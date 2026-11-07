/**
 * OpenClaw Provider Plugin Contract & Antigravity Types
 * Target: OpenClaw >=2026.10.8
 */

export type ReasoningLevel = "off" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AntigravityAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string;
  email?: string;
  projectId?: string;
}

export interface AuthProfileSecretRef {
  readonly profileId: string;
  readonly provider: "antigravity";
  readonly method: "oauth";
}

export interface AuthProfileStore {
  hasSecret?(provider: string): boolean;
  getSecret(provider: string): Promise<AntigravityAuthCredentials | null>;
  setSecret(provider: string, credentials: AntigravityAuthCredentials): Promise<AuthProfileSecretRef>;
  deleteSecret(provider: string): Promise<void>;
}

export interface LoginContext {
  method: string;
  localLoopback?: boolean;
  loopbackCode?: string;
  loopbackCodeVerifier?: string;
  loopbackRedirectUri?: string;
  isRemote?: boolean;
  openUrl?: (url: string) => Promise<void>;
  promptText?: (message: string) => Promise<string>;
  authStore: AuthProfileStore;
  print: (message: string) => void;
  signal?: AbortSignal;
}

export interface LoginResult {
  profile: AuthProfileSecretRef;
  accountId?: string;
  email?: string;
  projectId?: string;
}

export interface SubscriptionModelRow {
  id: string;
  ref: `antigravity/${string}`;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  canDisableReasoning: boolean;
  reasoningLevels: readonly ReasoningLevel[];
  supportsImages?: boolean;
  supportsVideo?: boolean;
  supportsPdf?: boolean;
  supportedMimeTypes?: readonly string[];
}

export interface QuotaBucketInfo {
  bucketId?: string;
  modelId?: string;
  displayName?: string;
  groupDisplayName?: string;
  description?: string;
  window?: string;
  remainingFraction?: number;
  remainingAmount?: number;
  disabled?: boolean;
  resetTime?: string;
}

export interface SubscriptionUsageReport {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  quotaWindow: string;
  resetAt: string;
  /**
   * Percentage of quota used, or null if omitted by the subscription API.
   * Per contract §3: "If the API omits a percentage, report the omission. Do not invent one."
   */
  usedPercentage: number | null;
  percentageOmitted: boolean;
  plan?: string;
  buckets?: QuotaBucketInfo[];
  rawSummary?: unknown;
  rawUserQuota?: unknown;
  rawModels?: unknown;
  rawSources?: Record<string, unknown>;
}

export interface HostToolDefinition {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface HostToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown> | string;
  thoughtSignature?: string;
  /** Catalog model id that produced thoughtSignature; used to avoid cross-model replay. */
  thoughtSignatureModel?: string;
}

export interface TurnContentPartText {
  type: "text";
  text: string;
}

export interface TurnContentPartImageUrl {
  type: "image_url";
  image_url: {
    url: string;
    detail?: string;
  };
}

export interface TurnContentPartImage {
  type: "image";
  data?: string;
  mimeType?: string;
  mime?: string;
  source?: {
    type?: string;
    media_type?: string;
    data?: string;
  };
}

export interface TurnContentPartInputAudio {
  type: "input_audio";
  input_audio?: {
    data?: string;
    format?: string;
  };
}

export interface TurnContentPartInlineData {
  inlineData?: {
    mimeType: string;
    data: string;
  };
  inline_data?: {
    mime_type: string;
    data: string;
  };
}

export type TurnContentPart =
  | string
  | TurnContentPartText
  | TurnContentPartImageUrl
  | TurnContentPartImage
  | TurnContentPartInputAudio
  | TurnContentPartInlineData
  | Record<string, unknown>;

export interface ConversationMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | TurnContentPart[];
  name?: string;
  toolCallId?: string;
  toolCalls?: HostToolCall[];
}

export interface TurnUsageCounts {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
}

export interface TurnRequest {
  model: string;
  systemPrompt?: string;
  messages: readonly ConversationMessage[];
  tools?: readonly HostToolDefinition[];
  reasoningEffort?: ReasoningLevel;
  /** Host `StreamOptions.responseFormat` mapped for Gemini structured output. */
  responseMimeType?: string;
  responseSchema?: Record<string, unknown>;
  onTextDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface TurnResponse {
  text: string;
  toolCalls: HostToolCall[];
  usage?: TurnUsageCounts;
}

export interface AntigravityEndpoints {
  deviceCodeUrl: string;
  authUrl?: string;
  tokenUrl: string;
  userInfoUrl?: string;
  verifySubscriptionUrl: string;
  modelsUrl: string;
  usageUrl: string;
  userQuotaUrl?: string;
  chatCompletionsUrl: string;
  clientId: string;
  clientSecret?: string;
  loopbackRedirectUri?: string;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface AntigravityProviderOptions {
  endpoints?: Partial<AntigravityEndpoints>;
  fetchImpl?: FetchLike;
  authStore?: AuthProfileStore;
  pollIntervalMs?: number;
  modelAuth?: ModelAuthRuntime | undefined;
}

export interface OpenClawOAuthCredential {
  type: "oauth";
  provider: "antigravity";
  access: string;
  refresh: string;
  expires: number;
  profileId?: string;
  email?: string;
  projectId?: string;
  accountId?: string;
}

export interface OpenClawAuthMethodContext {
  config?: Record<string, unknown>;
  agentDir?: string;
  workspaceDir?: string;
  env?: Record<string, string | undefined>;
  isRemote?: boolean;
  openUrl?: (url: string) => Promise<void>;
  prompter?: {
    progress?: (label: string) => { update: (msg: string) => void; stop: (msg?: string) => void };
    note?: (message: string, title?: string) => Promise<void>;
    deviceCode?: (params: { url: string; code: string; message?: string }) => Promise<void>;
    text?: (params: {
      message: string;
      placeholder?: string;
      validate?: (value: string) => string | undefined;
    }) => Promise<string>;
  };
  runtime?: {
    log?: (message: string) => void;
    error?: (message: string) => void;
  };
  signal?: AbortSignal;
  assertCurrent?: () => void;
}

export interface OpenClawProviderAuthResult {
  profiles: Array<{
    profileId: string;
    credential: OpenClawOAuthCredential;
  }>;
  configPatch?: Record<string, unknown>;
  notes?: string[];
}

export interface OpenClawProviderAuthMethod {
  id: "oauth";
  label: string;
  hint: string;
  kind: "oauth";
  wizard?: {
    choiceId: string;
    choiceLabel: string;
    choiceHint: string;
    groupId: string;
    groupLabel: string;
    groupHint?: string;
    methodId: "oauth";
  };
  run: (ctx: OpenClawAuthMethodContext) => Promise<OpenClawProviderAuthResult>;
}

export type OpenClawProviderAuthSurface = ReadonlyArray<OpenClawProviderAuthMethod> & {
  readonly methods: readonly ["oauth"];
  readonly login: (ctx: LoginContext) => Promise<LoginResult>;
  readonly refresh: (authStore?: AuthProfileStore) => Promise<AntigravityAuthCredentials>;
};

export interface OpenClawCatalogRunContext {
  config?: Record<string, unknown>;
  agentDir?: string;
  env?: Record<string, string | undefined>;
  resolveProviderAuth?: (providerId: string) => {
    apiKey?: string;
    discoveryApiKey?: string;
    mode?: string;
    source?: string;
  };
  resolveProviderApiKey?: (providerId: string) => {
    apiKey?: string;
    discoveryApiKey?: string;
  };
}

/** Config-schema model entry emitted by OAuth and catalog.run, not authored ModelCatalogModel metadata. */
export interface OpenClawCatalogModelDefinition {
  id: string;
  name: string;
  api: "openai-completions";
  baseUrl: string;
  reasoning: boolean;
  input: readonly ("text" | "image")[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: {
    supportsReasoningEffort: boolean;
    supportedReasoningEfforts: readonly ReasoningLevel[];
  };
}

export type FailoverReason =
  | "auth"
  | "auth_permanent"
  | "format"
  | "rate_limit"
  | "overloaded"
  | "billing"
  | "server_error"
  | "timeout"
  | "tls_certificate"
  | "context_overflow"
  | "model_not_found"
  | "session_expired"
  | "empty_response"
  | "no_error_details"
  | "unclassified"
  | "unknown";

export interface ProviderFailoverErrorContext {
  provider?: string;
  modelId?: string;
  errorMessage: string;
  status?: number;
  code?: string;
  errorType?: string;
}

export interface OpenClawProviderRegistration {
  id: "antigravity";
  label: string;
  api: "openai-completions";
  baseUrl: string;
  auth: OpenClawProviderAuthSurface;
  classifyFailoverReason?: (ctx: ProviderFailoverErrorContext) => FailoverReason | null | undefined;
  catalog: {
    order: "simple";
    run: (ctx: OpenClawCatalogRunContext) => Promise<{
      provider: {
        baseUrl: string;
        api: "openai-completions";
        auth: "oauth";
        models: OpenClawCatalogModelDefinition[];
      };
    } | null>;
    listModels: (options?: { refresh?: boolean; authStore?: AuthProfileStore }) => Promise<SubscriptionModelRow[]>;
    getUsage: (options?: { authStore?: AuthProfileStore }) => Promise<SubscriptionUsageReport>;
  };
  refreshOAuth: (credential: OpenClawOAuthCredential) => Promise<OpenClawOAuthCredential>;
  formatApiKey: (credential: OpenClawOAuthCredential | Record<string, unknown>) => string;
  resolveUsageAuth: (ctx: {
    resolveOAuthToken: () => Promise<{ token: string; accountId?: string } | null>;
  }) => Promise<{ token: string; accountId?: string } | null>;
  fetchUsageSnapshot: (ctx: {
    token: string;
    accountId?: string;
    timeoutMs?: number;
    fetchFn?: FetchLike;
  }) => Promise<{
    provider: "antigravity";
    displayName: string;
    windows: Array<{
      label: string;
      usedPercent: number | null;
      resetAt?: number;
    }>;
    rawUsage?: SubscriptionUsageReport;
  }>;
  createStreamFn: (ctx: {
    model: { id: string; api?: string; provider?: string; baseUrl?: string };
    authProfileId?: string;
  }) => (
    model: { id: string; api?: string; provider?: string; baseUrl?: string },
    context: {
      systemPrompt?: string;
      messages?: ReadonlyArray<Record<string, unknown>>;
      tools?: ReadonlyArray<Record<string, unknown>>;
    },
    options?: Record<string, unknown>
  ) => unknown;
  buildReplayPolicy?: (ctx?: {
    modelId?: string;
    model?: unknown;
    inHistorySystemUpdates?: unknown;
  }) => Record<string, unknown>;
  wrapSimpleCompletionStreamFn?: (ctx: Record<string, unknown>) => unknown;
  resolveThinkingProfile?: (ctx: ResolveThinkingProfileContext) => ProviderThinkingProfile | undefined;
  completeTurn: (request: TurnRequest, options?: { authStore?: AuthProfileStore }) => Promise<TurnResponse>;
}

export interface ResolveThinkingProfileContext {
  provider?: string;
  modelId?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  compat?: {
    supportsReasoningEffort?: boolean;
    supportedReasoningEfforts?: readonly string[] | null;
  } | null;
}

export interface ProviderThinkingProfileLevel {
  id: ReasoningLevel;
  label?: string;
}

export interface ProviderThinkingProfile {
  levels: readonly ProviderThinkingProfileLevel[];
  defaultLevel: ReasoningLevel;
}

export interface MediaUnderstandingImageInput {
  buffer: Buffer;
  fileName?: string | undefined;
  mime?: string | undefined;
}

export interface MediaUnderstandingImageRequest extends MediaUnderstandingImageInput {
  model?: string | undefined;
  provider?: string | undefined;
  prompt?: string | undefined;
  maxTokens?: number | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  profile?: string | undefined;
  preferredProfile?: string | undefined;
  authStore?: AuthProfileStore | undefined;
  apiKey?: string | undefined;
  auth?: { kind?: string | undefined; apiKey?: string | undefined } | undefined;
}

export interface MediaUnderstandingImagesRequest {
  images: MediaUnderstandingImageInput[];
  model?: string | undefined;
  provider?: string | undefined;
  prompt?: string | undefined;
  maxTokens?: number | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  profile?: string | undefined;
  preferredProfile?: string | undefined;
  authStore?: AuthProfileStore | undefined;
  apiKey?: string | undefined;
  auth?: { kind?: string | undefined; apiKey?: string | undefined } | undefined;
}

export interface MediaUnderstandingAudioRequest extends MediaUnderstandingImageInput {
  model?: string | undefined;
  prompt?: string | undefined;
  language?: string | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  profile?: string | undefined;
  preferredProfile?: string | undefined;
  authStore?: AuthProfileStore | undefined;
  apiKey?: string | undefined;
  auth?: { kind?: string | undefined; apiKey?: string | undefined } | undefined;
}

export interface MediaUnderstandingVideoRequest extends MediaUnderstandingImageInput {
  model?: string | undefined;
  prompt?: string | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  profile?: string | undefined;
  preferredProfile?: string | undefined;
  authStore?: AuthProfileStore | undefined;
  apiKey?: string | undefined;
  auth?: { kind?: string | undefined; apiKey?: string | undefined } | undefined;
}

export interface MediaUnderstandingTextResult {
  text: string;
  model: string;
}

export interface AntigravityMediaUnderstandingProvider {
  id: "antigravity";
  capabilities: readonly ["image", "audio", "video"];
  defaultModels: {
    image: string;
    audio: string;
    video: string;
  };
  autoPriority: {
    image: number;
    audio: number;
    video: number;
  };
  nativeDocumentInputs: readonly ["pdf"];
  describeImage: (req: MediaUnderstandingImageRequest) => Promise<MediaUnderstandingTextResult>;
  describeImages: (req: MediaUnderstandingImagesRequest) => Promise<MediaUnderstandingTextResult>;
  transcribeAudio: (req: MediaUnderstandingAudioRequest) => Promise<MediaUnderstandingTextResult>;
  describeVideo: (req: MediaUnderstandingVideoRequest) => Promise<MediaUnderstandingTextResult>;
}

export interface WebSearchResultCitation {
  url: string;
  title?: string | undefined;
}

export interface WebSearchResultPayload {
  query: string;
  provider: "antigravity-search";
  model: string;
  tookMs: number;
  externalContent: {
    untrusted: boolean;
    source: "web_search";
    provider: "antigravity-search";
    wrapped: boolean;
  };
  content: string;
  text?: string;
  citations: WebSearchResultCitation[];
}

export interface BuildWebSearchProviderOptions {
  endpoints?: Partial<AntigravityEndpoints> | undefined;
  fetchFn?: FetchLike | undefined;
  defaultAuthStore?: AuthProfileStore | undefined;
  modelAuth?: ModelAuthRuntime | undefined;
}

export interface AntigravityWebSearchProvider {
  id: "antigravity-search";
  providerId?: "antigravity";
  label: string;
  hint: string;
  authProviderId: "antigravity";
  requiresCredential: true;
  autoDetectOrder?: number;
  envVars: string[];
  placeholder: string;
  signupUrl: string;
  docsUrl: string;
  credentialPath: string;
  inactiveSecretPaths?: string[];
  credentialNote?: string;
  parameters?: Record<string, unknown>;
  getCredentialValue: (config?: Record<string, unknown>) => unknown;
  setCredentialValue: (configTarget: Record<string, unknown>, value: unknown) => void;
  getConfiguredCredentialValue?: (config?: Record<string, unknown>) => unknown;
  setConfiguredCredentialValue?: (configTarget: Record<string, unknown>, value: unknown) => void;
  isConfigured?: (ctx?: { cfg?: unknown; agentDir?: string }) => boolean;
  search?: (req: {
    query: string;
    count?: number;
    freshness?: string;
    date_after?: string;
    date_before?: string;
    apiKey?: string;
    auth?: { apiKey?: string };
    authStore?: AuthProfileStore;
    signal?: AbortSignal;
  }) => Promise<WebSearchResultPayload>;
  createTool: (ctx: {
    config?: unknown;
    searchConfig?: Record<string, unknown>;
    runtimeMetadata?: unknown;
    agentDir?: string;
    authStore?: AuthProfileStore;
  }) => {
    description: string;
    parameters: Record<string, unknown>;
    execute: (
      args: Record<string, unknown>,
      executionContext?: { signal?: AbortSignal; assertCurrent?: () => void }
    ) => Promise<WebSearchResultPayload | Record<string, unknown>>;
  };
}

export interface GeneratedImageAsset {
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
  revisedPrompt?: string;
  metadata?: Record<string, unknown>;
}

export interface ImageGenerationSourceImage {
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
}

export interface ImageGenerationRequest {
  provider?: string;
  model?: string;
  prompt: string;
  apiKey?: string;
  cfg?: Record<string, unknown>;
  agentDir?: string;
  authStore?: AuthProfileStore;
  timeoutMs?: number;
  count?: number;
  size?: string;
  aspectRatio?: string;
  resolution?: string;
  quality?: string;
  outputFormat?: string;
  background?: string;
  inputImages?: ImageGenerationSourceImage[];
  signal?: AbortSignal;
}

export interface ImageGenerationResult {
  images: GeneratedImageAsset[];
  model?: string;
  metadata?: Record<string, unknown>;
}

export interface AntigravityImageGenerationProvider {
  id: string;
  label: string;
  defaultModel: string;
  models: string[];
  defaultTimeoutMs?: number;
  capabilities: {
    generate: {
      maxCount?: number;
      supportsSize?: boolean;
      supportsAspectRatio?: boolean;
      supportsResolution?: boolean;
    };
    edit: {
      enabled: boolean;
      maxCount?: number;
      maxInputImages?: number;
      supportsSize?: boolean;
      supportsAspectRatio?: boolean;
      supportsResolution?: boolean;
    };
    geometry?: {
      sizes?: string[];
      aspectRatios?: string[];
      resolutions?: string[];
    };
    output?: {
      formats: string[];
    };
  };
  isConfigured?: (ctx: { cfg?: unknown; agentDir?: string }) => boolean;
  isConfiguredAsync?: (ctx: { cfg?: unknown; agentDir?: string }) => Promise<boolean>;
  generateImage: (req: ImageGenerationRequest) => Promise<ImageGenerationResult>;
}

export interface ModelAuthRuntime {
  isProviderApiKeyConfiguredAsync?: (params: {
    provider: string;
    cfg?: unknown;
    agentDir?: string | undefined;
    store?: unknown;
    readOnly?: boolean | undefined;
    allowKeychainPrompt?: boolean | undefined;
  }) => Promise<boolean>;
  ensureAuthProfileStoreAsync?: (
    agentDir?: string | undefined,
    options?: { readOnly?: boolean | undefined; allowKeychainPrompt?: boolean | undefined }
  ) => Promise<unknown>;
  isProviderApiKeyConfigured?: (params: {
    provider: string;
    cfg?: unknown;
    store?: unknown;
    agentDir?: string | undefined;
    readOnly?: boolean | undefined;
    allowKeychainPrompt?: boolean | undefined;
  }) => boolean;
  ensureAuthProfileStore?: (
    agentDir?: string | undefined,
    options?: { readOnly?: boolean | undefined; allowKeychainPrompt?: boolean | undefined }
  ) => unknown;
  listProfilesForProvider?: (store: unknown, providerId: string) => unknown[];
  resolveProviderIdForAuth?: (providerId: string) => string;
  resolveAuthProfileOrder?: (params: unknown) => unknown;
}

export interface WebFetchResultPayload {
  url: string;
  finalUrl: string;
  contentType?: string;
  title?: string;
  extractMode: "markdown" | "text";
  extractor: string;
  truncated: boolean;
  length: number;
  rawLength: number;
  fetchedAt: string;
  tookMs: number;
  text: string;
  warning?: string;
}

export interface BuildWebFetchProviderOptions {
  endpoints?: Partial<AntigravityEndpoints> | undefined;
  fetchFn?: FetchLike | undefined;
  defaultAuthStore?: AuthProfileStore | undefined;
  modelAuth?: ModelAuthRuntime | undefined;
}

export interface AntigravityWebFetchProvider {
  id: "antigravity-fetch";
  providerId?: "antigravity";
  label: string;
  hint: string;
  authProviderId: "antigravity";
  requiresCredential: true;
  autoDetectOrder?: number;
  envVars: string[];
  placeholder: string;
  signupUrl: string;
  docsUrl: string;
  credentialPath: string;
  inactiveSecretPaths?: string[];
  credentialNote?: string;
  parameters?: Record<string, unknown>;
  getCredentialValue: (config?: Record<string, unknown>) => unknown;
  setCredentialValue: (configTarget: Record<string, unknown>, value: unknown) => void;
  getConfiguredCredentialValue?: (config?: Record<string, unknown>) => unknown;
  setConfiguredCredentialValue?: (configTarget: Record<string, unknown>, value: unknown) => void;
  isConfigured?: (ctx?: { cfg?: unknown; agentDir?: string }) => boolean;
  fetch?: (req: {
    url: string;
    extractMode?: "markdown" | "text";
    maxChars?: number;
    checkDenylist?: boolean;
    apiKey?: string;
    auth?: { apiKey?: string };
    authStore?: AuthProfileStore;
    agentDir?: string;
    cfg?: unknown;
    signal?: AbortSignal;
  }) => Promise<WebFetchResultPayload>;
  createTool: (ctx: {
    config?: unknown;
    fetchConfig?: Record<string, unknown>;
    runtimeMetadata?: unknown;
    agentDir?: string;
    authStore?: AuthProfileStore;
  }) => {
    description: string;
    parameters: Record<string, unknown>;
    execute: (
      args: Record<string, unknown>,
      executionContext?: { signal?: AbortSignal }
    ) => Promise<WebFetchResultPayload | Record<string, unknown>>;
  };
}

export interface OpenClawPluginApi {
  registerProvider(provider: OpenClawProviderRegistration): void;
  registerMediaUnderstandingProvider?(provider: AntigravityMediaUnderstandingProvider): void;
  registerWebSearchProvider?(provider: AntigravityWebSearchProvider): void;
  registerImageGenerationProvider?(provider: AntigravityImageGenerationProvider): void;
  registerWebFetchProvider?(provider: AntigravityWebFetchProvider): void;
  runtime?: {
    modelAuth?: ModelAuthRuntime | undefined;
    modelConfig?: unknown | undefined;
    llm?: unknown | undefined;
  } | undefined;
}

export interface OpenClawPluginDefinition {
  id: string;
  name: string;
  description: string;
  register(api: OpenClawPluginApi): void;
  activate(api: OpenClawPluginApi): void;
}
