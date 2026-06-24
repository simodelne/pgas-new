import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli.js';

describe('pgas-new logout', () => {
  const originalHome = process.env.HOME;
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'pgas-new-logout-home-'));
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('deletes a cached token when present', async () => {
    mkdirSync(dataDir(homeDir), { recursive: true });
    writeFileSync(tokenPath(homeDir), 'cached-token');

    const result = await runCli(['logout']);

    expect(result).toEqual({ exitCode: 0, stdout: 'logged out', stderr: '' });
    expect(existsSync(tokenPath(homeDir))).toBe(false);
  });

  it('is idempotent when no token is cached', async () => {
    const result = await runCli(['logout']);

    expect(result).toEqual({ exitCode: 0, stdout: 'logged out', stderr: '' });
    expect(existsSync(tokenPath(homeDir))).toBe(false);
  });
});

function dataDir(homeDir: string): string {
  return join(homeDir, '.local/share/pgas-new');
}

function tokenPath(homeDir: string): string {
  return join(dataDir(homeDir), 'token');
}
