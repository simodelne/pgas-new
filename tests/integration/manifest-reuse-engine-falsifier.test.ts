import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { type PgasClient } from '@simodelne/pgas-server/client.js';
import {
  createProgramAdapters,
  loadSpecWithPatterns,
  type ProgramEntry,
  type ReactionHandler,
  type ToolHandler,
} from '@simodelne/pgas-server/plugin.js';
import { describe, expect, it } from 'vitest';

import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import { startRouteHarness } from './foundry-test-utils.js';

interface AgentScenario {
  parentProgram: string;
  parentName: string;
  targetDir: string;
  purpose: string;
  targetSpec: string;
  childRegistryKey: string;
  childId: string;
  stage: string;
  // The stage-classifier routes the transition action's completion effect to
  // widget_output for llm-reasoning stages (e.g. a stage named "review") and to
  // stage_output for pure-compute stages. The scripted author must emit the
  // completion effect on the matching channel.
  completionArchetype: 'pure-compute' | 'llm-reasoning';
}

const RESEARCH_AGENT: AgentScenario = {
  parentProgram: 'manifest-reuse-parent',
  parentName: 'Manifest Reuse Parent',
  targetDir: '/tmp/manifest-reuse-parent',
  purpose: 'Dispatch legal research through a target_spec-only child.',
  targetSpec: 'SimoneOS Legal Research',
  childRegistryKey: 'research',
  childId: 'research',
  stage: 'dispatch_research',
  completionArchetype: 'pure-compute',
};

const DOCUMENT_INGEST_AGENT: AgentScenario = {
  parentProgram: 'manifest-reuse-ingest-parent',
  parentName: 'Manifest Reuse Ingest Parent',
  targetDir: '/tmp/manifest-reuse-ingest-parent',
  purpose: 'Dispatch document ingest through a target_spec-only child.',
  targetSpec: 'SimoneOS Document Ingest',
  childRegistryKey: 'document-ingest',
  childId: 'document_ingest',
  stage: 'dispatch_ingest',
  completionArchetype: 'pure-compute',
};

const REVIEW_AGENT: AgentScenario = {
  parentProgram: 'manifest-reuse-review-parent',
  parentName: 'Manifest Reuse Review Parent',
  targetDir: '/tmp/manifest-reuse-review-parent',
  purpose: 'Dispatch contract review through a target_spec-only child.',
  targetSpec: 'contract-review-service',
  childRegistryKey: 'contract-review-service',
  childId: 'review',
  // A stage named "review" is classified llm-reasoning by the stage-classifier,
  // so its completion effect rides widget_output with a result_json arg.
  stage: 'dispatch_review',
  completionArchetype: 'llm-reasoning',
};

function actionResultPath(agent: AgentScenario): string {
  return `${agent.stage}.delegation.${agent.childId}.result`;
}

function delegationBase(agent: AgentScenario): string {
  return `${agent.stage}.delegation.${agent.childId}`;
}

describe('manifest reuse engine falsifier', () => {
  it('F-2 routes a foundry-emitted target_spec channel to a separately registered program by name', async () => {
    const evidence = await runManifestReuseScenario({
      agent: RESEARCH_AGENT,
      childRegistryName: RESEARCH_AGENT.childRegistryKey,
      childSpecName: RESEARCH_AGENT.targetSpec,
      allowedTargetPrograms: [RESEARCH_AGENT.targetSpec, RESEARCH_AGENT.childRegistryKey],
      script: completeScript(RESEARCH_AGENT),
    });

    expect(evidence.result.status).toBe('complete');
    expect(typeof evidence.result.sessionId).toBe('string');
    expect(evidence.result.sessionId).not.toBe(evidence.parentSessionId);
    expect(evidence.finalMode).toBe('complete');
  });

  it('F-2k declines as Unknown protocol when neither registered key nor spec name matches target_spec', async () => {
    const evidence = await runManifestReuseScenario({
      agent: RESEARCH_AGENT,
      childRegistryName: 'unrelated-research',
      childSpecName: 'Unrelated Legal Research',
      allowedTargetPrograms: [RESEARCH_AGENT.targetSpec, RESEARCH_AGENT.childRegistryKey, 'unrelated-research'],
      script: declinedScript(RESEARCH_AGENT),
    });

    expect(evidence.result.status).toBe('declined');
    expect(String(evidence.result.reason)).toContain('Unknown protocol');
  });

  it('F-2k declines when allowedTargetPrograms omits the resolved registry key', async () => {
    const evidence = await runManifestReuseScenario({
      agent: RESEARCH_AGENT,
      childRegistryName: RESEARCH_AGENT.childRegistryKey,
      childSpecName: RESEARCH_AGENT.targetSpec,
      allowedTargetPrograms: [RESEARCH_AGENT.targetSpec],
      script: declinedScript(RESEARCH_AGENT),
    });

    expect(evidence.result.status).toBe('declined');
    expect(String(evidence.result.reason)).toContain('not in allowedTargetPrograms');
  });
});

describe('manifest reuse engine falsifier — document-ingest + review agents (Slice A)', () => {
  for (const agent of [DOCUMENT_INGEST_AGENT, REVIEW_AGENT]) {
    it(`F-A2 routes the ${agent.childRegistryKey} target_spec channel to a separately registered program by name`, async () => {
      const evidence = await runManifestReuseScenario({
        agent,
        childRegistryName: agent.childRegistryKey,
        childSpecName: agent.targetSpec,
        allowedTargetPrograms: [agent.targetSpec, agent.childRegistryKey],
        script: completeScript(agent),
      });

      expect(evidence.result.status).toBe('complete');
      expect(typeof evidence.result.sessionId).toBe('string');
      expect(evidence.result.sessionId).not.toBe(evidence.parentSessionId);
      expect(evidence.finalMode).toBe('complete');
    });

    it(`F-A2k declines as Unknown protocol when nothing matches the ${agent.childRegistryKey} target_spec`, async () => {
      const evidence = await runManifestReuseScenario({
        agent,
        childRegistryName: `unrelated-${agent.childId}`,
        childSpecName: `Unrelated ${agent.childId}`,
        allowedTargetPrograms: [agent.targetSpec, agent.childRegistryKey, `unrelated-${agent.childId}`],
        script: declinedScript(agent),
      });

      expect(evidence.result.status).toBe('declined');
      expect(String(evidence.result.reason)).toContain('Unknown protocol');
    });

  }

  // The engine face of the manifest kill: when the manifest entry is absent the
  // foundry never stamps registered_name, so the emitted allowedTargetPrograms
  // carries ONLY the spec name. This is only observable at the engine when the
  // registry key differs from the spec name (document-ingest); for review the
  // key equals the spec name so the both-names fix is a no-op and the parent
  // unit fallback test carries the kill for that case.
  for (const agent of [DOCUMENT_INGEST_AGENT, REVIEW_AGENT].filter((a) => a.childRegistryKey !== a.targetSpec)) {
    it(`F-A2k (KILL) declines when allowedTargetPrograms omits the ${agent.childRegistryKey} registry key`, async () => {
      const evidence = await runManifestReuseScenario({
        agent,
        childRegistryName: agent.childRegistryKey,
        childSpecName: agent.targetSpec,
        allowedTargetPrograms: [agent.targetSpec],
        script: declinedScript(agent),
      });

      expect(evidence.result.status).toBe('declined');
      expect(String(evidence.result.reason)).toContain('not in allowedTargetPrograms');
    });
  }
});

async function runManifestReuseScenario(options: ManifestReuseScenario): Promise<ScenarioEvidence> {
  const { agent } = options;
  return withManifestReuseServer(options, async ({ client }) => {
    const created = await client.sessions.create({ program: agent.parentProgram });
    const parentSessionId = created.sessionId;

    // Drive bootstrap -> dispatch -> completion. With the delegation continuation
    // contract in place, the engine-fired system_query_result wakes the parent and can
    // auto-advance it to a terminal mode within a single trigger, so tolerate an
    // over-trigger instead of asserting an intermediate stage.
    for (const payload of ['bootstrap parent', 'dispatch delegated work', 'complete parent']) {
      try {
        await client.sessions.trigger(parentSessionId, { channel: 'user_text', payload });
      } catch (error) {
        if (String((error as Error).message).includes('terminal')) break;
        throw error;
      }
    }

    const afterDelegationDomain = (await client.sessions.world(parentSessionId)).domain;
    const result = resultAt(afterDelegationDomain, actionResultPath(agent));
    const finalParent = await client.sessions.get(parentSessionId);

    return {
      parentSessionId,
      result,
      finalMode: modeOf(finalParent),
    };
  });
}

async function withManifestReuseServer<T>(
  options: ManifestReuseScenario,
  run: (ctx: { client: PgasClient }) => Promise<T>,
): Promise<T> {
  const { agent } = options;
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pgas-manifest-reuse-falsifier-'));
  const parentEntry = createParentEntry(tempDir, agent, options.allowedTargetPrograms);
  const childEntry = createChildEntry(tempDir, options.childSpecName);
  const { client, close } = await startRouteHarness({
    programs: [
      { name: agent.parentProgram, entry: parentEntry },
      { name: options.childRegistryName, entry: childEntry },
    ],
    authorHandle: scriptedAuthor(options.script),
    observerModelId: 'manifest-reuse-observer',
  });
  try {
    return await run({ client });
  } finally {
    await close();
    rmSync(tempDir, { force: true, recursive: true });
  }
}

function createParentEntry(tempDir: string, agent: AgentScenario, allowedTargetPrograms: string[]): ProgramEntry {
  const artifact = synthesizeProgramSpecFromDomain(parentDomain(agent));
  const specPath = path.join(tempDir, `parent-${randomUUID()}.yml`);
  writeFileSync(specPath, artifact.spec_yaml, 'utf8');
  const { spec } = loadSpecWithPatterns(specPath);
  return {
    spec,
    delegationPolicy: {
      allowedTargetPrograms,
      inputEnrichment: [
        { source: 'inputs.initial_user_text', target: 'request.topic' },
      ],
    },
    reactionHandlers: new Map<string, ReactionHandler>([
      [`settle_${agent.childId}_delegation`, settleDelegationFor(agent)],
    ]),
    createAdapters: (ctx) => createProgramAdapters(spec, ctx, parentHandlersFor(agent)),
  };
}

function createChildEntry(tempDir: string, specName: string): ProgramEntry {
  const specPath = path.join(tempDir, `child-${randomUUID()}.yml`);
  writeFileSync(specPath, childSpecYaml(specName), 'utf8');
  const { spec } = loadSpecWithPatterns(specPath);
  return {
    spec,
    delegationResultPolicy: {
      fields: [{ path: 'work.summary', key: 'summary' }],
    },
    createAdapters: (ctx) => createProgramAdapters(spec, ctx, childHandlers),
  };
}

function parentDomain(agent: AgentScenario): Record<string, unknown> {
  return {
    'program.slug': agent.parentProgram,
    'program.name': agent.parentName,
    'program.target_dir': agent.targetDir,
    'intake.purpose': agent.purpose,
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      {
        slug: 'intake',
        is_bootstrap: true,
        domain_spec: {
          reads: ['inputs.user_text'],
          produces: { result_json: { topic: 'string' } },
          rules: ['Capture the delegation topic.'],
          invariants: ['The topic is available for delegation.'],
        },
      },
      { slug: agent.stage },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: agent.stage, trigger: 'started', guard_field: 'intake.started' },
      { from: agent.stage, to: 'complete', trigger: 'done', guard_field: `${agent.stage}.ready` },
    ]),
    'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: `${agent.stage}.ready` }),
    'intake.delegation_json': JSON.stringify({
      children: [
        {
          id: agent.childId,
          stage: agent.stage,
          target_spec: agent.targetSpec,
          payload_map: { 'request.topic': 'inputs.initial_user_text' },
          result_path: actionResultPath(agent),
          max_delegated_rounds: 12,
          optional: true,
        },
      ],
    }),
  };
}

function settleDelegationFor(agent: AgentScenario): ReactionHandler {
  const base = delegationBase(agent);
  return (snapshot) => {
    if (snapshot.get(`${base}.settled`) === true) {
      return undefined;
    }
    const status = resultStatusFromSnapshot(snapshot, agent);
    if (!status) {
      return undefined;
    }
    return {
      mutations: [
        { op: 'MSet', path: `${base}.settled`, value: true },
        { op: 'MSet', path: `${base}.degraded`, value: status !== 'complete' },
        { op: 'MSet', path: `${base}.degrade_reason`, value: status === 'complete' ? '' : status },
      ],
    };
  };
}

function resultStatusFromSnapshot(snapshot: Parameters<ReactionHandler>[0], agent: AgentScenario): string | null {
  const resultPath = actionResultPath(agent);
  const direct = snapshot.get(resultPath);
  if (isRecord(direct) && typeof direct.status === 'string') {
    return direct.status;
  }
  const leaf = snapshot.get(`${resultPath}.status`);
  return typeof leaf === 'string' ? leaf : null;
}

function parentHandlersFor(agent: AgentScenario): Record<string, ToolHandler> {
  return {
    async begin_work(payload) {
      return { ok: true, action: 'begin_work', payload };
    },
    [`request_${agent.childId}`]: async (payload) => {
      return { ok: true, action: `request_${agent.childId}`, payload };
    },
    [`complete_${agent.stage}`]: async (payload) => {
      return { ok: true, action: `complete_${agent.stage}`, payload };
    },
  };
}

const childHandlers: Record<string, ToolHandler> = {
  async accept_request(payload) {
    return { ok: true, action: 'accept_request', payload };
  },
  async finish_work(payload) {
    return { ok: true, action: 'finish_work', payload };
  },
};

function childSpecYaml(specName: string): string {
  return `name: "${specName}"
termination: BoundedSession
topology: CyclicTopology
pure: true

preamble: |
  Hand-authored delegation stub used by the manifest reuse falsifier.

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
    include: [inputs.user_text, inputs.request, inputs.request.topic, inputs.domain_context, inputs.domain_context.source_program]
    exclude: []
  work:
    include: [inputs.request, inputs.request.topic, child.received, work.summary]
    exclude: []
  complete:
    include: [inputs.request, inputs.request.topic, child.received, work.done, work.summary]
    exclude: []

prompts:
  receive: "Accept the delegated legal research request."
  work: "Finish the delegated legal research request."
  complete: "Terminal."

ingestion:
  user_text:
    - inputs.user_text

action_map:
  accept_request:
    description: "Record that the request was received."
    mutations:
      - { op: MSet, path: child.received, value: true }
    channel: child_output
  finish_work:
    description: "Complete legal research and export a summary."
    mutations:
      - { op: MSet, path: work.done, value: true }
      - { op: MSet, path: work.summary, from_arg: summary }
    channel: child_output

schema:
  inputs.user_text: string
  inputs.request: object
  inputs.request.topic: string
  inputs.domain_context: object
  inputs.domain_context.source_program: string
  inputs.domain_context.source_session_id: string
  inputs.domain_context.target_program: string
  child.received: boolean
  work.done: boolean
  work.summary: string

repair_bound: 2

fallback:
  channel: child_output
  payload: { ok: false }
`;
}

function completionEffect(agent: AgentScenario): Record<string, unknown> {
  const completeAction = `complete_${agent.stage}`;
  return agent.completionArchetype === 'llm-reasoning'
    ? effect(completeAction, {
      result_json: JSON.stringify({ done: true }),
      items_json: JSON.stringify(['delegation-complete']),
    }, 'widget_output')
    : effect(completeAction, { __stage_runtime: { now_iso: '2026-07-16T00:00:00.000Z', random: 0.25 } }, 'stage_output');
}

function completeScript(agent: AgentScenario): ScriptedResponse[] {
  const requestAction = `request_${agent.childId}`;
  return [
    scripted('parent:begin_work', effect('begin_work', {}, 'stage_output')),
    scripted(`parent:${requestAction}`, effect(requestAction, {
      request: { topic: 'lease indemnity' },
    }, `${agent.childId}_call`)),
    scripted('child:accept_request', effect('accept_request', { accepted: true }, 'child_output')),
    scripted('child:finish_work', effect('finish_work', { summary: 'complete delegated work' }, 'child_output')),
    scripted(`parent:complete_${agent.stage}`, completionEffect(agent)),
  ];
}

function declinedScript(agent: AgentScenario): ScriptedResponse[] {
  const requestAction = `request_${agent.childId}`;
  return [
    scripted('parent:begin_work', effect('begin_work', {}, 'stage_output')),
    scripted(`parent:${requestAction}`, effect(requestAction, {
      request: { topic: 'lease indemnity' },
    }, `${agent.childId}_call`)),
    scripted(`parent:complete_${agent.stage}`, completionEffect(agent)),
  ];
}

function effect(name: string, payload: Record<string, unknown>, channel: string): Record<string, unknown> {
  return { actions: [{ kind: 'EffectAction', name, channel, payload }] };
}

function scripted(label: string, response: Record<string, unknown>): ScriptedResponse {
  return { label, response };
}

function scriptedAuthor(responses: ScriptedResponse[]): { modelId: string; complete(): Promise<string> } {
  let index = 0;
  return {
    modelId: 'manifest-reuse-author',
    async complete() {
      const response = responses[index++];
      if (!response) {
        throw new Error(`no manifest reuse author response scripted for call ${String(index - 1)}`);
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
    if (key.startsWith(prefix)) {
      result[key.slice(prefix.length)] = value;
    }
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

interface ManifestReuseScenario {
  agent: AgentScenario;
  childRegistryName: string;
  childSpecName: string;
  allowedTargetPrograms: string[];
  script: ScriptedResponse[];
}

interface ScriptedResponse {
  label: string;
  response: Record<string, unknown>;
}

interface ScenarioEvidence {
  parentSessionId: string;
  result: Record<string, unknown>;
  finalMode: string | null;
}
