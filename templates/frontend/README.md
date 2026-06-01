# templates/frontend/ — placeholder

This directory is intentionally minimal in plugin v0.1.

**Brief 3 (v0.3 of the plugin) will land a frontend snapshot here**,
templated from `~/Desktop/simoneos/frontend/`. The snapshot will
include:

- React + Vite + TypeScript scaffold
- Hono-API client bindings to the consumer's server
- WS client wired to pgas-server's session WebSocket
- Per-widget rendering for the standard pgas widget set
- Auth integration (depends on Brief 2 landing first)

Until Brief 3 ships, consumers provide their own frontend (per
`simodelne/pgas-rag`/CLAUDE.md "What this repo is NOT" — frontend is
not a scaffold concern in v0.1).

**No action required from the orchestrator in v0.1.** The
`/pgas-new-consumer` command does NOT touch `templates/frontend/`; the
scaffolded consumer has no `frontend/` directory until Brief 3 adds
the scaffold step.
