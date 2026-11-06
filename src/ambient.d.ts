declare module "openclaw/plugin-sdk/media-understanding" {
  export function describeImageWithModel(req: unknown): Promise<{ text: string; model?: string }>;
  export function describeImagesWithModel(req: unknown): Promise<{ text: string; model?: string }>;
}

declare module "openclaw/plugin-sdk/provider-web-search" {
  export function resolveCitationRedirectUrl(url: string): Promise<string>;
  export function wrapWebContent(content: string, source?: string): string;
  export function buildUnsupportedSearchFilterResponse(
    filters: { country?: string | undefined; language?: string | undefined },
    providerId: string
  ): Record<string, unknown> | undefined;
  export function buildSearchCacheKey(parts: unknown[]): string;
  export function readCachedSearchPayload(cacheKey: string, ttlMs: number): unknown;
  export function writeCachedSearchPayload(cacheKey: string, payload: unknown, ttlMs: number): void;
  export function resolveSearchCacheTtlMs(config?: unknown): number;
}

declare module "openclaw/plugin-sdk/provider-auth-runtime" {
  export function resolveApiKeyForProvider(params: {
    provider: string;
    agentDir?: string | undefined;
    cfg?: unknown;
    signal?: AbortSignal | undefined;
  }): Promise<{ apiKey?: string | undefined; profileId?: string | undefined } | undefined>;
}

