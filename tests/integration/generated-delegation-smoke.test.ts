import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { synthesizeProgramSpecFromDomain, type SynthesizedSpec } from '../../src/foundry-program/synthesizer.js';
import type { SynthesizedArtifact } from '../../src/foundry-program/synthesizer-store.js';
import { renderStandaloneScaffold, type RenderStandaloneOptions } from '../../src/pgas-new/template-renderer.js';

const delegationDescriptor = {
  stages: {
    dispatch_research: { kind: 'llm-reasoning', reasoning_per_turn: true },
  },
  children: [
    {
      id: 'research',
      stage: 'dispatch_research',
      synthesize_child: {
        kind: 'worker',
        purpose: 'Handle delegated research work and echo the seeded topic.',
        result_fields: {
          summary: 'string',
          seeded_topic: 'string',
        },
      },
      payload_map: {
        'request.topic': 'inputs.initial_user_text',
        'domain_context.original_request': 'inputs.initial_user_text',
      },
      result_path: 'dispatch_research.delegation.research.result',
      max_delegated_rounds: 12,
      round_timeout_ms: 5000,
      optional: true,
    },
  ],
};

const delegationDomain = {
  'program.slug': 'delegation-parent-hermetic',
  'program.name': 'Delegation Parent Hermetic',
  'program.target_dir': '/tmp/delegation-parent-hermetic',
  'program.design_path': 'design',
  'intake.purpose': 'Dispatch one delegated child worker and complete after the result settles.',
  'intake.entry_channel': 'user_text',
  'intake.stages_json': JSON.stringify([
    { slug: 'intake', is_bootstrap: true },
    { slug: 'dispatch_research' },
    { slug: 'complete', is_terminal: true },
  ]),
  'intake.transitions_json': JSON.stringify([
    { from: 'intake', to: 'dispatch_research', trigger: 'started', guard_field: 'intake.started' },
    { from: 'dispatch_research', to: 'complete', trigger: 'done', guard_field: 'dispatch_research.ready' },
  ]),
  'intake.delegation_json': JSON.stringify(delegationDescriptor),
  'intake.completion_json': JSON.stringify({
    final_stage: 'complete',
    guard_field: 'dispatch_research.ready',
  }),
};

describe('generated delegation smoke test', () => {
  it('boots synthesized parent and worker child through the route and proves settled result echo', { timeout: 120_000 }, () => {
    const artifact = artifactFromDomain(delegationDomain);
    const delegationArtifact = artifact as SynthesizedArtifact & DelegationArtifactExtension;
    const childArtifacts = delegationArtifact.child_artifacts ?? [];
    expect(childArtifacts).toHaveLength(1);

    const targetDir = mkdtempSync(join(tmpdir(), 'pgas-new-delegation-render-'));

    try {
      renderStandaloneScaffold({
        slug: 'delegation-parent-hermetic',
        name: 'Delegation Parent Hermetic',
        outDir: targetDir,
        synthesizedSpecYaml: artifact.spec_yaml,
        synthesizedRegistrationTs: delegationArtifact.registration_ts,
        synthesizedContractsTs: artifact.contracts_ts,
        synthesizedHandlersTs: artifact.handlers_ts,
        synthesizedHandlersIndexTs: artifact.handlers_index_ts,
        synthesizedStageSources: artifact.stage_sources,
        synthesizedToolsTs: artifact.tools_ts,
        synthesizedSmokeTestTs: artifact.smoke_test_ts,
        synthesizedChildArtifacts: childArtifacts,
      } as RenderStandaloneOptions & DelegationRenderOptions);
      linkRootNodeModules(targetDir);

      const serverSource = readFileSync(join(targetDir, 'src/server.ts'), 'utf8');
      expect(serverSource).toContain('createDelegationParentHermeticProgramEntry');
      expect(serverSource).toContain('createResearchProgramEntry');
      expect(serverSource).toContain("{ name: 'delegation-parent-hermetic'");
      expect(serverSource).toContain("{ name: 'research'");

      const parentRegistration = readFileSync(join(targetDir, 'src/programs/delegation-parent-hermetic/registration.ts'), 'utf8');
      expect(parentRegistration).toContain('delegationPolicy');
      expect(parentRegistration).toContain("allowedTargetPrograms: ['research']");
      expect(parentRegistration).toContain("source: 'inputs.initial_user_text'");

      const childRegistration = readFileSync(join(targetDir, 'src/programs/research/registration.ts'), 'utf8');
      expect(childRegistration).toContain('delegationResultPolicy');
      expect(childRegistration).toContain("path: 'work.result.seeded_topic'");

      expect(artifact.smoke_test_ts).toContain('runs synthesized delegation hermetically through the route');
      expect(artifact.smoke_test_ts).toContain("expect(result.seeded_topic).toBe('seeded delegation topic')");
      expect(artifact.smoke_test_ts).toContain("expect(degradeResult.status).toBe('failed')");
      expect(artifact.smoke_test_ts).not.toContain('createTestHarness');

      const output = runGeneratedSmokeTest(targetDir);
      expect(output).toContain('1 passed');
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});

interface DelegationArtifactExtension {
  registration_ts?: string;
  child_artifacts?: Array<SynthesizedSpec & {
    slug: string;
    name: string;
    registration_ts?: string;
    stage_sources?: Record<string, string>;
  }>;
}

interface DelegationRenderOptions {
  synthesizedRegistrationTs?: string;
  synthesizedChildArtifacts?: NonNullable<DelegationArtifactExtension['child_artifacts']>;
}

function artifactFromDomain(domain: Record<string, unknown>): SynthesizedArtifact {
  return {
    ...synthesizeProgramSpecFromDomain(domain),
    created_at: '2026-07-16T00:00:00.000Z',
  };
}

function linkRootNodeModules(targetDir: string): void {
  const rootNodeModules = join(process.cwd(), 'node_modules');
  if (!existsSync(rootNodeModules)) {
    return;
  }
  symlinkSync(rootNodeModules, join(targetDir, 'node_modules'), 'dir');
}

function runGeneratedSmokeTest(targetDir: string): string {
  const vitestBin = join(process.cwd(), 'node_modules/vitest/vitest.mjs');
  return execFileSync(process.execPath, [vitestBin, 'run', '--pool=threads', 'tests/generated-program-smoke.test.ts'], {
    cwd: targetDir,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', RAYON_NUM_THREADS: '1' },
  });
}
