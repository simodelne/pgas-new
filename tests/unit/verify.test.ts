import { describe, expect, it } from 'vitest';
import {
  assertNoExecutedPathStubs,
  createMockCommandRunner,
  findExecutedPathStubMarkers,
  runGeneratedLiveDriveVerification,
  runLiveProviderVerification,
  runPostRebaseVerification,
  runSmokeVerification,
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
    const evidence = await runLiveProviderVerification({ cwd: '/repo', env: {} });

    expect(evidence).toEqual([
      {
        command_id: 'liveProviderRoundTrip',
        cwd: '/repo',
        duration_ms: 0,
        exit_code: null,
        status: 'skip',
        stdout_excerpt: 'missing PGAS_LIVE_PROVIDER, PGAS_API_BASE, or PGAS_API_TOKEN',
      },
    ]);
  });

  it('fails live-provider verification instead of skipping when PGAS_REQUIRE_LIVE=1', async () => {
    const evidence = await runLiveProviderVerification({
      cwd: '/repo',
      env: {
        PGAS_REQUIRE_LIVE: '1',
      },
    });

    expect(evidence).toEqual([
      {
        command_id: 'liveProviderRoundTrip',
        cwd: '/repo',
        duration_ms: 0,
        exit_code: 1,
        status: 'fail',
        stderr_excerpt: 'PGAS_REQUIRE_LIVE=1 requires PGAS_LIVE_PROVIDER, PGAS_API_BASE, and PGAS_API_TOKEN',
      },
    ]);
  });

  it('promotes live-provider verifier skips to failures when PGAS_REQUIRE_LIVE=1', async () => {
    const evidence = await runLiveProviderVerification({
      cwd: '/repo',
      env: {
        PGAS_REQUIRE_LIVE: '1',
        PGAS_LIVE_PROVIDER: 'openai',
        PGAS_API_BASE: 'http://127.0.0.1:3000',
        PGAS_API_TOKEN: 'token',
      },
      verifier: {
        async verify() {
          return {
            duration_ms: 5,
            exit_code: null,
            status: 'skip',
            stdout_excerpt: 'provider unreachable',
          };
        },
      },
    });

    expect(evidence).toEqual([
      {
        command_id: 'liveProviderRoundTrip',
        cwd: '/repo',
        duration_ms: 5,
        exit_code: 1,
        status: 'fail',
        stdout_excerpt: 'provider unreachable',
        stderr_excerpt: 'PGAS_REQUIRE_LIVE=1 forbids skipped live-provider verification',
      },
    ]);
  });

  it('runs live-provider verification separately from static evidence when env is present', async () => {
    const evidence = await runLiveProviderVerification({
      cwd: '/repo',
      env: {
        PGAS_LIVE_PROVIDER: 'openai',
        PGAS_API_BASE: 'http://127.0.0.1:3000',
        PGAS_API_TOKEN: 'token',
      },
      verifier: {
        async verify() {
          return {
            duration_ms: 5,
            exit_code: 0,
            status: 'pass',
            stdout_excerpt: 'live provider round trip ok',
          };
        },
      },
    });

    expect(evidence).toHaveLength(1);
    expect(evidence[0].command_id).toBe('liveProviderRoundTrip');
    expect(evidence[0].status).toBe('pass');
  });

  it('fails live-provider verification when env is populated but no verifier is configured', async () => {
    const evidence = await runLiveProviderVerification({
      cwd: '/repo',
      env: {
        PGAS_LIVE_PROVIDER: 'openai',
        PGAS_API_BASE: 'http://127.0.0.1:3000',
        PGAS_API_TOKEN: 'token',
      },
    });

    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      command_id: 'liveProviderRoundTrip',
      cwd: '/repo',
      exit_code: null,
      status: 'fail',
    });
    expect(evidence[0].stderr_excerpt).toMatch(/verifier not configured/);
  });

  it('does not allow live verifier output to override evidence identity', async () => {
    const evidence = await runLiveProviderVerification({
      cwd: '/repo',
      env: {
        PGAS_LIVE_PROVIDER: 'openai',
        PGAS_API_BASE: 'http://127.0.0.1:3000',
        PGAS_API_TOKEN: 'token',
      },
      verifier: {
        async verify() {
          return {
            command_id: 'npmTest',
            cwd: '/other',
            duration_ms: 5,
            exit_code: 0,
            status: 'pass',
            stdout_excerpt: 'live provider round trip ok',
          } as never;
        },
      },
    });

    expect(evidence[0].command_id).toBe('liveProviderRoundTrip');
    expect(evidence[0].cwd).toBe('/repo');
  });

  it('skips generated live-drive verification with explicit evidence when provider env is absent', async () => {
    const evidence = await runGeneratedLiveDriveVerification({ cwd: '/repo', env: {} });

    expect(evidence).toEqual([
      {
        command_id: 'generatedLiveDrive',
        cwd: '/repo',
        duration_ms: 0,
        exit_code: null,
        status: 'skip',
        stdout_excerpt: 'missing PGAS_OPENAI_BASE_URL or PGAS_OPENAI_MODEL/PGAS_MODEL',
      },
    ]);
  });

  it('fails generated live-drive verification instead of skipping when PGAS_REQUIRE_LIVE=1', async () => {
    const evidence = await runGeneratedLiveDriveVerification({
      cwd: '/repo',
      env: { PGAS_REQUIRE_LIVE: '1' },
    });

    expect(evidence).toEqual([
      {
        command_id: 'generatedLiveDrive',
        cwd: '/repo',
        duration_ms: 0,
        exit_code: 1,
        status: 'fail',
        stderr_excerpt: 'PGAS_REQUIRE_LIVE=1 requires PGAS_OPENAI_BASE_URL and PGAS_OPENAI_MODEL (or PGAS_MODEL)',
      },
    ]);
  });

  it('fails generated live-drive verification when provider env is present but no verifier is configured', async () => {
    const evidence = await runGeneratedLiveDriveVerification({
      cwd: '/repo',
      env: {
        PGAS_OPENAI_BASE_URL: 'http://provider.local/v1',
        PGAS_OPENAI_MODEL: 'qwen36-27b',
      },
    });

    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      command_id: 'generatedLiveDrive',
      cwd: '/repo',
      status: 'fail',
    });
    expect(evidence[0].stderr_excerpt).toContain('verifier not configured');
  });

  it('promotes generated live-drive verifier skips to failures when PGAS_REQUIRE_LIVE=1', async () => {
    const evidence = await runGeneratedLiveDriveVerification({
      cwd: '/repo',
      env: {
        PGAS_REQUIRE_LIVE: '1',
        PGAS_OPENAI_BASE_URL: 'http://provider.local/v1',
        PGAS_MODEL: 'qwen36-27b',
      },
      verifier: {
        verify: async () => ({
          duration_ms: 5,
          exit_code: null,
          status: 'skip',
          stdout_excerpt: 'provider unreachable',
        }),
      },
    });

    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      command_id: 'generatedLiveDrive',
      cwd: '/repo',
      exit_code: 1,
      status: 'fail',
    });
  });

  it('returns the generated live-drive verifier result when env is present and the drive passes', async () => {
    const evidence = await runGeneratedLiveDriveVerification({
      cwd: '/repo',
      env: {
        PGAS_OPENAI_BASE_URL: 'http://provider.local/v1',
        PGAS_OPENAI_MODEL: 'qwen36-27b',
      },
      verifier: {
        verify: async () => ({
          duration_ms: 1234,
          exit_code: 0,
          status: 'pass',
          stdout_excerpt: 'final_mode=complete provider_hits=5',
        }),
      },
    });

    expect(evidence).toEqual([
      {
        command_id: 'generatedLiveDrive',
        cwd: '/repo',
        duration_ms: 1234,
        exit_code: 0,
        status: 'pass',
        stdout_excerpt: 'final_mode=complete provider_hits=5',
      },
    ]);
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

  it('runs anti-stub scanning before the generated smoke test', async () => {
    const runner = createMockCommandRunner();
    const evidence = await runSmokeVerification({
      cwd: '/repo',
      runner,
      executedOutputs: [
        {
          result_json: JSON.stringify({ status: 'triaged' }),
          items_json: JSON.stringify(['triaged']),
        },
      ],
    });

    expect(runner.calls).toEqual(['runGeneratedSmokeTest']);
    expect(evidence.map((item) => item.command_id)).toEqual(['antiStubScan', 'runGeneratedSmokeTest']);
    expect(evidence.every((item) => item.status === 'pass')).toBe(true);
  });

  it('fails smoke verification before command execution when executed outputs contain stubs', async () => {
    const runner = createMockCommandRunner();
    const evidence = await runSmokeVerification({
      cwd: '/repo',
      runner,
      executedOutputs: [
        { kind: 'stage_action_stub', todo: 'fill me in' },
      ],
    });

    expect(runner.calls).toEqual([]);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      command_id: 'antiStubScan',
      status: 'fail',
      exit_code: 1,
    });
    expect(evidence[0].stderr_excerpt).toMatch(/stage_action_stub/);
    expect(evidence[0].stderr_excerpt).toMatch(/todo field/);
  });

  it('detects executed-path default fallback shapes and unsafe TODO markers', () => {
    const findings = findExecutedPathStubMarkers({
      result_json: {},
      items_json: [],
      message: 'TODO: implement later',
    });

    expect(findings.map((finding) => finding.marker)).toEqual(
      expect.arrayContaining(['empty_object', 'empty_array', 'TODO']),
    );
    expect(() => assertNoExecutedPathStubs({ result_json: '{}' })).toThrow(/stub markers/);
  });
});
