import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forwardToolChoiceProxyRequest } from '../../src/foundry-program/tool-choice-proxy.js';

describe('forwardToolChoiceProxyRequest', () => {
  const originalFetch = globalThis.fetch;
  let upstreamRequests: Array<Record<string, unknown>>;

  beforeEach(() => {
    upstreamRequests = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = init?.body;
      if (typeof body === 'string') {
        upstreamRequests.push(JSON.parse(body) as Record<string, unknown>);
      } else if (body instanceof ArrayBuffer) {
        upstreamRequests.push(JSON.parse(Buffer.from(body).toString('utf8')) as Record<string, unknown>);
      } else if (body instanceof Uint8Array) {
        upstreamRequests.push(JSON.parse(Buffer.from(body).toString('utf8')) as Record<string, unknown>);
      } else {
        upstreamRequests.push({});
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('injects required tool_choice into the upstream chat-completion request body when tools are present', async () => {
    const response = await forwardToolChoiceProxyRequest('http://provider.local/v1', new Request('http://127.0.0.1:9001/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer local',
      },
      body: JSON.stringify({
        model: 'qwen36-27b',
        messages: [{ role: 'user', content: 'Pick a tool.' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'record_program_target',
              parameters: { type: 'object' },
            },
          },
        ],
      }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(globalThis.fetch).toHaveBeenCalledWith(new URL('http://provider.local/v1/chat/completions'), expect.objectContaining({
      method: 'POST',
    }));
    expect(upstreamRequests).toEqual([
      expect.objectContaining({
        model: 'qwen36-27b',
        tool_choice: 'required',
      }),
    ]);
  });

  it('overrides engine auto tool_choice and leaves non-chat paths unchanged', async () => {
    await forwardToolChoiceProxyRequest('http://provider.local/v1', new Request('http://127.0.0.1:9001/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen36-27b',
        messages: [{ role: 'user', content: 'Pick a tool.' }],
        tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object' } } }],
        tool_choice: 'auto',
      }),
    }));
    await forwardToolChoiceProxyRequest('http://provider.local/v1', new Request('http://127.0.0.1:9001/v1/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen36-27b',
        tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object' } } }],
      }),
    }));

    expect(upstreamRequests).toEqual([
      expect.objectContaining({ tool_choice: 'required' }),
      expect.not.objectContaining({ tool_choice: 'required' }),
    ]);
  });
});
