import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStandaloneArtifactPlan } from '../../src/pgas-new/artifact-plan.js';
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
      for (const control of ['ask:', 'abort:', 'new:', 'history:', 'status:', 'help:']) {
        expect(spec).toContain(control);
      }
      expect(spec).toContain('control_plane:');
      expect(spec).toContain('notebook_pins:');
      expect(spec).toContain('session_abort_current');
      expect(tests.join('\n')).toContain('real provider round trip through the external API');
      expect(tests.join('\n')).toContain('PGAS_LIVE_PROVIDER');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
