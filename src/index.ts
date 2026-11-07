import {
  InMemoryAuthProfileStore,
  loginWithOAuth,
  parseFormattedApiKey,
  refreshAccessToken,
  refreshOAuthCredential
} from "./auth.js";
import {
  CatalogService,
  EXTENDED_THINKING_LEVEL_MODELS,
  toOpenClawCatalogModelDefinition
} from "./catalog.js";
import { DEFAULT_ENDPOINTS, DEFAULT_PROJECT_ID, PLUGIN_ID, PROVIDER_ID } from "./constants.js";
import { buildAntigravityMediaUnderstandingProvider } from "./media.js";
import { buildAntigravityWebSearchProvider } from "./search.js";
import { buildAntigravityWebFetchProvider } from "./fetch.js";
import { buildAntigravityImageGenerationProvider } from "./image.js";
import {
  executeTurn,
  extractHostResponseFormat,
  extractThoughtSignature,
  extractThoughtSignatureModel,
  formatResetTime
} from "./turn.js";
import type {
  AntigravityAuthCredentials,
  AntigravityEndpoints,
  AntigravityImageGenerationProvider,
  AntigravityMediaUnderstandingProvider,
  AntigravityProviderOptions,
  AntigravityWebSearchProvider,
  AntigravityWebFetchProvider,
  AuthProfileStore,
  ConversationMessage,
  FailoverReason,
  FetchLike,
  HostToolCall,
  HostToolDefinition,
  LoginContext,
  LoginResult,
  OpenClawAuthMethodContext,
  OpenClawCatalogRunContext,
  OpenClawOAuthCredential,
  OpenClawPluginApi,
  OpenClawPluginDefinition,
  OpenClawProviderAuthMethod,
  OpenClawProviderAuthResult,
  OpenClawProviderAuthSurface,
  OpenClawProviderRegistration,
  ProviderFailoverErrorContext,
  ProviderThinkingProfile,
  QuotaBucketInfo,
  ReasoningLevel,
  ResolveThinkingProfileContext,
  TurnContentPart,
  TurnRequest,
  TurnResponse
} from "./types.js";

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
export function definePluginEntry(definition: OpenClawPluginDefinition): OpenClawPluginDefinition {
  return definition;
}



class SimpleAssistantEventStream {
  private readonly queue: Array<Record<string, unknown>> = [];
  private readonly waiting: Array<
    (value: IteratorResult<Record<string, unknown>, void>) => void
  > = [];
  private isDone = false;
  private resultSettled = false;
  private resolveFinal!: (value: Record<string, unknown>) => void;
  private rejectFinal!: (reason?: unknown) => void;
  private readonly finalPromise: Promise<Record<string, unknown>>;

  public constructor() {
    this.finalPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.resolveFinal = resolve;
      this.rejectFinal = reject;
    });
  }

  public push(event: Record<string, unknown>): void {
    if (this.isDone) {
      return;
    }
    if (event.type === "done") {
      this.isDone = true;
      this.resultSettled = true;
      this.resolveFinal((event.message as Record<string, unknown>) ?? event);
    } else if (event.type === "error") {
      this.isDone = true;
      this.resultSettled = true;
      this.resolveFinal((event.error as Record<string, unknown>) ?? event);
    }
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  public end(finalMessage?: Record<string, unknown>): void {
    this.isDone = true;
    if (finalMessage !== undefined && !this.resultSettled) {
      this.resultSettled = true;
      this.resolveFinal(finalMessage);
    } else if (!this.resultSettled) {
      this.resultSettled = true;
      this.finalPromise.catch(() => {});
      this.rejectFinal(new Error("Stream ended without terminal event"));
    }
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift();
      waiter?.({ value: undefined, done: true });
    }
  }

  public result(): Promise<Record<string, unknown>> {
    return this.finalPromise;
  }

  public async *[Symbol.asyncIterator](): AsyncGenerator<Record<string, unknown>, void, unknown> {
    while (true) {
      if (this.queue.length > 0) {
        const nextEvent = this.queue.shift()!;
        yield nextEvent;
      } else if (this.isDone) {
        return;
      } else {
        const item = await new Promise<IteratorResult<Record<string, unknown>, void>>((resolve) => {
          this.waiting.push(resolve);
        });
        if (item.done) {
          return;
        }
        yield item.value;
      }
    }
  }
}

function convertOpenClawMessages(
  rawMessages: ReadonlyArray<Record<string, unknown>> | undefined
): ConversationMessage[] {
  if (!Array.isArray(rawMessages)) {
    return [];
  }
  const converted: ConversationMessage[] = [];

  for (const msg of rawMessages) {
    const rawRole = typeof msg.role === "string" ? msg.role : "user";
    if (rawRole === "toolResult" || rawRole === "tool") {
      const toolCallId =
        typeof msg.toolCallId === "string"
          ? msg.toolCallId
          : typeof msg.tool_call_id === "string"
            ? msg.tool_call_id
            : undefined;
      const toolName =
        typeof msg.toolName === "string"
          ? msg.toolName
          : typeof msg.name === "string"
            ? msg.name
            : "tool";
      if (typeof msg.content === "string") {
        converted.push({
          role: "tool",
          content: msg.content,
          name: toolName,
          ...(toolCallId ? { toolCallId } : {})
        });
      } else if (Array.isArray(msg.content)) {
        const parts: TurnContentPart[] = [];
        for (const part of msg.content) {
          if (!part || typeof part !== "object") {
            if (typeof part === "string") {
              parts.push({ type: "text", text: part });
            }
            continue;
          }
          const p = part as Record<string, unknown>;
          if (p.type === "text" && typeof p.text === "string") {
            parts.push({ type: "text", text: p.text });
          } else if (
            p.type === "image" &&
            typeof p.data === "string"
          ) {
            const mime =
              typeof p.mimeType === "string"
                ? p.mimeType
                : typeof p.mime === "string"
                  ? p.mime
                  : "image/png";
            parts.push({
              type: "image",
              data: p.data,
              mimeType: mime
            });
          } else if (p.inlineData || p.inline_data || p.type === "image_url") {
            parts.push(p as TurnContentPart);
          } else {
            parts.push({ type: "text", text: "[Unsupported tool output block]" });
          }
        }
        converted.push({
          role: "tool",
          content: parts,
          name: toolName,
          ...(toolCallId ? { toolCallId } : {})
        });
      }
      continue;
    }

    const role: "system" | "user" | "assistant" =
      rawRole === "system" || rawRole === "assistant" ? rawRole : "user";
    const toolCalls: HostToolCall[] = [];

    if (typeof msg.content === "string") {
      converted.push({
        role,
        content: msg.content
      });
      continue;
    }

    if (Array.isArray(msg.content)) {
      const parts: TurnContentPart[] = [];
      let textContent = "";

      for (const block of msg.content) {
        if (!block || typeof block !== "object") {
          if (typeof block === "string") {
            parts.push({ type: "text", text: block });
            textContent += block;
          }
          continue;
        }
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          parts.push({ type: "text", text: b.text });
          textContent += b.text;
        } else if (
          b.type === "image" &&
          typeof b.data === "string"
        ) {
          const mime =
            typeof b.mimeType === "string"
              ? b.mimeType
              : typeof b.mime === "string"
                ? b.mime
                : "image/png";
          parts.push({
            type: "image",
            data: b.data,
            mimeType: mime
          });
        } else if (b.type === "toolCall" && typeof b.name === "string") {
          const thoughtSignature = extractThoughtSignature(b);
          const thoughtSignatureModel = extractThoughtSignatureModel(b);
          toolCalls.push({
            id: typeof b.id === "string" ? b.id : `call_${toolCalls.length}`,
            name: b.name,
            arguments:
              b.arguments && typeof b.arguments === "object"
                ? (b.arguments as Record<string, unknown>)
                : typeof b.arguments === "string"
                  ? b.arguments
                  : {},
            ...(thoughtSignature ? { thoughtSignature } : {}),
            ...(thoughtSignatureModel ? { thoughtSignatureModel } : {})
          });
        } else if (b.type === "image_url" || b.type === "input_audio" || b.inlineData || b.inline_data) {
          parts.push(b as TurnContentPart);
        }
      }

      const hasStructuredParts = parts.some(
        (p) =>
          typeof p === "object" &&
          p !== null &&
          ("data" in p || "inlineData" in p || "inline_data" in p || "image_url" in p || "source" in p)
      );

      converted.push({
        role,
        content: hasStructuredParts ? parts : textContent,
        ...(toolCalls.length > 0 ? { toolCalls } : {})
      });
      continue;
    }

    converted.push({
      role,
      content: ""
    });
  }

  return converted;
}

function convertOpenClawTools(
  rawTools: ReadonlyArray<Record<string, unknown>> | undefined
): HostToolDefinition[] | undefined {
  if (!Array.isArray(rawTools) || rawTools.length === 0) {
    return undefined;
  }
  const defs: HostToolDefinition[] = [];
  for (const t of rawTools) {
    const fn =
      t.function && typeof t.function === "object"
        ? (t.function as Record<string, unknown>)
        : t;
    const name = typeof fn.name === "string" ? fn.name.trim() : "";
    if (!name) {
      continue;
    }
    const description = typeof fn.description === "string" ? fn.description : undefined;
    const parameters =
      fn.parameters && typeof fn.parameters === "object"
        ? (fn.parameters as Record<string, unknown>)
        : { type: "object", properties: {} };
    defs.push({
      name,
      ...(description !== undefined ? { description } : {}),
      parameters
    });
  }
  return defs.length > 0 ? defs : undefined;
}

function extractReasoningEffort(options?: Record<string, unknown>): ReasoningLevel | undefined {
  if (!options) {
    return undefined;
  }
  let raw: unknown =
    options.reasoningEffort ??
    options.reasoning_effort ??
    options.reasoning ??
    options.thinkingLevel ??
    options.thinking_level ??
    options.effort;

  if (raw === undefined && options.thinking !== undefined) {
    if (typeof options.thinking === "object" && options.thinking !== null) {
      const thinkingObj = options.thinking as Record<string, unknown>;
      raw =
        thinkingObj.level ??
        thinkingObj.effort ??
        thinkingObj.thinkingLevel ??
        thinkingObj.thinking_level;
    } else {
      raw = options.thinking;
    }
  }

  if (typeof raw === "number" && Number.isFinite(raw)) {
    if (raw <= 0) return "off";
    if (raw < 0.35) return "low";
    if (raw < 0.75) return "medium";
    return "high";
  }

  if (typeof raw !== "string") {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "off" || normalized === "none" || normalized === "disabled") {
    return "off";
  }
  if (normalized === "low" || normalized === "minimal") {
    return "low";
  }
  if (normalized === "medium" || normalized === "adaptive") {
    return "medium";
  }
  if (normalized === "high" || normalized === "highest" || normalized === "ultra") {
    return "high";
  }
  if (
    normalized === "xhigh" ||
    normalized === "x-high" ||
    normalized === "x_high" ||
    normalized === "extra-high" ||
    normalized === "extra_high" ||
    normalized === "extra high"
  ) {
    return "xhigh";
  }
  if (normalized === "max" || normalized === "maximum") {
    return "max";
  }
  return undefined;
}

function canonicalModelId(modelId?: string): string {
  const raw = (modelId ?? "").trim();
  return raw.startsWith("antigravity/") ? raw.slice("antigravity/".length) : raw;
}

function thinkingProfileFromLevels(
  levels: readonly ReasoningLevel[]
): ProviderThinkingProfile | undefined {
  if (levels.length === 0) {
    return undefined;
  }
  const defaultLevel: ReasoningLevel = levels.includes("medium")
    ? "medium"
    : levels.includes("high")
      ? "high"
      : levels.includes("low")
        ? "low"
        : levels[0]!;
  return {
    levels: levels.map((id) => ({ id })),
    defaultLevel
  };
}

export function formatGroupName(group?: string): string {
  if (!group) return "";
  const trimmed = group.trim();
  if (/^claude and gpt( models)?$/i.test(trimmed)) {
    return "Claude and GPT";
  }
  if (/^gemini( models)?$/i.test(trimmed)) {
    return "Gemini";
  }
  if (/^gemini 4 argon( models)?$/i.test(trimmed) || /^argon$/i.test(trimmed)) {
    return "Gemini 4 Argon";
  }
  return trimmed;
}

export function formatWindowName(window?: string): string {
  if (!window) return "";
  const trimmed = window.trim();
  if (/^(?:5h|five_hour|five hour)$/i.test(trimmed)) return "5h";
  if (/^(?:weekly|week)$/i.test(trimmed)) return "Weekly";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

export function buildUsageWindowLabel(bucket: QuotaBucketInfo): string {
  let group = formatGroupName(bucket.groupDisplayName);
  let win = bucket.window;
  if (!win && bucket.displayName) {
    if (/five hour|5h|5-hour|five_hour/i.test(bucket.displayName)) {
      win = "5h";
    } else if (/week/i.test(bucket.displayName)) {
      win = "weekly";
    }
  }
  if (!win && bucket.resetTime) {
    const diffHours = (Date.parse(bucket.resetTime) - Date.now()) / 3600_000;
    win = diffHours > 24 ? "weekly" : "5h";
  }
  if (!group) {
    group = formatGroupName(bucket.displayName);
  }
  const windowStr = formatWindowName(win);

  if (group && windowStr) {
    if (group.toLowerCase().endsWith(`· ${windowStr.toLowerCase()}`)) {
      return group;
    }
    return `${group} · ${windowStr}`;
  }
  if (group) return group;
  if (bucket.bucketId) {
    return windowStr ? `${bucket.bucketId} · ${windowStr}` : bucket.bucketId;
  }
  return windowStr || "Subscription";
}

export function calculateBucketUsedPercent(bucket: QuotaBucketInfo): number | null {
  if (bucket.disabled === true) {
    return 100;
  }
  if (typeof bucket.remainingFraction === "number" && Number.isFinite(bucket.remainingFraction)) {
    if (bucket.remainingFraction <= 0) {
      return 100;
    }
    // Upstream Antigravity app rounds remaining percentage UP to the nearest integer: Math.ceil(remainingFraction * 100).
    // Therefore used percentage is: 100 - remainingPercent = Math.floor((1 - remainingFraction) * 100).
    const percent = Math.floor((1 - bucket.remainingFraction) * 100);
    return Math.max(0, Math.min(100, percent));
  }
  return null;
}

function getBucketGroupPriority(bucket: QuotaBucketInfo): number {
  const text = `${bucket.groupDisplayName ?? ""} ${bucket.displayName ?? ""} ${bucket.bucketId ?? ""} ${bucket.modelId ?? ""}`.toLowerCase();
  if (text.includes("gemini") && !text.includes("argon")) {
    return 1;
  }
  if (text.includes("claude") || text.includes("gpt") || text.includes("3p")) {
    return 2;
  }
  if (text.includes("argon")) {
    return 3;
  }
  return 4;
}

function getBucketWindowPriority(bucket: QuotaBucketInfo): number {
  const text = `${bucket.window ?? ""} ${bucket.displayName ?? ""} ${bucket.bucketId ?? ""}`.toLowerCase();
  if (text.includes("week")) {
    return 1;
  }
  if (text.includes("5h") || text.includes("five hour") || text.includes("5-hour")) {
    return 2;
  }
  return 3;
}

export function sortUsageBuckets(buckets: QuotaBucketInfo[]): QuotaBucketInfo[] {
  return [...buckets].sort((a, b) => {
    const pGroupA = getBucketGroupPriority(a);
    const pGroupB = getBucketGroupPriority(b);
    if (pGroupA !== pGroupB) {
      return pGroupA - pGroupB;
    }
    const pWinA = getBucketWindowPriority(a);
    const pWinB = getBucketWindowPriority(b);
    if (pWinA !== pWinB) {
      return pWinA - pWinB;
    }
    const nameA = a.displayName ?? a.bucketId ?? "";
    const nameB = b.displayName ?? b.bucketId ?? "";
    return nameA.localeCompare(nameB);
  });
}

const inFlightRefreshPromises = new Map<string, Promise<AntigravityAuthCredentials>>();

async function deduplicatedRefreshAccessToken(
  refreshToken: string,
  authStore: AuthProfileStore,
  endpoints: AntigravityEndpoints,
  fetchImpl: FetchLike
): Promise<AntigravityAuthCredentials> {
  const existing = inFlightRefreshPromises.get(refreshToken);
  if (existing) {
    return await existing;
  }
  const promise = (async () => {
    try {
      return await refreshAccessToken(authStore, endpoints, fetchImpl);
    } finally {
      inFlightRefreshPromises.delete(refreshToken);
    }
  })();
  inFlightRefreshPromises.set(refreshToken, promise);
  return await promise;
}

export function createAntigravityProvider(
  options: AntigravityProviderOptions = {}
): {
  provider: OpenClawProviderRegistration;
  catalogService: CatalogService;
  defaultAuthStore: AuthProfileStore;
  mediaUnderstandingProvider: AntigravityMediaUnderstandingProvider;
  webSearchProvider: AntigravityWebSearchProvider;
  webFetchProvider: AntigravityWebFetchProvider;
  imageGenerationProvider: AntigravityImageGenerationProvider;
} {
  const endpoints: AntigravityEndpoints = {
    ...DEFAULT_ENDPOINTS,
    ...(options.endpoints ?? {})
  };
  const fetchImpl = options.fetchImpl ?? fetch;
  const defaultAuthStore = options.authStore ?? new InMemoryAuthProfileStore();
  const catalogService = new CatalogService(endpoints, fetchImpl);

  const directLogin = async (ctx: LoginContext): Promise<LoginResult> =>
    await loginWithOAuth(ctx, endpoints, fetchImpl, options.pollIntervalMs);

  const directRefresh = async (
    authStore?: AuthProfileStore
  ): Promise<AntigravityAuthCredentials> =>
    await refreshAccessToken(authStore ?? defaultAuthStore, endpoints, fetchImpl);

  const oauthMethod: OpenClawProviderAuthMethod = {
    id: "oauth",
    label: "Antigravity OAuth",
    hint: "Sign in with your Antigravity subscription",
    kind: "oauth",
    wizard: {
      choiceId: "antigravity-oauth",
      choiceLabel: "Antigravity OAuth",
      choiceHint: "Sign in with your Antigravity subscription (OAuth)",
      groupId: PROVIDER_ID,
      groupLabel: "Antigravity",
      groupHint: "Antigravity subscription provider",
      methodId: "oauth"
    },
    run: async (ctx: OpenClawAuthMethodContext): Promise<OpenClawProviderAuthResult> => {
      const printedMessages: string[] = [];
      const loginResult = await loginWithOAuth(
        {
          method: "oauth",
          isRemote: ctx.isRemote === true,
          ...(ctx.openUrl ? { openUrl: ctx.openUrl } : {}),
          ...(ctx.prompter?.text
            ? {
                promptText: async (message: string) =>
                  await ctx.prompter!.text!({
                    message,
                    validate: (val) =>
                      val.trim().length > 0 ? undefined : "Required"
                  })
              }
            : {}),
          authStore: defaultAuthStore,
          print: (msg: string) => {
            printedMessages.push(msg);
            if (ctx.runtime?.log) {
              ctx.runtime.log(msg);
            } else {
              console.log(msg);
            }
          },
          ...(ctx.signal ? { signal: ctx.signal } : {})
        },
        endpoints,
        fetchImpl,
        options.pollIntervalMs
      );

      const stored = await defaultAuthStore.getSecret(PROVIDER_ID);
      if (!stored) {
        throw new Error("subscription not eligible");
      }

      const discoveredModels = await catalogService
        .listModels(defaultAuthStore, { refresh: true })
        .catch(() => []);

      const profileSuffix =
        loginResult.email ??
        stored.email ??
        loginResult.accountId ??
        stored.accountId ??
        "default";

      return {
        profiles: [
          {
            profileId: `${PROVIDER_ID}:${profileSuffix}`,
            credential: {
              type: "oauth",
              provider: PROVIDER_ID,
              access: stored.accessToken,
              refresh: stored.refreshToken,
              expires: stored.expiresAt,
              ...(stored.email ? { email: stored.email } : {}),
              ...(stored.projectId ? { projectId: stored.projectId } : {}),
              ...(stored.accountId ? { accountId: stored.accountId } : {})
            }
          }
        ],
        configPatch: {
          models: {
            providers: {
              [PROVIDER_ID]: {
                baseUrl: endpoints.chatCompletionsUrl,
                api: "openai-completions",
                auth: "oauth",
                models: discoveredModels.map((m) =>
                  toOpenClawCatalogModelDefinition(m, endpoints.chatCompletionsUrl)
                )
              }
            }
          }
        },
        notes: [
          `Connected Antigravity subscription (${profileSuffix}). Discovered ${discoveredModels.length} chat model(s).`
        ]
      };
    }
  };

  const authSurface: OpenClawProviderAuthSurface = Object.assign([oauthMethod], {
    methods: ["oauth"] as const,
    login: directLogin,
    refresh: directRefresh
  });

  const provider: OpenClawProviderRegistration = {
    id: PROVIDER_ID,
    label: "Antigravity",
    api: "openai-completions",
    baseUrl: endpoints.chatCompletionsUrl,
    auth: authSurface,
    catalog: {
      order: "simple",
      run: async (ctx: OpenClawCatalogRunContext) => {
        const resolvedAuth =
          ctx.resolveProviderAuth?.(PROVIDER_ID) ??
          ctx.resolveProviderApiKey?.(PROVIDER_ID);
        const parsedKey = parseFormattedApiKey(
          resolvedAuth?.discoveryApiKey ?? resolvedAuth?.apiKey
        );

        let rows;
        if (parsedKey) {
          rows = await catalogService.listModelsWithToken(
            parsedKey.token,
            parsedKey.projectId,
            { refresh: true }
          );
        } else {
          const existing = await defaultAuthStore.getSecret(PROVIDER_ID);
          if (!existing) {
            return null;
          }
          rows = await catalogService.listModels(defaultAuthStore, { refresh: true });
        }

        return {
          provider: {
            baseUrl: endpoints.chatCompletionsUrl,
            api: "openai-completions" as const,
            auth: "oauth" as const,
            models: rows.map((row) =>
              toOpenClawCatalogModelDefinition(row, endpoints.chatCompletionsUrl)
            )
          }
        };
      },
      listModels: async (listOpts) =>
        await catalogService.listModels(listOpts?.authStore ?? defaultAuthStore, {
          ...(listOpts?.refresh !== undefined ? { refresh: listOpts.refresh } : {}),
          ...((listOpts as any)?.agentDir ? { agentDir: (listOpts as any).agentDir } : {}),
          ...((listOpts as any)?.cfg ? { cfg: (listOpts as any).cfg } : {}),
          ...((listOpts as any)?.signal ? { signal: (listOpts as any).signal } : {})
        }),
      getUsage: async (usageOpts) =>
        await catalogService.getUsage(usageOpts?.authStore ?? defaultAuthStore, {
          ...((usageOpts as any)?.agentDir ? { agentDir: (usageOpts as any).agentDir } : {}),
          ...((usageOpts as any)?.cfg ? { cfg: (usageOpts as any).cfg } : {}),
          ...((usageOpts as any)?.signal ? { signal: (usageOpts as any).signal } : {})
        })
    },
    refreshOAuth: async (credential: OpenClawOAuthCredential) =>
      await refreshOAuthCredential(credential, endpoints, fetchImpl),
    formatApiKey: (credential) => {
      if (credential && typeof credential === "object" && "access" in credential) {
        const oauthCred = credential as OpenClawOAuthCredential;
        return JSON.stringify({
          token: oauthCred.access,
          ...(oauthCred.projectId ? { projectId: oauthCred.projectId } : {}),
          ...(oauthCred.accountId ? { accountId: oauthCred.accountId } : {}),
          ...(typeof oauthCred.expires === "number" && oauthCred.expires > 0
            ? { expires: oauthCred.expires }
            : {})
        });
      }
      return "";
    },
    classifyFailoverReason: (ctx) => {
      if (!ctx) return null;
      const errMsg = ctx.errorMessage || "";
      const code = ctx.code || "";

      // 1. Rate limit & quota
      if (ctx.status === 429 || /quota|resource_exhausted/i.test(errMsg)) {
        return "rate_limit";
      }

      // 2. Auth: status 401, upstream error code UNAUTHENTICATED, or /unauthenticated/i
      if (ctx.status === 401 || code === "UNAUTHENTICATED" || /unauthenticated/i.test(errMsg)) {
        return "auth";
      }

      // 3. Status 403: only auth if body/message matches invalid_token, ACCESS_TOKEN_EXPIRED, or UNAUTHENTICATED
      if (ctx.status === 403) {
        if (/invalid_token|ACCESS_TOKEN_EXPIRED|UNAUTHENTICATED/i.test(errMsg)) {
          return "auth";
        }
        // Other 403s (including PERMISSION_DENIED) must NOT trigger auth failover
        return null;
      }

      // 4. Invalid or expired token indicators without explicit 403 status
      if (/invalid_token|ACCESS_TOKEN_EXPIRED/i.test(errMsg)) {
        return "auth";
      }

      // 5. Server errors: 5xx
      if (ctx.status && ctx.status >= 500 && ctx.status < 600) {
        return "server_error";
      }

      return null;
    },
    resolveUsageAuth: async (ctx) => await ctx.resolveOAuthToken(),
    fetchUsageSnapshot: async (ctx) => {
      const parsed = parseFormattedApiKey(ctx.token);
      const token = parsed?.token ?? ctx.token;
      let projectId = parsed?.projectId;
      if (!projectId) {
        try {
          const stored = await defaultAuthStore.getSecret(PROVIDER_ID);
          projectId = stored?.projectId;
        } catch {
          // ignore error reading default store
        }
      }
      const usage = await catalogService.getUsageWithToken(token, projectId);

      let windows: Array<{ label: string; usedPercent: number | null; resetAt?: number }>;
      if (Array.isArray(usage.buckets) && usage.buckets.length > 0) {
        const sorted = sortUsageBuckets(usage.buckets);
        windows = sorted.map((bucket) => {
          const label = buildUsageWindowLabel(bucket);
          const usedPercent = calculateBucketUsedPercent(bucket);
          const resetAtMs = bucket.resetTime ? Date.parse(bucket.resetTime) : undefined;
          return {
            label,
            usedPercent,
            ...(resetAtMs && Number.isFinite(resetAtMs) ? { resetAt: resetAtMs } : {})
          };
        });
      } else {
        const resetAtMs = usage.resetAt ? Date.parse(usage.resetAt) : undefined;
        windows = [
          {
            label: usage.quotaWindow || "Subscription",
            usedPercent: usage.usedPercentage,
            ...(resetAtMs && Number.isFinite(resetAtMs) ? { resetAt: resetAtMs } : {})
          }
        ];
      }

      return {
        provider: PROVIDER_ID,
        displayName: "Antigravity",
        windows: windows as any,
        ...(usage.plan ? { plan: usage.plan } : {}),
        rawUsage: usage
      };
    },
    buildReplayPolicy: (ctx?: { modelId?: string }) => {
      const isGemini = ctx?.modelId ? /gemini|argon/i.test(ctx.modelId) : true;
      return {
        repairToolUseResultPairing: true,
        allowSyntheticToolResults: true,
        ...(isGemini
          ? {
              sanitizeThoughtSignatures: {
                allowBase64Only: true,
                includeCamelCase: true
              }
            }
          : {})
      };
    },
    createStreamFn: () => {
      return (model, context, streamOptions) => {
        const stream = new SimpleAssistantEventStream();
        const turnStore = new InMemoryAuthProfileStore();
        const contentBlocks: Array<Record<string, unknown>> = [];
        const partialMessage: Record<string, unknown> = {
          role: "assistant",
          content: contentBlocks,
          api: model.api ?? "openai-completions",
          provider: model.provider ?? PROVIDER_ID,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          },
          stopReason: "stop",
          timestamp: Date.now()
        };

        let textBlockStarted = false;
        let textBlockClosed = false;
        let textBlock: { type: "text"; text: string } | undefined;
        let textContentIndex = 0;
        let thinkingBlockStarted = false;
        let thinkingBlockClosed = false;
        let thinkingBlock: { type: "thinking"; thinking: string } | undefined;
        let thinkingContentIndex = 0;

        const closeThinkingBlock = (): void => {
          if (!thinkingBlockStarted || thinkingBlockClosed || !thinkingBlock) {
            return;
          }
          thinkingBlockClosed = true;
          stream.push({
            type: "thinking_end",
            contentIndex: thinkingContentIndex,
            content: thinkingBlock.thinking,
            partial: partialMessage
          });
        };

        const closeTextBlock = (): void => {
          if (!textBlockStarted || textBlockClosed || !textBlock) {
            return;
          }
          textBlockClosed = true;
          stream.push({
            type: "text_end",
            contentIndex: textContentIndex,
            content: textBlock.text,
            partial: partialMessage
          });
        };

        const runAsync = async (): Promise<void> => {
          const parsedKey = parseFormattedApiKey(streamOptions?.apiKey);
          if (parsedKey) {
            const expiresAt =
              typeof parsedKey.expires === "number" && parsedKey.expires > 0
                ? parsedKey.expires
                : Date.now() + 3600_000;
            await turnStore.setSecret(PROVIDER_ID, {
              accessToken: parsedKey.token,
              refreshToken: "",
              expiresAt,
              projectId: parsedKey.projectId,
              ...(parsedKey.accountId ? { accountId: parsedKey.accountId } : {})
            });
          } else {
            const fallbackSecret = await defaultAuthStore.getSecret(PROVIDER_ID);
            if (fallbackSecret) {
              await turnStore.setSecret(PROVIDER_ID, {
                ...fallbackSecret,
                projectId: fallbackSecret.projectId ?? DEFAULT_PROJECT_ID
              });
            }
          }

          if (catalogService.getCachedModels() === null) {
            await catalogService.listModels(turnStore, { refresh: true });
          }

          stream.push({ type: "start", partial: partialMessage });

          const tools = convertOpenClawTools(context.tools);
          const reasoningEffort = extractReasoningEffort(streamOptions);
          const structuredOutput = extractHostResponseFormat(streamOptions);
          const signal =
            streamOptions?.signal instanceof AbortSignal ? streamOptions.signal : undefined;

          const turnRequest: TurnRequest = {
            model: model.id,
            ...(typeof context.systemPrompt === "string" && context.systemPrompt.length > 0
              ? { systemPrompt: context.systemPrompt }
              : {}),
            messages: convertOpenClawMessages(context.messages),
            ...(tools ? { tools } : {}),
            ...(reasoningEffort ? { reasoningEffort } : {}),
            ...(structuredOutput ?? {}),
            ...(signal ? { signal } : {}),
            onTextDelta: (delta: string) => {
              closeThinkingBlock();
              if (!textBlockStarted || textBlockClosed) {
                textBlockStarted = true;
                textBlockClosed = false;
                textBlock = { type: "text", text: "" };
                textContentIndex = contentBlocks.length;
                contentBlocks.push(textBlock);
                stream.push({
                  type: "text_start",
                  contentIndex: textContentIndex,
                  partial: partialMessage
                });
              }
              textBlock!.text += delta;
              stream.push({
                type: "text_delta",
                contentIndex: textContentIndex,
                delta,
                partial: partialMessage
              });
            },
            onReasoningDelta: (delta: string) => {
              closeTextBlock();
              if (!thinkingBlockStarted || thinkingBlockClosed) {
                thinkingBlockStarted = true;
                thinkingBlockClosed = false;
                thinkingBlock = { type: "thinking", thinking: "" };
                thinkingContentIndex = contentBlocks.length;
                contentBlocks.push(thinkingBlock);
                stream.push({
                  type: "thinking_start",
                  contentIndex: thinkingContentIndex,
                  partial: partialMessage
                });
              }
              thinkingBlock!.thinking += delta;
              stream.push({
                type: "thinking_delta",
                contentIndex: thinkingContentIndex,
                delta,
                partial: partialMessage
              });
            }
          };

          let turnRes: TurnResponse;
          try {
            turnRes = await executeTurn(
              turnRequest,
              turnStore,
              catalogService,
              endpoints,
              fetchImpl
            );
          } catch (err: any) {
            const isAuthError =
              err?.status === 401 ||
              err?.code === "UNAUTHENTICATED" ||
              /authentication error \(401\)|unauthenticated/i.test(err?.message || "");
            if (isAuthError && !parsedKey) {
              const currentSecret = await defaultAuthStore.getSecret(PROVIDER_ID);
              if (
                currentSecret?.refreshToken &&
                currentSecret.refreshToken !== "managed-by-openclaw"
              ) {
                const refreshed = await deduplicatedRefreshAccessToken(
                  currentSecret.refreshToken,
                  defaultAuthStore,
                  endpoints,
                  fetchImpl
                );
                await turnStore.setSecret(PROVIDER_ID, refreshed);
                turnRes = await executeTurn(
                  turnRequest,
                  turnStore,
                  catalogService,
                  endpoints,
                  fetchImpl
                );
              } else {
                throw err;
              }
            } else {
              throw err;
            }
          }

          closeThinkingBlock();
          closeTextBlock();

          for (const tc of turnRes.toolCalls) {
            const idx = contentBlocks.length;
            const tcBlock = {
              type: "toolCall",
              id: tc.id,
              name: tc.name,
              arguments:
                typeof tc.arguments === "string" ? { raw: tc.arguments } : tc.arguments,
              ...(tc.thoughtSignature
                ? {
                    thoughtSignature: tc.thoughtSignature,
                    thought_signature: tc.thoughtSignature
                  }
                : {}),
              ...(tc.thoughtSignatureModel
                ? {
                    thoughtSignatureModel: tc.thoughtSignatureModel,
                    thought_signature_model: tc.thoughtSignatureModel
                  }
                : {})
            };
            contentBlocks.push(tcBlock);
            stream.push({
              type: "toolcall_start",
              contentIndex: idx,
              partial: partialMessage
            });
            stream.push({
              type: "toolcall_end",
              contentIndex: idx,
              toolCall: tcBlock,
              partial: partialMessage
            });
          }

          if (turnRes.usage) {
            const total =
              turnRes.usage.inputTokens +
              turnRes.usage.outputTokens +
              turnRes.usage.thinkingTokens +
              turnRes.usage.cacheReadTokens;
            partialMessage.usage = {
              input: turnRes.usage.inputTokens,
              output: turnRes.usage.outputTokens,
              cacheRead: turnRes.usage.cacheReadTokens,
              cacheWrite: 0,
              totalTokens: total,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
            };
          }

          const stopReason = turnRes.toolCalls.length > 0 ? "toolUse" : "stop";
          partialMessage.stopReason = stopReason;

          stream.push({
            type: "done",
            reason: stopReason,
            message: partialMessage
          });
          stream.end(partialMessage);
        };

        void runAsync().catch(async (err: unknown) => {
          closeThinkingBlock();
          closeTextBlock();

          const errMsg = err instanceof Error ? err.message : String(err);

          const isTransient =
            err &&
            typeof err === "object" &&
            "isTransientRateLimit" in err &&
            (err as { isTransientRateLimit?: boolean }).isTransientRateLimit === true;

          const isQuota =
            !isTransient &&
            ((err && typeof err === "object" && "status" in err && (err as { status?: number }).status === 429) ||
              /quota|429|RESOURCE_EXHAUSTED|exhausted/i.test(errMsg));

          let userNotice = "";

          if (isQuota) {
            let resetAt = "";
            let quotaWindow = "";

            if (
              err &&
              typeof err === "object" &&
              typeof (err as { resetAt?: string }).resetAt === "string" &&
              (err as { resetAt: string }).resetAt.length > 0
            ) {
              resetAt = (err as { resetAt: string }).resetAt;
            }

            // 1. Direct extraction from errorBody details/metadata (HTTP 429 response)
            if (
              err &&
              typeof err === "object" &&
              "errorBody" in err &&
              typeof (err as { errorBody?: unknown }).errorBody === "string"
            ) {
              try {
                const parsedBody = JSON.parse((err as { errorBody: string }).errorBody);
                const details = parsedBody?.error?.details;
                if (Array.isArray(details)) {
                  for (const d of details) {
                    if (d?.metadata?.quotaResetTimeStamp) {
                      resetAt = String(d.metadata.quotaResetTimeStamp);
                    }
                    if (!resetAt && d?.metadata?.quotaResetDelay) {
                      let ms = 0;
                      const delayStr = String(d.metadata.quotaResetDelay);
                      const h = delayStr.match(/(\d+)h/);
                      const m = delayStr.match(/(\d+)m/);
                      const s = delayStr.match(/(\d+)s/);
                      if (h && h[1]) ms += parseInt(h[1], 10) * 3600_000;
                      if (m && m[1]) ms += parseInt(m[1], 10) * 60_000;
                      if (s && s[1]) ms += parseInt(s[1], 10) * 1000;
                      if (ms > 0) resetAt = new Date(Date.now() + ms).toISOString();
                    }
                    if (!resetAt && d?.retryDelay) {
                      const sec = parseFloat(String(d.retryDelay));
                      if (Number.isFinite(sec) && sec > 0) {
                        resetAt = new Date(Date.now() + sec * 1000).toISOString();
                      }
                    }
                  }
                }
                if (!resetAt && typeof parsedBody?.error?.message === "string") {
                  const m = parsedBody.error.message.match(/Resets in\s+([0-9hms.]+)/i);
                  if (m) {
                    let ms = 0;
                    const h = m[1]?.match(/(\d+)h/);
                    const min = m[1]?.match(/(\d+)m/);
                    const s = m[1]?.match(/(\d+)s/);
                    if (h && h[1]) ms += parseInt(h[1], 10) * 3600_000;
                    if (min && min[1]) ms += parseInt(min[1], 10) * 60_000;
                    if (s && s[1]) ms += parseInt(s[1], 10) * 1000;
                    if (ms > 0) resetAt = new Date(Date.now() + ms).toISOString();
                  }
                }
              } catch {
                // Ignore JSON parse errors
              }
            }

            // 2. Retry-After header fallback
            if (!resetAt && err && typeof err === "object" && "retryAfter" in err) {
              const retrySec = Number((err as { retryAfter?: string }).retryAfter);
              if (Number.isFinite(retrySec) && retrySec > 0) {
                resetAt = new Date(Date.now() + retrySec * 1000).toISOString();
              }
            }

            // 3. Fallback to usage endpoint check
            if (!resetAt) {
              try {
                const storedSecret = await turnStore.getSecret(PROVIDER_ID);
                const token = storedSecret?.accessToken;
                if (token) {
                  const usage = await catalogService.getUsageWithToken(
                    token,
                    storedSecret.projectId
                  );
                  resetAt = usage.resetAt;
                  quotaWindow = usage.quotaWindow;
                  if (Array.isArray(usage.buckets) && usage.buckets.length > 0) {
                    const modelIdLower = model.id.toLowerCase();
                    const modelBucket =
                      usage.buckets.find((b) => {
                        const bId = (b.bucketId ?? b.modelId ?? "").toLowerCase();
                        const gName = (b.groupDisplayName ?? "").toLowerCase();
                        const dName = (b.displayName ?? "").toLowerCase();
                        return (
                          bId.includes(modelIdLower) ||
                          modelIdLower.includes(bId) ||
                          (modelIdLower.includes("argon") &&
                            (bId.includes("argon") || gName.includes("argon") || dName.includes("argon")))
                        );
                      }) ??
                      usage.buckets.find(
                        (b) => typeof b.resetTime === "string" && b.resetTime.length > 0
                      );
                    if (modelBucket?.resetTime) {
                      resetAt = modelBucket.resetTime;
                    }
                    if (modelBucket?.window) {
                      quotaWindow = modelBucket.window;
                    }
                  }
                }
              } catch {
                // Best-effort quota fetch; ignore network/auth errors here
              }
            }

            const modelName =
              "name" in model && typeof (model as { name?: unknown }).name === "string"
                ? (model as { name: string }).name
                : model.id;
            const resetInfo = formatResetTime(resetAt);

            const isClaude = /opus|sonnet|claude/i.test(model.id);
            const altModelSuggestion = isClaude
              ? "**Gemini 3.8 Flash** or **Gemini 4 Argon**"
              : "**Claude Opus 5.5** or **Claude Sonnet 5.5**";

            if (resetInfo) {
              userNotice = `⚠️ **Antigravity subscription quota exhausted for ${modelName}.**\n\n- ⏳ **Resets at:** ${resetInfo.formatted} (${resetInfo.relative})${quotaWindow ? `\n- 🔄 **Quota window:** ${quotaWindow}` : ""}\n\nPlease try again after the reset or switch to another model (such as ${altModelSuggestion}).`;
            } else {
              userNotice = `⚠️ **Antigravity subscription quota exhausted for ${modelName}.**\n\nPlease try again later or switch to another model (such as ${altModelSuggestion}).`;
            }
          }

          if (userNotice) {
            textBlockStarted = true;
            textBlockClosed = false;
            textBlock = { type: "text", text: userNotice };
            textContentIndex = contentBlocks.length;
            contentBlocks.push(textBlock);
            stream.push({
              type: "text_start",
              contentIndex: textContentIndex,
              partial: partialMessage
            });
            stream.push({
              type: "text_delta",
              contentIndex: textContentIndex,
              delta: userNotice,
              partial: partialMessage
            });
            stream.push({
              type: "text_end",
              contentIndex: textContentIndex,
              content: textBlock.text,
              partial: partialMessage
            });
            textBlockClosed = true;
          }

          const errorMessage: Record<string, unknown> = {
            role: "assistant",
            content: contentBlocks,
            api: model.api ?? "openai-completions",
            provider: model.provider ?? PROVIDER_ID,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
            },
            stopReason: "error",
            errorMessage: errMsg,
            timestamp: Date.now()
          };
          stream.push({
            type: "error",
            reason: "error",
            error: errorMessage
          });
          stream.end(errorMessage);
        });

        return stream;
      };
    },
    wrapSimpleCompletionStreamFn: (ctx) => {
      return provider.createStreamFn?.(ctx as any);
    },
    resolveThinkingProfile: (ctx: ResolveThinkingProfileContext) => {
      const bareModelId = canonicalModelId(ctx.modelId);
      const cached = catalogService.getCachedModels();
      const row = cached?.find((model) => model.id === bareModelId);
      if (row) {
        return thinkingProfileFromLevels(row.reasoningLevels);
      }
      const declared = ctx.compat?.supportedReasoningEfforts;
      if (declared && declared.length > 0) {
        const levels = declared.filter(
          (lvl): lvl is ReasoningLevel =>
            lvl === "off" ||
            lvl === "low" ||
            lvl === "medium" ||
            lvl === "high" ||
            lvl === "xhigh" ||
            lvl === "max"
        );
        const profile = thinkingProfileFromLevels(levels);
        if (profile) {
          return profile;
        }
      }
      if (!bareModelId) {
        return undefined;
      }
      if (EXTENDED_THINKING_LEVEL_MODELS.has(bareModelId)) {
        return thinkingProfileFromLevels(["low", "medium", "high", "xhigh", "max"]);
      }
      return thinkingProfileFromLevels(["low", "medium", "high"]);
    },
    completeTurn: async (request, turnOpts) =>
      await executeTurn(
        request,
        turnOpts?.authStore ?? defaultAuthStore,
        catalogService,
        endpoints,
        fetchImpl
      )
  };

  const mediaUnderstandingProvider = buildAntigravityMediaUnderstandingProvider({
    endpoints,
    fetchFn: fetchImpl
  });

  const webSearchProvider = buildAntigravityWebSearchProvider({
    endpoints,
    fetchFn: fetchImpl,
    defaultAuthStore,
    modelAuth: options.modelAuth
  });

  const webFetchProvider = buildAntigravityWebFetchProvider({
    endpoints,
    fetchFn: fetchImpl,
    defaultAuthStore,
    modelAuth: options.modelAuth
  });

  const imageGenerationProvider = buildAntigravityImageGenerationProvider({
    endpoints,
    fetchFn: fetchImpl,
    defaultAuthStore,
    modelAuth: options.modelAuth
  });

  return {
    provider,
    catalogService,
    defaultAuthStore,
    mediaUnderstandingProvider,
    webSearchProvider,
    webFetchProvider,
    imageGenerationProvider
  };
}

function readPluginModelAuth(api: OpenClawPluginApi) {
  try {
    return api.runtime?.modelAuth;
  } catch {
    // Host 2026.10.10: createUnavailableRuntime is a throwing proxy in
    // "cli-metadata" and "setup-only" registration. Gateway startup uses
    // registrationMode "full" and a real runtime (see loadAndActivateRootPluginRegistry).
    return undefined;
  }
}

function registerAntigravityPlugin(api: OpenClawPluginApi): void {
  const {
    provider,
    mediaUnderstandingProvider,
    webSearchProvider,
    webFetchProvider,
    imageGenerationProvider
  } = createAntigravityProvider({
    modelAuth: readPluginModelAuth(api)
  });
  api.registerProvider(provider);
  if (typeof api.registerMediaUnderstandingProvider === "function") {
    api.registerMediaUnderstandingProvider(mediaUnderstandingProvider);
  }
  if (typeof api.registerWebSearchProvider === "function") {
    api.registerWebSearchProvider(webSearchProvider);
  }
  if (typeof api.registerWebFetchProvider === "function") {
    api.registerWebFetchProvider(webFetchProvider);
  }
  if (typeof api.registerImageGenerationProvider === "function") {
    api.registerImageGenerationProvider(imageGenerationProvider);
  }
}

export const antigravityPlugin: OpenClawPluginDefinition = definePluginEntry({
  id: PLUGIN_ID,
  name: "Antigravity OAuth",
  description: "Unofficial provider for your own Antigravity subscription, signed in with OAuth. Not affiliated with or endorsed by Google.",
  // Host 2026.10.x calls register() only. activate aliases the same function so a
  // second call cannot build a second provider object (Contract §1).
  register: registerAntigravityPlugin,
  activate: registerAntigravityPlugin
});

export default antigravityPlugin;
