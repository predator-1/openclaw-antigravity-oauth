# Development and testing

```bash
npm ci
npm run check            # tsc --noEmit
npm test                 # builds dist/, runs the hermetic suite (node --test)
npm run verify:package   # package shape (needs a build: npm run verify:dist builds first)
```

Node.js >= 22. OpenClaw, a subscription and `agy` are not needed for the suite. If `node`/`npm` are not on `PATH` (some agent hosts), call node by absolute path; the scripts resolve npm from `process.execPath`. Hosts that refuse `node --import` can run the suite with `node:test`'s `run({ files, execArgv: ["--experimental-strip-types", "--import=<repo>/test/support/setup.mjs"] })`. `dist/` is build output from `npm test` (pretest), `npm pack` (prepack) and CI; never commit it to `main`.

## Hermetic suite

`test/support/setup.mjs` (loaded with `--import`):
- `HOME`/`USERPROFILE` point at a throwaway directory; `AGY_BIN` and `AGY_TOKEN_FILE` are cleared;
- `fetch` fails any request a test did not mock; non-loopback sockets and DNS lookups throw (loopback stays open for the OAuth callback server);
- `openclaw/plugin-sdk/media-understanding` resolves to a test double in `test/support/openclaw-sdk/` via `module.registerHooks()` on Node 22.15+ and 24 (CI), with `module.register()` as a fallback on older Node 22; other `openclaw/*` imports stay unresolved like a bare checkout.

Rules: mock `fetch`, never read the real `HOME`, pin the clock (`t.mock.timers.enable({ apis: ["Date"], now })`) for time-dependent behavior.

| file | covers |
|---|---|
| `test/acceptance.test.ts` | contract acceptance ([architecture.md](architecture.md#6-acceptance)) and provider behavior |
| `test/package.test.ts` | versioning, release notes, package and release-commit checks, npm resolution |
| `test/sync-upstream.test.ts` | binary parsing, baselines, verdicts, apply rollback |
| `test/integration-smoke.test.ts` | smoke argument parsing, auth sources, redaction, classification |
| `test/hermetic.test.ts` | the network and `HOME` guards |

## `verify:package` (`scripts/verify-package.js`)

- Default: version maps to `CLI_VERSION`; the git-tracked tree plus `dist/` has every manifest entry compiled (`openclaw.extensions`, `main`, `types`) and a `dist/*.js` per `src/*.ts`; `npm pack --dry-run` contains the compiled entry and manifest and no sources or credential-like files. npm is resolved from `process.execPath`.
- `--release-commit=<rev> [--parent=<sha>]`: the release commit has exactly one parent (the tagged `main` commit), adds only `dist/`, and its tree passes the same tree check.

## Integration smoke (local only, real upstream, uses quota)

```bash
npm run test:integration
npm run test:integration -- --auth-source=agy [--agy-token-file=<path>] [--min-usage-windows=<n>] [--model=<id>] [--agent=<id>] [--json]
```

- Runs the built `dist/` code paths sequentially with short prompts.
- Auth (`--auth-source`, default `openclaw`):
  - `openclaw`: the stored profile in OpenClaw's SQLite stores, read-only;
  - `agy` (opt-in): `~/.gemini/antigravity-cli/antigravity-oauth-token` (or `AGY_TOKEN_FILE`), read once, refreshed in memory, never written;
  - `auto`: openclaw, then agy.
- Checks:
  - catalog against the published models (legacy mapped ids are not reported as removed);
  - per model: `pong` turn and a tool round trip (`jira:get_ticket`, nullable `anyOf` schema);
  - usage (at least `--min-usage-windows`, default 5);
  - search citations;
  - web fetch through `antigravity-fetch` against a run-time nonce echo URL;
  - image generation (one retry on 503 `UNAVAILABLE`, deadline, or 500 `INTERNAL`);
  - image description.
- Results: `pass`; `skipped` for quota exhaustion (429, `RESOURCE_EXHAUSTED`, `Individual quota reached`) with the reset time; transient rate/capacity limits are `skipped: rate_limited` with a retry/reset hint, not exhausted quota; `fail` otherwise (exit 1), including model 404 / `unknown model` / `NOT_FOUND`. A 429 with `Resets in` is the real quota signal; treating Argon 404 as quota hid the dead `MODEL_PLACEHOLDER_M124` alias.
- Live freshness checks: put a nonce generated at run time into an echo URL (`postman-echo.com/get?n=<nonce>`) and require it in the result; fixed pages can come from training data or caches.
- Errors go through `sanitizeError` (tokens, JWTs, emails, project ids). `--json` sends plugin logs to stderr.
- Never run in CI. Never paste raw output that contains account-specific data.

## Scratch files

Temporary dumps, trial scripts and raw API responses go in `.tmp/` (gitignored).
