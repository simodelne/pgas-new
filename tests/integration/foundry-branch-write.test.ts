import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { handlers } from '../../src/foundry-program/handlers.js';
import type { WiringManifest } from '../../src/pgas-new/wiring-manifest.js';

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

const existingRepoManifest: WiringManifest = {
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
  paths: {
    programs_dir: 'programs',
    audit_dir: 'audit',
    pgas_new_dir: '.pgas/pgas-new',
  },
  registration: { strategy: 'curator_request' },
  verification: {
    commands: {
      install: 'npm install --no-audit --no-fund',
      typecheck: 'npm run build',
      test: 'npm test',
    },
  },
  curator: {
    github_owner: 'simodelne',
    github_repo: 'fee-proposal',
  },
};

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

  it('writes every planned existing-repo stage artifact from the approved plan', { timeout: 120_000 }, async () => {
    const targetDir = mkdtempSync(join(tmpdir(), 'pgas-new-existing-branch-write-'));
    const stageList = [
      { slug: 'intake', is_bootstrap: true },
      { slug: 'scope_definition' },
      { slug: 'draft_assembly' },
      { slug: 'partner_review' },
      { slug: 'complete', is_terminal: true },
      { slug: 'blocked', is_terminal: true },
    ];
    const domain = {
      'program.slug': 'fee-proposal-drafter',
      'program.name': 'Fee Proposal Drafter',
      'program.target_dir': targetDir,
      'intake.purpose': 'Draft fee proposals through scoped assembly and partner review.',
      'intake.entry_channel': 'user_text',
      'inputs.user_decision.instruction': [
        'Preserve projection.ts, export/html.ts, export/docx.ts, specs.yml, contracts.ts.',
        'Also preserve stages/scope_definition.ts, handlers.ts, handlers/index.ts, handlers/_resolver.ts, tools.ts, and .pgas/wiring.yml.',
      ].join(' '),
      'intake.stages_json': JSON.stringify(stageList),
      'intake.transitions_json': JSON.stringify([
        { from: 'intake', to: 'scope_definition', trigger: 'started', guard_field: 'intake.started' },
        { from: 'scope_definition', to: 'draft_assembly', trigger: 'scoped', guard_field: 'scope_definition.ready' },
        { from: 'draft_assembly', to: 'partner_review', trigger: 'drafted', guard_field: 'draft_assembly.ready' },
        { from: 'partner_review', to: 'complete', trigger: 'approved', guard_field: 'partner_review.approved' },
        { from: 'scope_definition', to: 'blocked', trigger: 'blocked', guard_field: 'scope_definition.blocked' },
      ]),
      'intake.delegation_json': JSON.stringify({}),
      'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'partner_review.done' }),
      'repo.target_kind': 'existing_repo',
      'repo.wiring_manifest_json': JSON.stringify(existingRepoManifest),
    };

    try {
      const coveragePath = join(targetDir, 'qc/e2e-coverage.yml');
      mkdirSync(join(targetDir, 'qc'), { recursive: true });
      writeFileSync(coveragePath, [
        'version: 1',
        'user_facing_programs:',
        '  - review',
        'programs:',
        '  review:',
        '    facts: qc/facts/review.facts.yml',
        '    e2e-frontend:',
        '      channels: [frontend]',
        '      required: true',
        '',
      ].join('\n'));

      await handlers.synthesize_program_spec({ sessionId: 'existing-branch-write-session', domain });
      const planned = await handlers.plan_artifacts({ sessionId: 'existing-branch-write-session', domain }) as Array<{ path: string; kind: string }>;
      (domain as Record<string, unknown>)['artifact_plan.artifacts'] = planned;
      const plannedPaths = planned.map((artifact) => artifact.path);
      const plannedStagePaths = planned
        .filter((artifact) => artifact.kind === 'stage')
        .map((artifact) => artifact.path);

      await handlers.synthesize_domain_logic({
        sessionId: 'existing-branch-write-session',
        domain,
        cache_dir: join(targetDir, '.domain-synthesis-cache'),
        __domain_synthesis_generator: async (request: { stage: string }) => stageBodyFor(request.stage),
      });

      const result = await handlers.write_scaffold_artifacts({ sessionId: 'existing-branch-write-session', domain }) as {
        generated_paths: string[];
      };
      const writtenPaths = result.generated_paths;

      expect(plannedStagePaths).toEqual([
        'programs/fee-proposal-drafter/stages/intake.ts',
        'programs/fee-proposal-drafter/stages/scope_definition.ts',
        'programs/fee-proposal-drafter/stages/draft_assembly.ts',
        'programs/fee-proposal-drafter/stages/partner_review.ts',
        'programs/fee-proposal-drafter/stages/complete.ts',
        'programs/fee-proposal-drafter/stages/blocked.ts',
      ]);
      expect(plannedPaths).toContain('tests/generated-program-smoke.test.ts');
      expect(plannedPaths).toContain('tests/live-provider.test.ts');
      expect(plannedPaths.filter((path) => [
        '.pgas/wiring.yml',
        'projection.ts',
        'export/html.ts',
        'export/docx.ts',
        'specs.yml',
        'contracts.ts',
        'stages/scope_definition.ts',
        'handlers.ts',
        'handlers/index.ts',
        'handlers/_resolver.ts',
        'tools.ts',
      ].includes(path))).toEqual([]);
      expect(plannedPaths.filter((path) => path === 'programs/fee-proposal-drafter/projection.ts')).toHaveLength(1);
      expect(writtenPaths).toEqual(plannedPaths);
      expect(plannedPaths.filter((path) => !writtenPaths.includes(path))).toEqual([]);

      for (const path of plannedStagePaths) {
        expect(existsSync(join(targetDir, path)), `${path} should be written`).toBe(true);
        expect(readFileSync(join(targetDir, path), 'utf8')).toContain('runStage');
      }

      const smokeTestPath = join(targetDir, 'tests/generated-program-smoke.test.ts');
      const smokeTest = readFileSync(smokeTestPath, 'utf8');
      expect(smokeTest).toContain("from '../programs/fee-proposal-drafter/registration.js'");
      expect(smokeTest).not.toContain('../src/programs/fee-proposal-drafter/registration.js');
      expect(existsSync(join(targetDir, 'programs/fee-proposal-drafter/registration.ts'))).toBe(true);
      expect(readFileSync(join(targetDir, 'tests/live-provider.test.ts'), 'utf8')).toContain(
        'fee-proposal-drafter live-provider graduation',
      );

      const coverage = load(readFileSync(coveragePath, 'utf8')) as {
        user_facing_programs: string[];
        programs: Record<string, { facts?: string; 'e2e-frontend'?: { channels?: string[]; required?: boolean } }>;
      };
      expect(coverage.user_facing_programs).toEqual(expect.arrayContaining(['review', 'fee-proposal-drafter']));
      expect(coverage.programs.review.facts).toBe('qc/facts/review.facts.yml');
      expect(coverage.programs['fee-proposal-drafter']).toEqual({
        facts: 'qc/facts/fee-proposal-drafter.facts.yml',
        'e2e-frontend': {
          channels: ['frontend'],
          required: true,
        },
      });
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it('keeps branch_write strict for genuinely planned artifacts that were not written', { timeout: 120_000 }, async () => {
    const targetDir = mkdtempSync(join(tmpdir(), 'pgas-new-existing-branch-write-missing-'));
    const domain = {
      'program.slug': 'fee-proposal-drafter',
      'program.name': 'Fee Proposal Drafter',
      'program.target_dir': targetDir,
      'intake.purpose': 'Draft fee proposals through scoped assembly and partner review.',
      'intake.entry_channel': 'user_text',
      'intake.stages_json': JSON.stringify(stages),
      'intake.transitions_json': JSON.stringify(transitions),
      'intake.delegation_json': JSON.stringify({}),
      'intake.completion_json': JSON.stringify({ final_stage: 'resolved', guard_field: 'triage.summary_ready' }),
      'repo.target_kind': 'existing_repo',
      'repo.wiring_manifest_json': JSON.stringify(existingRepoManifest),
    };

    try {
      await handlers.synthesize_program_spec({ sessionId: 'existing-branch-write-missing-session', domain });
      const planned = await handlers.plan_artifacts({ sessionId: 'existing-branch-write-missing-session', domain }) as Array<{ path: string; kind: string }>;
      (domain as Record<string, unknown>)['artifact_plan.artifacts'] = [
        ...planned,
        {
          kind: 'metadata',
          path: 'programs/fee-proposal-drafter/unwritten.ts',
        },
      ];
      await handlers.synthesize_domain_logic({
        sessionId: 'existing-branch-write-missing-session',
        domain,
        cache_dir: join(targetDir, '.domain-synthesis-cache'),
        __domain_synthesis_body: synthesizedTriageBody,
      });

      await expect(
        handlers.write_scaffold_artifacts({ sessionId: 'existing-branch-write-missing-session', domain }),
      ).rejects.toThrow(/branch_write did not write planned artifacts:\nprograms\/fee-proposal-drafter\/unwritten\.ts/);
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

function stageBodyFor(stage: string): string {
  return `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  return {
    result_json: JSON.stringify({ stage: input.stage, status: ${JSON.stringify(`${stage}-ready`)}, at: runtime.now() }),
    items_json: JSON.stringify([${JSON.stringify(`${stage}:ready`)}]),
    digest: '',
  };
}
`;
}
