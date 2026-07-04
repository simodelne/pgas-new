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

describe('foundry artifact-plan approval flow', () => {
  it('stops after plan_artifacts until user approval, then continues through branch_write', async () => {
    const targetDir = join(trackedTempRoot('pgas-new-foundry-approve-'), 'incident-triage');
    const harness = await createHarness(targetDir);

    try {
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

      const planned = await waitForSnapshot(
        harness,
        (snapshot) =>
          snapshot.mode === 'scaffold_plan' &&
          snapshot.domain['artifact_plan.status'] === 'draft' &&
          terminalActionNames(snapshot.rounds).includes('plan_artifacts'),
        'plan_artifacts to draft artifact plan',
      );

      expect(planned.mode).toBe('scaffold_plan');
      expect(planned.domain['artifact_plan.status']).toBe('draft');
      expect(planned.domain['artifact_plan.approved']).toBe(false);
      expect(terminalActionNames(planned.rounds)).toContain('plan_artifacts');
      expect(terminalActionNames(planned.rounds)).not.toContain('approve_artifact_plan');
      expect(terminalActionNames(planned.rounds)).not.toContain('write_scaffold_artifacts');

      await harness.trigger({ channel: 'user_confirmation', payload: { decision: 'approve' } });
      // After /approve the chain is fully bus-driven: approve_artifact_plan ->
      // (auto_continuation) synthesize_domain_logic -> (auto_continuation)
      // write_scaffold_artifacts. NO manual system_mode_entry trigger here —
      // this is the regression surface of the 2026-07-03 live-UAT stall, where
      // synthesize_domain_logic emitted on a non-widget channel and the
      // domain_synthesis -> branch_write continuation never fired.
      const approved = await waitForSnapshot(
        harness,
        (snapshot) => snapshot.domain['artifacts.written'] === true,
        'artifact plan approval to auto-continued scaffold write',
      );
      expect(approved.domain['program.domain_synthesis_complete']).toBe(true);
      const terminals = terminalActionNames(approved.rounds);

      expect(terminals).toEqual(expect.arrayContaining(['approve_artifact_plan', 'synthesize_domain_logic', 'write_scaffold_artifacts']));
      expect(approved.domain['artifact_plan.status']).toBe('approved');
      expect(approved.domain['artifact_plan.approved']).toBe(true);
      expect(approved.domain['artifact_plan.write_authorized']).toBe(true);
      expect(approved.domain['artifacts.written']).toBe(true);
      expect(approved.mode).not.toBe('scaffold_plan');
    } finally {
      await harness.close();
    }
  });

  it('repairs a repeated plan_artifacts tool call on /approve into approve_artifact_plan', async () => {
    const targetDir = join(trackedTempRoot('pgas-new-foundry-approve-repair-'), 'incident-triage');
    const harness = await createHarnessWithResponses([
      ...intakeThroughDraftResponses(targetDir),
      effect('plan_artifacts'),
      effect('approve_artifact_plan'),
      effect('synthesize_domain_logic', {
        cache_dir: join(targetDir, '.domain-synthesis-cache'),
        __domain_synthesis_body: synthesizedTriageBody,
      }),
      effect('write_scaffold_artifacts', { cwd: targetDir }),
    ]);

    try {
      await driveToDraftArtifactPlan(harness);

      await harness.trigger({ channel: 'user_confirmation', payload: { decision: 'approve' } });
      // Fully bus-driven after the repair as well — no manual system_mode_entry.
      const approved = await waitForSnapshot(
        harness,
        (snapshot) => snapshot.domain['artifacts.written'] === true,
        'repair from repeated plan_artifacts to auto-continued approval write',
      );
      expect(approved.domain['program.domain_synthesis_complete']).toBe(true);
      const terminals = terminalActionNames(approved.rounds);

      expect(terminals).toEqual(expect.arrayContaining(['approve_artifact_plan', 'synthesize_domain_logic', 'write_scaffold_artifacts']));
      expect(approved.domain['artifact_plan.status']).toBe('approved');
      expect(approved.domain['artifact_plan.approved']).toBe(true);
      expect(approved.domain['artifacts.written']).toBe(true);
    } finally {
      await harness.close();
    }
  });
});

async function createHarness(targetDir: string): Promise<TestHarness> {
  return createHarnessWithResponses([
    ...intakeThroughDraftResponses(targetDir),
    effect('approve_artifact_plan'),
    effect('synthesize_domain_logic', {
      cache_dir: join(targetDir, '.domain-synthesis-cache'),
      __domain_synthesis_body: synthesizedTriageBody,
    }),
    effect('write_scaffold_artifacts', { cwd: targetDir }),
  ]);
}

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
    'draft artifact plan before approval',
  );
}

function effect(name: string, payload: Record<string, unknown> = {}): TestHarnessAuthorResponse {
  return {
    actions: [
      {
        kind: 'EffectAction',
        name,
        channel: name === 'plan_artifacts'
          ? 'artifact_plan_output'
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
