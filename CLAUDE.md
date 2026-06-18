# claude-pgas-plugin

> READ FIRST. This is the load-bearing governance doc for this repo. Every
> Claude session here must obey it. Then read `MEMORY.md` for current state and
> `.remember/remember.md` for the latest transient handoff when present.

## What This Repo Is

This repo now builds `pgas-new`: a TypeScript/Node PGAS foundry for creating
new PGAS programs. It is not a general coding assistant. Its job is to generate
PGAS-specific program scaffolds, governed specs, repo attachment requests, and
verification gates aligned with the published `@simodelne/pgas-server` API.

The original v1 Claude plugin commands, skills, hooks, and consumer templates
have been removed from this branch. Do not recreate `commands/`,
`templates/new-consumer/`, `templates/new-program/`, `templates/frontend/`,
`skills/`, or `hooks/` unless the owner explicitly asks for a legacy restore.

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
