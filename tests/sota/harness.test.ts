import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadOracle, loadSotaCorpus, requireLiveSynthConfig } from './harness.js';

describe('SOTA corpus harness', () => {
  it('loads a governed corpus with dev and holdout benchmarks across required archetypes', async () => {
    const corpus = await loadSotaCorpus();

    expect(corpus).toHaveLength(13);
    expect(corpus.map((benchmark) => benchmark.slug)).toEqual([
      'ambiguous-policy-refusal',
      'brief-summarizer',
      'credit-memo-stateful',
      'crm-mock-lookup',
      'entitlement-seat-stateful',
      'fee-calculator',
      'proposal-ops-stateful',
      'refund-ledger-stateful',
      'release-note-extractor',
      'risk-router',
      'sla-policy-refusal',
      'usage-invoice-calculator',
      'warehouse-mock-reservation',
    ]);
    expect(corpus.filter((benchmark) => !benchmark.meta.holdout).map((benchmark) => benchmark.slug)).toEqual([
      'brief-summarizer',
      'crm-mock-lookup',
      'fee-calculator',
      'proposal-ops-stateful',
      'risk-router',
    ]);
    expect(corpus.filter((benchmark) => benchmark.meta.holdout).map((benchmark) => benchmark.slug)).toEqual([
      'ambiguous-policy-refusal',
      'credit-memo-stateful',
      'entitlement-seat-stateful',
      'refund-ledger-stateful',
      'release-note-extractor',
      'sla-policy-refusal',
      'usage-invoice-calculator',
      'warehouse-mock-reservation',
    ]);

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

  it('keeps risk-router visible and aligned to its canonical queue/item contract', async () => {
    const [benchmark] = (await loadSotaCorpus()).filter((item) => item.slug === 'risk-router');
    expect(benchmark).toBeDefined();
    expect(benchmark.meta.holdout).toBe(false);
    expect(benchmark.rubric).toContain('Canonical intent:');

    const stages = JSON.parse(String(benchmark.mandate['intake.stages_json'])) as Array<{
      slug: string;
      domain_spec?: {
        produces?: {
          items_json?: unknown;
        };
      };
    }>;
    expect(stages.find((stage) => stage.slug === 'score_risk')?.domain_spec?.produces?.items_json)
      .toEqual(['risk_score:<risk_score>', 'severity:<severity>']);
    expect(stages.find((stage) => stage.slug === 'route_queue')?.domain_spec?.produces?.items_json)
      .toEqual(['owner_queue:<owner_queue>', 'risk_score:<risk_score>']);

    const oracle = await loadOracle(benchmark);
    const [input] = benchmark.inputs.filter((item) => item.id === 'high-risk');
    expect(input).toBeDefined();
    const expected = oracle.expected(input);
    expect(expected.stages.score_risk.result.risk_score).toBe(100);
    expect(expected.stages.score_risk.items).toEqual(['risk_score:100', 'severity:high']);
    expect(expected.stages.route_queue.result.owner_queue).toBe('security_escalation');
    expect(expected.stages.route_queue.items).toEqual(['owner_queue:security_escalation', 'risk_score:100']);
    expect(() => oracle.assertOutput(input, expected)).not.toThrow();
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
    // tests/sota/generated/ is gitignored scratch and absent on a fresh checkout — ensure it
    // exists before mkdtemp (was passing locally only because prior runs left the dir behind).
    mkdirSync(join(process.cwd(), 'tests/sota/generated'), { recursive: true });
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

      expect(result.passed, JSON.stringify(result.gates)).toBe(true);
      expect(result.failure_taxonomy).toBeNull();
      expect(result.gates.typecheck.status).toBe('pass');
      expect(result.gates.smoke.status).toBe('pass');
      expect(result.gates.behavioral.status).toBe('pass');
      expect(result.gates.functional_oracle.status).toBe('pass');
      expect(result.stage_attempts).toEqual({ intake: 0, calculate_fee: 0 });
      expect(result.cache_hits).toEqual({ intake: true, calculate_fee: true });
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 120_000);
});
