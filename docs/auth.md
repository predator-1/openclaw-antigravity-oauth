# Auth

OAuth 2.0 only (`--method oauth`). No API key method; `GEMINI_API_KEY`, Vertex credentials and `gcloud` ADC are never read.

## Login

```bash
openclaw models auth login --provider antigravity --method oauth
```

1. Device code (`oauth2.googleapis.com/device/code`): prints URL and code, polls `/token`.
2. If the client refuses device code (400/401), PKCE `S256` against `accounts.google.com/o/oauth2/v2/auth`:
   - local login (`!ctx.isRemote`): loopback `http://localhost:51121/oauth-callback`;
   - remote/headless: paste the redirect URL or the raw code (same exchange as agy's `antigravity.google/oauth-callback` page).
3. Eligibility: `loadCodeAssist` with `{"metadata":{"ideType":"ANTIGRAVITY"}}`. Not eligible (`eligible === false`, 401/403, no tier) aborts with `subscription not eligible` and saves nothing.
4. Project: `cloudaicompanionProject` from `loadCodeAssist`, else `default-cli-project`; cached on `CatalogService` and stored on the credential.
5. Result: `{ profiles: [{ profileId, credential: { type: "oauth", provider: "antigravity", access, refresh, expires, email, projectId, accountId } }], configPatch, notes }`. No `defaultModel`, so the primary model is unchanged.

Scopes: `cloud-platform`, `userinfo.email`, `userinfo.profile`, `cclog`, `experimentsandconfigs` (all under `https://www.googleapis.com/auth/`). Login never opens a browser during a turn and never prints tokens or auth headers.

## Storage

OpenClaw's auth store (SQLite: `~/.openclaw/agents/<agent>/agent/openclaw-agent.sqlite`, or `~/.openclaw/state/openclaw.sqlite`) through the SDK. The plugin writes no token files and never touches `~/.gemini`.

## Credential shapes

`formatApiKey(credential)` returns JSON `{"token", "projectId", "accountId"}`. Every ingestion path (main stream, `wrapSimpleCompletionStreamFn`, media understanding, web search) receives that plain JSON; the host unwraps any secret sentinel before handoff. `parseFormattedApiKey` decodes it. The plugin does no sentinel decryption of its own. The placeholder `managed-by-openclaw` is rejected before any network call.

## Refresh

Path: `resolveApiKeyForProvider` → `oauthManager.resolveOAuthAccess` → `refreshOAuthTokenWithLock` → `plugin.refreshOAuth(credential)` → `formatApiKey` → persisted by OpenClaw.

- Activation `onProviders: ["antigravity"]`, `onCommands: ["models"]` loads the plugin before auth resolution; without it refresh fails with `No API key found for provider "antigravity"`.
- 5xx and network errors: up to 3 attempts, backoff `200 * 2^(attempt-1)` ms plus jitter; errors marked `transient`/`retryable` so the profile is kept.
- `invalid_grant`: no retry; message tells the user to run `openclaw models auth login --provider antigravity`. Stored credentials are never deleted by the plugin.
- Direct 401 retry in `createStreamFn` (when the host wrapper is bypassed): one refresh and one retry; concurrent refreshes share one promise per refresh token (`inFlightRefreshPromises`).
- Logs show expiry deltas and a short non-reversible profile hint, never tokens, account ids or emails.

## Failover classification (`classifyFailoverReason`)

| result | when |
|---|---|
| `auth` (host refreshes and retries) | 401; `UNAUTHENTICATED`; 403 whose body matches `invalid_token\|ACCESS_TOKEN_EXPIRED\|UNAUTHENTICATED` |
| `null` (terminal) | other 403 (`PERMISSION_DENIED`, entitlement, disabled model) |
| `rate_limit` | 429 matching `quota\|resource_exhausted`; 404 matching `argon` (assumed exhausted Argon credits; in fact the dead `M124` alias) |
| `server_error` | 5xx |

Non-auth 403s must stay `null`, otherwise OpenClaw loops refreshing or wipes valid credentials.
