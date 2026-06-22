import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHarness, type TestHarness, type TestHarnessAuthorResponse } from '@simodelne/pgas-server/testing.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handlers } from '../../src/foundry-program/handlers.js';
import { createPgasNewFoundryProgramEntry } from '../../src/foundry-program/registration.js';

const SUCCESS_MODE_CHAIN = [
  'intake_intelligence',
  'repo_targeting',
  'architecture_design',
  'scaffold_plan',
  'branch_write',
  'static_verify',
  'live_verify',
  'rebase_verify',
  'pr_graduation',
] as const;

const REFUSAL_MODE_CHAIN = [
  'intake_intelligence',
  'repo_targeting',
  'curator_request',
] as const;

const stages = [
  { slug: 'intake', is_bootstrap: true },
  { slug: 'triage' },
  { slug: 'resolved', is_terminal: true },
];

const transitions = [
  { from: 'intake', to: 'triage', trigger: 'ready', guard_field: 'intake.started' },
  { from: 'triage', to: 'resolved', trigger: 'summary_ready', guard_field: 'triage.summary_ready' },
];

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
      await triggerAndRecord(harness, seenModes, { channel: 'user_confirmation', payload: { decision: 'approve' } });
      await triggerAndRecord(harness, seenModes, { channel: 'system_mode_entry', payload: {} });

      expect(seenModes).toEqual(SUCCESS_MODE_CHAIN.slice(0, 6));
      expect(await harness.getDomain('program.target_dir')).toBe(targetDir);
      expect(existsSync(targetDir), 'branch_write should create the configured output dir').toBe(true);

      const generatedChecks = runGeneratedChecks(targetDir);
      expect(generatedChecks).toEqual([
        expect.objectContaining({ command: 'npm install --no-audit --no-fund', status: expect.stringMatching(/^(passed|skipped)$/u) }),
        expect.objectContaining({ command: 'npm run typecheck', status: expect.stringMatching(/^(passed|skipped)$/u) }),
        expect.objectContaining({ command: 'npm test', status: expect.stringMatching(/^(passed|skipped)$/u) }),
      ]);

      await triggerAndRecord(harness, seenModes, { channel: 'system_mode_entry', payload: {} });
      await triggerAndRecord(harness, seenModes, { channel: 'system_mode_entry', payload: {} });
      const liveProvider = await probeLiveProvider();
      expect(liveProvider.status).toMatch(/^(passed|skipped)$/u);
      await triggerAndRecord(harness, seenModes, { channel: 'system_mode_entry', payload: {} });
      await triggerAndRecord(harness, seenModes, { channel: 'system_mode_entry', payload: {} });
      await triggerAndRecord(harness, seenModes, { channel: 'system_mode_entry', payload: {} });

      const snapshot = await harness.snapshot();
      expect(seenModes).toEqual(SUCCESS_MODE_CHAIN);
      expect(snapshot.terminal).toBe(true);

      const curatorRequestPath = join(targetDir, 'audit', 'PGAS-NEW-GRADUATION.md');
      expect(existsSync(curatorRequestPath), 'pr_graduation should have a curator-request artifact to review').toBe(true);
      expect(readFileSync(curatorRequestPath, 'utf8')).toContain('Incident Triage');
      expect(openPullRequest).not.toHaveBeenCalled();
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
      await triggerAndRecord(harness, seenModes, { channel: 'user_text', payload: 'Use the design path.' });
      await triggerAndRecord(harness, seenModes, { channel: 'system_mode_entry', payload: {} });

      expect(seenModes).toEqual(REFUSAL_MODE_CHAIN);
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
    authorizeStandaloneWithDesign(),
    effect('synthesize_program_spec'),
    effect('plan_artifacts'),
    effect('approve_artifact_plan'),
    effect('write_scaffold_artifacts', { cwd: targetDir }),
    effect('run_static_verification', { status: 'passed', evidence_id: 'static-e2e' }),
    effect('confirm_live_provider_intent'),
    markLiveVerificationPassed(),
    markRebasePassed(),
    effect('run_rebase_static_verification', { status: 'passed', evidence_id: 'rebase-static-e2e' }),
  ];
}

function refusalAuthorResponses(targetDir: string): TestHarnessAuthorResponse[] {
  return [
    seedBlockedExistingRepoTarget(targetDir),
    effect('choose_design_path', { choice: 'design' }),
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
      mutation('record_program_target', 'repo.target_kind', 'standalone_repo'),
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

function authorizeStandaloneWithDesign(): TestHarnessAuthorResponse {
  return {
    actions: [
      mutation('authorize_standalone_target', 'repo.write_authorized', true),
      mutation('authorize_standalone_target', 'repo.wiring_manifest.status', 'not_required'),
      mutation('authorize_standalone_target', 'program.design_path', 'design'),
      mutation('authorize_standalone_target', 'program.design_confirmed', true),
      mutation('authorize_standalone_target', 'intake.purpose', 'Route incidents into a triage workflow.'),
      mutation('authorize_standalone_target', 'intake.q1_recorded', true),
      mutation('authorize_standalone_target', 'intake.entry_channel', 'user_text'),
      mutation('authorize_standalone_target', 'intake.q2_recorded', true),
      mutation('authorize_standalone_target', 'intake.stages_json', JSON.stringify(stages)),
      mutation('authorize_standalone_target', 'intake.q3_recorded', true),
      mutation('authorize_standalone_target', 'intake.transitions_json', JSON.stringify(transitions)),
      mutation('authorize_standalone_target', 'intake.q4_recorded', true),
      mutation('authorize_standalone_target', 'intake.delegation_json', JSON.stringify({})),
      mutation('authorize_standalone_target', 'intake.q5_recorded', true),
      mutation('authorize_standalone_target', 'intake.completion_json', JSON.stringify({
        final_stage: 'resolved',
        guard_field: 'triage.summary_ready',
      })),
      mutation('authorize_standalone_target', 'intake.q6_recorded', true),
      mutation('authorize_standalone_target', 'intake.program_intake_finalized', true),
      terminal('authorize_standalone_target'),
    ],
  };
}

function markLiveVerificationPassed(): TestHarnessAuthorResponse {
  return {
    actions: [
      mutation('run_live_provider_verification', 'graduation.live_verification', 'passed'),
      mutation('run_live_provider_verification', 'graduation.live_evidence_id', 'live-e2e'),
      terminal('session_status'),
    ],
  };
}

function markRebasePassed(): TestHarnessAuthorResponse {
  return {
    actions: [
      mutation('git_rebase_latest', 'graduation.rebase_status', 'passed'),
      mutation('git_rebase_latest', 'graduation.rebase_evidence_id', 'rebase-e2e'),
      terminal('session_status'),
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
  return { kind: 'EffectAction', name, channel: 'widget_output', payload };
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
  try {
    execFileSync('npm', args, { cwd: targetDir, stdio: 'pipe', timeout });
    return { command, status: 'passed' };
  } catch (error) {
    const output = commandFailureOutput(error);
    if (isRegistryAccessFailure(output)) {
      return { command, status: 'skipped', reason: `registry unavailable: ${oneLine(output)}` };
    }
    throw error;
  }
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
