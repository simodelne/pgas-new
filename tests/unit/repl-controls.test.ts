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
  waitForRequest(path: string, seenCount?: number): Promise<RequestRecord>;
}

describe('REPL controls', () => {
  it.each([
    ['/approve', '/controls/pgas-new/approve_artifact_plan', { sessionId: 'session-1', channel: 'http' }],
    [
      '/reject please change Q3 stages',
      '/controls/pgas-new/reject_design_and_revise_q3',
      { sessionId: 'session-1', channel: 'http', args: { instruction: 'please change Q3 stages' } },
    ],
  ] as const)('routes %s through deterministic controls.invoke', async (control, expectedPath, expectedBody) => {
    const fake = createFakePgasFetch();
    vi.stubGlobal('fetch', fake.fetch);
    const stdin = new PassThrough();
    const stdout = captureStream();

    try {
      const repl = runRepl({ stdin, stdout, baseUrl: 'http://pgas.test', slug: 'pgas-new' });
      await stdout.waitFor('Connected');
      stdin.write('start session\n');
      await fake.waitForRequest('/sessions/session-1/trigger/stream', 1);
      await stdout.waitFor('ready');

      stdin.write(`${control}\n`);
      const deterministicControl = await fake.waitForRequest(expectedPath);
      stdin.write('/exit\n');
      stdin.end();

      const result = await repl;

      expect(result.exitCode).toBe(0);
      expect(deterministicControl).toMatchObject({
        method: 'POST',
        path: expectedPath,
        body: expectedBody,
      });
      expect(fake.requests.filter((request) => request.path === '/sessions/session-1/trigger/stream')).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects /reject controls that do not name a Q1-Q6 revision target', async () => {
    const fake = createFakePgasFetch();
    vi.stubGlobal('fetch', fake.fetch);
    const stdin = new PassThrough();
    const stdout = captureStream();

    try {
      const repl = runRepl({ stdin, stdout, baseUrl: 'http://pgas.test', slug: 'pgas-new' });
      await stdout.waitFor('Connected');
      stdin.write('start session\n');
      await fake.waitForRequest('/sessions/session-1/trigger/stream', 1);
      await stdout.waitFor('ready');

      stdin.write('/reject please revise this\n');
      await stdout.waitFor('/reject must name Q1, Q2, Q3, Q4, Q5, or Q6');
      stdin.write('/exit\n');
      stdin.end();

      const result = await repl;

      expect(result.exitCode).toBe(0);
      expect(fake.requests.some((request) => request.path.includes('/reject_design_and_revise_'))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps /abort routed through controls.invoke', async () => {
    const fake = createFakePgasFetch();
    vi.stubGlobal('fetch', fake.fetch);
    const stdin = new PassThrough();
    const stdout = captureStream();

    try {
      const repl = runRepl({ stdin, stdout, baseUrl: 'http://pgas.test', slug: 'pgas-new' });
      await stdout.waitFor('Connected');
      stdin.write('start session\n');
      await fake.waitForRequest('/sessions/session-1/trigger/stream', 1);
      await stdout.waitFor('ready');

      stdin.write('/abort\n');
      const abort = await fake.waitForRequest('/controls/pgas-new/abort');
      await stdout.waitFor('Session aborted.');
      stdin.write('/exit\n');
      stdin.end();

      const result = await repl;

      expect(result).toMatchObject({ reason: 'user_exit', sessionId: null, exitCode: 0 });
      expect(abort).toMatchObject({
        method: 'POST',
        path: '/controls/pgas-new/abort',
        body: { sessionId: 'session-1', channel: 'http' },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('drops input queued before /abort instead of starting a new session', async () => {
    const fake = createFakePgasFetch({ holdFirstTriggerOpen: true });
    vi.stubGlobal('fetch', fake.fetch);
    const stdin = new PassThrough();
    const stdout = captureStream();

    try {
      const repl = runRepl({ stdin, stdout, baseUrl: 'http://pgas.test', slug: 'pgas-new' });
      await stdout.waitFor('Connected');
      stdin.write('start session\n');
      await fake.waitForRequest('/sessions/session-1/trigger/stream', 1);

      stdin.write('Ask Q3.\n');
      stdin.write('/abort\n');
      await fake.waitForRequest('/controls/pgas-new/abort');
      fake.closeHeldTrigger();
      await stdout.waitFor('Session aborted.');

      stdin.write('/exit\n');
      stdin.end();

      const result = await repl;

      expect(result).toMatchObject({ reason: 'user_exit', sessionId: null, exitCode: 0 });
      expect(fake.requests.filter((request) => request.path === '/sessions')).toHaveLength(1);
      expect(fake.requests.filter((request) => request.path === '/sessions/session-1/trigger/stream')).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps plain text routed through user_text', async () => {
    const fake = createFakePgasFetch();
    vi.stubGlobal('fetch', fake.fetch);
    const stdin = new PassThrough();
    const stdout = captureStream();

    try {
      const repl = runRepl({ stdin, stdout, baseUrl: 'http://pgas.test', slug: 'pgas-new' });
      await stdout.waitFor('Connected');
      stdin.write('hello world\n');
      const trigger = await fake.waitForRequest('/sessions/session-1/trigger/stream', 1);
      stdin.write('/exit\n');
      stdin.end();

      const result = await repl;

      expect(result.exitCode).toBe(0);
      expect(trigger).toMatchObject({
        method: 'POST',
        path: '/sessions/session-1/trigger/stream',
        body: { channel: 'user_text', payload: 'hello world' },
      });
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

function createFakePgasFetch(options: { holdFirstTriggerOpen?: boolean } = {}): FakeFetch & { closeHeldTrigger(): void } {
  const requests: RequestRecord[] = [];
  const waiters = new Map<string, Array<{ seenCount: number; resolve(record: RequestRecord): void }>>();
  const encoder = new TextEncoder();
  let heldTriggerClosed = false;
  let releaseHeldTrigger: (() => void) | undefined;

  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = await readJson(request);
    const url = new URL(request.url);
    const record: RequestRecord = { method: request.method, path: url.pathname, body };
    requests.push(record);
    const pathWaiters = waiters.get(record.path) ?? [];
    for (const waiter of [...pathWaiters]) {
      const seen = requests.filter((entry) => entry.path === record.path).length;
      if (seen >= waiter.seenCount) {
        const index = pathWaiters.indexOf(waiter);
        if (index >= 0) pathWaiters.splice(index, 1);
        waiter.resolve(record);
      }
    }
    if (pathWaiters.length === 0) waiters.delete(record.path);

    if (request.method === 'GET' && url.pathname === '/programs') {
      return json({ programs: [{ name: 'pgas-new' }] });
    }
    if (request.method === 'POST' && url.pathname === '/sessions') {
      return json({ sessionId: 'session-1' });
    }
    if (request.method === 'POST' && url.pathname === '/sessions/session-1/trigger/stream') {
      const seen = requests.filter((entry) => entry.path === url.pathname).length;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('event: round_complete\n'));
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ result: { name: 'record_user_note', payload: { message: 'ready' } } })}\n\n`,
            ),
          );
          if (options.holdFirstTriggerOpen === true && seen === 1) {
            releaseHeldTrigger = () => {
              heldTriggerClosed = true;
              controller.close();
            };
            return;
          }
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    if (request.method === 'POST' && url.pathname === '/controls/pgas-new/abort') {
      return json({ ok: true });
    }
    if (request.method === 'POST' && url.pathname === '/controls/pgas-new/approve_artifact_plan') {
      return json({ ok: true, sessionId: 'session-1' });
    }
    if (request.method === 'POST' && url.pathname.startsWith('/controls/pgas-new/reject_design_and_revise_q')) {
      return json({ ok: true, sessionId: 'session-1' });
    }

    return json({ error: `not found: ${url.pathname}` }, 404);
  };

  return {
    fetch: fakeFetch,
    requests,
    waitForRequest(path: string, seenCount = 1) {
      const existing = requests.filter((request) => request.path === path);
      if (existing.length >= seenCount) return Promise.resolve(existing[seenCount - 1]);
      return new Promise((resolve) => {
        const list = waiters.get(path) ?? [];
        list.push({ seenCount, resolve });
        waiters.set(path, list);
      });
    },
    closeHeldTrigger() {
      if (heldTriggerClosed) return;
      releaseHeldTrigger?.();
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
