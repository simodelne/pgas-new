import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('rejects removed consumer template names at runtime', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pgas-new-removed-template-'));
    try {
      expect(() => renderStandaloneScaffold({
        outDir,
        slug: 'draft-policy',
        name: 'Draft Policy',
        template: 'policy-drafting' as never,
      })).toThrow(/invalid --template: policy-drafting/);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
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

  it('renders synthesized contracts, stage bodies, and smoke test artifacts', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pgas-new-render-synthesized-'));
    try {
      const result = renderStandaloneScaffold({
        outDir,
        slug: 'incident-triage',
        name: 'Incident Triage',
        synthesizedSpecYaml: 'name: incident-triage\n',
        synthesizedContractsTs: 'export const contractSentinel = true;\n',
        synthesizedHandlersTs: 'export const handlers = { sentinel: true };\n',
        synthesizedHandlersIndexTs: 'export const handlers = { sentinel: true };\n',
        synthesizedStageSources: {
          triage: 'export async function runStage() { return { result_json: "{}", items_json: "[]" }; }\n',
        },
        synthesizedToolsTs: 'export const stageActionTools = {};\n',
        synthesizedSmokeTestTs: 'import { describe } from "vitest";\ndescribe("generated program smoke", () => {});\n',
      });

      expect(result.written).toEqual(expect.arrayContaining([
        'src/programs/incident-triage/contracts.ts',
        'src/programs/incident-triage/stages/triage.ts',
        'tests/generated-program-smoke.test.ts',
      ]));
      expect(readFileSync(join(outDir, 'src/programs/incident-triage/contracts.ts'), 'utf8')).toContain('contractSentinel');
      expect(readFileSync(join(outDir, 'src/programs/incident-triage/stages/triage.ts'), 'utf8')).toContain('runStage');
      expect(readFileSync(join(outDir, 'tests/generated-program-smoke.test.ts'), 'utf8')).toContain('generated program smoke');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('renders synthesized smoke tests even when all body stages are LLM-reasoning stages', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pgas-new-render-llm-smoke-'));
    try {
      const result = renderStandaloneScaffold({
        outDir,
        slug: 'brief-summarizer',
        name: 'Brief Summarizer',
        synthesizedSpecYaml: 'name: brief-summarizer\n',
        synthesizedHandlersTs: 'export const handlers = { sentinel: true };\n',
        synthesizedHandlersIndexTs: 'export const handlers = { sentinel: true };\n',
        synthesizedToolsTs: 'export const stageActionTools = {};\n',
        synthesizedSmokeTestTs: 'import { describe } from "vitest";\ndescribe("generated program smoke", () => {});\n',
      });

      expect(result.written).toContain('tests/generated-program-smoke.test.ts');
      expect(readFileSync(join(outDir, 'tests/generated-program-smoke.test.ts'), 'utf8')).toContain('generated program smoke');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('renders existing-repo smoke tests with a manifest-relative registration import', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'pgas-new-attached-smoke-'));
    const manifest: WiringManifest = {
      ...VALID_MANIFEST,
      paths: {
        ...VALID_MANIFEST.paths,
        programs_dir: 'packages/simone/programs',
      },
    };
    try {
      const result = renderExistingRepoAttachment({
        repoRoot,
        manifest,
        slug: 'audit-trail',
        name: 'Audit Trail',
        stageSlugs: ['triage'],
        synthesizedSpecYaml: 'name: audit-trail\n',
        synthesizedContractsTs: 'export const contractSentinel = true;\n',
        synthesizedHandlersTs: 'export const handlers = { sentinel: true };\n',
        synthesizedHandlersIndexTs: 'export const handlers = { sentinel: true };\n',
        synthesizedStageSources: {
          triage: 'export async function runStage() { return { result_json: "{}", items_json: "[]" }; }\n',
        },
        synthesizedToolsTs: 'export const stageActionTools = {};\n',
        synthesizedSmokeTestTs: [
          "import { describe } from 'vitest';",
          "import { createAuditTrailProgramEntry } from '../src/programs/audit-trail/registration.js';",
          "describe('generated program smoke', () => {});",
          '',
        ].join('\n'),
      });

      const smokeTestPath = join(repoRoot, 'tests/generated-program-smoke.test.ts');
      const smokeTest = readFileSync(smokeTestPath, 'utf8');
      const registrationImport = smokeTest.match(/from '([^']+\/registration\.js)'/)?.[1];

      expect(result.written).toContain('tests/generated-program-smoke.test.ts');
      expect(registrationImport).toBe('../packages/simone/programs/audit-trail/registration.js');
      expect(smokeTest).not.toContain('../src/programs/audit-trail/registration.js');
      expect(existsSync(join(repoRoot, 'tests', registrationImport!.replace(/\.js$/u, '.ts')))).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
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

      expect(readFileSync(join(outDir, 'package.json'), 'utf8')).toContain('"@simodelne/pgas-server": "^3.3.0"');
      expect(server).toContain("from '@simodelne/pgas-server/create-server.js'");
      expect(registration).toContain("from '@simodelne/pgas-server/plugin.js'");
      expect(registration).toContain('type ProgramEntry');
      expect(registration).toContain('createProgramAdapters');
      expect(registration).toContain('createToolRegistry');
      expect(registration).toContain('loadSpecWithPatterns');
      expect(registration).toContain('createPgasNewProgramEntry');
      expect(registration).toContain('registerPgasNewTools');
      expect(registration).toContain('reactionHandlers');
      expect(registration).not.toContain('enableNotebook');
      expect(repl).toContain("from '@simodelne/pgas-server/client.js'");
      expect(repl).toContain('connectNotifications');
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

  it('renders standalone handlers without foundry-internal relative imports', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pgas-new-handler-imports-'));
    try {
      renderStandaloneScaffold({ outDir, slug: 'pgas-new', name: 'PGAS New' });

      const handlers = readFileSync(join(outDir, 'src/programs/pgas-new/handlers.ts'), 'utf8');

      expect(handlers).not.toContain('../pgas-new/');
      expect(handlers).not.toContain('./synthesizer.js');
      expect(handlers).not.toContain('./synthesizer-store.js');
      expect(handlers).toContain("from '@simodelne/pgas-server/plugin.js'");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('renders existing-repo registrations without Node ambient type dependencies', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'pgas-new-attached-registration-'));
    try {
      renderExistingRepoAttachment({
        repoRoot,
        manifest: VALID_MANIFEST,
        slug: 'audit-trail',
        name: 'Audit Trail',
      });

      const registration = readFileSync(join(repoRoot, 'programs/audit-trail/registration.ts'), 'utf8');
      expect(registration).toContain("new URL('./specs.yml', import.meta.url).pathname");
      expect(registration).toContain("import { auditTrailProjection } from './projection.js';");
      expect(registration).toContain('projectionBuilder: auditTrailProjection');
      expect(registration).toContain("frontendSpecPath: 'programs/audit-trail'");
      expect(registration).not.toContain("from 'node:path'");
      expect(registration).not.toContain("from 'node:url'");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('renders attached user-facing artifacts with projection, export, QC, and deterministic coverage', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'pgas-new-attached-user-facing-'));
    try {
      renderExistingRepoAttachment({
        repoRoot,
        manifest: VALID_MANIFEST,
        slug: 'fee-proposal-drafter',
        name: 'Fee Proposal Drafter',
        synthesizedSpecYaml: 'name: fee-proposal-drafter\n',
        synthesizedContractsTs: 'export const contractSentinel = true;\n',
        synthesizedHandlersTs: 'export const handlers = {}; export const reactionHandlers = new Map();\n',
        synthesizedHandlersIndexTs: 'export const handlers = {};\n',
        synthesizedStageSources: {
          fee_modelling: 'export async function runStage() { return { result_json: "{}", items_json: "[]", digest: "" }; }\n',
        },
        synthesizedToolsTs: 'export function registerFeeProposalDrafterTools() {}\n',
        synthesizedSmokeTestTs: [
          "import { describe } from 'vitest';",
          "import { createFeeProposalDrafterProgramEntry } from '../src/programs/fee-proposal-drafter/registration.js';",
          "describe('generated program smoke', () => { void createFeeProposalDrafterProgramEntry; });",
          '',
        ].join('\n'),
      });

      const projection = readFileSync(join(repoRoot, 'programs/fee-proposal-drafter/projection.ts'), 'utf8');
      const html = readFileSync(join(repoRoot, 'programs/fee-proposal-drafter/export/html.ts'), 'utf8');
      const docx = readFileSync(join(repoRoot, 'programs/fee-proposal-drafter/export/docx.ts'), 'utf8');
      const frontend = readFileSync(join(repoRoot, 'programs/fee-proposal-drafter/frontend.spec.yml'), 'utf8');
      const deterministic = readFileSync(join(repoRoot, 'tests/fee-proposal-drafter-deterministic.test.ts'), 'utf8');
      const facts = readFileSync(join(repoRoot, 'qc/facts/fee-proposal-drafter.facts.yml'), 'utf8');

      expect(projection).toContain('feeProposalDrafterProjection');
      expect(projection).toContain('pricing_cards');
      expect(projection).toContain('signature_page');
      expect(html).toContain('renderStructuredHtmlDocument');
      expect(html).toContain('Acceptance and Signature');
      expect(docx).toContain('renderStructuredDocxDocument');
      expect(docx).toContain('word/document.xml');
      expect(frontend).toContain('document-editor');
      expect(frontend).toContain('frontend_intake');
      expect(deterministic).toContain('renderStructuredDocxDocument');
      expect(deterministic).toContain("expect(docx[0]).toBe(0x50)");
      expect(facts).toContain('required_derived_keys');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('updates an existing E2E coverage matrix without create-artifact collisions', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'pgas-new-attached-coverage-'));
    try {
      mkdirSync(join(repoRoot, 'qc'), { recursive: true });
      writeFileSync(join(repoRoot, 'qc/e2e-coverage.yml'), [
        'version: 1',
        'user_facing_programs:',
        '  - review',
        'programs:',
        '  review:',
        '    facts: qc/facts/review.facts.yml',
        '    e2e-frontend:',
        '      channels: [frontend]',
        '      required: true',
        'cross_cutting:',
        '  e2e-ui:',
        '    runner: qc/e2e-ui/runner.ts',
        '    required: true',
        '',
      ].join('\n'));

      const result = renderExistingRepoAttachment({
        repoRoot,
        manifest: VALID_MANIFEST,
        slug: 'fee-proposal-drafter',
        name: 'Fee Proposal Drafter',
      });
      const coveragePath = join(repoRoot, 'qc/e2e-coverage.yml');
      const coverage = readFileSync(coveragePath, 'utf8');
      const parsed = load(coverage) as {
        user_facing_programs: string[];
        programs: Record<string, { facts?: string; 'e2e-frontend'?: { channels?: string[]; required?: boolean } }>;
        cross_cutting: Record<string, unknown>;
      };

      expect(result.written).toContain('qc/e2e-coverage.yml');
      expect(parsed.user_facing_programs).toContain('review');
      expect(parsed.user_facing_programs).toContain('fee-proposal-drafter');
      expect(parsed.programs.review.facts).toBe('qc/facts/review.facts.yml');
      expect(parsed.programs['fee-proposal-drafter']).toEqual({
        facts: 'qc/facts/fee-proposal-drafter.facts.yml',
        'e2e-frontend': {
          channels: ['frontend'],
          required: true,
        },
      });
      expect(parsed.cross_cutting).toHaveProperty('e2e-ui');

      for (const path of result.written.filter((path) => path !== 'qc/e2e-coverage.yml')) {
        rmSync(join(repoRoot, path), { force: true, recursive: true });
      }
      renderExistingRepoAttachment({
        repoRoot,
        manifest: VALID_MANIFEST,
        slug: 'fee-proposal-drafter',
        name: 'Fee Proposal Drafter',
      });
      expect(readFileSync(coveragePath, 'utf8')).toBe(coverage);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('still refuses existing-repo create-artifact collisions', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'pgas-new-attached-create-collision-'));
    try {
      const collisionPath = join(repoRoot, 'programs/audit-trail/specs.yml');
      const sentinel = 'name: existing-program\n';
      mkdirSync(join(repoRoot, 'programs/audit-trail'), { recursive: true });
      writeFileSync(collisionPath, sentinel);

      expect(() => renderExistingRepoAttachment({
        repoRoot,
        manifest: VALID_MANIFEST,
        slug: 'audit-trail',
        name: 'Audit Trail',
      })).toThrow(/refusing to overwrite existing attach artifacts:\nprograms\/audit-trail\/specs\.yml/);
      expect(readFileSync(collisionPath, 'utf8')).toBe(sentinel);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('declares skeleton control-plane session commands, modes, notebook state, and live-test hooks', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pgas-new-spec-'));
    try {
      renderStandaloneScaffold({ outDir, slug: 'pgas-new', name: 'PGAS New' });
      const spec = readFileSync(join(outDir, 'src/programs/pgas-new/specs.yml'), 'utf8');
      const parsed = load(spec) as {
        initial: string;
        terminal: string[];
      modes: Record<string, { vocabulary: string[]; channels?: string[] }>;
      projection: Record<string, { include: string[] }>;
      action_map: Record<string, { mutations: Array<{ op: string; path: string; value?: unknown; from_arg?: string }> }>;
      proceed_to: Record<string, string>;
      schema: Record<string, string>;
      control_plane: { controls: Record<string, unknown> };
    };
    const tests = [
      'tests/spec-load.test.ts',
      'tests/control-plane.test.ts',
      'tests/program-deterministic.test.ts',
      'tests/api-blackbox.test.ts',
      'tests/live-provider.test.ts',
    ].map((path) => readFileSync(join(outDir, path), 'utf8'));

    expect(parsed.initial).toBe('start');
    expect(parsed.terminal).toEqual(['complete']);
    expect(Object.keys(parsed.modes)).toEqual(['start', 'working', 'complete']);
    expect(Object.keys(parsed.control_plane.controls)).toEqual(expect.arrayContaining([...PGAS_NEW_CONTROL_PLANE_CONTROLS]));
    expect(parsed.modes.start.vocabulary).toEqual(
      expect.arrayContaining([
        'begin_work',
        'record_user_note',
        'session_new',
        'session_abort_current',
        'session_status',
        'session_history',
        'session_resume',
        'session_help',
      ]),
    );
    expect(parsed.modes.working.vocabulary).toEqual(
      expect.arrayContaining([
        'example_action',
        'record_user_note',
        'session_new',
        'session_abort_current',
        'session_status',
        'session_history',
        'session_resume',
        'session_help',
      ]),
    );
    expect(parsed.proceed_to).toEqual({
      begin_work: 'working',
      example_action: 'complete',
    });
    expect(spec).toContain('control_plane:');
    expect(spec).toContain('notebook.entries');
    expect(spec).toContain('notebook.pins');
    expect(parsed.projection.start.include).toEqual(
      expect.arrayContaining(['inputs.user_text', 'notebook.entries', 'notebook.pins', 'work.started']),
    );
    expect(parsed.projection.working.include).toEqual(
      expect.arrayContaining([
        'inputs.user_text',
        'notebook.entries',
        'notebook.pins',
        'work.example_ready',
        'work.example_result_json',
        'work.example_items_json',
      ]),
    );
    expect(parsed.schema).toMatchObject({
      'inputs.user_text': 'string',
      'notebook.entries': 'array',
      'notebook.pins': 'array',
      'work.started': 'boolean',
      'work.example_ready': 'boolean',
      'work.example_result_json': 'string',
      'work.example_items_json': 'string',
    });
    expect(parsed.action_map.begin_work.mutations).toEqual([{ op: 'MSet', path: 'work.started', value: true }]);
    expect(parsed.action_map.record_user_note.mutations).toEqual([
      { op: 'MAppend', path: 'notebook.entries', from_arg: 'note' },
    ]);
    expect(parsed.action_map.example_action.mutations).toEqual(
      expect.arrayContaining([
        { op: 'MSet', path: 'work.example_ready', value: true },
        { op: 'MSet', path: 'work.example_result_json', value: '{"status":"ready","source":"skeleton"}' },
        { op: 'MSet', path: 'work.example_items_json', value: '["example"]' },
      ]),
    );
    expect(spec).not.toContain('intake_intelligence:');
    expect(spec).not.toContain('record_program_target');
    expect(spec).not.toContain('pin_notebook_note');
    expect(spec).not.toContain('authorize_existing_repo_target');
    expect(tests.join('\n')).toContain('real provider round trip through the external API');
    expect(tests.join('\n')).toContain('PGAS_LIVE_PROVIDER');
    expect(tests.join('\n')).toContain('LIVE_PROVIDER_TIMEOUT_MS');
    expect(tests.join('\n')).toContain('PGAS_LIVE_PROVIDER_TIMEOUT_MS');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

it('declares the foundry intake actions, JSON-string intake recording shape, and guidance', () => {
  const specText = readFileSync('src/foundry-program/specs.yml', 'utf8');
  const foundryRegistration = readFileSync('src/foundry-program/registration.ts', 'utf8');
  const foundryTools = readFileSync('src/foundry-program/tools.ts', 'utf8');
  const parsed = load(specText) as {
      modes: Record<string, {
        vocabulary: string[];
        channels?: string[];
        preconditions?: Record<string, Array<{ kind: string; path?: string; value?: unknown; triggerSet?: string[] }>>;
        transitions?: Array<{ target: string; guard?: { kind: string; path?: string; value?: unknown } }>;
      }>;
      projection: Record<string, { include: string[] }>;
      action_map: Record<string, {
        description: string;
        channel: string;
        result_path?: string;
        arg_descriptions?: Record<string, string>;
        mutations: Array<{ op: string; path: string; from_arg?: string; value?: unknown }>;
      }>;
      proceed_to: Record<string, string>;
      schema: Record<string, string>;
      ingestion: Record<string, string[]>;
      guidance: Record<string, string[]>;
    };
    const qActionNames = [
      'record_q1_purpose',
      'record_q2_entry_channel',
      'record_q3_stages',
      'record_q4_transitions',
      'record_q5_delegation',
      'record_q6_completion',
    ] as const;
    const qRecordedPaths = [
      'intake.q1_recorded',
      'intake.q2_recorded',
      'intake.q3_recorded',
      'intake.q4_recorded',
      'intake.q5_recorded',
      'intake.q6_recorded',
    ] as const;

    expect(foundryRegistration).toContain('createPgasNewFoundryProgramEntry');
    expect(foundryRegistration).toContain('registerPgasNewTools');
    expect(foundryRegistration).toContain('reactionHandlers');
    expect(foundryTools).toContain("'record_q1_purpose'");
    expect(foundryTools).toContain("'revise_artifact_plan'");

    expect(parsed.modes.intake_intelligence.vocabulary).toEqual(
      expect.arrayContaining([
        'record_program_target',
        'choose_design_path',
        'apply_default_skeleton',
        'ask_design_question',
        ...qActionNames,
        'record_program_intake_finalize',
        'confirm_design',
        'reject_design_and_revise_q1',
        'reject_design_and_revise_q2',
        'reject_design_and_revise_q3',
        'reject_design_and_revise_q4',
        'reject_design_and_revise_q5',
        'reject_design_and_revise_q6',
      ]),
    );
    expect(parsed.modes.intake_intelligence.vocabulary).not.toContain('record_program_intake');
    expect(parsed.modes.architecture_design.vocabulary).toEqual(
      expect.arrayContaining(['synthesize_program_spec']),
    );
    expect(parsed.modes.architecture_design.preconditions?.synthesize_program_spec).toEqual(
      expect.arrayContaining([{ kind: 'FieldTruthy', path: 'program.design_confirmed' }]),
    );
    expect(parsed.modes.architecture_design.transitions).toEqual([
      { target: 'scaffold_plan', guard: { kind: 'FieldTruthy', path: 'program.synthesis_complete' } },
    ]);
    expect(parsed.modes.scaffold_plan.vocabulary).toEqual(
      expect.arrayContaining(['approve_artifact_plan', 'revise_artifact_plan', 'plan_artifacts']),
    );
    expect(parsed.modes.intake_intelligence.channels).toEqual(expect.arrayContaining(['user_confirmation']));
    expect(parsed.modes.intake_intelligence.transitions).toEqual(
      expect.arrayContaining([
        { target: 'repo_targeting', guard: { kind: 'FieldTruthy', path: 'program.design_confirmed' } },
      ]),
    );
    expect(parsed.modes.intake_intelligence.preconditions?.record_program_target).toEqual(
      expect.arrayContaining([{ kind: 'FieldFalsy', path: 'program.target_dir_confirmed' }]),
    );
    expect(parsed.modes.intake_intelligence.preconditions?.choose_design_path).toEqual(
      expect.arrayContaining([
        { kind: 'FieldTruthy', path: 'program.target_dir_confirmed' },
        { kind: 'FieldFalsy', path: 'program.design_path' },
      ]),
    );
    expect(parsed.modes.intake_intelligence.preconditions?.apply_default_skeleton).toEqual(
      expect.arrayContaining([
        { kind: 'FieldEquals', path: 'program.design_path', value: 'default' },
        { kind: 'FieldFalsy', path: 'intake.program_intake_finalized' },
      ]),
    );
    expect(parsed.modes.intake_intelligence.preconditions?.record_q1_purpose).toEqual(
      expect.arrayContaining([
        { kind: 'FieldEquals', path: 'program.design_path', value: 'design' },
        { kind: 'FieldFalsy', path: 'intake.q1_recorded' },
      ]),
    );
    expect(parsed.modes.intake_intelligence.preconditions?.record_q2_entry_channel).toEqual(
      expect.arrayContaining([
        { kind: 'FieldTruthy', path: 'intake.q1_recorded' },
        { kind: 'FieldFalsy', path: 'intake.q2_recorded' },
      ]),
    );
    expect(parsed.modes.intake_intelligence.preconditions?.record_q3_stages).toEqual(
      expect.arrayContaining([
        { kind: 'FieldTruthy', path: 'intake.q2_recorded' },
        { kind: 'FieldFalsy', path: 'intake.q3_recorded' },
      ]),
    );
    expect(parsed.modes.intake_intelligence.preconditions?.record_q4_transitions).toEqual(
      expect.arrayContaining([
        { kind: 'FieldTruthy', path: 'intake.q3_recorded' },
        { kind: 'FieldFalsy', path: 'intake.q4_recorded' },
      ]),
    );
    expect(parsed.modes.intake_intelligence.preconditions?.record_q5_delegation).toEqual(
      expect.arrayContaining([
        { kind: 'FieldTruthy', path: 'intake.q4_recorded' },
        { kind: 'FieldFalsy', path: 'intake.q5_recorded' },
      ]),
    );
    expect(parsed.modes.intake_intelligence.preconditions?.record_q6_completion).toEqual(
      expect.arrayContaining([
        { kind: 'FieldTruthy', path: 'intake.q5_recorded' },
        { kind: 'FieldFalsy', path: 'intake.q6_recorded' },
      ]),
    );
    expect(parsed.modes.intake_intelligence.preconditions?.record_program_intake_finalize).toEqual(
      expect.arrayContaining([
        ...qRecordedPaths.map((path) => ({ kind: 'FieldTruthy', path })),
        { kind: 'FieldFalsy', path: 'intake.program_intake_finalized' },
      ]),
    );
    expect(parsed.modes.intake_intelligence.preconditions?.confirm_design).toEqual(
      expect.arrayContaining([
        { kind: 'FieldTruthy', path: 'intake.program_intake_finalized' },
        { kind: 'FieldTruthy', path: 'program.target_dir_confirmed' },
        { kind: 'FieldFalsy', path: 'program.design_confirmed' },
        { kind: 'TriggerType', triggerSet: ['user_confirmation'] },
        { kind: 'FieldEquals', path: 'inputs.user_decision.decision', value: 'approve' },
      ]),
    );
    expect(parsed.modes.intake_intelligence.preconditions?.reject_design_and_revise_q3).toEqual(
      expect.arrayContaining([
        { kind: 'FieldTruthy', path: 'intake.program_intake_finalized' },
        { kind: 'TriggerType', triggerSet: ['user_confirmation'] },
        { kind: 'FieldEquals', path: 'inputs.user_decision.decision', value: 'reject' },
      ]),
    );

    expect(parsed.action_map.record_program_target.mutations).toEqual([
      { op: 'MSet', path: 'program.slug', from_arg: 'slug' },
      { op: 'MSet', path: 'program.name', from_arg: 'name' },
      { op: 'MSet', path: 'program.target_dir', from_arg: 'target_dir' },
      { op: 'MSet', path: 'program.target_dir_confirmed', value: true },
    ]);
    expect(parsed.action_map.choose_design_path.mutations).toEqual([
      { op: 'MSet', path: 'program.design_path', from_arg: 'choice' },
    ]);
    expect(parsed.action_map.apply_default_skeleton.mutations).toEqual([
      { op: 'MSet', path: 'intake.purpose', value: '' },
      { op: 'MSet', path: 'intake.q1_recorded', value: true },
      { op: 'MSet', path: 'intake.entry_channel', value: 'user_text' },
      { op: 'MSet', path: 'intake.q2_recorded', value: true },
      {
        op: 'MSet',
        path: 'intake.stages_json',
        value: '[{"slug":"start","is_bootstrap":true},{"slug":"working"},{"slug":"complete","is_terminal":true}]',
      },
      { op: 'MSet', path: 'intake.q3_recorded', value: true },
      {
        op: 'MSet',
        path: 'intake.transitions_json',
        value: '[{"from":"start","to":"working","trigger":"auto"},{"from":"working","to":"complete","trigger":"auto","guard_field":"work.example_ready","guard_value":true}]',
      },
      { op: 'MSet', path: 'intake.q4_recorded', value: true },
      { op: 'MSet', path: 'intake.delegation_json', value: '{}' },
      { op: 'MSet', path: 'intake.q5_recorded', value: true },
      {
        op: 'MSet',
        path: 'intake.completion_json',
        value: '{"final_stage":"complete","guard_field":"work.example_ready"}',
      },
      { op: 'MSet', path: 'intake.q6_recorded', value: true },
      { op: 'MSet', path: 'intake.program_intake_finalized', value: true },
    ]);
    expect(parsed.action_map.ask_design_question).toMatchObject({
      description: 'Ask the user a single design-interview question (Q1-Q6). Pauses the round; the next round\'s inputs.user_text carries the answer.',
      channel: 'widget_output',
      arg_descriptions: {
        question_number: 'Which Q is being asked (1-6).',
        question_text: 'The question prompt to display to the user.',
      },
    });
    expect(parsed.action_map.ask_design_question.mutations).toEqual([
      { op: 'MSet', path: 'intake.last_question_asked', from_arg: 'question_number' },
      { op: 'MSet', path: 'intake.last_question_text', from_arg: 'question_text' },
    ]);
    expect(parsed.action_map.record_q1_purpose).toMatchObject({
      description: "Capture the user's answer to Q1 (program purpose). One short paragraph describing what the program does.",
      channel: 'widget_output',
    });
    expect(parsed.action_map.record_q1_purpose.mutations).toEqual([
      { op: 'MSet', path: 'intake.purpose', from_arg: 'purpose' },
      { op: 'MSet', path: 'intake.q1_recorded', value: true },
    ]);
    expect(parsed.action_map.record_q2_entry_channel.mutations).toEqual([
      { op: 'MSet', path: 'intake.entry_channel', from_arg: 'entry_channel' },
      { op: 'MSet', path: 'intake.q2_recorded', value: true },
    ]);
    expect(parsed.action_map.record_q3_stages.mutations).toEqual([
      { op: 'MSet', path: 'intake.stages_json', from_arg: 'stages_json' },
      { op: 'MSet', path: 'intake.q3_recorded', value: true },
    ]);
    expect(parsed.action_map.record_q4_transitions.mutations).toEqual([
      { op: 'MSet', path: 'intake.transitions_json', from_arg: 'transitions_json' },
      { op: 'MSet', path: 'intake.q4_recorded', value: true },
    ]);
    expect(parsed.action_map.record_q5_delegation.mutations).toEqual([
      { op: 'MSet', path: 'intake.delegation_json', from_arg: 'delegation_json' },
      { op: 'MSet', path: 'intake.q5_recorded', value: true },
    ]);
    expect(parsed.action_map.record_q6_completion.mutations).toEqual([
      { op: 'MSet', path: 'intake.completion_json', from_arg: 'completion_json' },
      { op: 'MSet', path: 'intake.q6_recorded', value: true },
    ]);
    expect(parsed.action_map.record_program_intake_finalize).toMatchObject({
      description: 'Final commit of the design interview once all 6 Q-answers are recorded. Idempotent. The LLM should call this immediately after record_q6_completion fires.',
      channel: 'widget_output',
    });
    expect(parsed.action_map.record_program_intake_finalize.mutations).toEqual([
      { op: 'MSet', path: 'intake.program_intake_finalized', value: true },
    ]);
    expect(parsed.action_map).not.toHaveProperty('record_program_intake');
    expect(parsed.action_map.confirm_design.mutations).toEqual([
      { op: 'MSet', path: 'program.design_confirmed', value: true },
    ]);
    expect(parsed.action_map.reject_design_and_revise_q3.mutations).toEqual([
      { op: 'MSet', path: 'intake.q3_recorded', value: false },
      { op: 'MSet', path: 'program.design_confirmed', value: false },
    ]);
    expect(parsed.action_map.synthesize_program_spec).toMatchObject({
      description: 'Run the mechanical synthesizer (no LLM call). Writes the spec to in-process transit; flips program.synthesis_complete.',
      channel: 'widget_output',
    });
    expect(parsed.action_map.synthesize_program_spec.mutations).toEqual([
      { op: 'MSet', path: 'program.synthesis_complete', value: true },
    ]);
    expect(parsed.modes.scaffold_plan.preconditions?.approve_artifact_plan).toEqual(
      expect.arrayContaining([
        { kind: 'FieldTruthy', path: 'repo.write_authorized' },
        { kind: 'FieldTruthy', path: 'program.synthesis_complete' },
        { kind: 'FieldEquals', path: 'artifact_plan.status', value: 'draft' },
        { kind: 'FieldFalsy', path: 'artifact_plan.approved' },
        { kind: 'TriggerType', triggerSet: ['user_confirmation'] },
        { kind: 'FieldEquals', path: 'inputs.user_decision.decision', value: 'approve' },
      ]),
    );
    expect(parsed.modes.scaffold_plan.preconditions?.plan_artifacts).toEqual(
      expect.arrayContaining([
        { kind: 'FieldTruthy', path: 'repo.write_authorized' },
        { kind: 'FieldTruthy', path: 'program.synthesis_complete' },
        { kind: 'FieldFalsy', path: 'artifact_plan.status' },
        { kind: 'TriggerType', triggerSet: ['system_mode_entry'] },
      ]),
    );
    expect(parsed.modes.scaffold_plan.preconditions?.revise_artifact_plan).toEqual(
      expect.arrayContaining([
        { kind: 'FieldTruthy', path: 'repo.write_authorized' },
        { kind: 'FieldTruthy', path: 'program.synthesis_complete' },
        { kind: 'FieldEquals', path: 'artifact_plan.status', value: 'draft' },
        { kind: 'TriggerType', triggerSet: ['user_confirmation'] },
        { kind: 'FieldEquals', path: 'inputs.user_decision.decision', value: 'reject' },
      ]),
    );
    expect(parsed.action_map.revise_artifact_plan).toMatchObject({
      channel: 'artifact_plan_output',
      result_path: 'artifact_plan.artifacts',
    });
    expect(parsed.action_map.revise_artifact_plan.mutations).toEqual([
      { op: 'MSet', path: 'artifact_plan.status', value: 'draft' },
      { op: 'MSet', path: 'artifact_plan.approved', value: false },
      { op: 'MSet', path: 'artifact_plan.write_authorized', value: false },
    ]);
    expect(parsed.modes.domain_synthesis.preconditions?.synthesize_domain_logic).toEqual(
      expect.arrayContaining([
        { kind: 'FieldEquals', path: 'artifact_plan.status', value: 'approved' },
        { kind: 'FieldTruthy', path: 'artifact_plan.write_authorized' },
        { kind: 'FieldFalsy', path: 'program.domain_synthesis_complete' },
      ]),
    );
    expect(parsed.ingestion.user_confirmation).toEqual([
      'inputs.user_decision',
      'inputs.user_decision.decision',
      'inputs.user_decision.instruction',
      'inputs.user_decision.note_mode',
      'inputs.user_decision.timestamp',
    ]);
    expect(parsed.projection.intake_intelligence.include).toEqual(
      expect.arrayContaining([
        'inputs.user_text',
        'inputs.user_decision',
        'inputs.user_decision.decision',
        'inputs.user_decision.instruction',
        'inputs.user_decision.note_mode',
        'inputs.user_decision.timestamp',
        'intake.purpose',
        'intake.q1_recorded',
        'intake.entry_channel',
        'intake.q2_recorded',
        'intake.stages_json',
        'intake.q3_recorded',
        'intake.transitions_json',
        'intake.q4_recorded',
        'intake.delegation_json',
        'intake.q5_recorded',
        'intake.completion_json',
        'intake.q6_recorded',
        'intake.program_intake_finalized',
        'program.slug',
        'program.name',
        'program.target_dir',
        'program.target_dir_confirmed',
        'program.design_path',
        'program.design_confirmed',
        'program.skip_dimensions',
      ]),
    );
    expect(parsed.projection.branch_write.include).toEqual(
      expect.arrayContaining([
        'program.slug',
        'program.name',
        'program.target_dir',
        'repo.target_kind',
        'program.synthesis_complete',
        'program.domain_synthesis_complete',
      ]),
    );
    expect(parsed.schema).toMatchObject({
      'inputs.user_text': 'string',
      'inputs.user_decision': 'object',
      'inputs.user_decision.decision': 'string',
      'inputs.user_decision.instruction': 'string',
      'inputs.user_decision.note_mode': 'string',
      'inputs.user_decision.timestamp': 'string',
      'program.design_path': 'string',
      'program.design_confirmed': 'boolean',
      'program.synthesis_complete': 'boolean',
      'program.domain_synthesis_complete': 'boolean',
      'program.target_dir': 'string',
      'program.target_dir_confirmed': 'boolean',
      'program.skip_dimensions': 'array',
      'program.skip_dimensions.*': 'string',
      'intake.last_question_asked': 'number',
      'intake.last_question_text': 'string',
      'intake.purpose': 'string',
      'intake.q1_recorded': 'boolean',
      'intake.entry_channel': 'string',
      'intake.q2_recorded': 'boolean',
      'intake.stages_json': 'string',
      'intake.q3_recorded': 'boolean',
      'intake.transitions_json': 'string',
      'intake.q4_recorded': 'boolean',
      'intake.delegation_json': 'string',
      'intake.q5_recorded': 'boolean',
      'intake.completion_json': 'string',
      'intake.q6_recorded': 'boolean',
      'intake.program_intake_finalized': 'boolean',
    });
    expect(parsed.schema).not.toHaveProperty('intake.program_intake_recorded');
    expect(parsed.schema).not.toHaveProperty('program.synthesized_spec');
    expect(parsed.guidance.architecture_design).toEqual(
      expect.arrayContaining([
        expect.stringContaining('call synthesize_program_spec'),
        expect.stringContaining('in-process transit'),
      ]),
    );
    expect(parsed.guidance.scaffold_plan.join('\n')).toContain('synthesized spec in in-process transit');
    expect(parsed.guidance.scaffold_plan.join('\n')).toContain('call synthesize_program_spec again');
    expect(parsed.guidance.scaffold_plan.join('\n')).toContain('decision=reject');
    expect(parsed.guidance.scaffold_plan.join('\n')).toContain('revise_artifact_plan');
    expect(parsed.guidance.domain_synthesis.join('\n')).toContain('synthesize_domain_logic');
    expect(parsed.guidance.repo_targeting.join('\n')).toContain('mandatory between confirm_design and architecture_design');
    expect(parsed.guidance.repo_targeting.join('\n')).toContain('call authorize_standalone_target');
    expect(parsed.guidance.intake_intelligence).toEqual(
      expect.arrayContaining([
        expect.stringContaining('program.target_dir_confirmed is not true'),
        expect.stringContaining('call choose_design_path'),
        expect.stringContaining('call apply_default_skeleton'),
        expect.stringContaining('Design interview enforcement (Q1-Q6)'),
        expect.stringContaining('ask_design_question with question_number'),
        expect.stringContaining('record_qN_<topic>'),
        expect.stringContaining('record_program_intake_finalize'),
        expect.stringContaining('Do NOT attempt to batch multiple answers into one action'),
        expect.stringContaining("intent='confirm_design'"),
        expect.stringContaining('reject_design_and_revise_qN'),
        expect.stringContaining("Don't re-ask anything you already extracted"),
      ]),
    );
    expect(parsed.guidance.intake_intelligence.join('\n')).not.toContain('record_program_intake with');
  });

  it('renders streaming REPL client with SSE + WS rendering', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pgas-new-streaming-repl-'));
    try {
      renderStandaloneScaffold({
        outDir,
        slug: 'my-program',
        name: 'My Program',
      });

      const index = readFileSync(join(outDir, 'src/repl/index.ts'), 'utf8');
      const renderer = readFileSync(join(outDir, 'src/repl/renderer.ts'), 'utf8');
      const pkg = readFileSync(join(outDir, 'package.json'), 'utf8');

      // index.ts: pure client — no embedded server
      expect(index).not.toContain('createPgasServer');
      expect(index).not.toContain('controlCliAdapter');
      expect(index).not.toContain('devReplAuthProvider');
      expect(index).toContain("from '@simodelne/pgas-server/client.js'");
      expect(index).toContain('connectNotifications');
      expect(index).toContain('triggerStream');
      expect(index).toContain('PGAS_API_BASE');
      expect(index).toContain('PGAS_WS_BASE');
      expect(index).toContain('my-program');  // {{SLUG}} rendered
      expect(index).toContain('My Program');  // {{NAME}} rendered

      // renderer.ts: rendering functions exported
      expect(renderer).toContain('renderAction');
      expect(renderer).toContain('renderModeChange');
      expect(renderer).toContain('renderError');
      expect(renderer).toContain('ReplState');
      expect(renderer).toContain("from 'chalk'");

      // package.json: chalk dep present (@clack/prompts kept for future widget flows)
      expect(pkg).toContain('chalk');
      expect(pkg).toContain('"dev": "node --import tsx src/server.ts"');
      expect(pkg).toContain('"repl": "node --import tsx src/repl/index.ts"');

      // no unresolved tokens
      expect(index).not.toContain('{{');
      expect(renderer).not.toContain('{{');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('renders REPL startup with friendly auth and notification-open failures', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pgas-new-repl-auth-'));
    try {
      renderStandaloneScaffold({
        outDir,
        slug: 'my-program',
        name: 'My Program',
      });

      const index = readFileSync(join(outDir, 'src/repl/index.ts'), 'utf8');

      expect(index).toContain('isAuthError');
      expect(index).toContain('Authentication failed');
      expect(index).toContain('waitForNotifications');
      expect(index).not.toContain('await ws.opened;');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('renders REPL abort as an interruptible control-plane command', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pgas-new-repl-abort-'));
    try {
      renderStandaloneScaffold({
        outDir,
        slug: 'my-program',
        name: 'My Program',
      });

      const index = readFileSync(join(outDir, 'src/repl/index.ts'), 'utf8');

      expect(index).toContain("await client.controls.invoke(PROGRAM, 'abort'");
      expect(index).not.toContain('if (!input || state.running)');
      expect(index).toContain('state.abortRequested = true');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('renders REPL with input queue + busy guard against startup-race double-create', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pgas-new-repl-queue-'));
    try {
      renderStandaloneScaffold({
        outDir,
        slug: 'my-program',
        name: 'My Program',
      });

      const index = readFileSync(join(outDir, 'src/repl/index.ts'), 'utf8');

      // Queue + busy guard surfaces are declared
      expect(index).toContain('pendingInputs');
      expect(index).toContain('inputBusy');
      expect(index).toContain('dispatchInput');
      expect(index).toContain('drainPendingAfterRound');

      // textBusy tracks free-text handlers specifically — required so always-
      // available commands (/status, /history, /help) running concurrently
      // don't clear the guard while a pending sessions.create is in flight.
      // See round-3 issue 9.
      expect(index).toContain('textBusy');
      expect(index).toContain('state.running || textBusy || inputBusy');

      // Free text mid-round is queued, not dropped
      expect(index).toContain('pendingInputs.push(input)');
      // The queue is drained after each round completes
      expect(index).toContain('drainPendingAfterRound()');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('renders REPL status, history, and resume as server-backed commands', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pgas-new-repl-session-commands-'));
    try {
      renderStandaloneScaffold({
        outDir,
        slug: 'my-program',
        name: 'My Program',
      });

      const index = readFileSync(join(outDir, 'src/repl/index.ts'), 'utf8');

      expect(index).toContain('await client.sessions.get(state.sessionId)');
      expect(index).toContain('await client.sessions.rounds(state.sessionId)');
      expect(index).toContain('await client.sessions.resume()');
      expect(index).toContain('No resumable session exists.');
      expect(index).not.toContain("renderStep('Resuming…')");
      expect(index).not.toContain("mode: ${state.mode ?? '?'}");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('declares the internal system_mode_entry continuation channel in generated specs', () => {
    for (const template of ['pgas-new-foundry'] as const) {
      const outDir = mkdtempSync(join(tmpdir(), `pgas-new-mode-entry-${template}-`));
      try {
        renderStandaloneScaffold({
          outDir,
          slug: 'my-program',
          name: 'My Program',
          template,
          mandate: 'Test mandate.',
        });

        const parsed = load(readFileSync(join(outDir, 'src/programs/my-program/specs.yml'), 'utf8')) as {
          channels: Record<string, { direction: string; sync: string }>;
          ingestion: Record<string, string[]>;
          modes: Record<string, { channels: string[] }>;
          schema: Record<string, string>;
        };

        expect(parsed.channels.system_mode_entry).toEqual({ direction: 'In', sync: 'Async' });
        expect(parsed.ingestion.system_mode_entry).toEqual(['inputs.mode_entry']);
        expect(parsed.schema['inputs.mode_entry']).toBe('object');
        const firstMode = Object.keys(parsed.modes)[0];
        expect(firstMode).toBeDefined();
        expect(parsed.modes[firstMode as string]?.channels).toContain('system_mode_entry');
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    }
  });

  it('declares foundry write-safety gates for existing repo attachments', () => {
    const spec = readFileSync('src/foundry-program/specs.yml', 'utf8');
    const parsed = load(spec) as {
      modes: Record<string, {
        preconditions?: Record<string, Array<{ kind: string; path: string; value?: unknown; triggerSet?: string[] }>>;
        transitions?: Array<{ target: string; guard?: { kind: string; path: string; value?: unknown } }>;
      }>;
      action_map: Record<string, {
        arg_descriptions?: Record<string, string>;
        mutations?: Array<{ path: string; value?: unknown; from_arg?: string }>;
        result_path?: string;
        channel?: string;
      }>;
      proceed_to: Record<string, string>;
      schema: Record<string, string>;
      control_plane: { controls: Record<string, unknown> };
    };

    expect(Object.keys(parsed.control_plane.controls)).toEqual(expect.arrayContaining([...PGAS_NEW_CONTROL_PLANE_CONTROLS]));
    expect(parsed.schema['repo.write_authorized']).toBe('boolean');
    expect(parsed.schema['repo.wiring_manifest.path']).toBe('string');
    expect(parsed.schema['repo.wiring_manifest.repo_root']).toBe('string');
    expect(parsed.schema['repo.wiring_manifest_json']).toBe('string');
    expect(parsed.schema['repo.allowed_imports']).toBe('array');
    expect(parsed.schema['intake.research_allowed']).toBe('boolean');
    expect(parsed.schema['intake.user_research_authorized']).toBe('boolean');
    expect(parsed.schema['graduation.static_evidence_id']).toBe('string');
    expect(parsed.schema['graduation.smoke_verification']).toBe('string');
    expect(parsed.schema['graduation.smoke_evidence_id']).toBe('string');
    expect(parsed.schema['graduation.ready_for_live']).toBe('boolean');
    expect(parsed.schema['graduation.rebase_static_evidence_id']).toBe('string');
    expect(parsed.schema['program.domain_synthesis_complete']).toBe('boolean');
    // domain_synthesis.audit was removed from session-state schema together
    // with synthesize_domain_logic's result_path: the audit is durable in the
    // synthesizer transit store and surfaced in the widget payload instead.
    expect(parsed.schema['domain_synthesis.audit']).toBeUndefined();
    expect(parsed.proceed_to.load_wiring_manifest).toBeUndefined();
    expect(parsed.proceed_to.confirm_design).toBe('repo_targeting');
    expect(parsed.proceed_to.authorize_standalone_target).toBe('architecture_design');
    expect(parsed.proceed_to.authorize_existing_repo_target).toBe('architecture_design');
    expect(parsed.proceed_to.run_static_verification).toBe('smoke_verify');
    expect(parsed.proceed_to.approve_artifact_plan).toBe('domain_synthesis');
    expect(parsed.proceed_to.synthesize_domain_logic).toBe('branch_write');
    expect(parsed.proceed_to.confirm_live_provider_intent).toBe('live_verify');
    expect(parsed.proceed_to.run_rebase_static_verification).toBe('pr_graduation');
    expect(parsed.modes.intake_intelligence.preconditions?.web_research).toEqual(
      expect.arrayContaining([{ kind: 'FieldTruthy', path: 'intake.user_research_authorized' }]),
    );
    expect(parsed.modes.architecture_design.preconditions?.web_research).toEqual(
      expect.arrayContaining([{ kind: 'FieldTruthy', path: 'intake.user_research_authorized' }]),
    );
    expect(parsed.modes.repo_targeting.preconditions?.authorize_existing_repo_target).toEqual(
      expect.arrayContaining([
        { kind: 'FieldEquals', path: 'repo.wiring_manifest.status', value: 'valid' },
        { kind: 'FieldEquals', path: 'repo.wiring_manifest.path', value: '.pgas/wiring.yml' },
      ]),
    );
    expect(parsed.modes.repo_targeting.preconditions?.create_curator_request).toEqual(
      expect.arrayContaining([
        { kind: 'FieldEquals', path: 'repo.target_kind', value: 'existing_repo' },
        { kind: 'FieldFalsy', path: 'repo.write_authorized' },
      ]),
    );
    expect(parsed.modes.scaffold_plan.preconditions?.approve_artifact_plan).toEqual(
      expect.arrayContaining([{ kind: 'FieldTruthy', path: 'repo.write_authorized' }]),
    );
    expect(parsed.modes.branch_write.preconditions?.write_scaffold_artifacts).toEqual(
      expect.arrayContaining([
        { kind: 'FieldEquals', path: 'artifact_plan.status', value: 'approved' },
        { kind: 'FieldTruthy', path: 'artifact_plan.write_authorized' },
        { kind: 'FieldTruthy', path: 'program.domain_synthesis_complete' },
      ]),
    );
    expect(parsed.modes.scaffold_plan.transitions).toEqual(
      expect.arrayContaining([
        { target: 'domain_synthesis', guard: { kind: 'FieldEquals', path: 'artifact_plan.status', value: 'approved' } },
      ]),
    );
    expect(parsed.modes.domain_synthesis.transitions).toEqual(
      expect.arrayContaining([
        { target: 'branch_write', guard: { kind: 'FieldTruthy', path: 'program.domain_synthesis_complete' } },
      ]),
    );
    expect(parsed.modes.static_verify.transitions).toEqual(
      expect.arrayContaining([
        {
          target: 'smoke_verify',
          guard: { kind: 'FieldEquals', path: 'graduation.static_verification', value: 'passed' },
        },
      ]),
    );
    expect(parsed.modes.smoke_verify.transitions).toEqual(
      expect.arrayContaining([
        {
          target: 'live_verify',
          guard: { kind: 'FieldTruthy', path: 'graduation.ready_for_live' },
        },
      ]),
    );
    expect(parsed.modes.smoke_verify.preconditions?.confirm_live_provider_intent).toEqual(
      expect.arrayContaining([{ kind: 'FieldEquals', path: 'graduation.smoke_verification', value: 'passed' }]),
    );
    expect(parsed.modes.smoke_verify.preconditions?.run_smoke_verification).toEqual(
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
    expect(parsed.action_map.authorize_standalone_target.mutations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'repo.target_kind', value: 'standalone_repo' }),
        expect.objectContaining({ path: 'repo.write_authorized', value: true }),
        expect.objectContaining({ path: 'repo.wiring_manifest.status', value: 'not_required' }),
      ]),
    );
    expect(parsed.action_map.load_wiring_manifest.mutations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'repo.target_kind', value: 'existing_repo' }),
        expect.objectContaining({ path: 'repo.wiring_manifest.repo_root', from_arg: 'repo_root' }),
        expect.objectContaining({ path: 'repo.wiring_manifest.status', value: 'valid' }),
        expect.objectContaining({ path: 'repo.wiring_manifest.path', value: '.pgas/wiring.yml' }),
        expect.objectContaining({ path: 'repo.write_authorized', value: true }),
      ]),
    );
    expect(parsed.action_map.create_curator_request.arg_descriptions).toMatchObject({
      message: expect.stringContaining('optional context'),
      repo_root: expect.stringContaining('Optional override'),
      title: expect.stringContaining('Optional'),
      body: expect.stringContaining('Optional'),
    });
    expect(parsed.action_map.run_static_verification.mutations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'graduation.static_verification', from_arg: 'status' }),
        expect.objectContaining({ path: 'graduation.static_evidence_id', from_arg: 'evidence_id' }),
      ]),
    );
    expect(parsed.action_map.synthesize_domain_logic).toMatchObject({
      // widget_output is load-bearing: the engine's NoticeContinuation only
      // auto-continues widget_output effects, and synthesize_domain_logic must
      // auto-continue into branch_write. No result_path: the engine's ER-2
      // compiler check forbids result_path on an Async channel; the audit
      // stays durable in the synthesizer transit store.
      channel: 'widget_output',
    });
    expect(parsed.action_map.synthesize_domain_logic.result_path).toBeUndefined();
    expect(parsed.action_map.synthesize_domain_logic.mutations).toEqual([
      expect.objectContaining({ path: 'program.domain_synthesis_complete', value: true }),
    ]);
    expect(parsed.action_map.run_smoke_verification.mutations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'graduation.smoke_verification', from_arg: 'status' }),
        expect.objectContaining({ path: 'graduation.smoke_evidence_id', from_arg: 'evidence_id' }),
      ]),
    );
    expect(parsed.action_map.confirm_live_provider_intent.mutations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'graduation.live_provider_intent', value: true }),
        expect.objectContaining({ path: 'graduation.ready_for_live', value: true }),
      ]),
    );
  });
});
