import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startFoundryServer } from '../../src/foundry-server.js';
import { runCli } from '../../src/cli.js';
import { runRepl } from '../../src/repl/runner.js';

vi.mock('../../src/foundry-server.js', () => ({
  startFoundryServer: vi.fn(),
}));

vi.mock('../../src/repl/runner.js', () => ({
  runRepl: vi.fn(),
}));

const VALID_MANIFEST = `
schema_version: 1
repo:
  kind: existing_repo
  package_manager: npm
pgas:
  server_package: "@simodelne/pgas-server"
  allowed_imports:
    - "@simodelne/pgas-server/plugin.js"
    - "@simodelne/pgas-server/create-server.js"
    - "@simodelne/pgas-server/client.js"
    - "@simodelne/pgas-server/channels/index.js"
    - "@simodelne/pgas-server/routes/index.js"
paths:
  programs_dir: "programs"
  audit_dir: "audit"
  pgas_new_dir: ".pgas/pgas-new"
registration:
  strategy: curator_request
verification:
  commands:
    install: "npm install --no-audit --no-fund"
    typecheck: "npm run typecheck"
    test: "npm test"
curator:
  github_owner: simodelne
  github_repo: simoneos
`;

describe('pgas-new interactive CLI classifier', () => {
  const startFoundryServerMock = vi.mocked(startFoundryServer);
  const runReplMock = vi.mocked(runRepl);
  let kill: () => Promise<void>;
  let killMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    killMock = vi.fn().mockResolvedValue(undefined);
    kill = killMock as unknown as () => Promise<void>;
    startFoundryServerMock.mockResolvedValue({ url: 'http://foundry.test', kill });
    runReplMock.mockResolvedValue({
      reason: 'user_exit',
      sessionId: null,
      finalMode: null,
      exitCode: 0,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('starts the foundry REPL for bare entry', async () => {
    const result = await runCli([]);

    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(startFoundryServerMock).toHaveBeenCalledOnce();
    expect(runReplMock).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'http://foundry.test', slug: 'pgas-new' }),
    );
    expect(killMock).toHaveBeenCalledOnce();
  });

  it('starts the REPL with --slug pre-seeded as program.slug', async () => {
    await runCli(['--slug', 'only-slug']);

    expect(runReplMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialDomain: expect.objectContaining({
          'program.slug': 'only-slug',
          'program.name': 'Only Slug',
        }),
      }),
    );
  });

  it('starts the REPL with --out pre-seeded as program.target_dir', async () => {
    await runCli(['--out', '/tmp/pgas-new-target']);

    expect(runReplMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialDomain: expect.objectContaining({
          'program.target_dir': '/tmp/pgas-new-target',
        }),
      }),
    );
  });

  it('runs the REPL for --non-interactive without TTY assumptions', async () => {
    const result = await runCli(['--non-interactive']);

    expect(result.exitCode).toBe(0);
    expect(startFoundryServerMock).toHaveBeenCalledOnce();
    expect(runReplMock).toHaveBeenCalledWith(expect.objectContaining({ nonInteractive: true }));
  });

  it('keeps unknown non-flag commands on the existing unknown-command surface', async () => {
    const result = await runCli(['not-a-command']);

    expect(result).toEqual({ exitCode: 2, stdout: '', stderr: 'unknown command: not-a-command' });
    expect(startFoundryServerMock).not.toHaveBeenCalled();
    expect(runReplMock).not.toHaveBeenCalled();
  });

  it('keeps existing subcommands on the legacy path', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'pgas-new-cli-interactive-legacy-'));
    const outDir = mkdtempSync(join(tmpdir(), 'pgas-new-cli-interactive-render-'));
    try {
      mkdirSync(join(repo, '.pgas'), { recursive: true });
      writeFileSync(join(repo, '.pgas/wiring.yml'), VALID_MANIFEST);
      mkdirSync(join(repo, '.git'), { recursive: true });
      writeFileSync(join(repo, '.git/config'), '[remote "origin"]\n  url = git@github.com:simodelne/simoneos.git\n');

      const cases: string[][] = [
        ['help'],
        ['version'],
        ['session', 'status'],
        ['plan-standalone', '--slug', 'legacy-plan', '--name', 'Legacy Plan'],
        ['render-standalone', '--slug', 'legacy-render', '--name', 'Legacy Render', '--out', outDir],
        ['validate-manifest', '--repo', repo],
        ['plan-attach', '--repo', repo, '--slug', 'legacy-attach-plan', '--name', 'Legacy Attach Plan'],
        ['render-attach', '--repo', repo, '--slug', 'legacy-attach-render', '--name', 'Legacy Attach Render'],
        ['curator-request', '--repo', repo, '--slug', 'legacy-curator', '--name', 'Legacy Curator'],
      ];

      for (const argv of cases) {
        const result = await runCli(argv);
        expect(result.exitCode, argv.join(' ')).toBe(0);
      }

      expect(startFoundryServerMock).not.toHaveBeenCalled();
      expect(runReplMock).not.toHaveBeenCalled();
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
