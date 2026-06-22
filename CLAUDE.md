# pgas-new

> READ FIRST, IN ORDER, EVERY SESSION:
> 1. This file (governance rules)
> 2. `docs/PGAS-NEW-ARCHITECTURE.md` (the program's nature — what pgas-new IS)
> 3. `MEMORY.md` (current state + strategic invariants + tactical decisions)
> 4. `.remember/remember.md` (latest transient handoff, if present)
>
> All four are required. Skipping #2 was the root cause of the 2026-06-19→22
> design-phase drift documented in `docs/POST-MORTEM-2026-06-22-design-phase-drift.md`.

## Program Nature (load-bearing — do not weaken)

**What pgas-new IS:** an interactive PGAS-program design foundry. It is itself
a PGAS program. Its CLI starts a streaming REPL session against the foundry's
own program spec; an LLM agent walks the user through phases
(`intake_intelligence → architecture_design → scaffold_plan → branch_write →
static_verify → live_verify → rebase_verify → pr_graduation`), synthesizes a
fresh PGAS spec from the user's intake, plans artifacts, writes them, runs the
verification ladder, and graduates a PR. The full design contract lives in
`docs/PGAS-NEW-ARCHITECTURE.md`.

**What pgas-new MUST NOT drift to:**

- A preset-template selector. Per-domain templates (`policy-drafting`,
  `web-scraper`, `social-media-agent`) are **graduation evidence**, not
  product surface. They live in `docs/graduation-evidence/` (since v2.7.0)
  for regression-corpus purposes only. The CLI must not surface them as
  `--template <preset>` flags after v3.0.
- A non-conversational one-shot file emitter. The original v1.0 was a Claude
  Code slash command with a 6-question design interview. The TypeScript
  re-platforming (commit `3d832b5`, 2026-06-19) silently deleted that interview
  and shipped a render-only CLI. v3.0 restores the interview through the
  streaming REPL.
- A "general coding assistant." pgas-new does PGAS programs only.

**The foundry's own PGAS spec** (`templates/pgas-new/program/specs.yml.tmpl`)
declares the 10 modes above. That spec IS the design contract. If you change
the CLI in a way that bypasses any of those modes, you are drifting away from
the program's nature — stop and surface the change.

## What This Repo Is

This repo builds `pgas-new`: a TypeScript/Node PGAS foundry for creating
new PGAS programs. It is not a general coding assistant. Its job is to **drive
an interactive design session** that synthesizes governed specs, plans
artifacts, writes them, runs verification gates, and graduates a PR — aligned
with the published `@simodelne/pgas-server` API.

The original v1 Claude plugin commands, skills, hooks, and consumer templates
have been removed from the v2 branch. Do not recreate `commands/`,
`templates/new-consumer/`, `templates/new-program/`, `templates/frontend/`,
`skills/`, or `hooks/` unless the owner explicitly asks for a legacy restore.
The interactive-design intent of those v1 surfaces is restored in v2.7.x via
the streaming REPL + bare `pgas-new` (no-args) command, not by reviving the v1
plugin surface.

## Engine Boundary

- `@simodelne/pgas-server` is upstream and read-only from this repo.
- `pgas-new` consumes only public package exports from the latest checked
  published server version in `src/pgas-new/version.ts`.
- Runtime generated code may import only the approved runtime subpaths.
  `@simodelne/pgas-server/testing.js` is test-only.
- If a needed server surface is missing, file a curator/upstream request instead
  of patching around private internals.

## Current Surface

| Path | Purpose |
|---|---|
| `src/cli.ts` | `pgas-new` command entry point |
| `src/pgas-new/` | governed model, gates, manifest parsing, planning, rendering, verification |
| `templates/pgas-new/` | generated standalone PGAS program scaffold |
| `tests/unit/` | TypeScript unit coverage |
| `tests/static/` | generated scaffold static checks |
| `tests/pgas-new-static.test.sh` | shell wrapper for structural/static gates |
| `docs/PGAS-NEW-ARCHITECTURE.md` | approved architecture note |
| `docs/PGAS-NEW-LIVE-GRADUATION.md` | live-provider graduation contract |

## PGAS-New Invariants

- Initial consumer support is TypeScript/Node only.
- Existing-repo attachment requires a fixed `.pgas/wiring.yml` manifest.
  Without a valid manifest, the foundry must not write files; it may lodge a
  curator request.
- User research requires explicit user confirmation unless the user directly
  requested a specific research task.
- Notebook state is durable program state, not conversation history.
- Generated artifacts are first-class records, not incidental side effects.
- Live graduation requires a real provider round trip through the external API.
- Before PR graduation, the branch must be rebased on the latest target branch
  and static verification must be rerun.

## Commands

```bash
npm test
npm run typecheck
npm run test:unit
npm run test:static
npm run pgas-new -- --help
```

Generated standalone scaffold verification is exercised from
`tests/pgas-new-static.test.sh`; it renders a scaffold, installs dependencies,
typechecks, and runs generated tests.

## Classifier Denial Is A Hard Stop

When `Claude Code auto-mode classifier` denies a tool call, stop. Do not retry
the same call with `dangerouslyDisableSandbox: true` or any equivalent bypass.
Surface to the user: what was attempted, why it seems needed, and what a smaller
alternative looks like.

This holds even when the denial seems mistaken. The classifier is the user's
oversight layer; bypassing it removes the human-in-the-loop the user explicitly
opted into.

## Development Rules

- Keep edits scoped to `pgas-new` unless intentionally updating governance,
  tests, or docs.
- Do not add arbitrary shell execution. Use semantic command IDs and fixed argv
  mappings.
- Use `apply_patch` for manual edits.
- Do not revert unrelated user changes.
- Run verification before claiming completion.
