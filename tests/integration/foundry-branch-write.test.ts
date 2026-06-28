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

const synthesizedTriageBody = `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  return {
    result_json: JSON.stringify({ stage: input.stage, status: 'triaged', at: runtime.now() }),
    items_json: JSON.stringify(['triaged']),
    digest: '',
  };
}
`;

describe('foundry branch_write', () => {
  it('writes the synthesized standalone scaffold to disk', { timeout: 120_000 }, async () => {
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
      await handlers.synthesize_domain_logic({
        sessionId: 'branch-write-session',
        domain,
        cache_dir: join(targetDir, '.domain-synthesis-cache'),
        __domain_synthesis_body: synthesizedTriageBody,
      });

      const result = await handlers.write_scaffold_artifacts({ sessionId: 'branch-write-session', domain });

      expect(result).toMatchObject({
        kind: 'artifacts_written',
        target: 'standalone_repo',
        generated_paths: expect.arrayContaining([
          'package.json',
          'tsconfig.json',
          'src/server.ts',
          'src/programs/incident-triage/specs.yml',
          'src/programs/incident-triage/contracts.ts',
          'src/programs/incident-triage/handlers/index.ts',
          'src/programs/incident-triage/handlers/_resolver.ts',
          'src/programs/incident-triage/stages/triage.ts',
          'src/programs/incident-triage/tools.ts',
          'src/programs/incident-triage/registration.ts',
          'src/repl/index.ts',
          'tests/spec-load.test.ts',
          'tests/generated-program-smoke.test.ts',
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
        'src/programs/incident-triage/contracts.ts',
        'src/programs/incident-triage/handlers/index.ts',
        'src/programs/incident-triage/handlers/_resolver.ts',
        'src/programs/incident-triage/stages/triage.ts',
        'src/programs/incident-triage/tools.ts',
        'src/programs/incident-triage/registration.ts',
        'src/repl/index.ts',
        'tests/spec-load.test.ts',
        'tests/generated-program-smoke.test.ts',
        'tests/api-blackbox.test.ts',
        'tests/live-provider.test.ts',
        'tests/program-deterministic.test.ts',
      ]) {
        expect(existsSync(join(targetDir, path)), `${path} should be written`).toBe(true);
      }

      expect(readFileSync(join(targetDir, 'src/programs/incident-triage/specs.yml'), 'utf8')).toContain(
        'Program: Incident Triage.',
      );
      const handlersRoot = readFileSync(join(targetDir, 'src/programs/incident-triage/handlers.ts'), 'utf8');
      const handlersIndex = readFileSync(join(targetDir, 'src/programs/incident-triage/handlers/index.ts'), 'utf8');
      const contracts = readFileSync(join(targetDir, 'src/programs/incident-triage/contracts.ts'), 'utf8');
      const stageBody = readFileSync(join(targetDir, 'src/programs/incident-triage/stages/triage.ts'), 'utf8');
      const smokeTest = readFileSync(join(targetDir, 'tests/generated-program-smoke.test.ts'), 'utf8');
      const tools = readFileSync(join(targetDir, 'src/programs/incident-triage/tools.ts'), 'utf8');

      expect(handlersRoot).toContain('async complete_triage(payload)');
      expect(handlersRoot).toContain("import { createStageRuntime, normalizeStageOutput, resolveStageInput } from './contracts.js';");
      expect(handlersRoot).toContain("import { runStage as runTriage } from './stages/triage.js';");
      expect(handlersRoot).toContain('return normalizeStageOutput(output, \'triage\', \'pure-compute\', undefined);');
      expect(handlersRoot).not.toContain('stage_action_stub');
      expect(handlersRoot).not.toContain('TODO: implement the triage stage');
      expect(handlersRoot).not.toContain('example_action');
      expect(handlersIndex).toContain('async complete_triage(payload)');
      expect(handlersIndex).toContain("import { createStageRuntime, normalizeStageOutput, resolveStageInput } from '../contracts.js';");
      expect(handlersIndex).toContain("import { runStage as runTriage } from '../stages/triage.js';");
      expect(handlersIndex).not.toContain('example_action');
      expect(contracts).toContain('StageRuntime');
      expect(stageBody).toContain('status: \'triaged\'');
      expect(smokeTest).toContain('generated program smoke');
      expect(tools).toContain('stageActionTools');
      expect(tools).toContain('complete_triage');
      expect(tools).toContain("mode: 'triage'");
      expect(tools).toContain("target: 'resolved'");
      expect(tools).toContain("output_path: 'triage.output'");
      expect(tools).toContain("'triage.summary_ready'");

      if (process.env.NPM_TOKEN) {
        const env = { ...process.env, npm_config_cache: join(targetDir, '.npm-cache') };
        execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: targetDir, env, stdio: 'pipe' });
        execFileSync('npm', ['run', 'typecheck'], { cwd: targetDir, env, stdio: 'pipe' });
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
