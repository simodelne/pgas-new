# claude-pgas-plugin

> **READ FIRST.** This is the load-bearing governance doc for this repo. Every
> Claude session here MUST obey it. Then read [`MEMORY.md`](./MEMORY.md) for the
> *current state* — version, open issues, in-flight PRs, hard-won lessons. Division
> of labour: **`CLAUDE.md` is the rulebook**, **`MEMORY.md` is the running memory**,
> and **`.remember/remember.md` is the latest session handoff** (transient).

This file is the **soul of the engine's `CLAUDE.md`** (`simodelne/pgas` → `CLAUDE.md`)
adapted for the consumer-**tooling** layer. The shared rules — classifier-denial hard
stop, data-driven debugging, orchestration roles — are worded identically on purpose:
agents that move between the engine, the consumers, and this plugin read the same rules.

---

## What this repo is

A **Claude Code plugin that scaffolds and audits pgas consumers and programs.**

Thesis: codify the lessons from
[pgas#253](https://github.com/simodelne/pgas/issues/253) (the five
consumer-integration failure modes, FM1–FM5) and
[pgas#254](https://github.com/simodelne/pgas/issues/254) (the consumer-versioning
contract) so that a freshly-scaffolded consumer **closes FM1–FM5 by construction** —
the FM-closing patterns ship already wired, not as a checklist the consumer author
must remember.

- Manifest plugin name: `pgas`. License: MIT. Public repo: `simodelne/claude-pgas-plugin`.
- **This is consumer-tooling, SEPARATE from the engine.** The engine lives in
  `simodelne/pgas` and publishes `@simodelne/pgas-*` to GitHub Packages. **You
  consume it from here; you never edit it from here.**

## Relationship to the engine — a HARD boundary

1. **`@simodelne/pgas-*` is upstream and read-only.** Never edit anything under
   `node_modules/@simodelne/pgas-*/`, and never paper over an engine gap with a
   template hack.
2. **Engine bug or missing export → file an issue on `simodelne/pgas`**, with
   observed-vs-inferred markers. Do not work around it in the scaffold. (This is
   Channel 4 of the consumer-comms protocol the scaffold itself documents.)
3. **The scaffold's server template imports engine primitives through the
   `@simodelne/pgas-server/api` barrel** (since plugin v0.2.0 / engine v1.9.0,
   pgas#256). **Never import from the bare `@simodelne/pgas-server` specifier** —
   that `"."` entry is a runnable bootstrap that calls `serve()` and opens a port at
   import time and exports nothing. The barrel is the side-effect-free library surface.

## Surface area

| Path | What |
|---|---|
| `commands/pgas-new-consumer.md` | `/pgas-new-consumer` — scaffold a fresh consumer repo (Mode A) |
| `commands/pgas-new-program.md` | `/pgas-new-program` — scaffold a program inside an existing consumer (Mode B) |
| `skills/5-fm-audit/` | audit a consumer against pgas#253 FM1–FM5 |
| `skills/architecture-doc/` | generate/update `audit/ARCHITECTURE-*.md` (pgas#254) |
| `skills/spec-validate/` | `loadSpec()` a consumer's `spec.yml` |
| `skills/mode-entry-lint/` | flag the FM3 `system_mode_entry` breadth foot-gun |
| `hooks/` | block staging an invalid `spec.yml`; nudge for the arch-doc on `.0` publishes |
| `templates/new-consumer/` | the Mode-A scaffold (server / auth / frontend / migrations) |
| `templates/new-program/` | the Mode-B scaffold (spec / handlers / prompts) |
| `templates/frontend/` | vendored React+Vite snapshot from simoneos |
| `tests/` | `npm test` = `plugin-manifest` + `template-render` + `auth-scaffold` + `server-typecheck`; `frontend-scaffold` runs separately |
| `docs/` | `MARKER-PROTOCOL.md`, `MODE-B-DETECTION.md`, `PLUGIN-DEVELOPMENT.md` |

## Key invariants & patterns

### FM1–FM5 close by construction (pgas#253)

Every change to `templates/` or `skills/` must keep these closed. `/pgas:5-fm-audit`
is the check; a FAIL blocks merge.

| FM | What it is | Where the scaffold closes it |
|----|------------|------------------------------|
| FM1 | Handlers read action payload only; engine stores flat-key domain | `templates/new-program/handlers/_resolver.ts.tmpl` |
| FM2 | `InnerContinuationReplay` + `SessionLockExhausted` consumers must be wired | `templates/new-consumer/server/index.ts.tmpl` (registers both) |
| FM3 | `system_mode_entry` admission too broad under v1.8.x | `templates/new-program/spec.yml.tmpl` (admits only on bootstrap mode); `skills/mode-entry-lint/` |
| FM4 | Handler-backed raw tool with no `createAdapters` override silently `undefined`s | documented in the new-program README |
| FM5 | Engine-owned `inputs.query_meta.*` paths missing from consumer schema | `templates/new-program/spec.yml.tmpl` (schema includes them) |

The two FM2 consumers in `server/index.ts.tmpl` are load-bearing: removing them
re-opens the silent-stall path that burned ~50 min of debug time on pgas-rag. Do not
remove them without reading pgas#253.

### The marker protocol

The four `[pgas-plugin:*-registry]` markers in `server/index.ts.tmpl` are how
`/pgas-new-program` injects a new program without manual file editing. **Never remove
or rename them.** See `docs/MARKER-PROTOCOL.md`. `template-render.test.sh` and
`server-typecheck.test.sh` both assert their presence.

### Verify, don't trust "green"

The `server-typecheck` gate must run against the **real installed** engine, not a
mock — it scaffolds a consumer, `npm install`s `@simodelne/pgas-*`, and runs
`npx tsc --noEmit`. Reproduce ground truth. **Read the installed package's exports
before forming a log-based hypothesis** about what a symbol does. A SKIPped gate is
not a passing gate — confirm it actually ran (see `MEMORY.md` → CI 403 caveat).

## Commands

```bash
npm test                              # the 4-suite gate (run before every commit)
bash tests/server-typecheck.test.sh   # end-to-end: scaffold → install REAL engine → tsc --noEmit
bash tests/frontend-scaffold.test.sh  # vendored frontend snapshot build (network; not in npm test)
```

`server-typecheck` needs an `NPM_TOKEN` with `read:packages` on `simodelne`. Locally
it resolves `gh auth token` automatically; in CI it uses the `PLUGIN_NPM_TOKEN` repo
secret (falling back to `GITHUB_TOKEN`, which 403s → SKIP). See
`docs/PLUGIN-DEVELOPMENT.md` → "CI secrets".

## Don'ts (strict)

- **Never edit the engine from here**, never patch around an engine gap in a template.
- **Never import from the bare `@simodelne/pgas-server` specifier** — always `/api`.
- **Never remove the `[pgas-plugin:*]` markers** or reorder the Brief-2 auth mount
  (`app.route('/auth', …)` MUST precede `app.use('/api/*', authMiddleware)`).
- **Never let `.claude-plugin/plugin.json` and `package.json` versions drift** — the
  manifest test enforces lockstep; bump both together.
- **No dead code, no commented-out blocks, no `_unused` renames** — delete it.
- **No workarounds.** If a template needs an engine surface that doesn't exist, file
  it upstream; don't hack the template.
- **Never accept a SKIPped or trivially-green gate** as proof — confirm it exercised
  the real engine.
- **Never bypass a classifier denial** (see below) and **never `git commit --no-verify`**.

## How you operate — governance

This repo runs the orchestrator + sub-agent model from the engine's
`CLAUDE.md` ("Agent behavior — classifier denials and orchestration").

| Role | Who | Responsibilities | NOT allowed to |
|------|-----|------------------|----------------|
| **Orchestrator / Maintainer agent** | the main Claude session here | define scope + acceptance criteria; implement on a branch (or dispatch sub-agents); open a PR with the brief in `## Brief`; validate CI; triage findings into issues | self-merge by default |
| **Sub-agent (Implementer)** | `Agent`-tool-spawned | write code + tests; open a PR; return a short report (summary + test plan + risks) | self-merge |
| **Owner / Curator (human)** | `simone.delnevo@gmail.com` | reviews + merges; final veto on behavioral surfaces | — |

Operational rules:

1. **Acceptance criteria precede implementation.** No work without a "done when" list
   (GitHub issues supply them).
2. **Bugs and improvements → GitHub issues** on this repo, with observed-vs-inferred
   markers.
3. **Implement on a branch, open a PR — do not self-merge by default.** The owner
   reviews and merges. *The owner may explicitly grant merge authority for a session;*
   absent that grant, the default holds.
4. **Pure GitHub metadata** (issue/PR titles, labels, close/reopen via `gh`) is fine
   to do directly — it isn't git history.
5. **Engine changes are out of scope.** File them on `simodelne/pgas`.

## Data-driven debugging — highest priority

Per the user-global rule (`~/.claude/CLAUDE.md`) and the engine's governance:

1. **Name the observation** — the exact log line, test output, error, or registry
   value the claim rests on. No observation ⇒ no root cause yet.
2. **Mark inferences explicitly** — `observed` → `inferred (given Y)` → `hypothesized`.
   Never collapse the chain into a single "probably X."
3. **Flag missing data** — say "to confirm I'd need <specific data>" instead of
   guessing around the gap.
4. **Say "I don't know"** when data is absent. Always better than a confident wrong answer.

"The model is too dumb" / "probably the engine" are **never** accepted verdicts. When
observability is the bottleneck, fixing observability **is** the fix. Read the
installed `@simodelne/pgas-*` exports before forming log-based hypotheses.

## Classifier denial is a hard stop (verbatim — governance I-6)

When `Claude Code auto-mode classifier` denies a tool call, **stop**. Do not retry the
same call with `dangerouslyDisableSandbox: true` or any equivalent bypass. Surface to
the user: what was attempted, why it seems needed, and what a smaller alternative
looks like.

This holds even when the denial seems mistaken — the work is correct, the scope feels
appropriate, the call is "obviously safe". The classifier is the user's oversight
layer; bypassing it removes the human-in-the-loop the user explicitly opted into.
Escalation, not bypass, is the only correct response.

Sandbox-disable exists for cases the user has pre-approved in a session, not for
working around classifier verdicts mid-task. Every sub-agent brief MUST reproduce this
rule verbatim.

## Versioning policy

- The plugin follows **SemVer**. `.claude-plugin/plugin.json` and root `package.json`
  versions are kept in **lockstep** (asserted by `plugin-manifest.test.sh`).
- **Patch** (`x.y.Z`): doc/test/CI fixes, no scaffold-output change.
- **Minor** (`x.Y.0`): additive scaffold change (new template file, new placeholder,
  new skill/command) or an engine-pin bump that relies on a new engine surface (e.g.
  v0.2.0 = the `/api` barrel migration).
- **Major** (`X.0.0`): a breaking scaffold change — removing a placeholder, renaming a
  marker, or any change that breaks a re-scaffold of an existing consumer.
- The scaffold's engine pin default (`{{ENGINE_VERSION}}`, set in
  `commands/pgas-new-consumer.md`) tracks the lowest engine version whose surface the
  template depends on.

## Stack

| Component | Version / note |
|-----------|----------------|
| Plugin tooling runtime | Node ≥ 20 (root `package.json` engines) |
| Scaffolded-consumer runtime | Node ≥ 24 |
| Test harness | bash (`tests/*.test.sh`) |
| YAML parse (tests) | `js-yaml` 4.x |
| Engine registry | GitHub Packages (`@simodelne` scope), auth via `gh auth token` / `PLUGIN_NPM_TOKEN` |
| Engine pin (current default) | `@simodelne/pgas-*@^1.9.0` |

---

## End of CLAUDE.md
