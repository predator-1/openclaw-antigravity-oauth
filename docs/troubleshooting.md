# Troubleshooting

| symptom | cause and fix |
|---|---|
| `requires compiled runtime output` after install or update | installed from a ref without `dist/` (for example `@main`). Reinstall from `@release` with `--force`. |
| `No API key found for provider "antigravity"` | plugin not loaded before auth resolution, or no login. Check `openclaw plugins inspect openclaw-antigravity-oauth --runtime`, then `openclaw models auth login --provider antigravity --method oauth`. |
| `subscription not eligible` | the Google account has no Antigravity subscription tier; nothing was saved. |
| `OAuth refresh token is invalid or revoked ... [error: invalid_grant]` | refresh token revoked or expired; run the login again. |
| two plugins claim provider `antigravity` | old local plugin `antigravity` still enabled; disable it (see [install-and-release.md](install-and-release.md#migration)). |
| Gemini 4 Argon 404 / `unknown model` | plugin now sends `gemini-4-argon-low`, `-medium`, `-high`; a 404 is a model error, not quota. Real Argon quota is HTTP 429 with `Resets in`. Check windows with `openclaw status --usage`. |
| release publish fails with `cannot lock ref 'refs/heads/release'` | a branch `release/<name>` exists; delete it (after merging) and re-run the failed job. Never name branches `release/*`. |
| in-chat quota notice | subscription window exhausted; the notice shows the reset time and an alternative model. `openclaw status --usage` lists all windows. |
| `HTTP 400 INVALID_ARGUMENT: Proto field is not repeating` | a tool schema reached upstream unsanitized; report it with the tool schema (see [protocol.md](protocol.md#request-sanitization)). |
| `native tool refused: <name>` / `native tools offered` | upstream tried to use a consumer CLI tool; the turn is failed on purpose ([architecture.md](architecture.md#4-turn)). |
| web search not used | another provider is earlier in auto-detect or explicitly configured; set `tools.web.search.provider` to `antigravity-search`. |
| image generation never picked by default | by design; pass `--model antigravity/gemini-3.1-flash-image`. |
| `openclaw plugins update` does nothing for a tarball install | `npm-pack:` installs cannot see new releases; reinstall the new tarball or switch to `@release`. |
| `/think max` or `/think xhigh` rejected with valid options | the selected model does not declare those levels (Claude, Argon, and other suffix-tier models stay at `low|medium|high`). Use `gemini-3.8-flash`, or pick a listed level. See [features.md](features.md#reasoning-effort). |
| 404 `model_not_found` with HTML body on every Antigravity model (`/v1internal:streamGenerateContent/chat/completions?alt=sse`) | host bypassed the plugin stream and the OpenAI SDK doubled the path (OpenClaw 2026.10.10). Plugin ≥ this fix sets `activation.onStartup: true` so `createStreamFn` stays in the active registry; request URL must be exactly `…/v1internal:streamGenerateContent?alt=sse`. See [features.md](features.md#plugin-stream-transport). |
| `transcribeAudio` error naming `20 MiB` / `Gemini inline data limit` / `after base64 expansion` | clip larger than `INLINE_AUDIO_MAX_BYTES` (~14.81 MiB raw), chosen so base64(audio) + envelope stays under the ~20 MiB whole-request Gemini inline budget. There is no `v1internal` upload fallback; split or compress the audio. The live upstream cutoff is unverified ([protocol.md](protocol.md#inline-audio-size-2026-11-06)). |

If a token leaks: revoke it at <https://myaccount.google.com/permissions>, then log in again.
