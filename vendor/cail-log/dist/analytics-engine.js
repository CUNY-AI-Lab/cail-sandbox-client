import { assertValidatedEvent } from "./event-provenance.js";
export const CAIL_ANALYTICS_ENGINE_DATASET = "cail_fleet_events_v1";
export const CAIL_ANALYTICS_ENGINE_SCHEMA_VERSION = 1;
export const CAIL_ANALYTICS_ENGINE_MISSING_NUMBER = -1;
export const CAIL_ANALYTICS_ENGINE_MAX_POINTS_PER_INVOCATION = 250;
/**
 * Analytics Engine exposes ordered blob/double columns. These one-based
 * positions are the durable query contract; append new fields instead of
 * changing an existing position.
 */
export const CAIL_ANALYTICS_ENGINE_BLOBS = Object.freeze({
    event_name: 1,
    service_name: 2,
    service_version: 3,
    environment: 4,
    product_id: 5,
    principal_type: 6,
    cohort: 7,
    route: 8,
    outcome: 9,
    outcome_reason: 10,
    error_type: 11,
    provider: 12,
    request_model: 13,
    response_model: 14,
    http_method: 15,
});
export const CAIL_ANALYTICS_ENGINE_DOUBLES = Object.freeze({
    projection_schema_version: 1,
    log_schema_version: 2,
    severity_number: 3,
    status_code: 4,
    duration_ms: 5,
    upstream_ms: 6,
    input_tokens: 7,
    output_tokens: 8,
    cost_micro_usd: 9,
    request_bytes: 10,
    response_bytes: 11,
    retry_count: 12,
    event_timestamp_ms: 13,
});
function stringAttribute(attributes, name) {
    const value = attributes[name];
    return typeof value === "string" ? value : "";
}
function numberAttribute(attributes, name) {
    const value = attributes[name];
    return typeof value === "number"
        ? value
        : CAIL_ANALYTICS_ENGINE_MISSING_NUMBER;
}
export function toAnalyticsEngineDataPoint(event) {
    assertValidatedEvent(event);
    const attributes = event.attributes;
    const product = stringAttribute(attributes, "cail.product.id");
    const service = event.resource["service.name"];
    const environment = event.resource["deployment.environment.name"];
    const eventTimestamp = Date.parse(event.timestamp);
    return {
        // Product is the sampling boundary. Service-local events use a namespaced
        // fallback so one noisy component cannot sample an unrelated product.
        indexes: [`${environment}:${product || `_service.${service}`}`],
        blobs: [
            event.event_name,
            service,
            event.resource["service.version"],
            environment,
            product,
            stringAttribute(attributes, "cail.principal.type"),
            stringAttribute(attributes, "cail.cohort.id"),
            stringAttribute(attributes, "url.template"),
            stringAttribute(attributes, "cail.outcome"),
            stringAttribute(attributes, "cail.outcome.reason"),
            stringAttribute(attributes, "error.type"),
            stringAttribute(attributes, "gen_ai.provider.name"),
            stringAttribute(attributes, "gen_ai.request.model"),
            stringAttribute(attributes, "gen_ai.response.model"),
            stringAttribute(attributes, "http.request.method"),
            "",
            "",
            "",
            "",
            "",
        ],
        doubles: [
            CAIL_ANALYTICS_ENGINE_SCHEMA_VERSION,
            event.schema_version,
            event.severity_number,
            numberAttribute(attributes, "http.response.status_code"),
            numberAttribute(attributes, "cail.operation.duration_ms"),
            numberAttribute(attributes, "cail.upstream.duration_ms"),
            numberAttribute(attributes, "gen_ai.usage.input_tokens"),
            numberAttribute(attributes, "gen_ai.usage.output_tokens"),
            numberAttribute(attributes, "cail.gen_ai.cost.micro_usd"),
            numberAttribute(attributes, "http.request.body.size"),
            numberAttribute(attributes, "http.response.body.size"),
            numberAttribute(attributes, "cail.retry.count"),
            Number.isFinite(eventTimestamp)
                ? eventTimestamp
                : CAIL_ANALYTICS_ENGINE_MISSING_NUMBER,
            CAIL_ANALYTICS_ENGINE_MISSING_NUMBER,
            CAIL_ANALYTICS_ENGINE_MISSING_NUMBER,
            CAIL_ANALYTICS_ENGINE_MISSING_NUMBER,
            CAIL_ANALYTICS_ENGINE_MISSING_NUMBER,
            CAIL_ANALYTICS_ENGINE_MISSING_NUMBER,
            CAIL_ANALYTICS_ENGINE_MISSING_NUMBER,
            CAIL_ANALYTICS_ENGINE_MISSING_NUMBER,
        ],
    };
}
export function createAnalyticsEngineSink(dataset) {
    if (typeof dataset !== "object" ||
        dataset === null ||
        typeof dataset.writeDataPoint !== "function") {
        throw new TypeError("cail-log: Analytics Engine dataset must expose writeDataPoint");
    }
    return (event) => dataset.writeDataPoint(toAnalyticsEngineDataPoint(event));
}
/**
 * Invoke every selected sink even when another sink fails. The logger turns a
 * combined rejection into one content-free `sink_error` diagnostic.
 */
export function fanoutSinks(...sinks) {
    if (sinks.length === 0 || sinks.some((sink) => typeof sink !== "function")) {
        throw new TypeError("cail-log: fanout requires one or more sinks");
    }
    return (event) => {
        assertValidatedEvent(event);
        const pending = [];
        for (const sink of sinks) {
            try {
                const result = sink(event);
                if ((typeof result === "object" || typeof result === "function") &&
                    result !== null &&
                    typeof result.then === "function") {
                    pending.push(Promise.resolve(result));
                }
            }
            catch (error) {
                pending.push(Promise.reject(error));
            }
        }
        return pending.length === 0
            ? undefined
            : Promise.all(pending).then(() => undefined);
    };
}
