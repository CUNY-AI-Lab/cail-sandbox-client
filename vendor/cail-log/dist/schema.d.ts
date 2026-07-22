export declare const CAIL_LOG_SCHEMA_VERSION: 2;
/** Current version tag for privacy-bounded operational subject pseudonyms. */
export declare const CAIL_OPERATIONAL_SUBJECT_VERSION: "v1";
export declare const CAIL_EVENT_INVALID: "event.invalid";
export declare const CAIL_EVENT_INVALID_MESSAGE: "Event name rejected.";
export type CailLogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";
export declare const CAIL_SEVERITY_NUMBER: Readonly<Record<CailLogLevel, number>>;
export type CailLogEnvironment = "production" | "staging" | "development" | "test";
export type CailSourceClass = "platform" | "tenant";
export type CailOutcome = "ok" | "client_error" | "error" | "denied" | "cancelled" | "timeout" | "outcome_unknown";
export type CailTerminalReason = "application_failure" | "cancelled" | "client_error" | "completed" | "denied" | "quota_blocked" | "rate_limited" | "timeout" | "unknown" | "upstream_failure";
export type CailPrincipalType = "user" | "app" | "service" | "canary" | "anonymous";
export type CailPrincipalFields = Readonly<{
    type: "user" | "canary";
    subject: string;
}> | Readonly<{
    type: "app" | "service" | "anonymous";
    subject?: never;
}>;
export type CailTraceFields = Readonly<{
    trace_id: string;
    span_id: string;
    trace_flags: 0 | 1;
}>;
export type CailTerminalFields = Readonly<{
    outcome: "ok";
    reason: "completed";
}> | Readonly<{
    outcome: "client_error";
    reason: "client_error";
}> | Readonly<{
    outcome: "error";
    reason: "application_failure";
}> | Readonly<{
    outcome: "error";
    reason: "upstream_failure";
}> | Readonly<{
    outcome: "denied";
    reason: "denied";
}> | Readonly<{
    outcome: "denied";
    reason: "quota_blocked";
}> | Readonly<{
    outcome: "denied";
    reason: "rate_limited";
}> | Readonly<{
    outcome: "cancelled";
    reason: "cancelled";
}> | Readonly<{
    outcome: "timeout";
    reason: "timeout";
}> | Readonly<{
    outcome: "outcome_unknown";
    reason: "unknown";
}>;
export type CailQuotaState = "fresh" | "stale";
export type CailHttpMethod = "CONNECT" | "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT" | "QUERY" | "TRACE" | "_OTHER";
export type CailQuotaKindUnit = {
    kind: "model_spend";
    unit: "micro_usd";
} | {
    kind: "request_count";
    unit: "requests";
} | {
    kind: "build_count";
    unit: "builds";
} | {
    kind: "storage";
    unit: "bytes";
} | {
    kind: "compute";
    unit: "milliseconds";
} | {
    kind: "sandbox_compute";
    unit: "gib_seconds";
};
export type CailQuotaFields = CailQuotaKindUnit & {
    state: CailQuotaState;
    limit: number;
    used: number;
    reset_at: string;
};
export type CailQuotaEvent = CailQuotaFields & {
    remaining: number;
};
export type CailUsageKindUnit = {
    kind: "sandbox_compute";
    unit: "mib_milliseconds";
};
export type CailUsageFields = CailUsageKindUnit & {
    quantity: number;
};
export interface CailTenantLogFields {
    request_id?: string;
    action_id?: string;
    call_id?: string;
    trace?: CailTraceFields;
    http_method?: CailHttpMethod;
    route?: string;
    status?: number;
    terminal?: CailTerminalFields;
    duration_ms?: number;
    upstream_ms?: number;
    error_type?: string;
    retry_count?: number;
    req_bytes?: number;
    resp_bytes?: number;
}
export interface CailPlatformLogFields extends CailTenantLogFields {
    usage_id?: string;
    principal?: CailPrincipalFields;
    cohort?: string;
    key_id?: string;
    product_id?: string;
    project?: string;
    provider?: string;
    request_model?: string;
    response_model?: string;
    input_tokens?: number;
    output_tokens?: number;
    cost_micro_usd?: number;
    quota?: CailQuotaFields;
    usage?: CailUsageFields;
}
export type CailLogFields<Source extends CailSourceClass = "tenant"> = Source extends "platform" ? CailPlatformLogFields : CailTenantLogFields;
export type CailLogResource = Readonly<{
    "service.namespace": string;
    "service.name": string;
    "service.version": string;
    "deployment.environment.name": CailLogEnvironment;
}>;
export type CailLogAttributeValue = string | number | boolean;
export type CailLogAttributes = Readonly<{
    "cail.source.class": CailSourceClass;
    "cail.request.id"?: string;
    "cail.action.id"?: string;
    "cail.call.id"?: string;
    "http.request.method"?: CailHttpMethod;
    "url.template"?: string;
    "http.response.status_code"?: number;
    "cail.outcome"?: CailOutcome;
    "cail.outcome.reason"?: CailTerminalReason;
    "cail.operation.duration_ms"?: number;
    "cail.upstream.duration_ms"?: number;
    "error.type"?: string;
    "cail.retry.count"?: number;
    "http.request.body.size"?: number;
    "http.response.body.size"?: number;
    "cail.principal.type"?: CailPrincipalType;
    "cail.usage.id"?: string;
    "enduser.pseudo.id"?: string;
    "cail.cohort.id"?: string;
    "cail.key.id"?: string;
    "cail.product.id"?: string;
    "cail.kale.project.name"?: string;
    "gen_ai.provider.name"?: string;
    "gen_ai.request.model"?: string;
    "gen_ai.response.model"?: string;
    "gen_ai.usage.input_tokens"?: number;
    "gen_ai.usage.output_tokens"?: number;
    "cail.gen_ai.cost.micro_usd"?: number;
    "cail.quota.kind"?: CailQuotaKindUnit["kind"];
    "cail.quota.unit"?: CailQuotaKindUnit["unit"];
    "cail.quota.state"?: CailQuotaState;
    "cail.quota.limit"?: number;
    "cail.quota.used"?: number;
    "cail.quota.remaining"?: number;
    "cail.quota.reset_at"?: string;
    "cail.usage.kind"?: CailUsageKindUnit["kind"];
    "cail.usage.unit"?: CailUsageKindUnit["unit"];
    "cail.usage.quantity"?: number;
}>;
export type CailLogEvent = Readonly<{
    schema_version: typeof CAIL_LOG_SCHEMA_VERSION;
    timestamp: string;
    severity_text: string;
    severity_number: number;
    event_name: string;
    body: string;
    resource: CailLogResource;
    attributes: CailLogAttributes;
    trace_id?: string;
    span_id?: string;
    trace_flags?: 0 | 1;
}>;
export type CailTenantLogFieldName = keyof CailTenantLogFields;
export type CailPlatformLogFieldName = keyof CailPlatformLogFields;
export type CailEventSource = CailSourceClass | "both";
export type CailEventSeverity = CailLogLevel | "outcome";
type CailEventDefinitionBase = Readonly<{
    body: string;
    severity: CailEventSeverity;
    outcomes?: readonly CailOutcome[];
    terminal_reasons?: readonly CailTerminalReason[];
}>;
export type CailEventDefinition = (CailEventDefinitionBase & Readonly<{
    source: "platform";
    required: readonly CailPlatformLogFieldName[];
    optional: readonly CailPlatformLogFieldName[];
}>) | (CailEventDefinitionBase & Readonly<{
    source: "tenant" | "both";
    required: readonly CailTenantLogFieldName[];
    optional: readonly CailTenantLogFieldName[];
}>);
type CailCustomEventDefinitionBase = Readonly<{
    severity: CailEventSeverity;
    outcomes?: readonly CailOutcome[];
    terminal_reasons?: readonly CailTerminalReason[];
}>;
export type CailCustomEventDefinition = (CailCustomEventDefinitionBase & Readonly<{
    source: "platform";
    required: readonly CailPlatformLogFieldName[];
    optional: readonly CailPlatformLogFieldName[];
}>) | (CailCustomEventDefinitionBase & Readonly<{
    source: "tenant" | "both";
    required: readonly CailTenantLogFieldName[];
    optional: readonly CailTenantLogFieldName[];
}>);
export declare const CAIL_SERVICE_EVENT_BODY: "Service event recorded.";
type CailServiceEventDefinition<Definition extends CailCustomEventDefinition> = Readonly<{
    body: typeof CAIL_SERVICE_EVENT_BODY;
    source: Definition["source"];
    severity: Definition["severity"];
    required: Definition["required"];
    optional: Definition["optional"];
}> & (Definition extends {
    outcomes: infer Outcomes extends readonly CailOutcome[];
} ? Readonly<{
    outcomes: Outcomes;
}> : Readonly<{
    outcomes?: never;
}>) & (Definition extends {
    terminal_reasons: infer Reasons extends readonly CailTerminalReason[];
} ? Readonly<{
    terminal_reasons: Reasons;
}> : Readonly<{
    terminal_reasons?: never;
}>);
type CailServiceEventCatalog<Catalog extends Record<string, CailCustomEventDefinition>> = Readonly<{
    [Event in keyof Catalog]: CailServiceEventDefinition<Catalog[Event]>;
}>;
export type CailEventCatalog = Readonly<Record<string, CailEventDefinition>>;
export declare const CAIL_TENANT_FIELD_NAMES: readonly ["request_id", "action_id", "call_id", "trace", "http_method", "route", "status", "terminal", "duration_ms", "upstream_ms", "error_type", "retry_count", "req_bytes", "resp_bytes"];
export declare const CAIL_PLATFORM_ONLY_FIELD_NAMES: readonly ["usage_id", "principal", "cohort", "key_id", "product_id", "project", "provider", "request_model", "response_model", "input_tokens", "output_tokens", "cost_micro_usd", "quota", "usage"];
export declare const CAIL_PLATFORM_FIELD_NAMES: readonly ["request_id", "action_id", "call_id", "trace", "http_method", "route", "status", "terminal", "duration_ms", "upstream_ms", "error_type", "retry_count", "req_bytes", "resp_bytes", "usage_id", "principal", "cohort", "key_id", "product_id", "project", "provider", "request_model", "response_model", "input_tokens", "output_tokens", "cost_micro_usd", "quota", "usage"];
export declare const CAIL_EVENTS: Readonly<{
    readonly ACTION_ADMITTED: "cail.action.admitted";
    readonly ACTION_TERMINAL: "cail.action.terminal";
    readonly REQUEST_RECEIVED: "cail.request.received";
    readonly REQUEST_COMPLETED: "cail.request.completed";
    readonly AUTH_DENIED: "cail.auth.denied";
    readonly QUOTA_CHARGED: "cail.quota.charged";
    readonly UPSTREAM_ERROR: "cail.upstream.error";
    readonly MODEL_CALL_ADMITTED: "cail.model.call.admitted";
    readonly MODEL_CALL_TERMINAL: "cail.model.call.terminal";
    readonly SANDBOX_USAGE_SETTLED: "cail.sandbox.usage.settled";
}>;
export type CailEventName = (typeof CAIL_EVENTS)[keyof typeof CAIL_EVENTS];
export declare const SLUG_RE: RegExp;
export declare const MACHINE_ID_RE: RegExp;
export declare const MODEL_ID_RE: RegExp;
export declare const SUBJECT_VERSION_RE: RegExp;
export declare const SUBJECT_RE: RegExp;
export declare const REQUEST_ID_RE: RegExp;
export declare const HEX_TRACE_RE: RegExp;
export declare const HEX_SPAN_RE: RegExp;
export declare const ROUTE_TEMPLATE_RE: RegExp;
export declare const HTTP_METHODS: readonly CailHttpMethod[];
/** True only for the versioned pseudonym allowed in operational events. */
export declare function isOperationalLogSubject(value: unknown): value is string;
export declare function isPlainObject(value: unknown): value is Record<string, unknown>;
export declare function defineEventCatalog<const Catalog extends Record<string, CailCustomEventDefinition>>(catalog: Catalog & {
    readonly [Event in keyof Catalog]: Readonly<{
        body?: never;
    }>;
}): CailServiceEventCatalog<Catalog>;
export declare function isDefinedEventCatalog(value: unknown): value is CailEventCatalog;
export declare const CAIL_EVENT_CATALOG: Readonly<{
    readonly "cail.action.admitted": {
        readonly body: "Action admitted.";
        readonly source: "platform";
        readonly severity: "info";
        readonly required: readonly ["action_id", "product_id", "principal"];
        readonly optional: readonly ["request_id", "trace", "cohort", "key_id", "project", "http_method", "route"];
    };
    readonly "cail.action.terminal": {
        readonly body: "Action reached a terminal state.";
        readonly source: "platform";
        readonly severity: "outcome";
        readonly required: readonly ["action_id", "product_id", "principal", "terminal", "duration_ms"];
        readonly optional: readonly ["request_id", "trace", "cohort", "key_id", "project", "http_method", "route", "error_type", "retry_count"];
    };
    readonly "cail.request.received": {
        readonly body: "Request received.";
        readonly source: "platform";
        readonly severity: "info";
        readonly required: readonly ["request_id", "product_id", "http_method", "route"];
        readonly optional: readonly ["trace", "principal", "cohort", "key_id", "project", "req_bytes"];
    };
    readonly "cail.request.completed": {
        readonly body: "Request completed.";
        readonly source: "platform";
        readonly severity: "outcome";
        readonly required: readonly ["request_id", "product_id", "http_method", "route", "status", "terminal", "duration_ms"];
        readonly optional: readonly ["action_id", "call_id", "trace", "principal", "cohort", "key_id", "project", "upstream_ms", "error_type", "retry_count", "req_bytes", "resp_bytes"];
    };
    readonly "cail.auth.denied": {
        readonly body: "Authentication or authorization denied.";
        readonly source: "platform";
        readonly severity: "warn";
        readonly required: readonly ["request_id", "product_id", "principal", "http_method", "route", "status", "terminal"];
        readonly optional: readonly ["trace", "cohort", "project", "error_type"];
        readonly outcomes: readonly ["denied"];
        readonly terminal_reasons: readonly ["denied"];
    };
    readonly "cail.quota.charged": {
        readonly body: "Quota charged.";
        readonly source: "platform";
        readonly severity: "info";
        readonly required: readonly ["product_id", "principal", "terminal", "quota"];
        readonly optional: readonly ["request_id", "action_id", "call_id", "trace", "cohort", "key_id", "project"];
        readonly outcomes: readonly ["ok"];
        readonly terminal_reasons: readonly ["completed"];
    };
    readonly "cail.upstream.error": {
        readonly body: "Upstream provider call failed.";
        readonly source: "platform";
        readonly severity: "error";
        readonly required: readonly ["request_id", "product_id", "terminal", "error_type"];
        readonly optional: readonly ["action_id", "call_id", "trace", "principal", "cohort", "project", "provider", "request_model", "response_model", "status", "duration_ms", "upstream_ms", "retry_count"];
        readonly outcomes: readonly ["error", "timeout", "outcome_unknown"];
        readonly terminal_reasons: readonly ["upstream_failure", "timeout", "unknown"];
    };
    readonly "cail.model.call.admitted": {
        readonly body: "Model call admitted.";
        readonly source: "platform";
        readonly severity: "info";
        readonly required: readonly ["call_id", "action_id", "product_id", "principal", "provider", "request_model"];
        readonly optional: readonly ["request_id", "trace", "cohort", "key_id", "project", "quota"];
    };
    readonly "cail.model.call.terminal": {
        readonly body: "Model call reached a terminal state.";
        readonly source: "platform";
        readonly severity: "outcome";
        readonly required: readonly ["call_id", "action_id", "product_id", "principal", "provider", "request_model", "terminal", "duration_ms"];
        readonly optional: readonly ["request_id", "trace", "cohort", "key_id", "project", "response_model", "input_tokens", "output_tokens", "cost_micro_usd", "quota", "status", "upstream_ms", "error_type", "retry_count"];
    };
    readonly "cail.sandbox.usage.settled": {
        readonly body: "Sandbox usage settled.";
        readonly source: "platform";
        readonly severity: "info";
        readonly required: readonly ["usage_id", "product_id", "principal", "terminal", "usage"];
        readonly optional: readonly ["request_id", "action_id", "trace", "cohort", "key_id", "project", "quota", "duration_ms", "retry_count"];
        readonly outcomes: readonly ["ok"];
        readonly terminal_reasons: readonly ["completed"];
    };
}>;
export declare function extendCailEventCatalog<const Catalog extends Record<string, CailCustomEventDefinition>>(catalog: Catalog & {
    readonly [Event in keyof Catalog]: Readonly<{
        body?: never;
    }>;
}): Readonly<typeof CAIL_EVENT_CATALOG & CailServiceEventCatalog<Catalog>>;
export {};
//# sourceMappingURL=schema.d.ts.map