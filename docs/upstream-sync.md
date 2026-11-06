# Upstream sync (new agy release)

`scripts/sync-upstream-vars.js` compares the installed `agy` binary with the shared baseline `upstream/agy-fingerprint.json`. agy ships one version for every OS/arch at the same time and compared fingerprint fields are identical across platforms, so the check can run on any OS. Policy (2026-11-06): any agy version change means an investigation of what changed, then adoption.

## Commands

```bash
npm run sync:upstream            # dry run, human-readable diff (add -- --json for automation)
npm run sync:upstream:check      # exit code = verdict
npm run sync:upstream:apply      # verdict 10: write CLI_VERSION, version, baseline; build, check, test
```

Options: `--agy-bin=<path>` (or `AGY_BIN`; default `command -v agy`, usually `~/.local/bin/agy`), `--json`, `--investigated=<N>` (with `--apply` only: apply a `REVIEW_NEEDED` fingerprint after issue `N` recorded the findings). `--platform` and `--force` were removed.

## Guardrails

- Only `agy --version`, `agy --help`, `agy changelog`, `agy models` are ever run. Never `agy update`, `agy agent`, logins, or other subcommands.
- Never reads or writes `~/.gemini`, the Keychain or OS token stores (the smoke's opt-in `--auth-source=agy` is the only reader, see [development-and-testing.md](development-and-testing.md#integration-smoke-local-only-real-upstream-uses-quota)).
- No OpenClaw logins, config changes, gateway restarts or plugin installs.
- Secrets are never printed or serialized (only a SHA-256 of the client secret); client ids by numeric prefix only.
- Ends at a local commit for review; never pushes or merges.

## Binary formats

Mach-O 64-bit (thin or universal; `LC_SEGMENT_64`; universal uses the host-arch slice) and ELF64 (`PT_LOAD`; PIE `R_*_RELATIVE` applied in memory; `DT_RELR` refused, verdict 30) can be parsed on any host OS. PE/COFF is unsupported (verdict 30).

## Fingerprint fields

Compared (and written to the baseline): `cliVersion`, `latestChangelog`, `rpcNames` (`used` by `src/` / `other`), `googleHosts` (`used` / `other`), `oauthClientPrefixes`, `consumerClientParity` (booleans and secret hash), `oauthScopes`, `requestShapeMarkers`, `subcommands`, `models`. Not stored: `platform`, `binaryFormat`, `binarySha256`.

## Verdicts

| code | name | when | action |
|---|---|---|---|
| 0 | NO_CHANGE | identical | nothing |
| 10 | SAFE | only `cliVersion`, `latestChangelog`, `rpcNames.other`, `googleHosts.other` | `--apply` |
| 20 | REVIEW_NEEDED | used RPCs or hosts, scopes, client prefixes, request markers, subcommands or models changed | write nothing unless `--apply --investigated=<N>` |
| 30 | ERROR | binary missing, extraction failed, constants missing, unparsable baseline, unsupported format | report |

`--apply` exit codes: `0` (`applied: true`, including an investigated 20), `20` (nothing written), `30` (failed; `failingStep`, `tailOutput`; written files restored, a new baseline removed, `dist/` rebuilt; `rolledBack: true` only if all of that succeeded). JSON output has no platform fields (`platform`, `baselinePlatform`, `crossPlatformBaseline`).

The script also reports the latest `google-antigravity/antigravity-cli` GitHub release (`behind`/`equal`/`ahead`), for information only.

## Procedure (also the automation runbook)

Automation boundary: no `git push`, no merge to `main`; finish with a local commit on `chore/agy-<version>`.

1. `npm run sync:upstream -- --json`.
   - 0: report "Installed agy is up to date" (run step 3 only if live verification was requested).
   - 30: report the error and stop.
   - 20: report per-field old → new. Open (or finish) an investigation issue, record findings in `docs/`, then continue at step 2 with `--investigated=<N>`.
   - 10: read `latestChangelog`; if it hints at protocol, auth or schema changes treat it as 20. A `cliVersion` change still needs an investigation issue before adoption, even when the fingerprint is SAFE.
2. Clean tree required. `git checkout main && git pull --ff-only && git checkout -b chore/agy-<version>`, then `npm run sync:upstream:apply -- --json` (add `--investigated=<N>` when step 1 was 20). On exit 30 without `rolledBack: true`, run `git checkout -- . && git clean -fd upstream/ && npm run build` and report.
3. `npm run test:integration` (add `--auth-source=agy` only if the operator allowed it for this run). Exit 1: report the failures and stop without committing.
4. Version is already `<agy>00` (agy 1.4.13 → 1.4.1300); do not run `npm version`. Add a `CHANGELOG.md` section, then:
   `git add package.json package-lock.json src/constants.ts upstream/agy-fingerprint.json CHANGELOG.md && git commit -m "chore(agy): bump agy CLI to v<version>"`.
5. Report: verdict, old → new version, fingerprint status, branch and commit, changed fields, the smoke results table (check, target, result, details), added/removed/quota-limited models, and the next action for the maintainer (review, merge, tag; see [install-and-release.md](install-and-release.md#release-flow-maintainer)).
