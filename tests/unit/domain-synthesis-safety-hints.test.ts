import { describe, expect, it } from 'vitest';
import { formatSafetyGateFailure } from '../../src/foundry-program/domain-synthesis.js';

// Track A (Fable driver investigation): raw scanSafety errors reach the stage-body
// repair prompt telling the model WHAT is wrong but not WHAT TO DO, so temp-0
// models re-emit the same violation class (observed wedge: require -> dynamic
// import -> identical retries). These assert the enrichment adds concrete guidance.
describe('formatSafetyGateFailure', () => {
  it('preserves the raw error and steers the digest/import wedge to the self-contained shape', () => {
    for (const raw of ['banned capability: require', 'banned capability: dynamic import', 'banned import: node:crypto']) {
      const enriched = formatSafetyGateFailure(raw);
      expect(enriched).toContain(raw);
      // the concrete, actionable steer that unblocks the digest-fixation wedge
      expect(enriched.toLowerCase()).toContain('only allowed import is the type-only');
      expect(enriched.toLowerCase()).toContain('digest');
      expect(enriched).toContain("`digest: ''`");
    }
  });

  it('gives targeted guidance for other banned capabilities', () => {
    expect(formatSafetyGateFailure('banned capability: fetch').toLowerCase()).toContain('network i/o');
    expect(formatSafetyGateFailure('banned capability: process.env secret read')).toContain('input.domain');
    expect(formatSafetyGateFailure('banned capability: Function constructor').toLowerCase()).toContain('eval');
  });

  it('falls back to a general self-contained hint for unrecognized safety errors', () => {
    const enriched = formatSafetyGateFailure('banned capability: something-new');
    expect(enriched).toContain('banned capability: something-new');
    expect(enriched.toLowerCase()).toContain('self-contained');
  });
});
