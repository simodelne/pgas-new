import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startFoundryServer } from '../../src/foundry-server.js';
import { runCli, type CliIo } from '../../src/cli.js';

const mocks = vi.hoisted(() => ({
  startFoundryServer: vi.fn(),
}));

vi.mock('../../src/foundry-server.js', () => ({
  startFoundryServer: mocks.startFoundryServer,
}));

describe('pgas-new login', () => {
  const originalHome = process.env.HOME;
  const originalFetch = globalThis.fetch;
  const startFoundryServerMock = vi.mocked(startFoundryServer);
  let homeDir: string;
  let killMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'pgas-new-login-home-'));
    process.env.HOME = homeDir;
    killMock = vi.fn(async () => {});
    startFoundryServerMock.mockReset();
    startFoundryServerMock.mockResolvedValue({
      url: 'http://foundry.test',
      kill: killMock as unknown as () => Promise<void>,
    });
    globalThis.fetch = vi.fn(async () => json({ token: tokenWithExp(1893456000) }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('logs in non-interactively and caches the returned token with 0600 permissions', async () => {
    const passwordFile = join(homeDir, 'admin-password');
    writeFileSync(passwordFile, 'file-password\n');

    const result = await runCli(['login', '--email', 'admin@example.com', '--password-file', passwordFile]);

    expect(result).toEqual({
      exitCode: 0,
      stdout: 'login ok\ntoken expires at 2030-01-01T00:00:00.000Z',
      stderr: '',
    });
    expect(globalThis.fetch).toHaveBeenCalledWith('http://foundry.test/auth/login', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ email: 'admin@example.com', password: 'file-password' }),
    }));
    expect(readFileSync(tokenPath(homeDir), 'utf8')).toBe(tokenWithExp(1893456000));
    expect(modeOf(tokenPath(homeDir))).toBe('600');
    expect(killMock).toHaveBeenCalledOnce();
  });

  it('prompts for credentials when flags are omitted', async () => {
    const io = promptIo({
      promptAnswers: ['admin@example.com'],
      hiddenAnswers: ['prompt-password'],
    });

    const result = await runCli(['login'], io);

    expect(result.exitCode).toBe(0);
    expect(globalThis.fetch).toHaveBeenCalledWith('http://foundry.test/auth/login', expect.objectContaining({
      body: JSON.stringify({ email: 'admin@example.com', password: 'prompt-password' }),
    }));
  });

  it('returns exit 1 on invalid credentials and does not cache a token', async () => {
    globalThis.fetch = vi.fn(async () => json({ error: 'Invalid credentials' }, 401));
    const passwordFile = join(homeDir, 'admin-password');
    writeFileSync(passwordFile, 'file-password\n');

    const result = await runCli(['login', '--email', 'admin@example.com', '--password-file', passwordFile]);

    expect(result).toEqual({ exitCode: 1, stdout: '', stderr: 'login failed: invalid credentials' });
    expect(existsSync(tokenPath(homeDir))).toBe(false);
    expect(killMock).toHaveBeenCalledOnce();
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function tokenWithExp(exp: number): string {
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return `header.${payload}.signature`;
}

function tokenPath(homeDir: string): string {
  return join(homeDir, '.local/share/pgas-new/token');
}

function modeOf(path: string): string {
  return (statSync(path).mode & 0o777).toString(8);
}
