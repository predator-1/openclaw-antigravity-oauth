import { CatalogService } from "./catalog.js";
import type { AntigravityImageGenerationProvider, AntigravityMediaUnderstandingProvider, AntigravityProviderOptions, AntigravityWebSearchProvider, AntigravityWebFetchProvider, AuthProfileStore, OpenClawPluginDefinition, OpenClawProviderRegistration, QuotaBucketInfo } from "./types.js";
export * from "./types.js";
export * from "./constants.js";
export * from "./auth.js";
export * from "./catalog.js";
export * from "./turn.js";
export * from "./media.js";
export * from "./search.js";
export * from "./fetch.js";
export * from "./image.js";
/**
 * OpenClaw plugin entry helper matching the `definePluginEntry` contract (Contract §1).
 */
export declare function definePluginEntry(definition: OpenClawPluginDefinition): OpenClawPluginDefinition;
export declare function formatGroupName(group?: string): string;
export declare function formatWindowName(window?: string): string;
export declare function buildUsageWindowLabel(bucket: QuotaBucketInfo): string;
export declare function calculateBucketUsedPercent(bucket: QuotaBucketInfo): number | null;
export declare function sortUsageBuckets(buckets: QuotaBucketInfo[]): QuotaBucketInfo[];
export declare function createAntigravityProvider(options?: AntigravityProviderOptions): {
    provider: OpenClawProviderRegistration;
    catalogService: CatalogService;
    defaultAuthStore: AuthProfileStore;
    mediaUnderstandingProvider: AntigravityMediaUnderstandingProvider;
    webSearchProvider: AntigravityWebSearchProvider;
    webFetchProvider: AntigravityWebFetchProvider;
    imageGenerationProvider: AntigravityImageGenerationProvider;
};
export declare const antigravityPlugin: OpenClawPluginDefinition;
export default antigravityPlugin;
//# sourceMappingURL=index.d.ts.map