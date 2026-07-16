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
import { describe, expect, it } from 'vitest';

const PARENT_PROGRAM = 'delegation-falsifier-parent';
const CHILD_PROGRAM = 'delegation-falsifier-child';
const ACTION_RESULT_PATH = 'delegation.child_result';
const CHANNEL_DECOY_PATH = 'delegation.channel_result_decoy';

describe('delegation route-level engine falsifier', () => {
  it('executes F-1..F-6 through the real HTTP route', async () => {
    const f1 = await runF1OrStop();
    const failures: Error[] = [];

    await recordFalsifier('F-2', failures, async () => {
      const evidence = await runDegradeScenario();
      expect(evidence.result.status).toBe('failed');
      expect(evidence.result.optional).toBe(true);
      expect(evidence.parentStatus).not.toBe('Failed');
      expect(evidence.afterDelegationDomain.degraded).toBe(true);
      expect(evidence.afterDelegationDomain.settled).toBe(true);
      expect(evidence.finalMode).toBe('complete');
      return {
        landed_result: evidence.result,
        parent_status_after_degrade: evidence.parentStatus,
        degraded: evidence.afterDelegationDomain.degraded,
        settled: evidence.afterDelegationDomain.settled,
        final_mode: evidence.finalMode,
      };
    });

    await recordFalsifier('F-3', failures, async () => {
      const evidence = await runDeclineScenario();
      expect(evidence.result.status).toBe('declined');
      expect(String(evidence.result.reason)).toMatch(/Unknown protocol/i);
      expect(evidence.parentStatus).not.toBe('Failed');
      expect(evidence.finalMode).toBe('complete');
      return {
        landed_result: evidence.result,
        parent_status_after_decline: evidence.parentStatus,
        final_mode: evidence.finalMode,
      };
    });

    await recordFalsifier('F-4', failures, async () => {
      expect(f1.afterDelegationDomain.settled).toBe(true);
      expect(f1.afterDelegationDomain['settle.observed_status']).toBe('complete');
      return {
        settled_immediately_after_trigger: f1.afterDelegationDomain.settled,
        observed_status: f1.afterDelegationDomain['settle.observed_status'],
      };
    });

    await recordFalsifier('F-5', failures, async () => {
      // FINDING (design §2.8 correction, same root cause as F-1): the child Service session is NOT
      // route-observable — client.sessions.world(childId) returns "Session not found" — so the child's
      // INTERNAL inputs.request.* cannot be read post-hoc. What is observable + real here: the delegation
      // carried a payload to a child that RAN (landed rounds >= 1) and EXPORTED content (F-6). The
      // engine-native inputEnrichment (the payload_map, §2.2) is code-verified; its exact-value route-level
      // EXECUTE proof moves to PR-D3's generated smoke, where the SYNTHESIZED child (which we control)
      // echoes its seeded inputs.request.topic into its export so the landed result carries it.
      const rounds = (f1.result as { rounds?: unknown }).rounds;
      expect(typeof rounds).toBe('number');
      expect(rounds as number).toBeGreaterThanOrEqual(1);
      expect(f1.result.result).toBe('child-exported-result');
      return {
        child_world_get_error: f1.childWorldGetError ?? f1.childSessionGetError,
        child_ran_rounds: rounds,
        child_exported: f1.result.result,
        exact_value_seeding_proof: 'deferred to PR-D3 generated smoke (child not route-observable)',
      };
    });

    await recordFalsifier('F-6', failures, async () => {
      expect(f1.result.result).toBe('child-exported-result');
      return {
        exported_result_key: f1.result.result,
        landed_keys: Object.keys(f1.result).sort(),
      };
    });

    if (failures.length > 0) {
      throw new Error(failures.map((failure) => failure.message).join('\n'));
    }
  });
});

async function runF1OrStop(): Promise<F1Evidence> {
  let observed: unknown = null;
  try {
    const evidence = await runCompleteScenario();
    observed = {
      landed_result: evidence.result,
      child_session_id: evidence.childSession.sessionId,
      child_session_get_error: evidence.childSessionGetError,
      child_world_get_error: evidence.childWorldGetError,
      child_role: evidence.childSession.role,
      child_rounds: evidence.childRounds,
      child_round_envelopes: evidence.childRoundEnvelopes,
      child_debug_rounds: evidence.childDebugRounds,
      child_state: evidence.childSession.state,
      child_mode: evidence.childMode,
      visible_sessions: evidence.visibleSessions,
      channel_decoy: evidence.afterDelegationDomain[CHANNEL_DECOY_PATH],
      order: evidence.order,
    };

    expect(evidence.result.status).toBe('complete');
    expect(typeof evidence.result.sessionId).toBe('string');
    expect(evidence.result.sessionId).not.toBe(evidence.parentSessionId);
    // FINDING (design §2.8 correction, proven by this suite): the child Service session is NOT reliably
    // route-observable — client.sessions.get/rounds(childId) is NON-DETERMINISTIC (sometimes "Session not
    // found", sometimes resolves but reports 0 rounds), so it is unusable as evidence either way. Child-reality
    // is proven instead from the LANDED RESULT: a distinct session id, the child's own round count, its terminal
    // mode, and exported content — a signal only a real child run produces (a mocked child cannot; provider-hit
    // accounting reinforces it in the PR-D4 live-drive). The delegation_engaged verdict keys on this in-result
    // evidence, never a session GET.
    const landed = evidence.result as { rounds?: unknown; mode?: unknown };
    expect(typeof landed.rounds).toBe('number');
    expect(landed.rounds as number).toBeGreaterThanOrEqual(1);
    expect(landed.mode).toBe('complete');
    expect(evidence.afterDelegationDomain[CHANNEL_DECOY_PATH]).toBeUndefined();
    expect(hasPath(evidence.afterDelegationDomain, CHANNEL_DECOY_PATH)).toBe(false);
    expect(evidence.order).toEqual([
      'parent:enter_dispatch',
      'parent:request_child',
      'child:accept_request',
      'child:finish_work',
      'parent:complete_parent',
    ]);

    writeFalsifierLine('F-1', 'PASS', observed);
    return evidence;
  } catch (error) {
    writeFalsifierLine('F-1', 'FAIL', {
      expected: {
        action_result_path: ACTION_RESULT_PATH,
        result_status: 'complete',
        distinct_service_child_session: true,
        child_rounds_at_least: 1,
        child_terminal_mode: 'complete',
        absent_channel_only_decoy_path: CHANNEL_DECOY_PATH,
        response_order: 'parent setup, parent delegation, child rounds, parent completion',
      },
      observed,
      error: errorMessage(error),
    });
    throw error;
  }
}

async function runCompleteScenario(): Promise<F1Evidence> {
  return withDelegationServer(
    {
      parent: {
        targetSpec: CHILD_PROGRAM,
        channelResultPath: CHANNEL_DECOY_PATH,
        maxDelegatedRounds: 5,
        optional: true,
      },
      allowedTargets: [CHILD_PROGRAM],
      script: [
        scripted('parent:enter_dispatch', effect('enter_dispatch', { topic: 'parent-domain-topic' })),
        scripted('parent:request_child', effect('request_child', {
          request: {
            intent: 'f1-request',
            payload_marker: 'payload-from-parent',
          },
        }, 'child_call')),
        scripted('child:accept_request', effect('accept_request', { accepted: true }, 'child_output')),
        scripted('child:finish_work', effect('finish_work', { result: 'child-exported-result' }, 'child_output')),
        scripted('parent:complete_parent', effect('complete_parent', {})),
      ],
    },
    async ({ client, order }) => {
      const parentSessionId = await createDispatchSession(client);

      await client.sessions.trigger(parentSessionId, {
        channel: 'user_text',
        payload: 'dispatch delegated child work',
      });
      const afterDelegationDomain = (await client.sessions.world(parentSessionId)).domain;
      const result = resultAt(afterDelegationDomain, ACTION_RESULT_PATH);
      const childSessionId = requiredString(result.sessionId, 'delegation result sessionId');
      await client.sessions.trigger(parentSessionId, {
        channel: 'user_text',
        payload: 'complete parent after settled delegation',
      });
      let childSession: F1ChildSession = { sessionId: childSessionId };
      let childSessionGetError: string | undefined;
      try {
        childSession = await client.sessions.get(childSessionId);
      } catch (error) {
        childSessionGetError = errorMessage(error);
      }
      let childDomain: Record<string, unknown> = {};
      let childWorldGetError: string | undefined;
      try {
        childDomain = (await client.sessions.world(childSessionId)).domain;
      } catch (error) {
        childWorldGetError = errorMessage(error);
      }
      const childRouteRounds = await optionalCount(() => client.sessions.rounds(childSessionId).then((value) => value.rounds));
      const childRoundEnvelopes = await optionalCount(() => client.sessions.roundEnvelopes(childSessionId).then((value) => value.envelopes));
      const childDebugRounds = await optionalCount(() => client.sessions.debug(childSessionId).then((value) => value.rounds));
      const visibleSessions = await client.sessions.list({ status: 'all' }).then((value) =>
        value.sessions.map((session) => ({
          sessionId: session.sessionId,
          program: session.program,
          role: session.role,
          status: session.status,
          mode: modeOf(session),
        })),
      );
      const finalParent = await client.sessions.get(parentSessionId);

      return {
        parentSessionId,
        result,
        afterDelegationDomain,
        childSession,
        childSessionGetError,
        childWorldGetError,
        visibleSessions,
        childDomain,
        childRounds: childRouteRounds,
        childRoundEnvelopes,
        childDebugRounds,
        childMode: modeOf(childSession),
        finalMode: modeOf(finalParent),
        order: [...order],
      };
    },
  );
}

async function runDegradeScenario(): Promise<ParentScenarioEvidence> {
  return withDelegationServer(
    {
      parent: {
        targetSpec: CHILD_PROGRAM,
        channelResultPath: ACTION_RESULT_PATH,
        maxDelegatedRounds: 2,
        optional: true,
      },
      allowedTargets: [CHILD_PROGRAM],
      script: [
        scripted('parent:enter_dispatch', effect('enter_dispatch', { topic: 'parent-domain-topic' })),
        scripted('parent:request_child', effect('request_child', {
          request: {
            intent: 'f2-never-terminates',
          },
        }, 'child_call')),
        scripted('child:accept_request', effect('accept_request', { accepted: true }, 'child_output')),
        scripted('child:keep_working', effect('keep_working', { note: 'still not done' }, 'child_output')),
        scripted('parent:complete_parent', effect('complete_parent', {})),
      ],
    },
    async ({ client }) => runParentOnlyScenario(client),
  );
}

async function runDeclineScenario(): Promise<ParentScenarioEvidence> {
  return withDelegationServer(
    {
      parent: {
        targetSpec: 'no-such-program',
        channelResultPath: ACTION_RESULT_PATH,
        maxDelegatedRounds: 2,
        optional: true,
      },
      allowedTargets: [CHILD_PROGRAM, 'no-such-program'],
      script: [
        scripted('parent:enter_dispatch', effect('enter_dispatch', { topic: 'parent-domain-topic' })),
        scripted('parent:request_child', effect('request_child', {
          request: {
            intent: 'f3-decline',
          },
        }, 'child_call')),
        scripted('parent:complete_parent', effect('complete_parent', {})),
      ],
    },
    async ({ client }) => runParentOnlyScenario(client),
  );
}

async function runParentOnlyScenario(client: PgasClient): Promise<ParentScenarioEvidence> {
  const parentSessionId = await createDispatchSession(client);
  await client.sessions.trigger(parentSessionId, {
    channel: 'user_text',
    payload: 'dispatch delegated child work',
  });
  const [afterDelegationSession, afterDelegationWorld] = await Promise.all([
    client.sessions.get(parentSessionId),
    client.sessions.world(parentSessionId),
  ]);
  const afterDelegationDomain = afterDelegationWorld.domain;
  const result = resultAt(afterDelegationDomain, ACTION_RESULT_PATH);

  await client.sessions.trigger(parentSessionId, {
    channel: 'user_text',
    payload: 'complete parent after settled delegation',
  });
  const finalParent = await client.sessions.get(parentSessionId);

  return {
    parentSessionId,
    result,
    parentStatus: String(afterDelegationSession.status),
    afterDelegationDomain,
    finalMode: modeOf(finalParent),
  };
}

async function createDispatchSession(client: PgasClient): Promise<string> {
  const created = await client.sessions.create({ program: PARENT_PROGRAM });
  const trigger = await client.sessions.trigger(created.sessionId, {
    channel: 'user_text',
    payload: 'bootstrap parent',
  });
  const [afterBootstrap, world] = await Promise.all([
    client.sessions.get(created.sessionId),
    client.sessions.world(created.sessionId),
  ]);
  if (modeOf(afterBootstrap) !== 'dispatch') {
    process.stdout.write(`[delegation-engine-falsifier] bootstrap diagnostic ${JSON.stringify({
      mode: modeOf(afterBootstrap),
      status: afterBootstrap.status,
      trigger: trigger.result,
      parent_ready: world.domain['parent.ready'],
      parent_topic: world.domain['parent.topic'],
    })}\n`);
  }
  expect(modeOf(afterBootstrap)).toBe('dispatch');
  return created.sessionId;
}

async function withDelegationServer<T>(
  scenario: DelegationScenario,
  run: (ctx: { client: PgasClient; order: string[] }) => Promise<T>,
): Promise<T> {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pgas-delegation-falsifier-'));
  const order: string[] = [];
  const parentEntry = createParentEntry(tempDir, scenario.parent, scenario.allowedTargets);
  const childEntry = createChildEntry(tempDir);
  const server = await createPgasServer({
    programs: [
      { name: PARENT_PROGRAM, entry: parentEntry },
      { name: CHILD_PROGRAM, entry: childEntry },
    ],
    drivers: {
      authorHandle: scriptedAuthor(scenario.script, order),
      observerHandle: {
        modelId: 'delegation-falsifier-observer',
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
    return await run({ client, order });
  } finally {
    await server.close();
    rmSync(tempDir, { force: true, recursive: true });
  }
}

function createParentEntry(
  tempDir: string,
  options: ParentOptions,
  allowedTargetPrograms: string[],
): ProgramEntry {
  const specPath = path.join(tempDir, `parent-${crypto.randomUUID()}.yml`);
  writeFileSync(specPath, parentSpecYaml(options), 'utf8');
  const { spec } = loadSpecWithPatterns(specPath);
  return {
    spec,
    delegationPolicy: {
      allowedTargetPrograms,
      inputEnrichment: [
        { source: 'parent.topic', target: 'request.topic' },
      ],
    },
    reactionHandlers: new Map<string, ReactionHandler>([
      ['settle', settleDelegation],
    ]),
    createAdapters: (ctx) => createProgramAdapters(spec, ctx, parentHandlers),
  };
}

function createChildEntry(tempDir: string): ProgramEntry {
  const specPath = path.join(tempDir, `child-${crypto.randomUUID()}.yml`);
  writeFileSync(specPath, childSpecYaml(), 'utf8');
  const { spec } = loadSpecWithPatterns(specPath);
  return {
    spec,
    delegationResultPolicy: {
      fields: [{ path: 'work.result', key: 'result' }],
    },
    createAdapters: (ctx) => createProgramAdapters(spec, ctx, childHandlers),
  };
}

const settleDelegation: ReactionHandler = (snapshot) => {
  if (snapshot.get('settled') === true) {
    return undefined;
  }
  const status = resultStatusFromSnapshot(snapshot);
  if (!status) {
    return undefined;
  }
  return {
    mutations: [
      { op: 'MSet', path: 'settled', value: true },
      { op: 'MSet', path: 'degraded', value: status === 'failed' },
      { op: 'MSet', path: 'settle.observed_status', value: status },
    ],
  };
};

function resultStatusFromSnapshot(snapshot: Parameters<ReactionHandler>[0]): string | null {
  const direct = snapshot.get(ACTION_RESULT_PATH);
  if (isRecord(direct) && typeof direct.status === 'string') {
    return direct.status;
  }
  const leaf = snapshot.get(`${ACTION_RESULT_PATH}.status`);
  return typeof leaf === 'string' ? leaf : null;
}

const parentHandlers: Record<string, ToolHandler> = {
  async enter_dispatch(payload) {
    return { ok: true, action: 'enter_dispatch', payload };
  },
  async request_child(payload) {
    return { ok: true, action: 'request_child', payload };
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
  async keep_working(payload) {
    return { ok: true, action: 'keep_working', payload };
  },
};

function parentSpecYaml(options: ParentOptions): string {
  return `name: "${PARENT_PROGRAM}"
termination: BoundedSession
topology: CyclicTopology
pure: true

preamble: |
  Route-level delegation falsifier parent.

initial: bootstrap
terminal: [complete]

features:
  - base
  - delegation
  - reactions

channels:
  user_text: { direction: In, sync: Async }
  widget_output: { direction: Out, sync: Sync }
  child_call:
    direction: Out
    sync: Sync
    target_spec: "${options.targetSpec}"
    result_path: "${options.channelResultPath}"
    max_delegated_rounds: ${options.maxDelegatedRounds}
    round_timeout_ms: 5000
    optional: ${String(options.optional)}

modes:
  bootstrap:
    vocabulary: [enter_dispatch]
    channels: [user_text, widget_output]
    transitions:
      - target: dispatch
        guard: { kind: FieldTruthy, path: parent.ready }
  dispatch:
    vocabulary: [request_child, complete_parent]
    channels: [user_text, widget_output, child_call]
    transitions:
      - target: complete
        guard: { kind: FieldTruthy, path: parent.complete_ready }
  complete:
    vocabulary: []
    channels: [widget_output]

proceed_to:
  enter_dispatch: dispatch
  complete_parent: complete

projection:
  bootstrap:
    include: [inputs.user_text, parent.ready, parent.topic]
    exclude: []
  dispatch:
    include:
      - inputs.user_text
      - parent.topic
      - parent.requested
      - settled
      - degraded
      - settle.observed_status
      - ${ACTION_RESULT_PATH}
      - ${ACTION_RESULT_PATH}.status
      - ${ACTION_RESULT_PATH}.reason
      - ${ACTION_RESULT_PATH}.optional
      - ${ACTION_RESULT_PATH}.sessionId
      - ${ACTION_RESULT_PATH}.rounds
      - ${ACTION_RESULT_PATH}.mode
      - ${ACTION_RESULT_PATH}.result
      - ${CHANNEL_DECOY_PATH}
      - ${CHANNEL_DECOY_PATH}.status
    exclude: []
  complete:
    include:
      - settled
      - degraded
      - settle.observed_status
      - ${ACTION_RESULT_PATH}
      - ${ACTION_RESULT_PATH}.status
      - ${ACTION_RESULT_PATH}.reason
      - ${ACTION_RESULT_PATH}.optional
      - ${ACTION_RESULT_PATH}.sessionId
      - ${ACTION_RESULT_PATH}.rounds
      - ${ACTION_RESULT_PATH}.mode
      - ${ACTION_RESULT_PATH}.result
    exclude: []

prompts:
  bootstrap: "Move from bootstrap to dispatch."
  dispatch: "Call request_child once, then complete_parent after settled is true."
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
  request_child:
    description: "Synchronously delegate to the child program."
    mutations:
      - { op: MSet, path: parent.requested, value: true }
    channel: child_call
    result_path: "${ACTION_RESULT_PATH}"
  complete_parent:
    description: "Complete after the settle reaction observes the delegation result."
    mutations:
      - { op: MSet, path: parent.complete_ready, value: true }
    channel: widget_output

schema:
  inputs.user_text: string
  parent.ready: boolean
  parent.topic: string
  parent.requested: boolean
  parent.complete_ready: boolean
  settled: boolean
  degraded: boolean
  settle.observed_status: string
  ${ACTION_RESULT_PATH}: object
  ${ACTION_RESULT_PATH}.status: string
  ${ACTION_RESULT_PATH}.reason: string
  ${ACTION_RESULT_PATH}.optional: boolean
  ${ACTION_RESULT_PATH}.mode: string
  ${ACTION_RESULT_PATH}.rounds: number
  ${ACTION_RESULT_PATH}.sessionId: string
  ${ACTION_RESULT_PATH}.result: string
  ${CHANNEL_DECOY_PATH}: object
  ${CHANNEL_DECOY_PATH}.status: string
  ${CHANNEL_DECOY_PATH}.reason: string
  ${CHANNEL_DECOY_PATH}.optional: boolean
  ${CHANNEL_DECOY_PATH}.mode: string
  ${CHANNEL_DECOY_PATH}.rounds: number
  ${CHANNEL_DECOY_PATH}.sessionId: string

reactions:
  settle:
    event: AfterRound
    watch: []
    write_scope: [settled, degraded, settle.observed_status]

repair_bound: 2

fallback:
  channel: widget_output
  payload: { ok: false }
`;
}

function childSpecYaml(): string {
  return `name: "${CHILD_PROGRAM}"
termination: BoundedSession
topology: CyclicTopology
pure: true

preamble: |
  Route-level delegation falsifier child.

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
    vocabulary: [finish_work, keep_working]
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
    include:
      - inputs.user_text
      - inputs.request
      - inputs.request.intent
      - inputs.request.topic
      - inputs.domain_context
      - inputs.domain_context.source_program
    exclude: []
  work:
    include:
      - inputs.user_text
      - inputs.request
      - inputs.request.intent
      - inputs.request.topic
      - inputs.domain_context
      - inputs.domain_context.source_program
      - child.received
      - work.result
      - work.keepalive
    exclude: []
  complete:
    include:
      - inputs.request
      - inputs.request.intent
      - inputs.request.topic
      - inputs.domain_context
      - inputs.domain_context.source_program
      - child.received
      - work.done
      - work.result
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
  keep_working:
    description: "Stay non-terminal for optional-delegation degrade proof."
    mutations:
      - { op: MSet, path: work.keepalive, from_arg: note }
    channel: child_output

schema:
  inputs.user_text: string
  inputs.request: object
  inputs.request.intent: string
  inputs.request.payload_marker: string
  inputs.request.topic: string
  inputs.domain_context: object
  inputs.domain_context.source_program: string
  inputs.domain_context.source_session_id: string
  inputs.domain_context.owner_session_id: string
  inputs.domain_context.target_program: string
  child.received: boolean
  work.done: boolean
  work.result: string
  work.keepalive: string

repair_bound: 2

fallback:
  channel: child_output
  payload: { ok: false }
`;
}

function effect(name: string, payload: Record<string, unknown>, channel = 'widget_output'): Record<string, unknown> {
  return { actions: [{ kind: 'EffectAction', name, channel, payload }] };
}

function scripted(label: string, response: Record<string, unknown>): ScriptedResponse {
  return { label, response };
}

function scriptedAuthor(
  responses: ScriptedResponse[],
  order: string[],
): { modelId: string; complete(): Promise<string> } {
  let index = 0;
  return {
    modelId: 'delegation-falsifier-author',
    async complete() {
      const response = responses[index++];
      if (!response) {
        throw new Error(`no delegation falsifier author response scripted for call ${String(index - 1)}`);
      }
      order.push(response.label);
      return JSON.stringify(response.response);
    },
  };
}

async function recordFalsifier(
  id: string,
  failures: Error[],
  run: () => Promise<Record<string, unknown>>,
): Promise<void> {
  try {
    const evidence = await run();
    writeFalsifierLine(id, 'PASS', evidence);
  } catch (error) {
    const message = `${id} failed: ${errorMessage(error)}`;
    failures.push(new Error(message));
    writeFalsifierLine(id, 'FAIL', { error: errorMessage(error) });
  }
}

function writeFalsifierLine(id: string, status: 'PASS' | 'FAIL', evidence: unknown): void {
  process.stdout.write(`[delegation-engine-falsifier] ${id} ${status} ${JSON.stringify(evidence)}\n`);
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

function hasPath(domain: Record<string, unknown>, pathKey: string): boolean {
  return Object.keys(domain).some((key) => key === pathKey || key.startsWith(`${pathKey}.`));
}

async function optionalCount(read: () => Promise<unknown[]>): Promise<number | string> {
  try {
    return (await read()).length;
  } catch (error) {
    return `error:${errorMessage(error)}`;
  }
}

function requiredString(value: unknown, label: string): string {
  expect(typeof value, label).toBe('string');
  return value as string;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ParentOptions {
  targetSpec: string;
  channelResultPath: string;
  maxDelegatedRounds: number;
  optional: boolean;
}

interface DelegationScenario {
  parent: ParentOptions;
  allowedTargets: string[];
  script: ScriptedResponse[];
}

interface ScriptedResponse {
  label: string;
  response: Record<string, unknown>;
}

interface ParentScenarioEvidence {
  parentSessionId: string;
  result: Record<string, unknown>;
  parentStatus: string;
  afterDelegationDomain: Record<string, unknown>;
  finalMode: string | null;
}

interface VisibleSessionEvidence {
  sessionId: string;
  program: string;
  role?: string;
  status: string;
  mode: string | null;
}

type F1ChildSession = {
  sessionId: string;
  role?: string;
  mode?: unknown;
  state?: unknown;
};

interface F1Evidence {
  parentSessionId: string;
  result: Record<string, unknown>;
  afterDelegationDomain: Record<string, unknown>;
  childSession: F1ChildSession;
  childSessionGetError?: string;
  childWorldGetError?: string;
  visibleSessions: VisibleSessionEvidence[];
  childDomain: Record<string, unknown>;
  childRounds: number | string;
  childRoundEnvelopes: number | string;
  childDebugRounds: number | string;
  childMode: string | null;
  finalMode: string | null;
  order: string[];
}
