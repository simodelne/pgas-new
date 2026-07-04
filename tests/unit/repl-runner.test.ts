import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { runRepl } from '../../src/repl/runner.js';

interface RequestRecord {
  method: string;
  path: string;
  auth: string | null;
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
      const repl = runRepl({ stdin, stdout, baseUrl: 'http://pgas.test', slug: 'pgas-new', token: 'test-token' });
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

  it('submits a bracketed pasted multi-line brief as one user_text turn', async () => {
    const fake = createFakePgasFetch({
      sseEvents: [
        {
          event: 'round_complete',
          data: { result: { name: 'record_user_note', payload: { message: 'pasted' } } },
        },
      ],
    });
    vi.stubGlobal('fetch', fake.fetch);
    const stdin = new PassThrough();
    const stdout = captureStream();
    const pastedBrief = [
      'START NEW DESIGN SESSION.',
      'Target program slug=minutes-drafter.',
      'Required artifacts: projection.ts, frontend.spec.yml, qc coverage.',
    ].join('\n');

    try {
      const repl = runRepl({ stdin, stdout, baseUrl: 'http://pgas.test', slug: 'pgas-new', token: 'test-token' });
      await stdout.waitFor('Connected');
      stdin.write(`\x1b[200~${pastedBrief}\x1b[201~`);
      const trigger = await fake.waitForRequest('/sessions/session-1/trigger/stream');
      await stdout.waitFor('pasted');
      stdin.write('/exit\n');
      stdin.end();

      const result = await repl;

      expect(result).toMatchObject({ reason: 'user_exit', sessionId: 'session-1', exitCode: 0 });
      expect(trigger).toMatchObject({
        method: 'POST',
        path: '/sessions/session-1/trigger/stream',
        body: { channel: 'user_text', payload: pastedBrief },
      });
      expect(fake.requests.filter((request) => request.path === '/sessions/session-1/trigger/stream')).toHaveLength(1);
      expect(stdout.text()).toContain('bracketed paste');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('coalesces a bracketed paste split across multiple stdin chunks into one turn', async () => {
    // Real terminals deliver a large paste in several `data` chunks; the paste
    // end-marker (ESC[201~) can arrive in a later chunk. The buffer must hold
    // until the end-marker before submitting so the whole brief is one turn.
    const fake = createFakePgasFetch({
      sseEvents: [
        {
          event: 'round_complete',
          data: { result: { name: 'record_user_note', payload: { message: 'chunked' } } },
        },
      ],
    });
    vi.stubGlobal('fetch', fake.fetch);
    const stdin = new PassThrough();
    const stdout = captureStream();
    const pastedBrief = [
      'START NEW DESIGN SESSION.',
      'Target program slug=minutes-drafter.',
      'Required artifacts: projection.ts, frontend.spec.yml.',
    ].join('\n');

    try {
      const repl = runRepl({ stdin, stdout, baseUrl: 'http://pgas.test', slug: 'pgas-new', token: 'test-token' });
      await stdout.waitFor('Connected');
      // Split the paste sequence across three writes, with the end-marker last.
      stdin.write('\x1b[200~START NEW DESIGN SESSION.\nTarget program slug=minutes-drafter.\n');
      stdin.write('Required artifacts: projection.ts, frontend.spec.yml.');
      stdin.write('\x1b[201~');
      const trigger = await fake.waitForRequest('/sessions/session-1/trigger/stream');
      await stdout.waitFor('chunked');
      stdin.write('/exit\n');
      stdin.end();

      const result = await repl;

      expect(result).toMatchObject({ reason: 'user_exit', sessionId: 'session-1', exitCode: 0 });
      expect(trigger).toMatchObject({
        method: 'POST',
        path: '/sessions/session-1/trigger/stream',
        body: { channel: 'user_text', payload: pastedBrief },
      });
      expect(fake.requests.filter((request) => request.path === '/sessions/session-1/trigger/stream')).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reads the cached token and uses it as bearer auth when options.token is absent', async () => {
    const originalHome = process.env.HOME;
    const homeDir = mkdtempSync(join(tmpdir(), 'pgas-new-repl-token-'));
    const token = tokenWithExp(Math.floor(Date.now() / 1000) + 3600);
    writeToken(homeDir, token);
    process.env.HOME = homeDir;
    const fake = createFakePgasFetch({ sseEvents: [] });
    vi.stubGlobal('fetch', fake.fetch);
    const stdin = new PassThrough();
    const stdout = captureStream();

    try {
      const repl = runRepl({ stdin, stdout, baseUrl: 'http://pgas.test', slug: 'pgas-new' });
      await stdout.waitFor('Connected');
      stdin.write('/exit\n');
      stdin.end();

      const result = await repl;

      expect(result.exitCode).toBe(0);
      expect(fake.requests[0]).toMatchObject({
        method: 'GET',
        path: '/programs',
        auth: `Bearer ${token}`,
      });
    } finally {
      vi.unstubAllGlobals();
      restoreHome(originalHome);
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['missing token', undefined],
    ['expired token', tokenWithExp(1)],
  ])('exits before connecting when the cached session is %s', async (_label, token) => {
    const originalHome = process.env.HOME;
    const homeDir = mkdtempSync(join(tmpdir(), 'pgas-new-repl-no-token-'));
    if (token) writeToken(homeDir, token);
    process.env.HOME = homeDir;
    const fake = createFakePgasFetch({ sseEvents: [] });
    vi.stubGlobal('fetch', fake.fetch);
    const stdin = new PassThrough();
    const stdout = captureStream();

    try {
      const result = await runRepl({ stdin, stdout, baseUrl: 'http://pgas.test', slug: 'pgas-new' });

      expect(result).toMatchObject({ reason: 'error', sessionId: null, exitCode: 1 });
      expect(stdout.text()).toContain('no active session — run `pgas-new login`');
      expect(fake.requests).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      restoreHome(originalHome);
      rmSync(homeDir, { recursive: true, force: true });
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
      const repl = runRepl({ stdin, stdout, baseUrl: 'http://pgas.test', slug: 'pgas-new', token: 'test-token' });
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

  it('exits cleanly when the cached session is rejected mid-round', async () => {
    const fake = createFakePgasFetch({
      sseEvents: [],
      triggerStatus: 401,
    });
    vi.stubGlobal('fetch', fake.fetch);
    const stdin = new PassThrough();
    const stdout = captureStream();

    try {
      const repl = runRepl({ stdin, stdout, baseUrl: 'http://pgas.test', slug: 'pgas-new', token: 'test-token' });
      await stdout.waitFor('Connected');
      stdin.write('hello after expiry\n');
      await stdout.waitFor('session expired, re-run `pgas-new login`');

      const result = await repl;

      expect(result).toMatchObject({ reason: 'error', sessionId: 'session-1', exitCode: 1 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects unknown slash commands with the existing renderer shape', async () => {
    const fake = createFakePgasFetch({ sseEvents: [] });
    vi.stubGlobal('fetch', fake.fetch);
    const stdin = new PassThrough();
    const stdout = captureStream();

    try {
      const repl = runRepl({ stdin, stdout, baseUrl: 'http://pgas.test', slug: 'pgas-new', token: 'test-token' });
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
      const repl = runRepl({ stdin, stdout, baseUrl: 'http://pgas.test', slug: 'pgas-new', token: 'test-token' });
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

  it('recovers a round after a transient transport fetch-failed blip (issue #77)', async () => {
    const fake = createFakePgasFetch({
      sseEvents: [],
      triggerScript: [
        // First attempt: Qwen HTTP blip surfaced as `TypeError: fetch failed`.
        { kind: 'transport-error', message: 'fetch failed' },
        // Retry succeeds and the round completes normally.
        {
          kind: 'sse',
          events: [
            { event: 'step', data: { step: 'execution' } },
            { event: 'round_complete', data: { result: { name: 'write_scaffold_artifacts', payload: { written: 3 } } } },
          ],
        },
      ],
    });
    vi.stubGlobal('fetch', fake.fetch);
    const stdin = new PassThrough();
    const stdout = captureStream();

    try {
      const repl = runRepl({ stdin, stdout, baseUrl: 'http://pgas.test', slug: 'pgas-new', token: 'test-token' });
      await stdout.waitFor('Connected');
      stdin.write('write the scaffold\n');
      await stdout.waitFor('retrying round');
      await stdout.waitFor('write scaffold artifacts');
      stdin.write('/exit\n');
      stdin.end();

      const result = await repl;

      expect(result).toMatchObject({ reason: 'user_exit', sessionId: 'session-1', exitCode: 0 });
      // The round was re-triggered (two trigger/stream calls), and no hard
      // error was surfaced — the recoverable session resumed transparently.
      expect(fake.requests.filter((r) => r.path === '/sessions/session-1/trigger/stream')).toHaveLength(2);
      expect(stdout.text()).toContain('write scaffold artifacts');
      // The blip was surfaced as a benign retry notice (ℹ), not a hard error (✗).
      expect(stdout.text()).toContain('transient issue (fetch failed) — retrying round');
      expect(stdout.text()).not.toContain('✗');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('recovers a round cancelled by server_shutdown (retryable round_cancelled event, issue #77)', async () => {
    const fake = createFakePgasFetch({
      sseEvents: [],
      triggerScript: [
        // First attempt: engine cancels the in-flight round on server_shutdown
        // but leaves the session Running and marks the error retryable.
        {
          kind: 'sse',
          events: [
            { event: 'step', data: { step: 'execution' } },
            { event: 'error', data: { kind: 'round_cancelled', message: 'Round cancelled.', retryable: true } },
          ],
        },
        // Retry resumes the recoverable session and writes the artifacts.
        {
          kind: 'sse',
          events: [
            { event: 'round_complete', data: { result: { name: 'write_scaffold_artifacts', payload: { written: 3 } } } },
          ],
        },
      ],
    });
    vi.stubGlobal('fetch', fake.fetch);
    const stdin = new PassThrough();
    const stdout = captureStream();

    try {
      const repl = runRepl({ stdin, stdout, baseUrl: 'http://pgas.test', slug: 'pgas-new', token: 'test-token' });
      await stdout.waitFor('Connected');
      stdin.write('write the scaffold\n');
      await stdout.waitFor('retrying round');
      await stdout.waitFor('write scaffold artifacts');
      stdin.write('/exit\n');
      stdin.end();

      const result = await repl;

      expect(result).toMatchObject({ reason: 'user_exit', sessionId: 'session-1', exitCode: 0 });
      expect(fake.requests.filter((r) => r.path === '/sessions/session-1/trigger/stream')).toHaveLength(2);
      expect(stdout.text()).toContain('write scaffold artifacts');
      // The bare "Round cancelled." error must not reach the user as a failure.
      expect(stdout.text()).not.toMatch(/error.*Round cancelled/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('surfaces a recoverable hint when transient retries are exhausted (issue #77)', async () => {
    const fake = createFakePgasFetch({
      sseEvents: [],
      triggerScript: [
        { kind: 'transport-error', message: 'fetch failed' },
        { kind: 'transport-error', message: 'fetch failed' },
        { kind: 'transport-error', message: 'fetch failed' },
        { kind: 'transport-error', message: 'fetch failed' },
      ],
    });
    vi.stubGlobal('fetch', fake.fetch);
    const stdin = new PassThrough();
    const stdout = captureStream();

    try {
      const repl = runRepl({ stdin, stdout, baseUrl: 'http://pgas.test', slug: 'pgas-new', token: 'test-token' });
      await stdout.waitFor('Connected');
      stdin.write('write the scaffold\n');
      await stdout.waitFor('still recoverable');
      stdin.write('/exit\n');
      stdin.end();

      const result = await repl;

      expect(result).toMatchObject({ reason: 'user_exit', sessionId: 'session-1', exitCode: 0 });
      // 4 attempts = initial + TRANSIENT_ROUND_RETRY_LIMIT (3) retries.
      expect(fake.requests.filter((r) => r.path === '/sessions/session-1/trigger/stream')).toHaveLength(4);
      expect(stdout.text()).toContain('still recoverable');
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

type TriggerAttempt =
  | { kind: 'sse'; events: Array<{ event: string; data: unknown }> }
  | { kind: 'transport-error'; message?: string }
  | { kind: 'status'; status: number };

function createFakePgasFetch(options: {
  sseEvents: Array<{ event: string; data: unknown }>;
  beforeRoundComplete?: () => Promise<void>;
  sessionEnvelope?: Record<string, unknown>;
  triggerStatus?: number;
  // Per-attempt trigger-stream behavior (issue #77 transient-retry tests).
  // When present, the Nth trigger/stream call uses triggerScript[N]; calls
  // beyond the script fall back to `sseEvents`.
  triggerScript?: TriggerAttempt[];
}): FakeFetch {
  const requests: RequestRecord[] = [];
  const waiters = new Map<string, Array<(record: RequestRecord) => void>>();
  const encoder = new TextEncoder();
  let triggerAttempt = 0;

  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = await readJson(request);
    const url = new URL(request.url);
    const record: RequestRecord = {
      method: request.method,
      path: url.pathname,
      auth: request.headers.get('authorization'),
      body,
    };
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
      const attemptIndex = triggerAttempt;
      triggerAttempt += 1;
      const scripted = options.triggerScript?.[attemptIndex];
      if (scripted?.kind === 'transport-error') {
        // Model an undici transport blip: a raw `TypeError: fetch failed`
        // thrown from fetch itself (issue #77 repro shape).
        throw new TypeError(scripted.message ?? 'fetch failed');
      }
      if (scripted?.kind === 'status') {
        return json({ error: 'transient' }, scripted.status);
      }
      if (options.triggerStatus !== undefined) {
        return json({ error: 'unauthorized' }, options.triggerStatus);
      }
      const events = scripted?.kind === 'sse' ? scripted.events : options.sseEvents;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const event of events) {
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

function writeToken(homeDir: string, token: string): void {
  const dir = join(homeDir, '.local/share/pgas-new');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'token'), token, { mode: 0o600 });
}

function tokenWithExp(exp: number): string {
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return `header.${payload}.signature`;
}

function restoreHome(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = value;
  }
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
