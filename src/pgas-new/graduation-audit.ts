/**
 * Graduation audit reconciliation (pgas-new#100).
 *
 * The graduation audit artifact is first written at branch_write from a static
 * template whose evidence rows are literal "pending". The graduation verification
 * rungs update `graduation.*` state but never the file, so a terminal
 * `pr_graduation` could ship an audit that still read "pending" for rungs that had
 * actually passed. This module renders the finalized audit from governed
 * graduation state so the artifact reflects real evidence.
 *
 * Pure/deterministic: no filesystem or domain coupling here (the handler resolves
 * the path and reads state), which keeps it trivially unit-testable.
 */

export interface GraduationEvidenceRow {
  label: string;
  status: string;
  evidenceId?: string;
}

export interface GraduationStateSnapshot {
  static_verification?: string;
  static_evidence_id?: string;
  smoke_verification?: string;
  smoke_evidence_id?: string;
  live_verification?: string;
  live_evidence_id?: string;
  rebase_status?: string;
  rebase_evidence_id?: string;
  rebase_verification?: string;
  rebase_static_evidence_id?: string;
}

export interface FinalizedGraduationAuditInput {
  name: string;
  slug: string;
  rows: GraduationEvidenceRow[];
  pullRequest?: string;
}

function present(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Build the evidence rows from governed graduation state. A rung with no recorded
 * status renders as "pending" (honest — it was never run/recorded), otherwise it
 * renders the actual status and its evidence id.
 */
export function graduationEvidenceRows(state: GraduationStateSnapshot): GraduationEvidenceRow[] {
  const row = (label: string, status: string | undefined, evidenceId: string | undefined): GraduationEvidenceRow =>
    present(status)
      ? { label, status: status.trim(), evidenceId: present(evidenceId) ? evidenceId.trim() : undefined }
      : { label, status: 'pending' };

  return [
    row('Static verification', state.static_verification, state.static_evidence_id),
    row('Smoke verification', state.smoke_verification, state.smoke_evidence_id),
    row('Live provider verification', state.live_verification, state.live_evidence_id),
    row('Rebase', state.rebase_status, state.rebase_evidence_id),
    row('Post-rebase verification', state.rebase_verification, state.rebase_static_evidence_id),
  ];
}

export function renderFinalizedGraduationAudit(input: FinalizedGraduationAuditInput): string {
  const evidenceLines = input.rows.map((r) => {
    const evidence = present(r.evidenceId) ? ` (evidence ${r.evidenceId})` : '';
    return `- ${r.label}: ${r.status}${evidence}`;
  });
  const pullRequest = present(input.pullRequest) ? input.pullRequest.trim() : 'pending';
  evidenceLines.push(`- Pull request: ${pullRequest}`);

  return [
    `# ${input.name} PGAS-New Graduation`,
    '',
    `Program: \`${input.slug}\``,
    '',
    'Evidence reconciled from governed graduation state at post-rebase verification. '
      + 'Final graduation requires a real provider round trip through the external API and '
      + 'must not be inferred from deterministic tests.',
    '',
    '## Evidence',
    '',
    ...evidenceLines,
    '',
  ].join('\n');
}
