import {
  REQUEST_ID_RE,
  outboundCorrelationHeaders,
  type CailCorrelation,
} from "@cuny-ai-lab/cail-log";
import {
  EventSourceParserStream,
  type EventSourceMessage,
} from "eventsource-parser/stream";
import { z } from "zod";

export {
  CAIL_REQUEST_ID_HEADER,
  correlationFromHeaders,
  outboundCorrelationHeaders,
  TRACEPARENT_HEADER,
} from "@cuny-ai-lab/cail-log";
export type { CailCorrelation, CailHeadersLike } from "@cuny-ai-lab/cail-log";

export type CailSandboxCredential = {
  kind: "jwt";
  token: string;
};
export type SandboxInstanceClass = "lite" | "basic" | "standard-1";
export interface SandboxLease {
  id: string;
  leaseCapability: string;
  leaseGeneration: number;
}
export interface SandboxLifecycle extends SandboxLease {
  state: "active";
  expiresAt: string;
  instanceClass: SandboxInstanceClass;
}
export interface SandboxOperation {
  id: string;
  operationId: string;
  operationCapability: string;
  operationGeneration: number;
  expiresAt: string;
}
export interface CreateSandboxInput {
  scopeKey: string;
  idempotencyKey: string;
}
export interface CreateOperationInput {
  operationId: string;
  idempotencyKey: string;
}
export interface CommandOutputEvent {
  type: "stdout" | "stderr";
  data: Uint8Array;
}
export type CommandTerminalEvent =
  | { type: "exit"; exitCode: number }
  | { type: "error"; code: string; message: string; requestId: string };

const responseSignals = new WeakMap<Response, AbortSignal | undefined>();
const liveResponseBodyReadErrors = new WeakSet<object>();
const liveEventSourceParseErrors = new WeakSet<object>();

type CailErrorDetails = Record<string, string | number | boolean | null>;

export class CailSandboxError extends Error {
  declare readonly cause?: unknown | undefined;

  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly type = "unknown_error",
    readonly param: string | null = null,
    readonly details: CailErrorDetails = {},
    readonly requestId: string | null = null,
    readonly shouldRetry: boolean | null = null,
    cause?: unknown | undefined,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CailSandboxError";
    Object.setPrototypeOf(this, CailSandboxError.prototype);
  }
}

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface SandboxClientOptions {
  baseUrl: string;
  app: string;
  fetchImpl?: FetchLike;
  defaultTimeoutMs?: number;
}

export interface SandboxCallOptions {
  correlation?: CailCorrelation;
  signal?: AbortSignal;
}

export type SandboxExecOptions = SandboxCallOptions;

export interface SandboxRunning {
  running: boolean;
  state: "active";
  expiresAt: string;
  leaseGeneration: number;
}

export interface SandboxUsage {
  period: string;
  unit: "mib_milliseconds";
  limit: number;
  used: number;
  reserved: number;
  remaining: number;
  activeLeases: 0 | 1;
}

export interface SandboxSettlement {
  leaseId: string;
  periodStart: string;
  periodEnd: string;
  unit: "mib_milliseconds";
  quantity: number;
  settledAt: string;
  state: "settled";
}

export interface CailSandboxClient {
  create(
    input: CreateSandboxInput,
    credential: CailSandboxCredential,
    options?: SandboxCallOptions,
  ): Promise<SandboxLifecycle>;
  running(
    lease: SandboxLease,
    credential: CailSandboxCredential,
    options?: SandboxCallOptions,
  ): Promise<SandboxRunning>;
  destroy(
    lease: SandboxLease,
    credential: CailSandboxCredential,
    options?: SandboxCallOptions,
  ): Promise<void>;
  usage(
    credential: CailSandboxCredential,
    options?: SandboxCallOptions,
  ): Promise<SandboxUsage>;
  settlement(
    leaseId: string,
    credential: CailSandboxCredential,
    options?: SandboxCallOptions,
  ): Promise<SandboxSettlement>;
  createSession(
    lease: SandboxLease,
    input: CreateOperationInput,
    credential: CailSandboxCredential,
    options?: SandboxCallOptions,
  ): Promise<SandboxOperation>;
  destroySession(
    lease: SandboxLease,
    operation: SandboxOperation,
    credential: CailSandboxCredential,
    options?: SandboxCallOptions,
  ): Promise<void>;
  readFile(
    lease: SandboxLease,
    operation: SandboxOperation,
    path: string,
    credential: CailSandboxCredential,
    options?: SandboxCallOptions,
  ): Promise<Response>;
  writeFile(
    lease: SandboxLease,
    operation: SandboxOperation,
    path: string,
    body: BodyInit,
    credential: CailSandboxCredential,
    options?: SandboxCallOptions,
  ): Promise<void>;
  exec(
    lease: SandboxLease,
    operation: SandboxOperation,
    command: string,
    credential: CailSandboxCredential,
    options?: SandboxExecOptions,
  ): Promise<AsyncGenerator<CommandOutputEvent | CommandTerminalEvent>>;
}

const APP = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CONTROL_VALUE = /^[A-Za-z0-9._~-]{32,256}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_COMMAND_CHARS = 16_384;
const MAX_OUTPUT_EVENT_BYTES = 1_048_576;
const MAX_OUTPUT_EVENT_BASE64_CHARS = 4 * Math.ceil(MAX_OUTPUT_EVENT_BYTES / 3);
const MAX_JSON_RESPONSE_BYTES = 65_536;
const MAX_TIMEOUT_MS = 2_147_483_647;
const CANONICAL_BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const DOM_EXCEPTION_NAME_GETTER = Object.getOwnPropertyDescriptor(
  DOMException.prototype,
  "name",
)?.get;
const ERROR_TYPES = new Set([
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "conflict_error",
  "rate_limit_error",
  "server_error",
]);
// WHATWG URL keeps IPv6 hostnames bracketed; accept the bare form defensively.
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const JSON_VALUE_SCHEMA = z.json();
type JsonValue = z.infer<typeof JSON_VALUE_SCHEMA>;
const JSON_OBJECT_SCHEMA = z.record(z.string(), JSON_VALUE_SCHEMA);
type JsonObject = z.infer<typeof JSON_OBJECT_SCHEMA>;
const CAIL_DETAILS_SCHEMA = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);
const CREDENTIAL_SCHEMA = z
  .object({
    kind: z.literal("jwt"),
    token: z.string().min(1).max(8_192).regex(/^[\u0021-\u007e]+$/u),
  })
  .strict();
const READABLE_STREAM_BODY_SCHEMA = z
  .object({ getReader: z.function() })
  .passthrough();
const ABORT_SIGNAL_SCHEMA = z
  .object({
    aborted: z.boolean(),
    addEventListener: z.function(),
    removeEventListener: z.function(),
    dispatchEvent: z.function(),
  })
  .passthrough();

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function credentialHeaders(credential: CailSandboxCredential) {
  try {
    const kindDescriptor = Object.getOwnPropertyDescriptor(credential, "kind");
    const tokenDescriptor = Object.getOwnPropertyDescriptor(credential, "token");
    const parsed = CREDENTIAL_SCHEMA.safeParse({
      kind:
        kindDescriptor !== undefined && "value" in kindDescriptor
          ? kindDescriptor.value
          : undefined,
      token:
        tokenDescriptor !== undefined && "value" in tokenDescriptor
          ? tokenDescriptor.value
          : undefined,
    });
    if (parsed.success) {
      return { "x-cail-identity-jwt": parsed.data.token };
    }
  } catch {
    // Hostile runtime values can throw during property access. The public
    // credential error below deliberately contains none of that private data.
  }
  throw new Error("credential must contain a valid identity JWT");
}

type ResponseCleanupOperation =
  "body_cancel" | "reader_cancel" | "reader_release";

interface CancelableStream {
  cancel(cause?: unknown): Promise<void>;
}

function logResponseCleanupDiagnostic(
  operation: ResponseCleanupOperation,
): void {
  try {
    console.error({
      event: "cail_sandbox_client.response_cleanup_failed",
      error: "response_cleanup_failed",
      operation,
    });
  } catch {
    // Cleanup reporting has no lower diagnostic boundary. It must never
    // replace the request failure or create an unhandled promise rejection.
  }
}

function cancelResponseBody(response: Response, cause?: unknown): void {
  try {
    const body = response.body;
    if (body) cancelResponseStream(body, cause);
  } catch {
    logResponseCleanupDiagnostic("body_cancel");
  }
}

function cancelResponseStream(
  stream: CancelableStream,
  cause?: unknown,
): void {
  try {
    void Promise.resolve(stream.cancel(cause)).catch(() =>
      logResponseCleanupDiagnostic("body_cancel"),
    );
  } catch {
    logResponseCleanupDiagnostic("body_cancel");
  }
}

function cancelResponseReader<T>(
  reader: ReadableStreamDefaultReader<T>,
  cause?: unknown,
): void {
  try {
    void Promise.resolve(reader.cancel(cause)).catch(() =>
      logResponseCleanupDiagnostic("reader_cancel"),
    );
  } catch {
    logResponseCleanupDiagnostic("reader_cancel");
  }
}

type ReaderResult<T> = Awaited<
  ReturnType<ReadableStreamDefaultReader<T>["read"]>
>;

/**
 * Race one reader operation against the owning signal. The underlying read is
 * always given rejection handlers before the race can settle, so a provider
 * that rejects late after cancellation cannot surface an unhandled rejection.
 * Cancellation is requested by the caller exactly once and is never awaited.
 */
function readWithSignal<T>(
  reader: ReadableStreamDefaultReader<T>,
  signal: AbortSignal | undefined,
  requestCancel: (cause: unknown) => void,
): Promise<ReaderResult<T>> {
  if (!signal) {
    try {
      return Promise.resolve(reader.read());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  const rejectAborted = (): Promise<ReaderResult<T>> => {
    const reason = signal.reason;
    requestCancel(reason);
    return Promise.reject(reason);
  };

  if (signal.aborted) return rejectAborted();

  return new Promise<ReaderResult<T>>((resolve, reject) => {
    let settled = false;
    let onAbort: (() => void) | undefined;
    const removeAbortListener = () => {
      if (onAbort === undefined) return;
      signal.removeEventListener("abort", onAbort);
      onAbort = undefined;
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      callback();
    };

    onAbort = () => {
      if (settled) return;
      const reason = signal.reason;
      settle(() => {
        requestCancel(reason);
        reject(reason);
      });
    };

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    let pending: Promise<ReaderResult<T>>;
    try {
      pending = reader.read();
    } catch (error) {
      settle(() => reject(error));
      return;
    }

    // Keep handlers attached after abort wins. A provider may reject the
    // original read after cancellation/release; observing it prevents an
    // unhandled rejection without changing the primary abort error.
    void Promise.resolve(pending).then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
  });
}

function isSignalReason(
  cause: unknown,
  signal: AbortSignal | undefined,
): boolean {
  if (!signal) return false;
  try {
    return signal.aborted && cause === signal.reason;
  } catch {
    return false;
  }
}

function releaseResponseReader<T>(
  reader: ReadableStreamDefaultReader<T>,
): void {
  try {
    reader.releaseLock();
  } catch {
    logResponseCleanupDiagnostic("reader_release");
  }
}

function requireStatus(response: Response, expected: number) {
  if (response.status !== expected) {
    cancelResponseBody(response);
    throw responseError(
      response,
      "invalid_response",
      `Sandbox response used unexpected HTTP status ${response.status}.`,
    );
  }
  try {
    responseRequestId(response);
  } catch (error) {
    cancelResponseBody(response);
    throw error;
  }
  return response;
}

function responseRequestId(response: Response): string | null {
  const canonical = response.headers.get("x-cail-request-id");
  const alias = response.headers.get("x-request-id");
  if (
    (canonical !== null && !REQUEST_ID_RE.test(canonical)) ||
    (alias !== null && !REQUEST_ID_RE.test(alias))
  ) {
    throw new CailSandboxError(
      "invalid_response",
      "Sandbox response used an invalid request identifier.",
      response.status,
      "unknown_error",
      null,
      {},
      null,
      responseShouldRetry(response),
    );
  }
  if (canonical !== null && alias !== null && canonical !== alias) {
    throw new CailSandboxError(
      "invalid_response",
      "Sandbox response used conflicting request identifiers.",
      response.status,
      "unknown_error",
      null,
      {},
      null,
      responseShouldRetry(response),
    );
  }
  return canonical ?? alias;
}

function responseShouldRetry(response: Response): boolean | null {
  const value = response.headers.get("x-should-retry");
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function responseMediaType(response: Response): string | null {
  const contentType = response.headers.get("content-type");
  if (contentType === null) return null;
  return contentType.split(";", 1)[0]?.trim().toLowerCase() || null;
}

function responseError(
  response: Response,
  code: string,
  message: string,
  type = "unknown_error",
  cause?: unknown,
) {
  return new CailSandboxError(
    code,
    message,
    response.status,
    type,
    null,
    {},
    responseRequestId(response),
    responseShouldRetry(response),
    cause,
  );
}

function controlValue(value: string, name: string) {
  if (!z.string().safeParse(value).success || !CONTROL_VALUE.test(value)) {
    throw new Error(`${name} must be a high-entropy opaque value`);
  }
  return value;
}

function leaseHeaders(lease: SandboxLease) {
  encodeId(lease.id);
  return {
    "x-cail-sandbox-lease": controlValue(
      lease.leaseCapability,
      "leaseCapability",
    ),
  };
}

function operationHeaders(lease: SandboxLease, operation: SandboxOperation) {
  encodeId(operation.id);
  return {
    ...leaseHeaders(lease),
    "x-cail-session-id": operation.id,
    "x-cail-operation-id": controlValue(operation.operationId, "operationId"),
    "x-cail-operation-capability": controlValue(
      operation.operationCapability,
      "operationCapability",
    ),
  };
}

function isReadableStreamBody(
  body: BodyInit,
): body is ReadableStream<Uint8Array> {
  try {
    return READABLE_STREAM_BODY_SCHEMA.safeParse(body).success;
  } catch {
    return false;
  }
}

function isAbortSignal(value: AbortSignal | null): value is AbortSignal {
  try {
    return ABORT_SIGNAL_SCHEMA.safeParse(value).success;
  } catch {
    return false;
  }
}

async function parseSuccessRecord(
  response: Response,
  message: string,
): Promise<JsonObject> {
  if (responseMediaType(response) !== "application/json") {
    cancelResponseBody(response);
    throw responseError(response, "invalid_response", message);
  }
  let body: JsonValue;
  try {
    body = await readBoundedJson(response);
  } catch (cause) {
    const signal = responseSignals.get(response);
    if (isSignalReason(cause, signal) || isAbortError(cause)) throw cause;
    throw responseError(
      response,
      "invalid_response",
      message,
      "unknown_error",
      cause,
    );
  }
  const parsed = JSON_OBJECT_SCHEMA.safeParse(body);
  if (!parsed.success) {
    throw responseError(response, "invalid_response", message);
  }
  return parsed.data;
}

class ResponseBodyReadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ResponseBodyReadError";
    liveResponseBodyReadErrors.add(this);
  }
}

async function readBoundedJson(
  response: Response,
  signal = responseSignals.get(response),
): Promise<JsonValue> {
  if (signal?.aborted) {
    cancelResponseBody(response, signal.reason);
    throw signal.reason;
  }
  const body = response.body;
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    /^\d+$/u.test(declaredLength) &&
    Number(declaredLength) > MAX_JSON_RESPONSE_BYTES
  ) {
    const error = new ResponseBodyReadError(
      "Sandbox JSON response exceeded the byte ceiling.",
    );
    if (body) cancelResponseStream(body, error);
    throw error;
  }
  if (!body) {
    throw new ResponseBodyReadError("Sandbox JSON response had no body.");
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = body.getReader();
  } catch (cause) {
    cancelResponseStream(body, cause);
    throw new ResponseBodyReadError(
      "Sandbox JSON response could not be read.",
      { cause },
    );
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";
  let cancelRequested = false;
  const requestCancel = (cause: unknown) => {
    if (cancelRequested) return;
    cancelRequested = true;
    cancelResponseReader(reader, cause);
  };
  try {
    while (true) {
      const { done, value } = await readWithSignal(
        reader,
        signal,
        requestCancel,
      );
      if (signal?.aborted) {
        requestCancel(signal.reason);
        throw signal.reason;
      }
      if (done) {
        text += decoder.decode();
        break;
      }
      total += value.byteLength;
      if (total > MAX_JSON_RESPONSE_BYTES) {
        const error = new ResponseBodyReadError(
          "Sandbox JSON response exceeded the byte ceiling.",
        );
        requestCancel(error);
        throw error;
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch (cause) {
    // SAFETY: WeakSet#has returns false for primitives without inspecting an
    // object's prototype, which preserves hostile thrown values verbatim.
    if (liveResponseBodyReadErrors.has(cause as object)) throw cause;
    if (isSignalReason(cause, signal) || isAbortError(cause)) throw cause;
    requestCancel(cause);
    throw new ResponseBodyReadError(
      "Sandbox JSON response could not be read.",
      { cause },
    );
  } finally {
    releaseResponseReader(reader);
  }

  try {
    return JSON_VALUE_SCHEMA.parse(JSON.parse(text));
  } catch (cause) {
    throw new ResponseBodyReadError(
      "Sandbox JSON response was not valid JSON.",
      { cause },
    );
  }
}

function isDateTime(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) return false;
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    ,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth[month - 1]! &&
    Number(hourText) <= 23 &&
    Number(minuteText) <= 59 &&
    Number(secondText) <= 59 &&
    (offsetHourText === undefined || Number(offsetHourText) <= 23) &&
    (offsetMinuteText === undefined || Number(offsetMinuteText) <= 59)
  );
}

function isFullDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return (
    month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1]!
  );
}

const DATE_TIME_SCHEMA = z.string().refine(isDateTime);
const FULL_DATE_SCHEMA = z.string().refine(isFullDate);
const NONNEGATIVE_SAFE_INTEGER_SCHEMA = z.number().int().nonnegative();
const POSITIVE_SAFE_INTEGER_SCHEMA = z.number().int().positive();
const SANDBOX_INSTANCE_CLASS_SCHEMA = z.enum(["lite", "basic", "standard-1"]);
const LIFECYCLE_SCHEMA = z
  .object({
    id: z.string().regex(UUID),
    state: z.literal("active"),
    expires_at: DATE_TIME_SCHEMA,
    lease_capability: z.string().regex(CONTROL_VALUE),
    lease_generation: POSITIVE_SAFE_INTEGER_SCHEMA,
    instance_class: SANDBOX_INSTANCE_CLASS_SCHEMA,
  })
  .strict();
const OPERATION_SCHEMA = z
  .object({
    id: z.string().regex(UUID),
    operation_capability: z.string().regex(CONTROL_VALUE),
    operation_generation: POSITIVE_SAFE_INTEGER_SCHEMA,
    expires_at: DATE_TIME_SCHEMA,
  })
  .strict();
const RUNNING_SCHEMA = z
  .object({
    running: z.boolean(),
    state: z.literal("active"),
    expires_at: DATE_TIME_SCHEMA,
    lease_generation: POSITIVE_SAFE_INTEGER_SCHEMA,
  })
  .strict();
const USAGE_SCHEMA = z
  .object({
    period: FULL_DATE_SCHEMA,
    unit: z.literal("mib_milliseconds"),
    limit: NONNEGATIVE_SAFE_INTEGER_SCHEMA,
    used: NONNEGATIVE_SAFE_INTEGER_SCHEMA,
    reserved: NONNEGATIVE_SAFE_INTEGER_SCHEMA,
    remaining: NONNEGATIVE_SAFE_INTEGER_SCHEMA,
    active_leases: z.union([z.literal(0), z.literal(1)]),
  })
  .strict()
  .refine(
    (usage) =>
      BigInt(usage.remaining) ===
      (BigInt(usage.limit) > BigInt(usage.used) + BigInt(usage.reserved)
        ? BigInt(usage.limit) - BigInt(usage.used) - BigInt(usage.reserved)
        : 0n),
  );
const SETTLEMENT_SCHEMA = z
  .object({
    lease_id: z.string().regex(UUID),
    period_start: DATE_TIME_SCHEMA,
    period_end: DATE_TIME_SCHEMA,
    unit: z.literal("mib_milliseconds"),
    quantity: NONNEGATIVE_SAFE_INTEGER_SCHEMA,
    settled_at: DATE_TIME_SCHEMA,
    state: z.literal("settled"),
  })
  .strict();
const ERROR_ENVELOPE_SCHEMA = z
  .object({
    error: z
      .object({
        message: z.string(),
        type: z.string().refine((type) => ERROR_TYPES.has(type)),
        param: z.union([z.string(), z.null()]),
        code: z.string(),
        cail: CAIL_DETAILS_SCHEMA.optional(),
      })
      .strict(),
  })
  .strict();
const WRITE_ACKNOWLEDGEMENT_SCHEMA = z.object({ ok: z.literal(true) }).strict();
const COMMAND_OUTPUT_SCHEMA = z.object({ data: z.string() }).strict();
const COMMAND_EXIT_SCHEMA = z
  .object({ exit_code: z.number().int() })
  .strict();
const COMMAND_ERROR_SCHEMA = z
  .object({
    code: z.string(),
    message: z.string(),
    request_id: z.string().regex(REQUEST_ID_RE),
  })
  .strict();

async function parseLifecycle(response: Response): Promise<SandboxLifecycle> {
  const message = "Sandbox lifecycle response was malformed.";
  const parsed = LIFECYCLE_SCHEMA.safeParse(
    await parseSuccessRecord(response, message),
  );
  if (!parsed.success) {
    throw responseError(response, "invalid_response", message);
  }
  const body = parsed.data;
  return {
    id: body.id,
    state: "active",
    expiresAt: body.expires_at,
    leaseCapability: body.lease_capability,
    leaseGeneration: body.lease_generation,
    instanceClass: body.instance_class,
  };
}

async function parseOperation(
  response: Response,
  operationId: string,
): Promise<SandboxOperation> {
  const message = "Sandbox operation response was malformed.";
  const parsed = OPERATION_SCHEMA.safeParse(
    await parseSuccessRecord(response, message),
  );
  if (!parsed.success) {
    throw responseError(response, "invalid_response", message);
  }
  const body = parsed.data;
  return {
    id: body.id,
    operationId,
    operationCapability: body.operation_capability,
    operationGeneration: body.operation_generation,
    expiresAt: body.expires_at,
  };
}

async function parseRunning(response: Response): Promise<SandboxRunning> {
  const message = "Sandbox status response was malformed.";
  const parsed = RUNNING_SCHEMA.safeParse(
    await parseSuccessRecord(response, message),
  );
  if (!parsed.success) {
    throw responseError(response, "invalid_response", message);
  }
  const body = parsed.data;
  return {
    running: body.running,
    state: "active",
    expiresAt: body.expires_at,
    leaseGeneration: body.lease_generation,
  };
}

async function parseUsage(response: Response): Promise<SandboxUsage> {
  const message = "Sandbox usage response was malformed.";
  const parsed = USAGE_SCHEMA.safeParse(
    await parseSuccessRecord(response, message),
  );
  if (!parsed.success) {
    throw responseError(response, "invalid_response", message);
  }
  const body = parsed.data;
  return {
    period: body.period,
    unit: "mib_milliseconds",
    limit: body.limit,
    used: body.used,
    reserved: body.reserved,
    remaining: body.remaining,
    activeLeases: body.active_leases,
  };
}

async function parseSettlement(
  response: Response,
  expectedLeaseId: string,
): Promise<SandboxSettlement> {
  const message = "Sandbox settlement response was malformed.";
  const parsed = SETTLEMENT_SCHEMA.safeParse(
    await parseSuccessRecord(response, message),
  );
  if (!parsed.success || parsed.data.lease_id !== expectedLeaseId) {
    throw responseError(response, "invalid_response", message);
  }
  const body = parsed.data;
  return {
    leaseId: body.lease_id,
    periodStart: body.period_start,
    periodEnd: body.period_end,
    unit: "mib_milliseconds",
    quantity: body.quantity,
    settledAt: body.settled_at,
    state: "settled",
  };
}

async function parseError(response: Response): Promise<CailSandboxError> {
  let requestId: string | null;
  try {
    requestId = responseRequestId(response);
  } catch (error) {
    cancelResponseBody(response);
    throw error;
  }
  const shouldRetry = responseShouldRetry(response);
  if (
    response.headers.get("x-cail-request-id") === null ||
    response.headers.get("x-request-id") === null ||
    shouldRetry === null ||
    responseMediaType(response) !== "application/json"
  ) {
    cancelResponseBody(response);
    return new CailSandboxError(
      "unknown_error",
      `Sandbox request failed with HTTP ${response.status}.`,
      response.status,
      "unknown_error",
      null,
      {},
      requestId,
      shouldRetry,
    );
  }
  let body: JsonValue;
  try {
    body = await readBoundedJson(response);
  } catch (cause) {
    const signal = responseSignals.get(response);
    if (isSignalReason(cause, signal) || isAbortError(cause)) throw cause;
    return new CailSandboxError(
      "unknown_error",
      `Sandbox request failed with HTTP ${response.status}.`,
      response.status,
      "unknown_error",
      null,
      {},
      requestId,
      shouldRetry,
      cause,
    );
  }

  const parsed = ERROR_ENVELOPE_SCHEMA.safeParse(body);
  if (parsed.success) {
    const error = parsed.data.error;
    return new CailSandboxError(
      error.code,
      error.message,
      response.status,
      error.type,
      error.param,
      error.cail === undefined ? {} : { ...error.cail },
      requestId,
      shouldRetry,
    );
  }

  return new CailSandboxError(
    "unknown_error",
    `Sandbox request failed with HTTP ${response.status}.`,
    response.status,
    "unknown_error",
    null,
    {},
    requestId,
    shouldRetry,
  );
}

export function createCailSandboxClient(
  options: SandboxClientOptions,
): CailSandboxClient {
  if (!z.object({}).passthrough().safeParse(options).success) {
    throw new Error("options must be an object");
  }
  if (
    !z.string().safeParse(options.baseUrl).success ||
    options.baseUrl.length === 0 ||
    options.baseUrl.trim() !== options.baseUrl ||
    hasControlCharacters(options.baseUrl)
  ) {
    throw new Error("baseUrl must be a non-empty URL string");
  }
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(options.baseUrl);
  } catch {
    throw new Error("baseUrl must be an absolute URL");
  }
  const httpAllowed =
    parsedBaseUrl.protocol === "http:" &&
    LOOPBACK_HOSTNAMES.has(parsedBaseUrl.hostname);
  if (parsedBaseUrl.protocol !== "https:" && !httpAllowed) {
    throw new Error(
      "baseUrl must use HTTPS (plain HTTP is allowed only for loopback hosts)",
    );
  }
  if (
    parsedBaseUrl.username ||
    parsedBaseUrl.password ||
    parsedBaseUrl.search ||
    parsedBaseUrl.hash ||
    options.baseUrl.includes("?") ||
    options.baseUrl.includes("#")
  ) {
    throw new Error(
      "baseUrl must not contain credentials, a query, or a fragment",
    );
  }
  if (!z.string().safeParse(options.app).success || !APP.test(options.app)) {
    throw new Error("app must be a stable lowercase slug");
  }
  if (
    options.defaultTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.defaultTimeoutMs) ||
      options.defaultTimeoutMs < 1 ||
      options.defaultTimeoutMs > MAX_TIMEOUT_MS)
  ) {
    throw new Error(
      `defaultTimeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`,
    );
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!z.function().safeParse(fetchImpl).success) {
    throw new Error("fetchImpl must be a function");
  }
  const basePath = parsedBaseUrl.pathname.replace(/\/+$/, "");
  const baseUrl = `${parsedBaseUrl.origin}${basePath === "/" ? "" : basePath}`;
  const call = async (
    path: string,
    init: RequestInit,
    credential: CailSandboxCredential,
    callOptions?: SandboxCallOptions,
  ) => {
    const headers = new Headers(init.headers);
    headers.delete("x-cail-identity-jwt");
    headers.delete("authorization");
    headers.delete("proxy-authorization");
    headers.delete("cookie");
    headers.set("x-cail-app", options.app);
    for (const [name, value] of Object.entries(credentialHeaders(credential))) {
      headers.set(name, value);
    }
    if (callOptions?.correlation !== undefined) {
      try {
        for (const [name, value] of Object.entries(
          outboundCorrelationHeaders(callOptions.correlation),
        )) {
          headers.set(name, value);
        }
      } catch {
        throw new CailSandboxError(
          "invalid_correlation",
          "Invalid CAIL correlation object.",
          0,
        );
      }
    }

    const optionSignal = callOptions?.signal;
    if (optionSignal !== undefined && !isAbortSignal(optionSignal)) {
      throw new CailSandboxError(
        "invalid_request",
        "`signal` must be an AbortSignal when present.",
        0,
      );
    }
    const initSignal = init.signal;
    if (initSignal !== undefined && !isAbortSignal(initSignal)) {
      throw new CailSandboxError(
        "invalid_request",
        "`signal` must be an AbortSignal when present.",
        0,
      );
    }
    const callerSignal = optionSignal ?? initSignal;
    const timeoutSignal =
      options.defaultTimeoutMs === undefined
        ? undefined
        : AbortSignal.timeout(options.defaultTimeoutMs);
    const signal =
      callerSignal && timeoutSignal
        ? AbortSignal.any([callerSignal, timeoutSignal])
        : (callerSignal ?? timeoutSignal);
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers,
      // Cloudflare Workers accepts `manual`, but rejects the standard
      // `error` value before issuing the request. Keep redirects disabled by
      // inspecting the response explicitly below.
      redirect: "manual",
      signal,
    });
    responseSignals.set(response, signal);
    if (
      response.type === "opaqueredirect" ||
      (response.status >= 300 && response.status < 400)
    ) {
      cancelResponseBody(response);
      throw responseError(
        response,
        "unexpected_redirect",
        "The CAIL Sandbox service returned a redirect, which is never a valid sandbox response.",
      );
    }
    if (!response.ok) throw await parseError(response);
    return response;
  };

  return {
    async create(
      input: CreateSandboxInput,
      credential: CailSandboxCredential,
      callOptions?: SandboxCallOptions,
    ) {
      const response = await call(
        "/sandbox/v1/sandbox",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            scope_key: controlValue(input.scopeKey, "scopeKey"),
            idempotency_key: controlValue(
              input.idempotencyKey,
              "idempotencyKey",
            ),
          }),
        },
        credential,
        callOptions,
      );
      return parseLifecycle(requireStatus(response, 201));
    },
    async running(
      lease: SandboxLease,
      credential: CailSandboxCredential,
      callOptions?: SandboxCallOptions,
    ) {
      const response = await call(
        `/sandbox/v1/sandbox/${encodeId(lease.id)}/running`,
        { headers: leaseHeaders(lease) },
        credential,
        callOptions,
      );
      return parseRunning(requireStatus(response, 200));
    },
    async destroy(
      lease: SandboxLease,
      credential: CailSandboxCredential,
      callOptions?: SandboxCallOptions,
    ) {
      const response = await call(
        `/sandbox/v1/sandbox/${encodeId(lease.id)}`,
        { method: "DELETE", headers: leaseHeaders(lease) },
        credential,
        callOptions,
      );
      requireStatus(response, 204);
      cancelResponseBody(response);
    },
    async usage(
      credential: CailSandboxCredential,
      callOptions?: SandboxCallOptions,
    ) {
      const response = await call(
        "/sandbox/v1/usage",
        {},
        credential,
        callOptions,
      );
      return parseUsage(requireStatus(response, 200));
    },
    async settlement(
      leaseId: string,
      credential: CailSandboxCredential,
      callOptions?: SandboxCallOptions,
    ) {
      const validatedLeaseId = encodeId(leaseId);
      const response = await call(
        `/sandbox/v1/usage/${validatedLeaseId}`,
        {},
        credential,
        callOptions,
      );
      return parseSettlement(requireStatus(response, 200), leaseId);
    },
    async createSession(
      lease: SandboxLease,
      input: CreateOperationInput,
      credential: CailSandboxCredential,
      callOptions?: SandboxCallOptions,
    ) {
      const response = await call(
        `/sandbox/v1/sandbox/${encodeId(lease.id)}/session`,
        {
          method: "POST",
          headers: {
            ...leaseHeaders(lease),
            "content-type": "application/json",
          },
          body: JSON.stringify({
            operation_id: controlValue(input.operationId, "operationId"),
            idempotency_key: controlValue(
              input.idempotencyKey,
              "idempotencyKey",
            ),
          }),
        },
        credential,
        callOptions,
      );
      return parseOperation(requireStatus(response, 201), input.operationId);
    },
    async destroySession(
      lease: SandboxLease,
      operation: SandboxOperation,
      credential: CailSandboxCredential,
      callOptions?: SandboxCallOptions,
    ) {
      const response = await call(
        `/sandbox/v1/sandbox/${encodeId(lease.id)}/session/${encodeId(operation.id)}`,
        { method: "DELETE", headers: operationHeaders(lease, operation) },
        credential,
        callOptions,
      );
      requireStatus(response, 204);
      cancelResponseBody(response);
    },
    async readFile(
      lease: SandboxLease,
      operation: SandboxOperation,
      path: string,
      credential: CailSandboxCredential,
      callOptions?: SandboxCallOptions,
    ) {
      const response = await call(
        `/sandbox/v1/sandbox/${encodeId(lease.id)}/file/${encodePath(path)}`,
        { headers: operationHeaders(lease, operation) },
        credential,
        callOptions,
      );
      const validated = requireStatus(response, 200);
      if (responseMediaType(validated) !== "application/octet-stream") {
        cancelResponseBody(validated);
        throw responseError(
          validated,
          "invalid_response",
          "Sandbox file response used an unexpected media type.",
        );
      }
      return validated;
    },
    async writeFile(
      lease: SandboxLease,
      operation: SandboxOperation,
      path: string,
      body: BodyInit,
      credential: CailSandboxCredential,
      callOptions?: SandboxCallOptions,
    ) {
      const requestInit: RequestInit & { duplex?: "half" } = {
        method: "PUT",
        body,
        headers: {
          ...operationHeaders(lease, operation),
          "content-type": "application/octet-stream",
        },
      };
      if (isReadableStreamBody(body)) requestInit.duplex = "half";
      const response = await call(
        `/sandbox/v1/sandbox/${encodeId(lease.id)}/file/${encodePath(path)}`,
        requestInit,
        credential,
        callOptions,
      );
      requireStatus(response, 200);
      const result = WRITE_ACKNOWLEDGEMENT_SCHEMA.safeParse(
        await parseSuccessRecord(
        response,
        "Sandbox file-write response was malformed.",
        ),
      );
      if (!result.success) {
        throw responseError(
          response,
          "invalid_response",
          "Sandbox file-write response was malformed.",
        );
      }
    },
    async exec(
      lease: SandboxLease,
      operation: SandboxOperation,
      command: string,
      credential: CailSandboxCredential,
      execOptions: SandboxExecOptions = {},
    ) {
      if (
        !z.string().safeParse(command).success ||
        command.length === 0 ||
        command.length > MAX_COMMAND_CHARS
      ) {
        throw new Error(
          `command must contain 1-${MAX_COMMAND_CHARS} characters`,
        );
      }
      const response = await call(
        `/sandbox/v1/sandbox/${encodeId(lease.id)}/exec`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream",
            ...operationHeaders(lease, operation),
          },
          body: JSON.stringify({
            command,
            session_id: operation.id,
          }),
          signal: execOptions.signal,
        },
        credential,
        execOptions,
      );
      return parseCommandEvents(requireStatus(response, 200));
    },
  };
}

function isAbortError(cause: unknown): boolean {
  if (DOM_EXCEPTION_NAME_GETTER === undefined) return false;
  try {
    const name = DOM_EXCEPTION_NAME_GETTER.call(cause);
    return name === "AbortError" || name === "TimeoutError";
  } catch {
    return false;
  }
}

function isEventSourceParseError(cause: unknown): boolean {
  // SAFETY: WeakSet#has returns false for primitives and checks object identity
  // without invoking a hostile value's prototype traps.
  return liveEventSourceParseErrors.has(cause as object);
}

// The service contract declares sandbox/session ids as format: uuid; at
// minimum reject anything that could alter the request path or headers.
function encodeId(id: string) {
  if (!z.string().safeParse(id).success || !UUID.test(id)) {
    throw new Error("id must be a sandbox-issued identifier");
  }
  return encodeURIComponent(id);
}

function encodePath(path: string) {
  if (
    !z.string().safeParse(path).success ||
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\0") ||
    path.includes("%") ||
    path.split("/").some((part) => part === "..")
  ) {
    throw new Error("file path must be workspace-relative");
  }
  return path.split("/").map(encodeURIComponent).join("/");
}

async function* parseCommandEvents(
  response: Response,
): AsyncGenerator<CommandOutputEvent | CommandTerminalEvent> {
  const signal = responseSignals.get(response);
  const ownedStreamErrors = new WeakSet<object>();
  const invalidStream = (message: string, cause?: unknown) => {
    const error = responseError(
      response,
      "invalid_stream",
      message,
      "unknown_error",
      cause,
    );
    ownedStreamErrors.add(error);
    return error;
  };
  let terminal: CommandTerminalEvent | null = null;
  let cleanupStream: CancelableStream | null = null;
  let reader: ReadableStreamDefaultReader<EventSourceMessage> | null = null;
  let streamDone = false;
  let primaryError: unknown;
  let cancelRequested = false;
  const requestCancel = (cause: unknown) => {
    if (cancelRequested) return;
    cancelRequested = true;
    if (reader) {
      cancelResponseReader(reader, cause);
    } else if (cleanupStream) {
      cancelResponseStream(cleanupStream, cause);
    }
  };
  try {
    const body = response.body;
    cleanupStream = body;
    if (responseMediaType(response) !== "text/event-stream") {
      throw invalidStream(
        "Command response did not use the text/event-stream media type.",
      );
    }
    if (signal?.aborted) throw signal.reason;
    if (!body) {
      throw invalidStream("Command response had no body.");
    }
    const decoded = body.pipeThrough(
      new TextDecoderStream("utf-8", { fatal: true }),
    );
    cleanupStream = decoded;
    const events = decoded.pipeThrough(
      new EventSourceParserStream({
        maxBufferSize: 2 * 1024 * 1024,
        onError(error) {
          liveEventSourceParseErrors.add(error);
          throw error;
        },
      }),
    );
    cleanupStream = events;
    reader = events.getReader();
    while (true) {
      const { done, value: message } = await readWithSignal(
        reader,
        signal,
        requestCancel,
      );
      if (signal?.aborted) {
        requestCancel(signal.reason);
        throw signal.reason;
      }
      if (done) {
        streamDone = true;
        break;
      }
      const event = message.event;
      if (
        event !== "stdout" &&
        event !== "stderr" &&
        event !== "exit" &&
        event !== "error"
      ) {
        throw invalidStream("Command stream contained an unknown event type.");
      }
      let parsed: JsonValue;
      try {
        parsed = JSON_VALUE_SCHEMA.parse(JSON.parse(message.data));
      } catch {
        throw invalidStream("Command stream contained invalid JSON.");
      }
      if (!JSON_OBJECT_SCHEMA.safeParse(parsed).success) {
        throw invalidStream("Command stream event was malformed.");
      }
      if (event === "stdout" || event === "stderr") {
        if (terminal) {
          throw invalidStream("Output followed the terminal event.");
        }
        const output = COMMAND_OUTPUT_SCHEMA.safeParse(parsed);
        if (!output.success) {
          throw invalidStream("Command output event was malformed.");
        }
        const data = output.data.data;
        if (
          data.length > MAX_OUTPUT_EVENT_BASE64_CHARS ||
          !CANONICAL_BASE64.test(data)
        ) {
          throw invalidStream("Command output was not valid canonical base64.");
        }
        let bytes: Uint8Array;
        try {
          bytes = Uint8Array.from(atob(data), (value) =>
            value.charCodeAt(0),
          );
        } catch {
          throw invalidStream("Command output was not valid canonical base64.");
        }
        let roundTrip = "";
        for (let offset = 0; offset < bytes.byteLength; offset += 8_192) {
          roundTrip += String.fromCharCode(
            ...bytes.subarray(offset, offset + 8_192),
          );
        }
        if (btoa(roundTrip) !== data) {
          throw invalidStream("Command output was not valid canonical base64.");
        }
        if (bytes.byteLength > MAX_OUTPUT_EVENT_BYTES) {
          throw invalidStream("Command output event exceeded the CAIL limit.");
        }
        yield { type: event, data: bytes };
      } else if (event === "exit") {
        if (terminal) {
          throw invalidStream("Command stream had multiple terminal events.");
        }
        const exit = COMMAND_EXIT_SCHEMA.safeParse(parsed);
        if (!exit.success) {
          throw invalidStream("Command exit event was malformed.");
        }
        terminal = { type: "exit", exitCode: exit.data.exit_code };
      } else {
        if (terminal) {
          throw invalidStream("Command stream had multiple terminal events.");
        }
        const commandError = COMMAND_ERROR_SCHEMA.safeParse(parsed);
        if (!commandError.success) {
          throw invalidStream("Command error event was malformed.");
        }
        terminal = {
          type: "error",
          code: commandError.data.code,
          message: commandError.data.message,
          requestId: commandError.data.request_id,
        };
      }
    }
  } catch (error) {
    primaryError = error;
    // SAFETY: WeakSet#has is identity-only and returns false for non-objects;
    // it does not invoke prototype traps on hostile transport failures.
    if (ownedStreamErrors.has(error as object)) {
      throw error;
    }
    // Deliberate abort is not a framing failure — surface it unchanged.
    if (isSignalReason(error, signal) || isAbortError(error)) throw error;
    if (isEventSourceParseError(error)) {
      throw invalidStream("Command stream framing was invalid.", error);
    }
    throw responseError(
      response,
      "stream_transport_error",
      "Command stream transport failed.",
      "server_error",
      error,
    );
  } finally {
    if (!streamDone) {
      // Teardown is deliberately non-blocking: a broken transport cancel must
      // neither stall nor replace the primary protocol/transport failure.
      requestCancel(signal?.aborted ? signal.reason : primaryError);
    }
    if (reader) releaseResponseReader(reader);
  }
  if (!terminal) {
    throw invalidStream("Command stream ended without a terminal event.");
  }
  yield terminal;
}
