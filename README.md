# openclaw-antigravity-oauth

[![CI](https://github.com/predator-1/openclaw-antigravity-oauth/actions/workflows/ci.yml/badge.svg)](https://github.com/predator-1/openclaw-antigravity-oauth/actions/workflows/ci.yml)

OpenClaw provider plugin for the Google Antigravity subscription. It signs in with OAuth and serves the subscription's chat models, Google Search grounding, web fetch, image generation, media understanding and quota usage to OpenClaw. Provider id `antigravity`, plugin id `openclaw-antigravity-oauth`.

Unofficial: not affiliated with or endorsed by Google. It uses your own subscription login against the same endpoints as the official Antigravity CLI (`agy`).

Requires OpenClaw gateway / plugin API `>= 2026.10.8` and Node.js `>= 22`.

## Features

- Chat models from the subscription catalog (Gemini, Claude, gpt-oss), discovered live, with reasoning effort and streamed reasoning
- Structured output on Gemini; tool calls that OpenClaw executes (no native CLI tools)
- Google Search grounding (`antigravity-search`) and web fetch (`antigravity-fetch`)
- Image generation; media understanding for images, audio, video and PDF
- Quota usage

Details: [docs/features.md](docs/features.md).

## Install

```bash
openclaw plugins install git:github.com/predator-1/openclaw-antigravity-oauth@release --force --accept-capabilities
openclaw models auth login --provider antigravity --method oauth
```

Pin a version with `@v<version>` instead of `@release` (for example `@v1.5.203`).

`--force` confirms a source outside ClawHub and `--accept-capabilities` approves what the plugin [declares](openclaw.plugin.json). Leave them out in a terminal to answer the prompts instead; a non-interactive shell needs both.

## Update

```bash
openclaw gateway stop
openclaw plugins update openclaw-antigravity-oauth
openclaw gateway start
```

Without stopping the Gateway: `openclaw plugins install git:github.com/predator-1/openclaw-antigravity-oauth@release --force --no-enable`, then `openclaw plugins reload openclaw-antigravity-oauth`.

## Documentation

| Topic | File |
|---|---|
| Install, update, migration, versioning, releases | [docs/install-and-release.md](docs/install-and-release.md) |
| Configuration and model sync | [docs/configuration.md](docs/configuration.md) |
| Features: models, reasoning effort, tools, search, fetch, images, media, usage | [docs/features.md](docs/features.md) |
| Sign-in, refresh, failover | [docs/auth.md](docs/auth.md) |
| Contract, invariants, `src/` module map | [docs/architecture.md](docs/architecture.md) |
| Upstream protocol (verified facts) | [docs/protocol.md](docs/protocol.md) |
| Development and testing | [docs/development-and-testing.md](docs/development-and-testing.md) |
| Updating for a new agy release | [docs/upstream-sync.md](docs/upstream-sync.md) |
| Troubleshooting | [docs/troubleshooting.md](docs/troubleshooting.md) |

Agent and contributor rules: [AGENTS.md](AGENTS.md), [CONTRIBUTING.md](CONTRIBUTING.md). Open work: [issues](https://github.com/predator-1/openclaw-antigravity-oauth/issues). Security: [SECURITY.md](SECURITY.md). Changes: [CHANGELOG.md](CHANGELOG.md). License: [MIT](LICENSE).
