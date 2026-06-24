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
  it('prints root help for --help and help', async () => {
    await expect(runCli(['--help'])).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining('pgas-new commands:'),
    });
    await expect(runCli(['help'])).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining('render-standalone'),
    });
  });

  it('prints version contract information', async () => {
    const result = await runCli(['version']);
    const flagResult = await runCli(['--version']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('@simodelne/pgas-server@2.13.5');
    expect(flagResult.exitCode).toBe(0);
    expect(flagResult.stdout).toContain('@simodelne/pgas-server@2.13.5');
  });

  it('defaults engine OpenAI tool choice to required when no override is configured', () => {
    expect(process.env.PGAS_OPENAI_TOOL_CHOICE).toBe('required');
  });

  it('maps session commands to generated control-plane controls and points users to the REPL', async () => {
    for (const control of PGAS_NEW_SESSION_CONTROLS) {
      const result = await runCli(['session', control]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`control: ${control}`);
      expect(result.stdout).toContain('npm run repl');
      expect(result.stdout).toContain(`/${control}`);
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

  it('rejects removed consumer templates and points users at the bare REPL', async () => {
    for (const template of ['policy-drafting', 'web-scraper', 'social-media-agent']) {
      const outDir = mkdtempSync(join(tmpdir(), `pgas-new-cli-removed-${template}-`));
      try {
        const result = await runCli([
          'render-standalone',
          '--slug',
          template,
          '--name',
          template,
          '--out',
          outDir,
          '--template',
          template,
        ]);

        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain(`invalid --template: ${template}`);
        expect(result.stderr).toContain('only pgas-new-foundry is supported');
        expect(result.stderr).toContain('bare `pgas-new` REPL');
        expect(readDirSafe(outDir)).toEqual([]);
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    }
  });

  it('lists only the foundry template in help', async () => {
    const result = await runCli(['help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('pgas-new-foundry');
    expect(result.stdout).not.toContain('policy-drafting');
    expect(result.stdout).not.toContain('web-scraper');
    expect(result.stdout).not.toContain('social-media-agent');
    expect(result.stdout).not.toContain('pgas-new-foundry (deprecated)');
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

  it('renders existing repo attachment artifacts only on explicit render command', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'pgas-new-cli-render-attach-'));
    try {
      mkdirSync(join(repo, '.pgas'), { recursive: true });
      writeFileSync(join(repo, '.pgas/wiring.yml'), VALID_MANIFEST);

      const result = await runCli([
        'render-attach',
        '--repo',
        repo,
        '--slug',
        'draft-policy',
        '--name',
        'Draft Policy',
        '--mandate',
        'risk-based policy drafting with outline approval before section-by-section drafting and Word plus HTML output stubs',
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('written');
      expect(result.stdout).toContain('programs/draft-policy/specs.yml');
      expect(readFileSync(join(repo, 'programs/draft-policy/specs.yml'), 'utf8')).toContain('Program: PGAS New');
      expect(readFileSync(join(repo, '.pgas/pgas-new/draft-policy/artifacts.json'), 'utf8')).toContain(
        'programs/draft-policy/specs.yml',
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('refuses render-attach when the manifest is missing or planned files already exist', async () => {
    const missingRepo = mkdtempSync(join(tmpdir(), 'pgas-new-cli-render-attach-missing-'));
    const collisionRepo = mkdtempSync(join(tmpdir(), 'pgas-new-cli-render-attach-collision-'));
    try {
      const missing = await runCli(['render-attach', '--repo', missingRepo, '--slug', 'review', '--name', 'Review']);
      expect(missing).toMatchObject({ exitCode: 1, stderr: expect.stringContaining('missing .pgas/wiring.yml') });
      expect(readDirSafe(missingRepo)).toEqual([]);

      mkdirSync(join(collisionRepo, '.pgas'), { recursive: true });
      mkdirSync(join(collisionRepo, 'programs/review'), { recursive: true });
      writeFileSync(join(collisionRepo, '.pgas/wiring.yml'), VALID_MANIFEST);
      writeFileSync(join(collisionRepo, 'programs/review/specs.yml'), 'existing');

      const collision = await runCli(['render-attach', '--repo', collisionRepo, '--slug', 'review', '--name', 'Review']);
      expect(collision.exitCode).toBe(1);
      expect(collision.stderr).toContain('refusing to overwrite existing attach artifacts');
      expect(readFileSync(join(collisionRepo, 'programs/review/specs.yml'), 'utf8')).toBe('existing');
      expect(readDirSafe(join(collisionRepo, '.pgas/pgas-new'))).toEqual([]);
    } finally {
      rmSync(missingRepo, { recursive: true, force: true });
      rmSync(collisionRepo, { recursive: true, force: true });
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}
