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

```
$ pgas-new design legal-fee-proposals
```

1. CLI renders the `pgas-new-foundry` template to a temporary working dir.
2. CLI starts the rendered foundry's embedded server against the configured LLM provider.
3. CLI starts the rendered foundry's streaming REPL (the one we shipped in v2.5.x).
4. The foundry program runs. Its first mode is `intake_intelligence`.

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
- Add `pgas-new design <slug> [--name "..."]` CLI command. Renders `pgas-new-foundry` to a temp dir, starts its server + REPL, the user goes through the modes interactively. At `branch_write`, the foundry writes the synthesized program to the user's `--out` dir (or PWD).
- Add a `record_intake` action variant in the foundry's spec that captures Q1–Q6 to `intake.purpose`, `intake.entry_channel`, `intake.stages`, `intake.transitions`, `intake.delegation`, `intake.completion`.
- Old `--template` flags still work.

**v2.9.0** (additive, synthesis):
- Implement `synthesize_program_spec` action in the foundry's handler (per §3).
- The action writes the synthesized spec to `architecture.synthesized_spec` and runs validator before completing.
- `scaffold_plan` reads `architecture.synthesized_spec` and produces an artifact plan from it.
- `branch_write` writes the synthesized spec + handlers + tools (boilerplate handlers/tools generated from the spec's action_map and channel list).
- Add deterministic regression tests: feed each graduation `MANDATE.md` into the synthesis flow (with a deterministic LLM stub for the intake conversation) and assert the output matches the frozen graduation spec within a structural-equivalence margin.

**v3.0.0** (breaking, cleanup):
- Delete `--template policy-drafting|web-scraper|social-media-agent`. Print error suggesting `pgas-new design <slug>`.
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
