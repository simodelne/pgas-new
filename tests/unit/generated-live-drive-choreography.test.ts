import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assessDelegationEngagement,
  assessChoreography,
  deriveConfirmationScript,
  renderLiveDriveRunnerSource,
  type GeneratedLiveDriveDelegationReport,
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
      fallbackDecision: 'approve',
      decisions: [
        { decision: 'approve' },
        { decision: 'request_revision', instruction: 'Tighten the item before proposing it again.' },
        { decision: 'reject' },
      ],
      decisionTable: {
        approve: 'accepted',
        request_revision: 'proposed',
        reject: 'skipped',
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
      history(4, ['accepted', 'skipped'], { index: 1, decision: 'reject' }),
    ], script, 2);

    expect(verdict).toEqual({
      decision_table_respected: true,
      one_proposed_invariant_held: true,
      proposed_overlap_max: 1,
      items_seen_max: 2,
      decisions_applied: 2,
      terminal_items_final: 2,
      loop_engaged: true,
      provider_hits_ok: true,
      notes: [],
    });
  });

  it('fails closed when no scripted decision was observed as applied', () => {
    const verdict = assessChoreography([
      history(0, []),
      history(1, []),
    ], script, 1);

    expect(verdict.decision_table_respected).toBe(false);
    expect(verdict.loop_engaged).toBe(false);
    expect(verdict.decisions_applied).toBe(0);
    expect(verdict.items_seen_max).toBe(0);
    expect(verdict.terminal_items_final).toBe(0);
    expect(verdict.notes).toContain('decision_table_vacuous:no_decision_applied');
  });

  it('flags histories where two items are proposed simultaneously', () => {
    const verdict = assessChoreography([
      history(0, ['pending', 'pending']),
      history(1, ['proposed', 'proposed']),
    ], script, 1);

    expect(verdict.one_proposed_invariant_held).toBe(false);
    expect(verdict.proposed_overlap_max).toBe(2);
    expect(verdict.loop_engaged).toBe(false);
    expect(verdict.notes).toContain('one_proposed_invariant_violated:max=2');
    expect(verdict.notes).toContain('decision_table_vacuous:no_decision_applied');
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
    expect(source).toContain('confirmationScript.fallbackDecision');
    expect(source).toContain('const fallbackDecision = { decision: confirmationScript.fallbackDecision };');
    expect(source).toContain("if (decision === 'revise') return 'request_revision';");
    expect(source).toContain("if (decision === 'skip') return 'reject';");
    expect(source).toContain('return { decision: canonicalDecision');
    expect(source).not.toContain("'inputs.user_decision'");
    expect(source).not.toContain('target_item_index');
  });

  it('keeps the no-script runner source byte-identical to the entry-channel-only baseline', () => {
    const source = renderLiveDriveRunnerSource('proposal-ops');

    expect(hash(source)).toBe('ddededebbe54ba9710ca8609a4fe5e9591e4ba78e3879016fd4d75ca7b980404');
    expect(source).not.toContain('PGAS_LIVE_DRIVE_CONFIRMATION_SCRIPT');
    expect(source).not.toContain('PGAS_LIVE_DRIVE_DELEGATION_SCRIPT');
  });

  it('renders delegation evidence collection from the landed result, not child session routes', () => {
    const source = renderLiveDriveRunnerSource('delegation-parent-live', undefined, {
      resultPath: 'dispatch_research.delegation.research.result',
      settledPath: 'dispatch_research.delegation.research.settled',
      degradedPath: 'dispatch_research.delegation.research.degraded',
      stage: 'dispatch_research',
      childProgram: 'research',
    });

    expect(source).toContain('PGAS_LIVE_DRIVE_DELEGATION_SCRIPT');
    expect(source).toContain('createResearchProgramEntry');
    expect(source).toContain('recordFromWorldPath(world, script.resultPath)');
    expect(source).not.toContain('client.sessions.get(child');
    expect(source).not.toContain('client.sessions.rounds(child');
  });
});

describe('generated delegation live-drive verdict helpers', () => {
  it('passes only when a landed child result proves real child-session engagement', () => {
    const verdict = assessDelegationEngagement({
      report: delegationReport({
        result_status: 'complete',
        child_session_id: 'child-session-1',
        child_rounds: 2,
        settled: true,
        degraded: false,
      }),
      parentSessionId: 'parent-session-1',
      finalMode: 'complete',
      expectedFinalMode: 'complete',
      providerHits: 3,
      parentProviderHitMinimum: 1,
      stubFindings: [],
    });

    expect(verdict.delegation_engaged).toBe(true);
    expect(verdict.result_complete).toBe(true);
    expect(verdict.child_session_distinct).toBe(true);
    expect(verdict.child_rounds_ok).toBe(true);
    expect(verdict.provider_hits_ok).toBe(true);
    expect(verdict.notes).toEqual([]);
  });

  it('excludes ONLY the delegation host stage items_json from the stub scan (qwen-drive false positive), still counts real stubs', () => {
    const base = {
      report: delegationReport({ result_status: 'complete', child_session_id: 'child-1', child_rounds: 2, settled: true, degraded: false }),
      parentSessionId: 'parent-1',
      finalMode: 'complete',
      expectedFinalMode: 'complete',
      providerHits: 3,
      parentProviderHitMinimum: 1,
      hostStage: 'dispatch_research',
    };
    // host stage's empty items_json is a legitimate delegation-stage output, not a stub -> engaged
    const engaged = assessDelegationEngagement({
      ...base,
      stubFindings: ['dispatch_research.items_json: empty_array'],
    });
    expect(engaged.no_stub_markers).toBe(true);
    expect(engaged.delegation_engaged).toBe(true);
    // a REAL stub on another path is still counted -> fail-closed
    const stubbed = assessDelegationEngagement({
      ...base,
      stubFindings: ['dispatch_research.items_json: empty_array', 'other_stage.result_json: empty_object'],
    });
    expect(stubbed.no_stub_markers).toBe(false);
    expect(stubbed.delegation_engaged).toBe(false);
  });

  it('fails closed when no landed delegation result exists', () => {
    const verdict = assessDelegationEngagement({
      report: null,
      parentSessionId: 'parent-session-1',
      finalMode: 'complete',
      expectedFinalMode: 'complete',
      providerHits: 3,
      parentProviderHitMinimum: 1,
      stubFindings: [],
    });

    expect(verdict.delegation_engaged).toBe(false);
    expect(verdict.result_complete).toBe(false);
    expect(verdict.notes).toContain('delegation_result_absent');
  });

  it('fails the happy-path verdict for a degraded child result even when parent completes', () => {
    const verdict = assessDelegationEngagement({
      report: delegationReport({
        result_status: 'failed',
        child_session_id: 'child-session-1',
        child_rounds: 1,
        settled: true,
        degraded: true,
        degrade_reason: 'max delegated rounds exceeded',
      }),
      parentSessionId: 'parent-session-1',
      finalMode: 'complete',
      expectedFinalMode: 'complete',
      providerHits: 2,
      parentProviderHitMinimum: 1,
      stubFindings: [],
    });

    expect(verdict.delegation_engaged).toBe(false);
    expect(verdict.result_complete).toBe(false);
    expect(verdict.settled).toBe(true);
    expect(verdict.parent_complete).toBe(true);
    expect(verdict.notes).toContain('delegation_result_not_complete:failed');
  });

  it('fails when provider-hit accounting cannot cover parent plus child rounds', () => {
    const verdict = assessDelegationEngagement({
      report: delegationReport({
        result_status: 'complete',
        child_session_id: 'child-session-1',
        child_rounds: 2,
        settled: true,
        degraded: false,
      }),
      parentSessionId: 'parent-session-1',
      finalMode: 'complete',
      expectedFinalMode: 'complete',
      providerHits: 2,
      parentProviderHitMinimum: 1,
      stubFindings: [],
    });

    expect(verdict.delegation_engaged).toBe(false);
    expect(verdict.provider_hits_ok).toBe(false);
    expect(verdict.notes).toContain('provider_hits_below_parent_plus_child:min=3:actual=2');
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

function delegationReport(
  overrides: Partial<GeneratedLiveDriveDelegationReport> = {},
): GeneratedLiveDriveDelegationReport {
  return {
    child_program: 'research',
    result_status: 'complete',
    child_session_id: 'child-session-1',
    child_rounds: 1,
    optional: true,
    settled: true,
    degraded: false,
    degrade_reason: '',
    exported_fields: { summary: 'delegated work complete' },
    ...overrides,
  };
}
