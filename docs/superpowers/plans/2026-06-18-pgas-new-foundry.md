> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to execute this plan.

# PGAS-New Foundry Implementation Plan

## Objective

Replace the outdated `claude-pgas-plugin` v1 scaffolding surface with an initial `pgas-new` TypeScript/Node PGAS program foundry aligned to the approved Obsidian note:

- Target only TypeScript/Node PGAS consumers initially.
- Generate PGAS v2 programs using current public `@simodelne/pgas-server@2.10.0` surfaces.
- Generate standalone repos and existing-repo attachments, but write existing-repo artifacts only when fixed-path `.pgas/wiring.yml` exists and validates.
- Keep frontend, auth, persistence, and external services as explicit stubs/attachment points.
- Treat generated coding artifacts as first-class planned objects, not incidental file writes.
- Include a REPL/control-plane scaffold using `controlCliAdapter`, free text, slash commands, menus/confirmations, and notebook-backed state.
- Produce static and deterministic verification assets now; defer final real-provider live graduation to the user-selected live test.

## Baseline

- Branch: `feat/pgas-new-foundry`.
- Published package check: `npm view @simodelne/pgas-server version --registry=https://npm.pkg.github.com` returns `2.10.0`.
- Existing `npm test` after installing declared deps fails in `tests/server-typecheck.test.sh` because v1 templates import removed `@simodelne/pgas-server/api`.
- Existing `.remember/` is unrelated and must remain untouched.

## Public PGAS Surface Contract

Generated code must import only:

- `@simodelne/pgas-server/plugin.js`
- `@simodelne/pgas-server/create-server.js`
- `@simodelne/pgas-server/client.js`
- `@simodelne/pgas-server/channels/index.js`
- `@simodelne/pgas-server/routes/index.js`
- `@simodelne/pgas-server/testing.js` in tests only

Generated code must not import:

- `@simodelne/pgas-server/api`
- `@simodelne/pgas-runtime`
- `@simodelne/pgas-runtime-core`
- `@simodelne/pgas-contracts`
- `@simodelne/pgas-middleware`
- `@simodelne/pgas-drivers`
- non-exported `@simodelne/pgas-server/src/*` paths

## Work Packages

### Task 1: Tooling Foundation

Files:

- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `src/index.ts`
- `src/cli.ts`
- `src/pgas-new/version.ts`
- `tests/vitest.config.ts`
- `tests/unit/version.test.ts`

Implementation:

- Add TypeScript ESM tooling: `typescript`, `tsx`, `vitest`, `@types/node`.
- Add scripts:
  - `typecheck`: `tsc --noEmit`
  - `test:unit`: `vitest run`
  - `test:legacy`: retain current shell tests only if still meaningful
  - `test`: static/unit/typecheck plus shell gates that are updated for v2
  - `pgas-new`: `tsx src/cli.ts`
- Export constants:
  - `PGAS_SERVER_PACKAGE = "@simodelne/pgas-server"`
  - `PGAS_SERVER_VERSION = "2.10.0"`
  - `PGAS_SERVER_IMPORTS = [...]`
  - `BANNED_IMPORT_PATTERNS = [...]`

TDD:

1. Add `tests/unit/version.test.ts` expecting the version constant to be `2.10.0`, the public imports list to contain all allowed subpaths, and banned patterns to catch v1/private imports.
2. Run `npm run test:unit`; observe failure.
3. Add `src/pgas-new/version.ts`; rerun `npm run test:unit`.

### Task 2: Domain Model And Gates

Files:

- `src/pgas-new/model.ts`
- `src/pgas-new/gates.ts`
- `tests/unit/model.test.ts`
- `tests/unit/gates.test.ts`

Implementation:

- Model governed state:
  - `session`
  - `intake`
  - `notebook`
  - `research`
  - `repo`
  - `program`
  - `artifact_plan`
  - `artifacts`
  - `graduation`
  - `curator_requests`
- Model modes:
  - `intake_intelligence`
  - `repo_targeting`
  - `architecture_design`
  - `scaffold_plan`
  - `branch_write`
  - `static_verify`
  - `live_verify`
  - `rebase_verify`
  - `pr_graduation`
  - `curator_request`
- Implement pure gate helpers:
  - `canTransition(state, from, to)`
  - `legalActionsForMode(state, mode)`
  - `assertActionAllowed(state, mode, action)`
- Enforce:
  - Research requires user confirmation unless the user specifically requested the research task.
  - Existing-repo mode cannot enter `branch_write` without valid `.pgas/wiring.yml`.
  - `live_verify` requires static verification success and configured live-provider test intent.
  - `pr_graduation` requires post-rebase verification success.
  - `curator_request` is legal when manifest is absent/invalid or required repo facility is missing.

TDD:

1. Add tests for each transition and a denial reason test for missing manifest.
2. Add model/gate implementation.
3. Run `npm run test:unit`.

### Task 3: Wiring Manifest Parser

Files:

- `src/pgas-new/wiring-manifest.ts`
- `tests/unit/wiring-manifest.test.ts`
- `templates/pgas-new/repo/.pgas/wiring.yml.tmpl`

Implementation:

- Parse fixed path `.pgas/wiring.yml`.
- Validate required keys:
  - `schema_version`
  - `repo.kind`
  - `repo.package_manager`
  - `pgas.server_package`
  - `pgas.allowed_imports`
  - `paths.programs_dir`
  - `paths.audit_dir`
  - `paths.pgas_new_dir`
  - `registration.strategy`
  - `verification.commands`
  - `curator.github_owner`
  - `curator.github_repo`
- Verify `pgas.server_package` is `@simodelne/pgas-server`.
- Verify allowed imports are a subset of `PGAS_SERVER_IMPORTS`.
- Expose `loadWiringManifest(repoRoot)` returning `{ ok, manifest, errors }`.

TDD:

1. Add fixture strings for valid manifest, missing manifest, wrong package, and private import.
2. Implement parser with `js-yaml`.
3. Run unit tests.

### Task 4: Artifact Planner

Files:

- `src/pgas-new/artifact-plan.ts`
- `tests/unit/artifact-plan.test.ts`

Implementation:

- Generate a typed `ArtifactPlan` before any file write.
- Standalone plan paths:
  - `.pgas/wiring.yml`
  - `.pgas/pgas-new/<slug>/dossier.yml`
  - `.pgas/pgas-new/<slug>/artifacts.json`
  - `package.json`
  - `tsconfig.json`
  - `src/server.ts`
  - `src/repl/index.ts`
  - `src/programs/<slug>/specs.yml`
  - `src/programs/<slug>/registration.ts`
  - `src/programs/<slug>/handlers.ts`
  - `src/programs/<slug>/tools.ts`
  - `tests/spec-load.test.ts`
  - `tests/control-plane.test.ts`
  - `tests/program-deterministic.test.ts`
  - `tests/api-blackbox.test.ts`
  - `tests/live-provider.test.ts`
  - `audit/PGAS-NEW-GRADUATION.md`
- Existing-repo plan paths from manifest:
  - `<paths.programs_dir>/<slug>/specs.yml`
  - `<paths.programs_dir>/<slug>/registration.ts`
  - `<paths.programs_dir>/<slug>/handlers.ts`
  - `<paths.programs_dir>/<slug>/tools.ts`
  - `<paths.pgas_new_dir>/<slug>/dossier.yml`
  - `<paths.pgas_new_dir>/<slug>/artifacts.json`
  - `<paths.audit_dir>/PGAS-NEW-<slug>.md`
  - optional registration patch request declared as metadata, not an uncontrolled edit
- Each artifact must carry `kind`, `path`, `purpose`, `owner`, `mode_introduced`, and `verification`.

TDD:

1. Add tests asserting complete standalone/existing path sets and no frontend/auth/db implementation artifacts.
2. Implement planner.
3. Run unit tests.

### Task 5: Template Renderer

Files:

- `src/pgas-new/template-renderer.ts`
- `templates/pgas-new/standalone/package.json.tmpl`
- `templates/pgas-new/standalone/tsconfig.json.tmpl`
- `templates/pgas-new/standalone/src/server.ts.tmpl`
- `templates/pgas-new/standalone/src/repl/index.ts.tmpl`
- `templates/pgas-new/program/specs.yml.tmpl`
- `templates/pgas-new/program/registration.ts.tmpl`
- `templates/pgas-new/program/handlers.ts.tmpl`
- `templates/pgas-new/program/tools.ts.tmpl`
- `templates/pgas-new/tests/spec-load.test.ts.tmpl`
- `templates/pgas-new/tests/control-plane.test.ts.tmpl`
- `templates/pgas-new/tests/program-deterministic.test.ts.tmpl`
- `templates/pgas-new/tests/api-blackbox.test.ts.tmpl`
- `templates/pgas-new/tests/live-provider.test.ts.tmpl`
- `templates/pgas-new/audit/PGAS-NEW-GRADUATION.md.tmpl`
- `tests/unit/template-renderer.test.ts`
- `tests/static/public-imports.test.ts`

Implementation:

- Render templates using explicit token replacement, failing on missing or unused tokens.
- Generated standalone `package.json` pins `@simodelne/pgas-server` to `^2.10.0`.
- Generated `server.ts` uses `createPgasServer` from `create-server.js`.
- Generated `registration.ts` uses `ProgramEntry`, `createProgramAdapters`, `createToolRegistry`, `loadSpecWithPatterns`, and `enableNotebook` from `plugin.js`.
- Generated REPL uses `controlCliAdapter` from `channels/index.js`.
- Generated API tests use `createPgasClient`, `appTransport`, `fetchTransport`, and `normalizeSessionDomain` from `client.js`.
- Generated deterministic tests use `createTestHarness` from `testing.js`.
- Generated `specs.yml` declares `control_plane`, mode descriptions, legal actions, notebook pins, and the approved mode names.
- Generated tests include a live-provider test that is skipped unless live env vars are set, and clearly records that graduation requires a real provider round trip through the external API.

TDD:

1. Add tests rendering a standalone scaffold into a temp directory.
2. Assert no rendered file contains `{{`.
3. Assert generated files contain required public imports and no banned imports.
4. Assert generated tests include deterministic, API black-box, control-plane, and live-provider gates.
5. Implement renderer/templates.
6. Run unit/static tests.

### Task 6: Existing Repo Attach And Curator Requests

Files:

- `src/pgas-new/existing-repo.ts`
- `src/pgas-new/curator-request.ts`
- `tests/unit/existing-repo.test.ts`
- `tests/unit/curator-request.test.ts`
- `templates/pgas-new/curator/missing-wiring-request.md.tmpl`
- `templates/pgas-new/curator/registration-request.md.tmpl`

Implementation:

- `prepareExistingRepoAttachment(repoRoot, options)`:
  - Reads `.pgas/wiring.yml`.
  - Returns a denied result with curator request content if manifest is missing/invalid.
  - Returns artifact plan if manifest is valid.
- Curator request content must include:
  - target repo
  - missing/invalid requirement
  - binding fixed-path manifest requirement
  - exact action requested
  - no local writes performed
- Registration request content must include the generated artifact plan and requested patch points.

TDD:

1. Add missing manifest test asserting no writes and request text.
2. Add valid manifest test asserting plan only.
3. Implement.
4. Run unit tests.

### Task 7: Verification Runner And Evidence

Files:

- `src/pgas-new/verify.ts`
- `src/pgas-new/command-runner.ts`
- `tests/unit/verify.test.ts`

Implementation:

- Implement a semantic runner with allowlisted operations:
  - `npmInstall`
  - `npmTypecheck`
  - `npmTest`
  - `runGeneratedStaticTests`
  - `gitStatus`
  - `gitRebaseLatest`
  - `ghCreatePr`
- No arbitrary command strings in governed PGAS actions.
- Produce `VerificationEvidence`:
  - command id
  - cwd
  - exit code
  - duration
  - stdout/stderr path or excerpt
  - pass/fail/skip
- Model live-provider evidence separately from static evidence.

TDD:

1. Mock command runner and assert ordered static ladder.
2. Assert live-provider is skipped with explicit reason when env is absent.
3. Assert post-rebase verification must rerun the full static ladder.
4. Implement.
5. Run unit tests.

### Task 8: CLI Surface

Files:

- `src/cli.ts`
- `src/index.ts`
- `tests/unit/cli.test.ts`

Implementation:

- Add CLI commands:
  - `pgas-new version`
  - `pgas-new session new`
  - `pgas-new session abort`
  - `pgas-new session status`
  - `pgas-new session history`
  - `pgas-new session resume`
  - `pgas-new session help`
  - `pgas-new plan-standalone --slug <slug> --name <name>`
  - `pgas-new render-standalone --slug <slug> --name <name> --out <dir>`
  - `pgas-new validate-manifest --repo <dir>`
  - `pgas-new plan-attach --repo <dir> --slug <slug> --name <name>`
  - `pgas-new render-attach --repo <dir> --slug <slug> --name <name>`
  - `pgas-new curator-request --repo <dir> --slug <slug> --name <name>`
- Session commands dispatch through the generated PGAS `control_plane` vocabulary (`ask`, `new`, `abort`, `history`, `status`, `help`) rather than a bespoke parser.
- CLI writes only on explicit `render-standalone` or `render-attach`; existing-repo attach requires a valid fixed-path manifest and refuses overwrites.

TDD:

1. Add CLI tests invoking command handlers directly.
2. Implement CLI command parser without a heavy framework.
3. Run unit tests and typecheck.

### Task 9: Replace Obsolete Shell Gates

Files:

- `tests/plugin-manifest.test.sh`
- `tests/template-render.test.sh`
- `tests/server-typecheck.test.sh`
- `tests/spec-load.test.sh`
- `tests/program-smoke.test.sh`
- `tests/pgas-new-static.test.sh`
- `README.md`
- `.claude-plugin/plugin.json`

Implementation:

- Keep plugin manifest validation but update description from v1 Claude scaffold plugin to `pgas-new` foundry.
- Replace v1 `@simodelne/pgas-server/api` template gates with:
  - render standalone scaffold
  - grep banned imports
  - parse generated `specs.yml`
  - typecheck this package
  - run Vitest suite
- Keep network/package-install gates optional and loud:
  - If `NPM_TOKEN`/GitHub Packages access is available, install generated scaffold and run generated static tests.
  - If unavailable, skip with explicit reason.

TDD:

1. Add failing `tests/pgas-new-static.test.sh` expecting a rendered v2 scaffold.
2. Update package `test` script to run the v2 gate.
3. Remove or retire obsolete v1 shell tests from the default path.
4. Run `npm test`.

### Task 10: Documentation And Audit Trail

Files:

- `README.md`
- `docs/PGAS-NEW-ARCHITECTURE.md`
- `docs/PGAS-NEW-LIVE-GRADUATION.md`
- `MEMORY.md`

Implementation:

- README should say this repository now contains `pgas-new`, a PGAS-specific foundry, not a general coding assistant.
- Document:
  - `.pgas/wiring.yml` fixed path.
  - Public import contract.
  - Modes and gates.
  - User-confirmed research.
  - Notebook as state memory and `ActivationAction` only for static advisory procedures.
  - REPL/control-plane alignment.
  - Static verification now and real-provider live graduation later.
- Do not claim live graduation has passed until the user-selected real-provider test is run.

Verification:

1. `npm run typecheck`
2. `npm run test:unit`
3. `npm test`
4. `node --test` is not required unless added explicitly.
5. If package access is available, run generated scaffold install/typecheck/tests.

## Final Acceptance Criteria

- `pgas-new` package compiles.
- Unit/static tests pass.
- Default `npm test` no longer depends on removed v1 `@simodelne/pgas-server/api`.
- Generated standalone scaffold uses only current PGAS v2 public exports.
- Generated existing-repo attach flow refuses writes without `.pgas/wiring.yml` and emits a curator request.
- Generated scaffold includes deterministic, control-plane, API black-box, and live-provider test files.
- Branch records that live graduation remains pending user selection of the real-provider scenario.
