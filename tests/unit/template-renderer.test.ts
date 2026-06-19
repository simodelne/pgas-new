import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { createStandaloneArtifactPlan } from '../../src/pgas-new/artifact-plan.js';
import { PGAS_NEW_CONTROL_PLANE_CONTROLS } from '../../src/pgas-new/control-plane.js';
import {
  renderExistingRepoAttachment,
  renderStandaloneScaffold,
  renderTemplate,
} from '../../src/pgas-new/template-renderer.js';
import type { WiringManifest } from '../../src/pgas-new/wiring-manifest.js';

const VALID_MANIFEST: WiringManifest = {
  schema_version: 1,
  repo: { kind: 'existing_repo' as const, package_manager: 'npm' as const },
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
      typecheck: 'npm run build',
      test: 'npm test',
    },
  },
  curator: { github_owner: 'simodelne', github_repo: 'simoneos' },
};

describe('template renderer', () => {
  it('fails on missing and unused tokens', () => {
    expect(() => renderTemplate('hello {{NAME}}', {})).toThrow(/missing template token: NAME/);
    expect(() => renderTemplate('hello', { NAME: 'pgas-new' })).toThrow(/unused template token: NAME/);
    expect(() => renderTemplate('hello {{Slug}}', {})).toThrow(/unrendered template token remains/);
    expect(renderTemplate('hello {{NAME}}', { NAME: 'pgas-new' })).toBe('hello pgas-new');
  });

  it('refuses to overwrite existing planned artifacts in outDir', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pgas-new-overwrite-'));
    try {
      // Pre-create a file at one of the planned output paths.
      const collisionPath = join(outDir, 'package.json');
      const sentinel = '{"existing":"user-content"}';
      mkdirSync(outDir, { recursive: true });
      writeFileSync(collisionPath, sentinel);

      expect(() => renderStandaloneScaffold({ outDir, slug: 'pgas-new', name: 'PGAS New' })).toThrow(
        /refusing to overwrite/,
      );
      expect(readFileSync(collisionPath, 'utf8')).toBe(sentinel);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('renders the standalone scaffold with every planned artifact', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pgas-new-render-'));
    try {
      const result = renderStandaloneScaffold({
        outDir,
        slug: 'pgas-new',
        name: 'PGAS New',
        githubOwner: 'simodelne',
        githubRepo: 'pgas-new',
      });

      const planned = createStandaloneArtifactPlan({ slug: 'pgas-new', name: 'PGAS New' });
      expect(result.plan.artifacts.map((artifact) => artifact.path)).toEqual(
        planned.artifacts.map((artifact) => artifact.path),
      );
      expect(result.written).toEqual(planned.artifacts.map((artifact) => artifact.path));

      for (const artifact of planned.artifacts) {
        const body = readFileSync(join(outDir, artifact.path), 'utf8');
        expect(body).not.toContain('{{');
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('renders required public PGAS v2 imports and no banned imports', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pgas-new-imports-'));
    try {
      renderStandaloneScaffold({ outDir, slug: 'pgas-new', name: 'PGAS New' });
      const registration = readFileSync(join(outDir, 'src/programs/pgas-new/registration.ts'), 'utf8');
      const server = readFileSync(join(outDir, 'src/server.ts'), 'utf8');
      const repl = readFileSync(join(outDir, 'src/repl/index.ts'), 'utf8');
      const apiTest = readFileSync(join(outDir, 'tests/api-blackbox.test.ts'), 'utf8');
      const liveTest = readFileSync(join(outDir, 'tests/live-provider.test.ts'), 'utf8');
      const deterministicTest = readFileSync(join(outDir, 'tests/program-deterministic.test.ts'), 'utf8');

      expect(readFileSync(join(outDir, 'package.json'), 'utf8')).toContain('"@simodelne/pgas-server": "^2.10.0"');
      expect(server).toContain("from '@simodelne/pgas-server/create-server.js'");
      expect(registration).toContain("from '@simodelne/pgas-server/plugin.js'");
      expect(registration).toContain('type ProgramEntry');
      expect(registration).toContain('createProgramAdapters');
      expect(registration).toContain('createToolRegistry');
      expect(registration).toContain('loadSpecWithPatterns');
      expect(registration).toContain('enableNotebook');
      expect(repl).toContain("from '@simodelne/pgas-server/channels/index.js'");
      expect(repl).toContain('controlCliAdapter');
      expect(apiTest).toContain("from '@simodelne/pgas-server/client.js'");
      expect(apiTest).toContain('createPgasClient');
      expect(apiTest).toContain('appTransport');
      expect(apiTest).toContain('fetchTransport');
      expect(apiTest).toContain('normalizeSessionDomain');
      expect(apiTest).toContain('await client.programs.list()');
      expect(apiTest).toContain('await client.sessions.create');
      expect(apiTest).toContain('await client.sessions.get');
      expect(apiTest).toContain('await client.sessions.world');
      expect(liveTest).toContain('await client.sessions.create');
      expect(liveTest).toContain('await client.sessions.trigger');
      expect(liveTest).toContain('await client.sessions.get');
      expect(liveTest).toContain('await client.sessions.rounds');
      expect(deterministicTest).toContain("from '@simodelne/pgas-server/testing.js'");
      expect(deterministicTest).toContain('createTestHarness');

      const renderedText = [registration, server, repl, apiTest, deterministicTest].join('\n');
      expect(renderedText).not.toMatch(/@simodelne\/pgas-server\/api/);
      expect(renderedText).not.toMatch(/@simodelne\/pgas-server\/src/);
      expect(renderedText).not.toMatch(/@simodelne\/pgas-runtime/);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('declares control-plane session commands, modes, notebook pins, and verification gates', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pgas-new-spec-'));
    try {
      renderStandaloneScaffold({ outDir, slug: 'pgas-new', name: 'PGAS New' });
      const spec = readFileSync(join(outDir, 'src/programs/pgas-new/specs.yml'), 'utf8');
      const tests = [
        'tests/spec-load.test.ts',
        'tests/control-plane.test.ts',
        'tests/program-deterministic.test.ts',
        'tests/api-blackbox.test.ts',
        'tests/live-provider.test.ts',
      ].map((path) => readFileSync(join(outDir, path), 'utf8'));

      for (const mode of [
        'intake_intelligence',
        'repo_targeting',
        'architecture_design',
        'scaffold_plan',
        'branch_write',
        'static_verify',
        'live_verify',
        'rebase_verify',
        'pr_graduation',
        'curator_request',
      ]) {
        expect(spec).toContain(`${mode}:`);
      }
      for (const control of ['ask:', 'abort:', 'new:', 'history:', 'status:', 'resume:', 'help:']) {
        expect(spec).toContain(control);
      }
      expect(spec).toContain('control_plane:');
      expect(spec).toContain('notebook.entries');
      expect(spec).toContain('notebook.pins');
      expect(spec).toContain('pin_notebook_note');
      expect(spec).toContain('confirm_research_scope');
      expect(spec).toContain('record_user_requested_research');
      expect(spec).toContain('session_abort_current');
      expect(spec).toContain('authorize_existing_repo_target');
      expect(spec).toContain('confirm_live_provider_intent');
      expect(spec).toContain('run_rebase_static_verification');
      expect(tests.join('\n')).toContain('real provider round trip through the external API');
      expect(tests.join('\n')).toContain('PGAS_LIVE_PROVIDER');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('renders policy-drafting artifacts into manifest paths for existing repo attachments', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'pgas-new-attached-policy-'));
    try {
      const result = renderExistingRepoAttachment({
        repoRoot,
        manifest: VALID_MANIFEST,
        slug: 'draft-policy',
        name: 'Draft Policy',
        template: 'policy-drafting',
        mandate:
          'risk-based policy drafting; intake policy objectives/type/org/risk appetite/resources/audience/jurisdiction; outline approval before section-by-section drafting; Word + HTML rendering; editing/revision like SimoneOS contract draft',
      });

      expect(result.written).toEqual([
        'programs/draft-policy/specs.yml',
        'programs/draft-policy/registration.ts',
        'programs/draft-policy/handlers.ts',
        'programs/draft-policy/tools.ts',
        '.pgas/pgas-new/draft-policy/dossier.yml',
        '.pgas/pgas-new/draft-policy/artifacts.json',
        'audit/PGAS-NEW-draft-policy.md',
      ]);

      const spec = readFileSync(join(repoRoot, 'programs/draft-policy/specs.yml'), 'utf8');
      const parsed = load(spec) as {
        channels: Record<string, { structured_decision?: boolean }>;
        control_plane: { controls: Record<string, unknown>; version: number };
        guidance: Record<string, string[]>;
        ingestion: Record<string, string[]>;
        modes: Record<string, {
          preconditions?: Record<string, Array<{ kind: string; path?: string; value?: unknown; triggerSet?: string[] }>>;
        }>;
        projection: Record<string, { include: string[] }>;
        schema: Record<string, string>;
      };
      const tools = readFileSync(join(repoRoot, 'programs/draft-policy/tools.ts'), 'utf8');
      const artifacts = readFileSync(join(repoRoot, '.pgas/pgas-new/draft-policy/artifacts.json'), 'utf8');

      expect(spec).toContain('risk-based policy drafting');
      expect(spec).toContain('policy_objectives');
      expect(spec).toContain('risk_appetite');
      expect(spec).toContain('approve_outline');
      expect(spec).toContain('draft_section');
      expect(spec).toContain('render_policy_outputs');
      expect(spec).toContain('outputs.html');
      expect(spec).toContain('outputs.word');
      expect(parsed.control_plane.version).toBe(1);
      expect(Object.keys(parsed.control_plane.controls)).toEqual(
        expect.arrayContaining([...PGAS_NEW_CONTROL_PLANE_CONTROLS]),
      );
      expect(parsed.channels.user_confirmation.structured_decision).toBe(true);
      expect(parsed.ingestion.user_confirmation).toEqual([
        'inputs.user_decision.decision',
        'inputs.user_decision.instruction',
        'inputs.user_decision.note_mode',
        'inputs.user_decision.timestamp',
      ]);
      expect(parsed.projection.intake.include).toEqual(expect.arrayContaining(['inputs.user_text']));
      expect(parsed.projection.outline.include).toEqual(
        expect.arrayContaining(['inputs.user_text', 'inputs.user_decision', 'inputs.user_decision.decision', 'inputs.user_decision.instruction']),
      );
      expect(parsed.projection.drafting.include).toEqual(expect.arrayContaining(['inputs.user_text']));
      expect(parsed.projection.revision.include).toEqual(expect.arrayContaining(['inputs.user_text']));
      expect(parsed.guidance.intake).toEqual(expect.arrayContaining([expect.stringContaining('collect_structured_data')]));
      expect(parsed.guidance.outline).toEqual(expect.arrayContaining([expect.stringContaining('never call record_user_note')]));
      expect(parsed.schema['intake.fields']).toBe('object');
      expect(parsed.schema['inputs.user_decision.decision']).toBe('string');
      expect(parsed.schema['inputs.user_decision.instruction']).toBe('string');
      expect(parsed.modes.outline.preconditions?.approve_outline).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'TriggerType', triggerSet: ['user_confirmation'] }),
          expect.objectContaining({ kind: 'FieldEquals', path: 'inputs.user_decision.decision', value: 'approve' }),
          expect.objectContaining({ kind: 'FieldTruthy', path: 'outline.sections' }),
        ]),
      );
      expect(parsed.modes.drafting.preconditions?.render_policy_outputs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'FieldTruthy', path: 'draft.sections' }),
        ]),
      );
      expect(parsed.modes.revision.preconditions?.render_policy_outputs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'FieldTruthy', path: 'draft.sections' }),
        ]),
      );
      expect(parsed.schema['outline.sections']).toBe('object');
      expect(parsed.schema['outputs.html']).toBe('object');
      expect(parsed.schema['outputs.word']).toBe('object');
      expect(tools).toContain('revise_section');
      expect(artifacts).toContain('programs/draft-policy/specs.yml');
      expect(artifacts).not.toContain('{{');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('renders generated write-safety gates for existing repo attachments', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pgas-new-gates-'));
    try {
      renderStandaloneScaffold({ outDir, slug: 'pgas-new', name: 'PGAS New' });
      const spec = readFileSync(join(outDir, 'src/programs/pgas-new/specs.yml'), 'utf8');
      const parsed = load(spec) as {
        modes: Record<string, {
          preconditions?: Record<string, Array<{ kind: string; path: string; value?: unknown }>>;
          transitions?: Array<{ target: string; guard?: { kind: string; path: string; value?: unknown } }>;
        }>;
        action_map: Record<string, { mutations?: Array<{ path: string; value?: unknown; from_arg?: string }> }>;
        proceed_to: Record<string, string>;
        schema: Record<string, string>;
        control_plane: { controls: Record<string, unknown> };
      };

      expect(Object.keys(parsed.control_plane.controls)).toEqual(expect.arrayContaining([...PGAS_NEW_CONTROL_PLANE_CONTROLS]));
      expect(parsed.schema['repo.write_authorized']).toBe('boolean');
      expect(parsed.schema['repo.wiring_manifest.path']).toBe('string');
      expect(parsed.schema['intake.research_allowed']).toBe('boolean');
      expect(parsed.schema['graduation.static_evidence_id']).toBe('string');
      expect(parsed.schema['graduation.ready_for_live']).toBe('boolean');
      expect(parsed.schema['graduation.rebase_static_evidence_id']).toBe('string');
      expect(parsed.proceed_to.load_wiring_manifest).toBeUndefined();
      expect(parsed.proceed_to.authorize_existing_repo_target).toBe('architecture_design');
      expect(parsed.proceed_to.run_static_verification).toBeUndefined();
      expect(parsed.proceed_to.confirm_live_provider_intent).toBe('live_verify');
      expect(parsed.proceed_to.run_rebase_static_verification).toBe('pr_graduation');
      expect(parsed.modes.intake_intelligence.preconditions?.web_research).toEqual(
        expect.arrayContaining([{ kind: 'FieldTruthy', path: 'intake.research_allowed' }]),
      );
      expect(parsed.modes.architecture_design.preconditions?.web_research).toEqual(
        expect.arrayContaining([{ kind: 'FieldTruthy', path: 'intake.research_allowed' }]),
      );
      expect(parsed.modes.repo_targeting.preconditions?.authorize_existing_repo_target).toEqual(
        expect.arrayContaining([
          { kind: 'FieldEquals', path: 'repo.wiring_manifest.status', value: 'valid' },
          { kind: 'FieldEquals', path: 'repo.wiring_manifest.path', value: '.pgas/wiring.yml' },
        ]),
      );
      expect(parsed.modes.scaffold_plan.preconditions?.approve_artifact_plan).toEqual(
        expect.arrayContaining([{ kind: 'FieldTruthy', path: 'repo.write_authorized' }]),
      );
      expect(parsed.modes.branch_write.preconditions?.write_scaffold_artifacts).toEqual(
        expect.arrayContaining([
          { kind: 'FieldEquals', path: 'artifact_plan.status', value: 'approved' },
          { kind: 'FieldTruthy', path: 'artifact_plan.write_authorized' },
        ]),
      );
      expect(parsed.modes.scaffold_plan.transitions).toEqual(
        expect.arrayContaining([
          { target: 'branch_write', guard: { kind: 'FieldEquals', path: 'artifact_plan.status', value: 'approved' } },
        ]),
      );
      expect(parsed.modes.static_verify.transitions).toEqual(
        expect.arrayContaining([
          {
            target: 'live_verify',
            guard: { kind: 'FieldTruthy', path: 'graduation.ready_for_live' },
          },
        ]),
      );
      expect(parsed.modes.static_verify.preconditions?.confirm_live_provider_intent).toEqual(
        expect.arrayContaining([{ kind: 'FieldEquals', path: 'graduation.static_verification', value: 'passed' }]),
      );
      expect(parsed.modes.live_verify.preconditions?.run_live_provider_verification).toEqual(
        expect.arrayContaining([{ kind: 'FieldTruthy', path: 'graduation.live_provider_intent' }]),
      );
      expect(parsed.action_map.select_repo_target.mutations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'repo.target_kind', from_arg: 'target_kind' }),
          expect.objectContaining({ path: 'repo.write_authorized', value: false }),
          expect.objectContaining({ path: 'repo.blocked', value: false }),
        ]),
      );
      expect(parsed.action_map.load_wiring_manifest.mutations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'repo.wiring_manifest.status', from_arg: 'status' }),
          expect.objectContaining({ path: 'repo.wiring_manifest.path', from_arg: 'path' }),
        ]),
      );
      expect(parsed.action_map.run_static_verification.mutations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'graduation.static_verification', from_arg: 'status' }),
          expect.objectContaining({ path: 'graduation.static_evidence_id', from_arg: 'evidence_id' }),
        ]),
      );
      expect(parsed.action_map.confirm_live_provider_intent.mutations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'graduation.live_provider_intent', value: true }),
          expect.objectContaining({ path: 'graduation.ready_for_live', value: true }),
        ]),
      );
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
