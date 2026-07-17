import { FIXED_WIRING_MANIFEST_PATH, type PgasNewMode } from './model.js';
import { isSafeRepoRelativePath, type WiringManifest } from './wiring-manifest.js';

export type ArtifactKind =
  | 'manifest'
  | 'dossier'
  | 'metadata'
  | 'package'
  | 'config'
  | 'server'
  | 'repl'
  | 'spec'
  | 'registration'
  | 'contract'
  | 'handler'
  | 'projection'
  | 'frontend'
  | 'export'
  | 'extract'
  | 'stage'
  | 'tool'
  | 'test'
  | 'qc'
  | 'audit';

export interface ProgramIdentity {
  slug: string;
  name: string;
}

const SAFE_PROGRAM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateProgramIdentity(program: ProgramIdentity): ProgramIdentity {
  if (!SAFE_PROGRAM_SLUG.test(program.slug)) {
    throw new Error('invalid --slug: use lowercase letters, numbers, and single hyphens only');
  }

  if (program.name.trim().length === 0) {
    throw new Error('invalid --name: value must not be empty');
  }

  return program;
}

export interface PlannedArtifact {
  kind: ArtifactKind;
  path: string;
  purpose: string;
  owner: 'pgas-new';
  mode_introduced: PgasNewMode;
  verification: string[];
  writeMode?: 'create' | 'update';
}

export interface ArtifactPlan {
  target: 'standalone_repo' | 'existing_repo';
  program: ProgramIdentity;
  artifacts: PlannedArtifact[];
  registration_patch_request?: {
    strategy: string;
    requested: boolean;
  };
}

export interface GeneratedArtifactPlanOptions {
  stageSlugs?: string[];
  includeSmokeTest?: boolean;
  capabilityGaps?: readonly unknown[];
  requestedArtifactPaths?: string[];
  exportSurfaces?: {
    docx?: boolean;
    html?: boolean;
    diff?: boolean;
  };
  documentExtractionSurfaces?: {
    docx?: boolean;
  };
}

export function createStandaloneArtifactPlan(
  program: ProgramIdentity,
  options: GeneratedArtifactPlanOptions = {},
): ArtifactPlan {
  const safeProgram = validateProgramIdentity(program);
  const slug = safeProgram.slug;
  const stageSlugs = safeStageSlugs(options.stageSlugs ?? []);
  return {
    target: 'standalone_repo',
    program: safeProgram,
    artifacts: [
      artifact('manifest', FIXED_WIRING_MANIFEST_PATH, 'Declare repository wiring contract for pgas-new.', 'repo_targeting', [
        'parse-wiring-manifest',
      ]),
      artifact('dossier', `.pgas/pgas-new/${slug}/dossier.yml`, 'Persist intake decisions, user notes, and design dossier.', 'scaffold_plan', [
        'artifact-plan',
      ]),
      artifact('metadata', `.pgas/pgas-new/${slug}/artifacts.json`, 'Record generated artifacts as first-class outputs.', 'scaffold_plan', [
        'artifact-plan',
      ]),
      ...((options.capabilityGaps?.length ?? 0) > 0
        ? [artifact('metadata', 'README.md', 'Document generated host connector gaps and handoff contracts.', 'scaffold_plan', [
            'artifact-plan',
          ])]
        : []),
      artifact('package', 'package.json', 'Define the standalone TypeScript/Node PGAS consumer package.', 'branch_write', [
        'npm-install',
        'typecheck',
      ]),
      artifact('config', 'tsconfig.json', 'Configure strict TypeScript compilation for generated code.', 'branch_write', [
        'typecheck',
      ]),
      artifact('server', 'src/server.ts', 'Bootstrap the standalone PGAS server through the public create-server surface.', 'branch_write', [
        'typecheck',
        'api-blackbox',
      ]),
      artifact('server', 'src/author-driver.ts', 'Opt-in unified native-tools author driver, env-gated behind PGAS_AUTHOR_DRIVER=unified; default (unset) keeps the engine legacy JSON author path.', 'branch_write', [
        'typecheck',
      ]),
      artifact('repl', 'src/repl/index.ts', 'Stream-rendering REPL client using SSE triggers and WebSocket lifecycle events.', 'branch_write', [
        'control-plane-test',
      ]),
      artifact('repl', 'src/repl/renderer.ts', 'Maps PGAS session events to @clack/prompts output — renderAction, renderWidget, renderModeChange, renderError.', 'branch_write', [
        'control-plane-test',
      ]),
      artifact('spec', `src/programs/${slug}/specs.yml`, 'Declare PGAS modes, governance, notebook, and control_plane.', 'branch_write', [
        'spec-load',
      ]),
      artifact('registration', `src/programs/${slug}/registration.ts`, 'Register the PGAS program using public plugin.js helpers.', 'branch_write', [
        'typecheck',
        'program-deterministic',
      ]),
      ...generatedDomainArtifacts(`src/programs/${slug}`, stageSlugs),
      artifact('handler', `src/programs/${slug}/handlers.ts`, 'Implement stubbed action handlers and attachment points.', 'branch_write', [
        'program-deterministic',
      ]),
      artifact('handler', `src/programs/${slug}/handlers/index.ts`, 'Expose generated handlers from the handler directory.', 'branch_write', [
        'program-deterministic',
      ]),
      artifact('handler', `src/programs/${slug}/handlers/_resolver.ts`, 'Resolve handler values from payload overrides or engine-injected domain state.', 'branch_write', [
        'program-deterministic',
      ]),
      artifact('tool', `src/programs/${slug}/tools.ts`, 'Declare semantic repo, git, verification, research, and session tool metadata.', 'branch_write', [
        'typecheck',
      ]),
      ...standaloneExportArtifacts(slug, options.exportSurfaces),
      ...standaloneDocumentExtractionArtifacts(slug, options.documentExtractionSurfaces),
      artifact('test', 'tests/spec-load.test.ts', 'Verify generated specs load through pgas-server testing surfaces.', 'static_verify', [
        'npm-test',
      ]),
      artifact('test', 'tests/control-plane.test.ts', 'Verify REPL/control_plane declarations including session lifecycle commands.', 'static_verify', [
        'npm-test',
      ]),
      artifact('test', 'tests/program-deterministic.test.ts', 'Verify deterministic program behavior without live provider calls.', 'static_verify', [
        'npm-test',
      ]),
      ...(stageSlugs.length > 0 || options.includeSmokeTest === true
        ? [artifact('test', 'tests/generated-program-smoke.test.ts', 'Verify synthesized stage bodies run through the deterministic smoke path without stub output.', 'smoke_verify', [
            'smoke_verify',
            'npm-test',
          ])]
        : []),
      artifact('test', 'tests/api-blackbox.test.ts', 'Verify the external API contract through pgas-server client transports.', 'static_verify', [
        'npm-test',
      ]),
      artifact('test', 'tests/live-provider.test.ts', 'Define the real-provider graduation gate through the external API.', 'live_verify', [
        'live-provider',
      ]),
      artifact('audit', 'audit/PGAS-NEW-GRADUATION.md', 'Record static and live graduation evidence.', 'pr_graduation', [
        'audit-review',
      ]),
    ],
  };
}

export function createExistingRepoArtifactPlan(
  program: ProgramIdentity,
  manifest: WiringManifest,
  options: GeneratedArtifactPlanOptions = {},
): ArtifactPlan {
  const safeProgram = validateProgramIdentity(program);
  if (manifest.repo.kind !== 'existing_repo') {
    throw new Error('repo.kind must be existing_repo for attach planning');
  }
  const slug = safeProgram.slug;
  const stageSlugs = safeStageSlugs(options.stageSlugs ?? []);
  assertSafeManifestDir('paths.programs_dir', manifest.paths.programs_dir);
  assertSafeManifestDir('paths.pgas_new_dir', manifest.paths.pgas_new_dir);
  assertSafeManifestDir('paths.audit_dir', manifest.paths.audit_dir);
  const programsDir = trimSlashes(manifest.paths.programs_dir);
  const pgasNewDir = trimSlashes(manifest.paths.pgas_new_dir);
  const auditDir = trimSlashes(manifest.paths.audit_dir);
  const programPath = `${programsDir}/${slug}`;
  const coreArtifacts = [
    artifact('spec', `${programPath}/specs.yml`, 'Declare the attached PGAS program spec.', 'branch_write', [
      'spec-load',
    ]),
    artifact('registration', `${programPath}/registration.ts`, 'Register the attached PGAS program through public plugin.js helpers.', 'branch_write', [
      'typecheck',
    ]),
    ...existingRepoUserFacingArtifacts(programPath, manifest),
    ...generatedDomainArtifacts(programPath, stageSlugs),
    artifact('export', `${programPath}/export/html.ts`, 'Provide deterministic HTML document export support for the attached program.', 'branch_write', [
      'typecheck',
      'program-deterministic',
    ]),
    artifact('export', `${programPath}/export/docx.ts`, 'Provide deterministic DOCX document export support for the attached program.', 'branch_write', [
      'typecheck',
      'program-deterministic',
    ]),
    artifact('export', `${programPath}/export/diff.ts`, 'Provide deterministic word-level diff token support for attached export surfaces.', 'branch_write', [
      'typecheck',
      'program-deterministic',
    ]),
    ...existingRepoDocumentExtractionArtifacts(programPath, options.documentExtractionSurfaces),
    artifact('handler', `${programPath}/handlers.ts`, 'Implement stubbed program handlers for repo-owned integration.', 'branch_write', [
      'program-deterministic',
    ]),
    artifact('handler', `${programPath}/handlers/index.ts`, 'Expose attached program handlers from the handler directory.', 'branch_write', [
      'program-deterministic',
    ]),
    artifact('handler', `${programPath}/handlers/_resolver.ts`, 'Resolve handler values from payload overrides or engine-injected domain state.', 'branch_write', [
      'program-deterministic',
    ]),
    artifact('tool', `${programPath}/tools.ts`, 'Declare semantic tool metadata for the attached program.', 'branch_write', [
      'typecheck',
    ]),
    artifact('test', `tests/${slug}-deterministic.test.ts`, 'Verify deterministic behavior and requested workflow stages without live provider calls.', 'static_verify', [
      'npm-test',
      'program-deterministic',
    ]),
    ...(stageSlugs.length > 0 || options.includeSmokeTest === true
      ? [artifact('test', 'tests/generated-program-smoke.test.ts', 'Verify synthesized stage bodies run through the deterministic smoke path without stub output.', 'smoke_verify', [
          'smoke_verify',
          'npm-test',
        ])]
      : []),
    artifact('test', 'tests/live-provider.test.ts', 'Define the real-provider graduation gate through the attached repository external API.', 'live_verify', [
      'live-provider',
    ]),
    artifact('qc', `qc/e2e-frontend/${slug}.scenario.yml`, 'Exercise the user-facing frontend projection through the repo QC scenario harness.', 'static_verify', [
      'qc-e2e-frontend',
    ]),
    artifact('qc', `qc/facts/${slug}.facts.yml`, 'Declare deterministic frontend facts and fixtures for the attached program.', 'static_verify', [
      'qc-facts',
    ]),
    artifact(
      'qc',
      'qc/e2e-coverage.yml',
      'Register or update E2E coverage for the attached program frontend workflow.',
      'static_verify',
      ['qc-coverage'],
      { writeMode: 'update' },
    ),
    artifact('dossier', `${pgasNewDir}/${slug}/dossier.yml`, 'Persist pgas-new intake and design notes in the target repo.', 'scaffold_plan', [
      'artifact-plan',
    ]),
    artifact('metadata', `${pgasNewDir}/${slug}/artifacts.json`, 'Record generated attached-repo artifacts.', 'scaffold_plan', [
      'artifact-plan',
    ]),
    artifact('audit', `${auditDir}/PGAS-NEW-${slug}.md`, 'Record attach verification, requested artifacts, and curator requests.', 'pr_graduation', [
      'audit-review',
    ]),
  ];

  return {
    target: 'existing_repo',
    program: safeProgram,
    registration_patch_request: {
      strategy: manifest.registration.strategy,
      requested: true,
    },
    artifacts: uniqueArtifacts([
      ...coreArtifacts,
      ...requestedArtifacts(options.requestedArtifactPaths ?? [], coreArtifacts, programPath),
    ]),
  };
}

function standaloneExportArtifacts(
  slug: string,
  exportSurfaces: GeneratedArtifactPlanOptions['exportSurfaces'],
): PlannedArtifact[] {
  if (!exportSurfaces) {
    return [];
  }
  return [
    ...(exportSurfaces.html
      ? [artifact('export', `src/programs/${slug}/export/html.ts`, 'Provide deterministic HTML document export support.', 'branch_write', [
          'typecheck',
          'program-deterministic',
        ])]
      : []),
    ...(exportSurfaces.docx
      ? [artifact('export', `src/programs/${slug}/export/docx.ts`, 'Provide deterministic DOCX document export support.', 'branch_write', [
          'typecheck',
          'program-deterministic',
        ])]
      : []),
    ...(exportSurfaces.diff
      ? [artifact('export', `src/programs/${slug}/export/diff.ts`, 'Provide deterministic word-level diff token support.', 'branch_write', [
          'typecheck',
          'program-deterministic',
        ])]
      : []),
  ];
}

function standaloneDocumentExtractionArtifacts(
  slug: string,
  surfaces: GeneratedArtifactPlanOptions['documentExtractionSurfaces'],
): PlannedArtifact[] {
  if (!surfaces?.docx) {
    return [];
  }
  return [artifact('extract', `src/programs/${slug}/extract/docx.ts`, 'Provide deterministic DOCX text extraction support.', 'branch_write', [
    'typecheck',
    'program-deterministic',
  ])];
}

function existingRepoDocumentExtractionArtifacts(
  programPath: string,
  surfaces: GeneratedArtifactPlanOptions['documentExtractionSurfaces'],
): PlannedArtifact[] {
  if (!surfaces?.docx) {
    return [];
  }
  return [artifact('extract', `${programPath}/extract/docx.ts`, 'Provide deterministic DOCX text extraction support for the attached program.', 'branch_write', [
    'typecheck',
    'program-deterministic',
  ])];
}

function existingRepoUserFacingArtifacts(programPath: string, manifest: WiringManifest): PlannedArtifact[] {
  if (manifest.registration.strategy !== 'curator_request') {
    return [];
  }

  return [
    artifact('projection', `${programPath}/projection.ts`, 'Expose the attached program state as a user-facing SimoneOS projection.', 'branch_write', [
      'typecheck',
      'frontend-projection',
    ]),
    artifact('frontend', `${programPath}/frontend.spec.yml`, 'Declare the user-facing SimoneOS frontend surface for the attached program.', 'branch_write', [
      'frontend-spec',
      'typecheck',
    ]),
  ];
}

function generatedDomainArtifacts(programPath: string, stageSlugs: string[]): PlannedArtifact[] {
  if (stageSlugs.length === 0) {
    return [];
  }

  return [
    artifact('contract', `${programPath}/contracts.ts`, 'Declare frozen StageInput, StageRuntime, StageOutput, classification, and action contracts for synthesized domain bodies.', 'domain_synthesis', [
      'typecheck',
      'smoke_verify',
    ]),
    ...stageSlugs.map((stageSlug) =>
      artifact('stage', `${programPath}/stages/${stageSlug}.ts`, `Implement accepted synthesized domain logic for the ${stageSlug} stage.`, 'domain_synthesis', [
        'stage-verify',
        'typecheck',
        'smoke_verify',
      ]),
    ),
  ];
}

function artifact(
  kind: ArtifactKind,
  path: string,
  purpose: string,
  mode_introduced: PgasNewMode,
  verification: string[],
  options: { writeMode?: PlannedArtifact['writeMode'] } = {},
): PlannedArtifact {
  return {
    kind,
    path,
    purpose,
    owner: 'pgas-new',
    mode_introduced,
    verification,
    ...(options.writeMode ? { writeMode: options.writeMode } : {}),
  };
}

function requestedArtifacts(paths: string[], existingArtifacts: PlannedArtifact[], programPath: string): PlannedArtifact[] {
  const existingPaths = new Set(existingArtifacts.map((artifact) => artifact.path));
  return safeRequestedArtifactPaths(paths, programPath)
    .filter((path) => !existingPaths.has(path))
    .map((path) =>
      artifact(
        kindForRequestedArtifact(path),
        path,
        'Preserve explicit user-required artifact from intake, notebook, or scaffold-plan rejection feedback.',
        modeForRequestedArtifact(path),
        verificationForRequestedArtifact(path),
      ),
    );
}

function safeRequestedArtifactPaths(paths: string[], programPath: string): string[] {
  const seen = new Set<string>();
  const safePaths: string[] = [];
  for (const rawPath of paths) {
    const path = reconcileExistingRepoRequestedPath(trimSlashes(rawPath.trim()), programPath);
    if (!path) continue;
    if (path.length === 0) continue;
    if (!isSafeRepoRelativePath(path)) {
      throw new Error(`requested artifact path must be a safe repo-relative path: ${rawPath}`);
    }
    if (seen.has(path)) continue;
    seen.add(path);
    safePaths.push(path);
  }
  return safePaths;
}

function reconcileExistingRepoRequestedPath(path: string, programPath: string): string | undefined {
  if (path === FIXED_WIRING_MANIFEST_PATH) {
    return undefined;
  }
  if (isProgramRelativeArtifactPath(path)) {
    return `${programPath}/${path}`;
  }
  return path;
}

function isProgramRelativeArtifactPath(path: string): boolean {
  return path === 'projection.ts'
    || path === 'frontend.spec.yml'
    || path === 'specs.yml'
    || path === 'registration.ts'
    || path === 'contracts.ts'
    || path === 'handlers.ts'
    || path === 'tools.ts'
    || /^export\/[^/]+\.ts$/u.test(path)
    || /^extract\/[^/]+\.ts$/u.test(path)
    || /^stages\/[^/]+\.ts$/u.test(path)
    || /^handlers\/[^/]+\.ts$/u.test(path);
}

function uniqueArtifacts(artifacts: PlannedArtifact[]): PlannedArtifact[] {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    if (seen.has(artifact.path)) return false;
    seen.add(artifact.path);
    return true;
  });
}

function kindForRequestedArtifact(path: string): ArtifactKind {
  if (path.includes('/projection.') || path.endsWith('/projection.ts')) return 'projection';
  if (path.includes('frontend')) return 'frontend';
  if (path.includes('/extract/')) return 'extract';
  if (path.includes('/export/') || path.includes('docx') || path.includes('html')) return 'export';
  if (path.startsWith('qc/')) return 'qc';
  if (path.startsWith('tests/')) return 'test';
  if (path.includes('/stages/')) return 'stage';
  if (path.endsWith('/contracts.ts')) return 'contract';
  if (path.endsWith('/handlers.ts') || path.includes('/handlers/')) return 'handler';
  if (path.endsWith('/tools.ts')) return 'tool';
  if (path.endsWith('/specs.yml')) return 'spec';
  if (path.endsWith('/registration.ts')) return 'registration';
  if (path.startsWith('audit/')) return 'audit';
  return 'metadata';
}

function modeForRequestedArtifact(path: string): PgasNewMode {
  if (path.startsWith('qc/') || path.startsWith('tests/')) return 'static_verify';
  if (path.startsWith('audit/')) return 'pr_graduation';
  if (path.startsWith('.pgas/')) return 'scaffold_plan';
  if (path.includes('/stages/') || path.endsWith('/contracts.ts')) return 'domain_synthesis';
  return 'branch_write';
}

function verificationForRequestedArtifact(path: string): string[] {
  if (path.startsWith('qc/')) return ['qc'];
  if (path.startsWith('tests/')) return ['npm-test'];
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return ['typecheck'];
  if (path.startsWith('audit/')) return ['audit-review'];
  return ['artifact-plan'];
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

function safeStageSlugs(stageSlugs: string[]): string[] {
  const safeStageSlug = /^[a-z0-9_]+$/;
  const seen = new Set<string>();
  return stageSlugs.map((stageSlug) => {
    if (!safeStageSlug.test(stageSlug)) {
      throw new Error(`invalid synthesized stage slug: ${stageSlug}`);
    }
    if (seen.has(stageSlug)) {
      throw new Error(`duplicate synthesized stage slug: ${stageSlug}`);
    }
    seen.add(stageSlug);
    return stageSlug;
  });
}

function assertSafeManifestDir(label: string, path: string): void {
  if (!isSafeRepoRelativePath(path)) {
    throw new Error(`${label} must be a safe repo-relative path`);
  }
}
