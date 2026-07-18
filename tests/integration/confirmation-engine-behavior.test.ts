import { describe, expect, it } from 'vitest';
import { PgasApiError, type PgasClient } from '@simodelne/pgas-server/client.js';
import { createTestHarness } from '@simodelne/pgas-server/testing.js';
import {
  reconstructArray,
  type ProgramEntry,
  type ReactionHandler,
  type Specification,
} from '@simodelne/pgas-server/plugin.js';

import { startRouteHarness } from './foundry-test-utils.js';

describe('confirmation-loop engine behavior falsifier', () => {
  it('documents the real user_confirmation route contract and in-domain canonical decisions', async () => {
    // Route-contract finding, kept load-bearing: the HTTP/API route accepts the
    // simple engine payload shape and then enriches target_item_* via
    // decision_targeting. The AfterIngestion reaction receives the canonical
    // decision string (proved by decision.status below), while the final
    // persisted input leaf is cleared back to ''. Pre-expanded domain-path
    // payloads are rejected before ingestion, so generated clients must not
    // send them.
    const rejected = await withRouteSession(async ({ client, sessionId }) => {
      const complexDomainPathPayload = {
        'inputs.user_decision': {
          decision: 'approve',
          instruction: '',
          timestamp: '2026-07-16T00:00:00.000Z',
          target_item_index: 0,
          target_item_id: 'item-1',
          target_item_title: 'First item',
          target_item_status: 'proposed',
        },
        'inputs.user_decision.decision': 'approve',
        'inputs.user_decision.instruction': '',
        'inputs.user_decision.timestamp': '2026-07-16T00:00:00.000Z',
        'inputs.user_decision.target_item_index': 0,
        'inputs.user_decision.target_item_id': 'item-1',
        'inputs.user_decision.target_item_title': 'First item',
        'inputs.user_decision.target_item_status': 'proposed',
      };
      return capturePgasApiError(() =>
        client.sessions.trigger(sessionId, {
          channel: 'user_confirmation',
          payload: complexDomainPathPayload,
        }));
    });
    expect(rejected.message).toContain('Invalid confirmation payload');
    process.stdout.write(
      `[confirmation-route-contract] rejected complex domain-path payload: status=${String(rejected.status)} reason=${String(rejected.reason ?? '')}\n`,
    );

    const cases = [
      { decision: 'approve', payload: { decision: 'approve' }, expectedStatus: 'accepted' },
      {
        decision: 'request_revision',
        payload: { decision: 'request_revision', instruction: 'Tighten the proposed wording.' },
        expectedStatus: 'proposed',
      },
      { decision: 'reject', payload: { decision: 'reject' }, expectedStatus: 'skipped' },
    ] as const;

    for (const item of cases) {
      const world = await withRouteSession(async ({ client, sessionId }) => {
        await client.sessions.trigger(sessionId, {
          channel: 'user_confirmation',
          payload: item.payload,
        });
        return client.sessions.world(sessionId);
      });
      const appliedDecision = String(world.domain['decision.status']).split(':')[1] ?? '';
      process.stdout.write(
        `[confirmation-route-contract] accepted simple decision=${item.decision}; reaction_received=${appliedDecision}; persisted_leaf=${JSON.stringify(world.domain['inputs.user_decision.decision'] ?? null)}; item_status=${String(world.domain['items.0.status'])}\n`,
      );
      expect(world.domain['inputs.user_decision.decision']).toBe('');
      expect(world.domain['items.0.status']).toBe(item.expectedStatus);
      expect(world.domain['decision.status']).toBe(`applied:${item.decision}:0`);
      expect(world.domain['inputs.user_decision.target_item_index']).toBe(0);
    }
  });

  it('accepts a parked user_confirmation and runs ingestion reactions before the approval gate and author round', async () => {
    const prompts: string[] = [];
    const entry = createConfirmationEngineFalsifierEntry(prompts);
    const harness = await createTestHarness(entry, {
      programName: 'confirmation-engine-falsifier',
      defaultChannel: 'user_text',
      authorResponses: [
        effect('propose_item', { message: 'please approve' }),
        (ctx) => {
          prompts.push(ctx.prompt);
          return effect('noop', { message: 'approval round continued without status write' });
        },
      ],
    });

    try {
      await harness.trigger('start');
      const parked = await harness.snapshot();
      expect((parked.state as { awaitingUserDecision?: { channelId?: string } }).awaitingUserDecision?.channelId).toBe('user_confirmation');
      expect(parked.domain['items.0']).toEqual({
        id: 'item-1',
        title: 'First item',
        proposed_text: 'Seeded proposal',
        status: 'proposed',
      });
      expect(parked.domain['items.0.title']).toBe('First item');
      expect(parked.domain['items.0.status']).toBe('proposed');
      expect(reconstructArray(parked.domain, 'items')).toEqual([
        {
          id: 'item-1',
          title: 'First item',
          proposed_text: 'Seeded proposal',
          status: 'proposed',
        },
      ]);

      await harness.trigger({
        channel: 'user_confirmation',
        payload: {
          decision: 'approve',
          instruction: '',
          timestamp: '2026-07-16T00:00:00.000Z',
        },
      });

      const approved = await harness.snapshot();
      expect(approved.domain['decision.status']).toBe('applied:approve:0');
      expect(approved.domain['items.0.status']).toBe('accepted');
      expect(approved.domain['items.all_terminal']).toBe(true);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('items.0.title');
      expect(prompts[0]).toContain('First item');
      expect(prompts[0]).toContain('items.0.status');
      expect(prompts[0]).toContain('accepted');
      expect(approved.mode).toBe('complete');
      expect(approved.terminal).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('absorbs a decision with zero proposed items as an enriched target -1 violation', async () => {
    const entry = createConfirmationEngineFalsifierEntry([]);
    const harness = await createTestHarness(entry, {
      programName: 'confirmation-engine-falsifier-zero-target',
      defaultChannel: 'user_text',
      authorResponses: [
        effect('noop', { message: 'zero-target decision did not hard reject' }),
      ],
    });

    try {
      await expect(harness.trigger({
        channel: 'user_confirmation',
        payload: {
          decision: 'approve',
          instruction: '',
          timestamp: '2026-07-16T00:01:00.000Z',
        },
      })).resolves.toBeTruthy();

      const snapshot = await harness.snapshot();
      expect(JSON.parse(String(snapshot.domain['decision.violation']))).toEqual({
        reason: 'missing_target',
        decision: 'approve',
        target_index: -1,
      });
      expect(snapshot.mode).toBe('review');
    } finally {
      await harness.close();
    }
  });
});

function createConfirmationEngineFalsifierEntry(prompts: string[]): ProgramEntry {
  void prompts;
  const spec = createConfirmationEngineFalsifierSpec();
  return {
    spec,
    reactionHandlers: new Map<string, ReactionHandler>([
      ['apply_user_decision', applyUserDecision],
    ]),
    createAdapters: () => createAdapters(spec),
  };
}

function createConfirmationEngineFalsifierSpec(): Specification {
  return {
    name: 'confirmation-engine-falsifier',
    modes: new Map([
      ['review', {
        name: 'review',
        vocabulary: ['propose_item', 'noop'],
        channels: ['user_text', 'user_confirmation', 'widget_output'],
        transitions: [
          { target: 'complete', guard: { kind: 'FieldTruthy', path: 'items.all_terminal' } },
        ],
        preconditions: {},
      }],
      ['complete', {
        name: 'complete',
        vocabulary: [],
        channels: ['widget_output'],
        transitions: [],
        preconditions: {},
      }],
    ]),
    initial: 'review',
    terminal: ['complete'],
    schannels: new Map([
      ['user_text', { id: 'user_text', direction: 'In', sync: 'Async' }],
      ['user_confirmation', {
        id: 'user_confirmation',
        direction: 'In',
        sync: 'Async',
        structured_decision: true,
        decision_targeting: {
          collection: 'items',
          status_field: 'status',
          status_equals: 'proposed',
          select: 'first',
          index_path: 'inputs.user_decision.target_item_index',
          id_path: 'inputs.user_decision.target_item_id',
          title_path: 'inputs.user_decision.target_item_title',
          status_path: 'inputs.user_decision.target_item_status',
        },
      }],
      ['widget_output', { id: 'widget_output', direction: 'Out', sync: 'Sync' }],
    ]),
    schema: new Map([
      ['inputs.user_text', 'string'],
      ['inputs.user_decision', 'object'],
      ['inputs.user_decision.decision', 'string'],
      ['inputs.user_decision.instruction', 'string'],
      ['inputs.user_decision.note_mode', 'string'],
      ['inputs.user_decision.timestamp', 'string'],
      ['inputs.user_decision.target_item_index', 'number'],
      ['inputs.user_decision.target_item_id', 'string'],
      ['inputs.user_decision.target_item_title', 'string'],
      ['inputs.user_decision.target_item_status', 'string'],
      ['inputs.mode_entry', 'object'],
      ['inputs.mode_entry.mode', 'string'],
      ['inputs.mode_entry.from_mode', 'string'],
      ['inputs.mode_entry.entry_round', 'number'],
      ['governance.round_counter', 'number'],
      ['items.*', 'object'],
      ['items.*.id', 'string'],
      ['items.*.title', 'string'],
      ['items.*.proposed_text', 'string'],
      ['items.*.status', 'string'],
      ['items.all_terminal', 'boolean'],
      ['decision.status', 'string'],
      ['decision.violation', 'string'],
    ]),
    action_map: new Map([
      ['propose_item', {
        mutations: [
          {
            op: 'MSet',
            path: 'items.0',
            value: {
              id: 'item-1',
              title: 'First item',
              proposed_text: 'Seeded proposal',
              status: 'proposed',
            },
          },
        ],
        channel: 'widget_output',
        bounds: new Map(),
        description: 'Seed and present the first item for explicit user confirmation.',
        awaits_user_decision: { channel: 'user_confirmation', intent: 'present_for_approval' },
      }],
      ['noop', {
        mutations: [],
        channel: 'widget_output',
        bounds: new Map(),
        description: 'Continue without mutating item status.',
      }],
    ]),
    repair_bound: 1,
    fallback: { channel: 'widget_output', payload: { error: 'fallback' } },
    guidance: new Map([
      ['review', [{ sm_content: 'Use the declared actions only.' }]],
      ['complete', [{ sm_content: 'Terminal.' }]],
    ]),
    prompts: new Map([
      ['review', 'Review the projected item state and use the declared actions only.'],
      ['complete', 'Terminal.'],
    ]),
    ingestion: new Map([
      ['user_text', ['inputs.user_text']],
      ['user_confirmation', [
        'inputs.user_decision',
        'inputs.user_decision.decision',
        'inputs.user_decision.instruction',
        'inputs.user_decision.note_mode',
        'inputs.user_decision.timestamp',
        'inputs.user_decision.target_item_index',
        'inputs.user_decision.target_item_id',
        'inputs.user_decision.target_item_title',
        'inputs.user_decision.target_item_status',
      ]],
    ]),
    projection: new Map([
      ['review', {
        include: [
          'inputs.user_text',
          'inputs.user_decision.target_item_index',
          'items.*.id',
          'items.*.title',
          'items.*.status',
          'items.all_terminal',
          'decision.status',
          'decision.violation',
        ],
        exclude: [],
      }],
      ['complete', {
        include: ['items.*.title', 'items.*.status', 'items.all_terminal', 'decision.status'],
        exclude: [],
      }],
    ]),
    topology: 'LinearTopology',
    termination: 'BoundedSession',
    integrations: [],
    reactions: [
      {
        name: 'apply_user_decision',
        event: 'AfterIngestion',
        watch: ['inputs.user_decision.decision', 'inputs.user_decision.timestamp'],
        write_scope: ['items.*.status', 'items.all_terminal', 'decision.status', 'decision.violation'],
        may_guide: false,
      },
    ],
    features: new Set(['reactions']),
  };
}

const applyUserDecision: ReactionHandler = (snapshot) => {
  const decision = String(snapshot.get('inputs.user_decision.decision') ?? '').trim();
  if (decision.length === 0) {
    return undefined;
  }
  const targetIndex = targetIndexFrom(snapshot.get('inputs.user_decision.target_item_index'));
  if (targetIndex < 0) {
    return {
      mutations: [
        {
          op: 'MSet',
          path: 'decision.violation',
          value: JSON.stringify({ reason: 'missing_target', decision, target_index: targetIndex }),
        },
      ],
    };
  }
  const nextStatus = decision === 'request_revision'
    ? 'proposed'
    : decision === 'reject'
      ? 'skipped'
      : 'accepted';
  return {
    mutations: [
      { op: 'MSet', path: `items.${targetIndex}.status`, value: nextStatus },
      { op: 'MSet', path: 'items.all_terminal', value: nextStatus === 'accepted' || nextStatus === 'skipped' },
      { op: 'MSet', path: 'decision.status', value: `applied:${decision}:${targetIndex}` },
    ],
  };
};

function targetIndexFrom(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && /^-?\d+$/u.test(value)) {
    return Number.parseInt(value, 10);
  }
  return -1;
}

function createAdapters(spec: Specification) {
  const inputs = new Map();
  const outputs = new Map();
  for (const [channelId, channel] of spec.schannels) {
    if (channel.direction === 'In') {
      inputs.set(channelId, {
        id: channelId,
        async receive(): Promise<never> {
          throw new Error(`test input channel ${channelId} is trigger-driven`);
        },
      });
    } else {
      outputs.set(channelId, {
        id: channelId,
        async dispatch(payload: unknown): Promise<unknown> {
          return payload;
        },
      });
    }
  }
  return { inputs, outputs };
}

function effect(name: string, payload: Record<string, unknown>): Record<string, unknown> {
  return { actions: [{ kind: 'EffectAction', name, channel: 'widget_output', payload }] };
}

async function withRouteSession<T>(
  run: (route: { client: PgasClient; sessionId: string }) => Promise<T>,
): Promise<T> {
  const { client, close } = await startRouteHarness({
    programs: [{ name: 'confirmation-engine-falsifier-route', entry: createConfirmationEngineFalsifierEntry([]) }],
    authorHandle: scriptedAuthor([
      effect('propose_item', { message: 'please approve' }),
      effect('noop', { message: 'route contract round continued without status write' }),
    ]),
    observerModelId: 'confirmation-engine-falsifier-route-observer',
  });
  try {
    const created = await client.sessions.create({ program: 'confirmation-engine-falsifier-route' });
    await client.sessions.trigger(created.sessionId, { channel: 'user_text', payload: 'start' });
    const parked = await client.sessions.get(created.sessionId);
    expect((parked.state as { awaitingUserDecision?: { channelId?: string } }).awaitingUserDecision?.channelId).toBe('user_confirmation');
    return await run({ client, sessionId: created.sessionId });
  } finally {
    await close();
  }
}

function scriptedAuthor(responses: Record<string, unknown>[]): { modelId: string; complete(prompt: string): Promise<string> } {
  let index = 0;
  return {
    modelId: 'confirmation-engine-falsifier-route-author',
    async complete() {
      const response = responses[index++];
      if (!response) {
        throw new Error(`no route-contract author response scripted for call ${String(index - 1)}`);
      }
      return JSON.stringify(response);
    },
  };
}

async function capturePgasApiError(run: () => Promise<unknown>): Promise<PgasApiError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(PgasApiError);
    return error as PgasApiError;
  }
  throw new Error('expected PgasApiError');
}
