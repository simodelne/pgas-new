import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { synthesizeDomainLogic } from '../../src/foundry-program/domain-synthesis.js';
import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import type { StageArchetype } from '../../src/foundry-program/stage-classifier.js';
import type { SynthesizedArtifact } from '../../src/foundry-program/synthesizer-store.js';
import { renderStandaloneScaffold } from '../../src/pgas-new/template-renderer.js';

const multiStageDomain = {
  'program.slug': 'proposal-ops',
  'program.name': 'Proposal Ops',
  'program.target_dir': '/tmp/proposal-ops',
  'program.design_path': 'design',
  'intake.purpose': 'Calculate proposal fees, lookup a CRM account, summarize the brief, and close the proposal workflow.',
  'intake.entry_channel': 'user_text',
  'intake.stages_json': JSON.stringify([
    { slug: 'intake', is_bootstrap: true },
    { slug: 'fee_modeling' },
    { slug: 'crm_lookup' },
    { slug: 'brief_summary' },
    { slug: 'complete', is_terminal: true },
  ]),
  'intake.transitions_json': JSON.stringify([
    { from: 'intake', to: 'fee_modeling', trigger: 'started', guard_field: 'intake.started' },
    { from: 'fee_modeling', to: 'crm_lookup', trigger: 'modeled', guard_field: 'fee_modeling.ready' },
    { from: 'crm_lookup', to: 'brief_summary', trigger: 'looked_up', guard_field: 'crm_lookup.ready' },
    { from: 'brief_summary', to: 'complete', trigger: 'summarized', guard_field: 'brief_summary.done' },
  ]),
  'intake.delegation_json': JSON.stringify({
    crm_lookup: {
      service: 'crm',
      adapter: 'in-memory mock account lookup',
    },
  }),
  'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'brief_summary.done' }),
};

describe('generated multi-stage smoke test', () => {
  it('drives compute, external mock, and llm reasoning stages to the completion final stage', { timeout: 120_000 }, async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'pgas-new-multistage-cache-'));
    const artifact = await synthesizeDomainLogic(artifactFromDomain(multiStageDomain), {
      cacheDir,
      providerUrl: 'http://provider.local/v1',
      model: 'qwen36-27b',
      generator: async ({ stage, archetype }) => deterministicStageBody(stage, archetype),
    });
    const targetDir = mkdtempSync(join(tmpdir(), 'pgas-new-multistage-render-'));

    try {
      renderStandaloneScaffold({
        slug: 'proposal-ops',
        name: 'Proposal Ops',
        outDir: targetDir,
        synthesizedSpecYaml: artifact.spec_yaml,
        synthesizedContractsTs: artifact.contracts_ts,
        synthesizedHandlersTs: artifact.handlers_ts,
        synthesizedHandlersIndexTs: artifact.handlers_index_ts,
        synthesizedStageSources: artifact.stage_sources,
        synthesizedToolsTs: artifact.tools_ts,
        synthesizedSmokeTestTs: artifact.smoke_test_ts,
      });
      linkRootNodeModules(targetDir);

      expect(stageKinds(artifact)).toEqual([
        ['intake', 'pure-compute'],
        ['fee_modeling', 'pure-compute'],
        ['crm_lookup', 'external-adapter'],
        ['brief_summary', 'llm-reasoning'],
        ['complete', 'pure-compute'],
      ]);
      expect(artifact.smoke_test_ts).toContain("expect(snapshot.mode).toBe('complete')");
      expect(artifact.smoke_test_ts).toContain("expect(serialized).not.toContain('stage_action_stub')");
      expect(artifact.smoke_test_ts).toContain("expect(serialized).not.toContain('\"todo\"')");
      expect(artifact.smoke_test_ts).toContain("expect(serialized).toContain('in_memory_mock')");
      expect(artifact.domain_synthesis_audit).toEqual([
        expect.objectContaining({
          stage: 'fee_modeling',
          archetype: 'pure-compute',
          attempts: 1,
          cache_hit: false,
        }),
        expect.objectContaining({
          stage: 'crm_lookup',
          archetype: 'external-adapter',
          adapter_kind: 'in_memory_mock',
          attempts: 1,
          cache_hit: false,
        }),
      ]);
      expect(JSON.stringify(artifact.stage_sources).toLowerCase()).not.toContain('stage_action_stub');
      expect(JSON.stringify(artifact.stage_sources).toLowerCase()).not.toContain('"todo"');

      const output = runGeneratedSmokeTest(targetDir);
      expect(output).toContain('1 passed');
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});

function artifactFromDomain(domain: Record<string, unknown>): SynthesizedArtifact {
  return {
    ...synthesizeProgramSpecFromDomain(domain),
    created_at: '2026-06-28T00:00:00.000Z',
  };
}

function deterministicStageBody(stage: string, archetype: 'pure-compute' | 'external-adapter'): string {
  if (archetype === 'external-adapter') {
    return `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

// TODO(real-service-swap): replace this in-memory mock with the real service adapter.
export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  return {
    result_json: JSON.stringify({
      stage: input.stage,
      status: 'mocked',
      adapter_kind: 'in_memory_mock',
      account_id: String(input.domain['account.id'] ?? 'acct-demo'),
      observed_at: runtime.now()
    }),
    items_json: JSON.stringify(['crm-account:acct-demo']),
    digest: '',
    adapter_kind: 'in_memory_mock',
  };
}
`;
  }

  assertPureCompute(archetype);
  return `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  const baseFee = 12000;
  const complexity = Math.round(runtime.random() * 100);
  return {
    result_json: JSON.stringify({
      stage: input.stage,
      status: 'modeled',
      base_fee_usd: baseFee,
      complexity,
      recommended_fee_usd: baseFee + complexity,
      summary_ready: true,
      modeled_at: runtime.now()
    }),
    items_json: JSON.stringify(['fee-model:12000', 'complexity:' + complexity]),
    digest: '',
  };
}
`;
}

function assertPureCompute(archetype: StageArchetype): asserts archetype is 'pure-compute' {
  expect(archetype).toBe('pure-compute');
}

function stageKinds(artifact: SynthesizedArtifact): Array<[string, string]> {
  return artifact.stage_classification.map((stage) => {
    const record = stage as { slug: string; archetype: string };
    return [record.slug, record.archetype];
  });
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
  return execFileSync(process.execPath, [vitestBin, 'run', 'tests/generated-program-smoke.test.ts'], {
    cwd: targetDir,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
  });
}
