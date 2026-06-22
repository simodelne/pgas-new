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

      expect(readFileSync(join(outDir, 'package.json'), 'utf8')).toContain('"@simodelne/pgas-server": "^2.13.0"');
      expect(server).toContain("from '@simodelne/pgas-server/create-server.js'");
      expect(registration).toContain("from '@simodelne/pgas-server/plugin.js'");
      expect(registration).toContain('type ProgramEntry');
      expect(registration).toContain('createProgramAdapters');
      expect(registration).toContain('createToolRegistry');
      expect(registration).toContain('loadSpecWithPatterns');
      expect(registration).toContain('enableNotebook');
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
      expect(tests.join('\n')).toContain('LIVE_PROVIDER_TIMEOUT_MS');
      expect(tests.join('\n')).toContain('PGAS_LIVE_PROVIDER_TIMEOUT_MS');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('declares the foundry intake actions, JSON-string intake recording shape, and guidance', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pgas-new-foundry-intake-'));
    try {
      renderStandaloneScaffold({ outDir, slug: 'pgas-new', name: 'PGAS New' });

      const specText = readFileSync(join(outDir, 'src/programs/pgas-new/specs.yml'), 'utf8');
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
          mutations: Array<{ op: string; path: string; from_arg?: string; value?: unknown }>;
        }>;
        schema: Record<string, string>;
        ingestion: Record<string, string[]>;
        guidance: Record<string, string[]>;
      };

      expect(parsed.modes.intake_intelligence.vocabulary).toEqual(
        expect.arrayContaining([
          'record_program_target',
          'choose_design_path',
          'apply_default_skeleton',
          'record_program_intake',
          'confirm_design',
        ]),
      );
      expect(parsed.modes.architecture_design.vocabulary).toEqual(
        expect.arrayContaining(['synthesize_program_spec']),
      );
      expect(parsed.modes.architecture_design.preconditions?.synthesize_program_spec).toEqual(
        expect.arrayContaining([{ kind: 'FieldTruthy', path: 'program.design_confirmed' }]),
      );
      expect(parsed.modes.architecture_design.transitions).toEqual([
        { target: 'scaffold_plan', guard: { kind: 'FieldTruthy', path: 'program.synthesis_complete' } },
      ]);
      expect(parsed.modes.intake_intelligence.channels).toEqual(expect.arrayContaining(['user_confirmation']));
      expect(parsed.modes.intake_intelligence.transitions).toEqual(
        expect.arrayContaining([
          { target: 'architecture_design', guard: { kind: 'FieldTruthy', path: 'program.design_confirmed' } },
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
          { kind: 'FieldFalsy', path: 'intake.program_intake_recorded' },
        ]),
      );
      expect(parsed.modes.intake_intelligence.preconditions?.record_program_intake).toEqual(
        expect.arrayContaining([
          { kind: 'FieldEquals', path: 'program.design_path', value: 'design' },
          { kind: 'FieldFalsy', path: 'intake.program_intake_recorded' },
        ]),
      );
      expect(parsed.modes.intake_intelligence.preconditions?.confirm_design).toEqual(
        expect.arrayContaining([
          { kind: 'FieldTruthy', path: 'intake.program_intake_recorded' },
          { kind: 'FieldTruthy', path: 'program.target_dir_confirmed' },
          { kind: 'FieldFalsy', path: 'program.design_confirmed' },
          { kind: 'TriggerType', triggerSet: ['user_confirmation'] },
          { kind: 'FieldEquals', path: 'inputs.user_decision.decision', value: 'approve' },
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
        { op: 'MSet', path: 'intake.entry_channel', value: 'user_text' },
        {
          op: 'MSet',
          path: 'intake.stages_json',
          value: '[{"slug":"start","is_bootstrap":true},{"slug":"working"},{"slug":"complete","is_terminal":true}]',
        },
        {
          op: 'MSet',
          path: 'intake.transitions_json',
          value: '[{"from":"start","to":"working","trigger":"auto"},{"from":"working","to":"complete","trigger":"auto","guard_field":"work.example_ready","guard_value":true}]',
        },
        { op: 'MSet', path: 'intake.delegation_json', value: '{}' },
        {
          op: 'MSet',
          path: 'intake.completion_json',
          value: '{"final_stage":"complete","guard_field":"work.example_ready"}',
        },
        { op: 'MSet', path: 'intake.program_intake_recorded', value: true },
      ]);
      expect(parsed.modes.intake_intelligence.vocabulary).toContain('record_program_intake');
      expect(parsed.action_map.record_program_intake).toMatchObject({
        description: "Capture the user's Q1-Q6 design interview answers into governed JSON-string scalar state.",
        channel: 'widget_output',
      });
      expect(parsed.action_map.record_program_intake.mutations).toEqual([
        { op: 'MSet', path: 'intake.purpose', from_arg: 'purpose' },
        { op: 'MSet', path: 'intake.entry_channel', from_arg: 'entry_channel' },
        { op: 'MSet', path: 'intake.stages_json', from_arg: 'stages_json' },
        { op: 'MSet', path: 'intake.transitions_json', from_arg: 'transitions_json' },
        { op: 'MSet', path: 'intake.delegation_json', from_arg: 'delegation_json' },
        { op: 'MSet', path: 'intake.completion_json', from_arg: 'completion_json' },
        { op: 'MSet', path: 'intake.program_intake_recorded', value: true },
      ]);
      expect(parsed.action_map.confirm_design.mutations).toEqual([
        { op: 'MSet', path: 'program.design_confirmed', value: true },
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
          'intake.entry_channel',
          'intake.stages_json',
          'intake.transitions_json',
          'intake.delegation_json',
          'intake.completion_json',
          'intake.program_intake_recorded',
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
        'program.target_dir': 'string',
        'program.target_dir_confirmed': 'boolean',
        'program.skip_dimensions': 'array',
        'program.skip_dimensions.*': 'string',
        'intake.purpose': 'string',
        'intake.entry_channel': 'string',
        'intake.stages_json': 'string',
        'intake.transitions_json': 'string',
        'intake.delegation_json': 'string',
        'intake.completion_json': 'string',
        'intake.program_intake_recorded': 'boolean',
      });
      expect(parsed.schema).not.toHaveProperty('program.synthesized_spec');
      expect(parsed.guidance.architecture_design).toEqual(
        expect.arrayContaining([
          expect.stringContaining('call synthesize_program_spec'),
          expect.stringContaining('in-process transit'),
        ]),
      );
      expect(parsed.guidance.scaffold_plan.join('\n')).toContain('synthesized spec in in-process transit');
      expect(parsed.guidance.scaffold_plan.join('\n')).toContain('call synthesize_program_spec again');
      expect(parsed.guidance.intake_intelligence).toEqual(
        expect.arrayContaining([
          expect.stringContaining('program.target_dir_confirmed is not true'),
          expect.stringContaining("intent='choose_design_path'"),
          expect.stringContaining('call apply_default_skeleton'),
          expect.stringContaining('ask the 6 design questions IN ORDER'),
          expect.stringContaining('JSON-string scalar fields'),
          expect.stringContaining("intent='confirm_design'"),
          expect.stringContaining("Don't re-ask anything you already extracted"),
        ]),
      );
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
        'programs/draft-policy/handlers/index.ts',
        'programs/draft-policy/handlers/_resolver.ts',
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

  it('renders web-scraper artifacts with hard network guardrails encoded in the spec, tools, and handlers', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'pgas-new-attached-web-scraper-'));
    try {
      const result = renderExistingRepoAttachment({
        repoRoot,
        manifest: VALID_MANIFEST,
        slug: 'web-scraper',
        name: 'Web Scraper',
        template: 'web-scraper',
        mandate: 'Ethical legal corpus scraper with HARD network guardrails',
      });

      expect(result.written).toEqual([
        'programs/web-scraper/specs.yml',
        'programs/web-scraper/registration.ts',
        'programs/web-scraper/handlers.ts',
        'programs/web-scraper/handlers/index.ts',
        'programs/web-scraper/handlers/_resolver.ts',
        'programs/web-scraper/tools.ts',
        '.pgas/pgas-new/web-scraper/dossier.yml',
        '.pgas/pgas-new/web-scraper/artifacts.json',
        'audit/PGAS-NEW-web-scraper.md',
      ]);

      const spec = readFileSync(join(repoRoot, 'programs/web-scraper/specs.yml'), 'utf8');
      const tools = readFileSync(join(repoRoot, 'programs/web-scraper/tools.ts'), 'utf8');
      const handlers = readFileSync(join(repoRoot, 'programs/web-scraper/handlers.ts'), 'utf8');
      const dossier = readFileSync(join(repoRoot, '.pgas/pgas-new/web-scraper/dossier.yml'), 'utf8');
      const parsed = load(spec) as {
        modes: Record<string, {
          vocabulary?: string[];
          preconditions?: Record<string, Array<{ kind: string; path?: string; value?: unknown }>>;
          transitions?: Array<{ target: string; guard?: { kind: string; path?: string; value?: unknown } }>;
        }>;
        action_map: Record<string, { mutations?: Array<{ path: string; value?: unknown; from_arg?: string }> }>;
        proceed_to: Record<string, string>;
        schema: Record<string, string>;
        terminal: string[];
      };

      // 9 modes (8 active + blocked terminal pair) — matches the handoff.
      expect(Object.keys(parsed.modes)).toEqual([
        'intake',
        'intelligence',
        'egress_verification',
        'web_analysis',
        'strategy_review',
        'scraping',
        'asset_verification',
        'complete',
        'blocked',
      ]);
      expect(parsed.terminal).toEqual(['complete', 'blocked']);

      // No analysis call without confirmed egress.
      const analysisTools = ['check_robots_and_terms', 'analyze_html_sample', 'playwright_snapshot', 'vision_analyze_snapshot'];
      for (const tool of analysisTools) {
        expect(parsed.modes.web_analysis.preconditions?.[tool]).toEqual(
          expect.arrayContaining([expect.objectContaining({ kind: 'FieldTruthy', path: 'egress.confirmed' })]),
        );
      }

      // No scraping without confirmed egress AND user-approved strategy AND last asset verified.
      expect(parsed.modes.scraping.preconditions?.fetch_one_asset).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'FieldTruthy', path: 'egress.confirmed' }),
          expect.objectContaining({ kind: 'FieldTruthy', path: 'strategy.user_approved' }),
          expect.objectContaining({ kind: 'FieldEquals', path: 'scraping.last_asset_verified', value: true }),
        ]),
      );

      // Strategy approval requires the user_confirmation trigger.
      expect(parsed.modes.strategy_review.preconditions?.approve_scraping_strategy).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'TriggerType', triggerSet: ['user_confirmation'] }),
          expect.objectContaining({ kind: 'FieldEquals', path: 'inputs.user_decision.decision', value: 'approve' }),
          expect.objectContaining({ kind: 'FieldTruthy', path: 'strategy.proposal_json' }),
        ]),
      );

      // Asset_verification transitions: back to scraping when verified, complete when budget exhausted, blocked on user_decision required.
      expect(parsed.modes.asset_verification.transitions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            target: 'scraping',
            guard: expect.objectContaining({ kind: 'FieldEquals', path: 'scraping.last_asset_verified', value: true }),
          }),
          expect.objectContaining({
            target: 'complete',
            guard: expect.objectContaining({ kind: 'FieldTruthy', path: 'scraping.budget_exhausted' }),
          }),
          expect.objectContaining({
            target: 'blocked',
            guard: expect.objectContaining({ kind: 'FieldTruthy', path: 'verification.requires_user_decision' }),
          }),
        ]),
      );

      // Durable ledger schema declared.
      expect(parsed.schema['ledger.path']).toBe('string');
      expect(parsed.schema['ledger.entries_count']).toBe('number');
      expect(parsed.schema['scraping.last_asset_verified']).toBe('boolean');
      expect(parsed.schema['scraping.budget_exhausted']).toBe('boolean');
      expect(parsed.schema['strategy.user_approved']).toBe('boolean');
      expect(parsed.schema['egress.confirmed']).toBe('boolean');

      // Mandate landed (literal block scalar — newlines/colons in user mandates are safe).
      expect(spec).toContain('Ethical legal corpus scraper with HARD network guardrails');
      expect(dossier).toContain('Ethical legal corpus scraper with HARD network guardrails');
      expect(dossier).toContain('declared_purpose');
      expect(dossier).toContain('Stop rather than evade blocks');

      // fetch_one_asset MUST land its asset id and force the verification step (last_asset_verified=false on fetch).
      expect(parsed.action_map.fetch_one_asset.mutations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'scraping.last_asset_id', from_arg: 'asset_id' }),
          expect.objectContaining({ path: 'scraping.last_asset_verified', value: false }),
        ]),
      );

      // tools.ts encodes the rejection logic for URL arrays, wildcards, xargs, parallel, etc.
      expect(tools).toContain('FORBIDDEN_PAYLOAD_KEYS');
      expect(tools).toContain('xargs');
      expect(tools).toContain('parallel');
      expect(tools).toContain('payload may not declare plural field');
      expect(tools).toContain('url must not contain wildcards');
      expect(tools).toContain('url must be a single string, not an array');

      // handlers.ts has the array-rejection plumb on every networked tool.
      expect(handlers).toContain('rejectArrays');
      expect(handlers).toContain('attachment_points');
      expect(handlers).toContain('fetch_one_asset');
      expect(handlers).toContain('robots_fetcher');

      // proceed_to wiring covers the canonical ladder.
      expect(parsed.proceed_to.record_intake).toBe('intelligence');
      expect(parsed.proceed_to.confirm_egress_ip).toBe('web_analysis');
      expect(parsed.proceed_to.approve_scraping_strategy).toBe('scraping');
      expect(parsed.proceed_to.fetch_one_asset).toBe('asset_verification');
      expect(parsed.proceed_to.complete_run).toBe('complete');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('renders the social-media-agent program in a standalone scaffold via --template', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pgas-new-standalone-sma-'));
    try {
      const result = renderStandaloneScaffold({
        outDir,
        slug: 'social-media-agent',
        name: 'Social Media Agent',
        template: 'social-media-agent',
        mandate:
          'Manage a demo social media account via mocked web navigation only; never log into a real account; never post to a real account; explicit human approval before every publish.',
      });

      expect(result.written).toEqual(
        createStandaloneArtifactPlan({ slug: 'social-media-agent', name: 'Social Media Agent' }).artifacts.map(
          (artifact) => artifact.path,
        ),
      );

      const spec = readFileSync(join(outDir, 'src/programs/social-media-agent/specs.yml'), 'utf8');
      const tools = readFileSync(join(outDir, 'src/programs/social-media-agent/tools.ts'), 'utf8');
      const handlers = readFileSync(join(outDir, 'src/programs/social-media-agent/handlers.ts'), 'utf8');
      const dossier = readFileSync(join(outDir, '.pgas/pgas-new/social-media-agent/dossier.yml'), 'utf8');
      const parsed = load(spec) as {
        modes: Record<string, {
          vocabulary?: string[];
          preconditions?: Record<string, Array<{ kind: string; path?: string; value?: unknown; triggerSet?: string[] }>>;
          transitions?: Array<{ target: string; guard?: { kind: string; path?: string; value?: unknown } }>;
        }>;
        action_map: Record<string, { mutations?: Array<{ path: string; value?: unknown; from_arg?: string }> }>;
        terminal: string[];
        schema: Record<string, string>;
      };

      expect(Object.keys(parsed.modes)).toEqual([
        'intake',
        'mock_adapter_check',
        'session_bootstrap',
        'monitor_feed',
        'draft_review',
        'human_approval',
        'post_publish',
        'post_verification',
        'complete',
        'blocked',
      ]);
      expect(parsed.terminal).toEqual(['complete', 'blocked']);

      expect(parsed.modes.mock_adapter_check.preconditions?.confirm_mock_adapter).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'FieldEquals', path: 'safety.no_real_credentials', value: true }),
        ]),
      );
      expect(parsed.modes.session_bootstrap.preconditions?.bootstrap_mock_session).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'FieldEquals', path: 'browser.adapter_kind', value: 'mock' }),
        ]),
      );
      expect(parsed.modes.human_approval.preconditions?.approve_draft).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'TriggerType', triggerSet: ['user_confirmation'] }),
          expect.objectContaining({ kind: 'FieldEquals', path: 'inputs.user_decision.decision', value: 'approve' }),
        ]),
      );
      expect(parsed.modes.post_publish.preconditions?.publish_one_draft).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'FieldTruthy', path: 'approval.user_approved' }),
          expect.objectContaining({ kind: 'FieldEquals', path: 'browser.adapter_kind', value: 'mock' }),
          expect.objectContaining({ kind: 'FieldEquals', path: 'post.last_post_verified', value: true }),
        ]),
      );

      expect(parsed.action_map.publish_one_draft.mutations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'post.last_post_id', from_arg: 'post_id' }),
          expect.objectContaining({ path: 'post.last_post_verified', value: false }),
        ]),
      );

      expect(parsed.schema['safety.no_real_credentials']).toBe('boolean');
      expect(parsed.schema['browser.adapter_kind']).toBe('string');
      expect(parsed.schema['approval.user_approved']).toBe('boolean');
      expect(parsed.schema['post.last_post_verified']).toBe('boolean');

      expect(tools).toContain('REAL_PLATFORM_DOMAINS');
      expect(tools).toContain('twitter.com');
      expect(tools).toContain('mock/demo URLs only');
      expect(tools).toContain('publish exactly one draft');
      expect(tools).toContain('no real credentials accepted');
      expect(tools).toContain('FORBIDDEN_PAYLOAD_KEYS');

      expect(handlers).toContain('rejectArrays');
      expect(handlers).toContain('assertMockAdapter');
      expect(handlers).toContain('attachment_points');
      expect(handlers).toContain('mock_browser_adapter');
      expect(handlers).toContain('mock_publisher');

      expect(dossier).toContain('Manage a demo social media account via mocked web navigation only');
      expect(dossier).toContain('No real social media credentials');
      expect(dossier).toContain('mock_browser_adapter');
      expect(dossier).toContain('forbidden_capabilities');
      expect(dossier).toContain('navigate_real_platform');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
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
    for (const template of ['pgas-new-foundry', 'policy-drafting', 'web-scraper', 'social-media-agent'] as const) {
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

  it('renders social-media-agent artifacts via render-attach with mock-only guardrails', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'pgas-new-attached-sma-'));
    try {
      const result = renderExistingRepoAttachment({
        repoRoot,
        manifest: VALID_MANIFEST,
        slug: 'social-media-agent',
        name: 'Social Media Agent',
        template: 'social-media-agent',
        mandate: 'Demo-only social media account agent operating through a mocked browser adapter with explicit human approval gates before every publish.',
      });

      expect(result.written).toEqual([
        'programs/social-media-agent/specs.yml',
        'programs/social-media-agent/registration.ts',
        'programs/social-media-agent/handlers.ts',
        'programs/social-media-agent/handlers/index.ts',
        'programs/social-media-agent/handlers/_resolver.ts',
        'programs/social-media-agent/tools.ts',
        '.pgas/pgas-new/social-media-agent/dossier.yml',
        '.pgas/pgas-new/social-media-agent/artifacts.json',
        'audit/PGAS-NEW-social-media-agent.md',
      ]);

      const spec = readFileSync(join(repoRoot, 'programs/social-media-agent/specs.yml'), 'utf8');
      const dossier = readFileSync(join(repoRoot, '.pgas/pgas-new/social-media-agent/dossier.yml'), 'utf8');
      expect(spec).toContain('mock_adapter_check');
      expect(spec).toContain('approve_draft');
      expect(spec).toContain('publish_one_draft');
      expect(dossier).toContain('Demo-only social media account agent');
      expect(dossier).toContain('forbidden_capabilities');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('enforces social-media-agent safety gates H1-H4 + M5 from issue #30', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pgas-new-sma-safety-'));
    try {
      renderStandaloneScaffold({
        outDir,
        slug: 'sma',
        name: 'SMA',
        template: 'social-media-agent',
      });

      const spec = readFileSync(join(outDir, 'src/programs/sma/specs.yml'), 'utf8');
      const tools = readFileSync(join(outDir, 'src/programs/sma/tools.ts'), 'utf8');
      const handlers = readFileSync(join(outDir, 'src/programs/sma/handlers.ts'), 'utf8');

      const parsed = load(spec) as {
        modes: Record<string, {
          preconditions?: Record<string, Array<{ kind: string; path?: string; value?: unknown }>>;
        }>;
        action_map: Record<string, { mutations?: Array<{ path: string; value?: unknown; from_arg?: string }> }>;
        ingestion: Record<string, string[]>;
        schema: Record<string, string>;
      };

      // H1: record_intake requires inputs.no_real_credentials=true at the spec layer.
      expect(parsed.modes.intake.preconditions?.record_intake).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'FieldEquals', path: 'inputs.no_real_credentials', value: true }),
        ]),
      );
      // ingestion + schema declare the new user-supplied field.
      expect(parsed.ingestion.user_text).toEqual(expect.arrayContaining(['inputs.no_real_credentials']));
      expect(parsed.schema['inputs.no_real_credentials']).toBe('boolean');

      // H2: confirm_mock_adapter requires inputs.adapter_kind=mock at the spec layer.
      expect(parsed.modes.mock_adapter_check.preconditions?.confirm_mock_adapter).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'FieldEquals', path: 'inputs.adapter_kind', value: 'mock' }),
        ]),
      );
      expect(parsed.ingestion.user_text).toEqual(expect.arrayContaining(['inputs.adapter_kind']));
      expect(parsed.schema['inputs.adapter_kind']).toBe('string');

      // H3: tools.ts wraps every action via safetyValidatedTool — no noopTool pass-through.
      expect(tools).toContain('safetyValidatedTool');
      expect(tools).not.toContain('const noopTool');
      // Every semantic tool registers through safetyValidatedTool.
      expect(tools).toMatch(/registry\.register\(name, safetyValidatedTool\(name/);

      // H4: approve_draft no longer mutates post.last_post_verified.
      const approveMutations = parsed.action_map.approve_draft.mutations ?? [];
      const writesVerified = approveMutations.some((m) => m.path === 'post.last_post_verified');
      expect(writesVerified).toBe(false);

      // M5: forbidden_capabilities from the dossier are enforced in tools + handlers.
      expect(tools).toContain('FORBIDDEN_CAPABILITY_NAMES');
      expect(tools).toContain('navigate_real_platform');
      expect(tools).toContain('submit_real_credentials');
      expect(tools).toContain('publish_real_post');
      expect(tools).toContain('read_real_user_profile');
      expect(tools).toContain('assertNoForbiddenCapability');
      expect(handlers).toContain('FORBIDDEN_CAPABILITY_NAMES');
      expect(handlers).toContain('assertNoForbiddenCapability');

      // Defense-in-depth bonus: assertMockAdapter now covers bootstrap + capture too.
      expect(handlers).toMatch(/bootstrap_mock_session[\s\S]*?assertMockAdapter\('bootstrap_mock_session'/);
      expect(handlers).toMatch(/capture_feed_snapshot[\s\S]*?assertMockAdapter\('capture_feed_snapshot'/);
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
      expect(parsed.schema['repo.wiring_manifest_json']).toBe('string');
      expect(parsed.schema['repo.allowed_imports']).toBe('array');
      expect(parsed.schema['intake.research_allowed']).toBe('boolean');
      expect(parsed.schema['intake.user_research_authorized']).toBe('boolean');
      expect(parsed.schema['graduation.static_evidence_id']).toBe('string');
      expect(parsed.schema['graduation.ready_for_live']).toBe('boolean');
      expect(parsed.schema['graduation.rebase_static_evidence_id']).toBe('string');
      expect(parsed.proceed_to.load_wiring_manifest).toBeUndefined();
      expect(parsed.proceed_to.authorize_existing_repo_target).toBe('architecture_design');
      expect(parsed.proceed_to.run_static_verification).toBeUndefined();
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
          expect.objectContaining({ path: 'repo.wiring_manifest.status', value: 'valid' }),
          expect.objectContaining({ path: 'repo.wiring_manifest.path', value: '.pgas/wiring.yml' }),
          expect.objectContaining({ path: 'repo.write_authorized', value: true }),
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

  it('renders policy-drafting program in a standalone scaffold via --template', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pgas-new-standalone-pd-'));
    try {
      const result = renderStandaloneScaffold({
        outDir,
        slug: 'draft-policy',
        name: 'Draft Policy',
        template: 'policy-drafting',
        mandate: 'Risk-based policy drafting for SimoneOS.',
      });

      expect(result.written).toEqual(
        createStandaloneArtifactPlan({ slug: 'draft-policy', name: 'Draft Policy' }).artifacts.map(
          (a) => a.path,
        ),
      );

      const spec = readFileSync(join(outDir, 'src/programs/draft-policy/specs.yml'), 'utf8');
      for (const artifact of result.plan.artifacts) {
        expect(readFileSync(join(outDir, artifact.path), 'utf8')).not.toContain('{{');
      }
      expect(spec).toContain('policy_objectives');
      expect(spec).toContain('approve_outline');
      expect(spec).toContain('render_policy_outputs');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('renders web-scraper program in a standalone scaffold via --template', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pgas-new-standalone-ws-'));
    try {
      const result = renderStandaloneScaffold({
        outDir,
        slug: 'web-scraper',
        name: 'Web Scraper',
        template: 'web-scraper',
        mandate: 'Ethical corpus scraper with hard network guardrails.',
      });

      expect(result.written).toEqual(
        createStandaloneArtifactPlan({ slug: 'web-scraper', name: 'Web Scraper' }).artifacts.map(
          (a) => a.path,
        ),
      );

      const spec = readFileSync(join(outDir, 'src/programs/web-scraper/specs.yml'), 'utf8');
      for (const artifact of result.plan.artifacts) {
        expect(readFileSync(join(outDir, artifact.path), 'utf8')).not.toContain('{{');
      }
      expect(spec).toContain('egress.confirmed');
      expect(spec).toContain('fetch_one_asset');
      expect(spec).toContain('strategy.user_approved');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
