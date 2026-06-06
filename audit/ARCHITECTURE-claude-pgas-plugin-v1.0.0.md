# ARCHITECTURE — claude-pgas-plugin v1.0.0

> Per-version architecture paper per the CONSUMER-VERSIONING-CONTRACT
> (pgas#254) 10-section structure, adapted to the consumer-**tooling**
> layer: this repo is not a pgas consumer running programs — it is the
> Claude Code plugin that **scaffolds and audits** them. Each section
> maps the contract's intent onto the tooling equivalent. This is the
> auditable record of what the plugin is at v1.0.0; the diff against the
> next minor's paper is the drift-detection forcing function.

**Version:** 1.0.0 (first stable) · **Date:** 2026-06-06 · **Engine era:** `@simodelne/pgas-*@^1.13.0` (latest published: 1.13.0)

## What this plugin does

Scaffolds pgas **consumers** (Mode A: full repo — server, auth, frontend,
migrations) and pgas **programs** inside them (Mode B: spec, handlers,
registration, prompts, born-with tests), such that the five
consumer-integration failure modes from pgas#253 (FM1–FM5) are **closed by
construction**, and the result is **proven functional** by a five-rung
verification ladder that executes every scaffold surface against the real
engine — in CI, on every commit. Thesis: a user goes from nothing to a
verified-running pgas program in ~3.5 minutes (install-bound), with the
plugin doing the heavy lifting.

## 1. Layer diagram

```
┌────────────────────────────────────────────────────────────────────┐
│ USER (Claude Code session in a consumer repo)                      │
│   /pgas-new-consumer (Mode A)      /pgas-new-program (Mode B)      │
└──────────────┬─────────────────────────────┬───────────────────────┘
               ▼                             ▼
┌────────────────────────────────────────────────────────────────────┐
│ COMMANDS (Claude-executed markdown)                                │
│   inputs → optional design interview → copy template tree →        │
│   placeholder substitution → marker injection → SCAFFOLD           │
│   VERIFICATION (spec-validate + mode-entry-lint + born-with tests) │
├────────────────────────────────────────────────────────────────────┤
│ TEMPLATES (the product)                                            │
│   new-consumer/  server (api-barrel bootstrap, FM2 consumers,      │
│                  4 injection markers), auth, migrations, CI        │
│   new-program/   spec.yml (1.13 strict-keys shape, FM3+FM5,        │
│                  reaction-owned gate), registration.ts (FM4),      │
│                  handlers + FM1 resolver, prompts, tests/          │
│   frontend/      vendored React+Vite snapshot                      │
├────────────────────────────────────────────────────────────────────┤
│ SKILLS (audit) + HOOKS (enforcement)                               │
│   5-fm-audit · spec-validate · mode-entry-lint · architecture-doc  │
│   pre-commit spec gate · arch-doc nudge on .0 publishes            │
├────────────────────────────────────────────────────────────────────┤
│ GATES (tests/ — the verification ladder, all REAL-engine)          │
│   render → load → typecheck → run → consumer-tests                 │
└──────────────┬─────────────────────────────────────────────────────┘
               ▼ (consumes, NEVER edits)
        @simodelne/pgas-* on GitHub Packages (engine, sibling repo)
```

Hard boundary: the engine is upstream and read-only. Engine gaps are
filed on `simodelne/pgas` (Channel 4), never patched around in templates.

## 2. Mode graph (tooling equivalent: the two scaffold flows + the scaffolded program's graph)

**Mode A** `/pgas-new-consumer`: gather inputs (name, engine pin —
default `^1.13.0`, governance locks, frontend y/n) → render
`templates/new-consumer/` → consumer with a bootable server and four
injection markers, zero programs.

**Mode B** `/pgas-new-program`: detect consumer (MODE-B-DETECTION.md) →
optional 6-question design interview (purpose, entry channel, stages →
modes, decision points, delegation, completion) → render
`templates/new-program/` into `programs/<name>/` → marker injection →
SCAFFOLD VERIFICATION (loud PASS/FAIL).

**The scaffolded program's own graph** (the default the interview can
extend): `start` (bootstrap; sole admitter of `system_mode_entry` — FM3)
→ `begin_work` → `working` (handler-result-driven; `example_action`
writes `work.example`; the `open_example_gate` **reaction** — never the
LLM — sets `work.example_ready`) → guarded `complete_work` → `complete`
(terminal). Routing via top-level `proceed_to`; transitions per-mode with
predicate guards (`{kind: FieldTruthy, path}`) per the 1.13 strict-keys
shape.

## 3. Per-surface action table (tooling equivalent of per-mode actions)

| Surface | Action | Effect |
|---|---|---|
| `/pgas-new-consumer` | render Mode A tree | consumer repo w/ server, auth, CI, `.npmrc`, markers |
| `/pgas-new-program` | render Mode B tree + inject | program dir + 2 marker injections (import + `registry.register`) |
| marker `program-registry` | inject import | `import { create<Pascal>ProgramEntry } from '../programs/<n>/registration.js'` |
| marker `program-registration` | inject call | `registry.register('<n>', create<Pascal>ProgramEntry())` |
| markers `spec-registry`, `handler-registry` | **intentionally no injection** | registration.ts encapsulates; markers persist for inline-wiring consumers |
| hook `pre-tool-use-spec-validate` | block commit | staged `spec.yml` must pass `loadSpec` |
| hook `post-tool-use-arch-doc-nudge` | warn on `.0` publish | this very paper's forcing function |

## 4. Tools catalog (skills)

| Skill | Verifies | Level |
|---|---|---|
| `pgas:spec-validate` | `loadSpecWithPatterns()` accepts the spec (strict-keys gate, pgas#235 class) | load |
| `pgas:mode-entry-lint` | FM3: `system_mode_entry` only on bootstrap modes | static |
| `pgas:5-fm-audit` | FM1–FM5 closure across a consumer | static |
| `pgas:architecture-doc` | generates this paper's consumer equivalent | audit |

## 5. Gates and checkers — the verification ladder (the load-bearing section)

Six suites; `npm test` runs them all; CI runs them on every PR/push with
real GitHub-Packages auth (`PLUGIN_NPM_TOKEN`). Counts at v1.0.0:

| # | Gate | Rung | Proves (against the REAL engine) | v1.0.0 |
|---|---|---|---|---|
| 1 | `plugin-manifest` | meta | manifest valid, version lockstep, governance docs present | 20 pass |
| 2 | `template-render` | render | placeholders balanced, YAML parses, FM markers present | 137 pass |
| 3 | `auth-scaffold` | render | auth files render, migrations apply to SQLite | 20 pass |
| 4 | `server-typecheck` | typecheck | scaffold → real `npm install` → `tsc --noEmit` exit 0 | 8 pass |
| 5 | `spec-load` | **load** | rendered spec accepted by real `loadSpecWithPatterns` | 4 pass |
| 6 | `program-smoke` | **run** | in-process session (scripted-author seam, no LLM): boots at `start`, runs the full graph to `complete`/`Completed`, then the consumer's own `vitest run` passes (6/6 born-with tests) | 7 pass |

Doctrine (earned, see §8): **typecheck is not load; load is not run; run
is not the consumer's own test suite.** Every scaffold surface has a gate
that *executes* it. A SKIP is not a PASS (token-less environments SKIP
loudly with diagnostics).

## 6. Parameters

| Parameter | Default / shape | Where set |
|---|---|---|
| `{{CONSUMER_NAME}}`, `{{GH_OWNER}}`, `{{GOVERNANCE_LOCKS}}` | user input | Mode A |
| `{{PROGRAM_NAME}}`, `{{PROGRAM_SLUG}}`, `{{PROGRAM_NAME_PASCAL}}` | user input | Mode B |
| `{{ENGINE_VERSION}}` | `^1.13.0` | `commands/pgas-new-consumer.md` (tracks lowest engine whose surface the templates depend on) |
| `PLUGIN_NPM_TOKEN` | org-scoped `read:packages` PAT (owner-only) | repo secret; falls back to `GITHUB_TOKEN` → 403 → graceful SKIP |
| Node engines | plugin tooling ≥20; scaffolded consumers ≥24 | package.json engines |

## 7. Schema highlights (what the spec template carries and why)

- **Engine-owned, MUST stay declared** (FM5 + S-2; drift here is the
  v0.3.x incident class): `inputs.query_result.{kind,value_json}`,
  `inputs.query_meta.{source_path,source_channel,continuation_round,scope_redirect,message}`,
  `inputs.mode_entry.{mode,from_mode,entry_round}`,
  **`governance.round_counter`** (engine writes it at session
  construction; omission throws at `create()`).
- **Gate flags are reaction-owned**: `work.example_ready` appears in a
  reaction's mutations and a transition guard — never in an action's
  mutation list (the #1 gate-bypass anti-pattern, closed by construction).
- **Handler calling convention** (run-level truth): the engine invokes
  `handlers[action](payload)` — ONE argument — with the world snapshot at
  `payload.domain` as a **plain object** of flat dotted keys; the FM1
  resolver (`_resolver.ts`) implements payload-override-then-domain on
  that shape.
- Upstream ask pgas#309: auto-declare engine-owned paths at load time so
  consumers stop hand-copying engine internals.

## 8. Failure modes and salvage path

**Closed by construction (pgas#253):**

| FM | Closure |
|---|---|
| FM1 payload-vs-domain reads | `handlers/_resolver.ts` (resolver pattern) |
| FM2 missing continuation consumers | server template wires `InnerContinuationReplay` + `SessionLockExhausted` (load-bearing — removal reopens the ~50-min silent-stall) |
| FM3 `system_mode_entry` breadth | spec admits it on `start` only + `mode-entry-lint` |
| FM4 handler-backed tools silently `undefined` | `registration.ts.tmpl` ships the `createAdapters` override worked example |
| FM5 engine-owned paths undeclared | spec template carries the full set (§7) |

**Run-level defect classes the ladder catches** (each found by a gate
before any user hit it): stale spec keys vs engine strict-keys gate
(`mode_initial`, v0.3.0); missing engine-owned schema cell
(`governance.round_counter`, v0.3.1); port-shape mismatch hidden by an
`as never` cast (`NotificationSink`, v0.3.1); wrong handler calling
convention (v0.3.1); env-fragile test assertion (ANSI, post-v0.3.1).

**Salvage path / drift alarms:** the engine moves fast (1.9.0→1.13.0 in
three days). When `spec-load` or `program-smoke` breaks on a green
template, the ENGINE moved: read `~/Desktop/pgas` source (read-only),
re-shape templates, and file deltas upstream — never patch around the
engine in templates.

## 9. Versioning context

- **SemVer; `.claude-plugin/plugin.json` ⇄ `package.json` lockstep**
  (machine-enforced by `plugin-manifest.test.sh`).
- Patch = doc/test/CI + output-correcting bug fixes that add/remove no
  surface; Minor = additive scaffold surface or engine-pin bump relying
  on new engine surface; Major = breaking re-scaffold (placeholder/marker
  removal or rename).
- **History:** 0.1.0 foundation → 0.1.1 `.npmrc` + subpath stopgap +
  server-typecheck gate → 0.2.0 `/api` barrel (engine 1.9.0, pgas#256) →
  0.3.0 strict-keys spec shape + spec-load gate + registration.ts +
  born-with tests (engine 1.13.0) → 0.3.1 run-level defect fixes +
  program-smoke enforcing → **1.0.0 first stable: full ladder green,
  journey dogfooded end-to-end (~3.5 min)**.
- Dependency pins: engine `@simodelne/pgas-*@^1.13.0` (all 10 packages,
  lockstep-published); `js-yaml` 4.x (plugin tests); consumers get
  `hono`, `better-sqlite3`, `jose`, `vitest` 2.x, TS 5.7.

## 10. References

- Governance: `CLAUDE.md` (rulebook), `MEMORY.md` (running memory +
  decision log — the per-change rationale lives there).
- Protocol docs: `docs/MARKER-PROTOCOL.md`, `docs/MODE-B-DETECTION.md`,
  `docs/PLUGIN-DEVELOPMENT.md` (incl. "CI secrets", v0.1.1→v0.3 history).
- Upstream: pgas#253 (FM1–FM5), pgas#254 (this contract), pgas#256
  (`/api` barrel), pgas#235 (strict-keys trap class), **pgas#309** (open:
  auto-declare engine-owned paths).
- This repo: PRs #1–#23; issues #5/#6/#9 (all closed).

## Changelog (v1.0.0 vs prior)

First architecture paper — baseline. v1.0.0 is content-identical to
v0.3.1 plus this paper and the version graduation: the criterion for 1.0
was "every scaffold surface is gated by execution against the real
engine, and the full user journey is dogfooded green."
