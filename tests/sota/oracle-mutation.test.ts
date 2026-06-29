import { describe, expect, it } from 'vitest';
import { loadOracle, loadSotaCorpus } from './harness.js';

describe('SOTA oracle integrity', () => {
  it('accepts each oracle expected output and rejects every declared mutation', async () => {
    const corpus = await loadSotaCorpus();

    for (const benchmark of corpus) {
      const oracle = await loadOracle(benchmark);
      for (const input of benchmark.inputs) {
        const expected = oracle.expected(input);
        expect(() => oracle.assertOutput(input, expected), `${benchmark.slug}/${input.id} expected output`).not.toThrow();

        const mutations = oracle.mutations(input, expected);
        expect(mutations.length, `${benchmark.slug}/${input.id} should declare mutations`).toBeGreaterThan(0);
        for (const [index, mutation] of mutations.entries()) {
          expect(
            () => oracle.assertOutput(input, mutation),
            `${benchmark.slug}/${input.id} mutation ${index} should be rejected`,
          ).toThrow();
        }
      }
    }
  });
});
