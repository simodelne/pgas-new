import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.js';

describe('pgas-new init', () => {
  const originalHome = process.env.HOME;
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'pgas-new-init-home-'));
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

  it('creates a JWT secret and stages initial admin credentials from prompts', async () => {
    const io = promptIo({
      promptAnswers: ['admin@example.com'],
      hiddenAnswers: ['test-password', 'test-password'],
    });

    const result = await runCli(['init'], io);

    expect(result).toMatchObject({
      exitCode: 0,
      stderr: '',
      stdout: expect.stringContaining('Admin credentials staged. The next `pgas-new` invocation will seed the user table.'),
    });
    expect(readFileSync(secretPath(homeDir), 'utf8')).toMatch(/^[a-f0-9]{64}$/u);
    expect(readJson(adminPath(homeDir))).toEqual({
      email: 'admin@example.com',
      password: 'test-password',
    });
    expect(modeOf(dataDir(homeDir))).toBe('700');
    expect(modeOf(secretPath(homeDir))).toBe('600');
    expect(modeOf(adminPath(homeDir))).toBe('600');
  });

  it('is idempotent when secret and initial admin files already exist', async () => {
    mkdirSync(dataDir(homeDir), { recursive: true });
    writeFileSync(secretPath(homeDir), 'existing-secret', { mode: 0o600 });
    writeFileSync(adminPath(homeDir), JSON.stringify({ email: 'admin@example.com', password: 'existing-pw' }), { mode: 0o600 });
    const io = promptIo();

    const result = await runCli(['init'], io);

    expect(result).toEqual({ exitCode: 0, stdout: 'init already complete', stderr: '' });
    expect(readFileSync(secretPath(homeDir), 'utf8')).toBe('existing-secret');
    expect(readJson(adminPath(homeDir))).toEqual({ email: 'admin@example.com', password: 'existing-pw' });
    expect(io.prompt).not.toHaveBeenCalled();
    expect(io.promptHidden).not.toHaveBeenCalled();
  });

  it('requires force confirmation and keeps existing files when declined', async () => {
    mkdirSync(dataDir(homeDir), { recursive: true });
    writeFileSync(secretPath(homeDir), 'existing-secret', { mode: 0o600 });
    writeFileSync(adminPath(homeDir), JSON.stringify({ email: 'admin@example.com', password: 'existing-pw' }), { mode: 0o600 });
    const io = promptIo({ promptAnswers: ['n'] });

    const result = await runCli(['init', '--force'], io);

    expect(result).toEqual({ exitCode: 1, stdout: '', stderr: 'init aborted' });
    expect(readFileSync(secretPath(homeDir), 'utf8')).toBe('existing-secret');
    expect(readJson(adminPath(homeDir))).toEqual({ email: 'admin@example.com', password: 'existing-pw' });
  });

  it('supports non-interactive email and password-file flags', async () => {
    const passwordFile = join(homeDir, 'admin-password');
    writeFileSync(passwordFile, 'file-password\n');
    const io = promptIo();

    const result = await runCli(['init', '--email', 'admin@example.com', '--password-file', passwordFile], io);

    expect(result.exitCode).toBe(0);
    expect(readJson(adminPath(homeDir))).toEqual({
      email: 'admin@example.com',
      password: 'file-password',
    });
    expect(io.prompt).not.toHaveBeenCalled();
    expect(io.promptHidden).not.toHaveBeenCalled();
  });

  it('rejects invalid admin email', async () => {
    const io = promptIo({
      promptAnswers: ['not-an-email'],
      hiddenAnswers: ['test-password', 'test-password'],
    });

    const result = await runCli(['init'], io);

    expect(result).toEqual({ exitCode: 1, stdout: '', stderr: 'invalid admin email' });
    expect(existsSync(secretPath(homeDir))).toBe(false);
    expect(existsSync(adminPath(homeDir))).toBe(false);
  });
});

function promptIo(options: {
  promptAnswers?: string[];
  hiddenAnswers?: string[];
} = {}): CliIo {
  const promptAnswers = [...(options.promptAnswers ?? [])];
  const hiddenAnswers = [...(options.hiddenAnswers ?? [])];
  return {
    prompt: vi.fn(async () => promptAnswers.shift() ?? ''),
    promptHidden: vi.fn(async () => hiddenAnswers.shift() ?? ''),
  };
}

function dataDir(homeDir: string): string {
  return join(homeDir, '.local/share/pgas-new');
}

function secretPath(homeDir: string): string {
  return join(dataDir(homeDir), 'jwt.secret');
}

function adminPath(homeDir: string): string {
  return join(dataDir(homeDir), 'initial-admin.json');
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function modeOf(path: string): string {
  return (statSync(path).mode & 0o777).toString(8);
}
