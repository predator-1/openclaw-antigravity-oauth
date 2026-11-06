# AGENTS.md

OpenClaw provider plugin for the Antigravity subscription. Contract: [docs/architecture.md](docs/architecture.md). Open work: [issues](https://github.com/predator-1/openclaw-antigravity-oauth/issues). Index of docs: [README.md](README.md#documentation).

## Commands

```bash
npm ci
npm run check            # before every commit
npm test                 # build + hermetic suite
npm run verify:dist      # build + package shape
npm run sync:upstream    # agy fingerprint diff (docs/upstream-sync.md)
npm run test:integration # live smoke, local only, uses quota
```

Layout: `src/` plugin ([module map](docs/architecture.md#src-module-map)), `scripts/` tooling, `test/` hermetic tests, `upstream/agy-fingerprint.json` agy baseline, `.github/workflows/` CI and release.

## Never

- Merge, push to `main`, tag or release without the maintainer's approval. Work on a branch, open a draft PR.
- Name a branch `release/*` (breaks the `release` ref).
- Commit `dist/` to `main`, bump the version in a feature PR, or commit tokens, emails, project ids or raw API dumps.
- Use a personal email in commits (`predator-1@users.noreply.github.com`).
- Read or write `~/.gemini`, except the smoke's opt-in `--auth-source=agy` token read. Run `agy` only with `--version|--help|changelog|models`.
- Change the OAuth client constants or the CLI client identity in `src/constants.ts`.
- Spawn binaries, open browsers or attach native tools from `src/`; OpenClaw executes every tool.
- Change the user's OpenClaw config outside `scripts/sync-models.js`'s owned fields, or files under `~/.openclaw`.

## Docs

- One fact in one place, in `docs/*.md` by topic. Findings go straight there with date and evidence (upstream facts: `docs/protocol.md`; decisions: `docs/features.md`). No notes files.
- Terse, for agents: no marketing prose, no repeated tables, link instead of copying.
- Scratch output goes in `.tmp/` (gitignored).
- Open work is GitHub issues, one per task, with Known / Start / Prove. The PR closes its issue (`Closes #N`). Findings go to `docs/`, not into issue comments.
