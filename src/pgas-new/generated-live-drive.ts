/**
 * Generated-program live-drive verification (the fourth verification rung).
 *
 * Gap this closes: runSmokeVerification drives a GENERATED program to its
 * completion stage but hermetically (scripted authorResponses + canned
 * reasoning-contract example), and runLiveProviderVerification is a single
 * provider round trip that never drives a generated program. Before this
 * module there was NO rung where a foundry-generated program was driven to
 * `complete` by a REAL provider making the per-stage/reasoning decisions.
 *
 * The drive boots the rendered standalone scaffold's own program registration
 * on a real `createPgasServer` (the engine's env-configured OpenAI-compatible
 * author driver makes every round's decisions) and pushes entry-channel
 * triggers until the program reaches its completion stage. All provider
 * traffic is routed through an in-process counting proxy so the caller gets
 * tamper-proof evidence that the REAL provider produced the stage decisions
 * (hit count + request/response excerpts) — a canned-fallback pass cannot
 * masquerade as live.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

export interface ProviderExchange {
  path: string;
  response_status: number;
  request_excerpt: string;
  response_excerpt: string;
}

export interface CountingProviderProxy {
  /** OpenAI-compatible base URL (ends with /v1) that forwards to the upstream. */
  url: string;
  /** Successful (HTTP 2xx) chat-completions round trips through the proxy. */
  hits(): number;
  exchanges(): ProviderExchange[];
  close(): Promise<void>;
}

// Request excerpts must be long enough to preserve the native-tools evidence
// fields (`tools`, `tool_choice`, `role:"tool"` feedback messages) that the
// unified-driver live proof asserts on; tool declarations serialize at the
// END of the payload, so a short prefix would silently drop them.
const REQUEST_EXCERPT_LIMIT = 200_000;
const RESPONSE_EXCERPT_LIMIT = 200_000;

export async function startCountingProviderProxy(upstreamBaseUrl: string): Promise<CountingProviderProxy> {
  const upstream = upstreamBaseUrl.replace(/\/+$/u, '');
  const exchanges: ProviderExchange[] = [];

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void (async () => {
        const body = Buffer.concat(chunks);
        const path = req.url ?? '/';
        const target = `${upstream}${path.replace(/^\/v1/u, '')}`;
        try {
          const response = await fetch(target, {
            method: req.method ?? 'POST',
            headers: {
              'content-type': req.headers['content-type'] ?? 'application/json',
              ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
            },
            ...(body.length > 0 ? { body } : {}),
          });
          const text = await response.text();
          if (path.includes('chat/completions')) {
            exchanges.push({
              path,
              response_status: response.status,
              request_excerpt: body.toString('utf8').slice(0, REQUEST_EXCERPT_LIMIT),
              response_excerpt: text.slice(0, RESPONSE_EXCERPT_LIMIT),
            });
          }
          res.statusCode = response.status;
          res.setHeader('content-type', response.headers.get('content-type') ?? 'application/json');
          res.end(text);
        } catch (error) {
          res.statusCode = 502;
          res.end(JSON.stringify({ error: `live-drive proxy upstream failure: ${errorMessage(error)}` }));
        }
      })();
    });
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address !== 'object') {
    throw new Error('live-drive proxy failed to bind a port');
  }

  return {
    url: `http://127.0.0.1:${String(address.port)}/v1`,
    hits: () => exchanges.filter((exchange) => exchange.response_status >= 200 && exchange.response_status < 300).length,
    exchanges: () => [...exchanges],
    close: () => new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise());
    }),
  };
}

export interface GeneratedLiveDriveOptions {
  /** Rendered standalone scaffold root (node_modules present or symlinked). */
  targetDir: string;
  slug: string;
  /** REAL provider base URL (OpenAI-compatible, e.g. http://host:8000/v1). */
  providerBaseUrl: string;
  model: string;
  initialText: string;
  entryChannel?: string;
  finalStage?: string;
  maxTriggers?: number;
  driveTimeoutMs?: number;
  env?: Record<string, string | undefined>;
}

export interface DriveTerminalAction {
  name: string;
  payload_excerpt: string;
}

export interface GeneratedLiveDriveResult {
  final_mode: string | null;
  terminal: boolean;
  rounds: number;
  triggers: number;
  actions: string[];
  terminal_actions: DriveTerminalAction[];
  world: Record<string, unknown>;
  provider_hits: number;
  provider_exchanges: ProviderExchange[];
  /**
   * Which author-driver config the runner actually booted with: 'unified'
   * when the scaffold's resolveAuthorDrivers opted in (PGAS_AUTHOR_DRIVER=
   * unified), 'default' for the engine's legacy JSON author path, null when
   * the runner produced no report.
   */
  author_driver: 'unified' | 'default' | null;
  runner_exit_code: number | null;
  runner_output_excerpt: string;
  runner_error?: string;
}

const DEFAULT_FINAL_STAGE = 'complete';
const DEFAULT_MAX_TRIGGERS = 12;
const DEFAULT_DRIVE_TIMEOUT_MS = 600_000;

export async function driveGeneratedProgramLive(options: GeneratedLiveDriveOptions): Promise<GeneratedLiveDriveResult> {
  const workDir = join(options.targetDir, '.pgas-new-live-drive');
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(join(workDir, 'session-logs'), { recursive: true });
  const runnerPath = join(workDir, 'runner.ts');
  const reportPath = join(workDir, 'report.json');
  const driveTimeoutMs = options.driveTimeoutMs ?? DEFAULT_DRIVE_TIMEOUT_MS;

  const proxy = await startCountingProviderProxy(options.providerBaseUrl);
  try {
    writeFileSync(runnerPath, renderLiveDriveRunnerSource(options.slug));

    const runner = await runNodeScript(runnerPath, {
      cwd: options.targetDir,
      timeoutMs: driveTimeoutMs,
      env: {
        ...process.env,
        ...options.env,
        PGAS_PROVIDER: 'openai',
        PGAS_OPENAI_BASE_URL: proxy.url,
        PGAS_OPENAI_MODEL: options.model,
        PGAS_MODEL: options.model,
        PGAS_OPENAI_API_KEY: process.env.PGAS_OPENAI_API_KEY ?? 'local',
        PGAS_OPENAI_TOOL_CHOICE: process.env.PGAS_OPENAI_TOOL_CHOICE ?? 'required',
        PGAS_OPENAI_DISABLE_THINKING: process.env.PGAS_OPENAI_DISABLE_THINKING ?? '1',
        PGAS_OPENAI_TEMPERATURE: process.env.PGAS_OPENAI_TEMPERATURE ?? '0.2',
        PGAS_DB: join(workDir, 'live-drive.db'),
        PGAS_SESSION_LOG_DIR: join(workDir, 'session-logs'),
        PGAS_LIVE_DRIVE_REPORT: reportPath,
        PGAS_LIVE_DRIVE_ENTRY_CHANNEL: options.entryChannel ?? 'user_text',
        PGAS_LIVE_DRIVE_INITIAL_TEXT: options.initialText,
        PGAS_LIVE_DRIVE_FINAL_STAGE: options.finalStage ?? DEFAULT_FINAL_STAGE,
        PGAS_LIVE_DRIVE_MAX_TRIGGERS: String(options.maxTriggers ?? DEFAULT_MAX_TRIGGERS),
        PGAS_LIVE_DRIVE_TIMEOUT_MS: String(Math.max(driveTimeoutMs - 30_000, 60_000)),
      },
    });

    const report = readDriveReport(reportPath);
    return {
      final_mode: typeof report?.final_mode === 'string' ? report.final_mode : null,
      terminal: report?.terminal === true,
      rounds: typeof report?.rounds === 'number' ? report.rounds : 0,
      triggers: typeof report?.triggers === 'number' ? report.triggers : 0,
      actions: Array.isArray(report?.actions) ? report.actions.filter(isNonEmptyString) : [],
      terminal_actions: parseTerminalActions(report?.terminal_actions),
      world: isRecord(report?.world) ? report.world : {},
      provider_hits: proxy.hits(),
      provider_exchanges: proxy.exchanges(),
      author_driver: report?.author_driver === 'unified' || report?.author_driver === 'default'
        ? report.author_driver
        : null,
      runner_exit_code: runner.exitCode,
      runner_output_excerpt: runner.output.slice(-4_000),
      ...(typeof report?.error === 'string' ? { runner_error: report.error } : {}),
    };
  } finally {
    await proxy.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * The runner executes INSIDE the rendered scaffold (cwd = targetDir) via
 * `node --import tsx`, so it resolves the scaffold's own dependencies and
 * imports the generated program registration exactly as the scaffold's
 * production server does. It boots a real engine (no scripted authorResponses,
 * no stub drivers — the env-configured provider makes every decision) and
 * drives the session to the completion stage over the entry channel.
 */
function renderLiveDriveRunnerSource(slug: string): string {
  const pascal = toPascalCase(slug);
  return `import { writeFileSync } from 'node:fs';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import { appTransport, createPgasClient, type PgasClient } from '@simodelne/pgas-server/client.js';
import { create${pascal}ProgramEntry } from '../src/programs/${slug}/registration.js';

const REPORT_PATH = process.env.PGAS_LIVE_DRIVE_REPORT ?? '';
const ENTRY_CHANNEL = process.env.PGAS_LIVE_DRIVE_ENTRY_CHANNEL ?? 'user_text';
const INITIAL_TEXT = process.env.PGAS_LIVE_DRIVE_INITIAL_TEXT ?? 'start generated live drive';
const FINAL_STAGE = process.env.PGAS_LIVE_DRIVE_FINAL_STAGE ?? 'complete';
const MAX_TRIGGERS = Number(process.env.PGAS_LIVE_DRIVE_MAX_TRIGGERS ?? '12');
const DEADLINE = Date.now() + Number(process.env.PGAS_LIVE_DRIVE_TIMEOUT_MS ?? '540000');

interface DriveState {
  mode: string | null;
  terminal: boolean;
  roundCount: number;
  world: Record<string, unknown>;
  actions: string[];
  terminalActions: Array<{ name: string; payload_excerpt: string }>;
}

async function main(): Promise<void> {
  // Opt-in unified native-tools author driver: mirrors the rendered scaffold's
  // src/server.ts gating. Default (PGAS_AUTHOR_DRIVER unset) boots the engine's
  // legacy JSON author path exactly as before; the dynamic import keeps the
  // default path byte-identical even against a scaffold without the module.
  let drivers: Parameters<typeof createPgasServer>[0]['drivers'];
  if ((process.env.PGAS_AUTHOR_DRIVER ?? '').trim().toLowerCase() === 'unified') {
    const authorDriver = await import('../src/author-driver.js');
    drivers = authorDriver.resolveAuthorDrivers();
  }
  const server = await createPgasServer({
    programs: [{ name: '${slug}', entry: create${pascal}ProgramEntry() }],
    devMode: true,
    ...(drivers ? { drivers } : {}),
  });
  const client = createPgasClient(appTransport(server.app, { token: 'dev-token' }));
  const created = await client.sessions.create({
    program: '${slug}',
    domain_context: { query: INITIAL_TEXT },
  });
  const sessionId = created.sessionId;

  let payloadText = INITIAL_TEXT;
  let triggers = 0;
  let state = await readState(client, sessionId);
  while (state.mode !== FINAL_STAGE && !state.terminal && triggers < MAX_TRIGGERS && Date.now() < DEADLINE) {
    const before = state.roundCount;
    try {
      await client.sessions.trigger(sessionId, { channel: ENTRY_CHANNEL, payload: payloadText });
    } catch (error) {
      if (/terminal/iu.test(String(error))) break;
      throw error;
    }
    triggers += 1;
    payloadText = 'Continue to the next stage of the workflow.';
    state = await waitForRound(client, sessionId, before);
  }

  state = await readState(client, sessionId);
  writeReport({
    final_mode: state.mode,
    terminal: state.terminal,
    rounds: state.roundCount,
    triggers,
    actions: state.actions,
    terminal_actions: state.terminalActions,
    world: state.world,
    author_driver: drivers ? 'unified' : 'default',
  });
  process.exit(0);
}

async function waitForRound(client: PgasClient, sessionId: string, before: number): Promise<DriveState> {
  let latest = await readState(client, sessionId);
  while (latest.roundCount <= before && !latest.terminal && Date.now() < DEADLINE) {
    await sleep(1_000);
    latest = await readState(client, sessionId);
  }
  return latest;
}

async function readState(client: PgasClient, sessionId: string): Promise<DriveState> {
  const [envelope, worldResponse, roundsResponse] = await Promise.all([
    client.sessions.get(sessionId),
    client.sessions.world(sessionId),
    client.sessions.rounds(sessionId),
  ]);
  const rounds = Array.isArray(roundsResponse.rounds) ? roundsResponse.rounds : [];
  const status = typeof envelope.status === 'string' ? envelope.status : '';
  const stateRecord = envelope.state as Record<string, unknown> | undefined;
  const mode = firstString(envelope.mode, stateRecord?.mode);
  const terminalActions = rounds.flatMap((round) => terminalActionOf(round));
  return {
    mode,
    terminal: Boolean(stateRecord?.terminal ?? envelope.terminal) || status.toLowerCase() === 'completed',
    roundCount: rounds.length,
    world: worldResponse.domain as Record<string, unknown>,
    actions: terminalActions.map((action) => action.name),
    terminalActions,
  };
}

function terminalActionOf(round: unknown): Array<{ name: string; payload_excerpt: string }> {
  if (!round || typeof round !== 'object' || Array.isArray(round)) return [];
  const result = (round as { result?: unknown }).result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
  const terminal = (result as { terminal?: unknown }).terminal;
  if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)) return [];
  const name = (terminal as { name?: unknown }).name;
  if (typeof name !== 'string' || name.length === 0) return [];
  const payload = (terminal as { payload?: unknown }).payload;
  return [{ name, payload_excerpt: JSON.stringify(payload ?? null).slice(0, 4_000) }];
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function writeReport(report: Record<string, unknown>): void {
  if (REPORT_PATH.length > 0) {
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error: unknown) => {
  writeReport({ error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
  process.exit(1);
});
`;
}

interface RunnerOutcome {
  exitCode: number | null;
  output: string;
}

function runNodeScript(
  scriptPath: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<RunnerOutcome> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ['--import', 'tsx', scriptPath], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const record = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      if (output.length > 100_000) {
        output = output.slice(-100_000);
      }
    };
    child.stdout.on('data', record);
    child.stderr.on('data', record);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, options.timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code, output });
    });
  });
}

interface DriveReport {
  final_mode?: unknown;
  terminal?: unknown;
  rounds?: unknown;
  triggers?: unknown;
  actions?: unknown[];
  terminal_actions?: unknown;
  world?: unknown;
  author_driver?: unknown;
  error?: unknown;
}

function readDriveReport(reportPath: string): (DriveReport & { world?: Record<string, unknown> }) | undefined {
  try {
    const parsed = JSON.parse(readFileSync(reportPath, 'utf8')) as unknown;
    return isRecord(parsed) ? (parsed as DriveReport & { world?: Record<string, unknown> }) : undefined;
  } catch {
    return undefined;
  }
}

function parseTerminalActions(value: unknown): DriveTerminalAction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.name !== 'string') return [];
    return [{
      name: entry.name,
      payload_excerpt: typeof entry.payload_excerpt === 'string' ? entry.payload_excerpt : '',
    }];
  });
}

function toPascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join('');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
