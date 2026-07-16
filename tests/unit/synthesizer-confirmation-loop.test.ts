import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { loadSpecWithPatterns } from '@simodelne/pgas-server/plugin.js';
import { assertConfirmationPairingTerminals } from '../../src/foundry-program/composite-checks.js';
import {
  createConfirmationLoopChoreographCollectionReaction,
  createConfirmationLoopEnforceStatusReaction,
  createConfirmationLoopSaveDecisionReaction,
  synthesizeProgramSpecFromDomain,
  type SynthesizedSpec,
} from '../../src/foundry-program/synthesizer.js';

const baseDomain = {
  'program.slug': 'work-unit-flow',
  'program.name': 'Work Unit Flow',
  'program.target_dir': '/tmp/work-unit-flow',
  'program.design_path': 'design',
  'intake.purpose': 'Move generic work units through review until completion.',
  'intake.entry_channel': 'user_text',
  'intake.stages_json': JSON.stringify([
    { slug: 'intake', is_bootstrap: true },
    { slug: 'review_work' },
    { slug: 'complete', is_terminal: true },
  ]),
  'intake.transitions_json': JSON.stringify([
    { from: 'intake', to: 'review_work', trigger: 'started', guard_field: 'intake.started' },
    { from: 'review_work', to: 'complete', trigger: 'done', guard_field: 'work_units.all_terminal' },
  ]),
  'intake.delegation_json': JSON.stringify({ enabled: false }),
  'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'work_units.all_terminal' }),
};

const indexedLifecycle = {
  version: 1,
  name: 'work_units',
  item_label: 'work unit',
  storage: {
    items_path: 'work_units.items',
    event_path: 'work_units.pending_event_json',
    violation_path: 'work_units.lifecycle_violation_json',
    representation: 'indexed_array',
  },
  item: {
    id_field: 'id',
    status_field: 'status',
    schema: {
      id: 'string',
      title: 'string',
      proposed_text: 'string',
      user_instruction: 'string',
    },
  },
  statuses: [
    { name: 'pending', initial: true },
    { name: 'proposed' },
    { name: 'accepted', terminal: true },
    { name: 'skipped', terminal: true },
  ],
  transitions: [],
  aggregate: {
    guard_field: 'work_units.all_terminal',
    terminal_statuses: ['accepted', 'skipped'],
    require_non_empty: true,
  },
};

const confirmationLoop = {
  collection: 'work_units.items',
  proposed_status: 'proposed',
  seed: { source_stage: 'plan_work', id_prefix: 'unit' },
  decisions: {
    approve: { to: 'accepted' },
    revise: {
      to: 'proposed',
      requires_instruction: true,
      instruction_path: 'work_units.items.*.user_instruction',
      re_propose: true,
    },
    skip: { to: 'skipped' },
  },
  one_proposed_at_a_time: true,
  aggregate: {
    guard_field: 'work_units.all_terminal',
    terminal_statuses: ['accepted', 'skipped'],
  },
  stage: 'review_work',
  summary_path: 'summary.confirmation_loop',
  violation_path: 'work_units.confirmation_violation_json',
  pending_action_path: 'decisions.pending_review_work_action',
};

interface ParsedSpec {
  channels: Record<string, {
    direction: string;
    sync: string;
    structured_decision?: boolean;
    decision_targeting?: Record<string, unknown>;
  }>;
  confirmation_pairing?: {
    prefixes: string[];
    policy: string;
    terminals?: string[];
  };
  modes: Record<string, { channels?: string[]; vocabulary?: string[] }>;
  projection: Record<string, { include: string[]; exclude: string[] }>;
  schema: Record<string, string>;
  prompts: Record<string, string>;
  guidance: Record<string, string[]>;
  ingestion: Record<string, string[]>;
  reactions: Record<string, { event: string; watch?: string[]; write_scope: string[] }>;
  action_map: Record<string, {
    channel?: string;
    description?: string;
    awaits_user_decision?: { channel: string; intent?: string };
    mutations?: Array<{ op: string; path: string; value?: unknown; from_arg?: string }>;
  }>;
}

describe('confirmation_loop descriptor synthesis', () => {
  it('emits user_confirmation targeting, confirmation_pairing, propose_item, and an engine-valid spec', () => {
    const artifact = synthesizeProgramSpecFromDomain(domainWithLoop());
    const parsed = load(artifact.spec_yaml) as ParsedSpec;

    expect(parsed.channels.user_confirmation).toEqual({
      direction: 'In',
      sync: 'Async',
      structured_decision: true,
      decision_targeting: {
        collection: 'work_units.items',
        status_field: 'status',
        status_equals: 'proposed',
        select: 'first',
        index_path: 'inputs.user_decision.target_item_index',
        id_path: 'inputs.user_decision.target_item_id',
        title_path: 'inputs.user_decision.target_item_title',
        status_path: 'inputs.user_decision.target_item_status',
      },
    });
    expect(parsed.ingestion.user_confirmation).toEqual([
      'inputs.user_decision',
      'inputs.user_decision.decision',
      'inputs.user_decision.instruction',
      'inputs.user_decision.note_mode',
      'inputs.user_decision.timestamp',
      'inputs.user_decision.target_item_index',
      'inputs.user_decision.target_item_id',
      'inputs.user_decision.target_item_title',
      'inputs.user_decision.target_item_status',
    ]);
    expect(parsed.confirmation_pairing).toEqual({
      prefixes: ['work_units.items'],
      policy: 'reject',
      terminals: expect.arrayContaining(['propose_item', 'approve_item', 'revise_item', 'skip_item']),
    });
    expect(parsed.action_map.propose_item.awaits_user_decision).toEqual({
      channel: 'user_confirmation',
      intent: 'present_for_approval',
    });
    expect(parsed.action_map.propose_item.description).toContain('The runtime selects the item under review');
    expect(parsed.action_map.propose_item.mutations).toEqual([
      { op: 'MSet', path: 'review_work.proposal.proposed_text', value: '', from_arg: 'proposed_text' },
      { op: 'MAppend', path: 'review_work.proposal.log', value: 'proposed' },
    ]);
    expect(parsed.modes.review_work.vocabulary).toEqual([
      'propose_item',
      'record_user_note',
      'session_new',
      'session_abort_current',
      'session_status',
      'session_history',
      'session_resume',
      'session_help',
    ]);
    expect(parsed.modes.review_work.channels).toEqual(expect.arrayContaining(['user_confirmation', 'widget_output']));
    expect(parsed.projection.review_work.include).toEqual(expect.arrayContaining([
      'inputs.user_decision.target_item_index',
      'work_units.items.*.id',
      'work_units.items.*.title',
      'work_units.items.*.status',
      'work_units.all_terminal',
      'summary.confirmation_loop',
    ]));
    expect(parsed.projection.review_work.include).not.toContain('work_units.items');
    expect(parsed.reactions.save_review_work_decision).toEqual({
      event: 'AfterIngestion',
      watch: [
        'inputs.user_decision.decision',
        'inputs.user_decision.instruction',
        'inputs.user_decision.timestamp',
        'inputs.user_decision.target_item_index',
      ],
      write_scope: ['decisions.pending_review_work_action'],
    });
    expect(parsed.reactions.enforce_review_work_status).toEqual({
      event: 'AfterIngestion',
      watch: ['inputs.user_decision.decision', 'inputs.user_decision.timestamp'],
      write_scope: [
        'work_units.items.*.status',
        'work_units.items.*.user_instruction',
        'work_units.confirmation_violation_json',
        'summary.confirmation_loop.one_proposed_demotions',
        'summary.confirmation_loop.last_applied_decision',
        'work_units.all_terminal',
      ],
    });
    expect(parsed.reactions.choreograph_review_work_collection).toEqual({
      event: 'AfterRound',
      watch: [],
      write_scope: [
        'work_units.items.*',
        'summary.confirmation_loop.applied_proposal_count',
        'summary.confirmation_loop.seed_state',
      ],
    });
    expect(Object.keys(parsed.reactions).indexOf('save_review_work_decision')).toBeLessThan(
      Object.keys(parsed.reactions).indexOf('enforce_review_work_status'),
    );
    expect(parsed.schema).toMatchObject({
      'review_work.proposal': 'object',
      'review_work.proposal.proposed_text': 'string',
      'review_work.proposal.log': 'array',
      'summary.confirmation_loop.applied_proposal_count': 'number',
      'summary.confirmation_loop.seed_state': 'string',
    });
    expect(parsed.prompts.review_work).toContain('Work through the work units one at a time');
    expect(parsed.prompts.review_work).toContain('runtime selects the target item');
    expect(parsed.guidance.review_work).toEqual(expect.arrayContaining([
      expect.stringContaining('never write item statuses yourself'),
    ]));
    expect(artifact.handlers_ts).toContain("['save_review_work_decision', (snapshot, trigger, mode) =>");
    expect(artifact.handlers_ts).toContain("['enforce_review_work_status', (snapshot, trigger, mode) =>");
    expect(artifact.handlers_ts).toContain("['choreograph_review_work_collection', (snapshot, trigger, mode) =>");
    expect(artifact.handlers_ts).toContain('reconstructArray(Object.fromEntries(snapshot), itemsPath)');
    expect(artifact.smoke_test_ts).toContain('runs the confirmation loop choreography hermetically');
    expect(artifact.smoke_test_ts).toContain("title: 'Verify Pre-Launch System Health Checks'");
    expect(artifact.smoke_test_ts).toContain("status: 'pending_review'");
    expect(artifact.smoke_test_ts).not.toContain('complete_review_work');
    // Regression (confirmation live-drive RED, 2026-07-16 — SpecWiringError
    // HANDLER_NO_ACTION): the loop stage advances via the aggregate guard, not a
    // complete_<stage> action, so handlers_ts/tools_ts must NOT emit an orphaned
    // complete_review_work handler/tool. loadSpecWithPatterns does not run the
    // engine's validateSpecWiring; createPgasServer boot (and the live-drive) does.
    expect(artifact.handlers_ts).not.toContain('complete_review_work');
    expect(artifact.tools_ts).not.toContain('complete_review_work');
    expect(() => loadSpecWithPatterns(writeTempSpec(artifact.spec_yaml))).not.toThrow();
    expect(() => assertConfirmationPairingTerminals(parsed)).not.toThrow();
  });

  it('records user decisions and enforces approve, revise, skip, demotion, and aggregate status', () => {
    const save = createConfirmationLoopSaveDecisionReaction(confirmationLoop, indexedLifecycle);
    const enforce = createConfirmationLoopEnforceStatusReaction(confirmationLoop, indexedLifecycle);

    const approved = runEnforce(enforce, [
      { id: 'wu-1', title: 'One', status: 'proposed' },
      { id: 'wu-2', title: 'Two', status: 'pending' },
    ], savedPending(save, 'approve', 0));
    expect(approved.valueAt('work_units.items.0.status')).toBe('accepted');
    expect(approved.valueAt('summary.confirmation_loop.last_applied_decision')).toBe('2026-07-15T00:00:00.000Z');
    expect(approved.valueAt('work_units.all_terminal')).toBe(false);

    const revised = runEnforce(enforce, [
      { id: 'wu-1', title: 'One', status: 'proposed' },
      { id: 'wu-2', title: 'Two', status: 'pending' },
    ], savedPending(save, 'revise', 0, 'Tighten the summary.'));
    expect(revised.valueAt('work_units.items.0.status')).toBe('proposed');
    expect(revised.valueAt('work_units.items.0.user_instruction')).toBe('Tighten the summary.');

    const skipped = runEnforce(enforce, [
      { id: 'wu-1', title: 'One', status: 'proposed' },
      { id: 'wu-2', title: 'Two', status: 'accepted' },
    ], savedPending(save, 'skip', 0));
    expect(skipped.valueAt('work_units.items.0.status')).toBe('skipped');
    expect(skipped.valueAt('work_units.all_terminal')).toBe(true);

    const demoted = runEnforce(enforce, [
      { id: 'wu-1', title: 'One', status: 'proposed' },
      { id: 'wu-2', title: 'Two', status: 'proposed' },
    ], '');
    expect(demoted.valueAt('work_units.items.1.status')).toBe('pending');
    expect(JSON.parse(String(demoted.valueAt('work_units.confirmation_violation_json')))).toMatchObject({
      reason: 'multiple_proposed',
      demoted_index: 1,
      demoted_id: 'wu-2',
    });
    expect(demoted.valueAt('summary.confirmation_loop.one_proposed_demotions')).toBe(1);

    const aggregate = runEnforce(enforce, [
      { id: 'wu-1', title: 'One', status: 'accepted' },
      { id: 'wu-2', title: 'Two', status: 'skipped' },
    ], '');
    expect(aggregate.valueAt('work_units.all_terminal')).toBe(true);

    const fallback = runEnforce(enforce, [
      { id: 'wu-1', title: 'One', status: 'proposed' },
    ], '', [
      ['inputs.user_decision.decision', 'approve'],
      ['inputs.user_decision.instruction', ''],
      ['inputs.user_decision.timestamp', '2026-07-15T00:00:00.000Z'],
      ['inputs.user_decision.target_item_index', 0],
    ]);
    expect(fallback.valueAt('work_units.items.0.status')).toBe('accepted');
  });

  it('seeds items from the source stage and applies staged proposals once by nonce', () => {
    const choreograph = createConfirmationLoopChoreographCollectionReaction(confirmationLoop, indexedLifecycle);

    const objectChoreograph = createConfirmationLoopChoreographCollectionReaction(confirmationLoop, {
      ...clone(indexedLifecycle),
      item: {
        ...indexedLifecycle.item,
        schema: {
          ...indexedLifecycle.item.schema,
          description: 'string',
        },
      },
    });
    const objectSeeded = runChoreograph(objectChoreograph, [
      ['plan_work.items_json', JSON.stringify([
        {
          id: 'wu-1',
          title: 'Verify Pre-Launch System Health Checks',
          description: 'Confirm critical services are healthy before launch.',
          status: 'pending_review',
        },
        {
          id: 'wu-2',
          title: 'Validate Deployment Rollback Procedures',
          description: 'Check rollback commands and ownership before release.',
        },
      ])],
    ]);
    expect(objectSeeded.valueAt('work_units.items.0')).toEqual({
      id: 'wu-1',
      title: 'Verify Pre-Launch System Health Checks',
      proposed_text: '',
      user_instruction: '',
      description: 'Confirm critical services are healthy before launch.',
      status: 'pending',
    });
    expect(objectSeeded.valueAt('work_units.items.1')).toEqual({
      id: 'wu-2',
      title: 'Validate Deployment Rollback Procedures',
      proposed_text: '',
      user_instruction: '',
      description: 'Check rollback commands and ownership before release.',
      status: 'pending',
    });
    expect(objectSeeded.valueAt('summary.confirmation_loop.seed_state')).toBe('seeded');
    expect(objectSeeded.valueAt('summary.confirmation_loop.seed_state')).not.toBe('invalid_items_json');

    const mixedSeeded = runChoreograph(objectChoreograph, [
      ['plan_work.items_json', JSON.stringify([
        { name: 'Review fallback title source' },
        'Confirm owner handoff',
      ])],
    ]);
    expect(mixedSeeded.valueAt('work_units.items.0')).toMatchObject({
      id: 'unit-1',
      title: 'Review fallback title source',
      status: 'pending',
    });
    expect(mixedSeeded.valueAt('work_units.items.1')).toMatchObject({
      id: 'unit-2',
      title: 'Confirm owner handoff',
      status: 'pending',
    });
    expect(mixedSeeded.valueAt('summary.confirmation_loop.seed_state')).toBe('seeded');

    const seeded = runChoreograph(choreograph, [
      ['plan_work.items_json', JSON.stringify(['Draft launch checklist', 'Confirm owner handoff'])],
    ]);
    expect(seeded.valueAt('work_units.items.0')).toEqual({
      id: 'unit-1',
      title: 'Draft launch checklist',
      proposed_text: '',
      user_instruction: '',
      status: 'pending',
    });
    expect(seeded.valueAt('work_units.items.1')).toEqual({
      id: 'unit-2',
      title: 'Confirm owner handoff',
      proposed_text: '',
      user_instruction: '',
      status: 'pending',
    });
    expect(seeded.valueAt('summary.confirmation_loop.seed_state')).toBe('seeded');

    const invalidSeed = runChoreograph(choreograph, [
      ['plan_work.items_json', '{not json'],
    ]);
    expect(invalidSeed.valueAt('summary.confirmation_loop.seed_state')).toBe('invalid_items_json');

    const emptySeedArray = runChoreograph(choreograph, [
      ['plan_work.items_json', JSON.stringify([])],
    ]);
    expect(emptySeedArray.valueAt('summary.confirmation_loop.seed_state')).toBe('invalid_items_json');

    const invalidSeedArray = runChoreograph(choreograph, [
      ['plan_work.items_json', JSON.stringify(['valid title', 123])],
    ]);
    expect(invalidSeedArray.valueAt('summary.confirmation_loop.seed_state')).toBe('invalid_items_json');

    const applied = runChoreograph(choreograph, [
      ...flattenItems([
        { id: 'unit-1', title: 'Draft launch checklist', proposed_text: '', user_instruction: '', status: 'pending' },
        { id: 'unit-2', title: 'Confirm owner handoff', proposed_text: '', user_instruction: '', status: 'pending' },
      ]),
      ['review_work.proposal.proposed_text', 'First proposal'],
      ['review_work.proposal.log', ['proposed']],
      ['summary.confirmation_loop.applied_proposal_count', 0],
    ]);
    expect(applied.valueAt('work_units.items.0')).toEqual({
      id: 'unit-1',
      title: 'Draft launch checklist',
      proposed_text: 'First proposal',
      user_instruction: '',
      status: 'proposed',
    });
    expect(applied.valueAt('summary.confirmation_loop.applied_proposal_count')).toBe(1);

    const deduped = runChoreograph(choreograph, [
      ...flattenItems([
        { id: 'unit-1', title: 'Draft launch checklist', proposed_text: 'First proposal', user_instruction: '', status: 'proposed' },
        { id: 'unit-2', title: 'Confirm owner handoff', proposed_text: '', user_instruction: '', status: 'pending' },
      ]),
      ['review_work.proposal.proposed_text', 'First proposal'],
      ['review_work.proposal.log', ['proposed']],
      ['summary.confirmation_loop.applied_proposal_count', 1],
    ]);
    expect(deduped.mutations).toEqual([]);
  });

  it('rejects loops on json_string collections, undeclared statuses, and terminal stages', () => {
    expect(() =>
      synthesizeProgramSpecFromDomain(domainWithLoop({
        lifecycle: {
          ...clone(indexedLifecycle),
          storage: {
            ...indexedLifecycle.storage,
            items_path: 'work_units.items_json',
            representation: 'json_string',
          },
        },
        loop: { ...confirmationLoop, collection: 'work_units.items_json' },
      })),
    ).toThrow(/confirmation_loop collection must reference a collection_lifecycle with indexed_array storage/u);

    expect(() =>
      synthesizeProgramSpecFromDomain(domainWithLoop({
        loop: { ...confirmationLoop, proposed_status: 'drafted' },
      })),
    ).toThrow(/proposed_status.*declared non-terminal status/u);

    expect(() =>
      synthesizeProgramSpecFromDomain(domainWithLoop({
        loop: {
          ...confirmationLoop,
          decisions: { ...confirmationLoop.decisions, approve: { to: 'archived' } },
        },
      })),
    ).toThrow(/decision approve.*declared status/u);

    expect(() =>
      synthesizeProgramSpecFromDomain(domainWithLoop({
        loop: { ...confirmationLoop, stage: 'complete' },
      })),
    ).toThrow(/stage.*non-terminal mode/u);

    expect(() =>
      synthesizeProgramSpecFromDomain(domainWithLoop({
        loop: { ...confirmationLoop, seed: { source_stage: 'missing_stage' } },
      })),
    ).toThrow(/seed.source_stage must reference an earlier llm-reasoning stage/u);

    expect(() =>
      synthesizeProgramSpecFromDomain(domainWithLoop({
        loop: { ...confirmationLoop, seed: { source_stage: 'review_work' } },
      })),
    ).toThrow(/seed.source_stage must precede the confirmation_loop stage/u);

    expect(() =>
      synthesizeProgramSpecFromDomain(domainWithLoop({
        delegation: { plan_work: { kind: 'pure-compute' } },
      })),
    ).toThrow(/seed.source_stage must reference an earlier llm-reasoning stage/u);

    expect(() =>
      synthesizeProgramSpecFromDomain(domainWithLoop({
        lifecycle: {
          ...indexedLifecycle,
          transitions: [
            { from: 'pending', to: 'proposed', stage: 'review_work', action: 'draft_item', managed_by: 'llm' },
          ],
        },
      })),
    ).toThrow(/confirmation_loop lifecycles cannot declare managed_by llm transitions/u);
  });

  it('fails the pairing lint when a prefix-writing action is missing from terminals', () => {
    const parsed = load(synthesizeProgramSpecFromDomain(domainWithLoop()).spec_yaml) as ParsedSpec;
    const drifted = clone(parsed);
    drifted.action_map.write_item_directly = {
      mutations: [{ op: 'MSet', path: 'work_units.items.0.status', value: 'accepted' }],
    };
    drifted.confirmation_pairing = {
      prefixes: ['work_units.items'],
      policy: 'reject',
      terminals: ['propose_item', 'approve_item', 'revise_item', 'skip_item'],
    };

    expect(() => assertConfirmationPairingTerminals(drifted)).toThrow(/write_item_directly/u);
  });

  it('keeps no-interaction synthesis byte-identical to the pre-confirmation-loop baseline', () => {
    expect(hashArtifact(synthesizeProgramSpecFromDomain(baseDomain))).toEqual({
      spec_yaml: '0a6a33a160669ea32c740a3f9201300e304ea0c53659e2e989f81eb0f3716073',
      contracts_ts: '0887c0cf22f7eefd2b877e61d6dea3a938d952bbb349572a2fc9919523a74993',
      handlers_ts: '487b83115c463a60c3c53d3ccb21350e05a4f4d29a39d9f03ad77e804e56d04d',
      handlers_index_ts: '3fb01bfefde1d5a455f7ff53fbf48333c0e36dc9b49f7e82e6a3e5e56f342531',
      tools_ts: 'ba348055c634de2e2f58dd88a696d53614266b13c29ed03a9568cf3a3545bfe7',
      smoke_test_ts: 'cfb74d966744cd252918dd8820602ce9b762ea406a7cd39c26ff4e4edc821a92',
    });
  });
});

function domainWithLoop(overrides: {
  lifecycle?: unknown;
  loop?: unknown;
  delegation?: unknown;
} = {}): Record<string, unknown> {
  const lifecycle = overrides.lifecycle ?? indexedLifecycle;
  const loop = overrides.loop ?? confirmationLoop;
  return {
    ...baseDomain,
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      { slug: 'plan_work' },
      { slug: 'review_work' },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'plan_work', trigger: 'started', guard_field: 'intake.started' },
      { from: 'plan_work', to: 'review_work', trigger: 'planned', guard_field: 'plan_work.done' },
      { from: 'review_work', to: 'complete', trigger: 'done', guard_field: 'work_units.all_terminal' },
    ]),
    'intake.delegation_json': JSON.stringify(overrides.delegation ?? {
      plan_work: { kind: 'llm-reasoning' },
    }),
    'intake.completion_json': JSON.stringify({
      final_stage: 'complete',
      guard_field: 'work_units.all_terminal',
      collection_lifecycle: lifecycle,
    }),
    'intake.interaction_json': JSON.stringify({ confirmation_loops: [loop] }),
  };
}

function savedPending(
  save: ReturnType<typeof createConfirmationLoopSaveDecisionReaction>,
  decision: string,
  targetIndex: number,
  instruction = '',
): string {
  const result = save(new Map<string, unknown>([
    ['inputs.user_decision.decision', decision],
    ['inputs.user_decision.instruction', instruction],
    ['inputs.user_decision.timestamp', '2026-07-15T00:00:00.000Z'],
    ['inputs.user_decision.target_item_index', targetIndex],
    ['inputs.user_decision.target_item_id', `wu-${targetIndex + 1}`],
    ['inputs.user_decision.target_item_title', `Item ${targetIndex + 1}`],
    ['inputs.user_decision.target_item_status', 'proposed'],
  ]), 'AfterIngestion', 'review_work');
  const pending = result?.mutations?.find((mutation) => mutation.path === 'decisions.pending_review_work_action')?.value;
  return String(pending ?? '');
}

function runEnforce(
  enforce: ReturnType<typeof createConfirmationLoopEnforceStatusReaction>,
  items: Array<Record<string, unknown>>,
  pending: string,
  extraEntries: Array<[string, unknown]> = [],
): { valueAt(path: string): unknown } {
  const snapshot = new Map<string, unknown>([
    ...flattenItems(items),
    ['decisions.pending_review_work_action', pending],
    ['summary.confirmation_loop.one_proposed_demotions', 0],
    ...extraEntries,
  ]);
  const result = enforce(snapshot, 'AfterIngestion', 'review_work');
  const values = new Map(result?.mutations?.map((mutation) => [mutation.path, mutation.value]));
  return {
    valueAt(path: string): unknown {
      return values.has(path) ? values.get(path) : snapshot.get(path);
    },
  };
}

function runChoreograph(
  choreograph: ReturnType<typeof createConfirmationLoopChoreographCollectionReaction>,
  entries: Array<[string, unknown]>,
): { mutations: Array<{ op: string; path: string; value?: unknown }>; valueAt(path: string): unknown } {
  const snapshot = new Map<string, unknown>(entries);
  const result = choreograph(snapshot, 'AfterRound', 'review_work');
  const mutations = result?.mutations ?? [];
  const values = new Map(mutations.map((mutation) => [mutation.path, mutation.value]));
  return {
    mutations,
    valueAt(path: string): unknown {
      return values.has(path) ? values.get(path) : snapshot.get(path);
    },
  };
}

function flattenItems(items: Array<Record<string, unknown>>): Array<[string, unknown]> {
  return items.flatMap((item, index) =>
    Object.entries(item).map(([field, value]) => [`work_units.items.${index}.${field}`, value] as [string, unknown]),
  );
}

function hashArtifact(artifact: SynthesizedSpec): Record<string, string> {
  return Object.fromEntries(
    (['spec_yaml', 'contracts_ts', 'handlers_ts', 'handlers_index_ts', 'tools_ts', 'smoke_test_ts'] as const)
      .map((key) => [key, createHash('sha256').update(artifact[key]).digest('hex')]),
  );
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function writeTempSpec(specYaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pgas-new-confirmation-loop-load-'));
  const specPath = join(dir, 'specs.yml');
  writeFileSync(specPath, specYaml);
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return specPath;
}
