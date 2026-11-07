# Security Policy

## Reporting a vulnerability

Do not open a public issue. Use GitHub's
[private vulnerability reporting](https://github.com/predator-1/openclaw-antigravity-oauth/security/advisories/new)
with the affected version or commit, reproduction steps and impact. Never paste a real access or refresh token.

Supported: the latest GitHub Release. Releases are built from the tagged sources by CI; release assets carry a `SHA256SUMS` file.

## Credentials

- OAuth credentials are stored only in OpenClaw's auth profile store. The plugin never writes tokens to the repository, the working directory or `~/.gemini`, and never reads the macOS Keychain or OS token stores.
- User tokens (access, refresh, ID tokens) are never committed.
- `src/constants.ts` and its build `dist/constants.js` hold agy's public OAuth client, which this project cannot rotate. `.github/secret_scanning.yml` excludes these two files from GitHub secret scanning and push protection, so never put any other secret in them.
- Logs contain the provider, expiry timestamps, HTTP status and a non-reversible profile hint; never tokens, account ids or emails.
- `scripts/sync-upstream-vars.js` runs only `agy --version`, `--help`, `changelog`, `models` and never prints secrets.
- `scripts/integration-smoke.js` is local and opt-in: OpenClaw's SQLite stores read-only by default; the agy login only with `--auth-source=agy`, read-only and refreshed in memory. Error text is redacted (tokens, JWTs, emails, project ids).
- CI is hermetic: no repository secrets, all network calls in tests mocked, the live smoke never runs there. CI also runs a guard against committed tokens and JWTs.

## If a token leaks

Revoke it at <https://myaccount.google.com/permissions> (remove the Antigravity app), then run
`openclaw models auth login --provider antigravity`. Rewriting git history alone is not enough.
