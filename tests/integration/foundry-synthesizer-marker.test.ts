import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPgasServer, type UnifiedAuthorDriverOptions } from '@simodelne/pgas-server/plugin.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createPgasNewFoundryProgramEntry } from '../../src/foundry-program/registration.js';

type UnifiedComplete = UnifiedAuthorDriverOptions['complete'];

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('foundry synthesizer marker observability', () => {
  it('writes the mechanical synthesis marker into the session log for synthesize_program_spec', async () => {
    const logRoot = trackedTempRoot('pgas-new-synth-log-');
    const targetRoot = trackedTempRoot('pgas-new-synth-target-');
    const previousLogDir = process.env.PGAS_SESSION_LOG_DIR;
    process.env.PGAS_SESSION_LOG_DIR = logRoot;

    const server = await createSyntheticFoundryServer(targetRoot);
    let sessionId = '';

    try {
      const created = await fetchJson<{ sessionId: string }>(server, '/sessions', {
        method: 'POST',
        body: JSON.stringify({ program: 'pgas-new' }),
      });
      sessionId = created.sessionId;

      for (const payload of [
        'Create an incident triage PGAS program.',
        'Use the design path.',
        'Route incoming incidents into a triage workflow.',
        'user_text',
        'intake, triage, resolved',
        'intake to triage, then triage to resolved.',
        'No delegation.',
        'Resolved when triage.summary_ready is true.',
        'Finalize intake.',
      ]) {
        await fetchJson(server, `/sessions/${sessionId}/trigger`, {
          method: 'POST',
          body: JSON.stringify({ channel: 'user_text', payload }),
        });
      }
      await fetchJson(server, `/sessions/${sessionId}/trigger`, {
        method: 'POST',
        body: JSON.stringify({ channel: 'user_confirmation', payload: { decision: 'approve' } }),
      });
      await waitForSessionLog(logRoot, sessionId, ['synthesize_program_spec', 'mechanical_synthesis', 'plan_artifacts']);
    } finally {
      await server.close();
      restoreEnv('PGAS_SESSION_LOG_DIR', previousLogDir);
    }

    const logText = readFileSync(join(logRoot, sessionId, 'session-log.ndjson'), 'utf8');

    expect(logText).toContain('synthesize_program_spec');
    expect(logText).toContain('mechanical_synthesis');
    expect(logText).toContain('no_llm_call');
    expect(logText).toContain('mode_names');
    expect(logText).toContain('sha256');
  });
});

async function createSyntheticFoundryServer(targetRoot: string) {
  let index = 0;
  const scriptedActions = [
    toolCall('record_program_target', {
      slug: 'incident-triage',
      name: 'Incident Triage',
      target_dir: join(targetRoot, 'incident-triage'),
    }),
    toolCall('choose_design_path', { choice: 'design' }),
    toolCall('record_q1_purpose', {
      purpose: 'Route incoming incidents into a triage workflow.',
    }),
    toolCall('record_q2_entry_channel', { entry_channel: 'user_text' }),
    toolCall('record_q3_stages', {
      stages_json: JSON.stringify([
        { slug: 'intake', is_bootstrap: true },
        { slug: 'triage' },
        { slug: 'resolved', is_terminal: true },
      ]),
    }),
    toolCall('record_q4_transitions', {
      transitions_json: JSON.stringify([
        { from: 'intake', to: 'triage', trigger: 'ready', guard_field: 'intake.started' },
        { from: 'triage', to: 'resolved', trigger: 'summary_ready', guard_field: 'triage.summary_ready' },
      ]),
    }),
    toolCall('record_q5_delegation', { delegation_json: JSON.stringify({}) }),
    toolCall('record_q6_completion', {
      completion_json: JSON.stringify({ final_stage: 'resolved', guard_field: 'triage.summary_ready' }),
    }),
    toolCall('record_program_intake_finalize', {}),
    toolCall('confirm_design', {}),
  ];

  const complete: UnifiedComplete = async (_messages, tools) => {
    const toolNames = tools.map((tool) => tool.function.name);
    if (index < scriptedActions.length) {
      return scriptedActions[index++];
    }
    if (toolNames.includes('authorize_standalone_target')) {
      return toolCall('authorize_standalone_target', {});
    }
    if (toolNames.includes('synthesize_program_spec')) {
      return toolCall('synthesize_program_spec', {});
    }
    if (toolNames.includes('plan_artifacts')) {
      return toolCall('plan_artifacts', {});
    }
    return toolCall('session_status', {});
  };

  return createPgasServer({
    programs: [{ name: 'pgas-new', entry: createPgasNewFoundryProgramEntry() }],
    drivers: {
      authorHandle: {
        modelId: 'synthesizer-marker-test',
        async complete() {
          throw new Error('legacy author path should not run in synthesizer marker test');
        },
      },
      observerHandle: {
        modelId: 'synthesizer-marker-test-observer',
        async complete() {
          return 'noop';
        },
      },
      authorMode: 'unified',
      unified: { complete },
    },
    devMode: true,
    telemetry: { enabled: false },
    port: 0,
  });
}

async function waitForSessionLog(logRoot: string, sessionId: string, expected: string[]): Promise<void> {
  const logPath = join(logRoot, sessionId, 'session-log.ndjson');
  const deadline = Date.now() + 2_000;
  let latest = '';

  while (Date.now() < deadline) {
    if (existsSync(logPath)) {
      latest = readFileSync(logPath, 'utf8');
      if (expected.every((text) => latest.includes(text))) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`timed out waiting for session log markers: ${expected.join(', ')}`);
}

function toolCall(name: string, args: Record<string, unknown>): { tool_calls: Array<{ id: string; function: { name: string; arguments: string } }> } {
  return {
    tool_calls: [
      {
        id: `call_${name}`,
        function: {
          name,
          arguments: JSON.stringify(args),
        },
      },
    ],
  };
}

async function fetchJson<T>(server: Awaited<ReturnType<typeof createSyntheticFoundryServer>>, path: string, init?: RequestInit): Promise<T> {
  const response = await server.app.fetch(new Request(`http://local${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  }));
  const body = await response.json() as T;
  if (!response.ok) {
    throw new Error(`request failed ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function trackedTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function restoreEnv(key: string, previousValue: string | undefined): void {
  if (previousValue === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = previousValue;
}
