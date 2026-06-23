import { createTestHarness, type TestHarnessAuthorResponse } from '@simodelne/pgas-server/testing.js';
import { describe, expect, it } from 'vitest';
import { createPgasNewFoundryProgramEntry } from '../../src/foundry-program/registration.js';
import { getSynthesizedArtifact } from '../../src/foundry-program/synthesizer-store.js';
import { parseUserConfirmationControl, type UserConfirmationPayload } from '../../src/repl/runner.js';

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

function replConfirmation(input: string): { channel: 'user_confirmation'; payload: UserConfirmationPayload } {
  const payload = parseUserConfirmationControl(input);
  if (!payload) throw new Error(`invalid REPL confirmation control: ${input}`);
  return { channel: 'user_confirmation', payload };
}

describe('intake normalization synthesis integration', () => {
  it('synthesizes after Q3-Q6 handlers store canonical JSON from JSON5-style intake', async () => {
    const authorResponses: TestHarnessAuthorResponse[] = [
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
      effect('record_q3_stages', {
        stages_json: '[triage_intake, root_cause_analysis, mitigation, resolution]',
      }),
      effect('record_q4_transitions', {
        transitions_json: '[{from: triage_intake, to: root_cause_analysis, guard_field: triage_complete}, {from: root_cause_analysis, to: mitigation, guard_field: root_cause_identified}, {from: mitigation, to: resolution, guard_field: mitigation_applied}]',
      }),
      effect('record_q5_delegation', {
        delegation_json: '{enabled: false}',
      }),
      effect('record_q6_completion', {
        completion_json: '{final_stage: resolution, guard_field: mitigation_applied}',
      }),
      effect('record_program_intake_finalize', {}),
      effect('confirm_design', {}),
      effect('synthesize_program_spec', {}),
    ];

    const harness = await createTestHarness(createPgasNewFoundryProgramEntry(), {
      programName: 'pgas-new',
      defaultChannel: 'user_text',
      authorResponses,
    });

    try {
      await harness.trigger('Create an incident response PGAS program.');
      await harness.trigger('I want to design it.');
      await harness.trigger('Q1 answer.');
      await harness.trigger('Q2 answer.');
      await harness.trigger('Q3 answer.');
      await harness.trigger('Q4 answer.');
      await harness.trigger('Q5 answer.');
      await harness.trigger('Q6 answer.');
      await harness.trigger('Finalize intake.');
      await harness.trigger(replConfirmation('/approve'));
      const result = await harness.trigger('Synthesize the program spec.');
      const snapshot = await harness.snapshot();

      expect(result).toMatchObject({
        kind: 'EffectAction',
        name: 'synthesize_program_spec',
      });
      expect(snapshot.mode).toBe('scaffold_plan');
      expect(snapshot.domain['program.synthesis_complete']).toBe(true);

      const stages = JSON.parse(snapshot.domain['intake.stages_json'] as string) as unknown;
      const transitions = JSON.parse(snapshot.domain['intake.transitions_json'] as string) as unknown;
      const delegation = JSON.parse(snapshot.domain['intake.delegation_json'] as string) as unknown;
      const completion = JSON.parse(snapshot.domain['intake.completion_json'] as string) as unknown;

      expect(stages).toEqual(['triage_intake', 'root_cause_analysis', 'mitigation', 'resolution']);
      expect(transitions).toEqual([
        { from: 'triage_intake', to: 'root_cause_analysis', guard_field: 'triage_complete' },
        { from: 'root_cause_analysis', to: 'mitigation', guard_field: 'root_cause_identified' },
        { from: 'mitigation', to: 'resolution', guard_field: 'mitigation_applied' },
      ]);
      expect(delegation).toEqual({ enabled: false });
      expect(completion).toEqual({ final_stage: 'resolution', guard_field: 'mitigation_applied' });
      expect(getSynthesizedArtifact(snapshot.sessionId)?.mode_names).toEqual([
        'triage_intake',
        'root_cause_analysis',
        'mitigation',
        'resolution',
      ]);
    } finally {
      await harness.close();
    }
  });
});
