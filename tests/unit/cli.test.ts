import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli.js';

const VALID_MANIFEST = `
schema_version: 1
repo:
  kind: existing_repo
  package_manager: npm
pgas:
  server_package: "@simodelne/pgas-server"
  allowed_imports:
    - "@simodelne/pgas-server/plugin.js"
paths:
  programs_dir: "programs"
  audit_dir: "audit"
  pgas_new_dir: ".pgas/pgas-new"
registration:
  strategy: curator_request
verification:
  commands:
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
    await expect(runCli(['session', 'new'])).resolves.toMatchObject({ stdout: expect.stringContaining('control:new') });
    await expect(runCli(['session', 'abort'])).resolves.toMatchObject({ stdout: expect.stringContaining('control:abort') });
    await expect(runCli(['session', 'status'])).resolves.toMatchObject({ stdout: expect.stringContaining('control:status') });
    await expect(runCli(['session', 'history'])).resolves.toMatchObject({ stdout: expect.stringContaining('control:history') });
    await expect(runCli(['session', 'resume'])).resolves.toMatchObject({ stdout: expect.stringContaining('control:resume') });
    await expect(runCli(['session', 'help'])).resolves.toMatchObject({ stdout: expect.stringContaining('control:help') });
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
      const result = await runCli([
        'curator-request',
        '--repo',
        repo,
        '--slug',
        'review',
        '--name',
        'Review',
        '--github-owner',
        'simodelne',
        '--github-repo',
        'simoneos',
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('simodelne/simoneos');
      expect(result.stdout).toContain('No local writes were performed');
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
