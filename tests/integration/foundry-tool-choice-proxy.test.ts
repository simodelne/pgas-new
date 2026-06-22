import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startFoundryServer, type StartedFoundryServer } from '../../src/foundry-server.js';

const canOpenLoopbackListener = await canBindLoopbackListener();

describe('foundry tool-choice proxy integration', () => {
  const originalProvider = process.env.PGAS_PROVIDER;
  const originalEnableMockProvider = process.env.PGAS_ENABLE_MOCK_PROVIDER;
  const originalOpenAiBaseUrl = process.env.PGAS_OPENAI_BASE_URL;
  const originalProxyDebug = process.env.PGAS_FOUNDRY_PROXY_DEBUG;
  let foundryServer: StartedFoundryServer | null = null;
  let upstreamServer: { url: string; close(): Promise<void> } | null = null;

  beforeEach(() => {
    process.env.PGAS_PROVIDER = 'mock';
    process.env.PGAS_ENABLE_MOCK_PROVIDER = '1';
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
    restoreEnv('PGAS_FOUNDRY_PROXY_DEBUG', originalProxyDebug);
    vi.restoreAllMocks();
  });

  (canOpenLoopbackListener ? it : it.skip)('routes foundry OpenAI base URL through a proxy that sends required tool_choice upstream', async () => {
    const capturedBodies: Array<Record<string, unknown>> = [];
    upstreamServer = await startEchoUpstream(capturedBodies);
    process.env.PGAS_OPENAI_BASE_URL = upstreamServer.url;

    foundryServer = await startFoundryServer({ port: 0 });
    const proxyUrl = process.env.PGAS_OPENAI_BASE_URL;

    expect(proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/u);
    const response = await fetch(`${proxyUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen36-27b',
        messages: [{ role: 'user', content: 'Pick a tool.' }],
        tools: [{ type: 'function', function: { name: 'record_program_target', parameters: { type: 'object' } } }],
        tool_choice: 'auto',
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(capturedBodies).toEqual([
      expect.objectContaining({
        model: 'qwen36-27b',
        tool_choice: 'required',
      }),
    ]);
  });

  (canOpenLoopbackListener ? it : it.skip)('keeps PGAS_OPENAI_BASE_URL on the proxy and logs a direct proxy hit when debug is enabled', async () => {
    const capturedBodies: Array<Record<string, unknown>> = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    upstreamServer = await startEchoUpstream(capturedBodies);
    process.env.PGAS_FOUNDRY_PROXY_DEBUG = '1';
    process.env.PGAS_OPENAI_BASE_URL = upstreamServer.url;

    foundryServer = await startFoundryServer({ port: 0 });
    const proxyUrl = process.env.PGAS_OPENAI_BASE_URL;

    expect(proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/u);
    expect(proxyUrl).not.toBe(upstreamServer.url);
    await fetch(`${proxyUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen36-27b',
        messages: [{ role: 'user', content: 'Pick a tool.' }],
        tools: [{ type: 'function', function: { name: 'record_program_target', parameters: { type: 'object' } } }],
      }),
    });

    const output = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output).toContain('[proxy] POST /v1/chat/completions');
    expect(output).toContain('[proxy] ->');
    expect(capturedBodies).toEqual([
      expect.objectContaining({ tool_choice: 'required' }),
    ]);
  });
});

async function startEchoUpstream(capturedBodies: Array<Record<string, unknown>>): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      capturedBodies.push(text.length > 0 ? JSON.parse(text) as Record<string, unknown> : {});
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
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
    throw new Error('upstream did not bind to a TCP port');
  }

  return {
    url: `http://127.0.0.1:${String(address.port)}/v1`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
  };
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
