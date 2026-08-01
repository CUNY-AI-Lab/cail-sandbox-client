import { REQUEST_ID_RE, outboundCorrelationHeaders, } from "@cuny-ai-lab/cail-log";
import { EventSourceParserStream, } from "eventsource-parser/stream";
export { CAIL_REQUEST_ID_HEADER, correlationFromHeaders, outboundCorrelationHeaders, TRACEPARENT_HEADER, } from "@cuny-ai-lab/cail-log";
const liveResponseBodyReadErrors = new WeakSet();
const liveEventSourceParseErrors = new WeakSet();
const responseSignals = new WeakMap();
export class CailSandboxError extends Error {
    code;
    status;
    type;
    param;
    details;
    requestId;
    shouldRetry;
    constructor(code, message, status, type = "unknown_error", param = null, details = {}, requestId = null, shouldRetry = null, cause) {
        super(message, cause === undefined ? undefined : { cause });
        this.code = code;
        this.status = status;
        this.type = type;
        this.param = param;
        this.details = details;
        this.requestId = requestId;
        this.shouldRetry = shouldRetry;
        this.name = "CailSandboxError";
        Object.setPrototypeOf(this, CailSandboxError.prototype);
    }
}
const APP = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CONTROL_VALUE = /^[A-Za-z0-9._~-]{32,256}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_COMMAND_CHARS = 16_384;
const MAX_OUTPUT_EVENT_BYTES = 1_048_576;
const MAX_OUTPUT_EVENT_BASE64_CHARS = 4 * Math.ceil(MAX_OUTPUT_EVENT_BYTES / 3);
const MAX_JSON_RESPONSE_BYTES = 65_536;
const MAX_TIMEOUT_MS = 2_147_483_647;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const DOM_EXCEPTION_NAME_GETTER = Object.getOwnPropertyDescriptor(DOMException.prototype, "name")?.get;
const CAIL_LOG_CORRELATION_MESSAGES = new Set([
    "cail-log: correlation must be a readable plain object",
    "cail-log: trace_id must be 32 lowercase hex chars, not all-zero",
    "cail-log: span_id must be 16 lowercase hex chars, not all-zero",
    "cail-log: request_id must be a lowercase UUID v4 or v7",
    "cail-log: trace_flags must be 0 or 1",
    "cail-log: tracestate must be a structurally valid W3C tracestate list",
]);
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
/** Resource IDs use the broader UUID shape above; request IDs use cail-log's
 * canonical lowercase UUIDv4/v7 validator. */
function isCailRequestId(value) {
    return typeof value === "string" && REQUEST_ID_RE.test(value);
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOnlyKeys(value, allowed) {
    return Object.keys(value).every((key) => allowed.includes(key));
}
function ownDataValue(value, key) {
    if ((typeof value !== "object" || value === null) &&
        typeof value !== "function") {
        return undefined;
    }
    try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor && "value" in descriptor
            ? descriptor.value
            : undefined;
    }
    catch {
        return undefined;
    }
}
function safeCorrelationErrorMessage(error) {
    const message = ownDataValue(error, "message");
    return typeof message === "string" &&
        CAIL_LOG_CORRELATION_MESSAGES.has(message)
        ? message
        : undefined;
}
function credentialHeaders(credential) {
    const candidate = credential;
    if (candidate.kind !== "jwt" ||
        typeof candidate.token !== "string" ||
        candidate.token.length === 0 ||
        candidate.token.length > 8_192 ||
        !/^[\x21-\x7e]+$/.test(candidate.token)) {
        throw new Error("credential must contain a valid identity JWT");
    }
    return { "x-cail-identity-jwt": candidate.token };
}
function logResponseCleanupDiagnostic(operation) {
    try {
        console.error({
            event: "cail_sandbox_client.response_cleanup_failed",
            error: "response_cleanup_failed",
            operation,
        });
    }
    catch {
        // Cleanup reporting has no lower diagnostic boundary. It must never
        // replace the request failure or create an unhandled promise rejection.
    }
}
function cancelResponseBody(response, reason) {
    try {
        const body = response.body;
        if (body)
            cancelResponseStream(body, reason);
    }
    catch {
        logResponseCleanupDiagnostic("body_cancel");
    }
}
function cancelResponseStream(stream, reason) {
    try {
        void Promise.resolve(stream.cancel(reason)).catch(() => logResponseCleanupDiagnostic("body_cancel"));
    }
    catch {
        logResponseCleanupDiagnostic("body_cancel");
    }
}
function cancelResponseReader(reader, reason) {
    try {
        void Promise.resolve(reader.cancel(reason)).catch(() => logResponseCleanupDiagnostic("reader_cancel"));
    }
    catch {
        logResponseCleanupDiagnostic("reader_cancel");
    }
}
/**
 * Race one reader operation against the owning signal. The underlying read is
 * always given rejection handlers before the race can settle, so a provider
 * that rejects late after cancellation cannot surface an unhandled rejection.
 * Cancellation is requested by the caller exactly once and is never awaited.
 */
function readWithSignal(reader, signal, requestCancel) {
    if (!signal) {
        try {
            return Promise.resolve(reader.read());
        }
        catch (error) {
            return Promise.reject(error);
        }
    }
    const rejectAborted = () => {
        const reason = signal.reason;
        requestCancel(reason);
        return Promise.reject(reason);
    };
    if (signal.aborted)
        return rejectAborted();
    return new Promise((resolve, reject) => {
        let settled = false;
        let onAbort;
        const removeAbortListener = () => {
            if (onAbort === undefined)
                return;
            signal.removeEventListener("abort", onAbort);
            onAbort = undefined;
        };
        const settle = (callback) => {
            if (settled)
                return;
            settled = true;
            removeAbortListener();
            callback();
        };
        onAbort = () => {
            if (settled)
                return;
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
        let pending;
        try {
            pending = reader.read();
        }
        catch (error) {
            settle(() => reject(error));
            return;
        }
        // Keep handlers attached after abort wins. A provider may reject the
        // original read after cancellation/release; observing it prevents an
        // unhandled rejection without changing the primary abort error.
        void Promise.resolve(pending).then((value) => settle(() => resolve(value)), (error) => settle(() => reject(error)));
    });
}
function isSignalReason(error, signal) {
    if (!signal)
        return false;
    try {
        return signal.aborted && error === signal.reason;
    }
    catch {
        return false;
    }
}
function releaseResponseReader(reader) {
    try {
        reader.releaseLock();
    }
    catch {
        logResponseCleanupDiagnostic("reader_release");
    }
}
function requireStatus(response, expected) {
    if (response.status !== expected) {
        cancelResponseBody(response);
        throw responseError(response, "invalid_response", `Sandbox response used unexpected HTTP status ${response.status}.`);
    }
    try {
        responseRequestId(response);
    }
    catch (error) {
        cancelResponseBody(response);
        throw error;
    }
    return response;
}
function responseRequestId(response) {
    const canonical = response.headers.get("x-cail-request-id");
    const alias = response.headers.get("x-request-id");
    if ((canonical !== null && !isCailRequestId(canonical)) ||
        (alias !== null && !isCailRequestId(alias))) {
        throw new CailSandboxError("invalid_response", "Sandbox response used an invalid request identifier.", response.status, "unknown_error", null, {}, null, responseShouldRetry(response));
    }
    if (canonical !== null && alias !== null && canonical !== alias) {
        throw new CailSandboxError("invalid_response", "Sandbox response used conflicting request identifiers.", response.status, "unknown_error", null, {}, null, responseShouldRetry(response));
    }
    return canonical ?? alias;
}
function responseShouldRetry(response) {
    const value = response.headers.get("x-should-retry");
    if (value === "true")
        return true;
    if (value === "false")
        return false;
    return null;
}
function responseMediaType(response) {
    const contentType = response.headers.get("content-type");
    if (contentType === null)
        return null;
    return contentType.split(";", 1)[0]?.trim().toLowerCase() || null;
}
function responseError(response, code, message, type = "unknown_error", cause) {
    return new CailSandboxError(code, message, response.status, type, null, {}, responseRequestId(response), responseShouldRetry(response), cause);
}
function controlValue(value, name) {
    if (!CONTROL_VALUE.test(value)) {
        throw new Error(`${name} must be a high-entropy opaque value`);
    }
    return value;
}
function leaseHeaders(lease) {
    encodeId(lease.id);
    return {
        "x-cail-sandbox-lease": controlValue(lease.leaseCapability, "leaseCapability"),
    };
}
function operationHeaders(lease, operation) {
    encodeId(operation.id);
    return {
        ...leaseHeaders(lease),
        "x-cail-session-id": operation.id,
        "x-cail-operation-id": controlValue(operation.operationId, "operationId"),
        "x-cail-operation-capability": controlValue(operation.operationCapability, "operationCapability"),
    };
}
async function parseSuccessRecord(response, message) {
    if (responseMediaType(response) !== "application/json") {
        cancelResponseBody(response);
        throw responseError(response, "invalid_response", message);
    }
    let body;
    try {
        body = await readBoundedJson(response);
    }
    catch (cause) {
        const signal = responseSignals.get(response);
        if (isSignalReason(cause, signal) || isAbortError(cause))
            throw cause;
        throw responseError(response, "invalid_response", message, "unknown_error", cause);
    }
    if (!isRecord(body)) {
        throw responseError(response, "invalid_response", message);
    }
    return body;
}
class ResponseBodyReadError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "ResponseBodyReadError";
        liveResponseBodyReadErrors.add(this);
    }
}
async function readBoundedJson(response, signal = responseSignals.get(response)) {
    if (signal?.aborted) {
        cancelResponseBody(response, signal.reason);
        throw signal.reason;
    }
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null &&
        /^\d+$/u.test(declaredLength) &&
        Number(declaredLength) > MAX_JSON_RESPONSE_BYTES) {
        const error = new ResponseBodyReadError("Sandbox JSON response exceeded the byte ceiling.");
        cancelResponseBody(response, error);
        throw error;
    }
    if (!response.body) {
        throw new ResponseBodyReadError("Sandbox JSON response had no body.");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let total = 0;
    let text = "";
    let cancelRequested = false;
    const requestCancel = (reason) => {
        if (cancelRequested)
            return;
        cancelRequested = true;
        cancelResponseReader(reader, reason);
    };
    try {
        while (true) {
            const { done, value } = await readWithSignal(reader, signal, requestCancel);
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
                const error = new ResponseBodyReadError("Sandbox JSON response exceeded the byte ceiling.");
                requestCancel(error);
                throw error;
            }
            text += decoder.decode(value, { stream: true });
        }
    }
    catch (cause) {
        if (liveResponseBodyReadErrors.has(cause))
            throw cause;
        if (isSignalReason(cause, signal) || isAbortError(cause))
            throw cause;
        requestCancel(cause);
        throw new ResponseBodyReadError("Sandbox JSON response could not be read.", { cause });
    }
    finally {
        releaseResponseReader(reader);
    }
    try {
        return JSON.parse(text);
    }
    catch (cause) {
        throw new ResponseBodyReadError("Sandbox JSON response was not valid JSON.", { cause });
    }
}
function isDateTime(value) {
    if (typeof value !== "string")
        return false;
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
    if (!match)
        return false;
    const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText,] = match;
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
    return (month >= 1 &&
        month <= 12 &&
        day >= 1 &&
        day <= daysInMonth[month - 1] &&
        Number(hourText) <= 23 &&
        Number(minuteText) <= 59 &&
        Number(secondText) <= 59 &&
        (offsetHourText === undefined || Number(offsetHourText) <= 23) &&
        (offsetMinuteText === undefined || Number(offsetMinuteText) <= 59));
}
function isFullDate(value) {
    if (typeof value !== "string")
        return false;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match)
        return false;
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
    return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1];
}
function isNonnegativeSafeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0;
}
async function parseLifecycle(response) {
    const message = "Sandbox lifecycle response was malformed.";
    const body = await parseSuccessRecord(response, message);
    if (!hasOnlyKeys(body, [
        "id",
        "state",
        "expires_at",
        "lease_capability",
        "lease_generation",
        "profile",
        "instance_class",
    ]) ||
        typeof body.id !== "string" ||
        !UUID.test(body.id) ||
        body.state !== "active" ||
        !isDateTime(body.expires_at) ||
        typeof body.lease_capability !== "string" ||
        !CONTROL_VALUE.test(body.lease_capability) ||
        !Number.isInteger(body.lease_generation) ||
        body.lease_generation < 1 ||
        body.profile !== "offline-code" ||
        !["lite", "basic", "standard-1"].includes(String(body.instance_class))) {
        throw responseError(response, "invalid_response", message);
    }
    return {
        id: body.id,
        state: "active",
        expiresAt: body.expires_at,
        leaseCapability: body.lease_capability,
        leaseGeneration: body.lease_generation,
        profile: "offline-code",
        instanceClass: body.instance_class,
    };
}
async function parseOperation(response, operationId) {
    const message = "Sandbox operation response was malformed.";
    const body = await parseSuccessRecord(response, message);
    if (!hasOnlyKeys(body, [
        "id",
        "operation_capability",
        "operation_generation",
        "expires_at",
    ]) ||
        typeof body.id !== "string" ||
        !UUID.test(body.id) ||
        typeof body.operation_capability !== "string" ||
        !CONTROL_VALUE.test(body.operation_capability) ||
        !Number.isInteger(body.operation_generation) ||
        body.operation_generation < 1 ||
        !isDateTime(body.expires_at)) {
        throw responseError(response, "invalid_response", message);
    }
    return {
        id: body.id,
        operationId,
        operationCapability: body.operation_capability,
        operationGeneration: body.operation_generation,
        expiresAt: body.expires_at,
    };
}
async function parseRunning(response) {
    const message = "Sandbox status response was malformed.";
    const body = await parseSuccessRecord(response, message);
    if (!hasOnlyKeys(body, [
        "running",
        "state",
        "expires_at",
        "lease_generation",
    ]) ||
        typeof body.running !== "boolean" ||
        body.state !== "active" ||
        !isDateTime(body.expires_at) ||
        !Number.isInteger(body.lease_generation) ||
        body.lease_generation < 1) {
        throw responseError(response, "invalid_response", message);
    }
    return {
        running: body.running,
        state: "active",
        expiresAt: body.expires_at,
        leaseGeneration: body.lease_generation,
    };
}
async function parseUsage(response) {
    const message = "Sandbox usage response was malformed.";
    const body = await parseSuccessRecord(response, message);
    if (!hasOnlyKeys(body, [
        "period",
        "unit",
        "limit",
        "used",
        "reserved",
        "remaining",
        "active_leases",
    ]) ||
        !isFullDate(body.period) ||
        body.unit !== "mib_milliseconds" ||
        !isNonnegativeSafeInteger(body.limit) ||
        !isNonnegativeSafeInteger(body.used) ||
        !isNonnegativeSafeInteger(body.reserved) ||
        !isNonnegativeSafeInteger(body.remaining) ||
        (body.active_leases !== 0 && body.active_leases !== 1) ||
        BigInt(body.remaining) !==
            (BigInt(body.limit) > BigInt(body.used) + BigInt(body.reserved)
                ? BigInt(body.limit) - BigInt(body.used) - BigInt(body.reserved)
                : 0n)) {
        throw responseError(response, "invalid_response", message);
    }
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
async function parseSettlement(response, expectedLeaseId) {
    const message = "Sandbox settlement response was malformed.";
    const body = await parseSuccessRecord(response, message);
    if (!hasOnlyKeys(body, [
        "lease_id",
        "period_start",
        "period_end",
        "unit",
        "quantity",
        "settled_at",
        "state",
    ]) ||
        body.lease_id !== expectedLeaseId ||
        !isDateTime(body.period_start) ||
        !isDateTime(body.period_end) ||
        body.unit !== "mib_milliseconds" ||
        !isNonnegativeSafeInteger(body.quantity) ||
        !isDateTime(body.settled_at) ||
        body.state !== "settled") {
        throw responseError(response, "invalid_response", message);
    }
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
async function parseError(response) {
    let requestId;
    try {
        requestId = responseRequestId(response);
    }
    catch (error) {
        cancelResponseBody(response);
        throw error;
    }
    const shouldRetry = responseShouldRetry(response);
    if (response.headers.get("x-cail-request-id") === null ||
        response.headers.get("x-request-id") === null ||
        shouldRetry === null ||
        responseMediaType(response) !== "application/json") {
        cancelResponseBody(response);
        return new CailSandboxError("unknown_error", `Sandbox request failed with HTTP ${response.status}.`, response.status, "unknown_error", null, {}, requestId, shouldRetry);
    }
    let body;
    try {
        body = await readBoundedJson(response);
    }
    catch (cause) {
        const signal = responseSignals.get(response);
        if (isSignalReason(cause, signal) || isAbortError(cause))
            throw cause;
        return new CailSandboxError("unknown_error", `Sandbox request failed with HTTP ${response.status}.`, response.status, "unknown_error", null, {}, requestId, shouldRetry, cause);
    }
    if (isRecord(body) && hasOnlyKeys(body, ["error"]) && isRecord(body.error)) {
        const error = body.error;
        const cail = error.cail;
        const validCail = cail === undefined || isRecord(cail);
        const validParam = error.param === null || typeof error.param === "string";
        if (hasOnlyKeys(error, ["message", "type", "param", "code", "cail"]) &&
            typeof error.code === "string" &&
            typeof error.message === "string" &&
            typeof error.type === "string" &&
            ERROR_TYPES.has(error.type) &&
            validParam &&
            validCail) {
            return new CailSandboxError(error.code, error.message, response.status, error.type, error.param, cail === undefined ? {} : { ...cail }, requestId, shouldRetry);
        }
    }
    return new CailSandboxError("unknown_error", `Sandbox request failed with HTTP ${response.status}.`, response.status, "unknown_error", null, {}, requestId, shouldRetry);
}
export function createCailSandboxClient(options) {
    let parsedBaseUrl;
    try {
        parsedBaseUrl = new URL(options.baseUrl);
    }
    catch {
        throw new Error("baseUrl must be an absolute URL");
    }
    const httpAllowed = parsedBaseUrl.protocol === "http:" &&
        LOOPBACK_HOSTNAMES.has(parsedBaseUrl.hostname);
    if (parsedBaseUrl.protocol !== "https:" && !httpAllowed) {
        throw new Error("baseUrl must use HTTPS (plain HTTP is allowed only for loopback hosts)");
    }
    if (parsedBaseUrl.username ||
        parsedBaseUrl.password ||
        parsedBaseUrl.search ||
        parsedBaseUrl.hash) {
        throw new Error("baseUrl must not contain credentials, a query, or a fragment");
    }
    if (!APP.test(options.app)) {
        throw new Error("app must be a stable lowercase slug");
    }
    if (options.defaultTimeoutMs !== undefined &&
        (!Number.isSafeInteger(options.defaultTimeoutMs) ||
            options.defaultTimeoutMs < 1 ||
            options.defaultTimeoutMs > MAX_TIMEOUT_MS)) {
        throw new Error(`defaultTimeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`);
    }
    const fetchImpl = options.fetchImpl ?? fetch;
    const basePath = parsedBaseUrl.pathname.replace(/\/+$/, "");
    const baseUrl = `${parsedBaseUrl.origin}${basePath === "/" ? "" : basePath}`;
    const call = async (path, init, credential, callOptions) => {
        const headers = new Headers(init.headers);
        headers.delete("x-cail-identity-jwt");
        headers.delete("authorization");
        headers.set("x-cail-app", options.app);
        for (const [name, value] of Object.entries(credentialHeaders(credential))) {
            headers.set(name, value);
        }
        if (callOptions?.correlation !== undefined) {
            try {
                for (const [name, value] of Object.entries(outboundCorrelationHeaders(callOptions.correlation))) {
                    headers.set(name, value);
                }
            }
            catch (error) {
                throw new CailSandboxError("invalid_correlation", safeCorrelationErrorMessage(error) ??
                    "Invalid CAIL correlation object.", 0);
            }
        }
        const callerSignal = callOptions?.signal ?? init.signal;
        const timeoutSignal = options.defaultTimeoutMs === undefined
            ? undefined
            : AbortSignal.timeout(options.defaultTimeoutMs);
        const signal = callerSignal && timeoutSignal
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
        if (response.type === "opaqueredirect" ||
            (response.status >= 300 && response.status < 400)) {
            cancelResponseBody(response);
            throw responseError(response, "unexpected_redirect", "The CAIL Sandbox service returned a redirect, which is never a valid sandbox response.");
        }
        if (!response.ok)
            throw await parseError(response);
        return response;
    };
    return {
        async create(input, credential, callOptions) {
            if (input.profile !== "offline-code") {
                throw new Error('profile must be "offline-code"');
            }
            const response = await call("/sandbox/v1/sandbox", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    scope_key: controlValue(input.scopeKey, "scopeKey"),
                    idempotency_key: controlValue(input.idempotencyKey, "idempotencyKey"),
                    profile: input.profile,
                }),
            }, credential, callOptions);
            return parseLifecycle(requireStatus(response, 201));
        },
        async running(lease, credential, callOptions) {
            const response = await call(`/sandbox/v1/sandbox/${encodeId(lease.id)}/running`, { headers: leaseHeaders(lease) }, credential, callOptions);
            return parseRunning(requireStatus(response, 200));
        },
        async destroy(lease, credential, callOptions) {
            const response = await call(`/sandbox/v1/sandbox/${encodeId(lease.id)}`, { method: "DELETE", headers: leaseHeaders(lease) }, credential, callOptions);
            requireStatus(response, 204);
        },
        async usage(credential, callOptions) {
            const response = await call("/sandbox/v1/usage", {}, credential, callOptions);
            return parseUsage(requireStatus(response, 200));
        },
        async settlement(leaseId, credential, callOptions) {
            const validatedLeaseId = encodeId(leaseId);
            const response = await call(`/sandbox/v1/usage/${validatedLeaseId}`, {}, credential, callOptions);
            return parseSettlement(requireStatus(response, 200), leaseId);
        },
        async createSession(lease, input, credential, callOptions) {
            const response = await call(`/sandbox/v1/sandbox/${encodeId(lease.id)}/session`, {
                method: "POST",
                headers: {
                    ...leaseHeaders(lease),
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    operation_id: controlValue(input.operationId, "operationId"),
                    idempotency_key: controlValue(input.idempotencyKey, "idempotencyKey"),
                }),
            }, credential, callOptions);
            return parseOperation(requireStatus(response, 201), input.operationId);
        },
        async destroySession(lease, operation, credential, callOptions) {
            const response = await call(`/sandbox/v1/sandbox/${encodeId(lease.id)}/session/${encodeId(operation.id)}`, { method: "DELETE", headers: operationHeaders(lease, operation) }, credential, callOptions);
            requireStatus(response, 204);
        },
        async readFile(lease, operation, path, credential, callOptions) {
            const response = await call(`/sandbox/v1/sandbox/${encodeId(lease.id)}/file/${encodePath(path)}`, { headers: operationHeaders(lease, operation) }, credential, callOptions);
            return requireStatus(response, 200);
        },
        async writeFile(lease, operation, path, body, credential, callOptions) {
            const response = await call(`/sandbox/v1/sandbox/${encodeId(lease.id)}/file/${encodePath(path)}`, {
                method: "PUT",
                body,
                headers: {
                    ...operationHeaders(lease, operation),
                    "content-type": "application/octet-stream",
                },
            }, credential, callOptions);
            requireStatus(response, 200);
            const result = await parseSuccessRecord(response, "Sandbox file-write response was malformed.");
            if (!hasOnlyKeys(result, ["ok"]) || result.ok !== true) {
                throw responseError(response, "invalid_response", "Sandbox file-write response was malformed.");
            }
        },
        async exec(lease, operation, command, credential, execOptions = {}) {
            if (!command || command.length > MAX_COMMAND_CHARS) {
                throw new Error(`command must contain 1-${MAX_COMMAND_CHARS} characters`);
            }
            const response = await call(`/sandbox/v1/sandbox/${encodeId(lease.id)}/exec`, {
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
            }, credential, execOptions);
            return parseCommandEvents(requireStatus(response, 200));
        },
        async openapi(credential, callOptions) {
            const response = await call("/sandbox/v1/openapi.json", {}, credential, callOptions);
            const body = await parseSuccessRecord(requireStatus(response, 200), "Sandbox OpenAPI response was malformed.");
            return body;
        },
    };
}
function isAbortError(error) {
    if (DOM_EXCEPTION_NAME_GETTER === undefined)
        return false;
    try {
        const name = DOM_EXCEPTION_NAME_GETTER.call(error);
        return name === "AbortError" || name === "TimeoutError";
    }
    catch {
        return false;
    }
}
function isParseError(error) {
    return liveEventSourceParseErrors.has(error);
}
// The service contract declares sandbox/session ids as format: uuid; at
// minimum reject anything that could alter the request path or headers.
function encodeId(id) {
    if (!UUID.test(id)) {
        throw new Error("id must be a sandbox-issued identifier");
    }
    return encodeURIComponent(id);
}
function encodePath(path) {
    if (path.length === 0 ||
        path.startsWith("/") ||
        path.includes("\0") ||
        path.includes("%") ||
        path.split("/").some((part) => part === "..")) {
        throw new Error("file path must be workspace-relative");
    }
    return path.split("/").map(encodeURIComponent).join("/");
}
async function* parseCommandEvents(response) {
    const signal = responseSignals.get(response);
    const ownedStreamErrors = new WeakSet();
    const invalidStream = (message, cause) => {
        const error = responseError(response, "invalid_stream", message, "unknown_error", cause);
        ownedStreamErrors.add(error);
        return error;
    };
    let terminal = null;
    let cleanupStream = null;
    let reader = null;
    let streamDone = false;
    let primaryError;
    let cancelRequested = false;
    const requestCancel = (reason) => {
        if (cancelRequested)
            return;
        cancelRequested = true;
        if (reader) {
            cancelResponseReader(reader, reason);
        }
        else if (cleanupStream) {
            cancelResponseStream(cleanupStream, reason);
        }
    };
    try {
        const body = response.body;
        cleanupStream = body;
        if (responseMediaType(response) !== "text/event-stream") {
            throw invalidStream("Command response did not use the text/event-stream media type.");
        }
        if (signal?.aborted)
            throw signal.reason;
        if (!body) {
            throw invalidStream("Command response had no body.");
        }
        const decoded = body.pipeThrough(new TextDecoderStream("utf-8", { fatal: true }));
        cleanupStream = decoded;
        const events = decoded.pipeThrough(new EventSourceParserStream({
            maxBufferSize: 2 * 1024 * 1024,
            onError(error) {
                liveEventSourceParseErrors.add(error);
                throw error;
            },
        }));
        cleanupStream = events;
        reader = events.getReader();
        while (true) {
            const { done, value: message } = await readWithSignal(reader, signal, requestCancel);
            if (signal?.aborted) {
                requestCancel(signal.reason);
                throw signal.reason;
            }
            if (done) {
                streamDone = true;
                break;
            }
            const event = message.event;
            if (event !== "stdout" &&
                event !== "stderr" &&
                event !== "exit" &&
                event !== "error") {
                throw invalidStream("Command stream contained an unknown event type.");
            }
            let parsed;
            try {
                parsed = JSON.parse(message.data);
            }
            catch {
                throw invalidStream("Command stream contained invalid JSON.");
            }
            if (!isRecord(parsed)) {
                throw invalidStream("Command stream event was malformed.");
            }
            const data = parsed;
            if (event === "stdout" || event === "stderr") {
                if (terminal) {
                    throw invalidStream("Output followed the terminal event.");
                }
                if (!hasOnlyKeys(data, ["data"]) || typeof data.data !== "string") {
                    throw invalidStream("Command output event was malformed.");
                }
                if (data.data.length > MAX_OUTPUT_EVENT_BASE64_CHARS ||
                    !CANONICAL_BASE64.test(data.data)) {
                    throw invalidStream("Command output was not valid canonical base64.");
                }
                let bytes;
                try {
                    bytes = Uint8Array.from(atob(data.data), (value) => value.charCodeAt(0));
                }
                catch {
                    throw invalidStream("Command output was not valid canonical base64.");
                }
                let roundTrip = "";
                for (let offset = 0; offset < bytes.byteLength; offset += 8_192) {
                    roundTrip += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
                }
                if (btoa(roundTrip) !== data.data) {
                    throw invalidStream("Command output was not valid canonical base64.");
                }
                if (bytes.byteLength > MAX_OUTPUT_EVENT_BYTES) {
                    throw invalidStream("Command output event exceeded the CAIL limit.");
                }
                yield { type: event, data: bytes };
            }
            else if (event === "exit") {
                if (terminal) {
                    throw invalidStream("Command stream had multiple terminal events.");
                }
                if (!hasOnlyKeys(data, ["exit_code"]) ||
                    !Number.isInteger(data.exit_code)) {
                    throw invalidStream("Command exit event was malformed.");
                }
                terminal = { type: "exit", exitCode: data.exit_code };
            }
            else {
                if (terminal) {
                    throw invalidStream("Command stream had multiple terminal events.");
                }
                if (!hasOnlyKeys(data, ["code", "message", "request_id"]) ||
                    typeof data.code !== "string" ||
                    typeof data.message !== "string" ||
                    typeof data.request_id !== "string" ||
                    !isCailRequestId(data.request_id)) {
                    throw invalidStream("Command error event was malformed.");
                }
                terminal = {
                    type: "error",
                    code: data.code,
                    message: data.message,
                    requestId: data.request_id,
                };
            }
        }
    }
    catch (error) {
        primaryError = error;
        if (ownedStreamErrors.has(error))
            throw error;
        // Deliberate abort is not a framing failure — surface it unchanged.
        if (isSignalReason(error, signal) || isAbortError(error))
            throw error;
        if (isParseError(error)) {
            throw invalidStream("Command stream framing was invalid.", error);
        }
        throw responseError(response, "stream_transport_error", "Command stream transport failed.", "server_error", error);
    }
    finally {
        if (!streamDone) {
            // Teardown is deliberately non-blocking: a broken transport cancel must
            // neither stall nor replace the primary protocol/transport failure.
            requestCancel(signal?.aborted ? signal.reason : primaryError);
        }
        if (reader)
            releaseResponseReader(reader);
    }
    if (!terminal) {
        throw invalidStream("Command stream ended without a terminal event.");
    }
    yield terminal;
}
