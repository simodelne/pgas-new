import { describe, expect, it } from 'vitest';
import {
  graduationEvidenceRows,
  renderFinalizedGraduationAudit,
} from '../../src/pgas-new/graduation-audit.js';

// Regression coverage for pgas-new#100 — pr_graduation reached terminal with
// passed graduation state, but the generated audit artifact still read "pending".
// finalizeGraduationAudit (handlers.ts) rides run_rebase_static_verification and
// re-renders the artifact from governed graduation state using these helpers.

describe('#100 graduation audit reconciliation', () => {
  it('maps recorded graduation state to passed evidence rows with evidence ids', () => {
    const rows = graduationEvidenceRows({
      static_verification: 'passed',
      static_evidence_id: 'static-1',
      smoke_verification: 'passed',
      smoke_evidence_id: 'smoke-1',
      live_verification: 'passed',
      live_evidence_id: 'live-1',
      rebase_status: 'passed',
      rebase_evidence_id: 'rebase-1',
      rebase_verification: 'passed',
      rebase_static_evidence_id: 'rebase-static-1',
    });

    expect(rows).toEqual([
      { label: 'Static verification', status: 'passed', evidenceId: 'static-1' },
      { label: 'Smoke verification', status: 'passed', evidenceId: 'smoke-1' },
      { label: 'Live provider verification', status: 'passed', evidenceId: 'live-1' },
      { label: 'Rebase', status: 'passed', evidenceId: 'rebase-1' },
      { label: 'Post-rebase verification', status: 'passed', evidenceId: 'rebase-static-1' },
    ]);
  });

  it('renders unrecorded rungs as pending (honest) without a stray evidence id', () => {
    const rows = graduationEvidenceRows({ static_verification: 'passed', static_evidence_id: 'static-1' });
    expect(rows[0]).toEqual({ label: 'Static verification', status: 'passed', evidenceId: 'static-1' });
    expect(rows[2]).toEqual({ label: 'Live provider verification', status: 'pending' });
    expect(rows[2].evidenceId).toBeUndefined();
  });

  it('preserves skipped statuses (e.g. live provider unreachable) rather than forcing passed', () => {
    const rows = graduationEvidenceRows({ live_verification: 'skipped', live_evidence_id: 'live-skip-1' });
    expect(rows[2]).toEqual({ label: 'Live provider verification', status: 'skipped', evidenceId: 'live-skip-1' });
  });

  it('renders a finalized audit whose completed rungs are no longer "pending" (#100)', () => {
    const rows = graduationEvidenceRows({
      static_verification: 'passed',
      static_evidence_id: 'static-1',
      smoke_verification: 'passed',
      smoke_evidence_id: 'smoke-1',
      live_verification: 'passed',
      live_evidence_id: 'live-1',
      rebase_status: 'passed',
      rebase_evidence_id: 'rebase-1',
      rebase_verification: 'passed',
      rebase_static_evidence_id: 'rebase-static-1',
    });
    const md = renderFinalizedGraduationAudit({ name: 'Fee Proposal Drafter', slug: 'fee-proposal-drafter', rows });

    expect(md).toContain('# Fee Proposal Drafter PGAS-New Graduation');
    expect(md).toContain('Program: `fee-proposal-drafter`');
    expect(md).toContain('- Static verification: passed (evidence static-1)');
    expect(md).toContain('- Live provider verification: passed (evidence live-1)');
    expect(md).toContain('- Post-rebase verification: passed (evidence rebase-static-1)');
    // The #100 bug was completed rungs still showing "pending".
    expect(md).not.toContain('Static verification: pending');
    expect(md).not.toContain('Live provider verification: pending');
    expect(md).not.toContain('Post-rebase verification: pending');
    // No PR opened in this run — that row is honestly pending.
    expect(md).toContain('- Pull request: pending');
  });

  it('reflects an opened pull request when provided', () => {
    const md = renderFinalizedGraduationAudit({
      name: 'Fee Proposal Drafter',
      slug: 'fee-proposal-drafter',
      rows: graduationEvidenceRows({ static_verification: 'passed', static_evidence_id: 'static-1' }),
      pullRequest: 'https://github.com/simodelne/simoneos/pull/1234',
    });
    expect(md).toContain('- Pull request: https://github.com/simodelne/simoneos/pull/1234');
  });
});
