import { createTestHarness, type TestHarnessAuthorResponse } from '@simodelne/pgas-server/testing.js';
import { describe, expect, it } from 'vitest';
import { createPgasNewFoundryProgramEntry } from '../../src/foundry-program/registration.js';
import { handlers } from '../../src/foundry-program/handlers.js';

function effect(name: string, payload: Record<string, unknown>): TestHarnessAuthorResponse {
  return {
    actions: [
      {
        kind: 'EffectAction',
        name,
        channel: 'widget_output',
        payload,
      },
    ],
  };
}

const targetActions = [
  effect('record_program_target', {
    slug: 'incident-response',
    name: 'Incident Response',
    target_dir: '/tmp/incident-response',
  }),
  effect('choose_design_path', { choice: 'design' }),
  effect('record_q1_purpose', {
    purpose: 'Coordinate incident response.',
  }),
  effect('record_q2_entry_channel', {
    entry_channel: 'user_text',
  }),
];

const canonicalStages = JSON.stringify([
  { slug: 'triage_intake', is_bootstrap: true },
  { slug: 'root_cause_analysis' },
  { slug: 'mitigation' },
  { slug: 'resolution', is_terminal: true },
]);

const canonicalTransitions = JSON.stringify([
  { from: 'triage_intake', to: 'root_cause_analysis', guard_field: 'triage_complete' },
  { from: 'root_cause_analysis', to: 'mitigation', guard_field: 'root_cause_identified' },
  { from: 'mitigation', to: 'resolution', guard_field: 'mitigation_applied' },
]);

async function recordIntake(actions: TestHarnessAuthorResponse[]): Promise<Record<string, unknown>> {
  const harness = await createTestHarness(createPgasNewFoundryProgramEntry(), {
    programName: 'pgas-new',
    defaultChannel: 'user_text',
    authorResponses: [...targetActions, ...actions],
  });

  try {
    await harness.trigger('Create an incident response PGAS program.');
    await harness.trigger('I want to design it.');
    await harness.trigger('Q1 answer.');
    await harness.trigger('Q2 answer.');
    for (const _action of actions) {
      await harness.trigger('Record the next intake answer.');
    }
    const snapshot = await harness.snapshot();
    return snapshot.domain;
  } finally {
    await harness.close();
  }
}

function expectCanonicalJson(stored: unknown, expected: unknown): void {
  expect(typeof stored).toBe('string');
  const parsed = JSON.parse(stored as string) as unknown;
  expect(parsed).toEqual(expected);
  expect(stored).toBe(JSON.stringify(expected));
}

describe('intake JSON normalization', () => {
  it('stores strict JSON input unchanged as canonical JSON', async () => {
    const domain = await recordIntake([
      effect('record_q3_stages', { stages_json: canonicalStages }),
    ]);

    expect(domain['intake.stages_json']).toBe(canonicalStages);
    expectCanonicalJson(domain['intake.stages_json'], JSON.parse(canonicalStages));

    await expect(
      handlers.record_q3_stages({ stages_json: canonicalStages }),
    ).resolves.toMatchObject({
      stages_json: canonicalStages,
    });
  });

  it('stores bracketed identifier arrays as valid canonical JSON arrays', async () => {
    const expected = ['triage_intake', 'root_cause_analysis', 'mitigation', 'resolution'];
    const domain = await recordIntake([
      effect('record_q3_stages', {
        stages_json: '[triage_intake, root_cause_analysis, mitigation, resolution]',
      }),
    ]);

    expectCanonicalJson(domain['intake.stages_json'], expected);

    await expect(
      handlers.record_q3_stages({
        stages_json: '[triage_intake, root_cause_analysis, mitigation, resolution]',
      }),
    ).resolves.toMatchObject({
      stages_json: JSON.stringify(expected),
    });
  });

  it('stores unquoted-key objects as valid canonical JSON objects', async () => {
    const expected = { enabled: false, mode: 'none' };
    const domain = await recordIntake([
      effect('record_q3_stages', { stages_json: canonicalStages }),
      effect('record_q4_transitions', { transitions_json: canonicalTransitions }),
      effect('record_q5_delegation', { delegation_json: '{enabled: false, mode: none}' }),
    ]);

    expectCanonicalJson(domain['intake.delegation_json'], expected);

    await expect(
      handlers.record_q5_delegation({ delegation_json: '{enabled: false, mode: none}' }),
    ).resolves.toMatchObject({
      delegation_json: JSON.stringify(expected),
    });
  });

  it('stores mixed nested Q4 object-literal arrays as valid canonical JSON', async () => {
    const expected = [
      { from: 'triage_intake', to: 'root_cause_analysis', guard_field: 'triage.complete' },
      { from: 'root_cause_analysis', to: 'mitigation', guard_field: 'root_cause_identified' },
      { from: 'mitigation', to: 'resolution', guard_field: 'mitigation_applied' },
    ];
    const domain = await recordIntake([
      effect('record_q3_stages', { stages_json: canonicalStages }),
      effect('record_q4_transitions', {
        transitions_json: '[{from: triage_intake, to: root_cause_analysis, guard_field: triage.complete}, {from: root_cause_analysis, to: mitigation, guard_field: root_cause_identified}, {from: mitigation, to: resolution, guard_field: mitigation_applied}]',
      }),
    ]);

    expectCanonicalJson(domain['intake.transitions_json'], expected);

    await expect(
      handlers.record_q4_transitions({
        transitions_json: '[{from: triage_intake, to: root_cause_analysis, guard_field: triage.complete}, {from: root_cause_analysis, to: mitigation, guard_field: root_cause_identified}, {from: mitigation, to: resolution, guard_field: mitigation_applied}]',
      }),
    ).resolves.toMatchObject({
      transitions_json: JSON.stringify(expected),
    });
  });

  it('unescapes HTML-escaped quotes before storing canonical Q4 transition JSON', async () => {
    const expected = [
      { from: 'intake', to: 'analysis', guard_field: 'intake.ready' },
    ];
    const escapedTransitions = '[{&quot;from&quot;: &quot;intake&quot;, &quot;to&quot;: &quot;analysis&quot;, &quot;guard_field&quot;: &quot;intake.ready&quot;}]';
    const domain = await recordIntake([
      effect('record_q3_stages', { stages_json: canonicalStages }),
      effect('record_q4_transitions', { transitions_json: escapedTransitions }),
    ]);

    expectCanonicalJson(domain['intake.transitions_json'], expected);

    await expect(
      handlers.record_q4_transitions({ transitions_json: escapedTransitions }),
    ).resolves.toMatchObject({
      transitions_json: JSON.stringify(expected),
    });
  });

  it('unescapes amp-escaped quote entities before parsing intake JSON', async () => {
    const expected = [
      { from: 'intake', to: 'analysis', guard_field: 'intake.ready' },
    ];
    const doubleEscapedTransitions = '[{&amp;quot;from&amp;quot;: &amp;quot;intake&amp;quot;, &amp;quot;to&amp;quot;: &amp;quot;analysis&amp;quot;, &amp;quot;guard_field&amp;quot;: &amp;quot;intake.ready&amp;quot;}]';

    await expect(
      handlers.record_q4_transitions({ transitions_json: doubleEscapedTransitions }),
    ).resolves.toMatchObject({
      transitions_json: JSON.stringify(expected),
    });
  });

  it('unescapes HTML entities inside object literals before tolerant parsing', async () => {
    await expect(
      handlers.record_q5_delegation({ delegation_json: '{&quot;enabled&quot;: false}' }),
    ).resolves.toMatchObject({
      delegation_json: JSON.stringify({ enabled: false }),
    });
  });

  it('unescapes common numeric entities before parsing intake JSON', async () => {
    await expect(
      handlers.record_q6_completion({
        completion_json: '{&#34;final_stage&#34;: &#34;complete&#34;, &#x22;guard_field&#x22;: &#x22;work&lt;done&gt;&#38;ready&#x22;}',
      }),
    ).resolves.toMatchObject({
      completion_json: JSON.stringify({ final_stage: 'complete', guard_field: 'work<done>&ready' }),
    });
  });

  it('throws clearly for truly garbled intake JSON', async () => {
    await expect(
      handlers.record_q5_delegation({ delegation_json: '{enabled false' }),
    ).rejects.toThrow(/invalid JSON-string payload field: delegation_json/);
  });
});
