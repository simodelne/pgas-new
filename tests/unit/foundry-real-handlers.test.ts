import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WiringManifest } from '../../src/pgas-new/wiring-manifest.js';

const spawnMock = vi.fn();
const driveGeneratedProgramLiveMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

vi.mock('../../src/pgas-new/generated-live-drive.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/pgas-new/generated-live-drive.js')>();
  return {
    ...actual,
    driveGeneratedProgramLive: (...args: unknown[]) => driveGeneratedProgramLiveMock(...args),
  };
});

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
  driveGeneratedProgramLiveMock.mockReset();
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

  it('uses an attached repo manifest build command instead of hardcoded npm run typecheck', async () => {
    spawnMock.mockImplementationOnce(() => fakeChild({ stdout: 'build ok\n' }));

    const manifestWithBuildOnly = {
      ...MANIFEST,
      verification: {
        commands: {
          install: 'npm install --no-audit --no-fund',
          build: 'npm run build',
          test: 'npm test',
        },
      },
    };

    await expect(
      handlers.npm_typecheck(payload({
        cwd: '/tmp/out',
        domain: {
          'repo.target_kind': 'existing_repo',
          'repo.wiring_manifest_json': JSON.stringify(manifestWithBuildOnly),
        },
      })),
    ).resolves.toMatchObject({
      kind: 'command_result',
      command: 'npm run build',
      status: 'passed',
    });
    expect(spawnMock).toHaveBeenCalledWith('npm', ['run', 'build'], expect.objectContaining({ cwd: '/tmp/out' }));
  });

  it('strips foundry provider env from target verification commands while preserving ordinary env', async () => {
    vi.stubEnv('PGAS_PROVIDER', 'openai');
    vi.stubEnv('PGAS_OPENAI_API_KEY', 'foundry-openai-key');
    vi.stubEnv('PGAS_OPENAI_TOOL_CHOICE', 'required');
    vi.stubEnv('ANTHROPIC_API_KEY', 'foundry-anthropic-key');
    try {
      spawnMock.mockImplementationOnce(() => fakeChild({ stdout: 'test ok\n' }));

      await expect(handlers.npm_test(payload({ cwd: '/tmp/out' }))).resolves.toMatchObject({
        kind: 'command_result',
        status: 'passed',
      });

      const spawnOptions = spawnMock.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
      expect(spawnOptions?.env).toMatchObject({ PATH: process.env.PATH });
      expect(spawnOptions?.env).not.toHaveProperty('PGAS_PROVIDER');
      expect(spawnOptions?.env).not.toHaveProperty('PGAS_OPENAI_API_KEY');
      expect(spawnOptions?.env).not.toHaveProperty('PGAS_OPENAI_TOOL_CHOICE');
      expect(spawnOptions?.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    } finally {
      vi.unstubAllEnvs();
    }
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
  it('returns clean git status lines (git repo)', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeChild({ stdout: 'true\n' })) // rev-parse --is-inside-work-tree
      .mockImplementationOnce(() => fakeChild({ stdout: '' })); // status --porcelain

    await expect(handlers.git_status(payload({ cwd: '/tmp/out' }))).resolves.toEqual({ clean: true, lines: [] });
    expect(spawnMock).toHaveBeenNthCalledWith(1, 'git', ['rev-parse', '--is-inside-work-tree'], expect.any(Object));
    expect(spawnMock).toHaveBeenNthCalledWith(2, 'git', ['status', '--porcelain'], expect.any(Object));
  });

  it('runs fetch then rebase for the target branch (repo has origin)', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeChild({ stdout: 'origin\n' }))
      .mockImplementationOnce(() => fakeChild({ stdout: 'fetched\n' }))
      .mockImplementationOnce(() => fakeChild({ stdout: 'rebased\n' }));

    await expect(handlers.git_rebase_latest(payload({ cwd: '/tmp/out', target_branch: 'main' }))).resolves.toMatchObject({
      kind: 'git_rebase_latest',
      status: 'passed',
    });
    expect(spawnMock).toHaveBeenNthCalledWith(1, 'git', ['remote'], expect.any(Object));
    expect(spawnMock).toHaveBeenNthCalledWith(2, 'git', ['fetch', 'origin'], expect.any(Object));
    expect(spawnMock).toHaveBeenNthCalledWith(3, 'git', ['rebase', '--autostash', 'origin/main'], expect.any(Object));
  });

  it('defaults rebase cwd and target branch when the repo has an origin', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeChild({ stdout: 'origin\n' }))
      .mockImplementationOnce(() => fakeChild({ stdout: 'fetched\n' }))
      .mockImplementationOnce(() => fakeChild({ stdout: 'rebased\n' }));

    await expect(handlers.git_rebase_latest(payload({}))).resolves.toMatchObject({
      kind: 'git_rebase_latest',
      status: 'passed',
    });
    expect(spawnMock).toHaveBeenNthCalledWith(1, 'git', ['remote'], expect.any(Object));
    expect(spawnMock).toHaveBeenNthCalledWith(2, 'git', ['fetch', 'origin'], expect.any(Object));
    expect(spawnMock).toHaveBeenNthCalledWith(3, 'git', ['rebase', '--autostash', 'origin/main'], expect.any(Object));
  });

  it('skips rebase (passed) when the target has no origin remote (#106 standalone)', async () => {
    spawnMock.mockImplementationOnce(() => fakeChild({ stdout: '\n' }));

    await expect(handlers.git_rebase_latest(payload({ cwd: '/tmp/out' }))).resolves.toMatchObject({
      kind: 'git_rebase_latest',
      status: 'passed',
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenNthCalledWith(1, 'git', ['remote'], expect.any(Object));
  });

  it('reports unmerged paths on rebase conflict', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeChild({ stdout: 'origin\n' }))
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

  it('fails live provider verification when provider URL is unreachable and PGAS_REQUIRE_LIVE=1', async () => {
    const previousRequireLive = process.env.PGAS_REQUIRE_LIVE;
    process.env.PGAS_REQUIRE_LIVE = '1';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    try {
      await expect(handlers.run_live_provider_verification(payload({ cwd: '/tmp/out' }))).resolves.toMatchObject({
        kind: 'live_provider_verification',
        status: 'failed',
        reason: expect.stringContaining('provider unreachable'),
      });
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      restoreEnv('PGAS_REQUIRE_LIVE', previousRequireLive);
    }
  });

  it('skips the generated live drive when no provider model is configured', async () => {
    const previousModel = process.env.PGAS_OPENAI_MODEL;
    const previousPgasModel = process.env.PGAS_MODEL;
    delete process.env.PGAS_OPENAI_MODEL;
    delete process.env.PGAS_MODEL;
    try {
      await expect(handlers.run_generated_live_drive_verification(payload({ cwd: '/tmp/out' }))).resolves.toMatchObject({
        kind: 'generated_live_drive_verification',
        status: 'skipped',
        reason: expect.stringContaining('no provider model configured'),
      });
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      restoreEnv('PGAS_OPENAI_MODEL', previousModel);
      restoreEnv('PGAS_MODEL', previousPgasModel);
    }
  });

  it('skips the generated live drive when the provider is unreachable', async () => {
    const previousModel = process.env.PGAS_OPENAI_MODEL;
    process.env.PGAS_OPENAI_MODEL = 'qwen36-27b';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    try {
      await expect(handlers.run_generated_live_drive_verification(payload({ cwd: '/tmp/out' }))).resolves.toMatchObject({
        kind: 'generated_live_drive_verification',
        status: 'skipped',
        reason: expect.stringContaining('provider unreachable'),
      });
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      restoreEnv('PGAS_OPENAI_MODEL', previousModel);
    }
  });

  it('fails the generated live drive when unreachable and PGAS_REQUIRE_LIVE=1 (hard gate stays blocked)', async () => {
    const previousRequireLive = process.env.PGAS_REQUIRE_LIVE;
    const previousModel = process.env.PGAS_OPENAI_MODEL;
    process.env.PGAS_REQUIRE_LIVE = '1';
    process.env.PGAS_OPENAI_MODEL = 'qwen36-27b';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    try {
      await expect(handlers.run_generated_live_drive_verification(payload({ cwd: '/tmp/out' }))).resolves.toMatchObject({
        kind: 'generated_live_drive_verification',
        status: 'failed',
        reason: expect.stringContaining('provider unreachable'),
      });
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      restoreEnv('PGAS_REQUIRE_LIVE', previousRequireLive);
      restoreEnv('PGAS_OPENAI_MODEL', previousModel);
    }
  });

  it('fails confirmation-loop live drive verification when choreography never engages', async () => {
    const previousModel = process.env.PGAS_OPENAI_MODEL;
    process.env.PGAS_OPENAI_MODEL = 'qwen36-27b';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    driveGeneratedProgramLiveMock.mockResolvedValueOnce({
      final_mode: 'complete',
      terminal: true,
      rounds: 4,
      triggers: 4,
      actions: ['complete_plan_work'],
      terminal_actions: [],
      world: {},
      provider_hits: 2,
      provider_exchanges: [],
      author_driver: 'default',
      status_history: [],
      choreography: {
        decision_table_respected: false,
        one_proposed_invariant_held: true,
        proposed_overlap_max: 0,
        items_seen_max: 0,
        decisions_applied: 0,
        terminal_items_final: 0,
        loop_engaged: false,
        provider_hits_ok: true,
        notes: ['decision_table_vacuous:no_decision_applied'],
      },
      runner_exit_code: 0,
      runner_output_excerpt: '',
    });

    try {
      await expect(
        handlers.run_generated_live_drive_verification!(payload({
          cwd: '/tmp/out',
          domain: confirmationLoopDomain(),
        })),
      ).resolves.toMatchObject({
        kind: 'generated_live_drive_verification',
        status: 'failed',
        reason: expect.stringContaining('confirmation loop choreography did not engage'),
      });

      expect(driveGeneratedProgramLiveMock).toHaveBeenCalledWith(expect.objectContaining({
        confirmationScript: expect.objectContaining({
          fallbackDecision: 'approve',
          itemsPath: 'work_units.items',
        }),
      }));
    } finally {
      restoreEnv('PGAS_OPENAI_MODEL', previousModel);
    }
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
  const domain = args.domain && typeof args.domain === 'object' && !Array.isArray(args.domain)
    ? args.domain as Record<string, unknown>
    : {};
  return {
    ...args,
    domain: {
      'program.target_dir': '/tmp/out',
      ...domain,
    },
  };
}

function confirmationLoopDomain(): Record<string, unknown> {
  const completion = {
    final_stage: 'complete',
    guard_field: 'work_units.all_terminal',
    collection_lifecycle: {
      version: 1,
      name: 'work_units',
      item_label: 'work unit',
      storage: {
        items_path: 'work_units.items',
        event_path: 'work_units.pending_event_json',
        violation_path: 'work_units.lifecycle_violation_json',
        representation: 'indexed_array',
      },
      item: {
        id_field: 'id',
        status_field: 'status',
        schema: {
          id: 'string',
          title: 'string',
          proposed_text: 'string',
          user_instruction: 'string',
        },
      },
      statuses: [
        { name: 'pending', initial: true },
        { name: 'proposed' },
        { name: 'accepted', terminal: true },
        { name: 'skipped', terminal: true },
      ],
      transitions: [],
      aggregate: {
        guard_field: 'work_units.all_terminal',
        terminal_statuses: ['accepted', 'skipped'],
        require_non_empty: true,
      },
    },
  };
  const interaction = {
    confirmation_loops: [{
      collection: 'work_units.items',
      proposed_status: 'proposed',
      seed: { source_stage: 'plan_work', id_prefix: 'unit' },
      decisions: {
        approve: { to: 'accepted' },
        revise: {
          to: 'proposed',
          requires_instruction: true,
          instruction_path: 'work_units.items.*.user_instruction',
          re_propose: true,
        },
        skip: { to: 'skipped' },
      },
      one_proposed_at_a_time: true,
      aggregate: {
        guard_field: 'work_units.all_terminal',
        terminal_statuses: ['accepted', 'skipped'],
      },
      stage: 'review_work',
      summary_path: 'summary.confirmation_loop',
      violation_path: 'work_units.confirmation_violation_json',
      pending_action_path: 'decisions.pending_review_work_action',
    }],
  };
  return {
    'program.slug': 'work-unit-flow-live',
    'intake.purpose': 'Plan exactly two work units and review them with confirmation.',
    'intake.entry_channel': 'user_text',
    'intake.completion_json': JSON.stringify(completion),
    'intake.interaction_json': JSON.stringify(interaction),
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
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
