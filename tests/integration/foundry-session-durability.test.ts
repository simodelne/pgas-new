import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPgasClient, fetchTransport } from '@simodelne/pgas-server/client.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFoundryServer, type StartedFoundryServer } from '../../src/foundry-server.js';

const PROGRAM = 'pgas-new';
const GAP4_NOTES_PATH = '/tmp/codex-gap4-notes.md';
const canOpenLoopbackListener = await canBindLoopbackListener();

const DURABLE_STATE = {
  'notebook.entries': [
    'durability note: preserve the design intake across restart',
    'durability note: preserve the artifact plan across restart',
  ],
  'notebook.pins': [
    'pin:intake-purpose',
    'pin:artifact-plan',
  ],
  'intake.purpose': 'Measure file-backed foundry session durability.',
  'intake.entry_channel': 'user_text',
  'intake.stages_json': JSON.stringify([
    { slug: 'intake', is_bootstrap: true },
    { slug: 'durability_check' },
    { slug: 'complete', is_terminal: true },
  ]),
  'intake.transitions_json': JSON.stringify([
    { from: 'intake', to: 'durability_check', trigger: 'started', guard_field: 'intake.started' },
    { from: 'durability_check', to: 'complete', trigger: 'checked', guard_field: 'durability.ready' },
  ]),
  'intake.delegation_json': JSON.stringify({ enabled: false }),
  'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'durability.ready' }),
  'intake.q1_recorded': true,
  'intake.q2_recorded': true,
  'intake.q3_recorded': true,
  'intake.q4_recorded': true,
  'intake.q5_recorded': true,
  'intake.q6_recorded': true,
  'intake.program_intake_finalized': true,
  'program.slug': 'durability-check',
  'program.name': 'Durability Check',
  'program.target_dir': '/tmp/pgas-new-durability-check-target',
  'program.target_dir_confirmed': true,
  'program.design_path': 'design',
  'artifact_plan.status': 'draft',
  'artifact_plan.approved': false,
  'artifact_plan.write_authorized': false,
  'artifact_plan.artifacts': [
    {
      path: 'src/programs/durability-check/specs.yml',
      kind: 'spec',
      purpose: 'Durability assertion fixture.',
      owner: 'pgas-new',
      introducing_mode: 'scaffold_plan',
      verification_gate: 'spec-load',
    },
  ],
  'artifacts.written': false,
  'artifacts.generated_paths': [
    'src/programs/durability-check/specs.yml',
  ],
} as const satisfies Record<string, unknown>;

describe('foundry notebook and session durability', () => {
  const originalEnv = {
    HOME: process.env.HOME,
    PGAS_DB: process.env.PGAS_DB,
    PGAS_JWT_SECRET: process.env.PGAS_JWT_SECRET,
    PGAS_JWT_ISSUER: process.env.PGAS_JWT_ISSUER,
    PGAS_JWT_EXPIRES_IN: process.env.PGAS_JWT_EXPIRES_IN,
    PGAS_PROVIDER: process.env.PGAS_PROVIDER,
    PGAS_ENABLE_MOCK_PROVIDER: process.env.PGAS_ENABLE_MOCK_PROVIDER,
  };
  let rootDir: string;
  let server: StartedFoundryServer | null = null;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'pgas-new-foundry-durability-'));
    process.env.HOME = join(rootDir, 'home');
    process.env.PGAS_DB = join(rootDir, 'foundry.db');
    process.env.PGAS_JWT_SECRET = 'durability-jwt-secret';
    process.env.PGAS_JWT_ISSUER = 'pgas-new-durability-test';
    process.env.PGAS_JWT_EXPIRES_IN = '1h';
    process.env.PGAS_PROVIDER = 'mock';
    process.env.PGAS_ENABLE_MOCK_PROVIDER = '1';
  });

  afterEach(async () => {
    if (server) {
      await server.kill();
      server = null;
    }
    restoreEnv('HOME', originalEnv.HOME);
    restoreEnv('PGAS_DB', originalEnv.PGAS_DB);
    restoreEnv('PGAS_JWT_SECRET', originalEnv.PGAS_JWT_SECRET);
    restoreEnv('PGAS_JWT_ISSUER', originalEnv.PGAS_JWT_ISSUER);
    restoreEnv('PGAS_JWT_EXPIRES_IN', originalEnv.PGAS_JWT_EXPIRES_IN);
    restoreEnv('PGAS_PROVIDER', originalEnv.PGAS_PROVIDER);
    restoreEnv('PGAS_ENABLE_MOCK_PROVIDER', originalEnv.PGAS_ENABLE_MOCK_PROVIDER);
    rmSync(rootDir, { recursive: true, force: true });
  });

  (canOpenLoopbackListener ? it : it.skip)('resumes a file-backed session with notebook, intake, and artifact state intact after restart', async () => {
    server = await startFoundryServer({ port: 0 });
    const firstClient = createPgasClient(fetchTransport({ baseUrl: server.url, token: 'dev-token' }));
    const created = await firstClient.sessions.create({
      program: PROGRAM,
      domain_context: { query: 'Create the durability check foundry session.' },
    });
    await firstClient.sessions.patchDomain(created.sessionId, {
      patches: Object.entries(DURABLE_STATE).map(([path, value]) => ({ path, value })),
    });
    const beforeRestart = await durableState(firstClient, created.sessionId);

    await server.kill();
    server = null;

    server = await startFoundryServer({ port: 0 });
    const restartedClient = createPgasClient(fetchTransport({ baseUrl: server.url, token: 'dev-token' }));
    // Durability under test = persisted state is retrievable by sessionId after a
    // cold restart. Bare sessions.resume() resumes the in-memory LIVE active
    // session; a cold restart has none, so it legitimately does not re-select the
    // persisted session — asserting it returns the old id would test the wrong
    // property (that was the flaw in the first draft of this test).
    const resumed = await restartedClient.sessions.resume();
    expect(resumed.sessionId).not.toBe(created.sessionId);
    const afterRestart = await durableState(restartedClient, created.sessionId);

    try {
      expect(afterRestart).toEqual(beforeRestart);
      expect(afterRestart).toEqual(DURABLE_STATE);
    } catch (error) {
      writeDurabilityFinding(beforeRestart, afterRestart);
      throw error;
    }
  });
});

async function durableState(
  client: ReturnType<typeof createPgasClient>,
  sessionId: string,
): Promise<Record<keyof typeof DURABLE_STATE, unknown>> {
  await client.sessions.get(sessionId);
  const world = await client.sessions.world(sessionId);
  return Object.fromEntries(
    Object.keys(DURABLE_STATE).map((path) => [path, world.domain[path]]),
  ) as Record<keyof typeof DURABLE_STATE, unknown>;
}

function writeDurabilityFinding(
  beforeRestart: Record<keyof typeof DURABLE_STATE, unknown>,
  afterRestart: Record<keyof typeof DURABLE_STATE, unknown>,
): void {
  const losses = Object.keys(DURABLE_STATE).flatMap((path) => {
    const key = path as keyof typeof DURABLE_STATE;
    return JSON.stringify(beforeRestart[key]) === JSON.stringify(afterRestart[key])
      ? []
      : [`- ${path}: before=${JSON.stringify(beforeRestart[key])} after=${JSON.stringify(afterRestart[key])}`];
  });
  writeFileSync(
    GAP4_NOTES_PATH,
    [
      '# GAP 4 Findings',
      '',
      'Notebook/session durability test observed lost or changed state after foundry restart:',
      '',
      ...losses,
      '',
    ].join('\n'),
  );
}

async function canBindLoopbackListener(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => {
      resolve(false);
    });
    probe.listen(0, '127.0.0.1', () => {
      probe.close(() => {
        resolve(true);
      });
    });
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
