import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { appTransport, createPgasClient, type PgasClient } from '@simodelne/pgas-server/client.js';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import {
  createProgramAdapters,
  loadSpecWithPatterns,
  type ProgramEntry,
  type ReactionHandler,
  type ToolHandler,
} from '@simodelne/pgas-server/plugin.js';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

import {
  assertDelegationChildrenDescriptor,
  synthesizeProgramSpecFromDomain,
} from '../../src/foundry-program/synthesizer.js';
import { CapabilityRefusalError } from '../../src/foundry-program/capability-registry.js';

const PARENT_PROGRAM = 'multi-child-falsifier-parent';
const INGEST_PROGRAM = 'SimoneOS Document Ingest';
const REVIEW_PROGRAM = 'contract-review-service';
const INGEST_RESULT_PATH = 'ingest_stage.delegation.ingest.result';
const REVIEW_RESULT_PATH = 'review_stage.delegation.review.result';
const INGEST_BASE = 'ingest_stage.delegation.ingest';
const REVIEW_BASE = 'review_stage.delegation.review';

// Slice B multi-child static delegation falsifier — route-level. Mirrors
// tests/integration/delegation-engine-falsifier.test.ts but proves the ENGINE honors N
// distinct STATIC delegation channels in a SINGLE program: the parent dispatches to TWO
// separately-registered child programs sequentially, each landing complete in a DISTINCT
// child session. Plus the KILL TEST: an over-scope mode (fan_out) STILL refuses, and the
// synthesizer fans out to N channels/actions/reactions.

describe('multi-child delegation route-level engine falsifier (Slice B)', () => {
  it('M-1: parent dispatches TWO separately-registered children, each lands complete in a distinct session', async () => {
    const evidence = await runTwoChildScenario();

    // Both children ran and landed complete.
    expect(evidence.ingest.status).toBe('complete');
    expect(evidence.review.status).toBe('complete');
    // Distinct child sessions (a real Service child per channel, not the parent, not shared).
    expect(typeof evidence.ingest.sessionId).toBe('string');
    expect(typeof evidence.review.sessionId).toBe('string');
    expect(evidence.ingest.sessionId).not.toBe(evidence.parentSessionId);
    expect(evidence.review.sessionId).not.toBe(evidence.parentSessionId);
    expect(evidence.ingest.sessionId).not.toBe(evidence.review.sessionId);
    // Each child ran at least one round and reached its terminal mode.
    expect(Number(evidence.ingest.rounds)).toBeGreaterThanOrEqual(1);
    expect(Number(evidence.review.rounds)).toBeGreaterThanOrEqual(1);
    expect(evidence.ingest.mode).toBe('complete');
    expect(evidence.review.mode).toBe('complete');
    // Both settle reactions fired, neither degraded, and the parent reached complete.
    expect(evidence.domain[`${INGEST_BASE}.settled`]).toBe(true);
    expect(evidence.domain[`${REVIEW_BASE}.settled`]).toBe(true);
    expect(evidence.domain[`${INGEST_BASE}.degraded`]).toBe(false);
    expect(evidence.domain[`${REVIEW_BASE}.degraded`]).toBe(false);
    expect(evidence.finalMode).toBe('complete');

    process.stdout.write(`[multi-child-falsifier] M-1 PASS ${JSON.stringify({
      ingest_session: evidence.ingest.sessionId,
      review_session: evidence.review.sessionId,
      parent_session: evidence.parentSessionId,
      distinct_children: new Set([
        String(evidence.ingest.sessionId),
        String(evidence.review.sessionId),
        evidence.parentSessionId,
      ]).size === 3,
    })}\n`);
  });

  it('M-2 KILL: over-scope fan_out on one of N children STILL refuses (validator)', () => {
    const stages = [
      { slug: 'intake', is_bootstrap: true },
      { slug: 'ingest_stage' },
      { slug: 'review_stage' },
      { slug: 'complete', is_terminal: true },
    ];
    const context = {
      programSlug: PARENT_PROGRAM,
      programName: PARENT_PROGRAM,
      stages,
      actionNames: new Set(['begin_work']),
      channelNames: new Set(['user_text', 'widget_output', 'stage_output']),
      schemaPaths: new Set(['intake.summary']),
    };
    const overScope = {
      children: [
        {
          id: 'ingest',
          stage: 'ingest_stage',
          target_spec: INGEST_PROGRAM,
          payload_map: { 'request.topic': 'intake.summary' },
          result_path: INGEST_RESULT_PATH,
          max_delegated_rounds: 12,
          optional: true,
        },
        {
          id: 'review',
          stage: 'review_stage',
          target_spec: REVIEW_PROGRAM,
          fan_out: { axes: ['web', 'files'] },
          payload_map: { 'request.topic': 'intake.summary' },
          result_path: REVIEW_RESULT_PATH,
          max_delegated_rounds: 12,
          optional: true,
        },
      ],
    };
    let thrown: unknown;
    try {
      assertDelegationChildrenDescriptor(overScope, context);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CapabilityRefusalError);
    expect((thrown as CapabilityRefusalError).message).toContain('single-child fan-out');
    process.stdout.write(`[multi-child-falsifier] M-2 KILL PASS (fan_out on N-child still refuses)\n`);
  });

  it('M-3: synthesizer fans a 2-child domain out to N channels/actions/reactions + both allowedTargetPrograms', () => {
    const artifact = synthesizeProgramSpecFromDomain(twoChildDomain());
    const parsed = load(artifact.spec_yaml) as {
      channels: Record<string, unknown>;
      action_map: Record<string, unknown>;
      reactions: Record<string, unknown>;
    };
    expect(Object.keys(parsed.channels)).toEqual(expect.arrayContaining(['ingest_call', 'review_call']));
    expect(Object.keys(parsed.action_map)).toEqual(expect.arrayContaining(['request_ingest', 'request_review']));
    expect(Object.keys(parsed.reactions)).toEqual(
      expect.arrayContaining(['settle_ingest_delegation', 'settle_review_delegation']),
    );
    // Both spec names land in allowedTargetPrograms.
    expect(artifact.registration_ts).toContain(INGEST_PROGRAM);
    expect(artifact.registration_ts).toContain(REVIEW_PROGRAM);
    // The multi-child smoke was chosen (not a single-child renderer).
    const smoke = artifact.smoke_test_ts;
    expect(smoke).toContain('generated multi-child delegation smoke');
    expect(smoke).toContain('all 2 delegation children');
    expect(smoke).not.toContain('createTestHarness');
    // The generated smoke fans out per child: registers each stub, dispatches each request
    // action on its own channel, and asserts each result_path landed complete.
    expect(smoke).toContain(`{ name: '${INGEST_PROGRAM}', entry: createMultiChildStub(tempDir, 0) }`);
    expect(smoke).toContain(`{ name: '${REVIEW_PROGRAM}', entry: createMultiChildStub(tempDir, 1) }`);
    expect(smoke).toContain("effect('request_ingest', { request: { topic: 'seeded multi-child topic 0' } }, 'ingest_call')");
    expect(smoke).toContain("effect('request_review', { request: { topic: 'seeded multi-child topic 1' } }, 'review_call')");
    expect(smoke).toContain(`resultAt(final.domain, '${INGEST_RESULT_PATH}')`);
    expect(smoke).toContain(`resultAt(final.domain, '${REVIEW_RESULT_PATH}')`);
    // Each landed result is asserted complete + distinct child sessions.
    expect(smoke).toContain("expect(new Set(childSessionIds).size).toBe(2)");
    expect(smoke).toContain("expect(final.mode).toBe('complete')");
  });
});

interface TwoChildEvidence {
  parentSessionId: string;
  domain: Record<string, unknown>;
  ingest: Record<string, unknown>;
  review: Record<string, unknown>;
  finalMode: string | null;
}

async function runTwoChildScenario(): Promise<TwoChildEvidence> {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pgas-multi-child-falsifier-'));
  const server = await createPgasServer({
    programs: [
      { name: PARENT_PROGRAM, entry: createParentEntry(tempDir) },
      { name: INGEST_PROGRAM, entry: createChildEntry(tempDir, 'ingest') },
      { name: REVIEW_PROGRAM, entry: createChildEntry(tempDir, 'review') },
    ],
    drivers: {
      authorHandle: scriptedAuthor([
        // Bootstrap → dispatch.
        scripted(effect('enter_dispatch', { topic: 'multi-child-topic' })),
        // Child 1 (ingest): request → child accepts → child finishes → parent advances.
        scripted(effect('request_ingest', { request: { intent: 'ingest' } }, 'ingest_call')),
        scripted(effect('accept_request', { accepted: true }, 'child_output')),
        scripted(effect('finish_work', { result: 'ingest-exported-result' }, 'child_output')),
        scripted(effect('advance_ingest', {})),
        // Child 2 (review): request → child accepts → child finishes → parent completes.
        scripted(effect('request_review', { request: { intent: 'review' } }, 'review_call')),
        scripted(effect('accept_request', { accepted: true }, 'child_output')),
        scripted(effect('finish_work', { result: 'review-exported-result' }, 'child_output')),
        scripted(effect('complete_parent', {})),
      ]),
      observerHandle: {
        modelId: 'multi-child-falsifier-observer',
        async complete() {
          return 'noop';
        },
      },
    },
    devMode: true,
    telemetry: { enabled: false },
    port: 0,
  });
  const client = createPgasClient(appTransport(server.app, { token: 'dev-token' }));
  try {
    const created = await client.sessions.create({ program: PARENT_PROGRAM });
    const parentSessionId = created.sessionId;
    // bootstrap → dispatch
    await client.sessions.trigger(parentSessionId, { channel: 'user_text', payload: 'bootstrap parent' });
    // dispatch ingest child + settle
    await client.sessions.trigger(parentSessionId, { channel: 'user_text', payload: 'dispatch ingest child' });
    // advance to review stage
    await client.sessions.trigger(parentSessionId, { channel: 'user_text', payload: 'advance to review' });
    // dispatch review child + settle
    await client.sessions.trigger(parentSessionId, { channel: 'user_text', payload: 'dispatch review child' });
    // complete parent
    await client.sessions.trigger(parentSessionId, { channel: 'user_text', payload: 'complete parent' });

    const world = await client.sessions.world(parentSessionId);
    const domain = world.domain;
    const finalParent = await client.sessions.get(parentSessionId);

    return {
      parentSessionId,
      domain,
      ingest: resultAt(domain, INGEST_RESULT_PATH),
      review: resultAt(domain, REVIEW_RESULT_PATH),
      finalMode: modeOf(finalParent),
    };
  } finally {
    await server.close();
    rmSync(tempDir, { force: true, recursive: true });
  }
}

function createParentEntry(tempDir: string): ProgramEntry {
  const specPath = path.join(tempDir, `parent-${crypto.randomUUID()}.yml`);
  writeFileSync(specPath, parentSpecYaml(), 'utf8');
  const { spec } = loadSpecWithPatterns(specPath);
  return {
    spec,
    delegationPolicy: {
      allowedTargetPrograms: [INGEST_PROGRAM, REVIEW_PROGRAM],
      inputEnrichment: [{ source: 'parent.topic', target: 'request.topic' }],
    },
    reactionHandlers: new Map<string, ReactionHandler>([
      ['settle_ingest', settleFor(INGEST_RESULT_PATH, INGEST_BASE)],
      ['settle_review', settleFor(REVIEW_RESULT_PATH, REVIEW_BASE)],
    ]),
    createAdapters: (ctx) => createProgramAdapters(spec, ctx, parentHandlers),
  };
}

function createChildEntry(tempDir: string, tag: string): ProgramEntry {
  const specPath = path.join(tempDir, `child-${tag}-${crypto.randomUUID()}.yml`);
  writeFileSync(specPath, childSpecYaml(tag), 'utf8');
  const { spec } = loadSpecWithPatterns(specPath);
  return {
    spec,
    delegationResultPolicy: {
      fields: [{ path: 'work.result', key: 'result' }],
    },
    createAdapters: (ctx) => createProgramAdapters(spec, ctx, childHandlers),
  };
}

function settleFor(resultPath: string, base: string): ReactionHandler {
  return (snapshot) => {
    if (snapshot.get(`${base}.settled`) === true) {
      return undefined;
    }
    const status = resultStatusFromSnapshot(snapshot, resultPath);
    if (!status) {
      return undefined;
    }
    return {
      mutations: [
        { op: 'MSet', path: `${base}.settled`, value: true },
        { op: 'MSet', path: `${base}.degraded`, value: status === 'failed' },
      ],
    };
  };
}

function resultStatusFromSnapshot(snapshot: Parameters<ReactionHandler>[0], resultPath: string): string | null {
  const direct = snapshot.get(resultPath);
  if (isRecord(direct) && typeof direct.status === 'string') {
    return direct.status;
  }
  const leaf = snapshot.get(`${resultPath}.status`);
  return typeof leaf === 'string' ? leaf : null;
}

const parentHandlers: Record<string, ToolHandler> = {
  async enter_dispatch(payload) {
    return { ok: true, action: 'enter_dispatch', payload };
  },
  async request_ingest(payload) {
    return { ok: true, action: 'request_ingest', payload };
  },
  async request_review(payload) {
    return { ok: true, action: 'request_review', payload };
  },
  async advance_ingest(payload) {
    return { ok: true, action: 'advance_ingest', payload };
  },
  async complete_parent(payload) {
    return { ok: true, action: 'complete_parent', payload };
  },
};

const childHandlers: Record<string, ToolHandler> = {
  async accept_request(payload) {
    return { ok: true, action: 'accept_request', payload };
  },
  async finish_work(payload) {
    return { ok: true, action: 'finish_work', payload };
  },
};

function parentSpecYaml(): string {
  return `name: "${PARENT_PROGRAM}"
termination: BoundedSession
topology: CyclicTopology
pure: true

preamble: |
  Route-level multi-child delegation falsifier parent (two distinct static children).

initial: bootstrap
terminal: [complete]

features:
  - base
  - delegation
  - reactions

channels:
  user_text: { direction: In, sync: Async }
  widget_output: { direction: Out, sync: Sync }
  ingest_call:
    direction: Out
    sync: Sync
    target_spec: "${INGEST_PROGRAM}"
    result_path: "${INGEST_RESULT_PATH}"
    max_delegated_rounds: 5
    round_timeout_ms: 5000
    optional: true
  review_call:
    direction: Out
    sync: Sync
    target_spec: "${REVIEW_PROGRAM}"
    result_path: "${REVIEW_RESULT_PATH}"
    max_delegated_rounds: 5
    round_timeout_ms: 5000
    optional: true

modes:
  bootstrap:
    vocabulary: [enter_dispatch]
    channels: [user_text, widget_output]
    transitions:
      - target: ingest_stage
        guard: { kind: FieldTruthy, path: parent.ready }
  ingest_stage:
    vocabulary: [request_ingest, advance_ingest]
    channels: [user_text, widget_output, ingest_call]
    transitions:
      - target: review_stage
        guard: { kind: FieldTruthy, path: parent.ingest_done }
  review_stage:
    vocabulary: [request_review, complete_parent]
    channels: [user_text, widget_output, review_call]
    transitions:
      - target: complete
        guard: { kind: FieldTruthy, path: parent.complete_ready }
  complete:
    vocabulary: []
    channels: [widget_output]

proceed_to:
  enter_dispatch: ingest_stage
  advance_ingest: review_stage
  complete_parent: complete

projection:
  bootstrap:
    include: [inputs.user_text, parent.ready, parent.topic]
    exclude: []
  ingest_stage:
    include:
      - inputs.user_text
      - parent.topic
      - parent.ingest_done
      - ${INGEST_BASE}.settled
      - ${INGEST_BASE}.degraded
      - ${INGEST_RESULT_PATH}
      - ${INGEST_RESULT_PATH}.status
      - ${INGEST_RESULT_PATH}.sessionId
      - ${INGEST_RESULT_PATH}.rounds
      - ${INGEST_RESULT_PATH}.mode
      - ${INGEST_RESULT_PATH}.result
    exclude: []
  review_stage:
    include:
      - inputs.user_text
      - parent.topic
      - parent.complete_ready
      - ${INGEST_BASE}.settled
      - ${INGEST_RESULT_PATH}
      - ${INGEST_RESULT_PATH}.status
      - ${INGEST_RESULT_PATH}.sessionId
      - ${INGEST_RESULT_PATH}.rounds
      - ${INGEST_RESULT_PATH}.mode
      - ${REVIEW_BASE}.settled
      - ${REVIEW_BASE}.degraded
      - ${REVIEW_RESULT_PATH}
      - ${REVIEW_RESULT_PATH}.status
      - ${REVIEW_RESULT_PATH}.sessionId
      - ${REVIEW_RESULT_PATH}.rounds
      - ${REVIEW_RESULT_PATH}.mode
      - ${REVIEW_RESULT_PATH}.result
    exclude: []
  complete:
    include:
      - ${INGEST_BASE}.settled
      - ${INGEST_RESULT_PATH}
      - ${INGEST_RESULT_PATH}.status
      - ${INGEST_RESULT_PATH}.sessionId
      - ${INGEST_RESULT_PATH}.rounds
      - ${INGEST_RESULT_PATH}.mode
      - ${REVIEW_BASE}.settled
      - ${REVIEW_RESULT_PATH}
      - ${REVIEW_RESULT_PATH}.status
      - ${REVIEW_RESULT_PATH}.sessionId
      - ${REVIEW_RESULT_PATH}.rounds
      - ${REVIEW_RESULT_PATH}.mode
    exclude: []

prompts:
  bootstrap: "Move from bootstrap to ingest_stage."
  ingest_stage: "Call request_ingest once, then advance_ingest after the ingest child settles."
  review_stage: "Call request_review once, then complete_parent after the review child settles."
  complete: "Terminal."

ingestion:
  user_text:
    - inputs.user_text

action_map:
  enter_dispatch:
    description: "Enter dispatch and set a parent-domain enrichment value."
    mutations:
      - { op: MSet, path: parent.ready, value: true }
      - { op: MSet, path: parent.topic, from_arg: topic }
    channel: widget_output
  request_ingest:
    description: "Synchronously delegate to the ingest child program."
    mutations:
      - { op: MSet, path: ${INGEST_BASE}.requested, value: true }
    channel: ingest_call
    result_path: "${INGEST_RESULT_PATH}"
  advance_ingest:
    description: "Advance to the review stage after the ingest child settles."
    mutations:
      - { op: MSet, path: parent.ingest_done, value: true }
    channel: widget_output
  request_review:
    description: "Synchronously delegate to the review child program."
    mutations:
      - { op: MSet, path: ${REVIEW_BASE}.requested, value: true }
    channel: review_call
    result_path: "${REVIEW_RESULT_PATH}"
  complete_parent:
    description: "Complete after the review child settles."
    mutations:
      - { op: MSet, path: parent.complete_ready, value: true }
    channel: widget_output

schema:
  inputs.user_text: string
  parent.ready: boolean
  parent.topic: string
  parent.ingest_done: boolean
  parent.complete_ready: boolean
  ${INGEST_BASE}.requested: boolean
  ${INGEST_BASE}.settled: boolean
  ${INGEST_BASE}.degraded: boolean
  ${INGEST_RESULT_PATH}: object
  ${INGEST_RESULT_PATH}.status: string
  ${INGEST_RESULT_PATH}.optional: boolean
  ${INGEST_RESULT_PATH}.mode: string
  ${INGEST_RESULT_PATH}.rounds: number
  ${INGEST_RESULT_PATH}.sessionId: string
  ${INGEST_RESULT_PATH}.result: string
  ${REVIEW_BASE}.requested: boolean
  ${REVIEW_BASE}.settled: boolean
  ${REVIEW_BASE}.degraded: boolean
  ${REVIEW_RESULT_PATH}: object
  ${REVIEW_RESULT_PATH}.status: string
  ${REVIEW_RESULT_PATH}.optional: boolean
  ${REVIEW_RESULT_PATH}.mode: string
  ${REVIEW_RESULT_PATH}.rounds: number
  ${REVIEW_RESULT_PATH}.sessionId: string
  ${REVIEW_RESULT_PATH}.result: string

reactions:
  settle_ingest:
    event: AfterRound
    watch: []
    write_scope: [${INGEST_BASE}.settled, ${INGEST_BASE}.degraded]
  settle_review:
    event: AfterRound
    watch: []
    write_scope: [${REVIEW_BASE}.settled, ${REVIEW_BASE}.degraded]

repair_bound: 2

fallback:
  channel: widget_output
  payload: { ok: false }
`;
}

function childSpecYaml(tag: string): string {
  const specName = tag === 'ingest' ? INGEST_PROGRAM : REVIEW_PROGRAM;
  return `name: "${specName}"
termination: BoundedSession
topology: CyclicTopology
pure: true

preamble: |
  Route-level multi-child delegation falsifier ${tag} child.

initial: receive
terminal: [complete]

features:
  - base

channels:
  user_text: { direction: In, sync: Async }
  child_output: { direction: Out, sync: Sync }

modes:
  receive:
    vocabulary: [accept_request]
    channels: [user_text, child_output]
    transitions:
      - target: work
        guard: { kind: FieldTruthy, path: child.received }
  work:
    vocabulary: [finish_work]
    channels: [user_text, child_output]
    transitions:
      - target: complete
        guard: { kind: FieldTruthy, path: work.done }
  complete:
    vocabulary: []
    channels: [child_output]

proceed_to:
  accept_request: work
  finish_work: complete

projection:
  receive:
    include: [inputs.user_text, inputs.request, inputs.request.intent, inputs.domain_context, inputs.domain_context.source_program]
    exclude: []
  work:
    include: [inputs.user_text, inputs.request, child.received, work.result]
    exclude: []
  complete:
    include: [inputs.request, child.received, work.done, work.result]
    exclude: []

prompts:
  receive: "Accept the delegated request."
  work: "Finish the delegated work when instructed."
  complete: "Terminal."

ingestion:
  user_text:
    - inputs.user_text

action_map:
  accept_request:
    description: "Record that the delegated request was received."
    mutations:
      - { op: MSet, path: child.received, value: true }
    channel: child_output
  finish_work:
    description: "Complete child work and export work.result."
    mutations:
      - { op: MSet, path: work.done, value: true }
      - { op: MSet, path: work.result, from_arg: result }
    channel: child_output

schema:
  inputs.user_text: string
  inputs.request: object
  inputs.request.intent: string
  inputs.request.topic: string
  inputs.domain_context: object
  inputs.domain_context.source_program: string
  child.received: boolean
  work.done: boolean
  work.result: string

repair_bound: 2

fallback:
  channel: child_output
  payload: { ok: false }
`;
}

function twoChildDomain(): Record<string, unknown> {
  return {
    'program.slug': 'multi-child-parent',
    'program.name': 'Multi Child Parent',
    'program.target_dir': '/tmp/multi-child-parent',
    'intake.purpose': 'Dispatch two delegated children and finish.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      {
        slug: 'intake',
        is_bootstrap: true,
        domain_spec: {
          reads: ['inputs.initial_user_text'],
          produces: { result_json: { summary: 'string' }, items_json: ['summary:<summary>'] },
          rules: ['Summarize the request.'],
          invariants: ['summary is grounded in the request.'],
        },
      },
      { slug: 'ingest_stage' },
      { slug: 'review_stage' },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'ingest_stage', trigger: 'started', guard_field: 'intake.started' },
      { from: 'ingest_stage', to: 'review_stage', trigger: 'ingested', guard_field: 'ingest_stage.ready' },
      { from: 'review_stage', to: 'complete', trigger: 'reviewed', guard_field: 'review_stage.ready' },
    ]),
    'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'review_stage.ready' }),
    'intake.delegation_json': JSON.stringify({
      children: [
        {
          id: 'ingest',
          stage: 'ingest_stage',
          target_spec: INGEST_PROGRAM,
          payload_map: { 'request.topic': 'intake.summary' },
          result_path: INGEST_RESULT_PATH,
          max_delegated_rounds: 12,
          optional: true,
        },
        {
          id: 'review',
          stage: 'review_stage',
          target_spec: REVIEW_PROGRAM,
          payload_map: { 'request.topic': 'intake.summary' },
          result_path: REVIEW_RESULT_PATH,
          max_delegated_rounds: 12,
          optional: true,
        },
      ],
    }),
  };
}

function effect(name: string, payload: Record<string, unknown>, channel = 'widget_output'): Record<string, unknown> {
  return { actions: [{ kind: 'EffectAction', name, channel, payload }] };
}

function scripted(response: Record<string, unknown>): { response: Record<string, unknown> } {
  return { response };
}

function scriptedAuthor(responses: Array<{ response: Record<string, unknown> }>): {
  modelId: string;
  complete(): Promise<string>;
} {
  let index = 0;
  return {
    modelId: 'multi-child-falsifier-author',
    async complete() {
      const response = responses[index++];
      if (!response) {
        throw new Error(`no multi-child falsifier author response scripted for call ${String(index - 1)}`);
      }
      return JSON.stringify(response.response);
    },
  };
}

function resultAt(domain: Record<string, unknown>, pathKey: string): Record<string, unknown> {
  const direct = domain[pathKey];
  if (isRecord(direct)) {
    return direct;
  }
  const prefix = `${pathKey}.`;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(domain)) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    result[key.slice(prefix.length)] = value;
  }
  return result;
}

function modeOf(envelope: { mode?: unknown; state?: unknown }): string | null {
  if (typeof envelope.mode === 'string') {
    return envelope.mode;
  }
  if (isRecord(envelope.state) && typeof envelope.state.mode === 'string') {
    return envelope.state.mode;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
