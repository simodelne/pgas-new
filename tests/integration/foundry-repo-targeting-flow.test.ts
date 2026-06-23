import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHarness, type TestHarnessAuthorResponse } from '@simodelne/pgas-server/testing.js';
import { afterEach, describe, expect, it } from 'vitest';
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

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('foundry repo_targeting continuation flow', () => {
  it('routes confirm_design through repo_targeting, authorizes standalone writes, then enters architecture_design', async () => {
    const harness = await createTestHarness(createPgasNewFoundryProgramEntry(), {
      programName: 'pgas-new',
      defaultChannel: 'user_text',
      authorResponses: [
        effect('record_program_target', {
          slug: 'incident-triage',
          name: 'Incident Triage',
          target_dir: '/tmp/incident-triage',
        }),
        effect('choose_design_path', { choice: 'design' }),
        effect('record_q1_purpose', {
          purpose: 'Route incoming incidents into a triage workflow.',
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
        effect('record_program_intake_finalize', {}),
        effect('confirm_design', { approved: true }),
        effect('authorize_standalone_target', {}),
        effect('synthesize_program_spec', {}),
        effect('plan_artifacts', {}),
      ],
    });

    try {
      await harness.trigger('Create an incident triage PGAS program.');
      await harness.trigger('I want to design it.');
      await harness.trigger('Route incoming incidents into a triage workflow.');
      await harness.trigger('user_text');
      await harness.trigger('intake, triage, resolved');
      await harness.trigger('intake to triage, then triage to resolved.');
      await harness.trigger('No delegation.');
      await harness.trigger('Resolved when triage.summary_ready is true.');
      await harness.trigger('Finalize intake.');
      await harness.trigger({ channel: 'user_confirmation', payload: { decision: 'approve' } });

      const snapshot = await waitForSnapshot(
        harness,
        (candidate) => candidate.mode === 'scaffold_plan' && candidate.domain['artifact_plan.status'] === 'draft',
        'repo targeting continuation to scaffold artifact plan',
      );
      const rounds = terminalRounds(snapshot.rounds);

      expect(rounds.find((round) => round.name === 'confirm_design')?.proposedMode).toBe('repo_targeting');
      expect(rounds.find((round) => round.name === 'authorize_standalone_target')?.proposedMode).toBe(
        'architecture_design',
      );
      expect(rounds.map((round) => round.name)).toEqual(
        expect.arrayContaining(['confirm_design', 'authorize_standalone_target', 'synthesize_program_spec']),
      );
      expect(snapshot.mode).toBe('scaffold_plan');
      expect(snapshot.domain['repo.target_kind']).toBe('standalone_repo');
      expect(snapshot.domain['repo.write_authorized']).toBe(true);
      expect(snapshot.domain['program.synthesis_complete']).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('auto-continues existing-repo target selection into wiring manifest loading', async () => {
    const targetDir = trackedTempRoot('pgas-new-existing-repo-');
    mkdirSync(join(targetDir, '.pgas'), { recursive: true });
    writeFileSync(join(targetDir, '.pgas/wiring.yml'), manifestYaml());
    const harness = await createTestHarness(createPgasNewFoundryProgramEntry(), {
      programName: 'pgas-new',
      defaultChannel: 'user_text',
      authorResponses: [
        effect('record_program_target', {
          slug: 'incident-triage',
          name: 'Incident Triage',
          target_dir: targetDir,
        }),
        effect('choose_design_path', { choice: 'default' }),
        effect('apply_default_skeleton', {}),
        effect('confirm_design', { approved: true }),
        effect('select_repo_target', { target_kind: 'existing_repo' }),
        effect('load_wiring_manifest', { repo_root: targetDir }),
        effect('authorize_existing_repo_target', {}),
        effect('synthesize_program_spec', {}),
        effect('plan_artifacts', {}),
      ],
    });

    try {
      await harness.trigger('Attach incident triage to this existing repo.');
      await harness.trigger('Use the default skeleton.');
      await harness.trigger('Apply the default.');
      await harness.trigger({ channel: 'user_confirmation', payload: { decision: 'approve' } });

      const snapshot = await waitForSnapshot(
        harness,
        (candidate) => candidate.mode === 'scaffold_plan' && candidate.domain['artifact_plan.status'] === 'draft',
        'existing-repo target selection continuation to artifact planning',
      );
      const rounds = terminalRounds(snapshot.rounds);

      expect(rounds.map((round) => round.name)).toEqual(
        expect.arrayContaining([
          'select_repo_target',
          'load_wiring_manifest',
          'authorize_existing_repo_target',
          'synthesize_program_spec',
          'plan_artifacts',
        ]),
      );
      expect(rounds.find((round) => round.name === 'select_repo_target')?.trigger).toBe('system_mode_entry');
      expect(rounds.find((round) => round.name === 'load_wiring_manifest')?.trigger).toBe('system_mode_entry');
      expect(snapshot.domain['repo.target_kind']).toBe('existing_repo');
      expect(snapshot.domain['repo.write_authorized']).toBe(true);
      expect(snapshot.domain['repo.wiring_manifest.status']).toBe('valid');
      expect(snapshot.domain['repo.wiring_manifest.path']).toBe('.pgas/wiring.yml');
    } finally {
      await harness.close();
    }
  });
});

function effect(name: string, payload: Record<string, unknown>): TestHarnessAuthorResponse {
  return {
    actions: [
      {
        kind: 'EffectAction',
        name,
        channel: name === 'plan_artifacts' ? 'artifact_plan_output' : 'widget_output',
        payload,
      },
    ],
  };
}

function terminalRounds(rounds: unknown[]): Array<{ name: string; proposedMode?: string; trigger?: string }> {
  return rounds.flatMap((round) => {
    if (!round || typeof round !== 'object' || Array.isArray(round)) return [];
    const trigger = (round as { trigger?: unknown }).trigger;
    const result = (round as { result?: unknown }).result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
    const terminal = (result as { terminal?: unknown }).terminal;
    if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)) return [];
    const name = (terminal as { name?: unknown }).name;
    const proposedMode = (result as { proposedMode?: unknown }).proposedMode;
    if (typeof name !== 'string') return [];
    return [{
      name,
      proposedMode: typeof proposedMode === 'string' ? proposedMode : undefined,
      trigger: typeof trigger === 'string' ? trigger : undefined,
    }];
  });
}

function trackedTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function manifestYaml(): string {
  return `schema_version: 1
repo:
  kind: existing_repo
  package_manager: npm
pgas:
  server_package: "@simodelne/pgas-server"
  allowed_imports:
    - "@simodelne/pgas-server/plugin.js"
    - "@simodelne/pgas-server/create-server.js"
    - "@simodelne/pgas-server/client.js"
    - "@simodelne/pgas-server/channels/index.js"
    - "@simodelne/pgas-server/routes/index.js"
paths:
  programs_dir: programs
  audit_dir: audit
  pgas_new_dir: .pgas/pgas-new
registration:
  strategy: curator_request
verification:
  commands:
    install: "npm install --no-audit --no-fund"
    typecheck: "npm run typecheck"
    test: "npm test"
curator:
  github_owner: simodelne
  github_repo: simoneos
`;
}
