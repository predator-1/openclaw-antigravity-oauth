import type { AntigravityEndpoints, AuthProfileStore, FetchLike, OpenClawCatalogModelDefinition, ReasoningLevel, SubscriptionModelRow, SubscriptionUsageReport } from "./types.js";
interface RawSubscriptionModel {
    id?: string;
    model?: string;
    displayName?: string;
    label?: string;
    name?: string;
    tagDescription?: string;
    enabled?: boolean;
    disabled?: boolean;
    modality?: string;
    type?: string;
    contextWindow?: number;
    inputTokenLimit?: number;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    outputTokenLimit?: number;
    maxOutput?: number;
    maxTokens?: number;
    canDisableReasoning?: boolean;
    supportsThinking?: boolean;
    supportsImages?: boolean;
    supportsVideo?: boolean;
    supportsPdf?: boolean;
    supportedMimeTypes?: string[];
    reasoningLevels?: string[];
    quotaInfo?: {
        remainingFraction?: number;
        resetTime?: string;
    };
}
interface RawQuotaBucket {
    modelId?: string;
    bucketId?: string;
    displayName?: string;
    groupDisplayName?: string;
    description?: string;
    window?: string;
    remainingFraction?: number;
    remainingAmount?: number;
    disabled?: boolean;
    resetTime?: string;
    tokenType?: string;
}
export declare function inferQuotaWindow(bucket: RawQuotaBucket, knownBuckets?: RawQuotaBucket[]): "weekly" | "5h";
type EffortTier = "low" | "medium" | "high" | "tiered";
/**
 * Models that send thinkingLevel (not a -low|-medium|-high suffix) and accept EXTRA_HIGH / MAX.
 * gemini-4-argon is intentionally excluded: Argon uses gemini-4-argon-<low|medium|high> variants,
 * buildV1InternalRequestEnvelope skips thinkingConfig for those ids, so advertising xhigh/max
 * would lie.
 */
export declare const EXTENDED_THINKING_LEVEL_MODELS: ReadonlySet<string>;
/**
 * Corrects known mislabeled display names returned by v1internal:fetchAvailableModels.
 */
export declare const KNOWN_DISPLAY_NAME_OVERRIDES: Readonly<Record<string, string>>;
export declare const PROTO_MODEL_ID_MAP: Readonly<Record<string, {
    canonicalId: string;
    effortTier?: EffortTier;
}>>;
/**
 * Canonical chat models from proto mappings and observed published plain slugs.
 * Ids the catalog filters out (NON_CHAT_ID_PATTERNS, e.g. gemini-2.5-*, gemini-3.1-*) are
 * legacy mapping entries kept only so old proto ids still resolve; they are listed in
 * LEGACY_MAPPED_MODELS and never reported as published or "removed".
 */
export declare const KNOWN_CATALOG_MODELS: readonly string[];
/** Canonical ids in PROTO_MODEL_ID_MAP that the plugin does not publish. */
export declare const LEGACY_MAPPED_MODELS: readonly string[];
export declare function inferDefaultContextWindow(modelId: string): number;
export declare function parseEffortVariant(rawId: string, rawDisplayName: string): {
    canonicalId: string;
    canonicalDisplayName: string;
    effortTier?: EffortTier;
};
export type CatalogEligibilityOptions = {
    deprecatedModelIds?: ReadonlySet<string> | readonly string[];
};
export declare function extractDeprecatedModelIds(payload: {
    deprecatedModelIds?: string[];
}): ReadonlySet<string>;
export declare function isEligibleChatModel(raw: RawSubscriptionModel, options?: CatalogEligibilityOptions): boolean;
export declare function normalizeModelRow(raw: RawSubscriptionModel, options?: CatalogEligibilityOptions): SubscriptionModelRow | null;
export declare function toOpenClawCatalogModelDefinition(row: SubscriptionModelRow, baseUrl: string): OpenClawCatalogModelDefinition;
export declare class CatalogService {
    private readonly endpoints;
    private readonly fetchImpl;
    private cachedModels;
    private cachedManagedProjectId?;
    private readonly variantMap;
    private readonly protoIdMap;
    constructor(endpoints?: AntigravityEndpoints, fetchImpl?: FetchLike);
    getCachedModels(): readonly SubscriptionModelRow[] | null;
    getCachedManagedProjectId(): string | undefined;
    setCachedModels(models: readonly SubscriptionModelRow[]): void;
    getKnownModelIds(): readonly string[];
    /**
     * Resolves a requested model ID (either canonical `claude-sonnet-5-5` or effort-suffixed
     * `claude-sonnet-5-5-high`) against the cached subscription catalog and maps the active
     * reasoning effort onto the concrete upstream model ID.
     */
    resolveModelForTurn(bareModelId: string, reasoningEffort?: ReasoningLevel): {
        matchedModel: SubscriptionModelRow;
        upstreamModelId: string;
        effectiveEffort?: ReasoningLevel;
    } | null;
    listModelsWithToken(accessToken: string, projectId?: string, options?: {
        refresh?: boolean;
    }): Promise<SubscriptionModelRow[]>;
    listModels(authStore: AuthProfileStore, options?: {
        refresh?: boolean;
        agentDir?: string;
        cfg?: unknown;
        signal?: AbortSignal;
    }): Promise<SubscriptionModelRow[]>;
    getUsageWithToken(accessToken: string, projectId?: string): Promise<SubscriptionUsageReport>;
    getUsage(authStore: AuthProfileStore, options?: {
        agentDir?: string;
        cfg?: unknown;
        signal?: AbortSignal;
    }): Promise<SubscriptionUsageReport>;
}
export {};
//# sourceMappingURL=catalog.d.ts.map