import { isSecretShaped } from "./secret-shape.js";
export const CAIL_LOG_SCHEMA_VERSION = 2;
/** Current version tag for privacy-bounded operational subject pseudonyms. */
export const CAIL_OPERATIONAL_SUBJECT_VERSION = "v1";
export const CAIL_EVENT_INVALID = "event.invalid";
export const CAIL_EVENT_INVALID_MESSAGE = "Event name rejected.";
export const CAIL_SEVERITY_NUMBER = Object.freeze({
    trace: 1,
    debug: 5,
    info: 9,
    warn: 13,
    error: 17,
    fatal: 21,
});
export const CAIL_SERVICE_EVENT_BODY = "Service event recorded.";
export const CAIL_TENANT_FIELD_NAMES = Object.freeze([
    "request_id",
    "action_id",
    "call_id",
    "trace",
    "http_method",
    "route",
    "status",
    "terminal",
    "duration_ms",
    "upstream_ms",
    "error_type",
    "retry_count",
    "req_bytes",
    "resp_bytes",
]);
export const CAIL_PLATFORM_ONLY_FIELD_NAMES = Object.freeze([
    "usage_id",
    "principal",
    "cohort",
    "key_id",
    "product_id",
    "project",
    "provider",
    "request_model",
    "response_model",
    "input_tokens",
    "output_tokens",
    "cost_micro_usd",
    "quota",
    "usage",
]);
export const CAIL_PLATFORM_FIELD_NAMES = Object.freeze([
    ...CAIL_TENANT_FIELD_NAMES,
    ...CAIL_PLATFORM_ONLY_FIELD_NAMES,
]);
export const CAIL_EVENTS = Object.freeze({
    ACTION_ADMITTED: "cail.action.admitted",
    ACTION_TERMINAL: "cail.action.terminal",
    REQUEST_RECEIVED: "cail.request.received",
    REQUEST_COMPLETED: "cail.request.completed",
    AUTH_DENIED: "cail.auth.denied",
    QUOTA_CHARGED: "cail.quota.charged",
    UPSTREAM_ERROR: "cail.upstream.error",
    MODEL_CALL_ADMITTED: "cail.model.call.admitted",
    MODEL_CALL_TERMINAL: "cail.model.call.terminal",
    SANDBOX_USAGE_SETTLED: "cail.sandbox.usage.settled",
});
export const SLUG_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export const MACHINE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const MODEL_ID_RE = /^(?:@[a-z0-9][a-z0-9._-]{0,31}\/)?[a-z0-9][a-z0-9._:/-]{0,95}$/;
export const SUBJECT_VERSION_RE = /^[a-z0-9][a-z0-9_]{0,15}$/;
export const SUBJECT_RE = /^cail-[a-z0-9][a-z0-9_]{0,15}-[0-9a-f]{32}$/;
export const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const HEX_TRACE_RE = /^[0-9a-f]{32}$/;
export const HEX_SPAN_RE = /^[0-9a-f]{16}$/;
export const ROUTE_TEMPLATE_RE = /^\/(?:$|(?:(?:[A-Za-z0-9._~-]+|\{[A-Za-z][A-Za-z0-9_]*\})(?:\/(?:[A-Za-z0-9._~-]+|\{[A-Za-z][A-Za-z0-9_]*\}))*\/?))$/;
export const HTTP_METHODS = Object.freeze([
    "CONNECT",
    "DELETE",
    "GET",
    "HEAD",
    "OPTIONS",
    "PATCH",
    "POST",
    "PUT",
    "QUERY",
    "TRACE",
    "_OTHER",
]);
/** True only for the versioned pseudonym allowed in operational events. */
export function isOperationalLogSubject(value) {
    return typeof value === "string" && SUBJECT_RE.test(value);
}
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const MAX_CATALOG_MESSAGE = 160;
const VALIDATED_EVENT_CATALOGS = new WeakSet();
export function isPlainObject(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function buildEventCatalog(catalog, allowReservedCailNamespace) {
    if (!isPlainObject(catalog)) {
        throw new TypeError("cail-log: event catalog must be an object");
    }
    const copy = Object.create(null);
    const tenantFields = new Set(CAIL_TENANT_FIELD_NAMES);
    const platformFields = new Set(CAIL_PLATFORM_FIELD_NAMES);
    const outcomes = new Set([
        "ok",
        "client_error",
        "error",
        "denied",
        "cancelled",
        "timeout",
        "outcome_unknown",
    ]);
    const terminalReasons = new Set([
        "application_failure",
        "cancelled",
        "client_error",
        "completed",
        "denied",
        "quota_blocked",
        "rate_limited",
        "timeout",
        "unknown",
        "upstream_failure",
    ]);
    const sources = new Set(["platform", "tenant", "both"]);
    const severities = new Set([
        "fatal",
        "error",
        "warn",
        "info",
        "debug",
        "trace",
        "outcome",
    ]);
    for (const event of Object.keys(catalog)) {
        if (event === CAIL_EVENT_INVALID ||
            (!allowReservedCailNamespace && event.startsWith("cail.")) ||
            isSecretShaped(event) ||
            !SLUG_RE.test(event)) {
            throw new TypeError("cail-log: every catalog event must be a non-reserved event slug");
        }
        const definition = catalog[event];
        if (!isPlainObject(definition)) {
            throw new TypeError("cail-log: every event definition must be an object");
        }
        const message = definition.body;
        if (typeof message !== "string" ||
            message === "" ||
            message !== message.trim() ||
            message.length > MAX_CATALOG_MESSAGE ||
            CONTROL_RE.test(message)) {
            throw new TypeError("cail-log: every catalog message must be a single static line of 1-160 characters");
        }
        if (!sources.has(definition.source)) {
            throw new TypeError("cail-log: event source must be platform, tenant, or both");
        }
        if (!severities.has(definition.severity)) {
            throw new TypeError("cail-log: event severity is invalid");
        }
        if (!Array.isArray(definition.required) || !Array.isArray(definition.optional)) {
            throw new TypeError("cail-log: event required and optional fields must be arrays");
        }
        const allowedFields = definition.source === "platform" ? platformFields : tenantFields;
        const required = [...definition.required];
        const optional = [...definition.optional];
        const combined = [...required, ...optional];
        if (combined.some((field) => typeof field !== "string" || !allowedFields.has(field)) ||
            new Set(combined).size !== combined.length) {
            throw new TypeError("cail-log: event fields must be valid, unique, and source-compatible");
        }
        if (definition.severity === "outcome" && !required.includes("terminal")) {
            throw new TypeError("cail-log: outcome severity requires the terminal field");
        }
        if (required.includes("key_id") && !required.includes("principal")) {
            throw new TypeError("cail-log: required key identity requires a required principal field");
        }
        if (combined.includes("key_id") && !combined.includes("principal")) {
            throw new TypeError("cail-log: key identity requires an allowed principal field");
        }
        const allowedOutcomes = definition.outcomes
            ? [...definition.outcomes]
            : undefined;
        if (allowedOutcomes !== undefined &&
            (allowedOutcomes.length === 0 ||
                !required.includes("terminal") ||
                new Set(allowedOutcomes).size !== allowedOutcomes.length ||
                allowedOutcomes.some((outcome) => !outcomes.has(outcome)))) {
            throw new TypeError("cail-log: event outcomes are invalid");
        }
        const allowedReasons = definition.terminal_reasons
            ? [...definition.terminal_reasons]
            : undefined;
        if (allowedReasons !== undefined &&
            (allowedReasons.length === 0 ||
                !required.includes("terminal") ||
                new Set(allowedReasons).size !== allowedReasons.length ||
                allowedReasons.some((reason) => !terminalReasons.has(reason)))) {
            throw new TypeError("cail-log: event terminal reasons are invalid");
        }
        const reasonsByOutcome = {
            ok: ["completed"],
            client_error: ["client_error"],
            error: ["application_failure", "upstream_failure"],
            denied: ["denied", "quota_blocked", "rate_limited"],
            cancelled: ["cancelled"],
            timeout: ["timeout"],
            outcome_unknown: ["unknown"],
        };
        if (allowedOutcomes !== undefined &&
            allowedReasons !== undefined &&
            (allowedOutcomes.some((outcome) => !allowedReasons.some((reason) => reasonsByOutcome[outcome].includes(reason))) ||
                allowedReasons.some((reason) => !allowedOutcomes.some((outcome) => reasonsByOutcome[outcome].includes(reason))))) {
            throw new TypeError("cail-log: event outcomes and terminal reasons are incompatible");
        }
        const possibleOutcomes = (allowedOutcomes ?? [...outcomes]).filter((outcome) => outcomes.has(outcome));
        const possibleReasons = new Set((allowedReasons ?? [...terminalReasons]).filter((reason) => terminalReasons.has(reason)));
        const possibleTerminalOutcomes = possibleOutcomes.filter((outcome) => reasonsByOutcome[outcome].some((reason) => possibleReasons.has(reason)));
        if (required.includes("terminal") &&
            required.includes("error_type") &&
            possibleTerminalOutcomes.includes("ok")) {
            throw new TypeError("cail-log: a required error type is incompatible with a successful terminal fact");
        }
        const frozen = {
            body: message,
            source: definition.source,
            severity: definition.severity,
            required: Object.freeze(required),
            optional: Object.freeze(optional),
        };
        if (allowedOutcomes !== undefined) {
            frozen.outcomes =
                Object.freeze(allowedOutcomes);
        }
        if (allowedReasons !== undefined) {
            frozen
                .terminal_reasons = Object.freeze(allowedReasons);
        }
        copy[event] = Object.freeze(frozen);
    }
    if (Object.keys(copy).length === 0) {
        throw new TypeError("cail-log: event catalog must not be empty");
    }
    const frozenCatalog = Object.freeze(copy);
    VALIDATED_EVENT_CATALOGS.add(frozenCatalog);
    return frozenCatalog;
}
export function defineEventCatalog(catalog) {
    if (!isPlainObject(catalog)) {
        throw new TypeError("cail-log: event catalog must be an object");
    }
    const withBodies = Object.create(null);
    for (const [event, value] of Object.entries(catalog)) {
        if (!isPlainObject(value) ||
            (Object.hasOwn(value, "body") && value["body"] !== undefined)) {
            throw new TypeError("cail-log: service event bodies are fixed by the library");
        }
        withBodies[event] = {
            ...value,
            body: CAIL_SERVICE_EVENT_BODY,
        };
    }
    return buildEventCatalog(withBodies, false);
}
export function isDefinedEventCatalog(value) {
    return (typeof value === "object" &&
        value !== null &&
        VALIDATED_EVENT_CATALOGS.has(value));
}
export const CAIL_EVENT_CATALOG = buildEventCatalog({
    [CAIL_EVENTS.ACTION_ADMITTED]: {
        body: "Action admitted.", source: "platform", severity: "info",
        required: ["action_id", "product_id", "principal"],
        optional: ["request_id", "trace", "cohort", "key_id", "project", "http_method", "route"],
    },
    [CAIL_EVENTS.ACTION_TERMINAL]: {
        body: "Action reached a terminal state.", source: "platform", severity: "outcome",
        required: ["action_id", "product_id", "principal", "terminal", "duration_ms"],
        optional: ["request_id", "trace", "cohort", "key_id", "project", "http_method", "route", "error_type", "retry_count"],
    },
    [CAIL_EVENTS.REQUEST_RECEIVED]: {
        body: "Request received.", source: "platform", severity: "info",
        required: ["request_id", "product_id", "http_method", "route"],
        optional: ["trace", "principal", "cohort", "key_id", "project", "req_bytes"],
    },
    [CAIL_EVENTS.REQUEST_COMPLETED]: {
        body: "Request completed.", source: "platform", severity: "outcome",
        required: ["request_id", "product_id", "http_method", "route", "status", "terminal", "duration_ms"],
        optional: ["action_id", "call_id", "trace", "principal", "cohort", "key_id", "project", "upstream_ms", "error_type", "retry_count", "req_bytes", "resp_bytes"],
    },
    [CAIL_EVENTS.AUTH_DENIED]: {
        body: "Authentication or authorization denied.", source: "platform", severity: "warn",
        required: ["request_id", "product_id", "principal", "http_method", "route", "status", "terminal"],
        optional: ["trace", "cohort", "project", "error_type"],
        outcomes: ["denied"], terminal_reasons: ["denied"],
    },
    [CAIL_EVENTS.QUOTA_CHARGED]: {
        body: "Quota charged.", source: "platform", severity: "info",
        required: ["product_id", "principal", "terminal", "quota"],
        optional: ["request_id", "action_id", "call_id", "trace", "cohort", "key_id", "project"],
        outcomes: ["ok"], terminal_reasons: ["completed"],
    },
    [CAIL_EVENTS.UPSTREAM_ERROR]: {
        body: "Upstream provider call failed.", source: "platform", severity: "error",
        required: ["request_id", "product_id", "terminal", "error_type"],
        optional: ["action_id", "call_id", "trace", "principal", "cohort", "project", "provider", "request_model", "response_model", "status", "duration_ms", "upstream_ms", "retry_count"],
        outcomes: ["error", "timeout", "outcome_unknown"],
        terminal_reasons: ["upstream_failure", "timeout", "unknown"],
    },
    [CAIL_EVENTS.MODEL_CALL_ADMITTED]: {
        body: "Model call admitted.", source: "platform", severity: "info",
        required: ["call_id", "action_id", "product_id", "principal", "provider", "request_model"],
        optional: ["request_id", "trace", "cohort", "key_id", "project", "quota"],
    },
    [CAIL_EVENTS.MODEL_CALL_TERMINAL]: {
        body: "Model call reached a terminal state.", source: "platform", severity: "outcome",
        required: ["call_id", "action_id", "product_id", "principal", "provider", "request_model", "terminal", "duration_ms"],
        optional: ["request_id", "trace", "cohort", "key_id", "project", "response_model", "input_tokens", "output_tokens", "cost_micro_usd", "quota", "status", "upstream_ms", "error_type", "retry_count"],
    },
    [CAIL_EVENTS.SANDBOX_USAGE_SETTLED]: {
        body: "Sandbox usage settled.", source: "platform", severity: "info",
        required: ["usage_id", "product_id", "principal", "terminal", "usage"],
        optional: ["request_id", "action_id", "trace", "cohort", "key_id", "project", "quota", "duration_ms", "retry_count"],
        outcomes: ["ok"], terminal_reasons: ["completed"],
    },
}, true);
export function extendCailEventCatalog(catalog) {
    const serviceCatalog = defineEventCatalog(catalog);
    const combined = Object.assign(Object.create(null), CAIL_EVENT_CATALOG, serviceCatalog);
    const frozen = Object.freeze(combined);
    VALIDATED_EVENT_CATALOGS.add(frozen);
    return frozen;
}
