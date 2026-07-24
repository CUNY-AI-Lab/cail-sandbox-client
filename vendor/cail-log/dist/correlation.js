import { HEX_SPAN_RE, HEX_TRACE_RE, REQUEST_ID_RE, isPlainObject, } from "./schema.js";
export const TRACEPARENT_HEADER = "traceparent";
export const TRACESTATE_HEADER = "tracestate";
export const CAIL_REQUEST_ID_HEADER = "x-cail-request-id";
const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;
const ZERO_TRACE = "0".repeat(32);
const ZERO_SPAN = "0".repeat(16);
const TRACESTATE_MAX_CHARS = 512;
const TRACESTATE_MAX_MEMBERS = 32;
const RANDOM_ID_ATTEMPTS = 8;
const TRACESTATE_KEY_RE = /^(?:[a-z][a-z0-9_*\/-]{0,255}|[a-z0-9][a-z0-9_*\/-]{0,240}@[a-z][a-z0-9_*\/-]{0,13})$/;
const TRACESTATE_VALUE_RE = /^[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/;
function snapshotCorrelation(value) {
    try {
        if (!isPlainObject(value)) {
            throw new TypeError("invalid correlation");
        }
        return Object.freeze({
            traceId: value["trace_id"],
            spanId: value["span_id"],
            traceFlags: value["trace_flags"],
            requestId: value["request_id"],
            tracestate: value["tracestate"],
        });
    }
    catch {
        throw new TypeError("cail-log: correlation must be a readable plain object");
    }
}
function sanitizeTracestate(raw) {
    if (typeof raw !== "string")
        return undefined;
    if (raw.length > TRACESTATE_MAX_CHARS)
        return undefined;
    const rawMembers = raw.split(",");
    if (rawMembers.length > TRACESTATE_MAX_MEMBERS)
        return undefined;
    const members = [];
    const keys = new Set();
    for (const rawMember of rawMembers) {
        const member = rawMember.replace(/^[ \t]+|[ \t]+$/g, "");
        if (member === "")
            continue;
        const equals = member.indexOf("=");
        if (equals <= 0 || equals === member.length - 1)
            return undefined;
        const key = member.slice(0, equals);
        const value = member.slice(equals + 1);
        if (!TRACESTATE_KEY_RE.test(key) ||
            !TRACESTATE_VALUE_RE.test(value) ||
            keys.has(key)) {
            return undefined;
        }
        keys.add(key);
        members.push(member);
    }
    return members.length === 0 ? undefined : members.join(",");
}
function randomBytes(bytes) {
    for (let attempt = 0; attempt < RANDOM_ID_ATTEMPTS; attempt += 1) {
        const buffer = new Uint8Array(bytes);
        crypto.getRandomValues(buffer);
        if (buffer.some((byte) => byte !== 0)) {
            return buffer;
        }
    }
    throw new TypeError("cail-log: secure random source produced an all-zero identifier");
}
function randomHex(bytes) {
    let output = "";
    for (const byte of randomBytes(bytes)) {
        output += byte.toString(16).padStart(2, "0");
    }
    return output;
}
function mintRequestId() {
    if (typeof crypto.randomUUID === "function")
        return crypto.randomUUID();
    const bytes = randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function headersOf(source) {
    if (!source || typeof source !== "object")
        return null;
    if (typeof source.get === "function") {
        return source;
    }
    const inner = source.headers;
    return inner && typeof inner.get === "function" ? inner : null;
}
export function correlationFromHeaders(source, options = {}) {
    let traceId;
    let inboundTraceFlags;
    let requestId;
    let tracestate;
    let sampled;
    try {
        sampled = options.sampled;
    }
    catch {
        // A hostile options reader behaves like an omitted recording decision.
    }
    let headers = null;
    try {
        headers = headersOf(source);
    }
    catch {
        // A hostile source behaves like missing headers.
    }
    if (headers) {
        let rawTraceparent = null;
        let rawTracestate = null;
        let rawRequestId = null;
        try {
            rawTraceparent = headers.get(TRACEPARENT_HEADER);
            rawTracestate = headers.get(TRACESTATE_HEADER);
            rawRequestId = headers.get(CAIL_REQUEST_ID_HEADER);
        }
        catch {
            // A hostile reader behaves like missing headers.
        }
        if (typeof rawTraceparent === "string") {
            const match = TRACEPARENT_RE.exec(rawTraceparent.trim());
            if (match &&
                match[1] !== "ff" &&
                !(match[1] === "00" && match[5] !== undefined) &&
                match[2] !== ZERO_TRACE &&
                match[3] !== ZERO_SPAN) {
                traceId = match[2];
                inboundTraceFlags = (Number.parseInt(match[4], 16) & 1);
            }
        }
        if (traceId !== undefined) {
            tracestate = sanitizeTracestate(rawTracestate);
        }
        if (typeof rawRequestId === "string") {
            const candidate = rawRequestId.trim();
            if (REQUEST_ID_RE.test(candidate))
                requestId = candidate;
        }
    }
    const correlation = {
        trace_id: traceId ?? randomHex(16),
        span_id: randomHex(8),
        trace_flags: typeof sampled === "boolean"
            ? sampled
                ? 1
                : 0
            : (inboundTraceFlags ?? 0),
        request_id: requestId ?? mintRequestId(),
    };
    if (tracestate !== undefined)
        correlation.tracestate = tracestate;
    return correlation;
}
export function outboundCorrelationHeaders(correlation) {
    const { traceId, spanId, traceFlags, requestId, tracestate, } = snapshotCorrelation(correlation);
    if (typeof traceId !== "string" ||
        !HEX_TRACE_RE.test(traceId) ||
        traceId === ZERO_TRACE) {
        throw new TypeError("cail-log: trace_id must be 32 lowercase hex chars, not all-zero");
    }
    if (typeof spanId !== "string" ||
        !HEX_SPAN_RE.test(spanId) ||
        spanId === ZERO_SPAN) {
        throw new TypeError("cail-log: span_id must be 16 lowercase hex chars, not all-zero");
    }
    if (typeof requestId !== "string" || !REQUEST_ID_RE.test(requestId)) {
        throw new TypeError("cail-log: request_id must be a lowercase UUID v4 or v7");
    }
    if (traceFlags !== 0 && traceFlags !== 1) {
        throw new TypeError("cail-log: trace_flags must be 0 or 1");
    }
    if (tracestate !== undefined &&
        (typeof tracestate !== "string" ||
            sanitizeTracestate(tracestate) !== tracestate)) {
        throw new TypeError("cail-log: tracestate must be a structurally valid W3C tracestate list");
    }
    const headers = {
        [TRACEPARENT_HEADER]: `00-${traceId}-${spanId}-0${traceFlags}`,
        [CAIL_REQUEST_ID_HEADER]: requestId,
    };
    if (tracestate !== undefined)
        headers[TRACESTATE_HEADER] = tracestate;
    return headers;
}
