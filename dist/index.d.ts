import { type CailCorrelation } from "@cuny-ai-lab/cail-log";
export { CAIL_REQUEST_ID_HEADER, correlationFromHeaders, outboundCorrelationHeaders, TRACEPARENT_HEADER, } from "@cuny-ai-lab/cail-log";
export type { CailCorrelation, CailHeadersLike } from "@cuny-ai-lab/cail-log";
export type CailSandboxCredential = {
    kind: "jwt" | "key";
    token: string;
};
export type SandboxState = "active" | "destroying" | "destroyed";
export interface SandboxLease {
    id: string;
    leaseCapability: string;
    leaseGeneration: number;
}
export interface SandboxLifecycle {
    id: string;
    state: "active";
    expiresAt: string;
    leaseCapability: string;
    leaseGeneration: number;
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
    constructor(code: string, message: string, status: number, type?: string, param?: string | null, details?: Record<string, unknown>, requestId?: string | null, shouldRetry?: boolean | null);
}
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export interface SandboxClientOptions {
    baseUrl: string;
    app: string;
    fetchImpl?: FetchLike;
}
export interface SandboxCallOptions {
    correlation?: CailCorrelation;
    signal?: AbortSignal;
}
export type SandboxExecOptions = SandboxCallOptions;
export interface SandboxRunning {
    running: boolean;
    state: SandboxState;
    expiresAt: string;
    incarnation: string | null;
    restoredFromIncarnation: string | null;
    leaseGeneration: number;
}
export interface CailSandboxClient {
    create(input: CreateSandboxInput, credential: CailSandboxCredential, options?: SandboxCallOptions): Promise<SandboxLifecycle>;
    running(lease: SandboxLease, credential: CailSandboxCredential, options?: SandboxCallOptions): Promise<SandboxRunning>;
    destroy(lease: SandboxLease, credential: CailSandboxCredential, options?: SandboxCallOptions): Promise<void>;
    createSession(lease: SandboxLease, input: CreateOperationInput, credential: CailSandboxCredential, options?: SandboxCallOptions): Promise<SandboxOperation>;
    destroySession(lease: SandboxLease, operation: SandboxOperation, credential: CailSandboxCredential, options?: SandboxCallOptions): Promise<void>;
    readFile(lease: SandboxLease, operation: SandboxOperation, path: string, credential: CailSandboxCredential, options?: SandboxCallOptions): Promise<Response>;
    writeFile(lease: SandboxLease, operation: SandboxOperation, path: string, body: BodyInit, credential: CailSandboxCredential, options?: SandboxCallOptions): Promise<void>;
    exec(lease: SandboxLease, operation: SandboxOperation, command: string, credential: CailSandboxCredential, options?: SandboxExecOptions): Promise<AsyncGenerator<CommandOutputEvent | CommandTerminalEvent>>;
    openapi(credential: CailSandboxCredential, options?: SandboxCallOptions): Promise<Record<string, unknown>>;
}
export declare function createCailSandboxClient(options: SandboxClientOptions): CailSandboxClient;
//# sourceMappingURL=index.d.ts.map