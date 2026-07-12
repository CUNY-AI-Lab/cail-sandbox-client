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
    constructor(code, message, status, type = "unknown_error", param = null, details = {}, requestId = null, shouldRetry = null) {
        super(message);
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
// WHATWG URL keeps IPv6 hostnames bracketed; accept the bare form defensively.
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
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
    if (typeof body.id !== "string" ||
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
    };
}
async function parseOperation(response, operationId) {
    const message = "Sandbox operation response was malformed.";
    const body = await parseSuccessRecord(response, message);
    if (typeof body.id !== "string" ||
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
    };
}
async function parseRunning(response) {
    const message = "Sandbox status response was malformed.";
    const body = await parseSuccessRecord(response, message);
    if (typeof body.running !== "boolean" ||
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
    };
}
async function parseError(response) {
    const requestId = responseRequestId(response);
    const shouldRetry = responseShouldRetry(response);
    let body;
    try {
        body = await response.json();
    }
    catch {
        return new CailSandboxError("unknown_error", `Sandbox request failed with HTTP ${response.status}.`, response.status, "unknown_error", null, {}, requestId, shouldRetry);
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
    if (!APP.test(options.app)) {
        throw new Error("app must be a stable lowercase slug");
    }
    const fetchImpl = options.fetchImpl ?? fetch;
    const baseUrl = options.baseUrl.replace(/\/+$/, "");
    const call = async (path, init, credential, callOptions) => {
        const headers = new Headers(init.headers);
        headers.delete("x-cail-identity-jwt");
        headers.set("x-cail-app", options.app);
        if (credential.kind === "jwt") {
            headers.delete("authorization");
            headers.set("x-cail-identity-jwt", credential.token);
        }
        else {
            headers.delete("x-cail-identity-jwt");
            headers.set("authorization", `Bearer ${credential.token}`);
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
            redirect: "error",
            signal: callOptions?.signal ?? init.signal,
        });
        if (!response.ok)
            throw await parseError(response);
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
            return parseLifecycle(response);
        },
        async running(lease, credential, callOptions) {
            const response = await call(`/sandbox/v1/sandbox/${encodeId(lease.id)}/running`, { headers: leaseHeaders(lease) }, credential, callOptions);
            return parseRunning(response);
        },
        async destroy(lease, credential, callOptions) {
            await call(`/sandbox/v1/sandbox/${encodeId(lease.id)}`, { method: "DELETE", headers: leaseHeaders(lease) }, credential, callOptions);
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
            return parseOperation(response, input.operationId);
        },
        async destroySession(lease, operation, credential, callOptions) {
            await call(`/sandbox/v1/sandbox/${encodeId(lease.id)}/session/${encodeId(operation.id)}`, { method: "DELETE", headers: operationHeaders(lease, operation) }, credential, callOptions);
        },
        async readFile(lease, operation, path, credential, callOptions) {
            return call(`/sandbox/v1/sandbox/${encodeId(lease.id)}/file/${encodePath(path)}`, { headers: operationHeaders(lease, operation) }, credential, callOptions);
        },
        async writeFile(lease, operation, path, body, credential, callOptions) {
            await call(`/sandbox/v1/sandbox/${encodeId(lease.id)}/file/${encodePath(path)}`, {
                method: "PUT",
                body,
                headers: {
                    ...operationHeaders(lease, operation),
                    "content-type": "application/octet-stream",
                },
            }, credential, callOptions);
        },
        async exec(lease, operation, command, credential, execOptions = {}) {
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
            return parseCommandEvents(response);
        },
        async openapi(credential, callOptions) {
            const response = await call("/sandbox/v1/openapi.json", {}, credential, callOptions);
            return response.json();
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
            let data;
            try {
                data = JSON.parse(message.data);
            }
            catch {
                throw new CailSandboxError("invalid_stream", "Command stream contained invalid JSON.", response.status);
            }
            if (event === "stdout" || event === "stderr") {
                if (terminal) {
                    throw new CailSandboxError("invalid_stream", "Output followed the terminal event.", response.status);
                }
                if (typeof data.data !== "string") {
                    throw new CailSandboxError("invalid_stream", "Command output event was malformed.", response.status);
                }
                let bytes;
                try {
                    bytes = Uint8Array.from(atob(data.data), (value) => value.charCodeAt(0));
                }
                catch {
                    throw new CailSandboxError("invalid_stream", "Command output was not valid base64.", response.status);
                }
                yield { type: event, data: bytes };
            }
            else if (event === "exit") {
                if (terminal) {
                    throw new CailSandboxError("invalid_stream", "Command stream had multiple terminal events.", response.status);
                }
                if (typeof data.exit_code !== "number") {
                    throw new CailSandboxError("invalid_stream", "Command exit event was malformed.", response.status);
                }
                terminal = true;
                yield { type: "exit", exitCode: data.exit_code };
            }
            else {
                if (terminal) {
                    throw new CailSandboxError("invalid_stream", "Command stream had multiple terminal events.", response.status);
                }
                if (typeof data.code !== "string" ||
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
