# Configuration

The plugin has no plugin config of its own (`configSchema` is an empty object with `additionalProperties: false`). It never changes `agents.defaults.model.primary`, image models, search defaults or media tools.

## Model sync (`scripts/sync-models.js`)

Registers aliases and the agent runtime for the Antigravity models in `openclaw.json`, key by key through `openclaw config set <path> <value> --strict-json` (no whole-file rewrite).

```bash
npm run sync:models          # dry run: prints the planned openclaw config set commands
npm run sync:models:apply    # apply (same as: npm run sync:models -- --apply)
npm run sync:models:prune    # apply and remove the static models.providers.antigravity.models list
```

- Owned fields only: `agents.defaults.models["antigravity/<id>"].alias` and `.agentRuntime.id` (`openclaw`). Other per-model fields are left alone.
- Idempotent: a second `--apply` changes nothing.
- `--prune-static-catalog`:
  - reads the live catalog with `openclaw models list --all --provider antigravity --json` and refuses (exit 1) if the gateway is unreachable, the provider is missing, or any static model is not served;
  - backs up the static list to `.tmp/static-models-backup-<timestamp>.json`, unsets `models.providers.antigravity.models`, re-queries, and restores from the backup (exit 1) if any model disappeared.

## Selecting features

- **Chat:** `antigravity/<id>` model refs; see [features.md](features.md#models).
- **Web search:** auto-detected (order 35) when `tools.web.search.provider` is unset; set `tools.web.search.provider` to `antigravity-search` to force it. Explicit selection disables fallback.
- **Web fetch:** fallback provider `antigravity-fetch` (order 40). OpenClaw tries its own fetch first; sandboxed `web_fetch` skips this plugin. Set `tools.web.fetch.provider` to `antigravity-fetch` to select it after that fallback path.
- **Image generation:** the host's `image_generate` selects its model from `agents.defaults.mediaModels.image` ("Image Generation Model"); for this provider select `antigravity/gemini-3.1-flash-image`. The plugin and model-sync script never write that setting. The plugin sets no image `autoPriority`; accepted ids and validation: [features.md](features.md#image-generation).
- **Media understanding:** registered with `autoPriority` 90 for image, audio and video; default model `gemini-3.8-flash`.

## Local SDK types

OpenClaw provides `openclaw/plugin-sdk/*` at runtime, so `openclaw` is an optional peer dependency. For editor type resolution:
`ln -s ~/.openclaw/runtime/current/lib/node_modules/openclaw node_modules/openclaw`.
