import { type CailCorrelation } from "../vendor/cail-log/dist/index.js";
export { CAIL_REQUEST_ID_HEADER, correlationFromHeaders, outboundCorrelationHeaders, TRACEPARENT_HEADER, } from "../vendor/cail-log/dist/index.js";
export type { CailCorrelation, CailHeadersLike, } from "../vendor/cail-log/dist/index.js";
export type CailSandboxCredential = {
    kind: "jwt";
    token: string;
};
export type SandboxProfile = "offline-code";
export type SandboxInstanceClass = "lite" | "basic" | "standard-1";
export interface SandboxLease {
    id: string;
    leaseCapability: string;
    leaseGeneration: number;
}
export interface SandboxLifecycle extends SandboxLease {
    state: "active";
    expiresAt: string;
    profile: SandboxProfile;
    instanceClass: SandboxInstanceClass;
}
export interface SandboxOperation {
    id: string;
    operationId: string;
    operationCapability: string;
    operationGeneration: number;
    expiresAt: string;
}
export interface CreateSandboxInput {
    scopeKey: string;
    idempotencyKey: string;
    profile: SandboxProfile;
}
export interface CreateOperationInput {
    operationId: string;
    idempotencyKey: string;
}
export interface CommandOutputEvent {
    type: "stdout" | "stderr";
    data: Uint8Array;
}
export type CommandTerminalEvent = {
    type: "exit";
    exitCode: number;
} | {
    type: "error";
    code: string;
    message: string;
    requestId: string;
};
export declare class CailSandboxError extends Error {
    readonly code: string;
    readonly status: number;
    readonly type: string;
    readonly param: string | null;
    readonly details: Record<string, unknown>;
    readonly requestId: string | null;
    readonly shouldRetry: boolean | null;
    readonly cause?: unknown | undefined;
    constructor(code: string, message: string, status: number, type?: string, param?: string | null, details?: Record<string, unknown>, requestId?: string | null, shouldRetry?: boolean | null, cause?: unknown | undefined);
}
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export interface SandboxClientOptions {
    baseUrl: string;
    app: string;
    fetchImpl?: FetchLike;
    defaultTimeoutMs?: number;
}
export interface SandboxCallOptions {
    correlation?: CailCorrelation;
    signal?: AbortSignal;
}
export type SandboxExecOptions = SandboxCallOptions;
export interface SandboxRunning {
    running: boolean;
    state: "active";
    expiresAt: string;
    leaseGeneration: number;
}
export interface SandboxUsage {
    period: string;
    unit: "mib_milliseconds";
    limit: number;
    used: number;
    reserved: number;
    remaining: number;
    activeLeases: 0 | 1;
}
export interface SandboxSettlement {
    leaseId: string;
    periodStart: string;
    periodEnd: string;
    unit: "mib_milliseconds";
    quantity: number;
    settledAt: string;
    state: "settled";
}
export interface CailSandboxClient {
    create(input: CreateSandboxInput, credential: CailSandboxCredential, options?: SandboxCallOptions): Promise<SandboxLifecycle>;
    running(lease: SandboxLease, credential: CailSandboxCredential, options?: SandboxCallOptions): Promise<SandboxRunning>;
    destroy(lease: SandboxLease, credential: CailSandboxCredential, options?: SandboxCallOptions): Promise<void>;
    usage(credential: CailSandboxCredential, options?: SandboxCallOptions): Promise<SandboxUsage>;
    settlement(leaseId: string, credential: CailSandboxCredential, options?: SandboxCallOptions): Promise<SandboxSettlement>;
    createSession(lease: SandboxLease, input: CreateOperationInput, credential: CailSandboxCredential, options?: SandboxCallOptions): Promise<SandboxOperation>;
    destroySession(lease: SandboxLease, operation: SandboxOperation, credential: CailSandboxCredential, options?: SandboxCallOptions): Promise<void>;
    readFile(lease: SandboxLease, operation: SandboxOperation, path: string, credential: CailSandboxCredential, options?: SandboxCallOptions): Promise<Response>;
    writeFile(lease: SandboxLease, operation: SandboxOperation, path: string, body: BodyInit, credential: CailSandboxCredential, options?: SandboxCallOptions): Promise<void>;
    exec(lease: SandboxLease, operation: SandboxOperation, command: string, credential: CailSandboxCredential, options?: SandboxExecOptions): Promise<AsyncGenerator<CommandOutputEvent | CommandTerminalEvent>>;
    openapi(credential: CailSandboxCredential, options?: SandboxCallOptions): Promise<Record<string, unknown>>;
}
export declare function createCailSandboxClient(options: SandboxClientOptions): CailSandboxClient;
//# sourceMappingURL=index.d.ts.map