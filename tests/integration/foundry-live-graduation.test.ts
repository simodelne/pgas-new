import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

const LIVE_GRADUATION_ENABLED = process.env.PGAS_LIVE_GRADUATION === '1';
const liveIt = LIVE_GRADUATION_ENABLED ? it : it.skip;
const LIVE_TIMEOUT_MS = Number(process.env.PGAS_LIVE_GRADUATION_TIMEOUT_MS ?? '1800000');
const MAX_TRANSIENT_ATTEMPTS = 2;
const PROGRAM = 'pgas-new';

const EXPECTED_MODES = [
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
];

const REQUIRED_ACTIONS = [
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
  'authorize_standalone_target',
  'synthesize_program_spec',
  'plan_artifacts',
  'approve_artifact_plan',
  'synthesize_domain_logic',
  'write_scaffold_artifacts',
  'run_static_verification',
  'run_smoke_verification',
  'confirm_live_provider_intent',
  'run_live_provider_verification',
  'git_rebase_latest',
  'run_rebase_static_verification',
];

const EXPECTED_ARTIFACT_PATHS = [
  'package.json',
  'tests/generated-program-smoke.test.ts',
  'audit/PGAS-NEW-GRADUATION.md',
];

interface LiveGraduationEnv {
  baseUrl: string;
  model: string;
}

interface CommandCheck {
  command: string;
  status: 'passed';
  output: string;
}

interface GraduationResult {
  sessionId: string;
  targetDir: string;
  finalMode: string | null;
  terminal: boolean;
  modes: string[];
  actions: string[];
  artifactPaths: string[];
  generatedChecks: CommandCheck[];
  graduationAuditPath: string;
  graduationAuditExcerpt: string;
  world: Record<string, unknown>;
}

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('live foundry graduation gate', () => {
  liveIt('drives the real foundry server through full standalone graduation against Qwen', { timeout: LIVE_TIMEOUT_MS }, async () => {
    const env = requireLiveGraduationEnv();
    const result = await runWithTransientRetry(env);

    emitLiveGraduationResult(result);

    expect(result.finalMode).toBe('pr_graduation');
    expect(result.terminal).toBe(true);
    expect(result.modes).toEqual(expect.arrayContaining(EXPECTED_MODES));
    expect(result.actions).toEqual(expect.arrayContaining(REQUIRED_ACTIONS));
    expect(result.actions).not.toContain('open_pull_request');
    expect(result.world['artifacts.written']).toBe(true);
    expect(result.artifactPaths).toEqual(expect.arrayContaining(EXPECTED_ARTIFACT_PATHS));
    expect(result.world['graduation.static_verification']).toBe('passed');
    expect(result.world['graduation.smoke_verification']).toBe('passed');
    expect(result.world['graduation.live_verification']).toBe('passed');
    expect(result.world['graduation.rebase_status']).toBe('passed');
    expect(result.world['graduation.rebase_verification']).toBe('passed');
    expect(result.generatedChecks.map((check) => check.status)).toEqual(['passed', 'passed', 'passed', 'passed']);
    expect(existsSync(result.graduationAuditPath)).toBe(true);
    expect(result.graduationAuditExcerpt).toContain('PGAS-New Graduation');
  });
});

async function runWithTransientRetry(env: LiveGraduationEnv): Promise<GraduationResult> {
  let lastTransient: unknown;
  for (let attempt = 1; attempt <= MAX_TRANSIENT_ATTEMPTS; attempt += 1) {
    try {
      return await runGraduationAttempt(env, attempt);
    } catch (error) {
      if (!isTransientProviderFailure(error) || attempt === MAX_TRANSIENT_ATTEMPTS) {
        throw error;
      }
      lastTransient = error;
      console.warn(`[live-graduation] transient provider failure on attempt ${String(attempt)}: ${errorMessage(error)}`);
    }
  }
  throw lastTransient instanceof Error ? lastTransient : new Error(String(lastTransient));
}

async function runGraduationAttempt(env: LiveGraduationEnv, attempt: number): Promise<GraduationResult> {
  const root = trackedTempRoot(`pgas-new-live-graduation-${String(attempt)}-`);
  const targetDir = join(root, 'generated', 'expense-audit-live');
  const logRoot = join(root, 'session-logs');
  const restoreEnv = installLiveFoundryEnv(root, logRoot, env);
  let server: StartedFoundryServer | null = null;

  try {
    prepareLocalGitTarget(targetDir);
    server = await startFoundryServer({ port: 0 });
    const client = createPgasClient(fetchTransport({ baseUrl: server.url, token: 'dev-token' }));
    await client.programs.list();

    const created = await client.sessions.create({
      program: PROGRAM,
      domain_context: { query: graduationMandate(targetDir) },
    });
    const sessionId = created.sessionId;

    await driveDesignIntake(client, sessionId, targetDir);
    await invokeControlAndWait(
      client,
      sessionId,
      'confirm_design',
      (state) => state.mode === 'scaffold_plan' && state.world['artifact_plan.status'] === 'draft',
      'design approval to draft artifact plan',
    );
    await invokeControlAndWait(
      client,
      sessionId,
      'approve_artifact_plan',
      (state) => state.mode === 'branch_write' && state.world['program.domain_synthesis_complete'] === true,
      'artifact approval through domain_synthesis',
    );
    await driveSystemModesToGraduation(client, sessionId);

    const finalState = await readSessionState(client, sessionId);
    const generatedChecks = runGeneratedProgramChecks(targetDir);
    const graduationAuditPath = join(targetDir, 'audit', 'PGAS-NEW-GRADUATION.md');
    const graduationAudit = readFileSync(graduationAuditPath, 'utf8');

    return {
      sessionId,
      targetDir,
      finalMode: finalState.mode,
      terminal: finalState.terminal,
      modes: finalState.modes,
      actions: finalState.actions,
      artifactPaths: unique([...finalState.artifactPaths, ...existingExpectedArtifactPaths(targetDir)]),
      generatedChecks,
      graduationAuditPath,
      graduationAuditExcerpt: graduationAudit.slice(0, 500),
      world: finalState.world,
    };
  } finally {
    if (server) await server.kill();
    restoreEnv();
  }
}

async function driveSystemModesToGraduation(client: PgasClient, sessionId: string): Promise<void> {
  for (let step = 0; step < 20; step += 1) {
    const current = await readSessionState(client, sessionId);
    if (current.mode === 'pr_graduation' && current.terminal) {
      return;
    }
    try {
      await triggerAndWait(
        client,
        sessionId,
        'system_mode_entry',
        {},
        (state) => state.roundCount > current.roundCount && (
          state.mode !== current.mode ||
          state.actions.length > current.actions.length ||
          state.terminal
        ),
        `system mode advancement from ${String(current.mode)}`,
      );
    } catch (error) {
      if (isTerminalSessionError(error)) {
        const terminalState = await readSessionState(client, sessionId);
        if (terminalState.mode === 'pr_graduation' && terminalState.terminal) {
          return;
        }
      }
      throw error;
    }
  }

  const latest = await readSessionState(client, sessionId);
  throw new Error(
    `exhausted system-mode advancement before graduation. mode=${String(latest.mode)} ` +
    `actions=${latest.actions.join(',')} world=${JSON.stringify(latest.world)}`,
  );
}

async function driveDesignIntake(client: PgasClient, sessionId: string, targetDir: string): Promise<void> {
  const seedInputs = [
    graduationMandate(targetDir),
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
      nextMissingIntakeInstruction(state.world),
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
  terminal: boolean;
  roundCount: number;
  world: Record<string, unknown>;
  modes: string[];
  actions: string[];
  artifactPaths: string[];
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
    await sleep(500);
    latest = await readSessionState(client, sessionId);
  }

  if (!predicate(latest)) {
    throw new Error(
      `timed out waiting for ${label}. mode=${String(latest.mode)} rounds=${String(latest.roundCount)} ` +
      `actions=${latest.actions.join(',')} world=${JSON.stringify(latest.world)}`,
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
  const status = stringField(envelope.status);
  const actions = terminalActionNames(rounds);
  const mode = stringField(envelope.mode) ?? stringField((envelope.state as Record<string, unknown> | undefined)?.mode) ?? null;
  const modes = unique([
    mode ?? undefined,
    ...rounds.flatMap((round) => roundModes(round)),
    ...actions.map(modeForAction),
  ]);
  return {
    mode,
    terminal: Boolean((envelope.state as Record<string, unknown> | undefined)?.terminal ?? envelope.terminal) ||
      status === 'Completed' ||
      status === 'completed',
    roundCount: rounds.length,
    world: worldResponse.domain as Record<string, unknown>,
    modes,
    actions,
    artifactPaths: artifactGeneratedPaths(rounds),
  };
}

function nextMissingIntakeInstruction(world: Record<string, unknown>): string {
  if (world['program.target_dir_confirmed'] !== true) return graduationMandate(String(world['program.target_dir'] ?? '/tmp/expense-audit-live'));
  if (world['program.design_path'] !== 'design') return 'Use the design path. Do not use the default skeleton.';
  if (world['intake.q1_recorded'] !== true) return q1Purpose();
  if (world['intake.q2_recorded'] !== true) return q2EntryChannel();
  if (world['intake.q3_recorded'] !== true) return q3Stages();
  if (world['intake.q4_recorded'] !== true) return q4Transitions();
  if (world['intake.q5_recorded'] !== true) return q5Delegation();
  if (world['intake.q6_recorded'] !== true) return q6Completion();
  return 'Finalize the six-question design intake now.';
}

function graduationMandate(targetDir: string): string {
  return [
    'Create a standalone PGAS program.',
    `slug: expense-audit-live`,
    `name: Expense Audit Live`,
    `target_dir: ${targetDir}`,
    'Use the design path with the six-question intake.',
    'domain_spec:',
    q1Purpose(),
    q2EntryChannel(),
    q3Stages(),
    q4Transitions(),
    q5Delegation(),
    q6Completion(),
    'The rebase target branch is main and the target repo is a local temp git repository only.',
  ].join('\n');
}

function q1Purpose(): string {
  return 'Q1 purpose: Normalize a submitted expense request, classify it as reimbursable or review_needed, and finish with an audit-ready summary.';
}

function q2EntryChannel(): string {
  return 'Q2 entry_channel: user_text.';
}

function q3Stages(): string {
  return 'Q3 stages_json: [{"slug":"intake","is_bootstrap":true},{"slug":"classify_expense"},{"slug":"complete","is_terminal":true}].';
}

function q4Transitions(): string {
  return 'Q4 transitions_json: [{"from":"intake","to":"classify_expense","trigger":"started","guard_field":"intake.started"},{"from":"classify_expense","to":"complete","trigger":"classified","guard_field":"classify_expense.ready"}].';
}

function q5Delegation(): string {
  return 'Q5 delegation_json: {"enabled":false}.';
}

function q6Completion(): string {
  return 'Q6 completion_json: {"final_stage":"complete","guard_field":"classify_expense.ready"}.';
}

function runGeneratedProgramChecks(targetDir: string): CommandCheck[] {
  return [
    runGeneratedCommand(targetDir, ['install', '--no-audit', '--no-fund'], 'npm install --no-audit --no-fund', 300_000),
    runGeneratedCommand(targetDir, ['run', 'typecheck'], 'npm run typecheck', 180_000),
    runGeneratedCommand(targetDir, ['test'], 'npm test', 240_000),
    runGeneratedCommand(
      targetDir,
      ['test', '--', 'tests/generated-program-smoke.test.ts'],
      'npm test -- tests/generated-program-smoke.test.ts',
      180_000,
    ),
  ];
}

function runGeneratedCommand(targetDir: string, args: string[], command: string, timeout: number): CommandCheck {
  const output = execFileSync('npm', args, {
    cwd: targetDir,
    env: {
      ...process.env,
      npm_config_cache: join(targetDir, '.npm-cache'),
    },
    encoding: 'utf8',
    stdio: 'pipe',
    timeout,
  });
  return { command, status: 'passed', output: oneLine(output) };
}

function existingExpectedArtifactPaths(targetDir: string): string[] {
  return EXPECTED_ARTIFACT_PATHS.filter((path) => existsSync(join(targetDir, path)));
}

function prepareLocalGitTarget(targetDir: string): void {
  const originDir = join(targetDir, '..', 'origin.git');
  mkdirSync(targetDir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: targetDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'pgas-new-live@example.invalid'], { cwd: targetDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'PGAS New Live Test'], { cwd: targetDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'rebase.autoStash', 'true'], { cwd: targetDir, stdio: 'pipe' });
  execFileSync('git', ['init', '--bare', originDir], { stdio: 'pipe' });
  execFileSync('git', ['remote', 'add', 'origin', originDir], { cwd: targetDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'seed local graduation target'], { cwd: targetDir, stdio: 'pipe' });
  execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: targetDir, stdio: 'pipe' });
}

function installLiveFoundryEnv(root: string, logRoot: string, env: LiveGraduationEnv): () => void {
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
  process.env.PGAS_JWT_SECRET = 'live-graduation-jwt-secret';
  process.env.PGAS_JWT_ISSUER = 'pgas-new-live-graduation';
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

function requireLiveGraduationEnv(): LiveGraduationEnv {
  if (process.env.PGAS_LIVE_GRADUATION !== '1') {
    throw new Error('PGAS_LIVE_GRADUATION=1 is required for live graduation');
  }
  const baseUrl = process.env.PGAS_OPENAI_BASE_URL?.trim();
  const model = process.env.PGAS_OPENAI_MODEL?.trim();
  if (!baseUrl) {
    throw new Error('PGAS_LIVE_GRADUATION=1 requires PGAS_OPENAI_BASE_URL');
  }
  if (!model) {
    throw new Error('PGAS_LIVE_GRADUATION=1 requires PGAS_OPENAI_MODEL');
  }
  return { baseUrl, model };
}

function emitLiveGraduationResult(result: GraduationResult): void {
  writeLiveLine(`[live-graduation] session=${result.sessionId}`);
  writeLiveLine(`[live-graduation] modes=${result.modes.join(' -> ')}`);
  writeLiveLine(`[live-graduation] actions=${result.actions.join(' -> ')}`);
  writeLiveLine(`[live-graduation] final_mode=${String(result.finalMode)} terminal=${String(result.terminal)}`);
  writeLiveLine(`[live-graduation] generated_program=${result.targetDir}`);
  writeLiveLine(`[live-graduation] artifact_paths=${result.artifactPaths.join(',')}`);
  for (const check of result.generatedChecks) {
    writeLiveLine(`[live-graduation] gate ${check.command}: ${check.status}${check.output ? ` (${check.output})` : ''}`);
  }
  writeLiveLine(`[live-graduation] graduation_audit=${result.graduationAuditPath}`);
}

function writeLiveLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

function terminalActionNames(rounds: unknown[]): string[] {
  return rounds.flatMap((round) => {
    if (!round || typeof round !== 'object' || Array.isArray(round)) return [];
    const result = (round as { result?: unknown }).result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
    const terminal = (result as { terminal?: unknown }).terminal;
    if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)) return [];
    const name = (terminal as { name?: unknown }).name;
    return typeof name === 'string' ? [name] : [];
  });
}

function artifactGeneratedPaths(rounds: unknown[]): string[] {
  return rounds.flatMap((round) => {
    const terminal = terminalAction(round);
    if (!terminal || terminal.name !== 'write_scaffold_artifacts') return [];
    const payload = terminal.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
    const generatedPaths = (payload as { generated_paths?: unknown }).generated_paths;
    if (!Array.isArray(generatedPaths)) return [];
    return generatedPaths.filter((path): path is string => typeof path === 'string');
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

function roundModes(round: unknown): string[] {
  if (!round || typeof round !== 'object' || Array.isArray(round)) return [];
  const record = round as Record<string, unknown>;
  return [
    stringField(record.mode),
    stringField(record.modeBefore),
    stringField(record.modeAfter),
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

function oneLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, 500);
}

function isTransientProviderFailure(error: unknown): boolean {
  const text = errorMessage(error);
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|timeout|temporarily unavailable|HTTP 429|HTTP 5\d\d/iu.test(text);
}

function isTerminalSessionError(error: unknown): boolean {
  return /Session is terminal: Completed/u.test(errorMessage(error));
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
