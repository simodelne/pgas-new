import { createTestHarness } from '@simodelne/pgas-server/testing.js';
import { describe, expect, it } from 'vitest';
import { createPgasNewFoundryProgramEntry } from '../../src/foundry-program/registration.js';

function effect(name: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    actions: [
      {
        kind: 'EffectAction',
        name,
        channel: 'widget_output',
        payload,
      },
    ],
  };
}

describe('foundry intake tool-call protocol guidance', () => {
  it('instructs intake_intelligence to use one terminal tool call and accepts record_program_target args', async () => {
    const requiredPromptClauses = [
      'calling the declared tools as tool calls',
      'NOT by emitting raw JSON mutations',
      'Make exactly ONE terminal tool call',
      '{slug, name, target_dir}',
      'One tool call per round',
    ];
    let missingPromptClauses: string[] = [];

    const harness = await createTestHarness(createPgasNewFoundryProgramEntry(), {
      programName: 'pgas-new',
      defaultChannel: 'user_text',
      author: ({ prompt }) => {
        missingPromptClauses = requiredPromptClauses.filter((clause) => !prompt.includes(clause));

        return effect('record_program_target', {
          slug: 'foo',
          name: 'Foo',
          target_dir: '/tmp/foo',
        });
      },
    });

    try {
      await harness.trigger('Create a PGAS program named Foo in /tmp/foo.');
      const snapshot = await harness.snapshot();

      expect(missingPromptClauses).toEqual([]);
      expect(snapshot.domain['program.slug']).toBe('foo');
      expect(snapshot.domain['program.name']).toBe('Foo');
      expect(snapshot.domain['program.target_dir']).toBe('/tmp/foo');
      expect(snapshot.domain['program.target_dir_confirmed']).toBe(true);
    } finally {
      await harness.close();
    }
  });
});
