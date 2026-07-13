import { outboundCorrelationHeaders, } from "@cuny-ai-lab/cail-log";
import { EventSourceParserStream } from "eventsource-parser/stream";
export { CAIL_REQUEST_ID_HEADER, correlationFromHeaders, outboundCorrelationHeaders, TRACEPARENT_HEADER, } from "@cuny-ai-lab/cail-log";
export class CailSandboxError extends Error {
    code;
    status;
    type;
    param;
    details;
    requestId;
    shouldRetry;
    quota;
    constructor(code, message, status, type = "unknown_error", param = null, details = {}, requestId = null, shouldRetry = null, quota = null) {
        super(message);
        this.code = code;
        this.status = status;
        this.type = type;
        this.param = param;
        this.details = details;
        this.requestId = requestId;
        this.shouldRetry = shouldRetry;
        this.quota = quota;
        this.name = "CailSandboxError";
        Object.setPrototypeOf(this, CailSandboxError.prototype);
    }
}
const APP = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CONTROL_VALUE = /^[A-Za-z0-9._~-]{32,256}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_COMMAND_CHARS = 16_384;
const MAX_OUTPUT_EVENT_BYTES = 1_048_576;
// WHATWG URL keeps IPv6 hostnames bracketed; accept the bare form defensively.
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOnlyKeys(value, allowed) {
    return Object.keys(value).every((key) => allowed.includes(key));
}
const SANDBOX_QUOTA_HEADERS = [
    "x-cail-sandbox-quota-limit",
    "x-cail-sandbox-quota-used",
    "x-cail-sandbox-quota-remaining",
    "x-cail-sandbox-quota-unit",
    "x-cail-sandbox-quota-mode",
    "x-cail-sandbox-quota-state",
];
function nonnegativeHeaderInteger(value) {
    if (value === null || !/^(?:0|[1-9]\d*)$/.test(value))
        return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
}
export function sandboxQuotaFromHeaders(headers) {
    const values = SANDBOX_QUOTA_HEADERS.map((name) => headers.get(name));
    if (values.every((value) => value === null))
        return null;
    if (values.some((value) => value === null)) {
        throw new CailSandboxError("invalid_response", "Sandbox quota headers were incomplete.", 0);
    }
    const [limitText, usedText, remainingText, unit, mode, state] = values;
    const limitGibSeconds = nonnegativeHeaderInteger(limitText);
    const usedGibSeconds = nonnegativeHeaderInteger(usedText);
    const remainingGibSeconds = nonnegativeHeaderInteger(remainingText);
    if (limitGibSeconds === null ||
        usedGibSeconds === null ||
        remainingGibSeconds === null ||
        remainingGibSeconds !== Math.max(0, limitGibSeconds - usedGibSeconds) ||
        unit !== "gib-seconds" ||
        mode !== "enforce" ||
        (state !== "ok" && state !== "exhausted") ||
        (state === "exhausted" && remainingGibSeconds !== 0)) {
        throw new CailSandboxError("invalid_response", "Sandbox quota headers were malformed.", 0);
    }
    return {
        limitGibSeconds,
        usedGibSeconds,
        remainingGibSeconds,
        unit,
        mode,
        state,
    };
}
function credentialHeaders(credential) {
    const candidate = credential;
    if ((candidate.kind !== "jwt" && candidate.kind !== "key") ||
        typeof candidate.token !== "string" ||
        candidate.token.length === 0 ||
        candidate.token.length > 8_192 ||
        !/^[\x21-\x7e]+$/.test(candidate.token)) {
        throw new Error("credential must contain a valid jwt or key token");
    }
    return candidate.kind === "jwt"
        ? { "x-cail-identity-jwt": candidate.token }
        : { authorization: `Bearer ${candidate.token}` };
}
function requireStatus(response, expected) {
    if (response.status !== expected) {
        throw new CailSandboxError("invalid_response", `Sandbox response used unexpected HTTP status ${response.status}.`, response.status);
    }
    return response;
}
function responseRequestId(response) {
    return (response.headers.get("x-request-id") ??
        response.headers.get("x-cail-request-id"));
}
function responseShouldRetry(response) {
    const value = response.headers.get("x-should-retry")?.trim().toLowerCase();
    if (value === "true")
        return true;
    if (value === "false")
        return false;
    return null;
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
    let body;
    try {
        body = await response.json();
    }
    catch {
        throw new CailSandboxError("invalid_response", message, response.status);
    }
    if (!isRecord(body)) {
        throw new CailSandboxError("invalid_response", message, response.status);
    }
    return body;
}
function isDateTime(value) {
    if (typeof value !== "string")
        return false;
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
    if (!match)
        return false;
    const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
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
async function parseLifecycle(response) {
    const message = "Sandbox lifecycle response was malformed.";
    const body = await parseSuccessRecord(response, message);
    if (!hasOnlyKeys(body, ["id", "state", "expires_at", "lease_capability", "lease_generation"]) ||
        typeof body.id !== "string" ||
        !UUID.test(body.id) ||
        body.state !== "active" ||
        !isDateTime(body.expires_at) ||
        typeof body.lease_capability !== "string" ||
        !CONTROL_VALUE.test(body.lease_capability) ||
        !Number.isInteger(body.lease_generation) ||
        body.lease_generation < 1) {
        throw new CailSandboxError("invalid_response", message, response.status);
    }
    return {
        id: body.id,
        state: "active",
        expiresAt: body.expires_at,
        leaseCapability: body.lease_capability,
        leaseGeneration: body.lease_generation,
        quota: sandboxQuotaFromHeaders(response.headers),
    };
}
async function parseOperation(response, operationId) {
    const message = "Sandbox operation response was malformed.";
    const body = await parseSuccessRecord(response, message);
    if (!hasOnlyKeys(body, ["id", "operation_capability", "operation_generation", "expires_at"]) ||
        typeof body.id !== "string" ||
        !UUID.test(body.id) ||
        typeof body.operation_capability !== "string" ||
        !CONTROL_VALUE.test(body.operation_capability) ||
        !Number.isInteger(body.operation_generation) ||
        body.operation_generation < 1 ||
        !isDateTime(body.expires_at)) {
        throw new CailSandboxError("invalid_response", message, response.status);
    }
    return {
        id: body.id,
        operationId,
        operationCapability: body.operation_capability,
        operationGeneration: body.operation_generation,
        expiresAt: body.expires_at,
        quota: sandboxQuotaFromHeaders(response.headers),
    };
}
async function parseRunning(response) {
    const message = "Sandbox status response was malformed.";
    const body = await parseSuccessRecord(response, message);
    if (!hasOnlyKeys(body, ["running", "state", "expires_at", "incarnation", "lease_generation"]) ||
        typeof body.running !== "boolean" ||
        !["active", "destroying", "destroyed"].includes(String(body.state)) ||
        !isDateTime(body.expires_at) ||
        (body.incarnation !== null && typeof body.incarnation !== "string") ||
        !Number.isInteger(body.lease_generation) ||
        body.lease_generation < 1) {
        throw new CailSandboxError("invalid_response", message, response.status);
    }
    return {
        running: body.running,
        state: body.state,
        expiresAt: body.expires_at,
        incarnation: body.incarnation,
        leaseGeneration: body.lease_generation,
        quota: sandboxQuotaFromHeaders(response.headers),
    };
}
async function parseError(response) {
    const requestId = responseRequestId(response);
    const shouldRetry = responseShouldRetry(response);
    let quota = null;
    try {
        quota = sandboxQuotaFromHeaders(response.headers);
    }
    catch {
        // Quota metadata is ancillary on an error; preserve the finalized error.
    }
    let body;
    try {
        body = await response.json();
    }
    catch {
        return new CailSandboxError("unknown_error", `Sandbox request failed with HTTP ${response.status}.`, response.status, "unknown_error", null, {}, requestId, shouldRetry, quota);
    }
    if (isRecord(body) && isRecord(body.error)) {
        const error = body.error;
        const cail = error.cail;
        const validCail = cail === undefined || isRecord(cail);
        const validParam = error.param === null || typeof error.param === "string";
        if (typeof error.code === "string" &&
            typeof error.message === "string" &&
            typeof error.type === "string" &&
            validParam &&
            validCail) {
            return new CailSandboxError(error.code, error.message, response.status, error.type, error.param, cail === undefined ? {} : { ...cail }, requestId, shouldRetry, quota);
        }
    }
    return new CailSandboxError("unknown_error", `Sandbox request failed with HTTP ${response.status}.`, response.status, "unknown_error", null, {}, requestId, shouldRetry, quota);
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
                throw new CailSandboxError("invalid_correlation", error instanceof Error
                    ? error.message
                    : "Invalid CAIL correlation object.", 0);
            }
        }
        const response = await fetchImpl(`${baseUrl}${path}`, {
            ...init,
            headers,
            // Cloudflare Workers accepts `manual`, but rejects the standard
            // `error` value before issuing the request. Keep redirects disabled by
            // inspecting the response explicitly below.
            redirect: "manual",
            signal: callOptions?.signal ?? init.signal,
        });
        if (response.type === "opaqueredirect" ||
            (response.status >= 300 && response.status < 400)) {
            throw new CailSandboxError("unexpected_redirect", "The CAIL sandbox gateway returned a redirect, which is never a valid sandbox response.", response.status);
        }
        if (!response.ok)
            throw await parseError(response);
        const quota = sandboxQuotaFromHeaders(response.headers);
        if (quota && callOptions?.onQuota) {
            try {
                callOptions.onQuota(quota);
            }
            catch {
                // Observation must never change an already-admitted remote operation.
            }
        }
        return response;
    };
    return {
        async create(input, credential, callOptions) {
            const response = await call("/sandbox/v1/sandbox", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    scope_key: controlValue(input.scopeKey, "scopeKey"),
                    idempotency_key: controlValue(input.idempotencyKey, "idempotencyKey"),
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
                throw new CailSandboxError("invalid_response", "Sandbox file-write response was malformed.", response.status);
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
    return (typeof error === "object" &&
        error !== null &&
        error.name === "AbortError");
}
// The gateway contract declares sandbox/session ids as format: uuid; at
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
        path.split("/").some((part) => part === "..")) {
        throw new Error("file path must be workspace-relative");
    }
    return path.split("/").map(encodeURIComponent).join("/");
}
async function* parseCommandEvents(response) {
    if (!response.body) {
        throw new CailSandboxError("invalid_stream", "Command response had no body.", response.status);
    }
    let terminal = false;
    const events = response.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new EventSourceParserStream({
        maxBufferSize: 2 * 1024 * 1024,
        onError: "terminate",
    }));
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
            if (event !== "stdout" &&
                event !== "stderr" &&
                event !== "exit" &&
                event !== "error") {
                throw new CailSandboxError("invalid_stream", "Command stream contained an unknown event type.", response.status);
            }
            let parsed;
            try {
                parsed = JSON.parse(message.data);
            }
            catch {
                throw new CailSandboxError("invalid_stream", "Command stream contained invalid JSON.", response.status);
            }
            if (!isRecord(parsed)) {
                throw new CailSandboxError("invalid_stream", "Command stream event was malformed.", response.status);
            }
            const data = parsed;
            if (event === "stdout" || event === "stderr") {
                if (terminal) {
                    throw new CailSandboxError("invalid_stream", "Output followed the terminal event.", response.status);
                }
                if (!hasOnlyKeys(data, ["data"]) || typeof data.data !== "string") {
                    throw new CailSandboxError("invalid_stream", "Command output event was malformed.", response.status);
                }
                let bytes;
                try {
                    bytes = Uint8Array.from(atob(data.data), (value) => value.charCodeAt(0));
                }
                catch {
                    throw new CailSandboxError("invalid_stream", "Command output was not valid base64.", response.status);
                }
                if (bytes.byteLength > MAX_OUTPUT_EVENT_BYTES) {
                    throw new CailSandboxError("invalid_stream", "Command output event exceeded the CAIL limit.", response.status);
                }
                yield { type: event, data: bytes };
            }
            else if (event === "exit") {
                if (terminal) {
                    throw new CailSandboxError("invalid_stream", "Command stream had multiple terminal events.", response.status);
                }
                if (!hasOnlyKeys(data, ["exit_code"]) ||
                    !Number.isInteger(data.exit_code)) {
                    throw new CailSandboxError("invalid_stream", "Command exit event was malformed.", response.status);
                }
                terminal = true;
                yield { type: "exit", exitCode: data.exit_code };
                return;
            }
            else {
                if (terminal) {
                    throw new CailSandboxError("invalid_stream", "Command stream had multiple terminal events.", response.status);
                }
                if (!hasOnlyKeys(data, ["code", "message", "request_id"]) ||
                    typeof data.code !== "string" ||
                    typeof data.message !== "string" ||
                    typeof data.request_id !== "string") {
                    throw new CailSandboxError("invalid_stream", "Command error event was malformed.", response.status);
                }
                terminal = true;
                yield {
                    type: "error",
                    code: data.code,
                    message: data.message,
                    requestId: data.request_id,
                };
                return;
            }
        }
    }
    catch (error) {
        if (error instanceof CailSandboxError)
            throw error;
        // Deliberate abort is not a framing failure — surface it unchanged.
        if (isAbortError(error))
            throw error;
        throw new CailSandboxError("invalid_stream", "Command stream framing was invalid.", response.status);
    }
    finally {
        if (!streamDone) {
            // cancel() on an already-errored stream rejects with the stored error;
            // swallowing it here keeps the exception from the catch block intact
            // (a rejection escaping finally would override it).
            try {
                await reader.cancel();
            }
            catch {
                // Best-effort teardown only.
            }
        }
        reader.releaseLock();
    }
    if (!terminal) {
        throw new CailSandboxError("invalid_stream", "Command stream ended without a terminal event.", response.status);
    }
}
