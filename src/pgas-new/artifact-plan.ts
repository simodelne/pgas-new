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
  | 'handler'
  | 'tool'
  | 'test'
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

export function createStandaloneArtifactPlan(program: ProgramIdentity): ArtifactPlan {
  const safeProgram = validateProgramIdentity(program);
  const slug = safeProgram.slug;
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
      artifact('repl', 'src/repl/index.ts', 'Expose the control-plane CLI REPL using controlCliAdapter.', 'branch_write', [
        'control-plane-test',
      ]),
      artifact('spec', `src/programs/${slug}/specs.yml`, 'Declare PGAS modes, governance, notebook, and control_plane.', 'branch_write', [
        'spec-load',
      ]),
      artifact('registration', `src/programs/${slug}/registration.ts`, 'Register the PGAS program using public plugin.js helpers.', 'branch_write', [
        'typecheck',
        'program-deterministic',
      ]),
      artifact('handler', `src/programs/${slug}/handlers.ts`, 'Implement stubbed action handlers and attachment points.', 'branch_write', [
        'program-deterministic',
      ]),
      artifact('tool', `src/programs/${slug}/tools.ts`, 'Declare semantic repo, git, verification, research, and session tool metadata.', 'branch_write', [
        'typecheck',
      ]),
      artifact('test', 'tests/spec-load.test.ts', 'Verify generated specs load through pgas-server testing surfaces.', 'static_verify', [
        'npm-test',
      ]),
      artifact('test', 'tests/control-plane.test.ts', 'Verify REPL/control_plane declarations including session lifecycle commands.', 'static_verify', [
        'npm-test',
      ]),
      artifact('test', 'tests/program-deterministic.test.ts', 'Verify deterministic program behavior without live provider calls.', 'static_verify', [
        'npm-test',
      ]),
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

export function createExistingRepoArtifactPlan(program: ProgramIdentity, manifest: WiringManifest): ArtifactPlan {
  const safeProgram = validateProgramIdentity(program);
  if (manifest.repo.kind !== 'existing_repo') {
    throw new Error('repo.kind must be existing_repo for attach planning');
  }
  const slug = safeProgram.slug;
  assertSafeManifestDir('paths.programs_dir', manifest.paths.programs_dir);
  assertSafeManifestDir('paths.pgas_new_dir', manifest.paths.pgas_new_dir);
  assertSafeManifestDir('paths.audit_dir', manifest.paths.audit_dir);
  const programsDir = trimSlashes(manifest.paths.programs_dir);
  const pgasNewDir = trimSlashes(manifest.paths.pgas_new_dir);
  const auditDir = trimSlashes(manifest.paths.audit_dir);

  return {
    target: 'existing_repo',
    program: safeProgram,
    registration_patch_request: {
      strategy: manifest.registration.strategy,
      requested: true,
    },
    artifacts: [
      artifact('spec', `${programsDir}/${slug}/specs.yml`, 'Declare the attached PGAS program spec.', 'branch_write', [
        'spec-load',
      ]),
      artifact('registration', `${programsDir}/${slug}/registration.ts`, 'Register the attached PGAS program through public plugin.js helpers.', 'branch_write', [
        'typecheck',
      ]),
      artifact('handler', `${programsDir}/${slug}/handlers.ts`, 'Implement stubbed program handlers for repo-owned integration.', 'branch_write', [
        'program-deterministic',
      ]),
      artifact('tool', `${programsDir}/${slug}/tools.ts`, 'Declare semantic tool metadata for the attached program.', 'branch_write', [
        'typecheck',
      ]),
      artifact('dossier', `${pgasNewDir}/${slug}/dossier.yml`, 'Persist pgas-new intake and design notes in the target repo.', 'scaffold_plan', [
        'artifact-plan',
      ]),
      artifact('metadata', `${pgasNewDir}/${slug}/artifacts.json`, 'Record generated attached-repo artifacts.', 'scaffold_plan', [
        'artifact-plan',
      ]),
      artifact('audit', `${auditDir}/PGAS-NEW-${slug}.md`, 'Record attach verification and curator requests.', 'pr_graduation', [
        'audit-review',
      ]),
    ],
  };
}

function artifact(
  kind: ArtifactKind,
  path: string,
  purpose: string,
  mode_introduced: PgasNewMode,
  verification: string[],
): PlannedArtifact {
  return {
    kind,
    path,
    purpose,
    owner: 'pgas-new',
    mode_introduced,
    verification,
  };
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

function assertSafeManifestDir(label: string, path: string): void {
  if (!isSafeRepoRelativePath(path)) {
    throw new Error(`${label} must be a safe repo-relative path`);
  }
}
