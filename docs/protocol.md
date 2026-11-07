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
- Known-list audit (2026-11-08, [#28](https://github.com/predator-1/openclaw-antigravity-oauth/issues/28)): plain-slug entries use the existing dated [Routing lists observation](#fetchavailablemodels-schema-from-agys-protos), not invented proto aliases. Live smoke 2026-11-08 (OpenClaw login, `antigravity/cli/1.5.3`, PR head `9ee914c`): 21/21 passed; catalog `Discovered 7 models (added: 0, removed: 0)`, so all seven known ids are published and none is new. `gemini-3.1-flash-lite` stays legacy-filtered and is not a known id.

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

## agy 1.5.3 (2026-11-07)

Dry sync from main returned mechanical SAFE (10): CLI 1.5.2 → 1.5.3, latest changelog, and only unused host `fonts.googleapis.com` added; used hosts/RPCs, OAuth parity/scopes, request markers, subcommands and model ids unchanged. Installed ELF amd64 SHA-256: `7ca212748ca0dfda718efbc39a776a104472e7e9344d4b6ea147c543684f96a3`.

`agy changelog`, full 18-bullet 1.5.3 review: Go HTTP/2 header-timeout retries and enterprise gateway `/v1beta` normalization change client transport/routing behavior; Vertex changes only error wording. Remaining changes concern CLI UI/status JSON, plugin manifests/hooks/auth notifications, local/remote file tools, ACP lifecycle and terminal security. No video-generation mention or subscription OAuth/RPC/schema change identified. Per [upstream-sync policy](upstream-sync.md#procedure-also-the-automation-runbook), treat adoption as investigated REVIEW_NEEDED (#25), not automatic SAFE.

Timeout exposure: plugin defaults to Node fetch, not the CLI Go HTTP/2 client; this Node 24.22.1 / Undici 7.30.1 defaults to 300 s header timeout and HTTP/1.1 ([client](https://github.com/nodejs/undici/blob/v7.30.1/lib/dispatcher/client.js), [connector](https://github.com/nodejs/undici/blob/v7.30.1/lib/core/connect.js)). Five network-free checks show no intrinsic 60 s plugin deadline, explicit caller deadlines honored, and both chat/image transport failures surfaced without retry. Image budget remains 180 s. Custom host transports may differ; no same default 60 s defect or production incident was established, so no separate gap issue was filed. No transport fix in this adoption.

Adopted with `npm run sync:upstream:apply -- --json --investigated=25`: plugin `1.5.300`, CLI identity `1.5.3`; script returned `applied:true` with mechanical verdict 10 after the required manual review. Post-apply dry sync returned 0 `NO_CHANGE`. No other OAuth/client constants changed.

Live integration: **NOT RUN**; no new account-probe authorization assumed. A passing new-identity smoke remains required before merge.

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
- Reset-delay parser (2026-11-07, [#18](https://github.com/predator-1/openclaw-antigravity-oauth/issues/18)): accepts complete positive `h`/`m`/`s`/`ms` token sequences with fractions; malformed, non-finite or out-of-Date-range values give no reset time. ISO timestamps have millisecond precision. This is a locally tested Go-style-format assumption, not verification of the exact upstream duration format; no new live probe. Timestamp precedence and retry classification are unchanged.
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

### Extended research (2026-11-07): no route found through this login

No video route or file was found through this login in these forms; general upstream absence is **not established**. Sources: [reviewed results and Final probe](https://github.com/predator-1/openclaw-antigravity-oauth/pull/24), [Omni](https://aistudio.google.com/docs/omni), [deprecations](https://aistudio.google.com/docs/deprecations), [Interactions contract](https://aistudio.google.com/api-reference/interactions-api/create-interaction), [Antigravity models](https://antigravity.google/docs/models).
All runs below: 2026-11-07, client `antigravity/cli/1.5.2`. E1: OpenClaw login, darwin/arm64, plugin 1.5.202. E2: smoke's agy auth source, linux/amd64, default project fallback (not managed; account not recorded). **F: Final probe, 20:41 Asia/Nicosia, maintainer's OpenClaw login, darwin/arm64, plugin 1.5.203, real managed project used; identifier omitted.**
Hosts: D = `daily-cloudcode-pa.googleapis.com`; C = `cloudcode-pa.googleapis.com`; G = `generativelanguage.googleapis.com`; A = `aiplatform.googleapis.com`.
Models: O = `gemini-omni-1.2-flash`; X = invented `gemini-omni-research-does-not-exist`; Y = invented `veo-research-does-not-exist`; V = `veo-3.1-fast-generate-preview`, `veo-3.1-generate-preview`, `veo-3.1-lite-generate-preview`.
One table of **35 actual requests**; grouped rows retain counts. O/X means one request per model per listed run; D/C means one per host unless both bodies are specified. Controls are identified explicitly.

| Run | Host | Path (POST) | Model / control | Requests | Result |
|---|---|---|---|---|---|
| E2,F | D | `/v1internal:retrieveUserQuotaSummary` | — | 2 | 200; five nonempty windows each; F remaining 0.645–0.989 |
| E1,E2,F | D | `/v1internal:fetchAvailableModels` | — | 3 | 200; 26 models each; F: no omni/veo-/interaction string or video routing key; `imageGenerationModelIds: ["gemini-3.1-flash-image"]` |
| E1 | C | `/v1internal:fetchAvailableModels` | — | 1 | 200; 26 models, no veo string/video routing list |
| E1 | D,C | `/v1internal:listModelConfigs` | — | 4 | 400 INVALID_ARGUMENT; `{project}` and `{}` each once per host |
| E1 | D,C | `/v1internal:listExperiments` | — | 2 | 200; experimentIds and flags; video/veo field-name scan negative, flag-value semantics unresolved |
| E1 | D,C | `/v1internal:fetchAdminControls` | — | 2 | 200; empty object |
| E1 | D,C | `/v1internal:videoResearchNoSuchRpc` | invented RPC control | 2 | non-JSON 404 |
| E1 | D | `/v1internal:generateContent` | Y (control) | 1 | 404 NOT_FOUND |
| E1 | D | `/v1internal:generateContent` | V | 3 | 404 NOT_FOUND each, same as Y |
| E1 | C | `/v1internal:generateContent` | Y (control) | 1 | 429 RESOURCE_EXHAUSTED |
| E2,F | D | `/v1internal:generateContent` | O/X (control X) | 4 | 404 NOT_FOUND each, same as control |
| E2 | D | `/v1beta/interactions` | O/X (control X) | 2 | non-JSON 404 each |
| E2 | G | `/v1beta/models/gemini-omni-research-does-not-exist:generateContent` | X (control) | 1 | 403 PERMISSION_DENIED; ACCESS_TOKEN_SCOPE_INSUFFICIENT |
| E2 | A | `/v1beta1/publishers/google/models/{model}:generateContent` | O/X (control X) | 2 | 400 INVALID_ARGUMENT; RESOURCE_PROJECT_INVALID each |
| E2 | A | `/v1beta/interactions` | O/X (control X) | 2 | non-JSON 404 each |
| E2 | C | `/v1internal:generateContent` | X (control) | 1 | 429 RESOURCE_EXHAUSTED |
| F | D | `/v1internal:streamGenerateContent?alt=sse` | O/X (control X) | 2 | 404 NOT_FOUND each, same as control |

F sent **six requests once each**: quota, catalog and four generation/control requests. Generation body: `{project,model,request:{contents,generationConfig:{responseModalities:["VIDEO"]}}}`; a different Omni body may be needed. Equal 404s do not distinguish the real model from an invented one.
C returned 429 on its **first generation request in both earlier runs**, on invented controls, with no detailed reason, delay or reset while quota summary showed remaining quota. This **looks host-specific, not proven**; the plugin does not use C. No 401 occurred; 400/403/404/429 are distinct, not interchangeable availability verdicts.
E2 Interactions requests used `store:false,background:false,stream:false`; those paths on D/A are undocumented cross-host hypotheses. `store` is not a generateContent field. G's scope403 does not establish model entitlement; no new scope/key/login/billing was attempted.
F `agy -p` (agy 1.5.3, darwin/arm64): once, no extra flags, empty directory; exit0, no MP4/file. It reported `generate_image` as its only media generator and no video tool; its shell attempt was refused by a user-configured deny rule. **Agent output, not proof of backend capability.** E2's two earlier prompts also produced no media and claimed image generation/media inspection but no video/audio generator.
Static agy 1.5.3 has image plumbing and application Interactions translation; no video application route or Interactions caller-to-host binding was established. Vendored video SDK symbols are leads only.
Unknown: another Omni body/route, server-side tools, valid `listModelConfigs` input and Interactions transport. No real/playable video was obtained. **#7 closed 2026-11-07 as no route through this login; re-probe when `fetchAvailableModels` or the agy changelog gains video.** No general upstream-absence conclusion follows.

## Quota payloads

- `retrieveUserQuotaSummary`: groups with buckets `{ remainingFraction, resetTime, window | bucketId | displayName }`; window enums vary (`weekly`/`WEEKLY`, `5h`/`FIVE_HOUR`) and are normalized.
- The app shows remaining as `ceil(remainingFraction * 100)`.
- `retrieveUserQuota`: per-model buckets.
- `fetchAvailableModels`: ~180 KB with full model definitions; ~26 variants that collapse to the published catalog.
