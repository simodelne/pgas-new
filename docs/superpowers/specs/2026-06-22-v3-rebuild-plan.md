# v3.0 Rebuild Plan — Restore the agent-driven foundry (revision 6)

Date: 2026-06-22  
Status: revision 6 (addresses Codex r5 verdict NEEDS REVISION — uses existing `approve_artifact_plan` action + `artifact_plan.approved` field instead of fabricating duplicates); pending re-validation  
Supersedes: revisions 2 (`679e114`) / 3 (`bfd4064`) / 4 (`d187135`) / 5 (`ffc865c`)  
Anchors:
- v1 source: `commands/pgas-new-program.md` (recoverable from commit `3d832b5^`)
- v1 architecture paper: `audit/ARCHITECTURE-claude-pgas-plugin-v1.0.0.md` (recoverable from `3d832b5^`)
- Current architecture doc: `docs/PGAS-NEW-ARCHITECTURE.md`
- Trace: `docs/superpowers/specs/2026-06-22-v3-trace-from-v1-original.md` (updated in r3 — see §16)
- Post-mortem: `docs/POST-MORTEM-2026-06-22-design-phase-drift.md`
- Strategic invariants: `MEMORY.md` (SI-1 through SI-5)
- Revision 2: commit `679e114`
- Codex r1 validation: `.uat/codex-validate-rebuild-plan-report.md`
- Codex r2 validation: `.uat/codex-validate-rebuild-plan-r2-report.md` ("APPROVED WITH MINOR FIXES" — 5 cleanups, no human decisions)

**What changed from r2 → r3** (per Codex r2 cleanup items N1–N5):
- N1: `program.target_dir` + `program.target_dir_confirmed` added to schema + projection; new `record_program_target` action; identity capture explicit in `intake_intelligence` guidance.
- N2: `@simodelne/pgas-server` dependency addition moved from Phase 2.1 into Phase 1's atomic commit so the skeleton's engine-loader test can actually run in Phase 1.
- N3: Trace doc updated to use `confirm_design` (not `confirm_architecture`) and `program.synthesized_spec` (not `architecture.synthesized_spec`). The two-action default-path approach (`choose_design_path` + `apply_default_skeleton`) is kept by design per N5 — declarative MSet over handler-side state extension. CLAUDE.md foundry-spec path updated from `templates/pgas-new/program/specs.yml.tmpl` to `src/foundry-program/specs.yml`.
- N4: E2E "0 llm_call events" assertion replaced with handler-instrumentation marker check (the synthesizer handler emits `{kind: 'mechanical_synthesis', no_llm_call: true}` in its action result; E2E asserts on that field).
- N5: Default-path is now a **two-action sequence**, both with declared mutations: `choose_design_path` (records `program.design_path` only) + `apply_default_skeleton` (populates `intake.*` defaults via MSet literals, with a precondition `program.design_path == 'default'`). No handler-side state extension; all mutations are spec-declared.

## §0 Goal (Simone's own words, verbatim)

> *"pgas-new was meant to be an agent for creating new pgas-engine consumers either as standalone repo or as programs within existing repos like simoneos built in accordance with a blueprint of file organization and governance and in accordance to a manifest."*

## §1 Resolved decisions (6 open questions, owner-approved)

| # | Question | Decision |
|---|---|---|
| **D1** | Primary CLI invocation | **Bare `pgas-new`** opens the streaming REPL. No subcommand needed. `pgas-new --slug foo --out /tmp/bar` is equivalent with pre-filled inputs. `pgas-new design <slug>` is NOT in the v3.0 surface. |
| **D2** | Legacy scripted subcommands | **Keep indefinitely at top level.** `render-standalone`, `render-attach`, `validate-manifest`, `plan-standalone`, `plan-attach`, `curator-request`, `session`, `version`, `help` all stay as top-level subcommands. Only the consumer-preset `--template <consumer>` flag values get removed in v3.0. |
| **D3** | Synthesized-spec state namespace | **`program.synthesized_spec`** under existing `program.*`. No new top-level namespace. Adds `program.synthesized_spec`, `program.design_confirmed`, `artifact_plan.approved` to the existing fields in `PgasNewState`. |
| **D4** | User confirmation steps before write | **Two confirms.** (1) End of `intake_intelligence`: agent echoes proposed mode list + transitions; user approves to enter `architecture_design`. (2) End of `scaffold_plan`: agent shows artifact-plan list; user approves to enter `branch_write`. |
| **D5** | Foundry-program asset strategy | **First-run rendered to `~/.pgas-new/foundry-v<version>/`**, cached for subsequent invocations. `pgas-new` spawns a child server via `node --import tsx <workdir>/server.ts` on that rendered foundry. Render is idempotent + skipped if the working dir already exists for the current version. |
| **D6** | Governance corrections #37/#38/#39 | **Prerequisite — implement before v3 work starts.** Land #37 (architecture-doc CI diff), #38 (PR-template Program Nature checkbox), and #39 (UAT intent-verification template) first. Every subsequent v3 PR flows through the new gates. |

## §2 Non-goals

- A general coding assistant
- A GUI / web UI
- Multi-language program generation (TypeScript/Node only)
- Public npm publication (GitHub Packages stays)
- Reviving v1's marker-injection mechanism (`.pgas/wiring.yml` manifest contract is the v2 replacement — documented design decision)
- Implementing v1's `pgas-program-builder` Claude skill (replaced by the foundry's own `intake_intelligence` mode running on pgas-server)

## §3 What the foundry is, after v3.0

`pgas-new` is itself a **PGAS program** running on `@simodelne/pgas-server`. Its spec lives at `src/foundry-program/specs.yml` (not under `templates/`), declares 10 modes (`intake_intelligence → repo_targeting → architecture_design → scaffold_plan → branch_write → static_verify → live_verify → rebase_verify → pr_graduation → curator_request`), and its handlers do real work (file I/O, npm, git, PR opening, manifest loading, curator-request rendering).

`pgas-new` invoked **with no arguments** (or with `--slug <slug>`, `--name <name>`, `--out <dir>`) spawns an embedded `@simodelne/pgas-server` child process loaded with the foundry program, hosts the streaming REPL in-process connected via HTTP+WS, opens a session against the foundry program (whose first mode is `intake_intelligence`), and the agent drives the conversation through the 10 modes. Single command. Single process. Two user confirmation gates (D4) before any files land on disk.

Output: a fresh PGAS consumer (standalone repo per **standalone mode**, or program-within-existing-repo per **attach mode** governed by `.pgas/wiring.yml`), conforming to the canonical blueprint, with the user's program design synthesized **deterministically** from intake answers via mechanical rename+copy from a generic skeleton.

## §4 Salvage list — files that stay, with disposition

(Codex I1 fix: changed from "exactly as-is" to per-file disposition.)

| Path | Current lines | Disposition |
|---|---|---|
| `templates/pgas-new/standalone/package.json.tmpl` | 26 | Stay as-is. Generic blueprint. |
| `templates/pgas-new/standalone/tsconfig.json.tmpl` | 14 | Stay as-is. |
| `templates/pgas-new/standalone/src/server.ts.tmpl` | 9 | Stay as-is. Generic — boots pgas-server with user's program. |
| `templates/pgas-new/standalone/src/repl/index.ts.tmpl` | 432 | **Stay for generated consumers; source-copy `src/repl/runner.ts` derives from it.** Generated scaffolds still ship this verbatim. |
| `templates/pgas-new/standalone/src/repl/renderer.ts.tmpl` | 90 | Stay as-is. Source-copy at `src/repl/renderer.ts`. |
| `templates/pgas-new/standalone/.pgas/pgas-new/dossier.yml.tmpl` | — | Stay as-is. Generic dossier blueprint. |
| `templates/pgas-new/standalone/.pgas/pgas-new/artifacts.json.tmpl` | — | Stay as-is. |
| `templates/pgas-new/repo/.pgas/wiring.yml.tmpl` | 8 | Stay as-is. Manifest blueprint. |
| `templates/pgas-new/tests/*.test.ts.tmpl` (5 files) | 140 | Stay as-is. Generic born-with tests. |
| `templates/pgas-new/audit/PGAS-NEW-GRADUATION.md.tmpl` | 13 | Stay as-is. |
| `templates/pgas-new/consumer/artifacts.json.tmpl` | 10 | Stay as-is. |
| `templates/pgas-new/curator/missing-wiring-request.md.tmpl` | 11 | Stay as-is. |
| `templates/pgas-new/curator/registration-request.md.tmpl` | 19 | Stay as-is. |
| `src/pgas-new/artifact-plan.ts` | ~200 | **Salvage with targeted edits.** Add new artifacts for `handlers/_resolver.ts` (FM1) and `prompts/` (when present). |
| `src/pgas-new/template-renderer.ts` | ~330 | **Salvage with targeted edits.** Remove `STANDALONE_PROGRAM_OVERRIDE_BY_TEMPLATE` and `EXISTING_*_TEMPLATE_BY_KIND` (Phase 4). Add `renderProgramSkeleton(spec, outDir)` that operates on the synthesized spec from state. |
| `src/pgas-new/wiring-manifest.ts` | ~150 | Stay as-is. Manifest schema + validator. |
| `src/pgas-new/existing-repo.ts` | — | Stay as-is. |
| `src/pgas-new/curator-request.ts` | — | Stay as-is. |
| `src/pgas-new/version.ts` | ~50 | Stay as-is. Engine pin + banned-imports scanner. |
| `src/pgas-new/model.ts` | — | **Salvage with targeted edits.** Add `program.synthesized_spec`, `program.design_confirmed`, `artifact_plan.approved`, `program.skip_dimensions` to `PgasNewState`. |
| `src/pgas-new/gates.ts` | — | Stay as-is. Add 2 new gate definitions (`design_confirmed`, `plan_approved`) — appended, not modified. |
| `src/pgas-new/command-runner.ts` | — | Stay as-is. |
| `src/pgas-new/control-plane.ts` | — | Stay as-is. |
| `src/pgas-new/verify.ts` | — | Stay as-is. |
| `src/index.ts` | ~30 (estimated) | **Salvage with targeted edits.** Re-export new foundry-server + repl-runner APIs. Remove deprecated preset types. |
| `package.json` | 26 | **Salvage with targeted edits.** Add `@simodelne/pgas-server` to `dependencies` (currently empty; this is a structural change). Bump version. |
| `package-lock.json` | — | Auto-updates. |
| `tsconfig.json` | — | **Salvage with targeted edits if needed.** May need to include `src/foundry-program/*.yml` as an asset path for runtime resolution via `import.meta.url`. |
| `tests/unit/template-renderer.test.ts` | ~860 | **Salvage with targeted edits.** Drop preset-routing tests. Add skeleton + synthesizer tests. The forward-looking test in the dirty working tree (`record_program_intake`) becomes Phase 2 acceptance. |
| `tests/unit/cli.test.ts` | ~220 | **Salvage with targeted edits.** Drop the deprecated-preset-warning test (it tests behavior that goes away in v3.0). Add `cli-interactive.test.ts` (new file) for the bare-`pgas-new` entry path. |
| `tests/unit/{artifact-plan,command-runner,control-plane,curator-request,existing-repo,gates,model,verify,version,wiring-manifest}.test.ts` | ~1300 | Stay as-is. |
| `tests/static/public-imports.test.ts` (if present) | — | Stay as-is. |
| `tests/vitest.config.ts` | — | Stay as-is. |
| `tests/plugin-manifest.test.sh` | 92 | **Salvage with targeted edits.** Update version pin assertion. |
| `tests/pgas-new-static.test.sh` | 60 | Stay as-is. Static render + install + typecheck + test gate. |
| `docs/PGAS-NEW-ARCHITECTURE.md` | — | **Salvage with targeted edits.** Add §"CLI Surface" describing bare `pgas-new` entry. Already references the 10-mode flow correctly. |
| `docs/PGAS-NEW-LIVE-GRADUATION.md` | — | Stay as-is. |
| `docs/POST-MORTEM-2026-06-22-design-phase-drift.md` | — | Stay as-is. |
| `docs/superpowers/specs/2026-06-22-v3-trace-from-v1-original.md` | — | **Salvage with targeted edits.** Trace updated in r3+ commits to use the canonical state-field names from this plan's §7.1.1 (under `program.*` namespace), the `confirm_design` action name, and the two-action `choose_design_path` + `apply_default_skeleton` flow (matches §7.1.1 N5 decision). |
| `docs/superpowers/specs/2026-06-22-v3-mandate-driven-synthesis.md` | — | **Mark as superseded by this plan + the trace doc.** Add `> Status: superseded by 2026-06-22-v3-rebuild-plan.md` at the top. |
| `docs/graduation-evidence/{policy-drafting,web-scraper,social-media-agent}/*` | — | Stay as evidence + regression corpus. |
| `docs/superpowers/plans/*` (existing implementation plans from prior work, e.g. `2026-06-21-streaming-repl.md`) | — | Stay as historical reference. Do not load by tooling. (Codex r2 N-minor.) |
| `CLAUDE.md` | — | **Salvage with targeted edits.** Replace `pgas-new design <slug>` references with `pgas-new` (D1). |
| `MEMORY.md` | — | **Salvage with targeted edits.** Replace SI-1's `pgas-new design <slug>` with `pgas-new` (D1). |
| `.github/workflows/ci.yml` | 67 | Stay as-is. |
| `.github/PULL_REQUEST_TEMPLATE.md` | — | **Updated by governance prereq #38.** |
| `.gitignore`, `.claude-plugin/plugin.json`, `LICENSE`, `README.md` | — | Stay as-is (README gets one-paragraph update in Phase 2). |

**Salvage subtotal: ~3000 lines stay verbatim + ~1800 lines stay with targeted edits + ~2000 lines of tests stay.**

## §5 Refactor list — files that move or get materially restructured

(Codex C5 / I11 fixes: include `src/index.ts`, package.json asset handling.)

### 5.1 The foundry's own program leaves the templates tree (Phase 1)

| From | To | Notes |
|---|---|---|
| `templates/pgas-new/program/specs.yml.tmpl` (342 lines) | `src/foundry-program/specs.yml` | Drop `.tmpl` (no substitution — foundry's runtime spec). Bake `pgas-new` slug / `PgasNew` PascalCase to literals. Adds the new actions, gates, and schema fields per §7 below. |
| `templates/pgas-new/program/handlers.ts.tmpl` (24 lines) | `src/foundry-program/handlers.ts` | Heavy expansion to ~700 lines per §7. |
| `templates/pgas-new/program/tools.ts.tmpl` (48 lines) | `src/foundry-program/tools.ts` | Expand the ~6 tools that need real impls (npm/git/gh/fetch); others stay as semantic-name registrations. |
| `templates/pgas-new/program/registration.ts.tmpl` | `src/foundry-program/registration.ts` | Drop `.tmpl`. Standard PGAS program registration. |
| Renderer wiring | Atomic with file moves (Codex I12) | `src/pgas-new/template-renderer.ts` Phase 1 commit moves the files AND updates the `--template pgas-new-foundry` rendering path to read from `src/foundry-program/` in the same commit. Tests pass after the single atomic commit. |

### 5.2 The streaming REPL gets in-repo sibling copies (Phase 2)

| Create | Source | Notes |
|---|---|---|
| `src/repl/runner.ts` | Refactor from `templates/pgas-new/standalone/src/repl/index.ts.tmpl` | Exports `runStreamingRepl(opts): Promise<ReplExitInfo>`. See §7.3 for full API. |
| `src/repl/renderer.ts` | Copy of `templates/pgas-new/standalone/src/repl/renderer.ts.tmpl` | Same content, no token substitution. |
| `src/repl/types.ts` | New | `ReplOptions`, `ReplExitInfo`, `ReplLogger`. |

### 5.3 CLI entry rewrite (Phase 2)

(Codex C1 / C4 / I8 fixes.)

`src/cli.ts` entry switch is restructured. See §7.4 for the corrected classifier.

### 5.4 Tests restructured

(Codex F + G fixes.)

| Create / change | Purpose |
|---|---|
| `tests/unit/cli-interactive.test.ts` (new) | Bare-`pgas-new` entry path; design-path fork; intake recording; name/slug derivation. Uses deterministic LLM stub. |
| `tests/unit/foundry-program.test.ts` (new) | Foundry handlers (file IO, npm, git, gh) tested with mocks for side effects. |
| `tests/unit/foundry-skeleton.test.ts` (new) | Skeleton loads through `loadSpecWithPatterns`; FM3 (system_mode_entry only on bootstrap); FM5 paths declared. |
| `tests/unit/synthesize-program-spec.test.ts` (new) | Deterministic synthesizer; fixture intake → expected spec; no LLM call. |
| `tests/integration/foundry-intake-flow.test.ts` (new) | In-process foundry program drive via `@simodelne/pgas-server/testing.js` `createTestHarness` with deterministic LLM stub. Asserts Q1–Q6 order, `record_program_intake` fires, both confirms gate transitions. |
| `tests/integration/foundry-end-to-end.test.ts` (new) | Full session → emit + verify a generated program. |
| `tests/architectural-invariants.test.ts` (new — issue #36) | Foundry-program spec exists; declares 10 modes; CLI has bare-entry path; consumer-preset enum empty (after Phase 4); architecture-doc references each CLI subcommand. |
| `tests/e2e/cli-design-session.test.sh` (new) | Shell harness for Phase 3 end-to-end check (separate from the Codex tmux E2E in §10). |

## §6 Delete list — files / surfaces that go away (Phase 4 v3.0.0)

(Codex D + I3 fixes: also delete stale tests/docs/warning text.)

| Path / surface | When | Reason |
|---|---|---|
| `policy-drafting | web-scraper | social-media-agent` values in CLI's `ProgramTemplate` enum | Phase 4 | Deprecated in v2.7; removed in v3.0 |
| `STANDALONE_PROGRAM_OVERRIDE_BY_TEMPLATE` map + the three `EXISTING_*_TEMPLATE_BY_KIND` maps in `template-renderer.ts` | Phase 4 | Their only purpose was routing the three deprecated presets |
| `consumerTemplateDeprecationWarning()` function + its invocations in `cli.ts` | Phase 4 | The deprecated flags are now removed; the warning is unreachable |
| Tests in `tests/unit/cli.test.ts` covering deprecated-preset behavior | Phase 4 | The behavior is removed |
| Tests in `tests/unit/template-renderer.test.ts` covering the three `EXISTING_*_TEMPLATE_BY_KIND` paths | Phase 4 | The maps are removed |
| `docs/superpowers/specs/2026-06-22-v3-mandate-driven-synthesis.md` | Phase 1 (during this work) | Superseded by this plan + trace doc. Marked at the top, not deleted. |
| The `.tmpl` references in `template-renderer.ts` pointing into `docs/graduation-evidence/<name>/` | Phase 4 | Once the presets are removed, the evidence files stay on disk as evidence but the renderer no longer loads them |
| `templates/pgas-new/program/{specs,handlers,tools,registration}.{yml,ts}.tmpl` | Phase 1 (moved, see §5.1) | Replaced by `src/foundry-program/` content + new skeleton in `templates/pgas-new/program/spec-skeleton.yml.tmpl` etc. |

## §7 New surface — what gets built (file-level detail)

### 7.1 `src/foundry-program/` — the foundry's runtime program

The foundry IS a PGAS program. This directory contains its spec + handlers + tools + registration. **Runtime code, not templates.**

#### 7.1.1 `src/foundry-program/specs.yml` (~400 lines, derived from existing 342-line template)

Modes unchanged from the existing template. **New actions, schema, and gates per D3 (program.* namespace) + D4 (two confirms):**

**New actions added to `action_map`:**

(Codex N5 fix: split the design-path mechanism into two actions so all state changes flow through declared `mutations:` — no handler-side state extension. The LLM is instructed by guidance to call `apply_default_skeleton` immediately after `choose_design_path` when the user picked 'default'.)

```yaml
choose_design_path:
  description: "Record whether the user wants the interactive interview ('design') or the default 3-mode skeleton ('default'). Pure record action — does not populate intake.* defaults."
  mutations:
    - { op: MSet, path: program.design_path, from_arg: design_path }
  channel: widget_output

apply_default_skeleton:
  description: "Populate intake.* with the default start->working->complete skeleton constants. ONLY legal when program.design_path == 'default' (precondition). Closes intake without asking Q1-Q6."
  mutations:
    - { op: MSet, path: intake.purpose, value: '' }
    - { op: MSet, path: intake.entry_channel, value: 'user_text' }
    - { op: MSet, path: intake.stages, value: [
        { slug: 'start', is_bootstrap: true },
        { slug: 'working' },
        { slug: 'complete', is_terminal: true }
      ] }
    - { op: MSet, path: intake.transitions, value: [
        { from: 'start', to: 'working', trigger: 'auto' },
        { from: 'working', to: 'complete', trigger: 'auto', guard_field: 'work.example_ready', guard_value: true }
      ] }
    - { op: MSet, path: intake.delegation, value: {} }
    - { op: MSet, path: intake.completion, value: { final_stage: 'complete', guard_field: 'work.example_ready' } }
    - { op: MSet, path: intake.program_intake_recorded, value: true }
  channel: widget_output

record_program_target:
  description: "Capture the user's program name, slug, and target output directory. Called once during intake_intelligence; required before confirm_design."
  mutations:
    - { op: MSet, path: program.slug, from_arg: slug }
    - { op: MSet, path: program.name, from_arg: name }
    - { op: MSet, path: program.target_dir, from_arg: target_dir }
    - { op: MSet, path: program.target_dir_confirmed, value: true }
  channel: widget_output

record_program_intake:
  description: "Capture the user's Q1-Q6 design interview answers into governed state. Only legal when program.design_path == 'design'."
  mutations:
    - { op: MSet, path: intake.purpose, from_arg: purpose }
    - { op: MSet, path: intake.entry_channel, from_arg: entry_channel }
    - { op: MSet, path: intake.stages, from_arg: stages }
    - { op: MSet, path: intake.transitions, from_arg: transitions }
    - { op: MSet, path: intake.delegation, from_arg: delegation }
    - { op: MSet, path: intake.completion, from_arg: completion }
    - { op: MSet, path: intake.program_intake_recorded, value: true }
  channel: widget_output

confirm_design:
  description: "User-confirm the proposed mode/transition list before architecture_design runs synthesis. First of two confirm gates."
  mutations:
    - { op: MSet, path: program.design_confirmed, value: true }
  channel: widget_output

# approve_artifact_plan: this action ALREADY EXISTS in the current foundry spec
# (see templates/pgas-new/program/specs.yml.tmpl lines 237-241). v3 keeps it as
# the D4 second confirm. v3 only ADDS the idempotency precondition below — the
# existing mutations are unchanged: status='approved', approved=true, write_authorized=true.

synthesize_program_spec:
  description: "Deterministically synthesize the user's program spec from intake.* using mechanical rename+copy from the skeleton. NOT an LLM emit — pure code."
  mutations:
    - { op: MSet, path: program.synthesized_spec, from_handler: synthesized_spec }
    - { op: MSet, path: program.synthesis_complete, value: true }
  channel: widget_output
```

**New preconditions:**

- `intake_intelligence → architecture_design` transition gated on `program.design_confirmed = true`
- `scaffold_plan → branch_write` transition gated on `artifact_plan.approved = true`
- `record_program_target` precondition: `program.target_dir_confirmed` is not true (Codex R3-I1 fix: was incorrectly gated on `intake.program_intake_recorded = true`, which deadlocked — target capture must happen BEFORE intake)
- `choose_design_path` precondition: `program.target_dir_confirmed = true` AND `program.design_path` is not set (target identity must be captured before design-path is asked)
- `apply_default_skeleton` precondition: `{ kind: FieldEquals, path: program.design_path, value: 'default' }` AND `intake.program_intake_recorded` is not true
- `record_program_intake` precondition: `{ kind: FieldEquals, path: program.design_path, value: 'design' }` AND `intake.program_intake_recorded` is not true (idempotency)
- `confirm_design` precondition list:
  - `{ kind: FieldTruthy, path: intake.program_intake_recorded }`
  - `{ kind: FieldTruthy, path: program.target_dir_confirmed }`
  - `{ kind: FieldFalsy, path: program.design_confirmed }` (Codex R4-I2 idempotency fix — refuses a second call)
  - `{ kind: TriggerType, triggerSet: [user_confirmation] }`
  - `{ kind: FieldEquals, path: inputs.user_decision.decision, value: approve }`
- `approve_artifact_plan` precondition list (note: this action already exists in the current foundry spec — see `templates/pgas-new/program/specs.yml.tmpl` lines 232–241; v3 keeps the existing action and adds the idempotency guard):
  - `{ kind: FieldTruthy, path: program.synthesis_complete }` (artifact-plan only meaningful after synthesis runs)
  - `{ kind: FieldEquals, path: artifact_plan.status, value: 'draft' }` (the existing `plan_artifacts` action sets this to `'draft'`; the action is only legal once the plan has been drafted — Codex R5-I1 fix using the real field instead of the invented `approved_for_user`)
  - `{ kind: FieldFalsy, path: artifact_plan.approved }` (Codex R4-I2 idempotency fix — refuses a second call; `artifact_plan.approved` is the existing model field)
  - `{ kind: TriggerType, triggerSet: [user_confirmation] }`
  - `{ kind: FieldEquals, path: inputs.user_decision.decision, value: approve }`
- `synthesize_program_spec` precondition: `program.design_confirmed = true` (synthesis runs in `architecture_design` mode after intake is confirmed)

**Schema additions (D3 + Codex C2 fix for FM5 + Codex N1 fix for target_dir):**

```yaml
schema:
  # Existing fields kept — including artifact_plan.status / artifact_plan.approved /
  # artifact_plan.write_authorized, which v3 keeps and uses for the D4 second confirm
  # via the existing approve_artifact_plan action (no new artifact_plan.* fields needed)
  ...
  # D3 — program.* namespace for synthesis (Codex N1: target_dir governed state)
  program.design_path: string                # 'design' | 'default'
  program.design_confirmed: boolean
  program.synthesized_spec: object
  program.synthesis_complete: boolean
  program.target_dir: string                 # absolute path or kebab-slug default './<slug>'
  program.target_dir_confirmed: boolean      # set by record_program_target
  program.skip_dimensions: array             # Q1..Q6 skipped — used for fallback defaults
  program.skip_dimensions.*: string
  # Intake structured fields (matches user's existing test in tests/unit/template-renderer.test.ts)
  intake.purpose: string
  intake.entry_channel: string
  intake.stages: array
  intake.stages.*: object
  intake.transitions: array
  intake.transitions.*: object
  intake.delegation: object
  intake.completion: object
  intake.completion.final_stage: string
  intake.completion.guard_field: string
  intake.program_intake_recorded: boolean
  # FM5 — engine-owned schema paths (full set from v1 architecture paper)
  inputs.query_result.kind: string
  inputs.query_result.value_json: object
  inputs.query_meta.source_path: string
  inputs.query_meta.source_channel: string
  inputs.query_meta.continuation_round: number
  inputs.query_meta.scope_redirect: string
  inputs.query_meta.message: string
  inputs.mode_entry.mode: string
  inputs.mode_entry.from_mode: string
  inputs.mode_entry.entry_round: number
  governance.round_counter: number
```

**Projection includes for `intake_intelligence`:**

```yaml
projection:
  intake_intelligence:
    include:
      - inputs.user_text
      - inputs.user_decision
      - inputs.user_decision.decision
      - inputs.user_decision.instruction
      - intake.mandate
      - intake.purpose
      - intake.entry_channel
      - intake.stages
      - intake.transitions
      - intake.delegation
      - intake.completion
      - intake.program_intake_recorded
      - program.slug
      - program.name
      - program.target_dir
      - program.target_dir_confirmed
      - program.design_path
      - program.design_confirmed
      - program.skip_dimensions
      - notebook.entries
      - notebook.pins
```

**Guidance for `intake_intelligence` (Codex N5 + N1 fix: two-action default path + explicit target_dir capture):**

```yaml
guidance:
  intake_intelligence:
    # === Step 1 of intake: capture program identity (name, slug, target_dir) ===
    - "If program.target_dir_confirmed is not true: first capture program identity. The CLI may have pre-filled program.slug / program.name / program.target_dir via initialDomain. If any of slug/name/target_dir is missing, ask the user via request_user_action with intent='collect_program_identity'. If slug provided but name is missing, derive name as title-case of slug (e.g. 'legal-fee-proposals' -> 'Legal Fee Proposals'). If target_dir is blank, default to './<slug>'. Echo back the proposed slug/name/target_dir for confirmation, then call record_program_target with the structured payload."
    # === Step 2 of intake: design-path fork (choose_design_path) ===
    - "After record_program_target, if program.design_path is not set, ask the user whether they want to design the program now (~6 quick questions) or take the default 3-mode start->working->complete skeleton. Use request_user_action with intent='choose_design_path'. Then call choose_design_path with the user's answer."
    # === Step 3a: default path → call apply_default_skeleton ===
    - "If program.design_path == 'default' and intake.program_intake_recorded is not true: immediately call apply_default_skeleton (no args needed). This populates intake.* defaults atomically via declared mutations. Do NOT ask Q1-Q6."
    # === Step 3b: design path → run Q1-Q6 ===
    - "If program.design_path == 'design' and intake.program_intake_recorded is not true: ask the 6 design questions IN ORDER, one at a time or in a small batch, with brief context for each. Order matters."
    - "Q1 Purpose — one sentence on what the program does. Default if skipped: '<program-name>-driven workflow agent'."
    - "Q2 Entry channel — how does work arrive? (user_text, webhook, scheduled tick, another program delegating). Default if skipped: 'user_text'."
    - "Q3 Stages of work — distinct stages, named in order; these become the mode names. Default if skipped: ['start', 'working', 'complete']."
    - "Q4 Decision points — branches, loops, bail-outs; these become extra transitions, optionally with guards. Default if skipped: no extra transitions."
    - "Q5 Delegation — does any stage delegate to a child session / another program? Default if skipped: 'none'."
    - "Q6 Completion criteria — how do you know the program is done? Default if skipped: terminal mode = last stage, guard = 'work.example_ready'."
    - "If the user replies 'skip' to any of Q1-Q6 (or any clearly equivalent intent), record the skip in program.skip_dimensions and use the dimension's default in the structured payload. Don't re-ask."
    - "If the user replies 'reject' or 'change' or 'edit <text>' to a question, treat the prior answer as discarded and ask the question again. Don't proceed."
    - "Once you have all 6 answers (or defaults for skipped dimensions), call record_program_intake with the structured payload."
    # === Step 4: echo-back + confirm_design (first of D4's two confirms) ===
    - "After intake is recorded (via apply_default_skeleton OR record_program_intake), echo back the proposed mode list + transitions + target_dir to the user — render via widget_output — and ask for confirmation via request_user_action with intent='confirm_design'. Wait for the user_confirmation trigger."
    - "On user_confirmation with decision='approve', call confirm_design."
    - "On user_confirmation with decision='reject' or decision='edit', do NOT call confirm_design. Ask the user which dimension they want to revise (identity, design-path, individual Q1-Q6, or target_dir), re-run the relevant step, and re-emit the echo-back."
    - "Don't re-ask anything you already extracted from the user's free-text introduction."
```

**Guidance for `scaffold_plan` (D4 second confirm):**

```yaml
guidance:
  scaffold_plan:
    - "Call plan_artifacts to produce the artifact plan from program.synthesized_spec."
    - "Echo the artifact-plan list (paths + purposes) to the user. Ask for approval via request_user_action with intent='approve_artifact_plan'."
    - "On user_confirmation decision='approve', call approve_artifact_plan. Then the transition to branch_write fires."
    - "On reject/edit: don't call approve_artifact_plan; ask which artifact the user wants changed; re-emit."
```

#### 7.1.2 `src/foundry-program/handlers.ts` (~700 lines)

Handler implementations for every action in the foundry's spec. Each handler has a documented contract: arg shape, side effects, state mutations the handler causes (separate from `mutations:` in spec), failure modes, secret-redaction.

(Codex I9 fix — example contracts for the load-bearing handlers:)

```ts
/**
 * choose_design_path
 *   args: { design_path: 'design' | 'default' }
 *   side effects: none
 *   state mutations: program.design_path ONLY (via spec mutations). Pure record action.
 *     Handler does NOT extend mutations. Default-skeleton population is done by a
 *     separate spec-declared action (apply_default_skeleton, see below) — guidance
 *     instructs the LLM to call apply_default_skeleton immediately after
 *     choose_design_path when the user picked 'default'.
 *   failure modes: invalid design_path value — throw with clear error
 *   secret redaction: n/a
 */

/**
 * apply_default_skeleton
 *   args: {} (no args — all mutations are literal MSet declared in spec)
 *   side effects: none
 *   state mutations: ALL declared in spec via MSet with literal values for
 *     intake.purpose (''), intake.entry_channel ('user_text'),
 *     intake.stages (the canonical 3-mode skeleton), intake.transitions
 *     (linear start→working→complete with guard), intake.delegation ({}),
 *     intake.completion ({final_stage:'complete', guard_field:'work.example_ready'}),
 *     intake.program_intake_recorded (true).
 *     Handler does NOT extend mutations. Engine applies the literal MSet values.
 *   failure modes: engine rejects literal MSet shape for array/object paths
 *     (Codex R3-I2 risk; see Phase 1 acceptance gate below)
 *   secret redaction: n/a
 *   precondition (enforced in spec): program.design_path == 'default'.
 *     Engine refuses the action otherwise; handler is unreachable in that path.
 */

/**
 * record_program_target
 *   args: { slug: string, name: string, target_dir: string }
 *   side effects: none (validation only)
 *   state mutations: program.slug, program.name, program.target_dir,
 *     program.target_dir_confirmed = true (all via spec MSet from_arg)
 *   validation: slug must match kebab-case regex; name must be non-empty;
 *     target_dir must be a safe path (no '..', no shell escapes)
 *   failure modes: validation failure — throw with clear error
 *   secret redaction: n/a
 *   precondition (enforced in spec): program.target_dir_confirmed != true (idempotency).
 *     Runs as the FIRST intake action — must succeed before choose_design_path.
 */

/**
 * synthesize_program_spec
 *   args: {} (reads from state, not args)
 *   side effects: filesystem read of templates/pgas-new/program/spec-skeleton.yml.tmpl
 *   state reads: intake.*, program.slug, program.name
 *   state mutations (via handler return → spec MSet): program.synthesized_spec (object),
 *     program.synthesis_complete (boolean)
 *   failure modes:
 *     - skeleton file missing → throw
 *     - validator (loadSpecWithPatterns) rejects synthesized spec → throw with validator output
 *     - intake fields missing → throw with field list
 *   secret redaction: n/a
 *   determinism: pure function of intake.* + skeleton file. No LLM call. Same inputs → same outputs.
 */

/**
 * write_scaffold_artifacts
 *   args: { target_kind: 'standalone' | 'attach', out_dir: string }
 *   side effects: writes files to out_dir per program.synthesized_spec
 *   state reads: program.synthesized_spec, program.slug, program.name, repo.wiring_manifest
 *   state mutations: artifacts.written (array of paths), artifacts.write_complete (boolean)
 *   failure modes:
 *     - target_kind === 'standalone' AND out_dir exists with collisions → throw with collision list
 *     - target_kind === 'attach' AND wiring_manifest absent/invalid → throw, do NOT write
 *     - any filesystem error → throw with path
 *   secret redaction: out_dir paths are logged; no secrets expected in this surface
 *   implementation: delegates to renderStandaloneScaffold or renderExistingRepoAttachment from src/pgas-new/template-renderer.ts
 */

/**
 * npm_install
 *   args: { cwd: string }
 *   side effects: child_process npm install --no-audit --no-fund in cwd
 *   state mutations: graduation.install_evidence_id (string)
 *   timeout: 300_000 ms (5 minutes)
 *   failure modes: non-zero exit → throw with stderr tail (first 200 chars)
 *   secret redaction: filter NPM_TOKEN from logged env; never log .npmrc content
 *   cwd safety: cwd must be inside program.target_dir (path traversal check)
 */

/**
 * git_status / git_rebase_latest / open_pull_request
 *   Similar contracts — see full doc in handler source
 *   timeout: 60_000 ms for git_status; 300_000 for rebase; 120_000 for gh pr create
 *   secret redaction: GITHUB_TOKEN never logged; gh's own auth output filtered
 */
```

All 33+ actions get this level of contract documentation in the handler source (JSDoc).

#### 7.1.3 `src/foundry-program/tools.ts` (~400 lines)

Tool registry. Most semantic actions go through handlers; a few benefit from declarative tool wrappers:

- `web_research` — `kind: 'local'` tool that calls fetch with an allowlist (configurable; default = empty meaning the foundry asks for explicit URL approval each time)
- `npm_install` / `npm_typecheck` / `npm_test` — `kind: 'local'` with timeout + env scrubbing
- `git_status` / `git_rebase_latest` — `kind: 'local'`
- `open_pull_request` — `kind: 'local'` wrapping gh CLI
- All other semantic actions — `kind: 'local'` with no-op tool fn that just returns args to the handler (handler does the work via the action_map mutation pipeline)

#### 7.1.4 `src/foundry-program/registration.ts` (~40 lines)

Standard PGAS program registration via the public engine surface. Exports `createPgasNewFoundryProgramEntry()`.

### 7.2 `templates/pgas-new/program/` — the new generic skeleton

Replaces the misframed contents that moved to `src/foundry-program/`. Now a truly **generic 3-mode skeleton** for the synthesizer to operate on.

#### 7.2.1 `templates/pgas-new/program/spec-skeleton.yml.tmpl` (~250 lines)

The canonical generic skeleton. Templated with `{{NAME}}`, `{{SLUG}}`, `{{PASCAL_NAME}}` for substitution by the synthesizer's emit step. Contents:

- **3 modes:** `start` (bootstrap; sole admitter of `system_mode_entry`, per FM3) → `working` (handler-result-driven; FM3-safe channel set) → `complete` (terminal)
- **Action map:** `record_user_note`, `pin_notebook_note`, `example_action` (placeholder the synthesizer renames per intake), session controls
- **Standard channels:** `user_text`, `widget_output`, `system_mode_entry` (only on `start`)
- **Control plane vocabulary:** standard 7-control set
- **Schema:** full FM5 engine-owned path set (Codex C2 fix):
  - `inputs.query_result.{kind,value_json}`
  - `inputs.query_meta.{source_path,source_channel,continuation_round,scope_redirect,message}`
  - `inputs.mode_entry.{mode,from_mode,entry_round}`
  - `governance.round_counter`
  - User-program domain fields: `work.example_ready` etc.
- **Repair bound, fallback channel, projections, preamble** all parameterized but with sensible defaults

#### 7.2.2 `templates/pgas-new/program/handlers-skeleton.ts.tmpl` (~120 lines)

Minimal handler shells. Ships the **`handlers/_resolver.ts` pattern (FM1 closure)** — the synthesizer emits a directory structure under `<programs>/<slug>/handlers/` with:

- `<programs>/<slug>/handlers/index.ts` — exports `handlers` record
- `<programs>/<slug>/handlers/_resolver.ts` — payload-override-then-domain resolver

(Codex C2 / FM1 fix: skeleton emits a **directory**, not a flat `handlers.ts`. Artifact plan updated accordingly in §4 (`artifact-plan.ts` edits).)

#### 7.2.3 `templates/pgas-new/program/tools-skeleton.ts.tmpl` (~60 lines)

Tool registry shell. Exports `register{{PASCAL_NAME}}Tools(registry)` that registers semantic actions.

#### 7.2.4 `templates/pgas-new/program/registration-skeleton.ts.tmpl` (~50 lines)

Standard registration shape — ships the `createAdapters` override worked example (FM4).

### 7.3 `src/repl/runner.ts` API contract (Codex I8 fix)

```ts
export interface ReplOptions {
  apiBase: string;                                  // e.g. http://localhost:4500
  wsBase: string;                                   // e.g. ws://localhost:4500
  token: string;                                    // dev-token in dev mode
  program: string;                                  // e.g. 'pgas-new-foundry'
  programDisplayName?: string;
  initialDomain?: Record<string, unknown>;          // pre-fill state, e.g. { 'program.slug': 'foo' }
  stdin?: NodeJS.ReadableStream;                    // default process.stdin (injectable for tests)
  stdout?: NodeJS.WritableStream;                   // default process.stdout
  logger?: (level: 'info'|'warn'|'error', msg: string) => void;
  exitOnTerminal?: boolean;                         // default true; false for tests that want to inspect post-session state
  abortSignal?: AbortSignal;                        // SIGINT propagation
}

export interface ReplExitInfo {
  reason: 'session_terminal' | 'user_exit' | 'sigint' | 'error';
  sessionId: string | null;
  finalMode: string | null;
  exitCode: number;
}

/**
 * Runs a streaming REPL session against the given pgas-server.
 * Returns a promise that resolves when the session ends (terminal mode, /exit, SIGINT, or error).
 *
 * Lifecycle:
 *   1. Connect notification stream (WS), wait opened.
 *   2. Verify auth + program registration via GET /programs.
 *   3. Set up readline on stdin; start prompt loop.
 *   4. On free text → trigger session (SSE stream).
 *   5. On /command → dispatch to control_plane.
 *   6. On `session_terminal` event OR user types `/exit` OR SIGINT received → shutdown + resolve.
 *
 * Errors during connection / programs.list / unrecoverable WS → reject with descriptive error.
 *
 * Does NOT call process.exit(). Returns ReplExitInfo with intended exit code.
 * Caller (CLI entry) decides whether to exit the process.
 */
export async function runStreamingRepl(opts: ReplOptions): Promise<ReplExitInfo>;
```

The current template-version `index.ts.tmpl` is refactored to import from `runStreamingRepl` so generated scaffolds use the same code path as the foundry CLI.

### 7.4 CLI rewrite — corrected classifier (Codex C1 + C4 fix)

```ts
const KNOWN_SUBCOMMANDS = new Set([
  'help', 'version', 'session',
  'plan-standalone', 'render-standalone',
  'plan-attach', 'render-attach',
  'validate-manifest', 'curator-request',
  // Phase 1+: render-foundry as explicit self-bootstrap entry
  'render-foundry',
]);

export async function runCli(argv: string[]): Promise<CliResult> {
  // 1. Help short-circuits anywhere in argv
  if (argv.includes('--help') || argv.includes('-h')) {
    return ok(helpText());
  }

  // 2. Bare CLI (no args) → agent entry
  if (argv.length === 0) {
    return runAgentSession({});
  }

  // 3. First arg is a known subcommand → dispatch
  if (KNOWN_SUBCOMMANDS.has(argv[0])) {
    return dispatchSubcommand(argv);
  }

  // 4. First arg is a flag (--slug, --out, etc.) → agent entry with parsed options
  if (argv[0].startsWith('-')) {
    const parsed = parseAgentArgs(argv);  // recognizes --slug, --name, --out, --non-interactive, --provider
    return runAgentSession(parsed);
  }

  // 5. First arg is a non-flag, non-subcommand → unknown command error
  return fail(`unknown command: ${argv[0]}\nRun 'pgas-new --help' for usage.`, 2);
}

interface AgentArgs {
  slug?: string;       // optional pre-fill; if absent, agent asks
  name?: string;       // optional pre-fill; if absent, agent asks or derives from slug
  outDir?: string;     // optional pre-fill; if absent, agent asks; if blank, defaults to ./<slug>
  nonInteractive?: boolean;  // CI mode — errors if agent needs to ask anything
  provider?: string;   // optional override; otherwise reads from env
}

async function runAgentSession(args: AgentArgs): Promise<CliResult> {
  // 1. Validate slug if provided (kebab-case, no path traversal)
  // 2. Validate provider env (one of PGAS_OPENAI_*, PGAS_GEMINI_*, etc. must be set)
  //    If missing: in non-interactive mode error; in interactive mode print friendly message and exit 1
  // 3. spawnFoundryServer() → { apiBase, wsBase, token, kill, logPath }
  // 4. runStreamingRepl({ apiBase, wsBase, token, program: 'pgas-new-foundry',
  //     initialDomain: { 'program.slug': args.slug, 'program.name': args.name, 'program.target_dir': args.outDir } })
  // 5. On REPL exit, kill server, return { exitCode: replExitInfo.exitCode }.
}
```

**Program identity capture (Codex C4 fix):**

- `--slug <slug>`: kebab-case, validated upfront via `validateProgramIdentity`. If absent, the agent asks during `intake_intelligence` (first question after the design-path fork).
- `--name <name>`: title-case display name. If absent and `--slug` provided, derive: `legal-fee-proposals` → `Legal Fee Proposals` (replace `-` with ` `, title-case each word). Agent confirms the derivation.
- PascalCase identifier: derived from slug. `legal-fee-proposals` → `LegalFeeProposals`. Used for code-gen identifiers (e.g., `createLegalFeeProposalsProgramEntry`). Never user-facing.
- `--out <dir>`: target directory. If absent, defaults to `./<slug>`. Agent confirms.

These rules are validated in `tests/unit/cli-interactive.test.ts`.

### 7.5 `src/foundry-server.ts` — embedded server lifecycle (Codex I7 fix)

```ts
export interface SpawnedServer {
  apiBase: string;          // http://localhost:<port>
  wsBase: string;           // ws://localhost:<port>
  token: string;            // 'dev-token' (devMode)
  kill(): Promise<void>;    // SIGTERM, wait for exit, then SIGKILL after 5s
  logPath: string;          // path to child's stdout/stderr log file
}

/**
 * Spawn an embedded foundry server. Idempotent first-run render to workdir.
 *
 * Workdir resolution:
 *   - default: ~/.pgas-new/foundry-v<PGAS_NEW_VERSION>/
 *     where PGAS_NEW_VERSION is read from package.json
 *   - override via PGAS_NEW_FOUNDRY_WORKDIR env
 *   - cache-bust: developers iterating on src/foundry-program/* locally
 *     can either rm -rf ~/.pgas-new/foundry-v<version>/ between runs OR
 *     set PGAS_NEW_FOUNDRY_WORKDIR=$(mktemp -d) per invocation.
 *     A future enhancement could include a content hash in the cache
 *     key; not needed for v3.0 since releases are pinned by version. (Codex r2 N-minor.)
 *
 * First-run render:
 *   1. If workdir does NOT exist:
 *      a. mkdir -p <workdir>
 *      b. Copy src/foundry-program/{specs.yml, handlers.ts, tools.ts, registration.ts}
 *         and the entry server.ts shim to <workdir>/
 *      c. Write a minimal package.json at <workdir>/ with @simodelne/pgas-server dep + tsx
 *      d. Run `npm install --no-audit --no-fund --prefix <workdir>` (silent, log to <workdir>/install.log)
 *      e. On install failure: throw with tail of install.log
 *   2. If workdir EXISTS: skip render; verify <workdir>/node_modules exists; if not, run npm install.
 *
 * Spawn:
 *   1. Pick free port via net.createServer() listen(0) + immediate close
 *   2. child_process.spawn('node', ['--import', 'tsx', 'server.ts'], {
 *        cwd: workdir,
 *        env: {
 *          ...process.env,                            // pass user's PGAS_OPENAI_*, etc.
 *          PGAS_PORT: String(port),
 *          PGAS_DEV_MODE: '1',
 *          PGAS_LOG_LEVEL: 'warn',
 *        },
 *        stdio: ['ignore', logFd, logFd],             // pipe stdout/stderr to log file
 *      })
 *   3. Poll http://localhost:<port>/health every 200ms, timeout 15_000ms
 *   4. On timeout OR child exit during startup: kill child, throw with tail of log
 *
 * Auth:
 *   - devMode=1 → server accepts any token; we use 'dev-token'
 *   - In non-dev: would need PGAS_CLI_TOKEN env; not supported in v3.0.0
 *
 * Log path:
 *   <workdir>/foundry-server-<timestamp>.log
 *   Keep last 5 logs; older ones rotated out.
 *
 * Secret redaction:
 *   - The child server inherits process.env including provider API keys
 *   - Log file is rotated and stored at <workdir>; never written to the user's
 *     output directory or to git-tracked locations
 *   - foundry-server.ts NEVER logs env values; only PGAS_PORT and PGAS_DEV_MODE
 *   - On startup-error path: tail of log is included in thrown error — but
 *     pgas-server's own startup log doesn't contain raw env values, only metadata
 */
export async function spawnFoundryServer(opts?: {
  port?: number;
  workdir?: string;
}): Promise<SpawnedServer>;
```

### 7.6 `src/index.ts` updates (Codex I11 fix)

Re-export new public APIs:

```ts
// New
export { runStreamingRepl } from './repl/runner.js';
export type { ReplOptions, ReplExitInfo } from './repl/types.js';
export { spawnFoundryServer } from './foundry-server.js';
export type { SpawnedServer } from './foundry-server.js';
export { createPgasNewFoundryProgramEntry } from './foundry-program/registration.js';

// Existing, kept
export { runCli } from './cli.js';
// ... renderer + artifact-plan + manifest exports stay
```

## §8 Phased delivery

### Phase 0 (already landed — see git log)
- Graduation programs moved to `docs/graduation-evidence/`
- `--template <consumer>` flags deprecated with warning
- Governance corrections A+B+F landed (Program Nature, required reading, Strategic Invariants)
- Post-mortem committed
- Trace doc committed (revision 1)
- This plan (revision 2) committed

### Phase 0.5 — Governance prerequisites (D6, ~1–2 days)

Lands BEFORE Phase 1. Implements correction issues #37, #38, #39:

1. **#37**: `.github/workflows/architecture-diff.yml` CI job. On PR vs main, computes `git diff <prior-release-tag> -- docs/PGAS-NEW-ARCHITECTURE.md`; if non-empty, requires the PR body to contain "## Architectural changes" section.
2. **#38**: Updated `.github/PULL_REQUEST_TEMPLATE.md` with the Program Nature checkbox. Add `.github/PULL_REQUEST_TEMPLATE/re-platforming.md` variant for re-platforming PRs.
3. **#39**: `.uat/uat-prompt-template.md` with the intent-verification block at the top.

**Acceptance:** all three CI / template / prompt files exist, one test PR validates the new gates fire, README updated to document the contributor flow.

### Phase 1 — Foundry-program relocation + engine dependency (atomic, Codex I12 + N2 fix)

**Single commit that atomically:**

1. Moves `templates/pgas-new/program/{specs.yml,handlers.ts,tools.ts,registration.ts}.tmpl` → `src/foundry-program/{specs.yml,handlers.ts,tools.ts,registration.ts}` (drop `.tmpl`, bake `pgas-new`/`PgasNew` literals).
2. Updates `src/pgas-new/template-renderer.ts` to load the foundry-self-program from `src/foundry-program/` when `--template pgas-new-foundry` is requested.
3. Creates `templates/pgas-new/program/{spec-skeleton,handlers-skeleton,tools-skeleton,registration-skeleton}.{yml,ts}.tmpl` as the new generic skeleton with full FM5 schema (Codex C2 fix).
4. Updates `src/index.ts` to re-export `createPgasNewFoundryProgramEntry`.
5. **(Codex N2 fix)** Adds `@simodelne/pgas-server` to `package.json` `dependencies` + runs `npm install` (lock file update). The skeleton's engine-loader test in step 6 needs the engine available at this phase, so the dep cannot be deferred to Phase 2.1 as r2 said.
6. Adds `tests/unit/foundry-skeleton.test.ts` asserting skeleton FM3+FM5 invariants AND skeleton loads through `loadSpecWithPatterns` (engine validator). Static portion runs on every commit; engine-loader portion can be gated on the dep being present (skip in environments without registry access — separate from PASS/FAIL per §9 SKIP-vs-PASS rule).
7. Marks `docs/superpowers/specs/2026-06-22-v3-mandate-driven-synthesis.md` as superseded.

**Acceptance:** `npm test` clean. The foundry-program-as-template still renders correctly (existing tests pass). The new skeleton parses through engine validator (rung gated on `@simodelne/pgas-server` install — SKIP allowed in offline CI but recorded as SKIP, not PASS).

**Codex R3-I2 gate (must pass before Phase 1 merges):** The skeleton AND the foundry's own `src/foundry-program/specs.yml` (with the new `apply_default_skeleton` action containing nested array/object MSet literals) must load through `loadSpecWithPatterns` without error. If the engine rejects nested literals on array/object-typed paths (per `docs/PGAS-NEW-GRADUATION-2-EVIDENCE.md` S-11 — JSON-string scalar fallback was needed for some array/object state), the Phase 1 commit must use the **JSON-string scalar shape** instead: `apply_default_skeleton` mutations write `intake.stages_json: string` etc., and the synthesizer reads them via `JSON.parse` before operating on the structured form. Decide upfront in Phase 1 — do not punt the decision into Phase 2/3.

### Phase 2 — The agent surface (Codex I8 + I9 fix; ~1 week)

Split into 5 ordered sub-commits, each atomic + green (was 6 sub-commits in r2; the engine-dep step moved to Phase 1 per N2):

**2.1** Create `src/repl/{runner.ts,renderer.ts,types.ts}` (refactor from template). Add `tests/unit/repl-runner.test.ts` with injected stdin/stdout.  
**2.2** Create `src/foundry-server.ts`. Add `tests/unit/foundry-server.test.ts` with mocked spawn (real spawn in integration test).  
**2.3** Update `src/cli.ts` entry switch (corrected classifier per §7.4). Add `tests/unit/cli-interactive.test.ts` covering: bare entry, `--slug` only, `--out` only, `--non-interactive`, unknown command, all existing subcommands unchanged.  
**2.4** Update foundry-program spec with five NEW actions (`choose_design_path`, `apply_default_skeleton`, `record_program_target`, `record_program_intake`, `confirm_design`) plus the idempotency precondition added to the EXISTING `approve_artifact_plan` action. Schema, projection, guidance updates per §7.1.1.  
**2.5** Implement the five new intake-side handlers (`choose_design_path`, `apply_default_skeleton`, `record_program_target`, `record_program_intake`, `confirm_design`) in `src/foundry-program/handlers.ts`. The existing `approve_artifact_plan` handler stays; only its spec preconditions are amended in 2.4. Add `tests/integration/foundry-intake-flow.test.ts`.

**Acceptance:** running `pgas-new` against a deterministic LLM stub via the testing harness opens the REPL, runs the design-path fork, runs Q1–Q6 (or default), echoes back for confirm, gates the transition. The session reaches `architecture_design` mode with all intake state correctly populated. (Architecture-design + downstream is empty stubs at this phase.)

### Phase 3 — Synthesis + real handlers (Codex I9 + F fix; ~1.5 weeks)

Split into 5 ordered sub-commits, each atomic + green:

**3.1** Implement `synthesize_program_spec` in `src/foundry-program/handlers.ts`. Mechanical rename+copy against `templates/pgas-new/program/spec-skeleton.yml.tmpl`. Validate via `loadSpecWithPatterns`. Add `tests/unit/synthesize-program-spec.test.ts` (deterministic, fixture intake → expected spec, no LLM).  
**3.2** Wire `architecture_design` to call `synthesize_program_spec`. Wire `scaffold_plan` to read `program.synthesized_spec` and call `createStandaloneArtifactPlan` / `createExistingRepoArtifactPlan`.  
**3.3** Wire `branch_write` to call `renderStandaloneScaffold` / `renderExistingRepoAttachment` with the synthesized spec. **Adds `handlers/_resolver.ts` to the artifact plan** (Codex C2 / FM1 fix).  
**3.4** Implement remaining real handlers: `npm_install`, `npm_typecheck`, `npm_test`, `git_status`, `git_rebase_latest`, `open_pull_request`, `load_wiring_manifest`, `create_curator_request`, `run_api_blackbox_verification`, `run_live_provider_verification`, `web_research`. Each with documented contract per §7.1.2.  
**3.5** Add the regression corpus: `tests/integration/synthesis-regression.test.ts` feeding each `docs/graduation-evidence/<name>/MANDATE.md` into the synthesizer, asserting structural equivalence with the frozen graduation spec. Add `tests/integration/foundry-end-to-end.test.ts` driving a full session.

**Acceptance:** end-to-end test passes — fresh intake → synthesized spec → artifact plan → written files → npm install → typecheck → npm test all green inside the generated output dir. All FM1–FM5 closure tests pass.

### Phase 4 — Cleanup (breaking, v3.0.0 release)

1. Remove `policy-drafting|web-scraper|social-media-agent` from `ProgramTemplate` enum.
2. Remove `STANDALONE_PROGRAM_OVERRIDE_BY_TEMPLATE` + 3x `EXISTING_*_TEMPLATE_BY_KIND` maps.
3. Remove `consumerTemplateDeprecationWarning()` + its invocations.
4. Drop the stale tests asserting deprecated behavior.
5. Update README + architecture doc.
6. Cut v3.0.0 release.

## §9 Acceptance criteria

Each phase gate: ALL phase-specific tests + global invariants.

**Definition-of-done for v3.0:**

A fresh user runs `pgas-new` against a working LLM provider. After a 5–10 minute conversation, a directory on their disk contains a working PGAS consumer (server.ts + program/{specs,handlers/{index,_resolver},tools,registration}.ts + tests + manifest + dossier + audit doc), the consumer has been installed (`npm install`), typechecked, and its 5 born-with tests pass (with the live-provider test skipped per `PGAS_LIVE_PROVIDER` env). The user can `cd` into the directory and `npm run repl` to talk to the program they just designed.

**Important**: a SKIP on the live-provider test counts as SKIP, not PASS. The E2E gate must distinguish them. (Codex H risk fix.)

## §10 Codex tmux-driven E2E acceptance test (Codex C3 + G fix)

The load-bearing acceptance gate. Codex acts as user, drives the CLI from a fresh tmux session via keystrokes. Against the real Qwen vLLM at `100.100.74.6:8000`, model `qwen36-27b`.

**Preflight (Codex performs before each scenario):**

```bash
# Verify provider reachable
curl -sf http://100.100.74.6:8000/v1/models | jq -r '.data[0].id'
# Expected: qwen36-27b
```

**Scenario A — design path, standalone repo (incident triage)**

Same as revision 1, but verification adds:
- `record_program_target` action fired with the user's name/slug/target_dir
- Q1–Q6 were asked **in order** (verified by inspecting the session log's round_dispatch + llm_raw_response sequence)
- `record_program_intake` action fired exactly once with all 7 mutations
- `confirm_design` and `approve_artifact_plan` actions fired exactly once each
- `synthesize_program_spec` action fired and `program.synthesized_spec` is populated in session world state
- **(Codex N4 fix)** The synthesizer handler itself made no LLM/network call — asserted by inspecting the action result for the handler-emitted marker `{kind: 'mechanical_synthesis', no_llm_call: true, ...}`. The PGAS round around the action *will* contain LLM calls (the LLM picks the action and observes the result); the invariant is that the HANDLER is pure. Verified at two layers: (1) the marker in session log, (2) unit-test of `synthesize_program_spec` handler that runs without any engine harness at all (`tests/unit/synthesize-program-spec.test.ts`).

**Scenario B — default skeleton path, standalone repo (minimal-test)**

- User selects "default" at the design-path fork
- Codex asserts `choose_design_path` fired with `program.design_path = 'default'`
- Codex asserts `apply_default_skeleton` then fired and populated `intake.stages` to the 3-mode default via declared MSet mutations
- Only the two confirms are asked (design echo-back of the default skeleton + plan approve)
- Output uses `start → working → complete` mode names

**Scenario C — attach to existing pgas-consumer repo (audit-trail in fake-consumer)** (Codex C3 fix — replaced with runnable fixture)

Codex creates a real minimal PGAS consumer fixture:

```bash
mkdir -p /tmp/fake-consumer/.pgas /tmp/fake-consumer/programs /tmp/fake-consumer/audit /tmp/fake-consumer/.pgas/pgas-new

cat > /tmp/fake-consumer/package.json << 'EOF'
{
  "name": "fake-consumer",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@simodelne/pgas-server": "^2.13.0"
  },
  "devDependencies": {
    "@types/node": "^25.9.3",
    "tsx": "^4.22.4",
    "typescript": "^6.0.3",
    "vitest": "^4.1.9"
  },
  "engines": { "node": ">=20" }
}
EOF

cat > /tmp/fake-consumer/tsconfig.json << 'EOF'
{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler", "strict": true, "esModuleInterop": true, "skipLibCheck": true, "allowImportingTsExtensions": false }, "include": ["programs/**/*"] }
EOF

cat > /tmp/fake-consumer/.pgas/wiring.yml << 'EOF'
schema_version: 1
repo:
  kind: existing_repo
  package_manager: npm
pgas:
  server_package: '@simodelne/pgas-server'
  allowed_imports:
    - '@simodelne/pgas-server/plugin.js'
    - '@simodelne/pgas-server/create-server.js'
    - '@simodelne/pgas-server/client.js'
    - '@simodelne/pgas-server/channels/index.js'
    - '@simodelne/pgas-server/routes/index.js'
paths:
  programs_dir: programs
  audit_dir: audit
  pgas_new_dir: .pgas/pgas-new
registration:
  strategy: curator_request
verification:
  commands:
    install: 'npm install --no-audit --no-fund'
    typecheck: 'npm run typecheck'
    test: 'npm test'
curator:
  github_owner: simodelne
  github_repo: fake-consumer
EOF
```

Then drives `pgas-new --out /tmp/fake-consumer` through the agent, picks default skeleton, names the program "audit-trail".

**Verification:**
- Files written to `/tmp/fake-consumer/programs/audit-trail/` per the manifest's `paths.programs_dir`
- Curator-request artifact written to `/tmp/fake-consumer/audit/PGAS-NEW-audit-trail.md` per `registration.strategy: curator_request`
- `cd /tmp/fake-consumer && npm install && npm run typecheck` PASS (the consumer has package.json + tsconfig + deps now)

**Scenario D — refusal: missing manifest (Codex I10 fix)**

Codex runs `pgas-new --out /tmp/empty-dir-no-manifest`. Picks default skeleton. At `repo_targeting` the agent asks standalone-or-attach; Codex picks "attach". The foundry attempts to `load_wiring_manifest`. Manifest absent → handler emits `create_curator_request`. Verification: no files written under `/tmp/empty-dir-no-manifest/programs/`; a curator request artifact is emitted.

**Scenario E — refusal: invalid manifest**

Codex writes an invalid `.pgas/wiring.yml` (e.g., missing required `paths` field) to a test repo. Foundry rejects with clear error. No writes.

**Scenario F — refusal: collision (Codex I10 fix)**

Codex runs `pgas-new --out /tmp/pgas-new-e2e-scenario-a-output` a second time (the dir already has files from scenario A). The foundry refuses to overwrite. No writes.

**Scenario G — skip / reject / edit (Codex I6 fix)**

Codex drives the design path. On Q4 (decision points), Codex types `skip`. On confirm_design, Codex types `reject` then asks to change Q3 (stages). Foundry re-asks Q3, re-emits the confirmation. Codex approves.

**Scenario H — `/abort` during a running round**

Codex drives the design path. While the LLM is responding to Q3, Codex types `/abort`. The session aborts cleanly; no partial state mutations.

**Reporting:**

`.uat/codex-e2e-rebuild-report.md` with verdict + per-scenario PASS/FAIL/SKIP (with SKIP explicitly distinct from PASS per §9) + transcript paths.

## §11 Risks and mitigations

(Codex H additions integrated.)

| Risk | Likelihood | Mitigation |
|---|---|---|
| LLM behaves unpredictably during E2E (asks unexpected questions, gets stuck in loops) | High | Deterministic LLM stub for unit/integration tests; E2E retries with budget; Phase 4 release gate requires all 8 scenarios PASS; SKIP ≠ PASS |
| Synthesizer produces a spec that fails `loadSpecWithPatterns` | Medium | Validate inside handler; user has 2 confirm gates to revise before write; deterministic unit tests on synthesizer |
| Foundry-server lifecycle is fragile (port conflicts, slow start, child crash) | Medium | Health-poll with timeout; log redirect; surface log tail on crash; user can override port via env |
| Child-process operations (npm, git, gh) fail with unhelpful errors | Medium | All wraps include timeout + clear error formatting; secret redaction in error tail |
| Small models can't follow the foundry spec | Medium | Document tested models in README; `confirm_design` lets user override agent's interpretation |
| Tests slow CI down | Low | Phase 3's regression corpus uses LLM stub; only Phase 4 E2E hits real LLM; E2E in optional CI job |
| User runs `pgas-new` without provider env | Medium | CLI detects + prints friendly error; exit 1 |
| Governance drift from changing primary command without updating CLAUDE.md/MEMORY.md | High | **CLAUDE.md + MEMORY.md updates land in Phase 0.5 governance prerequisites, BEFORE Phase 1 — same commit as bare-`pgas-new` decision lands.** |
| Secret leakage through child server logs or E2E transcripts | Medium | foundry-server.ts secret-redaction policy in §7.5; E2E transcripts captured to `.uat/` (gitignored); preflight greps transcripts for known token patterns |
| String-level YAML edits break semantics | Medium | Synthesizer uses js-yaml parse → object operations → emit (not regex substitution) |
| Engine API mismatch unverified locally | Medium | Phase 2 sub-2.1 verifies engine load via testing harness BEFORE any agent code is written |
| Root package is private; release/package behavior unclear | Low | Plan stays private; foundry program rendered to `~/.pgas-new/foundry-v<version>/` on first run from source; no public publish |
| SKIP-vs-PASS confusion | Medium | Explicit assertion in acceptance §9; E2E reporter distinguishes |

## §12 Migration / rollout

| Version | Surface | Breaking? |
|---|---|---|
| v2.7.0 | Governance prereqs #37/#38/#39 + Phase 1 (foundry-program relocation, skeleton creation) | No |
| v2.8.0 | Phase 2 (agent + intake + REPL + bare-`pgas-new`). Deprecated `--template <consumer>` still works. | No |
| v2.9.0 | Phase 3 (synthesis + real handlers + regression corpus). Deprecated flags still work. | No |
| v3.0.0 | Phase 4 (remove deprecated flags). | Yes |

Each minor release runs `npm test` + the Codex E2E (8 scenarios) before tagging.

## §13 Implementation handoff to Codex

Reading order (matches `CLAUDE.md` required-reading; Codex I4 fix):

1. `CLAUDE.md`
2. `docs/PGAS-NEW-ARCHITECTURE.md`
3. `MEMORY.md` (Strategic Invariants)
4. `.remember/remember.md` if present
5. This plan (`docs/superpowers/specs/2026-06-22-v3-rebuild-plan.md`)
6. The trace doc (`docs/superpowers/specs/2026-06-22-v3-trace-from-v1-original.md`)
7. The post-mortem (`docs/POST-MORTEM-2026-06-22-design-phase-drift.md`)
8. v1 source: `git show 3d832b5^:commands/pgas-new-program.md`
9. v1 architecture: `git show 3d832b5^:audit/ARCHITECTURE-claude-pgas-plugin-v1.0.0.md`
10. Current code surface: `src/`, `templates/`, `tests/unit/`

Codex's mandate (when delegated):

1. Read above in order. Before writing any code.
2. Implement Phase 0.5, run tests, commit. Checkpoint to `.uat/codex-impl-phase-checkpoints.md`.
3. Implement Phase 1, atomic single commit per §8. Tests green. Checkpoint.
4. Implement Phase 2, six sub-commits per §8. Tests green at each. Checkpoint.
5. Implement Phase 3, five sub-commits per §8. Tests green at each. Checkpoint.
6. Run the Codex tmux E2E test (§10), all 8 scenarios. Capture transcripts to `.uat/e2e-rebuild-transcript-scenario-{a..h}.log`.
7. Write `.uat/codex-e2e-rebuild-report.md`.
8. Stop. Do not push. Do not open a PR. Do not implement Phase 4 (Phase 4 requires explicit second mandate authorization).

## §14 What this plan does NOT do

- Does not bring back v1's marker-injection mechanism
- Does not re-introduce per-domain consumer template presets
- Does not change the engine boundary (still public-only imports from `@simodelne/pgas-server`)
- Does not add a GUI
- Does not target non-TypeScript languages
- Does not bundle the foundry program in the npm package (D5: lives in `src/foundry-program/`; rendered to `~/.pgas-new/foundry-v<version>/` on first use)
- Does not implement v1's `pgas-program-builder` skill
- Does not move legacy scripted subcommands under a `pgas-new ci` namespace (D2: they stay at top level)
- Does not implement Phase 4 in the initial delegation (requires explicit second authorization)
