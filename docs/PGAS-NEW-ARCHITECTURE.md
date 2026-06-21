# PGAS-New Architecture

Status: shipped; current release v2.2.0 on main.

`pgas-new` is a PGAS-specific foundry for producing new PGAS programs. It is not a general coding assistant. Its responsibility is to govern the creation of a PGAS program: collect the mandate, research when allowed, design the PGAS architecture, plan artifacts, write only planned artifacts, verify deterministically, run a user-selected live provider graduation, rebase on the current target repo, and open a PR.

## PGAS Contract

Generated consumers target `@simodelne/pgas-server@2.10.0` and use only these public imports:

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

## Modes And Gates

| Mode | Purpose | Main Legal Actions | Exit Gate |
| --- | --- | --- | --- |
| `intake_intelligence` | Capture mandate, notebook notes, and confirmed research scope. | `record_user_note`, `confirm_research_scope`, `record_user_requested_research`, `web_research`, session controls | Mandate exists. |
| `repo_targeting` | Choose standalone or existing repo and load wiring manifest. | `select_repo_target`, `authorize_standalone_target`, `load_wiring_manifest`, `authorize_existing_repo_target`, `create_curator_request` | Target authorized, or route to curator. |
| `architecture_design` | Design the PGAS program and service attachment points. | `design_architecture`, `web_research`, `record_user_note` | Architecture marked ready. |
| `scaffold_plan` | Produce first-class artifact plan before writes. | `plan_artifacts`, `approve_artifact_plan`, `create_curator_request` | Artifact plan approved. |
| `branch_write` | Write only planned artifacts. | `write_scaffold_artifacts`, `git_status` | Artifacts written. |
| `static_verify` | Install/typecheck/test deterministically and confirm live graduation intent. | `npm_install`, `npm_typecheck`, `npm_test`, `run_static_verification`, `confirm_live_provider_intent` | Static verification passed and live-provider intent confirmed. |
| `live_verify` | Verify through the external API with a real provider. | `run_api_blackbox_verification`, `run_live_provider_verification` | Live verification passed. |
| `rebase_verify` | Rebase on latest target repo state and rerun static verification. | `git_status`, `git_rebase_latest`, `run_rebase_static_verification` | Post-rebase verification passed. |
| `pr_graduation` | Open the PR. | `open_pull_request` | Terminal graduation mode. |
| `curator_request` | Produce a repo-curator request when wiring is absent or invalid. | `create_curator_request`, `record_user_note` | Curator request lodged, then return to targeting. |

Every mode includes session controls: `session_new`, `session_abort_current`, `session_status`, `session_history`, `session_resume`, and `session_help`. `session_abort_current` requires an active running session.

## Existing Repo Attachment

Existing-repo attachment is bound to `.pgas/wiring.yml`. Without that fixed-path manifest, `pgas-new` refuses writes and produces a curator request. A valid manifest declares package manager, PGAS package/imports, artifact directories, registration strategy, verification commands, and curator GitHub owner/repo.

If a repo has no manifest, the correct output is a request for the repo curator to publish one. If a manifest exists but required facilities are missing, `pgas-new` stays in planning/request mode until the curator supplies or changes the repo wiring. `render-attach` writes only the planned per-program artifacts, refuses missing/invalid manifests, and refuses to overwrite existing planned files; registration integration remains a curator-owned patch point.

## Artifact Ownership

Code artifacts are primary objects, not incidental side effects. The artifact plan records each artifact's path, kind, purpose, owner, introducing mode, and verification gate. Standalone scaffolds include server, REPL, program spec, registration, handlers, tools, tests, wiring manifest, dossier, artifact manifest, and graduation audit. Existing-repo plans use the repo manifest paths and request registration patch points instead of editing arbitrary files.

`pgas-new` intentionally stubs frontend, auth, database, persistence, and external services. Those are attachment points for the target repo or for a general coding agent after graduation.

## Control Plane And CLI

The generated program declares a PGAS `control_plane` with free text routed through `ask` and session lifecycle controls: `ask`, `abort`, `new`, `history`, `status`, `resume`, and `help`.

The CLI is a bootstrap/control surface:

- `pgas-new session new`
- `pgas-new session abort`
- `pgas-new session status`
- `pgas-new session history`
- `pgas-new session resume`
- `pgas-new session help`

These commands emit the semantic control id and are aligned with the generated control-plane vocabulary. The REPL scaffold uses `controlCliAdapter` from `@simodelne/pgas-server/channels/index.js` so the interactive UI remains a projection of the PGAS control catalog rather than an independent parser.

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

Static and live graduation are complete through v2.2.0. Future branches must re-run the full static ladder after rebase.
