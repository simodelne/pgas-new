# MEMORY - claude-pgas-plugin

Read after `CLAUDE.md`. This file records current branch state and durable
decisions. It is not a changelog and not a session handoff.

## Current State - 2026-06-18

- Active branch: `feat/pgas-new-foundry`.
- Direction: convert the old scaffold plugin into `pgas-new`, a PGAS-specific
  TypeScript/Node foundry for creating governed PGAS programs.
- Current server target: latest checked published `@simodelne/pgas-server` is
  `2.8.3`.
- Generated runtime code must use public server imports only:
  `plugin.js`, `create-server.js`, `client.js`, `channels/index.js`, and
  `routes/index.js`. `testing.js` is test-only.
- Existing-repo attachment requires fixed `.pgas/wiring.yml`. Without a valid
  manifest, `pgas-new` must not write to that repo and may create a curator
  request.
- Static implementation is in progress on this branch. Live graduation is still
  pending and must be user-selected before PR graduation.
- Do not touch `.remember/`; it is unrelated untracked session memory in this
  checkout.

## Decisions

### 2026-06-18 - v1 plugin surfaces removed from the foundry branch

The old user-facing plugin commands, skills, hooks, and consumer/frontend
templates were removed from the `pgas-new` branch. The current branch should not
advertise or test `commands/pgas-new-consumer.md`, `commands/pgas-new-program.md`,
`templates/new-consumer`, `templates/new-program`, `templates/frontend`, `skills`,
or `hooks`.

### 2026-06-18 - Session lifecycle controls are part of the control plane

The REPL/control-plane surface includes free text plus session commands:
`ask`, `new`, `abort`, `history`, `status`, `resume`, and `help`. The governed
action vocabulary includes matching session lifecycle actions, with abort gated
on an active running session.

### 2026-06-18 - Verification success must be evidence-backed

Generated specs should not let a tool call directly manufacture success by
setting `*_passed` booleans. Verification actions record status and evidence ids;
mode transitions check those state fields.

### 2026-06-18 - Notebook is durable program state

User inputs, ideas, design notes, and evidence belong in the notebook-backed
world/domain. PGAS `ActivationAction` can support advisory next-turn projection,
but it is not the primary memory mechanism for `pgas-new`.

## Pending Before Graduation

- Run full local static verification after the current cleanup.
- Conduct a real-provider live test through the generated external API.
- Rebase the graduation branch on the latest target branch.
- Rerun static verification after rebase.
- Open the PR with static and live evidence.
