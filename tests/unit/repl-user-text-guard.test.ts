import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { modeAcceptsUserText } from '../../src/repl/runner.js';

// Regression lock for the live-UAT bug (2026-07-13): the REPL fired a `user_text`
// trigger at modes that do not declare a `user_text` channel (only scaffold_plan
// was guarded, via #69). In repo_targeting that doomed trigger crashed the engine
// with a raw `Cannot read properties of undefined (reading 'replace')` TypeError,
// blocking the interactive path to branch_write. The fix guards user_text to modes
// whose spec actually declares the channel. This test pins modeAcceptsUserText AND
// ties it to the foundry spec so a future channel change fails here (forcing the
// guard's USER_TEXT_MODES set to be updated in lockstep).

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SPEC_PATH = resolve(ROOT, 'src/foundry-program/specs.yml');

interface FoundrySpec {
  modes: Record<string, { channels?: string[] }>;
}

const spec = load(readFileSync(SPEC_PATH, 'utf8')) as FoundrySpec;

describe('REPL user_text channel guard', () => {
  it('accepts user_text only for intake_intelligence (the design interview)', () => {
    expect(modeAcceptsUserText('intake_intelligence')).toBe(true);
    expect(modeAcceptsUserText('repo_targeting')).toBe(false);
    expect(modeAcceptsUserText('architecture_design')).toBe(false);
    expect(modeAcceptsUserText('domain_synthesis')).toBe(false);
    expect(modeAcceptsUserText('branch_write')).toBe(false);
  });

  it('treats a null mode (no session yet) as not-a-user_text-mode so the guard leaves the first message to start intake', () => {
    // The dispatch guard only blocks when `state.mode !== null`; a null mode must
    // NOT be reported as accepting user_text here (the caller special-cases null).
    expect(modeAcceptsUserText(null)).toBe(false);
  });

  it('matches the foundry spec exactly: guard true iff the mode declares a user_text channel', () => {
    for (const [mode, def] of Object.entries(spec.modes)) {
      const declaresUserText = (def.channels ?? []).includes('user_text');
      expect(
        modeAcceptsUserText(mode),
        `If this fails: mode '${mode}' user_text channel changed in specs.yml — update USER_TEXT_MODES in src/repl/runner.ts to match, or the REPL will fire (or block) user_text against the wrong modes and reopen the repo_targeting crash.`,
      ).toBe(declaresUserText);
    }
  });
});
