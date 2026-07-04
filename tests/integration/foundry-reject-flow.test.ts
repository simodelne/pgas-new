import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHarness, type TestHarness, type TestHarnessAuthorResponse } from '@simodelne/pgas-server/testing.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createPgasNewFoundryProgramEntry } from '../../src/foundry-program/registration.js';
import { terminalActionNames, waitForSnapshot } from './foundry-test-utils.js';

const stages = [
  { slug: 'intake', is_bootstrap: true },
  { slug: 'triage' },
  { slug: 'resolved', is_terminal: true },
];

const transitions = [
  { from: 'intake', to: 'triage', trigger: 'ready', guard_field: 'intake.started' },
  { from: 'triage', to: 'resolved', trigger: 'summary_ready', guard_field: 'triage.summary_ready' },
];

const synthesizedTriageBody = `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  return {
    result_json: JSON.stringify({ stage: input.stage, status: 'triaged', at: runtime.now() }),
    items_json: JSON.stringify(['triaged']),
    digest: '',
  };
}
`;

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('#69 foundry artifact-plan rejection flow', () => {
  it('treats a user rejection as revise_artifact_plan, re-drafts, and does NOT trap the session', async () => {
    const targetDir = join(trackedTempRoot('pgas-new-foundry-reject-'), 'incident-triage');
    const harness = await createHarnessWithResponses([
      ...intakeThroughDraftResponses(targetDir),
      // Rejection turn: the author picks the rejection-guarded action.
      effect('revise_artifact_plan'),
      // Re-approval after the re-draft.
      effect('approve_artifact_plan'),
      effect('synthesize_domain_logic', {
        cache_dir: join(targetDir, '.domain-synthesis-cache'),
        __domain_synthesis_body: synthesizedTriageBody,
      }),
      effect('write_scaffold_artifacts', { cwd: targetDir }),
    ]);

    try {
      await driveToDraftArtifactPlan(harness);

      // User rejects the drafted plan with revision feedback.
      await harness.trigger({
        channel: 'user_confirmation',
        payload: {
          decision: 'reject',
          instruction: 'Revise: must include programs/minutes-drafter/projection.ts and QC coverage.',
        },
      });

      const rejected = await waitForSnapshot(
        harness,
        (snapshot) =>
          snapshot.mode === 'scaffold_plan' &&
          snapshot.domain['artifact_plan.status'] === 'draft' &&
          terminalActionNames(snapshot.rounds).includes('revise_artifact_plan'),
        'rejection to a re-drafted artifact plan',
      );

      // A rejection re-drafts the plan and stays approvable — it must NOT
      // approve, must NOT fall back, and must NOT write artifacts.
      expect(rejected.mode).toBe('scaffold_plan');
      expect(rejected.domain['artifact_plan.status']).toBe('draft');
      expect(rejected.domain['artifact_plan.approved']).toBe(false);
      const terminals = terminalActionNames(rejected.rounds);
      expect(terminals).toContain('revise_artifact_plan');
      expect(terminals).not.toContain('__fallback__');
      expect(rejected.domain['artifacts.written']).not.toBe(true);

      // The re-drafted plan is still approvable — approving now advances.
      await harness.trigger({ channel: 'user_confirmation', payload: { decision: 'approve' } });
      const domainReady = await waitForSnapshot(
        harness,
        (snapshot) =>
          snapshot.mode === 'branch_write' &&
          snapshot.domain['program.domain_synthesis_complete'] === true,
        're-approval after rejection to domain synthesis completion',
      );
      expect(terminalActionNames(domainReady.rounds)).toEqual(
        expect.arrayContaining(['revise_artifact_plan', 'approve_artifact_plan', 'synthesize_domain_logic']),
      );
    } finally {
      await harness.close();
    }
  });
});

async function createHarnessWithResponses(authorResponses: TestHarnessAuthorResponse[]): Promise<TestHarness> {
  return createTestHarness(createPgasNewFoundryProgramEntry(), {
    programName: 'pgas-new',
    authorResponses,
  });
}

function intakeThroughDraftResponses(targetDir: string): TestHarnessAuthorResponse[] {
  return [
    effect('record_program_target', {
      slug: 'incident-triage',
      name: 'Incident Triage',
      target_dir: targetDir,
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
    effect('record_program_intake_finalize'),
    effect('confirm_design', { approved: true }),
    effect('authorize_standalone_target'),
    effect('synthesize_program_spec'),
    effect('plan_artifacts'),
  ];
}

async function driveToDraftArtifactPlan(harness: TestHarness): Promise<void> {
  await harness.trigger({ channel: 'user_text', payload: 'Create an incident triage PGAS program.' });
  await harness.trigger({ channel: 'user_text', payload: 'Use the design path.' });
  await harness.trigger({ channel: 'user_text', payload: 'Route incoming incidents into a triage workflow.' });
  await harness.trigger({ channel: 'user_text', payload: 'user_text' });
  await harness.trigger({ channel: 'user_text', payload: 'intake, triage, resolved' });
  await harness.trigger({ channel: 'user_text', payload: 'intake to triage, then triage to resolved.' });
  await harness.trigger({ channel: 'user_text', payload: 'No delegation.' });
  await harness.trigger({ channel: 'user_text', payload: 'Resolved when triage.summary_ready is true.' });
  await harness.trigger({ channel: 'user_text', payload: 'Finalize intake.' });
  await harness.trigger({ channel: 'user_confirmation', payload: { decision: 'approve' } });
  await waitForSnapshot(
    harness,
    (snapshot) => snapshot.mode === 'scaffold_plan' && snapshot.domain['artifact_plan.status'] === 'draft',
    'draft artifact plan before rejection',
  );
}

function effect(name: string, payload: Record<string, unknown> = {}): TestHarnessAuthorResponse {
  return {
    actions: [
      {
        kind: 'EffectAction',
        name,
        channel:
          name === 'plan_artifacts' || name === 'revise_artifact_plan'
            ? 'artifact_plan_output'
            : name === 'synthesize_domain_logic'
              ? 'domain_synthesis_output'
              : 'widget_output',
        payload,
      },
    ],
  };
}

function trackedTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}
