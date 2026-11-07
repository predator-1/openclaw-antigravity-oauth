import type { AntigravityEndpoints, AntigravityWebSearchProvider, AuthProfileStore, BuildWebSearchProviderOptions, FetchLike, WebSearchResultPayload } from "./types.js";
export declare const ANTIGRAVITY_SEARCH_PROVIDER_ID: "antigravity-search";
export declare const ANTIGRAVITY_SEARCH_DEFAULT_MODEL = "gemini-3.8-flash";
export declare const ANTIGRAVITY_SEARCH_UPSTREAM_MODEL = "gemini-3.8-flash-tiered";
export declare const ANTIGRAVITY_SEARCH_AUTO_DETECT_ORDER = 35;
export declare const ANTIGRAVITY_SEARCH_CREDENTIAL_PATH: string;
export declare const ANTIGRAVITY_SEARCH_TOOL_PARAMETERS: Readonly<{
    type: "object";
    properties: {
        query: {
            type: string;
            description: string;
        };
        count: {
            type: string;
            description: string;
            minimum: number;
            maximum: number;
        };
        freshness: {
            type: string;
            description: string;
        };
        date_after: {
            type: string;
            description: string;
        };
        date_before: {
            type: string;
            description: string;
        };
        country: {
            type: string;
            description: string;
        };
        language: {
            type: string;
            description: string;
        };
    };
    required: string[];
}>;
export interface ExecuteSearchOptions {
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
    count?: number | undefined;
    freshness?: string | undefined;
    dateAfter?: string | undefined;
    dateBefore?: string | undefined;
    agentDir?: string | undefined;
    cfg?: unknown | undefined;
}
export declare function executeAntigravitySearch(query: string, options?: ExecuteSearchOptions): Promise<WebSearchResultPayload>;
export declare function buildAntigravityWebSearchProvider(options?: BuildWebSearchProviderOptions): AntigravityWebSearchProvider;
//# sourceMappingURL=search.d.ts.map