# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/) with one convention: plugin version =
`<agyMajor>.<agyMinor>.<agyPatch*100 + fix>` (agy 1.4.12 → `1.4.1200`; plugin-only fixes `1.4.1201`, …;
agy patch = plugin patch ÷ 100). See [docs/install-and-release.md](docs/install-and-release.md#versioning).

## [Unreleased]

### Fixed

- Correct quota-reset countdowns for millisecond and fractional delays; ignore malformed reset delays.

## [1.5.203] - 2026-11-07

Targets agy 1.5.2. Plugin-only fixes.

### Added

- Smoke catalog check detects changes to the pinned upstream image model routing list.
- Troubleshooting guidance for the missing Antigravity video-generation provider.
- Dated upstream probe: video generation is not available in the tested forms ([docs/protocol.md](docs/protocol.md#video-generation-probed-2026-11-07)).

### Fixed

- Keep OAuth provider settings and discovered model definitions compatible with the host config schema by omitting unsupported catalog tags.
- Preserve image host-auth cancellation and redacted resolver failures instead of reporting every fault as missing login.
- Distinguish terminal image quota from transient rate/capacity limits, retain reset hints, and bound transient retries.
- Refresh expired stored image credentials when possible; otherwise resolve authentication through the host instead of sending an expired credential.
- Keep image-generation timeout and caller cancellation active through success and error response bodies.
- Prefer asynchronous image-provider readiness and host auth checks while retaining compatibility with older supported hosts.

## [1.5.202] - 2026-11-07

Targets agy 1.5.2. Plugin-only fix.

### Changed

- The README install command works in a terminal and in a non-interactive shell (`--force --accept-capabilities`); the docs correct the earlier note and cover updating with the Gateway running or stopped.
- GitHub secret scanning skips the two files that hold agy's public OAuth client.

### Fixed

- Reject unsupported image-generation model ids before upstream requests and include the model in HTTP errors.

## [1.5.201] - 2026-11-07

Targets agy 1.5.2. First public release, with a build provenance attestation; no runtime changes.

### Added

- Bug report issue template that asks for redacted logs; feature list in the README.

### Changed

- The release flow updates the pinned version examples in the README and the install docs.
- Install docs cover the capability consent a first install asks for (`--accept-capabilities`).
- Recorded the repository rulesets and how to verify a release attestation.

## [1.5.200] - 2026-11-06

Targets agy 1.5.2.

### Added

- Publish `gemini-3.5-flash-lite` as a cheap OpenClaw chat model (`tags: ["cheap"]`) when upstream lists it. `gemini-2.5-*` and `gemini-3.1-*` stay filtered; `web_search` still uses `gemini-3.8-flash-tiered`.
- Gemini structured output: when OpenClaw 2026.11.1 passes `StreamOptions.responseFormat` (or extra-params `response_format` / `responseFormat`) into `createStreamFn`, the plugin forwards sanitized `generationConfig.responseMimeType` and `generationConfig.responseSchema` on Gemini and `MODEL_PLACEHOLDER_*` turns. Claude and GPT-OSS ignore it. Isolated `api.runtime.llm` completions reject `responseFormat` at the host. Checked live on `gemini-3.8-flash` (2026-11-06): a schema-only request returns JSON with the requested field; with tools the schema is omitted and the request succeeds.

### Changed

- Adopt agy 1.5.2: `CLI_VERSION` 1.5.2, plugin `1.5.200`. The investigation found no plugin change needed; the new `x-goog-upload-url` marker belongs to agy's remote-project upload, not to the plugin's request path ([docs/protocol.md](docs/protocol.md#agy-152-2026-11-06)).
- One shared agy baseline (`upstream/agy-fingerprint.json`) and the honest host OS/arch in the User-Agent (`antigravity/cli/<version> <os>/<arch>`). Per-platform baselines and `--platform` / `--force` are gone. `--apply --investigated=<N>` applies a `REVIEW_NEEDED` fingerprint after that investigation issue.
- Verified on darwin-arm64 with the real login (smoke 7 of 8, image generation skipped on quota). The `linux/amd64` User-Agent was accepted by the upstream when sent from the Mac (`fetchAvailableModels`, quota, chat all 200); a native Linux host run is still unverified ([docs/protocol.md](docs/protocol.md#client-identity)).

## [1.5.101] - 2026-11-06

Targets agy 1.5.1.

### Added

- `antigravity-fetch` web-fetch provider.
- Model reasoning streams to the host as thinking events.
- `/think xhigh` and `/think max` on `gemini-3.8-flash` map to upstream `thinkingLevel` `EXTRA_HIGH` and `MAX`. Other models reject them with the valid options listed. Argon is omitted because its suffix variants skip `thinkingConfig`. Declared through the catalog and `resolveThinkingProfile`.
- `transcribeAudio` fails early when raw audio would exceed the ~20 MiB Gemini inline request budget after base64 expansion (raw cap `INLINE_AUDIO_MAX_BYTES` ≈ 14.81 MiB) and reports that `v1internal` has no media upload path. Live 5/15/25 MB size probes were not run.

### Fixed

- Gemini 4 Argon routes through catalog variants instead of a dead upstream model id.
- The catalog honors `disabled`, `deprecatedModelIds` and media flags.
- Real Gemini thought signatures are stored and replayed on tool turns, bound to the producing catalog model.
- Thinking and text blocks close on block switch and stream errors; `antigravity-fetch` HTML tag handling, mapped-IPv6 deny and default timeout are tightened.

### Changed

- Hermetic test bootstrap uses `module.registerHooks()`.
- SHA-pinned GitHub Actions run on Node 24 (Dependabot); a regression test rejects the old Node 20 pins.

## [1.5.100] - 2026-11-06

Targets agy 1.5.1.

### Fixed

- Antigravity chat turns and utility completions no longer 404 as `model_not_found` on OpenClaw 2026.10.10. The manifest now sets `activation.onStartup: true` and `autoEnableWhenConfiguredProviders`, so the plugin stream stays in the host's active registry and requests go to `v1internal:streamGenerateContent?alt=sse` instead of the OpenAI SDK's doubled `/chat/completions` path. `register()` and `activate()` share one function and the `modelAuth` read is guarded. See [docs/features.md](docs/features.md#plugin-stream-transport).

### Changed

- CLI_VERSION and plugin version aligned to agy 1.5.1 (`1.5.100`).
- Fingerprint baselines for linux-x64 and darwin-arm64 recorded from agy 1.5.1.

## [1.4.1200] - 2026-11-02

First GitHub Release; targets agy 1.4.12. Install with
`openclaw plugins install git:github.com/predator-1/openclaw-antigravity-oauth@release`.

### Added
- Upstream variable sync (`scripts/sync-upstream-vars.js`) with fingerprint verdicts, the live integration
  smoke test (`scripts/integration-smoke.js`), and the upstream sync procedure (`docs/upstream-sync.md`).
- Plugin presents itself as the Antigravity CLI (client identity, sanitized upstream requests).
- `web_search` auto-detect order and OAuth readiness for fallback.
- `sync-upstream-vars`: ELF64 support (Linux `x64` / `arm64`, including PIE builds via
  `R_*_RELATIVE` relocations) and per-platform baselines in `upstream/agy-fingerprints/<platform>.json`
  (`darwin-arm64`, `linux-x64` recorded for agy 1.4.12). Platform comes from the binary;
  `--platform=<os>-<arch>` overrides it. PE binaries fail with a clear "unsupported format" error.
- Integration smoke: `--auth-source=openclaw|agy|auto` (default `openclaw`), `--agy-token-file` /
  `AGY_TOKEN_FILE`, and `--min-usage-windows`. The agy login is opt-in, read-only and refreshed only in memory.
- Hermetic test harness (`test/support/setup.mjs`): sandboxed `HOME`, network guard, OpenClaw SDK test double.
- New unit tests for binary parsing, baseline selection, apply rollback, smoke auth and redaction.
- Extended CI workflow `.github/workflows/ci.yml` (`main` + `release/**`, Node 22 and 24,
  read-only permissions, token-leak guard, `npm pack --dry-run`).
- `SECURITY.md`, `CONTRIBUTING.md`, this changelog.
- Release packaging: `npm run verify:package` (npm-pack shape + version check), `prepack` build,
  `scripts/release-notes.js`, `scripts/plugin-version.js` (agy ↔ plugin version mapping), and a
  tag-triggered release workflow `.github/workflows/release.yml`: the tag must equal the package
  version and point at a commit on `main`; a read-only build/test/pack job hands the tarball and
  `SHA256SUMS` to a separate publish job (`contents: write`) that attests build provenance (public repos)
  and creates the GitHub Release, failing cleanly if the release already exists.
- `.github/dependabot.yml` for GitHub Actions and npm.
- `sync-upstream-vars --force` to allow a `--platform` override that differs from the analysed binary's `<os>-<arch>` (OS or architecture).
- Release commits: the release workflow builds `dist/`, commits it on top of the tagged `main` commit (never on
  `main`), moves tag `v<version>` to that commit and updates branch `release`, so OpenClaw `git:` installs
  (`@release`, `@v<version>`) get the compiled runtime and `openclaw plugins update` works. The npm-pack tarball
  and `SHA256SUMS` remain optional release assets.
- `verify:package --release-commit=<rev> [--parent=<sha>]` checks the release commit shape (single parent, only
  `dist/` added, every manifest entry and source file compiled); the default mode checks the tree too.
- MIT `LICENSE`; `"license": "MIT"` in `package.json`.
- `TODO.md` with the open work; findings go straight into `docs/` (no notes file).

### Changed
- Docs: short README; topic files under `docs/` (install-and-release, configuration, features, auth,
  architecture, protocol, development-and-testing, upstream-sync, troubleshooting). `docs/DISCOVERY.md`,
  `docs/SPEC.md` and `docs/agy-update-runbook.md` were folded in and removed; `agents.md` is now a compact
  `AGENTS.md`.
- Smoke catalog check compares against the models the plugin publishes; legacy mapped ids
  (`LEGACY_MAPPED_MODELS`) are no longer reported as removed on every run.
- Smoke image generation also retries once on HTTP 500 `INTERNAL`.
- `upstream/agy-fingerprint.json` moved to `upstream/agy-fingerprints/darwin-arm64.json` (the old path is
  still read as a `darwin-arm64` fallback).
- `sync-upstream-vars --apply` rolls back everything it wrote on any failure after the first write
  (constants, package version, fingerprint, newly created baseline directory), always rebuilds `dist/` once a
  verification step ran, and reports `rolledBack: true` only if that rebuild succeeded.
- Smoke `turn:pong` now requires "pong" in the reply; `image:describe` requires non-empty text.
- Smoke error redaction also covers bare `ya29.` / `1//` tokens, `GOCSPX-` secrets, JWTs and token fields.
- Media understanding reports a clear error when the OpenClaw host runtime is missing.

### Fixed
- `verify-package` and `sync-upstream-vars` resolve npm from `process.execPath` (works when npm is not on
  `PATH` or not next to `node`).
- Test suite no longer depends on an installed `openclaw` package (CI on `main` had been red since 2026-10-31).
- Usage-window test no longer depends on the current date.
- Mach-O universal (fat) binaries: segment file offsets are now slice-relative.
- `package-lock.json` name/version now match `package.json`.
- Sync: a `--platform` override no longer silently records another OS's or architecture's key with this binary's data.
- Sync: universal Mach-O binaries use the slice matching the host architecture, not the first 64-bit slice.
- Sync: ELF binaries with `DT_RELR` packed relocations fail with verdict 30 instead of under-extracting.
- Smoke: quota reset hints are redacted; camelCase token fields (`accessToken`, …) and named project ids
  (`projects/my-proj`) are redacted; `--json` keeps plugin logs off stdout.
- Tests: the hermetic guard also blocks raw `net`/`tls` sockets and DNS, not just `fetch`.
- Acceptance tests no longer hard-code `CLI_VERSION`, so `--apply` can pass its own verification.

## [0.2.0]

- Plugin renamed to `openclaw-antigravity-oauth` (provider id stays `antigravity`).
- OAuth refresh with backoff, 401 failover, usage windows, search, image generation and media understanding.

[Unreleased]: https://github.com/predator-1/openclaw-antigravity-oauth/compare/v1.4.1200...HEAD
[1.4.1200]: https://github.com/predator-1/openclaw-antigravity-oauth/releases/tag/v1.4.1200
