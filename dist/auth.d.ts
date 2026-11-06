import type { AntigravityAuthCredentials, AntigravityEndpoints, AuthProfileSecretRef, AuthProfileStore, FetchLike, LoginContext, LoginResult, ModelAuthRuntime, OpenClawOAuthCredential } from "./types.js";
export declare function parseFormattedApiKey(raw: unknown): {
    token: string;
    projectId: string;
    accountId?: string;
    expires?: number;
} | null;
export declare class InMemoryAuthProfileStore implements AuthProfileStore {
    private readonly secrets;
    hasSecret(provider: string): boolean;
    getSecret(provider: string): Promise<AntigravityAuthCredentials | null>;
    setSecret(provider: string, credentials: AntigravityAuthCredentials): Promise<AuthProfileSecretRef>;
    deleteSecret(provider: string): Promise<void>;
}
export declare function isAntigravityConfigured(ctx?: {
    cfg?: unknown;
    agentDir?: string;
} | undefined, authStore?: AuthProfileStore | undefined, modelAuth?: ModelAuthRuntime | undefined): boolean;
export declare function extractProjectId(raw: string | {
    id?: string;
    name?: string;
    project?: string;
} | undefined): string | undefined;
export declare function loginWithOAuth(ctx: LoginContext, endpoints?: AntigravityEndpoints, fetchImpl?: FetchLike, pollIntervalOverrideMs?: number): Promise<LoginResult>;
export declare function refreshOAuthCredential(credential: OpenClawOAuthCredential, endpoints?: AntigravityEndpoints, fetchImpl?: FetchLike): Promise<OpenClawOAuthCredential>;
export declare function refreshAccessToken(authStore: AuthProfileStore, endpoints?: AntigravityEndpoints, fetchImpl?: FetchLike): Promise<AntigravityAuthCredentials>;
export declare function getValidAccessToken(authStore: AuthProfileStore, endpoints?: AntigravityEndpoints, fetchImpl?: FetchLike): Promise<string>;
//# sourceMappingURL=auth.d.ts.map