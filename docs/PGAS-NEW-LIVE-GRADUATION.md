# PGAS-New Live Graduation

This branch has not live-graduated. Live graduation requires a real provider round trip through the generated program's external API, followed by a rebase on the latest target repo state and a full static rerun.

## Preconditions

- The generated scaffold installs and passes deterministic tests.
- The target repo is on a feature branch.
- Existing-repo attachment has a valid `.pgas/wiring.yml`.
- The user has selected the live-provider scenario.
- API credentials are supplied outside git and are not written into generated artifacts.

## Static Gate

Run from this repository before the live attempt:

```bash
npm test
```

For a rendered standalone scaffold, the static shell gate also installs the generated project and runs its generated typecheck/tests when GitHub Packages access is available.

## Live Gate

The generated live test is intentionally skipped unless these variables exist:

- `PGAS_LIVE_PROVIDER`
- `PGAS_API_BASE`
- `PGAS_API_TOKEN`

The live test creates a session through `createPgasClient(fetchTransport(...))`, triggers `user_text` through the external API, reads the session back, and records that a real provider-backed round trip happened. Hermetic in-process API tests are useful but do not count as live graduation.

Example shape:

```bash
PGAS_LIVE_PROVIDER=openai \
PGAS_API_BASE=http://127.0.0.1:3000 \
PGAS_API_TOKEN=... \
npm test -- tests/live-provider.test.ts
```

Do not commit secrets, `.env` files, provider logs, or raw LLM payloads.

## Rebase Gate

Before PR graduation, rebase on the latest target repo branch and rerun the full static ladder. This proves the generated program works on the current repo state, not on stale assumptions.

Required evidence:

- Branch and base commit before rebase.
- Rebase target.
- Static verification command and result after rebase.
- Live-provider result, including provider label and API endpoint class, without secrets.

## PR Graduation

Open the PR only after:

- static verification passed,
- live-provider round trip passed,
- branch was rebased on latest target repo state,
- post-rebase static verification passed.

The PR body should say live graduation was performed only when it actually was. If live graduation is still pending, say that explicitly and keep the branch out of `pr_graduation` mode.
