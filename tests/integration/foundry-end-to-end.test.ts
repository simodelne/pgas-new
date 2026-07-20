import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHarness, type TestHarness, type TestHarnessAuthorResponse } from '@simodelne/pgas-server/testing.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handlers } from '../../src/foundry-program/handlers.js';
import { createPgasNewFoundryProgramEntry } from '../../src/foundry-program/registration.js';
import { waitForSnapshot } from './foundry-test-utils.js';

const stages = [
  { slug: 'intake', is_bootstrap: true },
  { slug: 'triage' },
  { slug: 'resolved', is_terminal: true },
];

const transitions = [
  { from: 'intake', to: 'triage', trigger: 'ready', guard_field: 'intake.started' },
  { from: 'triage', to: 'resolved', trigger: 'summary_ready', guard_field: 'triage.summary_ready' },
];

const synthesizedTriageBody = `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  return {
    result_json: JSON.stringify({ stage: input.stage, status: 'triaged', at: runtime.now() }),
    items_json: JSON.stringify(['triaged']),
    digest: '',
  };
}
`;

interface CommandCheck {
  command: string;
  status: 'passed' | 'skipped';
  reason?: string;
}

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('foundry end-to-end acceptance gate', () => {
  it('drives the foundry topology in memory and verifies generated scaffold gates', async () => {
    const tempRoot = trackedTempRoot('pgas-new-foundry-e2e-');
    const targetDir = join(tempRoot, 'incident-triage');
    const openPullRequest = vi.spyOn(handlers, 'open_pull_request');
    const harness = await createHarness(successAuthorResponses(targetDir));

    try {
      const seenModes = [await harness.getMode()];

      await triggerAndRecord(harness, seenModes, { channel: 'user_text', payload: 'Create an incident triage PGAS program.' });
      await triggerAndRecord(harness, seenModes, { channel: 'user_text', payload: 'Use the design path.' });
      await triggerAndRecord(harness, seenModes, { channel: 'system_mode_entry', payload: {} });
      await triggerAndRecord(harness, seenModes, { channel: 'system_mode_entry', payload: {} });
      await triggerAndRecord(harness, seenModes, { channel: 'system_mode_entry', payload: {} });
      await triggerAndRecord(harness, seenModes, { channel: 'system_mode_entry', payload: {} });
      await triggerAndRecord(harness, seenModes, { channel: 'system_mode_entry', payload: {} });
      await triggerAndRecord(harness, seenModes, { channel: 'system_mode_entry', payload: {} });
      await triggerAndRecord(harness, seenModes, { channel: 'system_mode_entry', payload: {} });
      await triggerAndRecord(harness, seenModes, { channel: 'user_confirmation', payload: { decision: 'approve' } });
      await waitForSnapshot(
        harness,
        (snapshot) => snapshot.mode === 'scaffold_plan' && snapshot.domain['artifact_plan.status'] === 'draft',
        'draft artifact plan before approval',
      );
      await triggerAndRecord(harness, seenModes, { channel: 'user_confirmation', payload: { decision: 'approve' } });
      // After /approve the chain is fully bus-driven: approve_artifact_plan ->
      // (auto_continuation) synthesize_domain_logic -> (auto_continuation)
      // write_scaffold_artifacts and onward. synthesize_domain_logic now emits on
      // widget_output so the domain_synthesis -> branch_write continuation fires
      // on its own; the working chain races through the transient branch_write
      // mode too fast to catch it there. Assert on the durable
      // program.domain_synthesis_complete fact instead of the transient mode, and
      // confirm the intermediate action fired via terminalActionNames.
      const domainReady = await waitForSnapshot(
        harness,
        (snapshot) => snapshot.domain['program.domain_synthesis_complete'] === true,
        'domain synthesis completion on the bus-driven approval chain',
      );
      expect(terminalActionNames(domainReady.rounds)).toEqual(expect.arrayContaining(['synthesize_domain_logic']));

      const finalSnapshot = await waitForSnapshot(
        harness,
        (snapshot) => snapshot.mode === 'pr_graduation' && snapshot.terminal === true,
        'approval continuation through pr_graduation',
      );

      expect(await harness.getMode()).toBe('pr_graduation');
      expect(await harness.getDomain('program.target_dir')).toBe(targetDir);
      expect(existsSync(targetDir), 'branch_write should create the configured output dir').toBe(true);

      const generatedChecks = runGeneratedChecks(targetDir);
      expect(generatedChecks).toEqual([
        expect.objectContaining({ command: 'npm install --no-audit --no-fund', status: expect.stringMatching(/^(passed|skipped)$/u) }),
        expect.objectContaining({ command: 'npm run typecheck', status: expect.stringMatching(/^(passed|skipped)$/u) }),
        expect.objectContaining({ command: 'npm test', status: expect.stringMatching(/^(passed|skipped)$/u) }),
      ]);

      const liveProvider = await probeLiveProvider();
      expect(liveProvider.status).toMatch(/^(passed|skipped)$/u);

      expect(terminalActionNames(finalSnapshot.rounds)).toEqual(
        expect.arrayContaining([
          'confirm_design',
          'authorize_standalone_target',
          'synthesize_program_spec',
          'plan_artifacts',
          'approve_artifact_plan',
          'synthesize_domain_logic',
          'write_scaffold_artifacts',
          'run_static_verification',
          'confirm_live_provider_intent',
          'run_rebase_static_verification',
        ]),
      );
      expect(finalSnapshot.terminal).toBe(true);

      const curatorRequestPath = join(targetDir, 'audit', 'PGAS-NEW-GRADUATION.md');
      expect(existsSync(curatorRequestPath), 'pr_graduation should have a curator-request artifact to review').toBe(true);
      expect(readFileSync(curatorRequestPath, 'utf8')).toContain('Incident Triage');
      expect(openPullRequest).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  }, 600_000);

  it('writes one composite envelope to the world when the opt-in parallel checks are packed in static_verify', async () => {
    const tempRoot = trackedTempRoot('pgas-new-foundry-composite-');
    const targetDir = join(tempRoot, 'incident-triage');
    const harness = await createHarness(successWithCompositeChecks(targetDir));

    try {
      const seenModes = [await harness.getMode()];

      await triggerAndRecord(harness, seenModes, { channel: 'user_text', payload: 'Create an incident triage PGAS program.' });
      await triggerAndRecord(harness, seenModes, { channel: 'user_text', payload: 'Use the design path.' });
      for (let i = 0; i < 7; i += 1) {
        await triggerAndRecord(harness, seenModes, { channel: 'system_mode_entry', payload: {} });
      }
      await triggerAndRecord(harness, seenModes, { channel: 'user_confirmation', payload: { decision: 'approve' } });
      await waitForSnapshot(
        harness,
        (snapshot) => snapshot.mode === 'scaffold_plan' && snapshot.domain['artifact_plan.status'] === 'draft',
        'draft artifact plan before approval',
      );
      await triggerAndRecord(harness, seenModes, { channel: 'user_confirmation', payload: { decision: 'approve' } });
      // After /approve the chain is fully bus-driven through
      // synthesize_domain_logic and write_scaffold_artifacts (no manual
      // system_mode_entry needed — see foundry-approve-flow.test.ts).
      // The opt-in packed action fires in static_verify on the auto-continue
      // chain after write_scaffold_artifacts and writes its combined envelope to
      // the world. It does not force-continue the ladder (single-call
      // run_static_verification remains the action that advances graduation), so
      // wait on the envelope landing rather than on terminal graduation.
      const snapshot = await waitForSnapshot(
        harness,
        (snap) => snap.mode === 'static_verify' && snap.domain['graduation.composite_checks'] !== undefined,
        'composite envelope written to world in static_verify',
      );

      // The opt-in packed action fired through the real engine path.
      expect(terminalActionNames(snapshot.rounds)).toContain('run_parallel_static_checks');

      // ER coupling: ONE combined envelope reached result_path graduation.composite_checks
      // in the world projection — read from the world, not re-derived.
      const envelope = snapshot.domain['graduation.composite_checks'] as
        | { status?: string; children?: { id: string; status: string }[] }
        | undefined;
      expect(envelope, 'composite envelope written to world').toBeTruthy();
      expect(envelope?.status).toBe('succeeded');
      expect(envelope?.children?.map((child) => child.id).sort()).toEqual([
        'evidence_shape',
        'import_boundary',
        'spec_modes',
      ]);
      expect(envelope?.children?.every((child) => child.status === 'succeeded')).toBe(true);
    } finally {
      await harness.close();
    }
  }, 600_000);

  it('canonicalizes verification result statuses before downstream graduation gates', async () => {
    const tempRoot = trackedTempRoot('pgas-new-foundry-status-canonical-');
    const targetDir = join(tempRoot, 'incident-triage');
    vi.spyOn(handlers, 'run_smoke_verification').mockResolvedValue({
      kind: 'smoke_verification',
      status: 'passed',
      evidence_id: 'smoke-synonym',
    });
    vi.spyOn(handlers, 'run_live_provider_verification').mockResolvedValue({
      kind: 'live_provider_verification',
      status: 'passed',
      evidence_id: 'live-synonym',
    });
    const harness = await createHarness(successWithVerificationStatusSynonyms(targetDir));

    try {
      const seenModes = [await harness.getMode()];

      await triggerAndRecord(harness, seenModes, { channel: 'user_text', payload: 'Create an incident triage PGAS program.' });
      await triggerAndRecord(harness, seenModes, { channel: 'user_text', payload: 'Use the design path.' });
      for (let i = 0; i < 7; i += 1) {
        await triggerAndRecord(harness, seenModes, { channel: 'system_mode_entry', payload: {} });
      }
      await triggerAndRecord(harness, seenModes, { channel: 'user_confirmation', payload: { decision: 'approve' } });
      await waitForSnapshot(
        harness,
        (snapshot) => snapshot.mode === 'scaffold_plan' && snapshot.domain['artifact_plan.status'] === 'draft',
        'draft artifact plan before status canonicalization regression',
      );
      await triggerAndRecord(harness, seenModes, { channel: 'user_confirmation', payload: { decision: 'approve' } });
      // Fully bus-driven after /approve (see the acceptance-gate test above): the
      // working synthesize_domain_logic auto-continuation races through the
      // transient branch_write mode, so gate on the durable
      // program.domain_synthesis_complete fact rather than the transient mode.
      const domainReady = await waitForSnapshot(
        harness,
        (snapshot) => snapshot.domain['program.domain_synthesis_complete'] === true,
        'domain synthesis completion before status canonicalization regression',
      );
      expect(terminalActionNames(domainReady.rounds)).toEqual(expect.arrayContaining(['synthesize_domain_logic']));

      const finalSnapshot = await waitForSnapshot(
        harness,
        (snapshot) => snapshot.mode === 'pr_graduation' && snapshot.terminal === true,
        'status synonyms canonicalized through pr_graduation',
      );

      expect(finalSnapshot.domain['graduation.static_verification']).toBe('passed');
      expect(finalSnapshot.domain['graduation.smoke_verification']).toBe('passed');
      expect(finalSnapshot.domain['graduation.live_verification']).toBe('passed');
      expect(finalSnapshot.domain['graduation.rebase_status']).toBe('passed');
      expect(finalSnapshot.domain['graduation.rebase_verification']).toBe('passed');
    } finally {
      await harness.close();
    }
  }, 600_000);

  it('reaches curator_request on the refusal path without binding a port', async () => {
    const tempRoot = trackedTempRoot('pgas-new-foundry-refusal-');
    const targetDir = join(tempRoot, 'existing-repo');
    const harness = await createHarness(refusalAuthorResponses(targetDir));

    try {
      const seenModes = [await harness.getMode()];

      await triggerAndRecord(harness, seenModes, { channel: 'user_text', payload: 'Attach to an existing repo.' });
      await triggerAndRecord(harness, seenModes, { channel: 'user_text', payload: 'Use the default skeleton.' });
      await triggerAndRecord(harness, seenModes, { channel: 'user_text', payload: 'Apply the default.' });
      await triggerAndRecord(harness, seenModes, { channel: 'user_confirmation', payload: { decision: 'approve' } });

      expect(await harness.getMode()).toBe('curator_request');
      const requestPath = join(targetDir, 'audit', 'PGAS-NEW-incident-triage.md');
      expect(existsSync(requestPath), 'curator_request should render the refusal artifact').toBe(true);
      expect(readFileSync(requestPath, 'utf8')).toContain('Missing required repo wiring');
    } finally {
      await harness.close();
    }
  });
});

async function createHarness(authorResponses: TestHarnessAuthorResponse[]): Promise<TestHarness> {
  return createTestHarness(createPgasNewFoundryProgramEntry(), {
    programName: 'pgas-new',
    authorResponses,
  });
}

function successAuthorResponses(targetDir: string): TestHarnessAuthorResponse[] {
  return [
    seedStandaloneTarget(targetDir),
    effect('choose_design_path', { choice: 'design' }),
    effect('record_q1_purpose', {
      purpose: 'Route incidents into a triage workflow.',
    }),
    effect('record_q2_entry_channel', {
      entry_channel: 'user_text',
    }),
    effect('record_q3_stages', {
      stages_json: JSON.stringify(stages),
    }),
    effect('record_q4_transitions', {
      transitions_json: JSON.stringify(transitions),
    }),
    effect('record_q5_delegation', {
      delegation_json: JSON.stringify({}),
    }),
    effect('record_q6_completion', {
      completion_json: JSON.stringify({ final_stage: 'resolved', guard_field: 'triage.summary_ready' }),
    }),
    effect('record_program_intake_finalize'),
    effect('confirm_design', { approved: true }),
    effect('authorize_standalone_target'),
    effect('synthesize_program_spec'),
    effect('plan_artifacts'),
    effect('approve_artifact_plan'),
    effect('synthesize_domain_logic', {
      cache_dir: join(targetDir, '.domain-synthesis-cache'),
      __domain_synthesis_body: synthesizedTriageBody,
    }),
    effect('write_scaffold_artifacts', { cwd: targetDir }),
    effect('run_static_verification', { status: 'passed', evidence_id: 'static-e2e' }),
    markSmokeVerificationPassed(),
    effect('confirm_live_provider_intent'),
    // The generated live drive must pass BEFORE live-provider verification:
    // run_live_provider_verification carries a spec precondition on
    // graduation.generated_live_drive == passed (the hard live-drive gate).
    markGeneratedLiveDrivePassed(),
    markLiveVerificationPassed(),
    markRebasePassed(),
    effect('run_rebase_static_verification', { status: 'passed', evidence_id: 'rebase-static-e2e' }),
  ];
}

function successWithCompositeChecks(targetDir: string): TestHarnessAuthorResponse[] {
  const sequence = successAuthorResponses(targetDir);
  // Splice the opt-in packed action into static_verify, right after
  // write_scaffold_artifacts (which transitions branch_write -> static_verify)
  // and before the default single-call run_static_verification. Both are legal
  // in static_verify; the composite action auto-continues, so it rides the same
  // continuation chain without an extra trigger.
  const writeIndex = sequence.findIndex(
    (response) => firstActionName(response) === 'write_scaffold_artifacts',
  );
  sequence.splice(writeIndex + 1, 0, compositeChecksEffect());
  return sequence;
}

function successWithVerificationStatusSynonyms(targetDir: string): TestHarnessAuthorResponse[] {
  const sequence = successAuthorResponses(targetDir);
  return sequence.map((response) => {
    switch (firstActionName(response)) {
      case 'run_static_verification':
        return effect('run_static_verification', { status: 'succeeded', evidence_id: 'static-synonym' });
      case 'run_smoke_verification':
        return effect('run_smoke_verification', { status: 'succeeded', evidence_id: 'smoke-synonym' });
      case 'run_live_provider_verification':
        return effect('run_live_provider_verification', { status: 'succeeded', evidence_id: 'live-synonym' });
      case 'run_generated_live_drive_verification':
        return markGeneratedLiveDrivePassed('succeeded', 'live-drive-synonym');
      case 'git_rebase_latest':
        return effect('git_rebase_latest', { status: 'succeeded', evidence_id: 'rebase-synonym' });
      case 'run_rebase_static_verification':
        return effect('run_rebase_static_verification', { status: 'succeeded', evidence_id: 'rebase-static-synonym' });
      default:
        return response;
    }
  });
}

function firstActionName(response: TestHarnessAuthorResponse): string | undefined {
  const actions = (response as { actions?: { name?: string }[] }).actions;
  return actions?.[0]?.name;
}

function compositeChecksEffect(): TestHarnessAuthorResponse {
  return {
    actions: [
      {
        kind: 'EffectAction',
        name: 'run_parallel_static_checks',
        channel: 'composite_checks_output',
        payload: {
          imports: ['@simodelne/pgas-server/plugin.js', '@simodelne/pgas-server/create-server.js'],
          modes: ['intake', 'triage', 'complete'],
          evidence: { status: 'passed', evidence_id: 'composite-e2e' },
        },
      },
    ],
  };
}

function refusalAuthorResponses(targetDir: string): TestHarnessAuthorResponse[] {
  return [
    seedBlockedExistingRepoTarget(targetDir),
    effect('choose_design_path', { choice: 'default' }),
    effect('apply_default_skeleton'),
    effect('confirm_design', { approved: true }),
    effect('create_curator_request', {
      repo_root: targetDir,
      slug: 'incident-triage',
      title: 'Missing required repo wiring',
      body: 'Missing required repo wiring for an existing-repo attachment.',
    }),
  ];
}

function seedStandaloneTarget(targetDir: string): TestHarnessAuthorResponse {
  return {
    actions: [
      mutation('record_program_target', 'program.slug', 'incident-triage'),
      mutation('record_program_target', 'program.name', 'Incident Triage'),
      mutation('record_program_target', 'program.target_dir', targetDir),
      mutation('record_program_target', 'program.target_dir_confirmed', true),
      terminal('record_program_target', { slug: 'incident-triage', name: 'Incident Triage', target_dir: targetDir }),
    ],
  };
}

function seedBlockedExistingRepoTarget(targetDir: string): TestHarnessAuthorResponse {
  return {
    actions: [
      mutation('record_program_target', 'program.slug', 'incident-triage'),
      mutation('record_program_target', 'program.name', 'Incident Triage'),
      mutation('record_program_target', 'program.target_dir', targetDir),
      mutation('record_program_target', 'program.target_dir_confirmed', true),
      mutation('record_program_target', 'repo.target_kind', 'existing_repo'),
      mutation('record_program_target', 'repo.blocked', true),
      mutation('record_program_target', 'repo.wiring_manifest_json', JSON.stringify({ paths: { audit_dir: 'audit' } })),
      terminal('record_program_target', { slug: 'incident-triage', name: 'Incident Triage', target_dir: targetDir }),
    ],
  };
}

function markLiveVerificationPassed(): TestHarnessAuthorResponse {
  return {
    actions: [
      mutation('run_live_provider_verification', 'graduation.live_verification', 'passed'),
      mutation('run_live_provider_verification', 'graduation.live_evidence_id', 'live-e2e'),
      terminal('session_status', continuationNotice()),
    ],
  };
}

/**
 * Scripted stand-in for the generated live-drive gate (hard-required for
 * live_verify -> rebase_verify). Hermetic flows mark the status by direct
 * mutation — mirroring markLiveVerificationPassed — because the real handler
 * boots the generated program against a live provider, which the hermetic
 * suite must never do. The derive_live_gate_passed reaction ANDs this with
 * graduation.live_verification to unlock rebase_verify.
 */
function markGeneratedLiveDrivePassed(
  status = 'passed',
  evidenceId = 'live-drive-e2e',
): TestHarnessAuthorResponse {
  return {
    actions: [
      mutation('run_generated_live_drive_verification', 'graduation.generated_live_drive', status),
      mutation('run_generated_live_drive_verification', 'graduation.generated_live_drive_evidence_id', evidenceId),
      // The recorded flag is what the normalize reaction watches (RC-4 forbids
      // watching the status path itself) — without it a status synonym would
      // never canonicalize and the run_live_provider_verification precondition
      // (FieldEquals 'passed') would stall the ladder.
      mutation('run_generated_live_drive_verification', 'graduation.generated_live_drive_recorded', true),
      terminal('session_status', continuationNotice()),
    ],
  };
}

function markSmokeVerificationPassed(): TestHarnessAuthorResponse {
  return {
    actions: [
      mutation('run_smoke_verification', 'graduation.smoke_verification', 'passed'),
      mutation('run_smoke_verification', 'graduation.smoke_evidence_id', 'smoke-e2e'),
      terminal('session_status', continuationNotice()),
    ],
  };
}

function markRebasePassed(): TestHarnessAuthorResponse {
  return {
    actions: [
      mutation('git_rebase_latest', 'graduation.rebase_status', 'passed'),
      mutation('git_rebase_latest', 'graduation.rebase_evidence_id', 'rebase-e2e'),
      terminal('session_status', continuationNotice()),
    ],
  };
}

function effect(name: string, payload: Record<string, unknown> = {}): TestHarnessAuthorResponse {
  return { actions: [terminal(name, payload)] };
}

function mutation(name: string, path: string, value: unknown): Record<string, unknown> {
  return { kind: 'MutationAction', name, op: 'MSet', path, value };
}

function terminal(name: string, payload: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'EffectAction',
    name,
    channel: name === 'plan_artifacts'
      ? 'artifact_plan_output'
      : 'widget_output',
    payload,
  };
}

function continuationNotice(): Record<string, unknown> {
  return { intent: 'present_information', auto_continue: true };
}

async function triggerAndRecord(
  harness: TestHarness,
  seenModes: string[],
  input: { channel: string; payload: unknown },
): Promise<void> {
  await harness.trigger(input);
  const currentMode = await harness.getMode();
  if (seenModes.at(-1) !== currentMode) {
    seenModes.push(currentMode);
  }
}

function runGeneratedChecks(targetDir: string): CommandCheck[] {
  const install = runGeneratedCommand(targetDir, ['install', '--no-audit', '--no-fund'], 'npm install --no-audit --no-fund', 45_000);
  if (install.status === 'skipped') {
    return [
      install,
      { command: 'npm run typecheck', status: 'skipped', reason: `skipped because ${install.reason}` },
      { command: 'npm test', status: 'skipped', reason: `skipped because ${install.reason}` },
    ];
  }

  return [
    install,
    runGeneratedCommand(targetDir, ['run', 'typecheck'], 'npm run typecheck', 120_000),
    runGeneratedCommand(targetDir, ['test'], 'npm test', 120_000),
  ];
}

function runGeneratedCommand(targetDir: string, args: string[], command: string, timeout: number): CommandCheck {
  const attempts = 2;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      execFileSync('npm', args, {
        cwd: targetDir,
        env: generatedCommandEnv(targetDir),
        stdio: 'pipe',
        timeout,
      });
      return { command, status: 'passed' };
    } catch (error) {
      const output = commandFailureOutput(error);
      if (isRegistryAccessFailure(output)) {
        return { command, status: 'skipped', reason: `registry unavailable: ${oneLine(output)}` };
      }
      if (attempt < attempts && isNativeWorkerStartupAbort(output)) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  throw lastError;
}

function generatedCommandEnv(targetDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CI: '1',
    npm_config_cache: join(targetDir, '.npm-cache'),
    RAYON_NUM_THREADS: process.env.RAYON_NUM_THREADS ?? '1',
    UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE ?? '1',
  };
}

function isNativeWorkerStartupAbort(output: string): boolean {
  return /Aborted \(core dumped\)|uv_thread_create|cannot fork|write EPIPE/u.test(output);
}

async function probeLiveProvider(): Promise<CommandCheck> {
  const providerUrl = process.env.PGAS_OPENAI_BASE_URL;
  if (!providerUrl) {
    return { command: 'live provider reachability', status: 'skipped', reason: 'PGAS_OPENAI_BASE_URL not set' };
  }
  if (!(await isReachable(providerUrl))) {
    return { command: 'live provider reachability', status: 'skipped', reason: `provider unreachable: ${providerUrl}` };
  }
  return { command: 'live provider reachability', status: 'passed' };
}

async function isReachable(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function isRegistryAccessFailure(output: string): boolean {
  return /EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EPERM|ETIMEDOUT|timed out|SIGTERM|network|registry|401 Unauthorized|403 Forbidden|404 Not Found/iu.test(output);
}

function commandFailureOutput(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);
  const candidate = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
  return [candidate.stderr, candidate.stdout, candidate.message].filter(Boolean).map((value) => value?.toString() ?? '').join('\n');
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, 240);
}

function trackedTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
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
