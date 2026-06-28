import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dump, load } from 'js-yaml';
import { loadSpecWithPatterns } from '@simodelne/pgas-server/plugin.js';
import { renderTemplate } from '../pgas-new/template-renderer.js';
import {
  classifyStagesForDomain,
  type ClassifiedStage,
  type StageArchetype,
} from './stage-classifier.js';

interface Stage {
  slug: string;
  is_bootstrap?: boolean;
  is_terminal?: boolean;
}

type StageInput = Stage | string;

interface IntakeTransition {
  from: string;
  to: string;
  trigger?: string;
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
  contracts_ts: string;
  handlers_ts: string;
  handlers_index_ts: string;
  tools_ts: string;
  smoke_test_ts: string;
  stage_classification: ClassifiedStage[];
  body_stage_slugs: string[];
}

type MutableRecord = Record<string, unknown>;

interface TransitionAction {
  name: string;
  source: string;
  target: string;
  guardField?: string;
  archetype: StageArchetype;
  adapter_kind?: 'in_memory_mock';
}

interface PlannedTransitionAction {
  name: string;
  source: string;
  target: string;
  guardField?: string;
}

const SKELETON_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../templates/pgas-new/program/spec-skeleton.yml.tmpl',
);

export function synthesizeProgramSpecFromDomain(domain: Record<string, unknown>): SynthesizedSpec {
  const slug = stringDomainField(domain, 'program.slug');
  const name = stringDomainField(domain, 'program.name');
  const purpose = stringDomainField(domain, 'intake.purpose');
  const entryChannel = stringDomainField(domain, 'intake.entry_channel');
  const stages = normalizeStages(parseJsonDomainField<StageInput[]>(domain, 'intake.stages_json'));
  let transitions = parseJsonDomainField<IntakeTransition[]>(domain, 'intake.transitions_json');
  const delegation = parseJsonDomainField<Record<string, unknown>>(domain, 'intake.delegation_json');
  const completion = parseJsonDomainField<Completion>(domain, 'intake.completion_json');

  assertStages(stages);
  assertTransitions(transitions);
  assertCompletion(completion);
  transitions = refreshStaleTransitionsForStages(stages, transitions, completion) ?? transitions;
  const stageClassification = classifyStagesForDomain({
    ...domain,
    'intake.stages_json': JSON.stringify(stages),
  });
  const stageClassificationBySlug = new Map(stageClassification.map((stage) => [stage.slug, stage]));

  const modeNames = stages.map((stage) => stage.slug);
  const firstMode = modeNames[0] as string;
  const modeNameSet = new Set(modeNames);
  if (!modeNameSet.has(completion.final_stage)) {
    throw new Error(`completion.final_stage must reference a named stage; got ${completion.final_stage}`);
  }
  const outgoingModes = new Set(transitions.map((transition) => transition.from));
  const terminalModes = modeNames.filter((modeName) => !outgoingModes.has(modeName));
  if (terminalModes.length === 0) {
    throw new Error('synthesized topology must declare at least one terminal stage with no outgoing transitions');
  }
  if (!terminalModes.includes(completion.final_stage)) {
    throw new Error(`completion.final_stage must be terminal (no outgoing transitions); got ${completion.final_stage}`);
  }
  assertCompletionTransition(transitions, completion);
  const terminalModeSet = new Set(terminalModes);
  const intermediateModes = modeNames.filter((modeName) => modeName !== firstMode && !terminalModeSet.has(modeName));
  const transitionActions = decorateTransitionActions(
    planTransitionActions(transitions, completion, firstMode),
    stageClassificationBySlug,
  );
  const transitionActionsBySource = actionsBySourceMode(transitionActions);
  const firstWorkMode = transitionActions.find((transition) => transition.source === firstMode)?.target ?? intermediateModes[0];

  const renderedSkeleton = renderTemplate(readFileSync(SKELETON_PATH, 'utf8'), {
    NAME: name,
    SLUG: slug,
  });
  const spec = load(renderedSkeleton) as MutableRecord;

  spec.name = slug;
  spec.preamble = `Program: ${name}. ${purpose}\n\nThis spec was synthesized mechanically by pgas-new.`;
  spec.initial = firstMode;
  spec.terminal = terminalModes;

  const sourceModes = recordField(spec, 'modes');
  const synthesizedModes: MutableRecord = {};
  for (const modeName of modeNames) {
    if (terminalModeSet.has(modeName)) {
      synthesizedModes[modeName] = transformMode(cloneRecord(sourceModes.complete), {
        channels: ['widget_output'],
        transitions: [],
      });
    } else if (modeName === firstMode) {
      synthesizedModes[modeName] = transformMode(cloneRecord(sourceModes.start), {
        channels: channelsForBootstrap(entryChannel),
        transitions: [],
      });
    } else {
      synthesizedModes[modeName] = transformMode(cloneRecord(sourceModes.working), {
        channels: unique([entryChannel, 'widget_output']),
        transitions: [],
      });
    }
  }

  applyTransitions(synthesizedModes, transitionActions, modeNames);
  applyModeVocabularies(synthesizedModes, transitionActionsBySource, terminalModeSet);
  applyStageOutputChannels(synthesizedModes, transitionActions);
  spec.modes = synthesizedModes;

  spec.proceed_to = Object.fromEntries(transitionActions.map((action) => [action.name, action.target]));

  const startedField = `${firstMode}.started`;
  const guardFieldsByMode = guardFieldsBySourceMode(transitionActions);
  const intermediateJsonFields = intermediateModes.flatMap((modeName) => outputProjectionFields(modeName, stageClassificationBySlug));
  const intermediateGuardFields = unique(
    intermediateModes.flatMap((modeName) => guardFieldsByMode.get(modeName) ?? []),
  );

  const projection: MutableRecord = {
    [firstMode]: {
      include: unique([`inputs.${entryChannel}`, 'notebook.entries', 'notebook.pins', startedField, ...(guardFieldsByMode.get(firstMode) ?? [])]),
      exclude: [],
    },
  };
  for (const modeName of terminalModes) {
    projection[modeName] = {
      include: unique([...intermediateGuardFields, ...intermediateJsonFields]),
      exclude: [],
    };
  }
  for (const modeName of intermediateModes) {
    projection[modeName] = {
      include: unique([
        `inputs.${entryChannel}`,
        'notebook.entries',
        'notebook.pins',
        ...(guardFieldsByMode.get(modeName) ?? []),
        ...outputProjectionFields(modeName, stageClassificationBySlug),
      ]),
      exclude: [],
    };
  }
  spec.projection = projection;

  const prompts: MutableRecord = {
    [firstMode]: `Capture the initial request for ${name} and start the work.`,
  };
  for (const modeName of terminalModes) {
    prompts[modeName] = modeName === completion.final_stage
      ? `Terminal mode after ${name} completion is confirmed.`
      : `Terminal sink mode after ${name} cannot progress further.`;
  }
  for (const modeName of intermediateModes) {
    prompts[modeName] = `Perform the ${modeName} stage for ${name}.`;
  }
  spec.prompts = prompts;

  spec.ingestion = {
    [entryChannel]: [`inputs.${entryChannel}`],
    system_mode_entry: ['inputs.mode_entry'],
  };

  spec.channels = {
    ...recordField(spec, 'channels'),
    [entryChannel]: { direction: 'In', sync: 'Async' },
    stage_output: { direction: 'Out', sync: 'Sync' },
  };

  const actionMap = recordField(spec, 'action_map');
  const placeholderActionName = ['example', 'action'].join('_');
  delete actionMap[placeholderActionName];
  if (!transitionActions.some((action) => action.name === 'begin_work')) {
    delete actionMap.begin_work;
  }
  for (const action of transitionActions) {
    actionMap[action.name] = actionMapEntryFor(action, firstMode);
  }

  const schema = recordField(spec, 'schema');
  delete schema['work.started'];
  delete schema['work.example_ready'];
  delete schema['work.example_result_json'];
  delete schema['work.example_items_json'];
  schema[`inputs.${entryChannel}`] = 'string';
  schema[startedField] = 'boolean';
  for (const field of unique([...guardFieldsByMode.values()].flat())) {
    schema[field] = 'boolean';
  }
  for (const modeName of intermediateModes) {
    const classification = stageClassificationBySlug.get(modeName);
    if (classification?.archetype === 'llm-reasoning') {
      schema[`${modeName}.result_json`] = 'string';
      schema[`${modeName}.items_json`] = 'string';
    } else {
      schema[`${modeName}.output`] = 'object';
      schema[`${modeName}.output.result_json`] = 'string';
      schema[`${modeName}.output.items_json`] = 'string';
      schema[`${modeName}.output.digest`] = 'string';
      if (classification?.archetype === 'external-adapter') {
        schema[`${modeName}.output.adapter_kind`] = 'string';
      }
    }
  }

  spec.guidance = guidanceFor(intermediateModes, delegation);

  const specYaml = dump(spec, { lineWidth: -1, noRefs: true, sortKeys: false });
  validateSynthesizedSpec(specYaml);
  const bodyStageSlugs = unique(
    transitionActions
      .filter((action) => action.name !== 'begin_work' && action.archetype !== 'llm-reasoning')
      .map((action) => action.source),
  );

  return {
    spec_yaml: specYaml,
    mode_names: modeNames,
    sha256: createHash('sha256').update(specYaml).digest('hex'),
    contracts_ts: renderContractsSource(stageClassification, transitionActions),
    handlers_ts: renderHandlersSource(transitionActions, {
      includeReactionHandlers: true,
      resolverImport: './handlers/_resolver.js',
      contractsImport: './contracts.js',
      stageImportPrefix: './stages',
    }),
    handlers_index_ts: renderHandlersSource(transitionActions, {
      includeReactionHandlers: false,
      resolverImport: './_resolver.js',
      contractsImport: '../contracts.js',
      stageImportPrefix: '../stages',
    }),
    tools_ts: renderToolsSource(slug, transitionActions),
    smoke_test_ts: renderSmokeTestSource(slug, name, transitionActions, completion),
    stage_classification: stageClassification,
    body_stage_slugs: bodyStageSlugs,
  };
}

export function refreshStaleTransitionsForStages(
  stagesInput: unknown[],
  transitionsInput: unknown[],
  completionInput: unknown,
): IntakeTransition[] | undefined {
  const stages = normalizeStages(stagesInput as StageInput[]);
  const transitions = transitionsInput as IntakeTransition[];
  const completion = completionInput as Completion;

  assertStages(stages);
  assertTransitions(transitions);
  assertCompletion(completion);

  const modeNames = stages.map((stage) => stage.slug);
  const finalMode = modeNames.at(-1);
  if (!finalMode || completion.final_stage !== finalMode) {
    return undefined;
  }

  const modeNameSet = new Set(modeNames);
  const hasStaleEndpoint = transitions.some(
    (transition) => !modeNameSet.has(transition.from) || !modeNameSet.has(transition.to),
  );
  const missingCompletionIncoming = !transitions.some((transition) => transition.to === completion.final_stage);
  if (transitions.length > 0 && !hasStaleEndpoint && !missingCompletionIncoming) {
    return undefined;
  }

  return modeNames.slice(0, -1).map((from, index) => {
    const to = modeNames[index + 1] as string;
    const transition: IntakeTransition = { from, to, trigger: 'auto' };
    if (to === completion.final_stage) {
      transition.guard_field = completion.guard_field;
    }
    return transition;
  });
}

function transformMode(mode: MutableRecord, options: {
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
  transitionActions: TransitionAction[],
  modeNames: string[],
): void {
  const modeNameSet = new Set(modeNames);
  for (const action of transitionActions) {
    if (!modeNameSet.has(action.source) || !modeNameSet.has(action.target)) {
      throw new Error(`transition references undeclared mode: ${action.source}->${action.target}`);
    }
    const fromMode = recordField(modes, action.source);
    const modeTransitions = Array.isArray(fromMode.transitions) ? fromMode.transitions : [];
    const guard = guardFromField(action.guardField);
    const emittedTransition: { target: string; guard?: Record<string, unknown> } = { target: action.target };
    if (guard) {
      emittedTransition.guard = guard;
    }
    modeTransitions.push(emittedTransition);
    fromMode.transitions = modeTransitions;
  }
}

function applyModeVocabularies(
  modes: MutableRecord,
  transitionActionsBySource: Map<string, TransitionAction[]>,
  terminalModeSet: Set<string>,
): void {
  for (const [modeName, actions] of transitionActionsBySource) {
    if (terminalModeSet.has(modeName)) continue;
    const mode = recordField(modes, modeName);
    mode.vocabulary = [
      ...actions.map((action) => action.name),
      'record_user_note',
      'session_new',
      'session_abort_current',
      'session_status',
      'session_history',
      'session_resume',
      'session_help',
    ];
  }
}

function applyStageOutputChannels(modes: MutableRecord, transitionActions: TransitionAction[]): void {
  for (const action of transitionActions) {
    if (action.name === 'begin_work' || action.archetype === 'llm-reasoning') {
      continue;
    }
    const mode = recordField(modes, action.source);
    const channels = Array.isArray(mode.channels) ? mode.channels as string[] : [];
    mode.channels = unique([...channels, 'stage_output']);
  }
}

function guardFieldsBySourceMode(transitionActions: TransitionAction[]): Map<string, string[]> {
  const fieldsByMode = new Map<string, string[]>();
  for (const transition of transitionActions) {
    const guardField = transition.guardField;
    if (!guardField) continue;
    fieldsByMode.set(transition.source, unique([...(fieldsByMode.get(transition.source) ?? []), guardField]));
  }
  return fieldsByMode;
}

function planTransitionActions(
  transitions: IntakeTransition[],
  completion: Completion,
  firstMode: string,
): PlannedTransitionAction[] {
  const grouped = new Map<string, IntakeTransition[]>();
  for (const transition of transitions) {
    grouped.set(transition.from, [...(grouped.get(transition.from) ?? []), transition]);
  }

  const usedActionNames = new Set<string>();
  const planned = new Map<IntakeTransition, PlannedTransitionAction>();

  for (const [source, siblingTransitions] of grouped) {
    const isBranch = siblingTransitions.length > 1;
    const usedGuardFields = new Set<string>();
    const completionGuard = siblingTransitions.some((sibling) => sibling.to === completion.final_stage)
      ? normalizeGuardField(completion.guard_field)
      : undefined;

    for (const transition of siblingTransitions) {
      const baseGuard = guardFieldForTransition(transition, completion);
      const preservesCompletionGuard = transition.to === completion.final_stage && baseGuard === completionGuard;
      const guardField = isBranch && (
        !baseGuard ||
        usedGuardFields.has(baseGuard) ||
        (!preservesCompletionGuard && baseGuard === completionGuard)
      )
        ? uniqueGuardField(`${source}.${safeIdentifier(transition.to)}_selected`, usedGuardFields)
        : baseGuard;
      if (guardField) {
        usedGuardFields.add(guardField);
      }

      planned.set(transition, {
        name: uniqueActionName(actionNameForTransition(transition, firstMode, isBranch), usedActionNames),
        source,
        target: transition.to,
        ...(guardField ? { guardField } : {}),
      });
    }
  }

  return transitions.map((transition) => {
    const action = planned.get(transition);
    if (!action) {
      throw new Error(`missing planned action for transition ${transition.from}->${transition.to}`);
    }
    return action;
  });
}

function decorateTransitionActions(
  actions: PlannedTransitionAction[],
  stageClassificationBySlug: Map<string, ClassifiedStage>,
): TransitionAction[] {
  return actions.map((action) => {
    const classification = stageClassificationBySlug.get(action.source);
    return {
      ...action,
      archetype: classification?.archetype ?? 'pure-compute',
      ...(classification?.adapter_kind ? { adapter_kind: classification.adapter_kind } : {}),
    };
  });
}

function actionsBySourceMode(actions: TransitionAction[]): Map<string, TransitionAction[]> {
  const actionsBySource = new Map<string, TransitionAction[]>();
  for (const action of actions) {
    actionsBySource.set(action.source, [...(actionsBySource.get(action.source) ?? []), action]);
  }
  return actionsBySource;
}

function outputProjectionFields(modeName: string, stageClassificationBySlug: Map<string, ClassifiedStage>): string[] {
  const classification = stageClassificationBySlug.get(modeName);
  return classification?.archetype === 'llm-reasoning'
    ? [`${modeName}.result_json`, `${modeName}.items_json`]
    : [`${modeName}.output`];
}

function actionMapEntryFor(action: TransitionAction, firstMode: string): MutableRecord {
  const isBootstrap = action.source === firstMode;
  const isResultPathStage = !isBootstrap && action.archetype !== 'llm-reasoning';
  const mutations = [
    ...(action.guardField ? [{ op: 'MSet', path: action.guardField, value: true }] : []),
    ...(isBootstrap || isResultPathStage ? [] : [
      { op: 'MSet', path: `${action.source}.result_json`, from_arg: 'result_json' },
      { op: 'MSet', path: `${action.source}.items_json`, from_arg: 'items_json' },
    ]),
  ];

  return {
    description: isBootstrap
      ? `Start ${action.source} and advance exactly one hop to ${action.target}.`
      : action.archetype === 'llm-reasoning'
        ? `Record runtime LLM reasoning output for ${action.source} and advance exactly one hop to ${action.target}.`
        : `Run deterministic ${action.archetype} wrapper for ${action.source} and advance exactly one hop to ${action.target}.`,
    ...(isBootstrap || isResultPathStage ? {} : {
      arg_descriptions: {
        result_json: `JSON string result for the ${action.source} LLM reasoning stage.`,
        items_json: `JSON string array of item ids or summaries produced by the ${action.source} LLM reasoning stage.`,
      },
    }),
    ...(isResultPathStage ? { result_path: `${action.source}.output` } : {}),
    mutations,
    channel: isResultPathStage ? 'stage_output' : 'widget_output',
  };
}

function actionNameForTransition(transition: IntakeTransition, firstMode: string, isBranch: boolean): string {
  if (transition.from === firstMode && !isBranch) {
    return 'begin_work';
  }
  if (isBranch) {
    return `advance_${safeIdentifier(transition.from)}_to_${safeIdentifier(transition.to)}`;
  }
  return `complete_${safeIdentifier(transition.from)}`;
}

function uniqueActionName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }

  let suffix = 2;
  while (used.has(`${base}_${suffix}`)) {
    suffix += 1;
  }
  const name = `${base}_${suffix}`;
  used.add(name);
  return name;
}

function uniqueGuardField(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }

  let suffix = 2;
  while (used.has(`${base}_${suffix}`)) {
    suffix += 1;
  }
  const field = `${base}_${suffix}`;
  used.add(field);
  return field;
}

function renderHandlersSource(
  transitionActions: TransitionAction[],
  options: {
    includeReactionHandlers: boolean;
    resolverImport: string;
    contractsImport: string;
    stageImportPrefix: string;
  },
): string {
  const stageActions = transitionActions.filter((action) => action.name !== 'begin_work');
  const bodyActions = unique(stageActions.filter((action) => action.archetype !== 'llm-reasoning').map((action) => action.source));
  const stageImports = bodyActions
    .map((stage) => `import { runStage as run${toPascalCase(stage)} } from ${tsString(`${options.stageImportPrefix}/${stage}.js`)};`)
    .join('\n');
  const actionHandlers = stageActions.map((action) => {
    if (action.archetype === 'llm-reasoning') {
      return `  async ${action.name}(payload) {
    const resultJson = resolveDomainValue<string>(payload as HandlerPayload, 'result_json', '{}');
    const itemsJson = resolveDomainValue<string>(payload as HandlerPayload, 'items_json', '[]');
    return {
      kind: 'llm_reasoning_stage_output',
      action: ${tsString(action.name)},
      stage: ${tsString(action.source)},
      target: ${tsString(action.target)},
      result_json: resultJson,
      items_json: itemsJson,
      payload,
    };
  },`;
    }

    return `  async ${action.name}(payload) {
    const output = await run${toPascalCase(action.source)}(
      resolveStageInput(payload as HandlerPayload, ${tsString(action.source)}),
      createStageRuntime(payload as HandlerPayload),
    );
    return normalizeStageOutput(output, ${tsString(action.source)}, ${tsString(action.archetype)});
  },`;
  }).join('\n\n');
  const reactionImport = options.includeReactionHandlers ? 'ReactionHandler, ' : '';
  const reactionExport = options.includeReactionHandlers
    ? `\n\n// The generated scaffold has no foundry-driven reactions by default. Consumer\n// programs can add reactions by populating this map.\nexport const reactionHandlers: Map<string, ReactionHandler> = new Map();`
    : '';

  return `import type { ${reactionImport}ToolHandler } from '@simodelne/pgas-server/plugin.js';
import { resolveDomainValue, type HandlerPayload } from ${tsString(options.resolverImport)};
import { createStageRuntime, normalizeStageOutput, resolveStageInput } from ${tsString(options.contractsImport)};
${stageImports ? `${stageImports}\n` : ''}

// Generated by pgas-new from the approved stage topology. Deterministic stage
// wrappers return values written through action_map.result_path; LLM reasoning
// stages keep the runtime model's tool-call arguments as their source of truth.

export const handlers: Record<string, ToolHandler> = {
  async begin_work(payload) {
    return {
      kind: 'work_started',
      payload,
    };
  },

  async record_user_note(payload) {
    const note = resolveDomainValue<string>(payload as HandlerPayload, 'note', '');
    return {
      kind: 'note_recorded',
      note,
    };
  }${actionHandlers ? `,\n\n${actionHandlers}` : ''}
};${reactionExport}
`;
}

function renderToolsSource(slug: string, transitionActions: TransitionAction[]): string {
  const stageActions = transitionActions.filter((action) => action.name !== 'begin_work');
  const metadata = stageActions.length === 0
    ? '{}'
    : `{
${stageActions.map((action) => `  ${action.name}: {
    mode: ${tsString(action.source)},
    target: ${tsString(action.target)},
    archetype: ${tsString(action.archetype)},
    guard_paths: [${action.guardField ? tsString(action.guardField) : ''}],
    output_path: ${tsString(action.archetype === 'llm-reasoning' ? `${action.source}.result_json` : `${action.source}.output`)},
    items_path: ${tsString(action.archetype === 'llm-reasoning' ? `${action.source}.items_json` : `${action.source}.output.items_json`)},
    description: ${tsString(`Generated stage action metadata for ${action.source}.`)},
  },`).join('\n')}\n}`;

  return `import type { ToolRegistry } from '@simodelne/pgas-server/plugin.js';

// Native stage actions are declared in specs.yml action_map. This metadata gives
// implementers one fillable local-tool slot per synthesized stage without adding
// extra invoke_tool_* actions to the engine topology.
export const stageActionTools = ${metadata} as const;

export function register${toPascalCase(slug)}Tools(_registry: ToolRegistry): void {
  // Stage actions are native action_map entries. Real service adapters belong
  // behind generated external-adapter stage bodies, not extra topology actions.
  void _registry;
}
`;
}

function renderContractsSource(stageClassification: ClassifiedStage[], transitionActions: TransitionAction[]): string {
  const classified = JSON.stringify(stageClassification, null, 2);
  const actionContracts = JSON.stringify(
    transitionActions
      .filter((action) => action.name !== 'begin_work')
      .map((action) => ({
        action: action.name,
        stage: action.source,
        target: action.target,
        archetype: action.archetype,
        output_path: action.archetype === 'llm-reasoning' ? `${action.source}.result_json` : `${action.source}.output`,
        guard_path: action.guardField,
        adapter_kind: action.adapter_kind,
      })),
    null,
    2,
  );

  return `import { createHash } from 'node:crypto';
import type { HandlerPayload } from './handlers/_resolver.js';

export type StageArchetype = 'pure-compute' | 'llm-reasoning' | 'external-adapter';

export interface StageInput {
  stage: string;
  payload: HandlerPayload;
  domain: Record<string, unknown>;
}

export interface StageRuntime {
  now(): string;
  random(): number;
  llm(prompt: string): Promise<string>;
}

export interface StageOutput {
  result_json: string;
  items_json: string;
  digest: string;
  adapter_kind?: 'in_memory_mock';
}

export const stageClassification = ${classified} as const;

export const stageActionContracts = ${actionContracts} as const;

export function resolveStageInput(payload: HandlerPayload, stage: string): StageInput {
  const domain = payload.domain && typeof payload.domain === 'object' && !Array.isArray(payload.domain)
    ? payload.domain as Record<string, unknown>
    : {};
  return { stage, payload, domain };
}

export function createStageRuntime(payload: HandlerPayload): StageRuntime {
  const runtime = payload.__stage_runtime;
  const fixedNow = runtime && typeof runtime === 'object' && !Array.isArray(runtime) && typeof (runtime as { now_iso?: unknown }).now_iso === 'string'
    ? (runtime as { now_iso: string }).now_iso
    : '1970-01-01T00:00:00.000Z';
  const fixedRandom = runtime && typeof runtime === 'object' && !Array.isArray(runtime) && typeof (runtime as { random?: unknown }).random === 'number'
    ? (runtime as { random: number }).random
    : 0.5;
  return {
    now: () => fixedNow,
    random: () => fixedRandom,
    llm: async () => {
      throw new Error('StageRuntime.llm is not available inside deterministic generated wrappers.');
    },
  };
}

export function normalizeStageOutput(output: unknown, stage: string, archetype: StageArchetype): StageOutput {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error(\`stage \${stage} returned a non-object output\`);
  }
  const candidate = output as Partial<StageOutput>;
  const resultJson = assertJsonString(candidate.result_json, \`\${stage}.result_json\`, 'object');
  const itemsJson = assertJsonString(candidate.items_json, \`\${stage}.items_json\`, 'array');
  const normalized: StageOutput = {
    result_json: resultJson,
    items_json: itemsJson,
    digest: digestStageOutput(resultJson, itemsJson),
  };
  if (archetype === 'external-adapter') {
    normalized.adapter_kind = 'in_memory_mock';
  }
  assertNoStubMarkers(normalized, stage);
  return normalized;
}

export function digestStageOutput(resultJson: string, itemsJson: string): string {
  return createHash('sha256').update(resultJson).update('\\n').update(itemsJson).digest('hex');
}

function assertJsonString(value: unknown, label: string, topLevel: 'object' | 'array'): string {
  if (typeof value !== 'string') {
    throw new Error(\`\${label} must be a JSON string\`);
  }
  const parsed = JSON.parse(value) as unknown;
  if (topLevel === 'array' ? !Array.isArray(parsed) : !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(\`\${label} must encode a JSON \${topLevel}\`);
  }
  return JSON.stringify(parsed);
}

function assertNoStubMarkers(output: StageOutput, stage: string): void {
  const text = JSON.stringify(output).toLowerCase();
  for (const marker of ['stage_action_stub', '"todo"', 'replace this stub', 'not implemented']) {
    if (text.includes(marker)) {
      throw new Error(\`stage \${stage} output contains stub marker: \${marker}\`);
    }
  }
}
`;
}

function renderSmokeTestSource(
  slug: string,
  name: string,
  transitionActions: TransitionAction[],
  completion: Completion,
): string {
  const pathActions = actionsForCompletionPath(transitionActions, completion.final_stage);
  const responses = pathActions.map((action) => {
    if (action.archetype === 'llm-reasoning') {
      return `        effect(${tsString(action.name)}, {
          result_json: JSON.stringify({ stage: ${tsString(action.source)}, status: 'reasoned' }),
          items_json: JSON.stringify([${tsString(`${action.source}-item`)}]),
        }),`;
    }
    return `        effect(${tsString(action.name)}, { __stage_runtime: { now_iso: '2026-06-28T00:00:00.000Z', random: 0.25 } }),`;
  }).join('\n');
  const externalAdapterAssertions = pathActions
    .filter((action) => action.archetype === 'external-adapter')
    .map((action) => `      expect(serialized).toContain(${tsString('in_memory_mock')});`)
    .join('\n');

  return `import { describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarnessAuthorResponse } from '@simodelne/pgas-server/testing.js';
import { create${toPascalCase(slug)}ProgramEntry } from '../src/programs/${slug}/registration.js';

describe('generated program smoke', () => {
  it('runs ${name} through the deterministic completion path without stub output', async () => {
    const harness = await createTestHarness(create${toPascalCase(slug)}ProgramEntry(), {
      programName: ${tsString(slug)},
      defaultChannel: 'user_text',
      authorResponses: [
${responses}
      ],
    });

    try {
      await harness.trigger('start generated smoke');
${pathActions.slice(1).map(() => "      await harness.trigger('continue generated smoke');").join('\n')}
      const snapshot = await harness.snapshot();
      expect(snapshot.mode).toBe(${tsString(completion.final_stage)});
      const serialized = JSON.stringify(snapshot.domain).toLowerCase();
      expect(serialized).not.toContain('stage_action_stub');
      expect(serialized).not.toContain('"todo"');
${externalAdapterAssertions ? `${externalAdapterAssertions}\n` : ''}    } finally {
      await harness.close();
    }
  });
});

function effect(name: string, payload: Record<string, unknown>): TestHarnessAuthorResponse {
  return { actions: [{ kind: 'EffectAction', name, channel: name === 'begin_work' ? 'widget_output' : 'stage_output', payload }] };
}
`;
}

function actionsForCompletionPath(actions: TransitionAction[], finalStage: string): TransitionAction[] {
  if (actions.length === 0) {
    return [];
  }

  const bySource = actionsBySourceMode(actions);
  const path: TransitionAction[] = [];
  let current = actions[0]?.source;
  const seen = new Set<string>();
  while (current && current !== finalStage && !seen.has(current)) {
    seen.add(current);
    const next = (bySource.get(current) ?? []).find((action) => reachesFinalStage(action.target, finalStage, bySource, new Set()));
    if (!next) break;
    path.push(next);
    current = next.target;
  }
  return path;
}

function reachesFinalStage(
  mode: string,
  finalStage: string,
  bySource: Map<string, TransitionAction[]>,
  seen: Set<string>,
): boolean {
  if (mode === finalStage) {
    return true;
  }
  if (seen.has(mode)) {
    return false;
  }
  seen.add(mode);
  return (bySource.get(mode) ?? []).some((action) => reachesFinalStage(action.target, finalStage, bySource, seen));
}

function safeIdentifier(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9_]+/gu, '_').replace(/^_+|_+$/gu, '');
  return normalized.length > 0 ? normalized : 'stage';
}

function tsString(value: string): string {
  return `'${value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'")}'`;
}

function guardFieldForTransition(transition: IntakeTransition, completion: Completion): string | undefined {
  return normalizeGuardField(transition.to === completion.final_stage ? completion.guard_field : transition.guard_field);
}

function guardFromField(field: string | undefined): Record<string, unknown> | undefined {
  const normalized = normalizeGuardField(field);
  if (!normalized) return undefined;
  return { kind: 'FieldTruthy', path: normalized };
}

function normalizeGuardField(field: string | undefined): string | undefined {
  if (typeof field !== 'string') return undefined;
  const trimmed = field.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function guidanceFor(modeNames: string[], delegation: Record<string, unknown>): Record<string, string[]> {
  const guidance = [
    'Use the synthesized JSON-string scalar fields for structured handler results.',
  ];
  if (Object.keys(delegation).length > 0) {
    guidance.push(`delegation intake captured for this program: ${JSON.stringify(delegation)}.`);
  }
  return Object.fromEntries(modeNames.map((modeName) => [modeName, guidance]));
}

function channelsForBootstrap(entryChannel: string): string[] {
  return unique([entryChannel, 'system_mode_entry', 'widget_output']);
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
  if (stages.length < 3) {
    throw new Error(`synthesizer expects at least 3 stages; got ${stages.length}`);
  }
  for (const stage of stages) {
    if (!stage || typeof stage.slug !== 'string' || stage.slug.length === 0) {
      throw new Error('each stage must declare a non-empty slug');
    }
  }
}

function normalizeStages(stages: StageInput[]): Stage[] {
  if (!Array.isArray(stages)) {
    throw new Error('intake.stages_json must decode to an array');
  }
  return stages.map((stage, index) => {
    if (typeof stage !== 'string') return stage;
    const slug = stage.trim();
    return {
      slug,
      ...(index === 0 ? { is_bootstrap: true } : {}),
      ...(index === stages.length - 1 ? { is_terminal: true } : {}),
    };
  });
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
      transition.to.length === 0 ||
      (transition.guard_field !== undefined && typeof transition.guard_field !== 'string')
    ) {
      throw new Error('each transition must declare non-empty from and to fields');
    }
  }
}

function assertCompletion(completion: Completion): void {
  if (
    !completion ||
    typeof completion.final_stage !== 'string' ||
    completion.final_stage.trim().length === 0 ||
    typeof completion.guard_field !== 'string' ||
    completion.guard_field.trim().length === 0
  ) {
    throw new Error('intake.completion_json must decode to { final_stage, guard_field }; completion.guard_field is required');
  }
}

function assertCompletionTransition(transitions: IntakeTransition[], completion: Completion): void {
  if (!transitions.some((transition) => transition.to === completion.final_stage)) {
    throw new Error(`completion.final_stage must have an incoming transition guarded by completion.guard_field; got ${completion.final_stage}`);
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

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function toPascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join('');
}
