import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { createStandaloneArtifactPlan } from '../../src/pgas-new/artifact-plan.js';
import { PGAS_NEW_CONTROL_PLANE_CONTROLS } from '../../src/pgas-new/control-plane.js';
import { renderStandaloneScaffold, renderTemplate } from '../../src/pgas-new/template-renderer.js';

describe('template renderer', () => {
  it('fails on missing and unused tokens', () => {
    expect(() => renderTemplate('hello {{NAME}}', {})).toThrow(/missing template token: NAME/);
    expect(() => renderTemplate('hello', { NAME: 'pgas-new' })).toThrow(/unused template token: NAME/);
    expect(() => renderTemplate('hello {{Slug}}', {})).toThrow(/unrendered template token remains/);
    expect(renderTemplate('hello {{NAME}}', { NAME: 'pgas-new' })).toBe('hello pgas-new');
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

      expect(readFileSync(join(outDir, 'package.json'), 'utf8')).toContain('"@simodelne/pgas-server": "^2.8.3"');
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
