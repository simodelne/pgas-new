import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dump, load } from 'js-yaml';
import { loadSpecWithPatterns } from '@simodelne/pgas-server/plugin.js';
import { renderTemplate } from '../pgas-new/template-renderer.js';

interface Stage {
  slug: string;
  is_bootstrap?: boolean;
  is_terminal?: boolean;
}

interface IntakeTransition {
  from: string;
  to: string;
  guard?: Record<string, unknown>;
  guard_field?: string;
}

interface Completion {
  final_stage: string;
  guard_field: string;
}

interface SynthesizedSpec {
  spec_yaml: string;
  mode_names: string[];
  sha256: string;
}

type MutableRecord = Record<string, unknown>;

const SKELETON_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../templates/pgas-new/program/spec-skeleton.yml.tmpl',
);

export function synthesizeProgramSpecFromDomain(domain: Record<string, unknown>): SynthesizedSpec {
  const slug = stringDomainField(domain, 'program.slug');
  const name = stringDomainField(domain, 'program.name');
  const purpose = stringDomainField(domain, 'intake.purpose');
  const entryChannel = stringDomainField(domain, 'intake.entry_channel');
  const stages = parseJsonDomainField<Stage[]>(domain, 'intake.stages_json');
  const transitions = parseJsonDomainField<IntakeTransition[]>(domain, 'intake.transitions_json');
  const delegation = parseJsonDomainField<Record<string, unknown>>(domain, 'intake.delegation_json');
  const completion = parseJsonDomainField<Completion>(domain, 'intake.completion_json');

  assertStages(stages);
  assertTransitions(transitions);
  assertCompletion(completion);

  const modeNames = stages.map((stage) => stage.slug);
  const [firstMode, middleMode, terminalMode] = modeNames as [string, string, string];
  if (completion.final_stage !== terminalMode) {
    throw new Error(`completion.final_stage must be ${terminalMode}; got ${completion.final_stage}`);
  }

  const renderedSkeleton = renderTemplate(readFileSync(SKELETON_PATH, 'utf8'), {
    NAME: name,
    SLUG: slug,
  });
  const spec = load(renderedSkeleton) as MutableRecord;

  spec.name = slug;
  spec.preamble = `Program: ${name}. ${purpose}\n\nThis spec was synthesized mechanically by pgas-new.`;
  spec.initial = firstMode;
  spec.terminal = [terminalMode];

  const sourceModes = recordField(spec, 'modes');
  const synthesizedModes: MutableRecord = {
    [firstMode]: transformMode(cloneRecord(sourceModes.start), {
      modeName: firstMode,
      channels: channelsForBootstrap(entryChannel),
      transitions: [],
    }),
    [middleMode]: transformMode(cloneRecord(sourceModes.working), {
      modeName: middleMode,
      channels: ['user_text', 'widget_output'],
      transitions: [],
    }),
    [terminalMode]: transformMode(cloneRecord(sourceModes.complete), {
      modeName: terminalMode,
      channels: ['widget_output'],
      transitions: [],
    }),
  };

  applyTransitions(synthesizedModes, transitions, completion, modeNames);
  spec.modes = synthesizedModes;

  spec.proceed_to = {
    begin_work: middleMode,
    example_action: terminalMode,
  };

  const startedField = `${firstMode}.started`;
  const resultField = `${middleMode}.result_json`;
  const itemsField = `${middleMode}.items_json`;
  const completionField = completion.guard_field;

  spec.projection = {
    [firstMode]: {
      include: [`inputs.${entryChannel}`, 'notebook.entries', 'notebook.pins', startedField],
      exclude: [],
    },
    [middleMode]: {
      include: [`inputs.${entryChannel}`, 'notebook.entries', 'notebook.pins', completionField, resultField, itemsField],
      exclude: [],
    },
    [terminalMode]: {
      include: [completionField, resultField, itemsField],
      exclude: [],
    },
  };

  spec.prompts = {
    [firstMode]: `Capture the initial request for ${name} and start the work.`,
    [middleMode]: `Perform the primary ${name} work.`,
    [terminalMode]: `Terminal mode after ${name} completion is confirmed.`,
  };

  spec.ingestion = {
    [entryChannel]: [`inputs.${entryChannel}`],
  };

  spec.channels = {
    ...recordField(spec, 'channels'),
    [entryChannel]: { direction: 'In', sync: 'Async' },
  };

  const actionMap = recordField(spec, 'action_map');
  const beginWork = recordField(actionMap, 'begin_work');
  beginWork.mutations = [{ op: 'MSet', path: startedField, value: true }];
  const exampleAction = recordField(actionMap, 'example_action');
  exampleAction.description = `Complete the synthesized ${middleMode} work using JSON-string scalar state.`;
  exampleAction.mutations = [
    { op: 'MSet', path: completionField, value: true },
    { op: 'MSet', path: resultField, value: '{"status":"ready","source":"synthesizer"}' },
    { op: 'MSet', path: itemsField, value: '["synthesized"]' },
  ];

  const schema = recordField(spec, 'schema');
  delete schema['work.started'];
  delete schema['work.example_ready'];
  delete schema['work.example_result_json'];
  delete schema['work.example_items_json'];
  schema[`inputs.${entryChannel}`] = 'string';
  schema[startedField] = 'boolean';
  schema[completionField] = 'boolean';
  schema[resultField] = 'string';
  schema[itemsField] = 'string';

  spec.guidance = guidanceFor(middleMode, delegation);

  const specYaml = dump(spec, { lineWidth: -1, noRefs: true, sortKeys: false });
  validateSynthesizedSpec(specYaml);

  return {
    spec_yaml: specYaml,
    mode_names: modeNames,
    sha256: createHash('sha256').update(specYaml).digest('hex'),
  };
}

function transformMode(mode: MutableRecord, options: {
  modeName: string;
  channels: string[];
  transitions: Array<{ target: string; guard?: Record<string, unknown> }>;
}): MutableRecord {
  return {
    ...mode,
    channels: options.channels,
    transitions: options.transitions,
  };
}

function applyTransitions(
  modes: MutableRecord,
  transitions: IntakeTransition[],
  completion: Completion,
  modeNames: string[],
): void {
  const modeNameSet = new Set(modeNames);
  for (const transition of transitions) {
    if (!modeNameSet.has(transition.from) || !modeNameSet.has(transition.to)) {
      throw new Error(`transition references undeclared mode: ${transition.from}->${transition.to}`);
    }
    const fromMode = recordField(modes, transition.from);
    const modeTransitions = Array.isArray(fromMode.transitions) ? fromMode.transitions : [];
    const guardField = transition.to === completion.final_stage ? completion.guard_field : transition.guard_field;
    modeTransitions.push({
      target: transition.to,
      guard: transition.guard ?? guardFromField(guardField),
    });
    fromMode.transitions = modeTransitions;
  }
}

function guardFromField(field: string | undefined): Record<string, unknown> {
  if (!field) {
    throw new Error('transition guard_field is required for synthesized transitions');
  }
  return { kind: 'FieldTruthy', path: field };
}

function guidanceFor(modeName: string, delegation: Record<string, unknown>): Record<string, string[]> {
  const guidance = [
    'Use the synthesized JSON-string scalar fields for structured handler results.',
  ];
  if (Object.keys(delegation).length > 0) {
    guidance.push(`delegation intake captured for this program: ${JSON.stringify(delegation)}.`);
  }
  return { [modeName]: guidance };
}

function channelsForBootstrap(entryChannel: string): string[] {
  return [...new Set([entryChannel, 'widget_output'])];
}

function validateSynthesizedSpec(specYaml: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'pgas-new-synth-'));
  try {
    const specPath = join(dir, 'specs.yml');
    writeFileSync(specPath, specYaml);
    loadSpecWithPatterns(specPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertStages(stages: Stage[]): void {
  if (!Array.isArray(stages)) {
    throw new Error('intake.stages_json must decode to an array');
  }
  if (stages.length !== 3) {
    throw new Error(`synthesizer expects 3 stages; got ${stages.length}`);
  }
  for (const stage of stages) {
    if (!stage || typeof stage.slug !== 'string' || stage.slug.length === 0) {
      throw new Error('each stage must declare a non-empty slug');
    }
  }
}

function assertTransitions(transitions: IntakeTransition[]): void {
  if (!Array.isArray(transitions)) {
    throw new Error('intake.transitions_json must decode to an array');
  }
  for (const transition of transitions) {
    if (
      !transition ||
      typeof transition.from !== 'string' ||
      transition.from.length === 0 ||
      typeof transition.to !== 'string' ||
      transition.to.length === 0
    ) {
      throw new Error('each transition must declare non-empty from and to fields');
    }
  }
}

function assertCompletion(completion: Completion): void {
  if (
    !completion ||
    typeof completion.final_stage !== 'string' ||
    completion.final_stage.length === 0 ||
    typeof completion.guard_field !== 'string' ||
    completion.guard_field.length === 0
  ) {
    throw new Error('intake.completion_json must decode to { final_stage, guard_field }');
  }
}

function stringDomainField(domain: Record<string, unknown>, path: string): string {
  const value = domainValue(domain, path);
  if (typeof value !== 'string') {
    throw new Error(`missing string domain field: ${path}`);
  }
  return value;
}

function parseJsonDomainField<T>(domain: Record<string, unknown>, path: string): T {
  const value = domainValue(domain, path);
  if (typeof value !== 'string') {
    throw new Error(`missing JSON-string domain field: ${path}`);
  }
  return JSON.parse(value) as T;
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

function recordField(parent: MutableRecord, key: string): MutableRecord {
  const value = parent[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`expected object field: ${key}`);
  }
  return value as MutableRecord;
}

function cloneRecord(value: unknown): MutableRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected object to clone');
  }
  return JSON.parse(JSON.stringify(value)) as MutableRecord;
}
