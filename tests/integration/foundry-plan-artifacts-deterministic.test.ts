import { createTestHarness, type TestHarnessAuthorResponse } from '@simodelne/pgas-server/testing.js';
import { describe, expect, it } from 'vitest';
import { createPgasNewFoundryProgramEntry } from '../../src/foundry-program/registration.js';
import { createStandaloneArtifactPlan } from '../../src/pgas-new/artifact-plan.js';
import { waitForSnapshot } from './foundry-test-utils.js';

const stages = [
  { slug: 'intake', is_bootstrap: true },
  { slug: 'triage' },
  { slug: 'resolved', is_terminal: true },
];

const transitions = [
  { from: 'intake', to: 'triage', trigger: 'ready', guard_field: 'intake.started' },
  { from: 'triage', to: 'resolved', trigger: 'summary_ready', guard_field: 'triage.summary_ready' },
];

describe('foundry deterministic artifact planning', () => {
  it('stores the handler-computed standalone artifact list instead of LLM-supplied paths', async () => {
    const hallucinatedArtifacts = [
      { kind: 'handler', path: 'src/main.py', purpose: 'hallucinated Python entrypoint' },
      { kind: 'handler', path: 'src/audit_trail.py', purpose: 'hallucinated Python module' },
      { kind: 'package', path: 'pyproject.toml', purpose: 'hallucinated Python package metadata' },
    ];
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
        effect('record_q1_purpose', { purpose: 'Route incoming incidents into a triage workflow.' }),
        effect('record_q2_entry_channel', { entry_channel: 'user_text' }),
        effect('record_q3_stages', { stages_json: JSON.stringify(stages) }),
        effect('record_q4_transitions', { transitions_json: JSON.stringify(transitions) }),
        effect('record_q5_delegation', { delegation_json: JSON.stringify({}) }),
        effect('record_q6_completion', {
          completion_json: JSON.stringify({ final_stage: 'resolved', guard_field: 'triage.summary_ready' }),
        }),
        effect('record_program_intake_finalize', {}),
        effect('confirm_design', {}),
        effect('authorize_standalone_target', {}),
        effect('synthesize_program_spec', {}),
        effect('plan_artifacts', { artifacts: hallucinatedArtifacts }),
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

      const snapshot = await waitForSnapshot(
        harness,
        (candidate) => candidate.mode === 'scaffold_plan' && candidate.domain['artifact_plan.status'] === 'draft',
        'deterministic artifact planning',
      );
      const plannedArtifacts = createStandaloneArtifactPlan({
        slug: 'incident-triage',
        name: 'Incident Triage',
      }, {
        // All non-terminal stages are planned (bootstrap `intake` + `triage`;
        // `resolved` is terminal). Previously only non-LLM stages were planned.
        stageSlugs: ['intake', 'triage'],
      }).artifacts;

      expect(snapshot.domain['artifact_plan.status']).toBe('draft');
      expect(snapshot.domain['artifact_plan.artifacts']).toEqual(plannedArtifacts);
      expect(snapshot.domain['artifact_plan.artifacts']).not.toEqual(hallucinatedArtifacts);
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
        channel: name === 'plan_artifacts' ? 'artifact_plan_output' : 'widget_output',
        payload,
      },
    ],
  };
}
