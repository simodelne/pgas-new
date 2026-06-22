# v3.0 Design — Restore the REPL-driven phase walk

Date: 2026-06-22  
Status: draft (for review)  
Tracks: issue #35  
Supersedes: the prior draft of this file at commit `b20f888` (mandate-string framing — wrong, kept in git history)

## Premise

`pgas-new` was originally a **Claude Code slash command** (`/pgas-new-program`, v1.0.0) that ran an **interactive 6-question design interview in the user's session**:

```
Q1 Purpose       → spec preamble ROLE + manifest.description
Q2 Entry channel → bootstrap mode input channel
Q3 Stages of work → MODE NAMES (not picked from preset!)
Q4 Decision points → extra transitions, optional guards
Q5 Delegation    → delegationPolicy TODO + architecture-doc note
Q6 Completion criteria → terminal mode + guard
```

The answers **parameterized a generic skeleton.** There were no `policy-drafting` / `web-scraper` / `social-media-agent` preset programs — those didn't exist yet.

Commit `3d832b5` ("feat: add pgas-new foundry", 2026-06-19) re-platformed pgas-new from a Claude Code plugin to a TypeScript/Node CLI. In that one commit, the interactive interview was **deleted** (the CLI has no in-session LLM), and only the "render templates" step survived. The graduation programs (PR #27, #28, #29) were then **hand-authored** to prove the render step worked, and got bolted onto the CLI as `--template <preset>` because the design phase was already gone.

**That's the drift.** It happened in a single commit and was driven by a platform change, not a design decision.

## v3.0 goal

Restore the v1 intent on the v2.x foundation. The user gets back the REPL conversation that walks them through phases — but now it runs in the streaming REPL shipped in v2.5.x, against the foundry's own PGAS program (which already declares the right 10 modes), against a real engine (`@simodelne/pgas-server@2.13.0`).

**Anti-goal:** the `--mandate "<string>"` one-shot synthesis from the prior draft of this doc is wrong. A single string can't carry the structure the v1 interview captured. The conversation is the design phase.

## How v3.0 works (end-to-end)

The user runs **`pgas-new`** with no arguments. Like running `claude` or `codex` — the REPL opens immediately and the agent drives the conversation:

```
$ pgas-new

  pgas-new — PGAS program design foundry
  starting design session...

● Connected  mode: intake_intelligence

agent ▸ What do you want this program to do? Describe it freely; I'll
        ask follow-ups to fill in the gaps.

› I want an agent that drafts incident postmortems for SimoneOS.
  It should pull from the incident timeline, ask the on-call for
  any missing context, and produce a structured doc...

  ⠸ reading context… asking follow-ups…

agent ▸ Got it. Two follow-ups:
        1. How does work arrive — a user message kicking off a new
           incident, a webhook from an alerting system, or both?
        2. What are the distinct stages this work moves through?
           (e.g. intake → reconstruction → draft → review → publish)

› ...

[agent walks through Q1–Q6 of the v1 interview; records to state]

→ mode: architecture_design
  ⠸ synthesizing program spec…

agent ▸ Here's the program I'd build for you:
  ┌─ proposed spec ────────────────────────────────────────────┐
  │ modes: intake → reconstruction → draft → review → publish  │
  │ channels: user_text, user_confirmation, widget_output      │
  │ schema fields: incident.id, incident.timeline, draft.body  │
  │ ...                                                        │
  └────────────────────────────────────────────────────────────┘
  Approve? [y/n/edit]

› y

→ mode: scaffold_plan      [Plan presented; user approves]
→ mode: branch_write       [Files written to ./incident-postmortems/]
→ mode: static_verify      [npm install, typecheck, tests — all green]
→ mode: pr_graduation      [Optional: open the PR]

✓ Done. Your program is at ./incident-postmortems/.
```

**That's the entire UX.** Single command. Single process. Real LLM. Real engine. Real artifacts on disk at the end.

### How the CLI implements this

`pgas-new` with no args (or with optional `--slug <slug> --out <dir>`):

1. CLI spawns an **embedded foundry server** in a child process. The server runs the foundry's own PGAS program (the spec at `templates/pgas-new/program/specs.yml.tmpl`, rendered + pre-bundled into the npm package at build time). The child's stdout/stderr is suppressed (or routed to a log file).
2. CLI waits for the child server's `/health` to respond.
3. CLI runs the **streaming REPL** we already ship (`templates/pgas-new/standalone/src/repl/{index,renderer}.ts`) in-process, connected to the child server via HTTP + WS.
4. The REPL opens a session against the foundry program. The session's first mode is `intake_intelligence`. The agent runs under the foundry's spec, asks Q1–Q6 + follow-ups, records to governed state.
5. Each mode advances when its exit gate is met. The REPL prints mode banners (`→ mode: architecture_design`), spinner phases (`reading context…`, `synthesizing…`), and action results (the proposed spec, the artifact plan, the verify ladder output).
6. When the user reaches `pr_graduation` (or types `/exit`), CLI kills the child server cleanly and exits.

### Subcommand surface (post-v3.0)

```
pgas-new                                  # primary: interactive design session
pgas-new --slug <slug> --out <dir>        # primary with pre-set slug/out
pgas-new --non-interactive --slug ...     # CI/scripted (errors if intake needs questions)
pgas-new version                          # one-shot, no REPL
pgas-new validate-manifest --repo <repo>  # one-shot, no REPL
pgas-new render-foundry --out <dir>       # one-shot self-bootstrap (replaces --template pgas-new-foundry)
pgas-new --help                           # one-shot
```

`render-standalone` / `render-attach` / `plan-standalone` / `plan-attach` / `curator-request` are removed from the CLI surface in v3.0; their behavior is internalized into the foundry's `scaffold_plan` and `branch_write` modes. Programmatic users can still drive the foundry via the same HTTP+WS API that the REPL uses.

Now the **agent walks the user through phases**, asking questions in the REPL, recording answers as governed state. Each mode advances when its exit gate is met. The user types, the agent responds, the spinner shows live SSE phases, mode banners print when modes change. **This is exactly what the v1 slash command did, but in a real REPL against a real engine.**

The 10-mode walk (already declared in `templates/pgas-new/program/specs.yml.tmpl`):

| Mode | What the agent does |
|---|---|
| `intake_intelligence` | Asks the v1 6 questions (Purpose, Entry channel, Stages, Decision points, Delegation, Completion) and any follow-ups. Records to `intake.*` and `notebook.*`. Optionally runs `web_research` if the user authorizes. |
| `repo_targeting` | Asks whether to scaffold a standalone repo or attach to an existing repo. If existing, loads `.pgas/wiring.yml`. If missing, produces a curator request. |
| `architecture_design` | Synthesizes the new PGAS spec from `intake.*`: stages become modes, decision points become transitions with guards, completion becomes terminal + guard. Records the synthesized spec to `architecture.*`. **This is the new synthesis action — described in §3 below.** |
| `scaffold_plan` | Emits a first-class artifact plan for the synthesized program (specs.yml, registration.ts, handlers.ts, tools.ts, dossier, audit, tests, repo wiring). User approves. |
| `branch_write` | Writes the planned artifacts to the target dir. Only planned artifacts. |
| `static_verify` | Runs the static ladder on the freshly written scaffold: `npm install`, `npm run typecheck`, `npm test`. Records evidence. |
| `live_verify` | (optional, user-confirmed) Runs a real-provider round trip against the generated program's external API. |
| `rebase_verify` | (for attach flows) Rebases on the target repo's latest and reruns static. |
| `pr_graduation` | Opens the PR. Terminal. |
| `curator_request` | Side branch when a repo has no manifest or invalid wiring. |

When the user reaches `pr_graduation` (or `branch_write` if they're not opening a PR), they have a working PGAS program tailored to their mandate, written to disk, typechecked, tested.

## §3 The new synthesis action

The single new piece of foundry-program logic v3.0 needs is an action in `architecture_design` mode that turns the structured intake into a PGAS spec.

**Action: `synthesize_program_spec`**

Input (read from state, populated during `intake_intelligence`):

```ts
{
  purpose: string,                  // Q1
  entry_channel: 'user_text' | 'webhook' | 'schedule' | ..., // Q2
  stages: Array<{                   // Q3
    slug: string,                   // e.g. 'intake', 'drafting'
    description: string,
    is_bootstrap?: boolean,         // first stage
    is_terminal?: boolean,          // last stage
  }>,
  transitions: Array<{              // Q4
    from: string,
    to: string,
    trigger: 'auto' | 'user_text' | 'user_confirmation',
    guard_field?: string,           // dotted path
    guard_value?: unknown,
  }>,
  delegation?: { from_mode: string, to_program: string }, // Q5
  completion: {                     // Q6
    final_stage: string,
    guard_field: string,            // e.g. 'work.example_ready'
  },
}
```

Output (written to `architecture.synthesized_spec` as a structured object that `scaffold_plan` later renders to YAML):

```ts
{
  name: string,           // from intake.program_slug
  preamble: string,       // generated from purpose + stages
  modes: Record<string, ModeSpec>,   // one per stage, FM3-safe (only bootstrap admits system_mode_entry)
  channels: Record<string, ChannelSpec>,
  ingestion: Record<string, string[]>,
  schema: Record<string, string>,
  action_map: Record<string, ActionSpec>,
  proceed_to: Record<string, string>,
  control_plane: ControlPlaneSpec,
  // ... (full spec)
}
```

Synthesis rules — mechanical, the same as v1 (no freeform LLM JSON):

1. Stage names → mode keys. First stage = bootstrap mode (the only one admitting `system_mode_entry`). Last stage = terminal mode.
2. For each non-bootstrap, non-terminal stage: copy the `working` mode block template, rename it. Keeps the FM3-safe channel set.
3. For each transition: emit a `from → to` row with the optional `guard`.
4. Completion: terminal-mode transition gated on `work.<completion_field>`.
5. Channels: emit `user_text`, `widget_output`, `system_mode_entry` (foundry-default) + any from `entry_channel`.
6. `control_plane`: emit the standard 7-control vocabulary.
7. Validate against the engine's spec loader before declaring the action complete.

The LLM does **judgment** in `intake_intelligence` (asking questions, follow-ups, recording structured answers); the **synthesis itself is deterministic code** running inside the foundry handler. That keeps the spec shape predictable and testable.

## Phased delivery

**v2.7.0** (non-breaking, prepare):
- Move `templates/pgas-new/consumer/{policy-drafting,web-scraper,social-media-agent}/` to `docs/graduation-evidence/{...}/`. Preserve files verbatim.
- For each moved program, add a `MANDATE.md` capturing the structured intake (Q1–Q6 answers) that would produce a structurally-equivalent program.
- Keep the `--template policy-drafting|web-scraper|social-media-agent` CLI flag working but mark deprecated in `--help`. Print a warning when used.

**v2.8.0** (additive, conversation):
- `pgas-new` with **no arguments** opens the REPL directly (like `claude` or `codex`). The CLI:
  1. Spawns an embedded foundry server as a child process (the foundry's PGAS program rendered into a stable per-installation working dir, e.g. `~/.pgas-new/foundry/`, on first run; bundled in the npm package so no on-first-run install penalty).
  2. Waits for child server's `/health`.
  3. Connects the streaming REPL (in-process) to the child server via HTTP+WS.
  4. Opens a foundry session against the foundry program (whose first mode is `intake_intelligence`).
  5. The agent drives the conversation. When the user reaches `pr_graduation` or types `/exit`, CLI kills the child cleanly.
- Optional flags: `--slug <slug>` (pre-fills the slug so the agent doesn't have to ask), `--out <dir>` (target dir for `branch_write`, defaults to `./<slug>` from intake), `--non-interactive` (CI mode — errors if the agent needs to ask anything).
- Add `record_program_intake` action to the foundry's spec that captures Q1–Q6 to `intake.purpose`, `intake.entry_channel`, `intake.stages`, `intake.transitions`, `intake.delegation`, `intake.completion`.
- Add guidance to `intake_intelligence` mode instructing the LLM to run the 6-question interview when `intake.program_intake_recorded` is false.
- Old `--template <consumer>` flags still work (deprecated since v2.7.0); the bare `pgas-new` REPL is the new primary surface.
- Old subcommands (`plan-standalone`, `render-standalone`, `validate-manifest`, `plan-attach`, `render-attach`, `curator-request`) still work for scripted use.

**v2.9.0** (additive, synthesis):
- Implement `synthesize_program_spec` action in the foundry's handler (per §3).
- The action writes the synthesized spec to `architecture.synthesized_spec` and runs validator before completing.
- `scaffold_plan` reads `architecture.synthesized_spec` and produces an artifact plan from it.
- `branch_write` writes the synthesized spec + handlers + tools (boilerplate handlers/tools generated from the spec's action_map and channel list).
- Add deterministic regression tests: feed each graduation `MANDATE.md` into the synthesis flow (with a deterministic LLM stub for the intake conversation) and assert the output matches the frozen graduation spec within a structural-equivalence margin.

**v3.0.0** (breaking, cleanup):
- Delete `--template policy-drafting|web-scraper|social-media-agent`. Print error suggesting `pgas-new` (no args).
- Move the scripted subcommands (`plan-standalone`, `render-standalone`, `plan-attach`, `render-attach`, `validate-manifest`, `curator-request`) behind a `pgas-new ci ...` namespace OR remove them entirely (the foundry's HTTP+WS API is the supported scripting interface).
- `pgas-new render-foundry --out <dir>` becomes the only remaining one-shot render command (replaces `--template pgas-new-foundry`).
- Delete `templates/pgas-new/consumer/`.
- `--template pgas-new-foundry` stays as the bootstrap path.
- Update README, architecture doc, all docs. Cut v3.0 release.

## What stays the same in v3.0

- PGAS contract: public-only imports, banned-import scanner, `system_mode_entry` continuation channel, `control_plane` vocabulary.
- Streaming REPL (`index.ts` + `renderer.ts`): generated programs use it; the foundry uses the same REPL to drive its own design session.
- Artifact-plan-first discipline.
- `.pgas/wiring.yml` manifest for existing-repo attach.
- Verification ladder (`static_verify` → `live_verify` → `rebase_verify` → `pr_graduation`).

## Implementation delegation

Implementation of Phase 1 + Phase 2 is delegated to Codex (see the Codex prompt in `.uat/codex-impl-prompt-phase-1-2.md` — Codex runs with `workspace-write` sandbox, approval policy `never`, and works on a branch).

Phase 3 (synthesis + regression tests) is the riskiest piece and should land as its own PR after Phase 2 ships and the conversation flow is verified end-to-end. Phase 4 (breaking) only after Phase 3 ships.
