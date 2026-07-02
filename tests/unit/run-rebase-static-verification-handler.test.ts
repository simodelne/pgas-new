import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handlers } from '../../src/foundry-program/handlers.js';

// Direct handler coverage for pgas-new#100. The mock test harness bypasses
// handlers for scripted from_arg effects, so the graduation-tail integration
// tests cannot exercise this handler's file write. This calls the handler
// directly (as the engine does in production, mirroring run_live_provider_verification)
// to prove it re-renders the graduation audit artifact from governed state.

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempTarget(): string {
  const root = mkdtempSync(join(tmpdir(), 'pgas-new-audit-finalize-'));
  tempRoots.push(root);
  return root;
}

const passedGraduationDomain = (targetDir: string): Record<string, unknown> => ({
  'program.slug': 'fee-proposal-drafter',
  'program.name': 'Fee Proposal Drafter',
  'program.target_dir': targetDir,
  'repo.target_kind': 'standalone_repo',
  'graduation.static_verification': 'passed',
  'graduation.static_evidence_id': 'static-1',
  'graduation.smoke_verification': 'passed',
  'graduation.smoke_evidence_id': 'smoke-1',
  'graduation.live_verification': 'passed',
  'graduation.live_evidence_id': 'live-1',
  'graduation.rebase_status': 'passed',
  'graduation.rebase_evidence_id': 'rebase-1',
});

describe('#100 run_rebase_static_verification handler finalizes the graduation audit', () => {
  it('rewrites the audit artifact from governed graduation state (no completed rung left "pending")', async () => {
    const targetDir = tempTarget();
    const result = await handlers.run_rebase_static_verification!({
      domain: passedGraduationDomain(targetDir),
      status: 'passed',
      evidence_id: 'rebase-static-1',
    } as never) as Record<string, unknown>;

    // Passthrough preserves the caller-supplied verification status/evidence.
    expect(result.status).toBe('passed');
    expect(result.evidence_id).toBe('rebase-static-1');
    expect(result.audit_finalized).toBe(true);
    expect(result.audit_path).toBe('audit/PGAS-NEW-GRADUATION.md');
    expect(result.audit_error).toBeUndefined();

    const audit = readFileSync(join(targetDir, 'audit/PGAS-NEW-GRADUATION.md'), 'utf8');
    expect(audit).toContain('- Static verification: passed (evidence static-1)');
    expect(audit).toContain('- Live provider verification: passed (evidence live-1)');
    expect(audit).toContain('- Post-rebase verification: passed (evidence rebase-static-1)');
    expect(audit).not.toContain('Static verification: pending');
    expect(audit).not.toContain('Live provider verification: pending');
    expect(audit).not.toContain('Post-rebase verification: pending');
  });

  it('reflects the caller-supplied post-rebase status (e.g. skipped) rather than forcing passed', async () => {
    const targetDir = tempTarget();
    const result = await handlers.run_rebase_static_verification!({
      domain: passedGraduationDomain(targetDir),
      status: 'skipped',
      evidence_id: 'rebase-static-skip',
    } as never) as Record<string, unknown>;

    expect(result.status).toBe('skipped');
    const audit = readFileSync(join(targetDir, 'audit/PGAS-NEW-GRADUATION.md'), 'utf8');
    expect(audit).toContain('- Post-rebase verification: skipped (evidence rebase-static-skip)');
  });

  it('is non-fatal and never silent when no domain snapshot is available', async () => {
    const result = await handlers.run_rebase_static_verification!({
      status: 'passed',
      evidence_id: 'rebase-static-1',
    } as never) as Record<string, unknown>;

    // Verification recording still succeeds; the audit reconciliation is reported
    // as not finalized with an explicit error (never a silent pass).
    expect(result.status).toBe('passed');
    expect(result.audit_finalized).toBe(false);
    expect(typeof result.audit_error).toBe('string');
  });
});
