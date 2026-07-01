import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handlers } from '../../src/foundry-program/handlers.js';

describe('git_rebase_latest real git behavior', () => {
  it('rebases onto the fetched target branch while preserving a dirty generated tree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pgas-new-rebase-autostash-'));
    const origin = join(root, 'origin.git');
    const seed = join(root, 'seed');
    const work = join(root, 'work');
    try {
      git(root, ['init', '--bare', '--initial-branch=main', origin]);
      mkdirSync(seed);
      git(seed, ['init', '--initial-branch=main']);
      configureGitUser(seed);
      writeFileSync(join(seed, 'tracked.txt'), 'base tracked file\n');
      writeFileSync(join(seed, 'upstream.txt'), 'base upstream file\n');
      git(seed, ['add', '.']);
      git(seed, ['commit', '-m', 'initial']);
      git(seed, ['remote', 'add', 'origin', origin]);
      git(seed, ['push', '-u', 'origin', 'main']);

      git(root, ['clone', '--branch', 'main', origin, work]);
      configureGitUser(work);
      git(work, ['checkout', '-b', 'feature/generated-program']);
      writeFileSync(join(work, 'feature.txt'), 'generated program commit\n');
      git(work, ['add', 'feature.txt']);
      git(work, ['commit', '-m', 'feature artifact baseline']);

      writeFileSync(join(work, 'tracked.txt'), 'dirty generated tracked change\n');
      writeFileSync(join(work, 'untracked-generated.txt'), 'dirty generated untracked file\n');

      writeFileSync(join(seed, 'upstream.txt'), 'new upstream content\n');
      git(seed, ['add', 'upstream.txt']);
      git(seed, ['commit', '-m', 'upstream change']);
      git(seed, ['push', 'origin', 'main']);

      await expect(
        handlers.git_rebase_latest({
          cwd: work,
          target_branch: 'main',
          domain: { 'program.target_dir': work },
        }),
      ).resolves.toMatchObject({
        kind: 'git_rebase_latest',
        status: 'passed',
      });

      git(work, ['merge-base', '--is-ancestor', 'origin/main', 'HEAD']);
      const status = git(work, ['status', '--porcelain']);
      expect(status).toContain(' M tracked.txt');
      expect(status).toContain('?? untracked-generated.txt');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function configureGitUser(cwd: string): void {
  git(cwd, ['config', 'user.name', 'PGAS Test']);
  git(cwd, ['config', 'user.email', 'pgas-test@example.com']);
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'PGAS Test',
      GIT_AUTHOR_EMAIL: 'pgas-test@example.com',
      GIT_COMMITTER_NAME: 'PGAS Test',
      GIT_COMMITTER_EMAIL: 'pgas-test@example.com',
    },
  });
}
