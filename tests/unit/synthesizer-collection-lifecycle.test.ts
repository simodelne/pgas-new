import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { loadSpecWithPatterns } from '@simodelne/pgas-server/plugin.js';
import {
  createCollectionLifecycleApplyReaction,
  createCollectionLifecycleAllTerminalReaction,
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
    { from: 'review_work', to: 'complete', trigger: 'done', guard_field: 'review_work.done' },
  ]),
  'intake.delegation_json': JSON.stringify({ enabled: false }),
  'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'review_work.done' }),
};

const genericLifecycle = {
  version: 1,
  name: 'work_units',
  item_label: 'work unit',
  storage: {
    items_path: 'work_units.items_json',
    event_path: 'work_units.pending_event_json',
    violation_path: 'work_units.lifecycle_violation_json',
  },
  item: {
    id_field: 'id',
    status_field: 'status',
    schema: {
      id: 'string',
      title: 'string',
      summary: 'string',
      status: 'string',
    },
  },
  statuses: [
    { name: 'pending', initial: true },
    { name: 'in_review' },
    { name: 'accepted', terminal: true },
    { name: 'removed', terminal: true },
  ],
  transitions: [
    { from: 'pending', to: 'in_review', stage: 'review_work', action: 'start_review', managed_by: 'llm' },
    { from: 'in_review', to: 'accepted', stage: 'review_work', action: 'accept_work_unit', managed_by: 'reaction', trigger: 'user_confirmation' },
    { from: 'accepted', to: 'in_review', stage: 'review_work', action: 'reopen_work_unit', managed_by: 'llm', guard_field: 'review_work.reopen_requested' },
  ],
  aggregate: {
    guard_field: 'work_units.all_terminal',
    terminal_statuses: ['accepted', 'removed'],
    require_non_empty: true,
  },
};

interface ParsedSpec {
  channels: Record<string, { direction: string; sync: string }>;
  modes: Record<string, {
    channels?: string[];
    transitions?: Array<{ target: string; guard?: { kind: string; path: string } }>;
    vocabulary?: string[];
  }>;
  projection: Record<string, { include: string[]; exclude: string[] }>;
  schema: Record<string, string>;
  reactions: Record<string, { event: string; watch?: string[]; write_scope: string[] }>;
  action_map: Record<string, {
    channel?: string;
    result_path?: string;
    mutations?: Array<{ op: string; path: string; value?: unknown; from_arg?: string }>;
  }>;
}

describe('collection_lifecycle descriptor synthesis', () => {
  it('accepts a generic lifecycle descriptor and rejects invalid descriptors', () => {
    expect(() => synthesizeProgramSpecFromDomain(domainWithLifecycle(genericLifecycle))).not.toThrow();

    const invalidCases: Array<[string, (descriptor: typeof genericLifecycle) => void, RegExp]> = [
      ['no statuses', (descriptor) => { descriptor.statuses = []; }, /statuses/u],
      ['no initial status', (descriptor) => { descriptor.statuses = descriptor.statuses.map(({ initial: _initial, ...status }) => status); }, /initial/u],
      ['unknown from status', (descriptor) => { descriptor.transitions[0] = { ...descriptor.transitions[0], from: 'unknown' }; }, /unknown.*from/u],
      ['unknown to status', (descriptor) => { descriptor.transitions[0] = { ...descriptor.transitions[0], to: 'unknown' }; }, /unknown.*to/u],
      ['duplicate action names', (descriptor) => { descriptor.transitions[1] = { ...descriptor.transitions[1], action: 'start_review' }; }, /duplicate.*action/u],
      ['terminal status outside statuses', (descriptor) => { descriptor.aggregate.terminal_statuses = ['accepted', 'archived']; }, /terminal_statuses/u],
      ['missing aggregate guard field', (descriptor) => { descriptor.aggregate.guard_field = ''; }, /aggregate\.guard_field/u],
      ['unknown storage representation', (descriptor) => { descriptor.storage = { ...descriptor.storage, representation: 'flat_blob' } as typeof descriptor.storage; }, /storage\.representation/u],
    ];

    for (const [label, mutate, message] of invalidCases) {
      const descriptor = clone(genericLifecycle);
      mutate(descriptor);
      expect(
        () => synthesizeProgramSpecFromDomain(domainWithLifecycle(descriptor)),
        label,
      ).toThrow(message);
    }
  });

  it('emits lifecycle state paths, reactions, lifecycle intent actions, and completion guard wiring', () => {
    const artifact = synthesizeProgramSpecFromDomain(domainWithLifecycle(genericLifecycle));
    const parsed = load(artifact.spec_yaml) as ParsedSpec;

    expect(parsed.schema).toMatchObject({
      'work_units.items_json': 'string',
      'work_units.pending_event_json': 'string',
      'work_units.lifecycle_violation_json': 'string',
      'work_units.all_terminal': 'boolean',
    });
    expect(parsed.reactions.compute_work_units_all_terminal).toEqual({
      event: 'AfterRound',
      write_scope: ['work_units.all_terminal'],
    });
    expect(parsed.reactions.apply_work_units_lifecycle_event).toEqual({
      event: 'AfterRound',
      write_scope: [
        'work_units.items_json',
        'work_units.pending_event_json',
        'work_units.lifecycle_violation_json',
      ],
    });
    expect(parsed.modes.review_work.transitions).toEqual([
      { target: 'complete', guard: { kind: 'FieldTruthy', path: 'work_units.all_terminal' } },
    ]);
    expect(parsed.channels.lifecycle_event).toEqual({ direction: 'Out', sync: 'Sync' });
    expect(parsed.modes.review_work.vocabulary).toEqual(expect.arrayContaining(['start_review', 'reopen_work_unit']));
    expect(parsed.modes.review_work.channels).toEqual(expect.arrayContaining(['lifecycle_event']));
    expect(parsed.action_map.start_review).toEqual({
      description: 'Record a lifecycle intent for work unit status in_review.',
      result_path: 'work_units.pending_event_json',
      mutations: [],
      channel: 'lifecycle_event',
    });
    expect(parsed.action_map.reopen_work_unit).toEqual({
      description: 'Record a lifecycle intent for work unit status in_review.',
      result_path: 'work_units.pending_event_json',
      mutations: [],
      channel: 'lifecycle_event',
    });
    expect(parsed.action_map.start_review.mutations?.map((mutation) => mutation.path)).not.toContain('work_units.items_json');
    expect(parsed.action_map).not.toHaveProperty('accept_work_unit');
    expect(artifact.tools_ts).toContain('lifecycleActionTools');
    expect(artifact.tools_ts).toContain('start_review');
    expect(artifact.handlers_ts).toContain('async start_review(payload)');
    expect(artifact.handlers_ts).toContain("return collectionLifecycleIntentEvent(payload as HandlerPayload, 'start_review', 'in_review', 'pending');");
    expect(artifact.handlers_ts).toContain("['apply_work_units_lifecycle_event', (snapshot, trigger, mode) =>");
    expect(artifact.handlers_ts).toContain("['compute_work_units_all_terminal', (snapshot, trigger, mode) =>");
    expect(artifact.handlers_ts).toContain("'work_units.items_json'");
    expect(artifact.handlers_ts).toContain("'work_units.all_terminal'");
    expect(artifact.handlers_ts).toContain("return { mutations: [{ op: 'MSet' as const, path: 'work_units.all_terminal', value: allTerminal }] };");
    expect(() => loadSpecWithPatterns(writeTempSpec(artifact.spec_yaml))).not.toThrow();
  });

  it('keeps json_string collection storage on the exact legacy schema paths', () => {
    const jsonStringLifecycle = {
      ...clone(genericLifecycle),
      storage: {
        ...genericLifecycle.storage,
        representation: 'json_string' as const,
      },
    };
    const artifact = synthesizeProgramSpecFromDomain(domainWithLifecycle(jsonStringLifecycle));
    const parsed = load(artifact.spec_yaml) as ParsedSpec;

    expect(pickCollectionSchema(parsed.schema)).toEqual({
      'work_units.items_json': 'string',
      'work_units.pending_event_json': 'string',
      'work_units.lifecycle_violation_json': 'string',
      'work_units.all_terminal': 'boolean',
    });
  });

  it('emits indexed array schema paths and projects the array root for indexed collections', () => {
    const artifact = synthesizeProgramSpecFromDomain(domainWithLifecycle(indexedArrayLifecycle()));
    const parsed = load(artifact.spec_yaml) as ParsedSpec;

    expect(parsed.schema).toMatchObject({
      'work_units.items': 'array',
      'work_units.items.*': 'object',
      'work_units.items.*.id': 'string',
      'work_units.items.*.title': 'string',
      'work_units.items.*.priority': 'number',
      'work_units.items.*.status': 'string',
      'work_units.pending_event_json': 'string',
      'work_units.lifecycle_violation_json': 'string',
      'work_units.all_terminal': 'boolean',
    });
    expect(parsed.schema).not.toHaveProperty('work_units.items_json');
    expect(parsed.projection.review_work.include).toContain('work_units.items');
    expect(() => loadSpecWithPatterns(writeTempSpec(artifact.spec_yaml))).not.toThrow();
  });

  it('emits reconstructArray terminal checks instead of JSON parsing for indexed collections', () => {
    const artifact = synthesizeProgramSpecFromDomain(domainWithLifecycle(indexedArrayLifecycle()));

    expect(artifact.handlers_ts).toContain('reconstructArray(Object.fromEntries(snapshot), itemsPath)');
    expect(artifact.handlers_ts).toContain("'work_units.items'");
    expect(artifact.handlers_ts).not.toContain('const raw = snapshot.get(itemsPath);');
    expect(artifact.handlers_ts).not.toContain('const rawItems = snapshot.get(itemsPath);');
    expect(artifact.handlers_ts).not.toContain('parsed = JSON.parse(raw) as unknown;');
    expect(artifact.handlers_ts).not.toContain('value: JSON.stringify(nextItems)');
    expect(artifact.handlers_ts).toContain("path: itemsPath + '.' + itemIndex + '.' + statusField");
  });

  it('writes a managed-by-llm lifecycle intent event without changing item status', () => {
    const artifact = synthesizeProgramSpecFromDomain(domainWithLifecycle(genericLifecycle));
    const parsed = load(artifact.spec_yaml) as ParsedSpec;

    expect(parsed.action_map.start_review.result_path).toBe('work_units.pending_event_json');
    expect(parsed.action_map.start_review.mutations).toEqual([]);
    expect(parsed.action_map.start_review.result_path).not.toBe('work_units.items_json');

    const event = JSON.parse(lifecycleIntentEvent('wu-1', 'start_review', 'in_review', 'pending')) as Record<string, unknown>;
    expect(event).toEqual({
      item_id: 'wu-1',
      action: 'start_review',
      to: 'in_review',
      from: 'pending',
    });
  });

  it('applies a valid pending lifecycle event and clears it', () => {
    const result = runApplyReaction(
      [
        { id: 'wu-1', status: 'pending', title: 'One' },
        { id: 'wu-2', status: 'accepted', title: 'Two' },
      ],
      lifecycleIntentEvent('wu-1', 'start_review', 'in_review', 'pending'),
    );

    expect(result.items).toEqual([
      { id: 'wu-1', status: 'in_review', title: 'One' },
      { id: 'wu-2', status: 'accepted', title: 'Two' },
    ]);
    expect(result.event).toBe('');
    expect(result.violation).toBeUndefined();
  });

  it('records a violation and leaves status unchanged for an undeclared transition', () => {
    const result = runApplyReaction(
      [{ id: 'wu-1', status: 'pending', title: 'One' }],
      lifecycleIntentEvent('wu-1', 'start_review', 'accepted', 'pending'),
    );

    expect(result.items).toEqual([{ id: 'wu-1', status: 'pending', title: 'One' }]);
    expect(result.event).toBe('');
    expect(result.violation).toEqual({
      item_id: 'wu-1',
      from: 'pending',
      attempted_to: 'accepted',
      reason: 'undeclared_transition',
    });
  });

  it('records a violation and leaves status unchanged when a transition guard is false', () => {
    const result = runApplyReaction(
      [{ id: 'wu-1', status: 'accepted', title: 'One' }],
      lifecycleIntentEvent('wu-1', 'reopen_work_unit', 'in_review', 'accepted'),
      [['review_work.reopen_requested', false]],
    );

    expect(result.items).toEqual([{ id: 'wu-1', status: 'accepted', title: 'One' }]);
    expect(result.event).toBe('');
    expect(result.violation).toEqual({
      item_id: 'wu-1',
      from: 'accepted',
      attempted_to: 'in_review',
      reason: 'guard_false',
    });
  });

  it('lets the aggregate guard recompute true after lifecycle application makes all items terminal', () => {
    const terminalLlmLifecycle = {
      ...clone(genericLifecycle),
      transitions: genericLifecycle.transitions.map((transition) =>
        transition.action === 'accept_work_unit'
          ? { ...transition, managed_by: 'llm' as const }
          : transition,
      ),
    };
    const applyResult = runApplyReaction(
      [
        { id: 'wu-1', status: 'in_review', title: 'One' },
        { id: 'wu-2', status: 'removed', title: 'Two' },
      ],
      lifecycleIntentEvent('wu-1', 'accept_work_unit', 'accepted', 'in_review'),
      [],
      terminalLlmLifecycle,
    );
    const allTerminal = createCollectionLifecycleAllTerminalReaction(terminalLlmLifecycle);

    expect(
      allTerminal(
        new Map([['work_units.items_json', JSON.stringify(applyResult.items)]]),
        'AfterMutation',
        'review_work',
      )?.mutations?.find((mutation) => mutation.path === 'work_units.all_terminal')?.value,
    ).toBe(true);
  });

  it('sets the aggregate guard true only for non-empty all-terminal collections', () => {
    const reaction = createCollectionLifecycleAllTerminalReaction(genericLifecycle);

    expect(runAllTerminalReaction(reaction, [
      { id: 'wu-1', status: 'accepted' },
      { id: 'wu-2', status: 'removed' },
    ])).toBe(true);
    expect(runAllTerminalReaction(reaction, [])).toBe(false);
    expect(runAllTerminalReaction(reaction, [
      { id: 'wu-1', status: 'accepted' },
      { id: 'wu-2', status: 'pending' },
    ])).toBe(false);
    expect(runAllTerminalReaction(reaction, { id: 'not-an-array', status: 'accepted' })).toBe(false);
    expect(runAllTerminalReaction(reaction, '[not json')).toBe(false);
  });

  it('keeps no-descriptor synthesis byte-identical to the pre-lifecycle baseline', () => {
    expect(hashArtifact(synthesizeProgramSpecFromDomain(baseDomain))).toEqual({
      spec_yaml: '9dcfe499925d995bc46442ba71b847b271380bc01e6cfd78f48f643fc8f09a9a',
      contracts_ts: '9cf1c34fb09d664aef1bbb2b9cf31cb54a6e2943c81007cd561d0975dd2d43af',
      handlers_ts: '487b83115c463a60c3c53d3ccb21350e05a4f4d29a39d9f03ad77e804e56d04d',
      handlers_index_ts: '1a48cdeab26386fc7b1a917aa9d466340f2e1af8b493056e5892cc1ca4776e94',
      tools_ts: '33ddf30cb9b4787506ba6e9b332fb570e3dfa185470c000dbd429083e0630e7d',
      smoke_test_ts: 'cfb74d966744cd252918dd8820602ce9b762ea406a7cd39c26ff4e4edc821a92',
    });
  });

  it('keeps descriptors with no llm-managed transitions byte-identical to the Phase 1 baseline', () => {
    const noLlmLifecycle = {
      ...clone(genericLifecycle),
      transitions: [
        {
          from: 'in_review',
          to: 'accepted',
          stage: 'review_work',
          action: 'accept_work_unit',
          managed_by: 'reaction',
          trigger: 'user_confirmation',
        },
      ],
    };

    expect(hashArtifact(synthesizeProgramSpecFromDomain(domainWithLifecycle(noLlmLifecycle)))).toEqual({
      spec_yaml: '45116c560ca1d62b69c103f97f5b12f458f8f6222037b8ad6eb7d45673d4247c',
      contracts_ts: '0887c0cf22f7eefd2b877e61d6dea3a938d952bbb349572a2fc9919523a74993',
      handlers_ts: '12b3a449739578f1d5bf6e59a820e1d9251bb1a4eef0352efa1226e6e843b3d2',
      handlers_index_ts: '1a48cdeab26386fc7b1a917aa9d466340f2e1af8b493056e5892cc1ca4776e94',
      tools_ts: 'ba348055c634de2e2f58dd88a696d53614266b13c29ed03a9568cf3a3545bfe7',
      smoke_test_ts: 'cfb74d966744cd252918dd8820602ce9b762ea406a7cd39c26ff4e4edc821a92',
    });
  });
});

function lifecycleIntentEvent(itemId: string, action: string, to: string, from?: string): string {
  return JSON.stringify({
    item_id: itemId,
    action,
    to,
    ...(from ? { from } : {}),
  });
}

function runApplyReaction(
  items: unknown[],
  event: string,
  extraSnapshot: Array<[string, unknown]> = [],
  lifecycle: unknown = genericLifecycle,
): { items: unknown; event: unknown; violation?: unknown } {
  const reaction = createCollectionLifecycleApplyReaction(lifecycle);
  const result = reaction(new Map<string, unknown>([
    ['work_units.items_json', JSON.stringify(items)],
    ['work_units.pending_event_json', event],
    ...extraSnapshot,
  ]), 'AfterMutation', 'review_work');
  const values = new Map(result?.mutations?.map((mutation) => [mutation.path, mutation.value]));
  return {
    items: JSON.parse(String(values.get('work_units.items_json') ?? JSON.stringify(items))) as unknown,
    event: values.get('work_units.pending_event_json'),
    violation: values.has('work_units.lifecycle_violation_json')
      ? JSON.parse(String(values.get('work_units.lifecycle_violation_json'))) as unknown
      : undefined,
  };
}

function domainWithLifecycle(lifecycle: unknown): Record<string, unknown> {
  return {
    ...baseDomain,
    'intake.completion_json': JSON.stringify({
      final_stage: 'complete',
      guard_field: 'review_work.done',
      collection_lifecycle: lifecycle,
    }),
  };
}

function indexedArrayLifecycle(): unknown {
  return {
    ...clone(genericLifecycle),
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
        priority: 'number',
      },
    },
  };
}

function pickCollectionSchema(schema: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(schema).filter(([path]) =>
      path.startsWith('work_units.'),
    ),
  );
}

function runAllTerminalReaction(
  reaction: ReturnType<typeof createCollectionLifecycleAllTerminalReaction>,
  items: unknown,
): unknown {
  const stored = typeof items === 'string' ? items : JSON.stringify(items);
  const result = reaction(new Map([['work_units.items_json', stored]]), 'AfterMutation', 'review_work');
  return result?.mutations?.find((mutation) => mutation.path === 'work_units.all_terminal')?.value;
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
  const dir = mkdtempSync(join(tmpdir(), 'pgas-new-lifecycle-load-'));
  const specPath = join(dir, 'specs.yml');
  writeFileSync(specPath, specYaml);
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return specPath;
}
