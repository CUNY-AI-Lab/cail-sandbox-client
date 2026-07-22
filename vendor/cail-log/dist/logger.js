import { CAIL_EVENT_INVALID, CAIL_EVENT_INVALID_MESSAGE, CAIL_LOG_SCHEMA_VERSION, CAIL_PLATFORM_FIELD_NAMES, CAIL_SEVERITY_NUMBER, HEX_SPAN_RE, HEX_TRACE_RE, HTTP_METHODS, MACHINE_ID_RE, MODEL_ID_RE, REQUEST_ID_RE, ROUTE_TEMPLATE_RE, SLUG_RE, SUBJECT_RE, SUBJECT_VERSION_RE, isDefinedEventCatalog, isPlainObject, } from "./schema.js";
import { assertValidatedEvent, markValidatedEvent, } from "./event-provenance.js";
import { isSensitive } from "./sensitive.js";
import { isSecretShaped } from "./secret-shape.js";
function isPromiseLike(value) {
    return ((typeof value === "object" || typeof value === "function") &&
        value !== null &&
        typeof value.then === "function");
}
const ENVIRONMENTS = new Set([
    "production",
    "staging",
    "development",
    "test",
]);
const SOURCE_CLASSES = new Set(["platform", "tenant"]);
const KNOWN_FIELDS = new Set(CAIL_PLATFORM_FIELD_NAMES);
function sanitizePattern(value, pattern) {
    if (isSensitive(value) || typeof value !== "string")
        return undefined;
    if (isSecretShaped(value))
        return undefined;
    return pattern.test(value) ? value : undefined;
}
function sanitizeEnum(value, allowed) {
    return typeof value === "string" && allowed.includes(value)
        ? value
        : undefined;
}
function sanitizeDuration(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : undefined;
}
function sanitizeCounter(value) {
    return typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0
        ? value
        : undefined;
}
function sanitizeStatus(value) {
    return typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 100 &&
        value <= 599
        ? value
        : undefined;
}
function sanitizeRouteTemplate(value) {
    if (typeof value !== "string" || value.length > 160)
        return undefined;
    return sanitizePattern(value, ROUTE_TEMPLATE_RE);
}
const COMMON_FIELD_DEFS = Object.freeze({
    request_id: ["cail.request.id", (value) => sanitizePattern(value, REQUEST_ID_RE)],
    action_id: ["cail.action.id", (value) => sanitizePattern(value, REQUEST_ID_RE)],
    call_id: ["cail.call.id", (value) => sanitizePattern(value, REQUEST_ID_RE)],
    http_method: ["http.request.method", (value) => sanitizeEnum(value, HTTP_METHODS)],
    route: ["url.template", sanitizeRouteTemplate],
    status: ["http.response.status_code", sanitizeStatus],
    duration_ms: ["cail.operation.duration_ms", sanitizeDuration],
    upstream_ms: ["cail.upstream.duration_ms", sanitizeDuration],
    error_type: ["error.type", (value) => sanitizePattern(value, SLUG_RE)],
    retry_count: ["cail.retry.count", sanitizeCounter],
    req_bytes: ["http.request.body.size", sanitizeCounter],
    resp_bytes: ["http.response.body.size", sanitizeCounter],
});
const PLATFORM_FIELD_DEFS = Object.freeze({
    usage_id: ["cail.usage.id", (value) => sanitizePattern(value, REQUEST_ID_RE)],
    cohort: ["cail.cohort.id", (value) => sanitizePattern(value, SLUG_RE)],
    key_id: ["cail.key.id", (value) => sanitizePattern(value, MACHINE_ID_RE)],
    product_id: ["cail.product.id", (value) => sanitizePattern(value, SLUG_RE)],
    project: ["cail.kale.project.name", (value) => sanitizePattern(value, SLUG_RE)],
    provider: ["gen_ai.provider.name", (value) => sanitizePattern(value, SLUG_RE)],
    request_model: ["gen_ai.request.model", (value) => sanitizePattern(value, MODEL_ID_RE)],
    response_model: ["gen_ai.response.model", (value) => sanitizePattern(value, MODEL_ID_RE)],
    input_tokens: ["gen_ai.usage.input_tokens", sanitizeCounter],
    output_tokens: ["gen_ai.usage.output_tokens", sanitizeCounter],
    cost_micro_usd: ["cail.gen_ai.cost.micro_usd", sanitizeCounter],
});
const QUOTA_UNITS = Object.freeze({
    model_spend: "micro_usd",
    request_count: "requests",
    build_count: "builds",
    storage: "bytes",
    compute: "milliseconds",
    sandbox_compute: "gib_seconds",
});
function sanitizeIsoTimestamp(value) {
    if (typeof value !== "string")
        return undefined;
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds))
        return undefined;
    return new Date(milliseconds).toISOString() === value ? value : undefined;
}
function sanitizeQuota(value) {
    if (!isPlainObject(value))
        return undefined;
    const kind = sanitizePattern(value["kind"], SLUG_RE);
    const unit = sanitizePattern(value["unit"], SLUG_RE);
    const state = sanitizeEnum(value["state"], ["fresh", "stale"]);
    const limit = sanitizeCounter(value["limit"]);
    const used = sanitizeCounter(value["used"]);
    const resetAt = sanitizeIsoTimestamp(value["reset_at"]);
    if (kind === undefined ||
        unit === undefined ||
        QUOTA_UNITS[kind] !== unit ||
        state === undefined ||
        limit === undefined ||
        used === undefined ||
        resetAt === undefined) {
        return undefined;
    }
    return {
        kind,
        unit,
        state,
        limit,
        used,
        remaining: Math.max(limit - used, 0),
        reset_at: resetAt,
    };
}
function sanitizeUsage(value) {
    if (!isPlainObject(value))
        return undefined;
    if (value["kind"] !== "sandbox_compute" ||
        value["unit"] !== "mib_milliseconds") {
        return undefined;
    }
    const quantity = sanitizeCounter(value["quantity"]);
    if (quantity === undefined)
        return undefined;
    return {
        kind: "sandbox_compute",
        unit: "mib_milliseconds",
        quantity,
    };
}
function sanitizeTrace(value) {
    if (!isPlainObject(value))
        return undefined;
    const traceId = sanitizePattern(value["trace_id"], HEX_TRACE_RE);
    const spanId = sanitizePattern(value["span_id"], HEX_SPAN_RE);
    const traceFlags = value["trace_flags"];
    if (traceId === undefined ||
        traceId === "0".repeat(32) ||
        spanId === undefined ||
        spanId === "0".repeat(16) ||
        (traceFlags !== 0 && traceFlags !== 1)) {
        return undefined;
    }
    return { trace_id: traceId, span_id: spanId, trace_flags: traceFlags };
}
function sanitizePrincipal(value, subjectVersion) {
    if (!isPlainObject(value))
        return undefined;
    const type = sanitizeEnum(value["type"], [
        "user",
        "app",
        "service",
        "canary",
        "anonymous",
    ]);
    if (type === undefined)
        return undefined;
    const principalType = type;
    const subjectValue = Object.hasOwn(value, "subject")
        ? value["subject"]
        : undefined;
    const hasSubject = subjectValue !== undefined;
    if (principalType === "user" || principalType === "canary") {
        if (subjectVersion === undefined)
            return undefined;
        const subject = sanitizePattern(subjectValue, SUBJECT_RE);
        return subject === undefined ||
            !subject.startsWith(`cail-${subjectVersion}-`)
            ? undefined
            : { type: principalType, subject };
    }
    return hasSubject ? undefined : { type: principalType };
}
const TERMINAL_REASONS = Object.freeze({
    ok: ["completed"],
    client_error: ["client_error"],
    error: ["application_failure", "upstream_failure"],
    denied: ["denied", "quota_blocked", "rate_limited"],
    cancelled: ["cancelled"],
    timeout: ["timeout"],
    outcome_unknown: ["unknown"],
});
function sanitizeTerminal(value) {
    if (!isPlainObject(value))
        return undefined;
    const outcome = sanitizeEnum(value["outcome"], Object.keys(TERMINAL_REASONS));
    const reason = typeof value["reason"] === "string" ? value["reason"] : undefined;
    if (outcome === undefined ||
        reason === undefined ||
        !TERMINAL_REASONS[outcome].includes(reason)) {
        return undefined;
    }
    return { outcome: outcome, reason };
}
export function jsonLineSink(event) {
    assertValidatedEvent(event);
    console.log(JSON.stringify(event));
}
export function toWorkersLogEvent(event) {
    assertValidatedEvent(event);
    const output = {
        ...event.attributes,
        "service.namespace": event.resource["service.namespace"],
        "service.name": event.resource["service.name"],
        "service.version": event.resource["service.version"],
        "deployment.environment.name": event.resource["deployment.environment.name"],
        "cail.schema.version": event.schema_version,
        timestamp: event.timestamp,
        severity_text: event.severity_text,
        severity_number: event.severity_number,
        "event.name": event.event_name,
        body: event.body,
    };
    if (event.trace_id !== undefined)
        output.trace_id = event.trace_id;
    if (event.span_id !== undefined)
        output.span_id = event.span_id;
    if (event.trace_flags !== undefined)
        output.trace_flags = event.trace_flags;
    return Object.freeze(output);
}
export function workersStructuredSink(event) {
    const output = toWorkersLogEvent(event);
    if (event.severity_number >= CAIL_SEVERITY_NUMBER.error) {
        console.error(output);
    }
    else if (event.severity_number >= CAIL_SEVERITY_NUMBER.warn) {
        console.warn(output);
    }
    else {
        console.log(output);
    }
}
function buildEvent(eventName, fields, timestamp, context, catalog, report) {
    const knownEvent = typeof eventName === "string" && Object.hasOwn(catalog, eventName);
    if (!knownEvent) {
        report("event_invalid");
        return Object.freeze({
            schema_version: CAIL_LOG_SCHEMA_VERSION,
            timestamp,
            severity_text: "ERROR",
            severity_number: CAIL_SEVERITY_NUMBER.error,
            event_name: CAIL_EVENT_INVALID,
            body: CAIL_EVENT_INVALID_MESSAGE,
            resource: Object.freeze({ ...context.resource }),
            attributes: Object.freeze({
                "cail.source.class": context.sourceClass,
            }),
        });
    }
    const definition = catalog[eventName];
    if (definition.source !== "both" &&
        definition.source !== context.sourceClass) {
        report("event_contract_error");
        return undefined;
    }
    let rawInput;
    if (fields === undefined) {
        rawInput = {};
    }
    else if (isPlainObject(fields)) {
        rawInput = fields;
    }
    else {
        report("event_contract_error");
        return undefined;
    }
    const allowed = new Set([
        ...definition.required,
        ...definition.optional,
    ]);
    const input = Object.create(null);
    for (const key of KNOWN_FIELDS) {
        if (!Object.hasOwn(rawInput, key))
            continue;
        const value = rawInput[key];
        if (value === undefined)
            continue;
        if (!allowed.has(key)) {
            report("event_contract_error");
            return undefined;
        }
        input[key] = value;
    }
    const attributes = {
        "cail.source.class": context.sourceClass,
    };
    const accepted = new Set();
    for (const [key, [attribute, sanitizer]] of Object.entries(COMMON_FIELD_DEFS)) {
        if (!allowed.has(key) || !Object.hasOwn(input, key))
            continue;
        const clean = sanitizer(input[key]);
        if (clean === undefined) {
            report("event_contract_error");
            return undefined;
        }
        attributes[attribute] = clean;
        accepted.add(key);
    }
    let traceId;
    let spanId;
    let traceFlags;
    if (allowed.has("trace") && Object.hasOwn(input, "trace")) {
        const trace = sanitizeTrace(input["trace"]);
        if (trace === undefined) {
            report("event_contract_error");
            return undefined;
        }
        ({ trace_id: traceId, span_id: spanId, trace_flags: traceFlags } = trace);
        accepted.add("trace");
    }
    if (context.sourceClass === "platform") {
        for (const [key, [attribute, sanitizer]] of Object.entries(PLATFORM_FIELD_DEFS)) {
            if (!allowed.has(key) || !Object.hasOwn(input, key))
                continue;
            const clean = sanitizer(input[key]);
            if (clean === undefined) {
                report("event_contract_error");
                return undefined;
            }
            attributes[attribute] = clean;
            accepted.add(key);
        }
        if (allowed.has("principal") && Object.hasOwn(input, "principal")) {
            const principal = sanitizePrincipal(input["principal"], context.subjectVersion);
            if (principal === undefined) {
                report("event_contract_error");
                return undefined;
            }
            attributes["cail.principal.type"] = principal.type;
            if (principal.subject !== undefined) {
                attributes["enduser.pseudo.id"] = principal.subject;
            }
            accepted.add("principal");
        }
        if (allowed.has("quota") && Object.hasOwn(input, "quota")) {
            const quota = sanitizeQuota(input["quota"]);
            if (quota === undefined) {
                report("event_contract_error");
                return undefined;
            }
            attributes["cail.quota.kind"] = quota.kind;
            attributes["cail.quota.unit"] = quota.unit;
            attributes["cail.quota.state"] = quota.state;
            attributes["cail.quota.limit"] = quota.limit;
            attributes["cail.quota.used"] = quota.used;
            attributes["cail.quota.remaining"] = quota.remaining;
            attributes["cail.quota.reset_at"] = quota.reset_at;
            accepted.add("quota");
        }
        if (allowed.has("usage") && Object.hasOwn(input, "usage")) {
            const usage = sanitizeUsage(input["usage"]);
            if (usage === undefined) {
                report("event_contract_error");
                return undefined;
            }
            attributes["cail.usage.kind"] = usage.kind;
            attributes["cail.usage.unit"] = usage.unit;
            attributes["cail.usage.quantity"] = usage.quantity;
            accepted.add("usage");
        }
    }
    if (allowed.has("terminal") && Object.hasOwn(input, "terminal")) {
        const terminal = sanitizeTerminal(input["terminal"]);
        if (terminal === undefined) {
            report("event_contract_error");
            return undefined;
        }
        attributes["cail.outcome"] = terminal.outcome;
        attributes["cail.outcome.reason"] = terminal.reason;
        accepted.add("terminal");
    }
    if (definition.required.some((field) => !accepted.has(field))) {
        report("event_contract_error");
        return undefined;
    }
    const outcome = attributes["cail.outcome"];
    const terminalReason = attributes["cail.outcome.reason"];
    const principalType = attributes["cail.principal.type"];
    if ((outcome === "ok" && attributes["error.type"] !== undefined) ||
        (attributes["cail.key.id"] !== undefined &&
            (principalType === undefined || principalType === "anonymous")) ||
        (definition.outcomes !== undefined &&
            (outcome === undefined || !definition.outcomes.includes(outcome))) ||
        (definition.terminal_reasons !== undefined &&
            (terminalReason === undefined ||
                !definition.terminal_reasons.includes(terminalReason)))) {
        report("event_contract_error");
        return undefined;
    }
    const level = definition.severity === "outcome"
        ? outcome === "ok" || outcome === "cancelled"
            ? "info"
            : outcome === "client_error" || outcome === "denied" || outcome === "outcome_unknown"
                ? "warn"
                : "error"
        : definition.severity;
    const output = {
        schema_version: CAIL_LOG_SCHEMA_VERSION,
        timestamp,
        severity_text: level.toUpperCase(),
        severity_number: CAIL_SEVERITY_NUMBER[level],
        event_name: eventName,
        body: definition.body,
        resource: context.resource,
        attributes: attributes,
    };
    if (traceId !== undefined && spanId !== undefined && traceFlags !== undefined) {
        output.trace_id = traceId;
        output.span_id = spanId;
        output.trace_flags = traceFlags;
    }
    return Object.freeze({
        ...output,
        resource: Object.freeze({ ...output.resource }),
        attributes: Object.freeze({ ...attributes }),
    });
}
export function createCailLogger(options) {
    if (!isPlainObject(options)) {
        throw new TypeError("cail-log: options must be an object");
    }
    const service = sanitizePattern(options.service, SLUG_RE);
    const release = sanitizePattern(options.release, MACHINE_ID_RE);
    if (service === undefined) {
        throw new TypeError("cail-log: service must be a slug");
    }
    if (release === undefined) {
        throw new TypeError("cail-log: release must be a machine identifier");
    }
    if (!ENVIRONMENTS.has(options.env)) {
        throw new TypeError("cail-log: env must be production, staging, development, or test");
    }
    if (!SOURCE_CLASSES.has(options.sourceClass)) {
        throw new TypeError("cail-log: sourceClass must be platform or tenant");
    }
    const subjectVersion = sanitizePattern(options.subjectVersion, SUBJECT_VERSION_RE);
    if (options.sourceClass === "platform" && subjectVersion === undefined) {
        throw new TypeError("cail-log: platform loggers require a subjectVersion");
    }
    if (options.sourceClass === "tenant" &&
        options.subjectVersion !== undefined) {
        throw new TypeError("cail-log: tenant loggers must not configure a subjectVersion");
    }
    let configuredSink;
    let configuredClock;
    let configuredDiagnostic;
    try {
        configuredSink = options.sink;
        configuredClock = options.clock;
        configuredDiagnostic = options.onDiagnostic;
    }
    catch {
        throw new TypeError("cail-log: callback options must be readable");
    }
    if (typeof configuredSink !== "function") {
        throw new TypeError("cail-log: sink must be an explicit function");
    }
    if (configuredClock !== undefined && typeof configuredClock !== "function") {
        throw new TypeError("cail-log: clock must be a function");
    }
    if (configuredDiagnostic !== undefined &&
        typeof configuredDiagnostic !== "function") {
        throw new TypeError("cail-log: onDiagnostic must be a function");
    }
    if (!isDefinedEventCatalog(options.catalog)) {
        throw new TypeError("cail-log: catalog must come from defineEventCatalog, extendCailEventCatalog, or CAIL_EVENT_CATALOG");
    }
    const catalog = options.catalog;
    const sink = configuredSink;
    const clock = configuredClock ?? Date.now;
    const onDiagnostic = configuredDiagnostic;
    const context = {
        sourceClass: options.sourceClass,
        subjectVersion,
        resource: Object.freeze({
            "service.namespace": "cuny-ai-lab",
            "service.name": service,
            "service.version": release,
            "deployment.environment.name": options.env,
        }),
    };
    function reportFallbackDiagnostic() {
        try {
            console.error("cail-log: diagnostic_error");
        }
        catch {
            // Nothing else can safely report this failure.
        }
    }
    function report(code) {
        if (onDiagnostic !== undefined) {
            try {
                const result = onDiagnostic(code);
                if (isPromiseLike(result)) {
                    Promise.resolve(result).catch(reportFallbackDiagnostic);
                }
                return;
            }
            catch {
                reportFallbackDiagnostic();
                return;
            }
        }
        try {
            console.error(`cail-log: ${code}`);
        }
        catch {
            // Logging must never break the application path.
        }
    }
    function emit(event, fields) {
        let now;
        try {
            now = clock();
            if (!Number.isFinite(now))
                throw new TypeError("invalid clock");
        }
        catch {
            report("clock_error");
            try {
                now = Date.now();
                if (!Number.isFinite(now))
                    throw new TypeError("invalid fallback clock");
            }
            catch {
                report("event_dropped");
                return;
            }
        }
        let logEvent;
        try {
            logEvent = buildEvent(event, fields, new Date(now).toISOString(), context, catalog, report);
        }
        catch {
            report("event_dropped");
            return;
        }
        if (logEvent === undefined)
            return;
        markValidatedEvent(logEvent);
        try {
            const result = sink(logEvent);
            if (isPromiseLike(result)) {
                Promise.resolve(result).catch(() => report("sink_error"));
            }
        }
        catch {
            report("sink_error");
        }
    }
    return {
        emit,
    };
}
