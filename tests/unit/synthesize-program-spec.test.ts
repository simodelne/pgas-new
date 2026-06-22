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

  it('rejects intake with a non-3-stage mode graph', async () => {
    await expect(
      handlers.synthesize_program_spec({
        sessionId: 'session-too-many-stages',
        domain: domain({
          'intake.stages_json': JSON.stringify([...stages, { slug: 'closed' }]),
        }),
      }),
    ).rejects.toThrow(/synthesizer expects 3 stages; got 4/);
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

function writeTempSpec(specYaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pgas-new-synth-load-'));
  const specPath = join(dir, 'specs.yml');
  writeFileSync(specPath, specYaml);
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return specPath;
}
