# Architecture

OpenClaw stores the credential, sends the prompt and executes every tool. The plugin does sign-in, model listing, and one HTTPS call per turn to the Antigravity subscription. There is no local agent and no CLI. Source comments cite the sections below as `Contract §n`.

## Contract

### §1 Product

- Plugin id `openclaw-antigravity-oauth`, provider id `antigravity`, model refs `antigravity/<id>`.
- An OpenClaw provider plugin: no `cliBackends`, no binary.
- `package.json`: `openclaw.extensions` = `./dist/index.js`, `openclaw.compat.pluginApi` = `>=2026.10.8`, `openclaw.compat.minGatewayVersion` = `2026.10.8`.
- `openclaw.plugin.json`: `providers: ["antigravity"]`, `activation.onStartup: true` (required so host 2026.10.x keeps `createStreamFn` in the active registry; see [features.md](features.md#plugin-stream-transport)), `autoEnableWhenConfiguredProviders: ["antigravity"]`, empty strict `configSchema`.
- Entry: `definePluginEntry` with a synchronous `register(api)` (`activate` alias). In `setup-only` mode `api.runtime` is a throwing proxy, so `register` only calls the `api.register*` functions.
- The plugin never changes `agents.defaults.model.primary` or fallbacks.

### §2 Authorization

OAuth subscription login only, stored in OpenClaw's auth profile store. Refresh without a browser until revoked; a failed refresh fails the turn with an authentication error. Login never opens a browser during a turn, never prints tokens or auth headers, never writes consumer CLI settings. Ineligible accounts exit with `subscription not eligible` and leave no profile. Details: [auth.md](auth.md).

### §3 Catalog

Listed models are the account's subscription chat models only: stable id, display name, context window, max output, reasoning levels (`off` only when reasoning can be disabled). Models marked `disabled` or listed in `deprecatedModelIds` are omitted. No invented ids; no image, video, audio, embedding or speech models. Failed or empty discovery invents nothing and does not switch to another Google API. An unknown id fails the turn before any billable call. Usage percentages the API omits are reported as omitted, never invented.

### §4 Turn

- Request contents are exactly what the host supplies: system prompt, conversation, host-filtered tools. Do not add, rename (beyond the reversible upstream-safe mapping) or remove tools; do not read the working directory or prepend rules, skills or memory from disk.
- Consumer CLI tools are never attached. If the endpoint offers them the turn fails with `native tools offered`; a call to a tool the host did not send fails with `native tool refused: <name>` and executes nothing.
- **§4.1 Response:** streamed assistant text plus usage, or complete tool calls with host names and arguments, or a failure (auth, unknown model, quota, timeout, native tool). An empty 200 reply or a timeout is a failure. Upstream `thought: true` parts are streamed as host thinking/reasoning events, never mixed into answer text ([features.md](features.md#model-reasoning-display)).
- **§4.2 Transport:** the plugin maps to `v1internal:streamGenerateContent` ([protocol.md](protocol.md)). The bearer token goes only to Google hosts. One request per turn; extra calls only for bounded transient retries, the 401 refresh retry, and the quota lookup behind the in-chat quota notice. Reasoning effort is passed through; an unsupported level fails the turn.

### §5 Files and processes

A turn writes only what OpenClaw writes for its auth profile and caches. Never touched: `~/.gemini` or consumer CLI history, settings, MCP registry, hooks, plugins; the user's working directory. No `agy`, browser, updater, microphone or remote-control process.

### §6 Acceptance

`test/acceptance.test.ts` covers, without the consumer CLI: 1 login stores a profile without leaking tokens and keeps the primary model; 2 ineligible account; 3 catalog is chat models only; 4 `pong` text turn with zero tool calls; 5 host tool `lookup_weather` called with untouched arguments; 6 native tool refusal.

## `src/` module map

| file | responsibility |
|---|---|
| `index.ts` | plugin entry, `createAntigravityProvider` (auth methods, catalog, `createStreamFn`, `wrapSimpleCompletionStreamFn`, `resolveThinkingProfile`, `refreshOAuth`, `formatApiKey`, `classifyFailoverReason`, `buildReplayPolicy`, usage snapshot and labels), registration of the five providers |
| `auth.ts` | device code and PKCE login, eligibility and project lookup, refresh with retry, `parseFormattedApiKey`, in-memory store for direct use |
| `catalog.ts` | `CatalogService` (discovery, filtering, effort-variant collapse, `resolveModelForTurn`), id maps and display overrides, quota window inference |
| `turn.ts` | `executeTurn`: request envelope, `cleanJsonSchema`, `ToolNameMapper`, native-tool guard, SSE parsing, 429 classification and retry, error summaries |
| `search.ts` | `antigravity-search` web search provider |
| `fetch.ts` | `antigravity-fetch` web-fetch provider |
| `image.ts` | image generation provider |
| `sanitize.ts` | shared credential and account-identifier error redaction for runtime and smoke |
| `media.ts` | media understanding provider (image, audio, video, pdf) |
| `constants.ts` | endpoints, OAuth client and scopes, `CLI_VERSION`, User-Agent (`mapAgyOsArch`: honest host os/arch), native tool list, non-chat filters |
| `types.ts`, `ambient.d.ts` | shared types, host SDK module declarations |
| `utils.ts` | `unwrapCandidates` |

Scripts: `sync-models.js` (config sync), `sync-upstream-vars.js` (agy fingerprint), `integration-smoke.js` (live checks), `verify-package.js` (package and release-commit checks), `resolve-npm.js`, `plugin-version.js`, `release-notes.js`, `clean.js`.
