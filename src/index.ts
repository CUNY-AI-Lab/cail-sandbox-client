import {
  outboundCorrelationHeaders,
  type CailCorrelation,
} from "@cuny-ai-lab/cail-log";
import { EventSourceParserStream } from "eventsource-parser/stream";

export {
  CAIL_REQUEST_ID_HEADER,
  correlationFromHeaders,
  outboundCorrelationHeaders,
  TRACEPARENT_HEADER,
} from "@cuny-ai-lab/cail-log";
export type { CailCorrelation, CailHeadersLike } from "@cuny-ai-lab/cail-log";

export type CailSandboxCredential = {
  kind: "jwt" | "key";
  token: string;
};
export type SandboxState = "active" | "destroying" | "destroyed";
export interface SandboxLifecycle {
  id: string;
  state: "active";
  expires_at: string;
}
export interface CommandOutputEvent {
  type: "stdout" | "stderr";
  data: Uint8Array;
}
export type CommandTerminalEvent =
  | { type: "exit"; exitCode: number }
  | { type: "error"; code: string; message: string; requestId: string };

export class CailSandboxError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly type = "unknown_error",
    readonly param: string | null = null,
    readonly details: Record<string, unknown> = {},
    readonly requestId: string | null = null,
    readonly shouldRetry: boolean | null = null,
  ) {
    super(message);
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
}

export interface SandboxCallOptions {
  correlation?: CailCorrelation;
}

export interface SandboxExecOptions extends SandboxCallOptions {
  sessionId?: string;
  signal?: AbortSignal;
}

export interface SandboxRunning {
  running: boolean;
  state: SandboxState;
  expires_at: string;
}

export interface CailSandboxClient {
  create(
    credential: CailSandboxCredential,
    options?: SandboxCallOptions,
  ): Promise<SandboxLifecycle>;
  running(
    id: string,
    credential: CailSandboxCredential,
    options?: SandboxCallOptions,
  ): Promise<SandboxRunning>;
  destroy(
    id: string,
    credential: CailSandboxCredential,
    options?: SandboxCallOptions,
  ): Promise<void>;
  createSession(
    id: string,
    credential: CailSandboxCredential,
    options?: SandboxCallOptions,
  ): Promise<{ id: string }>;
  destroySession(
    id: string,
    sessionId: string,
    credential: CailSandboxCredential,
    options?: SandboxCallOptions,
  ): Promise<void>;
  readFile(
    id: string,
    path: string,
    credential: CailSandboxCredential,
    options?: SandboxCallOptions,
  ): Promise<Response>;
  writeFile(
    id: string,
    path: string,
    body: BodyInit,
    credential: CailSandboxCredential,
    options?: SandboxCallOptions,
  ): Promise<void>;
  exec(
    id: string,
    command: string,
    credential: CailSandboxCredential,
    options?: SandboxExecOptions,
  ): Promise<AsyncGenerator<CommandOutputEvent | CommandTerminalEvent>>;
  openapi(
    credential: CailSandboxCredential,
    options?: SandboxCallOptions,
  ): Promise<Record<string, unknown>>;
}

const APP = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseRequestId(response: Response): string | null {
  return (
    response.headers.get("x-request-id") ??
    response.headers.get("x-cail-request-id")
  );
}

function responseShouldRetry(response: Response): boolean | null {
  const value = response.headers.get("x-should-retry")?.trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

async function parseError(response: Response): Promise<CailSandboxError> {
  const requestId = responseRequestId(response);
  const shouldRetry = responseShouldRetry(response);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
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

  if (isRecord(body) && isRecord(body.error)) {
    const error = body.error;
    const cail = error.cail;
    const validCail = cail === undefined || isRecord(cail);
    const validParam = error.param === null || typeof error.param === "string";
    if (
      typeof error.code === "string" &&
      typeof error.message === "string" &&
      typeof error.type === "string" &&
      validParam &&
      validCail
    ) {
      return new CailSandboxError(
        error.code,
        error.message,
        response.status,
        error.type,
        error.param as string | null,
        cail === undefined ? {} : { ...cail },
        requestId,
        shouldRetry,
      );
    }
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
  if (
    !options.baseUrl.startsWith("https://") &&
    !options.baseUrl.startsWith("http://localhost")
  ) {
    throw new Error("baseUrl must use HTTPS (or localhost)");
  }
  if (!APP.test(options.app)) {
    throw new Error("app must be a stable lowercase slug");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const call = async (
    path: string,
    init: RequestInit,
    credential: CailSandboxCredential,
    callOptions?: SandboxCallOptions,
  ) => {
    const headers = new Headers(init.headers);
    headers.delete("x-cail-identity-jwt");
    headers.set("x-cail-app", options.app);
    if (credential.kind === "jwt") {
      headers.delete("authorization");
      headers.set("x-cail-identity-jwt", credential.token);
    } else {
      headers.delete("x-cail-identity-jwt");
      headers.set("authorization", `Bearer ${credential.token}`);
    }
    if (callOptions?.correlation !== undefined) {
      try {
        for (const [name, value] of Object.entries(
          outboundCorrelationHeaders(callOptions.correlation),
        )) {
          headers.set(name, value);
        }
      } catch (error) {
        throw new CailSandboxError(
          "invalid_correlation",
          error instanceof Error
            ? error.message
            : "Invalid CAIL correlation object.",
          0,
        );
      }
    }

    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers,
      redirect: "error",
    });
    if (!response.ok) throw await parseError(response);
    return response;
  };

  return {
    async create(
      credential: CailSandboxCredential,
      callOptions?: SandboxCallOptions,
    ) {
      const response = await call(
        "/sandbox/v1/sandbox",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
        credential,
        callOptions,
      );
      return response.json() as Promise<SandboxLifecycle>;
    },
    async running(
      id: string,
      credential: CailSandboxCredential,
      callOptions?: SandboxCallOptions,
    ) {
      const response = await call(
        `/sandbox/v1/sandbox/${encodeURIComponent(id)}/running`,
        {},
        credential,
        callOptions,
      );
      return response.json() as Promise<SandboxRunning>;
    },
    async destroy(
      id: string,
      credential: CailSandboxCredential,
      callOptions?: SandboxCallOptions,
    ) {
      await call(
        `/sandbox/v1/sandbox/${encodeURIComponent(id)}`,
        { method: "DELETE" },
        credential,
        callOptions,
      );
    },
    async createSession(
      id: string,
      credential: CailSandboxCredential,
      callOptions?: SandboxCallOptions,
    ) {
      const response = await call(
        `/sandbox/v1/sandbox/${encodeURIComponent(id)}/session`,
        { method: "POST" },
        credential,
        callOptions,
      );
      return response.json() as Promise<{ id: string }>;
    },
    async destroySession(
      id: string,
      sessionId: string,
      credential: CailSandboxCredential,
      callOptions?: SandboxCallOptions,
    ) {
      await call(
        `/sandbox/v1/sandbox/${encodeURIComponent(id)}/session/${encodeURIComponent(sessionId)}`,
        { method: "DELETE" },
        credential,
        callOptions,
      );
    },
    async readFile(
      id: string,
      path: string,
      credential: CailSandboxCredential,
      callOptions?: SandboxCallOptions,
    ) {
      return call(
        `/sandbox/v1/sandbox/${encodeURIComponent(id)}/file/${encodePath(path)}`,
        {},
        credential,
        callOptions,
      );
    },
    async writeFile(
      id: string,
      path: string,
      body: BodyInit,
      credential: CailSandboxCredential,
      callOptions?: SandboxCallOptions,
    ) {
      await call(
        `/sandbox/v1/sandbox/${encodeURIComponent(id)}/file/${encodePath(path)}`,
        { method: "PUT", body },
        credential,
        callOptions,
      );
    },
    async exec(
      id: string,
      command: string,
      credential: CailSandboxCredential,
      execOptions: SandboxExecOptions = {},
    ) {
      const response = await call(
        `/sandbox/v1/sandbox/${encodeURIComponent(id)}/exec`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream",
          },
          body: JSON.stringify({
            command,
            ...(execOptions.sessionId
              ? { session_id: execOptions.sessionId }
              : {}),
          }),
          signal: execOptions.signal,
        },
        credential,
        execOptions,
      );
      return parseCommandEvents(response);
    },
    async openapi(
      credential: CailSandboxCredential,
      callOptions?: SandboxCallOptions,
    ) {
      const response = await call(
        "/sandbox/v1/openapi.json",
        {},
        credential,
        callOptions,
      );
      return response.json() as Promise<Record<string, unknown>>;
    },
  };
}

function encodePath(path: string) {
  if (path.startsWith("/") || path.split("/").some((part) => part === "..")) {
    throw new Error("file path must be workspace-relative");
  }
  return path.split("/").map(encodeURIComponent).join("/");
}

async function* parseCommandEvents(
  response: Response,
): AsyncGenerator<CommandOutputEvent | CommandTerminalEvent> {
  if (!response.body) {
    throw new CailSandboxError(
      "invalid_stream",
      "Command response had no body.",
      response.status,
    );
  }
  let terminal = false;
  const events = response.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(
      new EventSourceParserStream({
        maxBufferSize: 2 * 1024 * 1024,
        onError: "terminate",
      }),
    );
  const reader = events.getReader();
  let streamDone = false;
  try {
    while (true) {
      const { done, value: message } = await reader.read();
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
        throw new CailSandboxError(
          "invalid_stream",
          "Command stream contained an unknown event type.",
          response.status,
        );
      }
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(message.data) as Record<string, unknown>;
      } catch {
        throw new CailSandboxError(
          "invalid_stream",
          "Command stream contained invalid JSON.",
          response.status,
        );
      }
      if (event === "stdout" || event === "stderr") {
        if (terminal) {
          throw new CailSandboxError(
            "invalid_stream",
            "Output followed the terminal event.",
            response.status,
          );
        }
        if (typeof data.data !== "string") {
          throw new CailSandboxError(
            "invalid_stream",
            "Command output event was malformed.",
            response.status,
          );
        }
        let bytes: Uint8Array;
        try {
          bytes = Uint8Array.from(atob(data.data), (value) =>
            value.charCodeAt(0),
          );
        } catch {
          throw new CailSandboxError(
            "invalid_stream",
            "Command output was not valid base64.",
            response.status,
          );
        }
        yield { type: event, data: bytes };
      } else if (event === "exit") {
        if (terminal) {
          throw new CailSandboxError(
            "invalid_stream",
            "Command stream had multiple terminal events.",
            response.status,
          );
        }
        if (typeof data.exit_code !== "number") {
          throw new CailSandboxError(
            "invalid_stream",
            "Command exit event was malformed.",
            response.status,
          );
        }
        terminal = true;
        yield { type: "exit", exitCode: data.exit_code };
      } else {
        if (terminal) {
          throw new CailSandboxError(
            "invalid_stream",
            "Command stream had multiple terminal events.",
            response.status,
          );
        }
        if (
          typeof data.code !== "string" ||
          typeof data.message !== "string" ||
          typeof data.request_id !== "string"
        ) {
          throw new CailSandboxError(
            "invalid_stream",
            "Command error event was malformed.",
            response.status,
          );
        }
        terminal = true;
        yield {
          type: "error",
          code: data.code,
          message: data.message,
          requestId: data.request_id,
        };
      }
    }
  } catch (error) {
    if (error instanceof CailSandboxError) throw error;
    throw new CailSandboxError(
      "invalid_stream",
      "Command stream framing was invalid.",
      response.status,
    );
  } finally {
    if (!streamDone) await reader.cancel();
    reader.releaseLock();
  }
  if (!terminal) {
    throw new CailSandboxError(
      "invalid_stream",
      "Command stream ended without a terminal event.",
      response.status,
    );
  }
}
