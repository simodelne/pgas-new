import readline from 'node:readline';
import { createPgasClient, fetchTransport } from '@simodelne/pgas-server/client.js';
import { createReplRenderer, REPL_CONTROL_HINT } from './renderer.js';
import type { ActionResult, ReplExitInfo, ReplOptions, ReplState, ReplStreamEvent } from './types.js';

const STEP_LABELS: Record<string, string> = {
  ingestion: 'reading context…',
  projection: 'projecting state…',
  authorship: 'drafting response…',
  recognition: 'validating action…',
  execution: 'applying action…',
};

const ALWAYS_AVAILABLE_COMMANDS = new Set(['abort', 'exit', 'help', 'history', 'quit', 'status']);

export interface UserConfirmationPayload {
  decision: 'approve' | 'reject';
  instruction?: string;
}

export function parseUserConfirmationControl(input: string): UserConfirmationPayload | null {
  const approve = /^\/approve(\s+(.+))?$/.exec(input);
  if (approve) return buildUserConfirmationPayload('approve', approve[2]);

  const reject = /^\/reject(\s+(.+))?$/.exec(input);
  if (reject) return buildUserConfirmationPayload('reject', reject[2]);

  return null;
}

export async function runRepl(options: ReplOptions): Promise<ReplExitInfo> {
  return runStreamingRepl(options);
}

export async function runStreamingRepl(options: ReplOptions): Promise<ReplExitInfo> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const apiBase = options.apiBase ?? options.baseUrl ?? 'http://localhost:3000';
  const token = options.token ?? 'dev-token';
  const program = options.program ?? options.slug ?? 'pgas-new';
  const displayName = options.programDisplayName ?? program;
  const renderer = createReplRenderer(stdout);
  const client = createPgasClient(fetchTransport({ baseUrl: apiBase, token }));
  const state: ReplState = {
    sessionId: null,
    mode: null,
    running: false,
    abortRequested: false,
  };

  let activeSpinner: { update(message: string): void; stop(): void } | null = null;
  let inputBusy = false;
  let textBusy = false;
  let exiting = false;
  const pendingInputs: string[] = [];
  let resolveExit!: (info: ReplExitInfo) => void;
  const exitPromise = new Promise<ReplExitInfo>((resolve) => {
    resolveExit = resolve;
  });

  const finish = async (reason: ReplExitInfo['reason'], exitCode = 0): Promise<void> => {
    if (exiting) return;
    exiting = true;
    if (state.sessionId && state.running) {
      state.abortRequested = true;
      await client.controls.invoke(program, 'abort', { sessionId: state.sessionId, channel: 'http' }).catch(() => {});
    }
    activeSpinner?.stop();
    activeSpinner = null;
    rl.close();
    renderer.write('  Bye.');
    resolveExit({ reason, sessionId: state.sessionId, finalMode: state.mode, exitCode });
  };

  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: false });
  options.abortSignal?.addEventListener('abort', () => {
    void finish('sigint');
  });

  renderer.write(`\n  ${displayName} — PGAS REPL\n`);

  try {
    await client.programs.list();
  } catch (error) {
    renderer.renderError(renderStartupError(error, apiBase));
    return { reason: 'error', sessionId: null, finalMode: null, exitCode: 1 };
  }

  renderer.renderStep(`Connected  program: ${program}`);
  updatePrompt();

  rl.on('line', (line: string) => {
    const input = line.trim();
    if (!input) {
      updatePrompt();
      return;
    }

    const command = input.startsWith('/') ? input.slice(1).split(' ')[0] : '';
    const isAlwaysAvailable = !!command && ALWAYS_AVAILABLE_COMMANDS.has(command);
    if ((state.running || textBusy || inputBusy) && !isAlwaysAvailable) {
      pendingInputs.push(input);
      return;
    }

    void dispatchInput(input);
  });

  rl.on('SIGINT', () => {
    void finish('sigint');
  });

  rl.on('close', () => {
    if (!exiting) void finish('user_exit');
  });

  function updatePrompt(): void {
    if (!exiting) renderer.renderPrompt(state.mode);
  }

  function dispatchInput(input: string): Promise<void> {
    const isText = !input.startsWith('/');
    const userConfirmation = parseUserConfirmationControl(input);
    if (isText) textBusy = true;
    inputBusy = true;
    const handler = userConfirmation
      ? handleUserConfirmation(userConfirmation)
      : isText
        ? handleText(input)
        : handleCommand(input);
    return handler
      .catch((error) => renderer.renderError(errorMessage(error)))
      .finally(() => {
        if (isText) textBusy = false;
        if (!textBusy) inputBusy = false;
        if (!state.running && !textBusy && !exiting) {
          const next = pendingInputs.shift();
          if (next !== undefined) {
            void dispatchInput(next);
          } else {
            updatePrompt();
          }
        }
      });
  }

  function drainPendingAfterRound(): void {
    if (state.running || inputBusy || textBusy || exiting) return;
    const next = pendingInputs.shift();
    if (next !== undefined) void dispatchInput(next);
  }

  async function handleCommand(input: string): Promise<void> {
    const command = input.slice(1).split(' ')[0] ?? '';
    switch (command) {
      case 'exit':
      case 'quit':
        await finish('user_exit');
        break;
      case 'help':
        renderer.renderInfo(REPL_CONTROL_HINT);
        break;
      case 'new':
        state.sessionId = null;
        state.mode = null;
        renderer.renderStep('Ready — send a message to start a new session.');
        break;
      case 'abort':
        await abortSession();
        break;
      case 'status':
        await renderStatus();
        break;
      case 'history':
        await renderHistory();
        break;
      case 'resume':
        await resumeSession();
        break;
      default:
        renderer.renderError(`Unknown command: /${command}`);
    }
  }

  async function abortSession(): Promise<void> {
    if (!state.sessionId) {
      renderer.renderInfo('No active session.');
      return;
    }

    state.abortRequested = true;
    activeSpinner?.stop();
    activeSpinner = null;
    try {
      await client.controls.invoke(program, 'abort', { sessionId: state.sessionId, channel: 'http' });
      renderer.renderStep('Session aborted.');
    } catch (error) {
      renderer.renderError(`Abort failed: ${errorMessage(error)}`);
    }
    state.sessionId = null;
    state.mode = null;
    state.running = false;
  }

  async function renderStatus(): Promise<void> {
    if (!state.sessionId) {
      renderer.renderInfo('No active session.');
      return;
    }

    try {
      const envelope = await client.sessions.get(state.sessionId);
      state.mode = envelope.mode ?? state.mode;
      state.running = envelope.running === true;
      renderer.renderInfo(
        `session: ${state.sessionId}  status: ${String(envelope.status ?? 'unknown')}  ` +
          `mode: ${String(envelope.mode ?? '?')}  running: ${String(envelope.running === true)}  ` +
          `rounds: ${String(envelope.roundCount ?? 0)}`,
      );
    } catch (error) {
      renderer.renderError(`Status fetch failed: ${errorMessage(error)}`);
    }
  }

  async function renderHistory(): Promise<void> {
    try {
      if (!state.sessionId) {
        const list = await client.sessions.list({ program, limit: 10 });
        if (list.sessions.length === 0) {
          renderer.renderInfo('No prior sessions.');
        } else {
          for (const row of list.sessions) {
            renderer.renderInfo(`${row.sessionId}  ${row.status ?? '?'}  mode: ${row.mode ?? '?'}`);
          }
        }
        return;
      }

      const rounds = ((await client.sessions.rounds(state.sessionId)).rounds ?? []) as Array<{
        number?: number;
        trigger?: string | { channelId?: string };
        result?: { name?: string };
      }>;
      if (rounds.length === 0) {
        renderer.renderInfo('No rounds yet.');
        return;
      }
      for (const round of rounds) {
        const trigger = typeof round.trigger === 'string' ? round.trigger : round.trigger?.channelId ?? '?';
        renderer.renderInfo(
          `round ${String(round.number ?? '?')}  trigger: ${trigger}  action: ${String(round.result?.name ?? '?')}`,
        );
      }
    } catch (error) {
      renderer.renderError(`History fetch failed: ${errorMessage(error)}`);
    }
  }

  async function resumeSession(): Promise<void> {
    try {
      const resume = await client.sessions.resume();
      if (!resume?.sessionId) {
        renderer.renderInfo('No resumable session exists.');
        return;
      }
      const envelope = await client.sessions.get(resume.sessionId);
      state.sessionId = envelope.sessionId;
      state.mode = envelope.mode ?? null;
      state.running = envelope.running === true;
      renderer.renderStep(`Resumed session ${envelope.sessionId} (mode: ${state.mode ?? '?'}).`);
    } catch (error) {
      renderer.renderError(`Resume failed: ${errorMessage(error)}`);
    }
  }

  async function handleText(userText: string): Promise<void> {
    if (!state.sessionId) {
      const created = await client.sessions.create({
        program,
        domain_context: { ...(options.initialDomain ?? {}), query: userText },
      });
      state.sessionId = created.sessionId;
    }
    await runTrigger(state.sessionId, 'user_text', userText);
  }

  async function handleUserConfirmation(payload: UserConfirmationPayload): Promise<void> {
    if (!state.sessionId) {
      renderer.renderInfo('No active session.');
      return;
    }

    await runTrigger(state.sessionId, 'user_confirmation', payload);
  }

  async function runTrigger(sessionId: string, channel: string, payload: unknown): Promise<void> {
    state.running = true;
    state.abortRequested = false;
    const spinner = renderer.startSpinner('Thinking…');
    activeSpinner = spinner;

    try {
      const stream = client.sessions.triggerStream(sessionId, { channel, payload });
      for await (const event of stream as AsyncIterable<ReplStreamEvent>) {
        if (state.abortRequested) break;
        if (event.event === 'step') {
          const step = String((event.data as Record<string, unknown>).step ?? '');
          spinner.update(STEP_LABELS[step] ?? step);
        } else if (event.event === 'round_complete') {
          spinner.stop();
          const result = (event.data as Record<string, unknown>).result ?? event.data;
          renderer.renderAction(result as ActionResult);
          state.running = false;
          updatePrompt();
        } else if (event.event === 'error') {
          spinner.stop();
          renderer.renderError(String((event.data as Record<string, unknown>).message ?? event.data));
          state.running = false;
          updatePrompt();
        }
      }
    } catch (error) {
      if (!state.abortRequested) {
        spinner.stop();
        renderer.renderError(errorMessage(error));
      }
    } finally {
      state.running = false;
      if (activeSpinner === spinner) activeSpinner = null;
      drainPendingAfterRound();
    }
  }

  return exitPromise;
}

function renderStartupError(error: unknown, apiBase: string): string {
  const maybeStatus = error as { status?: number; body?: { error?: string } } | undefined;
  if (typeof maybeStatus?.status === 'number' && (maybeStatus.status === 401 || maybeStatus.status === 403)) {
    return `Authentication failed (HTTP ${String(maybeStatus.status)}). Check PGAS_CLI_TOKEN${
      maybeStatus.body?.error ? `: ${maybeStatus.body.error}` : '.'
    }`;
  }
  if (typeof maybeStatus?.status === 'number' && maybeStatus.status >= 500) {
    return `Server error (HTTP ${String(maybeStatus.status)}) at ${apiBase}.`;
  }
  return `Server not reachable at ${apiBase}. Start it first: npm run dev`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  return String(error);
}

function buildUserConfirmationPayload(
  decision: UserConfirmationPayload['decision'],
  instruction: string | undefined,
): UserConfirmationPayload {
  return instruction === undefined ? { decision } : { decision, instruction };
}
