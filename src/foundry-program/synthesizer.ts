import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dump, load } from 'js-yaml';
import { loadSpecWithPatterns } from '@simodelne/pgas-server/plugin.js';
import { renderTemplate } from '../pgas-new/template-renderer.js';
import type { WiringIntegration } from '../pgas-new/wiring-manifest.js';
import type { SynthesisContext } from './synthesizer-store.js';
import {
  classifyStagesForDomain,
  type ClassifiedStage,
  type StageArchetype,
} from './stage-classifier.js';

interface Stage {
  slug: string;
  is_bootstrap?: boolean;
  is_terminal?: boolean;
  domain_spec?: StageDomainSpec;
}

type StageInput = Stage | string;

interface StageDomainSpec {
  reads: string[];
  produces: Record<string, unknown>;
  rules: string[];
  invariants: string[];
}

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
  synthesis_context: SynthesisContext;
}

export interface SynthesizeProgramSpecOptions {
  targetKind?: 'standalone_repo' | 'existing_repo';
  integrations?: WiringIntegration[];
}

type MutableRecord = Record<string, unknown>;

interface TransitionAction {
  name: string;
  source: string;
  target: string;
  guardField?: string;
  archetype: StageArchetype;
  adapter_kind?: 'in_memory_mock' | 'repo_integration';
  integration_name?: string;
  integration_import?: string;
  integration_method?: string;
  integration_gap?: boolean;
  audit_note?: string;
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

export function synthesizeProgramSpecFromDomain(
  domain: Record<string, unknown>,
  options: SynthesizeProgramSpecOptions = {},
): SynthesizedSpec {
  const slug = stringDomainField(domain, 'program.slug');
  const name = stringDomainField(domain, 'program.name');
  const purpose = stringDomainField(domain, 'intake.purpose');
  const entryChannel = stringDomainField(domain, 'intake.entry_channel');
  const initialEntryPath = initialInputPath(entryChannel);
  const stages = normalizeStages(parseJsonDomainField<StageInput[]>(domain, 'intake.stages_json'));
  let transitions = parseJsonDomainField<IntakeTransition[]>(domain, 'intake.transitions_json');
  const delegation = parseJsonDomainField<Record<string, unknown>>(domain, 'intake.delegation_json');
  const completion = parseJsonDomainField<Completion>(domain, 'intake.completion_json');

  assertStages(stages);
  assertTransitions(transitions);
  assertCompletion(completion);
  transitions = refreshStaleTransitionsForStages(stages, transitions, completion) ?? transitions;
  const stageClassification = bindRepoIntegrations(
    classifyStagesForDomain({
    ...domain,
    'intake.stages_json': JSON.stringify(stages),
    }),
    options,
  );
  const stageClassificationBySlug = new Map(stageClassification.map((stage) => [stage.slug, stage]));
  const stageDomainSpecBySlug = new Map(
    stages
      .filter((stage): stage is Stage & { domain_spec: StageDomainSpec } => !!stage.domain_spec)
      .map((stage) => [stage.slug, stage.domain_spec]),
  );

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
  spec.features = unique([...(Array.isArray(spec.features) ? spec.features as string[] : []), 'reactions']);

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
  const accumulatedOutputFieldsBefore = (modeName: string): string[] => {
    const modeIndex = modeNames.indexOf(modeName);
    if (modeIndex < 0) {
      return [];
    }
    return intermediateModes
      .filter((candidate) => modeNames.indexOf(candidate) < modeIndex)
      .flatMap((candidate) => outputProjectionFields(candidate, stageClassificationBySlug));
  };

  const projection: MutableRecord = {
    [firstMode]: {
      include: unique([`inputs.${entryChannel}`, initialEntryPath, 'notebook.entries', 'notebook.pins', startedField, ...(guardFieldsByMode.get(firstMode) ?? [])]),
      exclude: [],
    },
  };
  for (const modeName of terminalModes) {
    projection[modeName] = {
      include: unique([initialEntryPath, ...intermediateGuardFields, ...intermediateJsonFields]),
      exclude: [],
    };
  }
  for (const modeName of intermediateModes) {
    projection[modeName] = {
      include: unique([
        `inputs.${entryChannel}`,
        initialEntryPath,
        'notebook.entries',
        'notebook.pins',
        ...(guardFieldsByMode.get(modeName) ?? []),
        ...accumulatedOutputFieldsBefore(modeName),
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
    prompts[modeName] = promptForStage(modeName, name, stageDomainSpecBySlug.get(modeName));
  }
  spec.prompts = prompts;

  spec.ingestion = {
    [entryChannel]: [`inputs.${entryChannel}`],
    system_mode_entry: ['inputs.mode_entry'],
  };

  spec.reactions = {
    capture_initial_entry_input: {
      event: 'AfterIngestion',
      watch: [`inputs.${entryChannel}`],
      write_scope: [initialEntryPath],
    },
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
    actionMap[action.name] = actionMapEntryFor(action, firstMode, stageDomainSpecBySlug.get(action.source));
  }

  const schema = recordField(spec, 'schema');
  delete schema['work.started'];
  delete schema['work.example_ready'];
  delete schema['work.example_result_json'];
  delete schema['work.example_items_json'];
  schema[`inputs.${entryChannel}`] = 'string';
  schema[initialEntryPath] = 'string';
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

  spec.guidance = guidanceFor(intermediateModes, delegation, stageDomainSpecBySlug);

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
    contracts_ts: renderContractsSource(stages, stageClassification, transitionActions),
    handlers_ts: renderHandlersSource(transitionActions, {
      includeReactionHandlers: true,
      resolverImport: './handlers/_resolver.js',
      contractsImport: './contracts.js',
      stageImportPrefix: './stages',
      initialEntryPath,
      entryPath: `inputs.${entryChannel}`,
    }),
    handlers_index_ts: renderHandlersSource(transitionActions, {
      includeReactionHandlers: false,
      resolverImport: './_resolver.js',
      contractsImport: '../contracts.js',
      stageImportPrefix: '../stages',
      initialEntryPath,
      entryPath: `inputs.${entryChannel}`,
    }),
    tools_ts: renderToolsSource(slug, transitionActions),
    smoke_test_ts: renderSmokeTestSource(slug, name, entryChannel, stages, transitionActions, completion),
    stage_classification: stageClassification,
    body_stage_slugs: bodyStageSlugs,
    synthesis_context: {
      program_slug: slug,
      program_name: name,
      purpose,
      entry_channel: entryChannel,
      stages,
      transitions,
      delegation,
      completion,
    },
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
      ...(classification?.integration_name ? { integration_name: classification.integration_name } : {}),
      ...(classification?.integration_import ? { integration_import: classification.integration_import } : {}),
      ...(classification?.integration_method ? { integration_method: classification.integration_method } : {}),
      ...(classification?.integration_gap ? { integration_gap: true } : {}),
      ...(classification?.audit_note ? { audit_note: classification.audit_note } : {}),
    };
  });
}

function bindRepoIntegrations(
  stages: ClassifiedStage[],
  options: SynthesizeProgramSpecOptions,
): ClassifiedStage[] {
  const targetKind = options.targetKind ?? 'standalone_repo';
  const integrations = options.integrations ?? [];
  return stages.map((stage) => {
    if (stage.archetype !== 'external-adapter') {
      return stage;
    }
    if (targetKind !== 'existing_repo') {
      return { ...stage, adapter_kind: 'in_memory_mock' };
    }
    const matched = matchIntegration(stage, integrations);
    if (matched) {
      const method = matched.methods[0] as string;
      return {
        ...stage,
        adapter_kind: 'repo_integration',
        integration_name: matched.name,
        integration_import: matched.import,
        integration_method: method,
        rationale: `${stage.rationale} Existing-repo manifest declares integration ${matched.name}; generated adapter must call ${matched.import}.${method}.`,
      };
    }
    return {
      ...stage,
      adapter_kind: 'in_memory_mock',
      integration_gap: true,
      audit_note: `existing repo external-adapter stage ${stage.slug} has no matching integration declared in .pgas/wiring.yml`,
      rationale: `${stage.rationale} No matching existing-repo integration was declared, so this remains an explicit in-memory mock gap.`,
    };
  });
}

function matchIntegration(stage: ClassifiedStage, integrations: WiringIntegration[]): WiringIntegration | undefined {
  const tokens = new Set(
    [stage.slug, stage.rationale]
      .join(' ')
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter(Boolean),
  );
  return integrations.find((integration) => tokens.has(integration.name.toLowerCase()));
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

function actionMapEntryFor(action: TransitionAction, firstMode: string, domainSpec?: StageDomainSpec): MutableRecord {
  const isBootstrap = action.source === firstMode;
  const isResultPathStage = !isBootstrap && action.archetype !== 'llm-reasoning';
  const domainSpecDescription = domainSpec
    ? ` Author-provided domain spec for ${action.source}: ${JSON.stringify(domainSpec)}`
    : '';
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
        ? `Record runtime LLM reasoning output for ${action.source} and advance exactly one hop to ${action.target}.${domainSpecDescription}`
        : `Run deterministic ${action.archetype} wrapper for ${action.source} and advance exactly one hop to ${action.target}.${domainSpecDescription}`,
    ...(isBootstrap || isResultPathStage ? {} : {
      arg_descriptions: {
        result_json: `JSON string result for the ${action.source} LLM reasoning stage.${domainSpecDescription}`,
        items_json: `JSON string array of item ids or summaries produced by the ${action.source} LLM reasoning stage.${domainSpecDescription}`,
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
    initialEntryPath: string;
    entryPath: string;
  },
): string {
  const stageActions = transitionActions.filter((action) => action.name !== 'begin_work');
  const bodyActions = unique(stageActions.filter((action) => action.archetype !== 'llm-reasoning').map((action) => action.source));
  const stageImports = bodyActions
    .map((stage) => `import { runStage as run${toPascalCase(stage)} } from ${tsString(`${options.stageImportPrefix}/${stage}.js`)};`)
    .join('\n');
  const contractsImport = bodyActions.length > 0
    ? `import { createStageRuntime, normalizeStageOutput, resolveStageInput } from ${tsString(options.contractsImport)};`
    : '';
  const sessionControlHandlers = [
    'session_new',
    'session_abort_current',
    'session_status',
    'session_history',
    'session_resume',
    'session_help',
  ].map((action) => `  async ${action}(payload) {
    return {
      kind: 'session_control',
      control: ${tsString(action)},
      payload,
    };
  },`).join('\n\n');
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
    return normalizeStageOutput(output, ${tsString(action.source)}, ${tsString(action.archetype)}, ${action.adapter_kind ? tsString(action.adapter_kind) : 'undefined'});
  },`;
  }).join('\n\n');
  const reactionImport = options.includeReactionHandlers ? 'ReactionHandler, ' : '';
  const reactionExport = options.includeReactionHandlers
    ? `\n\nexport const reactionHandlers: Map<string, ReactionHandler> = new Map([\n  ['capture_initial_entry_input', (snapshot) => {\n    if (typeof snapshot.get(${tsString(options.initialEntryPath)}) === 'string') {\n      return undefined;\n    }\n    const current = snapshot.get(${tsString(options.entryPath)});\n    return typeof current === 'string'\n      ? { mutations: [{ op: 'MSet' as const, path: ${tsString(options.initialEntryPath)}, value: current }] }\n      : undefined;\n  }],\n]);`
    : '';

  return `import type { ${reactionImport}ToolHandler } from '@simodelne/pgas-server/plugin.js';
import { resolveDomainValue, type HandlerPayload } from ${tsString(options.resolverImport)};
${contractsImport}
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
  },

${sessionControlHandlers}${actionHandlers ? `\n\n${actionHandlers}` : ''}
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

function renderContractsSource(
  stages: Stage[],
  stageClassification: ClassifiedStage[],
  transitionActions: TransitionAction[],
): string {
  const classified = JSON.stringify(stageClassification, null, 2);
  const domainSpecs = JSON.stringify(domainSpecsByStage(stages), null, 2);
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
        integration_name: action.integration_name,
        integration_import: action.integration_import,
        integration_method: action.integration_method,
        integration_gap: action.integration_gap,
        audit_note: action.audit_note,
      })),
    null,
    2,
  );

  return `import { createHash } from 'node:crypto';
import type { HandlerPayload } from './handlers/_resolver.js';

export type StageArchetype = 'pure-compute' | 'llm-reasoning' | 'external-adapter';

export interface StageDomainSpec {
  reads: readonly string[];
  produces: Record<string, unknown>;
  rules: readonly string[];
  invariants: readonly string[];
}

export interface StageInput {
  stage: string;
  payload: HandlerPayload;
  domain: Record<string, unknown>;
  domain_spec: StageDomainSpec;
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
  adapter_kind?: 'in_memory_mock' | 'repo_integration';
}

export const stageClassification = ${classified} as const;

export const stageDomainSpecs = ${domainSpecs} as Record<string, StageDomainSpec>;

export const stageActionContracts = ${actionContracts} as const;

export function resolveStageInput(payload: HandlerPayload, stage: string): StageInput {
  const domain = payload.domain && typeof payload.domain === 'object' && !Array.isArray(payload.domain)
    ? payload.domain as Record<string, unknown>
    : {};
  return { stage, payload, domain, domain_spec: stageDomainSpecs[stage] ?? emptyStageDomainSpec };
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

export function normalizeStageOutput(
  output: unknown,
  stage: string,
  archetype: StageArchetype,
  adapterKind?: StageOutput['adapter_kind'],
): StageOutput {
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
    normalized.adapter_kind = adapterKind ?? 'in_memory_mock';
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

const emptyStageDomainSpec: StageDomainSpec = {
  reads: [],
  produces: {},
  rules: [],
  invariants: [],
};
`;
}

function renderSmokeTestSource(
  slug: string,
  name: string,
  entryChannel: string,
  stages: Stage[],
  transitionActions: TransitionAction[],
  completion: Completion,
): string {
  const pathActions = actionsForCompletionPath(transitionActions, completion.final_stage);
  const initialTrigger = smokeInitialTriggerExpression(stages, entryChannel);
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
    .map((action) => `      expect(serialized).toContain(${tsString(action.adapter_kind ?? 'in_memory_mock')});`)
    .join('\n');

  return `import { describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarnessAuthorResponse } from '@simodelne/pgas-server/testing.js';
import { create${toPascalCase(slug)}ProgramEntry } from '../src/programs/${slug}/registration.js';

describe('generated program smoke', () => {
  it('runs ${name} through the deterministic completion path without stub output', async () => {
    const harness = await createTestHarness(create${toPascalCase(slug)}ProgramEntry(), {
      programName: ${tsString(slug)},
      defaultChannel: ${tsString(entryChannel)},
      authorResponses: [
${responses}
      ],
    });

    try {
      await harness.trigger(${initialTrigger});
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

function smokeInitialTriggerExpression(stages: Stage[], entryChannel: string): string {
  const initialRoot = initialInputPath(entryChannel);
  const initialPrefix = `${initialRoot}.`;
  const request: MutableRecord = {};
  for (const readPath of unique(stages.flatMap((stage) => stage.domain_spec?.reads ?? []))) {
    if (!readPath.startsWith(initialPrefix)) {
      continue;
    }
    const fieldPath = readPath.slice(initialPrefix.length).split('.').filter(Boolean);
    if (fieldPath.length === 0) {
      continue;
    }
    setNestedSmokeValue(request, fieldPath);
  }

  if (Object.keys(request).length === 0) {
    return tsString('start generated smoke');
  }
  return `JSON.stringify(${JSON.stringify(request, null, 2)})`;
}

function setNestedSmokeValue(target: MutableRecord, fieldPath: string[]): void {
  let cursor: MutableRecord = target;
  for (let index = 0; index < fieldPath.length; index += 1) {
    const field = fieldPath[index] as string;
    const isLeaf = index === fieldPath.length - 1;
    if (isLeaf) {
      if (!(field in cursor)) {
        cursor[field] = sampleSmokeValue(fieldPath);
      }
      return;
    }
    const existing = cursor[field];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      cursor[field] = {};
    }
    cursor = cursor[field] as MutableRecord;
  }
}

function sampleSmokeValue(fieldPath: string[]): unknown {
  const field = (fieldPath.at(-1) ?? 'value').toLowerCase();
  if (/^(is|has|can|should)_/u.test(field) || /_(flag|enabled|active|approved|requested)$/u.test(field)) {
    return true;
  }
  if (/(cents|amount|total|price|usd|count|quantity|qty|seats|days|age|hours|minutes|score|pct|percent|rate|limit|cap|capacity|used|remaining)/u.test(field)) {
    return field.includes('cents') ? 12500 : 14;
  }
  if (field === 'items' || field.endsWith('_items') || field.endsWith('_list')) {
    return ['sample-item'];
  }
  if (field.includes('email')) {
    return 'sample@example.com';
  }
  if (field.includes('date') && !field.includes('days')) {
    return '2026-06-29';
  }
  if (field.endsWith('_at') || field.includes('iso')) {
    return '2026-06-29T00:00:00.000Z';
  }
  if (field === 'id' || field.endsWith('_id')) {
    return `${field.replace(/_/gu, '-')}-sample`;
  }
  if (field.endsWith('_code') || field === 'code') {
    return 'sample_code';
  }
  return `${field.replace(/_/gu, '-')}-sample`;
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

function promptForStage(modeName: string, programName: string, domainSpec?: StageDomainSpec): string {
  const base = `Perform the ${modeName} stage for ${programName}.`;
  if (!domainSpec) return base;
  return [
    base,
    `Author-provided domain spec for ${modeName} is normative; implement it exactly and do not infer alternate business logic.`,
    JSON.stringify(domainSpec),
  ].join('\n');
}

function guidanceFor(
  modeNames: string[],
  delegation: Record<string, unknown>,
  stageDomainSpecBySlug: Map<string, StageDomainSpec>,
): Record<string, string[]> {
  const baseGuidance = [
    'Use the synthesized JSON-string scalar fields for structured handler results.',
  ];
  if (Object.keys(delegation).length > 0) {
    baseGuidance.push(`delegation intake captured for this program: ${JSON.stringify(delegation)}.`);
  }
  return Object.fromEntries(modeNames.map((modeName) => {
    const domainSpec = stageDomainSpecBySlug.get(modeName);
    const stageGuidance = domainSpec
      ? [
          ...baseGuidance,
          `Author-provided domain spec for ${modeName}: ${JSON.stringify(domainSpec)}.`,
          'Domain spec rules and invariants are mandatory; do not substitute guessed defaults.',
        ]
      : baseGuidance;
    return [modeName, stageGuidance];
  }));
}

function channelsForBootstrap(entryChannel: string): string[] {
  return unique([entryChannel, 'system_mode_entry', 'widget_output']);
}

function initialInputPath(entryChannel: string): string {
  return `inputs.initial_${safeIdentifier(entryChannel)}`;
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
    if (stage.domain_spec) {
      assertDomainSpec(stage.domain_spec, stage.slug);
    }
  }
}

function normalizeStages(stages: StageInput[]): Stage[] {
  if (!Array.isArray(stages)) {
    throw new Error('intake.stages_json must decode to an array');
  }
  return stages.map((stage, index) => {
    if (typeof stage !== 'string') {
      return {
        ...stage,
        ...(stage.domain_spec ? { domain_spec: normalizeDomainSpec(stage.domain_spec, stage.slug) } : {}),
      };
    }
    const slug = stage.trim();
    return {
      slug,
      ...(index === 0 ? { is_bootstrap: true } : {}),
      ...(index === stages.length - 1 ? { is_terminal: true } : {}),
    };
  });
}

function domainSpecsByStage(stages: Stage[]): Record<string, StageDomainSpec> {
  return Object.fromEntries(
    stages
      .filter((stage): stage is Stage & { domain_spec: StageDomainSpec } => !!stage.domain_spec)
      .map((stage) => [stage.slug, stage.domain_spec]),
  );
}

function normalizeDomainSpec(value: unknown, stageSlug: string): StageDomainSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`stage ${stageSlug} domain_spec must be an object`);
  }
  const record = value as Record<string, unknown>;
  const spec = {
    reads: stringArrayField(record, 'reads', stageSlug),
    produces: objectField(record, 'produces', stageSlug),
    rules: stringArrayField(record, 'rules', stageSlug),
    invariants: stringArrayField(record, 'invariants', stageSlug),
  };
  assertDomainSpec(spec, stageSlug);
  return spec;
}

function assertDomainSpec(value: StageDomainSpec, stageSlug: string): void {
  stringArrayField(value as unknown as Record<string, unknown>, 'reads', stageSlug);
  objectField(value as unknown as Record<string, unknown>, 'produces', stageSlug);
  stringArrayField(value as unknown as Record<string, unknown>, 'rules', stageSlug);
  stringArrayField(value as unknown as Record<string, unknown>, 'invariants', stageSlug);
}

function stringArrayField(record: Record<string, unknown>, field: keyof StageDomainSpec, stageSlug: string): string[] {
  const value = record[field];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === 'string' && item.trim().length > 0)
  ) {
    throw new Error(`stage ${stageSlug} domain_spec.${field} must be a non-empty string array`);
  }
  return value.map((item) => item.trim());
}

function objectField(record: Record<string, unknown>, field: keyof StageDomainSpec, stageSlug: string): Record<string, unknown> {
  const value = record[field];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`stage ${stageSlug} domain_spec.${field} must be an object`);
  }
  return value as Record<string, unknown>;
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
