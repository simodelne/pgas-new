import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WiringManifest } from '../../src/pgas-new/wiring-manifest.js';

const spawnMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const { handlers } = await import('../../src/foundry-program/handlers.js');

const MANIFEST: WiringManifest = {
  schema_version: 1,
  repo: { kind: 'existing_repo', package_manager: 'npm' },
  pgas: {
    server_package: '@simodelne/pgas-server',
    allowed_imports: [
      '@simodelne/pgas-server/plugin.js',
      '@simodelne/pgas-server/create-server.js',
      '@simodelne/pgas-server/client.js',
      '@simodelne/pgas-server/channels/index.js',
      '@simodelne/pgas-server/routes/index.js',
    ],
  },
  paths: { programs_dir: 'programs', audit_dir: 'audit', pgas_new_dir: '.pgas/pgas-new' },
  registration: { strategy: 'curator_request' },
  verification: { commands: { install: 'npm install --no-audit --no-fund', typecheck: 'npm run typecheck', test: 'npm test' } },
  curator: { github_owner: 'simodelne', github_repo: 'simoneos' },
};

beforeEach(() => {
  spawnMock.mockReset();
  vi.unstubAllGlobals();
});

describe('npm_install', () => {
  it('runs npm install inside program.target_dir', async () => {
    spawnMock.mockImplementationOnce(() => fakeChild({ stdout: 'installed\n' }));

    await expect(handlers.npm_install(payload({ cwd: '/tmp/out' }))).resolves.toMatchObject({
      kind: 'command_result',
      command: 'npm install --no-audit --no-fund',
      status: 'passed',
    });
    expect(spawnMock).toHaveBeenCalledWith('npm', ['install', '--no-audit', '--no-fund'], expect.objectContaining({ cwd: '/tmp/out' }));
  });

  it('defaults command cwd to program.target_dir for live native tool calls', async () => {
    spawnMock.mockImplementationOnce(() => fakeChild({ stdout: 'installed\n' }));

    await expect(handlers.npm_install(payload({}))).resolves.toMatchObject({
      kind: 'command_result',
      command: 'npm install --no-audit --no-fund',
      status: 'passed',
    });
    expect(spawnMock).toHaveBeenCalledWith('npm', ['install', '--no-audit', '--no-fund'], expect.objectContaining({ cwd: '/tmp/out' }));
  });

  it('rejects cwd traversal', async () => {
    await expect(handlers.npm_install(payload({ cwd: '/tmp/other' }))).rejects.toThrow(/cwd must be inside program.target_dir/);
  });

  it('throws with stderr tail on non-zero exit', async () => {
    spawnMock.mockImplementationOnce(() => fakeChild({ code: 1, stderr: 'install failed\n' }));

    await expect(handlers.npm_install(payload({ cwd: '/tmp/out' }))).rejects.toThrow(/install failed/);
  });
});

describe('npm_typecheck and npm_test', () => {
  it('runs typecheck and test commands with evidence ids', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeChild({ stdout: 'typecheck ok\n' }))
      .mockImplementationOnce(() => fakeChild({ stdout: 'test ok\n' }));

    await expect(handlers.npm_typecheck(payload({ cwd: '/tmp/out' }))).resolves.toMatchObject({
      kind: 'command_result',
      evidence_id: expect.stringMatching(/^static-/),
      status: 'passed',
    });
    await expect(handlers.npm_test(payload({ cwd: '/tmp/out' }))).resolves.toMatchObject({
      kind: 'command_result',
      evidence_id: expect.stringMatching(/^static-/),
      status: 'passed',
    });
  });

  it('times out long-running npm commands', async () => {
    vi.useFakeTimers();
    spawnMock.mockImplementationOnce(() => fakeChild({ hang: true }));

    const promise = handlers.npm_typecheck(payload({ cwd: '/tmp/out' }));
    const assertion = expect(promise).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(120_001);

    await assertion;
    vi.useRealTimers();
  });
});

describe('git_status and git_rebase_latest', () => {
  it('returns clean git status lines', async () => {
    spawnMock.mockImplementationOnce(() => fakeChild({ stdout: '' }));

    await expect(handlers.git_status(payload({ cwd: '/tmp/out' }))).resolves.toEqual({ clean: true, lines: [] });
  });

  it('runs fetch then rebase for the target branch', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeChild({ stdout: 'fetched\n' }))
      .mockImplementationOnce(() => fakeChild({ stdout: 'rebased\n' }));

    await expect(handlers.git_rebase_latest(payload({ cwd: '/tmp/out', target_branch: 'main' }))).resolves.toMatchObject({
      kind: 'git_rebase_latest',
      status: 'passed',
    });
    expect(spawnMock).toHaveBeenNthCalledWith(1, 'git', ['fetch', 'origin'], expect.any(Object));
    expect(spawnMock).toHaveBeenNthCalledWith(2, 'git', ['rebase', 'origin/main'], expect.any(Object));
  });

  it('defaults rebase cwd and target branch for the standalone graduation path', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeChild({ stdout: 'fetched\n' }))
      .mockImplementationOnce(() => fakeChild({ stdout: 'rebased\n' }));

    await expect(handlers.git_rebase_latest(payload({}))).resolves.toMatchObject({
      kind: 'git_rebase_latest',
      status: 'passed',
    });
    expect(spawnMock).toHaveBeenNthCalledWith(1, 'git', ['fetch', 'origin'], expect.any(Object));
    expect(spawnMock).toHaveBeenNthCalledWith(2, 'git', ['rebase', 'origin/main'], expect.any(Object));
  });

  it('reports unmerged paths on rebase conflict', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeChild({ stdout: 'fetched\n' }))
      .mockImplementationOnce(() => fakeChild({ code: 1, stderr: 'CONFLICT\n', stdout: 'UU src/a.ts\n' }));

    await expect(handlers.git_rebase_latest(payload({ cwd: '/tmp/out', target_branch: 'main' }))).rejects.toThrow(/unmerged paths.*src\/a\.ts/s);
  });
});

describe('open_pull_request', () => {
  it('returns PR url and number from gh output', async () => {
    spawnMock.mockImplementationOnce(() => fakeChild({ stdout: 'https://github.com/simodelne/pgas-new/pull/42\n' }));

    await expect(handlers.open_pull_request(payload({ cwd: '/tmp/out', title: 'Phase 3', body: 'Evidence' }))).resolves.toEqual({
      url: 'https://github.com/simodelne/pgas-new/pull/42',
      number: 42,
    });
  });

  it('throws on gh failure', async () => {
    spawnMock.mockImplementationOnce(() => fakeChild({ code: 1, stderr: 'not authenticated\n' }));

    await expect(handlers.open_pull_request(payload({ cwd: '/tmp/out', title: 'Phase 3', body: 'Evidence' }))).rejects.toThrow(
      /not authenticated/,
    );
  });
});

describe('load_wiring_manifest', () => {
  it('loads and validates .pgas/wiring.yml', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'pgas-new-manifest-'));
    try {
      mkdirSync(join(repoRoot, '.pgas'), { recursive: true });
      writeFileSync(join(repoRoot, '.pgas/wiring.yml'), manifestYaml());

      await expect(handlers.load_wiring_manifest({ repo_root: repoRoot })).resolves.toMatchObject({
        kind: 'wiring_manifest_loaded',
        status: 'valid',
        path: '.pgas/wiring.yml',
        write_authorized: true,
      });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('throws the fixed missing-manifest refusal and writes a curator request artifact', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'pgas-new-no-manifest-'));
    try {
      await expect(
        handlers.load_wiring_manifest({
          repo_root: repoRoot,
          domain: {
            'program.slug': 'missing-manifest-test',
          },
        }),
      ).rejects.toThrow(
        new RegExp(`no wiring manifest at ${repoRoot}/\\.pgas/wiring\\.yml; foundry must lodge a curator request instead of writing`),
      );
      const artifact = readFileSync(join(repoRoot, 'audit/PGAS-NEW-missing-manifest-test.md'), 'utf8');
      expect(artifact).toContain('PGAS-New Wiring Request');
      expect(artifact).toContain(`no wiring manifest at ${repoRoot}/.pgas/wiring.yml`);
      expect(artifact).toContain('No local writes were performed');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('create_curator_request', () => {
  it('sources repo_root from wiring manifest state when the LLM omits repo_root', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'pgas-new-curator-state-'));
    try {
      const result = await handlers.create_curator_request({
        message: 'Manifest is valid; lodge curator follow-up for SimoneOS registration.',
        domain: {
          'program.slug': 'incident-triage',
          'program.name': 'Incident Triage',
          'program.target_dir': '/tmp/fallback-target',
          'repo.wiring_manifest.repo_root': repoRoot,
          'repo.wiring_manifest_json': JSON.stringify(MANIFEST),
        },
      });

      expect(result).toMatchObject({
        kind: 'curator_request_created',
        path: 'audit/PGAS-NEW-incident-triage.md',
        title: 'PGAS-New Curator Request: Incident Triage',
      });
      const artifact = readFileSync(join(repoRoot, 'audit/PGAS-NEW-incident-triage.md'), 'utf8');
      expect(artifact).toContain('# PGAS-New Curator Request: Incident Triage');
      expect(artifact).toContain('Program: Incident Triage (`incident-triage`)');
      expect(artifact).toContain(`Repository: ${repoRoot}`);
      expect(artifact).toContain('Manifest is valid; lodge curator follow-up for SimoneOS registration.');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('writes a curator request into the manifest audit dir', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'pgas-new-curator-'));
    try {
      const result = await handlers.create_curator_request({
        repo_root: repoRoot,
        slug: 'incident-triage',
        title: 'Need wiring',
        body: 'Please publish wiring.',
        domain: { 'repo.wiring_manifest_json': JSON.stringify(MANIFEST) },
      });

      expect(result).toMatchObject({ kind: 'curator_request_created', path: 'audit/PGAS-NEW-incident-triage.md' });
      expect(readFileSync(join(repoRoot, 'audit/PGAS-NEW-incident-triage.md'), 'utf8')).toContain('Need wiring');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('verification handlers', () => {
  it('runs api blackbox verification', async () => {
    spawnMock.mockImplementationOnce(() => fakeChild({ stdout: 'api ok\n' }));

    await expect(handlers.run_api_blackbox_verification(payload({ cwd: '/tmp/out' }))).resolves.toMatchObject({
      kind: 'command_result',
      evidence_id: expect.stringMatching(/^static-/),
      status: 'passed',
    });
    expect(spawnMock).toHaveBeenCalledWith('npm', ['test', '--', 'tests/api-blackbox.test.ts'], expect.any(Object));
  });

  it('skips live provider verification when provider URL is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    await expect(handlers.run_live_provider_verification(payload({ cwd: '/tmp/out' }))).resolves.toMatchObject({
      kind: 'live_provider_verification',
      status: 'skipped',
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('web_research', () => {
  it('requires explicit user authorization', async () => {
    await expect(handlers.web_research({ query: 'pgas', domain: {} })).rejects.toThrow(/user research requires explicit authorization/);
  });

  it('returns the v3 research stub when authorized', async () => {
    await expect(
      handlers.web_research({ query: 'pgas', domain: { 'intake.user_research_authorized': true } }),
    ).resolves.toEqual({ kind: 'web_research_stub', query: 'pgas', results: [] });
  });
});

function payload(args: Record<string, unknown>) {
  return {
    ...args,
    domain: {
      'program.target_dir': '/tmp/out',
    },
  };
}

function fakeChild(options: { code?: number; stdout?: string; stderr?: string; hang?: boolean }) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => {
    child.emit('close', null, 'SIGTERM');
    return true;
  });

  queueMicrotask(() => {
    if (options.stdout) child.stdout.write(options.stdout);
    if (options.stderr) child.stderr.write(options.stderr);
    child.stdout.end();
    child.stderr.end();
    if (!options.hang) child.emit('close', options.code ?? 0, null);
  });

  return child;
}

function manifestYaml(): string {
  return `schema_version: 1
repo:
  kind: existing_repo
  package_manager: npm
pgas:
  server_package: '@simodelne/pgas-server'
  allowed_imports:
    - '@simodelne/pgas-server/plugin.js'
    - '@simodelne/pgas-server/create-server.js'
    - '@simodelne/pgas-server/client.js'
    - '@simodelne/pgas-server/channels/index.js'
    - '@simodelne/pgas-server/routes/index.js'
paths:
  programs_dir: programs
  audit_dir: audit
  pgas_new_dir: .pgas/pgas-new
registration:
  strategy: curator_request
verification:
  commands:
    install: npm install --no-audit --no-fund
    typecheck: npm run typecheck
    test: npm test
curator:
  github_owner: simodelne
  github_repo: simoneos
`;
}
