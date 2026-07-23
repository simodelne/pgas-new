# Due Diligence Report Program — Build via pgas-new

## Launch Addendum — 2026-07-23

You are a Codex CLI worker launched from the `pgas-new` tmux session. Your job is to use the live `pgas-new` foundry capabilities and the Codex PGAS driver path where appropriate to create a new SimoneOS PGAS program, not to hand-write an ungoverned one-shot scaffold. Treat `pgas-new` as the foundry/orchestration surface and `/home/simone/simoneos` as the target existing repo.

This is an ambitious build. Do not collapse it into a thin CRUD/report stub. The design must explicitly solve scale and context projection for hundreds/thousands of electronic data room documents. You may use research for industry best practices because Simone explicitly requested it. Do not merge to `main`, deploy, tag, release, force-push, use `--no-verify`, print secrets, or bypass a classifier/human approval gate. Open/prepare a PR only after real verification is green; if blocked or RED, report exact failing output.

**Target:** Build a new simoneos PGAS program called `due-diligence-report`
**Repo:** `/home/simone/simoneos/`
**Foundry:** `/home/simone/pgas-new/`
**Authoritative docs:**
- simoneos AGENTS.md (`/home/simone/simoneos/AGENTS.md`)
- simoneos qc/AGENT_CONTRACT.md
- pgas-new CLAUDE.md (`/home/simone/pgas-new/CLAUDE.md`)
- pgas-new architecture (`/home/simone/pgas-new/docs/PGAS-NEW-ARCHITECTURE.md`)
- PGAS skill: engine architecture, wire API, consumer contract
- Existing `document-due-diligence` program: `/home/simone/simoneos/programs/simoneos/document-due-diligence/`
- Existing `dd-service.compose.yml` pattern: `/home/simone/simoneos/patterns/services/dd-service.compose.yml`

**Engine pin:** `@simodelne/pgas-server@3.21.0` (same as pgas-new)

---

## Non-Negotiables

1. **Read simoneos AGENTS.md first.** Six QC gates, five core rules, archetype pattern. Do not violate these.
2. **Read pgas-new CLAUDE.md.** Governance rules, foundry nature, invariants.
3. **Read pgas-new architecture doc.** 12-mode workflow, PGAS contract, governed state, artifact ownership.
4. **Read PGAS-NEW-ARCHITECTURE.md.** Engine boundary, published imports only, sync-out pattern.
5. **Run `npm run qc:onboard` before any changes.** If a gate fails, fix it first.
6. **One archetype per program × channel.** No new live-e2e test files.
7. **Shared structural primitives in patterns/*/*.compose.yml.** Never hand-write what a pattern emits.
8. **Spec-graph drift is audited.** Mode/transition/vocabulary changes require `tsx qc/drift-check.ts --update` + `tsx qc/integrity.ts --rotate --reason "..."`.
9. **Generated programs use only public imports:** `create-server.js`, `plugin.js`, `client.js`, `channels/index.js`, `routes/index.js`.
10. **Never use `--sandbox danger-full-access` on Codex dispatches.** Classifier blocks it correctly.

---

## Goal

Build a **professional-grade legal due diligence report generation program** for simoneos. The program must produce Clifford Chance-level red flag due diligence reports assembled into DOCX documents. It operates at scale — handling hundreds or thousands of documents from an electronic data room.

This is NOT a replacement for `document-due-diligence`. That program does per-document DD analysis. The new `due-diligence-report` program orchestrates the full pipeline:

1. **Electronic data room connector** — connect to an eRoom, download all documents, build an artifact registry with metadata (category, name, date, link to file, review status, etc.)
2. **Parallel DD dispatch** — dispatch each document to the existing `document-due-diligence` program (via `dd-service` pattern) for per-document analysis. Dispatch in parallel batches.
3. **DD output aggregation** — collect outputs from all DD agents into structured store
4. **Section-by-section report drafting** — draft the DD report section by section, with user approval gates between sections
5. **Red flag population** — use DD agent outputs to populate red flag sections of the report
6. **Charts of SD append** — append charts of significant findings to the report
7. **DOCX assembly** — assemble the final report as a professional DOCX document

**Context projection is critical.** Each agent/session receives ONLY the context it needs for its task. Never dump everything. Projections must be carefully scoped per mode and per delegated session.

---

## PHASE 1 — Research and Architecture Design

### 1.1 Industry Research (subagent)

Research how top-tier law firms structure legal due diligence reports. Focus on:
- Clifford Chance, Linklaters, Freshfields DD report structures
- Standard sections: Executive Summary, Corporate Structure, Financial, Contracts, IP, Employment, Regulatory, Litigation, Tax, Environmental, Data/Privacy, Charts of Findings, Red Flags
- Industry best practices for document organization, risk rating, and flag categorization
- Electronic data room platforms: Firmex, NetDocuments, Intralinks, Datasite — API patterns for document listing/downloading/metadata

Output: `docs/dd-report-industry-research.md` with structured findings.

### 1.2 Study Existing Infrastructure

Thoroughly study:
- `document-due-diligence` program spec (`specs.yml`) — understand modes, vocabulary, channels, projection strategy
- `dd-service.compose.yml` — understand how DD delegation works
- `document-ingest` program — understand document parsing/extraction
- simoneos `libraries/docx/` — understand DOCX generation capabilities (memo-generator pattern)
- simoneos patterns — identify reusable compose patterns

Output: `docs/dd-report-infrastructure-study.md`

### 1.3 Architecture Design

Design the `due-diligence-report` program architecture:

**Core design decisions:**
- **Multi-mode workflow:** `intake` → `eroom_connect` → `eroom_ingest` → `dispatch_queue` → `dd_batch` → `aggregate` → `draft_sections` → `user_approval` → `assemble_report` → `complete`
- **Per-mode projections:** Each mode sees ONLY what it needs. This is non-negotiable for scaling to thousands of documents.
- **DD delegation pattern:** Reuse `dd-service` compose pattern for per-document DD, but with batch queuing
- **eRoom connector:** Abstract interface for electronic data room API (start with a configurable HTTP connector)
- **Report drafting:** Section-by-section with user approval gates — draft one section, wait for user sign-off, draft next
- **DOCX assembly:** Use simoneos `libraries/docx/memo-generator` pattern, extended for DD reports

**Domain model:**
```
inputs.eroom_config        # eRoom connection settings
inputs.eroom_documents     # Document registry: [{id, name, category, date, path, reviewed, dd_session_id, status}]
inputs.dd_contract         # DD mandate: purpose, materiality, risk_taxonomy, scope
inputs.dd_reports          # Aggregated DD outputs keyed by document id
inputs.current_section     # Section being drafted
inputs.approval_state      # User approval status per section

work.section_drafts        # Drafted sections: [{section_id, content, approved}]
work.red_flags             # Aggregated red flags: [{id, document, severity, category, description}]
work.charts_of_sd          # Charts of significant findings
work.report_structure      # Report outline with section metadata
work.docx_output           # Final DOCX path
```

Output: `docs/dd-report-architecture-design.md` with:
- Full mode graph with transitions and guards
- Domain schema with GKType types
- Per-mode projection specifications
- DD delegation strategy (batching, parallel dispatch, result collection)
- eRoom connector interface
- Report drafting workflow with approval gates
- DOCX assembly pipeline

---

## PHASE 2 — Compose Pattern and Spec

### 2.1 Compose Pattern

Create `patterns/services/dd-report-service.compose.yml` if the program needs a service pattern for external delegation. Study existing patterns (`dd-service`, `research-service`, `review-service`) for conventions.

### 2.2 Program Spec (specs.yml)

Write the full PGAS spec at:
`programs/simoneos/due-diligence-report/specs.yml`

**Must include:**
- `name`, `preamble` (system prompt), `termination`, `topology`, `pure`
- `features` (base, delegation, integrations, reactions, runtime_control, tool_registry)
- Pattern composition (reuse two-step-phase-gate, control-plane-standard)
- `proceed_to` entries for immediate transitions
- `derived_paths` for temporal state
- Full `projection` per mode (INCLUDE paths carefully scoped — this is the #1 thing that breaks at scale)
- `modes` with vocabulary, channels, preconditions, transitions, crystallize
- `tools` definitions (eroom_list, eroom_download, dispatch_dd, check_dd_status, draft_section, approve_section, assemble_docx)
- `action_map` with precondition gates

**CRITICAL — Projection design:**
- `intake` mode: sees config, contract params
- `eroom_connect`: sees connection config, auth status
- `eroom_ingest`: sees document list (not full content), pagination state
- `dispatch_queue`: sees document registry, queue status, dispatch config
- `dd_batch`: sees batch queue, in-flight sessions, completed results
- `aggregate`: sees DD report summaries (not full reports — too large)
- `draft_sections`: sees ONE section's context at a time, red flags for that section
- `user_approval`: sees current draft, approval state
- `assemble_report`: sees approved sections, metadata
- `complete`: sees output path, summary

**NEVER project the full document registry or all DD reports into any single mode.** Use indexed lookups — the LLM works with IDs and summaries, full content is fetched by tools.

Output: `programs/simoneos/due-diligence-report/specs.yml`

### 2.3 Expanded Spec

Run the spec expander to generate `specs.expanded.yml`. Fix any expansion errors.

---

## PHASE 3 — Registration and Handlers

### 3.1 Registration

Create `programs/simoneos/due-diligence-report/registration.ts`:
- Import from `@simodelne/pgas-server/plugin.js` and `create-server.js`
- Load spec from `specs.yml`
- Define `createAdapters` with actions map, inbound/outbound channels
- Register reaction handlers for: phase gates, DD result collection, approval gates
- Define `syncOutContinuationPolicy` for DD delegation channel
- Follow the pattern from `document-due-diligence/registration.ts`

### 3.2 Tool Handlers

Create `programs/simoneos/due-diligence-report/tool-handlers.ts`:

**eRoom tools:**
- `eroom_list_documents`: List documents in eRoom with metadata (category, date, name, path). Supports pagination.
- `eroom_download_document`: Download a specific document by ID, store locally, update registry.
- `eroom_connect`: Authenticate and establish connection to eRoom.

**DD dispatch tools:**
- `dispatch_dd_batch`: Dispatch a batch of documents to `document-due-diligence` via the dd-service delegation pattern. Returns batch session IDs.
- `check_dd_progress`: Check status of in-flight DD sessions, collect completed results.

**Report tools:**
- `draft_section`: Draft a report section based on DD findings for that category. Uses carefully scoped projection of relevant DD outputs.
- `assemble_docx`: Assemble all approved sections into a DOCX document using the memo-generator pattern.

### 3.3 Gate Handlers

Create `programs/simoneos/due-diligence-report/gate-handlers.ts`:
- Two-step phase gate handlers (reuse pattern)
- DD result collection reaction: when a DD session completes, write result to `inputs.dd_reports.<doc_id>`
- Approval gate: block progression until user approves section

### 3.4 Projection

Create `programs/simoneos/due-diligence-report/projection.ts`:
- Custom projection logic for per-mode context scoping
- Indexed lookup for document registry (return IDs + summaries, not full content)
- Red flag aggregation by category
- Section context builder for drafting mode

---

## PHASE 4 — Server Registration

### 4.1 Register Program in Server

Add `due-diligence-report` to the simoneos server registration map at:
`server/src/registrations/`

Follow the existing pattern — import the program's registration entry and add it to the programs map.

### 4.2 E2E Coverage

Update `qc/e2e-coverage.yml` to register the new program's facts and e2e-frontend scenario. Use YAML merge, never replace unrelated matrix entries.

---

## PHASE 5 — Frontend Spec

Create `programs/simoneos/due-diligence-report/frontend.spec.yml`:
- Define frontend interaction model: document registry view, DD progress dashboard, section-by-section approval workflow
- Follow the pattern from `document-due-diligence/frontend.spec.yml`

---

## PHASE 6 — Verification

### 6.1 Spec Validation

```bash
cd /home/simone/simoneos
tsx scripts/specs-loadcheck.ts 2>/dev/null || echo "No loadcheck script"
npm run typecheck
```

### 6.2 Spec Graph Lint

```bash
npx tsx qc/lint-patterns.ts 2>&1 | head -20
```

### 6.3 Drift Check

```bash
tsx qc/drift-check.ts --update
tsx qc/integrity.ts --rotate --reason "Add due-diligence-report program"
```

### 6.4 Typecheck and Test

```bash
npm run typecheck
npm test 2>&1 | tail -30
```

---

## PHASE 7 — Documentation

### 7.1 Program Design Doc

Create `docs/programs/due-diligence-report-design.md`:
- Architecture overview
- Mode graph with transition diagram
- Projection strategy per mode
- DD delegation and batching strategy
- eRoom connector design
- Report drafting workflow
- Context scoping principles (why we never dump everything)
- Scale considerations (thousands of documents)

### 7.2 Archetype

Create `qc/archetypes/due-diligence-report/default.scenario.yml` following the existing archetype pattern.

---

## OPERATING RULES

1. **Read before writing.** Study existing programs thoroughly before creating new ones.
2. **Pattern reuse over invention.** Use `dd-service`, `two-step-phase-gate`, `control-plane-standard`, `document-processing-loop` patterns.
3. **Context projection is the #1 design challenge.** Every mode sees minimal context. Tools fetch detail on demand.
4. **No fabricated output.** Run real commands, report real results. RED if something fails.
5. **Commit after each phase** with descriptive messages.
6. **QC gates before claiming completion.** If typecheck or tests fail, fix them.
7. **Projection paths must be explicit.** No wildcards in ingestion paths — expand to schema-declared paths.
8. **`terminal: []` even when empty.** Spec compiler crashes otherwise.
9. **Tool names auto-injected into vocabulary.** Do NOT list raw tool names in `modes.<mode>.vocabulary`.
10. **Use the simoneos docx library** for DOCX generation, not a third-party library.

---

## DELIVERABLES

1. `programs/simoneos/due-diligence-report/` — complete program directory
2. `specs.yml` — full PGAS spec with all modes, projections, tools, patterns
3. `specs.expanded.yml` — expanded spec (generated)
4. `registration.ts` — program registration with adapters and reactions
5. `tool-handlers.ts` — eRoom, DD dispatch, report tools
6. `gate-handlers.ts` — phase gates, DD collection, approval
7. `projection.ts` — per-mode context scoping
8. `frontend.spec.yml` — frontend interaction model
9. Server registration updated
10. `qc/e2e-coverage.yml` updated
11. `qc/archetypes/due-diligence-report/default.scenario.yml`
12. `docs/programs/due-diligence-report-design.md`
13. All QC gates pass: typecheck green, tests green, drift check clean
14. Spec loadcheck passes

**The program is NOT done until every QC gate passes and the spec loads cleanly.** If you run out of iterations before this, report RED with the failing output.

---

## Durable Handoff — 2026-07-23 21:00 UTC

Mandate correction: this pane is the pgas-new foundry/operator pane for
`due-diligence-report`. Ignore stale SimoneOS release watcher work and PR #2138
monitoring unless explicitly re-requested.

### Current Repo State

- `/home/simone/pgas-new`: started the handoff from `main` at `c1d4b44a`
  (`origin/main`), then moved this evidence file onto
  `docs/due-diligence-report-handoff-evidence` for review. The pre-existing
  local `.uat/codex-impl-phase-checkpoints.md` change remains unrelated and
  uncommitted.
- `/home/simone/simoneos`: local checkout clean at
  `19bf16c1 chore(release): v2.7.97`, with
  `34f141da feat: add due diligence report program (#2134)` in history.
  Branch is `chore/release-v2.7.97`; its upstream is gone and it diverges from
  `origin/main`. Do not push from this branch.
- pgas-new GitHub PR state: `gh pr list --state open --json number,title,headRefName,baseRefName,url,isDraft,mergeStateStatus --limit 20`
  returned `[]`.
- SimoneOS PR/issue lookup: `gh pr list --state all --search "due diligence report"`
  found `#2134 feat: add due diligence report program` merged at
  2026-07-23T20:11:29Z. `gh issue list --state open --search "due diligence report"`
  found open `document-due-diligence` issues, but no open issue clearly
  targeting the new `due-diligence-report` report orchestrator.
- No stale `gh pr checks` watcher processes for PR #2134/#2138 were found.

### PASS Verification Matrix

- `/home/simone/pgas-new`: `npm test` passed. Typecheck passed; plugin
  manifest gate reported 26 pass / 0 fail; unit suite reported 97 files passed
  / 4 skipped and 690 tests passed / 14 skipped; static scaffold gate reported
  8 pass / 0 fail. Optional generated scaffold install/test skipped because
  `NPM_TOKEN` was not explicitly set.
- `/home/simone/pgas-new`: `npm run pgas-new -- --help` passed and printed the
  expected command surface.
- `/home/simone/simoneos`: `npm run qc:onboard` passed; integrity, test-drift,
  pattern/prompt drift, and spec drift were green; live UAT reported 12
  e2e-frontend scenarios declared.
- `/home/simone/simoneos`: `npm run specs:loadcheck` passed; all 14 programs
  compiled, including `due-diligence-report`.
- `/home/simone/simoneos`: `npm run typecheck` passed via
  `tsc -p tsconfig.json`.
- `/home/simone/simoneos`: `npx vitest run --config vitest.config.ts programs/simoneos/due-diligence-report/__tests__/tool-handlers.test.ts programs/simoneos/due-diligence-report/__tests__/projection.test.ts programs/simoneos/due-diligence-report/__tests__/gate-handlers.test.ts programs/simoneos/due-diligence-report/__tests__/spec-load.test.ts`
  passed; 4 files passed and 15 tests passed.
- `/home/simone/simoneos/frontend`: `npm test -- src/runtime/docx-authoring/__tests__/register-due-diligence-report.test.ts`
  passed; 1 file passed and 3 tests passed.
- `/home/simone/simoneos`: `npm test` passed; 280 files passed / 13 skipped
  and 3051 tests passed / 139 skipped.

### Production-Readiness Notes

- Self-review found no material code gap in scale-safe projection, eRoom
  registry/list/download/provenance, parallel DD dispatch, section approval,
  red-flag aggregation, significant-findings charts, or DOCX assembly.
- Non-code gap closed locally in SimoneOS by adding
  `programs/simoneos/due-diligence-report/README.md` with operator notes and
  deterministic/live UAT commands, committed as
  `a71786b1 docs: add due diligence report handoff runbook` and opened as
  SimoneOS PR #2139.
- Remaining optional gate: live/staging UAT has not been run from this pane.
  Use the README commands after rebasing/recreating a clean branch from
  `origin/main`; do not run live/deploy/tunnel mutations from the stale release
  branch.

## Post-Merge Continuation — 2026-07-23 22:02 UTC

SimoneOS docs/evidence PR #2142 was opened from
`docs/dd-report-uat-blocker-handoff` and merged after all PR checks passed.

### Merge State

- PR head: `43de8da5242a950e2d7b3cf37c2827cddd308417`
- Merged default-branch SHA:
  `03776052f9a1e5b4e9d8520c9d4852e7346601ff`
- Merged subject:
  `docs: record due diligence report uat blocker (#2142)`
- PR checks were green before merge:
  `Form widget smoke (#527 regression guard)`, `check-override`,
  `product-tests`, both `static-gates` checks, and `verify`.

### Local Verification

The SimoneOS docs/evidence commit was made through normal hooks. The hook
reported all pre-commit QC checks passed, including integrity, test-drift,
pattern-drift, prompt-fragment lint, prompt-example lint, archetype-shape lint,
spec drift, projection-relocation lint, and spec-graph semantic lint.

Additional commands run before the commit:

```bash
git diff --check
npm run qc:onboard
npm run specs:loadcheck
```

Observed PASS output:

- `npm run qc:onboard`: integrity, test-drift lint, pattern + prompt drift, and
  spec drift passed; live UAT declared 12 e2e-frontend scenarios.
- `npm run specs:loadcheck`: all 14 programs compiled cleanly, including
  `due-diligence-report`.

### UAT Gate

The next DD-report UAT command was run from `/home/simone/simoneos`:

```bash
E2E_DETERMINISTIC_UAT=1 npm run e2e:frontend -- qc/e2e-frontend/due-diligence-report.scenario.yml
```

Result: RED before program execution because the configured target host was not
resolvable in this environment.

```text
runner error: apiRequestContext.post: getaddrinfo ENOTFOUND simoneos.local
POST https://simoneos.local/api/auth/register
curl: (6) Could not resolve host: simoneos.local
```

Generated runner report:
`qc/e2e-frontend/runs/due-diligence-report-2026-07-23T21-37-44-092Z.json`.
It recorded `pass: false`, `modes_visited: []`, and
`validation_mode: deterministic`.

### Default-Branch Check State

After the PR #2142 merge, `origin/main` resolved to
`03776052f9a1e5b4e9d8520c9d4852e7346601ff`.

Default-branch checks for that SHA:

- `Zero-internals guard`: success
- `Cheap gates`: success
- `Playwright smoke (PR-gating)`: success
- `SimoneOS CI`: success
- `Build & push container images`: failure

The image workflow failure was isolated to `image — simoneos-caddy`; app image
jobs for frontend, backend, mcp-server, and llama-wrapper succeeded, and
`image — llama-server-cuda` was skipped.

Exact failing output from run `30047828129`, job `89343638613`, step
`Login to GHCR`:

```text
/home/simone/actions-runner-simoneos/_work/_temp/58ae5ae1-41e6-4022-a685-8bcc22e75ef6.sh: line 2: podman: command not found
##[error]Process completed with exit code 127.
```

No runner, tunnel, deployment, release, or live infrastructure mutation was
performed from this pane. The remaining production gate is rerunning DD-report
deterministic/live UAT after `simoneos.local` is resolvable and rerunning the
image lane after the SimoneOS runner has a working `podman` installation.

## Overnight Environment-Gate Continuation — 2026-07-23 22:26 UTC

Follow-up diagnostics were run after the RED handoff. No secrets were printed
and no runner, tunnel, deployment, release, or live infrastructure was mutated.

### UAT DNS / Target Selection

Source-pinned runner defaults:

- `/home/simone/simoneos/qc/e2e-frontend/helpers.ts:35` defaults
  `E2E_BASE_URL` to `https://simoneos.local`.
- `/home/simone/simoneos/qc/e2e-frontend/helpers.ts:36` derives
  `E2E_API_BASE` as `${E2E_BASE_URL}/api`.
- `/home/simone/simoneos/qc/e2e-frontend/helpers.ts:89` posts auth to
  `${env.apiBase}/auth/register`.
- `/home/simone/simoneos/qc/e2e-frontend/README.md:31-36` documents the
  staging form of the command with explicit
  `https://simoneos-staging.simoneos.xyz` URLs.

Safe diagnostics:

```text
E2E_BASE_URL_set=
E2E_API_BASE_set=
E2E_TRIGGER_API_BASE_set=
E2E_TEST_EMAIL_set=
E2E_TEST_PASSWORD_set=
MCP_BASE_URL_set=
MCP_API_KEY_set=
curl: (6) Could not resolve host: simoneos.local
```

Public staging DNS and health were reachable:

```text
simoneos-staging.simoneos.xyz -> 172.67.145.60, 104.21.47.63
```

Filtered health result:

```json
{
  "status": "ok",
  "program_count": 16,
  "has_due_diligence_report": false
}
```

Conclusion: the original DD-report deterministic UAT command failed because no
target env was set and the local default hostname is not resolvable. The safe
repo-native workaround is to run UAT with explicit staging URLs. However, the
current public staging target is not deployed with `due-diligence-report`, so a
full DD-report UAT would still fail before exercising the program. The next
operator action is to deploy/reconcile staging to a SimoneOS build that includes
`due-diligence-report`, then rerun:

```bash
E2E_BASE_URL=https://simoneos-staging.simoneos.xyz \
E2E_API_BASE=https://simoneos-staging.simoneos.xyz/api \
E2E_TRIGGER_API_BASE=https://simoneos-staging.simoneos.xyz/api \
E2E_DETERMINISTIC_UAT=1 \
npm run e2e:frontend -- qc/e2e-frontend/due-diligence-report.scenario.yml
```

### Container Image Gate

Source-pinned workflow lines:

- `/home/simone/simoneos/.github/workflows/build-and-push.yml:85` runs app
  image jobs on `[self-hosted, gpu-pod]`.
- `/home/simone/simoneos/.github/workflows/build-and-push.yml:290-292` runs
  `image — simoneos-caddy` on the same `[self-hosted, gpu-pod]` labels.
- `/home/simone/simoneos/.github/workflows/build-and-push.yml:344-349` calls
  `podman login` for the caddy GHCR login step.

Runner metadata for failed default-branch run `30047828129`:

```json
{"name":"app — simoneos-frontend","conclusion":"success","runner_name":"htpc-simoneos","labels":["self-hosted","gpu-pod"]}
{"name":"app — simoneos-backend","conclusion":"success","runner_name":"htpc-simoneos","labels":["self-hosted","gpu-pod"]}
{"name":"app — simoneos-mcp-server","conclusion":"success","runner_name":"htpc-simoneos","labels":["self-hosted","gpu-pod"]}
{"name":"app — llama-wrapper","conclusion":"success","runner_name":"htpc-simoneos","labels":["self-hosted","gpu-pod"]}
{"name":"image — simoneos-caddy","conclusion":"failure","runner_name":"simone-lab-simoneos","labels":["self-hosted","gpu-pod"]}
```

Registered runner metadata showed both runners online with the same build
labels:

```json
{"name":"htpc-simoneos","status":"online","busy":false,"labels":["self-hosted","Linux","X64","gpu-pod"]}
{"name":"simone-lab-simoneos","status":"online","busy":false,"labels":["self-hosted","Linux","X64","gpu-pod"]}
```

Failed-job rerun was attempted with:

```bash
gh -R simodelne/simoneos run rerun 30047828129 --failed
```

The rerun again placed `image — simoneos-caddy` on
`simone-lab-simoneos` and failed before build. Rerun job:
`89349126315`.

Exact rerun failure:

```text
/home/simone/actions-runner-simoneos/_work/_temp/776c29f9-c0f0-42b8-9a68-f71b201934f9.sh: line 2: podman: command not found
##[error]Process completed with exit code 127.
```

The summary rerun job `89349195370` ran on `htpc-simoneos` and also emitted a
runner-capacity warning:

```text
Runner name: 'htpc-simoneos'
Machine name: 'htpc'
You are running out of disk space. The runner will stop working when the machine runs out of disk space. Free space left: 0 MB
```

Conclusion: the workflow label set is ambiguous. At least one runner with the
`gpu-pod` label (`simone-lab-simoneos`) cannot execute the workflow contract
because `podman` is absent. The smallest operator action is one of:

1. Install/repair `podman` on `simone-lab-simoneos`; or
2. Remove the `gpu-pod` label or disable the `simone-lab-simoneos` runner until
   it satisfies the workflow contract; or
3. Add a distinct Podman-capable label to `htpc-simoneos` and update
   `.github/workflows/build-and-push.yml` to require that label.

This requires runner host/label mutation and is therefore a hard stop for this
pane. No further caddy-image reruns are useful until runner selection or
runner provisioning is corrected.
