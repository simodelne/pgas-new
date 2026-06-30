import { describe, expect, it } from 'vitest';
import { createScorecard, validateScorecard } from './score.js';

describe('SOTA scorecard schema', () => {
  it('validates aggregate and per-benchmark deterministic gate fields', () => {
    const scorecard = createScorecard({
      run_id: 'unit-schema',
      created_at: '2026-06-29T00:00:00.000Z',
      model_id: 'sota-replay-model',
      provider_url: 'http://sota-replay.local/v1',
      prompt_hash: 'a'.repeat(64),
      baseline_scorecard: 'tests/sota/scorecard/baseline-v3.5.0.json',
      results: [
        {
          slug: 'fee-calculator',
          holdout: false,
          archetype_tags: ['pure-compute'],
          passed: true,
          failure_taxonomy: null,
          gates: {
            typecheck: { status: 'pass', duration_ms: 1 },
            smoke: { status: 'pass', duration_ms: 1 },
            behavioral: { status: 'pass', duration_ms: 1 },
            functional_oracle: { status: 'pass', duration_ms: 1 },
          },
          attempts_total: 1,
          stage_attempts: { calculate_fee: 1 },
          cache_hits: { calculate_fee: false },
          latency_ms: 4,
          body_hashes: { calculate_fee: 'b'.repeat(64) },
          prompt_hash: 'c'.repeat(64),
          scorecard_path: null,
          advisory_judge: null,
        },
      ],
      baseline: null,
    });

    expect(validateScorecard(scorecard)).toEqual({ ok: true, errors: [] });
    expect(scorecard.aggregate).toMatchObject({
      total: 1,
      passed: 1,
      failed: 0,
      pass_at_1: 1,
      task_success_rate: 1,
      holdout: { total: 0, passed: 0, task_success_rate: 0 },
      dev: { total: 1, passed: 1, task_success_rate: 1 },
      failure_taxonomy: {},
    });
  });

  it('rejects malformed scorecards instead of silently publishing partial data', () => {
    const malformed = {
      schema_version: 1,
      aggregate: { total: 1 },
      benchmarks: [
        {
          slug: 'fee-calculator',
          gates: {
            typecheck: { status: 'pass' },
          },
        },
      ],
    };

    const validation = validateScorecard(malformed);
    expect(validation.ok).toBe(false);
    expect(validation.errors.join('\n')).toContain('model_id');
    expect(validation.errors.join('\n')).toContain('functional_oracle');
  });
});
