import { createTestHarness, type TestHarnessAuthorResponse } from '@simodelne/pgas-server/testing.js';
import { createToolRegistry } from '@simodelne/pgas-server/plugin.js';
import { describe, expect, it } from 'vitest';
import { createPgasNewFoundryProgramEntry } from '../../src/foundry-program/registration.js';
import { handlers } from '../../src/foundry-program/handlers.js';
import { registerPgasNewTools } from '../../src/foundry-program/tools.js';
import { parseUserConfirmationControl, type UserConfirmationPayload } from '../../src/repl/runner.js';
import { terminalActionNames, waitForSnapshot } from './foundry-test-utils.js';

const intakeToolNames = [
  'record_program_target',
  'choose_design_path',
  'apply_default_skeleton',
  'ask_design_question',
  'record_q1_purpose',
  'record_q2_entry_channel',
  'record_q3_stages',
  'record_q4_transitions',
  'record_q5_delegation',
  'record_q6_completion',
  'record_program_intake_finalize',
  'confirm_design',
  'reject_design_and_revise_q1',
  'reject_design_and_revise_q2',
  'reject_design_and_revise_q3',
  'reject_design_and_revise_q4',
  'reject_design_and_revise_q5',
  'reject_design_and_revise_q6',
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

const questionByRound = [
  'Q1 Purpose -- one sentence on what the program does.',
  'Q2 Entry channel -- how does work arrive?',
  'Q3 Stages of work -- name the stages in order.',
  'Q4 Decision points -- branches, loops, or bail-outs?',
  'Q5 Delegation -- does any stage delegate?',
  'Q6 Completion criteria -- how do you know it is done?',
];

const answerByRound = [
  'to triage incidents from PagerDuty',
  'PagerDuty webhooks',
  'intake, triage, resolution',
  'loop from triage back to intake when details are incomplete',
  'no child-session delegation',
  'final stage resolution with guard incident_resolved',
];

const designIntakeRecordActions = [
  effect('record_q1_purpose', {
    purpose: 'Route incidents into a triage workflow.',
  }),
  effect('record_q2_entry_channel', {
    entry_channel: 'user_text',
  }),
  effect('record_q3_stages', {
    stages_json: JSON.stringify(designStages),
  }),
  effect('record_q4_transitions', {
    transitions_json: JSON.stringify(designTransitions),
  }),
  effect('record_q5_delegation', {
    delegation_json: JSON.stringify(designDelegation),
  }),
  effect('record_q6_completion', {
    completion_json: JSON.stringify(designCompletion),
  }),
];

const qActionCases = [
  {
    action: 'record_q1_purpose',
    payload: { purpose: answerByRound[0] },
    flag: 'intake.q1_recorded',
  },
  {
    action: 'record_q2_entry_channel',
    payload: { entry_channel: 'webhook' },
    flag: 'intake.q2_recorded',
  },
  {
    action: 'record_q3_stages',
    payload: {
      stages_json: JSON.stringify([
        { slug: 'intake', is_bootstrap: true },
        { slug: 'triage' },
        { slug: 'resolution', is_terminal: true },
      ]),
    },
    flag: 'intake.q3_recorded',
  },
  {
    action: 'record_q4_transitions',
    payload: {
      transitions_json: JSON.stringify([
        { from: 'intake', to: 'triage', trigger: 'incident_received' },
        {
          from: 'triage',
          to: 'intake',
          trigger: 'details_incomplete',
          guard_field: 'work.details_incomplete',
          guard_value: true,
        },
        {
          from: 'triage',
          to: 'resolution',
          trigger: 'incident_resolved',
          guard_field: 'incident_resolved',
          guard_value: true,
        },
      ]),
    },
    flag: 'intake.q4_recorded',
  },
  {
    action: 'record_q5_delegation',
    payload: { delegation_json: JSON.stringify({ strategy: 'none' }) },
    flag: 'intake.q5_recorded',
  },
  {
    action: 'record_q6_completion',
    payload: {
      completion_json: JSON.stringify({ final_stage: 'resolution', guard_field: 'incident_resolved' }),
    },
    flag: 'intake.q6_recorded',
  },
] as const;

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

function questionPause(questionNumber: number, questionText: string): TestHarnessAuthorResponse {
  return effect('ask_design_question', {
    question_number: questionNumber,
    question_text: questionText,
  });
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
      ? designIntakeRecordActions
      : effect('apply_default_skeleton', {}),
    ...(choice === 'design' ? [effect('record_program_intake_finalize', {})] : []),
    effect('confirm_design', { approved: true }),
  ].flat();

  const harness = await createTestHarness(createPgasNewFoundryProgramEntry(), {
    programName: 'pgas-new',
    defaultChannel: 'user_text',
    authorResponses,
  });

  try {
    await harness.trigger('Create an incident triage PGAS program.');
    await harness.trigger(choice === 'design' ? 'I want to design it.' : 'Use the default skeleton.');
    if (choice === 'design') {
      for (const answer of answerByRound) {
        await harness.trigger(answer);
      }
      await harness.trigger('Finalize the design intake.');
    } else {
      await harness.trigger('Apply the default.');
    }
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
  it('registers the chained intake tools and returns structured handler outputs', async () => {
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
    await expect(handlers.ask_design_question({
      question_number: 1,
      question_text: questionByRound[0],
    })).resolves.toEqual({
      kind: 'ask_design_question',
      question_number: 1,
      question_text: questionByRound[0],
    });
    await expect(handlers.record_q1_purpose({ purpose: 'Route incidents into a triage workflow.' })).resolves.toEqual({
      kind: 'pgas_new_q1_purpose_recorded',
      purpose: 'Route incidents into a triage workflow.',
    });
    await expect(handlers.record_q2_entry_channel({ entry_channel: 'user_text' })).resolves.toEqual({
      kind: 'pgas_new_q2_entry_channel_recorded',
      entry_channel: 'user_text',
    });
    await expect(handlers.record_q3_stages({ stages_json: JSON.stringify(designStages) })).resolves.toEqual({
      kind: 'pgas_new_q3_stages_recorded',
      stages: designStages,
      stages_json: JSON.stringify(designStages),
    });
    await expect(handlers.record_q4_transitions({ transitions_json: JSON.stringify(designTransitions) })).resolves.toEqual({
      kind: 'pgas_new_q4_transitions_recorded',
      transitions: designTransitions,
      transitions_json: JSON.stringify(designTransitions),
    });
    await expect(handlers.record_q5_delegation({ delegation_json: JSON.stringify(designDelegation) })).resolves.toEqual({
      kind: 'pgas_new_q5_delegation_recorded',
      delegation: designDelegation,
      delegation_json: JSON.stringify(designDelegation),
    });
    await expect(handlers.record_q6_completion({ completion_json: JSON.stringify(designCompletion) })).resolves.toEqual({
      kind: 'pgas_new_q6_completion_recorded',
      completion: designCompletion,
      completion_json: JSON.stringify(designCompletion),
    });
    await expect(handlers.record_program_intake_finalize({})).resolves.toEqual({
      kind: 'pgas_new_intake_finalized',
      finalized: true,
    });
    await expect(handlers.confirm_design({})).resolves.toEqual({
      kind: 'pgas_new_design_confirmed',
      approved: true,
    });
    await expect(handlers.reject_design_and_revise_q3({})).resolves.toEqual({
      kind: 'pgas_new_design_revision_requested',
      question_number: 3,
    });
  });

  it('drives the Q1-Q6 design fork to repo_targeting', async () => {
    const snapshot = await driveIntakeFork('design');

    expect(snapshot.mode).toBe('repo_targeting');
    expect(snapshot.domain['program.design_path']).toBe('design');
    expect(snapshot.domain['program.target_dir_confirmed']).toBe(true);
    for (let q = 1; q <= 6; q += 1) {
      expect(snapshot.domain[`intake.q${q}_recorded`]).toBe(true);
    }
    expect(snapshot.domain['intake.program_intake_finalized']).toBe(true);
    expect(snapshot.domain['program.design_confirmed']).toBe(true);
    expect(snapshot.domain['intake.stages_json']).toBe(JSON.stringify(designStages));
    expect(snapshot.domain['intake.transitions_json']).toBe(JSON.stringify(designTransitions));
  });

  it('waits through one-question-per-round intake prompts before recording Q1-Q6', async () => {
    const authorResponses: TestHarnessAuthorResponse[] = [
      effect('record_program_target', {
        slug: 'incident-triage',
        name: 'Incident Triage',
        target_dir: '/tmp/incident-triage',
      }),
      effect('choose_design_path', { choice: 'design' }),
      ...qActionCases.flatMap((actionCase, index) => [
        questionPause(index + 1, questionByRound[index] as string),
        effect(actionCase.action, actionCase.payload),
      ]),
      effect('record_program_intake_finalize', {}),
    ];

    const harness = await createTestHarness(createPgasNewFoundryProgramEntry(), {
      programName: 'pgas-new',
      defaultChannel: 'user_text',
      authorResponses,
    });

    try {
      await harness.trigger('Create an incident triage PGAS program.');
      await harness.trigger('I want to design it.');

      for (let i = 0; i < questionByRound.length; i += 1) {
        await harness.trigger(i === 0 ? 'Ask the first intake question.' : `Ask intake question ${i + 1}.`);
        const questionSnapshot = await harness.snapshot();
        const currentFlag = qActionCases[i]?.flag;

        expect(questionSnapshot.mode).toBe('intake_intelligence');
        expect(questionSnapshot.domain['intake.program_intake_finalized']).not.toBe(true);
        expect(questionSnapshot.domain[currentFlag as string]).not.toBe(true);
        expect(questionSnapshot.lastResult).toMatchObject({
          kind: 'EffectAction',
          name: 'ask_design_question',
          payload: {
            question_number: i + 1,
            question_text: questionByRound[i],
          },
        });

        await harness.trigger(answerByRound[i] as string);
        const answerSnapshot = await harness.snapshot();

        expect(answerSnapshot.mode).toBe('intake_intelligence');
        expect(answerSnapshot.domain[currentFlag as string]).toBe(true);
        expect(answerSnapshot.domain['intake.program_intake_finalized']).not.toBe(true);
      }

      await harness.trigger('Finalize the six recorded answers.');
      const snapshot = await harness.snapshot();

      expect(snapshot.mode).toBe('intake_intelligence');
      expect(snapshot.domain['program.design_path']).toBe('design');
      for (let q = 1; q <= 6; q += 1) {
        expect(snapshot.domain[`intake.q${q}_recorded`]).toBe(true);
      }
      expect(snapshot.domain['intake.program_intake_finalized']).toBe(true);
      expect(snapshot.domain['intake.purpose']).toBe(answerByRound[0]);
      expect(snapshot.domain['intake.entry_channel']).toBe('webhook');
      expect(snapshot.domain['intake.completion_json']).toBe(
        JSON.stringify({ final_stage: 'resolution', guard_field: 'incident_resolved' }),
      );
    } finally {
      await harness.close();
    }
  });

  it('rejects attempts to skip a chained Q-action precondition', async () => {
    const blockedCases = [
      { attemptedIndex: 1, priorCount: 0, expectedMissingPath: 'intake.q1_recorded' },
      { attemptedIndex: 2, priorCount: 1, expectedMissingPath: 'intake.q2_recorded' },
      { attemptedIndex: 3, priorCount: 2, expectedMissingPath: 'intake.q3_recorded' },
      { attemptedIndex: 4, priorCount: 3, expectedMissingPath: 'intake.q4_recorded' },
      { attemptedIndex: 5, priorCount: 4, expectedMissingPath: 'intake.q5_recorded' },
      { attemptedIndex: null, priorCount: 5, expectedMissingPath: 'intake.q6_recorded' },
    ] as const;

    for (const blockedCase of blockedCases) {
      const attempted = blockedCase.attemptedIndex === null
        ? effect('record_program_intake_finalize', {})
        : effect(
            qActionCases[blockedCase.attemptedIndex].action,
            qActionCases[blockedCase.attemptedIndex].payload,
          );
      const authorResponses: TestHarnessAuthorResponse[] = [
        effect('record_program_target', {
          slug: 'incident-triage',
          name: 'Incident Triage',
          target_dir: '/tmp/incident-triage',
        }),
        effect('choose_design_path', { choice: 'design' }),
        ...qActionCases.slice(0, blockedCase.priorCount).map((actionCase) => effect(actionCase.action, actionCase.payload)),
        attempted,
      ];

      const harness = await createTestHarness(createPgasNewFoundryProgramEntry(), {
        programName: 'pgas-new',
        defaultChannel: 'user_text',
        authorResponses,
      });

      try {
        await harness.trigger('Create an incident triage PGAS program.');
        await harness.trigger('I want to design it.');
        for (let q = 0; q < blockedCase.priorCount; q += 1) {
          await harness.trigger(answerByRound[q] as string);
        }

        const result = await harness.trigger('Try to skip ahead.');
        const snapshot = await harness.snapshot();
        const lastRound = snapshot.rounds.at(-1) as
          | {
            protocol?: {
              repairAttempts?: Array<{
                failedGate?: string;
                failedPredicate?: { path?: string };
              }>;
            };
          }
          | undefined;

        expect(result).toMatchObject({
          kind: 'EffectAction',
          name: '__fallback__',
          payload: { ok: false },
        });
        expect(lastRound?.protocol?.repairAttempts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              failedGate: 'GKPrecondition',
              failedPredicate: expect.objectContaining({ path: blockedCase.expectedMissingPath }),
            }),
          ]),
        );
      } finally {
        await harness.close();
      }
    }
  });

  it('clears Q3 through Q6 when confirmation is rejected for a Q3 revision', async () => {
    const revisedStages = [
      { slug: 'intake', is_bootstrap: true },
      { slug: 'review' },
      { slug: 'complete', is_terminal: true },
    ];
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
        ...designIntakeRecordActions,
        effect('record_program_intake_finalize', {}),
        effect('reject_design_and_revise_q3', {}),
        effect('ask_design_question', {
          question_number: 3,
          question_text: 'Q3 Stages of work -- name the revised stages in order.',
        }),
        effect('record_q3_stages', { stages_json: JSON.stringify(revisedStages) }),
      ],
    });

    try {
      await harness.trigger('Create an incident triage PGAS program.');
      await harness.trigger('I want to design it.');
      for (const answer of answerByRound) {
        await harness.trigger(answer);
      }
      await harness.trigger('Finalize the design intake.');
      await harness.trigger(replConfirmation('/reject please change Q3 stages'));
      let snapshot = await waitForSnapshot(
        harness,
        (candidate) => terminalActionNames(candidate.rounds).includes('ask_design_question'),
        'Q3 revision rejection to re-ask Q3',
      );

      expect(snapshot.domain['intake.q1_recorded']).toBe(true);
      expect(snapshot.domain['intake.q2_recorded']).toBe(true);
      expect(snapshot.domain['intake.q3_recorded']).toBe(false);
      expect(snapshot.domain['intake.q4_recorded']).toBe(false);
      expect(snapshot.domain['intake.q5_recorded']).toBe(false);
      expect(snapshot.domain['intake.q6_recorded']).toBe(false);
      expect(snapshot.domain['intake.program_intake_finalized']).toBe(false);
      expect(snapshot.domain['program.design_confirmed']).toBe(false);
      expect(snapshot.domain['intake.last_question_asked']).toBe(3);

      await harness.trigger('intake, review, complete');
      snapshot = await harness.snapshot();

      expect(snapshot.domain['intake.q3_recorded']).toBe(true);
      expect(snapshot.domain['intake.q4_recorded']).toBe(false);
      expect(snapshot.domain['intake.program_intake_finalized']).toBe(false);
      expect(snapshot.domain['intake.stages_json']).toBe(JSON.stringify(revisedStages));
    } finally {
      await harness.close();
    }
  });

  it('drives the default skeleton fork to repo_targeting', async () => {
    const snapshot = await driveIntakeFork('default');

    expect(snapshot.mode).toBe('repo_targeting');
    expect(snapshot.domain['program.design_path']).toBe('default');
    expect(snapshot.domain['program.target_dir_confirmed']).toBe(true);
    for (let q = 1; q <= 6; q += 1) {
      expect(snapshot.domain[`intake.q${q}_recorded`]).toBe(true);
    }
    expect(snapshot.domain['intake.program_intake_finalized']).toBe(true);
    expect(snapshot.domain['program.design_confirmed']).toBe(true);
    expect(snapshot.domain['intake.stages_json']).toBe(JSON.stringify(defaultStages));
    expect(snapshot.domain['intake.transitions_json']).toBe(JSON.stringify(defaultTransitions));
  });
});
