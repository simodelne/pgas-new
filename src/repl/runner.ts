import { isRecord } from '../util/guards.js';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { createPgasClient, fetchTransport } from '@simodelne/pgas-server/client.js';
import { decodeJwtExp } from './auth-token.js';
import { createReplRenderer, REPL_CONTROL_HINT } from './renderer.js';
import type { ActionResult, ReplExitInfo, ReplOptions, ReplState, ReplStreamEvent } from './types.js';

const STEP_LABELS: Record<string, string> = {
  ingestion: 'reading context…',
  projection: 'projecting state…',
  authorship: 'drafting response…',
  recognition: 'validating action…',
  execution: 'applying action…',
};

const ALWAYS_AVAILABLE_COMMANDS = new Set(['abort', 'approve', 'exit', 'help', 'history', 'quit', 'reject', 'status']);
const CONTROL_IDLE_POLL_INTERVAL_MS = 250;
const CONTROL_IDLE_TIMEOUT_MS = 120_000;

// Transient-round recovery (issue #77): a transport `fetch failed` blip or an
// engine-signalled recoverable round cancellation (server_shutdown /
// transient_error — the session is left Running with retryable:true) must not
// surface as a hard error that leaves the REPL idle. Because the engine keeps
// the session Running, re-triggering the same round resumes it. We retry the
// in-flight trigger a bounded number of times with backoff before giving up.
const TRANSIENT_ROUND_RETRY_LIMIT = 3;
const TRANSIENT_ROUND_RETRY_BASE_DELAY_MS = 500;
const TRANSIENT_ROUND_RETRY_MAX_DELAY_MS = 4_000;
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
const ENABLE_BRACKETED_PASTE = '\x1b[?2004h';
const DISABLE_BRACKETED_PASTE = '\x1b[?2004l';

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
  const program = options.program ?? options.slug ?? 'pgas-new';
  const displayName = options.programDisplayName ?? program;
  const tty = Boolean((stdin as NodeJS.ReadStream).isTTY) && Boolean((stdout as NodeJS.WriteStream).isTTY);
  const renderer = createReplRenderer(stdout, { tty });
  const token = options.token ?? readActiveCachedToken();
  if (token === undefined) {
    renderer.renderError('no active session — run `pgas-new login`');
    return { reason: 'error', sessionId: null, finalMode: null, exitCode: 1 };
  }
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
  let bracketedPasteActive = false;
  let bracketedPasteBuffer = '';
  let bracketedPasteLineSuppressions = 0;
  let bracketedPasteModeEnabled = false;
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
    stdin.off('data', handleBracketedPasteData);
    if (bracketedPasteModeEnabled) {
      stdout.write(DISABLE_BRACKETED_PASTE);
      bracketedPasteModeEnabled = false;
    }
    rl.close();
    renderer.renderGoodbye(state.sessionId, state.mode);
    resolveExit({ reason, sessionId: state.sessionId, finalMode: state.mode, exitCode });
  };

  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: tty });
  options.abortSignal?.addEventListener('abort', () => {
    void finish('sigint');
  });

  renderer.renderBanner(displayName, resolvePackageVersion());

  try {
    await client.programs.list();
  } catch (error) {
    renderer.renderError(isUnauthorizedError(error) ? 'session expired, re-run `pgas-new login`' : renderStartupError(error, apiBase));
    return { reason: 'error', sessionId: null, finalMode: null, exitCode: 1 };
  }

  if (tty) {
    stdout.write(ENABLE_BRACKETED_PASTE);
    bracketedPasteModeEnabled = true;
  }
  renderer.renderStep(`Connected to ${apiBase} · program ${program}`);
  updatePrompt();
  stdin.prependListener('data', handleBracketedPasteData);

  rl.on('line', (line: string) => {
    if (bracketedPasteLineSuppressions > 0) {
      bracketedPasteLineSuppressions -= 1;
      return;
    }
    if (bracketedPasteActive || line.includes(BRACKETED_PASTE_START) || line.includes(BRACKETED_PASTE_END)) {
      return;
    }

    submitInput(line.trim());
  });

  function submitInput(input: string): void {
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
  }

  function handleBracketedPasteData(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (!bracketedPasteActive && !text.includes(BRACKETED_PASTE_START)) {
      return;
    }

    consumeBracketedPasteText(text);
  }

  function consumeBracketedPasteText(text: string): void {
    let rest = text;
    while (rest.length > 0) {
      if (!bracketedPasteActive) {
        const startIndex = rest.indexOf(BRACKETED_PASTE_START);
        if (startIndex < 0) return;
        bracketedPasteActive = true;
        bracketedPasteBuffer = '';
        rest = rest.slice(startIndex + BRACKETED_PASTE_START.length);
      }

      const endIndex = rest.indexOf(BRACKETED_PASTE_END);
      if (endIndex < 0) {
        bracketedPasteBuffer += rest;
        return;
      }

      bracketedPasteBuffer += rest.slice(0, endIndex);
      bracketedPasteLineSuppressions += countReadlineLinesForBracketedPaste(bracketedPasteBuffer);
      const pastedInput = normalizeBracketedPaste(bracketedPasteBuffer);
      bracketedPasteActive = false;
      bracketedPasteBuffer = '';
      if (pastedInput.length > 0) {
        submitInput(pastedInput);
      } else {
        updatePrompt();
      }
      rest = rest.slice(endIndex + BRACKETED_PASTE_END.length);
    }
  }

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
    const isUserConfirmation = userConfirmation !== null;
    if (isText) textBusy = true;
    if (!isUserConfirmation) inputBusy = true;
    const handler = userConfirmation
      ? handleUserConfirmation(userConfirmation)
      : isText
        ? handleText(input)
        : handleCommand(input);
    return handler
      .catch(async (error) => {
        if (isUnauthorizedError(error)) {
          renderer.renderError('session expired, re-run `pgas-new login`');
          await finish('error', 1);
          return;
        }
        renderer.renderError(errorMessage(error));
      })
      .finally(() => {
        if (isText) textBusy = false;
        if (!textBusy && !isUserConfirmation) inputBusy = false;
        if (state.abortRequested) {
          pendingInputs.length = 0;
        }
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
    if (state.abortRequested) {
      pendingInputs.length = 0;
      return;
    }
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
    pendingInputs.length = 0;
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
    pendingInputs.length = 0;
  }

  async function renderStatus(): Promise<void> {
    if (!state.sessionId) {
      renderer.renderInfo('No active session.');
      return;
    }

    try {
      const envelope = await client.sessions.get(state.sessionId);
      const live = readLiveSessionFields(envelope);
      state.mode = live.mode ?? state.mode;
      renderer.renderInfo(
        `session: ${state.sessionId}  status: ${String(envelope.status ?? 'unknown')}  ` +
          `mode: ${String(live.mode ?? '?')}  running: ${String(live.running === true)}  ` +
          `rounds: ${String(live.roundCount ?? 0)}`,
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
      const live = readLiveSessionFields(envelope);
      state.sessionId = envelope.sessionId;
      state.mode = live.mode ?? null;
      state.running = false;
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

    // #69 trap guard: scaffold_plan has no `user_text` channel — it only
    // accepts a user_confirmation (approve/reject). Firing a doomed user_text
    // trigger there produces a __fallback__ round with no mutation and can
    // leave the session stuck at a draft artifact plan. Any plain text the user
    // types at the artifact-plan gate is rejection/revision feedback, so route
    // it through the rejection control (equivalent to `/reject <text>`) rather
    // than a doomed user_text turn. `/approve` and `/reject` remain the
    // explicit paths.
    if (isArtifactPlanGateMode(state.mode)) {
      renderer.renderInfo(
        'At the artifact-plan gate: treating your message as revision feedback (/reject). Type /approve to accept the plan.',
      );
      await handleUserConfirmation({ decision: 'reject', instruction: userText });
      return;
    }

    // Generalized user_text channel guard. In the foundry spec
    // (src/foundry-program/specs.yml) only intake_intelligence declares a
    // `user_text` channel; every other mode advances via system_mode_entry
    // auto-continuation, widget_output, or user_confirmation (/approve,
    // /reject). Firing a user_text trigger at a mode that does not declare the
    // channel is a doomed round — and in repo_targeting it crashes the engine
    // with a raw `Cannot read properties of undefined (reading 'replace')`
    // TypeError (surfaced during live UAT 2026-07-13). Only send user_text
    // where the spec accepts it; otherwise guide the user to the real controls.
    // (state.mode === null means no session yet — the first message legitimately
    // starts intake_intelligence, so it must pass through.)
    if (state.mode !== null && !modeAcceptsUserText(state.mode)) {
      renderer.renderInfo(
        `The '${state.mode}' step does not take free text — it proceeds automatically or via /approve, /reject, or /status.`,
      );
      updatePrompt();
      return;
    }

    await runTrigger(state.sessionId, 'user_text', userText);
  }

  async function handleUserConfirmation(payload: UserConfirmationPayload): Promise<void> {
    if (!state.sessionId) {
      renderer.renderInfo('No active session.');
      return;
    }

    if (payload.decision === 'approve') {
      await invokeSessionControl(resolveApproveControlForMode(state.mode));
      return;
    }

    await refreshLiveState();
    if (state.mode === 'scaffold_plan') {
      await invokeSessionControl('revise_artifact_plan', payload.instruction ? { instruction: payload.instruction } : undefined);
      return;
    }

    const questionNumber = parseRejectQuestionNumber(payload.instruction);
    if (questionNumber === null) {
      renderer.renderError('/reject must name Q1, Q2, Q3, Q4, Q5, or Q6.');
      return;
    }

    await invokeSessionControl(`reject_design_and_revise_q${String(questionNumber)}`, {
      instruction: payload.instruction ?? '',
    });
  }

  async function invokeSessionControl(controlId: string, args?: Record<string, unknown>): Promise<void> {
    if (!state.sessionId) {
      renderer.renderInfo('No active session.');
      return;
    }

    await client.controls.invoke(program, controlId, {
      sessionId: state.sessionId,
      channel: 'http',
      ...(args && Object.keys(args).length > 0 ? { args } : {}),
    });
    await waitForSessionRoundSettleAfterControl();
  }

  async function refreshLiveState(): Promise<ReturnType<typeof readLiveSessionFields> | null> {
    if (!state.sessionId) return null;

    try {
      const envelope = await client.sessions.get(state.sessionId);
      const live = readLiveSessionFields(envelope);
      const nextMode = live.mode ?? state.mode;
      if (nextMode && nextMode !== state.mode) {
        state.mode = nextMode;
        renderer.renderModeChange(nextMode);
      } else {
        state.mode = nextMode;
      }
      return live;
    } catch {
      // Controls are already committed; a status refresh failure should not
      // turn an accepted slash command into a user-facing error.
      return null;
    }
  }

  async function waitForSessionRoundSettleAfterControl(): Promise<void> {
    const deadline = Date.now() + CONTROL_IDLE_TIMEOUT_MS;
    let lastRoundCount: number | null = null;
    let stableRoundPolls = 0;

    do {
      const live = await refreshLiveState();
      if (exiting) return;
      if (live) {
        if (live.roundCount === lastRoundCount) {
          stableRoundPolls += 1;
        } else {
          lastRoundCount = live.roundCount;
          stableRoundPolls = 0;
        }
        if (stableRoundPolls >= 1) return;
      }
      await sleep(CONTROL_IDLE_POLL_INTERVAL_MS);
    } while (Date.now() < deadline);
  }

  async function runTrigger(sessionId: string, channel: string, payload: unknown): Promise<void> {
    state.running = true;
    state.abortRequested = false;
    const spinner = renderer.startSpinner('Thinking…');
    activeSpinner = spinner;

    try {
      // Issue #77: the round may be cancelled by a transient transport blip
      // (Qwen HTTP `fetch failed`) or an engine `round_cancelled_shutdown`
      // that leaves the session Running (retryable). Re-trigger the same round
      // up to TRANSIENT_ROUND_RETRY_LIMIT times before surfacing a hard error.
      for (let attempt = 0; ; attempt += 1) {
        const outcome = await streamRoundOnce(sessionId, channel, payload, spinner);
        if (outcome.status === 'unauthorized') {
          spinner.stop();
          renderer.renderError('session expired, re-run `pgas-new login`');
          await finish('error', 1);
          return;
        }
        if (outcome.status === 'transient' && !state.abortRequested && attempt < TRANSIENT_ROUND_RETRY_LIMIT) {
          const delay = Math.min(
            TRANSIENT_ROUND_RETRY_MAX_DELAY_MS,
            TRANSIENT_ROUND_RETRY_BASE_DELAY_MS * 2 ** attempt,
          );
          renderer.renderInfo(
            `transient issue (${outcome.detail}) — retrying round (attempt ${String(attempt + 2)}/${String(
              TRANSIENT_ROUND_RETRY_LIMIT + 1,
            )})…`,
          );
          await sleep(delay);
          spinner.update('Reconnecting…');
          continue;
        }
        if (outcome.status === 'transient' && !state.abortRequested) {
          // Retries exhausted: surface a recoverable-session hint rather than a
          // bare error so the user knows the session is not terminally failed.
          spinner.stop();
          renderer.renderError(
            `transient issue persisted (${outcome.detail}); the session is still recoverable — retry your last input or use /resume.`,
          );
          state.running = false;
          updatePrompt();
        } else if (outcome.status === 'error' && !state.abortRequested) {
          spinner.stop();
          renderer.renderError(outcome.detail);
          state.running = false;
          updatePrompt();
        }
        break;
      }
    } finally {
      state.running = false;
      if (activeSpinner === spinner) activeSpinner = null;
      drainPendingAfterRound();
    }
  }

  /**
   * Runs a single trigger-stream attempt. Returns a classified outcome so the
   * caller can decide whether to transparently retry a transient/recoverable
   * cancellation (issue #77) or surface a hard error.
   */
  async function streamRoundOnce(
    sessionId: string,
    channel: string,
    payload: unknown,
    spinner: { update(message: string): void; stop(): void },
  ): Promise<RoundOutcome> {
    try {
      const stream = client.sessions.triggerStream(sessionId, { channel, payload });
      for await (const event of stream as AsyncIterable<ReplStreamEvent>) {
        if (state.abortRequested) return { status: 'aborted' };
        if (event.event === 'step') {
          const step = String((event.data as Record<string, unknown>).step ?? '');
          spinner.update(STEP_LABELS[step] ?? step);
        } else if (event.event === 'round_complete') {
          spinner.stop();
          const result = (event.data as Record<string, unknown>).result ?? event.data;
          renderer.renderAction(result as ActionResult);
          state.running = false;
          updatePrompt();
          return { status: 'complete' };
        } else if (event.event === 'error') {
          const data = (event.data ?? {}) as Record<string, unknown>;
          const message = String(data.message ?? event.data);
          // Observability: the server's error event may carry more than a bare
          // message (a `detail`/`stack` in dev). The REPL previously kept only
          // `message`, which reduced raw engine TypeErrors to a single line and
          // hid the failing boundary during UAT. Surface any extra detail, and
          // dump the full event under PGAS_REPL_DEBUG for root-causing.
          if (process.env.PGAS_REPL_DEBUG === '1') {
            console.error('[pgas-repl] round error event:', JSON.stringify(data));
          }
          if (isRecoverableRoundError(data)) {
            return { status: 'transient', detail: recoverableDetail(data) };
          }
          const extra = errorEventDetail(data);
          return { status: 'error', detail: extra ? `${message}\n${extra}` : message };
        }
      }
      // Stream ended without a round_complete or error event: the transport
      // was dropped mid-round (transient). The session remains recoverable.
      return state.abortRequested
        ? { status: 'aborted' }
        : { status: 'transient', detail: 'stream ended early' };
    } catch (error) {
      if (state.abortRequested) return { status: 'aborted' };
      if (isUnauthorizedError(error)) return { status: 'unauthorized' };
      if (isTransientTransportError(error)) {
        return { status: 'transient', detail: transientDetail(error) };
      }
      return { status: 'error', detail: errorMessage(error) };
    }
  }

  return exitPromise;
}

let cachedPackageVersion: string | undefined;
function resolvePackageVersion(): string {
  if (cachedPackageVersion !== undefined) return cachedPackageVersion;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const candidate of [join(here, '..', '..', 'package.json'), join(here, '..', '..', '..', 'package.json')]) {
      if (!existsSync(candidate)) continue;
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string; version?: string };
      if (pkg.name === 'pgas-new' && typeof pkg.version === 'string') {
        cachedPackageVersion = pkg.version;
        return pkg.version;
      }
    }
  } catch {
    // fall through
  }
  cachedPackageVersion = '0.0.0';
  return cachedPackageVersion;
}

function readActiveCachedToken(): string | undefined {
  const tokenPath = join(process.env.HOME?.trim() || homedir(), '.local/share/pgas-new/token');
  if (!existsSync(tokenPath)) return undefined;

  const token = readFileSync(tokenPath, 'utf8').trim();
  if (token.length === 0) return undefined;
  const exp = decodeJwtExp(token);
  if (exp === undefined || exp <= Math.floor(Date.now() / 1000)) return undefined;
  return token;
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

// Pull any extra detail the server attached to an error event beyond `message`
// (a `detail`/`stack`/`cause` string in dev builds). Returns null when there is
// nothing more than the message, so the caller can show just the message.
function errorEventDetail(data: Record<string, unknown>): string | null {
  const candidate = data.detail ?? data.stack ?? data.cause;
  if (typeof candidate === 'string' && candidate.length > 0 && candidate !== data.message) {
    return candidate;
  }
  return null;
}

function isUnauthorizedError(error: unknown): boolean {
  const maybeStatus = error as { status?: unknown } | undefined;
  return maybeStatus?.status === 401;
}

/**
 * Classified result of a single trigger-stream attempt. `transient` means the
 * round was cancelled/dropped in a way the engine left recoverable (session
 * still Running) — the caller may re-trigger it. See issue #77.
 */
type RoundOutcome =
  | { status: 'complete' }
  | { status: 'aborted' }
  | { status: 'unauthorized' }
  | { status: 'transient'; detail: string }
  | { status: 'error'; detail: string };

// Engine error `kind`s that leave the session Running / recoverable and are
// therefore safe to re-trigger. Mirrors the notifications emitted by
// @simodelne/pgas-server on RoundCancelledError / transient round failure
// (kind: round_cancelled | transient_error, retryable: true).
const RECOVERABLE_ERROR_KINDS = new Set(['round_cancelled', 'transient_error']);

// Substrings that identify a transient transport failure (network/HTTP blip)
// as opposed to a genuine application error. Undici surfaces a dropped fetch
// as `TypeError: fetch failed`; socket-level drops carry these codes.
const TRANSIENT_TRANSPORT_MARKERS = [
  'fetch failed',
  'econnreset',
  'econnrefused',
  'etimedout',
  'enetunreach',
  'socket hang up',
  'network',
  'terminated',
];

function isRecoverableRoundError(data: Record<string, unknown>): boolean {
  if (data.retryable === true) return true;
  const kind = typeof data.kind === 'string' ? data.kind : undefined;
  return kind !== undefined && RECOVERABLE_ERROR_KINDS.has(kind);
}

function recoverableDetail(data: Record<string, unknown>): string {
  const kind = typeof data.kind === 'string' ? data.kind : undefined;
  if (kind !== undefined) return kind;
  const message = typeof data.message === 'string' ? data.message : undefined;
  return message ?? 'recoverable round cancellation';
}

function isTransientTransportError(error: unknown): boolean {
  // A PgasApiError the server explicitly marked retryable (e.g. a 503 with
  // retryable:true) is transient regardless of message text.
  const record = error as { retryable?: unknown; kind?: unknown; status?: unknown } | undefined;
  if (record?.retryable === true) return true;
  if (typeof record?.kind === 'string' && RECOVERABLE_ERROR_KINDS.has(record.kind)) return true;
  // 5xx responses from the round dispatch are transient; 4xx (except 401 which
  // is handled separately) are client errors and not retried here.
  if (typeof record?.status === 'number' && record.status >= 500) return true;

  const haystack = collectErrorText(error).toLowerCase();
  return TRANSIENT_TRANSPORT_MARKERS.some((marker) => haystack.includes(marker));
}

function transientDetail(error: unknown): string {
  const record = error as { code?: unknown } | undefined;
  if (typeof record?.code === 'string' && record.code.length > 0) return record.code;
  const message = errorMessage(error);
  return message.length > 0 ? message : 'transport failure';
}

function collectErrorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  // Walk the Error.cause chain (undici nests the socket error under `cause`).
  for (let depth = 0; depth < 5 && current != null; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message);
      const code = (current as { code?: unknown }).code;
      if (typeof code === 'string') parts.push(code);
      current = (current as { cause?: unknown }).cause;
    } else if (typeof current === 'string') {
      parts.push(current);
      current = undefined;
    } else {
      const record = current as { message?: unknown; code?: unknown; cause?: unknown };
      if (typeof record.message === 'string') parts.push(record.message);
      if (typeof record.code === 'string') parts.push(record.code);
      current = record.cause;
    }
  }
  return parts.join(' ');
}

function readLiveSessionFields(envelope: Record<string, unknown>): {
  mode: string | null;
  running: boolean;
  roundCount: number;
} {
  const liveState = isRecord(envelope.state) ? envelope.state : {};
  const rounds = Array.isArray(liveState.rounds) ? liveState.rounds.length : undefined;
  return {
    mode: stringField(liveState.mode) ?? stringField(envelope.mode) ?? null,
    running: booleanField(liveState.running) ?? booleanField(envelope.running) ?? false,
    roundCount:
      rounds
      ?? numberField(liveState.roundCount)
      ?? numberField(envelope.roundCount)
      ?? numberField(liveState.currentRoundNumber)
      ?? 0,
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildUserConfirmationPayload(
  decision: UserConfirmationPayload['decision'],
  instruction: string | undefined,
): UserConfirmationPayload {
  return instruction === undefined ? { decision } : { decision, instruction };
}

/**
 * #69: modes whose only user-driven trigger is a `user_confirmation`
 * (approve/reject) and which do NOT declare a `user_text` channel. Firing a
 * plain `user_text` trigger in one of these traps the session in a
 * `__fallback__` round. `scaffold_plan` gates on approve/reject of the drafted
 * artifact plan.
 */
export function isArtifactPlanGateMode(mode: string | null): boolean {
  return mode === 'scaffold_plan';
}

// Modes whose spec (src/foundry-program/specs.yml) declares a `user_text`
// channel. Only intake_intelligence (the six-question design interview) does;
// every other mode is auto-continuation / widget / confirmation driven. Kept as
// an explicit set so a future spec change that adds user_text to another mode is
// a single, visible edit here. See the generalized guard in dispatch (handleText).
const USER_TEXT_MODES = new Set(['intake_intelligence']);

export function modeAcceptsUserText(mode: string | null): boolean {
  return mode !== null && USER_TEXT_MODES.has(mode);
}

function parseRejectQuestionNumber(instruction: string | undefined): number | null {
  const match = /\bq([1-6])\b/iu.exec(instruction ?? '');
  return match ? Number(match[1]) : null;
}

function normalizeBracketedPaste(value: string): string {
  return value.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n').trim();
}

function countReadlineLinesForBracketedPaste(value: string): number {
  const normalized = value.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
  if (normalized.length === 0) {
    return 1;
  }
  const newlineCount = (normalized.match(/\n/gu) ?? []).length;
  return normalized.endsWith('\n') ? newlineCount : newlineCount + 1;
}

/**
 * Maps the current foundry mode to the correct `/approve` control action.
 * Each mode that gates on user_confirmation has its own approval action
 * — using a single action regardless of mode fails the engine's
 * precondition check, the trigger falls through to an LLM round, and
 * Qwen has been observed to pick a different tool (record_note) instead
 * of the expected confirm action.
 *
 * See §10 Scenario A blocker at HEAD `51eef801` (Phase 5 v2 §10 rerun):
 * `/approve` after `record_program_intake_finalize` invoked
 * `approve_artifact_plan`, whose preconditions are not yet satisfiable
 * in `intake_intelligence` mode (artifact_plan.status is not 'draft'
 * until `plan_artifacts` runs in `scaffold_plan`), causing the engine
 * to fall back to a user_confirmation LLM round where Qwen emitted
 * `record_note` (.uat/session-logs-current/pgas-new-1782230910268/session-log.ndjson:465-476).
 */
export function resolveApproveControlForMode(mode: string | null): string {
  switch (mode) {
    case 'intake_intelligence':
      return 'confirm_design';
    case 'scaffold_plan':
      return 'approve_artifact_plan';
    default:
      // Modes without a registered confirmation control fall back to
      // approve_artifact_plan; the engine will reject if not applicable
      // and surface a clear error rather than misroute the action.
      return 'approve_artifact_plan';
  }
}
