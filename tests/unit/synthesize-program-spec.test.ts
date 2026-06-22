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
      modes: Record<string, { channels?: string[]; transitions?: Array<{ target: string; guard?: { path?: string } }> }>;
      schema: Record<string, string>;
      action_map: Record<string, { mutations: Array<{ path: string; value?: unknown }> }>;
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
      'triage.result_json': 'string',
      'triage.items_json': 'string',
    });
    expect(parsed.action_map.example_action.mutations.map((mutation) => mutation.path)).toEqual([
      'triage.summary_ready',
      'triage.result_json',
      'triage.items_json',
    ]);
    expect(parsed.guidance.triage.join('\n')).toContain('delegation');

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
      modes: Record<string, unknown>;
      schema: Record<string, string>;
    };

    expect(result).toMatchObject({ mode_names: stageNames });
    expect(Object.keys(parsed.modes)).toEqual(stageNames);
    expect(parsed.schema).toMatchObject({
      'classify.result_json': 'string',
      'classify.items_json': 'string',
      'investigate.result_json': 'string',
      'investigate.items_json': 'string',
      'resolve.result_json': 'string',
      'resolve.items_json': 'string',
    });
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
      'intelligence.result_json': 'string',
      'web_analysis.items_json': 'string',
      'asset_verification.result_json': 'string',
      'reporting.items_json': 'string',
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
