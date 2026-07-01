import { describe, expect, it } from 'vitest';
import { createExistingRepoArtifactPlan, createStandaloneArtifactPlan } from '../../src/pgas-new/artifact-plan.js';
import type { WiringManifest } from '../../src/pgas-new/wiring-manifest.js';

const MANIFEST: WiringManifest = {
  schema_version: 1,
  repo: { kind: 'existing_repo', package_manager: 'npm' },
  pgas: {
    server_package: '@simodelne/pgas-server',
    allowed_imports: [
      '@simodelne/pgas-server/plugin.js',
      '@simodelne/pgas-server/create-server.js',
      '@simodelne/pgas-server/client.js',
      '@simodelne/pgas-server/channels/index.js',
      '@simodelne/pgas-server/routes/index.js',
    ],
  },
  paths: {
    programs_dir: 'programs',
    audit_dir: 'audit',
    pgas_new_dir: '.pgas/pgas-new',
  },
  registration: { strategy: 'curator_request' },
  verification: {
    commands: {
      install: 'npm install --no-audit --no-fund',
      typecheck: 'npm run typecheck',
      test: 'npm test',
    },
  },
  curator: {
    github_owner: 'simodelne',
    github_repo: 'simoneos',
  },
};

describe('artifact planner', () => {
  it('plans the complete standalone scaffold before writes', () => {
    const plan = createStandaloneArtifactPlan({ slug: 'pgas-new', name: 'PGAS New' }, {
      stageSlugs: ['triage'],
    });

    expect(plan.target).toBe('standalone_repo');
    expect(plan.program.slug).toBe('pgas-new');
    expect(plan.artifacts.map((artifact) => artifact.path)).toEqual([
      '.pgas/wiring.yml',
      '.pgas/pgas-new/pgas-new/dossier.yml',
      '.pgas/pgas-new/pgas-new/artifacts.json',
      'package.json',
      'tsconfig.json',
      'src/server.ts',
      'src/repl/index.ts',
      'src/repl/renderer.ts',
      'src/programs/pgas-new/specs.yml',
      'src/programs/pgas-new/registration.ts',
      'src/programs/pgas-new/contracts.ts',
      'src/programs/pgas-new/stages/triage.ts',
      'src/programs/pgas-new/handlers.ts',
      'src/programs/pgas-new/handlers/index.ts',
      'src/programs/pgas-new/handlers/_resolver.ts',
      'src/programs/pgas-new/tools.ts',
      'tests/spec-load.test.ts',
      'tests/control-plane.test.ts',
      'tests/program-deterministic.test.ts',
      'tests/generated-program-smoke.test.ts',
      'tests/api-blackbox.test.ts',
      'tests/live-provider.test.ts',
      'audit/PGAS-NEW-GRADUATION.md',
    ]);
  });

  it('plans existing-repo artifacts from the binding manifest paths', () => {
    const plan = createExistingRepoArtifactPlan({ slug: 'review', name: 'Review' }, MANIFEST);

    expect(plan.target).toBe('existing_repo');
    expect(plan.registration_patch_request).toEqual({
      strategy: 'curator_request',
      requested: true,
    });
    expect(plan.artifacts.map((artifact) => artifact.path)).toEqual([
      'programs/review/specs.yml',
      'programs/review/registration.ts',
      'programs/review/projection.ts',
      'programs/review/frontend.spec.yml',
      'programs/review/export/html.ts',
      'programs/review/export/docx.ts',
      'programs/review/handlers.ts',
      'programs/review/handlers/index.ts',
      'programs/review/handlers/_resolver.ts',
      'programs/review/tools.ts',
      'tests/review-deterministic.test.ts',
      'tests/live-provider.test.ts',
      'qc/e2e-frontend/review.scenario.yml',
      'qc/facts/review.facts.yml',
      'qc/e2e-coverage.yml',
      '.pgas/pgas-new/review/dossier.yml',
      '.pgas/pgas-new/review/artifacts.json',
      'audit/PGAS-NEW-review.md',
    ]);
  });

  it('marks only explicit existing-repo registration artifacts as update-mode', () => {
    const plan = createExistingRepoArtifactPlan({ slug: 'review', name: 'Review' }, MANIFEST);

    expect(plan.artifacts.filter((artifact) => artifact.writeMode === 'update').map((artifact) => artifact.path)).toEqual([
      'qc/e2e-coverage.yml',
    ]);
    expect(plan.artifacts.find((artifact) => artifact.path === 'programs/review/specs.yml')?.writeMode).toBeUndefined();
  });

  it('includes SimoneOS user-facing and requested stage artifacts for existing repos', () => {
    const plan = createExistingRepoArtifactPlan({ slug: 'minutes-drafter', name: 'Minutes Drafter' }, MANIFEST, {
      stageSlugs: ['transcript_review', 'section_drafting', 'final_review', 'complete', 'blocked'],
    });

    const paths = plan.artifacts.map((artifact) => artifact.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'programs/minutes-drafter/projection.ts',
        'programs/minutes-drafter/frontend.spec.yml',
        'programs/minutes-drafter/stages/transcript_review.ts',
        'programs/minutes-drafter/stages/section_drafting.ts',
        'programs/minutes-drafter/stages/final_review.ts',
        'programs/minutes-drafter/stages/complete.ts',
        'programs/minutes-drafter/stages/blocked.ts',
        'programs/minutes-drafter/export/html.ts',
        'programs/minutes-drafter/export/docx.ts',
        'tests/minutes-drafter-deterministic.test.ts',
        'qc/e2e-frontend/minutes-drafter.scenario.yml',
        'qc/facts/minutes-drafter.facts.yml',
        'qc/e2e-coverage.yml',
        'audit/PGAS-NEW-minutes-drafter.md',
      ]),
    );
  });

  it('plans generated smoke verification for existing-repo programs with stages', () => {
    const plan = createExistingRepoArtifactPlan({ slug: 'review', name: 'Review' }, MANIFEST, {
      stageSlugs: ['triage'],
    });

    expect(plan.artifacts.find((artifact) => artifact.path === 'tests/generated-program-smoke.test.ts')).toMatchObject({
      kind: 'test',
      mode_introduced: 'smoke_verify',
      verification: expect.arrayContaining(['smoke_verify', 'npm-test']),
    });
  });

  it('plans live-provider verification for existing-repo graduation', () => {
    const plan = createExistingRepoArtifactPlan({ slug: 'review', name: 'Review' }, MANIFEST);

    expect(plan.artifacts.find((artifact) => artifact.path === 'tests/live-provider.test.ts')).toMatchObject({
      kind: 'test',
      mode_introduced: 'live_verify',
      verification: ['live-provider'],
    });
  });

  it('rejects unsafe manifest paths before planning writes', () => {
    const unsafeProgramsDir: WiringManifest = {
      ...MANIFEST,
      paths: { ...MANIFEST.paths, programs_dir: '../programs' },
    };
    expect(() => createExistingRepoArtifactPlan({ slug: 'review', name: 'Review' }, unsafeProgramsDir)).toThrow(
      /paths\.programs_dir must be a safe repo-relative path/,
    );

    const unsafePgasNewDir: WiringManifest = {
      ...MANIFEST,
      paths: { ...MANIFEST.paths, pgas_new_dir: '/etc/pgas' },
    };
    expect(() => createExistingRepoArtifactPlan({ slug: 'review', name: 'Review' }, unsafePgasNewDir)).toThrow(
      /paths\.pgas_new_dir must be a safe repo-relative path/,
    );

    const unsafeAuditDir: WiringManifest = {
      ...MANIFEST,
      paths: { ...MANIFEST.paths, audit_dir: '../../audit' },
    };
    expect(() => createExistingRepoArtifactPlan({ slug: 'review', name: 'Review' }, unsafeAuditDir)).toThrow(
      /paths\.audit_dir must be a safe repo-relative path/,
    );
  });

  it('requires an existing-repo wiring manifest for attach planning', () => {
    expect(() =>
      createExistingRepoArtifactPlan(
        { slug: 'review', name: 'Review' },
        { ...MANIFEST, repo: { ...MANIFEST.repo, kind: 'standalone_repo' } },
      ),
    ).toThrow(/repo.kind must be existing_repo/);
  });

  it('marks every artifact with ownership, mode, purpose, and verification metadata', () => {
    const plan = createStandaloneArtifactPlan({ slug: 'pgas-new', name: 'PGAS New' }, {
      stageSlugs: ['triage'],
    });

    for (const artifact of plan.artifacts) {
      expect(artifact.kind).toMatch(/^(manifest|dossier|metadata|package|config|server|repl|spec|registration|contract|handler|stage|tool|test|audit)$/);
      expect(artifact.owner).toBe('pgas-new');
      expect(artifact.mode_introduced).toMatch(/^(repo_targeting|scaffold_plan|domain_synthesis|branch_write|static_verify|smoke_verify|live_verify|pr_graduation)$/);
      expect(artifact.purpose.length).toBeGreaterThan(0);
      expect(artifact.verification.length).toBeGreaterThan(0);
    }
  });

  it('does not plan frontend, auth, database, or external-service implementations', () => {
    const standalonePaths = createStandaloneArtifactPlan({ slug: 'pgas-new', name: 'PGAS New' }).artifacts.map((artifact) => artifact.path);
    const existingPaths = createExistingRepoArtifactPlan({ slug: 'review', name: 'Review' }, MANIFEST).artifacts.map((artifact) => artifact.path);

    expect(standalonePaths.some((path) => path.includes('frontend'))).toBe(false);
    expect(existingPaths.some((path) => path.includes('frontend'))).toBe(true);
    const allPaths = [...standalonePaths, ...existingPaths];
    expect(allPaths.some((path) => path.includes('/auth/') || path.startsWith('auth/'))).toBe(false);
    expect(allPaths.some((path) => path.includes('/db/') || path.startsWith('db/'))).toBe(false);
    expect(allPaths.some((path) => path.includes('external-service'))).toBe(false);
  });
});
