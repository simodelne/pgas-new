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
      expect(registration).not.toContain("from 'node:path'");
      expect(registration).not.toContain("from 'node:url'");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
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
          arg_descriptions?: Record<string, string>;
          mutations: Array<{ op: string; path: string; from_arg?: string; value?: unknown }>;
        }>;
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

  it('renders generated write-safety gates for existing repo attachments', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pgas-new-gates-'));
    try {
      renderStandaloneScaffold({ outDir, slug: 'pgas-new', name: 'PGAS New' });
      const spec = readFileSync(join(outDir, 'src/programs/pgas-new/specs.yml'), 'utf8');
      const parsed = load(spec) as {
        modes: Record<string, {
          preconditions?: Record<string, Array<{ kind: string; path: string; value?: unknown; triggerSet?: string[] }>>;
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
      expect(parsed.schema['repo.wiring_manifest.repo_root']).toBe('string');
      expect(parsed.schema['repo.wiring_manifest_json']).toBe('string');
      expect(parsed.schema['repo.allowed_imports']).toBe('array');
      expect(parsed.schema['intake.research_allowed']).toBe('boolean');
      expect(parsed.schema['intake.user_research_authorized']).toBe('boolean');
      expect(parsed.schema['graduation.static_evidence_id']).toBe('string');
      expect(parsed.schema['graduation.ready_for_live']).toBe('boolean');
      expect(parsed.schema['graduation.rebase_static_evidence_id']).toBe('string');
      expect(parsed.proceed_to.load_wiring_manifest).toBeUndefined();
      expect(parsed.proceed_to.confirm_design).toBe('repo_targeting');
      expect(parsed.proceed_to.authorize_standalone_target).toBe('architecture_design');
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
