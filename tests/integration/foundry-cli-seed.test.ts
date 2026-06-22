import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import { appTransport, createPgasClient } from '@simodelne/pgas-server/client.js';
import { describe, expect, it } from 'vitest';
import { createPgasNewFoundryProgramEntry } from '../../src/foundry-program/registration.js';
import { createInitialStateSessionCreateFetch, createSessionWithInitialState } from '../../src/cli.js';

function effect(name: string, payload: Record<string, unknown>) {
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

describe('foundry CLI initial state seed', () => {
  it('rewrites REPL session creation so CLI seeds become PATCH /domain calls', async () => {
    const requests: Array<{ method: string; path: string; auth: string | null; body: unknown }> = [];
    const fakeFetch: typeof fetch = async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      const url = new URL(request.url);
      const body = await readJson(request);
      requests.push({
        method: request.method,
        path: url.pathname,
        auth: request.headers.get('authorization'),
        body,
      });

      if (request.method === 'POST' && url.pathname === '/sessions') {
        return json({ sessionId: 'session-1' }, 201);
      }
      if (request.method === 'PATCH' && url.pathname === '/sessions/session-1/domain') {
        return json({ applied: 4 });
      }
      return json({ error: 'not found' }, 404);
    };

    const seededFetch = createInitialStateSessionCreateFetch(fakeFetch, {
      'program.slug': 'foo',
      'program.name': 'Foo',
      'program.target_dir': '/tmp/foo',
    });

    await seededFetch(new Request('http://pgas.test/sessions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer dev-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        program: 'pgas-new',
        domain_context: {
          'program.slug': 'foo',
          'program.name': 'Foo',
          'program.target_dir': '/tmp/foo',
          query: 'Create Foo.',
        },
      }),
    }));

    expect(requests).toEqual([
      {
        method: 'POST',
        path: '/sessions',
        auth: 'Bearer dev-token',
        body: {
          program: 'pgas-new',
          domain_context: { query: 'Create Foo.' },
        },
      },
      {
        method: 'PATCH',
        path: '/sessions/session-1/domain',
        auth: 'Bearer dev-token',
        body: {
          patches: [
            { path: 'program.slug', value: 'foo' },
            { path: 'program.name', value: 'Foo' },
            { path: 'program.target_dir', value: '/tmp/foo' },
            { path: 'program.target_dir_confirmed', value: true },
          ],
        },
      },
    ]);
  });

  it('routes slug/name/target_dir seeds to governed state before the first LLM round', async () => {
    const authorActions: string[] = [];
    const server = await createPgasServer({
      programs: [{ name: 'pgas-new', entry: createPgasNewFoundryProgramEntry() }],
      drivers: {
        authorHandle: {
          modelId: 'pgas-new-cli-seed-test',
          async complete() {
            authorActions.push('choose_design_path');
            return JSON.stringify(effect('choose_design_path', { choice: 'default' }));
          },
        },
        observerHandle: {
          modelId: 'pgas-new-cli-seed-observer',
          async complete() {
            return 'noop';
          },
        },
      },
      devMode: true,
      telemetry: { enabled: false },
      port: 0,
    });
    const client = createPgasClient(appTransport(server.app, { token: 'dev-token' }));

    try {
      const created = await createSessionWithInitialState(client, {
        program: 'pgas-new',
        initialState: {
          'program.slug': 'foo',
          'program.name': 'Foo',
          'program.target_dir': '/tmp/foo',
        },
        domainContext: { query: 'Create Foo.' },
      });

      const seededWorld = await client.sessions.world(created.sessionId);
      expect(seededWorld.domain['program.slug']).toBe('foo');
      expect(seededWorld.domain['program.name']).toBe('Foo');
      expect(seededWorld.domain['program.target_dir']).toBe('/tmp/foo');
      expect(seededWorld.domain['program.target_dir_confirmed']).toBe(true);
      expect(seededWorld.domain['inputs.domain_context']).toBeUndefined();

      const firstRound = await client.sessions.trigger(created.sessionId, {
        channel: 'user_text',
        payload: 'Use the default skeleton.',
      });

      expect(firstRound.result).toMatchObject({ name: 'choose_design_path' });
      expect(authorActions).toEqual(['choose_design_path']);
    } finally {
      await server.close();
    }
  });
});

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  return text.length > 0 ? JSON.parse(text) : undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
