# Features

Everything below goes through OpenClaw-provided auth and the `v1internal` endpoints listed in [protocol.md](protocol.md).

## Models

Catalog: `api.registerProvider({ catalog })`, discovered live from `fetchAvailableModels` (refreshable). Published ids:

| id | upstream | context | images |
|---|---|---|---|
| `gemini-4-argon` | `gemini-4-argon-low`, `-medium`, `-high` (`MODEL_PLACEHOLDER_M124` is a dead incoming alias only) | 1M | yes |
| `gemini-4-hydrogen` | `gemini-4-hydrogen-low`, `-medium`, `-high`, `-xhigh` (proto ids unknown) | 1M | yes (Gemini default) |
| `gemini-3.8-flash` | `gemini-3.8-flash-tiered` (M322) | 1M | yes |
| `claude-opus-5-5` | `claude-opus-5-5-<tier>` | 1M | yes |
| `claude-sonnet-5-5` | `claude-sonnet-5-5-<tier>` | 1M | yes |
| `gpt-oss-120b` | `gpt-oss-120b-medium` | 128k | no |
| `gemini-3.5-flash-lite` | `gemini-3.5-flash-lite` (agy `webSearchModelIds` / flash-lite slug) | 1M default | yes (Gemini default when `supportsImages` omitted) |

`gemini-3-flash` is published when upstream lists it under that id. `gemini-3.5-flash-lite` is published the same way (2026-11-06): canonical id `gemini-3.5-flash-lite`, display name "Gemini 3.5 Flash Lite". Thinking levels, context window and media flags come from the upstream `fetchAvailableModels` fields the plugin already parses; missing fields use the existing conservative defaults (Gemini 1M context via `inferDefaultContextWindow`, flash `canDisableReasoning` plus `off|low|medium|high`, Gemini/Claude default image input). No list price is recorded; `cost` stays the zero placeholder used for every subscription model. It is not in `EXTENDED_THINKING_LEVEL_MODELS` (no evidence it accepts `xhigh`/`max`). Live `listModels` / a live turn on this account were not run. `urlContext` and `fileData.fileUri` limits for this slug are already in [protocol.md](protocol.md#turn-envelope). `web_search` is unchanged: it still sends `gemini-3.8-flash-tiered`; agy's `webSearchModelIds` list still names this slug ([protocol.md](protocol.md#fetchavailablemodels-schema-from-agys-protos)).

Provider-model config boundary (2026-11-07): OAuth `configPatch` and `catalog.run` emit `ModelProviderConfig` entries, not authored `ModelCatalogModel` metadata. Published OpenClaw 2026.10.8 / 2026.10.10 strict `ModelDefinitionSchema` rejects `tags`; omit that decoration without changing discovery, routing or supported capabilities. Evidence: `zod-schema.core-BAwh66MV.mjs`, `zod-schema.core-BohYkI3l.mjs`, and 2026.10.10 `ProviderCatalogResult` / `ModelCatalogModel` declarations; schema projection/provenance in `test/support/host-model-config-fixture.ts`.

Filtering (`isEligibleChatModel`, `NON_CHAT_ID_PATTERNS` in `src/constants.ts`):
- dropped: `disabled: true` (upstream field; `enabled: false` is still honored if present); ids in the payload `deprecatedModelIds` list (raw slug, proto `model`, or canonical id); non-chat modalities and ids (`image`, `imagen`, `veo`, `chirp`, `embedding`, `tts`, `whisper`, `audio`, `video`, `speech`); `chat_*`, `tab_*`, `MODEL_*`; `gemini-2.5-*`, `gemini-3.1-*`; other `gemini-3.5-*` ids except `gemini-3.5-flash-lite` (and optional `-low|-medium|-high|-tiered` variants).
- Effort-suffixed variants (`-low`, `-medium`, `-high`, `-xhigh`, `-tiered`, `(Low)`, `(XHigh)`…) collapse into one canonical row with merged `reasoningLevels`.
- Not published by decision: `gemini-pro-orchestrator-g1-pro` (`UNPUBLISHED_UPSTREAM_ID_PATTERNS`, see [Gemini 4 Hydrogen and the orchestrator model](#gemini-4-hydrogen-and-the-orchestrator-model)).
- Context window = `max(upstream, inferDefaultContextWindow(id))`: Gemini, Argon and Claude 5.x get 1M (upstream reports 128k placeholders).
- `off` is advertised only when `canDisableReasoning` is true.
- Display names are corrected by `KNOWN_DISPLAY_NAME_OVERRIDES` (upstream mislabels several).
- `PROTO_MODEL_ID_MAP` maps proto enums and old ids (`MODEL_PLACEHOLDER_M400`…`M405`, `chat_20706`, …) to canonical ids so stale config still resolves. Mapped ids the catalog filters out are `LEGACY_MAPPED_MODELS`; the published set is `KNOWN_CATALOG_MODELS`.
- Media input: `supportsImages` (or `image/*` in `supportedMimeTypes`) adds `image` to catalog `input` (`text|image` only — host OpenClaw validates that field). `supportsVideo` / `supportsPdf` (or `video/*` and `application/pdf` MIME types) are stored on the subscription row for media-understanding routes and are **not** published on catalog `input`. Gemini and Claude still default to image input when `supportsImages` is omitted. 2026-11-06: field names (`disabled`, `deprecatedModelIds`, `supportsVideo`, `supportsPdf`, `supportedMimeTypes`) taken from the [fetchAvailableModels schema](protocol.md#fetchavailablemodels-schema-from-agys-protos). Live `listModels` compare on this account was **not** run (assistant must not read `~/.gemini` / `~/.openclaw`); Prove for unchanged live catalog remains maintainer-side.

## Reasoning effort

`CatalogService.resolveModelForTurn` maps OpenClaw's effort to an upstream model:
- Claude: `<id>-<low|medium|high>`; default `medium`; Opus without a medium variant uses `high`. `/think xhigh` and `/think max` are rejected with that model's valid options (`low`, `medium`, `high`).
- `gemini-4-argon`: `<id>-<low|medium|high>`; default `medium`. `MODEL_PLACEHOLDER_M124` (and M317–M320) stay incoming aliases so stale config still resolves; they are never sent upstream (2026-11-06). `/think xhigh` / `/think max` are **not** advertised for Argon: those `gemini-4-argon-<tier>` ids skip `thinkingConfig`, so advertising `xhigh`/`max` would lie. Revisit sending `gemini-4-argon-high` + `thinkingLevel`, or keep Argon without them.
- `gemini-4-hydrogen`: `<id>-<low|medium|high|xhigh>`; default `medium`. `xhigh` routes to the real `-xhigh` slug, never to `-high`, and is advertised only when that slug is listed. Like Argon, the tier ids skip `thinkingConfig`. `max` is rejected; `off` follows the rule below (2026-11-14, [decision](#gemini-4-hydrogen-and-the-orchestrator-model)).
- `gemini-3.8-flash`: `gemini-3.8-flash-tiered` with the same `thinkingLevel` mapping (`LOW|MEDIUM|HIGH|EXTRA_HIGH|MAX`). `/think xhigh` maps to `EXTRA_HIGH`; `/think max` maps to `MAX`.
- `off`: models with `canDisableReasoning` send `thinkingBudget: 0`. On any other model `off` is treated as no effort for the whole turn: no `thinkingConfig`, no `reasoning_effort`, model routing as with no effort. Other levels outside the model's list fail the turn with `unsupported reasoning effort`, which `classifyFailoverReason` reports as `format`.

Decision (2026-11-06, host OpenClaw thinking profile / `resolveThinkingProfile`): `xhigh` and `max` must be declared by the provider or OpenClaw rejects the directive and never sends them. The catalog advertises them on `gemini-3.8-flash` only via `compat.supportedReasoningEfforts` (Argon omitted because its suffix variants skip `thinkingConfig`). `resolveThinkingProfile` returns that ladder for flash (`low`, `medium`, `high`, `xhigh`, `max`; plus `off` when reasoning can be disabled). Other published models keep `low|medium|high` (and `off` when allowed). Mapping aliases: `extra-high` / `x-high` → `xhigh`; `maximum` → `max`. Live upstream acceptance of `EXTRA_HIGH`/`MAX` on flash is unverified (no quota probe; do not read `~/.gemini`); hermetic tests cover the mapping and the rejection path.

Decision (2026-11-13, issue #34, team lead): `off` on a model that cannot disable reasoning omits the thinking field instead of failing the turn; it is never mapped to `LOW`. Evidence:
- Host OpenClaw 2026.11.2 (`npm pack openclaw@2026.11.2`): the setup-inference probe hard-codes `thinkLevel: "off", reasoningLevel: "off"` (`dist/setup-inference-turn-DlXmW2XG.mjs:349-350`) regardless of the thinking profile. Our `thinkingLevelMap: { off: null }` and `resolveThinkingProfile` ladder do not stop it; `extractReasoningEffort` maps `reasoning: "off"` to `off`.
- Reported log (OpenClaw 2026.11.2, plugin 1.5.301, default `antigravity/gemini-3.8-flash`): `unsupported reasoning effort "off" for model gemini-3.8-flash`, `[empty-error-retry]` 3×, `decision=fallback_model` to the same model, `setup_inference_probe_failed`. No request reached Google; the plugin threw in `executeTurn` step 3. Hermetic reproduction: the probe-shaped `createStreamFn` test fails on 1.5.301 with that message.
- Host docs `docs/tools/thinking.md:62`: `/think off` omits `reasoning_effort` by default on custom routes; this matches.
- Not verified live (no quota approval). Maintainer acceptance after merge: `openclaw` tool call with default `antigravity/gemini-3.8-flash` starts Custodian and `openclaw logs --follow` shows no `setup_inference_probe_failed`.

Failover kind (2026-11-13, host 2026.11.2 `dist/`): `classifyFailoverReason` returns `format` for `/unsupported reasoning effort/i` (was `null`). Host effect:
- `null`/`unclassified` enables `[empty-error-retry]` (`MAX_EMPTY_ERROR_RETRIES = 3`, `dist/embedded-agent-BJe8xfTT.mjs:1850`, `:1906-1918`), then `exhaustedUnclassifiedSilentError` forces `fallback_model` with reason `unknown` (`:1926`, `:1970`). This is the reported 3× retry and same-model fallback.
- `format` is not `unclassifiedError`, so no empty-error retry and no forced fallback. `isTerminalFormatFailure` returns `surface_error` (`:1774`, `:1825`); the retry-limit stage excludes `format` from `fallback_model` (`:1800`); `auth-profile-failure-policy-tXEAKYJg.mjs:71` records no profile cooldown; `model-fallback-runner-DC_EqCLW.mjs:44` keeps the transient probe slot. Host docs `docs/concepts/model-failover.md`: format errors are terminal and not rotated.
- Caveat: `isFailoverAssistantError` (`dist/assistant-message-failures-Zz_OU1Uq.mjs:37`) classifies without the provider hook, so for this plugin-only classification `failoverFailure` can be false and the decision is `continue_normal` (error returned, no retry, no fallback) rather than `surface_error`. Either path stops the retry loop. Not observed at runtime.

## Gemini 4 Hydrogen and the orchestrator model

Decision (2026-11-14, issue #37, team lead). Evidence: dry `npm run sync:upstream` on `main` `00a555f` (installed agy 1.5.7, baseline 1.5.3) added five slugs to the fingerprint `models`; `agy models` shows `Gemini 4 Hydrogen (Low|Medium|High|XHigh)` and `Orchestrator (Argon)` (both as recorded in the issue). No live call was made for this decision.
- Hydrogen is one row, `gemini-4-hydrogen` "Gemini 4 Hydrogen", ladder `low|medium|high|xhigh` (`SLUG_LADDER_FAMILIES`, `src/catalog.ts`), default `medium`, `canDisableReasoning: false`, `compat.supportedReasoningEfforts` = the listed levels. Each level is sent as `gemini-4-hydrogen-<level>`; the turn sends no `thinkingConfig` (`-xhigh` counts as pre-tiered in `src/turn.ts`). `max`: no upstream tier, rejected before any call. `off`: no effort, sends `-medium` (#34).
- `EffortTier`, `parseEffortVariant` and the display-name cleanup know `xhigh`. Argon, 3.8 Flash, Claude and GPT-OSS rows and routing are unchanged (snapshot in `test/hydrogen.test.ts`).
- Before this change `main` published `gemini-4-hydrogen` (`low|medium|high`) plus a separate `gemini-4-hydrogen-xhigh` "Gemini 4 Hydrogen (XHigh)" row, rejected `xhigh`, and published `gemini-pro-orchestrator-g1-pro` "Orchestrator (Argon)" as a sendable chat model (hermetic fixture, mocked fetch).
- Quota: per-model buckets whose id starts with `gemini-4-hydrogen` form their own `Gemini 4 Hydrogen` group per window (the lowest `remainingFraction` of the tiers), so they neither split the shared `Gemini` row nor fall into the Argon group; a summary group named for Hydrogen does not hide per-model Gemini buckets. Real Hydrogen bucket ids, group names and windows are unknown (hermetic fixtures only).
- Media (`src/media.ts`, `src/image.ts`, `src/search.ts`): the only Argon special case is `media.ts` `resolveUpstreamModelSlug` (`gemini-4-argon` → `gemini-4-argon-medium`). Hydrogen is not a default media, image or search model; no evidence that it accepts media-understanding requests, so nothing was changed. A user who sets `antigravity/gemini-4-hydrogen` as a media model would send the bare id upstream (unverified result).
- Orchestrator verdict: **not published**. The Decision requires `fetchAvailableModels` fields (modality, `disabled`, quota) that prove an ordinary, enabled, user-selectable chat model. Recorded facts are only the slug `gemini-pro-orchestrator-g1-pro` and the display name `Orchestrator (Argon)`; its `modality`, `disabled`, `quotaInfo` and `supports*` values are not recorded (no live dump allowed, not in agy's static protos). The display name and the agy 1.5.9 `run_workflow` changelog suggest an internal subagent orchestrator (unverified). It is filtered by `UNPUBLISHED_UPSTREAM_ID_PATTERNS` (`/^gemini-pro-orchestrator-/`), so a configured `antigravity/gemini-pro-orchestrator-g1-pro` fails with `unknown model` before any call. Revisit when a redacted field record exists.

## Model reasoning display

Decision (2026-11-06, host OpenClaw 2026.11.1): `thought: true` parts from `v1internal:streamGenerateContent` are streamed as host `thinking_start` / `thinking_delta` / `thinking_end` events (`AssistantMessage` content `{ type: "thinking", thinking }`), never as `text_delta` or `TurnResponse.text`.

Evidence from host `2026.11.1` (`AssistantMessageEvent` in `dist/types-*.d.ts`; TUI `/reasoning <on|off|stream>` in `docs/web/tui.md`): the provider stream contract accepts reasoning as a separate thinking content type. The plugin previously dropped those parts in `src/turn.ts`. Visibility still follows the host `/reasoning` setting; the plugin only supplies the events.

## Tools

- Host tools only. The plugin returns tool calls with the host's names and arguments; OpenClaw executes them.
- Names are mapped to upstream-safe names and back (`ToolNameMapper`), schemas are sanitized (`cleanJsonSchema`); see [protocol.md](protocol.md#request-sanitization).
- Native CLI tools (`NATIVE_CLI_TOOLS`, e.g. `manage_task`, `run_command`, `search_web`) that the host did not offer fail the turn with `native tool refused: <name>`; an endpoint offering native tools fails with `native tools offered`. Host tools of the same name that OpenClaw offered (`exec`, `browser`, `session_status`, `view_image`) are allowed.
- Images in tool results are nested in `functionResponse.parts` (accepted upstream; models see both text and image).
- Gemini historical `functionCall` parts reuse the stored `thoughtSignature` when present **and** `thoughtSignatureModel` matches the current catalog model; otherwise the sentinel `skip_thought_signature_validator` ([protocol.md](protocol.md#turn-envelope)). Claude turns never send thought signatures. Live multi-step prove and host persistence of these fields are unverified.
- `buildReplayPolicy` returns `repairToolUseResultPairing: true`, `allowSyntheticToolResults: true` so OpenClaw repairs orphaned tool results.
- `wrapSimpleCompletionStreamFn` routes OpenClaw utility completions (pdf tool fallback, exec auto-reviewer, approval intent, tts normalization, compaction and titles, `api.runtime.llm.complete`) through the plugin; without it OpenClaw posts raw OpenAI requests to the SSE endpoint and gets 404.

## Structured output (`responseFormat`)

Recorded 2026-11-06 from published `openclaw@2026.11.1` (unpacked `npm pack`; no `~/.openclaw` read):

- Official `StreamOptions` includes `responseFormat?: Record<string, unknown>` (`dist/types-D7I_F5Ux.d.ts`). Its JSDoc: “Optional JSON Schema for the generated response. Providers that support constrained decoding map it to their native request shape; others ignore it.”
- Provider extra-params (`dist/extra-params-DFPwmidA.mjs`) treat `response_format` / `responseFormat` as request-scoped keys and copy a resolved object into `streamParams.responseFormat` before `createStreamFn`.
- Direct `api.runtime.llm.complete` forwards `params.responseFormat`. Isolated agent-runtime completions reject it (`Isolated agent-runtime completion does not support requiredAuthMode or responseFormat; use direct completion for provider controls.`) (`dist/runtime-llm.runtime-Bj0hJdFk.mjs`); that limit is host-side, not a plugin gap. Host docs (`docs/plugins/sdk-runtime/models.md`) match: direct completions can set `responseFormat`; isolated agent-runtime completions reject those controls before dispatch.
- The system planner sets `streamParams.responseFormat` to `SYSTEM_AGENT_PLANNER_RESPONSE_SCHEMA` (a raw JSON Schema object) (`dist/assistant-BscLQcUU.mjs`).
- Plugin providers are invoked as `createStreamFn(model, context, options)` (`dist/provider-runtime-DsbXpYc_.mjs`).

The plugin previously ignored `options.responseFormat`. It now maps it on Gemini-family catalog ids (including `MODEL_PLACEHOLDER_*` aliases) to `generationConfig.responseMimeType: "application/json"` and, when a schema is present, `generationConfig.responseSchema` after `cleanResponseJsonSchema` (same node sanitizer as tool parameters — `$schema`, `additionalProperties`, and `const` are dropped — but the root `type` is kept when it is `array`/`string`/etc.; object is forced only when type is missing). `{ type: "json_schema", json_schema }` without a `schema` record is mime-only; the descriptor itself is not treated as a schema. Claude and GPT-OSS turns do not receive these fields. When the turn already has `tools` (function declarations), `responseMimeType` and `responseSchema` are omitted: Gemini rejects function calling combined with `response_mime_type: application/json` (`400 INVALID_ARGUMENT`). Accepted shapes: a raw JSON Schema object; `{ type: "json_schema", json_schema: { schema } }`; `{ type: "json_object" }` (mime type only); `{ type: "text" }` or an absent/invalid value leaves these fields off. Live upstream acceptance of a schema is unverified (no live account request). Field names: [protocol.md](protocol.md#turn-envelope).

## Web search (`antigravity-search`)

- `api.registerWebSearchProvider`; manifest `contracts.webSearchProviders`.
- Runs only when OpenClaw's `web_search` tool routes to it; normal turns never get `googleSearch`.
- Request: `gemini-3.8-flash-tiered` with `tools: [{ googleSearch: {} }]`. Answer text plus `groundingMetadata` (`webSearchQueries`, `groundingChunks[].web {uri,title}`, `groundingSupports`).
- Parameters: `query` (required), `count` 1–10, `freshness` (`day|week|month|year`), `date_after`, `date_before` (`YYYY-MM-DD`).
- Auto-detect: `authProviderId: "antigravity"`, `requiresCredential: true`, `autoDetectOrder: 35` (after Grok 30, before Kimi 40). Readiness is a local auth-profile lookup, no network.
- Output wrapped with OpenClaw's `wrapWebContent`; citations as `[{ url, title }]` with redirects resolved.

## Web fetch (`antigravity-fetch`)

- `api.registerWebFetchProvider`; manifest `contracts.webFetchProviders`.
- Fallback provider only: OpenClaw tries its own HTTP fetch and Readability first; this runs if that fails, returns a non-OK status, or Readability yields nothing (or is disabled). Select explicitly with `tools.web.fetch.provider: "antigravity-fetch"`. Sandboxed `web_fetch` skips third-party providers, so this plugin is not used there.
- Request: `fetchFromTrawlerCache {url, liveFetch:true}` on `v1internal` ([protocol.md](protocol.md#other-v1internal-rpcs-probed-2026-11-02)). On HTTP 500, retries once with `liveFetch:false`. Mapped opaque 500: `page could not be fetched (upstream error, ~7 s timeout, or unsupported type such as PDF or images)`.
- No model quota. Upstream returns only `{content}`: no status, content type or final URL. The plugin sniffs HTML/JSON from the body and never invents a status. HTML is converted to readable text without a heavy dependency.
- Private, loopback and link-local URLs are refused before any upstream call. `checkUrlDenylist` is attempted first and skipped if that probe fails.
- Auto-detect: `authProviderId: "antigravity"`, `requiresCredential: true`, `autoDetectOrder: 40`. Readiness is a local auth-profile lookup, no network.

## SDK readiness compatibility

Decision/evidence (2026-11-07, published `openclaw@2026.10.8` and `@2026.10.10`, unpacked with `npm pack`):

- Keep the declared 2026.10.8 minimum and sync fallbacks: that package's `runtime-types-lAgJ9sB9.d.ts` / `loader-runtime-load-BYmZwotb.mjs` expose only sync readiness/auth methods. The image provider now also supplies `isConfiguredAsync`; its helper prefers `ensureAuthProfileStoreAsync(agentDir, options)` and `isProviderApiKeyConfiguredAsync(params)` independently, awaits them, and returns false on absent auth or errors. Both receive `readOnly: true`, `allowKeychainPrompt: false`; the key check receives the prepared store. No sync retry after an async error.
- 2026.10.10 confirms the signatures in `config-contracts-CaROPwlH.d.ts` (`modelAuth`, auth store/options), `runtime-types-BrbucdBv.d.ts` (`isConfiguredAsync(ctx): Promise<boolean>`), and wiring in `loader-runtime-load-DmW4CQhd.mjs`. `runtime-shared-DeK1EtAT.mjs` prefers the async image hook. `store-BuHyZgtK.mjs` / `sdk-deprecation-DjTmOhOX.mjs` confirm both warning families' last compatibility day is 2026-12-31, with removal in the first January 2027 stable release.
- The warning's “media provider” is the shared image/music/video readiness path, not the web providers: `WebSearchProviderPlugin` / `WebFetchProviderPlugin` in both packages declare neither readiness hook. Leave search/fetch's existing local sync helpers unchanged rather than invent an async web contract; search uses the host's `authProviderId` lookup.

Maintainer-reported installed-build check (2026-11-07, OpenClaw 2026.10.10, isolated state directory, no login): `openclaw infer image generate` without `--model` printed the `isConfigured`, `ensureAuthProfileStore` and `isProviderApiKeyConfigured` warnings on main and none on this branch. The gateway tool path was not exercised; this is warning/readiness evidence, not authenticated generation validation.

## Image generation

- `api.registerImageGenerationProvider`; id `antigravity`; supported model `gemini-3.1-flash-image`. Undefined, empty or whitespace-only input defaults to that model; that id and `flash-image` accept an optional `antigravity/` prefix. A bare `antigravity/` prefix is unsupported. Any other id is rejected before auth or an upstream request; no substitution or chat-to-image mapping (2026-11-07, `resolveImageModel` and hermetic acceptance tests). HTTP failures name the model. Maintainer-reported live smoke (2026-11-07): `gemini-3.1-flash-image` generated one image; the smoke calls the plugin directly, not the host `image_generate`. Earlier 404s on other image models: [protocol.md](protocol.md#errors).
- Generate and edit (up to 5 input images), 1 output, JPEG. Sizes `1024x1024`, `1024x1536`, `1536x1024`, `1024x1792`, `1792x1024`; aspect ratios `1:1 2:3 3:2 3:4 4:3 4:5 5:4 9:16 16:9 21:9`; resolutions `1K 2K 4K`.
- One retry when a response has no image, no block and `finishReason` `STOP` or missing. Blocks report `blockReason`/`finishReason` and high-probability safety categories.
- Timeout `DEFAULT_IMAGE_TIMEOUT_MS` = 180 s per request; stored-token refresh is bounded by the same `timeoutMs` and caller abort signal. Terminal 429 quota reports the reset time; transient rate/capacity limits use the shared [classification rules](protocol.md#errors), bounded retries; smoke skips them as `rate_limited`, not exhausted quota.

Image stored-auth scope (2026-11-07, `src/index.ts` registration/auth method and published `openclaw@2026.10.10` `runtime-jO-vrhdY.mjs`): a fresh registration creates an empty in-memory default store; ordinary generation forwards the caller's auth store, not a hydrated plugin store. Only the same registration's OAuth method (or an explicitly supplied plugin store) populates the default; chat uses a separate turn store. Thus the stored-token path is conditional, not evidence that the reported installed inference used it. Keep the fix local: use the existing refresh helper when refreshable, and let expired non-refreshable credentials fall through to SDK resolution. No 401 failover is added.

Image SDK auth errors (2026-11-07, published `openclaw@2026.10.10` `provider-auth-runtime-ED8xwtLJ.mjs`, `model-auth-provider-kAO_U1WC.mjs`, `model-auth-provider-config-Dlst5H1_.mjs`): the resolver checks caller cancellation and missing login throws `ProviderAuthError` with `code: "missing-provider-auth"`, `provider: "antigravity"` (key-required paths can use `missing-api-key`). Preserve sign-in guidance for these and the older provider-specific missing-key message. An unavailable import still falls through; other resolver errors retain their redacted message/cause, and cancellation preserves the caller's reason.

## Media understanding

- `api.registerMediaUnderstandingProvider`; capabilities image, audio, video; native document input `pdf`; default model `gemini-3.8-flash`.
- `describeImage` / `describeImages` delegate to the SDK helpers (`describeImageWithModel`, `describeImagesWithModel`), which resolve auth and call the provider's stream function.
- `transcribeAudio` / `describeVideo` send media as `inlineData` with the token from `req.apiKey` (see [auth.md](auth.md#credential-shapes)). Audio MIME types: `audio/mpeg` (MP3), `audio/mp4` (M4A).
- `transcribeAudio` rejects a clip larger than `INLINE_AUDIO_MAX_BYTES` (15 532 032 bytes / ~14.81 MiB raw) before encoding or fetch, so base64(audio) plus a 256 KiB prompt/envelope reserve stays under `INLINE_AUDIO_REQUEST_MAX_BYTES` (20 MiB). The error names the ~20 MiB whole-request Gemini inline limit, the raw cap after base64 expansion, and that `v1internal` has no media upload path. Decision (2026-11-06): live 5/15/25 MB probes were not run (no authorized quota or large fixtures); the base64-aware raw cap is derived from the published Gemini inline limit, not a measured `v1internal` threshold. See [protocol.md](protocol.md#inline-audio-size-2026-11-06).
- In-turn user content accepted: OpenClaw image blocks, OpenAI `image_url` data URIs, Anthropic base64 images, OpenAI `input_audio`, raw `inlineData`.

## Usage and quota

- `openclaw status --usage --json` shows live windows from `retrieveUserQuotaSummary` and `retrieveUserQuota` (parallel, 10 s timeout). `fetchAvailableModels` (~180 KB) is used only when `retrieveUserQuota` fails.
- `usedPercent = floor((1 - remainingFraction) * 100)`, matching the app's `ceil(remainingFraction * 100)` remaining. Exhausted or `disabled` buckets report 100 with `resetAt` kept. Missing percentages stay `null` (`percentageOmitted: true`).
- Window: explicit `window`/`bucketId`/`displayName` first, then a summary bucket with equal `(remainingFraction, resetTime)`, then reset within 5h15m means `5h`, otherwise weekly.
- Labels and order: `Gemini · Weekly`, `Gemini · 5h`, `Claude and GPT · Weekly`, `Claude and GPT · 5h`, `Gemini 4 Argon · Weekly`. Per-model buckets collapse into a group window only when window, fraction and reset are identical; duplicates across endpoints yield one window.
- `rawUsage` keeps the raw payloads without full model definitions (typically 4–6 KB).
- Terminal quota on a turn (429 `QUOTA_EXHAUSTED`) streams an in-chat notice with the reset time, countdown, window and an alternative model from the other family, and ends with `stopReason: "stop"`. A model 404 is an unknown-model failure, not quota (the old Argon 404 was the dead `MODEL_PLACEHOLDER_M124` id). Transient 429s (`RATE_LIMIT_EXCEEDED`, `MODEL_CAPACITY_EXHAUSTED`) are retried, then surfaced as a normal error without the notice.

## Not implemented

Probed on `v1internal` and not implemented: TTS, embeddings, music. Video generation: [no route found through this login in the forms tried](protocol.md#extended-research-2026-11-07-no-route-found-through-this-login); general upstream absence is not established. Web fetch through `urlContext` does not work; pages are fetched through `fetchFromTrawlerCache` via `antigravity-fetch` (above).

Video-generation provider errors: [troubleshooting](troubleshooting.md).

## Plugin stream transport

Decision (2026-11-05, host OpenClaw 2026.10.10): chat turns and utility completions for `antigravity/*` must go through the plugin's `createStreamFn` / `wrapSimpleCompletionStreamFn`, which POST once to `DEFAULT_ENDPOINTS.chatCompletionsUrl` (`v1internal:streamGenerateContent?alt=sse`). The catalog still publishes `api: "openai-completions"` with that full RPC URL as `baseUrl`.

Evidence from host `2026.10.10` dist (`registerProviderStreamForModel` → `resolveProviderStreamFn` → `plugin.createStreamFn(context)`; lookup uses `activate:false` + `skipIfLoadInFlight:true` against the already-loaded registry):
- `openai-completions` is in the host's `CORE_BUILT_IN_MODEL_APIS`. `configuredModelProviderNeedsRuntimePlugin` therefore returns false for this provider, so gateway startup does not activate the plugin for configured agent models.
- When the plugin is absent from the active registry, `resolveProviderStreamFn` returns nothing and the host falls back to `createTransportAwareStreamFnForModel`. The bundled OpenAI SDK `buildURL` inserts `/chat/completions` before the `?`, producing `/v1internal:streamGenerateContent/chat/completions?alt=sse`. Google returns HTML 404; the host classifies that as `model_not_found`.
- `register()` and `activate()` previously each called `createAntigravityProvider` (fresh objects). Host 2026.10.x only invokes `register()`; both entry points now share one function. OpenClaw's SDK `definePluginEntry` would drop `activate`; this plugin's local helper keeps it as an alias.
- Fix: `activation.onStartup: true` plus `autoEnableWhenConfiguredProviders: ["antigravity"]` so an enabled install is in the active registry before stream resolution. Startup activation is preferred over a non-core `api` id because `openai-completions` is the host family this catalog already uses (payload policy, extra-params, `wrapSimpleCompletionStreamFn`); a new api id would still need `createStreamFn` registered and would have to teach the host a custom transport. Cost: the plugin is eager-loaded on every gateway start (previously lazy via `onProviders`). The silent SDK fallback remains reachable if the plugin is disabled, fails to load, or is excluded by `plugins.allow`. Do not retarget `baseUrl` at an OpenAI-style `/v1` root and do not patch the OpenAI SDK as the primary fix. Changing `api` away from `openai-completions` remains a possible follow-up if startup activation proves insufficient on a future host.

## Out of scope by decision

agy can do these; the plugin does not, on purpose:
- **agy's agent tools** (`run_command`, `view_file`, `search_web`, `generate_image`, browser, MCP): OpenClaw has its own tools with its own approvals; the plugin refuses unoffered native tools.
- **Server-side Gemini tools in chat** (`googleSearch`, `codeExecution`, `urlContext`, image/visual search, Maps, computer use): they would run outside OpenClaw's view and approvals and spend quota every turn. `googleSearch` is used only behind `web_search`. `codeExecution` is the only candidate worth a probe.
- **Live dictation** (Live API, `proactive-observer-v10`): needs the `aicode` scope (re-login for every user) and a bidi gRPC client; recorded audio already works through media understanding.
- **IDE/CLI features**: tab completion (`tab_*`, `completeCode`, `generateCode`), commit messages, `countTokens`, video pre-summarization.
- **`gemini-2.5-*`, `gemini-3.1-*`**: filtered; superseded. Other `gemini-3.5-*` ids stay filtered. `gemini-3.5-flash-lite` is published as the cheap chat model (above).
- **OAuth client constants and the CLI client identity** (`src/constants.ts`, User-Agent): kept as they are; change only on the maintainer's decision.
