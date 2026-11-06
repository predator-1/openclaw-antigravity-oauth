import type { CatalogService } from "./catalog.js";
import type { AntigravityEndpoints, AuthProfileStore, FetchLike, TurnRequest, TurnResponse } from "./types.js";
export declare function toUpstreamThinkingLevel(effort: string): string;
export declare const GEMINI_THOUGHT_SIGNATURE_SENTINEL = "skip_thought_signature_validator";
export declare function extractThoughtSignature(...sources: unknown[]): string | undefined;
export declare function extractThoughtSignatureModel(...sources: unknown[]): string | undefined;
export declare function resolveReplayThoughtSignature(toolCall: unknown, bareModelId: string): string;
export declare function cleanJsonSchema(schema: unknown): Record<string, unknown>;
/** Sanitize a response schema without forcing the root to an object (arrays/strings stay). */
export declare function cleanResponseJsonSchema(schema: unknown): Record<string, unknown>;
/** Gemini and MODEL_PLACEHOLDER_* aliases; Claude and GPT-OSS do not get these fields. */
export declare function modelSupportsStructuredOutput(modelId: string): boolean;
/**
 * Read the host's `StreamOptions.responseFormat` (also `response_format`).
 * Accepts a raw JSON Schema or an OpenAI-style `{ type, json_schema }` wrapper.
 */
export declare function extractHostResponseFormat(options?: Record<string, unknown> | null): {
    responseMimeType: string;
    responseSchema?: Record<string, unknown>;
} | undefined;
export declare class ToolNameMapper {
    private originalToSafe;
    private safeToOriginal;
    toSafeName(original: string): string;
    toOriginalName(safe: string): string;
}
export declare function formatResetTime(resetTimeStr?: string, nowMs?: number): {
    formatted: string;
    relative: string;
} | null;
export declare function extractErrorSummary(errorBody: string): string;
export interface GoogleRpc429Classification {
    type: "terminal_quota" | "transient_rate_limit" | "unclassified";
    reason?: string;
    domain?: string;
    retryDelayMs?: number;
    resetAt?: string;
    errorSummary: string;
}
export declare function classifyGoogleRpc429(errorBody: string, headers?: {
    get(name: string): string | null;
}): GoogleRpc429Classification;
export declare function executeTurn(request: TurnRequest, authStore: AuthProfileStore, catalog: CatalogService, endpoints?: AntigravityEndpoints, fetchImpl?: FetchLike): Promise<TurnResponse>;
//# sourceMappingURL=turn.d.ts.map