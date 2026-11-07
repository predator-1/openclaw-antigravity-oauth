import { extractProjectId, getValidAccessToken, parseFormattedApiKey } from "./auth.js";
import {
  DEFAULT_ENDPOINTS,
  DEFAULT_PROJECT_ID,
  NON_CHAT_ID_PATTERNS,
  NON_CHAT_MODALITIES,
  PROVIDER_ID,
  buildAntigravityHeaders,
  buildAntigravityQuotaHeaders
} from "./constants.js";
import type {
  AntigravityEndpoints,
  AuthProfileStore,
  FetchLike,
  OpenClawCatalogModelDefinition,
  QuotaBucketInfo,
  ReasoningLevel,
  SubscriptionModelRow,
  SubscriptionUsageReport
} from "./types.js";

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

interface RawModelsPayload {
  models?: RawSubscriptionModel[] | Record<string, RawSubscriptionModel>;
  clientModelConfigs?: RawSubscriptionModel[] | Record<string, RawSubscriptionModel>;
  modelConfigs?: RawSubscriptionModel[] | Record<string, RawSubscriptionModel>;
  deprecatedModelIds?: string[];
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

interface RawQuotaGroup {
  displayName?: string;
  description?: string;
  buckets?: RawQuotaBucket[];
}

interface RawUserQuotaPayload {
  buckets?: RawQuotaBucket[];
}

export function inferQuotaWindow(
  bucket: RawQuotaBucket,
  knownBuckets?: RawQuotaBucket[]
): "weekly" | "5h" {
  // 1. Explicit window or bucketId/displayName from upstream
  if (bucket.window) {
    const w = bucket.window.trim().toLowerCase();
    if (w === "5h" || w === "five_hour" || w.includes("5h") || w.includes("five") || w.includes("rolling")) return "5h";
    if (w === "weekly" || w.includes("week")) return "weekly";
  }
  const bucketId = (bucket.bucketId ?? "").toLowerCase();
  if (bucketId === "5h" || bucketId.includes("5h") || bucketId.includes("five") || bucketId.includes("rolling")) return "5h";
  if (bucketId.includes("week")) return "weekly";

  const displayName = (bucket.displayName ?? "").toLowerCase();
  if (displayName.includes("5h") || displayName.includes("five hour") || displayName.includes("5-hour") || displayName.includes("rolling") || displayName.includes("five_hour")) return "5h";
  if (displayName.includes("week")) return "weekly";

  // 2. Match against known groups/buckets by (remainingFraction, resetTime)
  if (knownBuckets && knownBuckets.length > 0) {
    const match = knownBuckets.find(
      (k) =>
        typeof k.remainingFraction === "number" &&
        k.remainingFraction === bucket.remainingFraction &&
        typeof k.resetTime === "string" &&
        k.resetTime.length > 0 &&
        k.resetTime === bucket.resetTime
    );
    if (match) {
      if (match.window) {
        const mw = match.window.toLowerCase();
        if (mw.includes("5h") || mw.includes("five") || mw.includes("rolling")) return "5h";
        if (mw.includes("week")) return "weekly";
      }
      const mbId = (match.bucketId ?? "").toLowerCase();
      if (mbId.includes("5h") || mbId.includes("five") || mbId.includes("rolling")) return "5h";
      if (mbId.includes("week")) return "weekly";
      const mName = (match.displayName ?? "").toLowerCase();
      if (mName.includes("5h") || mName.includes("five hour") || mName.includes("5-hour") || mName.includes("rolling")) return "5h";
      if (mName.includes("week")) return "weekly";
    }
  }

  // 3. Time-to-reset heuristic: a 5h bucket has resetTime <= 5h15m in the future.
  // Anything longer is NOT a 5h bucket (e.g. weekly bucket with 18 hours left is weekly).
  if (bucket.resetTime) {
    const resetMs = Date.parse(bucket.resetTime);
    if (Number.isFinite(resetMs)) {
      const diffMs = resetMs - Date.now();
      if (diffMs > 5.25 * 3600_000) {
        return "weekly";
      }
      if (diffMs >= -24 * 3600_000) {
        return "5h";
      }
      return "weekly";
    }
  }
  return "weekly";
}

interface RawUsagePayload {
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  cacheReadTokens?: number;
  quotaWindow?: string;
  resetAt?: string;
  usedPercentage?: number | null;
  buckets?: RawQuotaBucket[];
  groups?: RawQuotaGroup[];
  description?: string;
  plan?: string;
}

type EffortTier = "low" | "medium" | "high" | "tiered";

const VALID_REASONING_LEVELS: ReadonlySet<ReasoningLevel> = new Set([
  "off",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]);

const CANONICAL_REASONING_ORDER: readonly ReasoningLevel[] = [
  "off",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
];

/**
 * Models that send thinkingLevel (not a -low|-medium|-high suffix) and accept EXTRA_HIGH / MAX.
 * gemini-4-argon is intentionally excluded: Argon uses gemini-4-argon-<low|medium|high> variants,
 * buildV1InternalRequestEnvelope skips thinkingConfig for those ids, so advertising xhigh/max
 * would lie.
 */
export const EXTENDED_THINKING_LEVEL_MODELS: ReadonlySet<string> = new Set([
  "gemini-3.8-flash"
]);

/**
 * Corrects known mislabeled display names returned by v1internal:fetchAvailableModels.
 */
export const KNOWN_DISPLAY_NAME_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "gemini-2.5-flash-thinking": "Gemini 2.5 Flash Thinking",
  "gemini-2.5-flash-lite": "Gemini 2.5 Flash Lite",
  "gemini-3-flash": "Gemini 3 Flash",
  "gemini-3.5-flash-lite": "Gemini 3.5 Flash Lite",
  "gemini-3.8-flash": "Gemini 3.8 Flash",
  "gemini-4-argon": "Gemini 4 Argon",
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "gpt-oss-120b": "GPT-OSS 120B"
});

const EFFORT_TIERED_FAMILIES: ReadonlySet<string> = new Set([
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "gemini-4-argon",
  "gemini-3.8-flash"
]);

export const PROTO_MODEL_ID_MAP: Readonly<
  Record<string, { canonicalId: string; effortTier?: EffortTier }>
> = Object.freeze({
  MODEL_PLACEHOLDER_M400: { canonicalId: "claude-opus-5-5", effortTier: "low" },
  MODEL_PLACEHOLDER_M401: { canonicalId: "claude-opus-5-5", effortTier: "medium" },
  MODEL_PLACEHOLDER_M402: { canonicalId: "claude-opus-5-5", effortTier: "high" },
  MODEL_PLACEHOLDER_M403: { canonicalId: "claude-sonnet-5-5", effortTier: "low" },
  MODEL_PLACEHOLDER_M404: { canonicalId: "claude-sonnet-5-5", effortTier: "medium" },
  MODEL_PLACEHOLDER_M405: { canonicalId: "claude-sonnet-5-5", effortTier: "high" },
  MODEL_PLACEHOLDER_M18: { canonicalId: "gemini-3-flash" },
  MODEL_OPENAI_GPT_OSS_120B_MEDIUM: { canonicalId: "gpt-oss-120b", effortTier: "medium" },
  MODEL_GOOGLE_GEMINI_2_5_FLASH: { canonicalId: "gemini-2.5-flash" },
  MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING: { canonicalId: "gemini-2.5-flash-thinking" },
  MODEL_GOOGLE_GEMINI_2_5_PRO: { canonicalId: "gemini-2.5-pro" },
  MODEL_PLACEHOLDER_M50: { canonicalId: "gemini-3.1-flash-lite" },
  MODEL_PLACEHOLDER_M317: { canonicalId: "gemini-4-argon", effortTier: "low" },
  MODEL_PLACEHOLDER_M318: { canonicalId: "gemini-4-argon", effortTier: "medium" },
  MODEL_PLACEHOLDER_M319: { canonicalId: "gemini-4-argon", effortTier: "high" },
  MODEL_PLACEHOLDER_M320: { canonicalId: "gemini-4-argon" },
  MODEL_PLACEHOLDER_M322: { canonicalId: "gemini-3.8-flash", effortTier: "tiered" },
  MODEL_PLACEHOLDER_M124: { canonicalId: "gemini-4-argon" },
  "gemini-4-argon-low": { canonicalId: "gemini-4-argon", effortTier: "low" },
  "gemini-4-argon-medium": { canonicalId: "gemini-4-argon", effortTier: "medium" },
  "gemini-4-argon-high": { canonicalId: "gemini-4-argon", effortTier: "high" },
  "gemini-3.8-flash-tiered": { canonicalId: "gemini-3.8-flash", effortTier: "tiered" },
  chat_20706: { canonicalId: "gemini-3-flash" },
  chat_23310: { canonicalId: "gemini-3-flash" }
});

const MAPPED_CANONICAL_IDS: readonly string[] = Array.from(
  new Set(Object.values(PROTO_MODEL_ID_MAP).map((m) => m.canonicalId))
).sort();

/**
 * Canonical chat models the plugin publishes, derived from PROTO_MODEL_ID_MAP.
 * Ids the catalog filters out (NON_CHAT_ID_PATTERNS, e.g. gemini-2.5-*, gemini-3.1-*) are
 * legacy mapping entries kept only so old proto ids still resolve; they are listed in
 * LEGACY_MAPPED_MODELS and never reported as published or "removed".
 */
export const KNOWN_CATALOG_MODELS: readonly string[] = Object.freeze(
  MAPPED_CANONICAL_IDS.filter((id) => isEligibleChatModel({ id }))
);

/** Canonical ids in PROTO_MODEL_ID_MAP that the plugin does not publish. */
export const LEGACY_MAPPED_MODELS: readonly string[] = Object.freeze(
  MAPPED_CANONICAL_IDS.filter((id) => !isEligibleChatModel({ id }))
);

export function inferDefaultContextWindow(modelId: string): number {
  const lower = modelId.trim().toLowerCase();
  if (lower.startsWith("gemini-") || lower.includes("argon")) {
    return 1_000_000;
  }
  if (/^claude-(?:opus|sonnet)-(?:5|4-6)\b/.test(lower)) {
    return 1_000_000;
  }
  if (lower.startsWith("claude-")) {
    return 200_000;
  }
  return 128_000;
}

export function parseEffortVariant(
  rawId: string,
  rawDisplayName: string
): {
  canonicalId: string;
  canonicalDisplayName: string;
  effortTier?: EffortTier;
} {
  const protoMapped = PROTO_MODEL_ID_MAP[rawId];
  if (protoMapped) {
    const override = KNOWN_DISPLAY_NAME_OVERRIDES[protoMapped.canonicalId];
    return {
      canonicalId: protoMapped.canonicalId,
      canonicalDisplayName: override ?? protoMapped.canonicalId,
      ...(protoMapped.effortTier !== undefined ? { effortTier: protoMapped.effortTier } : {})
    };
  }

  const cleanDisplayName = rawDisplayName
    .replace(/\s*\((?:low|medium|high|tiered)\)\s*$/i, "")
    .trim();
  const match = /^(.*)-(low|medium|high|tiered)$/i.exec(rawId);
  if (!match || !match[1] || !match[2]) {
    return {
      canonicalId: rawId,
      canonicalDisplayName: cleanDisplayName || rawId
    };
  }
  const canonicalId = match[1];
  const suffix = match[2].toLowerCase();
  const effortTier = suffix as EffortTier;
  return {
    canonicalId,
    canonicalDisplayName: cleanDisplayName || canonicalId,
    effortTier
  };
}

export type CatalogEligibilityOptions = {
  deprecatedModelIds?: ReadonlySet<string> | readonly string[];
};

function normalizeModelId(value: string): string {
  return value.trim().replace(/^antigravity\//, "");
}

function asDeprecatedIdSet(
  deprecatedModelIds?: ReadonlySet<string> | readonly string[]
): ReadonlySet<string> | undefined {
  if (!deprecatedModelIds) {
    return undefined;
  }
  const ids = Array.from(deprecatedModelIds)
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    .map((id) => normalizeModelId(id));
  return ids.length > 0 ? new Set(ids) : undefined;
}

export function extractDeprecatedModelIds(payload: {
  deprecatedModelIds?: string[];
}): ReadonlySet<string> {
  return asDeprecatedIdSet(payload.deprecatedModelIds) ?? new Set();
}

function isDeprecatedModel(
  raw: RawSubscriptionModel,
  deprecatedIds?: ReadonlySet<string>
): boolean {
  if (!deprecatedIds || deprecatedIds.size === 0) {
    return false;
  }
  const candidates = [raw.id, raw.model].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0
  );
  for (const candidate of candidates) {
    const id = normalizeModelId(candidate);
    if (deprecatedIds.has(id)) {
      return true;
    }
    const { canonicalId } = parseEffortVariant(id, raw.displayName ?? raw.label ?? raw.name ?? id);
    if (deprecatedIds.has(canonicalId)) {
      return true;
    }
  }
  return false;
}

function mergeOptionalFlag(left?: boolean, right?: boolean): boolean | undefined {
  if (left === true || right === true) {
    return true;
  }
  if (left === false || right === false) {
    return false;
  }
  return undefined;
}

function mergeMimeTypes(
  left?: readonly string[],
  right?: readonly string[]
): readonly string[] | undefined {
  const merged = new Set<string>();
  for (const item of [...(left ?? []), ...(right ?? [])]) {
    if (typeof item === "string" && item.trim().length > 0) {
      merged.add(item.trim());
    }
  }
  return merged.size > 0 ? Object.freeze([...merged]) : undefined;
}

function mediaFieldsFromRow(row: {
  supportsImages?: boolean | undefined;
  supportsVideo?: boolean | undefined;
  supportsPdf?: boolean | undefined;
  supportedMimeTypes?: readonly string[] | undefined;
}): Pick<SubscriptionModelRow, "supportsImages" | "supportsVideo" | "supportsPdf" | "supportedMimeTypes"> {
  return {
    ...(typeof row.supportsImages === "boolean" ? { supportsImages: row.supportsImages } : {}),
    ...(typeof row.supportsVideo === "boolean" ? { supportsVideo: row.supportsVideo } : {}),
    ...(typeof row.supportsPdf === "boolean" ? { supportsPdf: row.supportsPdf } : {}),
    ...(row.supportedMimeTypes && row.supportedMimeTypes.length > 0
      ? { supportedMimeTypes: row.supportedMimeTypes }
      : {})
  };
}

function mergeMediaCapabilities(
  left: SubscriptionModelRow,
  right: SubscriptionModelRow
): Pick<SubscriptionModelRow, "supportsImages" | "supportsVideo" | "supportsPdf" | "supportedMimeTypes"> {
  return mediaFieldsFromRow({
    supportsImages: mergeOptionalFlag(left.supportsImages, right.supportsImages),
    supportsVideo: mergeOptionalFlag(left.supportsVideo, right.supportsVideo),
    supportsPdf: mergeOptionalFlag(left.supportsPdf, right.supportsPdf),
    supportedMimeTypes: mergeMimeTypes(left.supportedMimeTypes, right.supportedMimeTypes)
  });
}

function inferMediaFlags(raw: RawSubscriptionModel): Pick<
  SubscriptionModelRow,
  "supportsImages" | "supportsVideo" | "supportsPdf" | "supportedMimeTypes"
> {
  const supportedMimeTypes = Array.isArray(raw.supportedMimeTypes)
    ? Object.freeze(
        raw.supportedMimeTypes
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          .map((item) => item.trim())
      )
    : undefined;
  const mimeList = supportedMimeTypes ?? [];
  let supportsImages = raw.supportsImages;
  let supportsVideo = raw.supportsVideo;
  let supportsPdf = raw.supportsPdf;
  if (supportsImages === undefined && mimeList.some((mime) => mime.toLowerCase().startsWith("image/"))) {
    supportsImages = true;
  }
  if (supportsVideo === undefined && mimeList.some((mime) => mime.toLowerCase().startsWith("video/"))) {
    supportsVideo = true;
  }
  if (
    supportsPdf === undefined &&
    mimeList.some((mime) => {
      const lower = mime.toLowerCase();
      return lower === "application/pdf" || lower.endsWith("/pdf") || lower.includes("pdf");
    })
  ) {
    supportsPdf = true;
  }
  return mediaFieldsFromRow({
    supportsImages,
    supportsVideo,
    supportsPdf,
    supportedMimeTypes
  });
}

export function isEligibleChatModel(
  raw: RawSubscriptionModel,
  options?: CatalogEligibilityOptions
): boolean {
  const id = raw.id ?? raw.model;
  if (!id || typeof id !== "string" || id.trim().length === 0) {
    return false;
  }

  if (raw.disabled === true || raw.enabled === false) {
    return false;
  }

  if (isDeprecatedModel(raw, asDeprecatedIdSet(options?.deprecatedModelIds))) {
    return false;
  }

  const modality = (raw.modality ?? raw.type ?? "chat").toLowerCase();
  if (NON_CHAT_MODALITIES.has(modality)) {
    return false;
  }
  if (modality !== "chat" && modality !== "text") {
    return false;
  }

  for (const pattern of NON_CHAT_ID_PATTERNS) {
    if (pattern.test(id)) {
      return false;
    }
  }

  return true;
}

export function normalizeModelRow(
  raw: RawSubscriptionModel,
  options?: CatalogEligibilityOptions
): SubscriptionModelRow | null {
  if (!isEligibleChatModel(raw, options)) {
    return null;
  }

  const rawId = (raw.id ?? raw.model ?? "").trim().replace(/^antigravity\//, "");
  const rawDisplay = (raw.displayName ?? raw.label ?? raw.name ?? rawId).trim();
  const { canonicalId, canonicalDisplayName, effortTier } = parseEffortVariant(rawId, rawDisplay);

  const overrideName = KNOWN_DISPLAY_NAME_OVERRIDES[canonicalId];
  const displayName =
    overrideName && (!raw.displayName || raw.displayName === "Gemini 3.5 Flash Lite")
      ? overrideName
      : canonicalDisplayName;

  const inferredContext = inferDefaultContextWindow(canonicalId);
  const rawContext =
    typeof raw.contextWindow === "number" && raw.contextWindow > 0
      ? raw.contextWindow
      : typeof raw.inputTokenLimit === "number" && raw.inputTokenLimit > 0
        ? raw.inputTokenLimit
        : typeof raw.maxInputTokens === "number" && raw.maxInputTokens > 0
          ? raw.maxInputTokens
          : 0;
  const contextWindow = Math.max(rawContext, inferredContext);

  const maxOutputTokens =
    typeof raw.maxOutputTokens === "number" && raw.maxOutputTokens > 0
      ? raw.maxOutputTokens
      : typeof raw.outputTokenLimit === "number" && raw.outputTokenLimit > 0
        ? raw.outputTokenLimit
        : typeof raw.maxOutput === "number" && raw.maxOutput > 0
          ? raw.maxOutput
          : typeof raw.maxTokens === "number" && raw.maxTokens > 0
            ? raw.maxTokens
            : 8_192;

  const canDisableReasoning =
    typeof raw.canDisableReasoning === "boolean"
      ? raw.canDisableReasoning
      : effortTier !== undefined
        ? false
        : raw.supportsThinking === false || /\bflash\b/i.test(canonicalId);

  const baseLevels: ReasoningLevel[] = [];
  if (Array.isArray(raw.reasoningLevels) && raw.reasoningLevels.length > 0) {
    for (const lvl of raw.reasoningLevels) {
      if (VALID_REASONING_LEVELS.has(lvl as ReasoningLevel)) {
        if (lvl === "off" && !canDisableReasoning) {
          // Spec §3: "If a model cannot disable reasoning, do not advertise an `off` level."
          continue;
        }
        if (!baseLevels.includes(lvl as ReasoningLevel)) {
          baseLevels.push(lvl as ReasoningLevel);
        }
      }
    }
  } else if (effortTier !== undefined && effortTier !== "tiered") {
    baseLevels.push(effortTier);
  } else {
    if (canDisableReasoning) {
      baseLevels.push("off");
    }
    baseLevels.push("low", "medium", "high");
  }

  if (canDisableReasoning && !baseLevels.includes("off")) {
    baseLevels.unshift("off");
  }

  return {
    id: canonicalId,
    ref: `${PROVIDER_ID}/${canonicalId}`,
    displayName,
    contextWindow,
    maxOutputTokens,
    canDisableReasoning,
    reasoningLevels: Object.freeze(baseLevels),
    ...inferMediaFlags(raw)
  };
}

export function toOpenClawCatalogModelDefinition(
  row: SubscriptionModelRow,
  baseUrl: string
): OpenClawCatalogModelDefinition {
  const supportsImages =
    row.supportsImages === true ||
    (row.supportsImages === undefined && (
      row.id === "gemini-3.8-flash" ||
      row.id === "gemini-4-argon" ||
      row.id === "claude-opus-5-5" ||
      row.id === "claude-sonnet-5-5" ||
      row.id.startsWith("gemini-") ||
      row.id.startsWith("claude-")
    ));

  // Host OpenClaw catalog `input` is text|image only. Video/PDF capability flags stay on
  // SubscriptionModelRow (supportsVideo / supportsPdf / supportedMimeTypes) for media routes.
  const input: Array<"text" | "image"> = ["text"];
  if (supportsImages) {
    input.push("image");
  }

  // Used by both OAuth configPatch and catalog.run: ModelProviderConfig, not authored catalog metadata.
  return {
    id: row.id,
    name: row.displayName,
    api: "openai-completions",
    baseUrl,
    reasoning: row.reasoningLevels.length > 0,
    input,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: row.contextWindow,
    maxTokens: row.maxOutputTokens,
    ...(row.canDisableReasoning ? {} : { thinkingLevelMap: { off: null } }),
    compat: {
      supportsReasoningEffort: true,
      supportedReasoningEfforts: row.reasoningLevels
    }
  };
}

function extractRawModelsList(payload: RawModelsPayload): RawSubscriptionModel[] {
  const source = payload.models ?? payload.clientModelConfigs ?? payload.modelConfigs;
  if (Array.isArray(source)) {
    return source;
  }
  if (source && typeof source === "object") {
    return Object.entries(source).map(([key, value]) => ({
      ...value,
      // Prefer explicit `id` or dictionary key `key` (the model slug) over `value.model`
      // because v1internal:fetchAvailableModels stores internal enum names in `value.model`.
      id: value.id ?? key
    }));
  }
  return [];
}

export class CatalogService {
  private cachedModels: SubscriptionModelRow[] | null = null;
  private cachedManagedProjectId?: string;
  private readonly variantMap = new Map<string, Partial<Record<EffortTier, string>>>();
  private readonly protoIdMap = new Map<string, string>();

  public constructor(
    private readonly endpoints: AntigravityEndpoints = DEFAULT_ENDPOINTS,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  public getCachedModels(): readonly SubscriptionModelRow[] | null {
    return this.cachedModels;
  }

  public getCachedManagedProjectId(): string | undefined {
    return this.cachedManagedProjectId;
  }

  public setCachedModels(models: readonly SubscriptionModelRow[]): void {
    this.cachedModels = [...models];
  }

  public getKnownModelIds(): readonly string[] {
    return KNOWN_CATALOG_MODELS;
  }

  /**
   * Resolves a requested model ID (either canonical `claude-sonnet-5-5` or effort-suffixed
   * `claude-sonnet-5-5-high`) against the cached subscription catalog and maps the active
   * reasoning effort onto the concrete upstream model ID.
   */
  public resolveModelForTurn(
    bareModelId: string,
    reasoningEffort?: ReasoningLevel
  ): {
    matchedModel: SubscriptionModelRow;
    upstreamModelId: string;
    effectiveEffort?: ReasoningLevel;
  } | null {
    if (!this.cachedModels || this.cachedModels.length === 0) {
      return null;
    }

    const directMatch = this.cachedModels.find((m) => m.id === bareModelId);
    if (directMatch) {
      const variants = this.variantMap.get(bareModelId);
      if (variants && Object.keys(variants).length > 0) {
        let desiredTier: EffortTier =
          reasoningEffort === "low" || reasoningEffort === "medium" || reasoningEffort === "high"
            ? reasoningEffort
            : "medium";
        if (bareModelId === "claude-opus-5-5" && desiredTier === "medium" && !variants.medium) {
          desiredTier = "high";
        }
        if (bareModelId === "gemini-3.8-flash") {
          const upstreamModelId =
            variants[desiredTier] ??
            variants.tiered ??
            "gemini-3.8-flash-tiered";
          return {
            matchedModel: directMatch,
            upstreamModelId,
            ...(reasoningEffort !== undefined ? { effectiveEffort: reasoningEffort } : {})
          };
        }
        const upstreamModelId =
          variants[desiredTier] ??
          variants.high ??
          variants.medium ??
          variants.low ??
          variants.tiered ??
          bareModelId;
        return {
          matchedModel: directMatch,
          upstreamModelId,
          ...(reasoningEffort !== undefined ? { effectiveEffort: reasoningEffort } : {})
        };
      }

      if (EFFORT_TIERED_FAMILIES.has(bareModelId)) {
        if (bareModelId === "gemini-3.8-flash") {
          return {
            matchedModel: directMatch,
            upstreamModelId: "gemini-3.8-flash-tiered",
            ...(reasoningEffort !== undefined ? { effectiveEffort: reasoningEffort } : {})
          };
        }
        let desiredTier: EffortTier =
          reasoningEffort === "low" || reasoningEffort === "medium" || reasoningEffort === "high"
            ? reasoningEffort
            : directMatch.reasoningLevels.includes("medium")
              ? "medium"
              : directMatch.reasoningLevels.includes("high")
                ? "high"
                : "low";
        if (bareModelId === "claude-opus-5-5" && desiredTier === "medium") {
          desiredTier = "high";
        }
        return {
          matchedModel: directMatch,
          upstreamModelId: `${bareModelId}-${desiredTier}`,
          ...(reasoningEffort !== undefined ? { effectiveEffort: reasoningEffort } : {})
        };
      }

      return {
        matchedModel: directMatch,
        upstreamModelId: bareModelId,
        ...(reasoningEffort !== undefined ? { effectiveEffort: reasoningEffort } : {})
      };
    }

    // Also support sessions that still reference an effort-suffixed ID (e.g. `claude-sonnet-5-5-high`)
    const { canonicalId, effortTier } = parseEffortVariant(bareModelId, bareModelId);
    if (effortTier) {
      const canonicalMatch = this.cachedModels.find((m) => m.id === canonicalId);
      if (canonicalMatch) {
        const effectiveEffort: ReasoningLevel | undefined =
          reasoningEffort ?? (effortTier !== "tiered" ? effortTier : undefined);
        const resolved = this.resolveModelForTurn(canonicalId, effectiveEffort);
        if (resolved) {
          return resolved;
        }
      }
    }

    // Handle proto enum ID or legacy internal ID resolution (e.g. MODEL_PLACEHOLDER_M401)
    if (bareModelId.startsWith("MODEL_") || PROTO_MODEL_ID_MAP[bareModelId]) {
      const dynamicSlug = this.protoIdMap.get(bareModelId);
      if (dynamicSlug && dynamicSlug !== bareModelId) {
        return this.resolveModelForTurn(dynamicSlug, reasoningEffort);
      }
      const staticMapping = PROTO_MODEL_ID_MAP[bareModelId];
      if (staticMapping) {
        const fallbackEffort: ReasoningLevel =
          staticMapping.effortTier && staticMapping.effortTier !== "tiered"
            ? staticMapping.effortTier
            : "medium";
        const effectiveEffort: ReasoningLevel = reasoningEffort ?? fallbackEffort;
        return this.resolveModelForTurn(staticMapping.canonicalId, effectiveEffort);
      }
    }

    return null;
  }

  public async listModelsWithToken(
    accessToken: string,
    projectId?: string,
    options?: { refresh?: boolean }
  ): Promise<SubscriptionModelRow[]> {
    if (this.cachedModels !== null && options?.refresh !== true) {
      return [...this.cachedModels];
    }

    const effectiveProject = projectId ?? DEFAULT_PROJECT_ID;
    const requestBody = effectiveProject ? { project: effectiveProject } : {};
    const response = await this.fetchImpl(this.endpoints.modelsUrl, {
      method: "POST",
      headers: {
        ...buildAntigravityHeaders(accessToken),
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(requestBody)
    });

    if (response.status === 401 || response.status === 403) {
      throw new Error(`Authentication error: failed to list subscription models (${response.status})`);
    }

    if (!response.ok) {
      // Spec §3: "A failed or empty discovery does not invent rows and does not switch to another Google API."
      throw new Error(`Catalog discovery failed (${response.status})`);
    }

    const payload = (await response.json()) as RawModelsPayload;
    const rawList = extractRawModelsList(payload);
    if (rawList.length === 0) {
      this.cachedModels = [];
      this.variantMap.clear();
      return [];
    }

    this.variantMap.clear();
    this.protoIdMap.clear();
    const byId = new Map<string, SubscriptionModelRow>();
    const deprecatedModelIds = extractDeprecatedModelIds(payload);
    const eligibility = { deprecatedModelIds };

    for (const raw of rawList) {
      const rawModelEnum = (raw.model ?? "").trim();
      const rawSlug = (raw.id ?? "").trim().replace(/^antigravity\//, "");
      if (rawModelEnum.startsWith("MODEL_") && rawSlug) {
        this.protoIdMap.set(rawModelEnum, rawSlug);
      }

      if (!isEligibleChatModel(raw, eligibility)) {
        continue;
      }
      const rawId = (raw.id ?? raw.model ?? "").trim().replace(/^antigravity\//, "");
      const rawDisplay = (raw.displayName ?? raw.label ?? raw.name ?? rawId).trim();
      const { canonicalId, effortTier } = parseEffortVariant(rawId, rawDisplay);

      if (effortTier) {
        const existingVariants = this.variantMap.get(canonicalId) ?? {};
        existingVariants[effortTier] = rawId;
        this.variantMap.set(canonicalId, existingVariants);
      }

      let row = normalizeModelRow(raw, eligibility);
      if (!row) {
        continue;
      }

      if (EFFORT_TIERED_FAMILIES.has(row.id)) {
        const tiers: ReasoningLevel[] = row.canDisableReasoning
          ? ["off", "low", "medium", "high"]
          : ["low", "medium", "high"];
        if (EXTENDED_THINKING_LEVEL_MODELS.has(row.id)) {
          tiers.push("xhigh", "max");
        }
        row = {
          ...row,
          reasoningLevels: Object.freeze(tiers)
        };
      }

      const existingRow = byId.get(row.id);
      if (!existingRow) {
        byId.set(row.id, row);
      } else {
        // Merge reasoning levels in canonical order (off, low, medium, high, xhigh, max)
        const mergedSet = new Set<ReasoningLevel>([
          ...existingRow.reasoningLevels,
          ...row.reasoningLevels
        ]);
        const canDisable = existingRow.canDisableReasoning || row.canDisableReasoning;
        const mergedLevels = CANONICAL_REASONING_ORDER.filter(
          (lvl) => mergedSet.has(lvl) && (lvl !== "off" || canDisable)
        );
        byId.set(row.id, {
          ...existingRow,
          contextWindow: Math.max(existingRow.contextWindow, row.contextWindow),
          maxOutputTokens: Math.max(existingRow.maxOutputTokens, row.maxOutputTokens),
          canDisableReasoning: canDisable,
          reasoningLevels: Object.freeze(mergedLevels),
          ...mergeMediaCapabilities(existingRow, row)
        });
      }
    }

    const hasAntigravityModels =
      byId.has("claude-sonnet-5-5") ||
      byId.has("claude-opus-5-5") ||
      byId.has("gemini-3.8-flash") ||
      byId.has("gpt-oss-120b");
    if (hasAntigravityModels && !byId.has("gemini-4-argon")) {
      byId.set("gemini-4-argon", {
        id: "gemini-4-argon",
        ref: `${PROVIDER_ID}/gemini-4-argon`,
        displayName: "Gemini 4 Argon",
        contextWindow: 1_000_000,
        maxOutputTokens: 65_536,
        canDisableReasoning: false,
        reasoningLevels: Object.freeze(["low", "medium", "high"])
      });
      if (!this.variantMap.has("gemini-4-argon")) {
        this.variantMap.set("gemini-4-argon", {
          low: "gemini-4-argon-low",
          medium: "gemini-4-argon-medium",
          high: "gemini-4-argon-high"
        });
      }
    }

    if (byId.has("gemini-3.8-flash") && !this.variantMap.has("gemini-3.8-flash")) {
      this.variantMap.set("gemini-3.8-flash", {
        tiered: "gemini-3.8-flash-tiered"
      });
    }

    const normalized = [...byId.values()];
    this.cachedModels = normalized;
    return [...normalized];
  }

  public async listModels(
    authStore: AuthProfileStore,
    options?: {
      refresh?: boolean;
      agentDir?: string;
      cfg?: unknown;
      signal?: AbortSignal;
    }
  ): Promise<SubscriptionModelRow[]> {
    if (this.cachedModels !== null && options?.refresh !== true) {
      return [...this.cachedModels];
    }

    let token: string | undefined;
    let proj: string | undefined;

    try {
      const { resolveApiKeyForProvider } = await import(
        "openclaw/plugin-sdk/provider-auth-runtime"
      );
      const resolved = await resolveApiKeyForProvider({
        provider: PROVIDER_ID,
        agentDir: options?.agentDir,
        cfg: options?.cfg as any,
        signal: options?.signal
      });
      if (resolved?.apiKey) {
        const parsed = parseFormattedApiKey(resolved.apiKey);
        if (parsed?.token) {
          token = parsed.token;
          proj = parsed.projectId;
        }
      }
    } catch {
      // Ignore if host runtime helper is unavailable
    }

    if (!token) {
      token = await getValidAccessToken(authStore, this.endpoints, this.fetchImpl);
      const stored = await authStore.getSecret(PROVIDER_ID);
      proj = stored?.projectId;
    }

    return await this.listModelsWithToken(token, proj, options);
  }

  public async getUsageWithToken(
    accessToken: string,
    projectId?: string
  ): Promise<SubscriptionUsageReport> {
    let effectiveProject =
      projectId && projectId !== DEFAULT_PROJECT_ID ? projectId : this.cachedManagedProjectId;

    if (!effectiveProject && this.endpoints.verifySubscriptionUrl) {
      try {
        const verifyRes = await this.fetchImpl(this.endpoints.verifySubscriptionUrl, {
          method: "POST",
          headers: {
            ...buildAntigravityHeaders(accessToken),
            "Content-Type": "application/json",
            Accept: "application/json"
          },
          body: JSON.stringify({
            metadata: {
              ideType: "ANTIGRAVITY"
            }
          })
        });
        if (verifyRes.ok) {
          const verifyData = (await verifyRes.json()) as any;
          const resolved = extractProjectId(verifyData?.cloudaicompanionProject);
          if (resolved) {
            this.cachedManagedProjectId = resolved;
            effectiveProject = resolved;
          }
        }
      } catch {
        // Fall back gracefully if subscription verification endpoint is unavailable
      }
    }

    effectiveProject = effectiveProject || DEFAULT_PROJECT_ID;
    const bodyStr = JSON.stringify(effectiveProject ? { project: effectiveProject } : {});

    const userQuotaEndpoint =
      this.endpoints.userQuotaUrl ??
      this.endpoints.usageUrl.replace(/retrieveUserQuotaSummary$/, "retrieveUserQuota");

    type SourceResult = { ok: boolean; status: number; data?: any; error?: string };
    const fetchSource = async (
      url: string,
      timeoutMs = 10000
    ): Promise<SourceResult> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const isQuotaCall = url.includes("retrieveUserQuota");
        const reqHeaders = isQuotaCall
          ? buildAntigravityQuotaHeaders(accessToken)
          : {
              ...buildAntigravityHeaders(accessToken),
              "Content-Type": "application/json",
              Accept: "application/json"
            };
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: reqHeaders,
          body: bodyStr,
          signal: controller.signal
        });
        clearTimeout(timer);
        if (!res.ok) {
          return { ok: false, status: res.status, error: `HTTP ${res.status}` };
        }
        const data = await res.json();
        return { ok: true, status: res.status, data };
      } catch (err: any) {
        clearTimeout(timer);
        return { ok: false, status: 0, error: err?.message || String(err) };
      }
    };

    // Query retrieveUserQuotaSummary and retrieveUserQuota in parallel
    const [summaryResult, userQuotaResult] = await Promise.all([
      fetchSource(this.endpoints.usageUrl),
      userQuotaEndpoint ? fetchSource(userQuotaEndpoint) : Promise.resolve<SourceResult>({ ok: false, status: 0 })
    ]);

    // Section E: Only fall back to fetchAvailableModels if retrieveUserQuota fails
    let modelsResult: SourceResult = { ok: false, status: 0 };
    if (!userQuotaResult.ok && this.endpoints.modelsUrl) {
      modelsResult = await fetchSource(this.endpoints.modelsUrl);
    }

    // Check for fatal authentication errors (401/403) across sources
    if (
      (summaryResult.status === 401 || summaryResult.status === 403) &&
      !userQuotaResult.ok &&
      !modelsResult.ok
    ) {
      throw new Error(`Authentication error: failed to fetch subscription usage (${summaryResult.status})`);
    }

    if (!summaryResult.ok && !userQuotaResult.ok && !modelsResult.ok) {
      throw new Error(`Failed to fetch subscription usage (${summaryResult.error || "all sources failed"})`);
    }

    const summaryData = (summaryResult.ok ? summaryResult.data : null) as RawUsagePayload | null;
    const userQuotaData = (userQuotaResult.ok ? userQuotaResult.data : null) as RawUserQuotaPayload | null;
    const modelsData = (modelsResult.ok ? modelsResult.data : null) as RawModelsPayload | null;

    // Extract summary buckets
    const summaryBuckets: RawQuotaBucket[] = [];
    if (summaryData) {
      if (Array.isArray(summaryData.groups)) {
        for (const group of summaryData.groups) {
          if (Array.isArray(group.buckets)) {
            for (const b of group.buckets) {
              const groupName = group.displayName ?? b.groupDisplayName;
              summaryBuckets.push({
                ...b,
                ...(groupName ? { groupDisplayName: groupName } : {})
              });
            }
          }
        }
      }
      if (Array.isArray(summaryData.buckets)) {
        for (const b of summaryData.buckets) {
          summaryBuckets.push(b);
        }
      }
    }

    // Extract raw model buckets from userQuota and models
    const rawModelBuckets: RawQuotaBucket[] = [];
    if (userQuotaData && Array.isArray(userQuotaData.buckets)) {
      for (const b of userQuotaData.buckets) {
        if (b.modelId) {
          rawModelBuckets.push(b);
        }
      }
    }
    if (modelsData) {
      const rawList = Array.isArray(modelsData.models)
        ? modelsData.models
        : modelsData.models
          ? Object.values(modelsData.models)
          : [];
      for (const m of rawList) {
        if (m.quotaInfo && typeof m.quotaInfo.remainingFraction === "number") {
          const modelId = m.name ?? m.id;
          if (modelId) {
            rawModelBuckets.push({
              modelId,
              ...(m.displayName ? { displayName: m.displayName } : {}),
              remainingFraction: m.quotaInfo.remainingFraction,
              ...(m.quotaInfo.resetTime ? { resetTime: m.quotaInfo.resetTime } : {})
            });
          }
        }
      }
    }

    const hasSummaryClaudeGroup = summaryBuckets.some(
      (b) =>
        /claude|gpt|3p/i.test(b.groupDisplayName ?? "") ||
        /3p/i.test(b.bucketId ?? "")
    );
    const hasSummaryGeminiGroup = summaryBuckets.some(
      (b) =>
        /gemini/i.test(b.groupDisplayName ?? "") &&
        !/argon/i.test(b.groupDisplayName ?? "")
    );
    const hasSummaryArgonGroup = summaryBuckets.some(
      (b) => /argon/i.test(b.groupDisplayName ?? "") || /argon/i.test(b.bucketId ?? "")
    );

    const finalBuckets: QuotaBucketInfo[] = [];

    // Add summary buckets (normalized)
    for (const b of summaryBuckets) {
      const win = inferQuotaWindow(b, summaryBuckets);
      const dispName = b.displayName ?? b.bucketId;
      finalBuckets.push({
        ...(b.bucketId ? { bucketId: b.bucketId } : {}),
        ...(b.modelId ? { modelId: b.modelId } : {}),
        ...(dispName ? { displayName: dispName } : {}),
        ...(b.groupDisplayName ? { groupDisplayName: b.groupDisplayName } : {}),
        ...(b.description ? { description: b.description } : {}),
        window: win,
        ...(typeof b.remainingFraction === "number" ? { remainingFraction: b.remainingFraction } : {}),
        ...(typeof b.remainingAmount === "number" ? { remainingAmount: b.remainingAmount } : {}),
        ...(typeof b.disabled === "boolean" ? { disabled: b.disabled } : {}),
        ...(b.resetTime ? { resetTime: b.resetTime } : {})
      });
    }

    // Process per-model buckets
    // Deduplicate across userQuota and models by modelId + window
    const seenModelKeys = new Set<string>();
    const deduplicatedModelBuckets: RawQuotaBucket[] = [];
    for (const b of rawModelBuckets) {
      if (/^(chat_|tab_)/i.test(b.modelId ?? "") && !b.resetTime) {
        continue;
      }
      const win = inferQuotaWindow(b, summaryBuckets);
      const key = `${b.modelId}:${win}`;
      if (!seenModelKeys.has(key)) {
        seenModelKeys.add(key);
        deduplicatedModelBuckets.push({ ...b, window: win });
      }
    }

    const geminiModels: RawQuotaBucket[] = [];
    const argonModels: RawQuotaBucket[] = [];
    const claudeModels: RawQuotaBucket[] = [];
    const otherModels: RawQuotaBucket[] = [];

    for (const b of deduplicatedModelBuckets) {
      const mId = b.modelId ?? "";
      if (/argon/i.test(mId)) {
        argonModels.push(b);
      } else if (/gemini/i.test(mId)) {
        geminiModels.push(b);
      } else if (/claude|gpt/i.test(mId)) {
        claudeModels.push(b);
      } else {
        otherModels.push(b);
      }
    }

    // 1. Process Gemini models if not already in summary
    if (!hasSummaryGeminiGroup && geminiModels.length > 0) {
      const byWindow = new Map<string, RawQuotaBucket[]>();
      for (const m of geminiModels) {
        const win = m.window ?? "5h";
        const list = byWindow.get(win) ?? [];
        list.push(m);
        byWindow.set(win, list);
      }

      for (const [win, list] of byWindow) {
        const first = list[0];
        if (!first) continue;
        const allShare = list.every(
          (b) =>
            b.remainingFraction === first.remainingFraction &&
            b.resetTime === first.resetTime
        );
        if (allShare) {
          finalBuckets.push({
            groupDisplayName: "Gemini",
            displayName: "Gemini",
            window: win,
            ...(typeof first.remainingFraction === "number"
              ? { remainingFraction: first.remainingFraction }
              : {}),
            ...(first.resetTime ? { resetTime: first.resetTime } : {}),
            ...(typeof first.disabled === "boolean" ? { disabled: first.disabled } : {})
          });
        } else {
          for (const b of list) {
            const dName = b.displayName ?? b.modelId;
            finalBuckets.push({
              ...(b.modelId ? { modelId: b.modelId } : {}),
              ...(dName ? { displayName: dName } : {}),
              groupDisplayName: "Gemini",
              window: win,
              ...(typeof b.remainingFraction === "number"
                ? { remainingFraction: b.remainingFraction }
                : {}),
              ...(b.resetTime ? { resetTime: b.resetTime } : {}),
              ...(typeof b.disabled === "boolean" ? { disabled: b.disabled } : {})
            });
          }
        }
      }
    }

    // 2. Process Claude and GPT models if not already in summary
    if (!hasSummaryClaudeGroup && claudeModels.length > 0) {
      const byWindow = new Map<string, RawQuotaBucket[]>();
      for (const m of claudeModels) {
        const win = m.window ?? "weekly";
        const list = byWindow.get(win) ?? [];
        list.push(m);
        byWindow.set(win, list);
      }

      for (const [win, list] of byWindow) {
        const first = list[0];
        if (!first) continue;
        const allShare = list.every(
          (b) =>
            b.remainingFraction === first.remainingFraction &&
            b.resetTime === first.resetTime
        );
        if (allShare) {
          finalBuckets.push({
            groupDisplayName: "Claude and GPT",
            displayName: "Claude and GPT",
            window: win,
            ...(typeof first.remainingFraction === "number"
              ? { remainingFraction: first.remainingFraction }
              : {}),
            ...(first.resetTime ? { resetTime: first.resetTime } : {}),
            ...(typeof first.disabled === "boolean" ? { disabled: first.disabled } : {})
          });
        } else {
          for (const b of list) {
            const dName = b.displayName ?? b.modelId;
            finalBuckets.push({
              ...(b.modelId ? { modelId: b.modelId } : {}),
              ...(dName ? { displayName: dName } : {}),
              groupDisplayName: "Claude and GPT",
              window: win,
              ...(typeof b.remainingFraction === "number"
                ? { remainingFraction: b.remainingFraction }
                : {}),
              ...(b.resetTime ? { resetTime: b.resetTime } : {}),
              ...(typeof b.disabled === "boolean" ? { disabled: b.disabled } : {})
            });
          }
        }
      }
    }

    // 3. Process Argon models if not already in summary
    if (!hasSummaryArgonGroup && argonModels.length > 0) {
      for (const b of argonModels) {
        const isExhaustedOrDisabled =
          b.disabled === true || b.remainingFraction === 0 || (typeof b.remainingFraction === "number" && b.remainingFraction <= 0);
        finalBuckets.push({
          groupDisplayName: "Gemini 4 Argon",
          displayName: "Gemini 4 Argon",
          ...(b.modelId ? { modelId: b.modelId } : {}),
          window: b.window ?? "weekly",
          ...(isExhaustedOrDisabled ? { remainingFraction: 0 } : typeof b.remainingFraction === "number" ? { remainingFraction: b.remainingFraction } : {}),
          ...(b.resetTime ? { resetTime: b.resetTime } : {}),
          ...(isExhaustedOrDisabled ? { disabled: true } : typeof b.disabled === "boolean" ? { disabled: b.disabled } : {})
        });
      }
    }

    // 4. Other models
    for (const b of otherModels) {
      const dName = b.displayName ?? b.modelId;
      finalBuckets.push({
        ...(b.modelId ? { modelId: b.modelId } : {}),
        ...(dName ? { displayName: dName } : {}),
        ...(b.window ? { window: b.window } : {}),
        ...(typeof b.remainingFraction === "number" ? { remainingFraction: b.remainingFraction } : {}),
        ...(b.resetTime ? { resetTime: b.resetTime } : {}),
        ...(typeof b.disabled === "boolean" ? { disabled: b.disabled } : {})
      });
    }

    // Deduplicate finalBuckets by (groupDisplayName || modelId || displayName) + window
    const seenFinalKeys = new Set<string>();
    const deduplicatedFinalBuckets: QuotaBucketInfo[] = [];
    for (const b of finalBuckets) {
      const groupKey = b.groupDisplayName ?? b.displayName ?? b.modelId ?? b.bucketId ?? "";
      const key = `${groupKey.toLowerCase()}:${(b.window ?? "").toLowerCase()}`;
      if (!seenFinalKeys.has(key)) {
        seenFinalKeys.add(key);
        deduplicatedFinalBuckets.push(b);
      }
    }

    const firstBucketWithReset = deduplicatedFinalBuckets.find(
      (b) => typeof b.resetTime === "string" && b.resetTime.length > 0
    );

    const hasPercentage =
      summaryData && typeof summaryData.usedPercentage === "number" && Number.isFinite(summaryData.usedPercentage);

    const compactSummary = summaryData
      ? {
          ...(Array.isArray(summaryData.groups) ? { groups: summaryData.groups } : {}),
          ...(Array.isArray(summaryData.buckets) ? { buckets: summaryData.buckets } : {}),
          ...(summaryData.description ? { description: summaryData.description } : {})
        }
      : undefined;

    const compactUserQuota = userQuotaData
      ? {
          ...(Array.isArray(userQuotaData.buckets) ? { buckets: userQuotaData.buckets } : {})
        }
      : undefined;

    let compactModelsQuota: Record<string, unknown> | undefined;
    if (modelsData) {
      compactModelsQuota = {};
      const rawList = Array.isArray(modelsData.models)
        ? modelsData.models
        : modelsData.models
          ? Object.values(modelsData.models)
          : [];
      for (const m of rawList) {
        if (m.quotaInfo) {
          const id = m.name ?? m.id;
          if (id) {
            compactModelsQuota[id] = m.quotaInfo;
          }
        }
      }
    }

    return {
      inputTokens: summaryData && typeof summaryData.inputTokens === "number" ? summaryData.inputTokens : 0,
      outputTokens: summaryData && typeof summaryData.outputTokens === "number" ? summaryData.outputTokens : 0,
      thinkingTokens: summaryData && typeof summaryData.thinkingTokens === "number" ? summaryData.thinkingTokens : 0,
      cacheReadTokens: summaryData && typeof summaryData.cacheReadTokens === "number" ? summaryData.cacheReadTokens : 0,
      quotaWindow:
        summaryData && typeof summaryData.quotaWindow === "string"
          ? summaryData.quotaWindow
          : firstBucketWithReset?.modelId ?? firstBucketWithReset?.window ?? "subscription",
      resetAt:
        summaryData && typeof summaryData.resetAt === "string"
          ? summaryData.resetAt
          : firstBucketWithReset?.resetTime ?? "",
      usedPercentage: hasPercentage ? summaryData!.usedPercentage! : null,
      percentageOmitted: !hasPercentage,
      ...(summaryData?.plan ? { plan: summaryData.plan } : {}),
      buckets: deduplicatedFinalBuckets,
      ...(compactSummary ? { rawSummary: compactSummary } : {}),
      ...(compactUserQuota ? { rawUserQuota: compactUserQuota } : {}),
      ...(compactModelsQuota ? { rawModels: compactModelsQuota } : {}),
      rawSources: {
        ...(compactSummary ? { summary: compactSummary } : {}),
        ...(compactUserQuota ? { userQuota: compactUserQuota } : {}),
        ...(compactModelsQuota ? { models: compactModelsQuota } : {})
      }
    };
  }

  public async getUsage(
    authStore: AuthProfileStore,
    options?: {
      agentDir?: string;
      cfg?: unknown;
      signal?: AbortSignal;
    }
  ): Promise<SubscriptionUsageReport> {
    let token: string | undefined;
    let proj: string | undefined;

    try {
      const { resolveApiKeyForProvider } = await import(
        "openclaw/plugin-sdk/provider-auth-runtime"
      );
      const resolved = await resolveApiKeyForProvider({
        provider: PROVIDER_ID,
        agentDir: options?.agentDir,
        cfg: options?.cfg as any,
        signal: options?.signal
      });
      if (resolved?.apiKey) {
        const parsed = parseFormattedApiKey(resolved.apiKey);
        if (parsed?.token) {
          token = parsed.token;
          proj = parsed.projectId;
        }
      }
    } catch {
      // Ignore if host runtime helper is unavailable
    }

    if (!token) {
      token = await getValidAccessToken(authStore, this.endpoints, this.fetchImpl);
      const stored = await authStore.getSecret(PROVIDER_ID);
      proj = stored?.projectId;
    }

    const report = await this.getUsageWithToken(token, proj);
    if (this.cachedManagedProjectId) {
      try {
        const stored = await authStore.getSecret(PROVIDER_ID);
        if (stored && !stored.projectId) {
          await authStore.setSecret(PROVIDER_ID, {
            ...stored,
            projectId: this.cachedManagedProjectId
          });
        }
      } catch {
        // Best effort update
      }
    }
    return report;
  }
}
