import type { ToolHandler } from '@simodelne/pgas-server/plugin.js';
import { load } from 'js-yaml';
import { createExistingRepoArtifactPlan, createStandaloneArtifactPlan } from '../pgas-new/artifact-plan.js';
import type { WiringManifest } from '../pgas-new/wiring-manifest.js';
import { synthesizeProgramSpecFromDomain } from './synthesizer.js';
import { putSynthesizedArtifact, requireSynthesizedArtifact } from './synthesizer-store.js';

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

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stringField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string') {
    throw new Error(`missing string payload field: ${key}`);
  }
  return value;
}

function optionalJsonField(payload: Record<string, unknown>, structuredKey: string, jsonKey: string): unknown {
  const structuredValue = payload[structuredKey];
  if (structuredValue !== undefined) return structuredValue;

  const jsonValue = payload[jsonKey];
  if (typeof jsonValue !== 'string') {
    throw new Error(`missing JSON-string payload field: ${jsonKey}`);
  }
  return JSON.parse(jsonValue) as unknown;
}

export const handlers: Record<string, ToolHandler> = {
  async synthesize_program_spec(payload) {
    const sessionId = sessionIdFromPayload(payload);
    const synthesized = synthesizeProgramSpecFromDomain(domainFromPayload(payload));
    putSynthesizedArtifact(sessionId, {
      spec_yaml: synthesized.spec_yaml,
      mode_names: synthesized.mode_names,
      sha256: synthesized.sha256,
      created_at: new Date().toISOString(),
    });
    return {
      kind: 'mechanical_synthesis',
      no_llm_call: true,
      mode_names: synthesized.mode_names,
      sha256: synthesized.sha256,
    };
  },

  async record_program_target(payload) {
    return {
      kind: 'pgas_new_target_recorded',
      target_dir: stringField(payload, 'target_dir'),
      confirmed: true,
    };
  },

  async choose_design_path(payload) {
    const choice = stringField(payload, 'choice');
    if (choice !== 'default' && choice !== 'design') {
      throw new Error('choose_design_path choice must be "default" or "design"');
    }
    return {
      kind: 'pgas_new_design_path_chosen',
      choice,
    };
  },

  async apply_default_skeleton() {
    return {
      kind: 'pgas_new_default_skeleton_applied',
      stages: cloneJson(defaultStages),
      transitions: cloneJson(defaultTransitions),
    };
  },

  async record_program_intake(payload) {
    return {
      kind: 'pgas_new_intake_recorded',
      purpose: stringField(payload, 'purpose'),
      entry_channel: stringField(payload, 'entry_channel'),
      stages: optionalJsonField(payload, 'stages', 'stages_json'),
      transitions: optionalJsonField(payload, 'transitions', 'transitions_json'),
      delegation: optionalJsonField(payload, 'delegation', 'delegation_json'),
      completion: optionalJsonField(payload, 'completion', 'completion_json'),
    };
  },

  async confirm_design() {
    return {
      kind: 'pgas_new_design_confirmed',
      approved: true,
    };
  },

  async plan_artifacts(payload) {
    const sessionId = sessionIdFromPayload(payload);
    const domain = domainFromPayload(payload);
    const synthesized = requireSynthesizedArtifact(sessionId);
    const parsedSpec = load(synthesized.spec_yaml) as { name?: string; modes?: Record<string, unknown> };
    const program = {
      slug: stringDomainField(domain, 'program.slug'),
      name: stringDomainField(domain, 'program.name'),
    };
    const targetKind = optionalStringDomainField(domain, 'repo.target_kind') ?? optionalStringDomainField(domain, 'repo.kind');
    const plan = targetKind === 'existing_repo'
      ? createExistingRepoArtifactPlan(program, parseWiringManifestDomainField(domain))
      : createStandaloneArtifactPlan(program);

    return {
      kind: 'artifact_plan_drafted',
      target: plan.target,
      artifact_count: plan.artifacts.length,
      artifacts: plan.artifacts,
      synthesized_spec: {
        name: parsedSpec.name,
        mode_names: Object.keys(parsedSpec.modes ?? {}),
        sha256: synthesized.sha256,
      },
    };
  },

  async record_user_note(payload) {
    return {
      kind: 'note_recorded',
      payload,
    };
  },

  async create_curator_request(payload) {
    return {
      kind: 'curator_request_prepared',
      payload,
    };
  },

  async write_scaffold_artifacts(payload) {
    return {
      kind: 'artifact_write_requested',
      payload,
    };
  },
};

function sessionIdFromPayload(payload: Record<string, unknown>): string {
  const direct = payload.session_id ?? payload.sessionId;
  if (typeof direct === 'string' && direct.length > 0) {
    return direct;
  }
  const domain = payload.domain;
  if (domain && typeof domain === 'object' && !Array.isArray(domain)) {
    const domainRecord = domain as Record<string, unknown>;
    const fromDomain = domainRecord.session_id ?? domainRecord.sessionId ?? domainRecord['session.id'];
    if (typeof fromDomain === 'string' && fromDomain.length > 0) {
      return fromDomain;
    }
  }
  throw new Error('synthesize_program_spec requires a session id in payload.session_id, payload.sessionId, or payload.domain');
}

function domainFromPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const domain = payload.domain;
  if (!domain || typeof domain !== 'object' || Array.isArray(domain)) {
    throw new Error('synthesize_program_spec requires payload.domain from the engine domain snapshot');
  }
  return domain as Record<string, unknown>;
}

function stringDomainField(domain: Record<string, unknown>, path: string): string {
  const value = domainValue(domain, path);
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`missing string domain field: ${path}`);
  }
  return value;
}

function optionalStringDomainField(domain: Record<string, unknown>, path: string): string | undefined {
  const value = domainValue(domain, path);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseWiringManifestDomainField(domain: Record<string, unknown>): WiringManifest {
  const value = domainValue(domain, 'repo.wiring_manifest_json') ?? domainValue(domain, 'repo.wiring_manifest');
  if (typeof value === 'string') {
    return JSON.parse(value) as WiringManifest;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as WiringManifest;
  }
  throw new Error('existing-repo artifact planning requires repo.wiring_manifest_json');
}

function domainValue(domain: Record<string, unknown>, path: string): unknown {
  if (Object.prototype.hasOwnProperty.call(domain, path)) {
    return domain[path];
  }

  let current: unknown = domain;
  for (const segment of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
