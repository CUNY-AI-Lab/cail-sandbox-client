import { type CailCorrelation } from "@cuny-ai-lab/cail-log";
export { CAIL_REQUEST_ID_HEADER, correlationFromHeaders, outboundCorrelationHeaders, TRACEPARENT_HEADER, } from "@cuny-ai-lab/cail-log";
export type { CailCorrelation, CailHeadersLike } from "@cuny-ai-lab/cail-log";
export type CailSandboxCredential = {
    kind: "jwt" | "key";
    token: string;
};
export type SandboxState = "active" | "destroying" | "destroyed";
export interface SandboxLifecycle {
    id: string;
    state: "active";
    expires_at: string;
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
export interface SandboxExecOptions extends SandboxCallOptions {
    sessionId?: string;
}
export interface SandboxRunning {
    running: boolean;
    state: SandboxState;
    expires_at: string;
}
export interface CailSandboxClient {
    create(credential: CailSandboxCredential, options?: SandboxCallOptions): Promise<SandboxLifecycle>;
    running(id: string, credential: CailSandboxCredential, options?: SandboxCallOptions): Promise<SandboxRunning>;
    destroy(id: string, credential: CailSandboxCredential, options?: SandboxCallOptions): Promise<void>;
    createSession(id: string, credential: CailSandboxCredential, options?: SandboxCallOptions): Promise<{
        id: string;
    }>;
    destroySession(id: string, sessionId: string, credential: CailSandboxCredential, options?: SandboxCallOptions): Promise<void>;
    readFile(id: string, path: string, credential: CailSandboxCredential, options?: SandboxCallOptions): Promise<Response>;
    writeFile(id: string, path: string, body: BodyInit, credential: CailSandboxCredential, options?: SandboxCallOptions): Promise<void>;
    exec(id: string, command: string, credential: CailSandboxCredential, options?: SandboxExecOptions): Promise<AsyncGenerator<CommandOutputEvent | CommandTerminalEvent>>;
    openapi(credential: CailSandboxCredential, options?: SandboxCallOptions): Promise<Record<string, unknown>>;
}
export declare function createCailSandboxClient(options: SandboxClientOptions): CailSandboxClient;
//# sourceMappingURL=index.d.ts.map