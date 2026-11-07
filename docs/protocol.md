# Upstream protocol

Verified facts about the Antigravity backend. Host: `daily-cloudcode-pa.googleapis.com`. All probes used the user's own subscription login. New findings go here (or in the matching topic file) with the date and the evidence; there is no separate notes file.

## Endpoints (`DEFAULT_ENDPOINTS`, `src/constants.ts`)

| purpose | endpoint |
|---|---|
| device code / auth / token / userinfo | `oauth2.googleapis.com/device/code`, `accounts.google.com/o/oauth2/v2/auth`, `oauth2.googleapis.com/token`, `www.googleapis.com/oauth2/v1/userinfo` |
| eligibility, project | `POST v1internal:loadCodeAssist` |
| models | `POST v1internal:fetchAvailableModels` |
| usage | `POST v1internal:retrieveUserQuotaSummary`, `POST v1internal:retrieveUserQuota` (`{"project"}`) |
| chat, search, image, media | `POST v1internal:streamGenerateContent?alt=sse` |

## Client identity

- `User-Agent: antigravity/cli/<CLI_VERSION> <os>/<arch>` (`buildAgyUserAgent` / `mapAgyOsArch`). Tokens follow Go: `win32`→`windows`, `sunos`→`solaris`, `x64`→`amd64`, `ia32`→`386`; any other value as reported; empty or non-string → `unknown`. Always a non-empty string; never throws. There is one `CLI_VERSION` and no per-host version or fallback to another platform's UA. This identity returns all 3 quota groups (5 windows).
- Decision (2026-11-06): agy ships one version for every OS/arch at the same time, and compared fingerprint fields are identical across platforms (agy 1.5.1 `darwin-arm64` vs `linux-x64` baselines differed only in `platform`, `binaryFormat`, and `binarySha256`; 1.5.2 dry-runs on darwin-arm64 and linux-x64 reported the same protocol diff). The plugin therefore keeps one shared baseline (`upstream/agy-fingerprint.json`) and tells the truth about the host OS/arch only in the User-Agent. That is the only place OS/arch leave the plugin: every Antigravity request sets it via `buildAntigravityHeaders`; request bodies have no platform/OS field (only `ideType: "ANTIGRAVITY"` in subscription/catalog `metadata`); OAuth token requests send no UA. `src/` never reads `upstream/`.
- Linux box check (2026-11-06): On linux-x64 from then-current `main` (plugin still targeting agy 1.5.1), `npm ci`, `npm run build`, then `buildAgyUserAgent()` from `dist/constants.js` returned `antigravity/cli/1.5.1 linux/amd64`. Dry `npm run sync:upstream -- --json` exited 20 `REVIEW_NEEDED`; `storedVersion` 1.5.1 → `cliVersion` 1.5.2; top-level `changedFields` were `cliVersion`, `latestChangelog`, `googleHosts`, `requestShapeMarkers` (same aggregate names as the 2026-11-06 Mac dry-run). Nested `diff.googleHosts`: `used` unchanged (3 hosts); `other` 21 → 22 (added `5aiplatform.googleapis.com`). Nested `diff.requestShapeMarkers`: 18 → 19 (added `x-goog-upload-url`). Live `npm run test:integration -- --json --model=gemini-3.8-flash` was **not run** on this Linux box: it has no stored OpenClaw Antigravity login (`~/.openclaw` is absent, so the smoke's default `openclaw` auth source would find none). No workaround was used (`--auth-source=agy` was not passed; `~/.gemini` was not read). Integration attempts: 0. Native-Linux per-check pass/skipped/failed results and a usage-window count from a Linux host are therefore unavailable.
- Maintainer report (2026-11-06): After agy 1.5.2 adoption, the maintainer ran the live check from the Mac with a stored OpenClaw login, forcing the User-Agent header to `antigravity/cli/1.5.2 linux/amd64` (not the Mac's native `darwin/arm64` identity, and not a run on a Linux machine). Results: `fetchAvailableModels` 200 (7 models); `retrieveUserQuotaSummary` and `retrieveUserQuota` 200 with 5 usage windows; `streamGenerateContent` on `gemini-3.8-flash` 200 with a pong reply. That verifies upstream acceptance of the `linux/amd64` User-Agent string. It does not verify native Linux-host execution of the plugin.

- `x-activity-request-id`: fresh UUID v4 on every call (a deliberate choice; opencode-agy-auth sends it only on quota calls; upstream accepts it everywhere).
- Not sent: `X-Goog-Api-Client`, `Client-Metadata` (agy sends neither).
- OAuth client: agy's consumer client (prefix `1071006060591`) with the same 5 scopes; `sync:upstream` reports a change.

## Turn envelope

```json
{ "project": "<projectId>", "model": "<upstream id>",
  "request": { "contents": [], "systemInstruction": {}, "tools": [], "generationConfig": {} },
  "requestType": "agent", "userAgent": "antigravity", "requestId": "<uuid>" }
```

Responses are SSE chunks; candidates are unwrapped from `response.candidates` (`unwrapCandidates`).

- Gemini 3+ requires thought signatures on historical `functionCall` parts. Decision (2026-11-06): the plugin stores the upstream `thoughtSignature` / `thought_signature` from each `functionCall` part on the host tool call **together with `thoughtSignatureModel` (catalog id that produced it)** and sends that value back on Gemini multi-step tool turns only when the replay model matches. When no signature was stored, or the stored producing model differs from the current turn model (failover / model switch), it falls back to `skip_thought_signature_validator`. Applied only for `/^gemini-/i` and `MODEL_PLACEHOLDER_M*`; Claude rejects thought signatures (including the sentinel), so Claude turns never get these fields.
- Prove (2026-11-06): live multi-step tool probe with real signatures **not run** (no quota / no `~/.gemini` read). Whether OpenClaw persists the extra `thoughtSignature` / `thoughtSignatureModel` fields on `toolCall` blocks is **unverified**; if the host strips them, replay always uses the sentinel (safe, pre-change behavior).
- Structured output (2026-11-06): when the host supplies `StreamOptions.responseFormat`, Gemini turns add camelCase `generationConfig.responseMimeType` (`application/json`) and, when a schema is present, `generationConfig.responseSchema`. Those JSON names match the public Gemini/Vertex `GenerateContent` request and the proto JSON mappings in the investigated agy 1.5.2 binary (`response_mime_type` → `responseMimeType`, `response_schema` → `responseSchema`; the binary also contains `response_json_schema`). The schema is sanitized with `cleanResponseJsonSchema` (root type preserved). These fields are omitted when the turn already includes function-calling `tools`, because Gemini rejects that combination (`400 INVALID_ARGUMENT: Function calling with a response mime type: 'application/json' is unsupported`). Claude and GPT-OSS turns never get these fields. A live schema request was not run; host-pass evidence lives in [features.md](features.md#structured-output-responseformat).
- Images in tool results: `functionResponse: { name, response: { output }, parts: [{ inlineData }] }` returns 200.
- Search: `tools: [{ googleSearch: {} }]`; grounding in `groundingMetadata`.
- `urlContext` does no live fetch (re-probed 2026-11-02 on `gemini-4-argon-low`, `gemini-3.8-flash-tiered`, `gemini-3-flash`, `gemini-3.5-flash-lite`; alone, with `googleSearch`, with and without the envelope fields): 200, no `urlContextMetadata`, models refuse or invent content.
- A URL as `fileData: { fileUri, mimeType }` (no tools) is read by `gemini-3-flash` and `gemini-4-argon-low` for JSON/text (verified with a fresh commit SHA); `gemini-3.8-flash-tiered` and `gemini-3.5-flash-lite` do not; `text/html` is rejected with 400. Costs a model turn; not used.

## Model ids (2026-11-02)

- `fetchAvailableModels` lists Argon as `gemini-4-argon-low|medium|high`. Probed 2026-11-02: `MODEL_PLACEHOLDER_M124` returns **404 NOT_FOUND**; `gemini-4-argon-medium` returns a proper 429 with `Resets in …` when the Argon weekly window is empty. Other `MODEL_PLACEHOLDER_*` aliases also returned 404 when sent as upstream ids. As of 2026-11-06 the plugin sends the catalog variants (`gemini-4-argon-<tier>`) and keeps `MODEL_PLACEHOLDER_*` as incoming aliases only.
- Model ids and the catalog are served at runtime and vary by account; static analysis of `agy` cannot prove what the server returns.

## `fetchAvailableModels` schema (from agy's protos)

- Routing lists: `defaultAgentModelId`, `agentModelSorts`, `commandModelIds`, `tabModelIds`, `imageGenerationModelIds` (`gemini-3.1-flash-image`), `webSearchModelIds` (`gemini-3.5-flash-lite`), `mqueryModelIds`, `commitMessageModelIds`, `deprecatedModelIds`, `audioTranscriptionModelIds` (`models/proactive-observer-v10`), `tieredModelIds{flashLite,flash,pro}`. 2026-11-06: that `webSearchModelIds` slug is now also published as a cheap chat model; the plugin's `web_search` provider still sends `gemini-3.8-flash-tiered` (unchanged). See [features.md](features.md#models).
- Per model: `supportsImages`, `supportsVideo`, `supportsPdf`, `supportedMimeTypes`, `supportsThinking`, `thinkingBudget`/`minThinkingBudget`, `thinkingLevel`, `supportsRawThinking`, `supportsAdaptiveThinking`, `supportsThoughtCirculation`, `maxTokens`, `maxOutputTokens`, **`disabled`** (not `enabled`), `beta`, `preview`, `quotaInfo`.
- `ThinkingConfig.thinkingLevel` enum: `LOW | MEDIUM | HIGH | MINIMAL | EXTRA_HIGH | MAX`; agy exposes `--effort low|medium|high|xhigh|max`. The plugin maps `xhigh` → `EXTRA_HIGH` and `max` → `MAX` on `gemini-3.8-flash` (2026-11-06). Argon is not in that set. Live acceptance of EXTRA_HIGH/MAX on flash is unverified (no live probe); see [features.md](features.md#reasoning-effort).

## Other `v1internal` RPCs (probed 2026-11-02)

Same host and headers as the quota calls (`buildAntigravityQuotaHeaders`). Used by agy's `read_url_content` tool (`ReadUrlContentHandler.fetchLiveContent`/`fetchViaProxy` → `FetchFromTrawlerCache`; HTML → markdown happens client-side).

| RPC | request → response | notes |
|---|---|---|
| `fetchFromTrawlerCache` | `{url, liveFetch}` → `{content}` | `liveFetch:true` fetches live; `false` returns a cached copy or 404 |
| `rewriteUri` | `{originalUri}` → `{redirectUri}` | returned `{}` for normal URLs |
| `checkUrlDenylist` | `{url}` → `{isDenied}` | |
| `checkUrlAntivirus` | `{url}` → `{isClean, reason}` | `reason: "All URLs scanned clean by GAVS"` |

`fetchFromTrawlerCache` facts:
- Live: a nonce generated at request time came back from `postman-echo.com/get`, `httpbin.org/get`, `httpbin.org/anything/<nonce>` and a Wikipedia URL (0.7–1.7 s); a commit about 40 s old came back from `api.github.com`.
- Returns the raw body only (HTML, JSON, text): no status, content type or final URL. Redirects are followed; a 1.55 MB page came back whole.
- Upstream 404/500, PDF, images, binary, bad URLs and pages slower than ~7 s all return an opaque `500 INTERNAL`. `api.github.com` started returning 500 after a few calls (likely upstream rate limiting).
- The result is reused per exact URL for at least 5 minutes even with `liveFetch:true`; a changed query string forces a refetch.
- No model quota observed.

## Audio in agy

agy's live dictation (`mic-serve`, `audiotranscribe`) streams microphone audio over the gRPC Live API `google.gca.aicode.v1main.PredictionService/BidiGenerateContent` on `aicode.googleapis.com` to `models/proactive-observer-v10`. It needs the `…/auth/aicode` scope, which the plugin does not request. The plugin transcribes recorded audio by sending the whole file inline to `gemini-3.8-flash-tiered` instead.

## Inline audio size (2026-11-06)

- Recorded audio is sent as one `inlineData` part on `POST v1internal:streamGenerateContent?alt=sse`. There is no chunking.
- Documented Gemini inline limit is ~20 MB for the whole request. Audio is base64-encoded (×4/3) plus prompt/envelope, so the plugin caps the raw `req.buffer` at `INLINE_AUDIO_MAX_BYTES` = 15 532 032 bytes (~14.81 MiB): `floor((20 MiB − 256 KiB) × 3/4)`. The 20 MiB figure is `INLINE_AUDIO_REQUEST_MAX_BYTES`. Checked before encoding or any network call.
- Live probes of 5, 15 and 25 MB clips through `transcribeAudio` were **not** run (no live auth, no quota authorization, no large fixtures). The upstream cutoff is unverified; do not treat the base64-aware raw cap as a measured `v1internal` result.
- No `v1internal` media upload RPC in the agy 1.5.1 or 1.5.2 fingerprints: used RPCs stay the five plugin endpoints; the only upload-named other RPC is still `uploadPerformanceProfile` (client telemetry, not media). There is no `uploadFile` / Files API style method. The `x-goog-upload-*` markers and unused host `scotty.googleapis.com` belong to aicode remote-project upload ([agy 1.5.2](#agy-152-2026-11-06)), not a probed audio upload API. `fileData.fileUri` on this RPC reads some HTTP URLs (JSON/text), not an uploaded blob handle (see [Turn envelope](#turn-envelope)). Live dictation is a separate gRPC path and stays out of scope ([features.md](features.md#out-of-scope-by-decision)).

## agy 1.5.2 (2026-11-06)

Investigation only; the plugin was not adopted onto 1.5.2 in this change. Evidence: installed `agy --version` = `1.5.2` (`~/.local/bin/agy`, linux-x64, SHA-256 `da1751e7658469fa80bf36eda2c60ee61216d8e42b735a184382ba31d1f6b88e`); `npm run sync:upstream -- --json` against `upstream/agy-fingerprints/linux-x64.json` (1.5.1) returned verdict 20 `REVIEW_NEEDED` on 2026-11-06. GitHub `google-antigravity/antigravity-cli` latest release reported `1.5.2` (`semverComparison: equal`).

Changed fingerprint fields: `cliVersion` `1.5.1` → `1.5.2`; `binarySha256` `72738cf0445918483956a5f0da33abdfcfb21a12dd9a421fd57d063782826669` → `da1751e7…` (full digest above); `latestChangelog`; `googleHosts.other` gained `5aiplatform.googleapis.com`; `requestShapeMarkers` gained `x-goog-upload-url`. Unchanged: used RPCs (`fetchAvailableModels`, `loadCodeAssist`, `retrieveUserQuota`, `retrieveUserQuotaSummary`, `streamGenerateContent`), used hosts, `rpcNames.other`, `oauthClientPrefixes`, `consumerClientParity`, `oauthScopes`, `subcommands`, `models`, and every previous request-shape marker.

`agy changelog` (1.5.2 heading, read in full): CLI, TUI, sandbox, MCP, plugin-install security, Remote Control, and `--remote-agent` only. The protocol-adjacent bullets are cloud-plugin skills in `--remote-agent` sessions, a fix so PDFs, other binaries, and files larger than about 8 MB upload to a remote project from `/projects` in those sessions, and CJK spacing in live voice dictation (Live API / `mic-serve`; the plugin does not use that path). Nothing in the heading describes a change to the five plugin RPCs, OAuth clients or scopes, the chat envelope, quota windows, or thinking levels.

`agy models` (2026-11-06, this account; the command may fetch the live list) printed the same 13 variants as the 1.5.1 fingerprint `models` field: `gemini-4-argon-{low,medium,high}`, `gemini-3.8-flash-{low,medium,high}`, `claude-opus-5-5-{low,medium,high}`, `claude-sonnet-5-5-{low,medium,high}`, `gpt-oss-120b-medium`. That matches the catalog the plugin already publishes ([features.md](features.md#models)); no new chat model ids. Static analysis of `agy` still cannot prove what `fetchAvailableModels` returns for another account.

### `x-goog-upload-url`

Same Google resumable-upload header family as the 1.5.1 markers (`X-Goog-Upload-Command`, `X-Goog-Upload-Protocol` with `const:"resumable"`, `X-Goog-Upload-Header-Content-Length`, `X-Goog-Upload-Header-Content-Type`, `X-Goog-User-Project`). The lowercase `x-goog-upload-url` marker is new relative to the 1.5.1 baseline (the 1.5.1 binary was not kept on this machine; the comparison is the committed fingerprint). Neighbors in the 1.5.2 binary, static strings only:

- `uploadProjectFile` is adjacent to `X-Goog-Upload-URL` in the string table.
- Error text: `uploadProjectFile Scotty start response missing X-Goog-Upload-URL`.
- Go symbols: `UploadRemoteAgentProjectFileScotty`, `validateSameOriginUploadURL`, `IsScottyStartError`.
- Protobuf `google.gca.aicode.v1main.UploadProjectFile` / `UploadProjectFileRequest` / `UploadProjectFileResponse`, unused host `scotty.googleapis.com`, HTTP path `/{$api_version}/remote:uploadProjectFile`.

That is the aicode remote-project file upload used by `--remote-agent` `/projects`, which matches the 1.5.2 changelog upload fix. It is not a `v1internal` media-upload RPC and is not on the plugin's request path (the plugin does not request the `aicode` scope). No plugin change.

### `5aiplatform.googleapis.com`

Not a reachable host. Three hits, all protobuf resource-type annotations `aiplatform.googleapis.com/EnvironmentTemplateRevision` (53 bytes) on `google.cloud.aiplatform.v1beta1` `RemoteEnvironment` fields (`template_revision`, `resolved_template_revision`, `catalog_base`). The length prefix before that string is `0x35` (ASCII `5`). `analyzeBinary` in `scripts/sync-upstream-vars.js` walks back through `[a-z0-9.-]` from `.googleapis.com` and accepts a previous byte of `0x0a` (protobuf length-delimited tag), so it records `5aiplatform.googleapis.com`. Unused-host extraction noise next to the already-listed `aiplatform.googleapis.com`. The descriptors belong to remote-environment / cloud-plugin templates, not a plugin endpoint.

### Plugin surface

No fingerprint or changelog evidence that 1.5.2 changes what the plugin sends or relies on: the five used RPCs, used Google hosts, OAuth client prefixes and consumer-client parity, the five plugin scopes, envelope identity markers (`ideType`, `ANTIGRAVITY`, …), or the model ids the plugin publishes. Thinking-level names already documented (`thinkingLevel`, `EXTRA_HIGH`, `MINIMAL`, …) are still present in the binary; quota RPCs are unchanged. Live quota lookups and live turns were not run.

Verdict: no plugin code change is needed for 1.5.2. Adoption (`CLI_VERSION` 1.5.2, plugin `1.5.200`, release-table row, baseline rewrite through the sync script) is a separate issue after the shared baseline.

## Request sanitization

Upstream parses tool schemas into protobuf and rejects type arrays and unions with `400 INVALID_ARGUMENT: Proto field is not repeating, cannot start list`. `cleanJsonSchema` (applied to the v1internal envelope and to OpenAI-style `wireTools`):

1. `type: ["x", "null"]` → `type: x, nullable: true`.
2. `anyOf`/`oneOf` with a null branch → the non-null branch, `nullable: true`.
3. Other unions → first viable branch, keeping the parent description.
4. Non-string enum values → strings, deduplicated.
5. Missing `type` → inferred (`object` from properties, `array` from items, `string` from enum), default `string`.

Tool names must match `^[a-zA-Z_][a-zA-Z0-9_]{0,63}$`. `ToolNameMapper.toSafeName` replaces invalid characters with `_`, prefixes `_` before a leading digit, resolves collisions with `_1`, `_2` (base truncated to stay within 64), and `toOriginalName` restores the host name. The native-tool allowlist checks the original name.

## Errors

- `extractErrorSummary` reduces Google JSON errors to `HTTP <status> <STATUS>: <message>`.
- 429 (`classifyGoogleRpc429`), only `ErrorInfo` with domain matching `cloudcode|cloudaicompanion`:
  - `QUOTA_EXHAUSTED`: terminal; reset from `quotaResetTimeStamp`, `quotaResetDelay` or `Resets in …`.
  - `RATE_LIMIT_EXCEEDED`, `MODEL_CAPACITY_EXHAUSTED`: transient; delay from `RetryInfo.retryDelay` or `Please retry in Xs`, clamped to 100 ms–10 s, 2 attempts.
- Argon with 0 credits: 429 `RESOURCE_EXHAUSTED` on `gemini-4-argon-*`. The 404 `Requested entity was not found` seen earlier comes from the dead `MODEL_PLACEHOLDER_M124` alias, not from quota (see [Model ids](#model-ids-2026-11-02)).
- Image models other than `gemini-3.1-flash-image` (`imagen-*`, `gemini-3-pro-image`, `gemini-2.5-flash-image`): 404.

## Video generation (probed 2026-11-07)

Not available on `v1internal` in the forms tried (client identity `antigravity/cli/1.5.2`, subscription login). This covers only the ids and RPC names below, so re-probe if `fetchAvailableModels` gains a video routing list.

- `fetchAvailableModels`: 26 models, no video routing list, no video or `veo-` model id, no `veo-` string anywhere in the payload.
- `streamGenerateContent` with `responseModalities: ["VIDEO"]`:
  - `veo-3.1-fast-generate-preview`, `veo-3.1-generate-preview`, `veo-3.1-lite-generate-preview`: 404 `NOT_FOUND`, the same as the invented control id `veo-probe-does-not-exist`.
  - `gemini-3.1-flash-image`: 200 with an `image/jpeg` part and no video part.
  - `gemini-3.8-flash-tiered`: 200 with text saying it cannot generate video files.
- `v1internal:predictLongRunning` and `v1internal:generateVideos`: non-JSON 404, the same as the invented control RPC `probeRpcDoesNotExist`.

### Extended research (2026-11-07; quota-stopped)

The original first-probe section above is preserved unchanged. Its matching-404 results do **not** establish general upstream unavailability. This extension is incomplete because the mandatory quota stop fired; it does not justify implementing video generation or closing #7 as unavailable.

#### Provenance and static trace

- Research branch starts at `ff1a2490bb85ce69971c37cbe8f1ea680475f3e2`. Live probes used existing source at `1d79ceb178138a959658034a58feead0aee18cbd`, plugin `1.5.202`, rebuilt before the separately authorized smoke. The probe client remains `antigravity/cli/1.5.2 darwin/arm64`; no identity or runtime update was made.
- Inspected agy: **1.5.3**, Mach-O arm64, 208900592 bytes, SHA-256 `5e4b545bff4a83a93354fc50c54631cf3e8cd02e1a469087af00929f3fdc4d51`. Allowed `--version`, `--help`, and `changelog` were used; no update command. Changelog contains dedicated image-generator-subagent plumbing and media-input fixes, not proof of a video-generation route.
- Static Go metadata: 183140 functions. Mach-O's on-disk Go `textStart` is zero before relocation; direct ARM64 call decoding used the `__text` address, not zero. `GetImageGenerationModelIds` belongs to `FetchAvailableModelsResponse` and exposes the image-routing list; the model-selection helper directly calls `cache.(*Cache).Get`. The exact cached-field load connecting this getter to the helper was not reconstructed, so that data-flow link remains unverified. The getter can be inlined: a getter symbol alone is not a demonstrated call edge.
- Application path: `modelapiccpa.(*Client).GetImageGeneration` → `codeassistclient.(*CodeAssistClient).GetImageGeneration` → `getImageGenerationModelID`, `getModelInfoByModelId`, and `GenerateContent`. `GenerateContent` contains routing branches for CCPA, gateway, AICode, business AICode and Vertex AI; its CCPA branch calls `generateContentFromCCPA` → `marshalCCPARequest` / `postCodeAssistBackendRequest`. The binary also contains `v1internal:generateContent` and `v1internal:streamGenerateContent`. This establishes dedicated image application plumbing, **not** which dynamic branch/host a particular agy turn uses.
- Additional application image path: `oneharness/internal/tools.(*GenerateImageTool).Execute` calls media reading/saving and `core.CallWithRetry`; `jetski/cortex/handlers/imagegen.(*GenerateImageHandler).Handle` has artifact saving and `generator.RunWithAPIRetry`. These are distinct from linked libraries. The alternative `model_api/backends/geminiapi.(*Client).GetImageGeneration` calls `newGenAIClient`, `imageGenerationModelName` and the GenAI SDK's `Models.GenerateContent`.
- No matching Jetski `GenerateVideo`, `videogen` or `VideoGenerationModelIds` function was found; no `veo-` string, `NewGenerateVideoTool`, `ActionGenerateVideo` or `CortexStepGenerateVideo` string. Linked **vendored** `genai.Models.GenerateVideos`, `GenerateVideosFromSource`, `GenerateVideosOperation`, `:predictLongRunning`, `:fetchPredictOperation` and aiplatform `GenerateVideoResponse` remain leads only. This search does not exclude remote tools, constructed values or another application path.
- `upstream/agy-fingerprint.json` remains the 1.5.2 baseline. Its CCPA catalog/experiment/admin RPCs motivated the calls below. AICode/business hosts and applet/scotty hosts were not called: the allowed-host list was not widened. No SDK symbol or alternate routing branch was treated as login entitlement.

#### Read-only catalogs and complete new request ledger

Auth came **only** from `resolveSmokeProfile({authSource: "openclaw", agentId: "main"})` in the existing `scripts/integration-smoke.js`. Existing access tokens and project values stayed in memory. No direct store/token reads, token copying, refresh/new login, cookies, scopes, paid key, config/gateway change or redirect following. Scratch scripts and sanitized summaries stayed in `.tmp/`; no raw response or media is committed.

Both CCPA hosts returned 26 raw model entries, no `veo-` string and no video-generation routing list. Matched fields/values: `imageGenerationModelIds: ["gemini-3.1-flash-image"]`, `supportsVideo: true`, and true MIME entries `video/mp4`, `video/webm`, `video/jpeg2000`, `video/videoframe/jpeg2000`, `video/text/timestamp`, `video/audio/s16le`, `video/audio/wav`. These media-input/understanding flags do **not** demonstrate video output. `listExperiments` returned `experimentIds` and `flags`; the field-name traversal yielded no video/veo-named field, but string-valued flag semantics were not exhaustively classified. `fetchAdminControls` returned `{}`. `listModelConfigs` rejected `project`; one schema-informed read-only correction to `{}` also returned 400. Its valid request contract and model contents remain unknown; no more body guessing was attempted.

Each row below is one actual HTTP request. Catalog controls are invented RPCs. Generation candidates are host/path/model combinations; each was sent once, with no retry. `{project}` means the existing in-memory value, never a committed identifier. Catalog responses and generation requests used JSON; no browser session.

| Host | Path (POST) | Model id | Body shape | Control | Result |
|---|---|---|---|---|---|
| `daily-cloudcode-pa.googleapis.com` | `/v1internal:fetchAvailableModels` | — | `{project}` | no | 200; 26 models, no veo string |
| `daily-cloudcode-pa.googleapis.com` | `/v1internal:listModelConfigs` | — | `{project}` | no | 400 INVALID_ARGUMENT; project rejected |
| `daily-cloudcode-pa.googleapis.com` | `/v1internal:listExperiments` | — | `{project}` | no | 200; experimentIds, flags |
| `daily-cloudcode-pa.googleapis.com` | `/v1internal:fetchAdminControls` | — | `{project}` | no | 200; empty object |
| `daily-cloudcode-pa.googleapis.com` | `/v1internal:videoResearchNoSuchRpc` | — | `{project}` | yes | 404; non-JSON |
| `cloudcode-pa.googleapis.com` | `/v1internal:fetchAvailableModels` | — | `{project}` | no | 200; 26 models, no veo string |
| `cloudcode-pa.googleapis.com` | `/v1internal:listModelConfigs` | — | `{project}` | no | 400 INVALID_ARGUMENT; project rejected |
| `cloudcode-pa.googleapis.com` | `/v1internal:listExperiments` | — | `{project}` | no | 200; experimentIds, flags |
| `cloudcode-pa.googleapis.com` | `/v1internal:fetchAdminControls` | — | `{project}` | no | 200; empty object |
| `cloudcode-pa.googleapis.com` | `/v1internal:videoResearchNoSuchRpc` | — | `{project}` | yes | 404; non-JSON |
| `daily-cloudcode-pa.googleapis.com` | `/v1internal:listModelConfigs` | — | `{}` | no | 400 INVALID_ARGUMENT; request contract unresolved |
| `cloudcode-pa.googleapis.com` | `/v1internal:listModelConfigs` | — | `{}` | no | 400 INVALID_ARGUMENT; request contract unresolved |
| `daily-cloudcode-pa.googleapis.com` | `/v1internal:generateContent` | `veo-research-does-not-exist` | `{project,model,request}` | yes | 404 NOT_FOUND |
| `daily-cloudcode-pa.googleapis.com` | `/v1internal:generateContent` | `veo-3.1-fast-generate-preview` | `{project,model,request}` | no | 404 NOT_FOUND |
| `daily-cloudcode-pa.googleapis.com` | `/v1internal:generateContent` | `veo-3.1-generate-preview` | `{project,model,request}` | no | 404 NOT_FOUND |
| `daily-cloudcode-pa.googleapis.com` | `/v1internal:generateContent` | `veo-3.1-lite-generate-preview` | `{project,model,request}` | no | 404 NOT_FOUND |
| `cloudcode-pa.googleapis.com` | `/v1internal:generateContent` | `veo-research-does-not-exist` | `{project,model,request}` | yes | 429 RESOURCE_EXHAUSTED; STOP |

Generation body: `{project, model, request: {contents: [{role: "user", parts: [{text: "Generate a short silent video of a red ball moving left to right on a plain white background."}]}], generationConfig: {responseModalities: ["VIDEO"]}}}`. On daily CCPA, all three named models and the invented model returned identical `404 NOT_FOUND: Requested entity was not found.` This says only that these forms did not distinguish real ids from the control. The first cloudcode generation-shaped request, itself the invented-model control, returned **429 RESOURCE_EXHAUSTED**, `Resource has been exhausted (e.g. check quota).` It gives no positive model/route evidence.

Accounting for this extension: **12 read-only requests + 5 generation-shaped POSTs** (3 named-model candidates, 2 invented-model controls). No 401/403 occurred; 400 is separate from 404; 429 is a quota stop, not an availability verdict. No 2xx generation/operation, polling, video download or file validation occurred. The maintainer-authorized eight-check smoke completed on 2026-11-07 at **19:21:36 Asia/Nicosia**, from its embedded report timestamp. Authorization was the maintainer's conditional build/one-smoke instruction preceding identification of the correct environment. It preceded this resumed research in the conversation chronology; per-request probe timestamps were not recorded in the sanitized evidence, so exact probe times cannot be established from those artifacts. The later 19:46 CI completion is not a probe timestamp. The smoke was not rerun and contains no video-generation check.

#### Interrupted work

The quota stop left 14 of the 19 original route-plan rows unsent and both prompted agy checks unrun. No agent tool inventory, permission-prompt observation or video file was obtained. Unsent plans and proposed commands are tracked only in PR #24, not duplicated here.

#### Public Gemini and Antigravity documentation (read 2026-11-07)

- [Google One plan comparison](https://one.google.com/intl/en_us/about/google-ai-plans/): Google AI **Plus, Pro and Ultra** include Gemini/Flow video access at different limits; the comparison names **Omni Flash** for video-generation model access. Antigravity is separately described as an agent/coding product with plan-dependent model/rate limits. The maintainer's actual plan remains unrecorded; no plan was inferred from login success.
- [Gemini subscriptions](https://gemini.google/subscriptions/): Plus and Pro explicitly include video generation, Ultra includes Pro's features with higher limits. The same fetched page's FAQ still names a Pro **Veo 3.1 Lite** trial and Ultra **Veo 3.1**, while its Flow sections name **Gemini Omni Flash**. Preserve this documentation discrepancy instead of inventing one authoritative app model for every plan/region.
- [Gemini API video guide](https://aistudio.google.com/docs/video): current recommended video model is **`gemini-omni-1.2-flash`**, with 3–15-second native-audio video and conversational editing through the Interactions API. It explicitly says `veo-3.1-generate-preview`, `veo-3.1-fast-generate-preview` and `veo-3.1-lite-generate-preview` were **shut down in the Gemini API on 2026-10-22**. This is public-API retirement evidence, not proof of identical CCPA alias lifecycle or the cause of the CCPA 404s. Omni was discovered after the quota stop and was not probed.
- [Interactions API](https://aistudio.google.com/docs/interactions): a separate API, generally available since June 2026; interactions are stored by default, `store=false` opts out. A future generation-only investigation must avoid enabling persisted conversation state silently. This guide's supported-model table does not list Omni although the video guide names it; the exact current video request contract needs its specific guide, not inference from generic examples.
- [Antigravity plans](https://antigravity.google/docs/plans) and [models](https://antigravity.google/docs/models): baseline CLI/product access, reasoning-model choices, plan quotas and optional AI-credit overages; the additional-model list names **Nano Banana 2 for the generative image tool**, not a video tool. These opened pages do not document a video-generation endpoint or transfer the Gemini app's video entitlement to this OAuth login. Absence from these pages is not proof of general upstream absence.
- [Gemini API billing](https://aistudio.google.com/docs/billing) describes project/Cloud Billing and prepay/postpay tiers, not automatic Antigravity token entitlement. [Google AI plan credits in AI Studio](https://aistudio.google.com/learn/use-google-ai-plan-credits-in-ai-studio), updated 2026-11-03, says eligible Pro/Ultra plans include monthly **Google Cloud** credits usable in AI Studio only after account linking and at least a **$5 prepaid deposit**; consumer Google One AI credits are separate and unsupported there. Thus “subscription benefits can never fund any API” would also be false. No billing link, deposit, new login/key, scope change or API entitlement was attempted or established here.

#### Quota-first follow-up (2026-11-07)

The maintainer authorized a quota-first resumption. Local `agy --version` now reports **1.5.3**, but the permitted existing smoke loader `resolveSmokeProfile({authSource: "openclaw", agentId: "main"})` returned **no profile** in the requested execution environment. This is distinct from the maintainer's report that agy is signed in; an agy login does not establish an OpenClaw auth-store profile. No alternate auth source, direct credential read, new login or credential transfer was attempted.

New authenticated HTTP requests: **0**. `retrieveUserQuotaSummary` was **not sent**, so current quota and reset time are unknown. The ordered catalog rerun, Interactions application trace, Omni/deprecation contract review, two prompted runs and Omni/control matrix were **not run in this follow-up**; prompted agy was not used to bypass the quota-first prerequisite. The previous request ledger above remains unchanged.

#### Remaining proof, approvals and recommendation for #7

**Recommendation: keep #7 open; do not implement yet and do not close it as unavailable upstream.** No real/playable video was produced. Matched 404s, vendored SDK symbols, input-media flags and app plan pages cannot establish either route success or global unavailability. Unknowns include a current Omni route/entitlement under this login, valid `listModelConfigs` input, untried endpoint shapes, remote tools, and async polling/delivery/quota behavior.

No playable video or current API entitlement has been established; pending research is tracked in PR #24.

## Quota payloads

- `retrieveUserQuotaSummary`: groups with buckets `{ remainingFraction, resetTime, window | bucketId | displayName }`; window enums vary (`weekly`/`WEEKLY`, `5h`/`FIVE_HOUR`) and are normalized.
- The app shows remaining as `ceil(remainingFraction * 100)`.
- `retrieveUserQuota`: per-model buckets.
- `fetchAvailableModels`: ~180 KB with full model definitions; ~26 variants that collapse to the published catalog.
