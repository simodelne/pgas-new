import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli.js';
import { PGAS_NEW_SESSION_CONTROLS } from '../../src/pgas-new/control-plane.js';

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

describe('pgas-new CLI', () => {
  it('prints version contract information', async () => {
    const result = await runCli(['version']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('@simodelne/pgas-server@2.8.3');
  });

  it('maps session commands to generated control-plane controls', async () => {
    for (const control of PGAS_NEW_SESSION_CONTROLS) {
      await expect(runCli(['session', control])).resolves.toMatchObject({
        stdout: expect.stringContaining(`control:${control}`),
      });
    }
  });

  it('plans standalone artifacts without writing files', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pgas-new-cli-plan-'));
    try {
      const result = await runCli(['plan-standalone', '--slug', 'pgas-new', '--name', 'PGAS New']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('src/programs/pgas-new/specs.yml');
      expect(readDirSafe(outDir)).toEqual([]);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('renders standalone artifacts only on explicit render command', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pgas-new-cli-render-'));
    try {
      const result = await runCli(['render-standalone', '--slug', 'pgas-new', '--name', 'PGAS New', '--out', outDir]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('written');
      expect(readFileSync(join(outDir, 'src/programs/pgas-new/specs.yml'), 'utf8')).toContain('control_plane:');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('rejects unsafe slugs before rendering files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pgas-new-cli-unsafe-'));
    const outDir = join(root, 'out');
    try {
      const result = await runCli([
        'render-standalone',
        '--slug',
        '../../../../pgas-new-escape',
        '--name',
        'PGAS New',
        '--out',
        outDir,
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('invalid --slug');
      expect(readDirSafe(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('validates manifests and plans existing repo attachment without writes', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'pgas-new-cli-attach-'));
    try {
      mkdirSync(join(repo, '.pgas'), { recursive: true });
      writeFileSync(join(repo, '.pgas/wiring.yml'), VALID_MANIFEST);

      const validate = await runCli(['validate-manifest', '--repo', repo]);
      expect(validate).toMatchObject({ exitCode: 0 });

      const plan = await runCli(['plan-attach', '--repo', repo, '--slug', 'review', '--name', 'Review']);
      expect(plan.exitCode).toBe(0);
      expect(plan.stdout).toContain('programs/review/specs.yml');
      expect(readDirSafe(join(repo, 'programs'))).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('returns curator request text when attachment manifest is missing', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'pgas-new-cli-curator-'));
    try {
      mkdirSync(join(repo, '.git'), { recursive: true });
      writeFileSync(join(repo, '.git/config'), '[remote "origin"]\n  url = git@github.com:simodelne/simoneos.git\n');
      const result = await runCli([
        'curator-request',
        '--repo',
        repo,
        '--slug',
        'review',
        '--name',
        'Review',
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('simodelne/simoneos');
      expect(result.stdout).toContain('No local writes were performed');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('keeps dots in GitHub repo names when deriving curator target from origin', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'pgas-new-cli-curator-dot-'));
    try {
      mkdirSync(join(repo, '.git'), { recursive: true });
      writeFileSync(join(repo, '.git/config'), '[remote "origin"]\n  url = https://github.com/simodelne/pgas.new.git\n');
      const result = await runCli([
        'curator-request',
        '--repo',
        repo,
        '--slug',
        'review',
        '--name',
        'Review',
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('simodelne/pgas.new');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

function readDirSafe(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}
