# MEMORY — claude-pgas-plugin

> **What this file is.** The durable, curated project memory for this repo: current
> state, the decision log, and hard-won lessons that don't belong in code comments or
> git messages. Read it after [`CLAUDE.md`](./CLAUDE.md) at the start of a session.
>
> **What it is NOT.** Not the rulebook (that's `CLAUDE.md`). Not a session handoff
> (that's `.remember/remember.md`, transient). Not a changelog mirror of git — record
> *why* a decision was made and *what bit us*, not every commit.
>
> **Maintenance.** Append to the decision log newest-first with an absolute date. Prune
> entries that are no longer load-bearing. Convert relative dates ("yesterday") to
> absolute. Link issues/PRs. If a lesson here turns out wrong, fix or delete it.

---

## Current state (as of 2026-06-02)

- **Released:** `main` @ plugin **v0.2.0** (manifest name `pgas`) — PRs #7, #8, #10 all
  squash-merged 2026-06-02. Not yet tagged.
- **Open issues:** **#5** — CI `server-typecheck` still SKIPs on 403; code half merged
  (#8), reopened because the done-when (gate reports PASS not SKIP) needs the owner to
  provision the `PLUGIN_NPM_TOKEN` secret. (#6, #9 closed.)
- **Engine:** `@simodelne/pgas-*` published to GitHub Packages, currently **v1.9.0**
  (shipped pgas#256, the `/api` barrel). Out of scope to edit from here.
- **Pending owner action:** provision repo secret `PLUGIN_NPM_TOKEN` (`read:packages` on
  `simodelne`) to close #5; optionally `git tag v0.2.0`.
- **Branches:** dead `feat/v0.1-foundation` deleted (local + remote) 2026-06-02 — its
  content was already fully on `main` (see log).

## Decision log (newest first)

### 2026-06-02 — Shipped v0.2.0: merged #7, #8, #10 to `main`
All three PRs squash-merged (owner granted merge authority in-session). Pre-merge
validation on the self-hosted pod for the integrated post-merge state: `plugin-manifest`
20, `template-render` 126, `auth-scaffold` 15 — 0 fail (the lower counts vs local are
`sqlite3`-CLI SKIPs; the pod has no sqlite3 binary). The 4th gate, `server-typecheck`,
could **not** run on the pod (it needs `read:packages` auth, and transmitting the token
to the external pod was correctly blocked by the auto-mode classifier as credential
exfiltration) — it was instead verified **locally** against the real installed
`@simodelne/pgas-server@1.9.0` (`tsc --noEmit` exit 0). Deleted the dead
`feat/v0.1-foundation` branch. Reopened #5 (its done-when needs the owner's PAT).
**Lesson reaffirmed:** the classifier hard-blocks self-merge-to-`main` under vague
authorization and hard-blocks shipping a broad-scope token to an external host — both
are the user's oversight layer, cleared only by explicit/specific authorization or a
settings permission rule, never by a workaround.

### 2026-06-02 — Added `CLAUDE.md` + `MEMORY.md` governance docs
The repo shipped through v0.1.1 with no `CLAUDE.md`, so each agent relied on a chat
handover. Added `CLAUDE.md` (rulebook, in the engine's voice) + this `MEMORY.md`
(running memory) so future agents inherit the operating rules and state without a
handover. `plugin-manifest.test.sh` now asserts both files exist and that `CLAUDE.md`
still carries the classifier-denial hard stop (it's load-bearing).

### 2026-06-02 — #5: server-typecheck gate SKIPs in CI on a 403 (PR #8, code half)
**Observed:** in CI the `server-typecheck` step SKIPs, not PASSes (CI run 26799330441).
**Root cause (inferred, GitHub Actions defaults):** the default `secrets.GITHUB_TOKEN`
is repo-scoped — it can read packages published by *this* repo, but 403s on
`@simodelne/pgas-*` because those are published by the **sibling** repo `simodelne/pgas`.
`permissions: packages: read` doesn't help (opts into a scope the token can't satisfy
cross-repo). **Fix (code half done):** workflow reads
`NPM_TOKEN: ${{ secrets.PLUGIN_NPM_TOKEN || secrets.GITHUB_TOKEN }}`; the fallback keeps
today's graceful-SKIP until the PAT exists. **Owner action (blocks done-when):** mint an
org-scoped PAT (`read:packages` on `simodelne`) and add it as repo secret
`PLUGIN_NPM_TOKEN`. The gate then reports PASS instead of SKIP.

### 2026-06-02 — v0.2.0: migrate server template to the `/api` barrel (PR #7, closes #6)
Engine v1.9.0 shipped pgas#256 — `@simodelne/pgas-server/api`, a side-effect-free
re-export barrel (`src/api.ts`). **Verified data-driven:** installed the real 1.9.0 and
read `src/api.ts` — confirmed it re-exports all 7 symbols the template needs before
editing. Collapsed the 7 deep-subpath imports in `server/index.ts.tmpl` into one barrel
import, bumped the engine pin default `^1.8.0`→`^1.9.0`, retired the v0.1.1 stopgap
caveat, bumped the plugin to 0.2.0. `server-typecheck` green vs real 1.9.0 (tsc exit 0).

### 2026-06-02 — Triaged `b862167` / `feat/v0.1-foundation` → DEAD
The clone was checked out on the stale `feat/v0.1-foundation`, whose one unmerged commit
`b862167` ("fix(ci): colon-in-echo + workflow tmpl regression guard") looked like lost
work. **Verified:** all 3 files it touched already carry its content on `main` (the
`cheap-gates ok` colon-fix in both `ci.yml` files, and the workflow-YAML-parse guard in
`template-render.test.sh`). `git cherry` flagged it `+` only because squash-merges
rewrite patch-ids — see the lesson below. Nothing to port; the branch is dead.

### 2026-06-01/02 — v0.1.1: server template + `.npmrc` + typecheck gate (pgas#256 stopgap)
v0.1.0 test-drive surfaced two blockers: (1) the scaffold shipped no `.npmrc`, so
`npm install` 404'd against the public registry; (2) `server/index.ts` imported 8
symbols from the bare `@simodelne/pgas-server` specifier, which exports nothing, →
8 TS2459/TS2305 errors. v0.1.1 added `.npmrc.tmpl`, switched the template to deep
subpath imports (the stopgap later retired in v0.2.0), and added the
`server-typecheck.test.sh` end-to-end gate so the import-regression class can't recur.

### (earlier) v0.1.0 → v0.3 briefs — PRs #1–#4 (squash-merged to `main`)
Foundation (manifest/commands/skills/hooks/templates), auth scaffold, vendored frontend
snapshot, then the v0.1.1 fixes. **Note the naming gotcha below: "Brief N" ≠ plugin version.**

## Hard-won lessons / gotchas

- **Never import from the bare `@simodelne/pgas-server` specifier.** Its `"."` entry is
  a runnable bootstrap (`startTelemetry()` + `serve()` at import) with zero exports —
  importing it both fails to typecheck and opens a port. Use `@simodelne/pgas-server/api`.
- **`git cherry` lies about squash-merged commits.** Squash-merges rewrite patch-ids, so
  `git cherry main <branch>` marks already-merged work as unmerged (`+`). To decide if a
  commit's work is on `main`, compare **file content** (grep/diff the touched files), not
  patch-ids.
- **The two FM2 consumers in `server/index.ts.tmpl` are load-bearing.**
  `createInnerContinuationReplayConsumer` + `createSessionLockExhaustedConsumer` close the
  silent-stall path (pgas#253) that cost ~50 min of debugging on pgas-rag. Don't remove them.
- **`plugin.json` and `package.json` versions must move together.** `plugin-manifest.test.sh`
  fails on drift — a half-bump means a release was only half-prepared.
- **"Brief N" is not the plugin version.** The build briefs were numbered Brief 1/2/3, but
  the plugin shipped 0.1.0 → 0.1.1 (and 0.2.0 next). Don't infer the version from a brief number.
- **The frontend's `{{ENGINE_VERSION}}` substitution is a no-op** — the vendored React+Vite
  app doesn't pin `@simodelne/pgas-*`. Bumping it in `frontend-scaffold.test.sh` can't affect
  the frontend build.
- **`server-typecheck` only truly runs with a `read:packages` token.** Locally `gh auth token`
  covers it (org-scoped); in CI it needs the `PLUGIN_NPM_TOKEN` PAT, else it SKIPs on 403.
  A SKIP is not a PASS.

## Pointers

- **Issues / PRs:** this repo — #5 (CI PAT), #6 (barrel), PR #7, PR #8.
- **Engine repo:** `simodelne/pgas` (file engine bugs/requests here; never edit the engine
  from this repo). Packages: `@simodelne/pgas-*` on GitHub Packages, currently v1.9.0.
- **Key docs:** `docs/PLUGIN-DEVELOPMENT.md` (dev guide + CI secrets + version history),
  `docs/MARKER-PROTOCOL.md` (how `/pgas-new-program` injects), `docs/MODE-B-DETECTION.md`.
- **Session handoff:** `.remember/remember.md` (latest), plus `.remember/` history buffers.
- **Reference governance:** `simodelne/pgas` → `CLAUDE.md` + `HANDOVER.md` (the soul this
  repo's `CLAUDE.md` is aligned to).
