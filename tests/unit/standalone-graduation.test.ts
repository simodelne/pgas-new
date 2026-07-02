import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handlers } from '../../src/foundry-program/handlers.js';

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

// #107 — run_static_verification accepted a noncanonical status ("succeeded") via
// from_arg and persisted it verbatim, blocking the next gate (which requires the
// exact string "passed"). The handler now canonicalizes the reported status to
// the graduation enum.
describe('#107 run_static_verification canonicalizes the reported status', () => {
  async function staticStatus(status: string): Promise<unknown> {
    const result = await handlers.run_static_verification!({ status, evidence_id: 'x' } as never) as Record<string, unknown>;
    return result.status;
  }

  it('rewrites a synonym ("succeeded") to the canonical "passed"', async () => {
    expect(await staticStatus('succeeded')).toBe('passed');
  });

  it('canonicalizes common synonyms across the enum', async () => {
    expect(await staticStatus('success')).toBe('passed');
    expect(await staticStatus('OK')).toBe('passed');
    expect(await staticStatus('Completed')).toBe('passed');
    expect(await staticStatus('failure')).toBe('failed');
    expect(await staticStatus('n/a')).toBe('skipped');
  });

  it('passes already-canonical values through unchanged', async () => {
    expect(await staticStatus('passed')).toBe('passed');
    expect(await staticStatus('skipped')).toBe('skipped');
  });

  it('leaves an unrecognized status untouched (does not mask as passed)', async () => {
    expect(await staticStatus('weird-custom')).toBe('weird-custom');
  });
});

// #106 — a fresh standalone output is not a git repo (or has no origin), so
// git_rebase_latest must skip the rebase gracefully instead of hard-failing on
// `git fetch origin`.
describe('#106 git_rebase_latest tolerates standalone targets without an origin', () => {
  it('returns passed (skip) when the target is not a git repository', async () => {
    const target = tempDir('pgas-new-standalone-rebase-');
    const result = await handlers.git_rebase_latest!({
      domain: { 'program.target_dir': target },
    } as never) as Record<string, unknown>;

    expect(result.status).toBe('passed');
    expect(String(result.reason)).toMatch(/standalone|origin/i);
  });

  it('returns passed (skip) when the target is a git repo with no origin remote', async () => {
    const target = tempDir('pgas-new-standalone-rebase-git-');
    execFileSync('git', ['init', '-q'], { cwd: target });
    const result = await handlers.git_rebase_latest!({
      domain: { 'program.target_dir': target },
    } as never) as Record<string, unknown>;

    expect(result.status).toBe('passed');
    expect(String(result.reason)).toMatch(/origin/i);
  });

  it('git_status reports clean/no-repo instead of failing on a non-git target', async () => {
    const target = tempDir('pgas-new-standalone-status-');
    const result = await handlers.git_status!({
      domain: { 'program.target_dir': target },
    } as never) as Record<string, unknown>;

    expect(result).toMatchObject({ clean: true, lines: [], not_a_git_repo: true });
  });
});
