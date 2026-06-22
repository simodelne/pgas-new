import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handlers } from '../../src/foundry-program/handlers.js';

const stages = [
  { slug: 'intake', is_bootstrap: true },
  { slug: 'triage' },
  { slug: 'resolved', is_terminal: true },
];

const transitions = [
  { from: 'intake', to: 'triage', trigger: 'ready', guard_field: 'intake.started' },
  { from: 'triage', to: 'resolved', trigger: 'summary_ready', guard_field: 'triage.summary_ready' },
];

describe('foundry branch_write', () => {
  it('writes the synthesized standalone scaffold to disk', async () => {
    const targetDir = mkdtempSync(join(tmpdir(), 'pgas-new-branch-write-'));
    const domain = {
      'program.slug': 'incident-triage',
      'program.name': 'Incident Triage',
      'program.target_dir': targetDir,
      'intake.purpose': 'Route incoming incidents into a triage workflow.',
      'intake.entry_channel': 'user_text',
      'intake.stages_json': JSON.stringify(stages),
      'intake.transitions_json': JSON.stringify(transitions),
      'intake.delegation_json': JSON.stringify({}),
      'intake.completion_json': JSON.stringify({ final_stage: 'resolved', guard_field: 'triage.summary_ready' }),
      'repo.target_kind': 'standalone_repo',
    };

    try {
      await handlers.synthesize_program_spec({ sessionId: 'branch-write-session', domain });

      const result = await handlers.write_scaffold_artifacts({ sessionId: 'branch-write-session', domain });

      expect(result).toMatchObject({
        kind: 'artifacts_written',
        target: 'standalone_repo',
        generated_paths: expect.arrayContaining([
          'package.json',
          'tsconfig.json',
          'src/server.ts',
          'src/programs/incident-triage/specs.yml',
          'src/programs/incident-triage/handlers/index.ts',
          'src/programs/incident-triage/handlers/_resolver.ts',
          'src/programs/incident-triage/tools.ts',
          'src/programs/incident-triage/registration.ts',
          'src/repl/index.ts',
          'tests/spec-load.test.ts',
          'tests/api-blackbox.test.ts',
          'tests/live-provider.test.ts',
          'tests/program-deterministic.test.ts',
        ]),
      });

      for (const path of [
        'package.json',
        'tsconfig.json',
        'src/server.ts',
        'src/programs/incident-triage/specs.yml',
        'src/programs/incident-triage/handlers/index.ts',
        'src/programs/incident-triage/handlers/_resolver.ts',
        'src/programs/incident-triage/tools.ts',
        'src/programs/incident-triage/registration.ts',
        'src/repl/index.ts',
        'tests/spec-load.test.ts',
        'tests/api-blackbox.test.ts',
        'tests/live-provider.test.ts',
        'tests/program-deterministic.test.ts',
      ]) {
        expect(existsSync(join(targetDir, path)), `${path} should be written`).toBe(true);
      }

      expect(readFileSync(join(targetDir, 'src/programs/incident-triage/specs.yml'), 'utf8')).toContain(
        'Program: Incident Triage.',
      );

      if (process.env.NPM_TOKEN) {
        execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: targetDir, stdio: 'pipe' });
        execFileSync('npm', ['run', 'typecheck'], { cwd: targetDir, stdio: 'pipe' });
      }
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it('fails clearly when branch_write transit state is missing', async () => {
    await expect(
      handlers.write_scaffold_artifacts({
        sessionId: 'missing-branch-write-session',
        domain: {
          'program.slug': 'incident-triage',
          'program.name': 'Incident Triage',
          'program.target_dir': '/tmp/incident-triage',
        },
      }),
    ).rejects.toThrow(/synthesized spec not in transit for session missing-branch-write-session; re-run synthesize_program_spec/);
  });
});
