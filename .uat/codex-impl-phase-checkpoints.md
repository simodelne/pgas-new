# Codex Implementation Phase Checkpoints

## Phase 0.5.1 - Architecture-diff CI gate

- Commit: `f0ed25e` (`feat(governance): architecture-diff CI gate (#37)`)
- Verification: `npm test` PASS on 2026-06-22.
- Notes: Generated scaffold install/test remained SKIP because `NPM_TOKEN` is not explicitly set; existing static gate reports this as SKIP, not PASS.

## Phase 0.5.2 - PR templates

- Commit: `a7fe43e` (`feat(governance): PR templates with Program Nature + re-platforming variant (#38)`)
- Verification: `npm test` PASS on 2026-06-22.
- Notes: Generated scaffold install/test remained SKIP because `NPM_TOKEN` is not explicitly set; existing static gate reports this as SKIP, not PASS.

## Phase 0.5.3 - UAT prompt template

- Commit: `a39faac` (`docs(governance): UAT prompt template + intent-verification convention (#39)`)
- Verification: `npm test` PASS on 2026-06-22.
- Notes: `.uat/uat-prompt-template.md` exists as an intentionally ignored local reference; `docs/UAT-PROMPT-TEMPLATE.md` records the convention in git. Generated scaffold install/test remained SKIP because `NPM_TOKEN` is not explicitly set.

## Phase 0.5.4 - README governance section

- Commit: `a90e078` (`docs(governance): README contributor-flow section`)
- Verification: `npm test` PASS on 2026-06-22.
- Notes: Generated scaffold install/test remained SKIP because `NPM_TOKEN` is not explicitly set; existing static gate reports this as SKIP, not PASS.

## Phase 0.5 Acceptance

- Verification: `npm test` PASS after commit `a90e078`; `npm run typecheck` PASS on 2026-06-22.
- Notes: All four Phase 0.5 commits landed. Generated scaffold install/test remained SKIP because `NPM_TOKEN` is not explicitly set.

## Phase 1 - Foundry-program relocation + engine dependency

- Commit: BLOCKED. `.git` is mounted read-only, so `git add`/`git commit` cannot create `.git/index.lock`.
- Verification before commit blocker: `npm run test:unit -- tests/unit/foundry-skeleton.test.ts` PASS; `npm test` PASS on 2026-06-22.
- R3-I2 decision: JSON-string scalar fallback required.
- R3-I2 evidence: nested-literal MSet failed in the engine loader with `CouplingError: S-11: action_map "example_action" MSet path "work.example_items" is array-typed`; after switching to `work.example_result_json` and `work.example_items_json` string fields, the skeleton loader test passed.
- Notes: Installed `@simodelne/pgas-server` resolved to `2.13.1` under the requested `^2.13.0` dependency range. The installed `testing.js` export resolves but does not export `loadSpecWithPatterns`; the test gates on `testing.js` resolvability and calls the installed public loader from `plugin.js`.

## Phase 2.1 - REPL extraction

- Commit: `5378396` (`feat(v3): Phase 2.1 — extract REPL into src/repl/{runner,renderer,types}.ts`)
- Verification: `npm test` PASS on 2026-06-22.
- Notes: Added injected-stream `runRepl`/`runStreamingRepl` surface with an in-memory fetch/SSE unit test for happy path, `/abort`, and unknown slash-command rendering. Generated scaffold install/test remained SKIP because `NPM_TOKEN` is not explicitly set.

## Phase 2.2 - Foundry server bootstrap

- Commit: `47b1172` (`feat(v3): Phase 2.2 — foundry-server bootstrap`)
- Verification: `npm test` PASS on 2026-06-22.
- Notes: Added `startFoundryServer({ port, hostname })`, mocked-spawn coverage for argv, `/healthz` readiness polling, and SIGTERM kill behavior. Generated scaffold install/test remained SKIP because `NPM_TOKEN` is not explicitly set.

## Phase 2.3 - Bare-entry REPL classifier

- Commit: `36a8941` (`feat(v3): Phase 2.3 — bare-entry REPL + classifier (Codex C1)`)
- Verification: `npm test` PASS on 2026-06-22.
- Notes: Bare and flag-only CLI invocations now start the foundry REPL; `--slug`, `--name`, and `--out` become `initialDomain` seeds; `--non-interactive` is accepted. Existing subcommand verbs stay on the legacy path. Generated scaffold install/test remained SKIP because `NPM_TOKEN` is not explicitly set.

## Phase 2.4 - Foundry spec intake actions

- Commit: `8b8f7b1` (`feat(v3): Phase 2.4 — foundry spec: 5 new intake actions + approve_artifact_plan idempotency`)
- Verification: `npm test` PASS on 2026-06-22.
- Shape decision: JSON-string scalar fallback. `apply_default_skeleton` and `record_program_intake` write `intake.stages_json`, `intake.transitions_json`, `intake.delegation_json`, and `intake.completion_json` as strings; the foundry runtime spec loader passes with that shape.
- Notes: Added a guarded `intake_intelligence -> repo_targeting` compatibility edge on `repo.target_kind` so the existing 10-mode graph remains loader-reachable while the Phase 2 intake-confirm path reaches `architecture_design`. Generated scaffold install/test remained SKIP because `NPM_TOKEN` is not explicitly set.

## Phase 2.5 - Intake handlers and integration flow

- Commit: `5c4bfa5` (`feat(v3): Phase 2.5 — 5 new intake handlers + integration test`)
- Verification: `npm test` PASS on 2026-06-22.
- Shape decision: `record_program_intake` handler accepts the Phase 2.4 JSON-string scalar fields (`stages_json`, `transitions_json`, `delegation_json`, `completion_json`) and returns structured parsed values in the domain output.
- Notes: Added the five intake handlers and tool registrations. The integration test drives both the custom Q1-Q6 path and the default skeleton path through `user_text` plus `user_confirmation` and verifies transition to `architecture_design`. The test also surfaced two engine-enriched input requirements: foundry `user_text` ingestion must stay single-path (`inputs.user_text`) for bare REPL text, and `user_confirmation` must declare `inputs.user_decision.note_mode` plus `inputs.user_decision.timestamp`.

## Phase 3.1 - Mechanical synthesizer + transit store

- Commit: `2d592f9` (`feat(v3): Phase 3.1 — mechanical synthesize_program_spec handler`)
- Verification: `npm test` PASS on 2026-06-22.
- Shape decision: governed state stores only `program.synthesis_complete = true`; synthesized YAML is held in the in-process session-scoped transit store and becomes durable when `write_scaffold_artifacts` writes `src/programs/<slug>/specs.yml`.
- Restart degradation: downstream handlers must throw `synthesized spec not in transit for session <id>; re-run synthesize_program_spec` when the transit store is missing after a process restart.
- Notes: Added the curator request for engine-level `from_handler` mutation support. Delegation intake is emitted as synthesized guidance because the installed engine loader rejects an unsupported top-level `delegations:` key.

## Phase 3.2 - Architecture synthesis to scaffold planning

- Commit: `813a1da` (`feat(v3): Phase 3.2 — wire architecture_design + scaffold_plan modes`)
- Verification: `npm test` PASS on 2026-06-22.
- Notes: `architecture_design` now runs `synthesize_program_spec` and transitions to `scaffold_plan` on `program.synthesis_complete`. `plan_artifacts` reads synthesized YAML from the transit store, parses it, and returns a standalone or existing-repo artifact plan while the spec-side mutation drafts `artifact_plan.status`.

## Phase 3.3 - Branch write + FM1 resolver artifact

- Commit: `50d2149` (`feat(v3): Phase 3.3 — wire branch_write + FM1 handlers/_resolver.ts (Codex C2)`)
- Verification: `npm test` PASS on 2026-06-22.
- Notes: `write_scaffold_artifacts` now reads synthesized YAML from transit, renders standalone or existing-repo artifacts with the synthesized spec, and returns generated paths. The artifact plan includes `handlers/index.ts` and `handlers/_resolver.ts` while retaining `handlers.ts` compatibility for existing generated registrations.

## Phase 3.4 - Real foundry handlers

- Commit: `786c25d` (`feat(v3): Phase 3.4 — 11 real handlers with mocked-spawn unit tests`)
- Verification: `npm test` PASS on 2026-06-22.
- Notes: Added mocked-spawn coverage for npm, git, gh, API blackbox, live-provider skip, manifest loading, curator-request writing, and the guarded web research stub. Handler-computed evidence ids remain handler return values because the installed engine still lacks `from_handler` mutation support.

## Phase 3.6 - Generalize synthesizer to N-stage programs

- Commit: `894c7e3` (`feat(v3): Phase 3.6 — generalize synthesizer to N ≥ 3 stages`)
- Verification: `npm test` PASS on 2026-06-22.
- Notes: Replaced the exact-3-stage guard with an N >= 3 contract. The synthesizer copies the skeleton `working` mode block for every intermediate intake stage and derives guard/schema/projection JSON-string scalar fields from the intake stage names. Generated scaffold install/test remained SKIP because `NPM_TOKEN` is not explicitly set.

## Phase 3.8 - Foundry server port env + ephemeral fallback

- Commit: `280c51d` (`fix(v3): Phase 3.8 — foundry-server port via PGAS_FOUNDRY_PORT env + ephemeral fallback (caught by §10)`)
- Verification: `npm test` PASS on 2026-06-22; Vitest reported 24 files passed, 159 tests passed.
- Notes: `startFoundryServer({})` now resolves `options.port` > `PGAS_FOUNDRY_PORT` > `0`, pipes stdout to read the `listening on port <N>` bound port when the OS assigns one, and returns a URL using the actual ready port. Generated scaffold install/test remained SKIP because `NPM_TOKEN` is not explicitly set.

## Phase 3.9 - Intake intelligence tool-call protocol

- Commit: `8e3b59b` (`fix(v3): Phase 3.9 — intake_intelligence prompt enforces tool-call protocol (caught by §10)`)
- Verification: `npx vitest run --config tests/vitest.config.ts tests/integration/foundry-tool-call-protocol.test.ts tests/integration/foundry-intake-flow.test.ts` PASS on 2026-06-22.
- Notes: `prompts.intake_intelligence` now tells live authors to call declared tools as tool calls, not raw JSON mutation envelopes, and to emit exactly one terminal tool call per round. The new protocol regression asserts the prompt clauses and verifies `record_program_target` writes governed target state.

## Phase 3.10 - CLI seed initial state routing

- Commit: `66e6f33` (`fix(v3): Phase 3.10 — CLI seed routes through initial state, not domain_context (caught by §10)`)
- Verification: `npx vitest run --config tests/vitest.config.ts tests/integration/foundry-cli-seed.test.ts tests/unit/cli-interactive.test.ts tests/unit/repl-runner.test.ts` PASS on 2026-06-22; `npm run typecheck` PASS on 2026-06-22.
- API choice: `sessions.create` exposes only `domain_context`, so the CLI uses the supported `PATCH /sessions/:id/domain` route immediately after create and before the first trigger.
- Notes: The session-create interceptor strips `program.*` CLI seeds out of `domain_context`, patches declared governed paths, and sets `program.target_dir_confirmed = true` when slug/name/target_dir are all seeded so the first LLM round can move to `choose_design_path` instead of repeating `record_program_target`.

## Phase 3.11 - Foundry server in-process bootstrap

- Commit: this commit (`fix(v3): Phase 3.11 — foundry-server in-process via createPgasServer (caught by §10)`)
- Verification: `npx vitest run --config tests/vitest.config.ts tests/unit/foundry-server.test.ts tests/integration/foundry-server-live.test.ts` PASS on 2026-06-22; `npm run typecheck` PASS on 2026-06-22; `npm test` PASS on 2026-06-22.
- Root cause: §10 round 3 Scenario A reached the first live E2E server launch and failed with `spawn pgas-server ENOENT`; the installed `@simodelne/pgas-server@2.13.1` package has no `bin` entry and exposes only ES-module API entrypoints.
- Notes: `startFoundryServer({})` now constructs the foundry entry in-process, starts `createPgasServer` directly, returns the bound port from `server.start()`, and maps `kill()` to `server.close()`. Unit coverage now mocks `createPgasServer`; the live integration smoke starts the real in-process engine and checks `/health` plus shutdown when the host permits loopback listeners.

## Phase 3.12 - REPL approval/rejection controls

- Commit: BLOCKED. `.git` is mounted read-only, so `git add`/`git commit` cannot create `.git/index.lock`. Intended commit: `fix(v3): Phase 3.12 — REPL /approve and /reject controls for user_confirmation channel (caught by §10)`.
- Verification: `npx vitest run --config tests/vitest.config.ts tests/unit/repl-controls.test.ts` PASS on 2026-06-22; `npm run typecheck` PASS on 2026-06-22; `npx vitest run --config tests/vitest.config.ts tests/integration/foundry-intake-flow.test.ts tests/unit/repl-runner.test.ts` PASS on 2026-06-22; `npm test` PASS on 2026-06-22.
- Root cause: §10 round 4 Scenario A typed `approve`, which the REPL routed as `user_text`; `confirm_design` requires a `user_confirmation` trigger, so GKPrecondition failed until the repair bound tripped.
- Notes: `/approve` and `/reject` now route through `runTrigger(..., 'user_confirmation', { decision, instruction? })`; plain text remains `user_text`, `/abort` still uses `client.controls.invoke`, and foundry guidance now tells the LLM to request slash controls for D4 confirmations instead of accepting plain text approval replies.

## Phase 3.13 - Intake question prompt contract

- Commit: this commit (`fix(v3): Phase 3.13 — remove request_user_action hallucination from foundry guidance (caught by §10)`)
- Verification: `npx vitest run --config tests/vitest.config.ts tests/integration/foundry-tool-call-protocol.test.ts tests/integration/foundry-intake-flow.test.ts` PASS on 2026-06-22; `npm test` PASS on 2026-06-22 with 28 Vitest files / 170 tests passed and generated scaffold install/test SKIP because `NPM_TOKEN` is not explicitly set.
- Root cause: §10 round 5 Scenario A followed a prompt that referenced `request_user_action`; the action is absent from the installed `@simodelne/pgas-server@2.13.1` bundle and from the foundry `intake_intelligence` vocabulary, so GKType rejected it until repair fallback.
- Notes: `intake_intelligence` now distinguishes question rounds from commit rounds: ask missing identity/design/Q1-Q6 questions as plain text and stop, consume the next `inputs.user_text`, and call `record_program_intake` only after all six answers/defaults are collected. The intake integration now covers six question rounds before the final intake record.

## Phase 3.15 - Synthesizer unconditional transitions

- Commit: this commit (`fix(v3): Phase 3.15 — synthesizer accepts unconditional transitions (caught by §10)`)
- Verification: `npm run test:unit -- tests/unit/synthesize-program-spec.test.ts` PASS on 2026-06-22; `npm run test:unit -- tests/integration/synthesis-regression.test.ts` PASS on 2026-06-22; `npm run typecheck` PASS on 2026-06-22; `npm test` PASS on 2026-06-22 with 28 Vitest files / 173 tests passed and generated scaffold install/test SKIP because `NPM_TOKEN` is not explicitly set.
- Root cause: §10 Round 7 reached `synthesize_program_spec`, but `apply_default_skeleton` writes an unconditional `start -> working` transition while the synthesizer threw on any missing `guard_field`.
- Notes: Transitions without `guard_field` now emit no `guard` clause, guarded transitions retain `FieldTruthy`, and transitions into `completion.final_stage` still derive their guard from `completion.guard_field`. Missing completion guards and missing incoming completion transitions remain hard synthesizer errors. Per instruction, §10 was not rerun.

## Phase 3.16 - Native tool-call protocol + deterministic artifact plans

- Commit: this commit (`fix(v3): Phase 3.16 — native tool schemas + deterministic artifact plans (caught by §10)`)
- Verification: `npx vitest run --config tests/vitest.config.ts tests/integration/foundry-tool-call-protocol.test.ts` PASS on 2026-06-22; `npx vitest run --config tests/vitest.config.ts tests/integration/foundry-plan-artifacts-deterministic.test.ts` PASS on 2026-06-22; `npm run typecheck` PASS on 2026-06-22; `npm test` PASS on 2026-06-22 with 29 Vitest files / 176 tests passed and generated scaffold install/test SKIP because `NPM_TOKEN` is not explicitly set.
- Root cause: §10 Round 8 exposed two related action-boundary leaks. The native tool schema generator already derives parameters from action-map `from_arg` mappings, but the foundry prompt/guidance also exposed the literal `from_arg` term to the author, so Qwen copied it as an argument name in Scenario G. Separately, `plan_artifacts` had no `result_path`, so its deterministic handler result was not committed to governed state and the LLM-supplied effect payload remained the visible action output.
- Notes: LLM-facing intake prose now refers only to each action's named argument, and core intake actions carry explicit `arg_descriptions` for the native tool schemas. The native regression drives `createPgasServer` with `authorMode: 'unified'`, asserts the prompt no longer leaks `from_arg`, verifies `record_program_target` exposes `{slug,name,target_dir}` in OpenAI tool parameters, and verifies legacy `MutationAction` content falls back without mutating target state. `plan_artifacts` now emits on a dedicated synchronous `artifact_plan_output` channel with `result_path: artifact_plan.artifacts`; the handler returns only the deterministic artifact list from `createStandaloneArtifactPlan` / `createExistingRepoArtifactPlan`, ignoring hallucinated LLM artifact payload fields.
