# v3.0 Rebuild Plan — Restore the agent-driven foundry

Date: 2026-06-22  
Status: draft (to be Codex-validated before delegation)  
Anchors:
- v1 source: `commands/pgas-new-program.md` (recoverable from commit `3d832b5^`, working copy at `/tmp/v1-pgas-new-program.md`)
- v1 architecture paper: `audit/ARCHITECTURE-claude-pgas-plugin-v1.0.0.md` (recoverable from `3d832b5^`)
- Current architecture doc: `docs/PGAS-NEW-ARCHITECTURE.md`
- Trace: `docs/superpowers/specs/2026-06-22-v3-trace-from-v1-original.md`
- Post-mortem: `docs/POST-MORTEM-2026-06-22-design-phase-drift.md`
- Strategic invariants: `MEMORY.md` (SI-1 through SI-5)

## 0. Goal (Simone's own words, verbatim)

> *"pgas-new was meant to be an agent for creating new pgas-engine consumers either as standalone repo or as programs within existing repos like simoneos built in accordance with a blueprint of file organization and governance and in accordance to a manifest."*

Decomposed into six load-bearing claims:

1. **Agent** — conversational, drives a session, walks the user through phases
2. **Creates new pgas-engine consumers** — output is a runnable PGAS program against `@simodelne/pgas-server`
3. **Standalone repo** — one output mode: a fresh repo
4. **Programs within existing repos** — second output mode: drop a new program into an existing PGAS-consumer repo (e.g., simoneos)
5. **Blueprint of file organization and governance** — fixed canonical layout the output always follows
6. **Manifest** — declarative file (`.pgas/wiring.yml`) in the target repo describing where things go

## 1. Non-goals

- A general coding assistant
- A GUI / web UI
- Multi-language program generation (TypeScript/Node only)
- Public npm publication (GitHub Packages stays)
- Removing the foundry's self-program template (`pgas-new-foundry`); it stays as the bootstrap path

## 2. What the foundry is, after v3.0

`pgas-new` is itself a **PGAS program** running on `@simodelne/pgas-server`. Its spec lives at `src/foundry-program/specs.yml` (not under `templates/`), declares 10 modes (`intake_intelligence → repo_targeting → architecture_design → scaffold_plan → branch_write → static_verify → live_verify → rebase_verify → pr_graduation → curator_request`), and its handlers do real work (file I/O, npm, git, PR opening).

`pgas-new` invoked with **no arguments** (or with `--slug <slug>` / `--out <dir>`) spawns an embedded pgas-server child process loaded with the foundry program, hosts the streaming REPL in-process connected via HTTP+WS, opens a session, and the agent drives the conversation through the 10 modes. Single command. Single process.

Output: a fresh PGAS consumer (standalone repo or program-within-existing-repo per the manifest contract), conforming to the canonical blueprint, with the user's program design synthesized **deterministically** from their intake answers via mechanical rename+copy from a generic skeleton.

## 3. Salvage list — files that stay exactly as-is

| Path | Lines | Why |
|---|---|---|
| `templates/pgas-new/standalone/package.json.tmpl` | 26 | Generic blueprint — package.json shape |
| `templates/pgas-new/standalone/tsconfig.json.tmpl` | 14 | Generic blueprint |
| `templates/pgas-new/standalone/src/server.ts.tmpl` | 9 | Generic blueprint — boots pgas-server with the user's program |
| `templates/pgas-new/standalone/src/repl/index.ts.tmpl` | 432 | The streaming REPL for the GENERATED consumer (rendered scaffold ships its own copy). End-to-end verified through 6 UAT rounds. |
| `templates/pgas-new/standalone/src/repl/renderer.ts.tmpl` | 90 | Same — verified |
| `templates/pgas-new/standalone/.pgas/pgas-new/dossier.yml.tmpl` | — | Generic blueprint — intake dossier |
| `templates/pgas-new/standalone/.pgas/pgas-new/artifacts.json.tmpl` | — | Generic blueprint — artifact manifest |
| `templates/pgas-new/repo/.pgas/wiring.yml.tmpl` | 8 | The manifest blueprint |
| `templates/pgas-new/tests/*.test.ts.tmpl` (5 files) | 140 | Generic born-with tests — spec-load, control-plane, deterministic, api-blackbox, live-provider |
| `templates/pgas-new/audit/PGAS-NEW-GRADUATION.md.tmpl` | 13 | Generic graduation evidence stub |
| `templates/pgas-new/consumer/artifacts.json.tmpl` | 10 | Generic artifact-manifest stub (consumer-side flag, used by both standalone + attach) |
| `templates/pgas-new/curator/missing-wiring-request.md.tmpl` | 11 | Generic curator-request stub |
| `templates/pgas-new/curator/registration-request.md.tmpl` | 19 | Generic curator-request stub |
| `src/pgas-new/artifact-plan.ts` | 200 | Artifact-plan model + path safety |
| `src/pgas-new/template-renderer.ts` | 330 | Template substitution + renderStandaloneScaffold + renderExistingRepoAttachment |
| `src/pgas-new/wiring-manifest.ts` | 150 | Manifest schema + validator |
| `src/pgas-new/existing-repo.ts` | — | Existing-repo attach prep |
| `src/pgas-new/curator-request.ts` | — | Curator-request rendering |
| `src/pgas-new/version.ts` | 50 | Engine version pin + banned-imports scanner |
| `src/pgas-new/model.ts` | — | Foundry model state types |
| `src/pgas-new/gates.ts` | — | Mode-gate logic |
| `src/pgas-new/command-runner.ts` | — | Semantic command runner |
| `src/pgas-new/control-plane.ts` | — | Control-plane vocabulary |
| `src/pgas-new/verify.ts` | — | Verification ladder helpers |
| `tests/unit/*` | ~2000 | All existing unit tests (90 currently green) |
| `tests/plugin-manifest.test.sh` | 92 | Structural smoke test |
| `tests/pgas-new-static.test.sh` | 60 | Static render+install+typecheck+test gate |
| `docs/PGAS-NEW-ARCHITECTURE.md` | — | Architecture contract |
| `docs/PGAS-NEW-LIVE-GRADUATION.md` | — | Live-graduation contract |
| `docs/POST-MORTEM-2026-06-22-design-phase-drift.md` | — | Yesterday's post-mortem |
| `docs/graduation-evidence/{policy-drafting,web-scraper,social-media-agent}/*` | — | Evidence + regression corpus (already correctly demoted yesterday) |
| `CLAUDE.md` (with v2.7.0 governance corrections A+B) | — | Governance — Program Nature, required reading |
| `MEMORY.md` (with v2.7.0 SI-1..SI-5 invariants) | — | Strategic invariants |
| `.github/workflows/ci.yml` | 67 | CI runner config |
| `.gitignore`, `.claude-plugin/plugin.json`, `LICENSE`, `README.md` | — | Standard repo files |

**Salvage subtotal: ~4500 lines of working code + ~2000 lines of tests + docs.**

## 4. Refactor list — files that move, rename, or get materially restructured

### 4.1 The foundry's own program leaves the templates tree

The current `templates/pgas-new/program/*` was misframed as "the generic program template." It is actually **the foundry's own self-program** (10 modes, foundry-specific actions like `design_architecture`, `plan_artifacts`, `write_scaffold_artifacts`, `npm_install`, etc.). It needs to leave the templates tree.

| From | To | Notes |
|---|---|---|
| `templates/pgas-new/program/specs.yml.tmpl` | `src/foundry-program/specs.yml` | Drop `.tmpl` (no substitution — it's the foundry's runtime spec). Resolve any `{{TOKEN}}` to baked literals (`pgas-new` slug, `PgasNew` PASCAL_NAME, etc.). Keep the 10-mode structure. |
| `templates/pgas-new/program/handlers.ts.tmpl` | `src/foundry-program/handlers.ts` | Same. Will be heavily expanded (currently 3 of 33 actions implemented as echo stubs; v3.0 implements all). |
| `templates/pgas-new/program/tools.ts.tmpl` | `src/foundry-program/tools.ts` | Same. Currently all 33 tools registered as noopTool; v3.0 implements the ones that need real implementations (npm child_process, fs IO, git child_process, fetch). |
| `templates/pgas-new/program/registration.ts.tmpl` | `src/foundry-program/registration.ts` | Same. |

### 4.2 The streaming REPL gets a sibling copy in `src/`

The streaming REPL currently lives only in `templates/pgas-new/standalone/src/repl/` (it gets rendered into every generated scaffold). The foundry CLI itself also needs to use it (to drive the agent conversation against the embedded foundry server).

| Create | Source | Notes |
|---|---|---|
| `src/repl/runner.ts` | Refactor from `templates/pgas-new/standalone/src/repl/index.ts.tmpl` | Reusable streaming-REPL runtime callable from the CLI. Same SSE+WS logic, same control-plane handling, same queue/abort/textBusy guards. Token substitution stripped. |
| `src/repl/renderer.ts` | Copy of `templates/pgas-new/standalone/src/repl/renderer.ts.tmpl` | Same. Box-drawing + spinner + chalk styling. |

The template files stay where they are — generated scaffolds keep their own copy.

### 4.3 The CLI entry point gets rewritten

`src/cli.ts` (currently ~330 lines, all flag-parsing + render-dispatch) gets restructured:

- **Default entry path** (no args or `--slug ... --out ...` only): spawn embedded foundry server, host REPL, run the agent conversation. This is the new primary surface.
- **Subcommand entry paths** (`version`, `help`, `validate-manifest`, `plan-standalone`, `render-standalone`, `plan-attach`, `render-attach`, `curator-request`, `session`): unchanged through v2.x — keep working for scripts and CI.
- **`pgas-new render-foundry --out <dir>`**: new explicit self-bootstrap (renders the foundry's own program as a standalone scaffold; replaces `--template pgas-new-foundry`).

### 4.4 Test files restructured

`tests/unit/cli.test.ts` (currently 200+ lines, all subcommand tests) gets a peer:

| Create | Notes |
|---|---|
| `tests/unit/cli-interactive.test.ts` | Tests for the `pgas-new` (no args) entry path, design-path fork, intake recording, etc. Uses a deterministic LLM stub from `@simodelne/pgas-server/testing.js` so the conversation is reproducible. |
| `tests/unit/foundry-program.test.ts` | Tests for `src/foundry-program/`: handler implementations, tool implementations, FM1–FM5 closure, etc. |
| `tests/e2e/cli-design-session.test.sh` | End-to-end shell test: render foundry as a standalone scaffold, install, start, drive a full design session via stdin-piped REPL inputs, verify a fresh program is emitted. Companion to the Codex tmux-driven acceptance test described in §9. |

## 5. Delete list — files that go away (mostly already moved or scheduled)

| Path | Reason | Status |
|---|---|---|
| The `policy-drafting | web-scraper | social-media-agent` values from the CLI's `ProgramTemplate` enum and the help text | Deprecated in v2.7.0; v3.0 removes | Already deprecated |
| `STANDALONE_PROGRAM_OVERRIDE_BY_TEMPLATE` map in `template-renderer.ts` + the three `EXISTING_*_TEMPLATE_BY_KIND` maps | The override mechanism's only purpose was routing the three consumer presets to their graduation programs | Remove when the flags are removed |
| References to the foundry-self-as-a-template in `STANDALONE_TEMPLATE_BY_PATH` | The foundry's program is no longer a user-output template; it's the foundry's runtime program | Remove when `src/foundry-program/` exists |
| `docs/graduation-evidence/{policy-drafting,web-scraper,social-media-agent}/*.tmpl` files | They were template files for the deprecated flags; once the flags are removed and the regression corpus is set up against `MANDATE.md`s, the `.tmpl` files don't need to be loaded by the template-renderer anymore | Keep as evidence; un-wire from renderer |

## 6. New surface — what gets built

### 6.1 `src/foundry-program/` — the foundry's runtime program

The foundry is itself a PGAS program. This directory contains its spec + handlers + tools + registration. **Not a template — actual runtime code.**

**`src/foundry-program/specs.yml`** (~342 lines, derived from the moved `program/specs.yml.tmpl`):

Same 10 modes as today. Adds:

- New action `record_program_intake` (the Q1–Q6 capture; already speced in `tests/unit/template-renderer.test.ts` per the test added yesterday). Mutations: `intake.purpose`, `intake.entry_channel`, `intake.stages`, `intake.transitions`, `intake.delegation`, `intake.completion`, `intake.program_intake_recorded`.
- New action `choose_design_path` with mutation `intake.design_path: 'design' | 'default'`. Default branch sets the 3-mode skeleton constants and `intake.program_intake_recorded = true` so the user doesn't have to answer Q1–Q6.
- New action `confirm_design` — gated user_confirmation step. `intake_intelligence → architecture_design` transition requires `intake.design_confirmed = true`.
- New action `synthesize_program_spec` in `architecture_design` mode (Phase 3 work). Reads `intake.*` from state, runs mechanical rename+copy against the skeleton, writes the result to `architecture.synthesized_spec`.
- Schema entries for all new state fields.
- Projection includes for all new fields.
- Guidance for `intake_intelligence` covering: ask Q1–Q6 in order; use `request_user_action` with `intent='collect_program_intake'`; call `record_program_intake` with structured payload; don't re-ask what's already extracted; if user chose default path, skip the interview.

**`src/foundry-program/handlers.ts`** (currently 24 lines, expands to ~700 lines):

Implements every action declared in the spec's `vocabulary:` lists across all 10 modes. Concrete handlers for what each is supposed to do:

| Handler | Implementation |
|---|---|
| `record_user_note` | Record to state (already implemented as echo, stays similar) |
| `pin_notebook_note` | Pin notebook key (state mutation only) |
| `confirm_research_scope`, `record_user_requested_research` | Toggle state flags |
| `web_research` | **Real implementation** — calls a research tool (fetch with allowlisted domains) and records results to state |
| `select_repo_target`, `authorize_standalone_target`, `authorize_existing_repo_target` | State flags |
| `load_wiring_manifest` | **Real implementation** — calls `loadWiringManifest()` from `src/pgas-new/wiring-manifest.ts` and writes the result to state |
| `create_curator_request` | **Real implementation** — calls `prepareExistingRepoAttachment()` and writes the request artifact via `src/pgas-new/curator-request.ts` |
| `design_architecture` | State mutation — records the user's architecture intent (mode list, transition list) to `architecture.*` |
| `synthesize_program_spec` | **Real implementation** (Phase 3) — runs the mechanical rename+copy synthesizer |
| `plan_artifacts` | **Real implementation** — calls `createStandaloneArtifactPlan` or `createExistingRepoArtifactPlan` from `src/pgas-new/artifact-plan.ts` |
| `approve_artifact_plan` | State flag |
| `write_scaffold_artifacts` | **Real implementation** — calls `renderStandaloneScaffold` or `renderExistingRepoAttachment` from `src/pgas-new/template-renderer.ts`. Uses the synthesized spec from state, not a frozen template. |
| `git_status` | **Real implementation** — child_process `git status --short` on the target repo |
| `npm_install` | **Real implementation** — child_process `npm install --no-audit --no-fund` in the target dir |
| `npm_typecheck` | child_process `npm run typecheck` |
| `npm_test` | child_process `npm test` |
| `run_static_verification` | Wrap install+typecheck+test, record evidence |
| `confirm_live_provider_intent` | User_confirmation step |
| `run_api_blackbox_verification` | **Real implementation** — runs the generated `tests/api-blackbox.test.ts` against an in-process pgas-server with the generated program loaded |
| `run_live_provider_verification` | **Real implementation** — runs the generated `tests/live-provider.test.ts` against a real LLM provider per user-confirmed env vars |
| `git_rebase_latest` | child_process `git fetch && git rebase` |
| `run_rebase_static_verification` | Re-run static after rebase |
| `open_pull_request` | **Real implementation** — child_process `gh pr create` with the body assembled from `architecture.*` + `graduation.*` evidence |
| `record_program_intake` | Already covered (records Q1–Q6 to state) |
| `choose_design_path` | Sets `intake.design_path` and (on default) populates the skeleton constants |
| `confirm_design` | Sets `intake.design_confirmed = true` |

**`src/foundry-program/tools.ts`** (currently 48 lines all-noop, expands to ~400 lines):

Tool implementations for actions that genuinely need a tool (the engine's `kind: 'local'` shape). Most semantic actions go through handlers; tools cover things that benefit from being declarative (e.g., `web_research`'s allowlist, `npm_*` env handling).

**`src/foundry-program/registration.ts`** (~40 lines):

Standard PGAS program registration: `createProgramAdapters`, `createToolRegistry`, `loadSpecWithPatterns`, `enableNotebook`. Exports `createPgasNewFoundryProgramEntry()`.

### 6.2 `templates/pgas-new/program/` — the new generic skeleton

Replaces the misframed contents (which moved to `src/foundry-program/`). Now contains a **truly generic 3-mode skeleton** that the foundry's `synthesize_program_spec` action operates on.

| Path | Content |
|---|---|
| `templates/pgas-new/program/spec-skeleton.yml.tmpl` (~200 lines) | The canonical generic skeleton: 3 modes `start → working → complete`. `start` is the bootstrap mode (sole admitter of `system_mode_entry`, per FM3). `working` is the handler-result-driven mode (FM3-safe channel set). `complete` is the terminal mode. Standard `control_plane:` vocabulary. Engine-owned schema paths declared (`inputs.query_result.{kind,value_json}`, `inputs.query_meta.{source_path,source_channel,continuation_round,scope_redirect,message}`, per FM5). Action map carries: `record_user_note`, `pin_notebook_note`, `example_action` (placeholder the synthesizer renames), and standard session controls. |
| `templates/pgas-new/program/handlers-skeleton.ts.tmpl` (~80 lines) | Minimal handlers for the skeleton actions. Ships `handlers/_resolver.ts` pattern (FM1). |
| `templates/pgas-new/program/tools-skeleton.ts.tmpl` (~50 lines) | Tool registry shell. |
| `templates/pgas-new/program/registration-skeleton.ts.tmpl` (~40 lines) | Standard registration shape. Ships the `createAdapters` override worked example (FM4). |

The skeleton is **rendered + transformed** by `synthesize_program_spec`. The synthesizer:

1. Reads `intake.stages`, `intake.transitions`, `intake.completion` from state.
2. Loads `spec-skeleton.yml.tmpl`.
3. Performs five mechanical operations (per v1 spec):
   - **Mode renames** (Q3): `start` → first stage; `working` → middle stages (one per extra stage); `complete` → last stage.
   - **Extra working stages** (Q3 > 3): for each middle stage, copy the `working` block, rename, chain transitions linearly.
   - **Extra transitions** (Q4): add `from/to/trigger` rows for each branch / loop-back / bail-out, with optional `guard`.
   - **Terminal + gate** (Q6): name the terminal mode after the user's final stage, gate the transition into it on the completion flag.
   - **Prose** (Q1, Q2, Q5): fold purpose into preamble ROLE line, note entry channel + delegation in the README.
4. Validates the output against the engine's spec loader (`@simodelne/pgas-server/testing.js`'s `loadSpecWithPatterns`).
5. Writes to `architecture.synthesized_spec` in state.

**No LLM call in the synthesizer.** The LLM does judgment in `intake_intelligence` (asking questions, parsing free-text, deciding follow-ups); the synthesis is pure code.

### 6.3 `src/foundry-server.ts` — embedded server lifecycle

| Item | Purpose |
|---|---|
| `spawnFoundryServer(opts)` | Spawn an embedded `@simodelne/pgas-server` child process. Loads `createPgasNewFoundryProgramEntry()`. Renders the foundry-program working dir to `~/.pgas-new/foundry-v<version>/` on first run (one-time cost, cached). Picks free port. Suppresses child stdout/stderr to a log file. Polls `/health` with timeout. Returns `{apiBase, wsBase, token, kill}`. |
| LLM provider env passthrough | `PGAS_OPENAI_BASE_URL`, `PGAS_OPENAI_API_KEY`, `PGAS_OPENAI_MODEL`, `PGAS_GEMINI_*`, `PGAS_ANTHROPIC_*`, `PGAS_OLLAMA_*` — pass through to the child. |
| SIGINT propagation | Parent SIGINT cleanly kills child. |
| Crash handling | If child exits non-zero during startup, surface the tail of its log to the user with a clear message. |

### 6.4 `src/cli.ts` rewrites the entry switch

The first argv-classification step:

```ts
const isAgentEntry =
  argv.length === 0 ||
  (argv[0] && !argv[0].startsWith('-') && !KNOWN_SUBCOMMANDS.has(argv[0])) ||
  argv.includes('--design');

if (isAgentEntry && !argv.includes('--help') && !argv.includes('-h')) {
  return runAgentSession(argv);
}
```

`KNOWN_SUBCOMMANDS` is the existing set: `help`, `version`, `session`, `plan-standalone`, `render-standalone`, `validate-manifest`, `plan-attach`, `render-attach`, `curator-request`, plus the new `render-foundry`.

`runAgentSession(argv)`:

1. Parse `--slug`, `--name`, `--out`, `--non-interactive` from argv.
2. Print banner.
3. `spawnFoundryServer()`.
4. `runStreamingRepl({ apiBase, wsBase, token, program: 'pgas-new-foundry' })` from the new `src/repl/runner.ts`.
5. The REPL opens a session against the foundry program. `intake.program_slug` and `intake.out_dir` are pre-set if the user passed `--slug` / `--out` (so the agent doesn't have to ask).
6. The agent drives the conversation. When the session reaches `pr_graduation` (or terminal mode for non-PR flows), the foundry's `branch_write` has already written the user's program to `--out` (or to a default `./<slug>`).
7. On user `/exit` or SIGINT: clean shutdown — kill the child, print "Bye."

### 6.5 New tests

| Test | Purpose |
|---|---|
| `tests/unit/cli-interactive.test.ts` | `runCli([])` enters the agent entry path; `runCli(['version'])` etc unchanged; `--non-interactive` errors with clear message if intake needs questions. |
| `tests/unit/foundry-program.test.ts` | Asserts foundry handlers actually do what they claim (file IO, npm child_process, etc., using mocks for the side effects). |
| `tests/unit/foundry-skeleton.test.ts` | Asserts the new generic skeleton is FM3-safe (system_mode_entry only on bootstrap), FM5-complete (all engine-owned `inputs.query_*` paths declared), parses through `loadSpecWithPatterns`. |
| `tests/unit/synthesize-program-spec.test.ts` | Deterministic — feed fixture intake into the synthesizer, assert output matches expected spec. No LLM call. |
| `tests/integration/foundry-intake-flow.test.ts` | Drives the foundry program in-process via `@simodelne/pgas-server/testing.js`'s `createTestHarness` with a deterministic LLM stub. Asserts the Q1–Q6 interview runs, `record_program_intake` fires, `confirm_design` gates the transition. |
| `tests/integration/foundry-end-to-end.test.ts` | Full design session against a fresh out-dir: intake → architecture_design → scaffold_plan → branch_write → static_verify. Asserts a working program is emitted that itself typechecks and passes its born-with tests. |
| `tests/e2e/cli-design-session.test.sh` | Shell harness that runs `pgas-new` against a real (Qwen/local) provider, drives the REPL via stdin, asserts the rendered scaffold is real. |
| `tests/architectural-invariants.test.ts` (correction C from yesterday's governance patch — issue #36) | Locks the v3 invariants in code: foundry-program spec exists, declares the 10 modes; CLI has `design`/agent entry; consumer-preset enum is empty; architecture doc references each CLI command. |

## 7. Phased delivery

### Phase 0 — Preparation (already landed yesterday, no work)
- ✅ Graduation programs moved to `docs/graduation-evidence/`
- ✅ MANDATE.md per graduation
- ✅ `--template <consumer>` flags deprecated
- ✅ Governance corrections A+B+F (CLAUDE.md Program Nature, expanded required reading, MEMORY.md Strategic Invariants)
- ✅ Post-mortem committed
- ✅ Trace doc committed

### Phase 1 — Foundry-program relocation (no behavior change yet)
1. Move `templates/pgas-new/program/{specs,handlers,tools,registration}.{yml,ts}.tmpl` → `src/foundry-program/{specs.yml,handlers.ts,tools.ts,registration.ts}`. Drop tokens (bake `pgas-new` / `PgasNew` literals).
2. Update `src/pgas-new/template-renderer.ts` to load the foundry-self-program from `src/foundry-program/` when `--template pgas-new-foundry` is requested (still functional for backward compat — the deprecation handles future cleanup).
3. Create `templates/pgas-new/program/{spec-skeleton.yml.tmpl,handlers-skeleton.ts.tmpl,tools-skeleton.ts.tmpl,registration-skeleton.ts.tmpl}` as the new generic skeleton.
4. Tests: `tests/unit/foundry-skeleton.test.ts` (FM3, FM5, loads through engine) + adjust existing template-renderer tests.

**Commits (Codex, one per logical step):**
- `refactor(foundry): move foundry self-program from templates/ to src/foundry-program/`
- `feat(skeleton): add templates/pgas-new/program/spec-skeleton.yml.tmpl (canonical 3-mode FM3/FM5-safe skeleton)`
- `test: cover skeleton invariants + foundry-program relocation`

### Phase 2 — The agent (the conversation)
1. Add `@simodelne/pgas-server` to foundry's `package.json` dependencies. **The CLI now depends on the engine at runtime, for the first time.**
2. Create `src/repl/{runner,renderer}.ts` (refactor from template).
3. Create `src/foundry-server.ts` (spawn lifecycle).
4. Rewrite `src/cli.ts` entry switch: bare `pgas-new` → `runAgentSession`. Existing subcommands unchanged.
5. Add `record_program_intake`, `choose_design_path`, `confirm_design` actions to `src/foundry-program/specs.yml`. Add schema. Add projection includes. Add intake_intelligence guidance.
6. Implement those three handler stubs in `src/foundry-program/handlers.ts`.
7. Tests: `cli-interactive.test.ts`, `foundry-intake-flow.test.ts`.

**Acceptance:** running `pgas-new` against a real or stub LLM provider opens the REPL, the agent asks the choose-design-path question, the user answers, the conversation proceeds. At this phase the agent **can** walk through `intake_intelligence` but `architecture_design` onward is still mostly empty.

**Commits:**
- `feat(deps): foundry runtime now depends on @simodelne/pgas-server`
- `refactor(repl): factor streaming REPL into src/repl/ for foundry CLI reuse`
- `feat(server): src/foundry-server.ts — spawn embedded foundry-program server`
- `feat(cli): pgas-new (no args) opens streaming REPL on the foundry program`
- `feat(foundry-spec): record_program_intake + choose_design_path + confirm_design + Q1-Q6 guidance`
- `feat(foundry-handlers): implement the three intake-side actions`
- `test: cover CLI interactive entry + intake flow`

### Phase 3 — Synthesis + real handlers
1. Implement `synthesize_program_spec` in `src/foundry-program/handlers.ts`. Mechanical rename + copy-block against the skeleton. Validate against `loadSpecWithPatterns`. Write to state.
2. Wire `architecture_design` mode to call it (mode preconditions, transitions).
3. Wire `scaffold_plan` to read `architecture.synthesized_spec` and call `createStandaloneArtifactPlan` / `createExistingRepoArtifactPlan`.
4. Wire `branch_write` to call `renderStandaloneScaffold` / `renderExistingRepoAttachment` with the synthesized spec instead of a template.
5. Implement the remaining handlers in `src/foundry-program/handlers.ts`: real `npm_install` / `npm_typecheck` / `npm_test`, real `git_status` / `git_rebase_latest`, real `open_pull_request`, real `load_wiring_manifest`, real `create_curator_request`, real `run_api_blackbox_verification`, real `run_live_provider_verification`, real `web_research`.
6. Tests: `synthesize-program-spec.test.ts`, `foundry-program.test.ts`, `foundry-end-to-end.test.ts`.
7. Tests: regression corpus — feed each `docs/graduation-evidence/<name>/MANDATE.md` into the synthesizer, assert structural equivalence with the frozen graduation spec.

**Acceptance:** the agent can drive a full session end-to-end, emit a real working program, install + typecheck + test it. Verified by `foundry-end-to-end.test.ts`.

**Commits:**
- `feat(synthesis): synthesize_program_spec action — mechanical rename+copy from skeleton`
- `feat(handlers): real handlers for plan_artifacts, write_scaffold_artifacts, npm_*, git_*, open_pull_request, load_wiring_manifest, web_research, run_*_verification`
- `test: regression corpus against graduation MANDATE.md files`
- `test: end-to-end design session emits a working program`

### Phase 4 — Cleanup (breaking, v3.0.0 release)
1. Remove `--template policy-drafting|web-scraper|social-media-agent` from the CLI's `ProgramTemplate` enum.
2. Remove `STANDALONE_PROGRAM_OVERRIDE_BY_TEMPLATE` and the three `EXISTING_*_TEMPLATE_BY_KIND` maps from `template-renderer.ts`.
3. Un-wire the `.tmpl` files in `docs/graduation-evidence/<name>/` from the template-renderer (they stay on disk as evidence).
4. Update README, architecture doc, all docs.
5. Cut v3.0.0 release.

**Commits:**
- `feat(cli)!: remove deprecated --template <consumer> flags (v3.0 breaking)`
- `docs: update README + architecture for v3.0 surface`
- `release: pgas-new v3.0.0`

## 8. Acceptance criteria

Each phase ships only when ALL its phase-specific tests pass AND the global invariants hold. The global invariants:

- `npm test` clean at every phase (typecheck + 21 manifest + N unit tests, growing each phase + 8 static)
- No banned imports introduced in generated scaffolds
- Foundry program loads via `loadSpecWithPatterns` without error at every phase
- Each phase's commit list matches the plan; no out-of-scope commits

The **definition-of-done for v3.0 as a whole**:

A fresh user runs `pgas-new` against a working LLM provider. They have a 5-minute conversation. At the end of it, a directory on their disk contains a working PGAS consumer (server.ts + program/{specs,handlers,tools}.ts + tests + manifest + dossier + audit doc), the consumer has been installed (`npm install`), typechecked, and its born-with tests pass. The user can `cd` into the directory and `npm run repl` to talk to the program they just designed.

## 9. Codex E2E acceptance test (tmux-driven)

**This is the load-bearing acceptance gate that the prior 6 UAT rounds did not have.** Codex acts as the user, driving the CLI from a fresh tmux session via keystrokes. End-to-end. No mocks. Against the real Qwen vLLM at `100.100.74.6:8000`.

### 9.1 Setup (Codex performs)

```bash
# Codex opens a fresh tmux session named pgas-new-e2e-rebuild
tmux new-session -d -s "pgas-new-e2e-rebuild" -n "user"

# In the user window, Codex enters the foundry repo
tmux send-keys -t "pgas-new-e2e-rebuild:user" \
  "cd /home/simone/pgas-new && git status" Enter

# Codex confirms HEAD is on the rebuild branch with Phase 3 landed
```

### 9.2 Scenario (Codex drives, acting as a brand-new user)

**Scenario A: design a fresh program from scratch (interview path)**

```bash
# Codex types the CLI command — like a user would
tmux send-keys -t "pgas-new-e2e-rebuild:user" \
  "PGAS_OPENAI_BASE_URL=http://100.100.74.6:8000/v1 PGAS_OPENAI_API_KEY=none PGAS_OPENAI_MODEL=qwen36-27b pgas-new --out /tmp/pgas-new-e2e-rebuild-output" Enter

# Wait for the agent to greet
# Codex looks for the "choose design path" prompt in the REPL output
# Codex sends `design` (chooses the interview path)
tmux send-keys -t "pgas-new-e2e-rebuild:user" "design" Enter

# Agent asks Q1 — Purpose
tmux send-keys -t "pgas-new-e2e-rebuild:user" \
  "An agent that helps SimoneOS engineers triage incoming support tickets, classifying them by severity and routing to the right team." Enter

# Agent asks Q2 — Entry channel
tmux send-keys -t "pgas-new-e2e-rebuild:user" "user_text" Enter

# Agent asks Q3 — Stages
tmux send-keys -t "pgas-new-e2e-rebuild:user" \
  "triage, classification, routing, complete" Enter

# Agent asks Q4 — Decision points
tmux send-keys -t "pgas-new-e2e-rebuild:user" \
  "classification can loop back to triage if uncertain; routing can bail out to a human-review queue" Enter

# Agent asks Q5 — Delegation
tmux send-keys -t "pgas-new-e2e-rebuild:user" "none" Enter

# Agent asks Q6 — Completion
tmux send-keys -t "pgas-new-e2e-rebuild:user" \
  "When the ticket has been routed to a team OR sent to human-review queue" Enter

# Agent echoes back the proposed mode list + transitions for confirmation
tmux send-keys -t "pgas-new-e2e-rebuild:user" "approve" Enter

# Agent proceeds: architecture_design → scaffold_plan → branch_write → static_verify
# Codex watches for "Plan approved? [y/n]" — approves
tmux send-keys -t "pgas-new-e2e-rebuild:user" "y" Enter

# Agent runs npm install, typecheck, test inside the output dir
# Codex waits for completion (with reasonable timeout)
```

**Scenario B: design a fresh program with the default 3-mode skeleton (no interview)**

```bash
# Second invocation, default path
tmux send-keys -t "pgas-new-e2e-rebuild:user" \
  "pgas-new --slug minimal-test --out /tmp/pgas-new-e2e-default-output" Enter

# Agent asks choose-design-path — Codex picks default
tmux send-keys -t "pgas-new-e2e-rebuild:user" "default" Enter

# Agent confirms the skeleton (just program name/slug, nothing else)
tmux send-keys -t "pgas-new-e2e-rebuild:user" "approve" Enter

# Agent emits the 3-mode skeleton, runs static verify
```

**Scenario C: attach a new program to an existing pgas-consumer repo**

```bash
# Codex creates a throwaway repo with a valid .pgas/wiring.yml
mkdir -p /tmp/fake-consumer/.pgas
cat > /tmp/fake-consumer/.pgas/wiring.yml << 'EOF'
schema_version: 1
repo: { kind: existing_repo, package_manager: npm }
pgas:
  server_package: '@simodelne/pgas-server'
  allowed_imports: [...]
paths: { programs_dir: programs, audit_dir: audit, pgas_new_dir: .pgas/pgas-new }
registration: { strategy: curator_request }
verification:
  commands: { install: 'npm install --no-audit --no-fund', typecheck: 'npm run typecheck', test: 'npm test' }
curator: { github_owner: simodelne, github_repo: fake-consumer }
EOF

# Codex runs the foundry against the fake consumer
tmux send-keys -t "pgas-new-e2e-rebuild:user" \
  "pgas-new --out /tmp/fake-consumer" Enter

# Codex picks default skeleton, names the program "audit-trail"
tmux send-keys -t "pgas-new-e2e-rebuild:user" "default" Enter
tmux send-keys -t "pgas-new-e2e-rebuild:user" "audit-trail" Enter
tmux send-keys -t "pgas-new-e2e-rebuild:user" "approve" Enter

# Agent emits the program into /tmp/fake-consumer/programs/audit-trail/
# Agent files a curator-request artifact (registration.strategy=curator_request)
```

### 9.3 Verification (Codex performs after each scenario)

For each scenario:

1. `ls -la <output-dir>` — assert files match the blueprint.
2. `cd <output-dir> && npm run typecheck` — assert exit code 0.
3. `cd <output-dir> && npm test` — assert all 5 born-with tests pass.
4. Open the rendered `src/programs/<slug>/specs.yml` and assert:
   - Modes are the user's stage names (Scenario A) or `start/working/complete` (Scenario B and C default path).
   - `system_mode_entry` channel declared only on bootstrap mode (FM3).
   - Engine-owned `inputs.query_*` schema paths declared (FM5).
   - Handlers ship a resolver (FM1).
   - registration.ts ships the createAdapters override (FM4).
5. Capture the full tmux session transcript to `.uat/e2e-rebuild-transcript-<scenario>.log`.

### 9.4 Reporting

Codex writes `.uat/codex-e2e-rebuild-report.md`:

```markdown
# v3.0 E2E Rebuild Report

## Test environment
- Date: <ISO>
- Repo HEAD: <SHA>
- LLM provider: Qwen3.6-27B via vLLM at http://100.100.74.6:8000

## Scenario A: interview path (incident triage)
- Result: PASS | FAIL
- Tmux transcript: .uat/e2e-rebuild-transcript-scenario-a.log
- Output dir: /tmp/pgas-new-e2e-rebuild-output
- Modes synthesized: <list>
- Transitions synthesized: <list>
- npm typecheck: PASS | FAIL
- npm test: <N> tests passed
- FM closures: FM1 [PASS/FAIL], FM2 [...], FM3 [...], FM4 [...], FM5 [...]

## Scenario B: default skeleton (minimal-test)
- Result: ...

## Scenario C: attach to existing consumer (audit-trail in fake-consumer)
- Result: ...

## What works
- ...

## What does not work
- ...

## Recommendation
- READY TO MERGE | NEEDS FIXES | DO NOT MERGE
```

## 10. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Real LLM behaves unpredictably during E2E (asks unexpected questions, gets stuck in loops) | High | Deterministic LLM stub for unit/integration tests; E2E lives separately with retry budget; E2E only blocks the Phase 4 release, not earlier phases |
| Synthesizer produces a spec that fails `loadSpecWithPatterns` | Medium | Validate inside the handler before write; have the agent's `confirm_design` step happen BEFORE synthesis so the user can revise; comprehensive unit tests on synthesizer with fixture inputs |
| Foundry-program-as-PGAS embedded-server lifecycle is fragile (port conflicts, slow start, child crash) | Medium | Health-poll with timeout; suppress child output to log file; surface tail of log on crash; user can override port via env |
| Child-process operations (npm, git, gh) fail with unhelpful errors | Medium | All child_process spawn wraps with timeout + clear error formatting; foundry's static_verify mode captures and surfaces errors in the REPL |
| User on a different LLM provider hits a model that can't follow the foundry's spec (e.g., a small model fails Q1-Q6 structure) | Medium | Document tested models in README; the `confirm_design` step lets the user override the agent's interpretation manually |
| Tests slow CI down significantly | Low | Phase 3's regression corpus uses deterministic LLM stub; only Phase 4's E2E test hits a real LLM and runs in a separate optional CI job |
| User runs `pgas-new` without LLM provider env set | Medium | CLI detects missing provider env and prints a friendly error with the env var list; do not proceed |

## 11. Migration / rollout

| Version | Surface | Breaking? |
|---|---|---|
| v2.7.0 | Phase 1 lands (foundry-program relocation, skeleton creation, foundry-program loaded by `--template pgas-new-foundry`) | No |
| v2.8.0 | Phase 2 lands (agent + intake + REPL). Deprecated `--template <consumer>` still works. | No |
| v2.9.0 | Phase 3 lands (synthesis + real handlers + regression corpus). Deprecated flags still work. | No |
| v3.0.0 | Phase 4 lands (remove deprecated flags). | Yes |

Each minor release runs npm test + the Codex E2E test before tagging. The E2E test is the definition of done.

## 12. Implementation handoff to Codex

Codex receives:
- This plan
- The trace doc (`docs/superpowers/specs/2026-06-22-v3-trace-from-v1-original.md`) [pending commit]
- The post-mortem (`docs/POST-MORTEM-2026-06-22-design-phase-drift.md`)
- The v1 source docs (recoverable from git history at `3d832b5^`)
- The current architecture doc (`docs/PGAS-NEW-ARCHITECTURE.md`)
- CLAUDE.md + MEMORY.md (governance, Program Nature, Strategic Invariants)
- The branch: `feat/v3.0-rebuild`

Codex's mandate:

1. Read the v1 source docs first, the architecture doc second, the trace doc third, the post-mortem fourth, this plan fifth, CLAUDE.md and MEMORY.md sixth. **Before writing any code.**
2. Implement Phase 1, run tests, commit per the per-phase commit list. Open a checkpoint comment in the report file at end of each phase.
3. Implement Phase 2, run tests, commit, checkpoint.
4. Implement Phase 3, run tests, commit, checkpoint.
5. Run the Codex E2E test (§9), all three scenarios.
6. Write `.uat/codex-e2e-rebuild-report.md`.
7. Stop. Do not push. Do not open a PR. The human reviews the branch.

If Phase 4 (the breaking removals) is to land in the same Codex run: explicit second mandate authorization required before Codex starts it. Default is "stop after Phase 3 + E2E."

## 13. What this plan does NOT do

- Does not bring back v1's marker-injection mechanism (the v2 `.pgas/wiring.yml` manifest contract replaces it; documented design decision)
- Does not re-introduce per-domain consumer template presets
- Does not change the engine boundary (still `@simodelne/pgas-server` public imports only)
- Does not add a GUI
- Does not target non-TypeScript languages
- Does not bundle the foundry program in the npm package (lives in source at `src/foundry-program/`; rendered to `~/.pgas-new/foundry-v<version>/` on first use)
- Does not implement v1's `pgas-program-builder` skill (the design interview from v1's `commands/pgas-new-program.md` is the interview; the skill was a layer on top that v3 doesn't need)
