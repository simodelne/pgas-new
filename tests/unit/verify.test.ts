import { describe, expect, it } from 'vitest';
import {
  createMockCommandRunner,
  runLiveProviderVerification,
  runPostRebaseVerification,
  runStaticVerification,
} from '../../src/pgas-new/verify.js';

describe('verification runner', () => {
  it('runs the static verification ladder in semantic command order', async () => {
    const runner = createMockCommandRunner();
    const evidence = await runStaticVerification({ cwd: '/repo', runner });

    expect(runner.calls).toEqual(['npmInstall', 'npmTypecheck', 'npmTest', 'runGeneratedStaticTests']);
    expect(evidence.map((item) => item.command_id)).toEqual([
      'npmInstall',
      'npmTypecheck',
      'npmTest',
      'runGeneratedStaticTests',
    ]);
    expect(evidence.every((item) => item.status === 'pass')).toBe(true);
    expect(evidence[0]).toMatchObject({
      cwd: '/repo',
      exit_code: 0,
      stdout_excerpt: 'npmInstall ok',
    });
  });

  it('skips live-provider verification with explicit evidence when env is absent', async () => {
    const runner = createMockCommandRunner();
    const evidence = await runLiveProviderVerification({ cwd: '/repo', runner, env: {} });

    expect(runner.calls).toEqual([]);
    expect(evidence).toEqual([
      {
        command_id: 'runLiveProviderVerification',
        cwd: '/repo',
        duration_ms: 0,
        exit_code: null,
        status: 'skip',
        stdout_excerpt: 'missing PGAS_LIVE_PROVIDER, PGAS_API_BASE, or PGAS_API_TOKEN',
      },
    ]);
  });

  it('runs live-provider verification separately from static evidence when env is present', async () => {
    const runner = createMockCommandRunner();
    const evidence = await runLiveProviderVerification({
      cwd: '/repo',
      runner,
      env: {
        PGAS_LIVE_PROVIDER: 'openai',
        PGAS_API_BASE: 'http://127.0.0.1:3000',
        PGAS_API_TOKEN: 'token',
      },
    });

    expect(runner.calls).toEqual(['runLiveProviderVerification']);
    expect(evidence).toHaveLength(1);
    expect(evidence[0].status).toBe('pass');
  });

  it('reruns the full static ladder after rebasing latest', async () => {
    const runner = createMockCommandRunner();
    const evidence = await runPostRebaseVerification({ cwd: '/repo', runner, branch: 'main' });

    expect(runner.calls).toEqual([
      'gitStatus',
      'gitRebaseLatest',
      'npmInstall',
      'npmTypecheck',
      'npmTest',
      'runGeneratedStaticTests',
    ]);
    expect(evidence.map((item) => item.command_id)).toEqual(runner.calls);
  });
});
