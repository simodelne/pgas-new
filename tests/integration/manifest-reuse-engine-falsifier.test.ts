import { randomUUID } from 'node:crypto';
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

import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';

const PARENT_PROGRAM = 'manifest-reuse-parent';
const TARGET_SPEC = 'SimoneOS Legal Research';
const CHILD_REGISTRY_KEY = 'research';
const ACTION_RESULT_PATH = 'dispatch_research.delegation.research.result';
const DELEGATION_BASE = 'dispatch_research.delegation.research';

describe('manifest reuse engine falsifier', () => {
  it('F-2 routes a foundry-emitted target_spec channel to a separately registered program by name', async () => {
    const evidence = await runManifestReuseScenario({
      childRegistryName: CHILD_REGISTRY_KEY,
      childSpecName: TARGET_SPEC,
      allowedTargetPrograms: [TARGET_SPEC, CHILD_REGISTRY_KEY],
      script: completeScript(),
    });

    expect(evidence.result.status).toBe('complete');
    expect(typeof evidence.result.sessionId).toBe('string');
    expect(evidence.result.sessionId).not.toBe(evidence.parentSessionId);
    expect(evidence.finalMode).toBe('complete');
  });

  it('F-2k declines as Unknown protocol when neither registered key nor spec name matches target_spec', async () => {
    const evidence = await runManifestReuseScenario({
      childRegistryName: 'unrelated-research',
      childSpecName: 'Unrelated Legal Research',
      allowedTargetPrograms: [TARGET_SPEC, CHILD_REGISTRY_KEY, 'unrelated-research'],
      script: declinedScript(),
    });

    expect(evidence.result.status).toBe('declined');
    expect(String(evidence.result.reason)).toContain('Unknown protocol');
  });

  it('F-2k declines when allowedTargetPrograms omits the resolved registry key', async () => {
    const evidence = await runManifestReuseScenario({
      childRegistryName: CHILD_REGISTRY_KEY,
      childSpecName: TARGET_SPEC,
      allowedTargetPrograms: [TARGET_SPEC],
      script: declinedScript(),
    });

    expect(evidence.result.status).toBe('declined');
    expect(String(evidence.result.reason)).toContain('not in allowedTargetPrograms');
  });
});

async function runManifestReuseScenario(options: ManifestReuseScenario): Promise<ScenarioEvidence> {
  return withManifestReuseServer(options, async ({ client }) => {
    const parentSessionId = await createParentDispatchSession(client);

    await client.sessions.trigger(parentSessionId, {
      channel: 'user_text',
      payload: 'dispatch legal research',
    });
    const afterDelegationDomain = (await client.sessions.world(parentSessionId)).domain;
    const result = resultAt(afterDelegationDomain, ACTION_RESULT_PATH);

    await client.sessions.trigger(parentSessionId, {
      channel: 'user_text',
      payload: 'complete parent',
    });
    const finalParent = await client.sessions.get(parentSessionId);

    return {
      parentSessionId,
      result,
      finalMode: modeOf(finalParent),
    };
  });
}

async function createParentDispatchSession(client: PgasClient): Promise<string> {
  const created = await client.sessions.create({ program: PARENT_PROGRAM });
  await client.sessions.trigger(created.sessionId, {
    channel: 'user_text',
    payload: 'bootstrap parent',
  });
  const afterBootstrap = await client.sessions.get(created.sessionId);
  expect(modeOf(afterBootstrap)).toBe('dispatch_research');
  return created.sessionId;
}

async function withManifestReuseServer<T>(
  options: ManifestReuseScenario,
  run: (ctx: { client: PgasClient }) => Promise<T>,
): Promise<T> {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pgas-manifest-reuse-falsifier-'));
  const parentEntry = createParentEntry(tempDir, options.allowedTargetPrograms);
  const childEntry = createChildEntry(tempDir, options.childSpecName);
  const server = await createPgasServer({
    programs: [
      { name: PARENT_PROGRAM, entry: parentEntry },
      { name: options.childRegistryName, entry: childEntry },
    ],
    drivers: {
      authorHandle: scriptedAuthor(options.script),
      observerHandle: {
        modelId: 'manifest-reuse-observer',
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
    return await run({ client });
  } finally {
    await server.close();
    rmSync(tempDir, { force: true, recursive: true });
  }
}

function createParentEntry(tempDir: string, allowedTargetPrograms: string[]): ProgramEntry {
  const artifact = synthesizeProgramSpecFromDomain(parentDomain());
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
      ['settle_research_delegation', settleDelegation],
    ]),
    createAdapters: (ctx) => createProgramAdapters(spec, ctx, parentHandlers),
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

function parentDomain(): Record<string, unknown> {
  return {
    'program.slug': PARENT_PROGRAM,
    'program.name': 'Manifest Reuse Parent',
    'program.target_dir': '/tmp/manifest-reuse-parent',
    'intake.purpose': 'Dispatch legal research through a target_spec-only child.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      {
        slug: 'intake',
        is_bootstrap: true,
        domain_spec: {
          reads: ['inputs.user_text'],
          produces: { result_json: { topic: 'string' } },
          rules: ['Capture the legal research topic.'],
          invariants: ['The topic is available for delegation.'],
        },
      },
      { slug: 'dispatch_research' },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'dispatch_research', trigger: 'started', guard_field: 'intake.started' },
      { from: 'dispatch_research', to: 'complete', trigger: 'done', guard_field: 'dispatch_research.ready' },
    ]),
    'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'dispatch_research.ready' }),
    'intake.delegation_json': JSON.stringify({
      children: [
        {
          id: 'research',
          stage: 'dispatch_research',
          target_spec: TARGET_SPEC,
          payload_map: { 'request.topic': 'inputs.initial_user_text' },
          result_path: ACTION_RESULT_PATH,
          max_delegated_rounds: 12,
          optional: true,
        },
      ],
    }),
  };
}

const settleDelegation: ReactionHandler = (snapshot) => {
  if (snapshot.get(`${DELEGATION_BASE}.settled`) === true) {
    return undefined;
  }
  const status = resultStatusFromSnapshot(snapshot);
  if (!status) {
    return undefined;
  }
  return {
    mutations: [
      { op: 'MSet', path: `${DELEGATION_BASE}.settled`, value: true },
      { op: 'MSet', path: `${DELEGATION_BASE}.degraded`, value: status !== 'complete' },
      { op: 'MSet', path: `${DELEGATION_BASE}.degrade_reason`, value: status === 'complete' ? '' : status },
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
  async begin_work(payload) {
    return { ok: true, action: 'begin_work', payload };
  },
  async request_research(payload) {
    return { ok: true, action: 'request_research', payload };
  },
  async complete_dispatch_research(payload) {
    return { ok: true, action: 'complete_dispatch_research', payload };
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

function childSpecYaml(specName: string): string {
  return `name: "${specName}"
termination: BoundedSession
topology: CyclicTopology
pure: true

preamble: |
  Hand-authored research stub used by the manifest reuse falsifier.

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

function completeScript(): ScriptedResponse[] {
  return [
    scripted('parent:begin_work', effect('begin_work', {}, 'stage_output')),
    scripted('parent:request_research', effect('request_research', {
      request: { topic: 'lease indemnity' },
    }, 'research_call')),
    scripted('child:accept_request', effect('accept_request', { accepted: true }, 'child_output')),
    scripted('child:finish_work', effect('finish_work', { summary: 'complete legal research' }, 'child_output')),
    scripted('parent:complete_dispatch_research', effect('complete_dispatch_research', {}, 'stage_output')),
  ];
}

function declinedScript(): ScriptedResponse[] {
  return [
    scripted('parent:begin_work', effect('begin_work', {}, 'stage_output')),
    scripted('parent:request_research', effect('request_research', {
      request: { topic: 'lease indemnity' },
    }, 'research_call')),
    scripted('parent:complete_dispatch_research', effect('complete_dispatch_research', {}, 'stage_output')),
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
