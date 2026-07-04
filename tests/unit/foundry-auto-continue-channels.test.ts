import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { AUTO_CONTINUE_ACTIONS } from '../../src/foundry-program/registration.js';

// Regression guard for the 2026-07-03 live-UAT a/b/c stall.
//
// The engine (@simodelne/pgas-server, verified on both 2.16.0 and 3.1.0)
// publishes the `notice_emitted` bus event — the ONLY source of the
// `system_mode_entry` `auto_continuation` trigger — exclusively for
// EffectActions whose channel is `widget_output` and whose payload carries an
// auto-continue intent. The foundry marks that intent for every action in
// AUTO_CONTINUE_ACTIONS (registration.ts exposeAutoContinueIntentInTerminalPayload),
// but the marker is dead weight if the action's declared channel is anything
// other than widget_output: the round completes, the mode transitions, and no
// continuation ever arrives, so the session stalls forever at the next
// system_mode_entry-driven mode.
//
// That exact stall shipped when domain_synthesis was wired (2026-06-28,
// 8524dad1): synthesize_domain_logic was added to AUTO_CONTINUE_ACTIONS with
// `channel: domain_synthesis_output`, so live sessions froze at
// domain_synthesis -> branch_write (UAT scenarios a/b/c, 9/9 failing attempts
// stalled after synthesize_domain_logic on 2026-07-03). The deterministic
// integration tests did not catch it because they send system_mode_entry
// triggers manually instead of relying on bus continuation.
describe('foundry auto-continue channel invariant', () => {
  const specPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../src/foundry-program/specs.yml',
  );
  const spec = parse(readFileSync(specPath, 'utf8')) as {
    action_map: Record<string, { channel?: string }>;
  };

  it('declares every AUTO_CONTINUE_ACTIONS member in the spec action_map', () => {
    for (const action of AUTO_CONTINUE_ACTIONS) {
      expect(spec.action_map[action], `action_map entry missing for ${action}`).toBeDefined();
    }
  });

  it('routes every AUTO_CONTINUE_ACTIONS member through widget_output', () => {
    for (const action of AUTO_CONTINUE_ACTIONS) {
      expect(
        spec.action_map[action]?.channel,
        `${action} is in AUTO_CONTINUE_ACTIONS but does not emit on widget_output; ` +
          'the engine will never publish notice_emitted for it and the session ' +
          'will stall at the next mode entry',
      ).toBe('widget_output');
    }
  });
});
