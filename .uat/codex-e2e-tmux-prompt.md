# Codex §10 tmux-driven E2E Live Acceptance Test

The load-bearing v3 acceptance gate. You act as user, driving the
`pgas-new` CLI from a tmux session via keystrokes against the real Qwen
vLLM at `100.100.74.6:8000`, model `qwen36-27b`. Eight scenarios per
plan §10 at `docs/superpowers/specs/2026-06-22-v3-rebuild-plan.md:822`.

**SANDBOX NOTE:** You're running with `--sandbox danger-full-access` because
the §10 test requires outbound network to reach the Tailscale vLLM at
`100.100.74.6:8000` — workspace-write blocked this in the prior run (curl
exit 7 on every preflight). The file-system boundaries previously enforced
by the sandbox are now policy-enforced by the "Hard boundaries" section at
the bottom of this prompt. Treat those boundaries as if the sandbox were
still active: write only to `.uat/`, `/tmp/pgas-new-e2e-scenario-*`,
`/tmp/fake-consumer/`, `/tmp/empty-dir-no-manifest/`,
`/tmp/invalid-manifest/`, and tmux session state. No commits, no pushes,
no writes outside the allow-list.

## Preflight (every scenario)

```bash
curl -sf --max-time 5 http://100.100.74.6:8000/v1/models | jq -r '.data[0].id'
# Expected: qwen36-27b
```

If preflight fails, write `SKIP - vLLM unreachable` for that scenario
and continue. Do **NOT** soften to "PASS"; SKIP must be explicit and
counted separately per plan §9.

Set the model env once:
```bash
export PGAS_OPENAI_BASE_URL=http://100.100.74.6:8000/v1
export PGAS_OPENAI_MODEL=qwen36-27b
```

## Reading order

1. `CLAUDE.md`
2. `docs/superpowers/specs/2026-06-22-v3-rebuild-plan.md` §10 (`:822`)
3. `.uat/codex-impl-phase-checkpoints.md` and
   `.uat/codex-impl-phase-3-report.md` (current state of the foundry).
4. Current foundry surface: `src/foundry-program/`, `src/cli.ts`,
   `src/repl/`, `src/foundry-server.ts`.

## How to drive the tmux session

For each scenario:
1. Start a fresh tmux session: `tmux new-session -d -s e2e-<scenario>`.
2. Inside the session, run the CLI: `pgas-new` (or with the flags the
   scenario specifies).
3. Send keystrokes with `tmux send-keys -t e2e-<scenario>:0 "text" Enter`.
4. Capture the pane periodically with `tmux capture-pane -t e2e-<scenario>:0 -p`.
5. Stream the full pane buffer to
   `.uat/e2e-rebuild-transcript-scenario-<letter>.log` (use
   `pipe-pane` for streaming or capture at end).
6. Kill the session at end: `tmux kill-session -t e2e-<scenario>`.
7. Inspect:
   - Generated files at the output directory (where applicable).
   - PGAS session log under `<repo>/session-logs/` for action firing
     evidence.
   - Foundry's in-process state via the REPL `status` control before
     issuing `/abort` or final `exit`.

Each scenario MUST capture in its transcript:
- The exact `pgas-new` invocation.
- Every user keystroke sent (timestamped).
- Every pane snapshot.
- The final action_map firing summary from `session-logs/`.
- PASS / FAIL / SKIP verdict with one-line reason.

## Scenarios

### Scenario A — design path, standalone repo (incident triage)

- Output dir: `/tmp/pgas-new-e2e-scenario-a`.
- Pick **design** at the design-path fork.
- Answer Q1–Q6 with an incident-triage example:
  - Q1 purpose: "Triage and resolve production incidents from PagerDuty."
  - Q2 entry channel: `widget_input`
  - Q3 stages: `triage_intake, root_cause_analysis, mitigation, resolution`
  - Q4 transitions: `triage_intake→root_cause_analysis (on triage_complete=true)`,
    `root_cause_analysis→mitigation (on root_cause_identified=true)`,
    `mitigation→resolution (on mitigation_applied=true)`
  - Q5 delegation: none
  - Q6 completion: final stage `resolution`, guard `incident_resolved`
- Approve at both confirms.

**PASS criteria** (all must hold):
- `record_program_target` fired with `name=incident-triage`, `slug=incident-triage`.
- Q1–Q6 asked **in order** (verify by `grep -n llm_raw_response session-logs/<file>.jsonl`
  and confirming the order matches the intake's expected prompts).
- All six chained Q-actions fired in order: `record_q1_purpose`,
  `record_q2_entry_channel`, `record_q3_stages`, `record_q4_transitions`,
  `record_q5_delegation`, `record_q6_completion` — each EXACTLY ONCE,
  each gated by its predecessor's `intake.qN_recorded=true` precondition
  (governed-state enforcement per Phase 3.14).
- `record_program_intake_finalize` fired exactly once after Q6,
  setting `intake.program_intake_finalized=true`.
- `confirm_design` and `approve_artifact_plan` each fired exactly once.
- `synthesize_program_spec` fired; the synthesizer-store has the YAML; the
  action result carries `{kind: 'mechanical_synthesis', no_llm_call: true,
  mode_names: [4 names], sha256: ...}` — verify the `no_llm_call: true`
  marker is present in the session log entry for the action result.
- `write_scaffold_artifacts` fired; the output dir contains
  `src/programs/incident-triage/specs.yml` with the 4-mode topology.
- The unit-test version (`tests/unit/synthesize-program-spec.test.ts`) also
  passes locally (verifies the handler is pure independently of harness).

### Scenario B — default skeleton path, standalone repo (minimal-test)

- Output dir: `/tmp/pgas-new-e2e-scenario-b`.
- Pick **default** at the design-path fork.
- Name the program "minimal-test".
- Approve at design echo-back and plan approve.

**PASS criteria:**
- `choose_design_path` fired with `program.design_path = 'default'`.
- `apply_default_skeleton` fired and populated `intake.stages_json` to the
  3-mode default (`start, working, complete`) per its declared MSet mutations.
- Only the two confirms are asked (no Q1–Q6).
- Output uses `start → working → complete` mode names in the synthesized
  spec.

### Scenario C — attach to existing pgas-consumer repo (fake-consumer)

Pre-create the fake-consumer fixture per plan §10 Scenario C (the
`mkdir + cat > package.json` block). Then:

- Output dir: `/tmp/fake-consumer`.
- Pick **default** skeleton.
- Name the program "audit-trail".

**PASS criteria:**
- Files written under `/tmp/fake-consumer/programs/audit-trail/` per the
  manifest's `paths.programs_dir`.
- Curator-request artifact written to `/tmp/fake-consumer/audit/PGAS-NEW-audit-trail.md`
  per `registration.strategy: curator_request`.
- `cd /tmp/fake-consumer && npm install --no-audit --no-fund && npm run typecheck` PASS.

If `npm install` fails with no registry access, record SKIP for the
install/typecheck assertion (not PASS); the rest of the scenario can still
PASS if files were written correctly.

### Scenario D — refusal: missing manifest

- Output dir: `/tmp/empty-dir-no-manifest` (empty dir, no `.pgas/`).
- Pick **default**. At `repo_targeting`, pick **attach**.

**PASS criteria:**
- Foundry's `load_wiring_manifest` rejects with
  "no wiring manifest at <path>; foundry must lodge a curator request
  instead of writing".
- A curator-request artifact is emitted (location may vary; verify any
  artifact exists in the session log AND no files were written under
  `/tmp/empty-dir-no-manifest/programs/`).

### Scenario E — refusal: invalid manifest

Pre-create `/tmp/invalid-manifest/.pgas/wiring.yml` with deliberately
invalid content (e.g., `schema_version: 1` and missing required `paths`
field). Then:

- Output dir: `/tmp/invalid-manifest`.
- Pick **default** + **attach**.

**PASS criteria:**
- Foundry rejects with a clear schema-validation error.
- No files written under `/tmp/invalid-manifest/programs/`.

### Scenario F — refusal: collision

Run `pgas-new --out /tmp/pgas-new-e2e-scenario-a` a SECOND time (the dir
already has files from Scenario A).

**PASS criteria:**
- Foundry refuses to overwrite. The error message names the collision
  path (e.g., `package.json` already exists).
- No files mutated under `/tmp/pgas-new-e2e-scenario-a/`.

### Scenario G — skip / reject / edit

- Drive the **design path**.
- On Q4 (decision points), type literally `skip`.
- On `confirm_design`, type `reject` then ask to change Q3 (stages).
- Foundry re-asks Q3, re-emits the confirmation. Then approve.

**PASS criteria:**
- The session log shows Q4 was answered with `skip` and the foundry filled
  defaults for transitions through `record_q4_transitions`.
- The session log shows a rejection of `confirm_design`, then a re-emit
  of Q3 by clearing `intake.q3_recorded`, then a re-fire of
  `record_q3_stages`, then a re-emit of `confirm_design`.
- The final `record_q3_stages` mutation reflects the **revised** Q3 answer,
  not the original, and the chained Q-actions/finalize shape remains intact.

### Scenario H — `/abort` during a running round

- Drive the **design path**.
- While the LLM is responding to Q3, type `/abort`.

**PASS criteria:**
- The session aborts cleanly (no orphan child process, no half-written
  state).
- The session log shows the abort signal and a clean shutdown of the
  current round.
- No partial state mutations after the abort (verify by inspecting the
  session log for any action mutation after the abort timestamp).
- The foundry-server process is still alive and able to start a fresh
  session (test by starting another `pgas-new` and confirming the REPL
  opens).

## Reporting

Write `.uat/codex-e2e-rebuild-report.md` with:

```markdown
# §10 tmux E2E Acceptance Report

## Environment
- Date: <ISO>
- Branch: v3-rebuild @ <SHA>
- Model: qwen36-27b @ http://100.100.74.6:8000/v1
- tmux: <version>

## Scenario verdicts

| Scenario | Verdict | Transcript | Notes |
|---|---|---|---|
| A — design path standalone | PASS \| FAIL \| SKIP | `.uat/e2e-rebuild-transcript-scenario-a.log` | … |
| B — default skeleton standalone | … | | |
| C — attach existing repo | … | | |
| D — refusal missing manifest | … | | |
| E — refusal invalid manifest | … | | |
| F — refusal collision | … | | |
| G — skip/reject/edit | … | | |
| H — /abort mid-round | … | | |

## SKIP analysis

For each SKIP, name the specific assertion that couldn't be verified and
why. SKIPs are NOT failures, but they are also NOT passes; they're
explicit gaps in coverage.

## Real bugs surfaced

Any LLM-driven discovery the unit/integration tests missed. Each bug:
1-2 sentence description + the action / mutation / state path involved +
session-log file + line range.

## Verdict

- [ ] ALL PASS — v3 ready for §11/§12 (Phase 4 cleanup + release cut)
- [ ] PARTIAL — some SKIPs, no FAILs — v3 conditionally ready
- [ ] FAIL — at least one scenario revealed a real bug; cite scenario(s)
```

## Stop conditions

- vLLM unreachable for >30 min during the run → STOP, write blocker.
- Foundry crashes uncaught in >1 scenario after 1 retry each → STOP.
- Any scenario reveals a bug that breaks a foundational assumption
  (e.g., synthesizer produces non-loadable YAML for a graduation-evidence
  intake) → STOP, write blocker with the specific intake.

## Hard boundaries (zero tolerance)

- Do NOT push. Do NOT open PRs. Do NOT touch `main`.
- Do NOT call `gh pr create` against any remote. Scenarios A and C may
  reach `pr_graduation` mode; render the curator-request artifact but do
  NOT actually run the gh command.
- Do NOT read, print, or expose secrets in transcripts. Filter any env
  variable matching `*TOKEN*`, `*KEY*`, `*SECRET*` from `tmux capture-pane`
  output before writing to the transcript.
- Do NOT skip git hooks. (You aren't committing anything anyway.)
- Write only to: `.uat/`, `/tmp/pgas-new-e2e-scenario-*`,
  `/tmp/fake-consumer/`, `/tmp/empty-dir-no-manifest/`,
  `/tmp/invalid-manifest/`, and `tmux` session state.
- Do NOT commit. This is a read-only verification run from the repo's
  perspective. (Side effects in `/tmp/` and `tmux` sessions are fine.)
