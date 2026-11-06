# Contributing

Read [AGENTS.md](AGENTS.md) (rules for humans and agents) and [docs/architecture.md](docs/architecture.md) (the contract). Open work is in [issues](https://github.com/predator-1/openclaw-antigravity-oauth/issues).

## Setup

```bash
git clone https://github.com/predator-1/openclaw-antigravity-oauth.git
cd openclaw-antigravity-oauth
git config user.email predator-1@users.noreply.github.com   # never a personal email
npm ci
npm test
```

Node.js 22+. OpenClaw, a subscription and `agy` are not needed for the suite. Details: [docs/development-and-testing.md](docs/development-and-testing.md).

## Making a change

1. Branch from `main` (`feat/…`, `fix/…`, `docs/…`, `chore/…`, `poc/…`). Never `release/…`: it breaks the `release` branch ([why](docs/install-and-release.md#release-flow-maintainer)).
2. Change `src/`. Do not commit `dist/` and do not change the version ([versioning](docs/install-and-release.md#versioning)).
3. `npm run check`, `npm test` and `npm run verify:dist` must pass. New behavior needs a hermetic test.
4. Conventional Commits; add a `CHANGELOG.md` line under *Unreleased*.
5. Write findings (endpoints, probes, upstream behavior, decisions) directly into the matching topic file under `docs/` with the date and the evidence: upstream facts in `docs/protocol.md`, decisions in `docs/features.md`. There is no separate notes file. Close the issue from the PR (`Closes #N`).
6. Open a draft pull request; CI must be green. Agents never merge to `main`, push to `main`, tag or release without the maintainer's approval.

`npm run test:integration` is optional, local only, and uses your quota. Never commit tokens, `.env` files, emails, project numbers or raw API dumps (use `.tmp/`).
