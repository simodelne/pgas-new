# PGAS-New Architecture

Status: v3.1 release candidate on `v3.1-auth-v2`; current release target v3.1.0.

## Changelog

### v3.1.0

- Added DB-backed foundry session persistence through `createPgasServer({ storage: { dbPath } })`.
- Added engine-backed auth bootstrap through `auth.initialAdmin`, plus CLI `init`, `login`, and `logout`.
- Retired the local tool-choice proxy. The CLI now defaults `PGAS_OPENAI_TOOL_CHOICE=required`, while preserving explicit env overrides.
- Confirmed the engine's zero-internals stance: `SqliteStore` and `JwtAuthProvider` remain private, so pgas-new uses only public server config and HTTP auth routes.

### v3.0.0

- Converged the foundry back onto the original PGAS-new design after 16 phases of focused fixes.
- Removed the deprecated per-domain `--template policy-drafting`, `--template web-scraper`, and `--template social-media-agent` scaffold paths. The graduation programs remain only as read-only evidence under `docs/graduation-evidence/`.
- Proven by the section 10 ALL PASS gate against live Qwen at commit `8699131`.

## What pgas-new IS

`pgas-new` is a PGAS-specific foundry for producing new PGAS programs. It is not a general coding assistant. Its responsibility is to govern the creation of a PGAS program: collect the mandate, research when allowed, design the PGAS architecture, plan artifacts, write only planned artifacts, verify deterministically, run a user-selected live provider graduation, rebase on the current target repo, and open a PR.

In v3.0 the foundry itself is a PGAS program. The bare `pgas-new` command starts the foundry REPL, whose modes, actions, control plane, notebook state, and projections are declared in `src/foundry-program/`. Per-domain programs are synthesized by completing the foundry design interview and approving the governed artifact plan, not by choosing a preset template flag.

The only remaining `--template` value is `pgas-new-foundry`, retained for the legacy foundry bootstrap render path. Consumer template values are removed in v3.0; callers that pass them receive an error pointing to the bare REPL.

## PGAS Contract

Generated consumers target `@simodelne/pgas-server@2.14.1` and use only these public imports:

- `@simodelne/pgas-server/plugin.js`
- `@simodelne/pgas-server/create-server.js`
- `@simodelne/pgas-server/client.js`
- `@simodelne/pgas-server/channels/index.js`
- `@simodelne/pgas-server/routes/index.js`
- `@simodelne/pgas-server/testing.js` in tests

Generated code must not import v1 or private surfaces such as `@simodelne/pgas-server/api`, `@simodelne/pgas-runtime`, `@simodelne/pgas-runtime-core`, `@simodelne/pgas-contracts`, `@simodelne/pgas-middleware`, `@simodelne/pgas-drivers`, or `@simodelne/pgas-server/src/*`.

## Governed State

The state dictionary is the source of truth. Conversation history is not state.

- `session`: active session id, running status, current mode.
- `intake`: mandate, research confirmation, user-requested research flag.
- `notebook`: durable working-memory entries and pins.
- `research`: research queries and completion state.
- `repo`: target kind, `.pgas/wiring.yml` status, missing facilities.
- `program`: slug, name, TypeScript/Node runtime.
- `artifact_plan`: planned artifacts and approval status.
- `artifacts`: written flag and generated paths.
- `graduation`: static, live, and rebase verification status.
- `curator_requests`: requests to the repo curator.

## 10-Mode Workflow

| Mode | Purpose | Main Legal Actions | Exit Gate |
| --- | --- | --- | --- |
| `intake_intelligence` | Capture target identity, Q1-Q6 design intake, notebook notes, and confirmed research scope. | `record_program_target`, `choose_design_path`, `apply_default_skeleton`, `ask_design_question`, `record_q1_purpose`, `record_q2_entry_channel`, `record_q3_stages`, `record_q4_transitions`, `record_q5_delegation`, `record_q6_completion`, `record_program_intake_finalize`, `confirm_design`, `web_research`, session controls | Design intake finalized and approved through `user_confirmation`. |
| `repo_targeting` | Choose standalone or existing repo and load wiring manifest. | `select_repo_target`, `authorize_standalone_target`, `load_wiring_manifest`, `authorize_existing_repo_target`, `create_curator_request` | Target authorized, or route to curator. |
| `architecture_design` | Synthesize the PGAS program spec from approved intake and service attachment points. | `synthesize_program_spec`, `design_architecture`, `web_research`, `record_user_note` | Deterministic synthesized spec is available in in-process transit. |
| `scaffold_plan` | Produce first-class artifact plan from the synthesized spec before writes. | `plan_artifacts`, `approve_artifact_plan`, `create_curator_request` | Artifact plan approved through `user_confirmation`. |
| `branch_write` | Write only planned artifacts. | `write_scaffold_artifacts`, `git_status` | Artifacts written. |
| `static_verify` | Install/typecheck/test deterministically and confirm live graduation intent. | `npm_install`, `npm_typecheck`, `npm_test`, `run_static_verification`, `run_parallel_static_checks` (opt-in), `confirm_live_provider_intent` | Static verification passed and live-provider intent confirmed. |
| `live_verify` | Verify through the external API with a real provider. | `run_api_blackbox_verification`, `run_live_provider_verification` | Live verification passed. |
| `rebase_verify` | Rebase on latest target repo state and rerun static verification. | `git_status`, `git_rebase_latest`, `run_rebase_static_verification` | Post-rebase verification passed. |
| `pr_graduation` | Open the PR. | `open_pull_request` | Terminal graduation mode. |
| `curator_request` | Produce a repo-curator request when wiring is absent or invalid. | `create_curator_request`, `record_user_note` | Curator request lodged, then return to targeting. |

Every mode includes session controls: `session_new`, `session_abort_current`, `session_status`, `session_history`, `session_resume`, and `session_help`. `session_abort_current` requires an active running session.

## Opt-in Parallel Effects (Composite-Effect Adapter)

`static_verify` exposes one **opt-in** packed action, `run_parallel_static_checks`, in addition to the default single-call verification actions. It lets a single PGAS `EffectAction` wrap multiple independent checks that run **concurrently** and aggregate into one combined result, without weakening the Alloy core's exactly-one-`EffectAction`-per-round invariant (I-1 Terminal Singularity):

- The action emits to the synchronous `composite_checks_output` channel; its handler delegates to `createCompositeEffectAdapter` (public `@simodelne/pgas-server/plugin.js` barrel — no engine internals). Children run via `Promise.all`.
- The children aggregate into one `CompositeEffectEnvelope` (`{ status, children: [{ status, output, error }] }`) written to the action's `result_path` (`graduation.composite_checks`). One action → one Value → one synchronous result path, so ER coupling (ER-1/2/3) holds. The world view reads the envelope from the `static_verify` projection; engine-owned state is never re-derived.
- Multiplicity rides on the action payload (`imports[]`, `modes[]`, `evidence{}`) — the author "packs" the checks into the single action's args, not via native multi-tool-calls. The formal core is untouched.
- **Opt-in and never forced.** The single-call `npm_typecheck` / `npm_test` / `run_static_verification` actions remain the default; the author decides per case whether to pack. Partial failure of any child surfaces as envelope `status: "partial"` with per-child `error`, handled consumer-side rather than thrown.

## Existing Repo Attachment

Existing-repo attachment is bound to `.pgas/wiring.yml`. Without that fixed-path manifest, `pgas-new` refuses writes and produces a curator request. A valid manifest declares package manager, PGAS package/imports, artifact directories, registration strategy, verification commands, curator GitHub owner/repo, and optionally repo-published integrations.

The optional manifest `integrations` block declares real adapter boundaries by logical name: `name`, `kind` (`http_api`, `db`, `sdk`, or `module`), module `import`, optional `factory`, available `methods`, and `config_env` env var names. It never contains secret values. During domain synthesis, existing-repo external-adapter stages that match a declared integration generate a real adapter importing only that declared module and calling the declared method, with `adapter_kind:"repo_integration"` in audit. Standalone programs and unmatched existing-repo adapters remain explicit in-memory mocks with an audit gap.

If a repo has no manifest, the correct output is a request for the repo curator to publish one. If a manifest exists but required facilities are missing, `pgas-new` stays in planning/request mode until the curator supplies or changes the repo wiring. `render-attach` writes only the foundry program artifacts, refuses missing/invalid manifests, and refuses to overwrite create-mode planned files. Explicit update-mode registration artifacts are narrow merge points; today `qc/e2e-coverage.yml` is YAML-merged to register the attached program's facts and e2e-frontend scenario without replacing unrelated matrix entries. Registration integration remains a curator-owned patch point. Per-domain existing-repo attachments are generated by the foundry REPL after the design interview, not by `--template <domain>`.

## Artifact Ownership

Code artifacts are primary objects, not incidental side effects. The artifact plan records each artifact's path, kind, purpose, owner, introducing mode, and verification gate. Standalone scaffolds include server, REPL, program spec, registration, handlers, tools, tests, wiring manifest, dossier, artifact manifest, and graduation audit. Existing-repo plans use the repo manifest paths and request registration patch points instead of editing arbitrary files.

Generated programs intentionally stub frontend, auth, database, and persistence. Standalone programs still mock external services. Existing-repo programs bind external-adapter stages to real integrations only when those integrations are declared in `.pgas/wiring.yml`; otherwise they record an explicit mock gap for the curator. The foundry's own v3.1 runtime is DB-backed and authenticated.

## v3.1: Auth + DB Persistence

The foundry server persists sessions by resolving a SQLite path and passing it through the engine's public server config:

```ts
createPgasServer({
  storage: { dbPath },
  auth: {
    jwtSecret,
    issuer,
    expiresIn,
    ...(initialAdmin ? { initialAdmin } : {}),
  },
  programs: [{ name: 'pgas-new', entry }],
});
```

`dbPath` resolves from `PGAS_DB`, or defaults to `$HOME/.local/share/pgas-new/pgas-new.db`. The parent directory is created before server startup. JWT config resolves from `PGAS_JWT_SECRET` or `$HOME/.local/share/pgas-new/jwt.secret`, `PGAS_JWT_ISSUER` or `pgas-new`, and `PGAS_JWT_EXPIRES_IN` or `7d`.

`pgas-new init` creates the data directory, writes `jwt.secret`, and stages `initial-admin.json`. On the next successful server startup, pgas-new passes the staged credentials as `auth.initialAdmin`; the engine seeds the first admin only when the user table is empty, and pgas-new deletes the staged file after startup. Subsequent users and logins use the engine's public HTTP auth routes. `pgas-new login` caches the returned JWT at `$HOME/.local/share/pgas-new/token`; the REPL refuses to start without a non-expired cached token and passes that token to `createPgasClient` as bearer auth.

The engine still does not export `SqliteStore` or `JwtAuthProvider` classes. That is intentional per the engine team's zero-internals design, and pgas-new does not import those classes. Storage and auth are configured only through `createPgasServer`; authentication after bootstrap flows through HTTP routes.

The v3.0 local tool-choice proxy has been removed. Engine v2.14.1 supports tool-choice resolution directly, so the CLI sets `PGAS_OPENAI_TOOL_CHOICE=required` by default before engine imports. Explicit env values still win.

## Author driver selection

The foundry's `serverConfig.drivers` is wired by `src/foundry-server.ts` based on env vars:

| Env | Driver |
|---|---|
| `PGAS_AUTHOR_DRIVER=codex-cli` OR `PGAS_PROVIDER=codex-cli` | Codex CLI unified author (`createCodexCliUnifiedComplete` from `@simodelne/pgas-server/plugin.js`). Routes prompts through the local `codex exec` ChatGPT-subscription CLI. Foundry auto-sets `PGAS_ENABLE_CODEX_DRIVER=1` (the engine's opt-in guard) when the selector fires, so users only need one env var to express the intent. Verify with `codex login status`. |
| `PGAS_PROVIDER=openai` OR `PGAS_OPENAI_API_KEY`/`OPENAI_API_KEY` set | OpenAI-compatible unified author (the v3.1 default — Qwen vLLM, OpenAI HTTP, etc.). |
| Neither set (and no `GOOGLE_API_KEY`) | `serverConfig.drivers` is left unset; engine falls back to its default deterministic-only behavior. |

Codex-cli wins over OpenAI when both env vars are set; this lets users keep `PGAS_OPENAI_API_KEY` configured for other tooling while explicitly opting into codex-cli for the foundry.

## Control Plane And CLI

The generated program declares a PGAS `control_plane` with free text routed through `ask` and session lifecycle controls: `ask`, `abort`, `new`, `history`, `status`, `resume`, and `help`.

The CLI is a bootstrap/control surface. With no subcommand, `pgas-new` starts the foundry REPL. The legacy render commands remain for the foundry bootstrap path only and accept no per-domain template flags.

- `pgas-new init`
- `pgas-new login`
- `pgas-new logout`
- `pgas-new session new`
- `pgas-new session abort`
- `pgas-new session status`
- `pgas-new session history`
- `pgas-new session resume`
- `pgas-new session help`

The `init`, `login`, and `logout` commands manage foundry auth bootstrap and the cached JWT. Session commands emit the semantic control id and are aligned with the generated control-plane vocabulary. The REPL scaffold uses `controlCliAdapter` from `@simodelne/pgas-server/channels/index.js` so the interactive UI remains a projection of the PGAS control catalog rather than an independent parser.

## Research And User Decisions

Research is part of intake intelligence, not just mandate capture. `web_research` is legal only when the user explicitly requested that research or confirmed research. Research outputs should be written into governed state and notebook notes so later modes do not depend on chat history.

User confirmations, optional choices, and destructive actions should be represented as PGAS controls or request-user-action style actions in the generated program, not as untracked CLI prompts.

## Notebook And ActivationAction

`pgas-new` uses notebook-backed working memory through `enableNotebook`. Notebook entries are governed state and appear in the model projection. The notebook is the right mechanism for user ideas, mandate refinements, research summaries, artifact decisions, and graduation evidence that must survive conversation compaction.

`ActivationAction` is different. In current PGAS architecture it is a side-band advisory primitive: it materializes declared static advisory content for the next turn and is guard-invisible. It should not be used as the primary memory mechanism for `pgas-new`. Use it only for static advisory procedures or skills that are declared in the spec. Use notebook state for accumulated user inputs and project knowledge.

## Verification

The static ladder is:

1. `npmInstall`
2. `npmTypecheck`
3. `npmTest`
4. `runGeneratedStaticTests`

Post-rebase verification reruns the static ladder after `gitStatus` and `gitRebaseLatest`. Live-provider evidence is separate from command-runner evidence and is recorded as `liveProviderRoundTrip`.

The v3.1 release candidate must keep the v3.0 section 10 behavior gate green while adding authenticated transport and persistent sessions. Release branches must re-run the full static ladder after rebase and rerun section 10 against the authenticated REPL flow.
