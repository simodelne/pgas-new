import { describe, expect, it } from 'vitest';
import { sanitizedVerificationEnv, VERIFICATION_ENV_DENYLIST } from '../../src/pgas-new/verification-env.js';

// Regression coverage for the security-critical env sanitizer. sanitizedVerificationEnv
// strips foundry provider/credential env before spawning generated-scaffold verification
// subprocesses, so a synthesized program can never observe the foundry's own API keys,
// provider base URL, model selection, or live-mode switches. These tests lock:
//   (1) every denylist key is removed,
//   (2) ordinary env is preserved verbatim,
//   (3) the input object is never mutated (a fresh copy is returned).

describe('sanitizedVerificationEnv', () => {
  it('strips denylisted provider/credential keys while preserving ordinary env', () => {
    const base = {
      PATH: '/usr/bin',
      HOME: '/home/simone',
      NODE_ENV: 'test',
      PGAS_OPENAI_API_KEY: 'secret-provider-key',
      OPENAI_API_KEY: 'sk-live-openai',
      ANTHROPIC_API_KEY: 'sk-ant-live',
      GOOGLE_API_KEY: 'goog-live',
      GEMINI_API_KEY: 'gem-live',
      PGAS_OPENAI_BASE_URL: 'http://provider.local/v1',
      PGAS_MODEL: 'qwen36-27b',
      PGAS_LIVE_SYNTH: '1',
      PGAS_LIVE_GRADUATION: '1',
    };

    const out = sanitizedVerificationEnv(base);

    // ordinary, non-sensitive env is passed through untouched
    expect(out.PATH).toBe('/usr/bin');
    expect(out.HOME).toBe('/home/simone');
    expect(out.NODE_ENV).toBe('test');

    // every sensitive key is gone
    for (const key of [
      'PGAS_OPENAI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY',
      'GEMINI_API_KEY', 'PGAS_OPENAI_BASE_URL', 'PGAS_MODEL', 'PGAS_LIVE_SYNTH', 'PGAS_LIVE_GRADUATION',
    ]) {
      expect(out[key], `${key} must be stripped from verification env`).toBeUndefined();
    }
  });

  it('removes every key in the denylist (full-list coverage)', () => {
    const base: Record<string, string> = { KEEP_ME: 'yes' };
    for (const key of VERIFICATION_ENV_DENYLIST) base[key] = `value-of-${key}`;

    const out = sanitizedVerificationEnv(base);

    for (const key of VERIFICATION_ENV_DENYLIST) {
      expect(out[key], `${key} must not survive sanitization`).toBeUndefined();
    }
    expect(out.KEEP_ME).toBe('yes');
  });

  it('does not mutate the caller-supplied base env and returns a fresh object', () => {
    const base: Record<string, string> = { KEEP_ME: 'yes', PGAS_OPENAI_API_KEY: 'secret' };
    const snapshot = { ...base };

    const out = sanitizedVerificationEnv(base);

    // returned object is a distinct copy
    expect(out).not.toBe(base);
    // input is untouched — the secret is still present on the original
    expect(base).toEqual(snapshot);
    expect(base.PGAS_OPENAI_API_KEY).toBe('secret');
  });
});
