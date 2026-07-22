export declare const TRACEPARENT_HEADER = "traceparent";
export declare const TRACESTATE_HEADER = "tracestate";
export declare const CAIL_REQUEST_ID_HEADER = "x-cail-request-id";
export interface CailCorrelation {
    trace_id: string;
    span_id: string;
    trace_flags: 0 | 1;
    request_id: string;
    tracestate?: string;
}
export interface CailCorrelationOptions {
    sampled?: boolean;
}
export interface CailHeadersLike {
    get(name: string): string | null;
}
export declare function correlationFromHeaders(source: CailHeadersLike | {
    headers: CailHeadersLike;
}, options?: CailCorrelationOptions): CailCorrelation;
export declare function outboundCorrelationHeaders(correlation: CailCorrelation): Record<string, string>;
//# sourceMappingURL=correlation.d.ts.map