import { createPgasServer, type UnifiedAuthorDriverOptions } from '@simodelne/pgas-server/plugin.js';
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
      'ask_design_question',
      'question_number',
      'next round via inputs.user_text',
      '{slug, name, target_dir}',
      'One tool call per round',
    ];
    let missingPromptClauses: string[] = [];
    let capturedPrompt = '';

    const harness = await createTestHarness(createPgasNewFoundryProgramEntry(), {
      programName: 'pgas-new',
      defaultChannel: 'user_text',
      author: ({ prompt }) => {
        capturedPrompt = prompt;
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
      expect(capturedPrompt).not.toContain('plain natural-language text');
      expect(snapshot.domain['program.slug']).toBe('foo');
      expect(snapshot.domain['program.name']).toBe('Foo');
      expect(snapshot.domain['program.target_dir']).toBe('/tmp/foo');
      expect(snapshot.domain['program.target_dir_confirmed']).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('uses native tool_calls schemas without leaking from_arg into the prompt', async () => {
    const captured: {
      prompt?: string;
      toolNames: string[];
      targetTool?: Record<string, unknown>;
      questionTool?: Record<string, unknown>;
    } = {
      toolNames: [],
    };
    const server = await createUnifiedServer(async (messages, tools) => {
      captured.prompt = messages.map((message) => message.content ?? '').join('\n');
      captured.toolNames = tools.map((tool) => tool.function.name);
      captured.targetTool = tools.find((tool) => tool.function.name === 'record_program_target')?.function.parameters;
      captured.questionTool = tools.find((tool) => tool.function.name === 'ask_design_question')?.function.parameters;

      return {
        tool_calls: [{
          id: 'call_target',
          function: {
            name: 'record_program_target',
            arguments: JSON.stringify({
              slug: 'native-target',
              name: 'Native Target',
              target_dir: '/tmp/native-target',
            }),
          },
        }],
      };
    });

    try {
      const created = await fetchJson<{ sessionId: string }>(server, '/sessions', {
        method: 'POST',
        body: JSON.stringify({ program: 'pgas-new' }),
      });
      await fetchJson(server, `/sessions/${created.sessionId}/trigger`, {
        method: 'POST',
        body: JSON.stringify({
          channel: 'user_text',
          payload: 'Create a PGAS program named Native Target in /tmp/native-target.',
        }),
      });
      const world = await fetchJson<{ domain: Record<string, unknown> }>(server, `/sessions/${created.sessionId}/world`);

      expect(captured.prompt).not.toContain('from_arg');
      expect(captured.toolNames).toContain('record_program_target');
      expect(captured.toolNames).toContain('ask_design_question');
      expect(captured.questionTool).toMatchObject({
        type: 'object',
        properties: {
          question_number: expect.objectContaining({ type: 'number' }),
          question_text: expect.objectContaining({ type: 'string' }),
        },
        required: expect.arrayContaining(['question_number', 'question_text']),
      });
      expect(captured.questionTool?.required).not.toContain('message');
      expect(captured.targetTool).toMatchObject({
        type: 'object',
        properties: {
          slug: expect.objectContaining({ type: 'string' }),
          name: expect.objectContaining({ type: 'string' }),
          target_dir: expect.objectContaining({ type: 'string' }),
        },
        required: expect.arrayContaining(['slug', 'name', 'target_dir']),
      });
      expect(world.domain['program.slug']).toBe('native-target');
      expect(world.domain['program.name']).toBe('Native Target');
      expect(world.domain['program.target_dir']).toBe('/tmp/native-target');
    } finally {
      await server.close();
    }
  });

  it('fires ask_design_question from structured native tool_calls and records the last question', async () => {
    const questionText = 'Q1 Purpose -- what does the program do?';
    const server = await createUnifiedServer(async () => ({
      tool_calls: [{
        id: 'call_question',
        function: {
          name: 'ask_design_question',
          arguments: JSON.stringify({
            question_number: 1,
            question_text: questionText,
          }),
        },
      }],
    }));

    try {
      const created = await fetchJson<{ sessionId: string }>(server, '/sessions', {
        method: 'POST',
        body: JSON.stringify({ program: 'pgas-new' }),
      });
      const result = await fetchJson<{ result: { name?: string; payload?: unknown } }>(server, `/sessions/${created.sessionId}/trigger`, {
        method: 'POST',
        body: JSON.stringify({
          channel: 'user_text',
          payload: 'Ask the first design question.',
        }),
      });
      const world = await fetchJson<{ domain: Record<string, unknown> }>(server, `/sessions/${created.sessionId}/world`);

      expect(result.result).toMatchObject({
        name: 'ask_design_question',
        payload: {
          question_number: 1,
          question_text: questionText,
        },
      });
      expect(world.domain['intake.last_question_asked']).toBe(1);
      expect(world.domain['intake.last_question_text']).toBe(questionText);
    } finally {
      await server.close();
    }
  });

  it('does not accept legacy MutationAction content on the native tool-call path', async () => {
    const server = await createUnifiedServer(async () => ({
      content: JSON.stringify({
        actions: [
          { kind: 'MutationAction', name: 'record_program_target', op: 'MSet', path: 'program.slug', value: 'legacy-target' },
          { kind: 'MutationAction', name: 'record_program_target', op: 'MSet', path: 'program.name', value: 'Legacy Target' },
          { kind: 'MutationAction', name: 'record_program_target', op: 'MSet', path: 'program.target_dir', value: '/tmp/legacy-target' },
          { kind: 'MutationAction', name: 'record_program_target', op: 'MSet', path: 'program.target_dir_confirmed', value: true },
        ],
      }),
    }));

    try {
      const created = await fetchJson<{ sessionId: string }>(server, '/sessions', {
        method: 'POST',
        body: JSON.stringify({ program: 'pgas-new' }),
      });
      const result = await fetchJson<{ result: { name?: string; payload?: unknown } }>(server, `/sessions/${created.sessionId}/trigger`, {
        method: 'POST',
        body: JSON.stringify({
          channel: 'user_text',
          payload: 'Create a legacy-shaped PGAS program.',
        }),
      });
      const world = await fetchJson<{ domain: Record<string, unknown> }>(server, `/sessions/${created.sessionId}/world`);

      expect(result.result.name).toBe('__fallback__');
      expect(world.domain['program.slug']).toBeUndefined();
      expect(world.domain['program.target_dir_confirmed']).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});

type UnifiedComplete = UnifiedAuthorDriverOptions['complete'];

const throwingAuthorHandle = {
  modelId: 'native-tool-call-test',
  async complete() {
    throw new Error('legacy JSON author should not be used in native tool-call tests');
  },
};

const throwingObserverHandle = {
  modelId: 'native-tool-call-test',
  async complete() {
    return 'noop';
  },
};

async function createUnifiedServer(complete: UnifiedComplete) {
  return createPgasServer({
    programs: [{ name: 'pgas-new', entry: createPgasNewFoundryProgramEntry() }],
    drivers: {
      authorHandle: throwingAuthorHandle,
      observerHandle: throwingObserverHandle,
      authorMode: 'unified',
      unified: { complete },
    },
    devMode: true,
    telemetry: { enabled: false },
    port: 0,
  });
}

async function fetchJson<T = unknown>(server: Awaited<ReturnType<typeof createUnifiedServer>>, path: string, init?: RequestInit): Promise<T> {
  const response = await server.app.fetch(new Request(`http://local${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  }));
  const body = await response.json() as T;
  if (!response.ok) {
    throw new Error(`request failed ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}
