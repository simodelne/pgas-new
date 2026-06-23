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

  it('forces approve_artifact_plan for scaffold-plan approval rounds', async () => {
    await forwardToolChoiceProxyRequest('http://provider.local/v1', new Request('http://127.0.0.1:9001/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen36-27b',
        messages: [
          {
            role: 'system',
            content: 'Mode scaffold_plan. inputs.user_decision.decision=approve artifact_plan.status=draft',
          },
        ],
        tools: [
          { type: 'function', function: { name: 'approve_artifact_plan', parameters: { type: 'object' } } },
          { type: 'function', function: { name: 'plan_artifacts', parameters: { type: 'object' } } },
        ],
        tool_choice: 'auto',
      }),
    }));

    expect(upstreamRequests).toEqual([
      expect.objectContaining({
        tool_choice: { type: 'function', function: { name: 'approve_artifact_plan' } },
      }),
    ]);
  });

  it('forces confirm_design for intake approval rounds', async () => {
    await forwardToolChoiceProxyRequest('http://provider.local/v1', new Request('http://127.0.0.1:9001/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen36-27b',
        messages: [
          {
            role: 'system',
            content: 'Mode intake_intelligence. inputs.user_decision.decision=approve intake.program_intake_finalized=true',
          },
        ],
        tools: [
          { type: 'function', function: { name: 'confirm_design', parameters: { type: 'object' } } },
          { type: 'function', function: { name: 'record_user_note', parameters: { type: 'object' } } },
        ],
        tool_choice: 'auto',
      }),
    }));

    expect(upstreamRequests).toEqual([
      expect.objectContaining({
        tool_choice: { type: 'function', function: { name: 'confirm_design' } },
      }),
    ]);
  });

  it('forces the named reject_design_and_revise_qN tool when a rejection names Q1-Q6', async () => {
    await forwardToolChoiceProxyRequest('http://provider.local/v1', new Request('http://127.0.0.1:9001/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen36-27b',
        messages: [
          {
            role: 'system',
            content: 'inputs.user_decision.decision=reject inputs.user_decision.instruction=please change Q3 stages',
          },
        ],
        tools: [
          { type: 'function', function: { name: 'reject_design_and_revise_q1', parameters: { type: 'object' } } },
          { type: 'function', function: { name: 'reject_design_and_revise_q3', parameters: { type: 'object' } } },
        ],
        tool_choice: 'auto',
      }),
    }));

    expect(upstreamRequests).toEqual([
      expect.objectContaining({
        tool_choice: { type: 'function', function: { name: 'reject_design_and_revise_q3' } },
      }),
    ]);
  });

  it('does not force a decision tool from static prompt guidance when current state has no user decision', async () => {
    await forwardToolChoiceProxyRequest('http://provider.local/v1', new Request('http://127.0.0.1:9001/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen36-27b',
        messages: [
          {
            role: 'system',
            content: [
              "If the user_confirmation decision is 'reject' and the instruction names Q1, call reject_design_and_revise_q1.",
              'Current state:',
              '{',
              '  "inputs.user_text": "Create a program."',
              '}',
            ].join('\n'),
          },
        ],
        tools: [
          { type: 'function', function: { name: 'record_program_target', parameters: { type: 'object' } } },
          { type: 'function', function: { name: 'reject_design_and_revise_q1', parameters: { type: 'object' } } },
        ],
        tool_choice: 'auto',
      }),
    }));

    expect(upstreamRequests).toEqual([
      expect.objectContaining({
        tool_choice: 'required',
      }),
    ]);
  });
});
