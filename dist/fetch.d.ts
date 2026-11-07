import type { AntigravityEndpoints, AntigravityWebFetchProvider, AuthProfileStore, BuildWebFetchProviderOptions, FetchLike, WebFetchResultPayload } from "./types.js";
export declare const ANTIGRAVITY_FETCH_PROVIDER_ID: "antigravity-fetch";
export declare const ANTIGRAVITY_FETCH_AUTO_DETECT_ORDER = 40;
export declare const ANTIGRAVITY_FETCH_CREDENTIAL_PATH: string;
export declare const ANTIGRAVITY_FETCH_DEFAULT_MAX_CHARS = 20000;
export declare const ANTIGRAVITY_FETCH_DEFAULT_TIMEOUT_MS = 15000;
export declare const ANTIGRAVITY_FETCH_OPAQUE_ERROR = "page could not be fetched (upstream error, ~7 s timeout, or unsupported type such as PDF or images)";
export declare const ANTIGRAVITY_FETCH_TOOL_PARAMETERS: Readonly<{
    type: "object";
    properties: {
        url: {
            type: string;
            description: string;
        };
        extractMode: {
            type: string;
            description: string;
            enum: string[];
        };
        maxChars: {
            type: string;
            description: string;
            minimum: number;
        };
    };
    required: string[];
}>;
export interface ExecuteFetchOptions {
    model?: string | undefined;
    apiKey?: string | undefined;
    auth?: {
        kind?: string | undefined;
        apiKey?: string | undefined;
    } | undefined;
    authStore?: AuthProfileStore | undefined;
    endpoints?: Partial<AntigravityEndpoints> | undefined;
    timeoutMs?: number | undefined;
    signal?: AbortSignal | undefined;
    fetchFn?: FetchLike | undefined;
    extractMode?: "markdown" | "text" | undefined;
    maxChars?: number | undefined;
    checkDenylist?: boolean | undefined;
    agentDir?: string | undefined;
    cfg?: unknown | undefined;
}
export declare function fetchFromTrawlerCacheUrl(endpoints?: AntigravityEndpoints): string;
export declare function checkUrlDenylistUrl(endpoints?: AntigravityEndpoints): string;
export declare function htmlToReadable(html: string, mode?: "markdown" | "text"): {
    title?: string;
    text: string;
};
export declare function sniffContentType(content: string): string | undefined;
export declare function forbiddenFetchUrlReason(raw: string): string | undefined;
export declare function executeAntigravityFetch(url: string, options?: ExecuteFetchOptions): Promise<WebFetchResultPayload>;
export declare function buildAntigravityWebFetchProvider(options?: BuildWebFetchProviderOptions): AntigravityWebFetchProvider;
//# sourceMappingURL=fetch.d.ts.map