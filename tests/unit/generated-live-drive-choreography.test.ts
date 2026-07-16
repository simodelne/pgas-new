import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assessChoreography,
  deriveConfirmationScript,
  renderLiveDriveRunnerSource,
  type GeneratedLiveDriveStatusHistoryEntry,
} from '../../src/pgas-new/generated-live-drive.js';

const loopDescriptor = {
  collection: 'work_units.items',
  proposed_status: 'proposed',
  seed: { source_stage: 'plan_work' },
  decisions: {
    approve: { to: 'accepted' },
    revise: {
      to: 'proposed',
      requires_instruction: true,
      instruction_path: 'work_units.items.*.user_instruction',
      re_propose: true,
    },
    skip: { to: 'skipped' },
  },
  one_proposed_at_a_time: true as const,
  aggregate: {
    guard_field: 'work_units.all_terminal',
    terminal_statuses: ['accepted', 'skipped'],
  },
  stage: 'review_work',
  summary_path: 'summary.confirmation_loop',
  violation_path: 'work_units.confirmation_violation_json',
  pending_action_path: 'decisions.pending_review_work_action',
};

const script = deriveConfirmationScript(loopDescriptor, [
  { decision: 'approve' },
  { decision: 'revise', instruction: 'Tighten the item before proposing it again.' },
  { decision: 'skip' },
  { decision: 'reject' },
]);

describe('generated live-drive choreography helpers', () => {
  it('derives a confirmation script from a confirmation_loop descriptor and canned order', () => {
    expect(script).toEqual({
      channel: 'user_confirmation',
      itemsPath: 'work_units.items',
      statusField: 'status',
      proposedStatus: 'proposed',
      decisionField: 'inputs.user_decision.decision',
      instructionField: 'inputs.user_decision.instruction',
      decisions: [
        { decision: 'approve' },
        { decision: 'revise', instruction: 'Tighten the item before proposing it again.' },
        { decision: 'skip' },
      ],
      decisionTable: {
        approve: 'accepted',
        revise: 'proposed',
        skip: 'skipped',
      },
      terminalStatuses: ['accepted', 'skipped'],
    });
  });

  it('assesses a good choreography run as respecting the decision table and one-proposed invariant', () => {
    const verdict = assessChoreography([
      history(0, ['pending', 'pending']),
      history(1, ['proposed', 'pending']),
      history(2, ['accepted', 'pending'], { index: 0, decision: 'approve' }),
      history(3, ['accepted', 'proposed']),
      history(4, ['accepted', 'skipped'], { index: 1, decision: 'skip' }),
    ], script, 2);

    expect(verdict).toEqual({
      decision_table_respected: true,
      one_proposed_invariant_held: true,
      proposed_overlap_max: 1,
      provider_hits_ok: true,
      notes: [],
    });
  });

  it('flags histories where two items are proposed simultaneously', () => {
    const verdict = assessChoreography([
      history(0, ['pending', 'pending']),
      history(1, ['proposed', 'proposed']),
    ], script, 1);

    expect(verdict.one_proposed_invariant_held).toBe(false);
    expect(verdict.proposed_overlap_max).toBe(2);
    expect(verdict.notes).toContain('one_proposed_invariant_violated:max=2');
  });

  it('flags targeted decisions whose resulting item status does not match the decision table', () => {
    const verdict = assessChoreography([
      history(0, ['proposed', 'pending']),
      history(1, ['skipped', 'pending'], { index: 0, decision: 'approve' }),
    ], script, 1);

    expect(verdict.decision_table_respected).toBe(false);
    expect(verdict.notes).toContain('decision_table_mismatch:round=1:index=0:decision=approve:expected=accepted:actual=skipped');
  });

  it('renders confirmation-publish logic only when a confirmation script is present', () => {
    const source = renderLiveDriveRunnerSource('proposal-ops', script);

    expect(source).toContain('PGAS_LIVE_DRIVE_CONFIRMATION_SCRIPT');
    expect(source).toContain('buildConfirmationPayload');
    expect(source).toContain('await client.sessions.trigger(sessionId, { channel: confirmationScript.channel, payload });');
    expect(source).toContain('status_history');
  });

  it('keeps the no-script runner source byte-identical to the entry-channel-only baseline', () => {
    const source = renderLiveDriveRunnerSource('proposal-ops');

    expect(hash(source)).toBe('ddededebbe54ba9710ca8609a4fe5e9591e4ba78e3879016fd4d75ca7b980404');
    expect(source).not.toContain('PGAS_LIVE_DRIVE_CONFIRMATION_SCRIPT');
  });
});

function history(
  round: number,
  statuses: string[],
  decision?: GeneratedLiveDriveStatusHistoryEntry['decision'],
): GeneratedLiveDriveStatusHistoryEntry {
  return {
    round,
    items: statuses.map((status, index) => ({
      index,
      id: `wu-${index + 1}`,
      title: `Work unit ${index + 1}`,
      status,
    })),
    ...(decision ? { decision } : {}),
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
