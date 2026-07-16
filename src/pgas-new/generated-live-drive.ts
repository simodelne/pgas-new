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
import type { SynthesisContext } from '../foundry-program/synthesizer-store.js';

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
  confirmationScript?: GeneratedLiveDriveConfirmationScript;
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
  status_history: GeneratedLiveDriveStatusHistoryEntry[];
  choreography: GeneratedLiveDriveChoreographyVerdict;
  runner_exit_code: number | null;
  runner_output_excerpt: string;
  runner_error?: string;
}

const DEFAULT_FINAL_STAGE = 'complete';
const DEFAULT_MAX_TRIGGERS = 12;
const DEFAULT_DRIVE_TIMEOUT_MS = 600_000;

type ConfirmationLoopDescriptorForScript = NonNullable<NonNullable<SynthesisContext['interaction']>['confirmation_loops']>[number];
type CollectionLifecycleForScript = NonNullable<SynthesisContext['completion']['collection_lifecycle']>;

export interface GeneratedLiveDriveScriptDecision {
  decision: string;
  instruction?: string;
}

export interface GeneratedLiveDriveConfirmationScript {
  channel: string;
  itemsPath: string;
  statusField: string;
  proposedStatus: string;
  decisionField?: string;
  instructionField?: string;
  fallbackDecision: string;
  decisions: GeneratedLiveDriveScriptDecision[];
  decisionTable: Record<string, string>;
  terminalStatuses: string[];
}

export interface GeneratedLiveDriveStatusItem {
  index: number;
  id?: string;
  title?: string;
  status: string | null;
}

export interface GeneratedLiveDriveStatusHistoryEntry {
  round: number;
  items: GeneratedLiveDriveStatusItem[];
  decision?: {
    index: number;
    decision: string;
    instruction?: string;
  };
}

export interface GeneratedLiveDriveChoreographyVerdict {
  decision_table_respected: boolean;
  one_proposed_invariant_held: boolean;
  proposed_overlap_max: number;
  items_seen_max: number;
  decisions_applied: number;
  terminal_items_final: number;
  loop_engaged: boolean;
  provider_hits_ok: boolean;
  notes: string[];
}

export function deriveConfirmationScript(
  descriptor: ConfirmationLoopDescriptorForScript,
  cannedOrder: readonly (string | GeneratedLiveDriveScriptDecision)[],
  lifecycle?: CollectionLifecycleForScript,
): GeneratedLiveDriveConfirmationScript {
  const decisionTable = Object.fromEntries(
    Object.entries(descriptor.decisions).map(([decision, config]) => [decision, config.to]),
  );
  const declaredDecisions = new Set(Object.keys(decisionTable));
  const decisions = cannedOrder.flatMap((entry) => {
    const decision = typeof entry === 'string' ? { decision: entry } : entry;
    return declaredDecisions.has(decision.decision)
      ? [{ decision: decision.decision, ...(decision.instruction ? { instruction: decision.instruction } : {}) }]
      : [];
  });
  return {
    channel: 'user_confirmation',
    itemsPath: lifecycle?.storage.items_path ?? descriptor.collection,
    statusField: lifecycle?.item.status_field ?? descriptorStatusField(descriptor) ?? 'status',
    proposedStatus: descriptor.proposed_status,
    decisionField: 'inputs.user_decision.decision',
    instructionField: 'inputs.user_decision.instruction',
    fallbackDecision: 'approve',
    decisions,
    decisionTable,
    terminalStatuses: [...descriptor.aggregate.terminal_statuses],
  };
}

export function assessChoreography(
  history: readonly GeneratedLiveDriveStatusHistoryEntry[],
  script: GeneratedLiveDriveConfirmationScript,
  providerHits = 1,
): GeneratedLiveDriveChoreographyVerdict {
  const notes: string[] = [];
  let proposedOverlapMax = 0;
  let itemsSeenMax = 0;
  let decisionsApplied = 0;
  let decisionTableRespected = true;

  for (const snapshot of history) {
    itemsSeenMax = Math.max(itemsSeenMax, snapshot.items.length);
    const proposedCount = snapshot.items.filter((item) => item.status === script.proposedStatus).length;
    proposedOverlapMax = Math.max(proposedOverlapMax, proposedCount);
  }

  for (const snapshot of history) {
    if (!snapshot.decision) {
      continue;
    }
    const expectedStatus = script.decisionTable[snapshot.decision.decision];
    const item = snapshot.items.find((candidate) => candidate.index === snapshot.decision?.index);
    const actualStatus = item?.status ?? null;
    if (!expectedStatus) {
      decisionTableRespected = false;
      notes.push(`decision_table_unknown:round=${String(snapshot.round)}:index=${String(snapshot.decision.index)}:decision=${snapshot.decision.decision}`);
      continue;
    }
    if (actualStatus === expectedStatus) {
      decisionsApplied += 1;
    } else {
      decisionTableRespected = false;
      notes.push(
        `decision_table_mismatch:round=${String(snapshot.round)}:index=${String(snapshot.decision.index)}:decision=${snapshot.decision.decision}:expected=${expectedStatus}:actual=${String(actualStatus)}`,
      );
    }
  }

  if (script.decisions.length > 0 && decisionsApplied === 0) {
    decisionTableRespected = false;
    notes.push('decision_table_vacuous:no_decision_applied');
  }
  const oneProposedInvariantHeld = proposedOverlapMax <= 1;
  if (!oneProposedInvariantHeld) {
    notes.push(`one_proposed_invariant_violated:max=${String(proposedOverlapMax)}`);
  }
  const lastSnapshot = history[history.length - 1];
  const terminalStatuses = new Set(script.terminalStatuses);
  const terminalItemsFinal = lastSnapshot
    ? lastSnapshot.items.filter((item) => item.status !== null && terminalStatuses.has(item.status)).length
    : 0;
  const loopEngaged = itemsSeenMax >= 1 && proposedOverlapMax >= 1 && decisionsApplied >= 1;
  const providerHitsOk = providerHits >= 1;
  if (!providerHitsOk) {
    notes.push('provider_hits_below_minimum');
  }

  return {
    decision_table_respected: decisionTableRespected,
    one_proposed_invariant_held: oneProposedInvariantHeld,
    proposed_overlap_max: proposedOverlapMax,
    items_seen_max: itemsSeenMax,
    decisions_applied: decisionsApplied,
    terminal_items_final: terminalItemsFinal,
    loop_engaged: loopEngaged,
    provider_hits_ok: providerHitsOk,
    notes,
  };
}

export async function driveGeneratedProgramLive(options: GeneratedLiveDriveOptions): Promise<GeneratedLiveDriveResult> {
  const workDir = join(options.targetDir, '.pgas-new-live-drive');
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(join(workDir, 'session-logs'), { recursive: true });
  const runnerPath = join(workDir, 'runner.ts');
  const reportPath = join(workDir, 'report.json');
  const driveTimeoutMs = options.driveTimeoutMs ?? DEFAULT_DRIVE_TIMEOUT_MS;

  const proxy = await startCountingProviderProxy(options.providerBaseUrl);
  try {
    writeFileSync(runnerPath, renderLiveDriveRunnerSource(options.slug, options.confirmationScript));

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
        ...(options.confirmationScript
          ? { PGAS_LIVE_DRIVE_CONFIRMATION_SCRIPT: JSON.stringify(options.confirmationScript) }
          : {}),
      },
    });

    const report = readDriveReport(reportPath);
    const providerHits = proxy.hits();
    const statusHistory = parseStatusHistory(report?.status_history);
    const choreography = options.confirmationScript
      ? assessChoreography(statusHistory, options.confirmationScript, providerHits)
      : noConfirmationScriptChoreography(providerHits);
    return {
      final_mode: typeof report?.final_mode === 'string' ? report.final_mode : null,
      terminal: report?.terminal === true,
      rounds: typeof report?.rounds === 'number' ? report.rounds : 0,
      triggers: typeof report?.triggers === 'number' ? report.triggers : 0,
      actions: Array.isArray(report?.actions) ? report.actions.filter(isNonEmptyString) : [],
      terminal_actions: parseTerminalActions(report?.terminal_actions),
      world: isRecord(report?.world) ? report.world : {},
      provider_hits: providerHits,
      provider_exchanges: proxy.exchanges(),
      author_driver: report?.author_driver === 'unified' || report?.author_driver === 'default'
        ? report.author_driver
        : null,
      status_history: statusHistory,
      choreography,
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
export function renderLiveDriveRunnerSource(
  slug: string,
  confirmationScript?: GeneratedLiveDriveConfirmationScript,
): string {
  if (confirmationScript) {
    return renderConfirmationLiveDriveRunnerSource(slug);
  }
  return renderEntryOnlyLiveDriveRunnerSource(slug);
}

function renderEntryOnlyLiveDriveRunnerSource(slug: string): string {
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

function renderConfirmationLiveDriveRunnerSource(slug: string): string {
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
const confirmationScript = parseConfirmationScript(process.env.PGAS_LIVE_DRIVE_CONFIRMATION_SCRIPT ?? '');

interface DriveState {
  mode: string | null;
  terminal: boolean;
  roundCount: number;
  world: Record<string, unknown>;
  actions: string[];
  terminalActions: Array<{ name: string; payload_excerpt: string }>;
}

interface ConfirmationScript {
  channel: string;
  itemsPath: string;
  statusField: string;
  proposedStatus: string;
  fallbackDecision: string;
  decisions: Array<{ decision: string; instruction?: string }>;
  decisionTable: Record<string, string>;
  terminalStatuses: string[];
}

interface StatusHistoryItem {
  index: number;
  id?: string;
  title?: string;
  status: string | null;
}

interface StatusHistoryEntry {
  round: number;
  items: StatusHistoryItem[];
  decision?: { index: number; decision: string; instruction?: string };
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

  const statusHistory: StatusHistoryEntry[] = [];
  let payloadText = INITIAL_TEXT;
  let triggers = 0;
  let scriptIndex = 0;
  let state = await readState(client, sessionId);
  recordStatusSnapshot(statusHistory, state, confirmationScript);
  while (state.mode !== FINAL_STAGE && !state.terminal && triggers < MAX_TRIGGERS && Date.now() < DEADLINE) {
    const proposed = findProposedItem(state.world, confirmationScript);
    if (proposed) {
      const fallbackDecision = { decision: confirmationScript.fallbackDecision };
      const decision = scriptIndex < confirmationScript.decisions.length
        ? confirmationScript.decisions[scriptIndex] as { decision: string; instruction?: string }
        : fallbackDecision;
      if (scriptIndex < confirmationScript.decisions.length) scriptIndex += 1;
      const before = state.roundCount;
      const payload = buildConfirmationPayload(confirmationScript, proposed, decision);
      try {
        await client.sessions.trigger(sessionId, { channel: confirmationScript.channel, payload });
      } catch (error) {
        if (/terminal/iu.test(String(error))) break;
        throw error;
      }
      triggers += 1;
      state = await waitForRound(client, sessionId, before);
      recordStatusSnapshot(statusHistory, state, confirmationScript, {
        index: proposed.index,
        decision: decision.decision,
        ...(decision.instruction ? { instruction: decision.instruction } : {}),
      });
      continue;
    }

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
    recordStatusSnapshot(statusHistory, state, confirmationScript);
  }

  state = await readState(client, sessionId);
  recordStatusSnapshot(statusHistory, state, confirmationScript);
  writeReport({
    final_mode: state.mode,
    terminal: state.terminal,
    rounds: state.roundCount,
    triggers,
    actions: state.actions,
    terminal_actions: state.terminalActions,
    world: state.world,
    author_driver: drivers ? 'unified' : 'default',
    status_history: statusHistory,
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

function parseConfirmationScript(raw: string): ConfirmationScript {
  if (raw.trim().length === 0) {
    throw new Error('PGAS_LIVE_DRIVE_CONFIRMATION_SCRIPT is required for confirmation live drive');
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('PGAS_LIVE_DRIVE_CONFIRMATION_SCRIPT must be an object');
  }
  const decisions = Array.isArray(parsed.decisions)
    ? parsed.decisions.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.decision !== 'string' || entry.decision.length === 0) return [];
        return [{
          decision: entry.decision,
          ...(typeof entry.instruction === 'string' && entry.instruction.length > 0 ? { instruction: entry.instruction } : {}),
        }];
      })
    : [];
  const decisionTable = isRecord(parsed.decisionTable)
    ? Object.fromEntries(Object.entries(parsed.decisionTable).flatMap(([decision, status]) =>
        typeof status === 'string' ? [[decision, status]] : []))
    : {};
  const terminalStatuses = Array.isArray(parsed.terminalStatuses)
    ? parsed.terminalStatuses.filter((status): status is string => typeof status === 'string' && status.length > 0)
    : [];
  const script = {
    channel: stringField(parsed, 'channel'),
    itemsPath: stringField(parsed, 'itemsPath'),
    statusField: stringField(parsed, 'statusField'),
    proposedStatus: stringField(parsed, 'proposedStatus'),
    fallbackDecision: typeof parsed.fallbackDecision === 'string' && parsed.fallbackDecision.length > 0
      ? parsed.fallbackDecision
      : 'approve',
    decisions,
    decisionTable,
    terminalStatuses,
  };
  if (!script.channel || !script.itemsPath || !script.statusField || !script.proposedStatus) {
    throw new Error('PGAS_LIVE_DRIVE_CONFIRMATION_SCRIPT is missing required channel/itemsPath/statusField/proposedStatus');
  }
  return script;
}

function recordStatusSnapshot(
  history: StatusHistoryEntry[],
  state: DriveState,
  script: ConfirmationScript,
  decision?: StatusHistoryEntry['decision'],
): void {
  if (!decision && history[history.length - 1]?.round === state.roundCount) {
    return;
  }
  history.push({
    round: state.roundCount,
    items: statusItemsFromWorld(state.world, script),
    ...(decision ? { decision } : {}),
  });
}

function findProposedItem(world: Record<string, unknown>, script: ConfirmationScript): StatusHistoryItem | null {
  return statusItemsFromWorld(world, script).find((item) => item.status === script.proposedStatus) ?? null;
}

function statusItemsFromWorld(world: Record<string, unknown>, script: ConfirmationScript): StatusHistoryItem[] {
  const itemsByIndex = new Map<number, StatusHistoryItem>();
  const arrayValue = world[script.itemsPath];
  if (Array.isArray(arrayValue)) {
    arrayValue.forEach((item, index) => {
      if (!isRecord(item)) return;
      itemsByIndex.set(index, {
        index,
        ...optionalStringValue('id', firstString(item.id, item.item_id)),
        ...optionalStringValue('title', firstString(item.title, item.name)),
        status: typeof item[script.statusField] === 'string' ? item[script.statusField] : null,
      });
    });
  }

  const prefix = script.itemsPath + '.';
  for (const [path, value] of Object.entries(world)) {
    if (!path.startsWith(prefix)) continue;
    const match = path.slice(prefix.length).match(/^(\\d+)\\.([^.]*)$/u);
    if (!match) continue;
    const index = Number(match[1]);
    const field = match[2] as string;
    const current = itemsByIndex.get(index) ?? { index, status: null };
    if (field === script.statusField) {
      current.status = typeof value === 'string' ? value : null;
    } else if ((field === 'id' || field === 'item_id') && typeof value === 'string') {
      current.id = value;
    } else if ((field === 'title' || field === 'name') && typeof value === 'string') {
      current.title = value;
    }
    itemsByIndex.set(index, current);
  }

  return [...itemsByIndex.values()].sort((left, right) => left.index - right.index);
}

function buildConfirmationPayload(
  script: ConfirmationScript,
  target: StatusHistoryItem,
  decision: { decision: string; instruction?: string },
): Record<string, unknown> {
  void script;
  const envelope = {
    decision: decision.decision,
    instruction: decision.instruction ?? '',
    timestamp: new Date().toISOString(),
    target_item_index: target.index,
    target_item_id: target.id ?? '',
    target_item_title: target.title ?? '',
    target_item_status: target.status ?? '',
  };
  return {
    'inputs.user_decision': envelope,
    'inputs.user_decision.decision': envelope.decision,
    'inputs.user_decision.instruction': envelope.instruction,
    'inputs.user_decision.timestamp': envelope.timestamp,
    'inputs.user_decision.target_item_index': envelope.target_item_index,
    'inputs.user_decision.target_item_id': envelope.target_item_id,
    'inputs.user_decision.target_item_title': envelope.target_item_title,
    'inputs.user_decision.target_item_status': envelope.target_item_status,
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

function optionalStringValue(key: 'id' | 'title', value: string | null): { id?: string; title?: string } {
  return value ? { [key]: value } : {};
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function writeReport(report: Record<string, unknown>): void {
  if (REPORT_PATH.length > 0) {
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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
  status_history?: unknown;
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

function parseStatusHistory(value: unknown): GeneratedLiveDriveStatusHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.round !== 'number' || !Array.isArray(entry.items)) {
      return [];
    }
    const items = entry.items.flatMap((item) => {
      if (!isRecord(item) || typeof item.index !== 'number') return [];
      return [{
        index: item.index,
        ...(typeof item.id === 'string' ? { id: item.id } : {}),
        ...(typeof item.title === 'string' ? { title: item.title } : {}),
        status: typeof item.status === 'string' ? item.status : null,
      }];
    });
    const decision = isRecord(entry.decision) &&
      typeof entry.decision.index === 'number' &&
      typeof entry.decision.decision === 'string'
      ? {
          index: entry.decision.index,
          decision: entry.decision.decision,
          ...(typeof entry.decision.instruction === 'string' ? { instruction: entry.decision.instruction } : {}),
        }
      : undefined;
    return [{
      round: entry.round,
      items,
      ...(decision ? { decision } : {}),
    }];
  });
}

function noConfirmationScriptChoreography(providerHits: number): GeneratedLiveDriveChoreographyVerdict {
  return {
    decision_table_respected: true,
    one_proposed_invariant_held: true,
    proposed_overlap_max: 0,
    items_seen_max: 0,
    decisions_applied: 0,
    terminal_items_final: 0,
    loop_engaged: true,
    provider_hits_ok: providerHits >= 1,
    notes: providerHits >= 1 ? ['confirmation_script_absent'] : ['confirmation_script_absent', 'provider_hits_below_minimum'],
  };
}

function descriptorStatusField(descriptor: ConfirmationLoopDescriptorForScript): string | undefined {
  const record = descriptor as Record<string, unknown>;
  const direct = record.status_field;
  if (typeof direct === 'string' && direct.length > 0) {
    return direct;
  }
  const item = record.item;
  if (isRecord(item) && typeof item.status_field === 'string' && item.status_field.length > 0) {
    return item.status_field;
  }
  return undefined;
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
