# v3.0 Implementation — v1 → v3 Point-by-Point Trace

Date: 2026-06-22 (revised 2026-06-22 per rebuild plan r3 cleanups)  
Status: draft, **supplemental reference** for Phase 2/3 implementation. The rebuild plan (`2026-06-22-v3-rebuild-plan.md`) is the canonical implementation source-of-truth; this trace is the v1→v3 mapping.

**Revisions:**
- r3 (2026-06-22): renamed `architecture.synthesized_spec` → `program.synthesized_spec` per rebuild plan D3; renamed `confirm_architecture` → `confirm_design` per rebuild plan §7.1.1; clarified that `apply_default_skeleton` is a **separate spec-declared action** called by the LLM after `choose_design_path` when default is selected (the two-action approach is intentional per rebuild plan N5 fix — keeps all state mutations declarative).

Source-of-truth for v1: `commands/pgas-new-program.md` (465 lines) and `audit/ARCHITECTURE-claude-pgas-plugin-v1.0.0.md` (211 lines), both deleted in commit `3d832b5` but recoverable from git history.

## Why this doc exists

The prior v3.0 design draft (commit `9b7fb1d`, then refined in `bf4ede6`) was directionally correct but **silently underspecified four load-bearing details from v1**:

1. The opt-in/opt-out fork (default 3-mode skeleton vs interview)
2. Echo-back-for-confirmation before write
3. Mechanical rename+copy synthesis vs freeform LLM emit
4. FM1–FM5 closure-by-construction discipline

This doc maps **every v1 design decision** to its **v3 implementation point** so a fresh implementer (Codex or human) cannot deviate without acknowledging it.

## Convention

Each row: **v1 design** → **v3 implementation** → **adherence check (test or code locator)**.

## §1 — The interactive design surface

| v1 | v3 |
|---|---|
| `/pgas-new-program` — Claude Code slash command inside an existing consumer repo. The session itself is the agent. | `pgas-new` (no args) — TypeScript CLI spawns an embedded foundry server child process, hosts the v2.5.x streaming REPL in-process, opens a session against the foundry program. The foundry program IS the agent. |
| Single conversation across all questions, batched via `AskUserQuestion`. | Single conversation across all questions, driven by the foundry's `intake_intelligence` mode via `user_text` / `user_confirmation` channels. |
| One Claude session = one design flow. | One CLI invocation = one design flow. SIGINT / `/exit` cleanly kills the child server. |

**Adherence check:** `tests/unit/cli-interactive.test.ts` (to be written): `runCli([])` enters the design flow; `runCli(['version'])`, `runCli(['help'])`, and all existing subcommands still work unchanged.

## §2 — The opt-in/opt-out fork (LOAD-BEARING — was missed in the prior draft)

**v1 spec, line 31:**
> Open with a single `AskUserQuestion`:
>
> > "Want to design the program's mode graph now (≈6 quick questions), or scaffold the default `start → working → complete` skeleton and shape it yourself later? (design / default)"
>
> If the user answers **default** (or skips), go straight to Step 1 — the scaffold emits the minimal three-mode program unchanged. **Do not block on the interview.**

**v3 implementation (Codex R4-I1 fix: ordering corrected — identity capture comes FIRST, then design-path fork):**

- The foundry's `intake_intelligence` mode's **first action** is `record_program_target` — captures slug/name/target_dir (either pre-filled from CLI `--slug`/`--name`/`--out` or asked via `request_user_action` with `intent='collect_program_identity'`). Sets `program.target_dir_confirmed = true`.
- Only AFTER `program.target_dir_confirmed = true` (engine-enforced precondition) does the agent call `request_user_action` with `intent='choose_design_path'`, offering two options: `design` or `default`.
- If user picks **default**: the agent calls `choose_design_path` with `design_path: 'default'` (sets `program.design_path = 'default'`), then immediately calls `apply_default_skeleton` (no args; the spec's declared MSet mutations populate `intake.stages = [{slug:'start', is_bootstrap:true}, {slug:'working'}, {slug:'complete', is_terminal:true}]`, `intake.transitions = [{from:'start', to:'working', trigger:'auto'}, {from:'working', to:'complete', trigger:'auto', guard_field:'work.example_ready', guard_value:true}]`, `intake.completion = {final_stage:'complete', guard_field:'work.example_ready'}`, etc., and `intake.program_intake_recorded = true`).
- If user picks **design**: the agent enters the Q1–Q6 interview.

**Mandatory minimum questions** even in `default` path: program name (kebab-case slug). Per v1 spec: "no questions beyond name/slug." Captured by `record_program_target` BEFORE the design-path fork.

**Adherence check (new test):**
```ts
it('foundry intake_intelligence orders record_program_target before choose_design_path', () => {
  // assert record_program_target precondition is program.target_dir_confirmed != true
  // assert choose_design_path precondition is program.target_dir_confirmed = true (engine-enforced ordering)
  // assert apply_default_skeleton precondition is program.design_path == 'default'
  // assert intake_intelligence guidance mentions identity capture first, then design-path fork
});
```

## §3 — The six questions (verbatim from v1)

| # | v1 question | v1 intent | v3 storage path |
|---|---|---|---|
| Q1 | "In one sentence, what does this program do?" | spec `preamble` ROLE line + `manifest.description` | `intake.purpose: string` |
| Q2 | "How does work arrive? (e.g. a user message, a scheduled tick, a webhook, another program delegating to it)" | bootstrap mode input channel + `continuationPolicy` defaults; default `user_text` | `intake.entry_channel: string` |
| Q3 | "What are the distinct stages this work moves through? Name them in order." | the **mode names**; default if skipped: `start`, `working`, `complete` | `intake.stages: array` (each `{slug, description, is_bootstrap?, is_terminal?}`) |
| Q4 | "Are there points where the flow branches (e.g. needs approval, can loop back, can bail out)?" | extra `transitions` entries with optional `guard` | `intake.transitions: array` |
| Q5 | "Does any stage delegate to a child session / another program?" | architecture-doc note + (if engine exposes delegation) `delegationPolicy` TODO; **do NOT invent engine APIs that aren't installed** | `intake.delegation: object` |
| Q6 | "How do you know the program is done?" | terminal mode + guard (the `work.*_ready` gate pattern) | `intake.completion: { final_stage: string, guard_field: string }` |

**Order matters.** v1 spec line 49: "ask the following six questions". Q3 (stages) before Q4 (decision points) before Q5 (delegation) before Q6 (completion). The agent must not reorder.

**Skip semantics from v1:** "accept 'skip' on any one and fall back to the default for that dimension." Skipped Q1 → generic purpose string. Skipped Q2 → `user_text`. Skipped Q3 → `[start, working, complete]`. Skipped Q4 → no extra transitions. Skipped Q5 → none. Skipped Q6 → terminal = last stage, guard = `work.example_ready`.

**Adherence check (already started by user):** the test added in `tests/unit/template-renderer.test.ts` ("declares the foundry Q1-Q6 intake recording action and guidance") asserts the schema, mutations, projection, and guidance. Extend with an assertion on the question ORDER.

## §4 — Echo-back-for-confirmation (LOAD-BEARING — was missed in the prior draft)

**v1 spec, line 87:**
> "After the interview, **echo the resulting mode list and transition list back to the user for confirmation** before copying templates."

**v3 implementation:**

- `intake_intelligence` ends with a `request_user_action` with `intent='confirm_design'` that renders the proposed mode list, transitions, terminal mode + guard, and asks for approval.
- Only on `inputs.user_decision.decision == 'approve'` does the spec's `intake_intelligence → architecture_design` transition fire.
- On `reject`: stay in `intake_intelligence`, ask which dimension to revise, re-run the relevant question.
- On `edit <text>`: capture the user's correction to a notebook entry and re-emit the proposal.

**Adherence check (new test):**
```ts
it('foundry intake_intelligence ends with a confirm_design user_confirmation gate', () => {
  // assert mode has user_confirmation channel
  // assert preconditions on the transition out require approval
  // assert guidance documents the echo-back step
});
```

## §5 — Mechanical synthesis (LOAD-BEARING — was missed in the prior draft)

**v1 spec, line 79:**
> "The answers customize the **emitted** `spec.yml`; they do not trigger a freeform rewrite. The customization is mechanical:
> 1. **Mode renames (Q3).** Replace the generic `start` / `working` / `complete` mode names with the user's stage names throughout `spec.yml`.
> 2. **Extra working stages (Q3, >3 stages).** For each stage between the bootstrap and terminal modes, **copy the `working` mode block** (its channels, prompts, vocabulary shape) and rename it. Do NOT hand-author a novel mode shape — the `working` block already has the FM3-safe channel set.
> 3. **Extra transitions (Q4).** Add `from/to/trigger` rows for each branch / loop-back / bail-out the user named.
> 4. **Terminal + gate (Q6).** Name the terminal mode after the user's final stage and gate the transition into it on the completion flag.
> 5. **Prose only (Q1, Q2, Q5).** Fold the purpose into the `preamble` ROLE line. Note the entry channel and any delegation in the README and `audit/ARCHITECTURE.md` TODO."

**v3 implementation:**

- Phase 3 ships a **`templates/pgas-new/program/spec-skeleton.yml.tmpl`** — the canonical 3-mode `start → working → complete` skeleton with FM3-safe channels and the engine-owned `inputs.query_*` schema.
- The `synthesize_program_spec` action in the foundry's `architecture_design` handler reads `intake.stages`, `intake.transitions`, `intake.delegation`, `intake.completion`, and the user's program name, then performs the **five mechanical operations above**:
  1. Mode renames (sed-style substitution).
  2. Copy the `working` block, rename per extra stage. Insert in linear order between bootstrap and terminal.
  3. Append extra `transitions:` rows.
  4. Rename terminal + set guard.
  5. Substitute purpose/entry-channel/delegation into the preamble + README.

The handler runs the engine's spec loader on the output to validate before returning. **No LLM call. No freeform JSON. No new mode shapes invented.**

**Anti-pattern explicitly forbidden:** asking the LLM to emit a full `specs.yml` as a string. The skeleton is mechanical; the spec shape is testable.

**Adherence check (Phase 3 task):**
```ts
it('synthesize_program_spec performs mechanical rename+copy, not LLM-freeform', () => {
  // unit-test the handler directly with a fixed intake payload,
  // assert it does NOT call any LLM-emit surface,
  // assert it does emit a valid PGAS spec the engine can load
});
```

## §6 — Mode A vs Mode B vs v3's collapse

| v1 | v3 |
|---|---|
| `/pgas-new-consumer` (Mode A): scaffold a fresh pgas consumer repo (server, auth, migrations, CI, markers). Used once per repo. | `pgas-new` (no args) + the foundry's `repo_targeting` mode branches on user choice: `standalone` (fresh repo with server+REPL+program — current `render-standalone` behavior) or `existing_repo` (attach a program into a repo that already has `.pgas/wiring.yml`). |
| `/pgas-new-program` (Mode B): scaffold a new program INSIDE an existing consumer; **detects markers** in `server/index.ts` and **injects** `import` + `registry.register` calls. Used per program. | `existing_repo` branch reads `.pgas/wiring.yml` (the v2 manifest), respects the manifest's `paths.programs_dir` for output paths, and lodges a curator request if registration is `curator_request` strategy. No CLI-side marker injection. |

**Design decision (already made in v2):** v3 keeps the v2 `.pgas/wiring.yml` manifest contract instead of reviving v1's marker-injection. Rationale:

1. The manifest is auditable upfront (single declarative file in target repo).
2. Marker injection requires write access to arbitrary consumer files; the manifest contract limits writes to `paths.programs_dir/<slug>/`.
3. Curator-request flow is cleaner than "inject into whatever file matches a regex."

The marker-injection mechanism is **not** restored. v3 does not need it. This is a documented v2 design decision, not drift.

**Adherence check:** existing tests in `tests/unit/cli.test.ts` cover the `render-attach` manifest path; no new test needed here.

## §7 — FM1–FM5 closure-by-construction (LOAD-BEARING — was missed in the prior draft)

**v1 arch paper:**
> "consumer-integration failure modes from pgas#253 (FM1–FM5) are **closed by construction**":

| FM | v1 closure mechanism | v3 closure mechanism (must verify) |
|---|---|---|
| **FM1** payload-vs-domain reads | `handlers/_resolver.ts` ships with the program; payload-override-then-domain pattern | Skeleton's handlers.ts must ship a resolver helper. Verify in `tests/unit/template-renderer.test.ts`. |
| **FM2** missing continuation consumers | server template wires `InnerContinuationReplay` + `SessionLockExhausted` | The generated `src/server.ts` uses `@simodelne/pgas-server/create-server.js` whose internal contract handles this; verify the generated server matches. |
| **FM3** `system_mode_entry` only on bootstrap | spec admits `system_mode_entry` on bootstrap mode only + `mode-entry-lint` | Phase 3 synthesis must produce specs where only the bootstrap mode lists `system_mode_entry` in `channels:`. Verify in a regression test against synthesized output. |
| **FM4** handler-backed tools silently `undefined` | `registration.ts.tmpl` ships the `createAdapters` override worked example | Already in `templates/pgas-new/program/registration.ts.tmpl`; verify after rename+copy synthesis doesn't strip it. |
| **FM5** engine-owned paths undeclared | spec template carries the full set `inputs.query_result.{kind,value_json}`, `inputs.query_meta.{source_path,source_channel,continuation_round,scope_redirect,message}` | Skeleton must declare these in `schema:`. Verify in a regression test. |

**Adherence check (Phase 3 task, before synthesis ships):**
```ts
describe('FM closure-by-construction in synthesized programs', () => {
  it('FM1: handlers.ts ships the resolver helper', ...);
  it('FM2: server.ts wires the continuation consumers via create-server', ...);
  it('FM3: only bootstrap mode declares system_mode_entry channel', ...);
  it('FM4: registration.ts contains createAdapters override', ...);
  it('FM5: schema declares all engine-owned inputs.query_* paths', ...);
});
```

These five tests run against a freshly synthesized program produced by feeding a fixture intake into the synthesis action. They are the regression fence that prevents the synthesizer from drifting.

## §8 — Verification ladder (5-rung)

**v1 arch paper:**
> "five-rung verification ladder that executes every scaffold surface against the real engine"

**v3 implementation:** the foundry's `static_verify` and `live_verify` modes are exactly this. Declared in `src/foundry-program/specs.yml` (relocated from `templates/pgas-new/program/specs.yml.tmpl` in Phase 1 of v3 per the rebuild plan).

| Rung | v1 step | v3 mode |
|---|---|---|
| 1 | render | `branch_write` |
| 2 | install | `static_verify` action `npm_install` |
| 3 | typecheck | `static_verify` action `npm_typecheck` |
| 4 | run | `static_verify` action `npm_test` |
| 5 | consumer-tests (end-to-end against real engine) | `live_verify` action `run_live_provider_verification` |

**Adherence check:** existing `tests/pgas-new-static.test.sh` exercises rungs 1–4. Live (rung 5) is the user-confirmed graduation path.

## §9 — Name/slug derivation

**v1 spec, lines 138–147:**
> - **Program name** — kebab-case, e.g. `legal-rag`, `contract-draft`.
> - **Program slug** — default = program name with `_` instead of `-` (e.g. `legal-rag` → `legal_rag`). Used in TypeScript identifier contexts.
> - **`{{PROGRAM_NAME_PASCAL}}`** — strip the hyphens and upper-case each segment's first letter (`legal-rag` → `LegalRag`).

**v3 implementation:** the foundry's `intake_intelligence` mode asks for the program name (kebab-case). The agent derives slug + PascalCase automatically. Match v1's three forms.

**Adherence check:** existing `validateProgramIdentity` in `src/pgas-new/artifact-plan.ts` enforces kebab-case slug. Extend the foundry intake to ask for the kebab name and derive the rest.

## §10 — The four marker comments (informational, not restored)

**v1 spec, lines 158–175:**
> ```
> // [pgas-plugin:program-registry] — auto-injected program imports below
> // [pgas-plugin:program-registration] — auto-injected `registry.register(...)` calls below
> // [pgas-plugin:spec-registry] — auto-injected spec loads below
> // [pgas-plugin:handler-registry] — auto-injected handler imports below
> ```
> "the two empty markers **MUST remain in the file** — never remove them. They exist for backward compatibility..."

**v3:** the marker mechanism is **not** restored (see §6 — v2 chose the manifest contract instead). The `.pgas/wiring.yml` manifest's `registration.strategy` field replaces the marker-injection step. Generated consumer scaffolds (when v3 supports them) do not need markers.

**No adherence check.** This is an intentional v2 departure from v1.

## §11 — What v3 adds beyond v1 (not drift, evolution)

- **Streaming REPL UI** with SSE phase indicators, mode banners, ANSI box rendering of action results. v1 was inline-Claude-session text; v3 is a real terminal UI. Same intent (one conversation), better UX.
- **Foundry runs as a real PGAS program** (the spec at `src/foundry-program/specs.yml`, relocated in v3 Phase 1) against `@simodelne/pgas-server`. v1's design phase was Claude-driven prose execution; v3's design phase is engine-driven mode-machine execution. Stronger contract.
- **`.pgas/wiring.yml` manifest** for attach (replaces marker injection — documented in §6).
- **Verification ladder as PGAS modes** (`static_verify`, `live_verify`, `rebase_verify`, `pr_graduation`) rather than ad-hoc shell scripts. Each rung records evidence to governed state.

## §12 — Phased delivery (revised)

**v2.7.0 (LANDED on `main` at HEAD `33e35a9` + subsequent):**
- ✅ Graduation programs moved to `docs/graduation-evidence/`
- ✅ MANDATE.md per graduation program
- ✅ `--template <consumer>` deprecation warning
- ✅ Governance corrections A, B, F (CLAUDE.md Program Nature, expanded required reading, MEMORY.md Strategic Invariants)
- ✅ Post-mortem doc
- ⏳ Pre-release verification + tag (pending — phases 2/3 work first, then cut v2.7.0)

**v2.8.0 (Phase 2 — bare-`pgas-new` REPL entry, the conversation surface):**

1. Refactor `templates/pgas-new/standalone/src/repl/{index,renderer}.ts.tmpl` content into in-repo `src/repl/{runner,renderer}.ts` (reusable by the foundry CLI).
2. New file `src/foundry-server.ts`: render-foundry-on-first-run (to `~/.pgas-new/foundry-v<version>/`) + spawn child server + health-poll + return `{apiBase, wsBase, token, kill}`.
3. `pgas-new` (no args) entry path: print banner, spawn server, run REPL against foundry program, clean up on exit. Optional `--slug`, `--out`, `--non-interactive`.
4. **Foundry spec changes** (per the user's test scaffolding already on main):
   - Add `record_program_intake` action with the 7 mutations (purpose, entry_channel, stages, transitions, delegation, completion, program_intake_recorded).
   - Add the 11 schema entries (`intake.purpose: string`, `intake.entry_channel: string`, `intake.stages: array`, `intake.stages.*: object`, `intake.transitions: array`, `intake.transitions.*: object`, `intake.delegation: object`, `intake.completion: object`, `intake.completion.final_stage: string`, `intake.completion.guard_field: string`, `intake.program_intake_recorded: boolean`).
   - Add `record_program_intake` to `intake_intelligence` mode's vocabulary and projection.
   - Add guidance with the four directives the user's test asserts (ask Q1–Q6 in order; use `request_user_action` with `intent='collect_program_intake'`; call `record_program_intake` with structured payload; don't re-ask what's already extracted).
5. **NEW from this trace doc — §2 fork:** add `record_program_target` as the first guidance line (captures slug/name/target_dir before the design-path fork — Codex R4-I1 ordering). Then add the choose-design-path step as the second guidance line. Add `program.design_path: string` to schema under the `program.*` namespace (D3). Add a separate mode-action `apply_default_skeleton` with declared `mutations:` populating `intake.stages/transitions/completion` to the 3-mode defaults; precondition gates it on `program.design_path == 'default'`. Two-action approach by design (rebuild-plan N5): `choose_design_path` records the choice only, `apply_default_skeleton` populates defaults; guidance instructs the LLM to call them in sequence.
6. **NEW from this trace doc — §4 echo-back:** `intake_intelligence` ends with `confirm_design` user_confirmation step. Mode transition out of `intake_intelligence` gated on `program.design_confirmed = true`.
7. Handler stub for `record_program_intake` (already asserted by user's test).
8. Tool registration for `record_program_intake` (already asserted by user's test).
9. Tests covering: bare-entry behavior, design-path fork, echo-back gate, full Q1–Q6 mutations and schema.

**v2.9.0 (Phase 3 — deterministic synthesis):**

1. Ship `templates/pgas-new/program/spec-skeleton.yml.tmpl` — the canonical 3-mode skeleton, FM3-safe, with all engine-owned schema paths declared (FM5).
2. Implement `synthesize_program_spec` handler in the foundry: rename + copy-block per §5. **No LLM call.** Validate output against the engine's spec loader before returning.
3. `architecture_design` mode runs `synthesize_program_spec`, writes result to `program.synthesized_spec` (D3 namespace decision). The `confirm_design` user_confirmation step is the FIRST of the two D4 confirms and happens at the END of `intake_intelligence` (gating entry into `architecture_design`), not at the end of `architecture_design`. Architecture_design runs the deterministic synthesizer + a final readback before transitioning to `scaffold_plan`.
4. `scaffold_plan` reads `program.synthesized_spec`, produces an artifact plan including handlers/{index,_resolver}.ts (FM1 layout) + tools + tests, then ends with the SECOND D4 confirm (`approve_plan`).
5. `branch_write` writes the synthesized program.
6. Regression corpus: feed each `docs/graduation-evidence/<name>/MANDATE.md` into the synthesizer (deterministic, no LLM), assert structural-equivalence with the frozen graduation spec.
7. FM1–FM5 closure tests (§7).

**v3.0.0 (Phase 4 — breaking cleanup):**

1. Delete `--template policy-drafting|web-scraper|social-media-agent` flags.
2. Update README + architecture doc.
3. Cut release.

## §13 — Acceptance criteria summary

Phase 2 ships when ALL of:

- [ ] `pgas-new` (no args) opens the REPL and runs the foundry program
- [ ] Foundry's `intake_intelligence` mode captures identity (`record_program_target`) BEFORE asking the design-path question (Codex R4-I1 ordering)
- [ ] After identity is captured, the mode offers the choose-design-path fork
- [ ] If user picks `default`: `apply_default_skeleton` fires with declared MSet mutations; name/slug only required
- [ ] If user picks `design`: Q1–Q6 asked in order, skips fall back to defaults
- [ ] After Q6 (or after `default` skeleton), agent echoes the design back for user confirmation (`confirm_design`)
- [ ] `confirm_design` and `approve_plan` are idempotent (`FieldFalsy` precondition on themselves; Codex R4-I2)
- [ ] All foundry spec contracts asserted by the user's test in `tests/unit/template-renderer.test.ts` pass
- [ ] Bare-entry test asserts the REPL opens (without requiring an actual LLM server in unit tests — use a stub)
- [ ] All existing tests stay green; new tests added per the plan

Phase 3 ships when ALL of Phase 2 + ALL of:

- [ ] `spec-skeleton.yml.tmpl` exists, FM3-safe, FM5-complete
- [ ] `synthesize_program_spec` handler is pure mechanical rename + copy (verified by code inspection AND by a test that runs it WITHOUT a network/LLM dependency)
- [ ] FM1–FM5 closure tests pass against synthesized output
- [ ] Each graduation MANDATE.md synthesizes back to a structurally-equivalent spec (regression corpus)
