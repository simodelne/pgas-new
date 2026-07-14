import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dump, load } from 'js-yaml';
import { loadSpecWithPatterns, type ReactionHandler, type ReactionResult } from '@simodelne/pgas-server/plugin.js';
import { renderTemplate } from '../pgas-new/template-renderer.js';
import type { WiringIntegration } from '../pgas-new/wiring-manifest.js';
import type { SynthesisContext, SynthesizedArtifact } from './synthesizer-store.js';
import { assertSynthesizableCapabilities } from './capability-registry.js';
import { parseAndNormalizeStagesJson } from './json-normalize.js';
import {
  classifyStagesForDomain,
  type ClassifiedStage,
  type StageArchetype,
} from './stage-classifier.js';
import {
  reasoningFieldSummary,
  runtimeTypeNameFor,
  type ReasoningStageContract,
} from './reasoning-contract.js';

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
  collection_lifecycle?: CollectionLifecycleDescriptor;
}

interface CollectionLifecycleDescriptor {
  version: number;
  name: string;
  item_label: string;
  storage: {
    items_path: string;
    event_path: string;
    violation_path: string;
  };
  item: {
    id_field: string;
    status_field: string;
    schema: Record<string, unknown>;
  };
  statuses: Array<{
    name: string;
    initial?: boolean;
    terminal?: boolean;
  }>;
  transitions: Array<{
    from: string;
    to: string;
    stage: string;
    action: string;
    managed_by: 'llm' | 'reaction';
    trigger?: string;
    guard_field?: string;
  }>;
  aggregate: {
    guard_field: string;
    terminal_statuses: string[];
    require_non_empty: boolean;
  };
}

export interface SynthesizedSpec {
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
  reasoningContracts?: Record<string, ReasoningStageContract>;
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

const PGAS_CHANNEL_ID_MAX_LENGTH = 64;
const COLLECTION_LIFECYCLE_EVENT_CHANNEL = 'lifecycle_event';
const COLLECTION_LIFECYCLE_EVENT_CLEAR_VALUE = '';

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
  const entryChannel = normalizePgasChannelId(stringDomainField(domain, 'intake.entry_channel'));
  const initialEntryPath = initialInputPath(entryChannel);
  const stages = normalizeStages(parseStagesDomainField(domain));
  let transitions = parseJsonDomainField<IntakeTransition[]>(domain, 'intake.transitions_json');
  const delegation = parseJsonDomainField<Record<string, unknown>>(domain, 'intake.delegation_json');
  let completion = parseJsonDomainField<Completion>(domain, 'intake.completion_json');
  const collectionLifecycle = normalizeCollectionLifecycleDescriptor(completion.collection_lifecycle);

  // #166 capability gate (uplift PR-1): safe-stop rather than silently emit an
  // inadequate linear scaffold when the program demands synthesis capabilities the
  // foundry does not yet have (per-item confirmation, child/research delegation,
  // document upload, rich frontend, DOCX/track-changes). No detectors fire for
  // today's linear / external-adapter programs, so this is a no-op for them and
  // golden byte-identity is preserved.
  assertSynthesizableCapabilities({ purpose, stages, delegation, completion });

  assertStages(stages);
  assertTransitions(transitions);
  assertCompletion(completion);
  if (collectionLifecycle) {
    assertCollectionLifecycleDescriptor(collectionLifecycle);
    completion = {
      ...completion,
      guard_field: collectionLifecycle.aggregate.guard_field,
      collection_lifecycle: collectionLifecycle,
    };
  }
  transitions = refreshStaleTransitionsForStages(stages, transitions, completion) ?? transitions;
  const stageClassification = bindRepoIntegrations(
    classifyStagesForDomain({
    ...domain,
    'intake.stages_json': JSON.stringify(stages),
    }),
    options,
  );
  const stageClassificationBySlug = new Map(stageClassification.map((stage) => [stage.slug, stage]));
  const reasoningContractsBySlug = new Map<string, ReasoningStageContract>(
    Object.entries(options.reasoningContracts ?? {}).filter(([slug]) =>
      stageClassificationBySlug.get(slug)?.archetype === 'llm-reasoning'),
  );
  const stageDomainSpecBySlug = new Map(
    stages
      .filter((stage): stage is Stage & { domain_spec: StageDomainSpec } => !!stage.domain_spec)
      .map((stage) => [stage.slug, stage.domain_spec]),
  );
  const flatMirrorStages = collectFlatMirrorStages(stages, stageClassificationBySlug);

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
  if (completion.collection_lifecycle) {
    applyCollectionLifecycleIntentModeWiring(synthesizedModes, completion.collection_lifecycle);
  }
  spec.modes = synthesizedModes;

  spec.proceed_to = Object.fromEntries(transitionActions.map((action) => [action.name, action.target]));

  const startedField = `${firstMode}.started`;
  const guardFieldsByMode = guardFieldsBySourceMode(transitionActions);
  const intermediateJsonFields = intermediateModes.flatMap((modeName) => outputProjectionFields(modeName, stageClassificationBySlug, reasoningContractsBySlug, flatMirrorStages));
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
      .flatMap((candidate) => outputProjectionFields(candidate, stageClassificationBySlug, reasoningContractsBySlug, flatMirrorStages));
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
        ...outputProjectionFields(modeName, stageClassificationBySlug, reasoningContractsBySlug, flatMirrorStages),
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
    prompts[modeName] = promptForStage(modeName, name, stageDomainSpecBySlug.get(modeName), reasoningContractsBySlug.get(modeName));
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
  applyStageOutputMirrorReactions(recordField(spec, 'reactions'), intermediateModes, flatMirrorStages);
  if (completion.collection_lifecycle) {
    applyCollectionLifecycleReactions(recordField(spec, 'reactions'), completion.collection_lifecycle);
  }

  spec.channels = {
    ...recordField(spec, 'channels'),
    [entryChannel]: { direction: 'In', sync: 'Async' },
    stage_output: { direction: 'Out', sync: 'Sync' },
  };
  if (completion.collection_lifecycle) {
    applyCollectionLifecycleIntentChannel(recordField(spec, 'channels'), completion.collection_lifecycle);
  }
  applyControlPlaneEntryChannel(spec, entryChannel);

  const actionMap = recordField(spec, 'action_map');
  const placeholderActionName = ['example', 'action'].join('_');
  delete actionMap[placeholderActionName];
  if (!transitionActions.some((action) => action.name === 'begin_work')) {
    delete actionMap.begin_work;
  }
  for (const action of transitionActions) {
    actionMap[action.name] = actionMapEntryFor(action, firstMode, stageDomainSpecBySlug.get(action.source), reasoningContractsBySlug.get(action.source));
  }
  if (completion.collection_lifecycle) {
    applyCollectionLifecycleIntentActions(actionMap, completion.collection_lifecycle);
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
      const reasoningContract = reasoningContractsBySlug.get(modeName);
      if (reasoningContract) {
        schema[`${modeName}.result`] = 'object';
        for (const field of reasoningContract.result_schema.fields) {
          schema[`${modeName}.result.${field.name}`] = runtimeTypeNameFor(field.type);
        }
      }
    } else {
      schema[`${modeName}.output`] = 'object';
      schema[`${modeName}.output.result_json`] = 'string';
      schema[`${modeName}.output.items_json`] = 'string';
      schema[`${modeName}.output.digest`] = 'string';
      if (classification?.archetype === 'external-adapter') {
        schema[`${modeName}.output.adapter_kind`] = 'string';
      }
      if (flatMirrorStages.has(modeName)) {
        schema[`${modeName}.result_json`] = 'string';
        schema[`${modeName}.items_json`] = 'string';
      }
    }
  }
  if (completion.collection_lifecycle) {
    applyCollectionLifecycleSchema(schema, completion.collection_lifecycle);
  }

  spec.guidance = guidanceFor(intermediateModes, delegation, stageDomainSpecBySlug, reasoningContractsBySlug);

  const specYaml = dump(spec, { lineWidth: -1, noRefs: true, sortKeys: false });
  validateSynthesizedSpec(specYaml);
  const bodyStageSlugs = nonTerminalStageSlugs(stages, completion);

  return {
    spec_yaml: specYaml,
    mode_names: modeNames,
    sha256: createHash('sha256').update(specYaml).digest('hex'),
    contracts_ts: renderContractsSource(stages, stageClassification, transitionActions, reasoningContractsBySlug),
    handlers_ts: renderHandlersSource(transitionActions, {
      includeReactionHandlers: true,
      resolverImport: './handlers/_resolver.js',
      contractsImport: './contracts.js',
      stageImportPrefix: './stages',
      initialEntryPath,
      entryPath: `inputs.${entryChannel}`,
      flatMirrorStages,
      collectionLifecycle: completion.collection_lifecycle,
    }, reasoningContractsBySlug),
    handlers_index_ts: renderHandlersSource(transitionActions, {
      includeReactionHandlers: false,
      resolverImport: './_resolver.js',
      contractsImport: '../contracts.js',
      stageImportPrefix: '../stages',
      initialEntryPath,
      entryPath: `inputs.${entryChannel}`,
      flatMirrorStages,
      collectionLifecycle: completion.collection_lifecycle,
    }, reasoningContractsBySlug),
    tools_ts: renderToolsSource(slug, transitionActions, reasoningContractsBySlug, completion.collection_lifecycle),
    smoke_test_ts: renderSmokeTestSource(slug, name, entryChannel, stages, transitionActions, completion, reasoningContractsBySlug),
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

/**
 * Deterministically re-runs spec synthesis from the stored synthesis context
 * with reasoning contracts woven in. Byte-identical to the original synthesis
 * wherever no contract applies (spec §6): the context holds every input
 * synthesizeProgramSpecFromDomain consumes, entry_channel is already
 * normalized, and normalizePgasChannelId is idempotent on its own output.
 */
export function resynthesizeWithReasoningContracts(
  artifact: SynthesizedArtifact,
  contracts: Record<string, ReasoningStageContract>,
  options: SynthesizeProgramSpecOptions = {},
): SynthesizedSpec {
  const context = artifact.synthesis_context;
  if (!context) {
    throw new Error('resynthesizeWithReasoningContracts requires artifact.synthesis_context');
  }
  return synthesizeProgramSpecFromDomain({
    'program.slug': context.program_slug,
    'program.name': context.program_name,
    'intake.purpose': context.purpose,
    'intake.entry_channel': context.entry_channel,
    'intake.stages_json': JSON.stringify(context.stages),
    'intake.transitions_json': JSON.stringify(context.transitions),
    'intake.delegation_json': JSON.stringify(context.delegation),
    'intake.completion_json': JSON.stringify(context.completion),
  }, { ...options, reasoningContracts: contracts });
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

function applyControlPlaneEntryChannel(spec: MutableRecord, entryChannel: string): void {
  const controls = recordField(recordField(spec, 'control_plane'), 'controls');
  const ask = recordField(controls, 'ask');
  const dispatch = ask.dispatch;
  if (!Array.isArray(dispatch)) {
    return;
  }
  for (const step of dispatch) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      continue;
    }
    const record = step as MutableRecord;
    if (record.op === 'trigger' && typeof record.channel === 'string') {
      record.channel = entryChannel;
    }
  }
}

// Demand-driven flat mirror: a pure-compute/external-adapter stage earns a
// flat `<stage>.result_json`/`<stage>.items_json` mirror of its nested
// `<stage>.output.*` record ONLY when some stage's domain_spec.reads
// references the flat path (`<stage>.result_json...` / `<stage>.items_json...`,
// not `<stage>.output....`). With no such reference the set is empty and the
// synthesized contract is byte-identical to the mirror-free output.
function collectFlatMirrorStages(
  stages: Stage[],
  stageClassificationBySlug: Map<string, ClassifiedStage>,
): Set<string> {
  const flatMirrorStages = new Set<string>();
  for (const readPath of stages.flatMap((stage) => stage.domain_spec?.reads ?? [])) {
    const [stageSlug, flatField] = readPath.split('.');
    if (!stageSlug || (flatField !== 'result_json' && flatField !== 'items_json')) {
      continue;
    }
    const archetype = stageClassificationBySlug.get(stageSlug)?.archetype;
    if (archetype !== undefined && archetype !== 'llm-reasoning') {
      flatMirrorStages.add(stageSlug);
    }
  }
  return flatMirrorStages;
}

function applyStageOutputMirrorReactions(
  reactions: MutableRecord,
  intermediateModes: string[],
  flatMirrorStages: ReadonlySet<string>,
): void {
  for (const modeName of intermediateModes) {
    if (!flatMirrorStages.has(modeName)) {
      continue;
    }
    reactions[stageOutputMirrorReactionName(modeName)] = {
      event: 'AfterRound',
      write_scope: [`${modeName}.result_json`, `${modeName}.items_json`],
    };
  }
}

function stageOutputMirrorReactionName(stage: string): string {
  return `mirror_${safeIdentifier(stage)}_output`;
}

function applyCollectionLifecycleReactions(
  reactions: MutableRecord,
  descriptor: CollectionLifecycleDescriptor,
): void {
  const hasLlmTransitions = collectionLifecycleLlmTransitions(descriptor).length > 0;
  if (hasLlmTransitions) {
    reactions[collectionLifecycleApplyReactionName(descriptor)] = {
      event: 'AfterRound',
      write_scope: [
        descriptor.storage.items_path,
        descriptor.storage.event_path,
        descriptor.storage.violation_path,
      ],
    };
  }
  reactions[collectionLifecycleReactionName(descriptor)] = {
    event: hasLlmTransitions ? 'AfterRound' : 'AfterMutation',
    ...(hasLlmTransitions ? {} : { watch: [descriptor.storage.items_path] }),
    write_scope: [descriptor.aggregate.guard_field],
  };
}

function applyCollectionLifecycleSchema(
  schema: MutableRecord,
  descriptor: CollectionLifecycleDescriptor,
): void {
  schema[descriptor.storage.items_path] = 'string';
  schema[descriptor.storage.event_path] = 'string';
  schema[descriptor.storage.violation_path] = 'string';
  schema[descriptor.aggregate.guard_field] = 'boolean';
}

function collectionLifecycleReactionName(descriptor: CollectionLifecycleDescriptor): string {
  return `compute_${safeIdentifier(descriptor.name)}_all_terminal`;
}

function collectionLifecycleApplyReactionName(descriptor: CollectionLifecycleDescriptor): string {
  return `apply_${safeIdentifier(descriptor.name)}_lifecycle_event`;
}

function collectionLifecycleLlmTransitions(
  descriptor: CollectionLifecycleDescriptor,
): CollectionLifecycleDescriptor['transitions'] {
  return descriptor.transitions.filter((transition) => transition.managed_by === 'llm');
}

function applyCollectionLifecycleIntentChannel(
  channels: MutableRecord,
  descriptor: CollectionLifecycleDescriptor,
): void {
  if (collectionLifecycleLlmTransitions(descriptor).length === 0) {
    return;
  }
  channels[COLLECTION_LIFECYCLE_EVENT_CHANNEL] = { direction: 'Out', sync: 'Sync' };
}

function applyCollectionLifecycleIntentModeWiring(
  modes: MutableRecord,
  descriptor: CollectionLifecycleDescriptor,
): void {
  const transitions = collectionLifecycleLlmTransitions(descriptor);
  if (transitions.length === 0) {
    return;
  }
  for (const transition of transitions) {
    const mode = recordField(modes, transition.stage);
    const vocabulary = Array.isArray(mode.vocabulary) ? mode.vocabulary as string[] : [];
    const channels = Array.isArray(mode.channels) ? mode.channels as string[] : [];
    mode.vocabulary = unique([...vocabulary, transition.action]);
    mode.channels = unique([...channels, COLLECTION_LIFECYCLE_EVENT_CHANNEL]);
  }
}

function applyCollectionLifecycleIntentActions(
  actionMap: MutableRecord,
  descriptor: CollectionLifecycleDescriptor,
): void {
  for (const transition of collectionLifecycleLlmTransitions(descriptor)) {
    if (Object.prototype.hasOwnProperty.call(actionMap, transition.action)) {
      throw new Error(`collection_lifecycle transition action collides with generated action_map: ${transition.action}`);
    }
    actionMap[transition.action] = {
      description: `Record a lifecycle intent for ${descriptor.item_label} status ${transition.to}.`,
      result_path: descriptor.storage.event_path,
      mutations: [],
      channel: COLLECTION_LIFECYCLE_EVENT_CHANNEL,
    };
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

function outputProjectionFields(
  modeName: string,
  stageClassificationBySlug: Map<string, ClassifiedStage>,
  reasoningContractsBySlug: Map<string, ReasoningStageContract>,
  flatMirrorStages: ReadonlySet<string>,
): string[] {
  const classification = stageClassificationBySlug.get(modeName);
  if (classification?.archetype !== 'llm-reasoning') {
    return flatMirrorStages.has(modeName)
      ? [`${modeName}.output`, `${modeName}.result_json`, `${modeName}.items_json`]
      : [`${modeName}.output`];
  }
  return reasoningContractsBySlug.has(modeName)
    ? [`${modeName}.result_json`, `${modeName}.items_json`, `${modeName}.result`]
    : [`${modeName}.result_json`, `${modeName}.items_json`];
}

function actionMapEntryFor(
  action: TransitionAction,
  firstMode: string,
  domainSpec?: StageDomainSpec,
  reasoningContract?: ReasoningStageContract,
): MutableRecord {
  const isBootstrap = action.source === firstMode;
  const isResultPathStage = !isBootstrap && action.archetype !== 'llm-reasoning';
  const contract = !isBootstrap && action.archetype === 'llm-reasoning' ? reasoningContract : undefined;
  const domainSpecDescription = domainSpec
    ? ` Author-provided domain spec for ${action.source}: ${JSON.stringify(domainSpec)}`
    : '';
  const mutations = [
    ...(action.guardField ? [{ op: 'MSet', path: action.guardField, value: true }] : []),
    ...(isBootstrap || isResultPathStage ? [] : [
      { op: 'MSet', path: `${action.source}.result_json`, from_arg: 'result_json' },
      { op: 'MSet', path: `${action.source}.items_json`, from_arg: 'items_json' },
      ...(contract ? contract.result_schema.fields.map((field) => ({
        op: 'MSet',
        path: `${action.source}.result.${field.name}`,
        from_arg: field.name,
      })) : []),
    ]),
  ];

  return {
    description: isBootstrap
      ? `Start ${action.source} and advance exactly one hop to ${action.target}.`
      : action.archetype === 'llm-reasoning'
        ? `Record runtime LLM reasoning output for ${action.source} and advance exactly one hop to ${action.target}.${domainSpecDescription}`
        : `Run deterministic ${action.archetype} wrapper for ${action.source} and advance exactly one hop to ${action.target}.${domainSpecDescription}`,
    ...(isBootstrap || isResultPathStage ? {} : {
      arg_descriptions: contract
        ? {
            result_json: `JSON string result for the ${action.source} LLM reasoning stage. Must encode a JSON object containing at least: ${contract.result_schema.fields.map(reasoningFieldSummary).join(', ')}. Additional keys are allowed.${domainSpecDescription}`,
            items_json: `JSON string array of item strings produced by the ${action.source} LLM reasoning stage. Must match the templates: ${contract.items_schema.templates.join(', ')}.${domainSpecDescription}`,
            ...Object.fromEntries(contract.result_schema.fields.map((field) => [
              field.name,
              `${field.description}${field.type === 'enum' ? ` One of: ${(field.enum_values ?? []).join(' | ')}.` : ''}${field.type === 'string_array' ? ' Provide the value as a JSON array string.' : ''}`,
            ])),
          }
        : {
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
    flatMirrorStages: ReadonlySet<string>;
    collectionLifecycle?: CollectionLifecycleDescriptor;
  },
  reasoningContractsBySlug: Map<string, ReasoningStageContract>,
): string {
  const beginWorkHandler = transitionActions.some((action) => action.name === 'begin_work')
    ? `  async begin_work(payload) {
    return {
      kind: 'work_started',
      payload,
    };
  },`
    : '';
  const stageActions = transitionActions.filter((action) => action.name !== 'begin_work');
  const lifecycleTransitions = options.collectionLifecycle
    ? collectionLifecycleLlmTransitions(options.collectionLifecycle)
    : [];
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
  const contractActionSources = new Set(stageActions
    .filter((action) => action.archetype === 'llm-reasoning' && reasoningContractsBySlug.has(action.source))
    .map((action) => action.source));
  const actionHandlers = stageActions.map((action) => {
    if (action.archetype === 'llm-reasoning') {
      const reasoningContract = reasoningContractsBySlug.get(action.source);
      if (reasoningContract) {
        const coreFieldNames = reasoningContract.result_schema.fields.map((field) => field.name);
        const fieldResolvers = coreFieldNames
          .map((name) => `      ${name}: resolveDomainValue<unknown>(payload as HandlerPayload, ${tsString(name)}, null),`)
          .join('\n');
        return `  async ${action.name}(payload) {
    const resultJson = resolveDomainValue<string>(payload as HandlerPayload, 'result_json', '{}');
    const itemsJson = resolveDomainValue<string>(payload as HandlerPayload, 'items_json', '[]');
    const fields = {
${fieldResolvers}
    };
    return {
      kind: 'llm_reasoning_stage_output',
      action: ${tsString(action.name)},
      stage: ${tsString(action.source)},
      target: ${tsString(action.target)},
      result_json: resultJson,
      items_json: itemsJson,
      fields,
      contract_conformant: reasoningOutputConformant(resultJson, fields, [${coreFieldNames.map(tsString).join(', ')}]),
      payload,
    };
  },`;
      }
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
  const lifecycleActionHandlers = lifecycleTransitions.map((transition) => `  async ${transition.action}(payload) {
    return collectionLifecycleIntentEvent(payload as HandlerPayload, ${tsString(transition.action)}, ${tsString(transition.to)}, ${tsString(transition.from)});
  },`).join('\n\n');
  const stageOutputMirrorReactionEntries = options.includeReactionHandlers
    ? bodyActions.filter((stage) => options.flatMirrorStages.has(stage)).map((stage) => `,
  [${tsString(stageOutputMirrorReactionName(stage))}, (snapshot) => mirrorStageOutput(snapshot, ${tsString(`${stage}.output`)}, ${tsString(`${stage}.result_json`)}, ${tsString(`${stage}.items_json`)})]`).join('')
    : '';
  const reactionImport = options.includeReactionHandlers
    ? `ReactionHandler, ${stageOutputMirrorReactionEntries ? 'ReactionResult, ' : ''}`
    : '';
  const reactionMapConstructor = stageOutputMirrorReactionEntries ? 'new Map<string, ReactionHandler>' : 'new Map';
  const lifecycleReactionEntries = options.includeReactionHandlers && options.collectionLifecycle
    ? renderCollectionLifecycleReactionEntry(options.collectionLifecycle)
    : '';
  const lifecycleIntentHelper = lifecycleTransitions.length > 0
    ? `

function collectionLifecycleIntentEvent(payload: HandlerPayload, action: string, to: string, from: string): string {
  const itemId = resolveDomainValue<string>(payload, 'item_id', '').trim();
  if (itemId.length === 0) {
    throw new Error(\`\${action} requires item_id\`);
  }
  return JSON.stringify({ item_id: itemId, action, to, from });
}`
    : '';
  const lifecycleReactionHelper = options.includeReactionHandlers && options.collectionLifecycle
    ? `\n\nfunction collectionLifecycleAllTerminal(\n  snapshot: ReadonlyMap<string, unknown>,\n  itemsPath: string,\n  statusField: string,\n  terminalStatuses: readonly string[],\n  requireNonEmpty: boolean,\n): boolean {\n  const raw = snapshot.get(itemsPath);\n  if (typeof raw !== 'string') {\n    return false;\n  }\n  let parsed: unknown;\n  try {\n    parsed = JSON.parse(raw) as unknown;\n  } catch {\n    return false;\n  }\n  if (!Array.isArray(parsed)) {\n    return false;\n  }\n  if (requireNonEmpty && parsed.length === 0) {\n    return false;\n  }\n  const terminal = new Set(terminalStatuses);\n  return parsed.every((item) => {\n    if (!item || typeof item !== 'object' || Array.isArray(item)) {\n      return false;\n    }\n    const status = (item as Record<string, unknown>)[statusField];\n    return typeof status === 'string' && terminal.has(status);\n  });\n}${lifecycleTransitions.length > 0 ? renderCollectionLifecycleApplyHelper() : ''}`
    : '';
  const reactionExport = options.includeReactionHandlers
    ? `\n\nexport const reactionHandlers: Map<string, ReactionHandler> = ${reactionMapConstructor}([\n  ['capture_initial_entry_input', (snapshot) => {\n    if (typeof snapshot.get(${tsString(options.initialEntryPath)}) === 'string') {\n      return undefined;\n    }\n    const current = snapshot.get(${tsString(options.entryPath)});\n    return typeof current === 'string'\n      ? { mutations: [{ op: 'MSet' as const, path: ${tsString(options.initialEntryPath)}, value: current }] }\n      : undefined;\n  }]${stageOutputMirrorReactionEntries}${lifecycleReactionEntries},\n]);${stageOutputMirrorReactionEntries ? stageOutputMirrorReactionHelper() : ''}${lifecycleReactionHelper}`
    : '';
  const conformanceHelper = contractActionSources.size > 0
    ? `

// Observability only: the hard reasoning-output enforcement is the engine's
// GKType check on each typed <stage>.result.<field> path. This envelope makes
// composite/field divergence visible in session logs without throwing.
function reasoningOutputConformant(
  resultJson: string | undefined,
  fields: Record<string, unknown>,
  coreFields: readonly string[],
): boolean {
  if (typeof resultJson !== 'string') {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false;
  }
  const record = parsed as Record<string, unknown>;
  return coreFields.every((field) => {
    if (!Object.prototype.hasOwnProperty.call(record, field)) {
      return false;
    }
    const arg = fields[field];
    if (arg === null || arg === undefined) {
      return true;
    }
    if (JSON.stringify(record[field]) === JSON.stringify(arg)) {
      return true;
    }
    // string_array args arrive as JSON array strings (JSON-string-scalar
    // pattern); compare against the composite value's JSON text.
    return typeof arg === 'string' && JSON.stringify(record[field]) === arg;
  });
}`
    : '';

  return `import type { ${reactionImport}ToolHandler } from '@simodelne/pgas-server/plugin.js';
import { resolveDomainValue, type HandlerPayload } from ${tsString(options.resolverImport)};
${contractsImport}
${stageImports ? `${stageImports}\n` : ''}

// Generated by pgas-new from the approved stage topology. Deterministic stage
// wrappers return values written through action_map.result_path; LLM reasoning
// stages keep the runtime model's tool-call arguments as their source of truth.

export const handlers: Record<string, ToolHandler> = {
${beginWorkHandler ? `${beginWorkHandler}\n\n` : ''}  async record_user_note(payload) {
    const note = resolveDomainValue<string>(payload as HandlerPayload, 'note', '');
    return {
      kind: 'note_recorded',
      note,
    };
  },

${sessionControlHandlers}${actionHandlers ? `\n\n${actionHandlers}` : ''}${lifecycleActionHandlers ? `\n\n${lifecycleActionHandlers}` : ''}
};${lifecycleIntentHelper}${reactionExport}${conformanceHelper}
`;
}

function stageOutputMirrorReactionHelper(): string {
  return `

function mirrorStageOutput(
  snapshot: ReadonlyMap<string, unknown>,
  outputPath: string,
  resultPath: string,
  itemsPath: string,
): ReactionResult | undefined {
  const output = snapshot.get(outputPath);
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return undefined;
  }
  const record = output as Record<string, unknown>;
  const mutations: ReactionResult['mutations'] = [];
  if (typeof record.result_json === 'string' && snapshot.get(resultPath) !== record.result_json) {
    mutations.push({ op: 'MSet' as const, path: resultPath, value: record.result_json });
  }
  if (typeof record.items_json === 'string' && snapshot.get(itemsPath) !== record.items_json) {
    mutations.push({ op: 'MSet' as const, path: itemsPath, value: record.items_json });
  }
  return mutations.length > 0 ? { mutations } : undefined;
}`;
}

function renderCollectionLifecycleReactionEntry(descriptor: CollectionLifecycleDescriptor): string {
  const applyEntry = collectionLifecycleLlmTransitions(descriptor).length > 0
    ? `,
  [${tsString(collectionLifecycleApplyReactionName(descriptor))}, (snapshot, trigger, mode) => {
    void trigger;
    void mode;
    return collectionLifecycleApplyEvent(
      snapshot,
      ${tsString(descriptor.storage.items_path)},
      ${tsString(descriptor.storage.event_path)},
      ${tsString(descriptor.storage.violation_path)},
      ${tsString(descriptor.item.id_field)},
      ${tsString(descriptor.item.status_field)},
      ${JSON.stringify(collectionLifecycleLlmTransitions(descriptor).map((transition) => ({
        action: transition.action,
        from: transition.from,
        to: transition.to,
        ...(transition.guard_field ? { guard_field: transition.guard_field } : {}),
      })))},
    );
  }]`
    : '';
  return `${applyEntry},
  [${tsString(collectionLifecycleReactionName(descriptor))}, (snapshot, trigger, mode) => {
    void trigger;
    void mode;
    const allTerminal = collectionLifecycleAllTerminal(
      snapshot,
      ${tsString(descriptor.storage.items_path)},
      ${tsString(descriptor.item.status_field)},
      [${descriptor.aggregate.terminal_statuses.map(tsString).join(', ')}],
      ${descriptor.aggregate.require_non_empty ? 'true' : 'false'},
    );
    return { mutations: [{ op: 'MSet' as const, path: ${tsString(descriptor.aggregate.guard_field)}, value: allTerminal }] };
  }]`;
}

function renderCollectionLifecycleApplyHelper(): string {
  return `

function collectionLifecycleApplyEvent(
  snapshot: ReadonlyMap<string, unknown>,
  itemsPath: string,
  eventPath: string,
  violationPath: string,
  idField: string,
  statusField: string,
  transitions: readonly { action: string; from: string; to: string; guard_field?: string }[],
) {
  const rawEvent = snapshot.get(eventPath);
  if (typeof rawEvent !== 'string' || rawEvent.trim().length === 0) {
    return undefined;
  }

  let parsedEvent: unknown;
  try {
    parsedEvent = JSON.parse(rawEvent) as unknown;
  } catch {
    return {
      mutations: [
        { op: 'MSet' as const, path: violationPath, value: JSON.stringify({ item_id: '', from: '', attempted_to: '', reason: 'invalid_event' }) },
        { op: 'MSet' as const, path: eventPath, value: '' },
      ],
    };
  }
  if (!parsedEvent || typeof parsedEvent !== 'object' || Array.isArray(parsedEvent)) {
    return {
      mutations: [
        { op: 'MSet' as const, path: violationPath, value: JSON.stringify({ item_id: '', from: '', attempted_to: '', reason: 'invalid_event' }) },
        { op: 'MSet' as const, path: eventPath, value: '' },
      ],
    };
  }

  const event = parsedEvent as Record<string, unknown>;
  const itemId = typeof event.item_id === 'string' ? event.item_id : '';
  const action = typeof event.action === 'string' ? event.action : '';
  const attemptedTo = typeof event.to === 'string' ? event.to : '';
  const eventFrom = typeof event.from === 'string' ? event.from : '';
  const violation = (reason: string, from: string) => ({
    mutations: [
      { op: 'MSet' as const, path: violationPath, value: JSON.stringify({ item_id: itemId, from, attempted_to: attemptedTo, reason }) },
      { op: 'MSet' as const, path: eventPath, value: '' },
    ],
  });
  if (itemId.length === 0 || action.length === 0 || attemptedTo.length === 0) {
    return violation('invalid_event', eventFrom);
  }

  const rawItems = snapshot.get(itemsPath);
  if (typeof rawItems !== 'string') {
    return violation('missing_item', eventFrom);
  }
  let parsedItems: unknown;
  try {
    parsedItems = JSON.parse(rawItems) as unknown;
  } catch {
    return violation('missing_item', eventFrom);
  }
  if (!Array.isArray(parsedItems)) {
    return violation('missing_item', eventFrom);
  }
  const items = parsedItems.filter((item): item is Record<string, unknown> =>
    !!item && typeof item === 'object' && !Array.isArray(item),
  );
  const itemIndex = items.findIndex((item) => item[idField] === itemId);
  if (itemIndex < 0) {
    return violation('missing_item', eventFrom);
  }

  const currentStatus = items[itemIndex]?.[statusField];
  const from = typeof currentStatus === 'string' ? currentStatus : '';
  const transition = transitions.find((candidate) =>
    candidate.action === action && candidate.from === from && candidate.to === attemptedTo);
  if (!transition) {
    return violation('undeclared_transition', from);
  }
  if (transition.guard_field && !snapshot.get(transition.guard_field)) {
    return violation('guard_false', from);
  }

  const nextItems = items.map((item, index) =>
    index === itemIndex ? { ...item, [statusField]: attemptedTo } : item,
  );
  return {
    mutations: [
      { op: 'MSet' as const, path: itemsPath, value: JSON.stringify(nextItems) },
      { op: 'MSet' as const, path: eventPath, value: '' },
    ],
  };
}`;
}

function renderToolsSource(
  slug: string,
  transitionActions: TransitionAction[],
  reasoningContractsBySlug: Map<string, ReasoningStageContract>,
  collectionLifecycle?: CollectionLifecycleDescriptor,
): string {
  const stageActions = transitionActions.filter((action) => action.name !== 'begin_work');
  const lifecycleTransitions = collectionLifecycle
    ? collectionLifecycleLlmTransitions(collectionLifecycle)
    : [];
  const stageMetadata = stageActions.map((action) => {
  const reasoningContract = action.archetype === 'llm-reasoning' ? reasoningContractsBySlug.get(action.source) : undefined;
  const reasoningLines = reasoningContract
    ? `
    result_fields: [${reasoningContract.result_schema.fields.map((field) => tsString(field.name)).join(', ')}],
    result_record_path: ${tsString(`${action.source}.result`)},`
    : '';
  return `  ${action.name}: {
    mode: ${tsString(action.source)},
    target: ${tsString(action.target)},
    archetype: ${tsString(action.archetype)},
    guard_paths: [${action.guardField ? tsString(action.guardField) : ''}],
    output_path: ${tsString(action.archetype === 'llm-reasoning' ? `${action.source}.result_json` : `${action.source}.output`)},
    items_path: ${tsString(action.archetype === 'llm-reasoning' ? `${action.source}.items_json` : `${action.source}.output.items_json`)},${reasoningLines}
    description: ${tsString(`Generated stage action metadata for ${action.source}.`)},
  },`;
}).join('\n');
  const metadata = stageActions.length === 0
    ? '{}'
    : `{
${stageMetadata}\n}`;
  const lifecycleMetadata = lifecycleTransitions.length === 0
    ? ''
    : `

export const lifecycleActionTools = {
${lifecycleTransitions.map((transition) => `  ${transition.action}: {
    mode: ${tsString(transition.stage)},
    action: ${tsString(transition.action)},
    from: ${tsString(transition.from)},
    to: ${tsString(transition.to)},
    event_path: ${tsString(collectionLifecycle?.storage.event_path ?? '')},
    items_path: ${tsString(collectionLifecycle?.storage.items_path ?? '')},
    item_id_arg: 'item_id',
    guard_paths: [${transition.guard_field ? tsString(transition.guard_field) : ''}],
    description: ${tsString(`Generated lifecycle intent action metadata for ${collectionLifecycle?.item_label ?? 'item'}.`)},
  },`).join('\n')}
} as const;`;

  return `import type { ToolRegistry } from '@simodelne/pgas-server/plugin.js';

// Native stage actions are declared in specs.yml action_map. This metadata gives
// implementers one fillable local-tool slot per synthesized stage without adding
// extra invoke_tool_* actions to the engine topology.
export const stageActionTools = ${metadata} as const;${lifecycleMetadata}

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
  reasoningContractsBySlug: Map<string, ReasoningStageContract>,
): string {
  const classified = JSON.stringify(stageClassification, null, 2);
  const domainSpecs = JSON.stringify(domainSpecsByStage(stages), null, 2);
  const reasoningContractsBlock = reasoningContractsBySlug.size === 0
    ? ''
    : `

export interface ReasoningFieldContract {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'string_array';
  description: string;
  enum_values?: readonly string[];
}

export interface ReasoningStageContract {
  contract_version: string;
  stage: string;
  reasoning_prompt: string;
  result_schema: {
    fields: readonly ReasoningFieldContract[];
    allow_extra_fields: boolean;
  };
  items_schema: {
    templates: readonly string[];
    description: string;
  };
  canned_example: {
    result: Record<string, unknown>;
    items: readonly string[];
  };
  contract_source: 'meta_llm' | 'deterministic_fallback';
}

export const stageReasoningContracts = ${JSON.stringify(Object.fromEntries(reasoningContractsBySlug), null, 2)} as Record<string, ReasoningStageContract>;`;
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

export const stageDomainSpecs = ${domainSpecs} as Record<string, StageDomainSpec>;${reasoningContractsBlock}

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
  reasoningContractsBySlug: Map<string, ReasoningStageContract>,
): string {
  const pathActions = actionsForCompletionPath(transitionActions, completion.final_stage);
  const initialTrigger = smokeInitialTriggerExpression(stages, entryChannel);
  const hasContractResponses = pathActions.some((action) =>
    action.archetype === 'llm-reasoning' && reasoningContractsBySlug.has(action.source));
  const responses = pathActions.map((action) => {
    if (action.archetype === 'llm-reasoning') {
      const reasoningContract = reasoningContractsBySlug.get(action.source);
      if (reasoningContract) {
        // The action's declared channel is widget_output (actionMapEntryFor);
        // the canned effect must ride that channel or the handler's
        // contract-conformance envelope is unreachable (Codex fix, spec §6.7).
        const canned = reasoningContract.canned_example;
        const cannedFieldArgs = reasoningContract.result_schema.fields
          .map((field) => {
            const value = canned.result[field.name];
            // string_array args ride the JSON-string-scalar pattern (S-11
            // forbids MSet into array-typed paths), so the scripted arg is
            // the JSON text of the canned array.
            const literal = field.type === 'string_array'
              ? JSON.stringify(JSON.stringify(value))
              : JSON.stringify(value);
            return `          ${field.name}: ${literal},`;
          })
          .join('\n');
        return `        effect(${tsString(action.name)}, {
          result_json: JSON.stringify(${JSON.stringify(canned.result)}),
          items_json: JSON.stringify(${JSON.stringify(canned.items)}),
${cannedFieldArgs}
        }, 'widget_output'),`;
      }
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

${hasContractResponses
    ? `function effect(name: string, payload: Record<string, unknown>, channel?: string): TestHarnessAuthorResponse {
  return { actions: [{ kind: 'EffectAction', name, channel: channel ?? (name === 'begin_work' ? 'widget_output' : 'stage_output'), payload }] };
}`
    : `function effect(name: string, payload: Record<string, unknown>): TestHarnessAuthorResponse {
  return { actions: [{ kind: 'EffectAction', name, channel: name === 'begin_work' ? 'widget_output' : 'stage_output', payload }] };
}`}
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
    if (entryChannel === 'frontend_intake') {
      return `JSON.stringify(${JSON.stringify({
        client_name: 'Acme Holdings',
        matter_or_service_type: 'Professional services engagement',
        jurisdiction: 'New York',
        complexity_tier: 'standard',
        target_deadline: '2026-07-15',
        constraints: ['board-ready proposal', 'transparent assumptions'],
        budget_signal: 'value-conscious',
        currency: 'USD',
        fee_structure: 'fixed',
      }, null, 2)})`;
    }
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
    const next = (bySource.get(current) ?? []).find((action) => reachesFinalStage(action.target, finalStage, bySource, new Set(seen)));
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
  return (bySource.get(mode) ?? []).some((action) => reachesFinalStage(action.target, finalStage, bySource, new Set(seen)));
}

function safeIdentifier(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9_]+/gu, '_').replace(/^_+|_+$/gu, '');
  return normalized.length > 0 ? normalized : 'stage';
}

function normalizePgasChannelId(value: string): string {
  const lowered = value.trim().toLowerCase();
  if (/\bfrontend_intake\b/u.test(lowered) || /\bfrontend\b[\s\S]*\bstructured\s+intake\b/u.test(lowered)) {
    return 'frontend_intake';
  }
  if (/\buser_text\b/u.test(lowered)) {
    return 'user_text';
  }
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/gu, '_')
    .replace(/_+/gu, '_')
    .replace(/^_+|_+$/gu, '');
  const bounded = slug
    .slice(0, PGAS_CHANNEL_ID_MAX_LENGTH)
    .replace(/^_+|_+$/gu, '');
  return bounded.length > 0 ? bounded : 'user_text';
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

export function createCollectionLifecycleAllTerminalReaction(value: unknown): ReactionHandler {
  const descriptor = normalizeCollectionLifecycleDescriptor(value);
  if (!descriptor) {
    throw new Error('collection_lifecycle descriptor is required');
  }
  assertCollectionLifecycleDescriptor(descriptor);
  return (snapshot) => {
    const allTerminal = collectionLifecycleAllTerminal(
      snapshot,
      descriptor.storage.items_path,
      descriptor.item.status_field,
      descriptor.aggregate.terminal_statuses,
      descriptor.aggregate.require_non_empty,
    );
    return { mutations: [{ op: 'MSet' as const, path: descriptor.aggregate.guard_field, value: allTerminal }] };
  };
}

export function createCollectionLifecycleApplyReaction(value: unknown): ReactionHandler {
  const descriptor = normalizeCollectionLifecycleDescriptor(value);
  if (!descriptor) {
    throw new Error('collection_lifecycle descriptor is required');
  }
  assertCollectionLifecycleDescriptor(descriptor);
  return (snapshot) => collectionLifecycleApplyEvent(snapshot, descriptor);
}

function collectionLifecycleApplyEvent(
  snapshot: ReadonlyMap<string, unknown>,
  descriptor: CollectionLifecycleDescriptor,
): ReactionResult | undefined {
  const rawEvent = snapshot.get(descriptor.storage.event_path);
  if (typeof rawEvent !== 'string' || rawEvent.trim().length === 0) {
    return undefined;
  }

  let parsedEvent: unknown;
  try {
    parsedEvent = JSON.parse(rawEvent) as unknown;
  } catch {
    return collectionLifecycleViolation(descriptor, '', '', '', 'invalid_event');
  }
  if (!parsedEvent || typeof parsedEvent !== 'object' || Array.isArray(parsedEvent)) {
    return collectionLifecycleViolation(descriptor, '', '', '', 'invalid_event');
  }

  const event = parsedEvent as Record<string, unknown>;
  const itemId = typeof event.item_id === 'string' ? event.item_id : '';
  const action = typeof event.action === 'string' ? event.action : '';
  const attemptedTo = typeof event.to === 'string' ? event.to : '';
  const eventFrom = typeof event.from === 'string' ? event.from : '';
  if (itemId.length === 0 || action.length === 0 || attemptedTo.length === 0) {
    return collectionLifecycleViolation(descriptor, itemId, eventFrom, attemptedTo, 'invalid_event');
  }

  const parsedItems = parseCollectionLifecycleItems(snapshot.get(descriptor.storage.items_path));
  if (!parsedItems) {
    return collectionLifecycleViolation(descriptor, itemId, eventFrom, attemptedTo, 'missing_item');
  }
  const itemIndex = parsedItems.findIndex((item) =>
    item && typeof item === 'object' && !Array.isArray(item) &&
      (item as Record<string, unknown>)[descriptor.item.id_field] === itemId);
  if (itemIndex < 0) {
    return collectionLifecycleViolation(descriptor, itemId, eventFrom, attemptedTo, 'missing_item');
  }

  const currentItem = parsedItems[itemIndex] as Record<string, unknown>;
  const currentStatus = currentItem[descriptor.item.status_field];
  const from = typeof currentStatus === 'string' ? currentStatus : '';
  const transition = collectionLifecycleLlmTransitions(descriptor).find((candidate) =>
    candidate.action === action && candidate.from === from && candidate.to === attemptedTo);
  if (!transition) {
    return collectionLifecycleViolation(descriptor, itemId, from, attemptedTo, 'undeclared_transition');
  }
  if (transition.guard_field && !snapshot.get(transition.guard_field)) {
    return collectionLifecycleViolation(descriptor, itemId, from, attemptedTo, 'guard_false');
  }

  const updatedItems = parsedItems.map((item, index) =>
    index === itemIndex && item && typeof item === 'object' && !Array.isArray(item)
      ? { ...item as Record<string, unknown>, [descriptor.item.status_field]: attemptedTo }
      : item,
  );
  return {
    mutations: [
      { op: 'MSet' as const, path: descriptor.storage.items_path, value: JSON.stringify(updatedItems) },
      { op: 'MSet' as const, path: descriptor.storage.event_path, value: COLLECTION_LIFECYCLE_EVENT_CLEAR_VALUE },
    ],
  };
}

function parseCollectionLifecycleItems(value: unknown): unknown[] | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
  return Array.isArray(parsed) ? parsed : undefined;
}

function collectionLifecycleViolation(
  descriptor: CollectionLifecycleDescriptor,
  itemId: string,
  from: string,
  attemptedTo: string,
  reason: string,
): ReactionResult {
  return {
    mutations: [
      {
        op: 'MSet' as const,
        path: descriptor.storage.violation_path,
        value: JSON.stringify({
          item_id: itemId,
          from,
          attempted_to: attemptedTo,
          reason,
        }),
      },
      {
        op: 'MSet' as const,
        path: descriptor.storage.event_path,
        value: COLLECTION_LIFECYCLE_EVENT_CLEAR_VALUE,
      },
    ],
  };
}

function collectionLifecycleAllTerminal(
  snapshot: ReadonlyMap<string, unknown>,
  itemsPath: string,
  statusField: string,
  terminalStatuses: readonly string[],
  requireNonEmpty: boolean,
): boolean {
  const raw = snapshot.get(itemsPath);
  if (typeof raw !== 'string') {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) {
    return false;
  }
  if (requireNonEmpty && parsed.length === 0) {
    return false;
  }
  const terminal = new Set(terminalStatuses);
  return parsed.every((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return false;
    }
    const status = (item as Record<string, unknown>)[statusField];
    return typeof status === 'string' && terminal.has(status);
  });
}

function promptForStage(
  modeName: string,
  programName: string,
  domainSpec?: StageDomainSpec,
  reasoningContract?: ReasoningStageContract,
): string {
  const domainSpecSuffix = domainSpec
    ? [
        `Author-provided domain spec for ${modeName} is normative; implement it exactly and do not infer alternate business logic.`,
        JSON.stringify(domainSpec),
      ]
    : [];
  if (reasoningContract) {
    return [
      reasoningContract.reasoning_prompt,
      `Return your reasoning through the stage action's arguments. result_json must be a JSON object containing at least: ${reasoningContract.result_schema.fields.map(reasoningFieldSummary).join(', ')}. Additional keys are allowed. items_json must be a JSON array of strings matching: ${reasoningContract.items_schema.templates.join(', ')}.`,
      ...domainSpecSuffix,
    ].join('\n');
  }
  return [`Perform the ${modeName} stage for ${programName}.`, ...domainSpecSuffix].join('\n');
}

function guidanceFor(
  modeNames: string[],
  delegation: Record<string, unknown>,
  stageDomainSpecBySlug: Map<string, StageDomainSpec>,
  reasoningContractsBySlug: Map<string, ReasoningStageContract>,
): Record<string, string[]> {
  const baseGuidance = [
    'Use the synthesized JSON-string scalar fields for structured handler results.',
  ];
  if (Object.keys(delegation).length > 0) {
    baseGuidance.push(`delegation intake captured for this program: ${JSON.stringify(delegation)}.`);
  }
  return Object.fromEntries(modeNames.map((modeName) => {
    const domainSpec = stageDomainSpecBySlug.get(modeName);
    const reasoningContract = reasoningContractsBySlug.get(modeName);
    const stageGuidance = domainSpec
      ? [
          ...baseGuidance,
          `Author-provided domain spec for ${modeName}: ${JSON.stringify(domainSpec)}.`,
          'Domain spec rules and invariants are mandatory; do not substitute guessed defaults.',
        ]
      : [...baseGuidance];
    if (reasoningContract) {
      stageGuidance.push(
        ...reasoningContract.result_schema.fields.map((field) =>
          `${field.name} (${field.type}${field.type === 'enum' ? `, one of: ${(field.enum_values ?? []).join(' | ')}` : ''}): ${field.description}`),
        `items_json templates: ${reasoningContract.items_schema.templates.join(', ')}.`,
        'Populate every core argument; the composite result_json must agree with the per-field arguments.',
      );
    }
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
  assertPreconditionVocabularyAlignment(load(specYaml));
}

/**
 * Locks the precondition-vocabulary invariant on every synthesized spec: each
 * mode's `preconditions` keys must be a subset of that mode's `vocabulary`.
 * A precondition keyed on an action the mode cannot emit is dead — the engine
 * warns on dead preconditions today and will reject them as ERRORS in a
 * future release (pgas#620). Synthesized specs currently emit no
 * `preconditions` at all, so this holds by construction; the assertion exists
 * to fail synthesis loudly if a future generator change regresses that.
 */
export function assertPreconditionVocabularyAlignment(spec: unknown): void {
  if (!isRecord(spec)) {
    throw new Error('precondition vocabulary alignment requires a parsed spec object');
  }
  const modes = spec.modes;
  if (!isRecord(modes)) {
    throw new Error('precondition vocabulary alignment requires spec.modes to be a mapping');
  }
  for (const [modeName, mode] of Object.entries(modes)) {
    if (!isRecord(mode)) {
      throw new Error(`synthesized mode "${modeName}" must be a mapping`);
    }
    const vocabulary = new Set(
      Array.isArray(mode.vocabulary)
        ? (mode.vocabulary as unknown[]).filter((entry): entry is string => typeof entry === 'string')
        : [],
    );
    const preconditions = mode.preconditions;
    if (preconditions === undefined || preconditions === null) {
      continue;
    }
    if (!isRecord(preconditions)) {
      throw new Error(`synthesized mode "${modeName}" preconditions must be a mapping of action name to predicates`);
    }
    for (const actionName of Object.keys(preconditions)) {
      if (!vocabulary.has(actionName)) {
        throw new Error(
          `synthesized mode "${modeName}" declares a precondition for action "${actionName}" that is not in the mode's vocabulary — dead preconditions become engine errors (pgas#620)`,
        );
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function nonTerminalStageSlugs(stages: Stage[], completion: Completion): string[] {
  return unique(
    stages
      .filter((stage) => !stage.is_terminal && stage.slug !== completion.final_stage)
      .map((stage) => stage.slug),
  );
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

export function normalizeCollectionLifecycleDescriptor(value: unknown): CollectionLifecycleDescriptor | undefined {
  if (value === undefined) {
    return undefined;
  }
  const descriptor = requiredRecord(value, 'collection_lifecycle');
  const storage = requiredRecord(descriptor.storage, 'collection_lifecycle.storage');
  const item = requiredRecord(descriptor.item, 'collection_lifecycle.item');
  const aggregate = requiredRecord(descriptor.aggregate, 'collection_lifecycle.aggregate');
  const statuses = requiredArray(descriptor.statuses, 'collection_lifecycle.statuses').map((status, index) => {
    const record = requiredRecord(status, `collection_lifecycle.statuses[${index}]`);
    return {
      name: requiredString(record.name, `collection_lifecycle.statuses[${index}].name`),
      ...(record.initial === true ? { initial: true } : {}),
      ...(record.terminal === true ? { terminal: true } : {}),
    };
  });
  const transitions = requiredArray(descriptor.transitions, 'collection_lifecycle.transitions').map((transition, index) => {
    const record = requiredRecord(transition, `collection_lifecycle.transitions[${index}]`);
    const managedByRaw = requiredString(record.managed_by, `collection_lifecycle.transitions[${index}].managed_by`);
    if (managedByRaw !== 'llm' && managedByRaw !== 'reaction') {
      throw new Error(`collection_lifecycle.transitions[${index}].managed_by must be llm or reaction`);
    }
    const managedBy: CollectionLifecycleDescriptor['transitions'][number]['managed_by'] = managedByRaw;
    return {
      from: requiredString(record.from, `collection_lifecycle.transitions[${index}].from`),
      to: requiredString(record.to, `collection_lifecycle.transitions[${index}].to`),
      stage: requiredString(record.stage, `collection_lifecycle.transitions[${index}].stage`),
      action: requiredString(record.action, `collection_lifecycle.transitions[${index}].action`),
      managed_by: managedBy,
      ...optionalStringProperty(record, 'trigger'),
      ...optionalStringProperty(record, 'guard_field'),
    };
  });

  return {
    version: requiredNumber(descriptor.version, 'collection_lifecycle.version'),
    name: requiredString(descriptor.name, 'collection_lifecycle.name'),
    item_label: requiredString(descriptor.item_label, 'collection_lifecycle.item_label'),
    storage: {
      items_path: requiredString(storage.items_path, 'collection_lifecycle.storage.items_path'),
      event_path: requiredString(storage.event_path, 'collection_lifecycle.storage.event_path'),
      violation_path: requiredString(storage.violation_path, 'collection_lifecycle.storage.violation_path'),
    },
    item: {
      id_field: requiredString(item.id_field, 'collection_lifecycle.item.id_field'),
      status_field: requiredString(item.status_field, 'collection_lifecycle.item.status_field'),
      schema: { ...requiredRecord(item.schema, 'collection_lifecycle.item.schema') },
    },
    statuses,
    transitions,
    aggregate: {
      guard_field: requiredString(aggregate.guard_field, 'collection_lifecycle.aggregate.guard_field'),
      terminal_statuses: requiredStringList(aggregate.terminal_statuses, 'collection_lifecycle.aggregate.terminal_statuses'),
      require_non_empty: requiredBoolean(aggregate.require_non_empty, 'collection_lifecycle.aggregate.require_non_empty'),
    },
  };
}

export function assertCollectionLifecycleDescriptor(descriptor: CollectionLifecycleDescriptor): void {
  if (!Array.isArray(descriptor.statuses) || descriptor.statuses.length === 0) {
    throw new Error('collection_lifecycle.statuses must declare at least one status');
  }
  const statusNames = descriptor.statuses.map((status) => status.name);
  const statusNameSet = new Set(statusNames);
  if (statusNameSet.size !== statusNames.length) {
    throw new Error('collection_lifecycle.statuses names must be unique');
  }
  if (!descriptor.statuses.some((status) => status.initial === true)) {
    throw new Error('collection_lifecycle.statuses must declare an initial status');
  }

  const actionNames = descriptor.transitions.map((transition) => transition.action);
  if (new Set(actionNames).size !== actionNames.length) {
    throw new Error('collection_lifecycle.transitions must not contain duplicate action names');
  }

  for (const transition of descriptor.transitions) {
    if (!statusNameSet.has(transition.from)) {
      throw new Error(`collection_lifecycle transition ${transition.action} has unknown from status: ${transition.from}`);
    }
    if (!statusNameSet.has(transition.to)) {
      throw new Error(`collection_lifecycle transition ${transition.action} has unknown to status: ${transition.to}`);
    }
  }

  const unknownTerminalStatuses = descriptor.aggregate.terminal_statuses.filter((status) => !statusNameSet.has(status));
  if (unknownTerminalStatuses.length > 0) {
    throw new Error(`collection_lifecycle.aggregate.terminal_statuses must be a subset of statuses; unknown: ${unknownTerminalStatuses.join(', ')}`);
  }
  if (!normalizeGuardField(descriptor.aggregate.guard_field)) {
    throw new Error('collection_lifecycle.aggregate.guard_field is required');
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

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requiredStringList(value: unknown, label: string): string[] {
  return requiredArray(value, label).map((item, index) => requiredString(item, `${label}[${index}]`));
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function optionalStringProperty(
  record: Record<string, unknown>,
  key: 'trigger' | 'guard_field',
): Partial<Record<'trigger' | 'guard_field', string>> {
  const value = record[key];
  if (value === undefined) {
    return {};
  }
  return { [key]: requiredString(value, `collection_lifecycle.transitions[].${key}`) };
}

/**
 * Parse intake.stages_json applying the SAME repair/normalization the
 * record_q3_stages handler applies (issue #92). Because the engine persists
 * intake.stages_json from the raw tool `from_arg` (there is no `from_result`
 * mutation source), a rich Q3 stages_json carrying per-stage domain_spec that
 * arrives with the known dropped-boundary-brace malformation would otherwise be
 * strict-parsed here and lose every domain_spec (empty stageDomainSpecs).
 */
function parseStagesDomainField(domain: Record<string, unknown>): StageInput[] {
  const value = domainValue(domain, 'intake.stages_json');
  if (typeof value !== 'string') {
    throw new Error('missing JSON-string domain field: intake.stages_json');
  }
  return parseAndNormalizeStagesJson(value).value as StageInput[];
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
