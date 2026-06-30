import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPgasClient,
  fetchTransport,
  type PgasClient,
  type TriggerResponse,
} from '@simodelne/pgas-server/client.js';
import { afterEach, describe, expect, it } from 'vitest';
import { startFoundryServer, type StartedFoundryServer } from '../../src/foundry-server.js';

const LIVE_REPO_TARGETING_ENABLED = process.env.PGAS_LIVE_REPO_TARGETING === '1';
const liveIt = LIVE_REPO_TARGETING_ENABLED ? it : it.skip;
const LIVE_TIMEOUT_MS = Number(process.env.PGAS_LIVE_REPO_TARGETING_TIMEOUT_MS ?? '1200000');
const MAX_TRANSIENT_ATTEMPTS = 2;
const TRANSIENT_COOLDOWN_MS = Number(process.env.PGAS_LIVE_REPO_TARGETING_RETRY_COOLDOWN_MS ?? '30000');
const PROGRAM = 'pgas-new';
const SIMONEOS_WIRING_MANIFEST = '/home/simone/simoneos-fee-proposal/.pgas/wiring.yml';

const EXPECTED_ACTIONS = [
  'record_program_target',
  'choose_design_path',
  'record_q1_purpose',
  'record_q2_entry_channel',
  'record_q3_stages',
  'record_q4_transitions',
  'record_q5_delegation',
  'record_q6_completion',
  'record_program_intake_finalize',
  'confirm_design',
  'load_wiring_manifest',
  'authorize_existing_repo_target',
] as const;

const MODE_ORDER = [
  'intake_intelligence',
  'repo_targeting',
  'architecture_design',
  'scaffold_plan',
  'domain_synthesis',
  'branch_write',
  'static_verify',
  'smoke_verify',
  'live_verify',
  'rebase_verify',
  'pr_graduation',
] as const;

interface LiveRepoTargetingEnv {
  baseUrl: string;
  model: string;
}

interface RepoTargetingResult {
  sessionId: string;
  targetDir: string;
  manifestPath: string;
  status: string | null;
  finalMode: string | null;
  terminal: boolean;
  modes: string[];
  actions: string[];
  repoTargetingRounds: Array<{ name: string; trigger?: string; proposedMode?: string }>;
  world: Record<string, unknown>;
}

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('live foundry existing-repo repo_targeting gate', () => {
  liveIt('clears repo_targeting for a temp existing-repo SimoneOS attachment against Qwen', { timeout: LIVE_TIMEOUT_MS }, async () => {
    const env = requireLiveRepoTargetingEnv();
    const result = await runWithTransientRetry(env);

    emitLiveRepoTargetingResult(result);

    expect(result.status).not.toMatch(/^failed$/iu);
    expect(modeRank(result.finalMode)).toBeGreaterThanOrEqual(modeRank('architecture_design'));
    expect(result.modes).toEqual(expect.arrayContaining(['repo_targeting', 'architecture_design']));
    expect(result.actions).toEqual(expect.arrayContaining([...EXPECTED_ACTIONS]));
    expect(result.actions).not.toContain('create_curator_request');
    expect(result.world['repo.target_kind']).toBe('existing_repo');
    expect(result.world['repo.wiring_manifest.status']).toBe('valid');
    expect(result.world['repo.wiring_manifest.path']).toBe('.pgas/wiring.yml');
    expect(result.world['repo.write_authorized']).toBe(true);
    expect(result.world['repo.curator_request_lodged']).not.toBe(true);
    expect(result.finalMode).not.toBe('repo_targeting');
    expect(existsSync(result.manifestPath)).toBe(true);
  });
});

async function runWithTransientRetry(env: LiveRepoTargetingEnv): Promise<RepoTargetingResult> {
  let lastTransient: unknown;
  for (let attempt = 1; attempt <= MAX_TRANSIENT_ATTEMPTS; attempt += 1) {
    try {
      return await runRepoTargetingAttempt(env, attempt);
    } catch (error) {
      if (!isTransientProviderFailure(error) || attempt === MAX_TRANSIENT_ATTEMPTS) {
        throw error;
      }
      lastTransient = error;
      const cooldown = isRateLimitFailure(error) ? TRANSIENT_COOLDOWN_MS : Math.min(TRANSIENT_COOLDOWN_MS, 10_000);
      console.warn(
        `[live-repo-targeting] transient provider failure on attempt ${String(attempt)}; ` +
        `cooling down ${String(cooldown)}ms: ${errorMessage(error)}`,
      );
      await sleep(cooldown);
    }
  }
  throw lastTransient instanceof Error ? lastTransient : new Error(String(lastTransient));
}

async function runRepoTargetingAttempt(env: LiveRepoTargetingEnv, attempt: number): Promise<RepoTargetingResult> {
  const root = trackedTempRoot(`pgas-new-live-repo-targeting-${String(attempt)}-`);
  const targetDir = join(root, 'simoneos-fee-proposal-attachment');
  const logRoot = join(root, 'session-logs');
  const restoreEnv = installLiveFoundryEnv(root, logRoot, env);
  let server: StartedFoundryServer | null = null;

  try {
    const manifestPath = prepareTempExistingRepoTarget(targetDir);
    server = await startFoundryServer({ port: 0 });
    const client = createPgasClient(fetchTransport({ baseUrl: server.url, token: 'dev-token' }));
    await client.programs.list();

    const created = await client.sessions.create({
      program: PROGRAM,
      domain_context: { query: existingRepoMandate(targetDir) },
    });
    const sessionId = created.sessionId;

    await driveDesignIntake(client, sessionId, targetDir);
    await invokeControlAndWait(
      client,
      sessionId,
      'confirm_design',
      hasReachedArchitectureOrBeyond,
      'confirm_design auto-continuation through existing-repo repo_targeting',
    );

    const finalState = await readSessionState(client, sessionId);
    return {
      sessionId,
      targetDir,
      manifestPath,
      status: finalState.status,
      finalMode: finalState.mode,
      terminal: finalState.terminal,
      modes: finalState.modes,
      actions: finalState.actions,
      repoTargetingRounds: repoTargetingRounds(finalState.rounds),
      world: finalState.world,
    };
  } finally {
    if (server) await server.kill();
    restoreEnv();
  }
}

async function driveDesignIntake(client: PgasClient, sessionId: string, targetDir: string): Promise<void> {
  const seedInputs = [
    existingRepoMandate(targetDir),
    'Use the design path. Do not use the default skeleton.',
  ];

  for (let index = 0; index < seedInputs.length; index += 1) {
    await triggerAndWait(
      client,
      sessionId,
      'user_text',
      seedInputs[index],
      () => true,
      `intake seed input ${String(index + 1)}`,
    );
    if ((await readSessionState(client, sessionId)).world['intake.program_intake_finalized'] === true) {
      return;
    }
  }

  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    const state = await readSessionState(client, sessionId);
    if (state.world['intake.program_intake_finalized'] === true) return;
    await triggerAndWait(
      client,
      sessionId,
      'user_text',
      nextMissingIntakeInstruction(state.world, targetDir),
      () => true,
      'remaining intake field',
    );
  }

  throw new Error(`timed out finalizing intake: ${JSON.stringify((await readSessionState(client, sessionId)).world)}`);
}

async function triggerAndWait(
  client: PgasClient,
  sessionId: string,
  channel: string,
  payload: unknown,
  predicate: (state: SessionState) => boolean,
  label: string,
): Promise<TriggerResponse> {
  const before = await readSessionState(client, sessionId);
  const response = await client.sessions.trigger(sessionId, { channel, payload });
  await waitForSessionState(
    client,
    sessionId,
    (state) => state.roundCount > before.roundCount && predicate(state),
    label,
  );
  return response;
}

async function invokeControlAndWait(
  client: PgasClient,
  sessionId: string,
  controlId: string,
  predicate: (state: SessionState) => boolean,
  label: string,
): Promise<void> {
  const before = await readSessionState(client, sessionId);
  await client.controls.invoke(PROGRAM, controlId, {
    sessionId,
    channel: 'http',
  });
  await waitForSessionState(
    client,
    sessionId,
    (state) => state.roundCount > before.roundCount && predicate(state),
    label,
  );
}

interface SessionState {
  mode: string | null;
  status: string | null;
  terminal: boolean;
  roundCount: number;
  world: Record<string, unknown>;
  modes: string[];
  actions: string[];
  rounds: unknown[];
}

async function waitForSessionState(
  client: PgasClient,
  sessionId: string,
  predicate: (state: SessionState) => boolean,
  label: string,
): Promise<SessionState> {
  const deadline = Date.now() + 900_000;
  let latest = await readSessionState(client, sessionId);

  while (!predicate(latest) && Date.now() < deadline) {
    if (isFailedSession(latest)) {
      throw new Error(
        `session failed while waiting for ${label}. mode=${String(latest.mode)} ` +
        `status=${String(latest.status)} actions=${latest.actions.join(',')} world=${JSON.stringify(latest.world)}`,
      );
    }
    await sleep(500);
    latest = await readSessionState(client, sessionId);
  }

  if (!predicate(latest)) {
    throw new Error(
      `timed out waiting for ${label}. mode=${String(latest.mode)} status=${String(latest.status)} ` +
      `rounds=${String(latest.roundCount)} actions=${latest.actions.join(',')} world=${JSON.stringify(latest.world)}`,
    );
  }
  return latest;
}

async function readSessionState(client: PgasClient, sessionId: string): Promise<SessionState> {
  const [envelope, worldResponse, roundsResponse] = await Promise.all([
    client.sessions.get(sessionId),
    client.sessions.world(sessionId),
    client.sessions.rounds(sessionId),
  ]);
  const rounds = Array.isArray(roundsResponse.rounds) ? roundsResponse.rounds : [];
  const status = stringField(envelope.status) ?? null;
  const actions = terminalActionNames(rounds);
  const mode = stringField(envelope.mode) ?? stringField((envelope.state as Record<string, unknown> | undefined)?.mode) ?? null;
  const modes = unique([
    ...rounds.flatMap((round) => roundModes(round)),
    ...actions.map(modeForAction),
    mode ?? undefined,
  ]);
  return {
    mode,
    status,
    terminal: Boolean((envelope.state as Record<string, unknown> | undefined)?.terminal ?? envelope.terminal) ||
      status === 'Completed' ||
      status === 'completed',
    roundCount: rounds.length,
    world: worldResponse.domain as Record<string, unknown>,
    modes,
    actions,
    rounds,
  };
}

function existingRepoMandate(targetDir: string): string {
  return [
    'Attach a user-facing SimoneOS PGAS program to an EXISTING repository.',
    'slug: simoneos-fee-proposal-live',
    'name: SimoneOS Fee Proposal Live',
    `target_dir: ${targetDir}`,
    'The target_dir is a throwaway git repository with a valid .pgas/wiring.yml already present.',
    'This is not a standalone repo. Select target_kind existing_repo.',
    'After confirm_design, load the wiring manifest from target_dir and authorize the existing repo.',
    'The copied manifest has registration.strategy curator_request, but it is valid wiring and must not trigger create_curator_request.',
    'Use the design path with the six-question intake.',
    'domain_spec:',
    q1Purpose(),
    q2EntryChannel(),
    q3Stages(),
    q4Transitions(),
    q5Delegation(),
    q6Completion(),
  ].join('\n');
}

function nextMissingIntakeInstruction(world: Record<string, unknown>, targetDir: string): string {
  if (world['program.target_dir_confirmed'] !== true) return existingRepoMandate(targetDir);
  if (world['program.design_path'] !== 'design') return 'Use the design path. Do not use the default skeleton.';
  if (world['intake.q1_recorded'] !== true) return q1Purpose();
  if (world['intake.q2_recorded'] !== true) return q2EntryChannel();
  if (world['intake.q3_recorded'] !== true) return q3Stages();
  if (world['intake.q4_recorded'] !== true) return q4Transitions();
  if (world['intake.q5_recorded'] !== true) return q5Delegation();
  if (world['intake.q6_recorded'] !== true) return q6Completion();
  return 'Finalize the six-question design intake now.';
}

function q1Purpose(): string {
  return 'Q1 purpose: Capture a fee proposal request, compute an estimated SimoneOS implementation fee, and finish with a user-facing proposal summary.';
}

function q2EntryChannel(): string {
  return 'Q2 entry_channel: user_text.';
}

function q3Stages(): string {
  return 'Q3 stages_json: [{"slug":"intake","is_bootstrap":true},{"slug":"estimate_fee"},{"slug":"proposal_ready","is_terminal":true}].';
}

function q4Transitions(): string {
  return 'Q4 transitions_json: [{"from":"intake","to":"estimate_fee","trigger":"request_captured","guard_field":"intake.request_ready"},{"from":"estimate_fee","to":"proposal_ready","trigger":"estimate_complete","guard_field":"estimate_fee.ready"}].';
}

function q5Delegation(): string {
  return 'Q5 delegation_json: {"enabled":false}.';
}

function q6Completion(): string {
  return 'Q6 completion_json: {"final_stage":"proposal_ready","guard_field":"estimate_fee.ready"}.';
}

function prepareTempExistingRepoTarget(targetDir: string): string {
  if (!existsSync(SIMONEOS_WIRING_MANIFEST)) {
    throw new Error(`missing SimoneOS wiring manifest at ${SIMONEOS_WIRING_MANIFEST}`);
  }
  mkdirSync(join(targetDir, '.pgas'), { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: targetDir, stdio: 'pipe' });
  const manifestPath = join(targetDir, '.pgas', 'wiring.yml');
  copyFileSync(SIMONEOS_WIRING_MANIFEST, manifestPath);
  return manifestPath;
}

function installLiveFoundryEnv(root: string, logRoot: string, env: LiveRepoTargetingEnv): () => void {
  const names = [
    'HOME',
    'PGAS_DB',
    'PGAS_JWT_SECRET',
    'PGAS_JWT_ISSUER',
    'PGAS_JWT_EXPIRES_IN',
    'PGAS_PROVIDER',
    'PGAS_OPENAI_BASE_URL',
    'PGAS_OPENAI_MODEL',
    'PGAS_MODEL',
    'PGAS_OPENAI_API_KEY',
    'PGAS_OPENAI_TOOL_CHOICE',
    'PGAS_OPENAI_DISABLE_THINKING',
    'PGAS_OPENAI_TEMPERATURE',
    'PGAS_SESSION_LOG_DIR',
    'npm_config_cache',
  ] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));

  process.env.HOME = join(root, 'home');
  process.env.PGAS_DB = join(root, 'foundry.db');
  process.env.PGAS_JWT_SECRET = 'live-repo-targeting-jwt-secret';
  process.env.PGAS_JWT_ISSUER = 'pgas-new-live-repo-targeting';
  process.env.PGAS_JWT_EXPIRES_IN = '1h';
  process.env.PGAS_PROVIDER = 'openai';
  process.env.PGAS_OPENAI_BASE_URL = env.baseUrl;
  process.env.PGAS_OPENAI_MODEL = env.model;
  process.env.PGAS_MODEL = env.model;
  process.env.PGAS_OPENAI_API_KEY ??= 'local';
  process.env.PGAS_OPENAI_TOOL_CHOICE ??= 'required';
  process.env.PGAS_OPENAI_DISABLE_THINKING ??= '1';
  process.env.PGAS_OPENAI_TEMPERATURE ??= '0.2';
  process.env.PGAS_SESSION_LOG_DIR = logRoot;
  process.env.npm_config_cache = join(root, '.npm-cache');

  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
}

function requireLiveRepoTargetingEnv(): LiveRepoTargetingEnv {
  if (process.env.PGAS_LIVE_REPO_TARGETING !== '1') {
    throw new Error('PGAS_LIVE_REPO_TARGETING=1 is required for live repo_targeting');
  }
  const baseUrl = process.env.PGAS_OPENAI_BASE_URL?.trim();
  const model = process.env.PGAS_OPENAI_MODEL?.trim();
  if (!baseUrl) {
    throw new Error('PGAS_LIVE_REPO_TARGETING=1 requires PGAS_OPENAI_BASE_URL');
  }
  if (!model) {
    throw new Error('PGAS_LIVE_REPO_TARGETING=1 requires PGAS_OPENAI_MODEL');
  }
  return { baseUrl, model };
}

function hasReachedArchitectureOrBeyond(state: SessionState): boolean {
  return modeRank(state.mode) >= modeRank('architecture_design') && !isFailedSession(state);
}

function modeRank(mode: string | null): number {
  return mode === null ? -1 : MODE_ORDER.indexOf(mode as (typeof MODE_ORDER)[number]);
}

function isFailedSession(state: SessionState): boolean {
  return state.status === 'Failed' || state.status === 'failed';
}

function emitLiveRepoTargetingResult(result: RepoTargetingResult): void {
  writeLiveLine(`[live-repo-targeting] session=${result.sessionId}`);
  writeLiveLine(`[live-repo-targeting] target_dir=${result.targetDir}`);
  writeLiveLine(`[live-repo-targeting] copied_manifest=${result.manifestPath}`);
  writeLiveLine(`[live-repo-targeting] modes=${result.modes.join(' -> ')}`);
  writeLiveLine(`[live-repo-targeting] actions=${result.actions.join(' -> ')}`);
  writeLiveLine(`[live-repo-targeting] repo_targeting_rounds=${JSON.stringify(result.repoTargetingRounds)}`);
  writeLiveLine(`[live-repo-targeting] final_mode=${String(result.finalMode)} status=${String(result.status)} terminal=${String(result.terminal)}`);
  writeLiveLine(
    `[live-repo-targeting] repo target_kind=${String(result.world['repo.target_kind'])} ` +
    `manifest_status=${String(result.world['repo.wiring_manifest.status'])} ` +
    `write_authorized=${String(result.world['repo.write_authorized'])}`,
  );
}

function writeLiveLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

function terminalActionNames(rounds: unknown[]): string[] {
  return rounds.flatMap((round) => {
    const terminal = terminalAction(round);
    const name = terminal?.name;
    return typeof name === 'string' ? [name] : [];
  });
}

function terminalAction(round: unknown): { name?: unknown; payload?: unknown } | undefined {
  if (!round || typeof round !== 'object' || Array.isArray(round)) return undefined;
  const result = (round as { result?: unknown }).result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const terminal = (result as { terminal?: unknown }).terminal;
  if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)) return undefined;
  return terminal as { name?: unknown; payload?: unknown };
}

function repoTargetingRounds(rounds: unknown[]): Array<{ name: string; trigger?: string; proposedMode?: string }> {
  return rounds.flatMap((round) => {
    const terminal = terminalAction(round);
    const name = terminal?.name;
    if (typeof name !== 'string' || modeForAction(name) !== 'repo_targeting') return [];
    const record = round as { trigger?: unknown; result?: { proposedMode?: unknown } };
    const trigger = typeof record.trigger === 'string' ? record.trigger : undefined;
    const proposedMode = typeof record.result?.proposedMode === 'string' ? record.result.proposedMode : undefined;
    return [{ name, trigger, proposedMode }];
  });
}

function roundModes(round: unknown): string[] {
  if (!round || typeof round !== 'object' || Array.isArray(round)) return [];
  const record = round as Record<string, unknown>;
  return [
    stringField(record.modeBefore),
    stringField(record.modeAfter),
    stringField(record.mode),
    stringField((record.state as Record<string, unknown> | undefined)?.mode),
  ].filter((value): value is string => typeof value === 'string');
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function modeForAction(action: string | undefined): string | undefined {
  switch (action) {
    case 'record_program_target':
    case 'choose_design_path':
    case 'apply_default_skeleton':
    case 'ask_design_question':
    case 'record_q1_purpose':
    case 'record_q2_entry_channel':
    case 'record_q3_stages':
    case 'record_q4_transitions':
    case 'record_q5_delegation':
    case 'record_q6_completion':
    case 'record_program_intake_finalize':
    case 'confirm_design':
      return 'intake_intelligence';
    case 'select_repo_target':
    case 'authorize_standalone_target':
    case 'load_wiring_manifest':
    case 'authorize_existing_repo_target':
      return 'repo_targeting';
    case 'synthesize_program_spec':
    case 'design_architecture':
      return 'architecture_design';
    case 'plan_artifacts':
    case 'approve_artifact_plan':
      return 'scaffold_plan';
    case 'synthesize_domain_logic':
      return 'domain_synthesis';
    case 'write_scaffold_artifacts':
      return 'branch_write';
    case 'npm_install':
    case 'npm_typecheck':
    case 'npm_test':
    case 'run_static_verification':
    case 'run_parallel_static_checks':
      return 'static_verify';
    case 'run_smoke_verification':
    case 'confirm_live_provider_intent':
      return 'smoke_verify';
    case 'run_api_blackbox_verification':
    case 'run_live_provider_verification':
      return 'live_verify';
    case 'git_status':
    case 'git_rebase_latest':
    case 'run_rebase_static_verification':
      return 'rebase_verify';
    case 'open_pull_request':
      return 'pr_graduation';
    default:
      return undefined;
  }
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string'))];
}

function isTransientProviderFailure(error: unknown): boolean {
  const text = errorMessage(error);
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|timeout|temporarily unavailable|HTTP 429|HTTP 5\d\d/iu.test(text);
}

function isRateLimitFailure(error: unknown): boolean {
  return /HTTP 429|rate.?limit/iu.test(errorMessage(error));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function trackedTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
