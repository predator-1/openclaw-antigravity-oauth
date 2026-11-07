import type { AntigravityEndpoints, AntigravityMediaUnderstandingProvider, FetchLike, MediaUnderstandingTextResult } from "./types.js";
export declare const ANTIGRAVITY_MEDIA_UNDERSTANDING_DEFAULT_MODELS: Readonly<{
    image: "gemini-3.8-flash";
    audio: "gemini-3.8-flash";
    video: "gemini-3.8-flash";
}>;
export declare const ANTIGRAVITY_MEDIA_UNDERSTANDING_CAPABILITIES: readonly ["image", "audio", "video"];
export declare const ANTIGRAVITY_MEDIA_UNDERSTANDING_AUTO_PRIORITY: Readonly<{
    image: 90;
    audio: 90;
    video: 90;
}>;
/**
 * Documented Gemini inline-data budget for the whole request (~20 MiB).
 * Covers base64(audio) plus prompt/envelope, not the raw buffer alone.
 */
export declare const INLINE_AUDIO_REQUEST_MAX_BYTES: number;
/**
 * Max raw audio buffer so that base64 size (`Math.ceil(n / 3) * 4`) plus a
 * small prompt/envelope overhead stays ≤ INLINE_AUDIO_REQUEST_MAX_BYTES
 * (~14.81 MiB raw → ~19.75 MiB base64). Live v1internal cutoff for 5/15/25 MB
 * clips is unverified (see docs/protocol.md).
 */
export declare const INLINE_AUDIO_MAX_BYTES: number;
export declare function assertInlineAudioWithinLimit(buffer: {
    byteLength: number;
}): void;
export declare function inferMediaMimeType(fileName?: string, fallback?: string): string;
export interface ExecuteMediaUnderstandingOptions {
    model?: string | undefined;
    apiKey?: string | undefined;
    auth?: {
        kind?: string | undefined;
        apiKey?: string | undefined;
    } | undefined;
    endpoints?: Partial<AntigravityEndpoints> | undefined;
    timeoutMs?: number | undefined;
    signal?: AbortSignal | undefined;
    fetchFn?: FetchLike | undefined;
    agentDir?: string | undefined;
    cfg?: unknown | undefined;
}
export declare function executeMediaUnderstanding(parts: Array<Record<string, unknown>>, options: ExecuteMediaUnderstandingOptions): Promise<MediaUnderstandingTextResult>;
export declare function buildAntigravityMediaUnderstandingProvider(options?: {
    endpoints?: Partial<AntigravityEndpoints>;
    fetchFn?: FetchLike;
}): AntigravityMediaUnderstandingProvider;
//# sourceMappingURL=media.d.ts.map