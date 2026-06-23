import { createTestHarness, type TestHarnessAuthorResponse } from '@simodelne/pgas-server/testing.js';
import { describe, expect, it } from 'vitest';
import { createPgasNewFoundryProgramEntry } from '../../src/foundry-program/registration.js';

const stages = [
  { slug: 'intake', is_bootstrap: true },
  { slug: 'triage' },
  { slug: 'resolved', is_terminal: true },
];

const transitions = [
  { from: 'intake', to: 'triage', trigger: 'ready', guard_field: 'intake.started' },
  { from: 'triage', to: 'resolved', trigger: 'summary_ready', guard_field: 'triage.summary_ready' },
];

describe('foundry repo_targeting continuation flow', () => {
  it('routes confirm_design through repo_targeting, authorizes standalone writes, then enters architecture_design', async () => {
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
        effect('record_q1_purpose', {
          purpose: 'Route incoming incidents into a triage workflow.',
        }),
        effect('record_q2_entry_channel', {
          entry_channel: 'user_text',
        }),
        effect('record_q3_stages', {
          stages_json: JSON.stringify(stages),
        }),
        effect('record_q4_transitions', {
          transitions_json: JSON.stringify(transitions),
        }),
        effect('record_q5_delegation', {
          delegation_json: JSON.stringify({}),
        }),
        effect('record_q6_completion', {
          completion_json: JSON.stringify({ final_stage: 'resolved', guard_field: 'triage.summary_ready' }),
        }),
        effect('record_program_intake_finalize', {}),
        effect('confirm_design', { approved: true }),
        effect('authorize_standalone_target', {}),
        effect('synthesize_program_spec', {}),
      ],
    });

    try {
      await harness.trigger('Create an incident triage PGAS program.');
      await harness.trigger('I want to design it.');
      await harness.trigger('Route incoming incidents into a triage workflow.');
      await harness.trigger('user_text');
      await harness.trigger('intake, triage, resolved');
      await harness.trigger('intake to triage, then triage to resolved.');
      await harness.trigger('No delegation.');
      await harness.trigger('Resolved when triage.summary_ready is true.');
      await harness.trigger('Finalize intake.');
      await harness.trigger({ channel: 'user_confirmation', payload: { decision: 'approve' } });

      const snapshot = await harness.snapshot();
      const rounds = terminalRounds(snapshot.rounds);

      expect(rounds.find((round) => round.name === 'confirm_design')?.proposedMode).toBe('repo_targeting');
      expect(rounds.find((round) => round.name === 'authorize_standalone_target')?.proposedMode).toBe(
        'architecture_design',
      );
      expect(rounds.map((round) => round.name)).toEqual(
        expect.arrayContaining(['confirm_design', 'authorize_standalone_target', 'synthesize_program_spec']),
      );
      expect(snapshot.mode).toBe('scaffold_plan');
      expect(snapshot.domain['repo.target_kind']).toBe('standalone_repo');
      expect(snapshot.domain['repo.write_authorized']).toBe(true);
      expect(snapshot.domain['program.synthesis_complete']).toBe(true);
    } finally {
      await harness.close();
    }
  });
});

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

function terminalRounds(rounds: unknown[]): Array<{ name: string; proposedMode?: string }> {
  return rounds.flatMap((round) => {
    if (!round || typeof round !== 'object' || Array.isArray(round)) return [];
    const result = (round as { result?: unknown }).result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
    const terminal = (result as { terminal?: unknown }).terminal;
    if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)) return [];
    const name = (terminal as { name?: unknown }).name;
    const proposedMode = (result as { proposedMode?: unknown }).proposedMode;
    if (typeof name !== 'string') return [];
    return [{ name, proposedMode: typeof proposedMode === 'string' ? proposedMode : undefined }];
  });
}
