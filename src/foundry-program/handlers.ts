import type { ToolHandler } from '@simodelne/pgas-server/plugin.js';

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
