import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFoundryServer, type StartedFoundryServer } from '../../src/foundry-server.js';

const canOpenLoopbackListener = await canBindLoopbackListener();

describe('foundry proxy wire path', () => {
  const originalProvider = process.env.PGAS_PROVIDER;
  const originalEnableMockProvider = process.env.PGAS_ENABLE_MOCK_PROVIDER;
  const originalOpenAiBaseUrl = process.env.PGAS_OPENAI_BASE_URL;
  const originalOpenAiApiKey = process.env.PGAS_OPENAI_API_KEY;
  const originalOpenAiModel = process.env.PGAS_OPENAI_MODEL;
  const originalModel = process.env.PGAS_MODEL;
  const originalDisableThinking = process.env.PGAS_OPENAI_DISABLE_THINKING;
  const originalDisableJsonResponseFormat = process.env.PGAS_OPENAI_DISABLE_JSON_RESPONSE_FORMAT;
  let foundryServer: StartedFoundryServer | null = null;
  let upstreamServer: FakeVllmServer | null = null;

  beforeEach(() => {
    process.env.PGAS_PROVIDER = 'openai';
    delete process.env.PGAS_ENABLE_MOCK_PROVIDER;
    process.env.PGAS_OPENAI_API_KEY = 'local';
    process.env.PGAS_OPENAI_MODEL = 'qwen36-27b';
    process.env.PGAS_OPENAI_DISABLE_THINKING = '1';
    delete process.env.PGAS_OPENAI_DISABLE_JSON_RESPONSE_FORMAT;
  });

  afterEach(async () => {
    if (foundryServer) {
      await foundryServer.kill();
      foundryServer = null;
    }
    if (upstreamServer) {
      await upstreamServer.close();
      upstreamServer = null;
    }
    restoreEnv('PGAS_PROVIDER', originalProvider);
    restoreEnv('PGAS_ENABLE_MOCK_PROVIDER', originalEnableMockProvider);
    restoreEnv('PGAS_OPENAI_BASE_URL', originalOpenAiBaseUrl);
    restoreEnv('PGAS_OPENAI_API_KEY', originalOpenAiApiKey);
    restoreEnv('PGAS_OPENAI_MODEL', originalOpenAiModel);
    restoreEnv('PGAS_MODEL', originalModel);
    restoreEnv('PGAS_OPENAI_DISABLE_THINKING', originalDisableThinking);
    restoreEnv('PGAS_OPENAI_DISABLE_JSON_RESPONSE_FORMAT', originalDisableJsonResponseFormat);
  });

  (canOpenLoopbackListener ? it : it.skip)('sends an engine LLM call through the proxy with required tool_choice', async () => {
    upstreamServer = await startFakeVllmServer();
    process.env.PGAS_OPENAI_BASE_URL = upstreamServer.url;

    foundryServer = await startFoundryServer({ port: 0 });
    const proxyUrl = process.env.PGAS_OPENAI_BASE_URL;

    expect(proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/u);
    expect(proxyUrl).not.toBe(upstreamServer.url);

    const created = await fetchJson<{ sessionId: string }>(`${foundryServer.url}/sessions`, {
      method: 'POST',
      body: JSON.stringify({ program: 'pgas-new' }),
    });
    await fetchJson(`${foundryServer.url}/sessions/${created.sessionId}/trigger`, {
      method: 'POST',
      body: JSON.stringify({
        channel: 'user_text',
        payload: 'Create a PGAS program named Wire Probe in /tmp/wire-probe.',
      }),
    });

    expect(upstreamServer.requests.length).toBeGreaterThan(0);
    expect(upstreamServer.requests).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: '/v1/chat/completions',
        body: expect.objectContaining({
          model: 'qwen36-27b',
          tools: expect.arrayContaining([
            expect.objectContaining({
              type: 'function',
              function: expect.objectContaining({ name: 'record_program_target' }),
            }),
          ]),
          tool_choice: 'required',
        }),
      }),
    ]);
  });

  (canOpenLoopbackListener ? it : it.skip)('preserves OpenAI tool_call type in retry conversation history', async () => {
    upstreamServer = await startFakeVllmServer(['record_q1_purpose', 'record_program_target']);
    process.env.PGAS_OPENAI_BASE_URL = upstreamServer.url;

    foundryServer = await startFoundryServer({ port: 0 });
    const created = await fetchJson<{ sessionId: string }>(`${foundryServer.url}/sessions`, {
      method: 'POST',
      body: JSON.stringify({ program: 'pgas-new' }),
    });
    await fetchJson(`${foundryServer.url}/sessions/${created.sessionId}/trigger`, {
      method: 'POST',
      body: JSON.stringify({
        channel: 'user_text',
        payload: 'Create a PGAS program named Retry Probe in /tmp/retry-probe.',
      }),
    });

    const retryRequest = upstreamServer.requests.find((request) => {
      const messages = request.body.messages;
      return Array.isArray(messages) && messages.some((message) => (
        isRecord(message) && Array.isArray(message.tool_calls)
      ));
    });
    expect(retryRequest).toBeDefined();
    const retryMessages = retryRequest?.body.messages;
    const assistantMessage = Array.isArray(retryMessages)
      ? retryMessages.find((message) => isRecord(message) && Array.isArray(message.tool_calls))
      : undefined;

    expect(assistantMessage).toMatchObject({
      tool_calls: [
        expect.objectContaining({
          id: expect.any(String),
          type: 'function',
          function: expect.objectContaining({ name: 'record_q1_purpose' }),
        }),
      ],
    });
  });
});

interface CapturedRequest {
  method?: string;
  path?: string;
  body: Record<string, unknown>;
}

interface FakeVllmServer {
  url: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

async function startFakeVllmServer(toolNames: string[] = ['record_program_target']): Promise<FakeVllmServer> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const requestNumber = requests.length;
      requests.push({
        method: request.method,
        path: request.url,
        body: text.length > 0 ? JSON.parse(text) as Record<string, unknown> : {},
      });
      const toolName = toolNames[Math.min(requestNumber, toolNames.length - 1)] ?? 'record_program_target';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'chatcmpl-wire-probe',
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
                    name: toolName,
                    arguments: JSON.stringify(toolArguments(toolName)),
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
      }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake vLLM did not bind to a TCP port');
  }

  return {
    url: `http://127.0.0.1:${String(address.port)}/v1`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
  };
}

function toolArguments(toolName: string): Record<string, unknown> {
  if (toolName === 'record_q1_purpose') {
    return { purpose: 'Retry probe purpose before target capture.' };
  }
  return {
    slug: 'wire-probe',
    name: 'Wire Probe',
    target_dir: '/tmp/wire-probe',
  };
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init?.headers,
    },
  });
  const body = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) {
    throw new Error(`request failed ${String(response.status)}: ${JSON.stringify(body)}`);
  }
  return body as T;
}

async function canBindLoopbackListener(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => {
      resolve(false);
    });
    probe.listen(0, '127.0.0.1', () => {
      probe.close(() => {
        resolve(true);
      });
    });
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
