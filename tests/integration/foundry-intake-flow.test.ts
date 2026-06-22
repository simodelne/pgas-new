import { createTestHarness, type TestHarnessAuthorResponse } from '@simodelne/pgas-server/testing.js';
import { createToolRegistry } from '@simodelne/pgas-server/plugin.js';
import { describe, expect, it } from 'vitest';
import { createPgasNewFoundryProgramEntry } from '../../src/foundry-program/registration.js';
import { handlers } from '../../src/foundry-program/handlers.js';
import { registerPgasNewTools } from '../../src/foundry-program/tools.js';
import { parseUserConfirmationControl, type UserConfirmationPayload } from '../../src/repl/runner.js';

const intakeToolNames = [
  'record_program_target',
  'choose_design_path',
  'apply_default_skeleton',
  'record_program_intake',
  'confirm_design',
] as const;

const defaultStages = [
  { slug: 'start', is_bootstrap: true },
  { slug: 'working' },
  { slug: 'complete', is_terminal: true },
];

const defaultTransitions = [
  { from: 'start', to: 'working', trigger: 'auto' },
  {
    from: 'working',
    to: 'complete',
    trigger: 'auto',
    guard_field: 'work.example_ready',
    guard_value: true,
  },
];

const designStages = [
  { slug: 'intake', is_bootstrap: true },
  { slug: 'triage' },
  { slug: 'done', is_terminal: true },
];

const designTransitions = [
  { from: 'intake', to: 'triage', trigger: 'details_ready' },
  { from: 'triage', to: 'done', trigger: 'summary_ready', guard_field: 'work.summary_ready' },
];

const designDelegation = { strategy: 'none' };
const designCompletion = { final_stage: 'done', guard_field: 'work.summary_ready' };

function effect(name: string, payload: Record<string, unknown>): TestHarnessAuthorResponse {
  return {
    actions: [
      {
        kind: 'EffectAction',
        name,
        channel: 'widget_output',
        payload,
      },
    ],
  };
}

async function driveIntakeFork(choice: 'design' | 'default') {
  const authorResponses: TestHarnessAuthorResponse[] = [
    effect('record_program_target', {
      slug: 'incident-triage',
      name: 'Incident Triage',
      target_dir: '/tmp/incident-triage',
    }),
    effect('choose_design_path', { choice }),
    choice === 'design'
      ? effect('record_program_intake', {
          purpose: 'Route incidents into a triage workflow.',
          entry_channel: 'user_text',
          stages_json: JSON.stringify(designStages),
          transitions_json: JSON.stringify(designTransitions),
          delegation_json: JSON.stringify(designDelegation),
          completion_json: JSON.stringify(designCompletion),
        })
      : effect('apply_default_skeleton', {}),
    effect('confirm_design', { approved: true }),
  ];

  const harness = await createTestHarness(createPgasNewFoundryProgramEntry(), {
    programName: 'pgas-new',
    defaultChannel: 'user_text',
    authorResponses,
  });

  try {
    await harness.trigger('Create an incident triage PGAS program.');
    await harness.trigger(choice === 'design' ? 'I want to design it.' : 'Use the default skeleton.');
    await harness.trigger(choice === 'design' ? 'Here are the six design answers.' : 'Apply the default.');
    await harness.trigger(replConfirmation('/approve'));

    return await harness.snapshot();
  } finally {
    await harness.close();
  }
}

function replConfirmation(input: string): { channel: 'user_confirmation'; payload: UserConfirmationPayload } {
  const payload = parseUserConfirmationControl(input);
  if (!payload) throw new Error(`invalid REPL confirmation control: ${input}`);
  return { channel: 'user_confirmation', payload };
}

describe('foundry intake flow', () => {
  it('registers the five intake tools and returns structured handler outputs', async () => {
    const registry = createToolRegistry();
    registerPgasNewTools(registry);

    for (const toolName of intakeToolNames) {
      expect(registry.has(toolName)).toBe(true);
    }

    await expect(handlers.record_program_target({ target_dir: '/tmp/incident-triage' })).resolves.toEqual({
      kind: 'pgas_new_target_recorded',
      target_dir: '/tmp/incident-triage',
      confirmed: true,
    });
    await expect(handlers.choose_design_path({ choice: 'design' })).resolves.toEqual({
      kind: 'pgas_new_design_path_chosen',
      choice: 'design',
    });
    await expect(handlers.apply_default_skeleton({})).resolves.toEqual({
      kind: 'pgas_new_default_skeleton_applied',
      stages: defaultStages,
      transitions: defaultTransitions,
    });
    await expect(
      handlers.record_program_intake({
        purpose: 'Route incidents into a triage workflow.',
        entry_channel: 'user_text',
        stages_json: JSON.stringify(designStages),
        transitions_json: JSON.stringify(designTransitions),
        delegation_json: JSON.stringify(designDelegation),
        completion_json: JSON.stringify(designCompletion),
      }),
    ).resolves.toEqual({
      kind: 'pgas_new_intake_recorded',
      purpose: 'Route incidents into a triage workflow.',
      entry_channel: 'user_text',
      stages: designStages,
      transitions: designTransitions,
      delegation: designDelegation,
      completion: designCompletion,
    });
    await expect(handlers.confirm_design({})).resolves.toEqual({
      kind: 'pgas_new_design_confirmed',
      approved: true,
    });
  });

  it('drives the Q1-Q6 design fork to architecture_design', async () => {
    const snapshot = await driveIntakeFork('design');

    expect(snapshot.mode).toBe('architecture_design');
    expect(snapshot.domain['program.design_path']).toBe('design');
    expect(snapshot.domain['program.target_dir_confirmed']).toBe(true);
    expect(snapshot.domain['intake.program_intake_recorded']).toBe(true);
    expect(snapshot.domain['program.design_confirmed']).toBe(true);
    expect(snapshot.domain['intake.stages_json']).toBe(JSON.stringify(designStages));
    expect(snapshot.domain['intake.transitions_json']).toBe(JSON.stringify(designTransitions));
  });

  it('drives the default skeleton fork to architecture_design', async () => {
    const snapshot = await driveIntakeFork('default');

    expect(snapshot.mode).toBe('architecture_design');
    expect(snapshot.domain['program.design_path']).toBe('default');
    expect(snapshot.domain['program.target_dir_confirmed']).toBe(true);
    expect(snapshot.domain['intake.program_intake_recorded']).toBe(true);
    expect(snapshot.domain['program.design_confirmed']).toBe(true);
    expect(snapshot.domain['intake.stages_json']).toBe(JSON.stringify(defaultStages));
    expect(snapshot.domain['intake.transitions_json']).toBe(JSON.stringify(defaultTransitions));
  });
});
