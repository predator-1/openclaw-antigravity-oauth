# Install and release

## How distribution works

- `main` holds sources only; `dist/` is gitignored.
- OpenClaw `git:` installs clone the ref and run no build, so the installed ref must contain the compiled `dist/`.
- For every release CI creates a **release commit**: the tagged `main` tree plus the built `dist/`. Its only parent is the tagged `main` commit, and it never lands on `main`.
- Tag `v<version>` and branch `release` point at the newest release commit. The source commit of a release is `v<version>^`.
- The npm package is `@predator-1/openclaw-antigravity-oauth` (scoped for ClawHub); the plugin id stays `openclaw-antigravity-oauth`.
- Each GitHub Release also carries optional assets: the npm-pack tarball `openclaw-antigravity-oauth-<version>.tgz` (renamed from npm's scoped `predator-1-openclaw-antigravity-oauth-<version>.tgz`), a copy named `openclaw-antigravity-oauth.tgz`, and `SHA256SUMS`.

## Install

```bash
openclaw plugins install git:github.com/predator-1/openclaw-antigravity-oauth@release   # follows releases
openclaw plugins install git:github.com/predator-1/openclaw-antigravity-oauth@v1.5.301 # pinned
openclaw plugins inspect openclaw-antigravity-oauth --runtime
openclaw models auth login --provider antigravity --method oauth
```

Finding 2026-11-07 (OpenClaw 2026.10.10, clean state, no GitHub credentials): a first install passes two host gates, and the plugin cannot skip either. The source gate (`--force`) applies outside ClawHub; in a terminal it is a `[y/N]` prompt, in a non-interactive shell the install stops with `Install cancelled; rerun with --force`. The capability gate (`--accept-capabilities`) then stops a non-interactive install with `requires capability consent`. Host docs exempt only bundled and verified official catalog plugins from capability consent. `--force --accept-capabilities` installed in a non-interactive shell.

Optional tarball install (offline or air-gapped hosts):

```bash
gh release download v1.5.301 -R predator-1/openclaw-antigravity-oauth -p 'openclaw-antigravity-oauth-1.5.301.tgz' -p SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS      # macOS: shasum -a 256 -c --ignore-missing SHA256SUMS
openclaw plugins install npm-pack:./openclaw-antigravity-oauth-1.5.301.tgz --force
```

`openclaw plugins update` cannot discover newer GitHub Releases for an `npm-pack:` install; reinstall the newer tarball with `--force`.

## Update

```bash
openclaw plugins update openclaw-antigravity-oauth
```

An `@release` install moves to the newest release. A pinned `@v<version>` install stays on that tag; reinstall with the new tag to move. Finding 2026-11-07 (OpenClaw 2026.10.10): with the Gateway running, `plugins update` refuses with `requires exclusive offline state ownership` and changes nothing, so stop the Gateway first. `plugins install <spec> --force --no-enable` followed by `plugins reload <id>` updated a running Gateway without a restart and kept the earlier capability acceptance. Stored OAuth credentials live in OpenClaw's auth store, so no re-login is needed.

## Migration

- **From an `npm-pack:` tarball install.** `--force` replaces the existing install:
  `openclaw plugins install git:github.com/predator-1/openclaw-antigravity-oauth@release --force`
- **From the old local plugin id `antigravity`.** The provider id is still `antigravity`, so `antigravity/*` model refs, aliases and stored credentials keep working. Both plugins register provider `antigravity`; disable the old one first:
  `openclaw plugins disable antigravity && openclaw plugins enable openclaw-antigravity-oauth`

## Versioning

```
plugin version = <agyMajor>.<agyMinor>.<agyPatch * 100 + fix>     fix = 00..99
```

| agy | plugin | meaning |
|---|---|---|
| 1.4.12 | `1.4.1200` | first release for agy 1.4.12 |
| 1.4.12 | `1.4.1201`, `1.4.1202` | plugin-only fixes |
| 1.4.13 | `1.4.1300` | agy update, fix resets to 00 |
| 1.5.1 | `1.5.100` | first release for agy 1.5.1 |
| 1.5.2 | `1.5.200` | first release for agy 1.5.2 |
| 1.5.3 | `1.5.300` | adoption after [protocol review](protocol.md#agy-153-2026-11-07) |

- Back-mapping: agy patch = `floor(pluginPatch / 100)`, fix = `pluginPatch % 100`.
- Plain `x.y.z` only, so fixes sort above their base in semver.
- `npm run sync:upstream:apply` sets `CLI_VERSION` and the version to `<agy>00`; it keeps the fix while agy is unchanged.
- Plugin-only fix: the maintainer runs `npm version 1.4.1201 --no-git-tag-version`.
- `test/package.test.ts` and `npm run verify:package` fail when the version does not map to `CLI_VERSION` (helpers: `scripts/plugin-version.js`).

## Release flow (maintainer)

1. Feature PRs leave the version alone and add a `CHANGELOG.md` line under *Unreleased*.
2. Bump the version if needed, update the pinned version examples (`README.md` Install, [Install](#install) above), move the notes under `## [<version>]`, merge to `main` with green CI.
3. Tag the merged `main` commit and push the tag: `git tag v<version> <main-sha> && git push origin v<version>`.
4. The release workflow ([`.github/workflows/release.yml`](../.github/workflows/release.yml)) does the rest:
   - **build** job (`contents: read`): the tag is on `main`, `main` tracks no `dist/`, and the tag equals the package version; then `npm ci`, `check`, `test`, `verify:dist`; it packs the tarball, `SHA256SUMS`, release notes and a `dist/` archive.
   - **publish** job (`contents: write`): fails before changing anything if the Release exists; verifies checksums; creates the release commit (fixed dates, so a re-run produces the same commit); runs `verify:package --release-commit`; moves tag `v<version>` and force-updates branch `release` to it; attests provenance (public repos only); creates the GitHub Release.

Never create a branch named `release/<anything>`: git cannot hold `release` and `release/…` at the same time, and the publish job fails with `cannot lock ref 'refs/heads/release'`.

Verify a release before installing it (reviewer checklist):
1. Fresh clone of `release`; `git log -1 --format=%P` is the tagged `main` commit.
2. `node scripts/verify-package.js --release-commit=HEAD --parent=<main-sha>` passes.
3. A local build of `<main-sha>` is byte-identical to the release `dist/` (`diff -r`).
4. No tokens or emails in `dist/`; release assets pass `shasum -a 256 -c SHA256SUMS`.
5. Provenance (releases from `v1.5.201` on): `gh attestation verify openclaw-antigravity-oauth-<version>.tgz -R predator-1/openclaw-antigravity-oauth`.

Redo a release: `gh release delete v<version> --yes -R predator-1/openclaw-antigravity-oauth`, then re-run the workflow run.

Rulesets (2026-11-07): `main` takes changes only through a PR with green `build & test (Node 22)` and `(Node 24)`, no force push, no deletion, no bypass. `v*` tags: no deletion, no non-fast-forward; the move to the release commit is a fast-forward. `release`: no deletion only, because each release force-updates it. Repository admins can bypass the last two, which is what moving a tag back for a redo needs.

If rulesets block `GITHUB_TOKEN` from pushing `release` or the tag, add a `RELEASE_PUSH_TOKEN` secret (contents write; workflow scope if GitHub refuses the push for touching `.github/workflows`). A tag push made with that token re-triggers the workflow, which skips because the tag already points at a release commit.

Build the tarball locally: `npm pack`. Check a release commit locally: `node scripts/verify-package.js --release-commit=v<version> --parent=<main-sha>`.

## ClawHub (prepared, not published)

Prepared 2026-11-08 ([#31](https://github.com/predator-1/openclaw-antigravity-oauth/issues/31)); nothing is published yet. Rules: [ClawHub publishing](https://docs.openclaw.ai/clawhub/publishing).

- Required metadata: scoped name `@predator-1/...` (the scope must match the publishing owner), `openclaw.compat.pluginApi` and `openclaw.build.openclawVersion` in `package.json`, one manifest category (`models`). `verify:package` fails without the two `openclaw.*` fields.
- `openclaw.build.openclawVersion` names the host the release was validated against. Raise it when a release is checked on a newer OpenClaw; leave `compat` alone unless support for older hosts changes.
- `"private": true` stays: ClawHub publishes the built tarball, and it blocks an accidental `npm publish`.
- Evidence 2026-11-08 (clawhub CLI 0.25.1, OpenClaw 2026.11.1): `clawhub package validate` passes with no issues or deprecations; `clawhub package publish <tgz> --family code-plugin --dry-run` passes without login; a scoped tarball installed over the unscoped one, and a `git:` install updated to a scoped release commit, both keep id `openclaw-antigravity-oauth`. A reinstall from `npm-pack:` leaves the old unscoped project folder under `~/.openclaw/npm/projects/`.

First publish (maintainer, own account):

```bash
npm i -g clawhub
clawhub login
gh release download v<version> -R predator-1/openclaw-antigravity-oauth -p 'openclaw-antigravity-oauth-<version>.tgz'
clawhub package validate <unpacked-package-folder>
clawhub package publish openclaw-antigravity-oauth-<version>.tgz --family code-plugin \
  --source-repo predator-1/openclaw-antigravity-oauth --source-commit "$(git rev-parse v<version>^)" --source-ref v<version> --dry-run
# same command without --dry-run, then wait for the security checks
```

Use the tarball from the GitHub Release, not a local build, so the published bytes match `SHA256SUMS` and the attestation. Then:

- Check `openclaw plugins install clawhub:@predator-1/openclaw-antigravity-oauth` in a scratch OpenClaw state and whether the `provenance-invalid` warning is gone; record the result here.
- Moving an existing install: `openclaw plugins install clawhub:@predator-1/openclaw-antigravity-oauth --force`. The `git:` path keeps working.
- Next step, not wired yet: `clawhub package trusted-publisher set @predator-1/openclaw-antigravity-oauth --repository predator-1/openclaw-antigravity-oauth --workflow-filename release.yml`, then a publish step in `release.yml` using GitHub OIDC.

## CI

- `.github/workflows/ci.yml`: `main` pushes and PRs to `main`, Node 22 and 24, read-only permissions, SHA-pinned actions, PR-only cancel-in-progress: type-check, `verify:dist`, tests, a committed-token guard. No secrets; the live smoke never runs in CI.
- `.github/workflows/release.yml`: the release workflow above.
- Pushing changes to workflow files needs a token with the GitHub `workflow` scope.
- `.github/dependabot.yml` keeps the pinned action SHAs current (weekly `github-actions` group `actions`).
- Finding 2026-11-06: the SHA-pinned actions run on Node 24 (`runs.using: node24`), not the deprecated Node 20 action runtime. A Dependabot bump (merged 2026-11-05) replaced the Node 20 pins (`actions/checkout@v4.4.0`, `actions/setup-node@v4.4.0`, `actions/upload-artifact@v4.6.2`, `actions/download-artifact@v4.3.0`) with `checkout@v7.0.1`, `setup-node@v7.1.0`, `upload-artifact@v7.0.2` and `download-artifact@v8.0.2`. `actions/attest-build-provenance@v4.2.2` is composite and calls `actions/attest@v4.2.1` (`node24`). The `v1.5.100` Release workflow run succeeded after that merge (2026-11-06). First node24 releases: checkout and setup-node v5, upload-artifact v6, download-artifact v7.
