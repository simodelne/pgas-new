import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { resolveApproveControlForMode, runRepl } from '../../src/repl/runner.js';

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
      const repl = runRepl({ stdin, stdout, baseUrl: 'http://pgas.test', slug: 'pgas-new', token: 'test-token' });
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
      const repl = runRepl({ stdin, stdout, baseUrl: 'http://pgas.test', slug: 'pgas-new', token: 'test-token' });
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

  it('keeps text input live after a control status refresh reports the session active', async () => {
    const fake = createFakePgasFetch({
      sessionEnvelope: {
        sessionId: 'session-1',
        program: 'pgas-new',
        status: 'Running',
        state: {
          mode: 'intake_intelligence',
          running: true,
          currentRoundNumber: 17,
          rounds: Array.from({ length: 17 }, (_, index) => ({ number: index })),
        },
      },
    });
    vi.stubGlobal('fetch', fake.fetch);
    const stdin = new PassThrough();
    const stdout = captureStream();

    try {
      const repl = runRepl({ stdin, stdout, baseUrl: 'http://pgas.test', slug: 'pgas-new', token: 'test-token' });
      await stdout.waitFor('Connected');
      stdin.write('start session\n');
      await fake.waitForRequest('/sessions/session-1/trigger/stream', 1);
      await stdout.waitFor('ready');

      stdin.write('/reject please change Q3 stages\n');
      await fake.waitForRequest('/controls/pgas-new/reject_design_and_revise_q3');
      await fake.waitForRequest('/sessions/session-1');

      stdin.write('intake, review, remediation, complete\n');
      const revisedAnswer = await waitForMaybeRequest(fake, '/sessions/session-1/trigger/stream', 250, 2);
      stdin.write('/exit\n');
      stdin.end();

      const result = await repl;

      expect(result.exitCode).toBe(0);
      expect(revisedAnswer).toMatchObject({
        method: 'POST',
        path: '/sessions/session-1/trigger/stream',
        body: { channel: 'user_text', payload: 'intake, review, remediation, complete' },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not trap queued text when a deterministic control response remains open', async () => {
    const fake = createFakePgasFetch({ holdRejectControlOpen: true });
    vi.stubGlobal('fetch', fake.fetch);
    const stdin = new PassThrough();
    const stdout = captureStream();

    try {
      const repl = runRepl({ stdin, stdout, baseUrl: 'http://pgas.test', slug: 'pgas-new', token: 'test-token' });
      await stdout.waitFor('Connected');
      stdin.write('start session\n');
      await fake.waitForRequest('/sessions/session-1/trigger/stream', 1);
      await stdout.waitFor('ready');

      stdin.write('/reject please change Q3 stages\n');
      await fake.waitForRequest('/controls/pgas-new/reject_design_and_revise_q3');
      stdin.write('intake, review, remediation, complete\n');
      const revisedAnswer = await waitForMaybeRequest(fake, '/sessions/session-1/trigger/stream', 250, 2);
      stdin.write('/exit\n');
      stdin.end();

      const result = await repl;

      expect(result.exitCode).toBe(0);
      expect(revisedAnswer).toMatchObject({
        method: 'POST',
        path: '/sessions/session-1/trigger/stream',
        body: { channel: 'user_text', payload: 'intake, review, remediation, complete' },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps text input live while a deterministic control observes auto-continuation state', async () => {
    const fake = createFakePgasFetch({
      sessionEnvelopes: [
        {
          sessionId: 'session-1',
          program: 'pgas-new',
          status: 'Running',
          state: {
            mode: 'intake_intelligence',
            running: true,
            currentRoundNumber: 17,
            rounds: Array.from({ length: 17 }, (_, index) => ({ number: index })),
          },
        },
        {
          sessionId: 'session-1',
          program: 'pgas-new',
          status: 'Running',
          state: {
            mode: 'intake_intelligence',
            running: false,
            currentRoundNumber: 17,
            rounds: Array.from({ length: 17 }, (_, index) => ({ number: index })),
          },
        },
      ],
    });
    vi.stubGlobal('fetch', fake.fetch);
    const stdin = new PassThrough();
    const stdout = captureStream();

    try {
      const repl = runRepl({ stdin, stdout, baseUrl: 'http://pgas.test', slug: 'pgas-new', token: 'test-token' });
      await stdout.waitFor('Connected');
      stdin.write('start session\n');
      await fake.waitForRequest('/sessions/session-1/trigger/stream', 1);
      await stdout.waitFor('ready');

      stdin.write('/reject please change Q3 stages\n');
      await fake.waitForRequest('/sessions/session-1');
      await sleep(0);

      stdin.write('intake, review, remediation, complete\n');
      const revisedAnswer = await waitForMaybeRequest(fake, '/sessions/session-1/trigger/stream', 1000, 2);
      stdin.write('/exit\n');
      stdin.end();

      const result = await repl;

      expect(result.exitCode).toBe(0);
      expect(fake.requests.filter((request) => request.path === '/sessions/session-1').length).toBeGreaterThanOrEqual(1);
      expect(revisedAnswer).toMatchObject({
        method: 'POST',
        path: '/sessions/session-1/trigger/stream',
        body: { channel: 'user_text', payload: 'intake, review, remediation, complete' },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('drains queued text after a control when the live session remains running', async () => {
    const fake = createFakePgasFetch({
      sessionEnvelope: {
        sessionId: 'session-1',
        program: 'pgas-new',
        status: 'Running',
        state: {
          mode: 'intake_intelligence',
          running: true,
          currentRoundNumber: 17,
          rounds: Array.from({ length: 17 }, (_, index) => ({ number: index })),
        },
      },
    });
    vi.stubGlobal('fetch', fake.fetch);
    const stdin = new PassThrough();
    const stdout = captureStream();

    try {
      const repl = runRepl({ stdin, stdout, baseUrl: 'http://pgas.test', slug: 'pgas-new', token: 'test-token' });
      await stdout.waitFor('Connected');
      stdin.write('start session\n');
      await fake.waitForRequest('/sessions/session-1/trigger/stream', 1);
      await stdout.waitFor('ready');

      stdin.write('/reject please change Q3 stages\n');
      await fake.waitForRequest('/sessions/session-1');
      await sleep(0);

      stdin.write('intake, review, remediation, complete\n');
      const revisedAnswer = await waitForMaybeRequest(fake, '/sessions/session-1/trigger/stream', 250, 2);
      stdin.write('/exit\n');
      stdin.end();

      const result = await repl;

      expect(result.exitCode).toBe(0);
      expect(revisedAnswer).toMatchObject({
        method: 'POST',
        path: '/sessions/session-1/trigger/stream',
        body: { channel: 'user_text', payload: 'intake, review, remediation, complete' },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('dispatches /approve even while a prior streamed round is still open', async () => {
    const fake = createFakePgasFetch({ holdFirstTriggerOpen: true });
    vi.stubGlobal('fetch', fake.fetch);
    const stdin = new PassThrough();
    const stdout = captureStream();

    try {
      const repl = runRepl({ stdin, stdout, baseUrl: 'http://pgas.test', slug: 'pgas-new', token: 'test-token' });
      await stdout.waitFor('Connected');
      stdin.write('start session\n');
      await fake.waitForRequest('/sessions/session-1/trigger/stream', 1);

      stdin.write('/approve\n');
      const deterministicControl = await waitForMaybeRequest(fake, '/controls/pgas-new/approve_artifact_plan', 250);
      fake.closeHeldTrigger();
      stdin.write('/exit\n');
      stdin.end();

      const result = await repl;

      expect(result.exitCode).toBe(0);
      expect(deterministicControl).toMatchObject({
        method: 'POST',
        path: '/controls/pgas-new/approve_artifact_plan',
        body: { sessionId: 'session-1', channel: 'http' },
      });
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
      const repl = runRepl({ stdin, stdout, baseUrl: 'http://pgas.test', slug: 'pgas-new', token: 'test-token' });
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
      const repl = runRepl({ stdin, stdout, baseUrl: 'http://pgas.test', slug: 'pgas-new', token: 'test-token' });
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
      const repl = runRepl({ stdin, stdout, baseUrl: 'http://pgas.test', slug: 'pgas-new', token: 'test-token' });
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

describe('resolveApproveControlForMode (regression: §10 Scenario A intake_intelligence /approve)', () => {
  // Source-of-failure evidence: at HEAD 51eef801 (Phase 5 v2 §10 rerun) the
  // pre-fix runner unconditionally fired `approve_artifact_plan` on /approve.
  // In `intake_intelligence` mode, that action's precondition requires
  // `artifact_plan.status='draft'` (set only by plan_artifacts in scaffold_plan),
  // so it failed; engine fell back to a user_confirmation LLM round; Qwen
  // emitted `record_note` instead of `confirm_design`. See
  // .uat/session-logs-current/pgas-new-1782230910268/session-log.ndjson:465-476.

  it("maps mode='intake_intelligence' to confirm_design (Phase 3.14 chain-end action)", () => {
    expect(resolveApproveControlForMode('intake_intelligence')).toBe('confirm_design');
  });

  it("maps mode='scaffold_plan' to approve_artifact_plan (unchanged behavior)", () => {
    expect(resolveApproveControlForMode('scaffold_plan')).toBe('approve_artifact_plan');
  });

  it.each([
    ['repo_targeting'],
    ['architecture_design'],
    ['branch_write'],
    ['static_verify'],
    ['live_verify'],
    ['rebase_verify'],
    ['pr_graduation'],
    ['curator_request'],
  ] as const)('falls back to approve_artifact_plan for mode=%s (engine surfaces precondition error)', (mode) => {
    expect(resolveApproveControlForMode(mode)).toBe('approve_artifact_plan');
  });

  it('falls back to approve_artifact_plan when mode is null (pre-session boot, edge case)', () => {
    expect(resolveApproveControlForMode(null)).toBe('approve_artifact_plan');
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
  holdFirstTriggerOpen?: boolean;
  holdRejectControlOpen?: boolean;
  sessionEnvelope?: Record<string, unknown>;
  sessionEnvelopes?: Array<Record<string, unknown>>;
} = {}): FakeFetch & { closeHeldTrigger(): void } {
  const requests: RequestRecord[] = [];
  const waiters = new Map<string, Array<{ seenCount: number; resolve(record: RequestRecord): void }>>();
  const encoder = new TextEncoder();
  let heldTriggerClosed = false;
  let releaseHeldTrigger: (() => void) | undefined;
  let sessionGetCount = 0;

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
    if (request.method === 'GET' && url.pathname === '/sessions/session-1') {
      const sequencedEnvelope = options.sessionEnvelopes?.[
        Math.min(sessionGetCount, Math.max(options.sessionEnvelopes.length - 1, 0))
      ];
      sessionGetCount += 1;
      return json(sequencedEnvelope ?? options.sessionEnvelope ?? {
        sessionId: 'session-1',
        program: 'pgas-new',
        status: 'Running',
        state: { mode: 'intake_intelligence', running: false, currentRoundNumber: 1, rounds: [{ number: 0 }] },
      });
    }
    if (request.method === 'POST' && url.pathname === '/controls/pgas-new/abort') {
      return json({ ok: true });
    }
    if (request.method === 'POST' && url.pathname === '/controls/pgas-new/approve_artifact_plan') {
      return json({ ok: true, sessionId: 'session-1' });
    }
    if (request.method === 'POST' && url.pathname.startsWith('/controls/pgas-new/reject_design_and_revise_q')) {
      if (options.holdRejectControlOpen === true) {
        return await new Promise<Response>(() => {});
      }
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

async function waitForMaybeRequest(
  fake: FakeFetch,
  path: string,
  timeoutMs: number,
  seenCount = 1,
): Promise<RequestRecord | null> {
  return Promise.race([
    fake.waitForRequest(path, seenCount),
    new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), timeoutMs);
    }),
  ]);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
