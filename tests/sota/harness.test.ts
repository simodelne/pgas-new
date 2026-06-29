import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSotaCorpus, requireLiveSynthConfig } from './harness.js';

describe('SOTA corpus harness', () => {
  it('loads a governed corpus with dev and holdout benchmarks across required archetypes', async () => {
    const corpus = await loadSotaCorpus();

    expect(corpus).toHaveLength(6);
    expect(corpus.map((benchmark) => benchmark.slug)).toEqual([
      'ambiguous-policy-refusal',
      'brief-summarizer',
      'crm-mock-lookup',
      'fee-calculator',
      'proposal-ops-stateful',
      'risk-router',
    ]);
    expect(corpus.some((benchmark) => benchmark.meta.holdout)).toBe(true);
    expect(corpus.some((benchmark) => !benchmark.meta.holdout)).toBe(true);

    const archetypes = new Set(corpus.flatMap((benchmark) => benchmark.meta.archetype_tags));
    expect(archetypes).toEqual(new Set([
      'adversarial-negative',
      'external-adapter',
      'in-memory-mock',
      'llm-reasoning',
      'multi-stage',
      'pure-compute',
    ]));

    for (const benchmark of corpus) {
      expect(benchmark.meta.repair_budget).toBe(4);
      expect(benchmark.inputs.length, `${benchmark.slug} should have inputs`).toBeGreaterThan(0);
      expect(benchmark.meta.expected_topology.stages.at(-1)).toBe(benchmark.meta.expected_topology.final_stage);
      expect(benchmark.mandate['intake.completion_json']).toContain(benchmark.meta.expected_topology.final_stage);
    }
  });

  it('fails loudly when live synthesis is requested without provider env', () => {
    expect(() => requireLiveSynthConfig({
      PGAS_LIVE_SYNTH: '1',
      PGAS_OPENAI_BASE_URL: undefined,
      PGAS_OPENAI_MODEL: 'qwen36-27b',
    })).toThrow(/PGAS_OPENAI_BASE_URL/u);

    expect(() => requireLiveSynthConfig({
      PGAS_LIVE_SYNTH: undefined,
      PGAS_OPENAI_BASE_URL: 'http://provider.local/v1',
      PGAS_OPENAI_MODEL: 'qwen36-27b',
    })).toThrow(/PGAS_LIVE_SYNTH=1/u);
  });

  it('runs a benchmark from a checked-in replay cache without calling the provider', async () => {
    const outDir = mkdtempSync(join(process.cwd(), 'tests/sota/generated/unit-replay-'));
    try {
      const [benchmark] = (await loadSotaCorpus()).filter((item) => item.slug === 'fee-calculator');
      expect(benchmark).toBeDefined();

      const { runBenchmark } = await import('./score.js');
      const result = await runBenchmark(benchmark, {
        cacheDir: join(process.cwd(), 'tests/sota/fixtures/body-cache/fee-calculator'),
        model: 'sota-replay-model',
        providerUrl: 'http://sota-replay.local/v1',
        outputDir: outDir,
        generator: async () => {
          throw new Error('provider must not be called during replay');
        },
      });

      expect(result.passed).toBe(true);
      expect(result.failure_taxonomy).toBeNull();
      expect(result.gates.typecheck.status).toBe('pass');
      expect(result.gates.smoke.status).toBe('pass');
      expect(result.gates.behavioral.status).toBe('pass');
      expect(result.gates.functional_oracle.status).toBe('pass');
      expect(result.stage_attempts).toEqual({ calculate_fee: 0 });
      expect(result.cache_hits).toEqual({ calculate_fee: true });
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 120_000);
});
