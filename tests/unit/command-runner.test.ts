import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  createNodeCommandRunner,
  isSafeGitBranchName,
  type SpawnImpl,
} from '../../src/pgas-new/command-runner.js';

interface SpawnCall {
  command: string;
  args: string[];
  cwd: string;
  shell: false;
}

interface SpawnResult {
  code: number;
  stdout?: string;
  stderr?: string;
}

const REQUIRED_STRIPPED_FOUNDRY_ENV_KEYS = [
  'PGAS_OPENAI_BASE_URL',
  'PGAS_OPENAI_MODEL',
  'PGAS_OPENAI_API_KEY',
  'PGAS_OPENAI_TOOL_CHOICE',
  'PGAS_OPENAI_DISABLE_JSON_RESPONSE_FORMAT',
  'PGAS_MODEL',
  'PGAS_PROVIDER',
  'PGAS_ENABLE_MOCK_PROVIDER',
  'PGAS_LIVE_SYNTH',
  'PGAS_LIVE_GRADUATION',
  'PGAS_LIVE_REPO_TARGETING',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
] as const;

function fakeSpawn(results: SpawnResult[]): { calls: SpawnCall[]; envs: NodeJS.ProcessEnv[]; spawn: SpawnImpl } {
  const calls: SpawnCall[] = [];
  const envs: NodeJS.ProcessEnv[] = [];

  const spawn: SpawnImpl = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd, shell: options.shell });
    envs.push(options.env);
    const result = results.shift() ?? { code: 0 };
    const emitter = new EventEmitter();
    const child = emitter as ReturnType<SpawnImpl>;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    child.stdout = stdout;
    child.stderr = stderr;

    setImmediate(() => {
      stdout.end(result.stdout ?? '');
      stderr.end(result.stderr ?? '');
      emitter.emit('close', result.code);
    });

    return child;
  };

  return { calls, envs, spawn };
}

describe('node command runner', () => {
  it('maps semantic npm commands to fixed argv without shell execution', async () => {
    const { calls, spawn } = fakeSpawn([{ code: 0, stdout: 'ok' }]);
    const runner = createNodeCommandRunner(spawn);

    const result = await runner.npmInstall({ cwd: '/tmp/repo' });

    expect(result).toMatchObject({
      command_id: 'npmInstall',
      cwd: '/tmp/repo',
      exit_code: 0,
      stdout_excerpt: 'ok',
    });
    expect(calls).toEqual([
      {
        command: 'npm',
        args: ['install', '--no-audit', '--no-fund'],
        cwd: '/tmp/repo',
        shell: false,
      },
    ]);
  });

  it('runs the generated smoke test with a fixed npm argv', async () => {
    const { calls, spawn } = fakeSpawn([{ code: 0, stdout: 'smoke ok' }]);
    const runner = createNodeCommandRunner(spawn);

    const result = await runner.runGeneratedSmokeTest({ cwd: '/tmp/repo' });

    expect(result).toMatchObject({
      command_id: 'runGeneratedSmokeTest',
      cwd: '/tmp/repo',
      exit_code: 0,
      stdout_excerpt: 'smoke ok',
    });
    expect(calls).toEqual([
      {
        command: 'npm',
        args: ['test', '--', 'tests/generated-program-smoke.test.ts'],
        cwd: '/tmp/repo',
        shell: false,
      },
    ]);
  });

  it('strips foundry provider env from target verification commands while preserving ordinary env', async () => {
    for (const key of REQUIRED_STRIPPED_FOUNDRY_ENV_KEYS) {
      vi.stubEnv(key, `foundry-${key}`);
    }
    try {
      const { envs, spawn } = fakeSpawn([{ code: 0, stdout: 'ok' }]);
      const runner = createNodeCommandRunner(spawn);

      await runner.npmTest({ cwd: '/tmp/repo', env: { TARGET_ENV: 'kept' } });

      expect(envs[0]).toMatchObject({
        PATH: process.env.PATH,
        TARGET_ENV: 'kept',
      });
      for (const key of REQUIRED_STRIPPED_FOUNDRY_ENV_KEYS) {
        expect(envs[0]).not.toHaveProperty(key);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rebases by fetching the declared branch and then rebasing against origin branch', async () => {
    const { calls, spawn } = fakeSpawn([{ code: 0, stdout: 'fetch' }, { code: 0, stdout: 'rebase' }]);
    const runner = createNodeCommandRunner(spawn);

    const result = await runner.gitRebaseLatest({ cwd: '/tmp/repo', branch: 'develop' });

    expect(result.exit_code).toBe(0);
    expect(result.stdout_excerpt).toContain('fetch');
    expect(result.stdout_excerpt).toContain('rebase');
    expect(calls.map((call) => [call.command, call.args])).toEqual([
      ['git', ['fetch', 'origin', 'develop', '--prune']],
      ['git', ['rebase', 'origin/develop']],
    ]);
  });

  it('stops a command sequence after the first failing fixed command', async () => {
    const { calls, spawn } = fakeSpawn([{ code: 1, stderr: 'fetch failed' }, { code: 0, stdout: 'must not run' }]);
    const runner = createNodeCommandRunner(spawn);

    const result = await runner.gitRebaseLatest({ cwd: '/tmp/repo', branch: 'main' });

    expect(result.exit_code).toBe(1);
    expect(result.stderr_excerpt).toContain('fetch failed');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(['fetch', 'origin', 'main', '--prune']);
  });

  it('rejects option-like or unsafe branch names before invoking git', async () => {
    const { calls, spawn } = fakeSpawn([{ code: 0, stdout: 'must not run' }]);
    const runner = createNodeCommandRunner(spawn);

    await expect(runner.gitRebaseLatest({ cwd: '/tmp/repo', branch: '--upload-pack=evil' })).resolves.toMatchObject({
      command_id: 'gitRebaseLatest',
      exit_code: 1,
      stderr_excerpt: 'invalid git branch name: --upload-pack=evil',
    });
    await expect(runner.gitRebaseLatest({ cwd: '/tmp/repo', branch: 'feature bad' })).resolves.toMatchObject({
      exit_code: 1,
      stderr_excerpt: 'invalid git branch name: feature bad',
    });
    expect(calls).toEqual([]);
  });

  it('records explicit stderr markers when child stdio streams are null', async () => {
    const spawn: SpawnImpl = () => {
      const emitter = new EventEmitter();
      const child = emitter as ReturnType<SpawnImpl>;
      child.stdout = null;
      child.stderr = null;
      setImmediate(() => emitter.emit('close', 0));
      return child;
    };
    const runner = createNodeCommandRunner(spawn);

    const result = await runner.npmInstall({ cwd: '/tmp/repo' });

    expect(result.exit_code).toBe(0);
    expect(result.stderr_excerpt).toContain('child stdout not piped');
    expect(result.stderr_excerpt).toContain('child stderr not piped');
  });

  it('validates branch names conservatively', () => {
    expect(isSafeGitBranchName('main')).toBe(true);
    expect(isSafeGitBranchName('release/2026-06-18')).toBe(true);
    expect(isSafeGitBranchName('-main')).toBe(false);
    expect(isSafeGitBranchName('feature bad')).toBe(false);
    expect(isSafeGitBranchName('feature..bad')).toBe(false);
    expect(isSafeGitBranchName('feature@{bad')).toBe(false);
    expect(isSafeGitBranchName('feature.lock')).toBe(false);
  });
});
