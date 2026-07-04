import { createTestHarness } from '@simodelne/pgas-server/testing.js';
import { describe, expect, it } from 'vitest';
import { createPgasNewFoundryProgramEntry } from '../../src/foundry-program/registration.js';

/**
 * #68 regression: a native tool call whose arguments carry a trailing-whitespace
 * key (`"message "`) must not ride that malformed key through the gates into the
 * terminal payload. The engine's parse/type/structural gates accept it verbatim;
 * the foundry normalizes the effect payload keys before the terminal payload is
 * built, so the canonical key (`message`) is what appears downstream.
 */
describe('#68 trailing-whitespace argument keys do not reach the terminal payload', () => {
  it('normalizes a padded key on record_program_target', async () => {
    const harness = await createTestHarness(createPgasNewFoundryProgramEntry(), {
      programName: 'pgas-new',
      defaultChannel: 'user_text',
      author: () => ({
        actions: [
          {
            kind: 'EffectAction',
            name: 'record_program_target',
            channel: 'widget_output',
            payload: {
              slug: 'foo',
              name: 'Foo',
              target_dir: '/tmp/foo',
              'message ': 'trailing space key',
            },
          },
        ],
      }),
    });

    try {
      const terminal = (await harness.trigger(
        'Create a PGAS program named Foo in /tmp/foo.',
      )) as { payload?: Record<string, unknown> };

      const payload = terminal.payload ?? {};
      expect(payload).not.toHaveProperty('message ');
      expect(payload.message).toBe('trailing space key');
      expect(payload.slug).toBe('foo');
    } finally {
      await harness.close();
    }
  });
});
