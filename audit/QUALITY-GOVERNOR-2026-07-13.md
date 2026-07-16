# pgas-new — Repo Quality Governor Audit

- Date: 2026-07-13 · Mode: audit-only (zero edits) · Tree: v3.20.0 (main @ bed016cc)
- Engine: repo-quality-governor workflow adapted for pgas-new · 28 agents · horizontal sweep -> adversarial verification -> vertical synthesis -> staged roadmap
- Recommendation: **proceed-cautiously**

> The verification baseline is healthy (typecheck clean, full suite of typecheck+manifest+unit+static exists; the only local instability is the documented environmental nested-vitest fork abort, which passes on htpc CI and is not a code defect), so no verification-establishment PR is needed as a prerequisite. All ten findings were re-verified against the current tree (now at v3.20.0) and are genuine. Three PRs are auto-safe now and should proceed immediately: the pure-additive verification-env characterization test (order 1), the module-scope regex hoist (order 2), and the wiring-manifest error-dedup with its exact-contents characterization test (order 3) — I ordered the additive test PR first per the safety policy and kept each single-axis. The remaining seven require human confirmation and stay audit-only: two dead-code items (one flagged by cross-axis analysis as a possible reserved v3 feature, one touching the deep-importable foundry-server public surface), two duplication refactors that land in or adjacent to the governed model.ts/gates.ts DO-NOT-TOUCH zone, a security hardening whose failure-mode (warn vs throw) is a UX/fixture decision the human must pick, a no-observed-defect deepEqual robustness nicety, and — highest risk — the gates/spec contract-alignment fix, which is NOT a live misgate today (only the shipped companion validator disagrees with specs.yml) and requires a blocking governance decision on which field(s) gate the transition and the fate of architecture_ready. Every behavioral/protected-zone change is gated behind human sign-off with lockstep test updates called out; nothing touches the engine pin, version.ts, specs.yml itself, templates, or sota/fixture goldens. Proceed with orders 1-3 now; route 4-10 through owner review before implementation.

## Verification baseline
- **typecheck**: PASS - tsc --noEmit clean
- **test_manifest**: PASS - 26/26 checks (plugin.json v3.20.0, package.json v3.20.0, legacy v1 surfaces absent, docs present)
- **cli_smoke**: PASS - pgas-new --help works
- **test_suites**: PASS - unit/integration/static/sota configured and runnable
- **ci_workflow**: self-hosted gpu-pod runner only; architecture-diff.yml enforces architecture doc PR section requirement
- **status**: All verification commands present in package.json and confirmed working

## Findings (10 survived adversarial verification)

| # | sev | conf | axis | id | files | HITL |
|---|-----|------|------|----|-------|------|
| 1 | high | high | type-safety | `model-spec-gate-contract-001` | src/pgas-new/model.ts<br>src/pgas-new/gates.ts<br>src/foundry-program/specs.yml | yes |
| 2 | medium | high | security | `password-file-permissions-security-01` | src/cli.ts | — |
| 3 | low | medium | duplication | `path-text-utility-duplication-01` | src/pgas-new/artifact-plan.ts<br>src/pgas-new/template-renderer.ts<br>src/pgas-new/generated-live-drive.ts | — |
| 4 | low | medium | duplication | `session-control-actions-duplication-001` | src/pgas-new/model.ts<br>src/pgas-new/gates.ts | — |
| 5 | low | high | type-safety | `deep-equal-type-safety-001` | src/foundry-program/registration.ts | — |
| 6 | low | high | dead-code | `repo-tools-dead-code-check-01` | src/foundry-program/tools.ts | yes |
| 7 | low | high | tests | `sanitized-verification-env-test-coverage-01` | src/pgas-new/verification-env.ts | — |
| 8 | low | high | optimization | `wiring-manifest-validation-consolidation-01` | src/pgas-new/wiring-manifest.ts | — |
| 9 | low | high | optimization | `static-regex-optimization-01` | src/foundry-program/handlers.ts | — |
| 10 | low | high | dead-code | `shouldUseCodexCliDriver-dead-export-01` | src/foundry-server.ts | — |

### 1. [high/high] model-spec-gate-contract-001 (type-safety)
- **Files**: src/pgas-new/model.ts, src/pgas-new/gates.ts, src/foundry-program/specs.yml
- **Evidence**: specs.yml line 137 declares guard checking program.synthesis_complete for architecture_design->scaffold_plan transition. model.ts lines 117-122 define program interface with only architecture_ready, missing synthesis_complete field. gates.ts line 110 checks architecture_ready instead. Violates spec/model/gate alignment from MEMORY.md.
- **Why it matters**: Critical governance contract mismatch. The spec declares two distinct synthesis phases but TypeScript model only tracks one. Public gates API legalActionsForMode/canTransition relies on complete model definition.
- **Proposed fix**: Add synthesis_complete: boolean field to PgasNewState.program in model.ts. Update gates.ts to check program.synthesis_complete for the transition guard.
- **Risk if changed**: Low. Field is additive; existing tests need synthesis_complete: true when testing scaffold_plan transitions. Runtime state already contains this field.
- **HITL**: yes · **verify**: `npm run typecheck` `npm run test:unit -- tests/unit/gates.test.ts`

### 2. [medium/high] password-file-permissions-security-01 (security)
- **Files**: src/cli.ts
- **Evidence**: cli.ts:531-533 reads password file without verifying permissions. Should check file mode is 0o600 (owner only).
- **Why it matters**: World-readable password file could leak credentials to other processes on the same system.
- **Proposed fix**: Verify file mode: if ((stats.mode & 0o077) !== 0) throw new Error().
- **Risk if changed**: Very low. Makes function stricter without changing behavior for properly-secured files.
- **HITL**: no · **verify**: `npm run typecheck` `npm run test:unit -- tests/unit/cli-login.test.ts`

### 3. [low/medium] path-text-utility-duplication-01 (duplication)
- **Files**: src/pgas-new/artifact-plan.ts, src/pgas-new/template-renderer.ts, src/pgas-new/generated-live-drive.ts
- **Evidence**: artifact-plan.ts:409-411 and template-renderer.ts:623-625 both implement identical slash-trimming regex. toPascalCase is defined identically in template-renderer.ts:753-759 and generated-live-drive.ts:434-440.
- **Why it matters**: Case conversion and path utilities across multiple modules should be centralized for maintainability.
- **Proposed fix**: Extract to src/pgas-new/path-utils.ts and src/pgas-new/text-case.ts, import in all three modules.
- **Risk if changed**: Very low. Private functions, well-tested in artifact-plan.test.ts and template-renderer.test.ts.
- **HITL**: no · **verify**: `npm run typecheck` `npm run test:unit -- artifact-plan.test.ts template-renderer.test.ts`

### 4. [low/medium] session-control-actions-duplication-001 (duplication)
- **Files**: src/pgas-new/model.ts, src/pgas-new/gates.ts
- **Evidence**: Session actions (session_new through session_help) appear in model.ts PGAS_NEW_ACTIONS lines 37-42 and gates.ts SESSION_CONTROL_ACTIONS lines 16-23 with duplicated entries, included in every mode's BASE_ACTIONS_BY_MODE.
- **Why it matters**: Three-way duplication of cross-cutting concern (every mode includes session controls) creates synchronization risk. If a new session control is added, all 3 locations must be updated.
- **Proposed fix**: Export SESSION_CONTROL_ACTIONS from model.ts, import in gates.ts. Single source of truth.
- **Risk if changed**: Very low. Pure refactoring.
- **HITL**: no · **verify**: `npm run typecheck` `npm run test:unit -- tests/unit/gates.test.ts`

### 5. [low/high] deep-equal-type-safety-001 (type-safety)
- **Files**: src/foundry-program/registration.ts
- **Evidence**: registration.ts:177-180 uses JSON.stringify for equality check. This is fragile for object ordering and can produce false negatives/positives for complex nested structures.
- **Why it matters**: JSON.stringify-based equality is an anti-pattern prone to subtle bugs and circular reference failures.
- **Proposed fix**: Replace with field-by-field comparison or library-agnostic deep equality check.
- **Risk if changed**: Minimal. Only affects collision detection logic.
- **HITL**: no · **verify**: `npm run typecheck` `npm run test:unit -- registration`

### 6. [low/high] repo-tools-dead-code-check-01 (dead-code)
- **Files**: src/foundry-program/tools.ts
- **Evidence**: tools.ts:22-23 registers repo_read_file and repo_list_files as noop tools. Not in specs.yml vocabularies and no handler definitions found.
- **Why it matters**: Dead code increases cognitive load. If planned features, should be documented as such.
- **Proposed fix**: Remove from semanticTools array unless documented as future feature.
- **Risk if changed**: No risk. Not wired into any spec action.
- **HITL**: yes · **verify**: `grep -r 'repo_read_file' src tests` `npm run test:manifest`

### 7. [low/high] sanitized-verification-env-test-coverage-01 (tests)
- **Files**: src/pgas-new/verification-env.ts
- **Evidence**: sanitizedVerificationEnv is security-critical (prevents credential leaks to verification subprocesses) but has no unit test coverage. No tests verify denylist keys are removed or non-denylist keys preserved.
- **Why it matters**: Lack of explicit credential filtering tests is a security concern. Changes could accidentally allow credentials to leak.
- **Proposed fix**: Create tests/unit/verification-env.test.ts verifying denylist keys are removed and non-denylist keys preserved.
- **Risk if changed**: No risk. Tests only, improve confidence.
- **HITL**: no · **verify**: `npm run test:unit -- tests/unit/verification-env.test.ts`

### 8. [low/high] wiring-manifest-validation-consolidation-01 (optimization)
- **Files**: src/pgas-new/wiring-manifest.ts
- **Evidence**: wiring-manifest.ts:162-172 validates verification.commands twice: required commands (162-166), then all commands (168-172). Generates duplicate error messages for invalid required commands.
- **Why it matters**: Redundant validation wastes CPU cycles and produces duplicate errors in error array, confusing error reporting.
- **Proposed fix**: Consolidate into single loop checking required and all commands in one pass.
- **Risk if changed**: Low. Removes redundancy, no validation rules change.
- **HITL**: no · **verify**: `npm run test:unit -- wiring-manifest`

### 9. [low/high] static-regex-optimization-01 (optimization)
- **Files**: src/foundry-program/handlers.ts
- **Evidence**: handlers.ts:1276-1286 constructs artifact-path regex on every call. Pattern is static and should be pre-compiled.
- **Why it matters**: Repeated regex compilation adds observable overhead during artifact planning revisions.
- **Proposed fix**: Move regex to module-level const.
- **Risk if changed**: No risk. Pure optimization.
- **HITL**: no · **verify**: `npm run typecheck`

### 10. [low/high] shouldUseCodexCliDriver-dead-export-01 (dead-code)
- **Files**: src/foundry-server.ts
- **Evidence**: foundry-server.ts:208 exports shouldUseCodexCliDriver but it is only used internally (line 54). Not re-exported in index.ts.
- **Why it matters**: Unnecessary export increases public API surface and creates potential backwards compatibility constraints.
- **Proposed fix**: Remove export keyword. Keep as private function.
- **Risk if changed**: If external code imports it, would break. However not in documented public API.
- **HITL**: no · **verify**: `grep -r 'shouldUseCodexCliDriver' src --include='*.ts'`

## Staged PR roadmap (10)

| # | branch | title | risk | safe_now | HITL |
|---|--------|-------|------|----------|------|
| 1 | `quality/tests-verification-env-coverage` | tests: add credential-filtering coverage for sanitizedVerificationEnv | low | yes | — |
| 2 | `quality/opt-precompile-artifact-path-regex` | perf(foundry): pre-compile artifact-path extraction regex to module scope | low | yes | — |
| 3 | `quality/opt-wiring-manifest-dedupe-validation` | perf(wiring): consolidate wiring-manifest verification-command validation (dedupe errors, preserve absent-required-command case) | low | yes | — |
| 4 | `quality/dead-code-repo-tools-reserved` | chore(foundry): document repo_read_file/repo_list_files noop tools as reserved (or remove) | low | — | yes |
| 5 | `quality/dead-code-foundry-server-private-helper` | chore(foundry-server): drop unnecessary export on shouldUseCodexCliDriver | low | — | yes |
| 6 | `quality/dup-session-control-actions-single-source` | refactor(model/gates): export SESSION_CONTROL_ACTIONS from model.ts, import in gates.ts | low | — | yes |
| 7 | `quality/dup-path-text-case-utilities` | refactor(pgas-new): consolidate path + text-case utilities (u-flag canonical, scope-limited to src/pgas-new) | low | — | yes |
| 8 | `quality/security-password-file-permissions` | security: warn (or reject) on group/world-readable --password-file in cli.ts | low | — | yes |
| 9 | `quality/type-safety-registration-deepequal` | refactor(registration): replace JSON.stringify deepEqual in tool-argument-key collision detection | low | — | yes |
| 10 | `quality/type-safety-gates-spec-contract-alignment` | fix(gates): align architecture_design->scaffold_plan guard with specs.yml program.synthesis_complete (GOVERNANCE DECISION REQUIRED) | high | — | yes |

**Auto-safe (safe_now && !HITL):** #1 quality/tests-verification-env-coverage, #2 quality/opt-precompile-artifact-path-regex, #3 quality/opt-wiring-manifest-dedupe-validation

## Cross-axis conflicts (5)
- **[artifact-spec-co-location-vs-file-org]** cli-agent-session-extraction-01 — Extracting agent-session logic to separate module respects the principle that spec and handler should stay co-located. The agent-session code is CLI infrastructure, not foundry spec/handler logic, so extraction is safe.
- **[dead-code-vs-future-feature]** repo-tools-dead-code-check-01 — repo_read_file and repo_list_files may be planned v3 features. Confirm with team whether to remove or document as roadmap items before cleanup.
- **[test-utility-consolidation-vs-integration-structure]** test-helper-consolidation-01 — Consolidating test helpers in foundry-test-utils.ts does not break integration test structure or cross-file dependencies. It improves test suite maintainability without any negative tradeoffs.
- **[verification-status-normalization-vs-test-updates]** verification-status-enum-mismatch-001 — Normalizing VerificationStatus requires updating verify.test.ts expectations (lines 25, 43, 89, 147, 124, 178, 310, 327). This is safe but requires coordinated test updates.
- **[model-completeness-vs-public-api-signature]** model-spec-gate-contract-001, model-action-vocabulary-mismatch-001 — Both findings point to incomplete model.ts vs. spec.yml alignment, violating MEMORY.md invariant #68. Fixing both ensures legalActionsForMode and canTransition public APIs accurately reflect spec definitions. Can be addressed in single PR.

## Verifier note (headline finding)
`model-spec-gate-contract-001` verified independently: `specs.yml` declares/writes/guards `program.synthesis_complete` (schema L1034, MSet L769, guards L137/144/149/156) so it is a real working field — the foundry navigates correctly. `model.ts` program interface (L116-121) + createInitialState (L186-189) omit it (they carry architecture_ready + domain_synthesis_complete). It is therefore a spec<->model TYPE-DRIFT (incomplete typed mirror), not a functional break; severity high is a notch strong, but it violates the model<->spec alignment invariant, hence correctly HITL/governance-gated.