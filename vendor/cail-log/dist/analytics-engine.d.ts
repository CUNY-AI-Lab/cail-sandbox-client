import type { CailLogEvent } from "./schema.js";
import type { CailLogSink } from "./logger.js";
export declare const CAIL_ANALYTICS_ENGINE_DATASET: "cail_fleet_events_v1";
export declare const CAIL_ANALYTICS_ENGINE_SCHEMA_VERSION: 1;
export declare const CAIL_ANALYTICS_ENGINE_MISSING_NUMBER: -1;
export declare const CAIL_ANALYTICS_ENGINE_MAX_POINTS_PER_INVOCATION: 250;
/**
 * Analytics Engine exposes ordered blob/double columns. These one-based
 * positions are the durable query contract; append new fields instead of
 * changing an existing position.
 */
export declare const CAIL_ANALYTICS_ENGINE_BLOBS: Readonly<{
    readonly event_name: 1;
    readonly service_name: 2;
    readonly service_version: 3;
    readonly environment: 4;
    readonly product_id: 5;
    readonly principal_type: 6;
    readonly cohort: 7;
    readonly route: 8;
    readonly outcome: 9;
    readonly outcome_reason: 10;
    readonly error_type: 11;
    readonly provider: 12;
    readonly request_model: 13;
    readonly response_model: 14;
    readonly http_method: 15;
}>;
export declare const CAIL_ANALYTICS_ENGINE_DOUBLES: Readonly<{
    readonly projection_schema_version: 1;
    readonly log_schema_version: 2;
    readonly severity_number: 3;
    readonly status_code: 4;
    readonly duration_ms: 5;
    readonly upstream_ms: 6;
    readonly input_tokens: 7;
    readonly output_tokens: 8;
    readonly cost_micro_usd: 9;
    readonly request_bytes: 10;
    readonly response_bytes: 11;
    readonly retry_count: 12;
    readonly event_timestamp_ms: 13;
}>;
export interface CailAnalyticsEngineDataPoint {
    indexes: [string];
    blobs: string[];
    doubles: number[];
}
export interface CailAnalyticsEngineDataset {
    writeDataPoint(point: CailAnalyticsEngineDataPoint): void;
}
export declare function toAnalyticsEngineDataPoint(event: CailLogEvent): CailAnalyticsEngineDataPoint;
export declare function createAnalyticsEngineSink(dataset: CailAnalyticsEngineDataset): CailLogSink;
/**
 * Invoke every selected sink even when another sink fails. The logger turns a
 * combined rejection into one content-free `sink_error` diagnostic.
 */
export declare function fanoutSinks(...sinks: CailLogSink[]): CailLogSink;
//# sourceMappingURL=analytics-engine.d.ts.map