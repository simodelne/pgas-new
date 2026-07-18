import { isRecord } from '../util/guards.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dump, load } from 'js-yaml';
import { loadSpecWithPatterns, reconstructArray, type ProgramArtifactPolicy, type ReactionHandler, type ReactionResult } from '@simodelne/pgas-server/plugin.js';
import { renderTemplate } from '../pgas-new/template-renderer.js';
import type { WiringAvailableProgram, WiringIntegration } from '../pgas-new/wiring-manifest.js';
import type { CapabilityGap, DelegationChildDescriptor, DelegationDescriptor, DocumentExtractionSurfaces, DocumentsDescriptor, ExportStageDescriptor, ExportSurfaces, SynthesisContext, SynthesizedArtifact } from './synthesizer-store.js';
import { CapabilityRefusalError, assertSynthesizableCapabilities, detectRequestedCapabilities } from './capability-registry.js';
import { assertConfirmationPairingTerminals } from './composite-checks.js';
import { parseAndNormalizeStagesJson } from './json-normalize.js';
import {
  classifyStagesForDomain,
  type ClassifiedStage,
  type StageArchetype,
} from './stage-classifier.js';
import {
  REASONING_CONTRACT_VERSION,
  reasoningFieldSummary,
  runtimeTypeNameFor,
  type ReasoningStageContract,
} from './reasoning-contract.js';

type CollectionStorageRepresentation = 'json_string' | 'indexed_array';

interface Stage {
  slug: string;
  is_bootstrap?: boolean;
  is_terminal?: boolean;
  kind?: string;
  export_kind?: string;
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

interface Interaction {
  confirmation_loops: ConfirmationLoopDescriptor[];
}

export interface DelegationChildrenValidationContext {
  programSlug: string;
  programName: string;
  stages: Array<{
    slug: string;
    is_bootstrap?: boolean;
    is_terminal?: boolean;
    domain_spec?: StageDomainSpec;
  }>;
  actionNames: Iterable<string>;
  channelNames: Iterable<string>;
  schemaPaths: Iterable<string>;
}

export interface DocumentsValidationContext {
  stages: Array<{
    slug: string;
    is_bootstrap?: boolean;
    is_terminal?: boolean;
  }>;
  delegation?: Record<string, unknown>;
}

interface CollectionLifecycleDescriptor {
  version: number;
  name: string;
  item_label: string;
  storage: {
    items_path: string;
    event_path: string;
    violation_path: string;
    representation: CollectionStorageRepresentation;
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

interface ConfirmationLoopDecisionDescriptor {
  to: string;
  requires_instruction?: boolean;
  instruction_path?: string;
  re_propose?: boolean;
}

interface ConfirmationLoopSeedDescriptor {
  source_stage: string;
  id_prefix?: string;
}

interface ConfirmationLoopDescriptor {
  collection: string;
  proposed_status: string;
  seed: ConfirmationLoopSeedDescriptor;
  item_id_field?: string;
  item_title_field?: string;
  decisions: Record<string, ConfirmationLoopDecisionDescriptor>;
  one_proposed_at_a_time: true;
  aggregate: {
    guard_field: string;
    terminal_statuses: string[];
  };
  stage: string;
  summary_path?: string;
  violation_path?: string;
  pending_action_path?: string;
}

export interface SynthesizedSpec {
  spec_yaml: string;
  mode_names: string[];
  sha256: string;
  registration_ts?: string;
  contracts_ts: string;
  handlers_ts: string;
  handlers_index_ts: string;
  tools_ts: string;
  smoke_test_ts: string;
  stage_sources?: Record<string, string>;
  capability_gaps?: CapabilityGap[];
  export_surfaces?: ExportSurfaces;
  document_extraction_surfaces?: DocumentExtractionSurfaces;
  export_descriptors?: ExportStageDescriptor[];
  child_artifacts?: SynthesizedChildArtifact[];
  stage_classification: ClassifiedStage[];
  body_stage_slugs: string[];
  synthesis_context: SynthesisContext;
}

export interface SynthesizedChildArtifact extends Omit<SynthesizedSpec, 'child_artifacts' | 'synthesis_context'> {
  slug: string;
  name: string;
  synthesis_context: SynthesisContext;
}

export interface SynthesizeProgramSpecOptions {
  targetKind?: 'standalone_repo' | 'existing_repo';
  integrations?: WiringIntegration[];
  availablePrograms?: WiringAvailableProgram[];
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
  export_kind?: 'export_docx' | 'export_html';
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
const USER_CONFIRMATION_CHANNEL = 'user_confirmation';
const DOCUMENT_UPLOAD_CHANNEL = 'document_upload';
const DOCUMENT_INTAKE_ROOT = 'inputs.document_intake';
const DOCUMENT_REQUEST_ACTION = 'request_documents';
const DOCUMENT_INGEST_ACTION = 'ingest_documents';
const DOCUMENT_SKIP_ACTION = 'complete_document_skip';
const DOCUMENTS_RECEIVED_PATH = 'decisions.documents_received';
const DOCUMENT_SKIP_STATUS = 'no_documents_available';
const PROPOSE_ITEM_ACTION = 'propose_item';
const CONTROL_PLANE_ACTIONS = [
  'record_user_note',
  'session_new',
  'session_abort_current',
  'session_status',
  'session_history',
  'session_resume',
  'session_help',
];
const USER_DECISION_INGESTION_PATHS = [
  'inputs.user_decision',
  'inputs.user_decision.decision',
  'inputs.user_decision.instruction',
  'inputs.user_decision.note_mode',
  'inputs.user_decision.timestamp',
  'inputs.user_decision.target_item_index',
  'inputs.user_decision.target_item_id',
  'inputs.user_decision.target_item_title',
  'inputs.user_decision.target_item_status',
];
const DOCUMENT_UPLOAD_TYPES = new Map<string, string>([
  ['text', 'text/plain'],
  ['plain', 'text/plain'],
  ['text/plain', 'text/plain'],
  ['markdown', 'text/markdown'],
  ['md', 'text/markdown'],
  ['text/markdown', 'text/markdown'],
  ['pdf', 'application/pdf'],
  ['application/pdf', 'application/pdf'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['zip', 'application/zip'],
  ['application/zip', 'application/zip'],
  ['application/x-zip-compressed', 'application/x-zip-compressed'],
]);
const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_MIME_TYPE = 'application/pdf';
const SELF_CONTAINED_DOCUMENT_UPLOAD_TYPES = new Set(
  [...DOCUMENT_UPLOAD_TYPES.values()].filter((uploadType) => uploadType !== PDF_MIME_TYPE),
);
const DOCUMENT_SELF_CONTAINED_GAP_NOTE =
  'PDF extraction is a host connector — use extraction: host_connector with connector_slug; self-contained DOCX is supported by the generated extractor';

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
  const delegation = resolveDelegationChildrenAgainstManifest(
    parseJsonDomainField<DelegationDescriptor>(domain, 'intake.delegation_json'),
    options.availablePrograms ?? [],
  );
  const rawDocuments = optionalJsonDomainField(domain, 'intake.documents_json');
  const documents = normalizeDocumentsDescriptor(rawDocuments);
  let completion = parseJsonDomainField<Completion>(domain, 'intake.completion_json');
  const collectionLifecycle = normalizeCollectionLifecycleDescriptor(completion.collection_lifecycle);
  const interaction = normalizeInteractionDescriptor(optionalJsonDomainField(domain, 'intake.interaction_json'));
  const confirmationLoops = interaction?.confirmation_loops ?? [];
  const delegationChildren = delegation.children ?? [];

  if (delegation.children !== undefined) {
    assertStages(stages);
    assertTransitions(transitions);
    assertCompletion(completion);
    assertDelegationChildrenDescriptor(delegation, {
      programSlug: slug,
      programName: name,
      stages,
      actionNames: collectGeneratedActionNamesForDelegationValidation(transitions, completion, stages[0]?.slug ?? ''),
      channelNames: collectGeneratedChannelNamesForDelegationValidation(entryChannel),
      schemaPaths: collectParentSchemaPathsForDelegationValidation(stages, entryChannel, initialEntryPath, transitions, completion),
    });
  }
  if (rawDocuments !== undefined && documents !== undefined) {
    assertStages(stages);
    assertDocumentsDescriptor(documents, { stages, delegation });
  }

  // #166 capability gate (uplift PR-1): safe-stop rather than silently emit an
  // inadequate linear scaffold when the program demands synthesis capabilities the
  // foundry does not yet have (per-item confirmation, child/research delegation,
  // document upload, rich frontend, DOCX/track-changes). No detectors fire for
  // today's linear / external-adapter programs, so this is a no-op for them and
  // golden byte-identity is preserved.
  const capabilityInput = { purpose, stages, delegation, documents, completion };
  const requestedCapabilities = detectRequestedCapabilities(capabilityInput);
  assertSynthesizableCapabilities(capabilityInput);
  const exportDescriptors = exportDescriptorsFor(stages, requestedCapabilities, name);
  const exportSurfaces = exportSurfacesFor(exportDescriptors, requestedCapabilities);
  const documentExtractionSurfaces = documentExtractionSurfacesFor(documents);
  const documentExtractionGaps = capabilityGapsForDocumentExtraction(documents);

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
  const stageClassification = applyExportDescriptorsToClassifications(
    bindRepoIntegrations(
      classifyStagesForDomain({
        ...domain,
        'intake.stages_json': JSON.stringify(stages),
      }),
      options,
    ),
    exportDescriptors,
  );
  const stageClassificationBySlug = new Map(stageClassification.map((stage) => [stage.slug, stage]));
  if (confirmationLoops.length > 0) {
    assertConfirmationLoopDescriptors(confirmationLoops, collectionLifecycle, stages, stageClassificationBySlug);
    completion = {
      ...completion,
      guard_field: confirmationLoops[0]?.aggregate.guard_field ?? completion.guard_field,
    };
  }
  transitions = refreshStaleTransitionsForStages(stages, transitions, completion) ?? transitions;
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
  const documentsStageTargetsFinal = documents
    ? transitions.some((transition) => transition.from === documents.stage && transition.to === completion.final_stage)
    : false;
  const effectiveCompletion = documents && documentsStageTargetsFinal
    ? completionWithDocumentsReadyGuard(completion, documents)
    : completion;
  const effectiveTransitions = documents
    ? transitionsWithDocumentsReadyGuard(transitions, documents)
    : transitions;
  const transitionActions = decorateTransitionActions(
    planTransitionActions(effectiveTransitions, effectiveCompletion, firstMode),
    stageClassificationBySlug,
  );
  const transitionActionsBySource = actionsBySourceMode(transitionActions);
  const loopStageNames = new Set(confirmationLoops.map((loop) => loop.stage));
  const suppressedTransitionActionNames = new Set(
    transitionActions
      .filter((action) => loopStageNames.has(action.source))
      .map((action) => action.name),
  );
  const firstWorkMode = transitionActions.find((transition) => transition.source === firstMode)?.target ?? intermediateModes[0];
  const childArtifacts = synthesizeDelegationChildArtifacts(slug, name, delegationChildren);
  const capabilityGaps = [
    ...capabilityGapsForDelegationChildren(delegationChildren),
    ...documentExtractionGaps,
  ];
  const artifactPolicy = artifactPolicyForExportDescriptors(exportDescriptors);
  const registrationPolicies = {
    ...(delegationChildren.length > 0 ? { delegationPolicy: delegationPolicyForChildren(delegationChildren) } : {}),
    ...(artifactPolicy ? { artifactPolicy } : {}),
  };
  const hasRegistrationPolicies = Object.keys(registrationPolicies).length > 0;

  const renderedSkeleton = renderTemplate(readFileSync(SKELETON_PATH, 'utf8'), {
    NAME: name,
    SLUG: slug,
  });
  const spec = load(renderedSkeleton) as MutableRecord;

  spec.name = slug;
  spec.preamble = `Program: ${name}. ${purpose}\n\nThis spec was synthesized mechanically by pgas-new.`;
  spec.initial = firstMode;
  spec.terminal = terminalModes;
  spec.features = unique([
    ...(Array.isArray(spec.features) ? spec.features as string[] : []),
    'reactions',
    ...(delegationChildren.length > 0 ? ['delegation'] : []),
  ]);

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
  applyConfirmationLoopIntentModeWiring(synthesizedModes, confirmationLoops);
  applyDocumentsModeWiring(synthesizedModes, documents);
  applyDelegationModeWiring(synthesizedModes, delegationChildren);
  spec.modes = synthesizedModes;

  spec.proceed_to = Object.fromEntries(
    transitionActions
      .filter((action) => !suppressedTransitionActionNames.has(action.name))
      .map((action) => [action.name, action.target]),
  );
  applyDocumentsProceedTo(recordField(spec, 'proceed_to'), documents, transitionActionsBySource);

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
  if (completion.collection_lifecycle) {
    applyCollectionLifecycleProjection(projection, completion.collection_lifecycle);
  }
  applyConfirmationLoopProjection(projection, confirmationLoops, completion.collection_lifecycle);
  applyDocumentsProjection(projection, documents, modeNames);
  applyDelegationProjection(projection, delegationChildren, modeNames);
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
  applyConfirmationLoopPrompts(prompts, confirmationLoops, completion.collection_lifecycle);
  applyDocumentsPromptsGuidance(prompts, documents);
  applyDelegationPrompts(prompts, delegationChildren);
  spec.prompts = prompts;

  spec.ingestion = {
    [entryChannel]: [`inputs.${entryChannel}`],
    system_mode_entry: ['inputs.mode_entry'],
  };
  applyConfirmationLoopIngestion(recordField(spec, 'ingestion'), confirmationLoops);
  applyDocumentsIngestion(recordField(spec, 'ingestion'), documents);
  applyDelegationIngestion(recordField(spec, 'ingestion'), delegationChildren);

  spec.reactions = {
    capture_initial_entry_input: {
      event: 'AfterIngestion',
      watch: [`inputs.${entryChannel}`],
      write_scope: [initialEntryPath],
    },
  };
  applyStageOutputMirrorReactions(recordField(spec, 'reactions'), intermediateModes, flatMirrorStages);
  if (completion.collection_lifecycle && confirmationLoops.length === 0) {
    applyCollectionLifecycleReactions(recordField(spec, 'reactions'), completion.collection_lifecycle);
  }
  applyConfirmationLoopReactions(recordField(spec, 'reactions'), confirmationLoops, completion.collection_lifecycle);
  applyDocumentsReactions(recordField(spec, 'reactions'), documents);
  applyDelegationReactions(recordField(spec, 'reactions'), delegationChildren);

  spec.channels = {
    ...recordField(spec, 'channels'),
    [entryChannel]: { direction: 'In', sync: 'Async' },
    stage_output: { direction: 'Out', sync: 'Sync' },
  };
  if (completion.collection_lifecycle) {
    applyCollectionLifecycleIntentChannel(recordField(spec, 'channels'), completion.collection_lifecycle);
  }
  applyConfirmationLoopIntentChannel(recordField(spec, 'channels'), confirmationLoops, completion.collection_lifecycle);
  applyDocumentsChannel(recordField(spec, 'channels'), documents);
  applyDelegationChannel(recordField(spec, 'channels'), delegationChildren);
  applyControlPlaneEntryChannel(spec, entryChannel);

  const actionMap = recordField(spec, 'action_map');
  const placeholderActionName = ['example', 'action'].join('_');
  delete actionMap[placeholderActionName];
  if (!transitionActions.some((action) => action.name === 'begin_work')) {
    delete actionMap.begin_work;
  }
  for (const action of transitionActions) {
    if (suppressedTransitionActionNames.has(action.name)) {
      continue;
    }
    actionMap[action.name] = actionMapEntryFor(action, firstMode, stageDomainSpecBySlug.get(action.source), reasoningContractsBySlug.get(action.source));
  }
  if (completion.collection_lifecycle) {
    applyCollectionLifecycleIntentActions(actionMap, completion.collection_lifecycle);
  }
  applyConfirmationLoopIntentActions(actionMap, confirmationLoops, completion.collection_lifecycle);
  applyDocumentsActions(actionMap, documents);
  applyDocumentsActionPreconditions(synthesizedModes, documents, transitionActionsBySource);
  applyDelegationActions(actionMap, delegationChildren);
  applyDelegationActionPreconditions(synthesizedModes, delegationChildren, transitionActionsBySource);
  applyConfirmationLoopPairing(spec, confirmationLoops);

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
  applyConfirmationLoopSchema(schema, confirmationLoops, completion.collection_lifecycle);
  applyDocumentsSchema(schema, documents);
  applyDelegationSchema(schema, delegationChildren);

  spec.guidance = guidanceFor(intermediateModes, delegation, stageDomainSpecBySlug, reasoningContractsBySlug);
  applyConfirmationLoopGuidance(recordField(spec, 'guidance'), confirmationLoops, completion.collection_lifecycle);
  applyDocumentsPromptsGuidance(recordField(spec, 'guidance'), documents);
  applyDelegationGuidance(recordField(spec, 'guidance'), delegationChildren);

  const specYaml = dump(spec, { lineWidth: -1, noRefs: true, sortKeys: false });
  validateSynthesizedSpec(specYaml);
  const bodyStageSlugs = nonTerminalStageSlugs(stages, completion);

  const contractsTs = appendDocumentExtractionHostConnectorContracts(
    renderContractsSource(stages, stageClassification, transitionActions, reasoningContractsBySlug),
    documentExtractionGaps,
  );

  return {
    spec_yaml: specYaml,
    mode_names: modeNames,
    sha256: createHash('sha256').update(specYaml).digest('hex'),
    contracts_ts: contractsTs,
    handlers_ts: renderHandlersSource(transitionActions, {
      includeReactionHandlers: true,
      resolverImport: './handlers/_resolver.js',
      contractsImport: './contracts.js',
      stageImportPrefix: './stages',
      initialEntryPath,
      entryPath: `inputs.${entryChannel}`,
      flatMirrorStages,
      collectionLifecycle: completion.collection_lifecycle,
      confirmationLoops,
      delegationChildren,
      documents,
      docxExtractorImport: './extract/docx.js',
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
      confirmationLoops,
      delegationChildren,
      documents,
      docxExtractorImport: '../extract/docx.js',
    }, reasoningContractsBySlug),
    tools_ts: renderToolsSource(slug, transitionActions, reasoningContractsBySlug, completion.collection_lifecycle, confirmationLoops, documents),
    smoke_test_ts: renderSmokeTestSource(slug, name, entryChannel, stages, transitionActions, completion, reasoningContractsBySlug, confirmationLoops, delegationChildren, documents),
    ...(capabilityGaps.length > 0 ? { capability_gaps: capabilityGaps } : {}),
    ...(hasRegistrationPolicies ? {
      registration_ts: renderRegistrationSource(toPascalCase(slug), registrationPolicies),
    } : {}),
    ...(hasExportSurfaces(exportSurfaces) ? { export_surfaces: exportSurfaces } : {}),
    ...(hasDocumentExtractionSurfaces(documentExtractionSurfaces) ? { document_extraction_surfaces: documentExtractionSurfaces } : {}),
    ...(exportDescriptors.length > 0 ? { export_descriptors: exportDescriptors } : {}),
    ...(childArtifacts.length > 0 ? { child_artifacts: childArtifacts } : {}),
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
      ...(documents ? { documents } : {}),
      ...(hasExportSurfaces(exportSurfaces) ? { export_surfaces: exportSurfaces } : {}),
      ...(hasDocumentExtractionSurfaces(documentExtractionSurfaces) ? { document_extraction_surfaces: documentExtractionSurfaces } : {}),
      ...(exportDescriptors.length > 0 ? { export_descriptors: exportDescriptors } : {}),
      ...(interaction ? { interaction } : {}),
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
    ...(context.documents ? { 'intake.documents_json': JSON.stringify(context.documents) } : {}),
    'intake.completion_json': JSON.stringify(context.completion),
    ...(context.interaction ? { 'intake.interaction_json': JSON.stringify(context.interaction) } : {}),
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
      ...CONTROL_PLANE_ACTIONS,
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
  if (descriptor.storage.representation === 'indexed_array') {
    schema[descriptor.storage.items_path] = 'array';
    schema[`${descriptor.storage.items_path}.*`] = 'object';
    for (const [fieldName, fieldType] of Object.entries(descriptor.item.schema)) {
      schema[`${descriptor.storage.items_path}.*.${fieldName}`] = fieldType;
    }
    schema[`${descriptor.storage.items_path}.*.${descriptor.item.status_field}`] = 'string';
  } else {
    schema[descriptor.storage.items_path] = 'string';
  }
  schema[descriptor.storage.event_path] = 'string';
  schema[descriptor.storage.violation_path] = 'string';
  schema[descriptor.aggregate.guard_field] = 'boolean';
}

function applyCollectionLifecycleProjection(
  projection: MutableRecord,
  descriptor: CollectionLifecycleDescriptor,
): void {
  if (descriptor.storage.representation !== 'indexed_array') {
    return;
  }
  for (const transition of descriptor.transitions) {
    const modeProjection = recordField(projection, transition.stage);
    const include = Array.isArray(modeProjection.include) ? modeProjection.include as string[] : [];
    modeProjection.include = unique([...include, descriptor.storage.items_path]);
    if (!Array.isArray(modeProjection.exclude)) {
      modeProjection.exclude = [];
    }
  }
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

function applyDelegationChannel(
  channels: MutableRecord,
  children: DelegationChildDescriptor[],
): void {
  for (const child of children) {
    channels[delegationChannelName(child)] = {
      direction: 'Out',
      sync: 'Sync',
      target_spec: delegationTargetSpec(child),
      result_path: child.result_path,
      max_delegated_rounds: child.max_delegated_rounds,
      ...(child.round_timeout_ms !== undefined ? { round_timeout_ms: child.round_timeout_ms } : {}),
      optional: true,
    };
  }
  // Delegation continuation contract: when a Sync child returns, the engine fires
  // the inbound `system_query_result` channel to wake the parent. Engine >=3.23 is
  // strict — the spec MUST declare this channel (and its ingestion + schema, below)
  // or the DelegationConsumer continuation trigger fails `channel_not_declared`.
  // Mirrors every SimoneOS delegating program (fee-proposal-drafter, draft-policy).
  if (children.length > 0) {
    channels.system_query_result = { direction: 'In', sync: 'Async' };
  }
}

function applyDelegationSchema(
  schema: MutableRecord,
  children: DelegationChildDescriptor[],
): void {
  for (const child of children) {
    const base = delegationStateBase(child);
    schema[child.result_path] = 'object';
    schema[`${child.result_path}.status`] = 'string';
    schema[`${child.result_path}.sessionId`] = 'string';
    schema[`${child.result_path}.rounds`] = 'number';
    schema[`${child.result_path}.mode`] = 'string';
    schema[`${child.result_path}.reason`] = 'string';
    schema[`${child.result_path}.optional`] = 'boolean';
    schema[`${child.result_path}.result`] = 'object';
    if (child.synthesize_child?.kind === 'research_agent' && researchChildBackend(child) === 'host_connector') {
      schema[`${child.result_path}.result_json`] = 'string';
      schema[`${child.result_path}.adapter_kind`] = 'string';
    }
    for (const [field, type] of delegationResultFields(child)) {
      schema[`${child.result_path}.${field}`] = type;
    }
    schema[`${base}.settled`] = 'boolean';
    schema[`${base}.degraded`] = 'boolean';
    schema[`${base}.degrade_reason`] = 'string';
    schema[`${base}.requested`] = 'boolean';
  }
  // Base paths for the `system_query_result` continuation payload. The skeleton
  // declares sub-paths (inputs.query_meta.*, inputs.query_result.*); the ingestion
  // targets the BASE paths, so declare them or engine >=3.23 rejects with
  // CouplingError S-4 (path "inputs.query_meta" is not schema-declared).
  if (children.length > 0) {
    schema['inputs.query_meta'] = 'object';
    schema['inputs.query_result'] = 'any';
  }
}

function applyDelegationActions(
  actionMap: MutableRecord,
  children: DelegationChildDescriptor[],
): void {
  for (const child of children) {
    const actionName = delegationRequestActionName(child);
    if (Object.prototype.hasOwnProperty.call(actionMap, actionName)) {
      throw new Error(`delegation request action collides with generated action_map: ${actionName}`);
    }
    actionMap[actionName] = {
      channel: delegationChannelName(child),
      result_path: child.result_path,
      mutations: [
        { op: 'MSet', path: `${delegationStateBase(child)}.requested`, value: true },
      ],
      description: `Dispatch the ${child.id} child program and wait for the routed delegation result.`,
      arg_descriptions: {
        request: 'Object with the request for the child (include a short topic/query string).',
      },
    };
  }
}

function applyDelegationActionPreconditions(
  modes: MutableRecord,
  children: DelegationChildDescriptor[],
  transitionActionsBySource: Map<string, TransitionAction[]>,
): void {
  for (const child of children) {
    const mode = recordField(modes, child.stage);
    appendModePrecondition(
      mode,
      delegationRequestActionName(child),
      { kind: 'FieldFalsy', path: `${delegationStateBase(child)}.requested` },
    );
    for (const action of transitionActionsBySource.get(child.stage) ?? []) {
      appendModePrecondition(
        mode,
        action.name,
        { kind: 'FieldTruthy', path: `${delegationStateBase(child)}.settled` },
      );
    }
  }
}

function applyDelegationReactions(
  reactions: MutableRecord,
  children: DelegationChildDescriptor[],
): void {
  for (const child of children) {
    const base = delegationStateBase(child);
    reactions[delegationSettleReactionName(child)] = {
      event: 'AfterRound',
      watch: [],
      write_scope: [
        `${base}.settled`,
        `${base}.degraded`,
        `${base}.degrade_reason`,
      ],
    };
  }
}

function applyDelegationModeWiring(
  modes: MutableRecord,
  children: DelegationChildDescriptor[],
): void {
  for (const child of children) {
    const mode = recordField(modes, child.stage);
    const vocabulary = Array.isArray(mode.vocabulary) ? mode.vocabulary as string[] : [];
    const channels = Array.isArray(mode.channels) ? mode.channels as string[] : [];
    mode.vocabulary = unique([...vocabulary, delegationRequestActionName(child)]);
    // The delegation-awaiting mode must list the outbound `_call` channel AND the
    // inbound `system_query_result` continuation channel (engine >=3.23 rejects the
    // continuation event if the active mode does not permit the channel).
    mode.channels = unique([...channels, delegationChannelName(child), 'system_query_result']);
  }
}

function applyDelegationIngestion(
  ingestion: MutableRecord,
  children: DelegationChildDescriptor[],
): void {
  // Map the engine-fired `system_query_result` continuation payload to the declared
  // base paths so the strict (engine >=3.23) `no_ingestion_paths` check is satisfied.
  if (children.length > 0) {
    ingestion.system_query_result = ['inputs.query_meta', 'inputs.query_result'];
  }
}

function applyDelegationProjection(
  projection: MutableRecord,
  children: DelegationChildDescriptor[],
  modeNames: string[],
): void {
  for (const child of children) {
    const hostIndex = modeNames.indexOf(child.stage);
    const resultPaths = delegationResultProjectionPaths(child);
    const hostPaths = [
      ...resultPaths,
      `${delegationStateBase(child)}.settled`,
      `${delegationStateBase(child)}.degraded`,
      `${delegationStateBase(child)}.degrade_reason`,
    ];
    const hostProjection = recordField(projection, child.stage);
    const hostInclude = Array.isArray(hostProjection.include) ? hostProjection.include as string[] : [];
    hostProjection.include = unique([...hostInclude, ...hostPaths]);
    if (!Array.isArray(hostProjection.exclude)) {
      hostProjection.exclude = [];
    }
    for (const modeName of modeNames.slice(Math.max(hostIndex + 1, 0))) {
      const downstreamProjection = recordField(projection, modeName);
      const include = Array.isArray(downstreamProjection.include) ? downstreamProjection.include as string[] : [];
      downstreamProjection.include = unique([...include, ...resultPaths]);
      if (!Array.isArray(downstreamProjection.exclude)) {
        downstreamProjection.exclude = [];
      }
    }
  }
}

function applyDelegationPrompts(
  prompts: MutableRecord,
  children: DelegationChildDescriptor[],
): void {
  for (const child of children) {
    const existing = typeof prompts[child.stage] === 'string' ? `${prompts[child.stage]}\n` : '';
    prompts[child.stage] = `${existing}Call ${delegationRequestActionName(child)} once with a request object that includes a short topic or query string. When ${delegationStateBase(child)}.settled is true, proceed via the normal transition action. If ${delegationStateBase(child)}.degraded is true, proceed and note the degradation.`;
  }
}

function applyDelegationGuidance(
  guidance: MutableRecord,
  children: DelegationChildDescriptor[],
): void {
  for (const child of children) {
    const existing = Array.isArray(guidance[child.stage]) ? guidance[child.stage] as string[] : [];
    guidance[child.stage] = [
      ...existing,
      `Call ${delegationRequestActionName(child)} exactly once with a request object; deterministic payload enrichment supplies mapped parent state.`,
      `Wait until ${delegationStateBase(child)}.settled is true, then use the stage transition action.`,
      `If ${delegationStateBase(child)}.degraded is true, continue and preserve ${delegationStateBase(child)}.degrade_reason in your output.`,
    ];
  }
}

function applyDocumentsChannel(
  channels: MutableRecord,
  documents: DocumentsDescriptor | undefined,
): void {
  if (!documents) {
    return;
  }
  channels[DOCUMENT_UPLOAD_CHANNEL] = { direction: 'In', sync: 'Async' };
}

function applyDocumentsIngestion(
  ingestion: MutableRecord,
  documents: DocumentsDescriptor | undefined,
): void {
  if (!documents) {
    return;
  }
  ingestion[DOCUMENT_UPLOAD_CHANNEL] = [DOCUMENT_INTAKE_ROOT];
}

function applyDocumentsSchema(
  schema: MutableRecord,
  documents: DocumentsDescriptor | undefined,
): void {
  if (!documents) {
    return;
  }
  const resultPath = documents.result_path;
  schema[DOCUMENT_INTAKE_ROOT] = 'object';
  schema[`${DOCUMENT_INTAKE_ROOT}.file_refs`] = 'array';
  schema[`${DOCUMENT_INTAKE_ROOT}.file_refs.*`] = 'object';
  schema[`${DOCUMENT_INTAKE_ROOT}.file_refs.*.fileId`] = 'string';
  schema[`${DOCUMENT_INTAKE_ROOT}.file_refs.*.name`] = 'string';
  schema[`${DOCUMENT_INTAKE_ROOT}.file_refs.*.mimeType`] = 'string';
  schema[`${DOCUMENT_INTAKE_ROOT}.file_refs.*.size`] = 'number';
  schema[`${DOCUMENT_INTAKE_ROOT}.documents`] = 'array';
  schema[`${DOCUMENT_INTAKE_ROOT}.status`] = 'string';
  schema[`${DOCUMENT_INTAKE_ROOT}.source`] = 'string';
  schema[`${DOCUMENT_INTAKE_ROOT}.completed`] = 'boolean';
  schema[`${DOCUMENT_INTAKE_ROOT}.documents_requested`] = 'boolean';
  schema[DOCUMENTS_RECEIVED_PATH] = 'boolean';
  schema[resultPath] = 'object';
  schema[`${resultPath}.full_text`] = 'string';
  schema[`${resultPath}.char_count`] = 'number';
  schema[`${resultPath}.file_count`] = 'number';
  schema[`${resultPath}.files_json`] = 'string';
  schema[`${resultPath}.extraction_kind`] = 'string';
  schema[`${resultPath}.status`] = 'string';
  schema[`${resultPath}.reason`] = 'string';
  schema[documentsSourceReadyPath(documents)] = 'boolean';
}

function applyDocumentsActions(
  actionMap: MutableRecord,
  documents: DocumentsDescriptor | undefined,
): void {
  if (!documents) {
    return;
  }
  for (const actionName of [DOCUMENT_REQUEST_ACTION, DOCUMENT_INGEST_ACTION, ...(!documents.required ? [DOCUMENT_SKIP_ACTION] : [])]) {
    if (Object.prototype.hasOwnProperty.call(actionMap, actionName)) {
      throw new Error(`documents action collides with generated action_map: ${actionName}`);
    }
  }
  actionMap[DOCUMENT_REQUEST_ACTION] = {
    description: 'Ask the user to upload source text or markdown documents and park until document_upload arrives.',
    mutations: [
      { op: 'MSet', path: `${DOCUMENT_INTAKE_ROOT}.documents_requested`, value: true },
    ],
    channel: 'widget_output',
    awaits_user_decision: { channel: DOCUMENT_UPLOAD_CHANNEL, intent: 'request_file_upload' },
  };
  actionMap[DOCUMENT_INGEST_ACTION] = {
    description: 'Read engine-injected uploaded documents and write extracted text; call with no document-content arguments.',
    mutations: [],
    channel: 'stage_output',
    result_path: documents.result_path,
  };
  if (!documents.required) {
    actionMap[DOCUMENT_SKIP_ACTION] = {
      description: 'Acknowledge that optional source documents were skipped and advance with an explicit no-documents record.',
      mutations: [
        { op: 'MSet', path: `${documents.result_path}.status`, value: 'skipped_no_documents' },
        { op: 'MSet', path: `${documents.result_path}.full_text`, value: '' },
        { op: 'MSet', path: `${documents.result_path}.char_count`, value: 0 },
        { op: 'MSet', path: `${documents.result_path}.file_count`, value: 0 },
        { op: 'MSet', path: `${documents.result_path}.files_json`, value: '[]' },
        { op: 'MSet', path: `${documents.result_path}.extraction_kind`, value: 'skipped_no_documents' },
        { op: 'MSet', path: documentsSourceReadyPath(documents), value: true },
      ],
      channel: 'widget_output',
    };
  }
}

function applyDocumentsActionPreconditions(
  modes: MutableRecord,
  documents: DocumentsDescriptor | undefined,
  transitionActionsBySource: Map<string, TransitionAction[]>,
): void {
  if (!documents) {
    return;
  }
  const mode = recordField(modes, documents.stage);
  const readyPath = documentsSourceReadyPath(documents);
  appendModePrecondition(
    mode,
    DOCUMENT_REQUEST_ACTION,
    { kind: 'FieldFalsy', path: `${DOCUMENT_INTAKE_ROOT}.documents_requested` },
  );
  appendModePrecondition(
    mode,
    DOCUMENT_REQUEST_ACTION,
    { kind: 'FieldFalsy', path: readyPath },
  );
  appendModePrecondition(
    mode,
    DOCUMENT_INGEST_ACTION,
    { kind: 'FieldTruthy', path: DOCUMENTS_RECEIVED_PATH },
  );
  appendModePrecondition(
    mode,
    DOCUMENT_INGEST_ACTION,
    { kind: 'FieldFalsy', path: readyPath },
  );
  if (!documents.required) {
    appendModePrecondition(
      mode,
      DOCUMENT_SKIP_ACTION,
      { kind: 'FieldTruthy', path: `${DOCUMENT_INTAKE_ROOT}.status` },
    );
    appendModePrecondition(
      mode,
      DOCUMENT_SKIP_ACTION,
      { kind: 'FieldFalsy', path: readyPath },
    );
    appendModePrecondition(
      mode,
      DOCUMENT_SKIP_ACTION,
      { kind: 'FieldFalsy', path: `${DOCUMENT_INTAKE_ROOT}.file_refs.0.fileId` },
    );
  }
  for (const action of transitionActionsBySource.get(documents.stage) ?? []) {
    appendModePrecondition(
      mode,
      action.name,
      { kind: 'FieldTruthy', path: readyPath },
    );
  }
}

function applyDocumentsReactions(
  reactions: MutableRecord,
  documents: DocumentsDescriptor | undefined,
): void {
  if (!documents) {
    return;
  }
  reactions[documentsSaveReactionName()] = {
    event: 'AfterIngestion',
    watch: [
      DOCUMENT_INTAKE_ROOT,
      `${DOCUMENT_INTAKE_ROOT}.file_refs`,
      `${DOCUMENT_INTAKE_ROOT}.file_refs.0`,
      `${DOCUMENT_INTAKE_ROOT}.file_refs.0.fileId`,
      `${DOCUMENT_INTAKE_ROOT}.status`,
    ],
    write_scope: [DOCUMENTS_RECEIVED_PATH],
  };
  reactions[documentsSettleReactionName()] = {
    event: 'AfterRound',
    watch: [],
    write_scope: [
      documentsSourceReadyPath(documents),
      `${documents.result_path}.status`,
      `${documents.result_path}.full_text`,
      `${documents.result_path}.char_count`,
      `${documents.result_path}.file_count`,
      `${documents.result_path}.files_json`,
      `${documents.result_path}.extraction_kind`,
    ],
  };
}

function applyDocumentsModeWiring(
  modes: MutableRecord,
  documents: DocumentsDescriptor | undefined,
): void {
  if (!documents) {
    return;
  }
  const mode = recordField(modes, documents.stage);
  const vocabulary = Array.isArray(mode.vocabulary) ? mode.vocabulary as string[] : [];
  const channels = Array.isArray(mode.channels) ? mode.channels as string[] : [];
  mode.vocabulary = unique([
    ...vocabulary,
    DOCUMENT_REQUEST_ACTION,
    DOCUMENT_INGEST_ACTION,
    ...(!documents.required ? [DOCUMENT_SKIP_ACTION] : []),
  ]);
  mode.channels = unique([...channels, DOCUMENT_UPLOAD_CHANNEL, 'widget_output', 'stage_output']);
}

function applyDocumentsProceedTo(
  proceedTo: MutableRecord,
  documents: DocumentsDescriptor | undefined,
  transitionActionsBySource: Map<string, TransitionAction[]>,
): void {
  if (!documents || documents.required) {
    return;
  }
  const target = transitionActionsBySource.get(documents.stage)?.[0]?.target;
  if (target) {
    proceedTo[DOCUMENT_SKIP_ACTION] = target;
  }
}

function applyDocumentsProjection(
  projection: MutableRecord,
  documents: DocumentsDescriptor | undefined,
  modeNames: string[],
): void {
  if (!documents) {
    return;
  }
  const hostIndex = modeNames.indexOf(documents.stage);
  const hostProjection = recordField(projection, documents.stage);
  const hostInclude = Array.isArray(hostProjection.include) ? hostProjection.include as string[] : [];
  const hostPaths = [
    DOCUMENT_INTAKE_ROOT,
    `${DOCUMENT_INTAKE_ROOT}.status`,
    `${DOCUMENT_INTAKE_ROOT}.documents_requested`,
    `${DOCUMENT_INTAKE_ROOT}.file_refs`,
    `${DOCUMENT_INTAKE_ROOT}.file_refs.0`,
    `${DOCUMENT_INTAKE_ROOT}.file_refs.0.fileId`,
    DOCUMENTS_RECEIVED_PATH,
    documents.result_path,
    `${documents.result_path}.status`,
    `${documents.result_path}.full_text`,
    `${documents.result_path}.char_count`,
    `${documents.result_path}.file_count`,
    `${documents.result_path}.files_json`,
    `${documents.result_path}.extraction_kind`,
    documentsSourceReadyPath(documents),
  ];
  hostProjection.include = unique([...hostInclude, ...hostPaths]);
  if (!Array.isArray(hostProjection.exclude)) {
    hostProjection.exclude = [];
  }

  const downstreamPaths = [
    documents.result_path,
    `${documents.result_path}.status`,
    `${documents.result_path}.full_text`,
    `${documents.result_path}.char_count`,
    `${documents.result_path}.file_count`,
    `${documents.result_path}.files_json`,
    `${documents.result_path}.extraction_kind`,
    documentsSourceReadyPath(documents),
  ];
  for (const modeName of modeNames.slice(Math.max(hostIndex + 1, 0))) {
    const downstreamProjection = recordField(projection, modeName);
    const include = Array.isArray(downstreamProjection.include) ? downstreamProjection.include as string[] : [];
    downstreamProjection.include = unique([...include, ...downstreamPaths]);
    if (!Array.isArray(downstreamProjection.exclude)) {
      downstreamProjection.exclude = [];
    }
  }
}

function applyDocumentsPromptsGuidance(
  target: MutableRecord,
  documents: DocumentsDescriptor | undefined,
): void {
  if (!documents) {
    return;
  }
  const existing = Array.isArray(target[documents.stage])
    ? target[documents.stage] as string[]
    : typeof target[documents.stage] === 'string'
      ? [target[documents.stage] as string]
      : [];
  const lines = [
    `Call ${DOCUMENT_REQUEST_ACTION} once to request the upload and wait for ${DOCUMENT_UPLOAD_CHANNEL}.`,
    `After uploaded file references arrive, call ${DOCUMENT_INGEST_ACTION} with no document-content arguments; the handler reads engine-injected request.documents content_text.`,
    `When ${documentsSourceReadyPath(documents)} is true, proceed through the normal transition action. If the user skipped optional documents, note the skipped source record and proceed.`,
  ];
  target[documents.stage] = Array.isArray(target[documents.stage])
    ? [...existing, ...lines]
    : `${existing.join('\n')}${existing.length > 0 ? '\n' : ''}${lines.join('\n')}`;
}

function documentsSourceReadyPath(documents: DocumentsDescriptor): string {
  const parts = documents.result_path.split('.');
  const leaf = parts.pop() ?? 'source';
  return [...parts, `${leaf}_ready`].join('.');
}

function documentsSaveReactionName(): string {
  return 'save_document_intake';
}

function documentsSettleReactionName(): string {
  return 'settle_document_source';
}

function completionWithDocumentsReadyGuard(
  completion: Completion,
  documents: DocumentsDescriptor,
): Completion {
  return {
    ...completion,
    guard_field: documentsSourceReadyPath(documents),
  };
}

function transitionsWithDocumentsReadyGuard(
  transitions: IntakeTransition[],
  documents: DocumentsDescriptor,
): IntakeTransition[] {
  const readyPath = documentsSourceReadyPath(documents);
  return transitions.map((transition) =>
    transition.from === documents.stage
      ? {
          ...transition,
          guard_field: readyPath,
        }
      : transition);
}

function appendModePrecondition(
  mode: MutableRecord,
  actionName: string,
  predicate: Record<string, unknown>,
): void {
  const raw = mode.preconditions;
  if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) {
    throw new Error('mode preconditions must be a mapping');
  }
  const preconditions = (raw ?? {}) as MutableRecord;
  const current = Array.isArray(preconditions[actionName]) ? preconditions[actionName] as Record<string, unknown>[] : [];
  preconditions[actionName] = [...current, predicate];
  mode.preconditions = preconditions;
}

function delegationChannelName(child: DelegationChildDescriptor): string {
  return `${child.id}_call`;
}

function delegationRequestActionName(child: DelegationChildDescriptor): string {
  return `request_${child.id}`;
}

function delegationSettleReactionName(child: DelegationChildDescriptor): string {
  return `settle_${child.id}_delegation`;
}

function delegationStateBase(child: DelegationChildDescriptor): string {
  return `${child.stage}.delegation.${child.id}`;
}

function delegationTargetSpec(child: DelegationChildDescriptor): string {
  if (child.target_spec) {
    return child.target_spec;
  }
  const childSlug = child.synthesize_child?.slug?.trim();
  return childSlug && childSlug.length > 0 ? childSlug : child.id;
}

function delegationResultFields(child: DelegationChildDescriptor): Array<[string, string]> {
  return Object.entries(child.synthesize_child?.result_fields ?? {});
}

function delegationResultProjectionPaths(child: DelegationChildDescriptor): string[] {
  return unique([
    child.result_path,
    `${child.result_path}.status`,
    `${child.result_path}.reason`,
    `${child.result_path}.optional`,
    `${child.result_path}.mode`,
    `${child.result_path}.rounds`,
    `${child.result_path}.sessionId`,
    `${child.result_path}.result`,
    ...(child.synthesize_child?.kind === 'research_agent' && researchChildBackend(child) === 'host_connector'
      ? [`${child.result_path}.result_json`, `${child.result_path}.adapter_kind`]
      : []),
    ...delegationResultFields(child).map(([field]) => `${child.result_path}.${field}`),
  ]);
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

function applyConfirmationLoopIntentChannel(
  channels: MutableRecord,
  loops: ConfirmationLoopDescriptor[],
  lifecycle?: CollectionLifecycleDescriptor,
): void {
  if (loops.length === 0 || !lifecycle) {
    return;
  }
  const loop = loops[0] as ConfirmationLoopDescriptor;
  channels[USER_CONFIRMATION_CHANNEL] = {
    direction: 'In',
    sync: 'Async',
    structured_decision: true,
    decision_targeting: {
      collection: loop.collection,
      status_field: lifecycle.item.status_field,
      status_equals: loop.proposed_status,
      select: 'first',
      index_path: 'inputs.user_decision.target_item_index',
      id_path: 'inputs.user_decision.target_item_id',
      title_path: 'inputs.user_decision.target_item_title',
      status_path: 'inputs.user_decision.target_item_status',
    },
  };
}

function applyConfirmationLoopIngestion(
  ingestion: MutableRecord,
  loops: ConfirmationLoopDescriptor[],
): void {
  if (loops.length === 0) {
    return;
  }
  ingestion[USER_CONFIRMATION_CHANNEL] = USER_DECISION_INGESTION_PATHS;
}

function applyConfirmationLoopReactions(
  reactions: MutableRecord,
  loops: ConfirmationLoopDescriptor[],
  lifecycle?: CollectionLifecycleDescriptor,
): void {
  if (!lifecycle) {
    return;
  }
  for (const loop of loops) {
    reactions[confirmationLoopSaveReactionName(loop)] = {
      event: 'AfterIngestion',
      watch: [
        'inputs.user_decision.decision',
        'inputs.user_decision.instruction',
        'inputs.user_decision.timestamp',
        'inputs.user_decision.target_item_index',
      ],
      write_scope: [confirmationLoopPendingPath(loop)],
    };
    reactions[confirmationLoopEnforceReactionName(loop)] = {
      event: 'AfterIngestion',
      watch: ['inputs.user_decision.decision', 'inputs.user_decision.timestamp'],
      write_scope: unique([
        `${loop.collection}.*.${lifecycle.item.status_field}`,
        ...confirmationLoopInstructionPaths(loop),
        confirmationLoopViolationPath(loop, lifecycle),
        confirmationLoopDemotionCounterPath(loop),
        confirmationLoopAppliedDecisionPath(loop),
        loop.aggregate.guard_field,
      ]),
    };
    reactions[confirmationLoopChoreographReactionName(loop)] = {
      event: 'AfterRound',
      watch: [],
      write_scope: [
        `${loop.collection}.*`,
        confirmationLoopAppliedProposalCountPath(loop),
        confirmationLoopSeedStatePath(loop),
      ],
    };
  }
}

function applyConfirmationLoopIntentModeWiring(
  modes: MutableRecord,
  loops: ConfirmationLoopDescriptor[],
): void {
  loops.forEach((loop, index) => {
    const mode = recordField(modes, loop.stage);
    mode.vocabulary = [
      confirmationLoopProposeActionName(loop, index, loops.length),
      ...CONTROL_PLANE_ACTIONS,
    ];
    const channels = Array.isArray(mode.channels) ? mode.channels as string[] : [];
    mode.channels = unique([...channels, USER_CONFIRMATION_CHANNEL, 'widget_output']);
  });
}

function applyConfirmationLoopProjection(
  projection: MutableRecord,
  loops: ConfirmationLoopDescriptor[],
  lifecycle?: CollectionLifecycleDescriptor,
): void {
  if (!lifecycle) {
    return;
  }
  for (const loop of loops) {
    const modeProjection = recordField(projection, loop.stage);
    const include = Array.isArray(modeProjection.include) ? modeProjection.include as string[] : [];
    const idField = loop.item_id_field ?? lifecycle.item.id_field;
    const titleField = loop.item_title_field ?? 'title';
    modeProjection.include = unique([
      ...include.filter((path) => path !== loop.collection),
      'inputs.user_decision.target_item_index',
      'inputs.user_decision.target_item_id',
      'inputs.user_decision.target_item_title',
      'inputs.user_decision.target_item_status',
      `${loop.collection}.*.${idField}`,
      `${loop.collection}.*.${titleField}`,
      `${loop.collection}.*.${lifecycle.item.status_field}`,
      loop.aggregate.guard_field,
      confirmationLoopSummaryPath(loop),
      `${loop.seed.source_stage}.items_json`,
    ]);
    if (!Array.isArray(modeProjection.exclude)) {
      modeProjection.exclude = [];
    }
  }
}

function applyConfirmationLoopPrompts(
  prompts: MutableRecord,
  loops: ConfirmationLoopDescriptor[],
  lifecycle?: CollectionLifecycleDescriptor,
): void {
  if (!lifecycle) {
    return;
  }
  for (const loop of loops) {
    const itemLabel = lifecycle.item_label;
    const itemLabelPlural = `${itemLabel}s`;
    const existing = typeof prompts[loop.stage] === 'string' ? `${prompts[loop.stage]}\n` : '';
    prompts[loop.stage] = `${existing}Work through the ${itemLabelPlural} one at a time. The projected ${loop.collection}.* entries show each item and its status. Call ${confirmationLoopProposeActionName(loop, 0, loops.length)} with the proposal content for the item under review; the runtime selects the target item and pauses for the user's decision. Never write item statuses yourself. A revise decision includes the user's instruction on the item; call ${confirmationLoopProposeActionName(loop, 0, loops.length)} again with revised content. When ${loop.aggregate.guard_field} is true, all items are resolved and the session advances.`;
  }
}

function applyConfirmationLoopGuidance(
  guidance: MutableRecord,
  loops: ConfirmationLoopDescriptor[],
  lifecycle?: CollectionLifecycleDescriptor,
): void {
  if (!lifecycle) {
    return;
  }
  for (const loop of loops) {
    const existing = Array.isArray(guidance[loop.stage]) ? guidance[loop.stage] as string[] : [];
    guidance[loop.stage] = [
      ...existing,
      `Work through the ${lifecycle.item_label}s one at a time; the runtime selects the target item for ${confirmationLoopProposeActionName(loop, 0, loops.length)}.`,
      'never write item statuses yourself; status changes are deterministic reaction-owned state.',
      `When ${loop.aggregate.guard_field} is true, all items are resolved and the session advances.`,
    ];
  }
}

function applyConfirmationLoopIntentActions(
  actionMap: MutableRecord,
  loops: ConfirmationLoopDescriptor[],
  lifecycle?: CollectionLifecycleDescriptor,
): void {
  if (!lifecycle) {
    return;
  }
  loops.forEach((loop, index) => {
    const actionName = confirmationLoopProposeActionName(loop, index, loops.length);
    if (Object.prototype.hasOwnProperty.call(actionMap, actionName)) {
      throw new Error(`confirmation_loop propose action collides with generated action_map: ${actionName}`);
    }
    const contentMutations = confirmationLoopProposalFields(loop, lifecycle)
      .map((field) => ({
        op: 'MSet',
        path: confirmationLoopProposalFieldPath(loop, field),
        value: '',
        from_arg: field,
      }));
    actionMap[actionName] = {
      description: `Propose ${lifecycle.item_label} content for user confirmation. The runtime selects the item under review; do not attempt to pick or write items.`,
      mutations: [
        ...contentMutations,
        { op: 'MAppend', path: confirmationLoopProposalLogPath(loop), value: 'proposed' },
      ],
      channel: 'widget_output',
      awaits_user_decision: { channel: USER_CONFIRMATION_CHANNEL, intent: 'present_for_approval' },
    };
    for (const decisionActionName of confirmationLoopDecisionActionNames(loop, index, loops.length)) {
      if (Object.prototype.hasOwnProperty.call(actionMap, decisionActionName)) {
        throw new Error(`confirmation_loop decision action collides with generated action_map: ${decisionActionName}`);
      }
      actionMap[decisionActionName] = {
        description: `Acknowledge a user confirmation decision for ${lifecycle.item_label}; status writes are reaction-owned.`,
        mutations: [],
        channel: 'widget_output',
      };
    }
  });
}

function applyConfirmationLoopPairing(
  spec: MutableRecord,
  loops: ConfirmationLoopDescriptor[],
): void {
  if (loops.length === 0) {
    return;
  }
  spec.confirmation_pairing = {
    prefixes: unique(loops.map((loop) => loop.collection)),
    policy: 'reject',
    terminals: unique(loops.flatMap((loop, index) => [
      confirmationLoopProposeActionName(loop, index, loops.length),
      ...confirmationLoopDecisionActionNames(loop, index, loops.length),
    ])),
  };
}

function applyConfirmationLoopSchema(
  schema: MutableRecord,
  loops: ConfirmationLoopDescriptor[],
  lifecycle?: CollectionLifecycleDescriptor,
): void {
  if (loops.length === 0 || !lifecycle) {
    return;
  }
  schema['inputs.user_decision'] = 'object';
  schema['inputs.user_decision.decision'] = 'string';
  schema['inputs.user_decision.instruction'] = 'string';
  schema['inputs.user_decision.note_mode'] = 'string';
  schema['inputs.user_decision.timestamp'] = 'string';
  schema['inputs.user_decision.target_item_index'] = 'number';
  schema['inputs.user_decision.target_item_id'] = 'string';
  schema['inputs.user_decision.target_item_title'] = 'string';
  schema['inputs.user_decision.target_item_status'] = 'string';
  for (const loop of loops) {
    schema[confirmationLoopPendingPath(loop)] = 'string';
    schema[confirmationLoopViolationPath(loop, lifecycle)] = 'string';
    schema[confirmationLoopSummaryPath(loop)] = 'object';
    schema[confirmationLoopDemotionCounterPath(loop)] = 'number';
    schema[confirmationLoopAppliedDecisionPath(loop)] = 'string';
    schema[confirmationLoopProposalPath(loop)] = 'object';
    for (const field of confirmationLoopProposalFields(loop, lifecycle)) {
      schema[confirmationLoopProposalFieldPath(loop, field)] = 'string';
    }
    schema[confirmationLoopProposalLogPath(loop)] = 'array';
    schema[confirmationLoopAppliedProposalCountPath(loop)] = 'number';
    schema[confirmationLoopSeedStatePath(loop)] = 'string';
    schema[loop.aggregate.guard_field] = 'boolean';
  }
}

function confirmationLoopSaveReactionName(loop: ConfirmationLoopDescriptor): string {
  return `save_${safeIdentifier(loop.stage)}_decision`;
}

function confirmationLoopEnforceReactionName(loop: ConfirmationLoopDescriptor): string {
  return `enforce_${safeIdentifier(loop.stage)}_status`;
}

function confirmationLoopChoreographReactionName(loop: ConfirmationLoopDescriptor): string {
  return `choreograph_${safeIdentifier(loop.stage)}_collection`;
}

function confirmationLoopProposeActionName(
  loop: ConfirmationLoopDescriptor,
  index: number,
  total: number,
): string {
  void index;
  return total === 1 ? PROPOSE_ITEM_ACTION : `propose_${safeIdentifier(loop.stage)}_item`;
}

function confirmationLoopDecisionActionNames(
  loop: ConfirmationLoopDescriptor,
  index: number,
  total: number,
): string[] {
  void index;
  return Object.keys(loop.decisions).map((decision) => {
    const runtimeDecision = confirmationLoopRuntimeDecisionName(decision);
    return total === 1
      ? `${safeIdentifier(runtimeDecision)}_item`
      : `${safeIdentifier(runtimeDecision)}_${safeIdentifier(loop.stage)}_item`;
  },
  );
}

function confirmationLoopPendingPath(loop: ConfirmationLoopDescriptor): string {
  return loop.pending_action_path ?? `decisions.pending_${safeIdentifier(loop.stage)}_action`;
}

function confirmationLoopRuntimeDecisionName(decision: string): string {
  if (decision === 'revise') return 'request_revision';
  if (decision === 'skip') return 'reject';
  return decision;
}

function confirmationLoopRuntimeDecisions(
  decisions: Record<string, ConfirmationLoopDecisionDescriptor>,
): Record<string, ConfirmationLoopDecisionDescriptor> {
  return Object.fromEntries(
    Object.entries(decisions).map(([decision, config]) => [confirmationLoopRuntimeDecisionName(decision), config]),
  );
}

function confirmationLoopSummaryPath(loop: ConfirmationLoopDescriptor): string {
  return loop.summary_path ?? `summary.${safeIdentifier(loop.stage)}`;
}

function confirmationLoopViolationPath(
  loop: ConfirmationLoopDescriptor,
  lifecycle: CollectionLifecycleDescriptor,
): string {
  return loop.violation_path ?? lifecycle.storage.violation_path;
}

function confirmationLoopDemotionCounterPath(loop: ConfirmationLoopDescriptor): string {
  return `${confirmationLoopSummaryPath(loop)}.one_proposed_demotions`;
}

function confirmationLoopAppliedDecisionPath(loop: ConfirmationLoopDescriptor): string {
  return `${confirmationLoopSummaryPath(loop)}.last_applied_decision`;
}

function confirmationLoopProposalPath(loop: ConfirmationLoopDescriptor): string {
  return `${safeIdentifier(loop.stage)}.proposal`;
}

function confirmationLoopProposalFieldPath(loop: ConfirmationLoopDescriptor, field: string): string {
  return `${confirmationLoopProposalPath(loop)}.${field}`;
}

function confirmationLoopProposalLogPath(loop: ConfirmationLoopDescriptor): string {
  return `${confirmationLoopProposalPath(loop)}.log`;
}

function confirmationLoopAppliedProposalCountPath(loop: ConfirmationLoopDescriptor): string {
  return `${confirmationLoopSummaryPath(loop)}.applied_proposal_count`;
}

function confirmationLoopSeedStatePath(loop: ConfirmationLoopDescriptor): string {
  return `${confirmationLoopSummaryPath(loop)}.seed_state`;
}

function confirmationLoopInstructionPaths(loop: ConfirmationLoopDescriptor): string[] {
  return Object.values(loop.decisions)
    .map((decision) => decision.instruction_path)
    .filter((path): path is string => typeof path === 'string' && path.length > 0);
}

function confirmationLoopInstructionFields(loop: ConfirmationLoopDescriptor): Set<string> {
  return new Set(
    confirmationLoopInstructionPaths(loop)
      .map((path) => path.split('.').filter(Boolean).at(-1))
      .filter((field): field is string => typeof field === 'string' && field.length > 0),
  );
}

function confirmationLoopProposalFields(
  loop: ConfirmationLoopDescriptor,
  lifecycle: CollectionLifecycleDescriptor,
): string[] {
  const idField = loop.item_id_field ?? lifecycle.item.id_field;
  const titleField = loop.item_title_field ?? 'title';
  const statusField = lifecycle.item.status_field;
  const instructionFields = confirmationLoopInstructionFields(loop);
  return Object.keys(lifecycle.item.schema)
    .filter((field) =>
      field !== idField &&
      field !== titleField &&
      field !== statusField &&
      !instructionFields.has(field));
}

function confirmationLoopSeedSchemaFields(
  loop: ConfirmationLoopDescriptor,
  lifecycle: CollectionLifecycleDescriptor,
): string[] {
  const idField = loop.item_id_field ?? lifecycle.item.id_field;
  const titleField = loop.item_title_field ?? 'title';
  const statusField = lifecycle.item.status_field;
  return Object.keys(lifecycle.item.schema)
    .filter((field) => field !== idField && field !== titleField && field !== statusField);
}

function confirmationLoopSeedForcedEmptyFields(
  loop: ConfirmationLoopDescriptor,
  lifecycle: CollectionLifecycleDescriptor,
): string[] {
  const instructionFields = confirmationLoopInstructionFields(loop);
  return confirmationLoopSeedSchemaFields(loop, lifecycle)
    .filter((field) => field === 'proposed_text' || field === 'user_instruction' || instructionFields.has(field));
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
      ...(classification?.export_kind ? { export_kind: classification.export_kind } : {}),
      ...(classification?.integration_name ? { integration_name: classification.integration_name } : {}),
      ...(classification?.integration_import ? { integration_import: classification.integration_import } : {}),
      ...(classification?.integration_method ? { integration_method: classification.integration_method } : {}),
      ...(classification?.integration_gap ? { integration_gap: true } : {}),
      ...(classification?.audit_note ? { audit_note: classification.audit_note } : {}),
    };
  });
}

function exportDescriptorsFor(
  stages: Stage[],
  demands: ReadonlyArray<{ capability: string }>,
  programName: string,
): ExportStageDescriptor[] {
  const descriptors: ExportStageDescriptor[] = [];
  const usedStages = new Set<string>();
  const addDescriptor = (stage: string, kind: ExportStageDescriptor['kind']): void => {
    if (usedStages.has(stage)) {
      return;
    }
    usedStages.add(stage);
    const docx = kind === 'export_docx';
    descriptors.push({
      stage,
      kind,
      title: docx ? `${programName} DOCX Export` : `${programName} HTML Export`,
      artifactType: docx ? 'docx_export' : 'html_export',
      payloadRef: `${stage}.output`,
    });
  };

  for (const stage of stages) {
    const kind = explicitStageExportKind(stage);
    if (kind && !stage.is_bootstrap && !stage.is_terminal) {
      addDescriptor(stage.slug, kind);
    }
  }

  const demandedKinds = new Set<ExportStageDescriptor['kind']>();
  if (demands.some((demand) => demand.capability === 'export_docx_plain')) {
    demandedKinds.add('export_docx');
  }
  if (demands.some((demand) => demand.capability === 'export_html')) {
    demandedKinds.add('export_html');
  }

  for (const kind of demandedKinds) {
    if (descriptors.some((descriptor) => descriptor.kind === kind)) {
      continue;
    }
    const stage = chooseExportStageForDemand(stages, kind, usedStages);
    if (stage) {
      addDescriptor(stage.slug, kind);
    }
  }

  const stageOrder = new Map(stages.map((stage, index) => [stage.slug, index]));
  return descriptors.sort((left, right) => (stageOrder.get(left.stage) ?? 0) - (stageOrder.get(right.stage) ?? 0));
}

function exportSurfacesFor(
  descriptors: readonly ExportStageDescriptor[],
  demands: ReadonlyArray<{ capability: string }>,
): ExportSurfaces {
  const surfaces: ExportSurfaces = {
    ...(descriptors.some((descriptor) => descriptor.kind === 'export_docx') || demands.some((demand) => demand.capability === 'export_docx_plain')
      ? { docx: true }
      : {}),
    ...(descriptors.some((descriptor) => descriptor.kind === 'export_html') || demands.some((demand) => demand.capability === 'export_html')
      ? { html: true }
      : {}),
  };
  return surfaces;
}

function hasExportSurfaces(surfaces: ExportSurfaces): boolean {
  return surfaces.docx === true || surfaces.html === true || surfaces.diff === true;
}

function documentExtractionSurfacesFor(documents: DocumentsDescriptor | undefined): DocumentExtractionSurfaces {
  if (documentsDemandsSelfContainedDocx(documents)) {
    return { docx: true };
  }
  return {};
}

function hasDocumentExtractionSurfaces(surfaces: DocumentExtractionSurfaces): boolean {
  return surfaces.docx === true;
}

function documentsDemandsSelfContainedDocx(documents: DocumentsDescriptor | undefined): boolean {
  return documents?.extraction === 'self_contained' && documents.upload_types.some(isDocxMimeType);
}

function documentsDemandsHostConnectorPdf(documents: DocumentsDescriptor | undefined): boolean {
  return documents?.extraction === 'host_connector' && documents.upload_types.some(isPdfMimeType);
}

function isDocxMimeType(value: string): boolean {
  return value.toLowerCase() === DOCX_MIME_TYPE;
}

function isPdfMimeType(value: string): boolean {
  return value.toLowerCase() === PDF_MIME_TYPE;
}

function capabilityGapsForDocumentExtraction(documents: DocumentsDescriptor | undefined): CapabilityGap[] {
  if (!documentsDemandsHostConnectorPdf(documents)) {
    return [];
  }
  const connectorSlug = documentExtractionPdfConnectorSlug(documents!);
  return [{
    capability: 'document_extraction_pdf',
    stage: documents!.stage,
    connector_slug: connectorSlug,
    message: `PDF text extraction is host-required — implement the ${connectorSlug} connector; scanned/OCR extraction is out of foundry scope.`,
  }];
}

function documentExtractionPdfConnectorSlug(documents: DocumentsDescriptor): string {
  const slug = documents.connector_slug?.trim();
  return slug && slug.length > 0 ? slug : 'pdf_text_extractor';
}

function applyExportDescriptorsToClassifications(
  stages: ClassifiedStage[],
  descriptors: readonly ExportStageDescriptor[],
): ClassifiedStage[] {
  const byStage = new Map(descriptors.map((descriptor) => [descriptor.stage, descriptor]));
  return stages.map((stage) => {
    const descriptor = byStage.get(stage.slug);
    if (!descriptor) {
      return stage;
    }
    return {
      slug: stage.slug,
      archetype: 'pure-compute',
      export_kind: descriptor.kind,
      rationale: `pure compute export: ${stage.slug} is bound to ${descriptor.kind} descriptor ${descriptor.payloadRef}.`,
    };
  });
}

function explicitStageExportKind(stage: Stage): ExportStageDescriptor['kind'] | undefined {
  const raw = [stage.kind, stage.export_kind]
    .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0)
    ?.trim()
    .toLowerCase();
  if (raw === 'export_docx' || raw === 'docx_export') return 'export_docx';
  if (raw === 'export_html' || raw === 'html_export') return 'export_html';
  return undefined;
}

function chooseExportStageForDemand(
  stages: Stage[],
  kind: ExportStageDescriptor['kind'],
  usedStages: ReadonlySet<string>,
): Stage | undefined {
  const candidates = stages.filter((stage) => !stage.is_bootstrap && !stage.is_terminal && !usedStages.has(stage.slug));
  const wanted = kind === 'export_docx' ? /(?:docx|word|export|render|assemble|format)/u : /(?:html|export|render|assemble|format)/u;
  return candidates.find((stage) => wanted.test(exportStageHaystack(stage))) ?? candidates.at(-1);
}

function exportStageHaystack(stage: Stage): string {
  return [
    stage.slug,
    stage.kind,
    stage.export_kind,
    stage.domain_spec ? JSON.stringify(stage.domain_spec) : '',
  ].filter((value): value is string => typeof value === 'string').join(' ').toLowerCase();
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

// Confirmation-loop stages advance via the aggregate guard (work.items_all_terminal),
// NOT a generated complete_<stage> transition action — so the action_map + proceed_to
// suppress those transition actions (see suppressedTransitionActionNames). The
// handler/tool codegen MUST apply the same suppression, or the generated program emits
// an orphaned complete_<stage> handler/tool and the engine's validateSpecWiring rejects
// it at boot (HANDLER_NO_ACTION) — the exact defect the confirmation live-drive caught.
function codegenStageActions(
  transitionActions: TransitionAction[],
  confirmationLoops: ConfirmationLoopDescriptor[],
): TransitionAction[] {
  const loopStageNames = new Set(confirmationLoops.map((loop) => loop.stage));
  return transitionActions.filter(
    (action) => action.name !== 'begin_work' && !loopStageNames.has(action.source),
  );
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
    confirmationLoops: ConfirmationLoopDescriptor[];
    delegationChildren: DelegationChildDescriptor[];
    documents?: DocumentsDescriptor;
    docxExtractorImport?: string;
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
  const confirmationLoops = options.collectionLifecycle ? options.confirmationLoops : [];
  const stageActions = codegenStageActions(transitionActions, confirmationLoops);
  const lifecycleTransitions = options.collectionLifecycle
    ? collectionLifecycleLlmTransitions(options.collectionLifecycle)
    : [];
  const usesIndexedCollectionLifecycle = options.includeReactionHandlers &&
    options.collectionLifecycle?.storage.representation === 'indexed_array';
  const usesConfirmationLoopHandlers = options.includeReactionHandlers && confirmationLoops.length > 0;
  const usesDelegationHandlers = options.includeReactionHandlers && options.delegationChildren.length > 0;
  const usesDocumentHandlers = options.documents !== undefined;
  const usesDocumentReactionHandlers = options.includeReactionHandlers && options.documents !== undefined;
  const usesDocxExtractor = documentsDemandsSelfContainedDocx(options.documents);
  const bodyActions = unique(stageActions.filter((action) => action.archetype !== 'llm-reasoning').map((action) => action.source));
  const stageImports = bodyActions
    .map((stage) => `import { runStage as run${toPascalCase(stage)} } from ${tsString(`${options.stageImportPrefix}/${stage}.js`)};`)
    .join('\n');
  const contractsImport = bodyActions.length > 0
    ? `import { createStageRuntime, normalizeStageOutput, resolveStageInput } from ${tsString(options.contractsImport)};`
    : '';
  const docxExtractorImport = usesDocxExtractor
    ? `import { extractDocxText } from ${tsString(options.docxExtractorImport ?? './extract/docx.js')};`
    : '';
  const docxExtractorImportBlock = docxExtractorImport ? `${docxExtractorImport}\n` : '';
  const sessionControlHandlers = CONTROL_PLANE_ACTIONS
    .filter((action) => action !== 'record_user_note')
    .map((action) => `  async ${action}(payload) {
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
  const documentActionHandlers = options.documents
    ? renderDocumentActionHandlers(options.documents)
    : '';
  const stageOutputMirrorReactionEntries = options.includeReactionHandlers
    ? bodyActions.filter((stage) => options.flatMirrorStages.has(stage)).map((stage) => `,
  [${tsString(stageOutputMirrorReactionName(stage))}, (snapshot) => mirrorStageOutput(snapshot, ${tsString(`${stage}.output`)}, ${tsString(`${stage}.result_json`)}, ${tsString(`${stage}.items_json`)})]`).join('')
    : '';
  const reactionImport = options.includeReactionHandlers
    ? `ReactionHandler, ${stageOutputMirrorReactionEntries || usesConfirmationLoopHandlers || usesDelegationHandlers || usesDocumentReactionHandlers ? 'ReactionResult, ' : ''}`
    : '';
  const reactionMapConstructor = stageOutputMirrorReactionEntries || usesConfirmationLoopHandlers || usesDelegationHandlers || usesDocumentReactionHandlers ? 'new Map<string, ReactionHandler>' : 'new Map';
  const lifecycleReactionEntries = options.includeReactionHandlers && options.collectionLifecycle
    ? renderCollectionLifecycleReactionEntry(options.collectionLifecycle)
    : '';
  const confirmationReactionEntries = usesConfirmationLoopHandlers && options.collectionLifecycle
    ? renderConfirmationLoopReactionEntries(confirmationLoops, options.collectionLifecycle)
    : '';
  const delegationReactionEntries = usesDelegationHandlers
    ? renderDelegationReactionEntries(options.delegationChildren)
    : '';
  const documentReactionEntries = usesDocumentReactionHandlers && options.documents
    ? renderDocumentReactionEntries(options.documents)
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
    ? `${renderCollectionLifecycleAllTerminalHelper(options.collectionLifecycle)}${lifecycleTransitions.length > 0 ? renderCollectionLifecycleApplyHelper(options.collectionLifecycle) : ''}`
    : '';
  const confirmationReactionHelper = usesConfirmationLoopHandlers
    ? renderConfirmationLoopReactionHelper()
    : '';
  const delegationReactionHelper = usesDelegationHandlers
    ? renderDelegationReactionHelper()
    : '';
  const documentHelper = usesDocumentHandlers && options.documents
    ? renderDocumentHelper(options.documents, usesDocumentReactionHandlers)
    : '';
  const reactionExport = options.includeReactionHandlers
    ? `\n\nexport const reactionHandlers: Map<string, ReactionHandler> = ${reactionMapConstructor}([\n  ['capture_initial_entry_input', (snapshot) => {\n    if (typeof snapshot.get(${tsString(options.initialEntryPath)}) === 'string') {\n      return undefined;\n    }\n    const current = snapshot.get(${tsString(options.entryPath)});\n    return typeof current === 'string'\n      ? { mutations: [{ op: 'MSet' as const, path: ${tsString(options.initialEntryPath)}, value: current }] }\n      : undefined;\n  }]${stageOutputMirrorReactionEntries}${lifecycleReactionEntries}${confirmationReactionEntries}${delegationReactionEntries}${documentReactionEntries},\n]);${stageOutputMirrorReactionEntries ? stageOutputMirrorReactionHelper() : ''}${lifecycleReactionHelper}${confirmationReactionHelper}${delegationReactionHelper}`
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
${usesIndexedCollectionLifecycle || usesConfirmationLoopHandlers ? "import { reconstructArray } from '@simodelne/pgas-server/plugin.js';\n" : ''}import { resolveDomainValue, type HandlerPayload } from ${tsString(options.resolverImport)};
${contractsImport}
${docxExtractorImportBlock}${stageImports ? `${stageImports}\n` : ''}

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

${sessionControlHandlers}${actionHandlers ? `\n\n${actionHandlers}` : ''}${lifecycleActionHandlers ? `\n\n${lifecycleActionHandlers}` : ''}${documentActionHandlers ? `\n\n${documentActionHandlers}` : ''}
};${lifecycleIntentHelper}${reactionExport}${documentHelper}${conformanceHelper}
`;
}

function renderDocumentActionHandlers(documents: DocumentsDescriptor): string {
  const skipHandler = documents.required
    ? ''
    : `

  async ${DOCUMENT_SKIP_ACTION}(payload) {
    return {
      kind: 'document_upload_skipped',
      payload,
    };
  },`;
  return `  async ${DOCUMENT_REQUEST_ACTION}(payload) {
    return {
      kind: 'document_upload_requested',
      payload,
    };
  },

  async ${DOCUMENT_INGEST_ACTION}(payload) {
    return ingestUploadedDocuments(payload as HandlerPayload);
  },${skipHandler}`;
}

function renderDocumentReactionEntries(documents: DocumentsDescriptor): string {
  return `,
  [${tsString(documentsSaveReactionName())}, (snapshot, trigger, mode) => {
    void trigger;
    void mode;
    return saveDocumentIntake(snapshot, ${documents.required ? 'true' : 'false'});
  }],
  [${tsString(documentsSettleReactionName())}, (snapshot, trigger, mode) => {
    void trigger;
    void mode;
    return settleDocumentSource(snapshot, ${tsString(documents.result_path)}, ${tsString(documentsSourceReadyPath(documents))}, ${documents.required ? 'true' : 'false'});
  }]`;
}

function renderDocumentHelper(documents: DocumentsDescriptor, includeReactionHelpers: boolean): string {
  const allowedTypes = JSON.stringify(documents.upload_types);
  const minChars = documentMinChars(documents);
  const docxExtractionEnabled = documentsDemandsSelfContainedDocx(documents);
  const reactionHelpers = includeReactionHelpers
    ? `

function saveDocumentIntake(snapshot: ReadonlyMap<string, unknown>, required: boolean): ReactionResult | undefined {
  if (snapshot.get(${tsString(DOCUMENTS_RECEIVED_PATH)}) === true) {
    return undefined;
  }
  if (!documentFileRefsPresent(snapshot) && (required || !documentSkipRequestedSnapshot(snapshot))) {
    return undefined;
  }
  return {
    mutations: [
      { op: 'MSet' as const, path: ${tsString(DOCUMENTS_RECEIVED_PATH)}, value: true },
    ],
  };
}

function settleDocumentSource(
  snapshot: ReadonlyMap<string, unknown>,
  resultPath: string,
  readyPath: string,
  required: boolean,
): ReactionResult | undefined {
  if (snapshot.get(readyPath) === true) {
    return undefined;
  }
  const status = documentSourceStatus(snapshot, resultPath);
  if (status === 'extracted' || (!required && status === 'skipped_no_documents')) {
    return {
      mutations: [
        { op: 'MSet' as const, path: readyPath, value: true },
      ],
    };
  }
  if (!required && documentSkipRequestedSnapshot(snapshot)) {
    return {
      mutations: [
        { op: 'MSet' as const, path: \`\${resultPath}.status\`, value: 'skipped_no_documents' },
        { op: 'MSet' as const, path: \`\${resultPath}.full_text\`, value: '' },
        { op: 'MSet' as const, path: \`\${resultPath}.char_count\`, value: 0 },
        { op: 'MSet' as const, path: \`\${resultPath}.file_count\`, value: 0 },
        { op: 'MSet' as const, path: \`\${resultPath}.files_json\`, value: '[]' },
        { op: 'MSet' as const, path: \`\${resultPath}.extraction_kind\`, value: 'skipped_no_documents' },
        { op: 'MSet' as const, path: readyPath, value: true },
      ],
    };
  }
  return undefined;
}

function documentFileRefsPresent(snapshot: ReadonlyMap<string, unknown>): boolean {
  const direct = snapshot.get('${DOCUMENT_INTAKE_ROOT}.file_refs');
  if (Array.isArray(direct) && direct.length > 0) {
    return true;
  }
  const root = snapshot.get('${DOCUMENT_INTAKE_ROOT}');
  if (isDocumentRecord(root) && Array.isArray(root.file_refs) && root.file_refs.length > 0) {
    return true;
  }
  const first = snapshot.get('${DOCUMENT_INTAKE_ROOT}.file_refs.0');
  if (isDocumentRecord(first)) {
    return true;
  }
  return typeof snapshot.get('${DOCUMENT_INTAKE_ROOT}.file_refs.0.fileId') === 'string';
}

function documentSkipRequestedSnapshot(snapshot: ReadonlyMap<string, unknown>): boolean {
  const status = snapshot.get('${DOCUMENT_INTAKE_ROOT}.status');
  if (status === '${DOCUMENT_SKIP_STATUS}') {
    return true;
  }
  const root = snapshot.get('${DOCUMENT_INTAKE_ROOT}');
  return isDocumentRecord(root) && root.status === '${DOCUMENT_SKIP_STATUS}';
}

function documentSourceStatus(snapshot: ReadonlyMap<string, unknown>, resultPath: string): string {
  const direct = snapshot.get(\`\${resultPath}.status\`);
  if (typeof direct === 'string') {
    return direct;
  }
  const source = snapshot.get(resultPath);
  return isDocumentRecord(source) && typeof source.status === 'string' ? source.status : '';
}`
    : '';

  return `

function ingestUploadedDocuments(payload: HandlerPayload): Record<string, unknown> {
  if (documentSkipRequestedPayload(payload)) {
    return skippedDocumentSource();
  }
  const request = payload.request as { documents?: unknown } | undefined;
  const rawDocuments = Array.isArray(request?.documents) ? request.documents : [];
  const documentRecords = rawDocuments.filter(isDocumentRecord);
  const allowedMimeTypes = new Set<string>(${allowedTypes});
  const summaries = documentRecords.map(documentSummary);
  const eligible: Array<{ document: Record<string, unknown>; text: string; extraction_kind: string }> = [];
  for (const document of documentRecords) {
    if (!documentMimeAllowed(document, allowedMimeTypes)) {
      continue;
    }
    if (typeof document.content_text === 'string') {
      eligible.push({ document, text: document.content_text, extraction_kind: 'content_text' });
      continue;
    }
    ${docxExtractionEnabled ? `if (documentIsDocx(document) && typeof document.content_base64 === 'string') {
      const bytes = Buffer.from(document.content_base64, 'base64');
      const extracted = extractDocxText(bytes);
      if (!extracted.ok) {
        return {
          status: 'blocked_extraction_failed',
          full_text: '',
          char_count: 0,
          file_count: 0,
          files_json: JSON.stringify(summaries),
          extraction_kind: docxExtractionKind(bytes),
          reason: extracted.reason,
        };
      }
      eligible.push({ document, text: extracted.text, extraction_kind: docxExtractionKind(bytes) });
      continue;
    }` : ''}
  }

  if (eligible.length === 0) {
    const sawUnsupported = documentRecords.some((document) =>
      typeof document.content_base64 === 'string' || !documentMimeAllowed(document, allowedMimeTypes));
    return {
      status: sawUnsupported ? 'blocked_unsupported_type' : 'blocked_no_content',
      full_text: '',
      char_count: 0,
      file_count: 0,
      files_json: JSON.stringify(summaries),
      extraction_kind: 'none',
      reason: sawUnsupported ? ${docxExtractionEnabled ? "'uploaded documents were not supported content_text or DOCX content_base64 documents'" : "'uploaded documents were not text/markdown content_text documents'"} : 'no engine-injected document content_text was available',
    };
  }

  const fullText = eligible.length === 1
    ? eligible[0]?.text ?? ''
    : eligible.map((entry, index) => \`--- file: \${documentName(entry.document, index)} ---\\n\\n\${entry.text}\`).join('\\n\\n');
  const charCount = fullText.length;
  const extractionKind = combinedExtractionKind(eligible.map((entry) => entry.extraction_kind));
  if (charCount < ${String(minChars)}) {
    return {
      status: 'blocked_low_fidelity',
      full_text: fullText,
      char_count: charCount,
      file_count: eligible.length,
      files_json: JSON.stringify(eligible.map((entry) => documentSummary(entry.document))),
      extraction_kind: extractionKind,
      reason: \`extracted text length \${String(charCount)} below minimum ${String(minChars)}\`,
    };
  }
  return {
    status: 'extracted',
    full_text: fullText,
    char_count: charCount,
    file_count: eligible.length,
    files_json: JSON.stringify(eligible.map((entry) => documentSummary(entry.document))),
    extraction_kind: extractionKind,
  };
}

function skippedDocumentSource(): Record<string, unknown> {
  return {
    status: 'skipped_no_documents',
    full_text: '',
    char_count: 0,
    file_count: 0,
    files_json: '[]',
    extraction_kind: 'skipped_no_documents',
  };
}

function documentSkipRequestedPayload(payload: HandlerPayload): boolean {
  const domain = payload.domain;
  if (!domain) {
    return false;
  }
  const status = domain['${DOCUMENT_INTAKE_ROOT}.status'];
  if (status === '${DOCUMENT_SKIP_STATUS}') {
    return true;
  }
  const root = domain['${DOCUMENT_INTAKE_ROOT}'];
  return isDocumentRecord(root) && root.status === '${DOCUMENT_SKIP_STATUS}';
}

function documentMimeAllowed(document: Record<string, unknown>, allowedMimeTypes: ReadonlySet<string>): boolean {
  const raw = typeof document.mime_type === 'string'
    ? document.mime_type
    : typeof document.mimeType === 'string'
      ? document.mimeType
      : '';
  return allowedMimeTypes.has(raw.toLowerCase());
}

function documentIsDocx(document: Record<string, unknown>): boolean {
  const raw = typeof document.mime_type === 'string'
    ? document.mime_type
    : typeof document.mimeType === 'string'
      ? document.mimeType
      : '';
  return raw.toLowerCase() === ${tsString(DOCX_MIME_TYPE)};
}

function combinedExtractionKind(kinds: string[]): string {
  if (kinds.length === 1) {
    return kinds[0] ?? 'unknown';
  }
  if (kinds.includes('docx_deflate')) {
    return 'mixed_docx_deflate';
  }
  if (kinds.includes('docx_store')) {
    return 'mixed_docx_store';
  }
  if (kinds.every((kind) => kind === 'content_text')) {
    return 'content_text';
  }
  return kinds.length > 0 ? 'mixed' : 'unknown';
}

${docxExtractionEnabled ? `function docxExtractionKind(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let sawEntry = false;
  let sawDeflate = false;
  while (offset + 4 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    sawEntry = true;
    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    if (method === 8) {
      sawDeflate = true;
    } else if (method !== 0) {
      return 'docx_unknown';
    }
    const dataEnd = offset + 30 + nameLength + extraLength + compressedSize;
    if (dataEnd > bytes.length) {
      return 'docx_unknown';
    }
    offset = dataEnd;
  }
  if (!sawEntry) {
    return 'docx_unknown';
  }
  return sawDeflate ? 'docx_deflate' : 'docx_store';
}

` : ''}function documentName(document: Record<string, unknown>, index: number): string {
  return typeof document.name === 'string' && document.name.length > 0
    ? document.name
    : \`document-\${String(index + 1)}\`;
}

function documentSummary(document: Record<string, unknown>): Record<string, unknown> {
  return {
    name: typeof document.name === 'string' ? document.name : undefined,
    mime_type: typeof document.mime_type === 'string'
      ? document.mime_type
      : typeof document.mimeType === 'string'
        ? document.mimeType
        : undefined,
    size: typeof document.size === 'number' ? document.size : undefined,
    has_content_text: typeof document.content_text === 'string',
    has_content_base64: typeof document.content_base64 === 'string',
  };
}

function isDocumentRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}${reactionHelpers}`;
}

function documentMinChars(documents: DocumentsDescriptor): number {
  const value = documents.fidelity_floor?.min_chars;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
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

function renderCollectionLifecycleAllTerminalHelper(descriptor: CollectionLifecycleDescriptor): string {
  if (descriptor.storage.representation === 'indexed_array') {
    return `\n\nfunction collectionLifecycleAllTerminal(\n  snapshot: ReadonlyMap<string, unknown>,\n  itemsPath: string,\n  statusField: string,\n  terminalStatuses: readonly string[],\n  requireNonEmpty: boolean,\n): boolean {\n  let parsed: unknown[];\n  try {\n    parsed = reconstructArray(Object.fromEntries(snapshot), itemsPath);\n  } catch {\n    return false;\n  }\n  if (requireNonEmpty && parsed.length === 0) {\n    return false;\n  }\n  const terminal = new Set(terminalStatuses);\n  return parsed.every((item) => {\n    if (!item || typeof item !== 'object' || Array.isArray(item)) {\n      return false;\n    }\n    const status = (item as Record<string, unknown>)[statusField];\n    return typeof status === 'string' && terminal.has(status);\n  });\n}`;
  }
  return `\n\nfunction collectionLifecycleAllTerminal(\n  snapshot: ReadonlyMap<string, unknown>,\n  itemsPath: string,\n  statusField: string,\n  terminalStatuses: readonly string[],\n  requireNonEmpty: boolean,\n): boolean {\n  const raw = snapshot.get(itemsPath);\n  if (typeof raw !== 'string') {\n    return false;\n  }\n  let parsed: unknown;\n  try {\n    parsed = JSON.parse(raw) as unknown;\n  } catch {\n    return false;\n  }\n  if (!Array.isArray(parsed)) {\n    return false;\n  }\n  if (requireNonEmpty && parsed.length === 0) {\n    return false;\n  }\n  const terminal = new Set(terminalStatuses);\n  return parsed.every((item) => {\n    if (!item || typeof item !== 'object' || Array.isArray(item)) {\n      return false;\n    }\n    const status = (item as Record<string, unknown>)[statusField];\n    return typeof status === 'string' && terminal.has(status);\n  });\n}`;
}

function renderCollectionLifecycleApplyHelper(descriptor: CollectionLifecycleDescriptor): string {
  if (descriptor.storage.representation === 'indexed_array') {
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

  let items: unknown[];
  try {
    items = reconstructArray(Object.fromEntries(snapshot), itemsPath);
  } catch {
    return violation('missing_item', eventFrom);
  }
  const itemIndex = items.findIndex((item) =>
    !!item && typeof item === 'object' && !Array.isArray(item) && (item as Record<string, unknown>)[idField] === itemId,
  );
  if (itemIndex < 0) {
    return violation('missing_item', eventFrom);
  }

  const currentItem = items[itemIndex] as Record<string, unknown>;
  const currentStatus = currentItem[statusField];
  const from = typeof currentStatus === 'string' ? currentStatus : '';
  const transition = transitions.find((candidate) =>
    candidate.action === action && candidate.from === from && candidate.to === attemptedTo);
  if (!transition) {
    return violation('undeclared_transition', from);
  }
  if (transition.guard_field && !snapshot.get(transition.guard_field)) {
    return violation('guard_false', from);
  }

  return {
    mutations: [
      { op: 'MSet' as const, path: itemsPath + '.' + itemIndex + '.' + statusField, value: attemptedTo },
      { op: 'MSet' as const, path: eventPath, value: '' },
    ],
  };
}`;
  }
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

function renderConfirmationLoopReactionEntries(
  loops: ConfirmationLoopDescriptor[],
  lifecycle: CollectionLifecycleDescriptor,
): string {
  return loops.map((loop) => {
    const decisions = confirmationLoopRuntimeDecisions(loop.decisions);
    return `,
  [${tsString(confirmationLoopSaveReactionName(loop))}, (snapshot, trigger, mode) => {
    void trigger;
    if (mode !== ${tsString(loop.stage)}) return undefined;
    return confirmationLoopSaveDecision(snapshot, ${tsString(confirmationLoopPendingPath(loop))}, ${JSON.stringify(decisions)});
  }],
  [${tsString(confirmationLoopEnforceReactionName(loop))}, (snapshot, trigger, mode) => {
    void trigger;
    if (mode !== ${tsString(loop.stage)}) return undefined;
    return confirmationLoopEnforceStatus(
      snapshot,
      ${tsString(loop.collection)},
      ${tsString(lifecycle.item.id_field)},
      ${tsString(lifecycle.item.status_field)},
      ${tsString(confirmationLoopInitialStatus(lifecycle))},
      ${tsString(loop.proposed_status)},
      ${tsString(confirmationLoopPendingPath(loop))},
      ${tsString(confirmationLoopViolationPath(loop, lifecycle))},
      ${tsString(confirmationLoopDemotionCounterPath(loop))},
      ${tsString(confirmationLoopAppliedDecisionPath(loop))},
      ${tsString(loop.aggregate.guard_field)},
      [${loop.aggregate.terminal_statuses.map(tsString).join(', ')}],
      ${JSON.stringify(decisions)},
    );
  }],
  [${tsString(confirmationLoopChoreographReactionName(loop))}, (snapshot, trigger, mode) => {
    void trigger;
    return confirmationLoopChoreographCollection(
      snapshot,
      mode,
      ${tsString(loop.collection)},
      ${tsString(loop.item_id_field ?? lifecycle.item.id_field)},
      ${tsString(lifecycle.item.status_field)},
      ${tsString(confirmationLoopInitialStatus(lifecycle))},
      ${tsString(loop.proposed_status)},
      ${tsString(loop.stage)},
      ${tsString(`${loop.seed.source_stage}.items_json`)},
      ${tsString(loop.seed.id_prefix ?? 'item')},
      ${tsString(loop.item_title_field ?? 'title')},
      [${confirmationLoopSeedSchemaFields(loop, lifecycle).map(tsString).join(', ')}],
      [${confirmationLoopSeedForcedEmptyFields(loop, lifecycle).map(tsString).join(', ')}],
      [${confirmationLoopProposalFields(loop, lifecycle).map(tsString).join(', ')}],
      ${tsString(confirmationLoopProposalPath(loop))},
      ${tsString(confirmationLoopProposalLogPath(loop))},
      ${tsString(confirmationLoopAppliedProposalCountPath(loop))},
      ${tsString(confirmationLoopSeedStatePath(loop))},
    );
  }]`;
  }).join('');
}

function renderDelegationReactionEntries(children: DelegationChildDescriptor[]): string {
  return children.map((child) => {
    const base = delegationStateBase(child);
    return `,
  [${tsString(delegationSettleReactionName(child))}, (snapshot, trigger, mode) => {
    void trigger;
    void mode;
    return settleDelegationResult(
      snapshot,
      ${tsString(child.result_path)},
      ${tsString(`${base}.settled`)},
      ${tsString(`${base}.degraded`)},
      ${tsString(`${base}.degrade_reason`)},
    );
  }]`;
  }).join('');
}

function renderDelegationReactionHelper(): string {
  return `

function settleDelegationResult(
  snapshot: ReadonlyMap<string, unknown>,
  resultPath: string,
  settledPath: string,
  degradedPath: string,
  degradeReasonPath: string,
): ReactionResult | undefined {
  if (snapshot.get(settledPath) === true) {
    return undefined;
  }
  const direct = snapshot.get(resultPath);
  const result = direct && typeof direct === 'object' && !Array.isArray(direct)
    ? direct as Record<string, unknown>
    : {};
  const status = typeof result.status === 'string'
    ? result.status
    : snapshot.get(\`\${resultPath}.status\`);
  if (typeof status !== 'string' || status.length === 0) {
    return undefined;
  }
  if (status === 'complete') {
    return {
      mutations: [
        { op: 'MSet' as const, path: settledPath, value: true },
        { op: 'MSet' as const, path: degradedPath, value: false },
        { op: 'MSet' as const, path: degradeReasonPath, value: '' },
      ],
    };
  }
  if (status !== 'failed' && status !== 'declined') {
    return undefined;
  }
  const reason = typeof result.reason === 'string'
    ? result.reason
    : snapshot.get(\`\${resultPath}.reason\`);
  return {
    mutations: [
      { op: 'MSet' as const, path: settledPath, value: true },
      { op: 'MSet' as const, path: degradedPath, value: true },
      { op: 'MSet' as const, path: degradeReasonPath, value: typeof reason === 'string' && reason.length > 0 ? reason : status },
    ],
  };
}`;
}

function renderConfirmationLoopReactionHelper(): string {
  return `

interface PendingConfirmationDecision {
  decision: string;
  instruction: string;
  target_index: number;
}

function confirmationLoopSaveDecision(
  snapshot: ReadonlyMap<string, unknown>,
  pendingPath: string,
  decisions: Record<string, { to: string; requires_instruction?: boolean; instruction_path?: string; re_propose?: boolean }>,
): ReactionResult | undefined {
  const rawDecision = snapshot.get('inputs.user_decision.decision');
  const normalizedDecision = typeof rawDecision === 'string' ? rawDecision.trim() : '';
  const decision = confirmationLoopNormalizeDecision(normalizedDecision, decisions);
  if (decision.length === 0) {
    return undefined;
  }
  const pending = {
    decision,
    instruction: typeof snapshot.get('inputs.user_decision.instruction') === 'string'
      ? String(snapshot.get('inputs.user_decision.instruction'))
      : '',
    target_index: confirmationLoopTargetIndex(snapshot.get('inputs.user_decision.target_item_index')),
    target_item_id: typeof snapshot.get('inputs.user_decision.target_item_id') === 'string' ? snapshot.get('inputs.user_decision.target_item_id') : '',
    target_item_title: typeof snapshot.get('inputs.user_decision.target_item_title') === 'string' ? snapshot.get('inputs.user_decision.target_item_title') : '',
    target_item_status: typeof snapshot.get('inputs.user_decision.target_item_status') === 'string' ? snapshot.get('inputs.user_decision.target_item_status') : '',
    timestamp: typeof snapshot.get('inputs.user_decision.timestamp') === 'string' ? snapshot.get('inputs.user_decision.timestamp') : '',
  };
  return { mutations: [{ op: 'MSet' as const, path: pendingPath, value: JSON.stringify(pending) }] };
}

function confirmationLoopNormalizeDecision(
  decision: string,
  decisions: Record<string, unknown>,
): string {
  if (Object.prototype.hasOwnProperty.call(decisions, decision)) {
    return decision;
  }
  return '';
}

function confirmationLoopEnforceStatus(
  snapshot: ReadonlyMap<string, unknown>,
  itemsPath: string,
  idField: string,
  statusField: string,
  initialStatus: string,
  proposedStatus: string,
  pendingPath: string,
  violationPath: string,
  demotionCounterPath: string,
  appliedDecisionPath: string,
  aggregateGuardPath: string,
  terminalStatuses: readonly string[],
  decisions: Record<string, { to: string; requires_instruction?: boolean; instruction_path?: string; re_propose?: boolean }>,
): ReactionResult | undefined {
  const mutations: ReactionResult['mutations'] = [];
  let items: unknown[] = [];
  let itemsAvailable = true;
  try {
    items = reconstructArray(Object.fromEntries(snapshot), itemsPath);
  } catch {
    itemsAvailable = false;
  }

  const pending = confirmationLoopPendingDecision(snapshot.get(pendingPath), snapshot);
  if (pending.kind === 'invalid') {
    mutations.push({ op: 'MSet' as const, path: violationPath, value: JSON.stringify({ reason: 'invalid_pending_decision' }) });
  } else if (pending.kind === 'present') {
    const fingerprint = confirmationLoopPendingFingerprint(pending.value);
    if (snapshot.get(appliedDecisionPath) === fingerprint) {
      // Already applied; invariant enforcement below still runs.
    } else if (!itemsAvailable) {
      mutations.push(
        { op: 'MSet' as const, path: violationPath, value: JSON.stringify({ reason: 'missing_collection' }) },
        { op: 'MSet' as const, path: appliedDecisionPath, value: fingerprint },
      );
    } else {
      const decision = decisions[pending.value.decision];
      const item = Number.isInteger(pending.value.target_index) ? items[pending.value.target_index] : undefined;
      if (!decision || !item || typeof item !== 'object' || Array.isArray(item)) {
        mutations.push(
          { op: 'MSet' as const, path: violationPath, value: JSON.stringify({ reason: decision ? 'missing_item' : 'unknown_decision', decision: pending.value.decision, target_index: pending.value.target_index }) },
          { op: 'MSet' as const, path: appliedDecisionPath, value: fingerprint },
        );
      } else if (decision.requires_instruction === true && pending.value.instruction.trim().length === 0) {
        mutations.push(
          { op: 'MSet' as const, path: violationPath, value: JSON.stringify({ reason: 'missing_instruction', decision: pending.value.decision, target_index: pending.value.target_index }) },
          { op: 'MSet' as const, path: appliedDecisionPath, value: fingerprint },
        );
      } else {
        const record = item as Record<string, unknown>;
        const nextStatus = decision.re_propose === true ? proposedStatus : decision.to;
        record[statusField] = nextStatus;
        mutations.push({ op: 'MSet' as const, path: itemsPath + '.' + pending.value.target_index + '.' + statusField, value: nextStatus });
        if (decision.instruction_path && pending.value.instruction.trim().length > 0) {
          mutations.push({ op: 'MSet' as const, path: decision.instruction_path.replace(/\\.\\*(?=\\.|$)/u, '.' + pending.value.target_index), value: pending.value.instruction });
        }
        mutations.push({ op: 'MSet' as const, path: appliedDecisionPath, value: fingerprint });
      }
    }
  }

  const proposed = itemsAvailable
    ? items.map((item, index) => ({ item, index })).filter(({ item }) =>
        item && typeof item === 'object' && !Array.isArray(item) &&
        (item as Record<string, unknown>)[statusField] === proposedStatus)
    : [];
  let demoted = 0;
  for (const { item, index } of proposed.slice(1)) {
    const record = item as Record<string, unknown>;
    record[statusField] = initialStatus;
    mutations.push({ op: 'MSet' as const, path: itemsPath + '.' + index + '.' + statusField, value: initialStatus });
    mutations.push({ op: 'MSet' as const, path: violationPath, value: JSON.stringify({ reason: 'multiple_proposed', kept_index: proposed[0]?.index ?? 0, demoted_index: index, demoted_id: typeof record[idField] === 'string' ? record[idField] : '' }) });
    demoted += 1;
  }
  if (demoted > 0) {
    const current = snapshot.get(demotionCounterPath);
    mutations.push({ op: 'MSet' as const, path: demotionCounterPath, value: (typeof current === 'number' && Number.isFinite(current) ? current : 0) + demoted });
  }
  const terminal = new Set(terminalStatuses);
  const allTerminal = itemsAvailable && items.length > 0 && items.every((item) =>
    item && typeof item === 'object' && !Array.isArray(item) &&
    typeof (item as Record<string, unknown>)[statusField] === 'string' &&
    terminal.has((item as Record<string, unknown>)[statusField] as string));
  mutations.push({ op: 'MSet' as const, path: aggregateGuardPath, value: allTerminal });
  return mutations.length > 0 ? { mutations } : undefined;
}

function confirmationLoopChoreographCollection(
  snapshot: ReadonlyMap<string, unknown>,
  mode: string,
  itemsPath: string,
  idField: string,
  statusField: string,
  initialStatus: string,
  proposedStatus: string,
  loopStage: string,
  sourceItemsJsonPath: string,
  idPrefix: string,
  titleField: string,
  seedSchemaFields: readonly string[],
  seedForcedEmptyFields: readonly string[],
  proposalFields: readonly string[],
  proposalPath: string,
  proposalLogPath: string,
  appliedProposalCountPath: string,
  seedStatePath: string,
): ReactionResult | undefined {
  const mutations: ReactionResult['mutations'] = [];
  let items: unknown[] = [];
  try {
    items = reconstructArray(Object.fromEntries(snapshot), itemsPath);
  } catch {
    items = [];
  }

  if (items.length === 0) {
    const seed = confirmationLoopSeedItems(snapshot.get(sourceItemsJsonPath), idField, titleField);
    if (seed.kind === 'valid') {
      const seeded = seed.items.map((seedItem, index) =>
        confirmationLoopSeedItem(seedItem, index, idField, statusField, initialStatus, idPrefix, titleField, seedSchemaFields, seedForcedEmptyFields));
      seeded.forEach((item, index) => {
        mutations.push({ op: 'MSet' as const, path: itemsPath + '.' + index, value: item });
      });
      mutations.push({ op: 'MSet' as const, path: seedStatePath, value: 'seeded' });
      items = seeded;
    } else if (seed.kind === 'invalid') {
      mutations.push({ op: 'MSet' as const, path: seedStatePath, value: 'invalid_items_json' });
    }
  }

  if (mode !== loopStage) {
    return mutations.length > 0 ? { mutations } : undefined;
  }
  const log = snapshot.get(proposalLogPath);
  const proposalCount = Array.isArray(log) ? log.length : 0;
  const applied = snapshot.get(appliedProposalCountPath);
  const appliedCount = typeof applied === 'number' && Number.isFinite(applied) ? applied : 0;
  if (proposalCount <= appliedCount) {
    return mutations.length > 0 ? { mutations } : undefined;
  }
  const targetIndex = confirmationLoopProposalTargetIndex(items, statusField, proposedStatus, initialStatus);
  if (targetIndex < 0) {
    return mutations.length > 0 ? { mutations } : undefined;
  }
  const current = items[targetIndex];
  const next: Record<string, unknown> = current && typeof current === 'object' && !Array.isArray(current)
    ? { ...(current as Record<string, unknown>) }
    : {};
  for (const field of proposalFields) {
    const value = snapshot.get(proposalPath + '.' + field);
    next[field] = typeof value === 'string' ? value : '';
  }
  next[statusField] = proposedStatus;
  mutations.push(
    { op: 'MSet' as const, path: itemsPath + '.' + targetIndex, value: next },
    { op: 'MSet' as const, path: appliedProposalCountPath, value: proposalCount },
  );
  return { mutations };
}

interface ConfirmationLoopSeedItem {
  id?: string;
  title: string;
  fields: Record<string, unknown>;
}

function confirmationLoopSeedItems(
  value: unknown,
  idField: string,
  titleField: string,
): { kind: 'empty' } | { kind: 'invalid' } | { kind: 'valid'; items: ConfirmationLoopSeedItem[] } {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { kind: 'empty' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return { kind: 'invalid' };
  }
  if (!Array.isArray(parsed)) {
    return { kind: 'invalid' };
  }
  if (parsed.length === 0) {
    return { kind: 'invalid' };
  }
  const items: ConfirmationLoopSeedItem[] = [];
  for (let index = 0; index < parsed.length; index += 1) {
    const item = parsed[index];
    if (typeof item === 'string') {
      items.push({ title: item, fields: {} });
      continue;
    }
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      const id = confirmationLoopFirstPresentSeedValue(record, [idField, 'id']);
      items.push({
        ...(id === undefined ? {} : { id: String(id) }),
        title: confirmationLoopSeedItemTitle(record, titleField, index),
        fields: { ...record },
      });
      continue;
    }
    return { kind: 'invalid' };
  }
  return { kind: 'valid', items };
}

function confirmationLoopSeedItemTitle(
  record: Record<string, unknown>,
  titleField: string,
  index: number,
): string {
  const value = confirmationLoopFirstPresentSeedValue(record, [titleField, 'title', 'name', 'label', 'summary']);
  if (value !== undefined) {
    return String(value);
  }
  const id = confirmationLoopFirstPresentSeedValue(record, ['id']);
  return String(id ?? index);
}

function confirmationLoopFirstPresentSeedValue(record: Record<string, unknown>, fields: readonly string[]): unknown | undefined {
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(record, field) && record[field] !== undefined && record[field] !== null) {
      return record[field];
    }
  }
  return undefined;
}

function confirmationLoopSeedItem(
  seed: ConfirmationLoopSeedItem,
  index: number,
  idField: string,
  statusField: string,
  initialStatus: string,
  idPrefix: string,
  titleField: string,
  seedSchemaFields: readonly string[],
  seedForcedEmptyFields: readonly string[],
): Record<string, unknown> {
  const item: Record<string, unknown> = {
    [idField]: seed.id ?? idPrefix + '-' + String(index + 1),
    [titleField]: seed.title,
    [statusField]: initialStatus,
  };
  for (const field of seedSchemaFields) {
    if (Object.prototype.hasOwnProperty.call(seed.fields, field)) {
      item[field] = seed.fields[field];
    }
  }
  for (const field of seedSchemaFields) {
    if (!Object.prototype.hasOwnProperty.call(item, field)) {
      item[field] = '';
    }
  }
  for (const field of seedForcedEmptyFields) {
    item[field] = '';
  }
  item[statusField] = initialStatus;
  return item;
}

function confirmationLoopProposalTargetIndex(
  items: unknown[],
  statusField: string,
  proposedStatus: string,
  initialStatus: string,
): number {
  const proposed = items.findIndex((item) =>
    item && typeof item === 'object' && !Array.isArray(item) &&
    (item as Record<string, unknown>)[statusField] === proposedStatus);
  if (proposed >= 0) {
    return proposed;
  }
  return items.findIndex((item) =>
    item && typeof item === 'object' && !Array.isArray(item) &&
    (item as Record<string, unknown>)[statusField] === initialStatus);
}

function confirmationLoopPendingDecision(value: unknown, snapshot: ReadonlyMap<string, unknown>): { kind: 'empty' } | { kind: 'invalid' } | { kind: 'present'; value: PendingConfirmationDecision } {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return confirmationLoopPendingDecisionFromInputs(snapshot);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return { kind: 'invalid' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'invalid' };
  }
  const record = parsed as Record<string, unknown>;
  const decision = typeof record.decision === 'string' ? record.decision.trim() : '';
  const targetIndex = confirmationLoopTargetIndex(record.target_index);
  if (decision.length === 0 || targetIndex < 0) {
    return { kind: 'invalid' };
  }
  return {
    kind: 'present',
    value: {
      decision,
      instruction: typeof record.instruction === 'string' ? record.instruction : '',
      target_index: targetIndex,
    },
  };
}

function confirmationLoopPendingDecisionFromInputs(snapshot: ReadonlyMap<string, unknown>): { kind: 'empty' } | { kind: 'invalid' } | { kind: 'present'; value: PendingConfirmationDecision } {
  const decision = typeof snapshot.get('inputs.user_decision.decision') === 'string'
    ? String(snapshot.get('inputs.user_decision.decision')).trim()
    : '';
  if (decision.length === 0) {
    return { kind: 'empty' };
  }
  const targetIndex = confirmationLoopTargetIndex(snapshot.get('inputs.user_decision.target_item_index'));
  if (targetIndex < 0) {
    return { kind: 'invalid' };
  }
  return {
    kind: 'present',
    value: {
      decision,
      instruction: typeof snapshot.get('inputs.user_decision.instruction') === 'string'
        ? String(snapshot.get('inputs.user_decision.instruction'))
        : '',
      target_index: targetIndex,
    },
  };
}

function confirmationLoopPendingFingerprint(pending: PendingConfirmationDecision): string {
  return JSON.stringify(pending);
}

function confirmationLoopTargetIndex(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^\\d+$/u.test(value)) {
    return Number.parseInt(value, 10);
  }
  return -1;
}`;
}

function renderToolsSource(
  slug: string,
  transitionActions: TransitionAction[],
  reasoningContractsBySlug: Map<string, ReasoningStageContract>,
  collectionLifecycle?: CollectionLifecycleDescriptor,
  confirmationLoops: ConfirmationLoopDescriptor[] = [],
  documents?: DocumentsDescriptor,
): string {
  void documents;
  const stageActions = codegenStageActions(transitionActions, confirmationLoops);
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
        export_kind: action.export_kind,
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
  confirmationLoops: ConfirmationLoopDescriptor[] = [],
  delegationChildren: DelegationChildDescriptor[] = [],
  documents?: DocumentsDescriptor,
): string {
  if (documents) {
    return renderDocumentUploadSmokeTestSource(slug, name, entryChannel, documents, transitionActions);
  }
  // Slice B: N distinct static delegation children dispatch + settle sequentially. The
  // single-child renderers below stay byte-identical for exactly one child; only 2+ children
  // route to the multi-child smoke that dispatches + settles EVERY child against its own
  // separately-registered stub program.
  if (delegationChildren.length >= 2) {
    return renderMultiChildDelegationSmokeTestSource(slug, name, entryChannel, delegationChildren, transitionActions);
  }
  const delegationSmokeChild = delegationChildren.find((child) =>
    child.synthesize_child?.kind === 'worker' || child.synthesize_child?.kind === 'research_agent');
  if (delegationSmokeChild) {
    return renderDelegationSmokeTestSource(slug, name, entryChannel, delegationSmokeChild, transitionActions);
  }
  const reuseDelegationSmokeChild = delegationChildren.find((child) => child.target_spec && child.registered_name);
  if (reuseDelegationSmokeChild) {
    return renderReuseDelegationSmokeTestSource(slug, name, entryChannel, reuseDelegationSmokeChild, transitionActions);
  }
  if (confirmationLoops.length > 0) {
    return renderConfirmationLoopSmokeTestSource(slug, name, entryChannel, confirmationLoops, completion.collection_lifecycle);
  }
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

function renderDocumentUploadSmokeTestSource(
  slug: string,
  name: string,
  entryChannel: string,
  documents: DocumentsDescriptor,
  transitionActions: TransitionAction[],
): string {
  const transitionAction = transitionActions.find((action) => action.source === documents.stage);
  const transitionActionName = transitionAction?.name ?? `complete_${safeIdentifier(documents.stage)}`;
  const transitionChannel = transitionAction?.archetype === 'llm-reasoning' ? 'widget_output' : 'stage_output';
  const transitionPayload = transitionAction?.archetype === 'llm-reasoning'
    ? `{
          result_json: JSON.stringify({ document_source_ready: true }),
          items_json: JSON.stringify(['document-source-ready']),
        }`
    : `{ __stage_runtime: { now_iso: '2026-07-16T00:00:00.000Z', random: 0.25 } }`;
  const resultPath = documents.result_path;
  const readyPath = documentsSourceReadyPath(documents);
  const skipTest = documents.required
    ? ''
    : `

  it('runs synthesized optional document skip through the route for ${name}', async () => {
    const result = await runSkipScenario([
      scripted(effect('begin_work', {})),
      scripted(effect('${DOCUMENT_SKIP_ACTION}', {})),
    ]);
    const source = resultAt(result.final.domain, ${tsString(resultPath)});
    expect(source.status).toBe('skipped_no_documents');
    expect(source.full_text).toBe('');
    expect(source.char_count).toBe(0);
    expect(source.file_count).toBe(0);
    expect(result.final.domain[${tsString(readyPath)}]).toBe(true);
    expect(result.final.mode).toBe('complete');
  });`;
  return `import { File } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import { appTransport, createPgasClient, type PgasClient } from '@simodelne/pgas-server/client.js';
import { create${toPascalCase(slug)}ProgramEntry } from '../src/programs/${slug}/registration.js';

describe('generated document upload smoke', () => {
  it('runs synthesized document upload hermetically through the route for ${name}', async () => {
    const sentinel = \`PGAS-UPLOAD-SENTINEL-\${randomUUID()}\`;
    const content = [
      'Generated route-level upload smoke fixture.',
      sentinel,
      'ASCII payload keeps byte length equal to character count for exact assertions.',
    ].join('\\n');
    const result = await runUploadScenario([
      scripted(effect('begin_work', {})),
      scripted(effect('${DOCUMENT_REQUEST_ACTION}', {})),
      scripted(effect('${DOCUMENT_INGEST_ACTION}', {}, 'stage_output')),
      scripted(effect(${tsString(transitionActionName)}, ${transitionPayload}, ${tsString(transitionChannel)})),
    ], async ({ client, sessionId }) => {
      const upload = await uploadText(client, sessionId, 'source.txt', content);
      const [fileRef] = refsFromUpload(upload);
      expect(fileRef).toBeDefined();
      await client.sessions.trigger(sessionId, {
        channel: '${DOCUMENT_UPLOAD_CHANNEL}',
        payload: { ['${DOCUMENT_INTAKE_ROOT}.file_refs']: [{ fileId: fileRef.fileId, name: fileRef.name }] },
      });
      return { fileRef, content, sentinel };
    });

    expect(result.upload?.fileRef.fileId).toEqual(expect.any(String));
    expect(documentRefLanded(result.afterUpload.domain, String(result.upload?.fileRef.fileId))).toBe(true);
    const source = resultAt(result.final.domain, ${tsString(resultPath)});
    expect(source.status).toBe('extracted');
    expect(source.full_text).toBe(result.upload?.content);
    expect(String(source.full_text)).toContain(result.upload?.sentinel);
    expect(source.char_count).toBe(result.upload?.content.length);
    expect(source.file_count).toBe(1);
    expect(result.final.domain[${tsString(readyPath)}]).toBe(true);
    expect(result.final.mode).toBe('complete');
  });${skipTest}
});

interface Snapshot {
  mode: string | null;
  domain: Record<string, unknown>;
  awaiting?: Record<string, unknown>;
}

interface ScriptedAuthorResponse {
  response: ReturnType<typeof effect>;
}

interface UploadEvidence {
  fileRef: Record<string, unknown>;
  content: string;
  sentinel: string;
}

async function runUploadScenario(
  script: ScriptedAuthorResponse[],
  act: (ctx: { client: PgasClient; sessionId: string }) => Promise<UploadEvidence | void>,
): Promise<{ afterRequest: Snapshot; afterUpload: Snapshot; final: Snapshot; upload?: UploadEvidence }> {
  const tempDir = mkdtempSync(join(tmpdir(), 'pgas-generated-upload-smoke-'));
  const server = await createPgasServer({
    programs: [{ name: ${tsString(slug)}, entry: create${toPascalCase(slug)}ProgramEntry() }],
    drivers: {
      authorHandle: scriptedAuthor(script),
      observerHandle: {
        modelId: 'generated-upload-smoke-observer',
        async complete() {
          return 'noop';
        },
      },
    },
    devMode: true,
    storage: { uploadsDir: join(tempDir, 'uploads') },
    telemetry: { enabled: false },
    port: 0,
  });
  const client = createPgasClient(appTransport(server.app, { token: 'dev-token' }));
  try {
    const created = await client.sessions.create({ program: ${tsString(slug)} });
    const sessionId = created.sessionId;
    await client.sessions.trigger(sessionId, { channel: ${tsString(entryChannel)}, payload: 'start generated upload smoke' });
    await client.sessions.trigger(sessionId, { channel: ${tsString(entryChannel)}, payload: 'request generated document upload' });
    const afterRequest = await readSnapshot(client, sessionId);
    expect(afterRequest.mode).toBe(${tsString(documents.stage)});
    expect(afterRequest.awaiting?.channelId).toBe('${DOCUMENT_UPLOAD_CHANNEL}');
    const upload = await act({ client, sessionId }) ?? undefined;
    let afterUpload = await readSnapshot(client, sessionId);
    let final = afterUpload;
    for (let attempt = 0; attempt < 4 && final.mode !== 'complete'; attempt += 1) {
      await client.sessions.trigger(sessionId, { channel: ${tsString(entryChannel)}, payload: \`continue generated upload smoke \${String(attempt + 1)}\` });
      final = await readSnapshot(client, sessionId);
    }
    if (afterUpload.mode === 'complete') {
      final = afterUpload;
    } else {
      afterUpload = await readSnapshot(client, sessionId);
    }
    return { afterRequest, afterUpload, final, ...(upload ? { upload } : {}) };
  } finally {
    await server.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runSkipScenario(
  script: ScriptedAuthorResponse[],
): Promise<{ afterSkip: Snapshot; final: Snapshot }> {
  const tempDir = mkdtempSync(join(tmpdir(), 'pgas-generated-upload-skip-smoke-'));
  const server = await createPgasServer({
    programs: [{ name: ${tsString(slug)}, entry: create${toPascalCase(slug)}ProgramEntry() }],
    drivers: {
      authorHandle: scriptedAuthor(script),
      observerHandle: {
        modelId: 'generated-upload-skip-smoke-observer',
        async complete() {
          return 'noop';
        },
      },
    },
    devMode: true,
    storage: { uploadsDir: join(tempDir, 'uploads') },
    telemetry: { enabled: false },
    port: 0,
  });
  const client = createPgasClient(appTransport(server.app, { token: 'dev-token' }));
  try {
    const created = await client.sessions.create({ program: ${tsString(slug)} });
    const sessionId = created.sessionId;
    await client.sessions.trigger(sessionId, { channel: ${tsString(entryChannel)}, payload: 'start generated optional skip smoke' });
    await client.sessions.trigger(sessionId, {
      channel: '${DOCUMENT_UPLOAD_CHANNEL}',
      payload: { ['${DOCUMENT_INTAKE_ROOT}.status']: '${DOCUMENT_SKIP_STATUS}' },
    });
    const afterSkip = await readSnapshot(client, sessionId);
    let final = afterSkip;
    for (let attempt = 0; attempt < 4 && final.mode !== 'complete'; attempt += 1) {
      await client.sessions.trigger(sessionId, { channel: ${tsString(entryChannel)}, payload: \`continue generated optional skip smoke \${String(attempt + 1)}\` });
      final = await readSnapshot(client, sessionId);
    }
    return { afterSkip, final };
  } finally {
    await server.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function uploadText(client: PgasClient, sessionId: string, name: string, content: string): Promise<unknown> {
  const form = new FormData();
  const file = new File([content], name, { type: 'text/plain' });
  form.append('files', file as unknown as Blob, file.name);
  return client.files.upload(sessionId, form);
}

function refsFromUpload(response: unknown): Array<Record<string, unknown>> {
  if (isRecord(response) && Array.isArray(response.files)) {
    return response.files.filter(isRecord);
  }
  return [];
}

async function readSnapshot(client: PgasClient, sessionId: string): Promise<Snapshot> {
  const [envelope, world] = await Promise.all([
    client.sessions.get(sessionId),
    client.sessions.world(sessionId),
  ]);
  const state = envelope.state as Record<string, unknown> | undefined;
  return {
    mode: firstString(envelope.mode, state?.mode),
    domain: world.domain as Record<string, unknown>,
    awaiting: isRecord(state?.awaitingUserDecision) ? state.awaitingUserDecision : undefined,
  };
}

function resultAt(domain: Record<string, unknown>, pathKey: string): Record<string, unknown> {
  const direct = domain[pathKey];
  if (isRecord(direct)) {
    return direct;
  }
  const prefix = \`\${pathKey}.\`;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(domain)) {
    if (key.startsWith(prefix)) {
      result[key.slice(prefix.length)] = value;
    }
  }
  return result;
}

function documentRefLanded(domain: Record<string, unknown>, fileId: string): boolean {
  const refs = domain['${DOCUMENT_INTAKE_ROOT}.file_refs'];
  if (Array.isArray(refs) && refs.some((ref) => isRecord(ref) && ref.fileId === fileId)) {
    return true;
  }
  if (domain['${DOCUMENT_INTAKE_ROOT}.file_refs.0.fileId'] === fileId) {
    return true;
  }
  const first = domain['${DOCUMENT_INTAKE_ROOT}.file_refs.0'];
  return isRecord(first) && first.fileId === fileId;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function scriptedAuthor(responses: ScriptedAuthorResponse[]) {
  let index = 0;
  return {
    modelId: 'generated-upload-smoke-author',
    async complete() {
      const response = responses[index++];
      if (!response) {
        throw new Error(\`no generated upload smoke author response scripted for call \${String(index - 1)}\`);
      }
      return JSON.stringify(response.response);
    },
  };
}

function effect(name: string, payload: Record<string, unknown>, channel = 'widget_output') {
  return { actions: [{ kind: 'EffectAction', name, channel, payload }] };
}

function scripted(response: ReturnType<typeof effect>): ScriptedAuthorResponse {
  return { response };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
`;
}

function renderConfirmationLoopSmokeTestSource(
  slug: string,
  name: string,
  entryChannel: string,
  loops: ConfirmationLoopDescriptor[],
  lifecycle?: CollectionLifecycleDescriptor,
): string {
  if (!lifecycle) {
    throw new Error('confirmation-loop smoke requires collection_lifecycle');
  }
  const loop = loops[0] as ConfirmationLoopDescriptor;
  const reactionNames = loops.flatMap((loop) => [
    confirmationLoopSaveReactionName(loop),
    confirmationLoopEnforceReactionName(loop),
    confirmationLoopChoreographReactionName(loop),
  ]);
  return `import { describe, expect, it } from 'vitest';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import { appTransport, createPgasClient, type PgasClient } from '@simodelne/pgas-server/client.js';
import { create${toPascalCase(slug)}ProgramEntry } from '../src/programs/${slug}/registration.js';
import { reactionHandlers } from '../src/programs/${slug}/handlers.js';

describe('generated confirmation-loop smoke', () => {
  it('runs the confirmation loop choreography hermetically through the route for ${name}', async () => {
    const entry = create${toPascalCase(slug)}ProgramEntry();
    expect(entry).toBeTruthy();
    for (const reaction of [${reactionNames.map(tsString).join(', ')}]) {
      expect(reactionHandlers.has(reaction)).toBe(true);
    }

    const server = await createPgasServer({
      programs: [{ name: ${tsString(slug)}, entry }],
      drivers: {
        authorHandle: scriptedAuthor([
          effect('begin_work', {}),
          effect(${tsString(`complete_${safeIdentifier(loop.seed.source_stage)}`)}, {
            result_json: JSON.stringify({ planned: true }),
            items_json: JSON.stringify([
              {
                id: 'wu-1',
                title: 'Verify Pre-Launch System Health Checks',
                description: 'Confirm critical services are healthy before launch.',
                status: 'pending_review',
              },
              {
                id: 'wu-2',
                title: 'Validate Deployment Rollback Procedures',
                description: 'Check rollback commands and ownership before release.',
              },
              {
                id: 'wu-3',
                title: 'Confirm Launch Communications Owner',
                description: 'Confirm the launch communication owner before release.',
              },
            ]),
          }, 'widget_output'),
          effect(${tsString(confirmationLoopProposeActionName(loop, 0, loops.length))}, {
            ${confirmationLoopProposalFields(loop, lifecycle).map((field) => `${field}: ${tsString('First proposal')},`).join('\n            ')}
          }),
          effect(${tsString(confirmationLoopProposeActionName(loop, 0, loops.length))}, {
            ${confirmationLoopProposalFields(loop, lifecycle).map((field) => `${field}: ${tsString('Second proposal')},`).join('\n            ')}
          }),
          effect(${tsString(confirmationLoopProposeActionName(loop, 0, loops.length))}, {
            ${confirmationLoopProposalFields(loop, lifecycle).map((field) => `${field}: ${tsString('Second proposal revised')},`).join('\n            ')}
          }),
          effect(${tsString(confirmationLoopProposeActionName(loop, 0, loops.length))}, {
            ${confirmationLoopProposalFields(loop, lifecycle).map((field) => `${field}: ${tsString('Third proposal')},`).join('\n            ')}
          }),
          effect('record_user_note', { note: 'All confirmation-loop items resolved.' }),
        ]),
        observerHandle: {
          modelId: 'generated-confirmation-loop-smoke-observer',
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
    const created = await client.sessions.create({ program: ${tsString(slug)} });
    const sessionId = created.sessionId;

    try {
      await client.sessions.trigger(sessionId, { channel: ${tsString(entryChannel)}, payload: 'start generated confirmation-loop smoke' });
      await client.sessions.trigger(sessionId, { channel: ${tsString(entryChannel)}, payload: 'plan generated confirmation-loop items' });
      let snapshot = await readSnapshot(client, sessionId);
      expect(snapshot.mode).toBe(${tsString(loop.stage)});
      expect(snapshot.domain[${tsString(`${loop.collection}.0.${loop.item_id_field ?? lifecycle.item.id_field}`)}]).toBe('wu-1');
      expect(snapshot.domain[${tsString(`${loop.collection}.0.${loop.item_title_field ?? 'title'}`)}]).toBe('Verify Pre-Launch System Health Checks');
      expect(snapshot.domain[${tsString(`${loop.collection}.0.${lifecycle.item.status_field}`)}]).toBe(${tsString(confirmationLoopInitialStatus(lifecycle))});
      expect(snapshot.domain[${tsString(`${loop.collection}.1.${loop.item_id_field ?? lifecycle.item.id_field}`)}]).toBe('wu-2');
      expect(snapshot.domain[${tsString(`${loop.collection}.1.${loop.item_title_field ?? 'title'}`)}]).toBe('Validate Deployment Rollback Procedures');
      expect(snapshot.domain[${tsString(`${loop.collection}.1.${lifecycle.item.status_field}`)}]).toBe(${tsString(confirmationLoopInitialStatus(lifecycle))});
      expect(snapshot.domain[${tsString(`${loop.collection}.2.${loop.item_id_field ?? lifecycle.item.id_field}`)}]).toBe('wu-3');
      expect(snapshot.domain[${tsString(`${loop.collection}.2.${loop.item_title_field ?? 'title'}`)}]).toBe('Confirm Launch Communications Owner');
      expect(snapshot.domain[${tsString(`${loop.collection}.2.${lifecycle.item.status_field}`)}]).toBe(${tsString(confirmationLoopInitialStatus(lifecycle))});

      await client.sessions.trigger(sessionId, { channel: ${tsString(entryChannel)}, payload: 'propose first generated item' });
      snapshot = await readSnapshot(client, sessionId);
      expect(snapshot.domain[${tsString(`${loop.collection}.0.${lifecycle.item.status_field}`)}]).toBe(${tsString(loop.proposed_status)});
      expect(snapshot.domain[${tsString(`${loop.collection}.0.proposed_text`)}]).toBe('First proposal');

      await client.sessions.trigger(sessionId, { channel: 'user_confirmation', payload: { decision: 'approve' } });
      snapshot = await readSnapshot(client, sessionId);
      expect(snapshot.domain[${tsString(`${loop.collection}.0.${lifecycle.item.status_field}`)}]).toBe('accepted');
      expect(snapshot.domain[${tsString(`${loop.collection}.1.${lifecycle.item.status_field}`)}]).toBe(${tsString(loop.proposed_status)});
      expect(snapshot.domain[${tsString(`${loop.collection}.1.proposed_text`)}]).toBe('Second proposal');

      await client.sessions.trigger(sessionId, {
        channel: 'user_confirmation',
        payload: { decision: 'request_revision', instruction: 'Tighten the proposed wording before asking again.' },
      });
      snapshot = await readSnapshot(client, sessionId);
      expect(snapshot.domain[${tsString(`${loop.collection}.1.${lifecycle.item.status_field}`)}]).toBe(${tsString(loop.proposed_status)});
      expect(snapshot.domain[${tsString(`${loop.collection}.1.user_instruction`)}]).toBe('Tighten the proposed wording before asking again.');
      expect(snapshot.domain[${tsString(`${loop.collection}.1.proposed_text`)}]).toBe('Second proposal revised');

      await client.sessions.trigger(sessionId, { channel: 'user_confirmation', payload: { decision: 'approve' } });
      snapshot = await readSnapshot(client, sessionId);
      expect(snapshot.domain[${tsString(`${loop.collection}.1.${lifecycle.item.status_field}`)}]).toBe('accepted');
      expect(snapshot.domain[${tsString(`${loop.collection}.2.${lifecycle.item.status_field}`)}]).toBe(${tsString(loop.proposed_status)});
      expect(snapshot.domain[${tsString(`${loop.collection}.2.proposed_text`)}]).toBe('Third proposal');

      await client.sessions.trigger(sessionId, { channel: 'user_confirmation', payload: { decision: 'reject' } });
      snapshot = await readSnapshot(client, sessionId);
      expect(snapshot.domain[${tsString(`${loop.collection}.2.${lifecycle.item.status_field}`)}]).toBe('skipped');
      expect(snapshot.domain[${tsString(loop.aggregate.guard_field)}]).toBe(true);
      expect(snapshot.mode).toBe('complete');
    } finally {
      await server.close();
    }
  });
});

interface SmokeSnapshot {
  mode: string | null;
  terminal: boolean;
  domain: Record<string, unknown>;
}

type ScriptedAuthorResponse = ReturnType<typeof effect>;

async function readSnapshot(client: PgasClient, sessionId: string): Promise<SmokeSnapshot> {
  const [envelope, world] = await Promise.all([
    client.sessions.get(sessionId),
    client.sessions.world(sessionId),
  ]);
  const state = envelope.state as Record<string, unknown> | undefined;
  return {
    mode: firstString(envelope.mode, state?.mode),
    terminal: Boolean(state?.terminal ?? envelope.terminal),
    domain: world.domain as Record<string, unknown>,
  };
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function scriptedAuthor(responses: ScriptedAuthorResponse[]) {
  let index = 0;
  return {
    modelId: 'generated-confirmation-loop-smoke-author',
    async complete() {
      const response = responses[index++];
      if (!response) {
        throw new Error(\`no generated confirmation-loop smoke author response scripted for call \${String(index - 1)}\`);
      }
      return JSON.stringify(response);
    },
  };
}

function effect(name: string, payload: Record<string, unknown>, channel = 'widget_output') {
  return { actions: [{ kind: 'EffectAction', name, channel, payload }] };
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

function synthesizeDelegationChildArtifacts(
  parentSlug: string,
  parentName: string,
  children: DelegationChildDescriptor[],
): SynthesizedChildArtifact[] {
  return children
    .filter((child) => child.synthesize_child?.kind === 'worker' || child.synthesize_child?.kind === 'research_agent')
    .map((child) => synthesizeDelegationChildArtifact(parentSlug, parentName, child));
}

function synthesizeDelegationChildArtifact(
  parentSlug: string,
  parentName: string,
  child: DelegationChildDescriptor,
): SynthesizedChildArtifact {
  if (child.synthesize_child?.kind === 'research_agent') {
    return synthesizeResearchAgentChildArtifact(parentSlug, parentName, child);
  }
  return synthesizeWorkerChildArtifact(parentSlug, parentName, child);
}

function synthesizeWorkerChildArtifact(
  parentSlug: string,
  parentName: string,
  child: DelegationChildDescriptor,
): SynthesizedChildArtifact {
  if (!child.synthesize_child) {
    throw new Error(`delegation child ${child.id} is missing synthesize_child`);
  }
  const childSlug = delegationTargetSpec(child);
  const childName = `${parentName} ${toPascalCase(child.id)} Worker`;
  const childDomain = workerChildDomain(parentSlug, childSlug, childName, child);
  const artifact = synthesizeProgramSpecFromDomain(childDomain, {
    reasoningContracts: {
      work: workerChildReasoningContract(child),
    },
  });
  const specYaml = patchWorkerChildSpecForDelegation(artifact.spec_yaml, child);
  return {
    ...artifact,
    slug: childSlug,
    name: childName,
    spec_yaml: specYaml,
    sha256: createHash('sha256').update(specYaml).digest('hex'),
    registration_ts: renderRegistrationSource(toPascalCase(childSlug), {
      delegationResultPolicy: delegationResultPolicyForChild(child),
    }),
  };
}

function synthesizeResearchAgentChildArtifact(
  parentSlug: string,
  parentName: string,
  child: DelegationChildDescriptor,
): SynthesizedChildArtifact {
  if (!child.synthesize_child) {
    throw new Error(`delegation child ${child.id} is missing synthesize_child`);
  }
  const childSlug = delegationTargetSpec(child);
  const childName = `${parentName} ${toPascalCase(child.id)} Research Agent`;
  const backend = researchChildBackend(child);
  const childDomain = researchAgentChildDomain(parentSlug, childSlug, childName, child, backend);
  const artifact = synthesizeProgramSpecFromDomain(childDomain, backend === 'self_contained'
    ? {
        reasoningContracts: {
          research: researchAgentChildReasoningContract(child),
        },
      }
    : {});
  const specYaml = patchDelegationChildSpecForDelegation(artifact.spec_yaml, child, 'research');
  const gap = backend === 'host_connector' ? researchBackendCapabilityGap(child) : undefined;
  const contractsTs = backend === 'host_connector'
    ? appendResearchHostConnectorContracts(artifact.contracts_ts, child, gap!)
    : artifact.contracts_ts;
  return {
    ...artifact,
    slug: childSlug,
    name: childName,
    spec_yaml: specYaml,
    sha256: createHash('sha256').update(specYaml).digest('hex'),
    contracts_ts: contractsTs,
    ...(backend === 'host_connector'
      ? {
          stage_sources: {
            ...(artifact.stage_sources ?? {}),
            research: renderResearchHostConnectorMockStageSource(child),
          },
          capability_gaps: gap ? [gap] : [],
        }
      : {}),
    registration_ts: renderRegistrationSource(toPascalCase(childSlug), {
      delegationResultPolicy: delegationResultPolicyForChild(child),
    }),
  };
}

function workerChildDomain(
  parentSlug: string,
  childSlug: string,
  childName: string,
  child: DelegationChildDescriptor,
): Record<string, unknown> {
  const resultFields = child.synthesize_child?.result_fields ?? {};
  return {
    'program.slug': childSlug,
    'program.name': childName,
    'program.target_dir': `/tmp/${childSlug}`,
    'intake.purpose': `Handle a delegated worker task for ${parentSlug}.`,
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      {
        slug: 'receive',
        is_bootstrap: true,
        domain_spec: {
          reads: ['inputs.request.topic', 'inputs.domain_context.source_program'],
          produces: {},
          rules: ['Accept the delegated request seeded by the parent session.'],
          invariants: ['Do not invent a different request topic.'],
        },
      },
      {
        slug: 'work',
        domain_spec: {
          reads: ['inputs.request.topic', 'inputs.domain_context.source_program', 'inputs.domain_context.original_request'],
          produces: {
            result_json: Object.fromEntries(Object.keys(resultFields).map((field) => [field, 'string'])),
            items_json: [`${child.id}:<seeded_topic>`],
          },
          rules: [
            'Produce the delegated worker result from the seeded request.',
            'Echo inputs.request.topic exactly into work.result.seeded_topic when that field exists.',
          ],
          invariants: ['The exported seeded_topic proves parent input enrichment reached the child.'],
        },
      },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'receive', to: 'work', trigger: 'received', guard_field: 'receive.started' },
      { from: 'work', to: 'complete', trigger: 'completed', guard_field: 'work.done' },
    ]),
    'intake.delegation_json': JSON.stringify({
      enabled: false,
      stages: {
        work: { kind: 'llm-reasoning', reasoning_per_turn: true },
      },
    }),
    'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'work.done' }),
  };
}

function workerChildReasoningContract(child: DelegationChildDescriptor): ReasoningStageContract {
  const rawFields = child.synthesize_child?.result_fields ?? {};
  const fields = Object.entries(rawFields).map(([name, rawType]) => ({
    name,
    type: reasoningFieldTypeFor(rawType),
    description: name === 'seeded_topic'
      ? 'Exact echo of inputs.request.topic supplied by parent input enrichment.'
      : `Delegated worker ${name.replace(/_/gu, ' ')} result.`,
  }));
  const cannedResult = Object.fromEntries(fields.map((field) => [
    field.name,
    field.type === 'number'
      ? 1
      : field.type === 'boolean'
        ? true
        : field.type === 'string_array'
          ? [`${field.name}-sample`]
          : field.name === 'seeded_topic'
            ? 'seeded delegation topic'
            : `${field.name}-sample`,
  ]));
  return {
    contract_version: REASONING_CONTRACT_VERSION,
    stage: 'work',
    reasoning_prompt: `Complete delegated worker request ${child.id}. Use the projected inputs.request.topic and inputs.domain_context fields. Return the requested result fields; seeded_topic must exactly echo inputs.request.topic when present.`,
    result_schema: {
      fields,
      allow_extra_fields: true,
    },
    items_schema: {
      templates: [`${child.id}:summary:<summary>`],
      description: 'One concise delegated-work item summary.',
    },
    canned_example: {
      result: cannedResult,
      items: [`${child.id}:summary:complete`],
    },
    contract_source: 'deterministic_fallback',
  };
}

function researchAgentChildDomain(
  parentSlug: string,
  childSlug: string,
  childName: string,
  child: DelegationChildDescriptor,
  backend: 'host_connector' | 'self_contained',
): Record<string, unknown> {
  const resultFields = child.synthesize_child?.result_fields ?? {};
  const resultSchema = Object.fromEntries(Object.keys(resultFields).map((field) => [field, 'string']));
  return {
    'program.slug': childSlug,
    'program.name': childName,
    'program.target_dir': `/tmp/${childSlug}`,
    'intake.purpose': backend === 'host_connector'
      ? `Expose a host-backed research connector contract for ${parentSlug}; the generated child uses only an in-memory mock.`
      : `Research a delegated request for ${parentSlug} using the seeded request context.`,
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      {
        slug: 'receive',
        is_bootstrap: true,
        domain_spec: {
          reads: ['inputs.request.topic', 'inputs.domain_context.source_program'],
          produces: {},
          rules: ['Accept the delegated research request seeded by the parent session.'],
          invariants: ['Do not invent a different request topic.'],
        },
      },
      {
        slug: 'research',
        domain_spec: {
          reads: ['inputs.request.topic', 'inputs.request.query', 'inputs.domain_context.source_program', 'inputs.domain_context.original_request'],
          produces: {
            result_json: backend === 'host_connector'
              ? { ...resultSchema, adapter_kind: 'string' }
              : resultSchema,
            items_json: [`${child.id}:<seeded_topic>`],
          },
          rules: backend === 'host_connector'
            ? [
                'Do not implement a real research backend in foundry code.',
                'Use only the fixture-backed in-memory mock research connector.',
                'Echo inputs.request.topic exactly into the seeded_topic result field when that field exists.',
              ]
            : [
                'Research over the delegated request using only the projected inputs.request and inputs.domain_context fields.',
                'Echo inputs.request.topic exactly into research.result.seeded_topic when that field exists.',
              ],
          invariants: backend === 'host_connector'
            ? [
                'adapter_kind must be in_memory_mock.',
                'The exported seeded_topic proves parent input enrichment reached the child.',
              ]
            : ['The exported seeded_topic proves parent input enrichment reached the child.'],
        },
      },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'receive', to: 'research', trigger: 'received', guard_field: 'receive.started' },
      { from: 'research', to: 'complete', trigger: 'completed', guard_field: 'research.done' },
    ]),
    'intake.delegation_json': JSON.stringify({
      enabled: false,
      stages: {
        research: backend === 'host_connector'
          ? {
              kind: 'external-adapter',
              research_backend: 'host_connector',
              host_required: true,
              integration_gap: true,
              connector_slug: delegationTargetSpec(child),
            }
          : { kind: 'llm-reasoning', reasoning_per_turn: true },
      },
    }),
    'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'research.done' }),
  };
}

function researchAgentChildReasoningContract(child: DelegationChildDescriptor): ReasoningStageContract {
  const rawFields = child.synthesize_child?.result_fields ?? {};
  const fields = Object.entries(rawFields).map(([name, rawType]) => ({
    name,
    type: reasoningFieldTypeFor(rawType),
    description: name === 'seeded_topic'
      ? 'Exact echo of inputs.request.topic supplied by parent input enrichment.'
      : `Delegated research ${name.replace(/_/gu, ' ')} result.`,
  }));
  const cannedResult = Object.fromEntries(fields.map((field) => [
    field.name,
    field.type === 'number'
      ? 1
      : field.type === 'boolean'
        ? true
        : field.type === 'string_array'
          ? [`${field.name}-sample`]
          : field.name === 'seeded_topic'
            ? 'seeded delegation topic'
            : `${field.name}-sample`,
  ]));
  return {
    contract_version: REASONING_CONTRACT_VERSION,
    stage: 'research',
    reasoning_prompt: `Complete delegated research request ${child.id}. Use the projected inputs.request.topic, inputs.request.query, and inputs.domain_context fields. Return the requested result fields; seeded_topic must exactly echo inputs.request.topic when present.`,
    result_schema: {
      fields,
      allow_extra_fields: true,
    },
    items_schema: {
      templates: [`${child.id}:research:<summary>`],
      description: 'One concise delegated-research item summary.',
    },
    canned_example: {
      result: cannedResult,
      items: [`${child.id}:research:complete`],
    },
    contract_source: 'deterministic_fallback',
  };
}

function patchWorkerChildSpecForDelegation(specYaml: string, child: DelegationChildDescriptor): string {
  return patchDelegationChildSpecForDelegation(specYaml, child, 'work');
}

function patchDelegationChildSpecForDelegation(specYaml: string, child: DelegationChildDescriptor, middleStage: 'research' | 'work'): string {
  const spec = load(specYaml) as MutableRecord;
  const schema = recordField(spec, 'schema');
  schema['inputs.request'] = 'object';
  schema['inputs.request.intent'] = 'string';
  schema['inputs.request.query'] = 'string';
  schema['inputs.request.topic'] = 'string';
  schema['inputs.domain_context'] = 'object';
  schema['inputs.domain_context.source_program'] = 'string';
  schema['inputs.domain_context.source_session_id'] = 'string';
  schema['inputs.domain_context.owner_session_id'] = 'string';
  schema['inputs.domain_context.target_program'] = 'string';
  schema['inputs.domain_context.delegation_chain'] = 'array';
  schema['inputs.domain_context.original_request'] = 'string';

  const projection = recordField(spec, 'projection');
  for (const modeName of ['receive', middleStage, 'complete']) {
    const modeProjection = recordField(projection, modeName);
    const include = Array.isArray(modeProjection.include) ? modeProjection.include as string[] : [];
    modeProjection.include = unique([
      ...include,
      'inputs.request',
      'inputs.request.intent',
      'inputs.request.query',
      'inputs.request.topic',
      'inputs.domain_context',
      'inputs.domain_context.source_program',
      'inputs.domain_context.original_request',
    ]);
  }

  const prompts = recordField(spec, 'prompts');
  prompts.receive = `${String(prompts.receive ?? '')}\nAccept the delegated request; inputs.request and inputs.domain_context are seeded by the parent delegation.`;
  prompts[middleStage] = `${String(prompts[middleStage] ?? '')}\nUse inputs.request.topic as the delegated topic. The seeded_topic result field, when present, must echo that exact value.`;

  const actionMap = recordField(spec, 'action_map');
  const completeStage = recordField(actionMap, `complete_${middleStage}`);
  const mutations = Array.isArray(completeStage.mutations) ? completeStage.mutations as MutableRecord[] : [];
  for (const mutation of mutations) {
    if (mutation.path === `${middleStage}.result.seeded_topic`) {
      mutation.value = '';
      mutation.from_arg = 'seeded_topic';
      mutation.from_state = 'inputs.request.topic';
    }
  }
  completeStage.mutations = mutations;

  const rendered = dump(spec, { lineWidth: -1, noRefs: true, sortKeys: false });
  validateSynthesizedSpec(rendered);
  return rendered;
}

function reasoningFieldTypeFor(value: string): ReasoningStageContract['result_schema']['fields'][number]['type'] {
  const normalized = value.toLowerCase().replace(/[-\s]+/gu, '_');
  if (normalized === 'number') return 'number';
  if (normalized === 'boolean') return 'boolean';
  if (normalized === 'string_array' || normalized === 'array') return 'string_array';
  return 'string';
}

function researchChildBackend(child: DelegationChildDescriptor): 'host_connector' | 'self_contained' {
  return child.synthesize_child?.research_backend === 'host_connector' ? 'host_connector' : 'self_contained';
}

function resolveDelegationChildrenAgainstManifest(
  delegation: DelegationDescriptor,
  availablePrograms: WiringAvailableProgram[],
): DelegationDescriptor {
  if (!Array.isArray(delegation.children) || delegation.children.length === 0 || availablePrograms.length === 0) {
    return delegation;
  }

  let changed = false;
  const children = delegation.children.map((child) => {
    const researchEntry = availablePrograms.find((candidate) =>
      candidate.provides === 'delegation_research_agent' &&
      child.synthesize_child?.kind === 'research_agent' &&
      researchChildBackend(child) === 'host_connector');
    if (researchEntry) {
      changed = true;
      const { synthesize_child: _deleted, ...rewritten } = child;
      return {
        ...rewritten,
        target_spec: researchEntry.target_spec,
        registered_name: researchEntry.slug,
        payload_map: researchEntry.payload_map ?? child.payload_map,
        result_path: researchEntry.result_path ?? child.result_path,
      };
    }

    // Slice A: reuse of the existing simoneos document-ingest / review agents.
    // These children are target_spec-only from the notebook (nothing to
    // synthesize — the agent already exists), so we validate-and-stamp: match a
    // manifest entry by its document-ingest / review provides tag whose
    // target_spec or slug names the author's target_spec, then stamp
    // registered_name (for the allowedTargetPrograms both-names fix) and
    // normalize target_spec to the manifest's canonical spec name.
    const reuseEntry = reusableAgentEntryForChild(child, availablePrograms);
    if (reuseEntry) {
      changed = true;
      return {
        ...child,
        target_spec: reuseEntry.target_spec,
        registered_name: reuseEntry.slug,
        payload_map: reuseEntry.payload_map ?? child.payload_map,
        result_path: reuseEntry.result_path ?? child.result_path,
      };
    }

    return child;
  });

  return changed ? { ...delegation, children } : delegation;
}

const REUSABLE_AGENT_PROVIDES: readonly WiringAvailableProgram['provides'][] = [
  'delegation_document_ingest',
  'delegation_review',
];

// Canonical delegated-input roots a payload_map target may land under (child inputs.<target>).
// request.*/domain_context.* cover synthesized workers + shared context; answers.* and
// document_intake.* let manifest-reuse payload_maps hit the real SimoneOS agents' input
// contracts (Legal Research answers.research_question, Review Service document_intake.work_product).
const DELEGATION_PAYLOAD_TARGET_ROOTS = ['request.', 'domain_context.', 'answers.', 'document_intake.'] as const;

function reusableAgentEntryForChild(
  child: DelegationChildDescriptor,
  availablePrograms: WiringAvailableProgram[],
): WiringAvailableProgram | undefined {
  // Only a target_spec-only child (author declares no synthesize_child) can be
  // wired to an already-registered agent; a synthesize_child demand is the
  // research path handled above.
  const requestedTarget = child.target_spec?.trim();
  if (!requestedTarget || child.synthesize_child !== undefined) {
    return undefined;
  }
  return availablePrograms.find((candidate) =>
    REUSABLE_AGENT_PROVIDES.includes(candidate.provides) &&
    (candidate.target_spec === requestedTarget || candidate.slug === requestedTarget));
}

function childResultStage(child: DelegationChildDescriptor): 'research' | 'work' {
  return child.synthesize_child?.kind === 'research_agent' ? 'research' : 'work';
}

function researchBackendCapabilityGap(child: DelegationChildDescriptor): CapabilityGap {
  const connectorSlug = delegationTargetSpec(child);
  return {
    capability: 'delegation_research_agent',
    stage: 'research',
    connector_slug: connectorSlug,
    message: `research backend is host-required — implement the ${connectorSlug} connector`,
  };
}

function capabilityGapsForDelegationChildren(children: DelegationChildDescriptor[]): CapabilityGap[] {
  return children
    .filter((child) => child.synthesize_child?.kind === 'research_agent' && researchChildBackend(child) === 'host_connector')
    .map(researchBackendCapabilityGap);
}

function tsTypeForResultField(value: string): string {
  const normalized = value.toLowerCase().replace(/[-\s]+/gu, '_');
  if (normalized === 'number') return 'number';
  if (normalized === 'boolean') return 'boolean';
  if (normalized === 'string_array' || normalized === 'array') return 'string[]';
  return 'string';
}

function appendResearchHostConnectorContracts(source: string, child: DelegationChildDescriptor, gap: CapabilityGap): string {
  const fields = Object.entries(child.synthesize_child?.result_fields ?? {});
  const resultMembers = fields
    .map(([field, type]) => `  ${field}: ${tsTypeForResultField(type)};`)
    .join('\n');
  const contractFields = fields
    .map(([field, type]) => `    { name: ${tsString(field)}, type: ${tsString(type)} },`)
    .join('\n');
  return `${source}

export interface ResearchHostConnectorRequest {
  topic: string;
  query?: string;
  source_program?: string;
  original_request?: string;
}

export interface ResearchHostConnectorResult {
${resultMembers}
}

export interface ResearchHostConnector {
  research(request: ResearchHostConnectorRequest): Promise<ResearchHostConnectorResult>;
}

export const researchHostConnectorContract = {
  connector_slug: ${tsString(gap.connector_slug)},
  request: {
    topic: 'string',
    query: 'string',
    source_program: 'string',
    original_request: 'string',
  },
  result_fields: [
${contractFields}
  ],
  fixture_adapter_kind: 'in_memory_mock',
} as const;

export const capabilityGaps = ${JSON.stringify([gap], null, 2)} as const;
`;
}

function appendDocumentExtractionHostConnectorContracts(source: string, gaps: readonly CapabilityGap[]): string {
  if (gaps.length === 0) {
    return source;
  }
  const [gap] = gaps;
  return `${source}

export interface DocumentExtractionHostConnectorDocument {
  name?: string;
  mime_type?: string;
  size?: number;
  content_base64: string;
}

export interface DocumentExtractionHostConnectorRequest {
  stage: string;
  connector_slug: string;
  documents: readonly DocumentExtractionHostConnectorDocument[];
}

export interface DocumentExtractionHostConnectorFileResult {
  name?: string;
  text: string;
  char_count: number;
}

export interface DocumentExtractionHostConnectorResult {
  text: string;
  char_count: number;
  files: readonly DocumentExtractionHostConnectorFileResult[];
}

export interface DocumentExtractionHostConnector {
  extractText(request: DocumentExtractionHostConnectorRequest): Promise<DocumentExtractionHostConnectorResult>;
}

export const documentExtractionHostConnectorContract = {
  connector_slug: ${tsString(gap!.connector_slug)},
  request: {
    stage: 'string',
    connector_slug: 'string',
    documents: 'DocumentExtractionHostConnectorDocument[]',
  },
  result: {
    text: 'string',
    char_count: 'number',
    files: 'DocumentExtractionHostConnectorFileResult[]',
  },
  fixture_adapter_kind: 'in_memory_mock',
} as const;

export async function documentExtractionHostConnectorFixtureMock(
  request: DocumentExtractionHostConnectorRequest,
): Promise<DocumentExtractionHostConnectorResult> {
  const files = request.documents.map((document, index) => {
    const label = document.name && document.name.length > 0 ? document.name : \`document-\${String(index + 1)}.pdf\`;
    const text = \`HOST_CONNECTOR_MOCK_PDF_TEXT \${label}\`;
    return { name: document.name, text, char_count: text.length };
  });
  const text = files.map((file) => file.text).join('\\n\\n');
  return { text, char_count: text.length, files };
}

export const capabilityGaps = ${JSON.stringify(gaps, null, 2)} as const;
`;
}

function renderResearchHostConnectorMockStageSource(child: DelegationChildDescriptor): string {
  const fieldEntries = Object.entries(child.synthesize_child?.result_fields ?? {})
    .map(([field, type]) => {
      if (field === 'seeded_topic') {
        return `    seeded_topic: topic,`;
      }
      const normalizedType = tsTypeForResultField(type);
      if (normalizedType === 'number') return `    ${field}: 1,`;
      if (normalizedType === 'boolean') return `    ${field}: true,`;
      if (normalizedType === 'string[]') return `    ${field}: [${tsString(`${field}-sample`)}],`;
      return `    ${field}: ${tsString(`${field}-sample`)},`;
    })
    .join('\n');
  return `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void runtime;
  const topic = stringFact(input.domain['inputs.request.topic'], 'seeded delegation topic');
  const result = {
${fieldEntries}
    adapter_kind: 'in_memory_mock',
  };
  return {
    result_json: JSON.stringify(result),
    items_json: JSON.stringify([\`research:\${topic}\`]),
    digest: '',
    adapter_kind: 'in_memory_mock',
  };
}

function stringFact(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}
`;
}

function delegationPolicyForChildren(children: DelegationChildDescriptor[]): {
  allowedTargetPrograms: string[];
  inputEnrichment: Array<{ source: string; target: string }>;
} {
  return {
    allowedTargetPrograms: unique(children.flatMap((child) => [
      delegationTargetSpec(child),
      ...(child.registered_name ? [child.registered_name] : []),
    ])),
    inputEnrichment: children.flatMap((child) =>
      Object.entries(child.payload_map).map(([target, source]) => ({ source, target })),
    ),
  };
}

function delegationResultPolicyForChild(child: DelegationChildDescriptor): {
  fields: Array<{ path: string; key: string }>;
} {
  const stage = childResultStage(child);
  if (child.synthesize_child?.kind === 'research_agent' && researchChildBackend(child) === 'host_connector') {
    return {
      fields: [
        { path: `${stage}.output`, key: 'result' },
        { path: `${stage}.output.result_json`, key: 'result_json' },
        { path: `${stage}.output.adapter_kind`, key: 'adapter_kind' },
      ],
    };
  }
  return {
    fields: [
      { path: `${stage}.result`, key: 'result' },
      ...delegationResultFields(child).map(([field]) => ({ path: `${stage}.result.${field}`, key: field })),
    ],
  };
}

function artifactPolicyForExportDescriptors(descriptors: readonly ExportStageDescriptor[]): ProgramArtifactPolicy | undefined {
  if (descriptors.length === 0) {
    return undefined;
  }
  return {
    rules: descriptors.map((descriptor) => ({
      artifactType: descriptor.artifactType,
      title: descriptor.title,
      summary: descriptor.kind === 'export_docx'
        ? 'Deterministically rendered DOCX artifact; payload bytes are base64 in domain state.'
        : 'Deterministically rendered HTML artifact; payload is in domain state.',
      payloadRef: descriptor.payloadRef,
      whenAllPaths: [`${descriptor.payloadRef}.result_json`],
    })),
  };
}

function renderRegistrationSource(
  pascalName: string,
  policies: {
    delegationPolicy?: { allowedTargetPrograms: string[]; inputEnrichment: Array<{ source: string; target: string }> };
    delegationResultPolicy?: { fields: Array<{ path: string; key: string }> };
    artifactPolicy?: ProgramArtifactPolicy;
  } = {},
): string {
  const policyEntries = [
    policies.delegationPolicy
      ? `    delegationPolicy: ${renderTsValue(policies.delegationPolicy)},`
      : '',
    policies.delegationResultPolicy
      ? `    delegationResultPolicy: ${renderTsValue(policies.delegationResultPolicy)},`
      : '',
    policies.artifactPolicy
      ? `    artifactPolicy: ${renderTsValue(policies.artifactPolicy)},`
      : '',
  ].filter(Boolean).join('\n');
  return `import {
  createProgramAdapters,
  createToolRegistry,
  loadSpecWithPatterns,
  type ProgramEntry,
} from '@simodelne/pgas-server/plugin.js';
import { handlers, reactionHandlers } from './handlers.js';
import { register${pascalName}Tools } from './tools.js';

export function create${pascalName}ProgramEntry(): ProgramEntry {
  const specPath = decodeURIComponent(new URL('./specs.yml', import.meta.url).pathname);
  const { spec } = loadSpecWithPatterns(specPath);
  const toolRegistry = createToolRegistry();
  register${pascalName}Tools(toolRegistry);

  return {
    spec,
    reactionHandlers,
${policyEntries ? `${policyEntries}\n` : ''}    createAdapters: (ctx) => {
      const adapters = createProgramAdapters(spec, ctx, handlers);
      if (spec.tools) {
        for (const [name, decl] of spec.tools) {
          if (toolRegistry.has(name)) {
            adapters.outputs.set(decl.channelId, toolRegistry.createAdapter(name));
          }
        }
      }
      return adapters;
    },
  };
}
`;
}

function renderTsValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(renderTsValue).join(', ')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, entryValue]) => `${key}: ${renderTsValue(entryValue)}`);
    return `{ ${entries.join(', ')} }`;
  }
  if (typeof value === 'string') {
    return tsString(value);
  }
  return JSON.stringify(value);
}

function renderReuseDelegationSmokeTestSource(
  slug: string,
  name: string,
  entryChannel: string,
  child: DelegationChildDescriptor,
  transitionActions: TransitionAction[],
): string {
  const parentPascal = toPascalCase(slug);
  const childTargetSpec = delegationTargetSpec(child);
  const childRegistryName = child.registered_name ?? childTargetSpec;
  const transitionAction = transitionActions.find((action) => action.source === child.stage);
  const transitionActionName = transitionAction?.name ?? `complete_${safeIdentifier(child.stage)}`;
  const transitionChannel = transitionAction?.archetype === 'llm-reasoning' ? 'widget_output' : 'stage_output';
  const resultPath = child.result_path;
  const base = delegationStateBase(child);
  const policy = delegationPolicyForChildren([child]);
  const childSpecYaml = `name: ${JSON.stringify(childTargetSpec)}
termination: BoundedSession
topology: CyclicTopology
pure: true

preamble: |
  Inline manifest-reuse smoke child for ${name}.

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
    include: [inputs.request, inputs.request.topic, inputs.domain_context, inputs.domain_context.source_program]
    exclude: []
  work:
    include: [inputs.request, inputs.request.topic, child.received, work.summary, work.seeded_topic]
    exclude: []
  complete:
    include: [inputs.request, inputs.request.topic, child.received, work.done, work.summary, work.seeded_topic]
    exclude: []

prompts:
  receive: "Accept the delegated manifest-reuse request."
  work: "Finish the delegated manifest-reuse request and echo the seeded topic."
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
    description: "Complete the delegated manifest-reuse request."
    mutations:
      - { op: MSet, path: work.done, value: true }
      - { op: MSet, path: work.summary, from_arg: summary }
      - { op: MSet, path: work.seeded_topic, from_arg: seeded_topic }
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
  work.seeded_topic: string

repair_bound: 2

fallback:
  channel: child_output
  payload: { ok: false }
`;
  return `import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import { appTransport, createPgasClient, type PgasClient } from '@simodelne/pgas-server/client.js';
import {
  createProgramAdapters,
  createToolRegistry,
  loadSpecWithPatterns,
  type ProgramEntry,
  type ToolHandler,
} from '@simodelne/pgas-server/plugin.js';
import { create${parentPascal}ProgramEntry } from '../src/programs/${slug}/registration.js';
import { handlers, reactionHandlers } from '../src/programs/${slug}/handlers.js';
import { register${parentPascal}Tools } from '../src/programs/${slug}/tools.js';

describe('generated manifest reuse delegation smoke', () => {
  it('runs manifest-reused delegation hermetically through the route for ${name}', async () => {
    const complete = await runDelegationScenario({
      script: [
        scripted(effect('begin_work', {})),
        scripted(effect(${tsString(delegationRequestActionName(child))}, { request: { topic: 'seeded delegation topic' } }, ${tsString(delegationChannelName(child))})),
        scripted(effect('accept_request', { accepted: true }, 'child_output'), 'seeded delegation topic'),
        scripted(effect('finish_work', {
          summary: 'complete legal research',
          seeded_topic: 'seeded delegation topic',
        }, 'child_output'), 'seeded delegation topic'),
        scripted(effect(${tsString(transitionActionName)}, {
          result_json: JSON.stringify({ parent: 'complete after delegation' }),
          items_json: JSON.stringify(['parent-complete']),
        }, ${tsString(transitionChannel)})),
      ],
    });
    const result = resultAt(complete.afterDelegation.domain, ${tsString(resultPath)});
    expect(result.status).toBe('complete');
    expect(Number(result.rounds)).toBeGreaterThanOrEqual(1);
    expect(result.mode).toBe('complete');
    expect(result.summary).toBe('complete legal research');
    expect(result.seeded_topic).toBe('seeded delegation topic');
    expect(complete.afterDelegation.domain[${tsString(`${base}.settled`)}]).toBe(true);
    expect(complete.afterDelegation.domain[${tsString(`${base}.degraded`)}]).toBe(false);
    expect(complete.final.mode).toBe('complete');

    const degraded = await runDelegationScenario({
      parentMaxDelegatedRounds: 1,
      script: [
        scripted(effect('begin_work', {})),
        scripted(effect(${tsString(delegationRequestActionName(child))}, { request: { topic: 'force-degrade' } }, ${tsString(delegationChannelName(child))})),
        scripted(effect('accept_request', { accepted: true }, 'child_output'), 'force-degrade'),
        scripted(effect(${tsString(transitionActionName)}, {
          result_json: JSON.stringify({ parent: 'complete after degraded delegation' }),
          items_json: JSON.stringify(['parent-complete-after-degrade']),
        }, ${tsString(transitionChannel)})),
      ],
    });
    const degradeResult = resultAt(degraded.afterDelegation.domain, ${tsString(resultPath)});
    expect(degradeResult.status).toBe('failed');
    expect(degradeResult.optional).toBe(true);
    expect(degraded.afterDelegation.domain[${tsString(`${base}.settled`)}]).toBe(true);
    expect(degraded.afterDelegation.domain[${tsString(`${base}.degraded`)}]).toBe(true);
    expect(String(degraded.afterDelegation.domain[${tsString(`${base}.degrade_reason`)}]).length).toBeGreaterThan(0);
    expect(degraded.final.mode).toBe('complete');
  });
});

interface DelegationScenario {
  parentMaxDelegatedRounds?: number;
  script: ScriptedAuthorResponse[];
}

interface ScriptedAuthorResponse {
  response: ReturnType<typeof effect>;
  expectPromptIncludes?: string;
}

interface Snapshot {
  mode: string | null;
  domain: Record<string, unknown>;
}

async function runDelegationScenario(scenario: DelegationScenario): Promise<{ afterDelegation: Snapshot; final: Snapshot }> {
  const tempDir = mkdtempSync(join(tmpdir(), 'pgas-generated-reuse-delegation-smoke-'));
  const server = await createPgasServer({
    programs: [
      {
        name: ${tsString(slug)},
        entry: scenario.parentMaxDelegatedRounds === undefined
          ? create${parentPascal}ProgramEntry()
          : createPatchedParentEntry(tempDir, scenario.parentMaxDelegatedRounds),
      },
      { name: ${tsString(childRegistryName)}, entry: createManifestReuseStubChildEntry(tempDir) },
    ],
    drivers: {
      authorHandle: scriptedAuthor(scenario.script),
      observerHandle: {
        modelId: 'generated-reuse-delegation-smoke-observer',
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
    const created = await client.sessions.create({ program: ${tsString(slug)} });
    const sessionId = created.sessionId;
    await client.sessions.trigger(sessionId, { channel: ${tsString(entryChannel)}, payload: 'seeded delegation topic' });
    await client.sessions.trigger(sessionId, { channel: ${tsString(entryChannel)}, payload: 'dispatch manifest-reused research' });
    const afterDelegation = await readSnapshot(client, sessionId);
    // The delegation continuation may already have advanced the parent to a terminal
    // mode; tolerate an over-trigger on the completion step.
    try {
      await client.sessions.trigger(sessionId, { channel: ${tsString(entryChannel)}, payload: 'complete parent after delegation settled' });
    } catch (error) {
      if (!String((error as Error).message).includes('terminal')) throw error;
    }
    const final = await readSnapshot(client, sessionId);
    return { afterDelegation, final };
  } finally {
    await server.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function createPatchedParentEntry(tempDir: string, maxDelegatedRounds: number): ProgramEntry {
  const sourcePath = decodeURIComponent(new URL('../src/programs/${slug}/specs.yml', import.meta.url).pathname);
  const source = readFileSync(sourcePath, 'utf8');
  const patched = source.replace(/max_delegated_rounds: \\d+/u, \`max_delegated_rounds: \${String(maxDelegatedRounds)}\`);
  const specPath = join(tempDir, 'parent-patched-specs.yml');
  writeFileSync(specPath, patched, 'utf8');
  const { spec } = loadSpecWithPatterns(specPath);
  const toolRegistry = createToolRegistry();
  register${parentPascal}Tools(toolRegistry);
  return {
    spec,
    reactionHandlers,
    delegationPolicy: {
      allowedTargetPrograms: ${JSON.stringify(policy.allowedTargetPrograms)},
      inputEnrichment: ${JSON.stringify(policy.inputEnrichment)},
    },
    createAdapters: (ctx) => {
      const adapters = createProgramAdapters(spec, ctx, handlers);
      if (spec.tools) {
        for (const [name, decl] of spec.tools) {
          if (toolRegistry.has(name)) {
            adapters.outputs.set(decl.channelId, toolRegistry.createAdapter(name));
          }
        }
      }
      return adapters;
    },
  };
}

function createManifestReuseStubChildEntry(tempDir: string): ProgramEntry {
  const specPath = join(tempDir, 'manifest-reuse-child-specs.yml');
  writeFileSync(specPath, manifestReuseStubChildSpec(), 'utf8');
  const { spec } = loadSpecWithPatterns(specPath);
  return {
    spec,
    delegationResultPolicy: {
      fields: [
        { path: 'work.summary', key: 'summary' },
        { path: 'work.seeded_topic', key: 'seeded_topic' },
      ],
    },
    createAdapters: (ctx) => createProgramAdapters(spec, ctx, manifestReuseStubChildHandlers),
  };
}

const manifestReuseStubChildHandlers: Record<string, ToolHandler> = {
  async accept_request(payload) {
    return { ok: true, action: 'accept_request', payload };
  },
  async finish_work(payload) {
    return { ok: true, action: 'finish_work', payload };
  },
};

function manifestReuseStubChildSpec(): string {
  return ${JSON.stringify(childSpecYaml)};
}

async function readSnapshot(client: PgasClient, sessionId: string): Promise<Snapshot> {
  const [envelope, world] = await Promise.all([
    client.sessions.get(sessionId),
    client.sessions.world(sessionId),
  ]);
  const state = envelope.state as Record<string, unknown> | undefined;
  return {
    mode: firstString(envelope.mode, state?.mode),
    domain: world.domain as Record<string, unknown>,
  };
}

function resultAt(domain: Record<string, unknown>, pathKey: string): Record<string, unknown> {
  const direct = domain[pathKey];
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    return direct as Record<string, unknown>;
  }
  const prefix = \`\${pathKey}.\`;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(domain)) {
    if (key.startsWith(prefix)) {
      result[key.slice(prefix.length)] = value;
    }
  }
  return result;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function scriptedAuthor(responses: ScriptedAuthorResponse[]) {
  let index = 0;
  return {
    modelId: 'generated-reuse-delegation-smoke-author',
    async complete(prompt: string) {
      const response = responses[index++];
      if (!response) {
        throw new Error(\`no generated reuse delegation smoke author response scripted for call \${String(index - 1)}\`);
      }
      if (response.expectPromptIncludes && !prompt.includes(response.expectPromptIncludes)) {
        throw new Error(\`expected generated reuse delegation prompt to include \${response.expectPromptIncludes}\`);
      }
      return JSON.stringify(response.response);
    },
  };
}

function effect(name: string, payload: Record<string, unknown>, channel = 'widget_output') {
  return { actions: [{ kind: 'EffectAction', name, channel, payload }] };
}

function scripted(response: ReturnType<typeof effect>, expectPromptIncludes?: string): ScriptedAuthorResponse {
  return { response, ...(expectPromptIncludes ? { expectPromptIncludes } : {}) };
}
`;
}

// Slice B multi-child smoke: dispatch + settle EVERY delegation child sequentially against
// its own separately-registered stub program. Each child owns a distinct delegation stage,
// so the parent drives begin_work → (per child: request_<id>, child accept/finish,
// complete_<stage>) → terminal. Every child's landed result is asserted `complete` with a
// distinct child sessionId. The single-child renderers stay byte-identical; only 2+ children
// route here.
function renderMultiChildDelegationSmokeTestSource(
  slug: string,
  name: string,
  entryChannel: string,
  children: DelegationChildDescriptor[],
  transitionActions: TransitionAction[],
): string {
  const parentPascal = toPascalCase(slug);
  const childSpecs = children.map((child, index) => {
    const registryName = child.registered_name ?? delegationTargetSpec(child);
    const specName = delegationTargetSpec(child);
    const transitionAction = transitionActions.find((action) => action.source === child.stage);
    const transitionActionName = transitionAction?.name ?? `complete_${safeIdentifier(child.stage)}`;
    const transitionChannel = transitionAction?.archetype === 'llm-reasoning' ? 'widget_output' : 'stage_output';
    const topic = `seeded multi-child topic ${String(index)}`;
    const resultVar = `result_${safeIdentifier(delegationStateBase(child))}`;
    return {
      registryName,
      specName,
      requestAction: delegationRequestActionName(child),
      channel: delegationChannelName(child),
      transitionActionName,
      transitionChannel,
      resultPath: child.result_path,
      base: delegationStateBase(child),
      topic,
      resultVar,
      specYaml: multiChildStubSpecYaml(specName, name),
    };
  });
  const childEntriesArray = childSpecs
    .map((child, index) => `        { name: ${tsString(child.registryName)}, entry: createMultiChildStub(tempDir, ${String(index)}) },`)
    .join('\n');
  const scriptEntries = [
    `          scripted(effect('begin_work', {})),`,
    ...childSpecs.flatMap((child) => [
      `          scripted(effect(${tsString(child.requestAction)}, { request: { topic: ${tsString(child.topic)} } }, ${tsString(child.channel)})),`,
      `          scripted(effect('accept_request', { accepted: true }, 'child_output'), ${tsString(child.topic)}),`,
      `          scripted(effect('finish_work', { summary: ${tsString(`completed ${child.topic}`)}, seeded_topic: ${tsString(child.topic)} }, 'child_output'), ${tsString(child.topic)}),`,
      `          scripted(effect(${tsString(child.transitionActionName)}, {\n            result_json: JSON.stringify({ stage: ${tsString(child.transitionActionName)} }),\n            items_json: JSON.stringify([${tsString(`${child.transitionActionName}-item`)}]),\n          }, ${tsString(child.transitionChannel)})),`,
    ]),
  ].join('\n');
  // Upper bound on rounds needed to dispatch + settle every child then complete.
  // The flow may reach a terminal mode before the last step (delegation continuation
  // round-count varies by engine version), so the driver stops on a terminal session
  // instead of hard-failing on an over-trigger.
  const triggerCount = childSpecs.length * 2 + 2;
  const triggerCalls = [
    `      for (let step = 0; step < ${String(triggerCount)}; step += 1) {`,
    `        try {`,
    `          await client.sessions.trigger(sessionId, { channel: ${tsString(entryChannel)}, payload: \`drive multi-child delegation step \${String(step)}\` });`,
    `        } catch (error) {`,
    `          if (String((error as Error).message).includes('terminal')) break;`,
    `          throw error;`,
    `        }`,
    `      }`,
  ].join('\n');
  const resultAssertions = childSpecs.map((child) => `      const ${child.resultVar} = resultAt(final.domain, ${tsString(child.resultPath)});
      expect(${child.resultVar}.status).toBe('complete');
      expect(typeof ${child.resultVar}.sessionId).toBe('string');
      childSessionIds.push(String(${child.resultVar}.sessionId));
      expect(Number(${child.resultVar}.rounds)).toBeGreaterThanOrEqual(1);
      expect(final.domain[${tsString(`${child.base}.settled`)}]).toBe(true);
      expect(final.domain[${tsString(`${child.base}.degraded`)}]).toBe(false);`).join('\n');
  const childStubSpecCases = childSpecs
    .map((child, index) => `    case ${String(index)}:\n      return ${JSON.stringify(child.specYaml)};`)
    .join('\n');
  return `import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import { appTransport, createPgasClient, type PgasClient } from '@simodelne/pgas-server/client.js';
import {
  createProgramAdapters,
  loadSpecWithPatterns,
  type ProgramEntry,
  type ToolHandler,
} from '@simodelne/pgas-server/plugin.js';
import { create${parentPascal}ProgramEntry } from '../src/programs/${slug}/registration.js';

describe('generated multi-child delegation smoke', () => {
  it('dispatches and settles all ${String(childSpecs.length)} delegation children hermetically through the route for ${name}', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pgas-generated-multi-child-delegation-smoke-'));
    const server = await createPgasServer({
      programs: [
        { name: ${tsString(slug)}, entry: create${parentPascal}ProgramEntry() },
${childEntriesArray}
      ],
      drivers: {
        authorHandle: scriptedAuthor([
${scriptEntries}
        ]),
        observerHandle: {
          modelId: 'generated-multi-child-delegation-smoke-observer',
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
    const childSessionIds: string[] = [];
    try {
      const created = await client.sessions.create({ program: ${tsString(slug)} });
      const sessionId = created.sessionId;
      await client.sessions.trigger(sessionId, { channel: ${tsString(entryChannel)}, payload: 'bootstrap multi-child delegation parent' });
${triggerCalls}
      const final = await readSnapshot(client, sessionId);
${resultAssertions}
      expect(new Set(childSessionIds).size).toBe(${String(childSpecs.length)});
      expect(final.mode).toBe('complete');
    } finally {
      await server.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

interface Snapshot {
  mode: string | null;
  domain: Record<string, unknown>;
}

async function readSnapshot(client: PgasClient, sessionId: string): Promise<Snapshot> {
  const [envelope, world] = await Promise.all([
    client.sessions.get(sessionId),
    client.sessions.world(sessionId),
  ]);
  const state = envelope.state as Record<string, unknown> | undefined;
  return {
    mode: firstString(envelope.mode, state?.mode),
    domain: world.domain as Record<string, unknown>,
  };
}

function resultAt(domain: Record<string, unknown>, pathKey: string): Record<string, unknown> {
  const direct = domain[pathKey];
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    return direct as Record<string, unknown>;
  }
  const prefix = \`\${pathKey}.\`;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(domain)) {
    if (key.startsWith(prefix)) {
      result[key.slice(prefix.length)] = value;
    }
  }
  return result;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function createMultiChildStub(tempDir: string, index: number): ProgramEntry {
  const specPath = join(tempDir, \`multi-child-stub-\${String(index)}.yml\`);
  writeFileSync(specPath, multiChildStubSpec(index), 'utf8');
  const { spec } = loadSpecWithPatterns(specPath);
  return {
    spec,
    delegationResultPolicy: {
      fields: [
        { path: 'work.summary', key: 'summary' },
        { path: 'work.seeded_topic', key: 'seeded_topic' },
      ],
    },
    createAdapters: (ctx) => createProgramAdapters(spec, ctx, multiChildStubHandlers),
  };
}

const multiChildStubHandlers: Record<string, ToolHandler> = {
  async accept_request(payload) {
    return { ok: true, action: 'accept_request', payload };
  },
  async finish_work(payload) {
    return { ok: true, action: 'finish_work', payload };
  },
};

function multiChildStubSpec(index: number): string {
  switch (index) {
${childStubSpecCases}
    default:
      throw new Error(\`no multi-child stub spec for index \${String(index)}\`);
  }
}

function scriptedAuthor(responses: ScriptedAuthorResponse[]) {
  let index = 0;
  return {
    modelId: 'generated-multi-child-delegation-smoke-author',
    async complete(prompt: string) {
      const response = responses[index++];
      if (!response) {
        throw new Error(\`no generated multi-child delegation smoke author response scripted for call \${String(index - 1)}\`);
      }
      if (response.expectPromptIncludes && !prompt.includes(response.expectPromptIncludes)) {
        throw new Error(\`expected generated multi-child delegation prompt to include \${response.expectPromptIncludes}\`);
      }
      return JSON.stringify(response.response);
    },
  };
}

interface ScriptedAuthorResponse {
  response: ReturnType<typeof effect>;
  expectPromptIncludes?: string;
}

function effect(name: string, payload: Record<string, unknown>, channel = 'widget_output') {
  return { actions: [{ kind: 'EffectAction', name, channel, payload }] };
}

function scripted(response: ReturnType<typeof effect>, expectPromptIncludes?: string): ScriptedAuthorResponse {
  return { response, ...(expectPromptIncludes ? { expectPromptIncludes } : {}) };
}
`;
}

function multiChildStubSpecYaml(specName: string, parentName: string): string {
  return [
    `name: ${JSON.stringify(specName)}`,
    'termination: BoundedSession',
    'topology: CyclicTopology',
    'pure: true',
    '',
    'preamble: |',
    `  Inline multi-child delegation smoke child for ${parentName}.`,
    '',
    'initial: receive',
    'terminal: [complete]',
    '',
    'features:',
    '  - base',
    '',
    'channels:',
    '  user_text: { direction: In, sync: Async }',
    '  child_output: { direction: Out, sync: Sync }',
    '',
    'modes:',
    '  receive:',
    '    vocabulary: [accept_request]',
    '    channels: [user_text, child_output]',
    '    transitions:',
    '      - target: work',
    '        guard: { kind: FieldTruthy, path: child.received }',
    '  work:',
    '    vocabulary: [finish_work]',
    '    channels: [user_text, child_output]',
    '    transitions:',
    '      - target: complete',
    '        guard: { kind: FieldTruthy, path: work.done }',
    '  complete:',
    '    vocabulary: []',
    '    channels: [child_output]',
    '',
    'proceed_to:',
    '  accept_request: work',
    '  finish_work: complete',
    '',
    'projection:',
    '  receive:',
    '    include: [inputs.request, inputs.request.topic, inputs.domain_context, inputs.domain_context.source_program]',
    '    exclude: []',
    '  work:',
    '    include: [inputs.request, inputs.request.topic, child.received, work.summary, work.seeded_topic]',
    '    exclude: []',
    '  complete:',
    '    include: [inputs.request, inputs.request.topic, child.received, work.done, work.summary, work.seeded_topic]',
    '    exclude: []',
    '',
    'prompts:',
    '  receive: "Accept the delegated multi-child request."',
    '  work: "Finish the delegated multi-child request and echo the seeded topic."',
    '  complete: "Terminal."',
    '',
    'ingestion:',
    '  user_text:',
    '    - inputs.user_text',
    '',
    'action_map:',
    '  accept_request:',
    '    description: "Record that the delegated request was received."',
    '    mutations:',
    '      - { op: MSet, path: child.received, value: true }',
    '    channel: child_output',
    '  finish_work:',
    '    description: "Complete the delegated multi-child request."',
    '    mutations:',
    '      - { op: MSet, path: work.done, value: true }',
    '      - { op: MSet, path: work.summary, from_arg: summary }',
    '      - { op: MSet, path: work.seeded_topic, from_arg: seeded_topic }',
    '    channel: child_output',
    '',
    'schema:',
    '  inputs.user_text: string',
    '  inputs.request: object',
    '  inputs.request.topic: string',
    '  inputs.domain_context: object',
    '  inputs.domain_context.source_program: string',
    '  inputs.domain_context.source_session_id: string',
    '  inputs.domain_context.target_program: string',
    '  child.received: boolean',
    '  work.done: boolean',
    '  work.summary: string',
    '  work.seeded_topic: string',
    '',
    'repair_bound: 2',
    '',
    'fallback:',
    '  channel: child_output',
    '  payload: { ok: false }',
    '',
  ].join('\n');
}

function renderDelegationSmokeTestSource(
  slug: string,
  name: string,
  entryChannel: string,
  child: DelegationChildDescriptor,
  transitionActions: TransitionAction[],
): string {
  const childSlug = delegationTargetSpec(child);
  const parentPascal = toPascalCase(slug);
  const childPascal = toPascalCase(childSlug);
  const childStage = childResultStage(child);
  const backedResearch = child.synthesize_child?.kind === 'research_agent' && researchChildBackend(child) === 'host_connector';
  const childCompleteAction = `complete_${childStage}`;
  const childCompleteChannel = backedResearch ? 'stage_output' : 'widget_output';
  const childCompletePayload = backedResearch
    ? `{ __stage_runtime: { now_iso: '2026-07-16T00:00:00.000Z', random: 0.25 } }`
    : `{
          result_json: JSON.stringify({ summary: 'child completed delegated work' }),
          items_json: JSON.stringify(['delegated-work-complete']),
          summary: 'child completed delegated work',
          seeded_topic: 'seeded delegation topic',
        }`;
  const childResultAssertions = backedResearch
    ? `    expect(String(result.result_json)).toContain('seeded delegation topic');
    expect(result.adapter_kind).toBe('in_memory_mock');`
    : `    expect(result.seeded_topic).toBe('seeded delegation topic');`;
  const transitionAction = transitionActions.find((action) => action.source === child.stage);
  const transitionActionName = transitionAction?.name ?? `complete_${safeIdentifier(child.stage)}`;
  const transitionChannel = transitionAction?.archetype === 'llm-reasoning' ? 'widget_output' : 'stage_output';
  const resultPath = child.result_path;
  const base = delegationStateBase(child);
  return `import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import { appTransport, createPgasClient, type PgasClient } from '@simodelne/pgas-server/client.js';
import {
  createProgramAdapters,
  createToolRegistry,
  loadSpecWithPatterns,
  type ProgramEntry,
} from '@simodelne/pgas-server/plugin.js';
import { create${parentPascal}ProgramEntry } from '../src/programs/${slug}/registration.js';
import { handlers, reactionHandlers } from '../src/programs/${slug}/handlers.js';
import { register${parentPascal}Tools } from '../src/programs/${slug}/tools.js';
import { create${childPascal}ProgramEntry } from '../src/programs/${childSlug}/registration.js';

describe('generated delegation smoke', () => {
  it('runs synthesized delegation hermetically through the route for ${name}', async () => {
    const complete = await runDelegationScenario({
      script: [
        scripted(effect('begin_work', {})),
        scripted(effect(${tsString(delegationRequestActionName(child))}, { request: { intent: 'complete-child' } }, ${tsString(delegationChannelName(child))})),
        scripted(effect('begin_work', {}), 'seeded delegation topic'),
        scripted(effect(${tsString(childCompleteAction)}, ${childCompletePayload}, ${tsString(childCompleteChannel)}), 'seeded delegation topic'),
        scripted(effect(${tsString(transitionActionName)}, {
          result_json: JSON.stringify({ parent: 'complete after delegation' }),
          items_json: JSON.stringify(['parent-complete']),
        }, ${tsString(transitionChannel)})),
      ],
    });
    const result = resultAt(complete.afterDelegation.domain, ${tsString(resultPath)});
    expect(result.status).toBe('complete');
    expect(Number(result.rounds)).toBeGreaterThanOrEqual(1);
    expect(result.mode).toBe('complete');
${childResultAssertions}
    expect(complete.afterDelegation.domain[${tsString(`${base}.settled`)}]).toBe(true);
    expect(complete.afterDelegation.domain[${tsString(`${base}.degraded`)}]).toBe(false);
    expect(complete.final.mode).toBe('complete');

    const degraded = await runDelegationScenario({
      parentMaxDelegatedRounds: 1,
      script: [
        scripted(effect('begin_work', {})),
        scripted(effect(${tsString(delegationRequestActionName(child))}, { request: { intent: 'force-degrade' } }, ${tsString(delegationChannelName(child))})),
        scripted(effect('begin_work', {}), 'seeded delegation topic'),
        scripted(effect(${tsString(transitionActionName)}, {
          result_json: JSON.stringify({ parent: 'complete after degraded delegation' }),
          items_json: JSON.stringify(['parent-complete-after-degrade']),
        }, ${tsString(transitionChannel)})),
      ],
    });
    const degradeResult = resultAt(degraded.afterDelegation.domain, ${tsString(resultPath)});
    expect(degradeResult.status).toBe('failed');
    expect(degradeResult.optional).toBe(true);
    expect(degraded.afterDelegation.domain[${tsString(`${base}.settled`)}]).toBe(true);
    expect(degraded.afterDelegation.domain[${tsString(`${base}.degraded`)}]).toBe(true);
    expect(String(degraded.afterDelegation.domain[${tsString(`${base}.degrade_reason`)}]).length).toBeGreaterThan(0);
    expect(degraded.final.mode).toBe('complete');
  });
});

interface DelegationScenario {
  parentMaxDelegatedRounds?: number;
  script: ScriptedAuthorResponse[];
}

interface ScriptedAuthorResponse {
  response: ReturnType<typeof effect>;
  expectPromptIncludes?: string;
}

interface Snapshot {
  mode: string | null;
  domain: Record<string, unknown>;
}

async function runDelegationScenario(scenario: DelegationScenario): Promise<{ afterDelegation: Snapshot; final: Snapshot }> {
  const tempDir = mkdtempSync(join(tmpdir(), 'pgas-generated-delegation-smoke-'));
  const server = await createPgasServer({
    programs: [
      {
        name: ${tsString(slug)},
        entry: scenario.parentMaxDelegatedRounds === undefined
          ? create${parentPascal}ProgramEntry()
          : createPatchedParentEntry(tempDir, scenario.parentMaxDelegatedRounds),
      },
      { name: ${tsString(childSlug)}, entry: create${childPascal}ProgramEntry() },
    ],
    drivers: {
      authorHandle: scriptedAuthor(scenario.script),
      observerHandle: {
        modelId: 'generated-delegation-smoke-observer',
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
    const created = await client.sessions.create({ program: ${tsString(slug)} });
    const sessionId = created.sessionId;
    await client.sessions.trigger(sessionId, { channel: ${tsString(entryChannel)}, payload: 'seeded delegation topic' });
    await client.sessions.trigger(sessionId, { channel: ${tsString(entryChannel)}, payload: 'dispatch delegated worker' });
    const afterDelegation = await readSnapshot(client, sessionId);
    // The delegation continuation may already have advanced the parent to a terminal
    // mode; tolerate an over-trigger on the completion step.
    try {
      await client.sessions.trigger(sessionId, { channel: ${tsString(entryChannel)}, payload: 'complete parent after delegation settled' });
    } catch (error) {
      if (!String((error as Error).message).includes('terminal')) throw error;
    }
    const final = await readSnapshot(client, sessionId);
    return { afterDelegation, final };
  } finally {
    await server.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function createPatchedParentEntry(tempDir: string, maxDelegatedRounds: number): ProgramEntry {
  const sourcePath = decodeURIComponent(new URL('../src/programs/${slug}/specs.yml', import.meta.url).pathname);
  const source = readFileSync(sourcePath, 'utf8');
  const patched = source.replace(/max_delegated_rounds: \\d+/u, \`max_delegated_rounds: \${String(maxDelegatedRounds)}\`);
  const specPath = join(tempDir, 'parent-patched-specs.yml');
  writeFileSync(specPath, patched, 'utf8');
  const { spec } = loadSpecWithPatterns(specPath);
  const toolRegistry = createToolRegistry();
  register${parentPascal}Tools(toolRegistry);
  return {
    spec,
    reactionHandlers,
    delegationPolicy: {
      allowedTargetPrograms: [${tsString(childSlug)}],
      inputEnrichment: ${JSON.stringify(delegationPolicyForChildren([child]).inputEnrichment)},
    },
    createAdapters: (ctx) => {
      const adapters = createProgramAdapters(spec, ctx, handlers);
      if (spec.tools) {
        for (const [name, decl] of spec.tools) {
          if (toolRegistry.has(name)) {
            adapters.outputs.set(decl.channelId, toolRegistry.createAdapter(name));
          }
        }
      }
      return adapters;
    },
  };
}

async function readSnapshot(client: PgasClient, sessionId: string): Promise<Snapshot> {
  const [envelope, world] = await Promise.all([
    client.sessions.get(sessionId),
    client.sessions.world(sessionId),
  ]);
  const state = envelope.state as Record<string, unknown> | undefined;
  return {
    mode: firstString(envelope.mode, state?.mode),
    domain: world.domain as Record<string, unknown>,
  };
}

function resultAt(domain: Record<string, unknown>, pathKey: string): Record<string, unknown> {
  const direct = domain[pathKey];
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    return direct as Record<string, unknown>;
  }
  const prefix = \`\${pathKey}.\`;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(domain)) {
    if (key.startsWith(prefix)) {
      result[key.slice(prefix.length)] = value;
    }
  }
  return result;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function scriptedAuthor(responses: ScriptedAuthorResponse[]) {
  let index = 0;
  return {
    modelId: 'generated-delegation-smoke-author',
    async complete(prompt: string) {
      const response = responses[index++];
      if (!response) {
        throw new Error(\`no generated delegation smoke author response scripted for call \${String(index - 1)}\`);
      }
      if (response.expectPromptIncludes && !prompt.includes(response.expectPromptIncludes)) {
        throw new Error(\`expected generated delegation prompt to include \${response.expectPromptIncludes}\`);
      }
      return JSON.stringify(response.response);
    },
  };
}

function effect(name: string, payload: Record<string, unknown>, channel = 'widget_output') {
  return { actions: [{ kind: 'EffectAction', name, channel, payload }] };
}

function scripted(response: ReturnType<typeof effect>, expectPromptIncludes?: string): ScriptedAuthorResponse {
  return { response, ...(expectPromptIncludes ? { expectPromptIncludes } : {}) };
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
      descriptor.storage.representation,
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

export function createConfirmationLoopSaveDecisionReaction(
  value: unknown,
  lifecycleValue: unknown,
): ReactionHandler {
  const loop = normalizeConfirmationLoopDescriptor(value, 0);
  const lifecycle = normalizeCollectionLifecycleDescriptor(lifecycleValue);
  if (!lifecycle) {
    throw new Error('collection_lifecycle descriptor is required');
  }
  assertCollectionLifecycleDescriptor(lifecycle);
  assertConfirmationLoopDescriptors([loop], lifecycle, [
    { slug: 'intake', is_bootstrap: true },
    { slug: loop.seed.source_stage },
    { slug: loop.stage },
    { slug: 'complete', is_terminal: true },
  ], new Map([
    ['intake', { slug: 'intake', archetype: 'pure-compute', rationale: '' }],
    [loop.seed.source_stage, { slug: loop.seed.source_stage, archetype: 'llm-reasoning', rationale: '' }],
    [loop.stage, { slug: loop.stage, archetype: 'llm-reasoning', rationale: '' }],
    ['complete', { slug: 'complete', archetype: 'pure-compute', rationale: '' }],
  ]));
  return (snapshot, trigger, mode) => {
    void trigger;
    if (mode !== loop.stage) {
      return undefined;
    }
    return confirmationLoopSaveDecision(snapshot, loop);
  };
}

export function createConfirmationLoopEnforceStatusReaction(
  value: unknown,
  lifecycleValue: unknown,
): ReactionHandler {
  const loop = normalizeConfirmationLoopDescriptor(value, 0);
  const lifecycle = normalizeCollectionLifecycleDescriptor(lifecycleValue);
  if (!lifecycle) {
    throw new Error('collection_lifecycle descriptor is required');
  }
  assertCollectionLifecycleDescriptor(lifecycle);
  assertConfirmationLoopDescriptors([loop], lifecycle, [
    { slug: 'intake', is_bootstrap: true },
    { slug: loop.seed.source_stage },
    { slug: loop.stage },
    { slug: 'complete', is_terminal: true },
  ], new Map([
    ['intake', { slug: 'intake', archetype: 'pure-compute', rationale: '' }],
    [loop.seed.source_stage, { slug: loop.seed.source_stage, archetype: 'llm-reasoning', rationale: '' }],
    [loop.stage, { slug: loop.stage, archetype: 'llm-reasoning', rationale: '' }],
    ['complete', { slug: 'complete', archetype: 'pure-compute', rationale: '' }],
  ]));
  return (snapshot, trigger, mode) => {
    void trigger;
    if (mode !== loop.stage) {
      return undefined;
    }
    return confirmationLoopEnforceStatus(snapshot, loop, lifecycle);
  };
}

export function createConfirmationLoopChoreographCollectionReaction(
  value: unknown,
  lifecycleValue: unknown,
): ReactionHandler {
  const loop = normalizeConfirmationLoopDescriptor(value, 0);
  const lifecycle = normalizeCollectionLifecycleDescriptor(lifecycleValue);
  if (!lifecycle) {
    throw new Error('collection_lifecycle descriptor is required');
  }
  assertCollectionLifecycleDescriptor(lifecycle);
  assertConfirmationLoopDescriptors([loop], lifecycle, [
    { slug: 'intake', is_bootstrap: true },
    { slug: loop.seed.source_stage },
    { slug: loop.stage },
    { slug: 'complete', is_terminal: true },
  ], new Map([
    ['intake', { slug: 'intake', archetype: 'pure-compute', rationale: '' }],
    [loop.seed.source_stage, { slug: loop.seed.source_stage, archetype: 'llm-reasoning', rationale: '' }],
    [loop.stage, { slug: loop.stage, archetype: 'llm-reasoning', rationale: '' }],
    ['complete', { slug: 'complete', archetype: 'pure-compute', rationale: '' }],
  ]));
  return (snapshot, trigger, mode) => {
    void trigger;
    return confirmationLoopChoreographCollection(snapshot, mode, loop, lifecycle);
  };
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

  const parsedItems = collectionLifecycleItems(snapshot, descriptor.storage.items_path, descriptor.storage.representation);
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

  const itemMutation = descriptor.storage.representation === 'indexed_array'
    ? { op: 'MSet' as const, path: `${descriptor.storage.items_path}.${itemIndex}.${descriptor.item.status_field}`, value: attemptedTo }
    : {
        op: 'MSet' as const,
        path: descriptor.storage.items_path,
        value: JSON.stringify(parsedItems.map((item, index) =>
          index === itemIndex && item && typeof item === 'object' && !Array.isArray(item)
            ? { ...item as Record<string, unknown>, [descriptor.item.status_field]: attemptedTo }
            : item,
        )),
      };
  return {
    mutations: [
      itemMutation,
      { op: 'MSet' as const, path: descriptor.storage.event_path, value: COLLECTION_LIFECYCLE_EVENT_CLEAR_VALUE },
    ],
  };
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
  representation: CollectionStorageRepresentation,
): boolean {
  const parsed = collectionLifecycleItems(snapshot, itemsPath, representation);
  if (!parsed) {
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

function collectionLifecycleItems(
  snapshot: ReadonlyMap<string, unknown>,
  itemsPath: string,
  representation: CollectionStorageRepresentation,
): unknown[] | undefined {
  if (representation === 'indexed_array') {
    try {
      return reconstructArray(Object.fromEntries(snapshot), itemsPath);
    } catch {
      return undefined;
    }
  }
  const raw = snapshot.get(itemsPath);
  if (typeof raw !== 'string') {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  return Array.isArray(parsed) ? parsed : undefined;
}

interface PendingConfirmationDecision {
  decision: string;
  instruction: string;
  target_index: number;
  target_item_id?: string;
  target_item_title?: string;
  target_item_status?: string;
  timestamp?: string;
}

type ReactionMutations = NonNullable<ReactionResult['mutations']>;

function confirmationLoopSaveDecision(
  snapshot: ReadonlyMap<string, unknown>,
  loop: ConfirmationLoopDescriptor,
): ReactionResult | undefined {
  const rawDecision = snapshot.get('inputs.user_decision.decision');
  const normalizedDecision = typeof rawDecision === 'string' ? rawDecision.trim() : '';
  const decision = confirmationLoopNormalizeDecision(normalizedDecision, confirmationLoopRuntimeDecisions(loop.decisions));
  if (decision.length === 0) {
    return undefined;
  }
  const targetIndex = normalizeTargetIndex(snapshot.get('inputs.user_decision.target_item_index'));
  const instruction = typeof snapshot.get('inputs.user_decision.instruction') === 'string'
    ? String(snapshot.get('inputs.user_decision.instruction'))
    : '';
  const pending: PendingConfirmationDecision = {
    decision,
    instruction,
    target_index: targetIndex,
    ...stringSnapshotField(snapshot, 'inputs.user_decision.target_item_id', 'target_item_id'),
    ...stringSnapshotField(snapshot, 'inputs.user_decision.target_item_title', 'target_item_title'),
    ...stringSnapshotField(snapshot, 'inputs.user_decision.target_item_status', 'target_item_status'),
    ...stringSnapshotField(snapshot, 'inputs.user_decision.timestamp', 'timestamp'),
  };
  return {
    mutations: [
      { op: 'MSet' as const, path: confirmationLoopPendingPath(loop), value: JSON.stringify(pending) },
    ],
  };
}

function confirmationLoopNormalizeDecision(
  decision: string,
  decisions: Record<string, unknown>,
): string {
  if (Object.prototype.hasOwnProperty.call(decisions, decision)) {
    return decision;
  }
  return '';
}

function confirmationLoopEnforceStatus(
  snapshot: ReadonlyMap<string, unknown>,
  loop: ConfirmationLoopDescriptor,
  lifecycle: CollectionLifecycleDescriptor,
): ReactionResult | undefined {
  const mutations: ReactionMutations = [];
  let items: unknown[] = [];
  let itemsAvailable = true;
  try {
    items = reconstructArray(Object.fromEntries(snapshot), loop.collection);
  } catch {
    itemsAvailable = false;
  }

  const pending = confirmationLoopPendingDecision(snapshot.get(confirmationLoopPendingPath(loop)), snapshot);
  if (pending.kind === 'invalid') {
    mutations.push(confirmationLoopViolationMutation(loop, lifecycle, { reason: 'invalid_pending_decision' }));
  } else if (pending.kind === 'present') {
    const fingerprint = confirmationLoopPendingFingerprint(pending.value);
    if (snapshot.get(confirmationLoopAppliedDecisionPath(loop)) === fingerprint) {
      // Already applied this recorded intent; still enforce invariants below.
    } else if (!itemsAvailable) {
      mutations.push(
        confirmationLoopViolationMutation(loop, lifecycle, { reason: 'missing_collection' }),
        { op: 'MSet' as const, path: confirmationLoopAppliedDecisionPath(loop), value: fingerprint },
      );
    } else {
      applyConfirmationPendingDecision(mutations, items, snapshot, loop, lifecycle, pending.value);
    }
  }

  if (itemsAvailable && loop.one_proposed_at_a_time) {
    const demoted = enforceOneProposedAtATime(mutations, items, snapshot, loop, lifecycle);
    if (demoted > 0) {
      const current = snapshot.get(confirmationLoopDemotionCounterPath(loop));
      const currentCount = typeof current === 'number' && Number.isFinite(current) ? current : 0;
      mutations.push({
        op: 'MSet' as const,
        path: confirmationLoopDemotionCounterPath(loop),
        value: currentCount + demoted,
      });
    }
  }

  const allTerminal = itemsAvailable
    ? confirmationLoopAllTerminal(items, lifecycle.item.status_field, loop.aggregate.terminal_statuses)
    : false;
  mutations.push({ op: 'MSet' as const, path: loop.aggregate.guard_field, value: allTerminal });

  return mutations.length > 0 ? { mutations } : undefined;
}

function confirmationLoopChoreographCollection(
  snapshot: ReadonlyMap<string, unknown>,
  mode: string,
  loop: ConfirmationLoopDescriptor,
  lifecycle: CollectionLifecycleDescriptor,
): ReactionResult | undefined {
  const mutations: ReactionMutations = [];
  let items: unknown[] = [];
  try {
    items = reconstructArray(Object.fromEntries(snapshot), loop.collection);
  } catch {
    items = [];
  }

  if (items.length === 0) {
    const seed = confirmationLoopSeedItems(
      snapshot.get(`${loop.seed.source_stage}.items_json`),
      loop.item_id_field ?? lifecycle.item.id_field,
      loop.item_title_field ?? 'title',
    );
    if (seed.kind === 'valid') {
      const seeded = seed.items.map((seedItem, index) =>
        confirmationLoopSeedItem(loop, lifecycle, seedItem, index));
      seeded.forEach((item, index) => {
        mutations.push({ op: 'MSet' as const, path: `${loop.collection}.${index}`, value: item });
      });
      mutations.push({ op: 'MSet' as const, path: confirmationLoopSeedStatePath(loop), value: 'seeded' });
      items = seeded;
    } else if (seed.kind === 'invalid') {
      mutations.push({ op: 'MSet' as const, path: confirmationLoopSeedStatePath(loop), value: 'invalid_items_json' });
    }
  }

  if (mode !== loop.stage) {
    return mutations.length > 0 ? { mutations } : undefined;
  }

  const log = snapshot.get(confirmationLoopProposalLogPath(loop));
  const proposalCount = Array.isArray(log) ? log.length : 0;
  const currentAppliedCount = snapshot.get(confirmationLoopAppliedProposalCountPath(loop));
  const appliedCount = typeof currentAppliedCount === 'number' && Number.isFinite(currentAppliedCount)
    ? currentAppliedCount
    : 0;
  if (proposalCount <= appliedCount) {
    return mutations.length > 0 ? { mutations } : undefined;
  }

  const targetIndex = confirmationLoopProposalTargetIndex(
    items,
    lifecycle.item.status_field,
    loop.proposed_status,
    confirmationLoopInitialStatus(lifecycle),
  );
  if (targetIndex < 0) {
    return mutations.length > 0 ? { mutations } : undefined;
  }

  const current = items[targetIndex];
  const next: Record<string, unknown> = current && typeof current === 'object' && !Array.isArray(current)
    ? { ...(current as Record<string, unknown>) }
    : {};
  for (const field of confirmationLoopProposalFields(loop, lifecycle)) {
    const value = snapshot.get(confirmationLoopProposalFieldPath(loop, field));
    next[field] = typeof value === 'string' ? value : '';
  }
  next[lifecycle.item.status_field] = loop.proposed_status;
  mutations.push(
    { op: 'MSet' as const, path: `${loop.collection}.${targetIndex}`, value: next },
    { op: 'MSet' as const, path: confirmationLoopAppliedProposalCountPath(loop), value: proposalCount },
  );
  return { mutations };
}

interface ConfirmationLoopSeedItem {
  id?: string;
  title: string;
  fields: Record<string, unknown>;
}

function confirmationLoopSeedItems(
  value: unknown,
  idField: string,
  titleField: string,
): { kind: 'empty' } | { kind: 'invalid' } | { kind: 'valid'; items: ConfirmationLoopSeedItem[] } {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { kind: 'empty' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return { kind: 'invalid' };
  }
  if (!Array.isArray(parsed)) {
    return { kind: 'invalid' };
  }
  if (parsed.length === 0) {
    return { kind: 'invalid' };
  }
  const items: ConfirmationLoopSeedItem[] = [];
  for (let index = 0; index < parsed.length; index += 1) {
    const item = parsed[index];
    if (typeof item === 'string') {
      items.push({ title: item, fields: {} });
      continue;
    }
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      const id = confirmationLoopFirstPresentSeedValue(record, [idField, 'id']);
      items.push({
        ...(id === undefined ? {} : { id: String(id) }),
        title: confirmationLoopSeedItemTitle(record, titleField, index),
        fields: { ...record },
      });
      continue;
    }
    return { kind: 'invalid' };
  }
  return { kind: 'valid', items };
}

function confirmationLoopSeedItemTitle(
  record: Record<string, unknown>,
  titleField: string,
  index: number,
): string {
  const value = confirmationLoopFirstPresentSeedValue(record, [titleField, 'title', 'name', 'label', 'summary']);
  if (value !== undefined) {
    return String(value);
  }
  const id = confirmationLoopFirstPresentSeedValue(record, ['id']);
  return String(id ?? index);
}

function confirmationLoopFirstPresentSeedValue(record: Record<string, unknown>, fields: readonly string[]): unknown | undefined {
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(record, field) && record[field] !== undefined && record[field] !== null) {
      return record[field];
    }
  }
  return undefined;
}

function confirmationLoopSeedItem(
  loop: ConfirmationLoopDescriptor,
  lifecycle: CollectionLifecycleDescriptor,
  seed: ConfirmationLoopSeedItem,
  index: number,
): Record<string, unknown> {
  const idField = loop.item_id_field ?? lifecycle.item.id_field;
  const titleField = loop.item_title_field ?? 'title';
  const item: Record<string, unknown> = {
    [idField]: seed.id ?? `${loop.seed.id_prefix ?? 'item'}-${index + 1}`,
    [titleField]: seed.title,
    [lifecycle.item.status_field]: confirmationLoopInitialStatus(lifecycle),
  };
  for (const field of confirmationLoopSeedSchemaFields(loop, lifecycle)) {
    if (Object.prototype.hasOwnProperty.call(seed.fields, field)) {
      item[field] = seed.fields[field];
    }
  }
  for (const field of confirmationLoopSeedSchemaFields(loop, lifecycle)) {
    if (!Object.prototype.hasOwnProperty.call(item, field)) {
      item[field] = '';
    }
  }
  for (const field of confirmationLoopSeedForcedEmptyFields(loop, lifecycle)) {
    item[field] = '';
  }
  item[lifecycle.item.status_field] = confirmationLoopInitialStatus(lifecycle);
  return item;
}

function confirmationLoopProposalTargetIndex(
  items: unknown[],
  statusField: string,
  proposedStatus: string,
  initialStatus: string,
): number {
  const proposed = items.findIndex((item) =>
    item && typeof item === 'object' && !Array.isArray(item) &&
    (item as Record<string, unknown>)[statusField] === proposedStatus);
  if (proposed >= 0) {
    return proposed;
  }
  return items.findIndex((item) =>
    item && typeof item === 'object' && !Array.isArray(item) &&
    (item as Record<string, unknown>)[statusField] === initialStatus);
}

function applyConfirmationPendingDecision(
  mutations: ReactionMutations,
  items: unknown[],
  snapshot: ReadonlyMap<string, unknown>,
  loop: ConfirmationLoopDescriptor,
  lifecycle: CollectionLifecycleDescriptor,
  pending: PendingConfirmationDecision,
): void {
  const decision = confirmationLoopRuntimeDecisions(loop.decisions)[pending.decision];
  const fingerprint = confirmationLoopPendingFingerprint(pending);
  if (!decision) {
    mutations.push(
      confirmationLoopViolationMutation(loop, lifecycle, { reason: 'unknown_decision', decision: pending.decision }),
      { op: 'MSet' as const, path: confirmationLoopAppliedDecisionPath(loop), value: fingerprint },
    );
    return;
  }
  const targetIndex = pending.target_index;
  const item = Number.isInteger(targetIndex) ? items[targetIndex] : undefined;
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    mutations.push(
      confirmationLoopViolationMutation(loop, lifecycle, { reason: 'missing_item', target_index: targetIndex }),
      { op: 'MSet' as const, path: confirmationLoopAppliedDecisionPath(loop), value: fingerprint },
    );
    return;
  }
  if (decision.requires_instruction === true && pending.instruction.trim().length === 0) {
    mutations.push(
      confirmationLoopViolationMutation(loop, lifecycle, { reason: 'missing_instruction', decision: pending.decision, target_index: targetIndex }),
      { op: 'MSet' as const, path: confirmationLoopAppliedDecisionPath(loop), value: fingerprint },
    );
    return;
  }

  const statusField = lifecycle.item.status_field;
  const nextStatus = decision.re_propose === true ? loop.proposed_status : decision.to;
  (item as Record<string, unknown>)[statusField] = nextStatus;
  mutations.push({
    op: 'MSet' as const,
    path: `${loop.collection}.${targetIndex}.${statusField}`,
    value: nextStatus,
  });
  if (decision.instruction_path && pending.instruction.trim().length > 0) {
    const instructionPath = indexedPath(decision.instruction_path, targetIndex);
    (item as Record<string, unknown>)[instructionPath.split('.').at(-1) ?? 'instruction'] = pending.instruction;
    mutations.push({
      op: 'MSet' as const,
      path: instructionPath,
      value: pending.instruction,
    });
  }
  mutations.push({ op: 'MSet' as const, path: confirmationLoopAppliedDecisionPath(loop), value: fingerprint });
  void snapshot;
}

function enforceOneProposedAtATime(
  mutations: ReactionMutations,
  items: unknown[],
  snapshot: ReadonlyMap<string, unknown>,
  loop: ConfirmationLoopDescriptor,
  lifecycle: CollectionLifecycleDescriptor,
): number {
  const statusField = lifecycle.item.status_field;
  const initialStatus = confirmationLoopInitialStatus(lifecycle);
  const proposedIndices = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) =>
      item && typeof item === 'object' && !Array.isArray(item) &&
      (item as Record<string, unknown>)[statusField] === loop.proposed_status);
  if (proposedIndices.length <= 1) {
    return 0;
  }
  let demoted = 0;
  for (const { item, index } of proposedIndices.slice(1)) {
    const record = item as Record<string, unknown>;
    record[statusField] = initialStatus;
    mutations.push({
      op: 'MSet' as const,
      path: `${loop.collection}.${index}.${statusField}`,
      value: initialStatus,
    });
    mutations.push(confirmationLoopViolationMutation(loop, lifecycle, {
      reason: 'multiple_proposed',
      kept_index: proposedIndices[0]?.index ?? 0,
      demoted_index: index,
      demoted_id: typeof record[lifecycle.item.id_field] === 'string' ? record[lifecycle.item.id_field] : '',
    }));
    demoted += 1;
  }
  void snapshot;
  return demoted;
}

function confirmationLoopPendingDecision(value: unknown, snapshot: ReadonlyMap<string, unknown>): { kind: 'empty' } | { kind: 'invalid' } | { kind: 'present'; value: PendingConfirmationDecision } {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return confirmationLoopPendingDecisionFromInputs(snapshot);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return { kind: 'invalid' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'invalid' };
  }
  const record = parsed as Record<string, unknown>;
  const decision = typeof record.decision === 'string' ? record.decision.trim() : '';
  const targetIndex = normalizeTargetIndex(record.target_index);
  if (decision.length === 0 || targetIndex < 0) {
    return { kind: 'invalid' };
  }
  return {
    kind: 'present',
    value: {
      decision,
      instruction: typeof record.instruction === 'string' ? record.instruction : '',
      target_index: targetIndex,
      ...(typeof record.target_item_id === 'string' ? { target_item_id: record.target_item_id } : {}),
      ...(typeof record.target_item_title === 'string' ? { target_item_title: record.target_item_title } : {}),
      ...(typeof record.target_item_status === 'string' ? { target_item_status: record.target_item_status } : {}),
      ...(typeof record.timestamp === 'string' ? { timestamp: record.timestamp } : {}),
    },
  };
}

function confirmationLoopPendingDecisionFromInputs(snapshot: ReadonlyMap<string, unknown>): { kind: 'empty' } | { kind: 'invalid' } | { kind: 'present'; value: PendingConfirmationDecision } {
  const decision = typeof snapshot.get('inputs.user_decision.decision') === 'string'
    ? String(snapshot.get('inputs.user_decision.decision')).trim()
    : '';
  if (decision.length === 0) {
    return { kind: 'empty' };
  }
  const targetIndex = normalizeTargetIndex(snapshot.get('inputs.user_decision.target_item_index'));
  if (targetIndex < 0) {
    return { kind: 'invalid' };
  }
  return {
    kind: 'present',
    value: {
      decision,
      instruction: typeof snapshot.get('inputs.user_decision.instruction') === 'string'
        ? String(snapshot.get('inputs.user_decision.instruction'))
        : '',
      target_index: targetIndex,
      ...stringSnapshotField(snapshot, 'inputs.user_decision.target_item_id', 'target_item_id'),
      ...stringSnapshotField(snapshot, 'inputs.user_decision.target_item_title', 'target_item_title'),
      ...stringSnapshotField(snapshot, 'inputs.user_decision.target_item_status', 'target_item_status'),
      ...stringSnapshotField(snapshot, 'inputs.user_decision.timestamp', 'timestamp'),
    },
  };
}

function confirmationLoopPendingFingerprint(pending: PendingConfirmationDecision): string {
  return pending.timestamp && pending.timestamp.length > 0
    ? pending.timestamp
    : JSON.stringify({
        decision: pending.decision,
        instruction: pending.instruction,
        target_index: pending.target_index,
      });
}

function confirmationLoopViolationMutation(
  loop: ConfirmationLoopDescriptor,
  lifecycle: CollectionLifecycleDescriptor,
  value: Record<string, unknown>,
): ReactionMutations[number] {
  return {
    op: 'MSet' as const,
    path: confirmationLoopViolationPath(loop, lifecycle),
    value: JSON.stringify(value),
  };
}

function confirmationLoopAllTerminal(
  items: unknown[],
  statusField: string,
  terminalStatuses: readonly string[],
): boolean {
  if (items.length === 0) {
    return false;
  }
  const terminal = new Set(terminalStatuses);
  return items.every((item) =>
    item && typeof item === 'object' && !Array.isArray(item) &&
    typeof (item as Record<string, unknown>)[statusField] === 'string' &&
    terminal.has((item as Record<string, unknown>)[statusField] as string));
}

function confirmationLoopInitialStatus(lifecycle: CollectionLifecycleDescriptor): string {
  return lifecycle.statuses.find((status) => status.initial === true)?.name ?? '';
}

function indexedPath(path: string, index: number): string {
  return path.replace(/\.\*(?=\.|$)/u, `.${index}`);
}

function normalizeTargetIndex(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/u.test(value)) {
    return Number.parseInt(value, 10);
  }
  return -1;
}

function stringSnapshotField(
  snapshot: ReadonlyMap<string, unknown>,
  path: string,
  key: Exclude<keyof PendingConfirmationDecision, 'target_index'>,
): Partial<PendingConfirmationDecision> {
  const value = snapshot.get(path);
  return typeof value === 'string' ? { [key]: value } : {};
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
  const hasChildrenDescriptor = Array.isArray(delegation.children);
  if (Object.keys(delegation).length > 0 && !hasChildrenDescriptor) {
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
  const parsed = load(specYaml);
  assertPreconditionVocabularyAlignment(parsed);
  assertConfirmationPairingTerminals(parsed);
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
      representation: normalizeCollectionStorageRepresentation(storage.representation),
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
  if (!isCollectionStorageRepresentation(descriptor.storage.representation)) {
    throw new Error('collection_lifecycle.storage.representation must be json_string or indexed_array');
  }
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

function normalizeInteractionDescriptor(value: unknown): Interaction | undefined {
  if (value === undefined) {
    return undefined;
  }
  const descriptor = requiredRecord(value, 'interaction');
  const loopsRaw = descriptor.confirmation_loops;
  if (loopsRaw === undefined) {
    return undefined;
  }
  const confirmationLoops = requiredArray(loopsRaw, 'interaction.confirmation_loops')
    .map((loop, index) => normalizeConfirmationLoopDescriptor(loop, index));
  return { confirmation_loops: confirmationLoops };
}

function normalizeConfirmationLoopDescriptor(value: unknown, index: number): ConfirmationLoopDescriptor {
  const descriptor = requiredRecord(value, `interaction.confirmation_loops[${index}]`);
  const decisions = Object.fromEntries(
    Object.entries(requiredRecord(descriptor.decisions, `interaction.confirmation_loops[${index}].decisions`))
      .map(([decisionName, rawDecision]) => {
        const decision = requiredRecord(rawDecision, `interaction.confirmation_loops[${index}].decisions.${decisionName}`);
        return [requiredString(decisionName, `interaction.confirmation_loops[${index}].decisions key`), {
          to: requiredString(decision.to, `interaction.confirmation_loops[${index}].decisions.${decisionName}.to`),
          ...(decision.requires_instruction === true ? { requires_instruction: true } : {}),
          ...optionalStringField(decision, 'instruction_path', `interaction.confirmation_loops[${index}].decisions.${decisionName}.instruction_path`),
          ...(decision.re_propose === true ? { re_propose: true } : {}),
        }];
      }),
  ) as Record<string, ConfirmationLoopDecisionDescriptor>;
  const aggregate = requiredRecord(descriptor.aggregate, `interaction.confirmation_loops[${index}].aggregate`);
  const stage = requiredString(descriptor.stage, `interaction.confirmation_loops[${index}].stage`);
  const seed = requiredRecord(descriptor.seed, `interaction.confirmation_loops[${index}].seed`);
  return {
    collection: requiredString(descriptor.collection, `interaction.confirmation_loops[${index}].collection`),
    proposed_status: requiredString(descriptor.proposed_status, `interaction.confirmation_loops[${index}].proposed_status`),
    seed: {
      source_stage: requiredString(seed.source_stage, `interaction.confirmation_loops[${index}].seed.source_stage`),
      ...optionalStringField(seed, 'id_prefix', `interaction.confirmation_loops[${index}].seed.id_prefix`),
    },
    ...optionalStringField(descriptor, 'item_id_field', `interaction.confirmation_loops[${index}].item_id_field`),
    ...optionalStringField(descriptor, 'item_title_field', `interaction.confirmation_loops[${index}].item_title_field`),
    decisions,
    one_proposed_at_a_time: requiredTrue(descriptor.one_proposed_at_a_time, `interaction.confirmation_loops[${index}].one_proposed_at_a_time`),
    aggregate: {
      guard_field: requiredString(aggregate.guard_field, `interaction.confirmation_loops[${index}].aggregate.guard_field`),
      terminal_statuses: requiredStringList(aggregate.terminal_statuses, `interaction.confirmation_loops[${index}].aggregate.terminal_statuses`),
    },
    stage,
    ...optionalStringField(descriptor, 'summary_path', `interaction.confirmation_loops[${index}].summary_path`),
    ...optionalStringField(descriptor, 'violation_path', `interaction.confirmation_loops[${index}].violation_path`),
    ...optionalStringField(descriptor, 'pending_action_path', `interaction.confirmation_loops[${index}].pending_action_path`),
  };
}

function assertConfirmationLoopDescriptors(
  loops: ConfirmationLoopDescriptor[],
  lifecycle: CollectionLifecycleDescriptor | undefined,
  stages: Stage[],
  stageClassificationBySlug: ReadonlyMap<string, ClassifiedStage>,
): void {
  if (!lifecycle || lifecycle.storage.representation !== 'indexed_array') {
    throw new Error('confirmation_loop collection must reference a collection_lifecycle with indexed_array storage');
  }
  if (lifecycle.transitions.some((transition) => transition.managed_by === 'llm')) {
    throw new Error('confirmation_loop lifecycles cannot declare managed_by llm transitions');
  }
  const modeNames = new Set(stages.map((stage) => stage.slug));
  const terminalModes = new Set(stages.filter((stage) => stage.is_terminal).map((stage) => stage.slug));
  const modeIndexByName = new Map(stages.map((stage, index) => [stage.slug, index]));
  const statusByName = new Map(lifecycle.statuses.map((status) => [status.name, status]));
  const initialStatuses = lifecycle.statuses.filter((status) => status.initial === true);
  if (initialStatuses.length !== 1) {
    throw new Error('confirmation_loop requires collection_lifecycle to declare exactly one initial status');
  }
  for (const loop of loops) {
    if (loop.collection !== lifecycle.storage.items_path) {
      throw new Error('confirmation_loop collection must reference a collection_lifecycle with indexed_array storage');
    }
    const proposed = statusByName.get(loop.proposed_status);
    if (!proposed || proposed.terminal === true) {
      throw new Error(`confirmation_loop proposed_status must be a declared non-terminal status; got ${loop.proposed_status}`);
    }
    if (Object.keys(loop.decisions).length === 0) {
      throw new Error('confirmation_loop decisions must declare at least one decision');
    }
    for (const [decisionName, decision] of Object.entries(loop.decisions)) {
      if (!statusByName.has(decision.to)) {
        throw new Error(`confirmation_loop decision ${decisionName} must target a declared status; got ${decision.to}`);
      }
      if (decision.requires_instruction === true && !decision.instruction_path) {
        throw new Error(`confirmation_loop decision ${decisionName} requires instruction_path when requires_instruction is true`);
      }
    }
    const unknownTerminalStatuses = loop.aggregate.terminal_statuses.filter((status) => !statusByName.has(status));
    if (unknownTerminalStatuses.length > 0) {
      throw new Error(`confirmation_loop.aggregate.terminal_statuses must be a subset of statuses; unknown: ${unknownTerminalStatuses.join(', ')}`);
    }
    if (!modeNames.has(loop.stage) || terminalModes.has(loop.stage)) {
      throw new Error(`confirmation_loop stage must reference a real non-terminal mode; got ${loop.stage}`);
    }
    const sourceIndex = modeIndexByName.get(loop.seed.source_stage);
    const loopIndex = modeIndexByName.get(loop.stage);
    if (sourceIndex === undefined || stageClassificationBySlug.get(loop.seed.source_stage)?.archetype !== 'llm-reasoning') {
      throw new Error('confirmation_loop seed.source_stage must reference an earlier llm-reasoning stage');
    }
    if (loopIndex === undefined || sourceIndex >= loopIndex) {
      throw new Error('confirmation_loop seed.source_stage must precede the confirmation_loop stage');
    }
  }
}

function normalizeDocumentsDescriptor(value: unknown): DocumentsDescriptor | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).enabled === false) {
    return undefined;
  }
  const descriptor = documentsDescriptorRecord(value);
  const stage = requiredString(descriptor.stage, 'documents.stage');
  const uploadTypes = normalizeDocumentUploadTypes(descriptor.upload_types);
  const extraction = normalizeDocumentsExtraction(descriptor.extraction);
  const resultPath = documentsResultPath(descriptor);
  const required = descriptor.required === undefined
    ? false
    : requiredBoolean(descriptor.required, 'documents.required');
  return {
    ...optionalNumberField(descriptor, 'version', 'documents.version'),
    stage,
    upload_types: uploadTypes,
    extraction,
    result_path: resultPath,
    required,
    ...optionalRecordField(descriptor, 'fidelity_floor', 'documents.fidelity_floor'),
    ...optionalStringField(descriptor, 'connector_slug', 'documents.connector_slug'),
  };
}

export function assertDocumentsDescriptor(
  documents: unknown,
  context: DocumentsValidationContext,
): void {
  const descriptor = normalizeDocumentsDescriptorForAssertion(documents);
  const stageRecord = context.stages.find((candidate) => candidate.slug === descriptor.stage);
  if (!stageRecord || stageRecord.is_bootstrap === true || stageRecord.is_terminal === true) {
    throw new Error(`documents.stage must reference a declared non-bootstrap non-terminal stage; got ${descriptor.stage}`);
  }

  const nonSelfContainedTypes = descriptor.upload_types.filter((uploadType) => !SELF_CONTAINED_DOCUMENT_UPLOAD_TYPES.has(uploadType));
  if (descriptor.extraction === 'self_contained' && nonSelfContainedTypes.length > 0) {
    throw new CapabilityRefusalError([{
      capability: 'document_upload_intake',
      evidence: DOCUMENT_SELF_CONTAINED_GAP_NOTE,
    }]);
  }

  if (
    descriptor.result_path === DOCUMENT_INTAKE_ROOT ||
    descriptor.result_path.startsWith(`${DOCUMENT_INTAKE_ROOT}.`)
  ) {
    throw new Error(`documents.result_path must not be under ${DOCUMENT_INTAKE_ROOT}`);
  }

  const delegationChildren = Array.isArray(context.delegation?.children)
    ? context.delegation.children
    : [];
  for (const [index, rawChild] of delegationChildren.entries()) {
    if (!rawChild || typeof rawChild !== 'object' || Array.isArray(rawChild)) {
      continue;
    }
    const childStage = (rawChild as Record<string, unknown>).stage;
    if (childStage === descriptor.stage) {
      throw new Error(`documents descriptor and delegation.children[${index}] must not share host stage ${descriptor.stage}`);
    }
  }
}

function normalizeDocumentsDescriptorForAssertion(documents: unknown): DocumentsDescriptor {
  if (documents === undefined) {
    throw new Error('documents descriptor is required');
  }
  const descriptor = normalizeDocumentsDescriptor(documents);
  if (!descriptor) {
    throw new Error('documents descriptor is required');
  }
  return descriptor;
}

function documentsDescriptorRecord(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new Error('documents must declare exactly one descriptor');
    }
    return requiredRecord(value[0], 'documents[0]');
  }
  return requiredRecord(value, 'documents');
}

function normalizeDocumentUploadTypes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('documents.upload_types must be a non-empty array');
  }
  return value.map((item, index) => {
    const raw = requiredString(item, `documents.upload_types[${index}]`).trim().toLowerCase();
    const normalized = DOCUMENT_UPLOAD_TYPES.get(raw);
    if (!normalized) {
      throw new Error(`documents.upload_types must be a subset of the engine upload allow-list; got ${raw}`);
    }
    return normalized;
  });
}

function normalizeDocumentsExtraction(value: unknown): DocumentsDescriptor['extraction'] {
  if (value === undefined) {
    return 'self_contained';
  }
  const extraction = requiredString(value, 'documents.extraction');
  if (extraction !== 'self_contained' && extraction !== 'host_connector') {
    throw new Error(`documents.extraction must be self_contained or host_connector; got ${extraction}`);
  }
  return extraction;
}

function documentsResultPath(descriptor: Record<string, unknown>): string {
  if (descriptor.result_path !== undefined) {
    return requiredString(descriptor.result_path, 'documents.result_path');
  }
  const target = descriptor.target;
  if (target && typeof target === 'object' && !Array.isArray(target)) {
    return requiredString((target as Record<string, unknown>).root, 'documents.target.root');
  }
  throw new Error('documents.result_path is required');
}

export function assertDelegationChildrenDescriptor(
  delegation: Record<string, unknown>,
  context: DelegationChildrenValidationContext,
): void {
  const childrenRaw = delegation.children;
  if (childrenRaw === undefined) {
    return;
  }
  const children = requiredArray(childrenRaw, 'delegation.children');
  if (children.length === 0) {
    throw new Error('delegation.children must declare at least one child');
  }

  // Slice B (multi-child static delegation): validate EACH of N children. N ≥ 2 distinct
  // STATIC children are now in scope (contract-draft parity — the emitters already fan out
  // over every child). assertDelegationV1Scope still refuses per-child fan_out / dynamic
  // targeting / continue-mode / strict, so a *single child fanning to many targets* stays
  // refuses; only *N distinct static children* is unlocked here. Cross-child uniqueness on
  // id / channel / stage / result_path / target_spec guarantees no request_${id} or
  // ${id}_call collision and no shared delegation stage between children.
  const actionNames = new Set(context.actionNames);
  const channelNames = new Set(context.channelNames);
  const schemaPaths = new Set(context.schemaPaths);
  const seenIds = new Set<string>();
  const seenStages = new Set<string>();
  const seenResultPaths = new Set<string>();
  const seenTargetSpecs = new Set<string>();

  // A later child's payload_map may source from an earlier child's landed result
  // (delegation result-chaining — e.g. review-service consuming the document-ingest
  // output as its document_intake.work_product). Pre-declare every child's result_path
  // (and its `.result` payload sub-path) so those sources validate.
  for (const rawChild of children) {
    if (isRecord(rawChild) && typeof rawChild.result_path === 'string') {
      schemaPaths.add(rawChild.result_path);
      schemaPaths.add(`${rawChild.result_path}.result`);
    }
  }

  for (const [i, rawChild] of children.entries()) {
    const child = requiredRecord(rawChild, `delegation.children[${i}]`);
    assertDelegationV1Scope(delegation, child);

    const id = requiredString(child.id, `delegation.children[${i}].id`);
    if (!/^[a-z][a-z0-9_]*$/u.test(id)) {
      throw new Error(`delegation.children[${i}].id must be a slug-safe identifier; got ${id}`);
    }
    if (seenIds.has(id)) {
      throw new Error(`delegation.children[${i}].id must be unique across children; ${id} is declared more than once`);
    }
    seenIds.add(id);
    const requestAction = `request_${id}`;
    if (actionNames.has(requestAction)) {
      throw new Error(`delegation child ${requestAction} action collides with generated action set`);
    }
    const callChannel = `${id}_call`;
    if (channelNames.has(callChannel)) {
      throw new Error(`delegation child ${callChannel} channel collides with generated channel set`);
    }

    const stage = requiredString(child.stage, `delegation.children[${i}].stage`);
    const stageRecord = context.stages.find((candidate) => candidate.slug === stage);
    if (!stageRecord || stageRecord.is_bootstrap === true || stageRecord.is_terminal === true) {
      throw new Error(`delegation.children[${i}].stage must reference a declared non-bootstrap non-terminal stage; got ${stage}`);
    }
    if (seenStages.has(stage)) {
      throw new Error(`delegation.children[${i}].stage must be unique across children; stage ${stage} is used by more than one child`);
    }
    seenStages.add(stage);

    const hasTargetSpec = child.target_spec !== undefined;
    const hasSynthesizeChild = child.synthesize_child !== undefined;
    if (hasTargetSpec === hasSynthesizeChild) {
      throw new Error(`delegation.children[${i}] must declare exactly one of target_spec or synthesize_child`);
    }

    if (hasTargetSpec) {
      const targetSpec = requiredString(child.target_spec, `delegation.children[${i}].target_spec`);
      const normalizedTarget = normalizeProgramNameForSelfTarget(targetSpec);
      if (
        normalizedTarget === normalizeProgramNameForSelfTarget(context.programSlug) ||
        normalizedTarget === normalizeProgramNameForSelfTarget(context.programName)
      ) {
        throw new Error(`delegation.children[${i}].target_spec must not reference the parent program`);
      }
      if (seenTargetSpecs.has(normalizedTarget)) {
        throw new Error(`delegation.children[${i}].target_spec must be distinct across children; ${targetSpec} targets the same program as another child`);
      }
      seenTargetSpecs.add(normalizedTarget);
    }

    if (hasSynthesizeChild) {
      const synthesizeChild = requiredRecord(child.synthesize_child, `delegation.children[${i}].synthesize_child`);
      const kind = requiredString(synthesizeChild.kind, `delegation.children[${i}].synthesize_child.kind`);
      if (kind !== 'research_agent' && kind !== 'worker') {
        throw new Error(`delegation.children[${i}].synthesize_child.kind must be research_agent or worker; got ${kind}`);
      }
      if (synthesizeChild.research_backend !== undefined) {
        const researchBackend = requiredString(synthesizeChild.research_backend, `delegation.children[${i}].synthesize_child.research_backend`);
        if (researchBackend !== 'host_connector' && researchBackend !== 'self_contained') {
          throw new Error(`delegation.children[${i}].synthesize_child.research_backend must be self_contained or host_connector; got ${researchBackend}`);
        }
        if (kind !== 'research_agent') {
          throw new Error(`delegation.children[${i}].synthesize_child.research_backend is only valid for kind research_agent`);
        }
      }
      requiredString(synthesizeChild.purpose, `delegation.children[${i}].synthesize_child.purpose`);
      const resultFields = requiredRecord(synthesizeChild.result_fields, `delegation.children[${i}].synthesize_child.result_fields`);
      if (Object.keys(resultFields).length === 0) {
        throw new Error(`delegation.children[${i}].synthesize_child.result_fields must declare at least one field`);
      }
      for (const [field, type] of Object.entries(resultFields)) {
        if (!/^[a-z][a-z0-9_]*$/u.test(field)) {
          throw new Error(`delegation.children[${i}].synthesize_child.result_fields key must be slug-safe; got ${field}`);
        }
        requiredString(type, `delegation.children[${i}].synthesize_child.result_fields.${field}`);
      }
      const childSlug = typeof synthesizeChild.slug === 'string' && synthesizeChild.slug.trim().length > 0
        ? synthesizeChild.slug
        : id;
      if (normalizeProgramNameForSelfTarget(childSlug) === normalizeProgramNameForSelfTarget(context.programSlug)) {
        throw new Error(`delegation.children[${i}].synthesized child slug must not match the parent program slug`);
      }
    }

    const payloadMap = requiredRecord(child.payload_map, `delegation.children[${i}].payload_map`);
    for (const [target, source] of Object.entries(payloadMap)) {
      const targetPath = requiredString(target, `delegation.children[${i}].payload_map target`);
      // Delegation payload targets land at the child's inputs.<target>. Allow the
      // canonical delegated-input roots used by SimoneOS agents: request.* (document
      // ingest / synthesized workers), domain_context.* (shared context), answers.*
      // (legal research question inputs), and document_intake.* (review-service work
      // product). This lets manifest-reuse payload_maps target each agent's real input
      // contract instead of a generic request.topic.
      if (!DELEGATION_PAYLOAD_TARGET_ROOTS.some((root) => targetPath.startsWith(root))) {
        throw new Error(
          `delegation.children[${i}].payload_map target ${targetPath} must start with one of: ${DELEGATION_PAYLOAD_TARGET_ROOTS.join(', ')}`,
        );
      }
      const sourcePath = requiredString(source, `delegation.children[${i}].payload_map.${targetPath}`);
      if (!delegationSchemaPathDeclared(sourcePath, schemaPaths)) {
        throw new Error(`delegation.children[${i}].payload_map source ${sourcePath} must be declared in the parent schema`);
      }
    }

    const resultPath = requiredString(child.result_path, `delegation.children[${i}].result_path`);
    if (!resultPath.startsWith(`${stage}.`)) {
      throw new Error(`delegation.children[${i}].result_path must be under ${stage}.`);
    }
    if (seenResultPaths.has(resultPath)) {
      throw new Error(`delegation.children[${i}].result_path must be unique across children; ${resultPath} is used by more than one child`);
    }
    seenResultPaths.add(resultPath);

    const maxDelegatedRounds = child.max_delegated_rounds;
    if (
      typeof maxDelegatedRounds !== 'number' ||
      !Number.isInteger(maxDelegatedRounds) ||
      maxDelegatedRounds <= 0 ||
      maxDelegatedRounds > 80
    ) {
      throw new Error(`delegation.children[${i}].max_delegated_rounds must be a positive integer <= 80`);
    }

    if (child.round_timeout_ms !== undefined) {
      const timeout = child.round_timeout_ms;
      if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout <= 0) {
        throw new Error(`delegation.children[${i}].round_timeout_ms must be a positive integer when present`);
      }
    }
  }
}

function assertDelegationV1Scope(
  delegation: Record<string, unknown>,
  child: Record<string, unknown>,
): void {
  const refusals: Array<{ capability: string; evidence: string }> = [];
  const note = 'v1 delegation is N distinct static/synthesized children, degrade-only (optional:true); single-child fan-out (one child fanning to many targets) / dynamic targeting / continue-mode / strict delegation are not yet synthesizable';
  const add = (capability: string, reason: string): void => {
    refusals.push({
      capability,
      evidence: `${note} — ${capability} stays refuses (${reason})`,
    });
  };
  if (delegation.fan_out !== undefined || child.fan_out !== undefined) {
    add('delegation_research_agent', 'fan_out');
  }
  if (delegation.dynamic_target_arg !== undefined || child.dynamic_target_arg !== undefined) {
    add('delegation_child_session', 'dynamic_target_arg');
  }
  const delegationMode = typeof child.delegation_mode === 'string'
    ? child.delegation_mode
    : typeof delegation.delegation_mode === 'string'
      ? delegation.delegation_mode
      : '';
  if (delegationMode.toLowerCase() === 'continue') {
    add('delegation_child_session', 'delegation_mode: continue');
  }
  if (child.optional !== true) {
    add('delegation_child_session', 'strict delegation');
  }
  if (refusals.length > 0) {
    throw new CapabilityRefusalError(refusals);
  }
}

function normalizeProgramNameForSelfTarget(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '');
}

function delegationSchemaPathDeclared(path: string, schemaPaths: ReadonlySet<string>): boolean {
  if (schemaPaths.has(path)) {
    return true;
  }
  return [...schemaPaths].some((schemaPath) => {
    if (!schemaPath.includes('*')) {
      return false;
    }
    const escaped = schemaPath
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
      .join('[^.]+');
    return new RegExp(`^${escaped}$`, 'u').test(path);
  });
}

function collectGeneratedActionNamesForDelegationValidation(
  transitions: IntakeTransition[],
  completion: Completion,
  firstMode: string,
): Set<string> {
  const actionNames = new Set(CONTROL_PLANE_ACTIONS);
  for (const action of planTransitionActions(transitions, completion, firstMode)) {
    actionNames.add(action.name);
  }
  return actionNames;
}

function collectGeneratedChannelNamesForDelegationValidation(entryChannel: string): Set<string> {
  return new Set([
    entryChannel,
    USER_CONFIRMATION_CHANNEL,
    'system_mode_entry',
    'widget_output',
    'stage_output',
    COLLECTION_LIFECYCLE_EVENT_CHANNEL,
  ]);
}

function collectParentSchemaPathsForDelegationValidation(
  stages: Stage[],
  entryChannel: string,
  initialEntryPath: string,
  transitions: IntakeTransition[],
  completion: Completion,
): Set<string> {
  const schemaPaths = new Set<string>([
    `inputs.${entryChannel}`,
    initialEntryPath,
  ]);
  for (const transition of transitions) {
    const guardField = guardFieldForTransition(transition, completion);
    if (guardField) {
      schemaPaths.add(guardField);
    }
  }
  for (const stage of stages) {
    if (stage.domain_spec) {
      for (const readPath of stage.domain_spec.reads) {
        schemaPaths.add(readPath);
      }
      collectDomainSpecProducedPaths(stage.slug, stage.domain_spec.produces, schemaPaths);
    }
    if (stage.is_terminal === true) {
      continue;
    }
    schemaPaths.add(`${stage.slug}.result_json`);
    schemaPaths.add(`${stage.slug}.items_json`);
    schemaPaths.add(`${stage.slug}.output`);
    schemaPaths.add(`${stage.slug}.output.result_json`);
    schemaPaths.add(`${stage.slug}.output.items_json`);
    schemaPaths.add(`${stage.slug}.output.digest`);
  }
  return schemaPaths;
}

function collectDomainSpecProducedPaths(
  stageSlug: string,
  produces: Record<string, unknown>,
  schemaPaths: Set<string>,
): void {
  const resultJson = produces.result_json;
  if (resultJson && typeof resultJson === 'object' && !Array.isArray(resultJson)) {
    for (const field of Object.keys(resultJson)) {
      schemaPaths.add(`${stageSlug}.${field}`);
      schemaPaths.add(`${stageSlug}.result.${field}`);
      schemaPaths.add(`${stageSlug}.output.result_json.${field}`);
    }
  }
  if (Array.isArray(produces.items_json)) {
    schemaPaths.add(`${stageSlug}.items_json`);
    schemaPaths.add(`${stageSlug}.output.items_json`);
  }
}

function normalizeCollectionStorageRepresentation(value: unknown): CollectionStorageRepresentation {
  if (value === undefined) {
    return 'json_string';
  }
  return requiredString(value, 'collection_lifecycle.storage.representation') as CollectionStorageRepresentation;
}

function isCollectionStorageRepresentation(value: unknown): value is CollectionStorageRepresentation {
  return value === 'json_string' || value === 'indexed_array';
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

function optionalJsonDomainField(domain: Record<string, unknown>, path: string): unknown {
  const value = domainValue(domain, path);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`optional JSON-string domain field must be a string when present: ${path}`);
  }
  return JSON.parse(value) as unknown;
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

function requiredTrue(value: unknown, label: string): true {
  if (value !== true) {
    throw new Error(`${label} must be true`);
  }
  return true;
}

function optionalStringField(
  record: Record<string, unknown>,
  key: string,
  label: string,
): Record<string, string> {
  const value = record[key];
  if (value === undefined) {
    return {};
  }
  return { [key]: requiredString(value, label) };
}

function optionalNumberField(
  record: Record<string, unknown>,
  key: string,
  label: string,
): Record<string, number> {
  const value = record[key];
  if (value === undefined) {
    return {};
  }
  return { [key]: requiredNumber(value, label) };
}

function optionalRecordField(
  record: Record<string, unknown>,
  key: string,
  label: string,
): Record<string, Record<string, unknown>> {
  const value = record[key];
  if (value === undefined) {
    return {};
  }
  return { [key]: requiredRecord(value, label) };
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
