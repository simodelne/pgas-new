import { createTestHarness, type TestHarnessAuthorResponse } from '@simodelne/pgas-server/testing.js';
import { describe, expect, it } from 'vitest';
import { createPgasNewFoundryProgramEntry } from '../../src/foundry-program/registration.js';
import { handlers } from '../../src/foundry-program/handlers.js';

const stages = [
  { slug: 'intake', is_bootstrap: true },
  { slug: 'triage' },
  { slug: 'resolved', is_terminal: true },
];

const transitions = [
  { from: 'intake', to: 'triage', trigger: 'ready', guard_field: 'intake.started' },
  { from: 'triage', to: 'resolved', trigger: 'summary_ready', guard_field: 'triage.summary_ready' },
];

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

describe('foundry architecture_design to scaffold_plan flow', () => {
  it('synthesizes into transit and drafts an artifact plan while waiting for approval', async () => {
    const harness = await createTestHarness(createPgasNewFoundryProgramEntry(), {
      programName: 'pgas-new',
      defaultChannel: 'user_text',
      authorResponses: [
        effect('record_program_target', {
          slug: 'incident-triage',
          name: 'Incident Triage',
          target_dir: '/tmp/incident-triage',
        }),
        effect('choose_design_path', { choice: 'design' }),
        effect('record_program_intake', {
          purpose: 'Route incoming incidents into a triage workflow.',
          entry_channel: 'user_text',
          stages_json: JSON.stringify(stages),
          transitions_json: JSON.stringify(transitions),
          delegation_json: JSON.stringify({}),
          completion_json: JSON.stringify({ final_stage: 'resolved', guard_field: 'triage.summary_ready' }),
        }),
        effect('confirm_design', { approved: true }),
        effect('synthesize_program_spec', {}),
        effect('plan_artifacts', {}),
      ],
    });

    try {
      await harness.trigger('Create an incident triage PGAS program.');
      await harness.trigger('I want to design it.');
      await harness.trigger('Here are the six design answers.');
      await harness.trigger({ channel: 'user_confirmation', payload: { decision: 'approve' } });
      await harness.trigger({ channel: 'system_mode_entry', payload: {} });
      await harness.trigger({ channel: 'system_mode_entry', payload: {} });

      const snapshot = await harness.snapshot();

      expect(snapshot.mode).toBe('scaffold_plan');
      expect(snapshot.domain['program.synthesis_complete']).toBe(true);
      expect(snapshot.domain['artifact_plan.status']).toBe('draft');
      expect(snapshot.domain['artifact_plan.approved']).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('fails clearly when the synthesized spec is missing from transit', async () => {
    await expect(
      handlers.plan_artifacts({
        sessionId: 'missing-synth-session',
        domain: {
          'program.slug': 'incident-triage',
          'program.name': 'Incident Triage',
        },
      }),
    ).rejects.toThrow(/synthesized spec not in transit for session missing-synth-session; re-run synthesize_program_spec/);
  });
});
