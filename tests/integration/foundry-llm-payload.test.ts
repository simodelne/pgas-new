import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPgasServer, type PgasServer } from '@simodelne/pgas-server/create-server.js';
import { createPgasNewFoundryProgramEntry } from '../../src/foundry-program/registration.js';

describe('foundry LLM provider payload', () => {
  const originalProvider = process.env.PGAS_PROVIDER;
  const originalOpenAiBaseUrl = process.env.PGAS_OPENAI_BASE_URL;
  const originalOpenAiApiKey = process.env.PGAS_OPENAI_API_KEY;
  const originalOpenAiModel = process.env.PGAS_OPENAI_MODEL;
  const originalDisableThinking = process.env.PGAS_OPENAI_DISABLE_THINKING;
  const originalDisableJsonResponseFormat = process.env.PGAS_OPENAI_DISABLE_JSON_RESPONSE_FORMAT;
  const originalFetch = globalThis.fetch;

  let server: PgasServer | null = null;
  let providerRequests: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    delete process.env.PGAS_OPENAI_DISABLE_JSON_RESPONSE_FORMAT;
    process.env.PGAS_PROVIDER = 'openai';
    process.env.PGAS_OPENAI_BASE_URL = 'http://provider.local/v1';
    process.env.PGAS_OPENAI_API_KEY = 'local';
    process.env.PGAS_OPENAI_MODEL = 'qwen36-27b';
    process.env.PGAS_OPENAI_DISABLE_THINKING = '1';
    providerRequests = [];
    globalThis.fetch = providerFetchStub(providerRequests);
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    globalThis.fetch = originalFetch;

    restoreEnv('PGAS_PROVIDER', originalProvider);
    restoreEnv('PGAS_OPENAI_BASE_URL', originalOpenAiBaseUrl);
    restoreEnv('PGAS_OPENAI_API_KEY', originalOpenAiApiKey);
    restoreEnv('PGAS_OPENAI_MODEL', originalOpenAiModel);
    restoreEnv('PGAS_OPENAI_DISABLE_THINKING', originalDisableThinking);
    restoreEnv('PGAS_OPENAI_DISABLE_JSON_RESPONSE_FORMAT', originalDisableJsonResponseFormat);
  });

  it('leaves OpenAI-compatible request payload formatting to the engine provider', async () => {
    server = await createPgasServer({
      programs: [{ name: 'pgas-new', entry: createPgasNewFoundryProgramEntry() }],
      devMode: true,
      telemetry: { enabled: false },
      port: 0,
    });

    const created = await fetchJson<{ sessionId: string }>(server, '/sessions', {
      method: 'POST',
      body: JSON.stringify({ program: 'pgas-new' }),
    });
    await fetchJson(server, `/sessions/${created.sessionId}/trigger`, {
      method: 'POST',
      body: JSON.stringify({
        channel: 'user_text',
        payload: 'Create a PGAS program named Payload Probe in /tmp/payload-probe.',
      }),
    });

    expect(providerRequests.length).toBeGreaterThan(0);
    const [payload] = providerRequests;
    expect(payload).toMatchObject({
      model: 'qwen36-27b',
    });
  });
});

function providerFetchStub(requests: Array<Record<string, unknown>>): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.method !== 'POST' || request.url !== 'http://provider.local/v1/chat/completions') {
      return new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }

    const payload = await request.json() as Record<string, unknown>;
    requests.push(payload);
    return new Response(JSON.stringify({
      id: 'chatcmpl-payload-probe',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'qwen36-27b',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_record_target',
                type: 'function',
                function: {
                  name: 'record_program_target',
                  arguments: JSON.stringify({
                    slug: 'payload-probe',
                    name: 'Payload Probe',
                    target_dir: '/tmp/payload-probe',
                  }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

async function fetchJson<T>(server: PgasServer, path: string, init?: RequestInit): Promise<T> {
  const response = await server.app.fetch(new Request(`http://local${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
    },
  }));
  const body = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) {
    throw new Error(`request failed ${String(response.status)}: ${JSON.stringify(body)}`);
  }
  return body as T;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
