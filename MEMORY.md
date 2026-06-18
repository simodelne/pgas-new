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

## Current state (as of 2026-06-18)

- **Active branch:** `feat/pgas-new-foundry`.
- **Direction:** this repo is being converted from the older `claude-pgas-plugin`
  scaffold plugin into `pgas-new`, a PGAS-specific TypeScript/Node foundry for
  creating governed PGAS programs.
- **Current engine target:** latest checked `@simodelne/pgas-server` package is
  `2.8.3`; generated code uses public `pgas-server` entrypoints only.
- **Implemented static surface:** domain model, gates, wiring manifest parser,
  artifact planner, renderer, existing-repo curator requests, verification
  evidence, CLI/session commands, generated REPL/control-plane scaffold, and
  generated deterministic/API/live test files.
- **Current verification:** `npm test` passes locally on 2026-06-18: typecheck,
  Vitest 11 files / 48 tests, and `tests/pgas-new-static.test.sh` including a
  generated scaffold install/typecheck/test when GitHub Packages access is
  available.
- **Still pending:** user-selected live graduation with a real provider round
  trip through the generated external API, followed by rebase on latest target
  repo state, post-rebase static verification, and PR opening.
- **Do not touch:** `.remember/` is an unrelated untracked session-memory
  directory in this checkout.

## Decision log (newest first)

### 2026-06-18 — pgas-new foundry branch replaces the v1 scaffold surface
The approved design became executable code on `feat/pgas-new-foundry`. The new
surface is PGAS-specific, TypeScript/Node only, and aligned to
`@simodelne/pgas-server@2.8.3` public exports. Existing-repo attachment is
manifest-bound at `.pgas/wiring.yml`; without the manifest, `pgas-new` refuses
writes and emits a curator request. The generated control plane now includes
REPL/session lifecycle controls (`ask`, `new`, `abort`, `history`, `status`,
`resume`, `help`), while the CLI exposes matching `session` commands. Notebook
state is the durable memory mechanism for user ideas, research, decisions, and
artifact/graduation evidence; `ActivationAction` is reserved for static
advisory procedures and is not the primary memory mechanism. Static verification
is green; live graduation remains explicitly pending.

### 2026-06-06 — v1.0.0: first stable cut + architecture paper
Criterion for 1.0: every scaffold surface gated by EXECUTION against the real engine
(6 suites, 196 assertions: render → load → typecheck → run → consumer-vitest) and the
full user journey dogfooded green (~3.5 min, install-bound). Content-identical to
v0.3.1 plus the architecture paper (`audit/ARCHITECTURE-claude-pgas-plugin-v1.0.0.md`,
the 10-section pgas#254 structure adapted to the tooling layer — satisfying the
plugin's own arch-doc-on-`.0` hook) and the version graduation. The paper's diff
against the next minor's edition is the standing drift-detection forcing function.

### 2026-06-06 — v0.3.1: run-level gate shipped (#20) + the three defects it caught, fixed
U7 delivered `tests/program-smoke.test.sh`: scaffold → install real engine → in-process
SessionManager via the engine's exported `setAuthorDriver` scripted-author seam (the same
seam pgas-server's own session tests use — NO live LLM) → boot + full-graph drive.
**First run immediately caught 3 defects invisible to render+load+typecheck:**
F1 spec schema missing engine-owned `governance.round_counter` (S-2 throws at create);
F2 `noopNotifications` wrong-shaped vs the `NotificationSink` port — hidden by an
`as never` cast, crashed on first create (fix: typed against the barrel-exported port,
cast deleted); F3 handlers written as `(payload, ctx)` but the engine calls
`handlers[action](payload)` with the snapshot at `payload.domain` as a PLAIN OBJECT —
the FM1 resolver expected a Map (fix: one-arg convention + `DomainSnapshot = Record`).
After fixes: program-smoke FULL ENFORCING PASS (boot + begin_work→working→example_action
→ reaction-owned gate fires → terminal `complete`, status `Completed`); all 6 suites
195 pass / 0 fail. **Versioning-policy clarification added to CLAUDE.md:** scaffold-output
bug-fixes that add/remove no surface are PATCH. **Lesson:** `as never` casts on port
boundaries hide exactly the crash class the smoke gate exists to catch — the gate found
in minutes what would have burned a consumer's first session.

### 2026-06-05 — v0.3.0: program scaffold actually loads + runs on the real engine (six-PR batch #13–#18)
**The headline bug (observed):** the v0.2 program scaffold's `spec.yml` was REJECTED by
the real engine loader — `loadSpecWithPatterns` → `Spec compiler check failed: unknown
key "spec.mode_initial"` (then top-level `transitions`, per-mode `prompts`,
`tools.*.args`, `channel_paths`, missing `fallback`…). Engine had moved 1.9.0→1.13.0
and NO plugin gate executed `loadSpec` against the rendered template (server-typecheck
= tsc only; template-render = YAML-parse only) — the pgas#235 trap class, self-inflicted.
**Shipped (parallel worker batch, conflict-free file slicing, all validated):**
#18 spec template rewritten to the 1.13 strict-keys shape (initial/terminal/termination/
topology, per-mode transitions {target, predicate guard}, proceed_to, top-level prompts
map, ingestion, reaction-owned gate flag — the LLM can no longer open its own gate;
query_state corrected to an action_map QueryAction since no built-in tool exists) + the
NEW `tests/spec-load.test.sh` gate that runs the REAL loader in CI; #16 registration.ts.tmpl
(ProgramEntry factory + FM4 worked example) + server-typecheck injection aligned;
#13 programs born with their own vitest pair (spec-load + registration); #15 command
overhaul (exact 4-marker contract: 2 injected / 2 intentionally empty, opt-in design
interview, loud SCAFFOLD VERIFICATION); #14 pin ^1.13.0 + v0.3.0; #17 skills de-staled
(they were TEACHING the rejected keys; spec-validate pointed at the wrong loader).
**Validation:** every PR green on GitHub CI (real gates, PAT); 6-PR local integration =
189 pass / 0 fail incl. `LOADED_OK` from the real loader; merged-main tree verified
byte-identical to the validated integration. Pod was unreachable (rotated) — GitHub CI
covered its role.
**Lesson (now structural):** *typecheck is not load, and load is not run.* Every scaffold
surface needs a gate that EXECUTES it; the spec-load gate closes the load level, the
wave-2 session-smoke closes the run level.

### 2026-06-02 — #5 closed: CI `server-typecheck` gate now live
Owner provisioned the `PLUGIN_NPM_TOKEN` repo secret. A re-run of the `main` CI
([run 26823450979](https://github.com/simodelne/claude-pgas-plugin/actions/runs/26823450979))
confirmed the gate runs for real instead of SKIPping: `npm install (with NPM_TOKEN)` →
PASS (~95s real install vs GitHub Packages), `npx tsc --noEmit` → exit 0, `PASS:
scaffolded consumer typechecks against installed @simodelne/pgas-server` (8 pass, 0 fail);
`smoke-tests` job 2m5s vs ~37s when it SKIPped. The agent could provision neither the
token (no programmatic narrow-PAT minting) nor store the broad `gh` token as the secret
(classifier hard-block — owner-only); the owner did it. Also tagged `v0.2.0`.

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
