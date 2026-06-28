import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { loadSpecWithPatterns } from '@simodelne/pgas-server/plugin.js';
import { handlers } from '../../src/foundry-program/handlers.js';
import {
  clearSynthesizedArtifact,
  getSynthesizedArtifact,
} from '../../src/foundry-program/synthesizer-store.js';

const stages = [
  { slug: 'intake', is_bootstrap: true },
  { slug: 'triage' },
  { slug: 'resolved', is_terminal: true },
];

const transitions = [
  { from: 'intake', to: 'triage', trigger: 'ready', guard_field: 'intake.started' },
  { from: 'triage', to: 'resolved', trigger: 'summary_ready', guard_field: 'triage.summary_ready' },
];

const delegation = { triage: { target: 'human-review', when: 'severity_high' } };
const completion = { final_stage: 'resolved', guard_field: 'triage.summary_ready' };

function domain(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'program.slug': 'incident-triage',
    'program.name': 'Incident Triage',
    'program.target_dir': '/tmp/incident-triage',
    'program.design_path': 'design',
    'intake.purpose': 'Route incoming incidents into a triage workflow.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify(stages),
    'intake.transitions_json': JSON.stringify(transitions),
    'intake.delegation_json': JSON.stringify(delegation),
    'intake.completion_json': JSON.stringify(completion),
    ...overrides,
  };
}

describe('synthesize_program_spec handler', () => {
  it('mechanically synthesizes, validates, and stores YAML without returning it', async () => {
    clearSynthesizedArtifact('session-synth');

    const result = await handlers.synthesize_program_spec({
      sessionId: 'session-synth',
      domain: domain(),
    });

    expect(result).toEqual({
      kind: 'mechanical_synthesis',
      no_llm_call: true,
      mode_names: ['intake', 'triage', 'resolved'],
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result).not.toHaveProperty('spec_yaml');

    const artifact = getSynthesizedArtifact('session-synth');
    expect(artifact).toMatchObject({
      mode_names: ['intake', 'triage', 'resolved'],
      sha256: (result as { sha256: string }).sha256,
    });
    expect(typeof artifact?.created_at).toBe('string');

    const parsed = load(artifact?.spec_yaml ?? '') as {
      name: string;
      initial: string;
      terminal: string[];
      modes: Record<string, { channels?: string[]; transitions?: Array<{ target: string; guard?: { path?: string } }>; vocabulary?: string[] }>;
      schema: Record<string, string>;
      action_map: Record<string, {
        channel?: string;
        result_path?: string;
        mutations: Array<{ path: string; value?: unknown; from_arg?: string }>;
      }>;
      proceed_to: Record<string, string>;
      guidance: Record<string, string[]>;
    };

    expect(parsed.name).toBe('incident-triage');
    expect(parsed.initial).toBe('intake');
    expect(parsed.terminal).toEqual(['resolved']);
    expect(Object.keys(parsed.modes)).toEqual(['intake', 'triage', 'resolved']);
    expect(parsed.modes.intake.channels).toEqual(expect.arrayContaining(['user_text']));
    expect(parsed.modes.intake.transitions).toEqual([
      { target: 'triage', guard: { kind: 'FieldTruthy', path: 'intake.started' } },
    ]);
    expect(parsed.modes.triage.transitions).toEqual([
      { target: 'resolved', guard: { kind: 'FieldTruthy', path: 'triage.summary_ready' } },
    ]);
    expect(parsed.schema).toMatchObject({
      'intake.started': 'boolean',
      'triage.summary_ready': 'boolean',
      'triage.output': 'object',
      'triage.output.result_json': 'string',
      'triage.output.items_json': 'string',
    });
    expect(parsed.modes.triage.vocabulary).toEqual(expect.arrayContaining(['complete_triage']));
    expect(parsed.modes.triage.vocabulary).not.toContain('example_action');
    expect(parsed.proceed_to.complete_triage).toBe('resolved');
    expect(parsed.action_map).not.toHaveProperty('example_action');
    expect(parsed.action_map.complete_triage.channel).toBe('stage_output');
    expect(parsed.action_map.complete_triage.result_path).toBe('triage.output');
    expect(parsed.action_map.complete_triage.mutations).toEqual([
      { op: 'MSet', path: 'triage.summary_ready', value: true },
    ]);
    expect(parsed.action_map.complete_triage.mutations.map((mutation) => mutation.path)).toEqual([
      'triage.summary_ready',
    ]);
    expect(parsed.guidance.triage.join('\n')).toContain('delegation');
    expect(artifact?.contracts_ts).toContain('triage');
    expect(artifact?.handlers_ts).toContain('runTriage');
    expect(artifact?.handlers_ts).not.toContain('stage_action_stub');
    expect(artifact?.smoke_test_ts).toContain('generated program smoke');

    expect(() => loadSpecWithPatterns(writeTempSpec(artifact?.spec_yaml ?? ''))).not.toThrow();
  });

  it('emits mixed guarded and unguarded transitions and parses them through the engine loader', async () => {
    const sessionId = 'session-mixed-transition-guards';
    clearSynthesizedArtifact(sessionId);

    await handlers.synthesize_program_spec({
      sessionId,
      domain: domain({
        'intake.stages_json': JSON.stringify([
          { slug: 'alpha', is_bootstrap: true },
          { slug: 'beta' },
          { slug: 'charlie' },
          { slug: 'delta' },
          { slug: 'terminal', is_terminal: true },
        ]),
        'intake.transitions_json': JSON.stringify([
          { from: 'alpha', to: 'beta', trigger: 'auto' },
          { from: 'beta', to: 'charlie', trigger: 'done', guard_field: 'beta.done' },
          { from: 'charlie', to: 'delta', trigger: 'auto', guard_field: '' },
          { from: 'delta', to: 'terminal', trigger: 'complete', guard_field: 'delta.ready' },
        ]),
        'intake.completion_json': JSON.stringify({
          final_stage: 'terminal',
          guard_field: 'completion.ready',
        }),
      }),
    });

    const artifact = getSynthesizedArtifact(sessionId);
    const parsed = load(artifact?.spec_yaml ?? '') as {
      modes: Record<string, { transitions?: Array<{ target: string; guard?: { path?: string } }> }>;
    };

    expect(parsed.modes.alpha.transitions).toEqual([{ target: 'beta' }]);
    expect(parsed.modes.beta.transitions).toEqual([
      { target: 'charlie', guard: { kind: 'FieldTruthy', path: 'beta.done' } },
    ]);
    expect(parsed.modes.charlie.transitions).toEqual([{ target: 'delta' }]);
    expect(parsed.modes.delta.transitions).toEqual([
      { target: 'terminal', guard: { kind: 'FieldTruthy', path: 'completion.ready' } },
    ]);
    expect(() => loadSpecWithPatterns(writeTempSpec(artifact?.spec_yaml ?? ''))).not.toThrow();
  });

  it('rejects completion without a completion guard field', async () => {
    await expect(
      handlers.synthesize_program_spec({
        sessionId: 'session-missing-completion-guard',
        domain: domain({
          'intake.completion_json': JSON.stringify({ final_stage: 'resolved' }),
        }),
      }),
    ).rejects.toThrow(/completion.*guard_field/u);
  });

  it('rejects intake with fewer than 3 stages', async () => {
    for (const stageList of [[], [{ slug: 'intake' }], [{ slug: 'intake' }, { slug: 'resolved' }]]) {
      await expect(
        handlers.synthesize_program_spec({
          sessionId: `session-${stageList.length}-stages`,
          domain: domain({
            'intake.stages_json': JSON.stringify(stageList),
            'intake.transitions_json': JSON.stringify(transitionsFor(stageList.map((stage) => stage.slug))),
            'intake.completion_json': JSON.stringify({
              final_stage: stageList.at(-1)?.slug ?? 'missing',
              guard_field: 'work.ready',
            }),
          }),
        }),
      ).rejects.toThrow(new RegExp(`synthesizer expects at least 3 stages; got ${stageList.length}`));
    }
  });

  it('synthesizes 5-stage intake graphs and parses them through the engine loader', async () => {
    const stageNames = ['intake', 'classify', 'investigate', 'resolve', 'closed'];
    const result = await synthesizeStageGraph('session-five-stages', stageNames);
    const artifact = getSynthesizedArtifact('session-five-stages');
    const parsed = load(artifact?.spec_yaml ?? '') as {
      modes: Record<string, { vocabulary?: string[] }>;
      schema: Record<string, string>;
      action_map: Record<string, { result_path?: string; mutations: Array<{ path: string }> }>;
      proceed_to: Record<string, string>;
    };

    expect(result).toMatchObject({ mode_names: stageNames });
    expect(Object.keys(parsed.modes)).toEqual(stageNames);
    expect(parsed.action_map).not.toHaveProperty('example_action');
    expect(parsed.modes.classify.vocabulary).toEqual(expect.arrayContaining(['complete_classify']));
    expect(parsed.modes.investigate.vocabulary).toEqual(expect.arrayContaining(['complete_investigate']));
    expect(parsed.modes.resolve.vocabulary).toEqual(expect.arrayContaining(['complete_resolve']));
    expect(parsed.proceed_to).toMatchObject({
      complete_classify: 'investigate',
      complete_investigate: 'resolve',
      complete_resolve: 'closed',
    });
    expect(parsed.action_map.complete_classify.mutations.map((mutation) => mutation.path)).toEqual([
      'classify.ready',
      'classify.result_json',
      'classify.items_json',
    ]);
    expect(parsed.action_map.complete_investigate.mutations.map((mutation) => mutation.path)).toEqual([
      'investigate.ready',
    ]);
    expect(parsed.action_map.complete_investigate.result_path).toBe('investigate.output');
    expect(parsed.action_map.complete_resolve.mutations.map((mutation) => mutation.path)).toEqual([
      'resolve.ready',
    ]);
    expect(parsed.action_map.complete_resolve.result_path).toBe('resolve.output');
    expect(parsed.schema).toMatchObject({
      'classify.result_json': 'string',
      'classify.items_json': 'string',
      'investigate.output': 'object',
      'investigate.output.result_json': 'string',
      'investigate.output.items_json': 'string',
      'resolve.output': 'object',
      'resolve.output.result_json': 'string',
      'resolve.output.items_json': 'string',
    });
    expect(() => loadSpecWithPatterns(writeTempSpec(artifact?.spec_yaml ?? ''))).not.toThrow();
  });

  it('emits distinct branch and loop actions that only open one outgoing guard', async () => {
    const sessionId = 'session-branch-loop-actions';
    clearSynthesizedArtifact(sessionId);

    await handlers.synthesize_program_spec({
      sessionId,
      domain: domain({
        'intake.stages_json': JSON.stringify([
          { slug: 'intake', is_bootstrap: true },
          { slug: 'draft' },
          { slug: 'review' },
          { slug: 'revision' },
          { slug: 'complete', is_terminal: true },
        ]),
        'intake.transitions_json': JSON.stringify([
          { from: 'intake', to: 'draft', trigger: 'started', guard_field: 'intake.started' },
          { from: 'draft', to: 'review', trigger: 'ready', guard_field: 'draft.ready' },
          { from: 'review', to: 'revision', trigger: 'revise', guard_field: 'review.needs_revision' },
          { from: 'review', to: 'complete', trigger: 'approve', guard_field: 'review.approved' },
          { from: 'revision', to: 'review', trigger: 'revised', guard_field: 'revision.ready' },
        ]),
        'intake.completion_json': JSON.stringify({
          final_stage: 'complete',
          guard_field: 'review.done',
        }),
      }),
    });

    const artifact = getSynthesizedArtifact(sessionId);
    const parsed = load(artifact?.spec_yaml ?? '') as {
      modes: Record<string, { transitions?: Array<{ target: string; guard?: { path?: string } }>; vocabulary?: string[] }>;
      action_map: Record<string, { result_path?: string; mutations: Array<{ path: string }> }>;
      proceed_to: Record<string, string>;
    };

    expect(parsed.modes.review.transitions).toEqual([
      { target: 'revision', guard: { kind: 'FieldTruthy', path: 'review.needs_revision' } },
      { target: 'complete', guard: { kind: 'FieldTruthy', path: 'review.done' } },
    ]);
    expect(parsed.modes.revision.transitions).toEqual([
      { target: 'review', guard: { kind: 'FieldTruthy', path: 'revision.ready' } },
    ]);
    expect(parsed.modes.review.vocabulary).toEqual(expect.arrayContaining([
      'advance_review_to_revision',
      'advance_review_to_complete',
    ]));
    expect(parsed.modes.review.vocabulary).not.toContain('complete_review');
    expect(parsed.proceed_to.advance_review_to_revision).toBe('revision');
    expect(parsed.proceed_to.advance_review_to_complete).toBe('complete');
    expect(parsed.proceed_to.complete_revision).toBe('review');
    expect(parsed.action_map.advance_review_to_revision.mutations.map((mutation) => mutation.path)).toEqual([
      'review.needs_revision',
      'review.result_json',
      'review.items_json',
    ]);
    expect(parsed.action_map.advance_review_to_complete.mutations.map((mutation) => mutation.path)).toEqual([
      'review.done',
      'review.result_json',
      'review.items_json',
    ]);
    expect(parsed.action_map.complete_revision.mutations.map((mutation) => mutation.path)).toEqual([
      'revision.ready',
    ]);
    expect(parsed.action_map.complete_revision.result_path).toBe('revision.output');
    expect(parsed.action_map.advance_review_to_revision.mutations.map((mutation) => mutation.path)).not.toContain('review.done');
    expect(parsed.action_map.advance_review_to_complete.mutations.map((mutation) => mutation.path)).not.toContain('review.needs_revision');
    expect(() => loadSpecWithPatterns(writeTempSpec(artifact?.spec_yaml ?? ''))).not.toThrow();
  });

  it('synthesizes revised stages after stale Q4 default transitions are refreshed', async () => {
    const sessionId = 'session-revised-stale-transitions';
    clearSynthesizedArtifact(sessionId);

    await handlers.synthesize_program_spec({
      sessionId,
      domain: domain({
        'intake.stages_json': JSON.stringify([
          { slug: 'intake', is_bootstrap: true },
          { slug: 'review' },
          { slug: 'remediation' },
          { slug: 'resolved', is_terminal: true },
        ]),
        'intake.transitions_json': JSON.stringify([
          { from: 'intake', to: 'triage', trigger: 'auto' },
          { from: 'triage', to: 'resolved', trigger: 'auto' },
        ]),
        'intake.completion_json': JSON.stringify({
          final_stage: 'resolved',
          guard_field: 'triage.summary_ready',
        }),
      }),
    });

    const artifact = getSynthesizedArtifact(sessionId);
    const parsed = load(artifact?.spec_yaml ?? '') as {
      modes: Record<string, { transitions?: Array<{ target: string; guard?: { path?: string } }> }>;
    };

    expect(Object.keys(parsed.modes)).toEqual(['intake', 'review', 'remediation', 'resolved']);
    expect(parsed.modes.intake.transitions).toEqual([{ target: 'review' }]);
    expect(parsed.modes.review.transitions).toEqual([{ target: 'remediation' }]);
    expect(parsed.modes.remediation.transitions).toEqual([
      { target: 'resolved', guard: { kind: 'FieldTruthy', path: 'triage.summary_ready' } },
    ]);
    expect(() => loadSpecWithPatterns(writeTempSpec(artifact?.spec_yaml ?? ''))).not.toThrow();
  });

  it('accepts completion before a later blocked terminal sink', async () => {
    const stageNames = ['intake', 'draft', 'review', 'complete', 'blocked'];
    clearSynthesizedArtifact('session-nonfinal-completion');

    await handlers.synthesize_program_spec({
      sessionId: 'session-nonfinal-completion',
      domain: domain({
        'intake.stages_json': JSON.stringify(stageNames.map((slug, index) => ({
          slug,
          is_bootstrap: index === 0 || undefined,
          is_terminal: slug === 'complete' || slug === 'blocked' || undefined,
        }))),
        'intake.transitions_json': JSON.stringify([
          { from: 'intake', to: 'draft', trigger: 'started', guard_field: 'intake.started' },
          { from: 'draft', to: 'review', trigger: 'ready', guard_field: 'draft.ready' },
          { from: 'review', to: 'complete', trigger: 'approved', guard_field: 'review.approved' },
          { from: 'draft', to: 'blocked', trigger: 'blocked', guard_field: 'draft.blocked' },
        ]),
        'intake.completion_json': JSON.stringify({
          final_stage: 'complete',
          guard_field: 'review.done',
        }),
      }),
    });

    const artifact = getSynthesizedArtifact('session-nonfinal-completion');
    const parsed = load(artifact?.spec_yaml ?? '') as {
      terminal: string[];
      modes: Record<string, { transitions?: Array<{ target: string; guard?: { path?: string } }>; vocabulary?: string[] }>;
    };

    expect(Object.keys(parsed.modes)).toEqual(stageNames);
    expect(parsed.terminal).toEqual(['complete', 'blocked']);
    expect(parsed.modes.complete.transitions).toEqual([]);
    expect(parsed.modes.blocked.transitions).toEqual([]);
    expect(parsed.modes.review.transitions).toEqual([
      { target: 'complete', guard: { kind: 'FieldTruthy', path: 'review.done' } },
    ]);
    expect(parsed.modes.complete.vocabulary).toEqual(['session_status', 'session_history', 'session_help']);
    expect(parsed.modes.blocked.vocabulary).toEqual(['session_status', 'session_history', 'session_help']);
    expect(() => loadSpecWithPatterns(writeTempSpec(artifact?.spec_yaml ?? ''))).not.toThrow();
  });

  it('synthesizes 9-stage intake graphs and parses them through the engine loader', async () => {
    const stageNames = [
      'intake',
      'intelligence',
      'egress_verification',
      'web_analysis',
      'strategy_review',
      'scraping',
      'asset_verification',
      'reporting',
      'complete',
    ];
    const result = await synthesizeStageGraph('session-nine-stages', stageNames);
    const artifact = getSynthesizedArtifact('session-nine-stages');
    const parsed = load(artifact?.spec_yaml ?? '') as {
      modes: Record<string, unknown>;
      schema: Record<string, string>;
    };

    expect(result).toMatchObject({ mode_names: stageNames });
    expect(Object.keys(parsed.modes)).toEqual(stageNames);
    expect(parsed.schema).toMatchObject({
      'intelligence.output.result_json': 'string',
      'web_analysis.items_json': 'string',
      'asset_verification.output.result_json': 'string',
      'reporting.output.items_json': 'string',
    });
    expect(() => loadSpecWithPatterns(writeTempSpec(artifact?.spec_yaml ?? ''))).not.toThrow();
  });

  it('rejects intake with wrong JSON-string field types', async () => {
    await expect(
      handlers.synthesize_program_spec({
        sessionId: 'session-bad-json',
        domain: domain({ 'intake.transitions_json': transitions }),
      }),
    ).rejects.toThrow(/missing JSON-string domain field: intake\.transitions_json/);
  });
});

async function synthesizeStageGraph(sessionId: string, stageNames: string[]) {
  clearSynthesizedArtifact(sessionId);
  return handlers.synthesize_program_spec({
    sessionId,
    domain: domain({
      'intake.stages_json': JSON.stringify(stageNames.map((slug, index) => ({
        slug,
        is_bootstrap: index === 0 || undefined,
        is_terminal: index === stageNames.length - 1 || undefined,
      }))),
      'intake.transitions_json': JSON.stringify(transitionsFor(stageNames)),
      'intake.completion_json': JSON.stringify({
        final_stage: stageNames.at(-1),
        guard_field: `${stageNames.at(-2)}.ready`,
      }),
    }),
  });
}

function transitionsFor(stageNames: string[]) {
  return stageNames.slice(0, -1).map((from, index) => ({
    from,
    to: stageNames[index + 1],
    trigger: index === 0 ? 'started' : 'ready',
    guard_field: index === 0 ? `${from}.started` : `${from}.ready`,
  }));
}

function writeTempSpec(specYaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pgas-new-synth-load-'));
  const specPath = join(dir, 'specs.yml');
  writeFileSync(specPath, specYaml);
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return specPath;
}
