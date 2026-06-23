import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { runRepl } from '../../src/repl/runner.js';

interface RequestRecord {
  method: string;
  path: string;
  body: unknown;
}

interface FakeFetch {
  fetch: typeof fetch;
  requests: RequestRecord[];
  waitForRequest(path: string): Promise<RequestRecord>;
}

describe('runRepl', () => {
  it('runs a bare-entry round against a fake streaming server', async () => {
    const fake = createFakePgasFetch({
      sseEvents: [
        { event: 'step', data: { step: 'authorship' } },
        {
          event: 'round_complete',
          data: { result: { name: 'record_user_note', payload: { message: 'noted' } } },
        },
      ],
    });
    vi.stubGlobal('fetch', fake.fetch);
    const stdin = new PassThrough();
    const stdout = captureStream();

    try {
      const repl = runRepl({ stdin, stdout, baseUrl: 'http://pgas.test', slug: 'pgas-new' });
      await stdout.waitFor('Connected');
      stdin.write('hello foundry\n');
      await fake.waitForRequest('/sessions/session-1/trigger/stream');
      await stdout.waitFor('noted');
      stdin.write('/exit\n');
      stdin.end();

      const result = await repl;

      expect(result).toMatchObject({ reason: 'user_exit', sessionId: 'session-1', exitCode: 0 });
      expect(fake.requests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: 'POST',
            path: '/sessions',
            body: { program: 'pgas-new', domain_context: { query: 'hello foundry' } },
          }),
          expect.objectContaining({
            method: 'POST',
            path: '/sessions/session-1/trigger/stream',
            body: { channel: 'user_text', payload: 'hello foundry' },
          }),
        ]),
      );
      expect(stdout.text()).toContain('Connected');
      expect(stdout.text()).toContain('noted');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sends /abort during an in-flight round and closes the active session', async () => {
    let releaseSse!: () => void;
    const fake = createFakePgasFetch({
      beforeRoundComplete: () => new Promise<void>((resolve) => {
        releaseSse = resolve;
      }),
      sseEvents: [
        { event: 'step', data: { step: 'authorship' } },
        {
          event: 'round_complete',
          data: { result: { name: 'record_user_note', payload: { message: 'late result' } } },
        },
      ],
    });
    vi.stubGlobal('fetch', fake.fetch);
    const stdin = new PassThrough();
    const stdout = captureStream();

    try {
      const repl = runRepl({ stdin, stdout, baseUrl: 'http://pgas.test', slug: 'pgas-new' });
      await stdout.waitFor('Connected');
      stdin.write('start work\n');
      await fake.waitForRequest('/sessions/session-1/trigger/stream');
      stdin.write('/abort\n');
      await fake.waitForRequest('/controls/pgas-new/abort');
      releaseSse();
      stdin.write('/exit\n');
      stdin.end();

      const result = await repl;

      expect(result).toMatchObject({ reason: 'user_exit', sessionId: null, exitCode: 0 });
      expect(fake.requests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: 'POST',
            path: '/controls/pgas-new/abort',
            body: { sessionId: 'session-1', channel: 'http' },
          }),
        ]),
      );
      expect(stdout.text()).toContain('Session aborted.');
      expect(stdout.text()).not.toContain('late result');
    } finally {
      releaseSse?.();
      vi.unstubAllGlobals();
    }
  });

  it('rejects unknown slash commands with the existing renderer shape', async () => {
    const fake = createFakePgasFetch({ sseEvents: [] });
    vi.stubGlobal('fetch', fake.fetch);
    const stdin = new PassThrough();
    const stdout = captureStream();

    try {
      const repl = runRepl({ stdin, stdout, baseUrl: 'http://pgas.test', slug: 'pgas-new' });
      await stdout.waitFor('Connected');
      stdin.write('/bogus\n');
      stdin.write('/exit\n');
      stdin.end();

      const result = await repl;

      expect(result.exitCode).toBe(0);
      expect(stdout.text()).toContain('Unknown command: /bogus');
      expect(fake.requests.some((request) => request.path.includes('/controls/'))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('renders /status from the live session state envelope', async () => {
    const fake = createFakePgasFetch({
      sessionEnvelope: {
        sessionId: 'session-1',
        program: 'pgas-new',
        status: 'Running',
        state: {
          mode: 'architecture_design',
          running: false,
          currentRoundNumber: 16,
          rounds: Array.from({ length: 16 }, (_, index) => ({ number: index })),
        },
      },
      sseEvents: [
        {
          event: 'round_complete',
          data: { result: { name: 'confirm_design', payload: { approved: true } } },
        },
      ],
    });
    vi.stubGlobal('fetch', fake.fetch);
    const stdin = new PassThrough();
    const stdout = captureStream();

    try {
      const repl = runRepl({ stdin, stdout, baseUrl: 'http://pgas.test', slug: 'pgas-new' });
      await stdout.waitFor('Connected');
      stdin.write('start design\n');
      await fake.waitForRequest('/sessions/session-1/trigger/stream');
      await stdout.waitFor('approved');
      stdin.write('/status\n');
      await fake.waitForRequest('/sessions/session-1');
      await stdout.waitFor('rounds:');
      stdin.write('/exit\n');
      stdin.end();

      await repl;

      expect(stdout.text()).toContain('mode: architecture_design');
      expect(stdout.text()).toContain('running: false');
      expect(stdout.text()).toContain('rounds: 16');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

function captureStream(): Writable & { text(): string; waitFor(expected: string): Promise<void> } {
  let body = '';
  const waiters: Array<{ expected: string; resolve(): void }> = [];
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      body += chunk.toString();
      for (const waiter of [...waiters]) {
        if (body.includes(waiter.expected)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      }
      callback();
    },
  }) as Writable & { text(): string; waitFor(expected: string): Promise<void> };
  writable.text = () => body.replace(/\x1b\[[0-9;]*m/g, '');
  writable.waitFor = (expected: string) => {
    if (body.includes(expected)) return Promise.resolve();
    return new Promise((resolve) => {
      waiters.push({ expected, resolve });
    });
  };
  return writable;
}

function createFakePgasFetch(options: {
  sseEvents: Array<{ event: string; data: unknown }>;
  beforeRoundComplete?: () => Promise<void>;
  sessionEnvelope?: Record<string, unknown>;
}): FakeFetch {
  const requests: RequestRecord[] = [];
  const waiters = new Map<string, Array<(record: RequestRecord) => void>>();
  const encoder = new TextEncoder();

  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = await readJson(request);
    const url = new URL(request.url);
    const record: RequestRecord = { method: request.method, path: url.pathname, body };
    requests.push(record);
    for (const resolve of waiters.get(record.path) ?? []) {
      resolve(record);
    }
    waiters.delete(record.path);

    if (request.method === 'GET' && url.pathname === '/programs') {
      return json({ programs: [{ name: 'pgas-new' }] });
    }
    if (request.method === 'POST' && url.pathname === '/sessions') {
      return json({ sessionId: 'session-1' });
    }
    if (request.method === 'POST' && url.pathname === '/sessions/session-1/trigger/stream') {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const event of options.sseEvents) {
            if (event.event === 'round_complete') {
              await options.beforeRoundComplete?.();
            }
            controller.enqueue(encoder.encode(`event: ${event.event}\n`));
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event.data)}\n\n`));
          }
          controller.close();
        }
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    if (request.method === 'GET' && url.pathname === '/sessions/session-1') {
      return json(options.sessionEnvelope ?? {
        sessionId: 'session-1',
        program: 'pgas-new',
        status: 'Running',
        state: { mode: 'intake_intelligence', running: false, currentRoundNumber: 1, rounds: [{ number: 0 }] },
      });
    }
    if (request.method === 'POST' && url.pathname === '/controls/pgas-new/abort') {
      return json({ ok: true });
    }

    return json({ error: `not found: ${url.pathname}` }, 404);
  };

  return {
    fetch: fakeFetch,
    requests,
    waitForRequest(path: string) {
      const existing = requests.find((request) => request.path === path);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => {
        const list = waiters.get(path) ?? [];
        list.push(resolve);
        waiters.set(path, list);
      });
    },
  };
}

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
