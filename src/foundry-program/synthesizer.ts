import { isRecord } from '../util/guards.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dump, load } from 'js-yaml';
import { reconstructArray, type ProgramArtifactPolicy, type ProgramDelegationPolicy, type ProgramEntry, type ReactionHandler, type ReactionResult, type ViewSection } from '@simodelne/pgas-server/plugin.js';
import { renderTemplate } from '../pgas-new/template-renderer.js';
import type { WiringAvailableProgram, WiringIntegration } from '../pgas-new/wiring-manifest.js';
import type { CapabilityGap, DelegationChildDescriptor, DelegationDescriptor, DelegationDocumentFanOutDescriptor, DocumentExtractionSurfaces, DocumentsDescriptor, ExportStageDescriptor, ExportSurfaces, SourceGroundedExtractor, SynthesizedArtifact } from './synthesizer-store.js';
import { CapabilityRefusalError, assertSynthesizableCapabilities, detectRequestedCapabilities } from './capability-registry.js';
import {
  detectGovernedConstructs,
  fatalGovernanceViolations,
  GovernanceRefusalError,
  type GovernedArtifactKind,
} from './governance-gate.js';
import { enforcedConstructsForArtifact } from './program-purity.js';
import { parseAndNormalizeStagesJson } from './json-normalize.js';
import {
  canonicalBlueprintRootOrder,
  modularSpecFilesFor,
  modularSpecFilesForYamlIfComplete,
} from './synthesizer/modular-spec.js';
import {
  classifyStagesForDomain,
  type ClassifiedStage,
} from './stage-classifier.js';
import {
  REASONING_CONTRACT_VERSION,
  reasoningFieldSummary,
  runtimeTypeNameFor,
  type ReasoningStageContract,
} from './reasoning-contract.js';
import type {
  CollectionLifecycleDescriptor,
  CollectionLifecycleNumericSumDescriptor,
  CollectionStorageRepresentation,
  Completion,
  ConfirmationLoopDecisionDescriptor,
  ConfirmationLoopDescriptor,
  DelegationChildrenValidationContext,
  DocumentsValidationContext,
  IntakeTransition,
  Interaction,
  MutableRecord,
  NumericAggregatePredicateKind,
  PlannedTransitionAction,
  Stage,
  StageArtifactDescriptor,
  StageArtifactDescriptorInput,
  StageDomainSpec,
  StageInput,
  SynthesizeProgramSpecOptions,
  SynthesizedChildArtifact,
  SynthesizedSpec,
  TerminalActionDescriptor,
  TransitionAction,
} from './synthesizer/types.js';
import {
  channelsForBootstrap,
  cloneRecord,
  guardFieldForTransition,
  guardFromField,
  initialInputPath,
  normalizeGuardField,
  normalizePgasChannelId,
  recordField,
  recordOrEmpty,
  safeIdentifier,
  toPascalCase,
  tsString,
  unique,
} from './synthesizer/shared.js';
import {
  actionMapEntryFor,
  actionsBySourceMode,
  decorateTransitionActions,
  exportRenderHookActionName,
  exportRenderPendingPath,
  exportTransitionActions,
  guardFieldsBySourceMode,
  isConversationalHubTransitionAction,
  isExportTransitionAction,
  isKeyedRecordArrayField,
  keyedRecordArrayAppendActionName,
  keyedRecordArrayFieldsFor,
  outputProjectionFields,
  planTransitionActions,
  transitionActionChannel,
} from './synthesizer/topology.js';
import { pdfReportArtifactRule, renderRegistrationSource } from './synthesizer/registration-artifacts.js';
import { validateSynthesizedSpec } from './synthesizer/validation.js';
import { isRepeatedRecordSchema } from './schema-shapes.js';
export type {
  DelegationChildrenValidationContext,
  DocumentsValidationContext,
  SynthesizeProgramSpecOptions,
  SynthesizedChildArtifact,
  SynthesizedSpec,
} from './synthesizer/types.js';
export { assertPreconditionVocabularyAlignment } from './synthesizer/validation.js';

const COLLECTION_LIFECYCLE_EVENT_CHANNEL = 'lifecycle_event';
const COLLECTION_LIFECYCLE_EVENT_CLEAR_VALUE = '';
const DERIVED_TERMINAL_FIELD = '__terminal';
const DERIVED_TERMINAL_STATUS_FIELD = 'status';
const USER_CONFIRMATION_CHANNEL = 'user_confirmation';
const DOCUMENT_UPLOAD_CHANNEL = 'document_upload';
const DOCUMENT_INTAKE_ROOT = 'inputs.document_intake';
const DOCUMENT_REQUEST_ACTION = 'request_documents';
const EXPORT_HOOK_CHANNEL = 'export_stage_hook';
const DOCUMENT_INGEST_ACTION = 'ingest_documents';
const DOCUMENT_REQUIRED_TOKENS_PATH = 'reference.document_required_tokens';
const DOCUMENT_SKIP_ACTION = 'complete_document_skip';
const DOCUMENTS_RECEIVED_PATH = 'decisions.documents_received';
const DOCUMENT_SKIP_STATUS = 'no_documents_available';
const PROPOSE_ITEM_ACTION = 'propose_item';
const SKILL_PROVIDER_NAME = 'skill';
const SKILL_TRIAGE_DECISION_PATH = 'skill_triage_settled';
const SKILL_BODY_TYPE = 'string';
const TERMINAL_ACTION_GENERIC_EXAMPLE =
  'Valid terminal action JSON example: {"actions":[{"kind":"EffectAction","name":"<action>","channel":"<channel>","payload":{}}]}. Emit exactly ONE such terminal action; do not emit raw MutationActions for a named action.';
const TERMINAL_ACTION_PROTOCOL =
  `Respond with EXACTLY ONE terminal action per response: emit one native tool_call from the current mode vocabulary, with no extra terminal actions, no empty action names, and no free-form action JSON. ${TERMINAL_ACTION_GENERIC_EXAMPLE}`;
const SESSION_CONTROL_ACTIONS = [
  'session_new',
  'session_abort_current',
  'session_status',
  'session_history',
  'session_resume',
  'session_help',
];
const ENGINE_NOTEBOOK_ACTIONS = [
  'record_note',
  'pin_note',
  'unpin_note',
  'delete_note',
];
const CONTROL_PLANE_ACTIONS = [
  ...ENGINE_NOTEBOOK_ACTIONS,
  ...SESSION_CONTROL_ACTIONS,
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

interface RegisteredToolDescriptor {
  name: string;
  kind: 'registered';
  provider: 'libraries/search';
  result_path: string;
  modes: string[];
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface SkillCatalogEntry {
  name: string;
  body: string;
}

interface WebNavigationSourceConfig {
  url: string;
  allowed_domains?: string[];
}

interface WebNavigationGuardContext {
  allowed_domains: string[];
  max_depth: number;
  max_pages: number;
  max_follow_links: number;
  min_delay_ms: number;
  max_concurrency: number;
}

interface HubSectionArtifactProjection {
  stage: string;
  summaryPath: string;
  sectionsPath: string;
  indexPaths: string[];
  textPath: string;
}

interface KeyedCollectionSpecDecl {
  collection: string;
  key: string;
}

interface NoActionEscapePlan {
  mode: string;
  counter: string;
  cap: number;
  arm: string;
  guidance: string;
  aggregateGuard: string;
  blockedMode: string;
  blockedAction: string;
  proposeAction: string;
}

const NO_ACTION_ESCAPE_CAP = 3;

const SKELETON_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../templates/pgas-new/program/spec-skeleton.yml.tmpl',
);

const DEFAULT_WEB_NAVIGATION_GUARD_CONTEXT = {
  max_depth: 1,
  max_pages: 3,
  max_follow_links: 2,
  min_delay_ms: 0,
  max_concurrency: 1,
} as const;

const LEAD_RESEARCH_SOURCE_FAN_OUT_SOURCE_PATH = 'work.config.sources';
const LEAD_RESEARCH_SOURCE_FAN_OUT_CURRENT_PATH = 'work.current_source';
const LEAD_RESEARCH_SOURCE_FAN_OUT_RESULTS_PATH = 'work.aggregate.per_source';

const FORBIDDEN_LEAD_RESEARCH_WEB_IO_NAMES = [
  'checkout',
  'payment',
  'purchase',
  'add_to_cart',
  'login',
  'sign_in',
  'credential',
  'password',
] as const;
const SOURCE_GROUNDED_EXTRACTORS: readonly SourceGroundedExtractor[] = [
  'capitalized_names',
  'citation_ids',
  'figure_refs',
] as const;

type GeneratedSmokeTargetKind = 'standalone_repo' | 'existing_repo';

export function synthesizeProgramSpecFromDomain(
  domain: Record<string, unknown>,
  options: SynthesizeProgramSpecOptions = {},
): SynthesizedSpec {
  const slug = stringDomainField(domain, 'program.slug');
  const name = stringDomainField(domain, 'program.name');
  const purpose = stringDomainField(domain, 'intake.purpose');
  const entryChannel = normalizePgasChannelId(stringDomainField(domain, 'intake.entry_channel'));
  const initialEntryPath = initialInputPath(entryChannel);
  const domainConfig = optionalRecordDomainValue(domain, 'config');
  const guardConfig = optionalRecordDomainValue(domain, 'guard_config');
  let stages = normalizeStages(parseStagesDomainField(domain));
  let transitions = parseJsonDomainField<IntakeTransition[]>(domain, 'intake.transitions_json');
  const rawDelegationInput = parseOptionalJsonDomainField<DelegationDescriptor>(domain, 'intake.delegation_json') ?? {};
  const rawDelegation = normalizeDelegationChildInternalIdentifiers(
    resolveDelegationChildrenAgainstManifest(
      rawDelegationInput,
      options.availablePrograms ?? [],
    ),
  );
  const rawDocuments = optionalJsonDomainField(domain, 'intake.documents_json');
  const documents = normalizeDocumentsDescriptor(rawDocuments);
  const delegation = normalizeDelegationInputEnrichmentTargets(
    normalizeDocumentIngestDelegation(
      normalizeDocumentSliceDelegation(rawDelegation, documents),
      documents,
    ),
    documents,
  );
  let completion = parseJsonDomainField<Completion>(domain, 'intake.completion_json');
  const collectionLifecycle = normalizeCollectionLifecycleDescriptor(completion.collection_lifecycle);
  const interaction = normalizeInteractionDescriptor(optionalJsonDomainField(domain, 'intake.interaction_json'));
  const confirmationLoops = interaction?.confirmation_loops ?? [];
  const delegationChildren = delegation.children ?? [];
  const skills = normalizeSkillCatalog(optionalSkillCatalogDomainField(domain));

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
      schemaPaths: collectParentSchemaPathsForDelegationValidation(stages, entryChannel, initialEntryPath, transitions, completion, documents),
      documents,
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
  stages = normalizeExportStageContracts(stages, exportDescriptors, domain);
  const stageArtifactDescriptors = stageArtifactDescriptorsFor(stages);
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
  const hasConversationalHub = stageClassification.some((stage) => stage.archetype === 'conversational-hub');
  stages = bindPersistenceConfigToStages(stages, stageClassificationBySlug, domain);
  stages = bindWebNavigationGuardContextToStages(stages, stageClassificationBySlug, domain, purpose, delegationChildren);
  if (confirmationLoops.length > 0) {
    assertConfirmationLoopDescriptors(confirmationLoops, collectionLifecycle, stages, stageClassificationBySlug);
    completion = {
      ...completion,
      guard_field: confirmationLoops[0]?.aggregate.guard_field ?? completion.guard_field,
    };
  }
  transitions = refreshStaleTransitionsForStages(stages, transitions, completion) ?? transitions;
  const descriptorCompletionGuard = confirmationLoops[0]?.aggregate.guard_field ?? collectionLifecycle?.aggregate.guard_field;
  if (descriptorCompletionGuard) {
    transitions = transitionsWithFinalStageGuard(transitions, completion.final_stage, descriptorCompletionGuard);
  }
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

  const baseModeNames = stages.map((stage) => stage.slug);
  const noActionEscapePlans = noActionEscapePlansForConfirmationLoops(
    confirmationLoops,
    completion.collection_lifecycle,
    baseModeNames,
  );
  const modeNames = unique([...baseModeNames, ...noActionEscapePlans.map((plan) => plan.blockedMode)]);
  const firstMode = baseModeNames[0] as string;
  const modeNameSet = new Set(modeNames);
  if (!modeNameSet.has(completion.final_stage)) {
    throw new Error(`completion.final_stage must reference a named stage; got ${completion.final_stage}`);
  }
  const registeredTools = collectRegisteredTools(stages, modeNameSet);
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
  const hubSectionArtifacts = collectHubSectionArtifactProjections(stages, stageClassificationBySlug);
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
  const keyedCollections = keyedCollectionsForPersistence(stages, stageClassificationBySlug, reasoningContractsBySlug, domain);
  // pgas#993 / v5.6.0: declared keyed/merge collection paths. A record_array
  // reasoning field targeting one of these upserts ONE element by key, so its
  // native-tool arg is the ELEMENT (object) type appended one-per-call through a
  // repeatable append action — NOT a batch array on the one-shot terminal action.
  const keyedCollectionPaths = new Set(keyedCollections.map((decl) => decl.collection));
  const recoverySteers = recoverySteersForConfirmationLoops(
    confirmationLoops,
    completion.collection_lifecycle,
    transitionActions,
  );
  const documentSchemaInvariants = documentSchemaInvariantsFor(documents);
  const documentTokens = documents ? documentRequiredTokens(documents) : [];
  const exportActions = exportTransitionActions(transitionActions);
  const hasExportDecisionOnly = exportActions.length > 0;
  const transitionActionsBySource = actionsBySourceMode(transitionActions);
  const contractedReasoningOutputStages = new Set(
    transitionActions
      .filter((action) => action.archetype === 'llm-reasoning' && reasoningContractsBySlug.has(action.source))
      .map((action) => action.source),
  );
  const declarativeViewSections = options.targetKind === 'existing_repo'
    ? buildDeclarativeViewSections(stages, stageClassificationBySlug, stageDomainSpecBySlug, reasoningContractsBySlug)
    : [];
  const declarativeRender = buildPdfReportRenderProfile(exportDescriptors);
  const stageOutputResultFieldsBySlug = mergeResultFieldMaps(
    stageResultFieldsForView(declarativeViewSections, (stage) =>
      stageClassificationBySlug.get(stage)?.archetype !== 'llm-reasoning'),
    declarativeRender.resultFieldsByStage,
  );
  const stageOutputMirrorStages = new Set([
    ...flatMirrorStages,
    ...contractedReasoningOutputStages,
    ...stageOutputResultFieldsBySlug.keys(),
  ]);
  const loopStageNames = new Set(confirmationLoops.map((loop) => loop.stage));
  const suppressedTransitionActionNames = new Set(
    [
      ...transitionActions
        .filter((action) => loopStageNames.has(action.source))
        .map((action) => action.name),
      ...exportActions.map((action) => action.name),
    ],
  );
  const firstWorkMode = transitionActions.find((transition) => transition.source === firstMode)?.target ?? intermediateModes[0];
  const childArtifacts = synthesizeDelegationChildArtifacts(slug, name, delegationChildren);
  const capabilityGaps = [
    ...capabilityGapsForDelegationChildren(delegationChildren),
    ...documentExtractionGaps,
    ...capabilityGapsForWebNavigationStages(stageClassification),
    ...capabilityGapsForPersistenceStages(stageClassification),
    ...capabilityGapsForPdfReportExportDescriptors(exportDescriptors),
  ];
  const artifactPolicy = artifactPolicyForExportDescriptors(exportDescriptors, stageArtifactDescriptors);
  const registrationPolicies = {
    ...(delegationChildren.length > 0 ? { delegationPolicy: delegationPolicyForChildren(delegationChildren) } : {}),
    ...(artifactPolicy ? { artifactPolicy } : {}),
  };

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
    'inline_world_query',
    ...(hasConversationalHub ? ['durable_channel'] : []),
    ...(skills.length > 0 ? ['activation', 'skill_triage'] : []),
    ...(registeredTools.length > 0 ? ['integrations', 'tool_registry'] : []),
    ...(hasExportDecisionOnly ? ['decision_only', 'integrations'] : []),
    ...(delegationChildren.length > 0 ? ['delegation'] : []),
    ...(keyedCollections.length > 0 ? ['keyed_collection'] : []),
    ...(recoverySteers.length > 0 ? ['recovery_steer'] : []),
    ...(noActionEscapePlans.length > 0 ? ['no_action_escape'] : []),
    ...(documentSchemaInvariants.length > 0 ? ['schema_invariants'] : []),
    ...(documentTokens.length > 0 ? ['reference_data'] : []),
  ]);
  if (documentTokens.length > 0) {
    spec.reference_data = {
      document_required_tokens: {
        schema: {
          [DOCUMENT_REQUIRED_TOKENS_PATH]: 'array',
          [`${DOCUMENT_REQUIRED_TOKENS_PATH}.*`]: 'string',
        },
        data: documentTokens,
      },
    };
  }
  if (keyedCollections.length > 0) {
    spec.keyed_collections = keyedCollections;
  } else {
    delete spec.keyed_collections;
  }
  if (recoverySteers.length > 0) {
    spec.recovery_steers = recoverySteers;
  } else {
    delete spec.recovery_steers;
  }
  if (noActionEscapePlans.length > 0) {
    spec.no_action_escapes = noActionEscapePlans.map((plan) => ({
      mode: plan.mode,
      counter: plan.counter,
      cap: plan.cap,
      arm: plan.arm,
      guidance: plan.guidance,
    }));
  } else {
    delete spec.no_action_escapes;
  }
  if (documentSchemaInvariants.length > 0) {
    spec.schema_invariants = documentSchemaInvariants;
  } else {
    delete spec.schema_invariants;
  }
  if (hasExportDecisionOnly) {
    spec.pure = false;
  }

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
  applyDocumentFidelityTransitionGuards(synthesizedModes, documents);
  applyConfirmationLoopTransitionGuards(synthesizedModes, confirmationLoops, completion.collection_lifecycle, transitionActions);
  applyCollectionNumericAggregateTransitionGuards(synthesizedModes, completion.collection_lifecycle);
  applyModeVocabularies(synthesizedModes, transitionActionsBySource, terminalModeSet);
  applyStageOutputChannels(synthesizedModes, transitionActions, reasoningContractsBySlug);
  if (completion.collection_lifecycle) {
    applyCollectionLifecycleIntentModeWiring(synthesizedModes, completion.collection_lifecycle);
  }
  applyConfirmationLoopIntentModeWiring(synthesizedModes, confirmationLoops, transitionActions);
  applyDocumentsModeWiring(synthesizedModes, documents);
  applyDelegationModeWiring(synthesizedModes, delegationChildren);
  applyExportDecisionOnlyModeWiring(synthesizedModes, exportActions);
  applyNoActionEscapeModeWiring(synthesizedModes, noActionEscapePlans);
  spec.modes = synthesizedModes;

  spec.proceeds_to = Object.fromEntries(
    transitionActions
      .filter((action) => !suppressedTransitionActionNames.has(action.name))
      .map((action) => [action.name, action.target]),
  );
  applyDocumentsProceedTo(recordField(spec, 'proceeds_to'), documents, transitionActionsBySource);
  applyConfirmationLoopCompletionProceedTo(recordField(spec, 'proceeds_to'), confirmationLoops, transitionActions);
  applyNoActionEscapeProceedTo(recordField(spec, 'proceeds_to'), noActionEscapePlans);

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
      include: unique([`inputs.${entryChannel}`, initialEntryPath, 'notebook.*', 'notebook_pins', startedField, ...(guardFieldsByMode.get(firstMode) ?? [])]),
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
        'notebook.*',
        'notebook_pins',
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
  applyConfirmationLoopProjection(projection, confirmationLoops, completion.collection_lifecycle, modeNames);
  applyNoActionEscapeProjection(projection, noActionEscapePlans);
  applyDocumentsProjection(projection, documents, modeNames);
  applyDelegationProjection(projection, delegationChildren, modeNames, documents);
  applyRegisteredToolProjection(projection, registeredTools);
  applyHubSectionArtifactProjection(projection, hubSectionArtifacts);
  applyScaleSafeProjectionPolicy(projection);
  removeExportDecisionOnlyStageEntries(projection, exportActions);
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
    prompts[modeName] = promptForStage(modeName, name, stageDomainSpecBySlug.get(modeName), reasoningContractsBySlug.get(modeName), keyedCollectionPaths);
  }
  applyTerminalActionPrompts(prompts, transitionActionsBySource, suppressedTransitionActionNames, firstMode, reasoningContractsBySlug);
  applyConfirmationLoopPrompts(prompts, confirmationLoops, completion.collection_lifecycle, transitionActions);
  applyNoActionEscapePrompts(prompts, noActionEscapePlans);
  applyDocumentsPromptsGuidance(prompts, documents);
  applyDelegationPrompts(prompts, delegationChildren, documents);
  applyRegisteredToolPrompts(prompts, registeredTools);
  removeExportDecisionOnlyStageEntries(prompts, exportActions);
  spec.prompts = prompts;

  spec.ingestion = {
    seed: ['inputs.domain_context', 'inputs.domain_context.query'],
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
  applyStageOutputMirrorDerivedPaths(spec, intermediateModes, stageOutputMirrorStages);
  applyStageOutputMirrorReactions(recordField(spec, 'reactions'), intermediateModes, stageOutputMirrorStages, stageOutputResultFieldsBySlug);
  applyReasoningFieldMirrorReactions(recordField(spec, 'reactions'), reasoningContractsBySlug);
  if (completion.collection_lifecycle && confirmationLoops.length === 0) {
    applyCollectionLifecycleReactions(recordField(spec, 'reactions'), completion.collection_lifecycle);
  }
  applyConfirmationLoopReactions(recordField(spec, 'reactions'), confirmationLoops, completion.collection_lifecycle);
  applyDocumentsReactions(recordField(spec, 'reactions'), documents);
  applyDelegationReactions(recordField(spec, 'reactions'), delegationChildren, documents);
  applyLeadResearchHostOutputMirrorReactions(recordField(spec, 'reactions'), delegationChildren);
  applyConversationalHubGuardResetReactions(recordField(spec, 'reactions'), transitionActions);

  spec.channels = {
    ...recordField(spec, 'channels'),
    seed: { direction: 'In', sync: 'Async' },
    [entryChannel]: {
      direction: 'In',
      sync: 'Async',
      ...(hasConversationalHub ? { durable: true, durability: { max_retries: 3, ordering: 'fifo' } } : {}),
    },
    stage_output: { direction: 'Out', sync: 'Sync' },
    ...(hasExportDecisionOnly ? { [EXPORT_HOOK_CHANNEL]: { direction: 'Out', sync: 'Sync' } } : {}),
  };
  if (completion.collection_lifecycle) {
    applyCollectionLifecycleIntentChannel(recordField(spec, 'channels'), completion.collection_lifecycle);
  }
  applyConfirmationLoopIntentChannel(recordField(spec, 'channels'), confirmationLoops, completion.collection_lifecycle);
  applyDocumentsChannel(recordField(spec, 'channels'), documents);
  applyDelegationChannel(recordField(spec, 'channels'), delegationChildren);
  applyControlPlaneEntryChannel(spec, entryChannel);
  applyExportDecisionOnlyIntegrations(spec, exportActions);

  const actionMap = recordField(spec, 'action_map');
  const placeholderActionName = ['example', 'action'].join('_');
  delete actionMap[placeholderActionName];
  delete actionMap.record_user_note;
  if (!transitionActions.some((action) => action.name === 'begin_work')) {
    delete actionMap.begin_work;
  }
  for (const action of transitionActions) {
    if (suppressedTransitionActionNames.has(action.name)) {
      continue;
    }
    actionMap[action.name] = actionMapEntryFor(action, firstMode, stageDomainSpecBySlug.get(action.source), reasoningContractsBySlug.get(action.source), keyedCollectionPaths);
  }
  applyDocumentSliceTransitionActions(actionMap, documents, delegationChildren, transitionActions);
  if (completion.collection_lifecycle) {
    applyCollectionLifecycleIntentActions(actionMap, completion.collection_lifecycle);
  }
  applyConfirmationLoopIntentActions(actionMap, confirmationLoops, completion.collection_lifecycle);
  applyConfirmationLoopCompletionActions(actionMap, confirmationLoops, completion.collection_lifecycle, transitionActions);
  applyNoActionEscapeActions(actionMap, noActionEscapePlans);
  applyDocumentsActions(actionMap, documents);
  applyDocumentsActionPreconditions(synthesizedModes, documents, transitionActionsBySource);
  applyDelegationActions(actionMap, delegationChildren);
  applySourceConfigFanOutInitialization(actionMap, delegationChildren, domain);
  applyEngineNotebookActions(actionMap);
  applySessionControlActionDescriptions(actionMap);
  applyDelegationActionPreconditions(synthesizedModes, delegationChildren, transitionActionsBySource, documents);
  applyConfirmationLoopPairing(spec, confirmationLoops);

  const schema = recordField(spec, 'schema');
  delete schema['work.started'];
  delete schema['work.example_ready'];
  delete schema['work.example_result_json'];
  delete schema['work.example_items_json'];
  schema[`inputs.${entryChannel}`] = 'string';
  schema[initialEntryPath] = 'string';
  schema['inputs.domain_context'] = 'object';
  schema['inputs.domain_context.query'] = 'string';
  delete schema['notebook.entries'];
  delete schema['notebook.pins'];
  schema['notebook.*'] = 'string';
  schema.notebook_pins = 'array';
  schema[startedField] = 'boolean';
  for (const field of unique([...guardFieldsByMode.values()].flat())) {
    schema[field] = 'boolean';
  }
  for (const modeName of intermediateModes) {
    const classification = stageClassificationBySlug.get(modeName);
    if (classification?.archetype === 'conversational-hub') {
      continue;
    }
    if (classification?.archetype === 'llm-reasoning') {
      schema[`${modeName}.result_json`] = 'string';
      schema[`${modeName}.items_json`] = 'string';
      const reasoningContract = reasoningContractsBySlug.get(modeName);
      if (reasoningContract) {
        schema[`${modeName}.output`] = 'object';
        schema[`${modeName}.output.result_json`] = 'string';
        schema[`${modeName}.output.items_json`] = 'string';
        schema[`${modeName}.raw_result_json`] = 'any';
        schema[`${modeName}.raw_items_json`] = 'any';
        schema[`${modeName}.raw_result_fields`] = 'object';
        schema[`${modeName}.result`] = 'object';
        for (const field of reasoningContract.result_schema.fields) {
          if (field.type === 'record_array') {
            schema[`${modeName}.result.${field.name}`] = runtimeTypeNameFor(field.type);
            schema[`${modeName}.result.${field.name}.*`] = 'object';
            for (const [recordField, recordType] of Object.entries(field.record_fields ?? {})) {
              schema[`${modeName}.result.${field.name}.*.${recordField}`] = runtimeTypeNameFor(recordType);
            }
          } else {
            schema[`${modeName}.raw_result_fields.${field.name}`] = 'any';
            schema[`${modeName}.result.${field.name}`] = runtimeTypeNameFor(field.type);
          }
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
      if (stageOutputMirrorStages.has(modeName)) {
        schema[`${modeName}.result_json`] = 'string';
        schema[`${modeName}.items_json`] = 'string';
      }
      const resultSchema = domainSpecResultJsonSchema(stageDomainSpecBySlug.get(modeName));
      const viewFields = stageOutputResultFieldsBySlug.get(modeName) ?? [];
      if (resultSchema && viewFields.length > 0) {
        schema[`${modeName}.result`] = 'object';
        for (const field of viewFields) {
          const schemaValue = resultSchema[field];
          schema[`${modeName}.result.${field}`] = domainResultSchemaTypeName(schemaValue);
          if (isRepeatedRecordSchema(schemaValue)) {
            schema[`${modeName}.result.${field}.*`] = 'object';
            for (const [nestedField, nestedValue] of Object.entries(schemaValue[0])) {
              schema[`${modeName}.result.${field}.*.${nestedField}`] = domainResultSchemaTypeName(nestedValue);
            }
          }
        }
      }
    }
  }
  for (const action of exportActions) {
    schema[exportRenderPendingPath(action.source)] = 'boolean';
  }
  applyExportRenderPendingEntryMutations(actionMap, transitionActions, exportActions);
  if (completion.collection_lifecycle) {
    applyCollectionLifecycleSchema(schema, completion.collection_lifecycle);
  }
  applyConfirmationLoopSchema(schema, confirmationLoops, completion.collection_lifecycle);
  applyNoActionEscapeSchema(schema, noActionEscapePlans);
  applyDocumentsSchema(schema, documents);
  applyDelegationSchema(schema, delegationChildren, documents);
  applyDelegationSettleFlagDerivedPaths(spec, delegationChildren, documents);
  applyRegisteredToolSchema(schema, registeredTools);
  applyHubSectionArtifactSchema(schema, hubSectionArtifacts);
  applySkillTriageSpec(spec, skills);
  applyCollectionCompletionDerivedPaths(spec, completion.collection_lifecycle, confirmationLoops);
  applyRenderProfileSchemaAndDerivedPaths(spec, declarativeRender);
  const queryPolicy = queryPolicyForDeclaredPaths(schema, projection, stageDomainSpecBySlug);

  spec.guidance = guidanceFor(intermediateModes, delegation, stageDomainSpecBySlug, reasoningContractsBySlug);
  applyTerminalActionGuidance(recordField(spec, 'guidance'), transitionActionsBySource, suppressedTransitionActionNames, firstMode, reasoningContractsBySlug);
  applyConfirmationLoopGuidance(recordField(spec, 'guidance'), confirmationLoops, completion.collection_lifecycle, transitionActions);
  applyNoActionEscapeGuidance(recordField(spec, 'guidance'), noActionEscapePlans);
  applyDocumentsPromptsGuidance(recordField(spec, 'guidance'), documents);
  applyDelegationGuidance(recordField(spec, 'guidance'), delegationChildren, documents);
  applyRegisteredToolGuidance(recordField(spec, 'guidance'), registeredTools);
  removeExportDecisionOnlyStageEntries(recordField(spec, 'guidance'), exportActions);
  applyEngineToolkitGuidance(recordField(spec, 'guidance'), synthesizedModes, queryPolicy.allowedWorldQueryPrefixes.length > 0);
  applyKeyedRecordArrayAppendActions(
    actionMap,
    synthesizedModes,
    recordField(spec, 'guidance'),
    reasoningContractsBySlug,
    keyedCollections,
    transitionActionsBySource,
  );

  if (registeredTools.length > 0) {
    spec.tools = Object.fromEntries(registeredTools.map((tool) => [
      tool.name,
      {
        description: tool.description,
        parameters: tool.parameters,
        result_path: tool.result_path,
        modes: tool.modes,
      },
    ]));
  }
  if ((options.targetKind ?? 'standalone_repo') !== 'existing_repo') {
    spec.policies = {
      ...registrationPolicies,
      ...(registeredTools.length > 0
        ? {
            syncOutContinuationPolicy: {
              channels: registeredTools.map((tool) => `tool:${tool.name}`),
              maxContinuations: 4,
            },
          }
        : {}),
      queryPolicy,
    };
    if (declarativeRender.profile) {
      spec.render = declarativeRender.profile;
    }
    if (declarativeViewSections.length > 0) {
      spec.view = declarativeViewSections;
    }
  }
  assertNoForbiddenLeadResearchWebVocabulary(spec, slug, stageClassification, domain);

  // Root keys are regrouped into canonical blueprint block order before the
  // dump. Key order compiles to nothing, but pgas#946 makes the engine's
  // blueprint gate STRICT by default in v6, and a non-canonical single-file
  // spec is rejected outright ([BLOCK_ORDER]). The modular emission below
  // walks the same partition, so both emissions stay in lockstep.
  const specYaml = dump(canonicalBlueprintRootOrder(spec), { lineWidth: -1, noRefs: true, sortKeys: false });
  const specFiles = modularSpecFilesFor(spec);
  validateSynthesizedSpec(specYaml, specFiles);
  const bodyStageSlugs = bodyStageSlugsFor(stages, completion, stageClassificationBySlug);

  const contractsTs = appendDocumentExtractionHostConnectorContracts(
    renderContractsSource(stages, stageClassification, transitionActions, reasoningContractsBySlug),
    documentExtractionGaps,
  );
  const handlersTs = renderHandlersSource(transitionActions, {
    includeReactionHandlers: true,
    resolverImport: './handlers/_resolver.js',
    contractsImport: './contracts.js',
    stageImportPrefix: './stages',
    initialEntryPath,
    entryPath: `inputs.${entryChannel}`,
    flatMirrorStages: stageOutputMirrorStages,
    stageResultFieldsBySlug: stageOutputResultFieldsBySlug,
    collectionLifecycle: completion.collection_lifecycle,
    confirmationLoops,
    delegationChildren,
    documents,
    docxExtractorImport: './extract/docx.js',
  }, reasoningContractsBySlug);
  const toolsTs = renderToolsSource(slug, transitionActions, reasoningContractsBySlug, completion.collection_lifecycle, confirmationLoops, documents, registeredTools);

  verifyGeneratedSourceGovernance(handlersTs, 'reaction_handler', 'handlers_ts');
  verifyGeneratedSourceGovernance(toolsTs, 'resolver', 'tools_ts');

  return {
    spec_yaml: specYaml,
    spec_files: specFiles,
    mode_names: modeNames,
    sha256: createHash('sha256').update(specYaml).digest('hex'),
    contracts_ts: contractsTs,
    handlers_ts: handlersTs,
    handlers_index_ts: renderHandlersIndexBarrelSource(),
    tools_ts: toolsTs,
    smoke_test_ts: renderSmokeTestSource(
      slug,
      name,
      entryChannel,
      stages,
      transitionActions,
      completion,
      reasoningContractsBySlug,
      confirmationLoops,
      delegationChildren,
      documents,
      options.targetKind ?? 'standalone_repo',
    ),
    ...(capabilityGaps.length > 0 ? { capability_gaps: capabilityGaps } : {}),
    registration_ts: renderRegistrationSource(toPascalCase(slug), {
      ...registrationPolicies,
      queryPolicy,
    }, {
        exportHookChannel: hasExportDecisionOnly ? EXPORT_HOOK_CHANNEL : undefined,
        renderProfile: declarativeRender.profile,
        syncOutContinuationChannels: registeredTools.map((tool) => `tool:${tool.name}`),
        viewSections: declarativeViewSections,
      }),
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
      ...(domainConfig ? { config: domainConfig } : {}),
      ...(guardConfig ? { guard_config: guardConfig } : {}),
      stages,
      transitions,
      delegation,
      ...(documents ? { documents } : {}),
      ...(skills.length > 0 ? { skills } : {}),
      ...(hasExportSurfaces(exportSurfaces) ? { export_surfaces: exportSurfaces } : {}),
      ...(hasDocumentExtractionSurfaces(documentExtractionSurfaces) ? { document_extraction_surfaces: documentExtractionSurfaces } : {}),
      ...(exportDescriptors.length > 0 ? { export_descriptors: exportDescriptors } : {}),
      ...(interaction ? { interaction } : {}),
      completion,
    },
  };
}

export interface ReusableDelegationPayloadMapCompatibility {
  delegation: DelegationDescriptor;
  errors: string[];
}

export function adaptReusableDelegationPayloadMapsForDomain(
  domain: Record<string, unknown>,
  delegation: DelegationDescriptor,
  availablePrograms: WiringAvailableProgram[],
): ReusableDelegationPayloadMapCompatibility {
  if (!Array.isArray(delegation.children) || delegation.children.length === 0) {
    return { delegation, errors: [] };
  }

  const entryChannel = normalizePgasChannelId(stringDomainField(domain, 'intake.entry_channel'));
  const initialEntryPath = initialInputPath(entryChannel);
  const stages = normalizeStages(parseStagesDomainField(domain));
  const transitions = parseOptionalJsonDomainField<IntakeTransition[]>(domain, 'intake.transitions_json') ?? [];
  const completion = parseOptionalJsonDomainField<Completion>(domain, 'intake.completion_json');
  const rawDocuments = optionalJsonDomainField(domain, 'intake.documents_json');
  const documents = normalizeDocumentsDescriptor(rawDocuments);
  const resolved = normalizeDelegationChildInternalIdentifiers(
    resolveDelegationChildrenAgainstManifest(delegation, availablePrograms),
  );
  const normalized = normalizeDelegationInputEnrichmentTargets(
    normalizeDocumentIngestDelegation(
      normalizeDocumentSliceDelegation(resolved, documents),
      documents,
    ),
    documents,
  );
  const schemaPaths = collectParentSchemaPathsForDelegationValidation(
    stages,
    entryChannel,
    initialEntryPath,
    transitions,
    completion,
    documents,
  );
  addDelegationResultSchemaPaths(normalized, schemaPaths);

  return {
    delegation: normalized,
    errors: [
      ...reusableDelegationPayloadMapSourceErrors(normalized, schemaPaths),
      ...documentDelegationCompatibilityErrors(documents, normalized),
    ],
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
    ...(context.config ? { config: context.config } : {}),
    ...(context.guard_config ? { guard_config: context.guard_config } : {}),
    'intake.stages_json': JSON.stringify(context.stages),
    'intake.transitions_json': JSON.stringify(context.transitions),
    'intake.delegation_json': JSON.stringify(context.delegation),
    ...(context.documents ? { 'intake.documents_json': JSON.stringify(context.documents) } : {}),
    'intake.completion_json': JSON.stringify(context.completion),
    ...(context.interaction ? { 'intake.interaction_json': JSON.stringify(context.interaction) } : {}),
    ...(context.skills ? { 'intake.skills_json': JSON.stringify(context.skills) } : {}),
  }, { ...options, reasoningContracts: contracts });
}

function verifyGeneratedSourceGovernance(
  sourceText: string,
  artifactKind: GovernedArtifactKind,
  artifactName: string,
): void {
  const violations = fatalGovernanceViolations(
    detectGovernedConstructs(sourceText),
    artifactKind,
    enforcedConstructsForArtifact(artifactKind),
  );
  if (violations.length > 0) {
    throw new GovernanceRefusalError(artifactName, violations);
  }
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
  transitions: Array<{ target: string; when?: Record<string, unknown> }>;
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
    const emittedTransition: { target: string; when?: Record<string, unknown> } = { target: action.target };
    if (guard) {
      emittedTransition.when = guard;
    }
    modeTransitions.push(emittedTransition);
    fromMode.transitions = modeTransitions;
  }
}

function applyDocumentFidelityTransitionGuards(
  modes: MutableRecord,
  documents: DocumentsDescriptor | undefined,
): void {
  if (!documents) {
    return;
  }
  const fidelity = documentUploadedFidelityPredicate(documents);
  if (!fidelity) {
    return;
  }
  const mode = recordField(modes, documents.stage);
  const transitions = Array.isArray(mode.transitions) ? mode.transitions as MutableRecord[] : [];
  for (const transition of transitions) {
    const existing = isRecord(transition.when) ? transition.when : undefined;
    const uploadGuard = existing ? allPredicates([existing, fidelity]) : fidelity;
    transition.when = documents.required
      ? uploadGuard
      : { kind: 'Any', subs: [documentSkipRequestedPredicate(), uploadGuard] };
  }
}

function documentUploadedFidelityPredicate(documents: DocumentsDescriptor): MutableRecord | undefined {
  const predicates: MutableRecord[] = [];
  const minChars = documentMinChars(documents);
  if (minChars > 0) {
    predicates.push({
      kind: 'FieldGreaterOrEqual',
      path: `${documents.result_path}.char_count`,
      value: minChars,
    });
  }
  const requiredTokens = documentRequiredTokens(documents);
  if (requiredTokens.length > 0) {
    predicates.push({
      kind: 'FieldContainsAllFromCollection',
      path: `${documents.result_path}.full_text`,
      source_path: DOCUMENT_REQUIRED_TOKENS_PATH,
    });
  }
  return predicates.length === 0 ? undefined : allPredicates(predicates);
}

function documentSchemaInvariantsFor(documents: DocumentsDescriptor | undefined): MutableRecord[] {
  if (!documents) {
    return [];
  }
  const invariants: MutableRecord[] = [];
  for (const pattern of documentRequiredPatterns(documents)) {
    invariants.push({
      kind: 'FieldMatchesPattern',
      path: 'text',
      pattern,
    });
  }
  for (const pattern of documentForbiddenPatterns(documents)) {
    invariants.push({
      kind: 'FieldNotMatchesPattern',
      path: 'text',
      pattern,
    });
  }
  // pgas#1743: intake copies/extracts source text deterministically, with no
  // authored claim subject. Keep legacy descriptor validation, but emit no
  // grounding invariant or validate declaration for this source copy.
  validateSourceGroundedExtractors(documents);
  return invariants.length === 0
    ? []
    : [{ collection: documentsCollectionPath(documents), invariants }];
}

function documentSkipRequestedPredicate(): MutableRecord {
  return { kind: 'FieldEquals', path: `${DOCUMENT_INTAKE_ROOT}.status`, value: DOCUMENT_SKIP_STATUS };
}

function alwaysPredicate(): MutableRecord {
  return { kind: 'Always' };
}

function anyPredicates(predicates: MutableRecord[]): MutableRecord {
  return predicates.length === 1 ? predicates[0] as MutableRecord : { kind: 'Any', subs: predicates };
}

function allPredicates(predicates: MutableRecord[]): MutableRecord {
  const flattened = predicates.flatMap((predicate) =>
    predicate.kind === 'All' && Array.isArray(predicate.subs)
      ? predicate.subs as MutableRecord[]
      : [predicate]);
  return flattened.length === 1 ? flattened[0] as MutableRecord : { kind: 'All', subs: flattened };
}

function applyConfirmationLoopTransitionGuards(
  modes: MutableRecord,
  loops: ConfirmationLoopDescriptor[],
  lifecycle: CollectionLifecycleDescriptor | undefined,
  transitionActions: TransitionAction[],
): void {
  if (!lifecycle) {
    return;
  }
  for (const loop of loops) {
    const completionTargets = confirmationLoopCompletionTransitionActionsForLoop(loop, transitionActions)
      .map((action) => action.target);
    if (completionTargets.length === 0) {
      continue;
    }
    const mode = recordField(modes, loop.stage);
    const transitions = Array.isArray(mode.transitions) ? mode.transitions as MutableRecord[] : [];
    for (const transition of transitions) {
      if (typeof transition.target === 'string' && completionTargets.includes(transition.target)) {
        transition.when = collectionLifecycleTerminalStatusPredicate(loop.collection);
      }
    }
  }
}

function noActionEscapePlansForConfirmationLoops(
  loops: ConfirmationLoopDescriptor[],
  lifecycle: CollectionLifecycleDescriptor | undefined,
  existingModeNames: string[],
): NoActionEscapePlan[] {
  if (!lifecycle) {
    return [];
  }
  const usedModeNames = new Set(existingModeNames);
  const usedEscapeBases = new Set<string>();
  return loops.map((loop, index) => {
    const escapedCollection = safeIdentifier(loop.collection);
    const escapeBase = uniqueSuffixedName(
      `${loop.stage}.no_action_escape.${escapedCollection}`,
      usedEscapeBases,
    );
    const blockedMode = uniqueSuffixedName(
      `${safeIdentifier(loop.stage)}_no_action_blocked`,
      usedModeNames,
    );
    const blockedAction = `route_${safeIdentifier(blockedMode)}`;
    const proposeAction = confirmationLoopProposeActionName(loop, index, loops.length);
    return {
      mode: loop.stage,
      counter: `${escapeBase}.counter`,
      cap: NO_ACTION_ESCAPE_CAP,
      arm: `${escapeBase}.arm`,
      aggregateGuard: loop.aggregate.guard_field,
      blockedMode,
      blockedAction,
      proposeAction,
      guidance: `No admissible confirmation-loop action was emitted; ${loop.stage} is waiting for ${proposeAction} while ${loop.aggregate.guard_field} is false. Emit ${proposeAction} with the active ${lifecycle.item_label} content, or call ${blockedAction} after the no-action escape arms if the work cannot be completed soundly.`,
    };
  });
}

function applyNoActionEscapeModeWiring(
  modes: MutableRecord,
  plans: NoActionEscapePlan[],
): void {
  for (const plan of plans) {
    const mode = recordField(modes, plan.mode);
    const transitions = Array.isArray(mode.transitions) ? mode.transitions as MutableRecord[] : [];
    mode.transitions = [
      ...transitions,
      { target: plan.blockedMode, when: noActionEscapeBlockedPredicate(plan) },
    ];
    const vocabulary = Array.isArray(mode.vocabulary) ? mode.vocabulary as string[] : [];
    mode.vocabulary = unique([...vocabulary, plan.blockedAction]);
    const channels = Array.isArray(mode.channels) ? mode.channels as string[] : [];
    mode.channels = unique([...channels, 'widget_output']);
    appendModePrecondition(mode, plan.blockedAction, { kind: 'FieldTruthy', path: plan.arm });
    appendModePrecondition(mode, plan.blockedAction, { kind: 'FieldFalsy', path: plan.aggregateGuard });
    appendModePrecondition(mode, plan.proposeAction, { kind: 'FieldFalsy', path: plan.arm });
  }
}

function applyNoActionEscapeProceedTo(
  proceedTo: MutableRecord,
  plans: NoActionEscapePlan[],
): void {
  for (const plan of plans) {
    const existing = proceedTo[plan.blockedAction];
    if (existing !== undefined && existing !== plan.blockedMode) {
      throw new Error(`no_action_escape blocked action ${plan.blockedAction} has conflicting proceeds_to target`);
    }
    proceedTo[plan.blockedAction] = plan.blockedMode;
  }
}

function applyNoActionEscapeProjection(
  projection: MutableRecord,
  plans: NoActionEscapePlan[],
): void {
  for (const plan of plans) {
    for (const modeName of [plan.mode, plan.blockedMode]) {
      const modeProjection = recordField(projection, modeName);
      const include = Array.isArray(modeProjection.include) ? modeProjection.include as string[] : [];
      modeProjection.include = unique([...include, plan.arm, plan.aggregateGuard]);
    }
  }
}

function applyNoActionEscapePrompts(
  prompts: MutableRecord,
  plans: NoActionEscapePlan[],
): void {
  for (const plan of plans) {
    prompts[plan.blockedMode] = `Terminal blocked sink reached after ${plan.mode} emitted repeated fallback rounds without an admissible confirmation-loop action.`;
  }
}

function applyNoActionEscapeGuidance(
  guidance: MutableRecord,
  plans: NoActionEscapePlan[],
): void {
  for (const plan of plans) {
    const existing = Array.isArray(guidance[plan.blockedMode]) ? guidance[plan.blockedMode] as string[] : [];
    guidance[plan.blockedMode] = [
      ...existing,
      `No-action escape from ${plan.mode} armed ${plan.arm}; unresolved work was routed here instead of being auto-approved.`,
    ];
  }
}

function applyNoActionEscapeActions(
  actionMap: MutableRecord,
  plans: NoActionEscapePlan[],
): void {
  for (const plan of plans) {
    if (Object.prototype.hasOwnProperty.call(actionMap, plan.blockedAction)) {
      throw new Error(`no_action_escape blocked action collides with generated action_map: ${plan.blockedAction}`);
    }
    actionMap[plan.blockedAction] = {
      description: `Route ${plan.mode} to blocked terminal handling after the no-action escape arms ${plan.arm}. This action does not approve unresolved confirmation items and writes no domain state.`,
      mutations: [],
      channel: 'widget_output',
    };
  }
}

function applyNoActionEscapeSchema(
  schema: MutableRecord,
  plans: NoActionEscapePlan[],
): void {
  for (const plan of plans) {
    schema[plan.counter] = 'number';
    schema[plan.arm] = 'boolean';
  }
}

function noActionEscapeBlockedPredicate(plan: NoActionEscapePlan): MutableRecord {
  return allPredicates([
    { kind: 'FieldTruthy', path: plan.arm },
    { kind: 'FieldFalsy', path: plan.aggregateGuard },
  ]);
}

function uniqueSuffixedName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let suffix = 2;
  while (used.has(`${base}_${suffix}`)) {
    suffix += 1;
  }
  const value = `${base}_${suffix}`;
  used.add(value);
  return value;
}

function applyCollectionNumericAggregateTransitionGuards(
  modes: MutableRecord,
  descriptor: CollectionLifecycleDescriptor | undefined,
): void {
  if (!descriptor) {
    return;
  }
  const predicates = collectionLifecycleNumericAggregatePredicates(descriptor);
  if (predicates.length === 0) {
    return;
  }
  for (const rawMode of Object.values(modes)) {
    if (!isRecord(rawMode) || !Array.isArray(rawMode.transitions)) {
      continue;
    }
    for (const transition of rawMode.transitions) {
      if (!isRecord(transition) || !isRecord(transition.when)) {
        continue;
      }
      if (!isCollectionLifecycleCompletionGuard(transition.when, descriptor)) {
        continue;
      }
      transition.when = allPredicates([transition.when, ...predicates]);
    }
  }
}

function collectionLifecycleNumericAggregatePredicates(
  descriptor: CollectionLifecycleDescriptor,
): MutableRecord[] {
  return (descriptor.aggregate.numeric_sums ?? [])
    .flatMap((sum) => sum.predicate
      ? [{
          kind: sum.predicate.kind,
          path: sum.target,
          value: sum.predicate.value,
        }]
      : []);
}

function isCollectionLifecycleCompletionGuard(
  predicate: MutableRecord,
  descriptor: CollectionLifecycleDescriptor,
): boolean {
  return (
    predicate.kind === 'FieldTruthy' &&
    predicate.path === descriptor.aggregate.guard_field
  ) || (
    predicate.kind === 'AllItemsStatus' &&
    predicate.path === collectionLifecycleTerminalStatusItemsPath(descriptor.storage.items_path) &&
    predicate.value === true
  );
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
      ...toolkitActionsForMode(mode),
    ];
  }
}

function toolkitActionsForMode(mode: MutableRecord): string[] {
  const channels = Array.isArray(mode.channels) ? mode.channels as string[] : [];
  const notebookActions = channels.includes('widget_output') ? ENGINE_NOTEBOOK_ACTIONS : [];
  return [...notebookActions, ...SESSION_CONTROL_ACTIONS];
}

function applyStageOutputChannels(
  modes: MutableRecord,
  transitionActions: TransitionAction[],
  reasoningContractsBySlug: Map<string, ReasoningStageContract>,
): void {
  for (const action of transitionActions) {
    if (action.name === 'begin_work') {
      continue;
    }
    if (isConversationalHubTransitionAction(action)) {
      continue;
    }
    if (action.archetype === 'llm-reasoning' && !reasoningContractsBySlug.has(action.source)) {
      continue;
    }
    const mode = recordField(modes, action.source);
    const channels = Array.isArray(mode.channels) ? mode.channels as string[] : [];
    mode.channels = unique([...channels, 'stage_output']);
  }
}

function applyExportDecisionOnlyModeWiring(
  modes: MutableRecord,
  exportActions: TransitionAction[],
): void {
  const actionsBySource = actionsBySourceMode(exportActions);
  for (const [source, actions] of actionsBySource) {
    for (const action of actions) {
      if (actions.length > 1 && action.guardField?.startsWith(`${source}.`)) {
        throw new Error(
          `decision-only export stage ${source} has branched source-local guard ${action.guardField}; the export hook cannot satisfy source-local branch guards`,
        );
      }
    }
    const mode = recordField(modes, source);
    mode.decision_only = true;
    mode.vocabulary = [];
    mode.channels = [];
    delete mode.preconditions;
    mode.transitions = actions.map(exportDecisionOnlyTransition);
  }
}

function exportDecisionOnlyTransition(action: TransitionAction): { target: string; when?: Record<string, unknown> } {
  const transition: { target: string; when?: Record<string, unknown> } = { target: action.target };
  if (action.guardField && !action.guardField.startsWith(`${action.source}.`)) {
    transition.when = guardFromField(action.guardField);
  }
  return transition;
}

function removeExportDecisionOnlyStageEntries(record: MutableRecord, exportActions: TransitionAction[]): void {
  for (const action of exportActions) {
    delete record[action.source];
  }
}

// The export stage is `decision_only`: no author round, so no EffectAction and no
// LLM-authored dispatch. Its only outbound seam is an integration hook, and a hook
// can declare WHAT to dispatch but not WHEN — except through `AfterMutation`, which
// is scoped by mutation path. So the transition INTO the export stage carries a
// single declared `MSet <stage>.render_pending = true`, and the hook binds to that
// exact path. The field already exists in the emitted schema; this reuses it as the
// dispatch trigger instead of as a consumer-read suppression flag.
function applyExportRenderPendingEntryMutations(
  actionMap: MutableRecord,
  transitionActions: TransitionAction[],
  exportActions: TransitionAction[],
): void {
  const exportStages = new Set(exportActions.map((action) => action.source));
  for (const action of transitionActions) {
    if (!exportStages.has(action.target)) {
      continue;
    }
    const semantics = actionMap[action.name];
    if (!isRecord(semantics)) {
      continue;
    }
    const path = exportRenderPendingPath(action.target);
    const mutations = Array.isArray(semantics.mutations) ? [...semantics.mutations] : [];
    if (mutations.some((mutation) => isRecord(mutation) && mutation.path === path)) {
      continue;
    }
    mutations.push({ op: 'MSet', path, value: true });
    (semantics as MutableRecord).mutations = mutations;
  }
}

function applyConversationalHubGuardResetReactions(
  reactions: MutableRecord,
  transitionActions: TransitionAction[],
): void {
  for (const [source, actions] of actionsBySourceMode(transitionActions)) {
    if (!actions.some(isConversationalHubTransitionAction)) {
      continue;
    }
    const guardFields = unique(actions.map((action) => action.guardField).filter(isString));
    if (guardFields.length === 0) {
      continue;
    }
    reactions[conversationalHubGuardResetReactionName(source)] = {
      event: 'OnTransition',
      write_scope: guardFields,
    };
  }
}

function conversationalHubGuardResetReactionName(stage: string): string {
  return `reset_${safeIdentifier(stage)}_hub_branch_guards`;
}

function applyExportDecisionOnlyIntegrations(spec: MutableRecord, exportActions: TransitionAction[]): void {
  if (exportActions.length === 0) {
    return;
  }
  spec.integrations = {
    ...recordOrEmpty(spec.integrations),
    export_stage_hooks: {
      channel: EXPORT_HOOK_CHANNEL,
      // Scoped to the ONE-SHOT `<stage>.render_pending` write emitted onto the
      // action that transitions INTO this export stage (see
      // `applyExportRenderPendingEntryMutations`). `OnTransition` carries no
      // mode/target-mode/predicate scope — the engine batches every declared
      // OnTransition hook on EVERY mode change — so it dispatches once per
      // transition, minting one deliverable per hop. `AfterMutation` is the only
      // hook event with any scoping (`runAfterMutationHooks` matches
      // `instructionSet.mutations` against `path`), which makes the dispatch
      // exactly-once WITHOUT a consumer-side filter.
      hooks: unique(exportActions.map((action) => action.source)).map((stage) => ({
        action: exportRenderHookActionName(stage),
        event: 'AfterMutation',
        path: exportRenderPendingPath(stage),
        result_path: `${stage}.output`,
      })),
    },
  };
}

function applySkillTriageSpec(spec: MutableRecord, skills: SkillCatalogEntry[]): void {
  if (skills.length === 0) {
    return;
  }

  const advisorySchema = recordOrEmpty(spec.advisory_schema);
  for (const skill of skills) {
    advisorySchema[`${SKILL_PROVIDER_NAME}.${skill.name}`] = SKILL_BODY_TYPE;
  }
  spec.advisory_schema = advisorySchema;

  const activationProviders = recordOrEmpty(spec.activation_providers);
  if (activationProviders[SKILL_PROVIDER_NAME] !== undefined) {
    throw new Error(`activation provider "${SKILL_PROVIDER_NAME}" is already declared`);
  }
  activationProviders[SKILL_PROVIDER_NAME] = {
    targets: Object.fromEntries(skills.map((skill) => [skill.name, { body: skill.body }])),
  };
  spec.activation_providers = activationProviders;

  spec.decision_schema = {
    ...recordOrEmpty(spec.decision_schema),
    [SKILL_TRIAGE_DECISION_PATH]: SKILL_BODY_TYPE,
  };
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
    if (archetype !== undefined && archetype !== 'llm-reasoning' && archetype !== 'conversational-hub') {
      flatMirrorStages.add(stageSlug);
    }
  }
  return flatMirrorStages;
}

const VIEW_RESULT_FIELD_SKIP_LIST = new Set(['stage']);
const CONCRETE_VIEW_PATH_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function buildDeclarativeViewSections(
  stages: Stage[],
  stageClassificationBySlug: ReadonlyMap<string, ClassifiedStage>,
  stageDomainSpecBySlug: ReadonlyMap<string, StageDomainSpec>,
  reasoningContractsBySlug: ReadonlyMap<string, ReasoningStageContract>,
): ViewSection[] {
  const sections: ViewSection[] = [];
  const seenKeys = new Set<string>();
  const addSection = (section: ViewSection): void => {
    if (seenKeys.has(section.key)) {
      return;
    }
    seenKeys.add(section.key);
    sections.push(section);
  };

  for (const stage of stages) {
    if (stage.is_bootstrap === true || stage.is_terminal === true) {
      continue;
    }
    const classification = stageClassificationBySlug.get(stage.slug);
    if (classification?.archetype === 'conversational-hub') {
      continue;
    }
    const reasoningContract = reasoningContractsBySlug.get(stage.slug);
    if (classification?.archetype === 'llm-reasoning' && reasoningContract) {
      for (const field of reasoningContract.result_schema.fields) {
        const section = viewSectionForResultField(stage.slug, field.name, {
          format: field.type === 'record_array' ? 'table' : undefined,
          columns: field.type === 'record_array' ? plainRecordColumns(field.record_fields ?? {}) : undefined,
        });
        if (section) {
          addSection(section);
        }
      }
      continue;
    }

    const resultJsonSchema = domainSpecResultJsonSchema(stageDomainSpecBySlug.get(stage.slug));
    if (!resultJsonSchema) {
      continue;
    }
    for (const [field, schemaValue] of Object.entries(resultJsonSchema)) {
      if (Array.isArray(schemaValue)) {
        continue;
      }
      const section = viewSectionForResultField(stage.slug, field, {
        format: undefined,
        columns: undefined,
      });
      if (section) {
        addSection(section);
      }
    }
  }

  return sections;
}

function viewSectionForResultField(
  stage: string,
  field: string,
  options: Pick<ViewSection, 'columns' | 'format'> = {},
): ViewSection | undefined {
  if (
    VIEW_RESULT_FIELD_SKIP_LIST.has(field) ||
    !CONCRETE_VIEW_PATH_SEGMENT.test(stage) ||
    !CONCRETE_VIEW_PATH_SEGMENT.test(field)
  ) {
    return undefined;
  }
  return {
    key: `${stage}_${field}`,
    from: `${stage}.result.${field}`,
    label: titleCaseIdentifier(`${stage}_${field}`),
    ...(options.format ? { format: options.format } : {}),
    ...(options.columns && options.columns.length > 0 ? { columns: options.columns } : {}),
  };
}

function stageResultFieldsForView(
  sections: readonly ViewSection[],
  includeStage: (stage: string) => boolean = () => true,
): Map<string, string[]> {
  const fieldsByStage = new Map<string, string[]>();
  for (const section of sections) {
    const match = section.from.match(/^([A-Za-z_][A-Za-z0-9_]*)\.result\.([A-Za-z_][A-Za-z0-9_]*)$/u);
    if (!match) {
      continue;
    }
    const stage = match[1] as string;
    const field = match[2] as string;
    if (!includeStage(stage)) {
      continue;
    }
    fieldsByStage.set(stage, unique([...(fieldsByStage.get(stage) ?? []), field]));
  }
  return fieldsByStage;
}

interface DeclarativeRenderBuild {
  profile?: ProgramEntry['renderProfile'];
  resultFieldsByStage: ReadonlyMap<string, readonly string[]>;
  schemaPaths: Readonly<Record<string, string>>;
  derivedPathRules: readonly MutableRecord[];
}

function buildPdfReportRenderProfile(exportDescriptors: readonly ExportStageDescriptor[]): DeclarativeRenderBuild {
  const pdfDescriptors = exportDescriptors.filter((descriptor) => descriptor.kind === 'export_pdf');
  if (pdfDescriptors.length === 0) {
    return {
      resultFieldsByStage: new Map(),
      schemaPaths: {},
      derivedPathRules: [],
    };
  }

  const artifacts: NonNullable<ProgramEntry['renderProfile']>['artifacts'] = pdfDescriptors.map((descriptor) => ({
    id: `${safeIdentifier(descriptor.stage)}_report`,
    format: 'html',
    page: { size: 'letter', margin_pt: 72 },
    numbering: { sections: 'decimal', clauses: 'none' },
    cover: {
      title: { from: 'config.title' },
      fields: [
        { label: { from: 'config.report.labels.purpose' }, value: { from: 'config.purpose' } },
      ],
    },
    sections: [
      {
        kind: 'section',
        heading: { from: 'config.report.sections.summary' },
        nodes: [
          { kind: 'paragraph', text: { from: 'config.purpose' } },
          {
            kind: 'clause',
            heading: { from: 'config.report.metrics.sources_reviewed' },
            body: { from: 'report.sources_reviewed' },
          },
          {
            kind: 'clause',
            heading: { from: 'config.report.metrics.total_found' },
            body: { from: 'report.total_found' },
          },
          {
            kind: 'clause',
            heading: { from: 'config.report.metrics.leads_carried_forward' },
            body: { from: 'report.leads_carried_forward' },
          },
          {
            kind: 'clause',
            heading: { from: 'config.report.metrics.guard_audit_entries' },
            body: { from: 'report.guard_audit_entries' },
          },
          {
            kind: 'clause',
            heading: { from: 'config.report.metrics.refused_or_skipped' },
            body: { from: 'report.refused_or_skipped_count' },
          },
        ],
      },
      {
        kind: 'section',
        heading: { from: 'config.report.sections.per_source' },
        nodes: [
          {
            kind: 'table',
            columns: [
              { header: { from: 'config.report.columns.source' }, field: 'source' },
              { header: { from: 'config.report.columns.found' }, field: 'found' },
              { header: { from: 'config.report.columns.pages_visited' }, field: 'pages_visited' },
            ],
            rows: { from: 'aggregate.result.per_source' },
          },
        ],
      },
      {
        kind: 'section',
        heading: { from: 'config.report.sections.leads' },
        nodes: [
          {
            kind: 'table',
            columns: [
              { header: { from: 'config.report.columns.name' }, field: 'name' },
              { header: { from: 'config.report.columns.company' }, field: 'company' },
              { header: { from: 'config.report.columns.email' }, field: 'email' },
              { header: { from: 'config.report.columns.status' }, field: 'status' },
            ],
            rows: { from: 'persist.result.new_vs_existing' },
          },
        ],
      },
      {
        kind: 'section',
        heading: { from: 'config.report.sections.guard_audit_summary' },
        nodes: [
          {
            kind: 'table',
            columns: [
              { header: { from: 'config.report.columns.action' }, field: 'action' },
              { header: { from: 'config.report.columns.url' }, field: 'url' },
              { header: { from: 'config.report.columns.reason' }, field: 'reason' },
            ],
            rows: { from: 'aggregate.result.audit' },
          },
        ],
      },
    ],
  }));

  return {
    profile: { artifacts },
    resultFieldsByStage: new Map([
      ['aggregate', ['per_source', 'leads', 'audit']],
      ['persist', ['new_vs_existing']],
    ]),
    schemaPaths: pdfReportRenderSchemaPaths(),
    derivedPathRules: pdfReportRenderDerivedPathRules(),
  };
}

function pdfReportRenderSchemaPaths(): Record<string, string> {
  return {
    'config.title': 'string',
    'config.purpose': 'string',
    'config.report.labels.purpose': 'string',
    'config.report.sections.summary': 'string',
    'config.report.sections.per_source': 'string',
    'config.report.sections.leads': 'string',
    'config.report.sections.guard_audit_summary': 'string',
    'config.report.metrics.sources_reviewed': 'string',
    'config.report.metrics.total_found': 'string',
    'config.report.metrics.leads_carried_forward': 'string',
    'config.report.metrics.guard_audit_entries': 'string',
    'config.report.metrics.refused_or_skipped': 'string',
    'config.report.columns.source': 'string',
    'config.report.columns.found': 'string',
    'config.report.columns.pages_visited': 'string',
    'config.report.columns.name': 'string',
    'config.report.columns.company': 'string',
    'config.report.columns.email': 'string',
    'config.report.columns.status': 'string',
    'config.report.columns.action': 'string',
    'config.report.columns.url': 'string',
    'config.report.columns.reason': 'string',
    'config.report.refused_or_skipped_actions': 'array',
    'aggregate.result': 'object',
    'aggregate.result.per_source': 'array',
    'aggregate.result.per_source.*': 'object',
    'aggregate.result.per_source.*.source': 'string',
    'aggregate.result.per_source.*.found': 'number',
    'aggregate.result.per_source.*.pages_visited': 'number',
    'aggregate.result.leads': 'array',
    'aggregate.result.audit': 'array',
    'aggregate.result.audit.*': 'object',
    'aggregate.result.audit.*.action': 'string',
    'aggregate.result.audit.*.url': 'string',
    'aggregate.result.audit.*.reason': 'string',
    'persist.result': 'object',
    'persist.result.new_vs_existing': 'array',
    'persist.result.new_vs_existing.*': 'object',
    'persist.result.new_vs_existing.*.name': 'string',
    'persist.result.new_vs_existing.*.company': 'string',
    'persist.result.new_vs_existing.*.email': 'string',
    'persist.result.new_vs_existing.*.status': 'string',
    'report.sources_reviewed': 'number',
    'report.total_found': 'number',
    'report.leads_carried_forward': 'number',
    'report.guard_audit_entries': 'number',
    'report.refused_or_skipped_audit': 'array',
    'report.refused_or_skipped_count': 'number',
  };
}

function pdfReportRenderDerivedPathRules(): MutableRecord[] {
  return [
    countOfDerivedPathRule('report.sources_reviewed', 'aggregate.result.per_source'),
    {
      target: 'report.total_found',
      when: alwaysPredicate(),
      set: {
        kind: 'sum_of',
        params: {
          collection_path: 'aggregate.result.per_source',
          field: 'found',
        },
      },
    },
    countOfDerivedPathRule('report.leads_carried_forward', 'persist.result.new_vs_existing'),
    countOfDerivedPathRule('report.guard_audit_entries', 'aggregate.result.audit'),
    {
      target: 'report.refused_or_skipped_audit',
      when: alwaysPredicate(),
      set: {
        kind: 'items_where_field_in_collection',
        params: {
          collection_path: 'aggregate.result.audit',
          field: 'action',
          source_path: 'config.report.refused_or_skipped_actions',
        },
      },
    },
    countOfDerivedPathRule('report.refused_or_skipped_count', 'report.refused_or_skipped_audit'),
  ];
}

function countOfDerivedPathRule(target: string, collectionPath: string): MutableRecord {
  return {
    target,
    when: alwaysPredicate(),
    set: {
      kind: 'count_of',
      params: {
        collection_path: collectionPath,
      },
    },
  };
}

function applyRenderProfileSchemaAndDerivedPaths(
  spec: MutableRecord,
  render: DeclarativeRenderBuild,
): void {
  if (!render.profile) {
    return;
  }
  const schema = recordField(spec, 'schema');
  for (const [path, typeName] of Object.entries(render.schemaPaths)) {
    if (schema[path] === undefined) {
      schema[path] = typeName;
    }
  }
  const derivedPaths = Array.isArray(spec.derived_paths) ? spec.derived_paths as MutableRecord[] : [];
  for (const rule of render.derivedPathRules) {
    appendDerivedPathRule(derivedPaths, rule);
  }
  if (derivedPaths.length > 0) {
    spec.derived_paths = derivedPaths;
  }
}

function mergeResultFieldMaps(
  ...maps: ReadonlyArray<ReadonlyMap<string, readonly string[]>>
): Map<string, string[]> {
  const merged = new Map<string, string[]>();
  for (const map of maps) {
    for (const [stage, fields] of map) {
      merged.set(stage, unique([...(merged.get(stage) ?? []), ...fields]));
    }
  }
  return merged;
}

function domainSpecResultJsonSchema(domainSpec: StageDomainSpec | undefined): Record<string, unknown> | undefined {
  const resultJson = domainSpec?.produces.result_json;
  return resultJson && typeof resultJson === 'object' && !Array.isArray(resultJson)
    ? resultJson as Record<string, unknown>
    : undefined;
}

function domainResultSchemaTypeName(value: unknown): string {
  if (isRepeatedRecordSchema(value)) {
    return 'array';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (value && typeof value === 'object') {
    return 'object';
  }
  const declared = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (declared === 'number' || declared === 'boolean' || declared === 'string' || declared === 'object' || declared === 'array') {
    return declared;
  }
  return 'any';
}

function plainRecordColumns(record: Record<string, unknown>): string[] {
  return Object.keys(record).filter((key) => CONCRETE_VIEW_PATH_SEGMENT.test(key));
}

function titleCaseIdentifier(value: string): string {
  return value
    .split(/_+/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}

function keyedCollectionsForPersistence(
  stages: Stage[],
  stageClassificationBySlug: ReadonlyMap<string, ClassifiedStage>,
  reasoningContractsBySlug: ReadonlyMap<string, ReasoningStageContract>,
  domain: Record<string, unknown>,
): KeyedCollectionSpecDecl[] {
  if (!stages.some((stage) => stageDeclaresPersistence(stage, stageClassificationBySlug))) {
    return [];
  }
  const dedupeKey = persistenceDedupeKeyFromDomain(domain);
  if (!dedupeKey) {
    return [];
  }

  const declarations: KeyedCollectionSpecDecl[] = [];
  for (const [stage, contract] of reasoningContractsBySlug) {
    if (stageClassificationBySlug.get(stage)?.archetype !== 'llm-reasoning') {
      continue;
    }
    for (const field of contract.result_schema.fields) {
      if (
        field.type === 'record_array' &&
        field.record_fields !== undefined &&
        Object.prototype.hasOwnProperty.call(field.record_fields, dedupeKey)
      ) {
        declarations.push({
          collection: `${stage}.result.${field.name}`,
          key: dedupeKey,
        });
      }
    }
  }

  return uniqueKeyedCollections(declarations);
}

function stageDeclaresPersistence(
  stage: Stage,
  stageClassificationBySlug: ReadonlyMap<string, ClassifiedStage>,
): boolean {
  const classification = stageClassificationBySlug.get(stage.slug);
  return classification?.integration_name === 'persistence' ||
    classification?.connector_slug === 'persistence';
}

function persistenceDedupeKeyFromDomain(domain: Record<string, unknown>): string | undefined {
  const config = optionalRecord(domainValue(domain, 'config'));
  const persistence = optionalRecord(domainValue(domain, 'persistence'));
  const configPersistence = optionalRecord(config?.persistence);
  const candidates = [
    domainValue(domain, 'dedupe_key'),
    persistence?.dedupe_key,
    config?.dedupe_key,
    configPersistence?.dedupe_key,
  ];
  return candidates.find((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
}

function uniqueKeyedCollections(declarations: KeyedCollectionSpecDecl[]): KeyedCollectionSpecDecl[] {
  const seen = new Set<string>();
  const uniqueDeclarations: KeyedCollectionSpecDecl[] = [];
  for (const declaration of declarations) {
    const key = `${declaration.collection}\0${declaration.key}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueDeclarations.push(declaration);
  }
  return uniqueDeclarations;
}

function singularizeRecordLabel(name: string): string {
  if (/ies$/u.test(name)) {
    return `${name.slice(0, -3)}y`;
  }
  if (/(?:s|x|z|ch|sh)es$/u.test(name)) {
    return name.slice(0, -2);
  }
  if (/s$/u.test(name) && !/ss$/u.test(name)) {
    return name.slice(0, -1);
  }
  return name;
}

/**
 * pgas#993 / pgas-server v5.6.0: emit a REPEATABLE per-record append action for
 * every keyed/merge `record_array` reasoning field.
 *
 * A keyed/merge-collection `MAppend` upserts a SINGLE element by key (the engine
 * executor unwraps only a length-1 array; a batch array never resolves the
 * top-level key → the upsert no-ops), and v5.6.0's loader accordingly infers the
 * `from_arg` as the ELEMENT (`object`) type — rejecting the stale #825 whole-array
 * `arg_schema.type: array`. The one-shot terminal completion action can therefore
 * carry only ONE record, so multi-record extraction must be a REPEATABLE
 * element-append (each call idempotent-by-key) SEPARATE from the terminal
 * completion — exactly the engine's proven keyed drafting-loop pattern (#994 e2e).
 *
 * The keyed record_array field is removed from the terminal action's mutations /
 * arg_schema / arg_descriptions (see `actionMapEntryFor`); this adds the append
 * action to the stage's action_map + vocabulary + guidance. The generated stage
 * handler already reads the collection path as a fallback source for the field
 * (see the reasoning-stage handler's `resolveReasoningRecordField`), so appended
 * records flow into the stage output with no handler change. Non-keyed
 * record_array fields are untouched (they keep the #825 whole-array fan-out).
 */
export function applyKeyedRecordArrayAppendActions(
  actionMap: MutableRecord,
  modes: MutableRecord,
  guidance: MutableRecord,
  reasoningContractsBySlug: ReadonlyMap<string, ReasoningStageContract>,
  keyedCollections: KeyedCollectionSpecDecl[],
  transitionActionsBySource: Map<string, TransitionAction[]>,
): void {
  if (keyedCollections.length === 0) {
    return;
  }
  const keyByCollection = new Map(keyedCollections.map((decl) => [decl.collection, decl.key]));
  const keyedCollectionPaths = new Set(keyedCollections.map((decl) => decl.collection));
  for (const [stage, contract] of reasoningContractsBySlug) {
    const fields = keyedRecordArrayFieldsFor(stage, contract, keyedCollectionPaths);
    if (fields.length === 0) {
      continue;
    }
    const mode = recordField(modes, stage);
    const vocabulary = Array.isArray(mode.vocabulary) ? mode.vocabulary as string[] : [];
    const completionActionNames = (transitionActionsBySource.get(stage) ?? []).map((action) => action.name);
    const completionClause = completionActionNames.length > 0
      ? completionActionNames.join(' or ')
      : 'the stage completion action';
    const appendNames: string[] = [];
    for (const field of fields) {
      const collection = `${stage}.result.${field.name}`;
      const key = keyByCollection.get(collection) ?? '';
      const actionName = keyedRecordArrayAppendActionName(stage, field.name);
      const label = singularizeRecordLabel(field.name);
      const recordFields = JSON.stringify(field.record_fields ?? {});
      actionMap[actionName] = {
        description:
          `Append ONE ${label} record to ${collection}; it is upserted by ${key} (re-appending the same ${key} REPLACES that record, never duplicates). ` +
          `Call once per ${label}, then call ${completionClause} to record the summary fields and advance. ${field.description}`,
        arg_descriptions: {
          [field.name]: `A single ${label} record (object) with fields: ${recordFields}. Provide exactly ONE record per call; it is upserted into ${collection} by ${key}.`,
        },
        arg_schema: {
          [field.name]: { type: 'object', required: true },
        },
        mutations: [
          { op: 'MAppend', path: collection, value: {}, from_arg: field.name },
        ],
        // widget_output: a declarative model-callable channel that applies the
        // action's mutations WITHOUT requiring a synchronous stage handler (the
        // same channel the confirmation-loop propose action uses). stage_output
        // is synchronous and would demand a handler for a pure-mutation upsert.
        channel: 'widget_output',
      };
      appendNames.push(actionName);
    }
    mode.vocabulary = unique([...vocabulary, ...appendNames]);
    const fieldClause = fields
      .map((field) => {
        const collection = `${stage}.result.${field.name}`;
        const label = singularizeRecordLabel(field.name);
        return `call ${keyedRecordArrayAppendActionName(stage, field.name)} once for EACH ${label} (each upserted into ${collection} by ${keyByCollection.get(collection) ?? ''}, so re-appending a ${label} is idempotent)`;
      })
      .join('; and ');
    const existing = Array.isArray(guidance[stage]) ? guidance[stage] as string[] : [];
    guidance[stage] = [
      ...existing,
      `Record each extracted record one at a time: ${fieldClause}. Emit ONE append action per response and repeat until every record is appended; then call ${completionClause} exactly once to record the remaining summary fields and advance. Do not attempt to pass the whole batch as an array — each keyed record is appended individually.`,
    ];
  }
}

function applyStageOutputMirrorDerivedPaths(
  spec: MutableRecord,
  intermediateModes: string[],
  mirrorStages: ReadonlySet<string>,
): void {
  const derivedPaths = Array.isArray(spec.derived_paths) ? spec.derived_paths as MutableRecord[] : [];
  for (const modeName of intermediateModes) {
    if (!mirrorStages.has(modeName)) {
      continue;
    }
    appendFieldValueDerivedPathRule(
      derivedPaths,
      `${modeName}.result_json`,
      `${modeName}.output.result_json`,
    );
    appendFieldValueDerivedPathRule(
      derivedPaths,
      `${modeName}.items_json`,
      `${modeName}.output.items_json`,
    );
  }
  if (derivedPaths.length > 0) {
    spec.derived_paths = derivedPaths;
  }
}

function applyStageOutputMirrorReactions(
  reactions: MutableRecord,
  intermediateModes: string[],
  mirrorStages: ReadonlySet<string>,
  stageResultFieldsBySlug: ReadonlyMap<string, readonly string[]>,
): void {
  for (const modeName of intermediateModes) {
    if (!mirrorStages.has(modeName)) {
      continue;
    }
    const resultFields = stageResultFieldsBySlug.get(modeName) ?? [];
    if (resultFields.length === 0) {
      continue;
    }
    reactions[stageResultFieldMirrorReactionName(modeName)] = {
      event: 'AfterRound',
      write_scope: resultFields.map((field) => `${modeName}.result.${field}`),
    };
  }
}

function applyReasoningFieldMirrorReactions(
  reactions: MutableRecord,
  reasoningContractsBySlug: ReadonlyMap<string, ReasoningStageContract>,
): void {
  for (const [stage, contract] of reasoningContractsBySlug) {
    const mirroredFields = contract.result_schema.fields.filter((field) => field.type !== 'record_array');
    if (mirroredFields.length === 0) {
      continue;
    }
    reactions[reasoningFieldMirrorReactionName(stage)] = {
      event: 'AfterMutation',
      watch: unique([
        `${stage}.output`,
        `${stage}.raw_result_json`,
        ...mirroredFields.map((field) => `${stage}.raw_result_fields.${field.name}`),
      ]),
      write_scope: mirroredFields.map((field) => `${stage}.result.${field.name}`),
    };
  }
}

function stageResultFieldMirrorReactionName(stage: string): string {
  return `mirror_${safeIdentifier(stage)}_result_fields`;
}

function reasoningFieldMirrorReactionName(stage: string): string {
  return `mirror_${safeIdentifier(stage)}_result_fields`;
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
        ...(descriptor.storage.representation === 'indexed_array'
          ? [
              collectionLifecycleTerminalStatusItemsPath(descriptor.storage.items_path),
              `${descriptor.storage.items_path}.*.${descriptor.item.status_field}`,
              `${descriptor.storage.items_path}.*.${DERIVED_TERMINAL_FIELD}`,
            ]
          : [descriptor.storage.items_path]),
        descriptor.storage.event_path,
        descriptor.storage.violation_path,
      ],
    };
  }
  if (descriptor.storage.representation !== 'indexed_array') {
    reactions[collectionLifecycleReactionName(descriptor)] = {
      event: hasLlmTransitions ? 'AfterRound' : 'AfterMutation',
      ...(hasLlmTransitions ? {} : { watch: [descriptor.storage.items_path] }),
      write_scope: [descriptor.aggregate.guard_field],
    };
  }
}

function applyCollectionCompletionDerivedPaths(
  spec: MutableRecord,
  descriptor: CollectionLifecycleDescriptor | undefined,
  loops: ConfirmationLoopDescriptor[],
): void {
  const derivedPaths = Array.isArray(spec.derived_paths) ? spec.derived_paths as MutableRecord[] : [];
  if (descriptor?.storage.representation === 'indexed_array') {
    const terminalItemsPath = collectionLifecycleTerminalStatusItemsPath(descriptor.storage.items_path);
    appendFieldEqualityDerivedPathRule(
      derivedPaths,
      descriptor.aggregate.guard_field,
      'all_items_field_eq',
      terminalItemsPath,
      DERIVED_TERMINAL_STATUS_FIELD,
      true,
    );
    for (const numericSum of descriptor.aggregate.numeric_sums ?? []) {
      appendDerivedPathRule(derivedPaths, {
        target: numericSum.target,
        when: alwaysPredicate(),
        set: {
          kind: 'sum_of',
          params: {
            collection_path: descriptor.storage.items_path,
            field: numericSum.field,
          },
        },
      });
    }
  }
  if (descriptor) {
    for (const loop of loops) {
      if (loop.collection !== descriptor.storage.items_path) {
        continue;
      }
      appendFieldEqualityDerivedPathRule(
        derivedPaths,
        confirmationLoopHasProposedItemPath(loop),
        'any_item_field_eq',
        loop.collection,
        descriptor.item.status_field,
        loop.proposed_status,
      );
      for (const status of descriptor.statuses) {
        appendFieldEqualityDerivedPathRule(
          derivedPaths,
          confirmationLoopStatusBucketPath(loop, status.name),
          'items_where_field_eq',
          loop.collection,
          descriptor.item.status_field,
          status.name,
        );
      }
      appendDerivedPathRule(derivedPaths, {
        target: confirmationLoopActiveItemIdPath(loop),
        when: alwaysPredicate(),
        set: {
          kind: 'first_item_where_field_ne',
          params: {
            collection_path: collectionLifecycleTerminalStatusItemsPath(loop.collection),
            field: DERIVED_TERMINAL_STATUS_FIELD,
            value: true,
            order: { kind: 'plan_array' },
          },
        },
      });
    }
  }
  if (derivedPaths.length > 0) {
    spec.derived_paths = derivedPaths;
  } else {
    delete spec.derived_paths;
  }
}

function appendFieldEqualityDerivedPathRule(
  derivedPaths: MutableRecord[],
  target: string,
  kind: 'all_items_field_eq' | 'any_item_field_eq' | 'items_where_field_eq',
  collectionPath: string,
  field: string,
  value: unknown,
): void {
  appendDerivedPathRule(derivedPaths, {
    target,
    when: alwaysPredicate(),
    set: {
      kind,
      params: {
        collection_path: collectionPath,
        field,
        value,
      },
    },
  });
}

function appendFieldValueDerivedPathRule(
  derivedPaths: MutableRecord[],
  target: string,
  sourcePath: string,
): void {
  appendDerivedPathRule(derivedPaths, {
    target,
    when: { kind: 'FieldTruthy', path: sourcePath },
    set: {
      kind: 'field_value',
      params: { path: sourcePath },
    },
  });
}

function appendDerivedPathRule(derivedPaths: MutableRecord[], rule: MutableRecord): void {
  if (!derivedPaths.some((candidate) => candidate.target === rule.target)) {
    derivedPaths.push(rule);
  }
}

function collectionLifecycleTerminalStatusItemsPath(itemsPath: string): string {
  const parts = itemsPath.split('.').filter((part) => part.length > 0);
  const leaf = parts.pop() ?? 'items';
  return [...parts, `${leaf}_terminal_status`].join('.');
}

function collectionLifecycleTerminalStatusPredicate(itemsPath: string): MutableRecord {
  return {
    kind: 'AllItemsStatus',
    path: collectionLifecycleTerminalStatusItemsPath(itemsPath),
    value: true,
  };
}

function collectionLifecycleTerminalStatusItems(
  items: unknown[],
  descriptor: CollectionLifecycleDescriptor,
): Array<Record<string, unknown>> {
  return items.map((item, index) => {
    const record = item && typeof item === 'object' && !Array.isArray(item)
      ? item as Record<string, unknown>
      : {};
    const id = typeof record[descriptor.item.id_field] === 'string'
      ? record[descriptor.item.id_field]
      : String(index);
    return {
      id,
      [DERIVED_TERMINAL_STATUS_FIELD]: record[DERIVED_TERMINAL_FIELD] === true ||
        descriptor.aggregate.terminal_statuses.includes(String(record[descriptor.item.status_field] ?? '')),
    };
  });
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
    schema[`${descriptor.storage.items_path}.*.${DERIVED_TERMINAL_FIELD}`] = 'boolean';
    const terminalItemsPath = collectionLifecycleTerminalStatusItemsPath(descriptor.storage.items_path);
    schema[terminalItemsPath] = 'array';
    schema[`${terminalItemsPath}.*`] = 'object';
    schema[`${terminalItemsPath}.*.id`] = 'string';
    schema[`${terminalItemsPath}.*.${DERIVED_TERMINAL_STATUS_FIELD}`] = 'boolean';
  } else {
    schema[descriptor.storage.items_path] = 'string';
  }
  schema[descriptor.storage.event_path] = 'string';
  schema[descriptor.storage.violation_path] = 'string';
  schema[descriptor.aggregate.guard_field] = 'boolean';
  for (const numericSum of descriptor.aggregate.numeric_sums ?? []) {
    schema[numericSum.target] = 'number';
  }
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
  documents?: DocumentsDescriptor,
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
    schema[`${base}.request`] = 'object';
    const fanOut = documentFanOutDescriptor(child, documents);
    if (fanOut) {
      const indexPath = fanOut.index_path ?? `${child.stage}.fan_out.index`;
      schema[indexPath] = 'number';
      schema[fanOut.completion_guard] = 'boolean';
      schema[fanOut.result_path] = 'object';
      schema[`${fanOut.result_path}.*`] = 'object';
      schema[`${fanOut.result_path}.*.document_id`] = 'string';
      schema[`${fanOut.result_path}.*.document_name`] = 'string';
      schema[`${fanOut.result_path}.*.source_index`] = 'number';
      schema[`${fanOut.result_path}.*.status`] = 'string';
      schema[`${fanOut.result_path}.*.sessionId`] = 'string';
      schema[`${fanOut.result_path}.*.rounds`] = 'number';
      schema[`${fanOut.result_path}.*.mode`] = 'string';
      schema[`${fanOut.result_path}.*.reason`] = 'string';
      schema[`${fanOut.result_path}.*.optional`] = 'boolean';
      schema[`${fanOut.result_path}.*.result`] = 'object';
      for (const [field, type] of delegationResultFields(child)) {
        schema[`${fanOut.result_path}.*.${field}`] = type;
      }
    }
    const sourceFanOut = sourceConfigFanOutDescriptor(child);
    if (sourceFanOut) {
      const indexPath = sourceFanOut.index_path ?? `${child.stage}.fan_out.index`;
      schema[indexPath] = 'number';
      schema[sourceFanOut.completion_guard] = 'boolean';
      schema[LEAD_RESEARCH_SOURCE_FAN_OUT_SOURCE_PATH] = 'array';
      schema[`${LEAD_RESEARCH_SOURCE_FAN_OUT_SOURCE_PATH}.*`] = 'object';
      schema[`${LEAD_RESEARCH_SOURCE_FAN_OUT_SOURCE_PATH}.*.url`] = 'string';
      schema[`${LEAD_RESEARCH_SOURCE_FAN_OUT_SOURCE_PATH}.*.allowed_domains`] = 'array';
      schema[sourceFanOut.current_document] = 'object';
      schema[`${sourceFanOut.current_document}.url`] = 'string';
      schema[`${sourceFanOut.current_document}.allowed_domains`] = 'array';
      schema[`${sourceFanOut.current_document}.source_index`] = 'number';
      schema[sourceFanOut.result_path] = 'array';
      schema[`${sourceFanOut.result_path}.*`] = 'object';
      schema[`${sourceFanOut.result_path}.*.source`] = 'string';
      schema[`${sourceFanOut.result_path}.*.source_index`] = 'number';
      schema[`${sourceFanOut.result_path}.*.status`] = 'string';
      schema[`${sourceFanOut.result_path}.*.items`] = 'array';
      schema[`${sourceFanOut.result_path}.*.pages_visited`] = 'number';
      schema[`${sourceFanOut.result_path}.*.audit`] = 'array';
      schema[`${sourceFanOut.result_path}.*.degraded`] = 'boolean';
      schema[`${sourceFanOut.result_path}.*.reason`] = 'string';
      schema['work.persist.new_vs_existing'] = 'array';
      schema['work.persist.new_vs_existing.*'] = 'object';
      schema['work.audit'] = 'array';
      schema['work.audit.*'] = 'object';
    }
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

function applyRegisteredToolSchema(
  schema: MutableRecord,
  tools: RegisteredToolDescriptor[],
): void {
  for (const tool of tools) {
    declareObjectPath(schema, tool.result_path);
  }
}

function declareObjectPath(schema: MutableRecord, path: string): void {
  const segments = path.split('.');
  for (let index = 1; index <= segments.length; index += 1) {
    const currentPath = segments.slice(0, index).join('.');
    if (schema[currentPath] === undefined) {
      schema[currentPath] = 'object';
    }
  }
}

function applyDelegationActions(
  actionMap: MutableRecord,
  children: DelegationChildDescriptor[],
): void {
  for (const child of children) {
    const actionName = delegationRequestActionName(child);
    const manifestReused = isManifestReusedDelegationChild(child);
    if (Object.prototype.hasOwnProperty.call(actionMap, actionName)) {
      throw new Error(`delegation request action collides with generated action_map: ${actionName}`);
    }
    actionMap[actionName] = {
      channel: delegationChannelName(child),
      result_path: child.result_path,
      mutations: [
        { op: 'MSet', path: `${delegationStateBase(child)}.requested`, value: true },
        // Keep the parent-state request slot and from_arg marker for the delegation
        // action contract (#901). Synthesized children still receive an author
        // request arg; manifest-reused children rely only on inputEnrichment.
        manifestReused
          ? {
            op: 'MSet',
            path: `${delegationStateBase(child)}.request`,
            value: { source: 'delegationPolicy.inputEnrichment' },
            from_arg: 'request',
          }
          : { op: 'MSet', path: `${delegationStateBase(child)}.request`, value: {}, from_arg: 'request' },
      ],
      description: manifestReused
        ? `Dispatch the ${child.id} manifest-reused child program and wait for the routed delegation result; delegationPolicy.inputEnrichment supplies the child inputs.`
        : `Dispatch the ${child.id} child program and wait for the routed delegation result.`,
      ...(manifestReused ? {} : { arg_descriptions: {
        request: 'Object with the request for the child. Emit the action payload as { request: { ... } }; do not put request fields directly under payload.',
      } }),
    };
  }
}

function applySourceConfigFanOutInitialization(
  actionMap: MutableRecord,
  children: DelegationChildDescriptor[],
  domain: Record<string, unknown>,
): void {
  if (!children.some(childHasSourceConfigFanOut)) {
    return;
  }
  const beginWork = actionMap.begin_work;
  if (!beginWork || typeof beginWork !== 'object' || Array.isArray(beginWork)) {
    return;
  }
  const beginWorkAction = beginWork as MutableRecord;
  const mutations = Array.isArray(beginWorkAction.mutations)
    ? beginWorkAction.mutations as MutableRecord[]
    : [];
  const sources = webNavigationSourcesForDomain(domain).map((source, index) => ({
    ...source,
    source_index: index,
  }));
  const firstSource = sources[0];
  for (const [index, source] of sources.entries()) {
    const path = `${LEAD_RESEARCH_SOURCE_FAN_OUT_SOURCE_PATH}.${String(index)}`;
    if (!mutations.some((mutation) => mutation.path === path)) {
      mutations.push({ op: 'MSet', path, value: source });
    }
  }
  if (firstSource && !mutations.some((mutation) => mutation.path === LEAD_RESEARCH_SOURCE_FAN_OUT_CURRENT_PATH)) {
    mutations.push({ op: 'MSet', path: LEAD_RESEARCH_SOURCE_FAN_OUT_CURRENT_PATH, value: firstSource });
  }
  if (firstSource && !mutations.some((mutation) => mutation.path === `${LEAD_RESEARCH_SOURCE_FAN_OUT_CURRENT_PATH}.url`)) {
    mutations.push({ op: 'MSet', path: `${LEAD_RESEARCH_SOURCE_FAN_OUT_CURRENT_PATH}.url`, value: firstSource.url });
  }
  if (firstSource && !mutations.some((mutation) => mutation.path === `${LEAD_RESEARCH_SOURCE_FAN_OUT_CURRENT_PATH}.source_index`)) {
    mutations.push({ op: 'MSet', path: `${LEAD_RESEARCH_SOURCE_FAN_OUT_CURRENT_PATH}.source_index`, value: 0 });
  }
  for (const child of children.filter(childHasSourceConfigFanOut)) {
    const fanOut = sourceConfigFanOutDescriptor(child);
    if (!fanOut) {
      continue;
    }
    const indexPath = fanOut.index_path ?? `${child.stage}.fan_out.index`;
    if (!mutations.some((mutation) => mutation.path === indexPath)) {
      mutations.push({ op: 'MSet', path: indexPath, value: 0 });
    }
    if (!mutations.some((mutation) => mutation.path === fanOut.completion_guard)) {
      mutations.push({ op: 'MSet', path: fanOut.completion_guard, value: false });
    }
  }
  beginWorkAction.mutations = mutations;
}

function applyDelegationActionPreconditions(
  modes: MutableRecord,
  children: DelegationChildDescriptor[],
  transitionActionsBySource: Map<string, TransitionAction[]>,
  documents?: DocumentsDescriptor,
): void {
  for (const child of children) {
    const mode = recordField(modes, child.stage);
    const fanOut = delegationFanOutDescriptor(child, documents);
    if (!isAdHocDelegationChild(child)) {
      appendModePrecondition(
        mode,
        delegationRequestActionName(child),
        { kind: 'FieldFalsy', path: `${delegationStateBase(child)}.requested` },
      );
    }
    if (documents && isDocumentIngestUploadDelegationChild(child, documents)) {
      appendModePrecondition(
        mode,
        delegationRequestActionName(child),
        { kind: 'FieldTruthy', path: documentsSourceReadyPath(documents) },
      );
    }
    if (fanOut) {
      appendModePrecondition(
        mode,
        delegationRequestActionName(child),
        { kind: 'FieldFalsy', path: fanOut.completion_guard },
      );
    }
    if (isAdHocDelegationChild(child)) {
      continue;
    }
    for (const action of transitionActionsBySource.get(child.stage) ?? []) {
      appendModePrecondition(
        mode,
        action.name,
        { kind: 'FieldTruthy', path: fanOut?.completion_guard ?? `${delegationStateBase(child)}.settled` },
      );
    }
  }
}

function applyDelegationSettleFlagDerivedPaths(
  spec: MutableRecord,
  children: DelegationChildDescriptor[],
  documents?: DocumentsDescriptor,
): void {
  const derivedPaths = Array.isArray(spec.derived_paths) ? spec.derived_paths as MutableRecord[] : [];
  for (const child of children) {
    if (!delegationSettleFlagsAreDeclarative(child, documents)) {
      continue;
    }
    const base = delegationStateBase(child);
    const statusPath = `${child.result_path}.status`;
    const terminalPredicate = delegationTerminalStatusPredicate(statusPath);
    appendDerivedPathRule(derivedPaths, {
      target: `${base}.settled`,
      when: terminalPredicate,
      set: {
        kind: 'from_predicate',
        params: { predicate: terminalPredicate },
      },
    });
    appendDerivedPathRule(derivedPaths, {
      target: `${base}.degraded`,
      when: terminalPredicate,
      set: {
        kind: 'from_predicate',
        params: {
          predicate: delegationDegradedStatusPredicate(statusPath),
        },
      },
    });
  }
  if (derivedPaths.length > 0) {
    spec.derived_paths = derivedPaths;
  }
}

function delegationSettleFlagsAreDeclarative(
  child: DelegationChildDescriptor,
  documents?: DocumentsDescriptor,
): boolean {
  return !documentFanOutDescriptor(child, documents) &&
    !sourceConfigFanOutDescriptor(child) &&
    !(documents && isDocumentIngestUploadDelegationChild(child, documents));
}

function delegationTerminalStatusPredicate(statusPath: string): MutableRecord {
  return anyPredicates([
    { kind: 'FieldEquals', path: statusPath, value: 'complete' },
    { kind: 'FieldEquals', path: statusPath, value: 'failed' },
    { kind: 'FieldEquals', path: statusPath, value: 'declined' },
  ]);
}

function delegationDegradedStatusPredicate(statusPath: string): MutableRecord {
  return anyPredicates([
    { kind: 'FieldEquals', path: statusPath, value: 'failed' },
    { kind: 'FieldEquals', path: statusPath, value: 'declined' },
  ]);
}

function applyDelegationReactions(
  reactions: MutableRecord,
  children: DelegationChildDescriptor[],
  documents?: DocumentsDescriptor,
): void {
  for (const child of children) {
    const fanOut = documentFanOutDescriptor(child, documents);
    if (fanOut) {
      const base = delegationStateBase(child);
      reactions[documentFanOutAdvanceReactionName(child)] = {
        event: 'AfterRound',
        watch: [],
        write_scope: [
          fanOut.index_path ?? `${child.stage}.fan_out.index`,
          fanOut.completion_guard,
          `${fanOut.result_path}.*`,
          `${base}.settled`,
          `${base}.degraded`,
          `${base}.degrade_reason`,
          `${base}.requested`,
          fanOut.current_document,
          `${fanOut.current_document}.id`,
          `${fanOut.current_document}.name`,
          `${fanOut.current_document}.mime_type`,
          `${fanOut.current_document}.size`,
          `${fanOut.current_document}.text`,
          `${fanOut.current_document}.char_count`,
          `${fanOut.current_document}.source_index`,
          `${fanOut.current_document}.extraction_kind`,
          `${fanOut.current_document}.provenance`,
          `${fanOut.current_document}.provenance.file_id`,
          `${fanOut.current_document}.provenance.name`,
          `${fanOut.current_document}.provenance.mime_type`,
          `${fanOut.current_document}.provenance.size`,
          `${fanOut.current_document}.provenance.source_index`,
        ],
      };
      continue;
    }
    const sourceFanOut = sourceConfigFanOutDescriptor(child);
    if (sourceFanOut) {
      const base = delegationStateBase(child);
      reactions[sourceConfigFanOutAdvanceReactionName(child)] = {
        event: 'AfterRound',
        watch: [],
        write_scope: [
          sourceFanOut.source,
          sourceFanOut.index_path ?? `${child.stage}.fan_out.index`,
          sourceFanOut.completion_guard,
          `${sourceFanOut.result_path}.*`,
          `${base}.settled`,
          `${base}.degraded`,
          `${base}.degrade_reason`,
          `${base}.requested`,
          sourceFanOut.current_document,
          `${sourceFanOut.current_document}.url`,
          `${sourceFanOut.current_document}.allowed_domains`,
          `${sourceFanOut.current_document}.source_index`,
        ],
      };
      continue;
    }
    if (!documents || !isDocumentIngestUploadDelegationChild(child, documents)) {
      continue;
    }
    const base = delegationStateBase(child);
    reactions[delegationSettleReactionName(child)] = {
      event: 'AfterRound',
      watch: [],
      write_scope: [
        `${base}.settled`,
        `${base}.degraded`,
        `${base}.degrade_reason`,
        ...documentIngestHarvestWriteScope(documents),
      ],
    };
  }
}

function applyLeadResearchHostOutputMirrorReactions(
  reactions: MutableRecord,
  children: DelegationChildDescriptor[],
): void {
  if (!children.some(childHasSourceConfigFanOut)) {
    return;
  }
  reactions.mirror_lead_research_host_outputs = {
    event: 'AfterRound',
    watch: [],
    write_scope: [
      'work.persist.new_vs_existing.*',
      'work.audit.*',
    ],
  };
}

function documentIngestHarvestWriteScope(documents: DocumentsDescriptor): string[] {
  return [
    `${documents.result_path}.summary`,
    `${documents.result_path}.sections`,
    `${documents.result_path}.sections.*`,
    `${documents.result_path}.sections.*.id`,
    `${documents.result_path}.sections.*.heading`,
    `${documents.result_path}.sections.*.status`,
    `${documents.result_path}.sections.*.text`,
    documentsIngestResultHarvestedPath(documents),
  ];
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
  documents?: DocumentsDescriptor,
): void {
  for (const child of children) {
    const hostIndex = modeNames.indexOf(child.stage);
    const fanOut = documentFanOutDescriptor(child, documents);
    const sourceFanOut = sourceConfigFanOutDescriptor(child);
    const resultPaths = delegationResultProjectionPaths(child);
    const fanOutPaths = delegationFanOutProjectionPaths(child, documents);
    const hostPaths = [
      ...resultPaths,
      ...fanOutPaths,
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
    const downstreamDelegationPaths = fanOut || sourceFanOut ? [] : resultPaths;
    const downstreamFanOutPaths = sourceFanOut ? sourceConfigFanOutProjectionPaths(child) : [];
    for (const modeName of modeNames.slice(Math.max(hostIndex + 1, 0))) {
      const downstreamProjection = recordField(projection, modeName);
      const include = Array.isArray(downstreamProjection.include) ? downstreamProjection.include as string[] : [];
      downstreamProjection.include = unique([...include, ...downstreamDelegationPaths, ...downstreamFanOutPaths]);
      if (!Array.isArray(downstreamProjection.exclude)) {
        downstreamProjection.exclude = [];
      }
    }
  }
}

function applyRegisteredToolProjection(
  projection: MutableRecord,
  tools: RegisteredToolDescriptor[],
): void {
  for (const tool of tools) {
    for (const modeName of tool.modes) {
      const modeProjection = recordField(projection, modeName);
      const include = Array.isArray(modeProjection.include) ? modeProjection.include as string[] : [];
      modeProjection.include = unique([...include, tool.result_path]);
      if (!Array.isArray(modeProjection.exclude)) {
        modeProjection.exclude = [];
      }
    }
  }
}

function collectHubSectionArtifactProjections(
  stages: Stage[],
  stageClassificationBySlug: ReadonlyMap<string, ClassifiedStage>,
): HubSectionArtifactProjection[] {
  const projections: HubSectionArtifactProjection[] = [];
  for (const stage of stages) {
    if (
      !stage.domain_spec ||
      stageClassificationBySlug.get(stage.slug)?.archetype !== 'conversational-hub'
    ) {
      continue;
    }
    const reads = new Set(stage.domain_spec.reads);
    const sectionFieldsByPath = new Map<string, Set<string>>();
    for (const readPath of reads) {
      const match = /^(.+\.sections)\.\*\.(id|heading|status|text)$/u.exec(readPath);
      if (!match) {
        continue;
      }
      const sectionsPath = match[1] as string;
      const field = match[2] as string;
      sectionFieldsByPath.set(sectionsPath, new Set([...(sectionFieldsByPath.get(sectionsPath) ?? []), field]));
    }
    for (const [sectionsPath, fields] of sectionFieldsByPath) {
      const documentPath = sectionsPath.replace(/\.sections$/u, '');
      const summaryPath = `${documentPath}.summary`;
      if (
        !reads.has(summaryPath) ||
        !['id', 'heading', 'status', 'text'].every((field) => fields.has(field))
      ) {
        continue;
      }
      projections.push({
        stage: stage.slug,
        summaryPath,
        sectionsPath,
        indexPaths: [
          `${sectionsPath}.*.id`,
          `${sectionsPath}.*.heading`,
          `${sectionsPath}.*.status`,
        ],
        textPath: `${sectionsPath}.*.text`,
      });
    }
  }
  return projections;
}

function applyHubSectionArtifactProjection(
  projection: MutableRecord,
  sectionArtifacts: HubSectionArtifactProjection[],
): void {
  for (const artifact of sectionArtifacts) {
    const modeProjection = recordField(projection, artifact.stage);
    const include = Array.isArray(modeProjection.include) ? modeProjection.include as string[] : [];
    modeProjection.include = unique([
      ...include.filter((path) =>
        path !== artifact.sectionsPath &&
        path !== `${artifact.sectionsPath}.*` &&
        path !== artifact.textPath),
      artifact.summaryPath,
      ...artifact.indexPaths,
    ]);
    const exclude = Array.isArray(modeProjection.exclude) ? modeProjection.exclude as string[] : [];
    modeProjection.exclude = unique([...exclude, artifact.textPath]);
  }
}

function applyHubSectionArtifactSchema(
  schema: MutableRecord,
  sectionArtifacts: HubSectionArtifactProjection[],
): void {
  for (const artifact of sectionArtifacts) {
    schema[artifact.summaryPath] = 'string';
    schema[artifact.sectionsPath] = 'object';
    schema[`${artifact.sectionsPath}.*`] = 'object';
    for (const path of [...artifact.indexPaths, artifact.textPath]) {
      schema[path] = 'string';
    }
  }
}

function applyDelegationPrompts(
  prompts: MutableRecord,
  children: DelegationChildDescriptor[],
  documents?: DocumentsDescriptor,
): void {
  for (const child of children) {
    const existing = typeof prompts[child.stage] === 'string' ? `${prompts[child.stage]}\n` : '';
    const fanOut = documentFanOutDescriptor(child, documents);
    const sourceFanOut = sourceConfigFanOutDescriptor(child);
    const uploadDocuments = documents && isDocumentIngestUploadDelegationChild(child, documents)
      ? documents
      : undefined;
    const requestAction = delegationRequestActionName(child);
    const terminalInstruction = terminalActionInstruction([{ name: requestAction, channel: delegationChannelName(child) }]);
    const requestShape = isManifestReusedDelegationChild(child)
      ? ''
      : ` Use payload shape { request: { ... } }: put child request fields inside payload.request, not directly under payload.`;
    if (isAdHocDelegationChild(child)) {
      prompts[child.stage] = `${existing}Call ${requestAction} as an ad-hoc delegation tool when the current conversation needs ${child.id} work.${requestShape} The runtime records the child result under ${child.result_path} and keeps the conversation in ${child.stage}.`;
      continue;
    }
    prompts[child.stage] = fanOut
      ? `${existing}${terminalInstruction}\nFor each uploaded document, call ${requestAction} once for ${fanOut.current_document}.${requestShape} The runtime records each child result under ${fanOut.result_path} and advances ${fanOut.current_document}. When ${fanOut.completion_guard} is true, proceed via the normal transition action.`
      : sourceFanOut
        ? `${existing}${terminalInstruction}\nFor each configured source in ${sourceFanOut.source}, call ${requestAction} once for ${sourceFanOut.current_document}.${requestShape} The runtime records each bounded navigation result under ${sourceFanOut.result_path} and advances ${sourceFanOut.current_document}. When ${sourceFanOut.completion_guard} is true, proceed via the normal transition action.`
      : uploadDocuments
        ? `${existing}${terminalInstruction}\nAfter ${DOCUMENT_INGEST_ACTION} sets ${documentsSourceReadyPath(uploadDocuments)}, call ${requestAction} once with an empty object payload. delegationPolicy.inputEnrichment supplies ${documentsCollectionPath(uploadDocuments)} and ${documentsExtractionContractPath(uploadDocuments)} to the child. When ${delegationStateBase(child)}.settled is true, use the normal transition action; the reaction harvests summary and sections into ${uploadDocuments.result_path}.`
        : isManifestReusedDelegationChild(child)
          ? `${existing}${terminalInstruction}\nCall ${requestAction} once with an empty object payload. The manifest delegationPolicy.inputEnrichment supplies the child inputs. When ${delegationStateBase(child)}.settled is true, proceed via the normal transition action. If ${delegationStateBase(child)}.degraded is true, proceed and note the degradation.`
          : `${existing}${terminalInstruction}\nCall ${requestAction} once with a request object that includes a short topic or query string.${requestShape} When ${delegationStateBase(child)}.settled is true, proceed via the normal transition action. If ${delegationStateBase(child)}.degraded is true, proceed and note the degradation.`;
  }
}

function applyRegisteredToolPrompts(
  prompts: MutableRecord,
  tools: RegisteredToolDescriptor[],
): void {
  for (const tool of tools) {
    for (const modeName of tool.modes) {
      const existing = typeof prompts[modeName] === 'string' ? `${prompts[modeName]}\n` : '';
      prompts[modeName] = `${existing}Use ${tool.name} when the conversation needs ${tool.description.toLowerCase()} The result is recorded at ${tool.result_path}.`;
    }
  }
}

function applyDelegationGuidance(
  guidance: MutableRecord,
  children: DelegationChildDescriptor[],
  documents?: DocumentsDescriptor,
): void {
  for (const child of children) {
    const existing = Array.isArray(guidance[child.stage]) ? guidance[child.stage] as string[] : [];
    const fanOut = documentFanOutDescriptor(child, documents);
    const sourceFanOut = sourceConfigFanOutDescriptor(child);
    const uploadDocuments = documents && isDocumentIngestUploadDelegationChild(child, documents)
      ? documents
      : undefined;
    const requestAction = delegationRequestActionName(child);
    if (isAdHocDelegationChild(child)) {
      const requestShape = isManifestReusedDelegationChild(child)
        ? 'empty object payload; delegationPolicy.inputEnrichment supplies child inputs'
        : 'payload shape { request: { ... } }';
      guidance[child.stage] = [
        ...existing,
        `Ad-hoc delegation tool ${requestAction}: use ${requestShape}; the child result lands at ${child.result_path} and the active mode remains ${child.stage}.`,
        `Read ${delegationStateBase(child)}.settled / degraded / degrade_reason before relying on the delegated ${child.id} result.`,
      ];
      continue;
    }
    guidance[child.stage] = [
      ...existing,
      terminalActionInstruction([{ name: requestAction, channel: delegationChannelName(child) }]),
      ...(fanOut ? [
        `Call ${requestAction} once for the projected ${fanOut.current_document}; deterministic payload enrichment supplies only that document slice.`,
        `For ${requestAction}, emit payload: { request: { ... } }; put document_id, document_name, topic, context, and other child request fields inside request, not directly under payload.`,
        `Repeat ${requestAction} on later rounds while ${fanOut.completion_guard} is false; the reaction advances the document cursor after each child result.`,
        `When ${fanOut.completion_guard} is true, use the stage transition action and do not dispatch another child.`,
        ] : sourceFanOut ? [
          `Call ${requestAction} once for the projected ${sourceFanOut.current_document}; deterministic payload enrichment supplies only that source slice.`,
          `For ${requestAction}, emit payload: { request: { ... } }; put source, purpose, guard, and other child request fields inside request, not directly under payload.`,
          `Repeat ${requestAction} on later rounds while ${sourceFanOut.completion_guard} is false; the reaction advances the source cursor after each bounded navigation result.`,
          `When ${sourceFanOut.completion_guard} is true, use the stage transition action and do not dispatch another child.`,
        ] : uploadDocuments ? [
          `Call ${requestAction} only after ${DOCUMENT_INGEST_ACTION} has set ${documentsSourceReadyPath(uploadDocuments)}; deterministic payload enrichment supplies ${uploadDocuments.result_path}.documents and ${uploadDocuments.result_path}.extraction_contract.`,
          `Wait until ${delegationStateBase(child)}.settled is true; the settlement reaction harvests the document-ingest result into ${uploadDocuments.result_path}.summary and ${uploadDocuments.result_path}.sections before transition.`,
        ] : [
          isManifestReusedDelegationChild(child)
            ? `Call ${requestAction} exactly once without a child request payload; deterministic payload enrichment supplies mapped parent state.`
            : `Call ${requestAction} exactly once with a request object; deterministic payload enrichment supplies mapped parent state.`,
        ...(isManifestReusedDelegationChild(child) ? [] : [
          `For ${requestAction}, emit payload: { request: { ... } }; put topic, query, context, and other child request fields inside request, not directly under payload.`,
        ]),
        `Wait until ${delegationStateBase(child)}.settled is true, then use the stage transition action.`,
        `If ${delegationStateBase(child)}.degraded is true, continue and preserve ${delegationStateBase(child)}.degrade_reason in your output.`,
      ]),
    ];
  }
}

function applyRegisteredToolGuidance(
  guidance: MutableRecord,
  tools: RegisteredToolDescriptor[],
): void {
  for (const tool of tools) {
    for (const modeName of tool.modes) {
      const existing = Array.isArray(guidance[modeName]) ? guidance[modeName] as string[] : [];
      guidance[modeName] = [
        ...existing,
        `Registered tool ${tool.name} writes its result to ${tool.result_path}; inspect that path before using the result in later reasoning.`,
      ];
    }
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
  schema[`${DOCUMENT_INTAKE_ROOT}.documents.*`] = 'object';
  schema[`${DOCUMENT_INTAKE_ROOT}.documents.*.fileId`] = 'string';
  schema[`${DOCUMENT_INTAKE_ROOT}.documents.*.name`] = 'string';
  schema[`${DOCUMENT_INTAKE_ROOT}.documents.*.mimeType`] = 'string';
  schema[`${DOCUMENT_INTAKE_ROOT}.documents.*.size`] = 'number';
  schema[`${DOCUMENT_INTAKE_ROOT}.documents.*.content_text`] = 'string';
  schema[`${DOCUMENT_INTAKE_ROOT}.documents.*.content_base64`] = 'string';
  schema[`${DOCUMENT_INTAKE_ROOT}.status`] = 'string';
  schema[`${DOCUMENT_INTAKE_ROOT}.source`] = 'string';
  schema[`${DOCUMENT_INTAKE_ROOT}.completed`] = 'boolean';
  schema[`${DOCUMENT_INTAKE_ROOT}.documents_requested`] = 'boolean';
  schema[DOCUMENTS_RECEIVED_PATH] = 'boolean';
  schema[resultPath] = 'object';
  schema[`${resultPath}.full_text`] = 'string';
  schema[`${resultPath}.documents`] = 'array';
  schema[`${resultPath}.documents.*`] = 'object';
  schema[`${resultPath}.documents.*.id`] = 'string';
  schema[`${resultPath}.documents.*.name`] = 'string';
  schema[`${resultPath}.documents.*.mime_type`] = 'string';
  schema[`${resultPath}.documents.*.size`] = 'number';
  schema[`${resultPath}.documents.*.text`] = 'string';
  schema[`${resultPath}.documents.*.char_count`] = 'number';
  schema[`${resultPath}.documents.*.source_index`] = 'number';
  schema[`${resultPath}.documents.*.extraction_kind`] = 'string';
  schema[`${resultPath}.documents.*.provenance`] = 'object';
  schema[`${resultPath}.documents.*.provenance.file_id`] = 'string';
  schema[`${resultPath}.documents.*.provenance.name`] = 'string';
  schema[`${resultPath}.documents.*.provenance.mime_type`] = 'string';
  schema[`${resultPath}.documents.*.provenance.size`] = 'number';
  schema[`${resultPath}.documents.*.provenance.source_index`] = 'number';
  schema[`${resultPath}.current_document`] = 'object';
  schema[`${resultPath}.current_document.id`] = 'string';
  schema[`${resultPath}.current_document.name`] = 'string';
  schema[`${resultPath}.current_document.mime_type`] = 'string';
  schema[`${resultPath}.current_document.size`] = 'number';
  schema[`${resultPath}.current_document.text`] = 'string';
  schema[`${resultPath}.current_document.char_count`] = 'number';
  schema[`${resultPath}.current_document.source_index`] = 'number';
  schema[`${resultPath}.current_document.extraction_kind`] = 'string';
  schema[`${resultPath}.current_document.provenance`] = 'object';
  schema[`${resultPath}.current_document.provenance.file_id`] = 'string';
  schema[`${resultPath}.current_document.provenance.name`] = 'string';
  schema[`${resultPath}.current_document.provenance.mime_type`] = 'string';
  schema[`${resultPath}.current_document.provenance.size`] = 'number';
  schema[`${resultPath}.current_document.provenance.source_index`] = 'number';
  schema[`${resultPath}.char_count`] = 'number';
  schema[`${resultPath}.file_count`] = 'number';
  schema[`${resultPath}.document_count`] = 'number';
  schema[`${resultPath}.files_json`] = 'string';
  schema[`${resultPath}.extraction_kind`] = 'string';
  schema[`${resultPath}.status`] = 'string';
  schema[`${resultPath}.reason`] = 'string';
  schema[documentsSourceReadyPath(documents)] = 'boolean';
  for (const [path, type] of documentDelegatedIngestSchemaEntries(documents)) {
    schema[path] = type;
  }
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
        { op: 'MSet', path: `${documents.result_path}.current_document`, value: {} },
        { op: 'MSet', path: `${documents.result_path}.char_count`, value: 0 },
        { op: 'MSet', path: `${documents.result_path}.file_count`, value: 0 },
        { op: 'MSet', path: `${documents.result_path}.document_count`, value: 0 },
        { op: 'MSet', path: `${documents.result_path}.files_json`, value: '[]' },
        { op: 'MSet', path: `${documents.result_path}.extraction_kind`, value: 'skipped_no_documents' },
        { op: 'MSet', path: documentsSourceReadyPath(documents), value: true },
      ],
      channel: 'widget_output',
    };
  }
}

function applyEngineNotebookActions(actionMap: MutableRecord): void {
  actionMap.record_note = {
    description: 'Save or overwrite a working-memory note. Pass key and text.',
    mutations: [{ op: 'MSet', path: 'notebook.*', value: '', from_arg: '*' }],
    channel: 'widget_output',
  };
  actionMap.pin_note = {
    description: 'Pin a note so its full body stays visible in later rounds.',
    arg_descriptions: { key: 'The note key to pin.' },
    arg_schema: { key: { type: 'string', required: true } },
    mutations: [{ op: 'MAppend', path: 'notebook_pins', value: '', from_arg: 'key' }],
    channel: 'widget_output',
  };
  actionMap.unpin_note = {
    description: 'Unpin a previously pinned note.',
    arg_descriptions: { key: 'The note key to unpin.' },
    arg_schema: { key: { type: 'string', required: true } },
    mutations: [{ op: 'MRemove', path: 'notebook_pins', value: '', from_arg: 'key' }],
    channel: 'widget_output',
  };
  actionMap.delete_note = {
    description: 'Clear a working-memory note you no longer need. Pass key.',
    mutations: [{ op: 'MSet', path: 'notebook.*', value: '', from_arg: '*' }],
    channel: 'widget_output',
  };
}

function applySessionControlActionDescriptions(actionMap: MutableRecord): void {
  for (const action of SESSION_CONTROL_ACTIONS) {
    const existing = recordField(actionMap, action);
    const label = action.replace(/^session_/u, '').replace(/_/gu, ' ');
    existing.description = `Control-plane ${label} command. Session controls are for explicit control intent only; do not use ${action} for normal stage progression.`;
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
    const fidelity = documentUploadedFidelityPredicate(documents);
    if (fidelity) {
      appendModePrecondition(
        mode,
        action.name,
        fidelity,
      );
    }
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
    write_scope: documents.required
      ? [documentsSourceReadyPath(documents)]
      : [
          documentsSourceReadyPath(documents),
          `${documents.result_path}.status`,
          `${documents.result_path}.full_text`,
          `${documents.result_path}.documents`,
          `${documents.result_path}.current_document`,
          `${documents.result_path}.char_count`,
          `${documents.result_path}.file_count`,
          `${documents.result_path}.document_count`,
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
    `${DOCUMENT_INTAKE_ROOT}.status`,
    `${DOCUMENT_INTAKE_ROOT}.documents_requested`,
    `${DOCUMENT_INTAKE_ROOT}.file_refs`,
    `${DOCUMENT_INTAKE_ROOT}.file_refs.0`,
    `${DOCUMENT_INTAKE_ROOT}.file_refs.0.fileId`,
    `${DOCUMENT_INTAKE_ROOT}.file_refs.0.name`,
    `${DOCUMENT_INTAKE_ROOT}.file_refs.0.mimeType`,
    `${DOCUMENT_INTAKE_ROOT}.file_refs.0.size`,
    DOCUMENTS_RECEIVED_PATH,
    ...documentSummaryProjectionPaths(documents),
  ];
  hostProjection.include = unique([...hostInclude, ...hostPaths]);
  if (!Array.isArray(hostProjection.exclude)) {
    hostProjection.exclude = [];
  }

  const downstreamPaths = documentSummaryProjectionPaths(documents);
  for (const modeName of modeNames.slice(Math.max(hostIndex + 1, 0))) {
    const downstreamProjection = recordField(projection, modeName);
    const include = Array.isArray(downstreamProjection.include) ? downstreamProjection.include as string[] : [];
    downstreamProjection.include = unique([...include, ...downstreamPaths]);
    if (!Array.isArray(downstreamProjection.exclude)) {
      downstreamProjection.exclude = [];
    }
  }
}

function documentSummaryProjectionPaths(documents: DocumentsDescriptor): string[] {
  const resultPath = documents.result_path;
  return [
    `${resultPath}.status`,
    `${resultPath}.char_count`,
    `${resultPath}.file_count`,
    `${resultPath}.document_count`,
    `${resultPath}.extraction_kind`,
    `${resultPath}.current_document.id`,
    `${resultPath}.current_document.name`,
    `${resultPath}.current_document.char_count`,
    documentsSourceReadyPath(documents),
  ];
}

function documentDelegatedIngestSchemaEntries(documents: DocumentsDescriptor): Array<[string, string]> {
  const resultPath = documents.result_path;
  const extractionContractPath = documentsExtractionContractPath(documents);
  return [
    [extractionContractPath, 'object'],
    [`${extractionContractPath}.output_profile`, 'string'],
    [`${extractionContractPath}.target_schema`, 'object'],
    [`${extractionContractPath}.required_outputs`, 'array'],
    [`${extractionContractPath}.required_outputs.*`, 'string'],
    [`${resultPath}.summary`, 'string'],
    [`${resultPath}.sections`, 'object'],
    [`${resultPath}.sections.*`, 'object'],
    [`${resultPath}.sections.*.id`, 'string'],
    [`${resultPath}.sections.*.heading`, 'string'],
    [`${resultPath}.sections.*.status`, 'string'],
    [`${resultPath}.sections.*.text`, 'string'],
    [documentsIngestResultHarvestedPath(documents), 'boolean'],
  ];
}

function documentIngestExtractionContract(documents: DocumentsDescriptor): Record<string, unknown> {
  return {
    output_profile: 'due-diligence-section-map',
    target_schema: documents.artifact_shape ?? {
      summary: 'string',
      sections: {
        '*': {
          id: 'string',
          heading: 'string',
          status: 'string',
          text: 'string',
        },
      },
    },
    required_outputs: ['structured_data', 'fidelity_report', 'quality_report'],
  };
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

function documentsFullTextPath(documents: DocumentsDescriptor): string {
  return `${documents.result_path}.full_text`;
}

function documentsCollectionPath(documents: DocumentsDescriptor): string {
  return `${documents.result_path}.documents`;
}

function documentsExtractionContractPath(documents: DocumentsDescriptor): string {
  return `${documents.result_path}.extraction_contract`;
}

function documentsIngestResultHarvestedPath(documents: DocumentsDescriptor): string {
  return `${documents.result_path}.ingest_result_harvested`;
}

function documentsCurrentDocumentPath(documents: DocumentsDescriptor): string {
  return `${documents.result_path}.current_document`;
}

function documentsCurrentDocumentTextPath(documents: DocumentsDescriptor): string {
  return `${documentsCurrentDocumentPath(documents)}.text`;
}

function documentsCurrentDocumentIdPath(documents: DocumentsDescriptor): string {
  return `${documentsCurrentDocumentPath(documents)}.id`;
}

function documentsCurrentDocumentNamePath(documents: DocumentsDescriptor): string {
  return `${documentsCurrentDocumentPath(documents)}.name`;
}

function documentsIndexedDocumentPath(documents: DocumentsDescriptor, index: number): string {
  return `${documentsCollectionPath(documents)}.${String(index)}`;
}

function documentFanOutDescriptor(
  child: DelegationChildDescriptor,
  documents?: DocumentsDescriptor,
): DelegationDocumentFanOutDescriptor | undefined {
  if (!documents || !child.fan_out || !documentFanOutCandidateSupported(child, documents)) {
    return undefined;
  }
  return {
    ...child.fan_out,
    index_path: child.fan_out.index_path ?? `${child.stage}.fan_out.index`,
  };
}

function sourceConfigFanOutDescriptor(
  child: DelegationChildDescriptor,
): DelegationDocumentFanOutDescriptor | undefined {
  if (!child.fan_out || !sourceConfigFanOutCandidateSupported(child)) {
    return undefined;
  }
  return {
    ...child.fan_out,
    index_path: child.fan_out.index_path ?? `${child.stage}.fan_out.index`,
  };
}

function delegationFanOutDescriptor(
  child: DelegationChildDescriptor,
  documents?: DocumentsDescriptor,
): DelegationDocumentFanOutDescriptor | undefined {
  return documentFanOutDescriptor(child, documents) ?? sourceConfigFanOutDescriptor(child);
}

function childHasDocumentFanOut(child: DelegationChildDescriptor, documents?: DocumentsDescriptor): boolean {
  return documentFanOutDescriptor(child, documents) !== undefined;
}

function childHasSourceConfigFanOut(child: DelegationChildDescriptor): boolean {
  return sourceConfigFanOutDescriptor(child) !== undefined;
}

function documentFanOutCandidateSupported(
  child: { fan_out?: unknown },
  documents?: DocumentsDescriptor,
): boolean {
  if (!documents || documents.required !== true || !isRecord(child.fan_out)) {
    return false;
  }
  return child.fan_out.source === documentsCollectionPath(documents) &&
    child.fan_out.current_document === documentsCurrentDocumentPath(documents) &&
    typeof child.fan_out.result_path === 'string' &&
    child.fan_out.result_path.length > 0 &&
    typeof child.fan_out.completion_guard === 'string' &&
    child.fan_out.completion_guard.length > 0;
}

function sourceConfigFanOutCandidateSupported(child: { fan_out?: unknown }): boolean {
  if (!isRecord(child.fan_out)) {
    return false;
  }
  return child.fan_out.source === LEAD_RESEARCH_SOURCE_FAN_OUT_SOURCE_PATH &&
    child.fan_out.current_document === LEAD_RESEARCH_SOURCE_FAN_OUT_CURRENT_PATH &&
    child.fan_out.result_path === LEAD_RESEARCH_SOURCE_FAN_OUT_RESULTS_PATH &&
    typeof child.fan_out.completion_guard === 'string' &&
    child.fan_out.completion_guard.length > 0;
}

function documentFanOutProjectionPaths(child: DelegationChildDescriptor, documents?: DocumentsDescriptor): string[] {
  const fanOut = documentFanOutDescriptor(child, documents);
  if (!fanOut) {
    return [];
  }
  return unique([
    fanOut.index_path ?? `${child.stage}.fan_out.index`,
    fanOut.completion_guard,
    `${fanOut.result_path}.*.document_id`,
    `${fanOut.result_path}.*.document_name`,
    `${fanOut.result_path}.*.source_index`,
    `${fanOut.result_path}.*.status`,
    `${fanOut.result_path}.*.reason`,
    ...boundedDelegationResultFields(child).map((field) => `${fanOut.result_path}.*.${field}`),
  ]);
}

function sourceConfigFanOutProjectionPaths(child: DelegationChildDescriptor): string[] {
  const fanOut = sourceConfigFanOutDescriptor(child);
  if (!fanOut) {
    return [];
  }
  return unique([
    LEAD_RESEARCH_SOURCE_FAN_OUT_SOURCE_PATH,
    `${LEAD_RESEARCH_SOURCE_FAN_OUT_SOURCE_PATH}.*.url`,
    `${LEAD_RESEARCH_SOURCE_FAN_OUT_SOURCE_PATH}.*.allowed_domains`,
    fanOut.current_document,
    `${fanOut.current_document}.url`,
    `${fanOut.current_document}.allowed_domains`,
    fanOut.index_path ?? `${child.stage}.fan_out.index`,
    fanOut.completion_guard,
    `${fanOut.result_path}.*.source`,
    `${fanOut.result_path}.*.source_index`,
    `${fanOut.result_path}.*.status`,
    `${fanOut.result_path}.*.pages_visited`,
    `${fanOut.result_path}.*.items`,
    `${fanOut.result_path}.*.audit`,
  ]);
}

function delegationFanOutProjectionPaths(child: DelegationChildDescriptor, documents?: DocumentsDescriptor): string[] {
  return unique([
    ...documentFanOutProjectionPaths(child, documents),
    ...sourceConfigFanOutProjectionPaths(child),
  ]);
}

function normalizeDocumentSliceDelegation(
  delegation: DelegationDescriptor,
  documents: DocumentsDescriptor | undefined,
): DelegationDescriptor {
  if (!documents || !Array.isArray(delegation.children) || delegation.children.length === 0) {
    return delegation;
  }
  let mutated = false;
  const fullTextPath = documentsFullTextPath(documents);
  const children = delegation.children.map((child) => {
    const payloadMap = { ...child.payload_map };
    let childMutated = false;
    for (const [target, source] of Object.entries(child.payload_map)) {
      if (source !== fullTextPath || !isDocumentSlicePayloadTarget(target)) {
        continue;
      }
      payloadMap[target] = documentsCurrentDocumentTextPath(documents);
      childMutated = true;
    }
    if (!childMutated) {
      return child;
    }
    if (payloadMap['request.document_id'] === undefined) {
      payloadMap['request.document_id'] = documentsCurrentDocumentIdPath(documents);
    }
    if (payloadMap['request.document_name'] === undefined) {
      payloadMap['request.document_name'] = documentsCurrentDocumentNamePath(documents);
    }
    mutated = true;
    return { ...child, payload_map: payloadMap };
  });
  return mutated ? { ...delegation, children } : delegation;
}

function normalizeDocumentIngestDelegation(
  delegation: DelegationDescriptor,
  documents: DocumentsDescriptor | undefined,
): DelegationDescriptor {
  if (!documents || !Array.isArray(delegation.children) || delegation.children.length === 0) {
    return delegation;
  }

  let mutated = false;
  const children = delegation.children.map((child) => {
    if (!isDocumentIngestUploadDelegationChild(child, documents)) {
      return child;
    }
    const payloadMap = {
      ...child.payload_map,
      'request.documents': documentsCollectionPath(documents),
      'request.extraction_contract': documentsExtractionContractPath(documents),
    };
    if (
      child.payload_map['request.documents'] === payloadMap['request.documents'] &&
      child.payload_map['request.extraction_contract'] === payloadMap['request.extraction_contract']
    ) {
      return child;
    }
    mutated = true;
    return { ...child, payload_map: payloadMap };
  });
  return mutated ? { ...delegation, children } : delegation;
}

function isDocumentIngestUploadDelegationChild(
  child: DelegationChildDescriptor,
  documents: DocumentsDescriptor,
): boolean {
  return documents.required === true &&
    child.stage === documents.stage &&
    isDocumentIngestDelegationChild(child);
}

function isDocumentIngestDelegationChild(child: DelegationChildDescriptor | Record<string, unknown>): boolean {
  return [
    child.registered_name,
    child.target_slug,
    child.target_spec,
  ].some((value) => {
    if (typeof value !== 'string') {
      return false;
    }
    const normalized = normalizeProgramNameForSelfTarget(value);
    return normalized === 'document_ingest' || normalized === 'simoneos_document_ingest';
  });
}

function isDocumentSlicePayloadTarget(target: string): boolean {
  return target === 'request.topic' ||
    target === 'request.query' ||
    target === 'request.document_text' ||
    target === 'document_intake.work_product' ||
    target === 'document_intake.text';
}

function normalizeDelegationInputEnrichmentTargets(
  delegation: DelegationDescriptor,
  documents: DocumentsDescriptor | undefined,
): DelegationDescriptor {
  if (!Array.isArray(delegation.children) || delegation.children.length === 0) {
    return delegation;
  }
  const preferredTargets = preferredDelegationPayloadTargets(delegation.children, documents);
  const targetSources = new Map<string, string>();
  let mutated = false;
  const children = delegation.children.map((child) => {
    const payloadMap: Record<string, string> = {};
    let childMutated = false;
    for (const [target, source] of Object.entries(child.payload_map)) {
      const preferredSource = preferredTargets.get(target);
      let nextTarget = target;
      if (preferredSource !== undefined && source !== preferredSource) {
        nextTarget = delegationContextTargetForSource(source, targetSources);
      } else {
        const existingSource = targetSources.get(target);
        if (existingSource !== undefined && existingSource !== source) {
          nextTarget = delegationContextTargetForSource(source, targetSources);
        }
      }
      payloadMap[nextTarget] = source;
      targetSources.set(nextTarget, source);
      if (nextTarget !== target) {
        childMutated = true;
      }
    }
    if (!childMutated) {
      return child;
    }
    mutated = true;
    return { ...child, payload_map: payloadMap };
  });
  return mutated ? { ...delegation, children } : delegation;
}

function preferredDelegationPayloadTargets(
  children: DelegationChildDescriptor[],
  documents: DocumentsDescriptor | undefined,
): Map<string, string> {
  const preferred = new Map<string, string>();
  if (!documents) {
    return preferred;
  }
  const documentTextPath = documentsCurrentDocumentTextPath(documents);
  for (const child of children) {
    for (const [target, source] of Object.entries(child.payload_map)) {
      if (source === documentTextPath && isDocumentSlicePayloadTarget(target)) {
        preferred.set(target, source);
      }
    }
  }
  return preferred;
}

function delegationContextTargetForSource(source: string, targetSources: ReadonlyMap<string, string>): string {
  const sourceBase = source.replace(/\.(result_json|items_json)$/u, '');
  const slug = sourceBase
    .replace(/[^A-Za-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .toLowerCase() || 'context';
  let candidate = `domain_context.${slug}`;
  if (targetSources.get(candidate) === source) {
    return candidate;
  }
  let suffix = 2;
  while (targetSources.has(candidate)) {
    candidate = `domain_context.${slug}_${String(suffix)}`;
    if (targetSources.get(candidate) === source) {
      return candidate;
    }
    suffix += 1;
  }
  return candidate;
}

function applyDocumentSliceTransitionActions(
  actionMap: MutableRecord,
  documents: DocumentsDescriptor | undefined,
  children: DelegationChildDescriptor[],
  transitionActions: TransitionAction[],
): void {
  if (!documents) {
    return;
  }
  const slicedChildren = children.filter((child) =>
    !childHasDocumentFanOut(child, documents) &&
    childUsesCurrentDocumentSlice(child, documents));
  for (const [index, child] of slicedChildren.entries()) {
    const transition = transitionActions.find((action) => action.target === child.stage);
    if (!transition) {
      continue;
    }
    const entry = actionMap[transition.name];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const actionEntry = entry as MutableRecord;
    const mutations = Array.isArray(actionEntry.mutations)
      ? actionEntry.mutations as MutableRecord[]
      : [];
    const documentSource = documentsIndexedDocumentPath(documents, index);
    if (!mutations.some((mutation) =>
      mutation.path === documentsCurrentDocumentPath(documents) &&
      mutation.from_state === documentSource)) {
      mutations.push({
        op: 'MSet',
        path: documentsCurrentDocumentPath(documents),
        value: '',
        from_arg: `document_slice_${child.id}`,
        from_state: documentSource,
      });
    }
    actionEntry.mutations = mutations;
  }
}

function childUsesCurrentDocumentSlice(child: DelegationChildDescriptor, documents: DocumentsDescriptor): boolean {
  const currentPath = documentsCurrentDocumentPath(documents);
  return Object.values(child.payload_map).some((source) =>
    source === currentPath || source.startsWith(`${currentPath}.`));
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

function transitionsWithFinalStageGuard(
  transitions: IntakeTransition[],
  finalStage: string,
  guardField: string,
): IntakeTransition[] {
  return transitions.map((transition) =>
    transition.to === finalStage
      ? { ...transition, guard_field: guardField }
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
  return child.action_name ?? `request_${child.id}`;
}

function delegationSettleReactionName(child: DelegationChildDescriptor): string {
  return `settle_${child.id}_delegation`;
}

function documentFanOutAdvanceReactionName(child: DelegationChildDescriptor): string {
  return `advance_${safeIdentifier(child.id)}_document_fan_out`;
}

function sourceConfigFanOutAdvanceReactionName(child: DelegationChildDescriptor): string {
  return `advance_${safeIdentifier(child.id)}_source_fan_out`;
}

function delegationStateBase(child: DelegationChildDescriptor): string {
  return `${child.stage}.delegation.${child.id}`;
}

function isAdHocDelegationChild(child: DelegationChildDescriptor): boolean {
  return child.ad_hoc === true;
}

function isManifestReusedDelegationChild(child: DelegationChildDescriptor): boolean {
  return child.synthesize_child === undefined && child.target_spec !== undefined && child.registered_name !== undefined;
}

function delegationTargetSpec(child: DelegationChildDescriptor): string {
  if (child.target_spec) {
    return child.target_spec;
  }
  const childSlug = child.synthesize_child?.slug?.trim();
  return childSlug && childSlug.length > 0 ? childSlug : child.id;
}

function delegationSeedsRequestTopic(child: DelegationChildDescriptor): boolean {
  return Object.prototype.hasOwnProperty.call(child.payload_map, 'request.topic') &&
    typeof child.payload_map['request.topic'] === 'string' &&
    child.payload_map['request.topic'].trim().length > 0;
}

function delegationDeclaresSeededTopicResult(child: DelegationChildDescriptor): boolean {
  return delegationResultFields(child).some(([field]) =>
    field.toLowerCase().replace(/[-\s]+/gu, '_') === 'seeded_topic');
}

function delegationEchoesSeededTopic(child: DelegationChildDescriptor): boolean {
  return delegationSeedsRequestTopic(child) && delegationDeclaresSeededTopicResult(child);
}

function delegationResultFields(child: DelegationChildDescriptor): Array<[string, string]> {
  return Object.entries(child.synthesize_child?.result_fields ?? {});
}

function delegationResultProjectionPaths(child: DelegationChildDescriptor): string[] {
  return unique([
    `${child.result_path}.status`,
    `${child.result_path}.reason`,
    ...(child.synthesize_child?.kind === 'research_agent' && researchChildBackend(child) === 'host_connector'
      ? [`${child.result_path}.adapter_kind`]
      : []),
    ...boundedDelegationResultFields(child).map((field) => `${child.result_path}.${field}`),
  ]);
}

function boundedDelegationResultFields(child: DelegationChildDescriptor): string[] {
  return delegationResultFields(child)
    .map(([field]) => field)
    .filter(isBoundedProjectionResultField);
}

function isBoundedProjectionResultField(field: string): boolean {
  const normalized = field.toLowerCase().replace(/[-\s]+/gu, '_');
  if (
    normalized.includes('full_text') ||
    normalized.includes('raw') ||
    normalized.includes('body') ||
    normalized.includes('content') ||
    normalized.includes('transcript') ||
    normalized.includes('source_text') ||
    normalized.includes('document_text') ||
    normalized === 'seeded_topic' ||
    normalized === 'topic' ||
    normalized === 'query'
  ) {
    return false;
  }
  return normalized.includes('summary') ||
    normalized.includes('finding') ||
    normalized.includes('flag') ||
    normalized.includes('risk') ||
    normalized.includes('count') ||
    normalized.includes('score') ||
    normalized.includes('status') ||
    normalized.includes('decision') ||
    normalized.includes('rationale') ||
    normalized.includes('recommendation') ||
    normalized === 'document_id' ||
    normalized === 'document_name' ||
    normalized === 'section_id' ||
    normalized === 'section_title';
}

function applyScaleSafeProjectionPolicy(projection: MutableRecord): void {
  for (const rawModeProjection of Object.values(projection)) {
    if (!rawModeProjection || typeof rawModeProjection !== 'object' || Array.isArray(rawModeProjection)) {
      continue;
    }
    const modeProjection = rawModeProjection as MutableRecord;
    const include = Array.isArray(modeProjection.include) ? modeProjection.include as string[] : [];
    modeProjection.include = unique(include.filter((path) => !isUnsafeModelProjectionInclude(path)));
    const exclude = Array.isArray(modeProjection.exclude) ? modeProjection.exclude as string[] : [];
    modeProjection.exclude = unique(exclude);
  }
}

function isUnsafeModelProjectionInclude(path: string): boolean {
  if (path.endsWith('.full_text')) {
    return true;
  }
  if (path.endsWith('.documents') || path.endsWith('.documents.*') || path.endsWith('.documents.*.text')) {
    return true;
  }
  if (path.endsWith('.current_document.text')) {
    return true;
  }
  if (/\.fan_out\.results$/u.test(path) || /\.fan_out\.results\.\*$/u.test(path) || /\.fan_out\.results\.\*\.result$/u.test(path)) {
    return true;
  }
  if (/\.fan_out\.results\.\*\.[^.]+$/u.test(path)) {
    const field = path.split('.').at(-1) ?? '';
    return !isBoundedProjectionResultField(field) &&
      !['document_id', 'document_name', 'source_index', 'status', 'reason'].includes(field);
  }
  if (/\.delegation\.[^.]+\.result$/u.test(path) || /\.delegation\.[^.]+\.result\.result$/u.test(path)) {
    return true;
  }
  if (/\.delegation\.[^.]+\.result\.[^.]+$/u.test(path)) {
    const field = path.split('.').at(-1) ?? '';
    return !isBoundedProjectionResultField(field) &&
      !['status', 'reason', 'adapter_kind'].includes(field);
  }
  return false;
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
        `${loop.collection}.*.${DERIVED_TERMINAL_FIELD}`,
        `${collectionLifecycleTerminalStatusItemsPath(loop.collection)}.*.${DERIVED_TERMINAL_STATUS_FIELD}`,
        ...confirmationLoopInstructionPaths(loop),
        confirmationLoopViolationPath(loop, lifecycle),
        confirmationLoopDemotionCounterPath(loop),
        confirmationLoopAppliedDecisionPath(loop),
      ]),
    };
    reactions[confirmationLoopSummarizeReactionName(loop)] = {
      event: 'AfterIngestion',
      watch: [
        'inputs.mode_entry.mode',
        'inputs.user_text',
        'inputs.user_decision.decision',
        'inputs.user_decision.timestamp',
      ],
      write_scope: [confirmationLoopSummaryPath(loop)],
    };
    const proposalFieldPaths = confirmationLoopProposalFields(loop, lifecycle)
      .map((field) => confirmationLoopProposalFieldPath(loop, field));
    reactions[confirmationLoopMirrorProposalReactionName(loop)] = {
      event: 'AfterMutation',
      watch: [confirmationLoopRawPayloadMutationsPath(loop)],
      write_scope: proposalFieldPaths,
    };
    reactions[confirmationLoopChoreographReactionName(loop)] = {
      event: 'AfterRound',
      watch: [],
      write_scope: [
        `${loop.collection}.*`,
        collectionLifecycleTerminalStatusItemsPath(loop.collection),
        confirmationLoopAppliedProposalCountPath(loop),
        confirmationLoopSeedStatePath(loop),
      ],
    };
  }
}

function applyConfirmationLoopIntentModeWiring(
  modes: MutableRecord,
  loops: ConfirmationLoopDescriptor[],
  transitionActions: TransitionAction[],
): void {
  loops.forEach((loop, index) => {
    const mode = recordField(modes, loop.stage);
    const proposeAction = confirmationLoopProposeActionName(loop, index, loops.length);
    const completionActions = confirmationLoopCompletionTransitionActionsForLoop(loop, transitionActions);
    mode.vocabulary = [
      proposeAction,
      ...completionActions.map((action) => action.name),
      ...toolkitActionsForMode(mode),
    ];
    const channels = Array.isArray(mode.channels) ? mode.channels as string[] : [];
    mode.channels = unique([...channels, USER_CONFIRMATION_CHANNEL, 'widget_output']);
    appendModePrecondition(mode, proposeAction, { kind: 'FieldFalsy', path: loop.aggregate.guard_field });
    appendModePrecondition(mode, proposeAction, confirmationLoopCursorReaderPredicate(loop));
    for (const action of completionActions) {
      appendModePrecondition(mode, action.name, collectionLifecycleTerminalStatusPredicate(loop.collection));
    }
  });
}

function confirmationLoopCursorReaderPredicate(loop: ConfirmationLoopDescriptor): Record<string, unknown> {
  const cursor = confirmationLoopActiveItemIdPath(loop);
  return {
    kind: 'Implies',
    subs: [
      { kind: 'FieldTruthy', path: cursor },
      {
        kind: 'PreviousItemFieldEquals',
        path: collectionLifecycleTerminalStatusItemsPath(loop.collection),
        cursor,
        value: true,
        order: { kind: 'plan_array' },
      },
    ],
  };
}

function applyConfirmationLoopProjection(
  projection: MutableRecord,
  loops: ConfirmationLoopDescriptor[],
  lifecycle?: CollectionLifecycleDescriptor,
  modeNames: string[] = [],
): void {
  if (!lifecycle) {
    return;
  }
  for (const loop of loops) {
    const modeProjection = recordField(projection, loop.stage);
    const collectionPaths = confirmationLoopCollectionProjectionPaths(loop, lifecycle);
    const existingInclude = Array.isArray(modeProjection.include) ? modeProjection.include as string[] : [];
    modeProjection.include = unique([
      ...existingInclude.filter((path) =>
        !path.endsWith('.items_json') &&
        path !== loop.collection &&
        !path.startsWith(`${loop.collection}.`)),
      ...confirmationLoopApproveProjectionPaths(loop, lifecycle),
      ...confirmationLoopActiveItemProjectionPaths(loop, lifecycle),
    ]);
    if (!Array.isArray(modeProjection.exclude)) {
      modeProjection.exclude = [];
    }
    const loopIndex = modeNames.indexOf(loop.stage);
    if (loopIndex < 0) {
      continue;
    }
    for (const modeName of modeNames.slice(loopIndex + 1)) {
      const downstreamProjection = recordField(projection, modeName);
      const downstreamInclude = Array.isArray(downstreamProjection.include) ? downstreamProjection.include as string[] : [];
      downstreamProjection.include = unique([
        ...downstreamInclude.filter((path) => path !== loop.collection),
        ...collectionPaths,
        loop.aggregate.guard_field,
        confirmationLoopSummaryPath(loop),
      ]);
      if (!Array.isArray(downstreamProjection.exclude)) {
        downstreamProjection.exclude = [];
      }
    }
  }
}

function confirmationLoopApproveProjectionPaths(
  loop: ConfirmationLoopDescriptor,
  lifecycle: CollectionLifecycleDescriptor,
): string[] {
  const summaryPath = confirmationLoopSummaryPath(loop);
  return unique([
    'inputs.user_decision.decision',
    'inputs.user_decision.instruction',
    'inputs.user_decision.target_item_index',
    'inputs.user_decision.target_item_id',
    'inputs.user_decision.target_item_title',
    'inputs.user_decision.target_item_status',
    loop.aggregate.guard_field,
    summaryPath,
    `${summaryPath}.active_item`,
    confirmationLoopActiveItemIdPath(loop),
    confirmationLoopHasProposedItemPath(loop),
    ...confirmationLoopStatusBucketProjectionPaths(loop, lifecycle),
    `${summaryPath}.total_items`,
    `${summaryPath}.terminal_items`,
    `${summaryPath}.pending_items`,
    `${summaryPath}.proposed_items`,
    `${summaryPath}.current_index`,
  ]);
}

function confirmationLoopStatusBucketProjectionPaths(
  loop: ConfirmationLoopDescriptor,
  lifecycle: CollectionLifecycleDescriptor,
): string[] {
  return lifecycle.statuses.map((status) => confirmationLoopStatusBucketPath(loop, status.name));
}

function confirmationLoopActiveItemProjectionPaths(
  loop: ConfirmationLoopDescriptor,
  lifecycle: CollectionLifecycleDescriptor,
): string[] {
  const activeItemPath = `${confirmationLoopSummaryPath(loop)}.active_item`;
  return unique([
    activeItemPath,
    ...confirmationLoopActiveItemFields(loop, lifecycle).map((field) => `${activeItemPath}.${field}`),
  ]);
}

function confirmationLoopCollectionProjectionPaths(
  loop: ConfirmationLoopDescriptor,
  lifecycle: CollectionLifecycleDescriptor,
): string[] {
  const idField = loop.item_id_field ?? lifecycle.item.id_field;
  const titleField = loop.item_title_field ?? 'title';
  const instructionFields = confirmationLoopInstructionFields(loop);
  const visibleFields = Object.keys(lifecycle.item.schema)
    .filter((field) => !instructionFields.has(field) && isBoundedProjectionResultField(field));
  return unique([
    `${loop.collection}.*.${idField}`,
    `${loop.collection}.*.${titleField}`,
    `${loop.collection}.*.${lifecycle.item.status_field}`,
    ...visibleFields.map((field) => `${loop.collection}.*.${field}`),
  ]);
}

function applyConfirmationLoopPrompts(
  prompts: MutableRecord,
  loops: ConfirmationLoopDescriptor[],
  lifecycle?: CollectionLifecycleDescriptor,
  transitionActions: TransitionAction[] = [],
): void {
  if (!lifecycle) {
    return;
  }
  for (const loop of loops) {
    const itemLabel = lifecycle.item_label;
    const itemLabelPlural = `${itemLabel}s`;
    const existing = typeof prompts[loop.stage] === 'string' ? `${prompts[loop.stage]}\n` : '';
    const proposeAction = confirmationLoopProposeActionName(loop, 0, loops.length);
    const completionActions = confirmationLoopCompletionTransitionActionsForLoop(loop, transitionActions);
    const completionActionNames = completionActions.map((action) => action.name);
    const proposalPayload = confirmationLoopProposalPayloadExample(loop, lifecycle);
    const terminalActions = [
      { name: proposeAction, channel: 'widget_output', payloadExample: proposalPayload },
      ...completionActionNames.map((name) => ({ name, channel: 'widget_output' })),
    ];
    const completionInstruction = ` ${confirmationLoopCompletionGuidance(loop, completionActionNames, proposeAction)}`;
    prompts[loop.stage] = `${existing}${terminalActionInstruction(terminalActions)}\nWork through the ${itemLabelPlural} one at a time. The projected ${confirmationLoopSummaryPath(loop)} object is the bounded approval view: use its active_item and progress counts for the item under review. Use projected upstream reasoning summaries such as result_json/result, including issue_analysis, due-diligence findings, intake facts, defects, risks, qualifications, and revision instructions when present; integrate that analysis into the proposal instead of drafting blank or generic content. Do not inspect or request the full ${loop.collection} collection. Call ${proposeAction} with the proposal content for the active item only while ${loop.aggregate.guard_field} is false; the runtime selects that item and pauses for the user's decision. For ${proposeAction}, emit the proposal content as top-level payload fields, not payload.mutations; use payload: ${JSON.stringify(proposalPayload)} and do not emit an empty proposed_text. Never write item statuses yourself. A revise decision includes the user's instruction on the active item; call ${proposeAction} again with revised content.${completionInstruction}`;
  }
}

function recoverySteersForConfirmationLoops(
  loops: ConfirmationLoopDescriptor[],
  lifecycle: CollectionLifecycleDescriptor | undefined,
  transitionActions: TransitionAction[],
): MutableRecord[] {
  if (!lifecycle) {
    return [];
  }
  return loops.flatMap((loop) => {
    const proposeAction = confirmationLoopProposeActionName(loop, 0, loops.length);
    const completionActions = confirmationLoopCompletionTransitionActionsForLoop(loop, transitionActions);
    const completionActionNames = completionActions.map((action) => action.name);
    const activeItemIdPath = confirmationLoopActiveItemIdPath(loop);
    const summaryPath = confirmationLoopSummaryPath(loop);
    return [
      {
        mode: loop.stage,
        when: { kind: 'FieldTruthy', path: loop.aggregate.guard_field },
        guidance: confirmationLoopCompletionGuidance(loop, completionActionNames, proposeAction),
        set: { path: loop.aggregate.guard_field, value: true },
      },
      {
        mode: loop.stage,
        when: {
          kind: 'All',
          subs: [
            { kind: 'FieldTruthy', path: activeItemIdPath },
            { kind: 'FieldFalsy', path: loop.aggregate.guard_field },
          ],
        },
        guidance: `Handle {{${activeItemIdPath}}} next with ${proposeAction}; use ${summaryPath}.active_item as the bounded ${lifecycle.item_label} view and do not inspect ${loop.collection}.`,
        template_paths: [activeItemIdPath],
      },
    ];
  });
}

function confirmationLoopCompletionGuidance(
  loop: ConfirmationLoopDescriptor,
  completionActionNames: string[],
  proposeAction: string,
): string {
  return completionActionNames.length > 0
    ? `When ${loop.aggregate.guard_field} is true, all items are resolved; call ${completionActionNames.join(' or ')} exactly once to advance downstream, and do not call ${proposeAction} again or open another confirmation prompt.`
    : `When ${loop.aggregate.guard_field} is true, all items are resolved; do not call ${proposeAction} again or open another confirmation prompt.`;
}

function applyConfirmationLoopGuidance(
  guidance: MutableRecord,
  loops: ConfirmationLoopDescriptor[],
  lifecycle?: CollectionLifecycleDescriptor,
  transitionActions: TransitionAction[] = [],
): void {
  if (!lifecycle) {
    return;
  }
  for (const loop of loops) {
    const existing = Array.isArray(guidance[loop.stage]) ? guidance[loop.stage] as string[] : [];
    const proposeAction = confirmationLoopProposeActionName(loop, 0, loops.length);
    const proposalPayload = confirmationLoopProposalPayloadExample(loop, lifecycle);
    const terminalActions = [
      { name: proposeAction, channel: 'widget_output', payloadExample: proposalPayload },
      ...confirmationLoopCompletionTransitionActionsForLoop(loop, transitionActions)
        .map((action) => ({ name: action.name, channel: 'widget_output' })),
    ];
    guidance[loop.stage] = [
      ...existing,
      terminalActionInstruction(terminalActions),
      `Work through the ${lifecycle.item_label}s one at a time from ${confirmationLoopSummaryPath(loop)}.active_item; the runtime selects the target item for ${proposeAction}.`,
      'Use projected upstream reasoning summaries such as result_json/result, including issue_analysis, due-diligence findings, intake facts, defects, risks, qualifications, and revision instructions when present; integrate that analysis into the proposal instead of drafting blank or generic content.',
      `For ${proposeAction}, emit the proposal content as top-level payload fields, not payload.mutations; use payload: ${JSON.stringify(proposalPayload)} and do not emit an empty proposed_text.`,
      `Keep approval authoring bounded: use ${confirmationLoopSummaryPath(loop)} progress counts and active_item only, not the full ${loop.collection} collection.`,
      'never write item statuses yourself; status changes are deterministic reaction-owned state.',
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
    const proposalFields = confirmationLoopProposalFields(loop, lifecycle);
    const contentMutations = proposalFields
      .map((field) => ({
        op: 'MSet',
        path: confirmationLoopProposalFieldPath(loop, field),
        value: '',
        from_arg: field,
      }));
    const proposalPayload = confirmationLoopProposalPayloadExample(loop, lifecycle);
    actionMap[actionName] = {
      description: `Propose ${lifecycle.item_label} content for user confirmation. The runtime selects which ${lifecycle.item_label} is under review; do not choose a different item. You must author the ${lifecycle.item_label} content in proposed_text using top-level payload fields, for example payload: ${JSON.stringify(proposalPayload)}. Emit top-level payload fields, not payload.mutations, and do not emit an empty proposed_text.`,
      arg_schema: Object.fromEntries(proposalFields.map((field) => [
        field,
        { type: 'string', required: true },
      ])),
      mutations: [
        { op: 'MSet', path: confirmationLoopRawPayloadMutationsPath(loop), value: [], from_arg: 'mutations' },
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

function applyConfirmationLoopCompletionActions(
  actionMap: MutableRecord,
  loops: ConfirmationLoopDescriptor[],
  lifecycle: CollectionLifecycleDescriptor | undefined,
  transitionActions: TransitionAction[],
): void {
  if (!lifecycle) {
    return;
  }
  for (const action of confirmationLoopCompletionTransitionActions(loops, transitionActions)) {
    if (Object.prototype.hasOwnProperty.call(actionMap, action.name)) {
      throw new Error(`confirmation_loop completion action collides with generated action_map: ${action.name}`);
    }
    actionMap[action.name] = {
      description: `Advance from confirmation-loop stage ${action.source} to ${action.target} after every ${lifecycle.item_label} is terminal. This action does not open another approval prompt.`,
      mutations: [],
      channel: 'widget_output',
    };
  }
}

function applyConfirmationLoopCompletionProceedTo(
  proceedTo: MutableRecord,
  loops: ConfirmationLoopDescriptor[],
  transitionActions: TransitionAction[],
): void {
  for (const action of confirmationLoopCompletionTransitionActions(loops, transitionActions)) {
    const existing = proceedTo[action.name];
    if (existing !== undefined && existing !== action.target) {
      throw new Error(`confirmation_loop completion action ${action.name} has conflicting proceeds_to target`);
    }
    proceedTo[action.name] = action.target;
  }
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
    schema[`${confirmationLoopSummaryPath(loop)}.active_item`] = 'object';
    schema[confirmationLoopActiveItemIdPath(loop)] = 'any';
    schema[confirmationLoopHasProposedItemPath(loop)] = 'boolean';
    schema[confirmationLoopStatusBucketsPath(loop)] = 'object';
    for (const status of lifecycle.statuses) {
      const bucketPath = confirmationLoopStatusBucketPath(loop, status.name);
      schema[bucketPath] = 'array';
      schema[`${bucketPath}.*`] = 'object';
      for (const [fieldName, fieldType] of Object.entries(lifecycle.item.schema)) {
        schema[`${bucketPath}.*.${fieldName}`] = fieldType;
      }
      schema[`${bucketPath}.*.${lifecycle.item.status_field}`] = 'string';
    }
    schema[`${confirmationLoopSummaryPath(loop)}.total_items`] = 'number';
    schema[`${confirmationLoopSummaryPath(loop)}.terminal_items`] = 'number';
    schema[`${confirmationLoopSummaryPath(loop)}.pending_items`] = 'number';
    schema[`${confirmationLoopSummaryPath(loop)}.proposed_items`] = 'number';
    schema[`${confirmationLoopSummaryPath(loop)}.current_index`] = 'number';
    for (const field of confirmationLoopActiveItemFields(loop, lifecycle)) {
      schema[`${confirmationLoopSummaryPath(loop)}.active_item.${field}`] = 'string';
    }
    schema[confirmationLoopDemotionCounterPath(loop)] = 'number';
    schema[confirmationLoopAppliedDecisionPath(loop)] = 'string';
    schema[confirmationLoopProposalPath(loop)] = 'object';
    schema[confirmationLoopRawPayloadMutationsPath(loop)] = 'any';
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

function confirmationLoopSummarizeReactionName(loop: ConfirmationLoopDescriptor): string {
  return `summarize_${safeIdentifier(loop.stage)}_approval`;
}

function confirmationLoopMirrorProposalReactionName(loop: ConfirmationLoopDescriptor): string {
  return `mirror_${safeIdentifier(loop.stage)}_proposal_payload`;
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

function confirmationLoopCompletionTransitionActions(
  loops: ConfirmationLoopDescriptor[],
  transitionActions: TransitionAction[],
): TransitionAction[] {
  const seen = new Set<string>();
  return loops.flatMap((loop) =>
    confirmationLoopCompletionTransitionActionsForLoop(loop, transitionActions)
      .filter((action) => {
        if (seen.has(action.name)) {
          return false;
        }
        seen.add(action.name);
        return true;
      }));
}

function confirmationLoopCompletionTransitionActionsForLoop(
  loop: ConfirmationLoopDescriptor,
  transitionActions: TransitionAction[],
): TransitionAction[] {
  return transitionActions.filter((action) =>
    action.source === loop.stage &&
    action.guardField === loop.aggregate.guard_field);
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

function confirmationLoopActiveItemIdPath(loop: ConfirmationLoopDescriptor): string {
  return `${confirmationLoopSummaryPath(loop)}.active_item_id`;
}

function confirmationLoopHasProposedItemPath(loop: ConfirmationLoopDescriptor): string {
  return `${confirmationLoopSummaryPath(loop)}.has_proposed_item`;
}

function confirmationLoopStatusBucketsPath(loop: ConfirmationLoopDescriptor): string {
  return `${confirmationLoopSummaryPath(loop)}.status_buckets`;
}

function confirmationLoopStatusBucketPath(loop: ConfirmationLoopDescriptor, status: string): string {
  return `${confirmationLoopStatusBucketsPath(loop)}.${safeIdentifier(status)}`;
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

function confirmationLoopRawPayloadMutationsPath(loop: ConfirmationLoopDescriptor): string {
  return `${confirmationLoopProposalPath(loop)}.raw_payload_mutations`;
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
  const fields = Object.keys(lifecycle.item.schema)
    .filter((field) =>
      field !== idField &&
      field !== titleField &&
      field !== statusField &&
      !instructionFields.has(field));
  return unique([
    ...fields.filter((field) => field === 'proposed_text'),
    ...fields.filter((field) => field !== 'proposed_text'),
  ]);
}

function confirmationLoopProposalPayloadExample(
  loop: ConfirmationLoopDescriptor,
  lifecycle: CollectionLifecycleDescriptor,
): Record<string, string> {
  return Object.fromEntries(
    confirmationLoopProposalFields(loop, lifecycle).map((field) => [
      field,
      field === 'proposed_text' ? '<the drafted section text>' : '...',
    ]),
  );
}

function confirmationLoopActiveItemFields(
  loop: ConfirmationLoopDescriptor,
  lifecycle: CollectionLifecycleDescriptor,
): string[] {
  const idField = loop.item_id_field ?? lifecycle.item.id_field;
  const titleField = loop.item_title_field ?? 'title';
  return unique([
    idField,
    titleField,
    lifecycle.item.status_field,
    ...confirmationLoopProposalFields(loop, lifecycle),
    ...confirmationLoopInstructionFields(loop),
  ]);
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
    descriptors.push({
      stage,
      kind,
      title: exportTitle(programName, kind),
      artifactType: artifactTypeForExportKind(kind),
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
  if (demands.some((demand) => demand.capability === 'export_pdf_report')) {
    demandedKinds.add('export_pdf');
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

function exportTitle(programName: string, kind: ExportStageDescriptor['kind']): string {
  if (kind === 'export_docx') return `${programName} DOCX Export`;
  if (kind === 'export_html') return `${programName} HTML Export`;
  return `${programName} PDF Report`;
}

function artifactTypeForExportKind(kind: ExportStageDescriptor['kind']): ExportStageDescriptor['artifactType'] {
  if (kind === 'export_docx') return 'docx_export';
  if (kind === 'export_html') return 'html_export';
  return 'pdf_report';
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
    ...(descriptors.some((descriptor) => descriptor.kind === 'export_pdf') || demands.some((demand) => demand.capability === 'export_pdf_report')
      ? { pdf: true }
      : {}),
  };
  return surfaces;
}

function normalizeExportStageContracts(
  stages: Stage[],
  descriptors: readonly ExportStageDescriptor[],
  domain: Record<string, unknown>,
): Stage[] {
  if (descriptors.length === 0) {
    return stages;
  }
  const descriptorsByStage = new Map(descriptors.map((descriptor) => [descriptor.stage, descriptor]));
  const exportInputDomain = staticInputDomainForDomain(domain);
  return stages.map((stage) => {
    const descriptor = descriptorsByStage.get(stage.slug);
    if (!descriptor || !stage.domain_spec) {
      return stage;
    }
    const inputDomain = descriptor.kind === 'export_pdf' && Object.keys(exportInputDomain).length > 0
      ? { input_domain: mergeInputDomain(stage.domain_spec.input_domain, exportInputDomain) }
      : {};
    return {
      ...stage,
      domain_spec: {
        ...stage.domain_spec,
        produces: exportStageProducesContract(descriptor.kind),
        ...inputDomain,
      },
    };
  });
}

function bindPersistenceConfigToStages(
  stages: Stage[],
  stageClassificationBySlug: ReadonlyMap<string, ClassifiedStage>,
  domain: Record<string, unknown>,
): Stage[] {
  const inputDomain = staticInputDomainForDomain(domain);
  if (Object.keys(inputDomain).length === 0) {
    return stages;
  }
  return stages.map((stage) => {
    const classification = stageClassificationBySlug.get(stage.slug);
    if (
      !stage.domain_spec ||
      (classification?.integration_name !== 'persistence' && classification?.connector_slug !== 'persistence')
    ) {
      return stage;
    }
    return {
      ...stage,
      domain_spec: {
        ...stage.domain_spec,
        input_domain: mergeInputDomain(stage.domain_spec.input_domain, inputDomain),
      },
    };
  });
}

function staticInputDomainForDomain(domain: Record<string, unknown>): Record<string, unknown> {
  const config = optionalRecordDomainValue(domain, 'config');
  const guardConfig = optionalRecordDomainValue(domain, 'guard_config');
  const purpose = config && typeof config.purpose === 'string' && config.purpose.length > 0
    ? config.purpose
    : undefined;
  return {
    ...(config ? { config } : {}),
    ...(purpose ? { purpose } : {}),
    ...(guardConfig ? { guard_config: guardConfig } : {}),
  };
}

function mergeInputDomain(
  existing: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
): Record<string, unknown> {
  return mergeRecords(existing ?? {}, next);
}

function mergeRecords(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    const previous = merged[key];
    merged[key] = isRecord(previous) && isRecord(value)
      ? mergeRecords(previous, value)
      : value;
  }
  return merged;
}

function exportStageProducesContract(kind: ExportStageDescriptor['kind']): Record<string, unknown> {
  if (kind === 'export_docx') {
    return {
      result_json: {
        stage: 'string',
        docx_base64: 'string',
        docx_bytes: 'number',
        sha256: 'string',
        section_count: 'number',
      },
      items_json: ['docx_export:<sha256>'],
    };
  }
  if (kind === 'export_pdf') {
    return {
      result_json: {
        stage: 'string',
        pdf_base64: 'string',
        pdf_bytes: 'number',
        sha256: 'string',
        section_count: 'number',
      },
      items_json: ['pdf_report:<sha256>'],
    };
  }
  return {
    result_json: {
      stage: 'string',
      html: 'string',
      html_bytes: 'number',
      sha256: 'string',
      section_count: 'number',
    },
    items_json: ['html_export:<sha256>'],
  };
}

function stageArtifactDescriptorsFor(stages: Stage[]): StageArtifactDescriptor[] {
  return stages.flatMap((stage) => {
    if (!stage.emit_artifact || stage.is_bootstrap === true || stage.is_terminal === true) {
      return [];
    }
    const descriptors = Array.isArray(stage.emit_artifact)
      ? stage.emit_artifact
      : [stage.emit_artifact];
    return descriptors.map((descriptor, index) =>
      normalizeStageArtifactDescriptor(stage.slug, descriptor, `stage ${stage.slug} emit_artifact${descriptors.length > 1 ? `[${index}]` : ''}`));
  });
}

function normalizeStageArtifactDescriptor(
  stage: string,
  value: StageArtifactDescriptorInput,
  label: string,
): StageArtifactDescriptor {
  const descriptor = requiredRecord(value, label);
  const artifactType = requiredString(descriptor.type, `${label}.type`);
  const title = requiredString(descriptor.title, `${label}.title`);
  const payloadRef = optionalStringValue(descriptor.payload_ref, `${label}.payload_ref`) ?? `${stage}.output`;
  return {
    stage,
    artifactType,
    title,
    summary: optionalStringValue(descriptor.summary, `${label}.summary`) ?? `Generated artifact emitted from ${stage}.`,
    payloadRef,
  };
}

function hasExportSurfaces(surfaces: ExportSurfaces): boolean {
  return surfaces.docx === true || surfaces.html === true || surfaces.pdf === true || surfaces.diff === true;
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

function capabilityGapsForWebNavigationStages(stages: ClassifiedStage[]): CapabilityGap[] {
  return stages
    .filter((stage) => stage.integration_gap === true && (stage.integration_name === 'web_navigation' || stage.connector_slug === 'web-navigation'))
    .map((stage) => ({
      capability: 'web_navigation_guarded',
      stage: stage.slug,
      connector_slug: 'web-navigation',
      message: 'guarded browser navigation is host-side; implement WebNavigationHostConnector (pgas-web driver)',
    }));
}

function capabilityGapsForPersistenceStages(stages: ClassifiedStage[]): CapabilityGap[] {
  return stages
    .filter((stage) => stage.integration_gap === true && (stage.integration_name === 'persistence' || stage.connector_slug === 'persistence'))
    .map((stage) => ({
      capability: 'cross_session_persistence',
      stage: stage.slug,
      connector_slug: 'persistence',
      message: 'cross-session store is host-side; implement PersistenceHostConnector (the CRM store)',
    }));
}

function capabilityGapsForPdfReportExportDescriptors(descriptors: readonly ExportStageDescriptor[]): CapabilityGap[] {
  return descriptors
    .filter((descriptor) => descriptor.kind === 'export_pdf')
    .map((descriptor) => ({
      capability: 'export_pdf_report',
      stage: descriptor.stage,
      connector_slug: 'pdf-report',
      message: 'SOTA PDF rendering is host-side; foundry ships renderProfile + PdfReportHostConnector contract + mock',
    }));
}

function bindWebNavigationGuardContextToStages(
  stages: Stage[],
  stageClassificationBySlug: ReadonlyMap<string, ClassifiedStage>,
  domain: Record<string, unknown>,
  purpose: string,
  delegationChildren: readonly DelegationChildDescriptor[] = [],
): Stage[] {
  const guardConfig = webNavigationGuardConfigRecordForDomain(domain);
  if (!guardConfig) {
    return stages;
  }
  const webNavigationSlugs = new Set(
    stages
      .filter((stage) => isWebNavigationClassifiedStage(stageClassificationBySlug.get(stage.slug)))
      .map((stage) => stage.slug),
  );
  if (webNavigationSlugs.size === 0) {
    return stages;
  }

  const sources = webNavigationSourcesForDomain(domain);
  const guardContext = webNavigationGuardContextFromConfig(guardConfig, sources);
  const extractionSchema = webNavigationExtractionSchemaForDomain(domain, stages);
  const sourceFanOutStages = new Set(
    delegationChildren
      .filter((child) => sourceConfigFanOutDescriptor(child) !== undefined)
      .map((child) => child.stage),
  );

  return stages.map((stage) => webNavigationSlugs.has(stage.slug)
    ? {
        ...stage,
        domain_spec: webNavigationGuardBoundDomainSpec(stage, {
          sources,
          purpose,
          extractionSchema,
          guardContext,
          sourceFanOut: sourceFanOutStages.has(stage.slug),
        }),
      }
    : stage);
}

function webNavigationGuardBoundDomainSpec(
  stage: Stage,
  input: {
    sources: WebNavigationSourceConfig[];
    purpose: string;
    extractionSchema: Record<string, string>;
    guardContext: WebNavigationGuardContext;
    sourceFanOut?: boolean;
  },
): StageDomainSpec {
  const base = stage.domain_spec ?? {
    reads: ['source', 'purpose', 'extraction_schema', 'GuardContext'],
    produces: {},
    rules: ['Call WebNavigationHostConnector.navigate_and_extract for configured public sources.'],
    invariants: ['Every connector audit entry is persisted in result_json.audit.'],
  };
  return {
    ...base,
    reads: unique([
      ...base.reads,
      ...(input.sourceFanOut
        ? [
            LEAD_RESEARCH_SOURCE_FAN_OUT_SOURCE_PATH,
            LEAD_RESEARCH_SOURCE_FAN_OUT_CURRENT_PATH,
            `${LEAD_RESEARCH_SOURCE_FAN_OUT_CURRENT_PATH}.url`,
            `${LEAD_RESEARCH_SOURCE_FAN_OUT_CURRENT_PATH}.allowed_domains`,
          ]
        : []),
      'source',
      'purpose',
      'extraction_schema',
      'GuardContext',
    ]),
    produces: {
      ...base.produces,
      result_json: {
        items: 'ExtractedItem[]',
        pages_visited: 'number',
        audit: 'NavAuditEntry[]',
      },
    },
    rules: unique([
      ...base.rules,
      'Call only WebNavigationHostConnector.navigate_and_extract for web I/O.',
      'No spend or auth verbs are modeled as callable actions.',
    ]),
    invariants: unique([
      ...base.invariants,
      'GuardContext is assembled mechanically from guard_config before the navigation connector runs.',
      'The navigation stage result persists audit[] through its deterministic result_path.',
    ]),
    input_domain: {
      source: input.sources[0]?.url ?? '',
      ...(input.sourceFanOut ? {
        current_source: input.sources[0] ?? {},
        work: {
          config: { sources: input.sources },
          current_source: input.sources[0] ?? {},
        },
      } : {}),
      sources: input.sources,
      purpose: input.purpose,
      extraction_schema: input.extractionSchema,
      GuardContext: input.guardContext,
      guard_context: input.guardContext,
    },
  } as StageDomainSpec;
}

function webNavigationGuardConfigRecordForDomain(domain: Record<string, unknown>): Record<string, unknown> | undefined {
  return optionalRecordDomainValue(domain, 'guard_config')
    ?? optionalRecordDomainValue(domain, 'config.guard_config')
    ?? optionalRecordDomainValue(domain, 'intake.guard_config_json');
}

function webNavigationSourcesForDomain(domain: Record<string, unknown>): WebNavigationSourceConfig[] {
  const rawSources = optionalArrayDomainValue(domain, 'config.sources')
    ?? optionalArrayDomainValue(domain, 'intake.sources_json')
    ?? [];
  return rawSources
    .map((source) => webNavigationSourceConfigFromValue(source))
    .filter((source): source is WebNavigationSourceConfig => source !== undefined);
}

function webNavigationSourceConfigFromValue(value: unknown): WebNavigationSourceConfig | undefined {
  if (typeof value === 'string') {
    const url = value.trim();
    return url.length > 0 ? { url } : undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const urlValue = typeof value.url === 'string'
    ? value.url
    : typeof value.source === 'string'
      ? value.source
      : '';
  const url = urlValue.trim();
  if (!url) {
    return undefined;
  }
  const allowedDomains = stringListFromUnknown(value.allowed_domains);
  return {
    url,
    ...(allowedDomains.length > 0 ? { allowed_domains: allowedDomains } : {}),
  };
}

function webNavigationGuardContextFromConfig(
  config: Record<string, unknown>,
  sources: readonly WebNavigationSourceConfig[],
): WebNavigationGuardContext {
  const explicitAllowedDomains = stringListFromUnknown(config.allowed_domains);
  const derivedAllowedDomains = unique(
    sources.flatMap((source) => [
      ...(source.allowed_domains ?? []),
      ...(registrableDomainFromUrlLike(source.url) ? [registrableDomainFromUrlLike(source.url) as string] : []),
    ]),
  );
  return {
    allowed_domains: unique(explicitAllowedDomains.length > 0 ? explicitAllowedDomains : derivedAllowedDomains),
    max_depth: nonNegativeIntegerFromConfig(config.max_depth, DEFAULT_WEB_NAVIGATION_GUARD_CONTEXT.max_depth),
    max_pages: nonNegativeIntegerFromConfig(config.max_pages, DEFAULT_WEB_NAVIGATION_GUARD_CONTEXT.max_pages),
    max_follow_links: nonNegativeIntegerFromConfig(config.max_follow_links, DEFAULT_WEB_NAVIGATION_GUARD_CONTEXT.max_follow_links),
    min_delay_ms: nonNegativeIntegerFromConfig(config.min_delay_ms, DEFAULT_WEB_NAVIGATION_GUARD_CONTEXT.min_delay_ms),
    max_concurrency: positiveIntegerFromConfig(config.max_concurrency, DEFAULT_WEB_NAVIGATION_GUARD_CONTEXT.max_concurrency),
  };
}

function webNavigationExtractionSchemaForDomain(
  domain: Record<string, unknown>,
  stages: readonly Stage[],
): Record<string, string> {
  return recordOfStrings(domainValue(domain, 'config.extraction_schema'))
    ?? recordOfStrings(jsonDomainValue(domain, 'intake.extraction_schema_json'))
    ?? stages
      .map((stage) => firstArrayObjectStringSchema(stage.domain_spec?.produces))
      .find((schema): schema is Record<string, string> => schema !== undefined)
    ?? {};
}

function optionalRecordDomainValue(domain: Record<string, unknown>, path: string): Record<string, unknown> | undefined {
  const value = jsonDomainValue(domain, path);
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object when present`);
  }
  return value;
}

function optionalArrayDomainValue(domain: Record<string, unknown>, path: string): unknown[] | undefined {
  const value = jsonDomainValue(domain, path);
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array when present`);
  }
  return value;
}

function jsonDomainValue(domain: Record<string, unknown>, path: string): unknown {
  const value = domainValue(domain, path);
  if (typeof value !== 'string') {
    return value;
  }
  return JSON.parse(value) as unknown;
}

function firstArrayObjectStringSchema(value: unknown): Record<string, string> | undefined {
  const direct = recordOfStringsFromArrayObject(value);
  if (direct) {
    return direct;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  for (const child of Object.values(value)) {
    const nested = firstArrayObjectStringSchema(child);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function recordOfStringsFromArrayObject(value: unknown): Record<string, string> | undefined {
  if (!Array.isArray(value) || value.length !== 1) {
    return undefined;
  }
  return recordOfStrings(value[0]);
}

function recordOfStrings(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value);
  if (entries.length === 0 || !entries.every(([, entryValue]) => typeof entryValue === 'string' && entryValue.trim().length > 0)) {
    return undefined;
  }
  return Object.fromEntries(entries.map(([key, entryValue]) => [key, (entryValue as string).trim()]));
}

function stringListFromUnknown(value: unknown): string[] {
  return Array.isArray(value)
    ? unique(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))
    : [];
}

function nonNegativeIntegerFromConfig(value: unknown, fallback: number): number {
  const parsed = numberFromConfig(value);
  return parsed === undefined ? fallback : Math.max(0, Math.floor(parsed));
}

function positiveIntegerFromConfig(value: unknown, fallback: number): number {
  const parsed = numberFromConfig(value);
  return parsed === undefined ? fallback : Math.max(1, Math.floor(parsed));
}

function numberFromConfig(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function registrableDomainFromUrlLike(value: string): string | undefined {
  try {
    return registrableDomainFromHostname(new URL(value).hostname);
  } catch {
    return registrableDomainFromHostname(value);
  }
}

function registrableDomainFromHostname(value: string): string | undefined {
  const hostname = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//u, '')
    .split('/')[0]
    ?.replace(/\.$/u, '');
  if (!hostname) {
    return undefined;
  }
  const labels = hostname.split('.').filter(Boolean);
  if (labels.length < 2) {
    return hostname;
  }
  return labels.slice(-2).join('.');
}

function assertNoForbiddenLeadResearchWebVocabulary(
  spec: MutableRecord,
  slug: string,
  stageClassification: readonly ClassifiedStage[],
  domain: Record<string, unknown>,
): void {
  if (!isLeadResearchWebNavigationShape(slug, stageClassification, domain)) {
    return;
  }
  const names = collectSpecActionToolVocabularyNames(spec);
  for (const name of names) {
    const forbidden = FORBIDDEN_LEAD_RESEARCH_WEB_IO_NAMES.find((candidate) =>
      actionOrToolNameContainsCapability(name, candidate));
    if (forbidden) {
      throw new Error(`lead-research web-navigation vocabulary must not expose ${forbidden} action/tool name: ${name}`);
    }
  }
}

function isLeadResearchWebNavigationShape(
  slug: string,
  stageClassification: readonly ClassifiedStage[],
  domain: Record<string, unknown>,
): boolean {
  const hasWebNavigationStage = stageClassification.some(isWebNavigationClassifiedStage);
  if (!hasWebNavigationStage) {
    return false;
  }
  return slug === 'lead-research-agent' || webNavigationGuardConfigRecordForDomain(domain) !== undefined;
}

function isWebNavigationClassifiedStage(stage: ClassifiedStage | undefined): boolean {
  return stage?.integration_name === 'web_navigation' || stage?.connector_slug === 'web-navigation';
}

function collectSpecActionToolVocabularyNames(spec: MutableRecord): string[] {
  const names: string[] = [];
  if (isRecord(spec.action_map)) {
    names.push(...Object.keys(spec.action_map));
  }
  if (isRecord(spec.tools)) {
    names.push(...Object.keys(spec.tools));
  }
  if (isRecord(spec.proceeds_to)) {
    names.push(...Object.keys(spec.proceeds_to));
  }
  if (isRecord(spec.modes)) {
    for (const mode of Object.values(spec.modes)) {
      if (!isRecord(mode) || !Array.isArray(mode.vocabulary)) {
        continue;
      }
      names.push(...mode.vocabulary.filter((item): item is string => typeof item === 'string'));
    }
  }
  return unique(names);
}

function actionOrToolNameContainsCapability(name: string, capability: string): boolean {
  const escaped = capability.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'u').test(name.toLowerCase());
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
  if (raw === 'export_pdf' || raw === 'pdf_export' || raw === 'export_pdf_report' || raw === 'pdf_report') return 'export_pdf';
  return undefined;
}

function chooseExportStageForDemand(
  stages: Stage[],
  kind: ExportStageDescriptor['kind'],
  usedStages: ReadonlySet<string>,
): Stage | undefined {
  const candidates = stages.filter((stage) => !stage.is_bootstrap && !stage.is_terminal && !usedStages.has(stage.slug));
  const wanted = kind === 'export_docx'
    ? /(?:docx|word|export|render|assemble|format)/u
    : kind === 'export_html'
      ? /(?:html|export|render|assemble|format)/u
      : /(?:pdf|report|export|render|assemble|format)/u;
  return candidates.find((stage) => wanted.test(exportStageHaystack(stage)));
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
    if (stage.integration_name === 'web_navigation' || stage.connector_slug === 'web-navigation') {
      return {
        ...stage,
        adapter_kind: 'in_memory_mock',
        integration_gap: true,
        integration_name: 'web_navigation',
        connector_slug: 'web-navigation',
        audit_note: stage.audit_note ?? 'guarded browser navigation is host-side; implement WebNavigationHostConnector (pgas-web driver)',
        rationale: `${stage.rationale} Guarded browser navigation remains a host connector gap.`,
      };
    }
    if (stage.integration_name === 'persistence' || stage.connector_slug === 'persistence') {
      return {
        ...stage,
        adapter_kind: 'in_memory_mock',
        integration_gap: true,
        integration_name: 'persistence',
        connector_slug: 'persistence',
        audit_note: stage.audit_note ?? 'cross-session store is host-side; implement PersistenceHostConnector (the CRM store)',
        rationale: `${stage.rationale} Cross-session persistence remains a host connector gap.`,
      };
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

// Confirmation-loop completion actions are declarative topology actions: the spec
// advertises them at all_terminal and maps them through proceeds_to, but generated
// handler/tool code must keep suppressing loop-source transition actions. Otherwise
// the generated program emits an orphaned complete_<stage> handler/tool and the
// engine's validateSpecWiring rejects it at boot (HANDLER_NO_ACTION).
function codegenStageActions(
  transitionActions: TransitionAction[],
  confirmationLoops: ConfirmationLoopDescriptor[],
): TransitionAction[] {
  const loopStageNames = new Set(confirmationLoops.map((loop) => loop.stage));
  return transitionActions.filter(
    (action) => action.name !== 'begin_work' && !loopStageNames.has(action.source) && !isExportTransitionAction(action),
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
    stageResultFieldsBySlug: ReadonlyMap<string, readonly string[]>;
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
  const exportActions = exportTransitionActions(transitionActions);
  const lifecycleTransitions = options.collectionLifecycle
    ? collectionLifecycleLlmTransitions(options.collectionLifecycle)
    : [];
  const usesIndexedCollectionLifecycle = options.includeReactionHandlers &&
    options.collectionLifecycle?.storage.representation === 'indexed_array';
  const usesConfirmationLoopHandlers = options.includeReactionHandlers && confirmationLoops.length > 0;
  const usesDelegationHandlers = options.includeReactionHandlers &&
    options.delegationChildren.some((child) => !delegationSettleFlagsAreDeclarative(child, options.documents));
  const usesDocumentHandlers = options.documents !== undefined;
  const usesDocumentReactionHandlers = options.includeReactionHandlers && options.documents !== undefined;
  const usesDocumentFanOutHandlers = options.includeReactionHandlers &&
    options.documents !== undefined &&
    options.delegationChildren.some((child) => childHasDocumentFanOut(child, options.documents));
  const usesDocxExtractor = documentsDemandsSelfContainedDocx(options.documents);
  const bodyActions = unique([
    ...stageActions
      .filter((action) => action.archetype !== 'llm-reasoning' && !isConversationalHubTransitionAction(action))
      .map((action) => action.source),
    ...exportActions.map((action) => action.source),
  ]);
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
  const notebookHandlers = `  async record_note(payload) {
    return {
      kind: 'note_recorded',
      payload,
    };
  },

  async pin_note(payload) {
    return {
      kind: 'note_pinned',
      payload,
    };
  },

  async unpin_note(payload) {
    return {
      kind: 'note_unpinned',
      payload,
    };
  },

  async delete_note(payload) {
    return {
      kind: 'note_deleted',
      payload,
    };
  },`;
  const sessionControlHandlers = SESSION_CONTROL_ACTIONS
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
        const stringArrayFieldNames = reasoningContract.result_schema.fields
          .filter((field) => field.type === 'string_array')
          .map((field) => field.name);
        const fieldResolvers = coreFieldNames
          .map((name) => `      ${name}: normalizeReasoningFieldValue(
        resolveDomainValue<unknown>(
          payload as HandlerPayload,
          ${tsString(name)},
          resolveDomainValue<unknown>(
            payload as HandlerPayload,
            ${tsString(`${action.source}.raw_result_fields.${name}`)},
            resolveReasoningRecordField(
              aggregateResultFields,
              ${tsString(name)},
              resolveDomainValue<unknown>(payload as HandlerPayload, ${tsString(`${action.source}.result.${name}`)}, null),
            ),
          ),
        ),
        ${tsString(name)},
        [${stringArrayFieldNames.map(tsString).join(', ')}],
      ),`)
          .join('\n');
        return `  async ${action.name}(payload) {
    const rawResultJson = resolveDomainValue<unknown>(
      payload as HandlerPayload,
      'result_json',
      resolveDomainValue<unknown>(payload as HandlerPayload, ${tsString(`${action.source}.raw_result_json`)}, undefined),
    );
    const aggregateResultFields = extractReasoningResultFields(rawResultJson);
    const fields = {
${fieldResolvers}
    };
    const resultJson = normalizeReasoningResultJson(
      rawResultJson,
      fields,
      [${stringArrayFieldNames.map(tsString).join(', ')}],
    );
    const itemsJson = normalizeReasoningItemsJson(
      resolveDomainValue<unknown>(
        payload as HandlerPayload,
        'items_json',
        resolveDomainValue<unknown>(payload as HandlerPayload, ${tsString(`${action.source}.raw_items_json`)}, undefined),
      ),
      [${reasoningContract.items_schema.templates.map(tsString).join(', ')}],
      fields,
      [${stringArrayFieldNames.map(tsString).join(', ')}],
    );
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
    if (isConversationalHubTransitionAction(action)) {
      return `  async ${action.name}(payload) {
    return {
      kind: 'conversational_hub_transition',
      action: ${tsString(action.name)},
      stage: ${tsString(action.source)},
      target: ${tsString(action.target)},
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
  const conversationalHubResetReactionEntries = options.includeReactionHandlers
    ? renderConversationalHubGuardResetReactionEntries(transitionActions)
    : '';
  const usesLeadResearchHostOutputMirrorHandlers = options.includeReactionHandlers &&
    options.delegationChildren.some(childHasSourceConfigFanOut);
  const stageOutputMirrorHandlerStages = unique([...bodyActions, ...contractActionSources]);
  const stageResultFieldMirrorReactionEntries = options.includeReactionHandlers
    ? stageOutputMirrorHandlerStages.filter((stage) => options.flatMirrorStages.has(stage)).map((stage) => {
        const resultFields = options.stageResultFieldsBySlug.get(stage) ?? [];
        if (resultFields.length === 0) {
          return '';
        }
        return `,
  [${tsString(stageResultFieldMirrorReactionName(stage))}, (snapshot) => mirrorStageResultFields(snapshot, ${tsString(`${stage}.output`)}, ${tsString(`${stage}.result`)}, [${resultFields.map(tsString).join(', ')}])]`;
      }).join('')
    : '';
  const leadResearchHostOutputMirrorReactionEntries = usesLeadResearchHostOutputMirrorHandlers
    ? `,
  ['mirror_lead_research_host_outputs', (snapshot) => mirrorLeadResearchHostOutputs(snapshot)]`
    : '';
  const reasoningFieldMirrorReactionEntries = options.includeReactionHandlers
    ? [...contractActionSources].map((stage) => {
        const contract = reasoningContractsBySlug.get(stage);
        const fieldNames = contract?.result_schema.fields
          .filter((field) => field.type !== 'record_array')
          .map((field) => field.name) ?? [];
        const stringArrayFieldNames = contract?.result_schema.fields
          .filter((field) => field.type === 'string_array')
          .map((field) => field.name) ?? [];
        return `,
  [${tsString(reasoningFieldMirrorReactionName(stage))}, (snapshot) => mirrorReasoningResultFields(snapshot, ${tsString(`${stage}.output`)}, ${tsString(`${stage}.raw_result_fields`)}, ${tsString(`${stage}.raw_result_json`)}, ${tsString(`${stage}.result`)}, [${fieldNames.map(tsString).join(', ')}], [${stringArrayFieldNames.map(tsString).join(', ')}])]`;
      }).join('')
    : '';
  const hasReactionEntries = Boolean(
    stageResultFieldMirrorReactionEntries ||
    leadResearchHostOutputMirrorReactionEntries ||
    reasoningFieldMirrorReactionEntries ||
    conversationalHubResetReactionEntries ||
    usesConfirmationLoopHandlers ||
    usesDelegationHandlers ||
    usesDocumentReactionHandlers ||
    usesDocumentFanOutHandlers,
  );
  const reactionImport = options.includeReactionHandlers
    ? `ReactionHandler, ${hasReactionEntries ? 'ReactionResult, ' : ''}`
    : '';
  const reactionMapConstructor = hasReactionEntries ? 'new Map<string, ReactionHandler>' : 'new Map';
  const lifecycleReactionEntries = options.includeReactionHandlers && options.collectionLifecycle
    ? renderCollectionLifecycleReactionEntry(options.collectionLifecycle)
    : '';
  const confirmationReactionEntries = usesConfirmationLoopHandlers && options.collectionLifecycle
    ? renderConfirmationLoopReactionEntries(confirmationLoops, options.collectionLifecycle)
    : '';
  const delegationReactionEntries = usesDelegationHandlers
    ? renderDelegationReactionEntries(options.delegationChildren, options.documents)
    : '';
  const documentReactionEntries = usesDocumentReactionHandlers && options.documents
    ? renderDocumentReactionEntries(options.documents)
    : '';
  const exportHookAdapter = exportActions.length > 0
    ? renderExportHookAdapter(exportActions)
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
    ? `\n\nexport const reactionHandlers: Map<string, ReactionHandler> = ${reactionMapConstructor}([\n  ['capture_initial_entry_input', (snapshot) => {\n    if (typeof snapshot.get(${tsString(options.initialEntryPath)}) === 'string') {\n      return undefined;\n    }\n    const current = snapshot.get(${tsString(options.entryPath)});\n    return typeof current === 'string'\n      ? { mutations: [{ op: 'MSet' as const, path: ${tsString(options.initialEntryPath)}, value: current }] }\n      : undefined;\n  }]${stageResultFieldMirrorReactionEntries}${leadResearchHostOutputMirrorReactionEntries}${reasoningFieldMirrorReactionEntries}${conversationalHubResetReactionEntries}${lifecycleReactionEntries}${confirmationReactionEntries}${delegationReactionEntries}${documentReactionEntries},\n]);${stageResultFieldMirrorReactionEntries ? stageResultFieldMirrorReactionHelper() : ''}${leadResearchHostOutputMirrorReactionEntries ? leadResearchHostOutputMirrorReactionHelper() : ''}${reasoningFieldMirrorReactionEntries ? reasoningFieldMirrorReactionHelper() : ''}${lifecycleReactionHelper}${confirmationReactionHelper}${delegationReactionHelper}`
    : '';
  const handlerAdapterOverrides = exportActions.length > 0
    ? `\n\nexport function createHandlerAdapterOverrides() {\n  return {\n    ${tsString(EXPORT_HOOK_CHANNEL)}: createExportHookAdapter(),\n  };\n}`
    : '\n\nexport function createHandlerAdapterOverrides() {\n  return {};\n}';
  const conformanceHelper = contractActionSources.size > 0
    ? `

// Observability only: typed <stage>.result.<field> paths are mirrored from
// normalized handler output after tolerant raw capture. This envelope makes
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
}

function normalizeReasoningFieldValue(
  value: unknown,
  fieldName: string,
  stringArrayFields: readonly string[],
): unknown {
  let candidate = value;
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    const record = candidate as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1 && Object.prototype.hasOwnProperty.call(record, fieldName)) {
      candidate = record[fieldName];
    }
  }
  if (stringArrayFields.includes(fieldName) && Array.isArray(candidate)) {
    return JSON.stringify(candidate);
  }
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    return JSON.stringify(candidate);
  }
  return candidate;
}

function extractReasoningResultFields(value: unknown): Record<string, unknown> {
  let candidate = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return {};
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return {};
  }
  return candidate as Record<string, unknown>;
}

function resolveReasoningRecordField(
  record: Record<string, unknown>,
  fieldName: string,
  fallback: unknown,
): unknown {
  return Object.prototype.hasOwnProperty.call(record, fieldName) ? record[fieldName] : fallback;
}

function normalizeReasoningResultJson(
  value: unknown,
  fields: Record<string, unknown>,
  stringArrayFields: readonly string[],
): string {
  const normalized = canonicalJsonForTopLevel(value, 'object');
  if (normalized !== undefined) {
    return normalized;
  }
  return JSON.stringify(normalizeReasoningFields(fields, stringArrayFields));
}

function normalizeReasoningItemsJson(
  value: unknown,
  templates: readonly string[],
  fields: Record<string, unknown>,
  stringArrayFields: readonly string[],
): string {
  const normalized = canonicalJsonForTopLevel(value, 'array');
  if (normalized !== undefined) {
    return normalized;
  }
  const normalizedFields = normalizeReasoningFields(fields, stringArrayFields);
  return JSON.stringify(templates.map((template) =>
    template.replace(/<([A-Za-z0-9_]+)>/gu, (_match, fieldName: string) =>
      reasoningItemToken(normalizedFields[fieldName]))));
}

function canonicalJsonForTopLevel(value: unknown, topLevel: 'object' | 'array'): string | undefined {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  const topLevelMatches = topLevel === 'array'
    ? Array.isArray(parsed)
    : !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
  if (!topLevelMatches) {
    return undefined;
  }
  return JSON.stringify(parsed);
}

function normalizeReasoningFields(
  fields: Record<string, unknown>,
  stringArrayFields: readonly string[],
): Record<string, unknown> {
  const stringArrayFieldSet = new Set(stringArrayFields);
  return Object.fromEntries(Object.entries(fields).map(([field, value]) => {
    if (stringArrayFieldSet.has(field) && typeof value === 'string') {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (Array.isArray(parsed)) {
          return [field, parsed];
        }
      } catch {
        return [field, value];
      }
    }
    return [field, value];
  }));
}

function reasoningItemToken(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value) ?? String(value);
  }
  return String(value);
}`
    : '';

  return `import type { ${reactionImport}ToolHandler } from '@simodelne/pgas-server/plugin.js';
${usesIndexedCollectionLifecycle || usesConfirmationLoopHandlers || usesDelegationHandlers ? "import { reconstructArray } from '@simodelne/pgas-server/plugin.js';\n" : ''}import { resolveDomainValue, type HandlerPayload } from ${tsString(options.resolverImport)};
${contractsImport}
${docxExtractorImportBlock}${stageImports ? `${stageImports}\n` : ''}

// Generated by pgas-new from the approved stage topology. Deterministic stage
// wrappers return values written through action_map.result_path; LLM reasoning
// stages keep the runtime model's tool-call arguments as their source of truth.

export const handlers: Record<string, ToolHandler> = {
${beginWorkHandler ? `${beginWorkHandler}\n\n` : ''}${notebookHandlers}

${sessionControlHandlers}${actionHandlers ? `\n\n${actionHandlers}` : ''}${lifecycleActionHandlers ? `\n\n${lifecycleActionHandlers}` : ''}${documentActionHandlers ? `\n\n${documentActionHandlers}` : ''}
};${handlerAdapterOverrides}${lifecycleIntentHelper}${exportHookAdapter}${reactionExport}${documentHelper}${conformanceHelper}
`;
}

function renderHandlersIndexBarrelSource(): string {
  return "export { handlers, reactionHandlers } from '../handlers.js';\n";
}

function renderConversationalHubGuardResetReactionEntries(
  transitionActions: TransitionAction[],
): string {
  return [...actionsBySourceMode(transitionActions)]
    .filter(([, actions]) => actions.some(isConversationalHubTransitionAction))
    .map(([source, actions]) => {
      const guardFields = unique(actions.map((action) => action.guardField).filter(isString));
      if (guardFields.length === 0) {
        return '';
      }
      const mutations = guardFields
        .map((path) => `{ op: 'MSet' as const, path: ${tsString(path)}, value: false }`)
        .join(', ');
      return `,
  [${tsString(conversationalHubGuardResetReactionName(source))}, (_snapshot, trigger, mode) => {
    if (mode !== ${tsString(source)} || !String(trigger).endsWith(${tsString(`->${source}`)})) {
      return undefined;
    }
    return { mutations: [${mutations}] };
  }]`;
    })
    .join('');
}

function renderExportHookAdapter(exportActions: TransitionAction[]): string {
  const stages = unique(exportActions.map((action) => action.source));
  const hookCases = stages
    .map((stage) => `    case ${tsString(exportRenderHookActionName(stage))}:\n      return ${tsString(stage)};`)
    .join('\n');
  const renderCases = stages
    .map((stage) => `    case ${tsString(stage)}: {
      const payload = { domain } as HandlerPayload;
      const output = await run${toPascalCase(stage)}(
        resolveStageInput(payload, ${tsString(stage)}),
        createStageRuntime(payload),
      );
      return attachExportPayloadFields(normalizeStageOutput(output, ${tsString(stage)}, 'pure-compute', undefined));
    }`)
    .join('\n');

  return `

export function createExportHookAdapter() {
  return {
    id: ${tsString(EXPORT_HOOK_CHANNEL)},
    async dispatch(payload: unknown): Promise<unknown | void> {
      const record = hookPayloadRecord(payload);
      const action = typeof record.action === 'string' ? record.action : '';
      const stage = exportStageForHookAction(action);
      if (!stage) {
        return undefined;
      }
      // No dispatch filter here. The hook is declared \`AfterMutation\` on the
      // one-shot \`<stage>.render_pending\` write emitted onto the transition INTO
      // this export stage, so the engine dispatches it exactly once, at export
      // time, with the full world already applied. A consumer-side gate would be
      // program logic on a governed path.
      const domain = hookDomainRecord(record.domain);
      return renderExportStage(stage, domain);
    },
  };
}

function exportStageForHookAction(action: string): string | undefined {
  switch (action) {
${hookCases}
    default:
      return undefined;
  }
}

async function renderExportStage(stage: string, domain: Record<string, unknown>): Promise<unknown | void> {
  switch (stage) {
${renderCases}
    default:
      return undefined;
  }
}

function hookPayloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function hookDomainRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function attachExportPayloadFields(output: unknown): unknown {
  const record = hookDomainRecord(output);
  const resultJson = record.result_json;
  if (typeof resultJson !== 'string') {
    return output;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson) as unknown;
  } catch {
    return output;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return output;
  }
  return { ...record, ...(parsed as Record<string, unknown>) };
}`;
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
  const docxExtractionEnabled = documentsDemandsSelfContainedDocx(documents);
  const extractionContract = JSON.stringify(documentIngestExtractionContract(documents));
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
        { op: 'MSet' as const, path: \`\${resultPath}.current_document\`, value: {} },
        { op: 'MSet' as const, path: \`\${resultPath}.char_count\`, value: 0 },
        { op: 'MSet' as const, path: \`\${resultPath}.file_count\`, value: 0 },
        { op: 'MSet' as const, path: \`\${resultPath}.document_count\`, value: 0 },
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
  const summaries = documentRecords.map((document, index) => documentSummaryWithIndex(document, index));
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
          documents: [],
            current_document: {},
            char_count: 0,
            file_count: 0,
            document_count: 0,
            files_json: JSON.stringify(summaries),
            extraction_kind: docxExtractionKind(bytes),
            extraction_contract: documentExtractionContract(),
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
      documents: [],
        current_document: {},
        char_count: 0,
        file_count: 0,
        document_count: 0,
        files_json: JSON.stringify(summaries),
        extraction_kind: 'none',
        extraction_contract: documentExtractionContract(),
        reason: sawUnsupported ? ${docxExtractionEnabled ? "'uploaded documents were not supported content_text or DOCX content_base64 documents'" : "'uploaded documents were not text/markdown content_text documents'"} : 'no engine-injected document content_text was available',
      };
  }

  const fullText = eligible.length === 1
    ? eligible[0]?.text ?? ''
    : eligible.map((entry, index) => \`--- file: \${documentName(entry.document, index)} ---\\n\\n\${entry.text}\`).join('\\n\\n');
  const charCount = fullText.length;
  const extractionKind = combinedExtractionKind(eligible.map((entry) => entry.extraction_kind));
  const documents = eligible.map((entry, index) => documentSlice(entry.document, entry.text, entry.extraction_kind, index));
  return {
    status: 'extracted',
    full_text: fullText,
    documents,
      current_document: documents[0] ?? {},
      char_count: charCount,
      file_count: eligible.length,
      document_count: documents.length,
      files_json: JSON.stringify(eligible.map((entry, index) => documentSummaryWithIndex(entry.document, index))),
      extraction_kind: extractionKind,
      extraction_contract: documentExtractionContract(),
    };
}

function skippedDocumentSource(): Record<string, unknown> {
  return {
    status: 'skipped_no_documents',
    full_text: '',
    documents: [],
      current_document: {},
      char_count: 0,
      file_count: 0,
      document_count: 0,
      files_json: '[]',
      extraction_kind: 'skipped_no_documents',
      extraction_contract: documentExtractionContract(),
    };
}

function documentExtractionContract(): Record<string, unknown> {
  return ${extractionContract};
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
    id: documentId(document, 0),
    file_id: documentFileId(document),
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

function documentSlice(
  document: Record<string, unknown>,
  text: string,
  extractionKind: string,
  index: number,
): Record<string, unknown> {
  const summary = documentSummaryWithIndex(document, index);
  return {
    id: summary.id,
    name: summary.name,
    mime_type: summary.mime_type,
    size: summary.size,
    text,
    char_count: text.length,
    source_index: index,
    extraction_kind: extractionKind,
    provenance: {
      file_id: summary.file_id,
      name: summary.name,
      mime_type: summary.mime_type,
      size: summary.size,
      source_index: index,
    },
  };
}

function documentSummaryWithIndex(document: Record<string, unknown>, index: number): Record<string, unknown> {
  return {
    ...documentSummary(document),
    id: documentId(document, index),
  };
}

function documentId(document: Record<string, unknown>, index: number): string {
  if (typeof document.id === 'string' && document.id.length > 0) {
    return document.id;
  }
  if (typeof document.document_id === 'string' && document.document_id.length > 0) {
    return document.document_id;
  }
  const fileId = documentFileId(document);
  if (fileId.length > 0) {
    return fileId;
  }
  return \`doc\${String(index + 1)}\`;
}

function documentFileId(document: Record<string, unknown>): string {
  if (typeof document.fileId === 'string' && document.fileId.length > 0) {
    return document.fileId;
  }
  if (typeof document.file_id === 'string' && document.file_id.length > 0) {
    return document.file_id;
  }
  return '';
}

function isDocumentRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}${reactionHelpers}`;
}

function documentMinChars(documents: DocumentsDescriptor): number {
  const value = documents.fidelity_floor?.min_chars;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function documentRequiredTokens(documents: DocumentsDescriptor): string[] {
  const value = documents.fidelity_floor?.required_tokens;
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('documents.fidelity_floor.required_tokens must be a non-empty array of non-blank strings');
  }
  return value.map((token, index) => {
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new Error(`documents.fidelity_floor.required_tokens[${index}] must be a non-blank string`);
    }
    return token.trim();
  });
}

function documentRequiredPatterns(documents: DocumentsDescriptor): string[] {
  return documentStringListFidelityFloor(documents, 'required_patterns');
}

function documentForbiddenPatterns(documents: DocumentsDescriptor): string[] {
  return documentStringListFidelityFloor(documents, 'forbidden_patterns');
}

function validateSourceGroundedExtractors(documents: DocumentsDescriptor): void {
  const raw = documentStringListFidelityFloor(documents, 'source_grounded_extractors');
  raw.forEach((extractor, index) => {
    if (!SOURCE_GROUNDED_EXTRACTORS.includes(extractor as SourceGroundedExtractor)) {
      throw new Error(
        `documents.fidelity_floor.source_grounded_extractors[${index}] must be one of: ${SOURCE_GROUNDED_EXTRACTORS.join(', ')}`,
      );
    }
  });
}

function documentStringListFidelityFloor(documents: DocumentsDescriptor, field: string): string[] {
  const value = documents.fidelity_floor?.[field];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`documents.fidelity_floor.${field} must be a non-empty array of non-blank strings`);
  }
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new Error(`documents.fidelity_floor.${field}[${index}] must be a non-blank string`);
    }
    return item.trim();
  });
}

function stageResultFieldMirrorReactionHelper(): string {
  return `

function mirrorStageResultFields(
  snapshot: ReadonlyMap<string, unknown>,
  outputPath: string,
  resultRootPath: string,
  resultFieldNames: readonly string[],
): ReactionResult | undefined {
  const output = snapshot.get(outputPath);
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return undefined;
  }
  const record = output as Record<string, unknown>;
  const mutations: ReactionResult['mutations'] = [];
  if (typeof record.result_json === 'string' && resultFieldNames.length > 0) {
    const parsed = parseStageResultRecord(record.result_json);
    for (const field of resultFieldNames) {
      if (!Object.prototype.hasOwnProperty.call(parsed, field)) {
        continue;
      }
      const path = \`\${resultRootPath}.\${field}\`;
      const value = parsed[field];
      if (JSON.stringify(snapshot.get(path)) !== JSON.stringify(value)) {
        mutations.push({ op: 'MSet' as const, path, value });
      }
    }
  }
  return mutations.length > 0 ? { mutations } : undefined;
}

function parseStageResultRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}`;
}

function leadResearchHostOutputMirrorReactionHelper(): string {
  return `

function mirrorLeadResearchHostOutputs(snapshot: ReadonlyMap<string, unknown>): ReactionResult | undefined {
  const mutations: ReactionResult['mutations'] = [];

  const persistOutput = snapshotRecord(snapshot, 'persist.output');
  const persistResult = parsedRecord(persistOutput?.result_json);
  const newVsExisting = arrayField(persistResult, 'new_vs_existing', persistOutput, 'new_vs_existing');
  for (const [index, record] of newVsExisting.entries()) {
    pushChangedMutation(mutations, snapshot, \`work.persist.new_vs_existing.\${String(index)}\`, record);
  }

  const aggregateOutput = snapshotRecord(snapshot, 'aggregate.output');
  const aggregateResult = parsedRecord(aggregateOutput?.result_json);
  const aggregateAudit = arrayField(aggregateResult, 'audit', aggregateOutput, 'audit');
  const audit = aggregateAudit.length > 0
    ? aggregateAudit
    : sourceCollection(snapshot, 'work.aggregate.per_source')
        .flatMap((entry) => {
          const record = snapshotLikeRecord(entry);
          return Array.isArray(record.audit) ? record.audit : [];
        });
  for (const [index, record] of audit.entries()) {
    pushChangedMutation(mutations, snapshot, \`work.audit.\${String(index)}\`, record);
  }

  return mutations.length > 0 ? { mutations } : undefined;
}

function pushChangedMutation(
  mutations: NonNullable<ReactionResult['mutations']>,
  snapshot: ReadonlyMap<string, unknown>,
  path: string,
  value: unknown,
): void {
  if (JSON.stringify(snapshot.get(path)) !== JSON.stringify(value)) {
    mutations.push({ op: 'MSet' as const, path, value });
  }
}`;
}

function reasoningFieldMirrorReactionHelper(): string {
  return `

function mirrorReasoningResultFields(
  snapshot: ReadonlyMap<string, unknown>,
  outputPath: string,
  rawFieldsRootPath: string,
  rawResultJsonPath: string,
  resultRootPath: string,
  fieldNames: readonly string[],
  stringArrayFields: readonly string[],
): ReactionResult | undefined {
  const rawAggregateFields = extractReasoningResultFields(snapshot.get(rawResultJsonPath));
  const output = snapshot.get(outputPath);
  const outputRecord = output && typeof output === 'object' && !Array.isArray(output)
    ? (output as Record<string, unknown>).fields
    : undefined;
  const outputFields = outputRecord && typeof outputRecord === 'object' && !Array.isArray(outputRecord)
    ? outputRecord as Record<string, unknown>
    : {};
  const mutations: ReactionResult['mutations'] = [];
  for (const field of fieldNames) {
    const rawFieldPath = \`\${rawFieldsRootPath}.\${field}\`;
    const outputValue = Object.prototype.hasOwnProperty.call(outputFields, field)
      ? outputFields[field]
      : undefined;
    const rawFieldValue = snapshot.get(rawFieldPath);
    const aggregateValue = Object.prototype.hasOwnProperty.call(rawAggregateFields, field)
      ? rawAggregateFields[field]
      : undefined;
    const value = normalizeReasoningFieldValue(
      outputValue !== undefined
        ? outputValue
        : rawFieldValue !== undefined
          ? rawFieldValue
          : aggregateValue,
      field,
      stringArrayFields,
    );
    if (value === undefined) {
      continue;
    }
    const path = \`\${resultRootPath}.\${field}\`;
    if (JSON.stringify(snapshot.get(path)) !== JSON.stringify(value)) {
      mutations.push({ op: 'MSet' as const, path, value });
    }
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
      ${descriptor.storage.representation === 'indexed_array'
        ? `${tsString(collectionLifecycleTerminalStatusItemsPath(descriptor.storage.items_path))},`
        : ''}
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
  if (descriptor.storage.representation === 'indexed_array') {
    return applyEntry;
  }
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
    return '';
  }
  return `\n\nfunction collectionLifecycleAllTerminal(\n  snapshot: ReadonlyMap<string, unknown>,\n  itemsPath: string,\n  statusField: string,\n  terminalStatuses: readonly string[],\n  requireNonEmpty: boolean,\n): boolean {\n  const raw = snapshot.get(itemsPath);\n  if (typeof raw !== 'string') {\n    return false;\n  }\n  let parsed: unknown;\n  try {\n    parsed = JSON.parse(raw) as unknown;\n  } catch {\n    return false;\n  }\n  if (!Array.isArray(parsed)) {\n    return false;\n  }\n  if (requireNonEmpty && parsed.length === 0) {\n    return false;\n  }\n  const terminal = new Set(terminalStatuses);\n  return parsed.every((item) => {\n    if (!item || typeof item !== 'object' || Array.isArray(item)) {\n      return false;\n    }\n    const status = (item as Record<string, unknown>)[statusField];\n    return typeof status === 'string' && terminal.has(status);\n  });\n}`;
}

function renderCollectionLifecycleApplyHelper(descriptor: CollectionLifecycleDescriptor): string {
  if (descriptor.storage.representation === 'indexed_array') {
    return `

function collectionLifecycleApplyEvent(
  snapshot: ReadonlyMap<string, unknown>,
  itemsPath: string,
  terminalItemsPath: string,
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
  const terminalStatuses = new Set([${descriptor.aggregate.terminal_statuses.map(tsString).join(', ')}]);
  const nextItems = items.map((item, index) =>
    index === itemIndex && item && typeof item === 'object' && !Array.isArray(item)
      ? { ...item as Record<string, unknown>, [statusField]: attemptedTo, ${tsString(DERIVED_TERMINAL_FIELD)}: terminalStatuses.has(attemptedTo) }
      : item,
  );
  const terminalItems = nextItems.map((item, index) => {
    const record = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const id = typeof record[idField] === 'string' ? record[idField] : String(index);
    return { id, ${tsString(DERIVED_TERMINAL_STATUS_FIELD)}: record[${tsString(DERIVED_TERMINAL_FIELD)}] === true };
  });

  return {
    mutations: [
      { op: 'MSet' as const, path: itemsPath + '.' + itemIndex + '.' + statusField, value: attemptedTo },
      { op: 'MSet' as const, path: itemsPath + '.' + itemIndex + '.${DERIVED_TERMINAL_FIELD}', value: terminalStatuses.has(attemptedTo) },
      { op: 'MSet' as const, path: terminalItemsPath, value: terminalItems },
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
  const itemIndex = parsedItems.findIndex((item) =>
    !!item && typeof item === 'object' && !Array.isArray(item) && (item as Record<string, unknown>)[idField] === itemId,
  );
  if (itemIndex < 0) {
    return violation('missing_item', eventFrom);
  }

  const currentItem = parsedItems[itemIndex] as Record<string, unknown>;
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

  const nextItems = parsedItems.map((item, index) =>
    index === itemIndex && item && typeof item === 'object' && !Array.isArray(item)
      ? { ...item as Record<string, unknown>, [statusField]: attemptedTo }
      : item,
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
    const proposalTargets = confirmationLoopProposalFields(loop, lifecycle)
      .map((field) => `{ field: ${tsString(field)}, path: ${tsString(confirmationLoopProposalFieldPath(loop, field))} }`)
      .join(', ');
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
      ${tsString(collectionLifecycleTerminalStatusItemsPath(loop.collection))},
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
  [${tsString(confirmationLoopSummarizeReactionName(loop))}, (snapshot, trigger, mode) => {
    void trigger;
    if (mode !== ${tsString(loop.stage)}) return undefined;
    return confirmationLoopSummarizeCollection(
      snapshot,
      ${tsString(loop.collection)},
      ${tsString(lifecycle.item.status_field)},
      ${tsString(confirmationLoopInitialStatus(lifecycle))},
      ${tsString(loop.proposed_status)},
      [${loop.aggregate.terminal_statuses.map(tsString).join(', ')}],
      ${tsString(confirmationLoopSummaryPath(loop))},
      [${confirmationLoopActiveItemFields(loop, lifecycle).map(tsString).join(', ')}],
    );
  }],
  [${tsString(confirmationLoopMirrorProposalReactionName(loop))}, (snapshot, trigger, mode) => {
    void trigger;
    if (mode !== ${tsString(loop.stage)}) return undefined;
    return mirrorConfirmationLoopProposalPayload(
      snapshot,
      ${tsString(confirmationLoopRawPayloadMutationsPath(loop))},
      [${proposalTargets}],
    );
  }],
  [${tsString(confirmationLoopChoreographReactionName(loop))}, (snapshot, trigger, mode) => {
    void trigger;
    return confirmationLoopChoreographCollection(
      snapshot,
      mode,
      ${tsString(loop.collection)},
      ${tsString(collectionLifecycleTerminalStatusItemsPath(loop.collection))},
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

function renderDelegationReactionEntries(children: DelegationChildDescriptor[], documents?: DocumentsDescriptor): string {
  return children.map((child) => {
    const base = delegationStateBase(child);
    const fanOut = documentFanOutDescriptor(child, documents);
    if (fanOut) {
      return `,
  [${tsString(documentFanOutAdvanceReactionName(child))}, (snapshot, trigger, mode) => {
    void trigger;
    void mode;
    return advanceDocumentDelegationFanOut(
      snapshot,
      {
        documentsPath: ${tsString(fanOut.source)},
        currentDocumentPath: ${tsString(fanOut.current_document)},
        readyPath: ${tsString(documentsSourceReadyPath(documents as DocumentsDescriptor))},
        resultPath: ${tsString(child.result_path)},
        requestedPath: ${tsString(`${base}.requested`)},
        settledPath: ${tsString(`${base}.settled`)},
        degradedPath: ${tsString(`${base}.degraded`)},
        degradeReasonPath: ${tsString(`${base}.degrade_reason`)},
        indexPath: ${tsString(fanOut.index_path ?? `${child.stage}.fan_out.index`)},
        completePath: ${tsString(fanOut.completion_guard)},
        resultsPath: ${tsString(fanOut.result_path)},
      },
      );
    }]`;
    }
    const sourceFanOut = sourceConfigFanOutDescriptor(child);
    if (sourceFanOut) {
      return `,
  [${tsString(sourceConfigFanOutAdvanceReactionName(child))}, (snapshot, trigger, mode) => {
    void trigger;
    void mode;
    return advanceSourceDelegationFanOut(
      snapshot,
      {
        sourcesPath: ${tsString(sourceFanOut.source)},
        currentSourcePath: ${tsString(sourceFanOut.current_document)},
        resultPath: ${tsString(child.result_path)},
        requestedPath: ${tsString(`${base}.requested`)},
        settledPath: ${tsString(`${base}.settled`)},
        degradedPath: ${tsString(`${base}.degraded`)},
        degradeReasonPath: ${tsString(`${base}.degrade_reason`)},
        indexPath: ${tsString(sourceFanOut.index_path ?? `${child.stage}.fan_out.index`)},
        completePath: ${tsString(sourceFanOut.completion_guard)},
        resultsPath: ${tsString(sourceFanOut.result_path)},
      },
      );
    }]`;
    }
    if (documents && isDocumentIngestUploadDelegationChild(child, documents)) {
      return `,
  [${tsString(delegationSettleReactionName(child))}, (snapshot, trigger, mode) => {
    void trigger;
    void mode;
    return settleDocumentIngestDelegationResult(
      snapshot,
      ${tsString(child.result_path)},
      ${tsString(`${base}.settled`)},
      ${tsString(`${base}.degraded`)},
      ${tsString(`${base}.degrade_reason`)},
      ${tsString(documents.result_path)},
    );
  }]`;
    }
    return '';
  }).join('');
}

function renderDelegationReactionHelper(): string {
  return `

interface DocumentDelegationFanOutConfig {
  documentsPath: string;
  currentDocumentPath: string;
  readyPath: string;
  resultPath: string;
  requestedPath: string;
  settledPath: string;
  degradedPath: string;
  degradeReasonPath: string;
  indexPath: string;
  completePath: string;
  resultsPath: string;
}

interface SourceConfigDelegationFanOutConfig {
  sourcesPath: string;
  currentSourcePath: string;
  resultPath: string;
  requestedPath: string;
  settledPath: string;
  degradedPath: string;
  degradeReasonPath: string;
  indexPath: string;
  completePath: string;
  resultsPath: string;
}

function settleDocumentIngestDelegationResult(
  snapshot: ReadonlyMap<string, unknown>,
  resultPath: string,
  settledPath: string,
  degradedPath: string,
  degradeReasonPath: string,
  documentPath: string,
): ReactionResult | undefined {
  if (snapshot.get(settledPath) === true) {
    return undefined;
  }
  const result = snapshotRecord(snapshot, resultPath) ?? {};
  const status = typeof result.status === 'string'
    ? result.status
    : snapshot.get(resultPath + '.status');
  if (typeof status !== 'string' || status.length === 0) {
    return undefined;
  }
  if (status === 'complete') {
    return {
      mutations: [
        { op: 'MSet' as const, path: settledPath, value: true },
        { op: 'MSet' as const, path: degradedPath, value: false },
        { op: 'MSet' as const, path: degradeReasonPath, value: '' },
        ...(documentArtifactMutations(documentPath, documentArtifactsFromIngestResult(result)) ?? []),
      ],
    };
  }
  if (status !== 'failed' && status !== 'declined') {
    return undefined;
  }
  const reason = typeof result.reason === 'string'
    ? result.reason
    : snapshot.get(resultPath + '.reason');
  return {
    mutations: [
      { op: 'MSet' as const, path: settledPath, value: true },
      { op: 'MSet' as const, path: degradedPath, value: true },
      { op: 'MSet' as const, path: degradeReasonPath, value: typeof reason === 'string' && reason.length > 0 ? reason : status },
    ],
  };
}

interface DocumentIngestArtifactSection {
  id: string;
  heading: string;
  status: string;
  text: string;
}

interface DocumentIngestArtifacts {
  summary: string;
  sections: DocumentIngestArtifactSection[];
}

function documentArtifactsFromIngestResult(result: Record<string, unknown>): DocumentIngestArtifacts {
  const resultRecord = parsedRecord(result.result);
  const pipelineResult = parsedRecord(result.pipeline_result);
  const candidates = [
    parsedRecord(result.structured_data),
    parsedRecord(resultRecord.structured_data),
    parsedRecord(pipelineResult.structured_data),
    resultRecord,
    pipelineResult,
    result,
  ];
  const source = candidates.find((candidate) =>
    Object.keys(candidate).some((key) => ['summary', 'overview', 'title', 'sections', 'clauses'].includes(key))) ?? result;
  const summary = firstNonEmptyString(
    source.summary,
    source.overview,
    result.summary,
    result.overview,
    source.title,
  );
  const sections = sectionValues(source.sections);
  const rawSections = sections.length > 0 ? sections : sectionValues(source.clauses);
  return {
    summary,
    sections: rawSections.map((section, index) => normalizeDocumentArtifactSection(section, index)),
  };
}

function documentArtifactMutations(documentPath: string, artifacts: DocumentIngestArtifacts): ReactionResult['mutations'] {
  const sections = artifacts.sections.map((section, index) => ({
    key: safeDocumentArtifactKey(section.id, index),
    section,
  }));
  const sectionsObject = Object.fromEntries(sections.map((entry) => [entry.key, entry.section]));
  const mutations: ReactionResult['mutations'] = [
    { op: 'MSet' as const, path: documentPath + '.summary', value: artifacts.summary },
    { op: 'MSet' as const, path: documentPath + '.sections', value: sectionsObject },
    { op: 'MSet' as const, path: documentPath + '.ingest_result_harvested', value: true },
  ];
  for (const { key, section } of sections) {
    const path = documentPath + '.sections.' + key;
    mutations.push(
      { op: 'MSet' as const, path, value: section },
      { op: 'MSet' as const, path: path + '.id', value: section.id },
      { op: 'MSet' as const, path: path + '.heading', value: section.heading },
      { op: 'MSet' as const, path: path + '.status', value: section.status },
      { op: 'MSet' as const, path: path + '.text', value: section.text },
    );
  }
  return mutations;
}

function normalizeDocumentArtifactSection(value: unknown, index: number): DocumentIngestArtifactSection {
  const record = parsedRecord(value);
  const id = firstNonEmptyString(record.id, record.section_id, record.clause_id) || 'section-' + String(index + 1);
  return {
    id,
    heading: firstNonEmptyString(record.heading, record.title, record.name) || id,
    status: firstNonEmptyString(record.status) || 'extracted',
    text: firstNonEmptyString(record.text, record.body, record.content, record.summary),
  };
}

function sectionValues(value: unknown): unknown[] {
  const candidate = typeof value === 'string' ? parsedJsonValue(value) : value;
  if (Array.isArray(candidate)) {
    return candidate;
  }
  if (candidate && typeof candidate === 'object') {
    return Object.values(candidate as Record<string, unknown>);
  }
  return [];
}

function parsedRecord(value: unknown): Record<string, unknown> {
  const candidate = typeof value === 'string' ? parsedJsonValue(value) : value;
  return snapshotLikeRecord(candidate);
}

function parsedJsonValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return '';
}

function safeDocumentArtifactKey(id: string, index: number): string {
  const normalized = id.replace(/[^A-Za-z0-9_-]+/gu, '_').replace(/^_+|_+$/gu, '');
  return normalized.length > 0 ? normalized : 'section_' + String(index + 1);
}

function advanceDocumentDelegationFanOut(
  snapshot: ReadonlyMap<string, unknown>,
  config: DocumentDelegationFanOutConfig,
): ReactionResult | undefined {
  if (snapshot.get(config.completePath) === true) {
    return undefined;
  }
  if (snapshot.get(config.readyPath) !== true) {
    return undefined;
  }
  let documents: unknown[];
  try {
    documents = reconstructArray(Object.fromEntries(snapshot), config.documentsPath);
  } catch {
    documents = [];
  }
  const index = fanOutIndex(snapshot.get(config.indexPath));
  if (documents.length === 0 || index >= documents.length) {
    return { mutations: [{ op: 'MSet' as const, path: config.completePath, value: true }] };
  }
  if (snapshot.get(config.requestedPath) !== true) {
    const current = snapshotRecord(snapshot, config.currentDocumentPath);
    if (!current || current.source_index !== index) {
      return {
        mutations: documentSliceMutations(config.currentDocumentPath, documentAt(documents, index) ?? {}),
      };
    }
    return undefined;
  }
  const result = snapshotRecord(snapshot, config.resultPath);
  const status = typeof result?.status === 'string'
    ? result.status
    : snapshot.get(\`\${config.resultPath}.status\`);
  if (status !== 'complete' && status !== 'failed' && status !== 'declined') {
    return undefined;
  }
  const document = snapshotRecord(snapshot, config.currentDocumentPath) ?? documentAt(documents, index) ?? {};
  const documentId = stringField(document, 'id') || \`doc\${String(index + 1)}\`;
  const key = safeFanOutKey(documentId, index);
  const nextIndex = index + 1;
  const nextDocument = documentAt(documents, nextIndex);
  const degraded = status === 'failed' || status === 'declined';
  const reason = typeof result?.reason === 'string' && result.reason.length > 0 ? result.reason : String(status);
  const stored = {
    ...(result ?? {}),
    document_id: documentId,
    document_name: stringField(document, 'name'),
    source_index: index,
    degraded,
  };
  const mutations: ReactionResult['mutations'] = [
    { op: 'MSet' as const, path: \`\${config.resultsPath}.\${key}\`, value: stored },
    { op: 'MSet' as const, path: config.indexPath, value: nextIndex },
    { op: 'MSet' as const, path: config.requestedPath, value: false },
    { op: 'MSet' as const, path: config.settledPath, value: nextDocument === undefined },
    { op: 'MSet' as const, path: config.degradedPath, value: degraded },
    { op: 'MSet' as const, path: config.degradeReasonPath, value: degraded ? reason : '' },
  ];
  if (nextDocument === undefined) {
    mutations.push({ op: 'MSet' as const, path: config.completePath, value: true });
  } else {
    mutations.push(
      ...(documentSliceMutations(config.currentDocumentPath, nextDocument) ?? []),
      { op: 'MSet' as const, path: config.completePath, value: false },
    );
  }
  return { mutations };
}

function advanceSourceDelegationFanOut(
  snapshot: ReadonlyMap<string, unknown>,
  config: SourceConfigDelegationFanOutConfig,
): ReactionResult | undefined {
  if (snapshot.get(config.completePath) === true) {
    return undefined;
  }
  const sources = sourceCollection(snapshot, config.sourcesPath);
  const index = fanOutIndex(snapshot.get(config.indexPath));
  if (sources.length === 0 || index >= sources.length) {
    return { mutations: [{ op: 'MSet' as const, path: config.completePath, value: true }] };
  }
  if (snapshot.get(config.requestedPath) !== true) {
    const nextSource = sourceAt(sources, index) ?? {};
    const current = snapshotRecord(snapshot, config.currentSourcePath);
    if (!current || numberField(current, 'source_index') !== index || stringField(current, 'url') !== stringField(nextSource, 'url')) {
      return {
        mutations: sourceSliceMutations(config.currentSourcePath, nextSource, index),
      };
    }
    return undefined;
  }
  const result = snapshotRecord(snapshot, config.resultPath);
  const status = typeof result?.status === 'string'
    ? result.status
    : snapshot.get(\`\${config.resultPath}.status\`);
  if (status !== 'complete' && status !== 'failed' && status !== 'declined') {
    return undefined;
  }
  const source = snapshotRecord(snapshot, config.currentSourcePath) ?? sourceAt(sources, index) ?? {};
  const sourceUrl = stringField(source, 'url') || \`source-\${String(index + 1)}\`;
  const nextIndex = index + 1;
  const nextSource = sourceAt(sources, nextIndex);
  const degraded = status === 'failed' || status === 'declined';
  const reason = typeof result?.reason === 'string' && result.reason.length > 0 ? result.reason : String(status);
  const resultRecord = parsedRecord(result?.result);
  const stored = {
    source: sourceUrl,
    source_index: index,
    status,
    items: arrayField(resultRecord, 'items', result, 'items'),
    pages_visited: numberField(resultRecord, 'pages_visited') || numberField(result ?? {}, 'pages_visited'),
    audit: arrayField(resultRecord, 'audit', result, 'audit'),
    degraded,
    reason: degraded ? reason : '',
  };
  const mutations: ReactionResult['mutations'] = [
    { op: 'MSet' as const, path: \`\${config.resultsPath}.\${String(index)}\`, value: stored },
    { op: 'MSet' as const, path: config.indexPath, value: nextIndex },
    { op: 'MSet' as const, path: config.requestedPath, value: false },
    { op: 'MSet' as const, path: config.settledPath, value: nextSource === undefined },
    { op: 'MSet' as const, path: config.degradedPath, value: degraded },
    { op: 'MSet' as const, path: config.degradeReasonPath, value: degraded ? reason : '' },
  ];
  if (nextSource === undefined) {
    mutations.push({ op: 'MSet' as const, path: config.completePath, value: true });
  } else {
    mutations.push(
      ...(sourceSliceMutations(config.currentSourcePath, nextSource, nextIndex) ?? []),
      { op: 'MSet' as const, path: config.completePath, value: false },
    );
  }
  return { mutations };
}

function sourceCollection(snapshot: ReadonlyMap<string, unknown>, path: string): unknown[] {
  const direct = snapshot.get(path);
  if (Array.isArray(direct)) {
    return direct;
  }
  try {
    return reconstructArray(Object.fromEntries(snapshot), path);
  } catch {
    return [];
  }
}

function sourceAt(sources: unknown[], index: number): Record<string, unknown> | undefined {
  const source = sources[index];
  if (typeof source === 'string') {
    return { url: source, source_index: index };
  }
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    const record = source as Record<string, unknown>;
    return { ...record, source_index: index };
  }
  return undefined;
}

function sourceSliceMutations(path: string, source: Record<string, unknown>, index: number): ReactionResult['mutations'] {
  return [
    { op: 'MSet' as const, path, value: { ...source, source_index: index } },
    { op: 'MSet' as const, path: \`\${path}.url\`, value: stringField(source, 'url') },
    { op: 'MSet' as const, path: \`\${path}.source_index\`, value: index },
  ];
}

function documentSliceMutations(path: string, document: Record<string, unknown>): ReactionResult['mutations'] {
  const provenance = snapshotLikeRecord(document.provenance);
  return [
    { op: 'MSet' as const, path, value: document },
    { op: 'MSet' as const, path: \`\${path}.id\`, value: stringField(document, 'id') },
    { op: 'MSet' as const, path: \`\${path}.name\`, value: stringField(document, 'name') },
    { op: 'MSet' as const, path: \`\${path}.mime_type\`, value: stringField(document, 'mime_type') },
    { op: 'MSet' as const, path: \`\${path}.size\`, value: numberField(document, 'size') },
    { op: 'MSet' as const, path: \`\${path}.text\`, value: stringField(document, 'text') },
    { op: 'MSet' as const, path: \`\${path}.char_count\`, value: numberField(document, 'char_count') },
    { op: 'MSet' as const, path: \`\${path}.source_index\`, value: numberField(document, 'source_index') },
    { op: 'MSet' as const, path: \`\${path}.extraction_kind\`, value: stringField(document, 'extraction_kind') },
    { op: 'MSet' as const, path: \`\${path}.provenance\`, value: provenance },
    { op: 'MSet' as const, path: \`\${path}.provenance.file_id\`, value: stringField(provenance, 'file_id') },
    { op: 'MSet' as const, path: \`\${path}.provenance.name\`, value: stringField(provenance, 'name') },
    { op: 'MSet' as const, path: \`\${path}.provenance.mime_type\`, value: stringField(provenance, 'mime_type') },
    { op: 'MSet' as const, path: \`\${path}.provenance.size\`, value: numberField(provenance, 'size') },
    { op: 'MSet' as const, path: \`\${path}.provenance.source_index\`, value: numberField(provenance, 'source_index') },
  ];
}

function fanOutIndex(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function documentAt(documents: unknown[], index: number): Record<string, unknown> | undefined {
  const document = documents[index];
  return document && typeof document === 'object' && !Array.isArray(document)
    ? document as Record<string, unknown>
    : undefined;
}

function snapshotRecord(snapshot: ReadonlyMap<string, unknown>, path: string): Record<string, unknown> | undefined {
  const direct = snapshot.get(path);
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    return direct as Record<string, unknown>;
  }
  const prefix = \`\${path}.\`;
  const result: Record<string, unknown> = {};
  for (const [key, value] of snapshot) {
    if (key.startsWith(prefix)) {
      result[key.slice(prefix.length)] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  return typeof value === 'string' ? value : '';
}

function numberField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function arrayField(
  primary: Record<string, unknown>,
  primaryField: string,
  fallback: Record<string, unknown> | undefined,
  fallbackField: string,
): unknown[] {
  const primaryValue = primary[primaryField];
  if (Array.isArray(primaryValue)) {
    return primaryValue;
  }
  const fallbackValue = fallback?.[fallbackField];
  if (Array.isArray(fallbackValue)) {
    return fallbackValue;
  }
  return [];
}

function snapshotLikeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeFanOutKey(documentId: string, index: number): string {
  const normalized = documentId.replace(/[^A-Za-z0-9_-]+/gu, '_').replace(/^_+|_+$/gu, '');
  return normalized.length > 0 ? normalized : \`doc\${String(index + 1)}\`;
}`;
}

function renderConfirmationLoopReactionHelper(): string {
  return `

interface ConfirmationLoopProposalTarget {
  field: string;
  path: string;
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

function mirrorConfirmationLoopProposalPayload(
  snapshot: ReadonlyMap<string, unknown>,
  rawPayloadMutationsPath: string,
  proposalTargets: readonly ConfirmationLoopProposalTarget[],
): ReactionResult | undefined {
  const rawPayloadMutations = snapshot.get(rawPayloadMutationsPath);
  if (!Array.isArray(rawPayloadMutations) || rawPayloadMutations.length === 0) {
    return undefined;
  }
  const targetPaths = new Set(proposalTargets.map((target) => target.path));
  const recoveredByPath = new Map<string, string>();
  for (const rawMutation of rawPayloadMutations) {
    const mutation = confirmationLoopRawPayloadMutation(rawMutation);
    if (!mutation) {
      continue;
    }
    if (mutation.op !== 'MSet' || !targetPaths.has(mutation.path)) {
      continue;
    }
    if (typeof mutation.value === 'string' && mutation.value.length > 0) {
      recoveredByPath.set(mutation.path, mutation.value);
    }
  }
  const mutations: ReactionResult['mutations'] = [];
  for (const target of proposalTargets) {
    const current = snapshot.get(target.path);
    if (typeof current === 'string' && current.length > 0) {
      continue;
    }
    const recovered = recoveredByPath.get(target.path);
    if (typeof recovered === 'string' && recovered.length > 0) {
      mutations.push({ op: 'MSet' as const, path: target.path, value: recovered });
    }
  }
  return mutations.length > 0 ? { mutations } : undefined;
}

function confirmationLoopRawPayloadMutation(value: unknown): { op: string; path: string; value: unknown } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return typeof record.op === 'string' && typeof record.path === 'string'
    ? { op: record.op, path: record.path, value: record.value }
    : undefined;
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
  terminalItemsPath: string,
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
        const terminal = terminalStatuses.includes(nextStatus);
        record[statusField] = nextStatus;
        record[${tsString(DERIVED_TERMINAL_FIELD)}] = terminal;
        mutations.push({ op: 'MSet' as const, path: itemsPath + '.' + pending.value.target_index + '.' + statusField, value: nextStatus });
        mutations.push({ op: 'MSet' as const, path: itemsPath + '.' + pending.value.target_index + '.${DERIVED_TERMINAL_FIELD}', value: terminal });
        mutations.push({ op: 'MSet' as const, path: terminalItemsPath + '.' + pending.value.target_index + '.${DERIVED_TERMINAL_STATUS_FIELD}', value: terminal });
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
    record[${tsString(DERIVED_TERMINAL_FIELD)}] = false;
    mutations.push({ op: 'MSet' as const, path: itemsPath + '.' + index + '.' + statusField, value: initialStatus });
    mutations.push({ op: 'MSet' as const, path: itemsPath + '.' + index + '.${DERIVED_TERMINAL_FIELD}', value: false });
    mutations.push({ op: 'MSet' as const, path: terminalItemsPath + '.' + index + '.${DERIVED_TERMINAL_STATUS_FIELD}', value: false });
    mutations.push({ op: 'MSet' as const, path: violationPath, value: JSON.stringify({ reason: 'multiple_proposed', kept_index: proposed[0]?.index ?? 0, demoted_index: index, demoted_id: typeof record[idField] === 'string' ? record[idField] : '' }) });
    demoted += 1;
  }
  if (demoted > 0) {
    const current = snapshot.get(demotionCounterPath);
    mutations.push({ op: 'MSet' as const, path: demotionCounterPath, value: (typeof current === 'number' && Number.isFinite(current) ? current : 0) + demoted });
  }
  void aggregateGuardPath;
  return mutations.length > 0 ? { mutations } : undefined;
}

function confirmationLoopSummarizeCollection(
  snapshot: ReadonlyMap<string, unknown>,
  itemsPath: string,
  statusField: string,
  initialStatus: string,
  proposedStatus: string,
  terminalStatuses: readonly string[],
  summaryPath: string,
  activeItemFields: readonly string[],
): ReactionResult | undefined {
  let items: unknown[] = [];
  try {
    items = reconstructArray(Object.fromEntries(snapshot), itemsPath);
  } catch {
    items = [];
  }
  const mutations: ReactionResult['mutations'] = [];
  appendConfirmationLoopSummaryMutation(
    mutations,
    summaryPath,
    items,
    statusField,
    initialStatus,
    proposedStatus,
    terminalStatuses,
    activeItemFields,
    confirmationLoopAllTerminal(items, statusField, terminalStatuses),
  );
  return { mutations };
}

function confirmationLoopChoreographCollection(
  snapshot: ReadonlyMap<string, unknown>,
  mode: string,
  itemsPath: string,
  terminalItemsPath: string,
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
      mutations.push({
        op: 'MSet' as const,
        path: terminalItemsPath,
        value: seeded.map((item, index) => ({
          id: typeof item[idField] === 'string' ? item[idField] : String(index),
          ${tsString(DERIVED_TERMINAL_STATUS_FIELD)}: item[${tsString(DERIVED_TERMINAL_FIELD)}] === true,
        })),
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
  next[${tsString(DERIVED_TERMINAL_FIELD)}] = false;
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
    [${tsString(DERIVED_TERMINAL_FIELD)}]: false,
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

function appendConfirmationLoopSummaryMutation(
  mutations: ReactionResult['mutations'],
  summaryPath: string,
  items: unknown[],
  statusField: string,
  initialStatus: string,
  proposedStatus: string,
  terminalStatuses: readonly string[],
  activeItemFields: readonly string[],
  allTerminal: boolean,
): void {
  mutations.push({
    op: 'MSet' as const,
    path: summaryPath,
    value: confirmationLoopProgressSummary(
      items,
      statusField,
      initialStatus,
      proposedStatus,
      terminalStatuses,
      activeItemFields,
      allTerminal,
    ),
  });
}

function confirmationLoopProgressSummary(
  items: unknown[],
  statusField: string,
  initialStatus: string,
  proposedStatus: string,
  terminalStatuses: readonly string[],
  activeItemFields: readonly string[],
  allTerminal: boolean,
): Record<string, unknown> {
  const terminal = new Set(terminalStatuses);
  const records = items
    .map((item, index) => ({ item, index }))
    .filter((entry): entry is { item: Record<string, unknown>; index: number } =>
      entry.item !== null && typeof entry.item === 'object' && !Array.isArray(entry.item));
  const terminalItems = records.filter(({ item }) => {
    const status = item[statusField];
    return typeof status === 'string' && terminal.has(status);
  }).length;
  const proposedItems = records.filter(({ item }) => item[statusField] === proposedStatus).length;
  const currentIndex = confirmationLoopActiveItemIndex(records, statusField, initialStatus, proposedStatus, terminalStatuses);
  const activeRecord = currentIndex >= 0 ? records.find(({ index }) => index === currentIndex)?.item : undefined;
  return {
    total_items: records.length,
    terminal_items: terminalItems,
    pending_items: Math.max(0, records.length - terminalItems),
    proposed_items: proposedItems,
    current_index: currentIndex,
    all_terminal: allTerminal,
    active_item: activeRecord ? confirmationLoopActiveItemView(activeRecord, activeItemFields) : {},
  };
}

function confirmationLoopActiveItemIndex(
  records: Array<{ item: Record<string, unknown>; index: number }>,
  statusField: string,
  initialStatus: string,
  proposedStatus: string,
  terminalStatuses: readonly string[],
): number {
  const terminal = new Set(terminalStatuses);
  return records.find(({ item }) => item[statusField] === proposedStatus)?.index
    ?? records.find(({ item }) => item[statusField] === initialStatus)?.index
    ?? records.find(({ item }) => {
      const status = item[statusField];
      return typeof status !== 'string' || !terminal.has(status);
    })?.index
    ?? -1;
}

function confirmationLoopActiveItemView(
  record: Record<string, unknown>,
  activeItemFields: readonly string[],
): Record<string, string> {
  return Object.fromEntries(activeItemFields.map((field) => [
    field,
    typeof record[field] === 'string' ? record[field] : String(record[field] ?? ''),
  ]));
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
      ...(typeof snapshot.get('inputs.user_decision.target_item_id') === 'string' ? { target_item_id: String(snapshot.get('inputs.user_decision.target_item_id')) } : {}),
      ...(typeof snapshot.get('inputs.user_decision.target_item_title') === 'string' ? { target_item_title: String(snapshot.get('inputs.user_decision.target_item_title')) } : {}),
      ...(typeof snapshot.get('inputs.user_decision.target_item_status') === 'string' ? { target_item_status: String(snapshot.get('inputs.user_decision.target_item_status')) } : {}),
      ...(typeof snapshot.get('inputs.user_decision.timestamp') === 'string' ? { timestamp: String(snapshot.get('inputs.user_decision.timestamp')) } : {}),
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
  registeredTools: RegisteredToolDescriptor[] = [],
): string {
  void documents;
  const stageActions = codegenStageActions(transitionActions, confirmationLoops);
  const lifecycleTransitions = collectionLifecycle
    ? collectionLifecycleLlmTransitions(collectionLifecycle)
    : [];
  const stageMetadata = stageActions.map((action) => {
  const reasoningContract = action.archetype === 'llm-reasoning' ? reasoningContractsBySlug.get(action.source) : undefined;
  const outputPath = isConversationalHubTransitionAction(action)
    ? undefined
    : action.archetype === 'llm-reasoning'
      ? `${action.source}.result_json`
      : `${action.source}.output`;
  const itemsPath = isConversationalHubTransitionAction(action)
    ? undefined
    : action.archetype === 'llm-reasoning'
      ? `${action.source}.items_json`
      : `${action.source}.output.items_json`;
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
    ${outputPath ? `output_path: ${tsString(outputPath)},` : 'output_path: undefined,'}
    ${itemsPath ? `items_path: ${tsString(itemsPath)},` : 'items_path: undefined,'}${reasoningLines}
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

  const registeredToolImport = registeredTools.some((tool) => tool.name === 'web_search')
    ? `\nimport { createWebSearchProvider } from '../../../libraries/search/index.js';`
    : '';
  const registeredToolRegistrations = registeredTools.length === 0
    ? `  // Stage actions are native action_map entries. Real service adapters belong
  // behind generated external-adapter stage bodies, not extra topology actions.
  void _registry;`
    : registeredTools.map((tool) => {
      if (tool.name !== 'web_search') {
        throw new Error(`unsupported registered tool ${tool.name}`);
      }
      return '  registerWebSearchTool(registry);';
    }).join('\n');
  const registeredToolHelpers = registeredTools.some((tool) => tool.name === 'web_search')
    ? `
function registerWebSearchTool(registry: ToolRegistry): void {
  let webProvider: ReturnType<typeof createWebSearchProvider> | null = null;

  registry.register('web_search', {
    kind: 'local',
    fn: async (args: Record<string, unknown>) => {
      const query = String(args.query ?? '').trim();
      const jurisdiction = typeof args.jurisdiction === 'string' && args.jurisdiction.trim()
        ? args.jurisdiction.trim()
        : '';
      const maxResults = typeof args.max_results === 'number' && args.max_results > 0
        ? Math.min(Math.floor(args.max_results), 20)
        : 8;

      if (!query) {
        return { status: 'failed', error: 'Empty query', query: '', results: [], result_count: 0 };
      }

      try {
        if (!webProvider) {
          webProvider = createWebSearchProvider();
        }
        const fullQuery = jurisdiction && !query.toLowerCase().includes(jurisdiction.toLowerCase())
          ? \`\${query} \${jurisdiction}\`
          : query;
        const searched = await webProvider.search(fullQuery);
        const results = searched.results.slice(0, maxResults).map((entry) => {
          const record = entry && typeof entry === 'object' && !Array.isArray(entry)
            ? entry as Record<string, unknown>
            : {};
          return {
            title: typeof record.title === 'string' ? record.title : '',
            url: typeof record.url === 'string' ? record.url : '',
            snippet: typeof record.snippet === 'string' ? record.snippet : '',
            score: typeof record.score === 'number' ? record.score : undefined,
          };
        });
        return {
          status: 'ok',
          query: fullQuery,
          jurisdiction,
          result_count: results.length,
          results,
        };
      } catch (error) {
        return {
          status: 'failed',
          query,
          jurisdiction,
          result_count: 0,
          results: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}
`
    : '';
  const registryParamName = registeredTools.length === 0 ? '_registry' : 'registry';

  const registeredToolNames = `[${registeredTools.map((tool) => tsString(tool.name)).join(', ')}] as const`;

  return `import type { ToolRegistry } from '@simodelne/pgas-server/plugin.js';${registeredToolImport}

// Native stage actions are declared in specs.yml action_map. This metadata gives
// implementers one fillable local-tool slot per synthesized stage without adding
// extra invoke_tool_* actions to the engine topology.
export const stageActionTools = ${metadata} as const;${lifecycleMetadata}

export const registeredToolNames = ${registeredToolNames};

export function register${toPascalCase(slug)}Tools(${registryParamName}: ToolRegistry): void {
${registeredToolRegistrations}
}
${registeredToolHelpers}`;
}

function renderContractsSource(
  stages: Stage[],
  stageClassification: ClassifiedStage[],
  transitionActions: TransitionAction[],
  reasoningContractsBySlug: Map<string, ReasoningStageContract>,
): string {
  const classified = JSON.stringify(stageClassification, null, 2);
  const domainSpecsRecord = domainSpecsByStage(stages);
  const domainSpecs = JSON.stringify(domainSpecsRecord, null, 2);
  const stageDomainSpecInputDomainField = Object.values(domainSpecsRecord).some((spec) =>
    !!spec.input_domain && typeof spec.input_domain === 'object' && !Array.isArray(spec.input_domain))
    ? '\n  input_domain?: Record<string, unknown>;'
    : '';
  const usesRecordArrayContract = [...reasoningContractsBySlug.values()].some((contract) =>
    contract.result_schema.fields.some((field) => field.type === 'record_array'));
  const reasoningFieldTypeUnion = usesRecordArrayContract
    ? "'string' | 'number' | 'boolean' | 'enum' | 'string_array' | 'record_array'"
    : "'string' | 'number' | 'boolean' | 'enum' | 'string_array'";
  const recordFieldsContractLine = usesRecordArrayContract
    ? "\n  record_fields?: Readonly<Record<string, 'string' | 'number' | 'boolean' | 'string_array'>>;"
    : '';
  const reasoningContractsBlock = reasoningContractsBySlug.size === 0
    ? ''
    : `

export interface ReasoningFieldContract {
  name: string;
  type: ${reasoningFieldTypeUnion};
  description: string;
  enum_values?: readonly string[];${recordFieldsContractLine}
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
      .filter((action) => action.name !== 'begin_work' && !isExportTransitionAction(action))
      .map((action) => ({
        action: action.name,
        stage: action.source,
        target: action.target,
        archetype: action.archetype,
        output_path: isConversationalHubTransitionAction(action)
          ? undefined
          : action.archetype === 'llm-reasoning'
            ? `${action.source}.result_json`
            : `${action.source}.output`,
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
  const stageArchetypeUnion = stageClassification.some((stage) => stage.archetype === 'conversational-hub')
    ? "'pure-compute' | 'llm-reasoning' | 'external-adapter' | 'conversational-hub'"
    : "'pure-compute' | 'llm-reasoning' | 'external-adapter'";

  return `import { createHash } from 'node:crypto';
import type { HandlerPayload } from './handlers/_resolver.js';

export type StageArchetype = ${stageArchetypeUnion};

export interface StageDomainSpec {
  reads: readonly string[];
  produces: Record<string, unknown>;
  rules: readonly string[];
  invariants: readonly string[];${stageDomainSpecInputDomainField}
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
  targetKind: GeneratedSmokeTargetKind = 'standalone_repo',
): string {
  const documentFanOutSmokeChild = documents
    ? delegationChildren.find((child) =>
      childHasDocumentFanOut(child, documents) &&
      (child.synthesize_child?.kind === 'worker' || child.synthesize_child?.kind === 'research_agent'))
    : undefined;
  if (documents && documentFanOutSmokeChild) {
    return renderDocumentFanOutDelegationSmokeTestSource(slug, name, entryChannel, documents, documentFanOutSmokeChild, transitionActions, targetKind);
  }
  const documentIngestReuseSmokeChild = documents
    ? delegationChildren.find((child) =>
      isDocumentIngestUploadDelegationChild(child, documents) &&
      child.target_spec !== undefined &&
      child.registered_name !== undefined)
    : undefined;
  if (documents && documentIngestReuseSmokeChild) {
    return renderDocumentUploadReuseDelegationSmokeTestSource(slug, name, entryChannel, documents, documentIngestReuseSmokeChild, transitionActions, targetKind);
  }
  if (documents) {
    return renderDocumentUploadSmokeTestSource(slug, name, entryChannel, documents, transitionActions, targetKind);
  }
  // Slice B: N distinct static delegation children dispatch + settle sequentially. The
  // single-child renderers below stay byte-identical for exactly one child; only 2+ children
  // route to the multi-child smoke that dispatches + settles EVERY child against its own
  // separately-registered stub program.
  if (delegationChildren.length >= 2) {
    return renderMultiChildDelegationSmokeTestSource(slug, name, entryChannel, delegationChildren, transitionActions, targetKind);
  }
  const delegationSmokeChild = delegationChildren.find((child) =>
    child.synthesize_child?.kind === 'worker' || child.synthesize_child?.kind === 'research_agent');
  if (delegationSmokeChild) {
    return renderDelegationSmokeTestSource(slug, name, entryChannel, delegationSmokeChild, transitionActions, targetKind);
  }
  const reuseDelegationSmokeChild = delegationChildren.find((child) => child.target_spec && child.registered_name);
  if (reuseDelegationSmokeChild) {
    return renderReuseDelegationSmokeTestSource(slug, name, entryChannel, reuseDelegationSmokeChild, transitionActions, targetKind);
  }
  if (confirmationLoops.length > 0) {
    return renderConfirmationLoopSmokeTestSource(slug, name, entryChannel, confirmationLoops, completion.collection_lifecycle, targetKind);
  }
  const pathActions = actionsForCompletionPath(transitionActions, completion.final_stage);
  const authorPathActions = pathActions.filter((action) => !isExportTransitionAction(action));
  const firstMode = stages[0]?.slug ?? '';
  const initialTrigger = smokeInitialTriggerExpression(stages, entryChannel);
  const hasContractResponses = authorPathActions.some((action) =>
    action.archetype === 'llm-reasoning' && reasoningContractsBySlug.has(action.source));
  const hasHubResponses = authorPathActions.some(isConversationalHubTransitionAction);
  const responses = authorPathActions.map((action) => {
    const channel = transitionActionChannel(action, firstMode, reasoningContractsBySlug);
    if (action.archetype === 'llm-reasoning') {
      const reasoningContract = reasoningContractsBySlug.get(action.source);
      if (reasoningContract) {
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
        }, ${tsString(channel)}),`;
      }
      return `        effect(${tsString(action.name)}, {
          result_json: JSON.stringify({ stage: ${tsString(action.source)}, status: 'reasoned' }),
          items_json: JSON.stringify([${tsString(`${action.source}-item`)}]),
        }),`;
    }
    if (isConversationalHubTransitionAction(action)) {
      return `        effect(${tsString(action.name)}, {}, ${tsString(channel)}),`;
    }
    return `        effect(${tsString(action.name)}, { __stage_runtime: { now_iso: '2026-06-28T00:00:00.000Z', random: 0.25 } }),`;
  }).join('\n');
  const externalAdapterAssertions = authorPathActions
    .filter((action) => action.archetype === 'external-adapter')
    .map((action) => `      expect(serialized).toContain(${tsString(action.adapter_kind ?? 'in_memory_mock')});`)
    .join('\n');

  return `import { describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarnessAuthorResponse } from '@simodelne/pgas-server/testing.js';
${renderSmokeProgramEntryPrelude([{ slug }], targetKind)}

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
${authorPathActions.slice(1).map(() => "      await harness.trigger('continue generated smoke');").join('\n')}
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

${hasContractResponses || hasHubResponses
    ? `function effect(name: string, payload: Record<string, unknown>, channel?: string): TestHarnessAuthorResponse {
  return { actions: [{ kind: 'EffectAction', name, channel: channel ?? (name === 'begin_work' ? 'widget_output' : 'stage_output'), payload }] };
}`
    : `function effect(name: string, payload: Record<string, unknown>): TestHarnessAuthorResponse {
  return { actions: [{ kind: 'EffectAction', name, channel: name === 'begin_work' ? 'widget_output' : 'stage_output', payload }] };
}`}
`;
}

function smokeTransitionActionUsesWidgetOutput(action: TransitionAction | undefined): boolean {
  return action?.archetype === 'llm-reasoning' || action?.archetype === 'conversational-hub';
}

interface SmokeConventionProgramSource {
  readonly slug: string;
  readonly delegationResultPolicy?: { fields: Array<{ path: string; key: string }> };
}

function renderSmokeProgramEntryPrelude(
  programs: SmokeConventionProgramSource[],
  targetKind: GeneratedSmokeTargetKind,
): string {
  if (targetKind === 'existing_repo') {
    return programs
      .map(({ slug }) => `import { create${toPascalCase(slug)}ProgramEntry } from '../src/programs/${slug}/registration.js';`)
      .join('\n');
  }

  return `import {
  createToolRegistry as createSmokeConventionToolRegistry,
  loadProgramByConvention as loadSmokeProgramByConvention,
  type ProgramAdapterOverride as SmokeProgramAdapterOverride,
  type ProgramEntry as SmokeProgramEntry,
  type ReactionHandler as SmokeReactionHandler,
  type RegisterProgramByConventionOptions as SmokeRegisterProgramByConventionOptions,
  type ToolHandler as SmokeToolHandler,
} from '@simodelne/pgas-server/plugin.js';
${renderSmokeConventionProgramImports(programs)}

${renderSmokeConventionProgramHelpers(programs)}`;
}

function renderSmokeConventionProgramImports(programs: readonly SmokeConventionProgramSource[]): string {
  return programs.flatMap(({ slug }) => {
    const pascal = toPascalCase(slug);
    const camel = smokeCamelCase(slug);
    return [
      `import { createHandlerAdapterOverrides as create${pascal}HandlerAdapterOverrides, handlers as ${camel}Handlers, reactionHandlers as ${camel}ReactionHandlers } from '../src/programs/${slug}/handlers.js';`,
      `import { registeredToolNames as ${camel}RegisteredToolNames, register${pascal}Tools as ${camel}RegisterTools } from '../src/programs/${slug}/tools.js';`,
    ];
  }).join('\n');
}

function renderSmokeConventionProgramHelpers(programs: readonly SmokeConventionProgramSource[]): string {
  const entries = programs.map((program) => {
    const pascal = toPascalCase(program.slug);
    const camel = smokeCamelCase(program.slug);
    const entryOverrides = program.delegationResultPolicy
      ? `, ${renderSmokeTsValue({ delegationResultPolicy: program.delegationResultPolicy })}`
      : '';
    return `function create${pascal}ProgramEntry(): SmokeProgramEntry {
  return createSmokeConventionProgramEntry(
    '${program.slug}',
    ${camel}Handlers,
    ${camel}ReactionHandlers,
    ${camel}RegisterTools,
    ${camel}RegisteredToolNames,
    create${pascal}HandlerAdapterOverrides${entryOverrides},
  );
}`;
  }).join('\n\n');

  return `const smokeProgramsRoot = decodeURIComponent(new URL('../src', import.meta.url).pathname);

type SmokeToolRegistryInstance = ReturnType<typeof createSmokeConventionToolRegistry>;
type SmokeRegisterTools = (registry: SmokeToolRegistryInstance) => void;
type SmokeHandlerAdapterOverrides = () => Record<string, SmokeProgramAdapterOverride>;

${entries}

function createSmokeConventionProgramEntry(
  name: string,
  handlers: Record<string, SmokeToolHandler>,
  reactionHandlers: Map<string, SmokeReactionHandler>,
  registerTools: SmokeRegisterTools,
  registeredToolNames: readonly string[],
  createHandlerAdapterOverrides: SmokeHandlerAdapterOverrides,
  entryOverrides?: SmokeRegisterProgramByConventionOptions['entryOverrides'],
): SmokeProgramEntry {
  const toolRegistry = createSmokeConventionToolRegistry();
  registerTools(toolRegistry);
  const loaded = loadSmokeProgramByConvention(name, {
    programsRoot: smokeProgramsRoot,
    additionalHandlers: {
      ...handlers,
      ...smokeToolHandlerPlaceholders(toolRegistry, registeredToolNames),
    },
    reactionHandlers,
    adapterOptions: {
      overrides: {
        ...createHandlerAdapterOverrides(),
        ...smokeToolAdapterOverrides(toolRegistry, registeredToolNames),
      },
    },
    ...(entryOverrides ? { entryOverrides } : {}),
  });
  return { ...loaded.entry, spec: withSmokeConventionDecisionOnlyRegistryPrompts(loaded.entry.spec) };
}

function smokeToolHandlerPlaceholders(toolRegistry: SmokeToolRegistryInstance, registeredToolNames: readonly string[]): Record<string, SmokeToolHandler> {
  const placeholders: Record<string, SmokeToolHandler> = {};
  for (const name of registeredToolNames) {
    if (!toolRegistry.has(name)) continue;
    placeholders[\`invoke_tool_\${name}\`] = async () => {
      throw new Error(\`tool adapter for \${name} was not installed\`);
    };
  }
  return placeholders;
}

function smokeToolAdapterOverrides(toolRegistry: SmokeToolRegistryInstance, registeredToolNames: readonly string[]): Record<string, SmokeProgramAdapterOverride> {
  const overrides: Record<string, SmokeProgramAdapterOverride> = {};
  for (const name of registeredToolNames) {
    if (toolRegistry.has(name)) {
      overrides[\`tool:\${name}\`] = toolRegistry.createAdapter(name);
    }
  }
  return overrides;
}

function withSmokeConventionDecisionOnlyRegistryPrompts<T extends {
  modes?: Map<string, { decisionOnly?: boolean }>;
  prompts?: Map<string, string>;
}>(spec: T): T {
  if (!(spec.modes instanceof Map) || !(spec.prompts instanceof Map)) {
    return spec;
  }
  const prompts = new Map(spec.prompts);
  for (const [modeName, mode] of spec.modes) {
    if (mode.decisionOnly === true && !prompts.has(modeName)) {
      prompts.set(modeName, 'Decision-only auto-transition mode.');
    }
  }
  const descriptors = Object.getOwnPropertyDescriptors(spec);
  delete descriptors.prompts;
  const clone = Object.create(Object.getPrototypeOf(spec)) as T;
  Object.defineProperties(clone, descriptors);
  Object.defineProperty(clone, 'prompts', {
    value: prompts,
    enumerable: true,
    configurable: true,
  });
  return clone;
}`;
}

function smokeCamelCase(value: string): string {
  const pascal = toPascalCase(value);
  return pascal.length === 0 ? 'program' : `${pascal.charAt(0).toLowerCase()}${pascal.slice(1)}`;
}

function renderSmokeTsValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(renderSmokeTsValue).join(', ')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, entryValue]) => `${key}: ${renderSmokeTsValue(entryValue)}`);
    return `{ ${entries.join(', ')} }`;
  }
  if (typeof value === 'string') {
    return tsString(value);
  }
  return JSON.stringify(value);
}

function renderDocumentFanOutDelegationSmokeTestSource(
  slug: string,
  name: string,
  entryChannel: string,
  documents: DocumentsDescriptor,
  child: DelegationChildDescriptor,
  transitionActions: TransitionAction[],
  targetKind: GeneratedSmokeTargetKind,
): string {
  const parentPascal = toPascalCase(slug);
  const childSlug = delegationTargetSpec(child);
  const childPascal = toPascalCase(childSlug);
  const childStage = childResultStage(child);
  const childCompleteAction = `complete_${childStage}`;
  const backedResearch = child.synthesize_child?.kind === 'research_agent' && researchChildBackend(child) === 'host_connector';
  const childCompleteChannel = backedResearch ? 'stage_output' : 'widget_output';
  const childCompletePayload = backedResearch
    ? `{ __stage_runtime: { now_iso: '2026-07-26T00:00:00.000Z', random: 0.25 } }`
    : `{
          result_json: JSON.stringify({ summary: 'reviewed current document', seeded_topic: doc.content, document_id: doc.id }),
          items_json: JSON.stringify(['reviewed-' + doc.id]),
          summary: 'reviewed current document',
          seeded_topic: doc.content,
          document_id: doc.id,
        }`;
  const uploadTransition = transitionActions.find((action) => action.source === documents.stage);
  const uploadTransitionAction = uploadTransition?.name ?? `complete_${safeIdentifier(documents.stage)}`;
  const uploadTransitionChannel = smokeTransitionActionUsesWidgetOutput(uploadTransition) ? 'widget_output' : 'stage_output';
  const uploadTransitionPayload = smokeTransitionActionUsesWidgetOutput(uploadTransition)
    ? `{
          result_json: JSON.stringify({ document_source_ready: true }),
          items_json: JSON.stringify(['document-source-ready']),
        }`
    : `{ __stage_runtime: { now_iso: '2026-07-26T00:00:00.000Z', random: 0.25 } }`;
  const fanOutTransition = transitionActions.find((action) => action.source === child.stage);
  const fanOutTransitionAction = fanOutTransition?.name ?? `complete_${safeIdentifier(child.stage)}`;
  const fanOutTransitionChannel = smokeTransitionActionUsesWidgetOutput(fanOutTransition) ? 'widget_output' : 'stage_output';
  const fanOutTransitionPayload = smokeTransitionActionUsesWidgetOutput(fanOutTransition)
    ? `{
          result_json: JSON.stringify({ reviewed_document_count: 5, status: 'complete' }),
          items_json: JSON.stringify(['five document review delegations']),
        }`
    : `{ __stage_runtime: { now_iso: '2026-07-26T00:00:00.000Z', random: 0.25 } }`;
  const fanOut = documentFanOutDescriptor(child, documents);
  if (!fanOut) {
    throw new Error('document fan-out smoke requires a document fan_out child');
  }
  const base = delegationStateBase(child);
  const scriptEntries = `scripted(effect('begin_work', {})),
        scripted(effect('${DOCUMENT_REQUEST_ACTION}', {})),
        scripted(effect('${DOCUMENT_INGEST_ACTION}', {}, 'stage_output')),
        scripted(effect(${tsString(uploadTransitionAction)}, ${uploadTransitionPayload}, ${tsString(uploadTransitionChannel)})),
        ...fixtures.flatMap((doc) => [
          scripted(effect(${tsString(delegationRequestActionName(child))}, { request: { intent: 'review-current-document' } }, ${tsString(delegationChannelName(child))})),
          scripted(effect('begin_work', {}), doc.content),
          scripted(effect(${tsString(childCompleteAction)}, ${childCompletePayload}, ${tsString(childCompleteChannel)}), doc.content),
        ]),
        scripted(effect(${tsString(fanOutTransitionAction)}, ${fanOutTransitionPayload}, ${tsString(fanOutTransitionChannel)})),`;
  return `import { File } from 'node:buffer';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import { appTransport, createPgasClient, type PgasClient } from '@simodelne/pgas-server/client.js';
${renderSmokeProgramEntryPrelude([
    { slug },
    { slug: childSlug, delegationResultPolicy: delegationResultPolicyForChild(child) },
  ], targetKind)}

describe('generated document fan-out review smoke', () => {
  it('runs five document review delegations through the route for ${name}', async () => {
    const fixtures = [
      { id: 'doc1', name: 'doc-1.txt', content: 'Document one material contract text.' },
      { id: 'doc2', name: 'doc-2.txt', content: 'Document two diligence exhibit text.' },
      { id: 'doc3', name: 'doc-3.txt', content: 'Document three lease schedule text.' },
      { id: 'doc4', name: 'doc-4.txt', content: 'Document four financial statement text.' },
      { id: 'doc5', name: 'doc-5.txt', content: 'Document five board consent text.' },
    ];
    const result = await runDocumentFanOutScenario(fixtures, [
      ${scriptEntries}
    ]);

    const fanOutResults = fanOutResultsAt(result.final.domain, ${tsString(fanOut.result_path)});
    if (Object.keys(fanOutResults).length === 0) {
      throw new Error(\`empty fan-out results: \${JSON.stringify(result.final.domain)}\`);
    }
    expect(Object.keys(fanOutResults).sort()).toEqual(fixtures.map((fixture) => fixture.id).sort());
    const sessionIds = new Set<string>();
    for (const fixture of fixtures) {
      const review = fanOutResults[fixture.id];
      expect(isRecord(review)).toBe(true);
      expect(review.document_id).toBe(fixture.id);
      expect(review.document_name).toBe(fixture.name);
      expect(review.seeded_topic).toBe(fixture.content);
      expect(review.status).toBe('complete');
      expect(typeof review.sessionId).toBe('string');
      sessionIds.add(String(review.sessionId));
    }
    expect(sessionIds.size).toBe(5);
    expect(result.final.domain[${tsString(fanOut.index_path ?? `${child.stage}.fan_out.index`)}]).toBe(5);
    expect(result.final.domain[${tsString(fanOut.completion_guard)}]).toBe(true);
    expect(result.final.domain[${tsString(`${base}.requested`)}]).toBe(false);
    expect(result.final.mode).toBe('complete');
  });
});

interface Snapshot {
  mode: string | null;
  domain: Record<string, unknown>;
  awaiting?: Record<string, unknown>;
}

interface ScriptedAuthorResponse {
  response: ReturnType<typeof effect>;
  expectPromptIncludes?: string;
}

interface Fixture {
  id: string;
  name: string;
  content: string;
}

async function runDocumentFanOutScenario(
  fixtures: Fixture[],
  script: ScriptedAuthorResponse[],
): Promise<{ final: Snapshot }> {
  const tempDir = mkdtempSync(join(tmpdir(), 'pgas-generated-document-fanout-smoke-'));
  const server = await createPgasServer({
    programs: [
      { name: ${tsString(slug)}, entry: create${parentPascal}ProgramEntry() },
      { name: ${tsString(childSlug)}, entry: create${childPascal}ProgramEntry() },
    ],
    drivers: {
      authorHandle: scriptedAuthor(script),
      observerHandle: {
        modelId: 'generated-document-fanout-smoke-observer',
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
    await client.sessions.trigger(sessionId, { channel: ${tsString(entryChannel)}, payload: 'start generated document fan-out review smoke' });
    await client.sessions.trigger(sessionId, { channel: ${tsString(entryChannel)}, payload: 'request generated document upload' });
    const afterRequest = await readSnapshot(client, sessionId);
    expect(afterRequest.mode).toBe(${tsString(documents.stage)});
    expect(afterRequest.awaiting?.channelId).toBe('${DOCUMENT_UPLOAD_CHANNEL}');
    const upload = await uploadTextFiles(client, sessionId, fixtures);
    const refs = refsFromUpload(upload);
    expect(refs).toHaveLength(fixtures.length);
    await client.sessions.trigger(sessionId, {
      channel: '${DOCUMENT_UPLOAD_CHANNEL}',
      payload: { ['${DOCUMENT_INTAKE_ROOT}.file_refs']: refs.map((ref) => ({ fileId: ref.fileId, name: ref.name })) },
    });
    for (let attempt = 0; attempt < fixtures.length + 4; attempt += 1) {
      const snapshot = await readSnapshot(client, sessionId);
      if (snapshot.mode === 'complete' || snapshot.domain[${tsString(fanOut.completion_guard)}] === true) {
        return { final: snapshot };
      }
      try {
        await client.sessions.trigger(sessionId, { channel: ${tsString(entryChannel)}, payload: \`continue generated document fan-out review smoke \${String(attempt + 1)}\` });
      } catch (error) {
        if (!String((error as Error).message).includes('terminal')) {
          throw error;
        }
        return { final: await readSnapshot(client, sessionId) };
      }
    }
    return { final: await readSnapshot(client, sessionId) };
  } finally {
    await server.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function uploadTextFiles(client: PgasClient, sessionId: string, fixtures: Fixture[]): Promise<unknown> {
  const form = new FormData();
  for (const fixture of fixtures) {
    const file = new File([fixture.content], fixture.name, { type: 'text/plain' });
    form.append('files', file as unknown as Blob, file.name);
  }
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

function fanOutResultsAt(domain: Record<string, unknown>, pathKey: string): Record<string, Record<string, unknown>> {
  const raw = resultAt(domain, pathKey);
  const grouped: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(raw)) {
    const [documentId, ...fieldParts] = key.split('.');
    if (!documentId) {
      continue;
    }
    const record = grouped[documentId] ?? {};
    if (fieldParts.length === 0 && isRecord(value)) {
      grouped[documentId] = { ...record, ...value };
    } else if (fieldParts.length > 0) {
      record[fieldParts.join('.')] = value;
      grouped[documentId] = record;
    }
  }
  return grouped;
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
    modelId: 'generated-document-fanout-smoke-author',
    async complete(prompt: string) {
      const response = responses[index++];
      if (!response) {
        throw new Error(\`no generated document fan-out smoke author response scripted for call \${String(index - 1)}\`);
      }
      if (response.expectPromptIncludes && !prompt.includes(response.expectPromptIncludes)) {
        throw new Error(\`expected generated document fan-out prompt to include \${response.expectPromptIncludes}\`);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
`;
}

function renderDocumentUploadReuseDelegationSmokeTestSource(
  slug: string,
  name: string,
  entryChannel: string,
  documents: DocumentsDescriptor,
  child: DelegationChildDescriptor,
  transitionActions: TransitionAction[],
  targetKind: GeneratedSmokeTargetKind,
): string {
  const parentPascal = toPascalCase(slug);
  const childTargetSpec = delegationTargetSpec(child);
  const childRegistryName = child.registered_name ?? child.target_slug ?? childTargetSpec;
  const transitionAction = transitionActions.find((action) => action.source === documents.stage);
  const transitionActionName = transitionAction?.name ?? `complete_${safeIdentifier(documents.stage)}`;
  const transitionChannel = smokeTransitionActionUsesWidgetOutput(transitionAction) ? 'widget_output' : 'stage_output';
  const transitionPayload = smokeTransitionActionUsesWidgetOutput(transitionAction)
    ? `{
          result_json: JSON.stringify({ document_ingest_settled: true }),
          items_json: JSON.stringify(['document-ingest-settled']),
        }`
    : `{ __stage_runtime: { now_iso: '2026-07-16T00:00:00.000Z', random: 0.25 } }`;
  const expectedPostIngestMode = transitionAction?.target ?? documents.stage;
  const resultPath = documents.result_path;
  const readyPath = documentsSourceReadyPath(documents);
  const base = delegationStateBase(child);
  const delegationResultPath = child.result_path;
  const childSpecYaml = `name: ${JSON.stringify(childTargetSpec)}

features:
  - base

pure: true

schema:
  inputs.user_text: string
  inputs.request: object
  inputs.domain_context: object
  child.received: boolean
  work.done: boolean
  work.summary: string
  work.structured_data: object
  work.seeded_topic: string

modes:
  receive:
    vocabulary: [accept_request]
    channels: [user_text, child_output]
    transitions:
      - target: work
        when: { kind: FieldTruthy, path: child.received }
  work:
    vocabulary: [finish_work]
    channels: [user_text, child_output]
    transitions:
      - target: complete
        when: { kind: FieldTruthy, path: work.done }
  complete:
    vocabulary: []
    channels: [child_output]

initial: receive

terminal: [complete]

topology: CyclicTopology

termination: BoundedSession

proceeds_to:
  accept_request: work
  finish_work: complete

channels:
  user_text: { direction: In, sync: Async }
  child_output: { direction: Out, sync: Sync }

fallback:
  channel: child_output
  payload: { ok: false }

ingestion:
  user_text:
    - inputs.user_text

action_map:
  accept_request:
    description: "Record that the delegated document-ingest request was received."
    mutations:
      - { op: MSet, path: child.received, value: true }
    channel: child_output
  finish_work:
    description: "Complete delegated document ingest."
    mutations:
      - { op: MSet, path: work.done, value: true }
      - { op: MSet, path: work.summary, from_arg: summary }
      - { op: MSet, path: work.structured_data, from_arg: structured_data }
      - { op: MSet, path: work.seeded_topic, from_arg: seeded_topic }
    channel: child_output

preamble: |
  Inline document-ingest manifest-reuse smoke child for ${name}.

prompts:
  receive: "Accept the delegated document-ingest request."
  work: "Finish document ingest and return summary plus sections."
  complete: "Terminal."

repair_bound: 2

projection:
  receive:
    include: [inputs.request, inputs.domain_context]
    exclude: []
  work:
    include: [inputs.request, child.received, work.summary, work.structured_data]
    exclude: []
  complete:
    include: [inputs.request, child.received, work.done, work.summary, work.structured_data]
    exclude: []
`;
  return `import { File } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
${renderSmokeProgramEntryPrelude([{ slug }], targetKind)}

describe('generated document upload plus manifest reuse delegation smoke', () => {
  it('runs required upload and reused document-ingest delegation through the route for ${name}', async () => {
    const sentinel = \`PGAS-UPLOAD-SENTINEL-\${randomUUID()}\`;
    const content = [
      'Generated route-level upload smoke fixture.',
      sentinel,
      'ASCII payload keeps byte length equal to character count for exact assertions.',
    ].join('\\n');
    const result = await runUploadDelegationScenario([
      scripted(effect('begin_work', {})),
      scripted(effect('${DOCUMENT_REQUEST_ACTION}', {})),
      scripted(effect('${DOCUMENT_INGEST_ACTION}', {}, 'stage_output')),
      scripted(effect(${tsString(delegationRequestActionName(child))}, {}, ${tsString(delegationChannelName(child))})),
      scripted(effect('accept_request', { accepted: true }, 'child_output')),
      scripted(effect('finish_work', {
        summary: 'complete document ingest',
        structured_data: {
          summary: 'complete document ingest',
          sections: [{
            id: 'sec-1',
            heading: 'Uploaded Source',
            status: 'ready',
            text: content,
          }],
        },
        seeded_topic: content,
      }, 'child_output')),
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
    const delegationResult = resultAt(result.final.domain, ${tsString(delegationResultPath)});
    expect(delegationResult.status, JSON.stringify(result.final.domain)).toBe('complete');
    expect(delegationResult.summary).toBe('complete document ingest');
    expect(result.final.domain[${tsString(`${base}.settled`)}]).toBe(true);
    expect(result.final.domain[${tsString(`${base}.degraded`)}]).toBe(false);
    expect(firstDefined(source.summary, result.final.domain[${tsString(`${resultPath}.summary`)}])).toBe('complete document ingest');
    expect(firstDefined(nestedValue(source, 'sections.sec-1.text'), result.final.domain[${tsString(`${resultPath}.sections.sec-1.text`)}])).toBe(result.upload?.content);
    expect(result.final.mode).toBe(${tsString(expectedPostIngestMode)});
  });
});

interface Snapshot {
  mode: string | null;
  domain: Record<string, unknown>;
  awaiting?: Record<string, unknown>;
}

interface ScriptedAuthorResponse {
  response: ReturnType<typeof effect>;
  expectPromptIncludes?: string;
}

interface UploadEvidence {
  fileRef: Record<string, unknown>;
  content: string;
  sentinel: string;
}

async function runUploadDelegationScenario(
  script: ScriptedAuthorResponse[],
  act: (ctx: { client: PgasClient; sessionId: string }) => Promise<UploadEvidence | void>,
): Promise<{ afterRequest: Snapshot; afterUpload: Snapshot; final: Snapshot; upload?: UploadEvidence }> {
  const tempDir = mkdtempSync(join(tmpdir(), 'pgas-generated-upload-reuse-delegation-smoke-'));
  const server = await createPgasServer({
    programs: [
      { name: ${tsString(slug)}, entry: create${parentPascal}ProgramEntry() },
      { name: ${tsString(childRegistryName)}, entry: createDocumentIngestStubChildEntry(tempDir) },
    ],
    drivers: {
      authorHandle: scriptedAuthor(script),
      observerHandle: {
        modelId: 'generated-upload-reuse-delegation-smoke-observer',
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
    await client.sessions.trigger(sessionId, { channel: ${tsString(entryChannel)}, payload: 'start generated upload reuse delegation smoke' });
    await client.sessions.trigger(sessionId, { channel: ${tsString(entryChannel)}, payload: 'request generated document upload' });
    const afterRequest = await readSnapshot(client, sessionId);
    expect(afterRequest.mode).toBe(${tsString(documents.stage)});
    expect(afterRequest.awaiting?.channelId).toBe('${DOCUMENT_UPLOAD_CHANNEL}');
    const upload = await act({ client, sessionId }) ?? undefined;
    const afterUpload = await readSnapshot(client, sessionId);
    let final = afterUpload;
    for (let attempt = 0; attempt < 8 && final.mode !== ${tsString(expectedPostIngestMode)}; attempt += 1) {
      await client.sessions.trigger(sessionId, { channel: ${tsString(entryChannel)}, payload: \`continue generated upload reuse delegation smoke \${String(attempt + 1)}\` });
      final = await readSnapshot(client, sessionId);
    }
    return { afterRequest, afterUpload, final, ...(upload ? { upload } : {}) };
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

function stripConventionSidecarsForRawLoader(source: string): string {
  const sidecars = new Set(['view', 'render', 'policies', 'capabilities', 'composite', 'notebook']);
  const lines: string[] = [];
  let skipping = false;
  for (const line of source.split(/\\r?\\n/u)) {
    const topLevel = /^(\\S[^:]*):/u.exec(line);
    if (topLevel) {
      skipping = sidecars.has(topLevel[1]);
      if (skipping) continue;
    }
    if (skipping) continue;
    lines.push(line);
  }
  return lines.join('\\n');
}

function createDocumentIngestStubChildEntry(tempDir: string): ProgramEntry {
  const specPath = join(tempDir, 'document-ingest-stub-specs.yml');
  writeFileSync(specPath, documentIngestStubChildSpec(), 'utf8');
  const { spec } = loadSpecWithPatterns(specPath);
  return {
    spec,
    delegationResultPolicy: {
      fields: [
        { path: 'work.summary', key: 'summary' },
        { path: 'work.structured_data', key: 'structured_data' },
        { path: 'work.seeded_topic', key: 'seeded_topic' },
      ],
    },
    createAdapters: (ctx) => createProgramAdapters(spec, ctx, documentIngestStubHandlers),
  };
}

const documentIngestStubHandlers: Record<string, ToolHandler> = {
  async accept_request(payload) {
    return { ok: true, action: 'accept_request', payload };
  },
  async finish_work(payload) {
    return { ok: true, action: 'finish_work', payload };
  },
};

function documentIngestStubChildSpec(): string {
  return ${JSON.stringify(childSpecYaml)};
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
}

function nestedValue(record: Record<string, unknown>, path: string): unknown {
  let current: unknown = record;
  for (const part of path.split('.')) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function scriptedAuthor(responses: ScriptedAuthorResponse[]) {
  let index = 0;
  return {
    modelId: 'generated-upload-reuse-delegation-smoke-author',
    async complete(prompt: string) {
      const response = responses[index++];
      if (!response) {
        throw new Error(\`no generated upload reuse delegation smoke author response scripted for call \${String(index - 1)}\`);
      }
      if (response.expectPromptIncludes && !prompt.includes(response.expectPromptIncludes)) {
        throw new Error(\`expected generated upload reuse delegation prompt to include \${response.expectPromptIncludes}\`);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
`;
}

function renderDocumentUploadSmokeTestSource(
  slug: string,
  name: string,
  entryChannel: string,
  documents: DocumentsDescriptor,
  transitionActions: TransitionAction[],
  targetKind: GeneratedSmokeTargetKind,
): string {
  const transitionAction = transitionActions.find((action) => action.source === documents.stage);
  const transitionActionName = transitionAction?.name ?? `complete_${safeIdentifier(documents.stage)}`;
  const transitionChannel = smokeTransitionActionUsesWidgetOutput(transitionAction) ? 'widget_output' : 'stage_output';
  const transitionPayload = smokeTransitionActionUsesWidgetOutput(transitionAction)
    ? `{
          result_json: JSON.stringify({ document_source_ready: true }),
          items_json: JSON.stringify(['document-source-ready']),
        }`
    : `{ __stage_runtime: { now_iso: '2026-07-16T00:00:00.000Z', random: 0.25 } }`;
  const expectedPostIngestMode = transitionAction?.target ?? documents.stage;
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
    expect(result.final.mode).toBe(${tsString(expectedPostIngestMode)});
  });`;
  return `import { File } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import { appTransport, createPgasClient, type PgasClient } from '@simodelne/pgas-server/client.js';
${renderSmokeProgramEntryPrelude([{ slug }], targetKind)}

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
    expect(result.final.mode).toBe(${tsString(expectedPostIngestMode)});
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
    for (let attempt = 0; attempt < 4 && final.mode !== ${tsString(expectedPostIngestMode)}; attempt += 1) {
      await client.sessions.trigger(sessionId, { channel: ${tsString(entryChannel)}, payload: \`continue generated upload smoke \${String(attempt + 1)}\` });
      final = await readSnapshot(client, sessionId);
    }
    if (afterUpload.mode === ${tsString(expectedPostIngestMode)}) {
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
    for (let attempt = 0; attempt < 4 && final.mode !== ${tsString(expectedPostIngestMode)}; attempt += 1) {
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
  targetKind: GeneratedSmokeTargetKind = 'standalone_repo',
): string {
  if (!lifecycle) {
    throw new Error('confirmation-loop smoke requires collection_lifecycle');
  }
  const loop = loops[0] as ConfirmationLoopDescriptor;
  const reactionNames = loops.flatMap((loop) => [
    confirmationLoopSaveReactionName(loop),
    confirmationLoopEnforceReactionName(loop),
    confirmationLoopSummarizeReactionName(loop),
    confirmationLoopChoreographReactionName(loop),
  ]);
  return `import { describe, expect, it } from 'vitest';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import { appTransport, createPgasClient, type PgasClient } from '@simodelne/pgas-server/client.js';
${renderSmokeProgramEntryPrelude([{ slug }], targetKind)}
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
          effect('session_status', { status: 'All confirmation-loop items resolved.' }),
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
    delegation_result_policy: delegationResultPolicyForChild(child),
    spec_yaml: specYaml,
    spec_files: modularSpecFilesForYamlIfComplete(specYaml) ?? artifact.spec_files,
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
    delegation_result_policy: delegationResultPolicyForChild(child),
    spec_yaml: specYaml,
    spec_files: modularSpecFilesForYamlIfComplete(specYaml) ?? artifact.spec_files,
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
  const seedsTopic = delegationSeedsRequestTopic(child);
  const emitsSeededTopic = delegationEchoesSeededTopic(child);
  const commonRequestReads = [
    ...(seedsTopic ? ['inputs.request.topic'] : []),
    'inputs.request.document_id',
    'inputs.request.document_name',
    'inputs.domain_context.source_program',
  ];
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
          reads: commonRequestReads,
          produces: {},
          rules: ['Accept the delegated request seeded by the parent session.'],
          invariants: seedsTopic
            ? ['Do not invent a different request topic.']
            : ['Keep the delegated request scoped to parent-provided inputs.'],
        },
      },
      {
        slug: 'work',
        domain_spec: {
          reads: [...commonRequestReads, 'inputs.domain_context.original_request'],
          produces: {
            result_json: Object.fromEntries(Object.keys(resultFields).map((field) => [field, 'string'])),
            items_json: [emitsSeededTopic ? `${child.id}:<seeded_topic>` : `${child.id}:summary:<summary>`],
          },
          rules: [
            'Produce the delegated worker result from the seeded request.',
            ...(emitsSeededTopic
              ? ['Echo inputs.request.topic exactly into work.result.seeded_topic when that field exists.']
              : []),
          ],
          invariants: emitsSeededTopic
            ? ['The exported seeded_topic proves parent input enrichment reached the child.']
            : ['Derive delegated worker results only from projected request and domain context.'],
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
  const emitsSeededTopic = delegationEchoesSeededTopic(child);
  const fields = Object.entries(rawFields).map(([name, rawType]) => ({
    name,
    type: reasoningFieldTypeFor(rawType),
    description: name === 'seeded_topic' && emitsSeededTopic
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
          : field.name === 'seeded_topic' && emitsSeededTopic
            ? 'seeded delegation topic'
            : `${field.name}-sample`,
  ]));
  return {
    contract_version: REASONING_CONTRACT_VERSION,
    stage: 'work',
    reasoning_prompt: emitsSeededTopic
      ? `Complete delegated worker request ${child.id}. Use the projected inputs.request.topic, inputs.request.document_id, inputs.request.document_name, and inputs.domain_context fields. Return the requested result fields; seeded_topic must exactly echo inputs.request.topic when present.`
      : `Complete delegated worker request ${child.id}. Use the projected inputs.request and inputs.domain_context fields. Return the requested result fields.`,
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
  const seedsTopic = delegationSeedsRequestTopic(child);
  const emitsSeededTopic = delegationEchoesSeededTopic(child);
  const commonRequestReads = [
    ...(seedsTopic ? ['inputs.request.topic'] : []),
    'inputs.request.document_id',
    'inputs.request.document_name',
    'inputs.domain_context.source_program',
  ];
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
          reads: commonRequestReads,
          produces: {},
          rules: ['Accept the delegated research request seeded by the parent session.'],
          invariants: seedsTopic
            ? ['Do not invent a different request topic.']
            : ['Keep the delegated research request scoped to parent-provided inputs.'],
        },
      },
      {
        slug: 'research',
        domain_spec: {
          reads: [
            ...(seedsTopic ? ['inputs.request.topic'] : []),
            'inputs.request.query',
            'inputs.request.document_id',
            'inputs.request.document_name',
            'inputs.domain_context.source_program',
            'inputs.domain_context.original_request',
          ],
          produces: {
            result_json: backend === 'host_connector'
              ? { ...resultSchema, adapter_kind: 'string' }
              : resultSchema,
            items_json: [emitsSeededTopic ? `${child.id}:<seeded_topic>` : `${child.id}:research:<summary>`],
          },
          rules: backend === 'host_connector'
            ? [
                'Do not implement a real research backend in foundry code.',
                'Use only the fixture-backed in-memory mock research connector.',
                ...(emitsSeededTopic
                  ? ['Echo inputs.request.topic exactly into the seeded_topic result field when that field exists.']
                  : []),
              ]
            : [
                'Research over the delegated request using only the projected inputs.request and inputs.domain_context fields.',
                ...(emitsSeededTopic
                  ? ['Echo inputs.request.topic exactly into research.result.seeded_topic when that field exists.']
                  : []),
              ],
          invariants: backend === 'host_connector'
            ? [
                'adapter_kind must be in_memory_mock.',
                ...(emitsSeededTopic
                  ? ['The exported seeded_topic proves parent input enrichment reached the child.']
                  : []),
              ]
            : emitsSeededTopic
              ? ['The exported seeded_topic proves parent input enrichment reached the child.']
              : ['Derive delegated research results only from projected request and domain context.'],
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
  const emitsSeededTopic = delegationEchoesSeededTopic(child);
  const fields = Object.entries(rawFields).map(([name, rawType]) => ({
    name,
    type: reasoningFieldTypeFor(rawType),
    description: name === 'seeded_topic' && emitsSeededTopic
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
          : field.name === 'seeded_topic' && emitsSeededTopic
            ? 'seeded delegation topic'
            : `${field.name}-sample`,
  ]));
  return {
    contract_version: REASONING_CONTRACT_VERSION,
    stage: 'research',
    reasoning_prompt: emitsSeededTopic
      ? `Complete delegated research request ${child.id}. Use the projected inputs.request.topic, inputs.request.query, inputs.request.document_id, inputs.request.document_name, and inputs.domain_context fields. Return the requested result fields; seeded_topic must exactly echo inputs.request.topic when present.`
      : `Complete delegated research request ${child.id}. Use the projected inputs.request, inputs.request.query, inputs.request.document_id, inputs.request.document_name, and inputs.domain_context fields. Return the requested result fields.`,
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
  const seedsTopic = delegationSeedsRequestTopic(child);
  const emitsSeededTopic = delegationEchoesSeededTopic(child);
  const schema = recordField(spec, 'schema');
  schema['inputs.request'] = 'object';
  schema['inputs.request.intent'] = 'string';
  schema['inputs.request.query'] = 'string';
  if (seedsTopic) {
    schema['inputs.request.topic'] = 'string';
  }
  schema['inputs.request.document_id'] = 'string';
  schema['inputs.request.document_name'] = 'string';
  schema['inputs.domain_context'] = 'object';
  schema['inputs.domain_context.source_program'] = 'string';
  schema['inputs.domain_context.source_session_id'] = 'string';
  schema['inputs.domain_context.owner_session_id'] = 'string';
  schema['inputs.domain_context.target_program'] = 'string';
  schema['inputs.domain_context.delegation_chain'] = 'array';
  schema['inputs.domain_context.original_request'] = 'string';
  const delegatedInputPaths = delegatedChildInputPaths(child);
  for (const inputPath of delegatedInputPaths) {
    declareDelegatedInputPath(schema, inputPath);
  }

  const projection = recordField(spec, 'projection');
  for (const modeName of ['receive', middleStage, 'complete']) {
    const modeProjection = recordField(projection, modeName);
    const include = Array.isArray(modeProjection.include) ? modeProjection.include as string[] : [];
    modeProjection.include = unique([
      ...include,
      'inputs.request',
      'inputs.request.intent',
      'inputs.request.query',
      ...(seedsTopic ? ['inputs.request.topic'] : []),
      'inputs.request.document_id',
      'inputs.request.document_name',
      'inputs.domain_context',
      'inputs.domain_context.source_program',
      'inputs.domain_context.original_request',
      ...delegatedInputPaths,
    ]);
  }

  const prompts = recordField(spec, 'prompts');
  prompts.receive = `${String(prompts.receive ?? '')}\nAccept the delegated request; inputs.request and inputs.domain_context are seeded by the parent delegation.`;
  prompts[middleStage] = emitsSeededTopic
    ? `${String(prompts[middleStage] ?? '')}\nUse inputs.request.topic as the delegated topic. For document-slice delegations, inputs.request.document_id and inputs.request.document_name identify the only target document. The seeded_topic result field, when present, must echo inputs.request.topic exactly.`
    : `${String(prompts[middleStage] ?? '')}\nUse only the delegated inputs projected under inputs.request and inputs.domain_context.`;

  const actionMap = recordField(spec, 'action_map');
  const completeStage = recordField(actionMap, `complete_${middleStage}`);
  const mutations = Array.isArray(completeStage.mutations) ? completeStage.mutations as MutableRecord[] : [];
  for (const mutation of mutations) {
    if (emitsSeededTopic && mutation.path === `${middleStage}.raw_result_fields.seeded_topic`) {
      mutation.value = '';
      mutation.from_arg = 'seeded_topic';
      mutation.from_state = 'inputs.request.topic';
    }
  }
  completeStage.mutations = mutations;

  // Same canonical blueprint block order as the parent emission: a delegated
  // CHILD spec that fails the strict blueprint gate is the same v6 failure.
  const rendered = dump(canonicalBlueprintRootOrder(spec), { lineWidth: -1, noRefs: true, sortKeys: false });
  validateSynthesizedSpec(rendered);
  return rendered;
}

function delegatedChildInputPaths(child: DelegationChildDescriptor): string[] {
  return unique(Object.keys(child.payload_map).map((target) => `inputs.${target}`));
}

function declareDelegatedInputPath(schema: MutableRecord, inputPath: string): void {
  const segments = inputPath.split('.');
  for (let index = 1; index < segments.length; index += 1) {
    const path = segments.slice(0, index).join('.');
    if (schema[path] === undefined) {
      schema[path] = 'object';
    }
  }
  if (schema[inputPath] === undefined || schema[inputPath] === 'object') {
    schema[inputPath] = 'string';
  }
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
    const reuseEntry = reusableAgentEntryForChild(child, availablePrograms, delegationTargetForStage(delegation, child.stage));
    if (reuseEntry) {
      changed = true;
      const { synthesize_child: _deleted, ...rewritten } = child;
      return {
        ...rewritten,
        target_spec: reuseEntry.target_spec,
        registered_name: reuseEntry.slug,
        target_slug: reuseEntry.slug,
        payload_map: adaptReusableProgramPayloadMap(child.payload_map, reuseEntry.payload_map),
        result_path: reuseEntry.result_path ?? child.result_path,
      };
    }

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
        target_slug: researchEntry.slug,
        payload_map: adaptReusableProgramPayloadMap(child.payload_map, researchEntry.payload_map),
        result_path: researchEntry.result_path ?? child.result_path,
      };
    }

    return child;
  });

  return changed ? { ...delegation, children } : delegation;
}

function adaptReusableProgramPayloadMap(
  parentPayloadMap: Record<string, string>,
  manifestPayloadMap: Record<string, string> | undefined,
): Record<string, string> {
  if (!manifestPayloadMap) {
    return parentPayloadMap;
  }

  const singleParentSource = unique(Object.values(parentPayloadMap)).length === 1
    ? Object.values(parentPayloadMap)[0]
    : undefined;

  return Object.fromEntries(
    Object.entries(manifestPayloadMap).map(([target, manifestSource]) => [
      target,
      parentPayloadMap[target] ?? singleParentSource ?? manifestSource,
    ]),
  );
}

function normalizeDelegationChildInternalIdentifiers(delegation: DelegationDescriptor): DelegationDescriptor {
  if (!Array.isArray(delegation.children) || delegation.children.length === 0) {
    return delegation;
  }

  let changed = false;
  const children = delegation.children.map((child) => {
    const normalized = normalizeDelegationChildInternalIdentifier(child);
    if (normalized !== child) {
      changed = true;
    }
    return normalized;
  });

  return changed ? { ...delegation, children } : delegation;
}

function normalizeDelegationChildInternalIdentifier(child: DelegationChildDescriptor): DelegationChildDescriptor {
  const id = slugSafeDelegationIdentifier(child.id);
  const actionName = child.action_name === undefined
    ? undefined
    : slugSafeDelegationIdentifier(child.action_name);
  const resultPath = id === child.id
    ? child.result_path
    : normalizeDelegationResultPathForInternalId(child.result_path, child.stage, child.id, id);

  let changed = false;
  let next: DelegationChildDescriptor = child;
  if (id !== child.id || actionName !== child.action_name || resultPath !== child.result_path) {
    changed = true;
    next = {
      ...next,
      id,
      ...(actionName === undefined ? {} : { action_name: actionName }),
      result_path: resultPath,
    };
  }

  if (
    id !== child.id &&
    next.synthesize_child !== undefined &&
    next.target_spec === undefined &&
    next.synthesize_child.slug === undefined
  ) {
    changed = true;
    next = {
      ...next,
      synthesize_child: {
        ...next.synthesize_child,
        slug: child.id,
      },
    };
  }

  return changed ? next : child;
}

function slugSafeDelegationIdentifier(value: string): string {
  const normalized = normalizeProgramNameForSelfTarget(value);
  if (/^[a-z][a-z0-9_]*$/u.test(normalized)) {
    return normalized;
  }
  return `child_${normalized.length > 0 ? normalized : 'program'}`;
}

function normalizeDelegationResultPathForInternalId(
  resultPath: string,
  stage: string,
  oldId: string,
  newId: string,
): string {
  const oldBase = `${stage}.delegation.${oldId}`;
  if (resultPath === oldBase) {
    return `${stage}.delegation.${newId}`;
  }
  const oldPrefix = `${oldBase}.`;
  if (resultPath.startsWith(oldPrefix)) {
    return `${stage}.delegation.${newId}.${resultPath.slice(oldPrefix.length)}`;
  }
  return resultPath;
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
  stageTarget: string | undefined,
): WiringAvailableProgram | undefined {
  // Reuse an already-registered document-ingest/review agent when the notebook
  // names a manifest target either directly on the child or in Q5's per-stage
  // execution model. This keeps hyphenated manifest slugs external while the
  // generated child id remains a slug-safe PGAS identifier.
  const requestedTargets = reusableAgentTargetCandidates(child, stageTarget);
  if (requestedTargets.length === 0) {
    return undefined;
  }
  return availablePrograms.find((candidate) =>
    REUSABLE_AGENT_PROVIDES.includes(candidate.provides) &&
    requestedTargets.some((requestedTarget) =>
      candidate.target_spec === requestedTarget || candidate.slug === requestedTarget));
}

function reusableAgentTargetCandidates(child: DelegationChildDescriptor, stageTarget: string | undefined): string[] {
  const idFallback = child.target_spec === undefined ? [child.id] : [];
  return unique([
    child.target_spec,
    child.target_slug,
    child.registered_name,
    stageTarget,
    ...idFallback,
  ].flatMap((value) => typeof value === 'string' && value.trim().length > 0 ? [value.trim()] : []));
}

function delegationTargetForStage(delegation: DelegationDescriptor, stage: string): string | undefined {
  const descriptor = delegationDescriptorForStage(delegation, stage);
  if (!descriptor) {
    return undefined;
  }
  return [
    descriptor.target,
    descriptor.target_slug,
    descriptor.program_slug,
    descriptor.program,
    descriptor.target_spec,
    descriptor.slug,
  ].find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function delegationDescriptorForStage(
  delegation: DelegationDescriptor,
  stage: string,
): Record<string, unknown> | undefined {
  const stages = optionalRecord(delegation.stages);
  const executionModel = optionalRecord(delegation.execution_model);
  const executionModelStages = optionalRecord(executionModel?.stages);
  const legacyStage = optionalRecord(delegation[stage]);
  return optionalRecord(stages?.[stage]) ??
    optionalRecord(executionModelStages?.[stage]) ??
    legacyStage;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
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
  const emitsSeededTopic = delegationEchoesSeededTopic(child);
  const fieldEntries = Object.entries(child.synthesize_child?.result_fields ?? {})
    .map(([field, type]) => {
      if (field === 'seeded_topic' && emitsSeededTopic) {
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
${emitsSeededTopic ? `  const topic = stringFact(input.domain['inputs.request.topic'], 'seeded delegation topic');` : ''}
  const result = {
${fieldEntries}
    adapter_kind: 'in_memory_mock',
  };
  return {
    result_json: JSON.stringify(result),
    items_json: JSON.stringify([${emitsSeededTopic ? '`research:${topic}`' : "'research:complete'"}]),
    digest: '',
    adapter_kind: 'in_memory_mock',
  };
}

${emitsSeededTopic ? `
function stringFact(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}
` : ''}
`;
}

type DelegationInputEnrichmentRule = NonNullable<ProgramDelegationPolicy['inputEnrichment']>[number];

function delegationPolicyForChildren(children: DelegationChildDescriptor[]): {
  allowedTargetPrograms: string[];
  inputEnrichment: DelegationInputEnrichmentRule[];
} {
  const inputEnrichment: DelegationInputEnrichmentRule[] = [];
  const seenEnrichment = new Set<string>();
  const scopePerTargetProgram = unique(children.map(delegationTargetSpec)).length > 1;
  for (const child of children) {
    const targetProgram = delegationTargetSpec(child);
    for (const [target, source] of Object.entries(child.payload_map)) {
      const policyTarget = delegationPolicyInputEnrichmentTarget(target);
      const key = scopePerTargetProgram
        ? `${targetProgram}\u0000${source}\u0000${policyTarget}`
        : `${source}\u0000${policyTarget}`;
      if (seenEnrichment.has(key)) {
        continue;
      }
      seenEnrichment.add(key);
      inputEnrichment.push(scopePerTargetProgram
        ? { source, target: policyTarget, targetProgram }
        : { source, target: policyTarget });
    }
  }
  return {
    allowedTargetPrograms: unique(children.flatMap((child) => [
      delegationTargetSpec(child),
      ...(child.registered_name ? [child.registered_name] : []),
    ])),
    inputEnrichment,
  };
}

function delegationPolicyInputEnrichmentTarget(payloadMapTarget: string): string {
  if (payloadMapTarget.startsWith('request.') || payloadMapTarget.startsWith('domain_context.')) {
    return payloadMapTarget;
  }
  return `inputs.${payloadMapTarget}`;
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

function artifactPolicyForExportDescriptors(
  descriptors: readonly ExportStageDescriptor[],
  stageArtifacts: readonly StageArtifactDescriptor[] = [],
): ProgramArtifactPolicy | undefined {
  if (descriptors.length === 0 && stageArtifacts.length === 0) {
    return undefined;
  }
  return {
    rules: [
      ...descriptors.map((descriptor) => ({
        ...(descriptor.kind === 'export_pdf'
          ? pdfReportArtifactRule({
            title: descriptor.title,
            payloadRef: descriptor.payloadRef,
          })
          : {
            artifactType: descriptor.artifactType,
            title: descriptor.title,
            summary: descriptor.kind === 'export_docx'
              ? 'Deterministically rendered DOCX artifact; payload bytes are base64 in domain state.'
              : 'Deterministically rendered HTML artifact; payload is in domain state.',
            payloadRef: descriptor.payloadRef,
            whenAllPaths: [`${descriptor.payloadRef}.result_json`],
          }),
      })),
      ...stageArtifacts.map((descriptor) => ({
        artifactType: descriptor.artifactType,
        title: descriptor.title,
        summary: descriptor.summary,
        payloadRef: descriptor.payloadRef,
        whenAllPaths: [`${descriptor.payloadRef}.result_json`],
      })),
    ],
  };
}

function renderReuseDelegationSmokeTestSource(
  slug: string,
  name: string,
  entryChannel: string,
  child: DelegationChildDescriptor,
  transitionActions: TransitionAction[],
  targetKind: GeneratedSmokeTargetKind,
): string {
  const parentPascal = toPascalCase(slug);
  const childTargetSpec = delegationTargetSpec(child);
  const childRegistryName = child.registered_name ?? childTargetSpec;
  const transitionAction = transitionActions.find((action) => action.source === child.stage);
  const transitionActionName = transitionAction?.name ?? `complete_${safeIdentifier(child.stage)}`;
  const transitionChannel = smokeTransitionActionUsesWidgetOutput(transitionAction) ? 'widget_output' : 'stage_output';
  const resultPath = child.result_path;
  const base = delegationStateBase(child);
  const policy = delegationPolicyForChildren([child]);
  const emitsSeededTopic = delegationSeedsRequestTopic(child);
  const childPromptExpectation = emitsSeededTopic ? `, 'seeded delegation topic'` : '';
  const completeRequestPayload = emitsSeededTopic
    ? `{ request: { topic: 'seeded delegation topic' } }`
    : `{ request: { intent: 'complete-child' } }`;
  const degradeRequestPayload = emitsSeededTopic
    ? `{ request: { topic: 'force-degrade' } }`
    : `{ request: { intent: 'force-degrade' } }`;
  const childSpecYaml = `name: ${JSON.stringify(childTargetSpec)}

features:
  - base

pure: true

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

modes:
  receive:
    vocabulary: [accept_request]
    channels: [user_text, child_output]
    transitions:
      - target: work
        when: { kind: FieldTruthy, path: child.received }
  work:
    vocabulary: [finish_work]
    channels: [user_text, child_output]
    transitions:
      - target: complete
        when: { kind: FieldTruthy, path: work.done }
  complete:
    vocabulary: []
    channels: [child_output]

initial: receive

terminal: [complete]

topology: CyclicTopology

termination: BoundedSession

proceeds_to:
  accept_request: work
  finish_work: complete

channels:
  user_text: { direction: In, sync: Async }
  child_output: { direction: Out, sync: Sync }

fallback:
  channel: child_output
  payload: { ok: false }

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

preamble: |
  Inline manifest-reuse smoke child for ${name}.

prompts:
  receive: "Accept the delegated manifest-reuse request."
  work: "Finish the delegated manifest-reuse request and echo the seeded topic."
  complete: "Terminal."

repair_bound: 2

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
`;
  return `import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import { appTransport, createPgasClient, type PgasClient } from '@simodelne/pgas-server/client.js';
import {
  createProgramAdapters,
  createToolRegistry,
  loadSpecWithPatterns,
  resolveSpecFile,
  type ProgramEntry,
  type ToolHandler,
} from '@simodelne/pgas-server/plugin.js';
${renderSmokeProgramEntryPrelude([{ slug }], targetKind)}
import { handlers, reactionHandlers } from '../src/programs/${slug}/handlers.js';
import { register${parentPascal}Tools } from '../src/programs/${slug}/tools.js';

describe('generated manifest reuse delegation smoke', () => {
  it('runs manifest-reused delegation hermetically through the route for ${name}', async () => {
    const complete = await runDelegationScenario({
      script: [
        scripted(effect('begin_work', {})),
        scripted(effect(${tsString(delegationRequestActionName(child))}, ${completeRequestPayload}, ${tsString(delegationChannelName(child))})),
        scripted(effect('accept_request', { accepted: true }, 'child_output')${childPromptExpectation}),
        scripted(effect('finish_work', {
          summary: 'complete legal research'${emitsSeededTopic ? `,
          seeded_topic: 'seeded delegation topic'` : ''},
        }, 'child_output')${childPromptExpectation}),
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
${emitsSeededTopic ? `    expect(result.seeded_topic).toBe('seeded delegation topic');
` : ''}    expect(complete.afterDelegation.domain[${tsString(`${base}.settled`)}]).toBe(true);
    expect(complete.afterDelegation.domain[${tsString(`${base}.degraded`)}]).toBe(false);
    expect(complete.final.mode).toBe('complete');

    const degraded = await runDelegationScenario({
      parentMaxDelegatedRounds: 1,
      script: [
        scripted(effect('begin_work', {})),
        scripted(effect(${tsString(delegationRequestActionName(child))}, ${degradeRequestPayload}, ${tsString(delegationChannelName(child))})),
        scripted(effect('accept_request', { accepted: true }, 'child_output')${emitsSeededTopic ? `, 'force-degrade'` : ''}),
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
  const patched = patchMaxDelegatedRounds(stripConventionSidecarsForRawLoader(resolveSpecFile(sourcePath)), maxDelegatedRounds);
  const specPath = join(tempDir, 'parent-patched-specs.yml');
  writeFileSync(specPath, JSON.stringify(patched, null, 2), 'utf8');
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

function stripConventionSidecarsForRawLoader(spec: Record<string, unknown>): Record<string, unknown> {
  const sidecars = new Set(['view', 'render', 'policies', 'capabilities', 'composite', 'notebook']);
  return Object.fromEntries(Object.entries(spec).filter(([key]) => !sidecars.has(key)));
}

function patchMaxDelegatedRounds(value: unknown, maxDelegatedRounds: number): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => patchMaxDelegatedRounds(entry, maxDelegatedRounds));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
    key,
    key === 'max_delegated_rounds' ? maxDelegatedRounds : patchMaxDelegatedRounds(entry, maxDelegatedRounds),
  ]));
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
  targetKind: GeneratedSmokeTargetKind,
): string {
  const parentPascal = toPascalCase(slug);
  const childSpecs = children.map((child, index) => {
    const registryName = child.registered_name ?? delegationTargetSpec(child);
    const specName = delegationTargetSpec(child);
    const transitionAction = transitionActions.find((action) => action.source === child.stage);
    const transitionActionName = transitionAction?.name ?? `complete_${safeIdentifier(child.stage)}`;
    const transitionChannel = smokeTransitionActionUsesWidgetOutput(transitionAction) ? 'widget_output' : 'stage_output';
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
${renderSmokeProgramEntryPrelude([{ slug }], targetKind)}

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
    '        when: { kind: FieldTruthy, path: child.received }',
    '  work:',
    '    vocabulary: [finish_work]',
    '    channels: [user_text, child_output]',
    '    transitions:',
    '      - target: complete',
    '        when: { kind: FieldTruthy, path: work.done }',
    '  complete:',
    '    vocabulary: []',
    '    channels: [child_output]',
    '',
    'proceeds_to:',
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
  targetKind: GeneratedSmokeTargetKind,
): string {
  const childSlug = delegationTargetSpec(child);
  const parentPascal = toPascalCase(slug);
  const childPascal = toPascalCase(childSlug);
  const childStage = childResultStage(child);
  const backedResearch = child.synthesize_child?.kind === 'research_agent' && researchChildBackend(child) === 'host_connector';
  const emitsSeededTopic = delegationEchoesSeededTopic(child);
  const childCompleteAction = `complete_${childStage}`;
  const childCompleteChannel = backedResearch ? 'stage_output' : 'widget_output';
  const childCompletePayload = backedResearch
    ? `{ __stage_runtime: { now_iso: '2026-07-16T00:00:00.000Z', random: 0.25 } }`
    : `{
          result_json: JSON.stringify({ summary: 'child completed delegated work' }),
          items_json: JSON.stringify(['delegated-work-complete']),
          summary: 'child completed delegated work'${emitsSeededTopic ? `,
          seeded_topic: 'seeded delegation topic'` : ''},
        }`;
  const childResultAssertions = backedResearch
    ? emitsSeededTopic
      ? `    expect(String(result.result_json)).toContain('seeded delegation topic');
    expect(result.adapter_kind).toBe('in_memory_mock');`
      : `    expect(result.adapter_kind).toBe('in_memory_mock');`
    : emitsSeededTopic
      ? `    expect(result.seeded_topic).toBe('seeded delegation topic');`
      : '';
  const childPromptExpectation = emitsSeededTopic ? `, 'seeded delegation topic'` : '';
  const transitionAction = transitionActions.find((action) => action.source === child.stage);
  const transitionActionName = transitionAction?.name ?? `complete_${safeIdentifier(child.stage)}`;
  const transitionChannel = smokeTransitionActionUsesWidgetOutput(transitionAction) ? 'widget_output' : 'stage_output';
  const resultPath = child.result_path;
  const base = delegationStateBase(child);
  const hasFanOut = child.fan_out !== undefined;
  const completeScenario = hasFanOut
    ? `    const complete = await runDelegationScenario({
      completeChild: true,
    });`
    : `    const complete = await runDelegationScenario({
      script: [
        scripted(effect('begin_work', {})),
        scripted(effect(${tsString(delegationRequestActionName(child))}, { request: { intent: 'complete-child' } }, ${tsString(delegationChannelName(child))})),
        scripted(effect('begin_work', {})${childPromptExpectation}),
        scripted(effect(${tsString(childCompleteAction)}, ${childCompletePayload}, ${tsString(childCompleteChannel)})${childPromptExpectation}),
        scripted(effect(${tsString(transitionActionName)}, {
          result_json: JSON.stringify({ parent: 'complete after delegation' }),
          items_json: JSON.stringify(['parent-complete']),
        }, ${tsString(transitionChannel)})),
      ],
    });`;
  const degradedScenario = hasFanOut
    ? `    const degraded = await runDelegationScenario({
      parentMaxDelegatedRounds: 1,
      completeChild: false,
    });`
    : `    const degraded = await runDelegationScenario({
      parentMaxDelegatedRounds: 1,
      script: [
        scripted(effect('begin_work', {})),
        scripted(effect(${tsString(delegationRequestActionName(child))}, { request: { intent: 'force-degrade' } }, ${tsString(delegationChannelName(child))})),
        scripted(effect('begin_work', {})${childPromptExpectation}),
        scripted(effect(${tsString(transitionActionName)}, {
          result_json: JSON.stringify({ parent: 'complete after degraded delegation' }),
          items_json: JSON.stringify(['parent-complete-after-degrade']),
        }, ${tsString(transitionChannel)})),
      ],
    });`;
  return `import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import { appTransport, createPgasClient, type PgasClient } from '@simodelne/pgas-server/client.js';
import {
  createProgramAdapters,
  createToolRegistry,
  loadSpecWithPatterns,
  resolveSpecFile,
  type ProgramEntry,
} from '@simodelne/pgas-server/plugin.js';
${renderSmokeProgramEntryPrelude([
    { slug },
    { slug: childSlug, delegationResultPolicy: delegationResultPolicyForChild(child) },
  ], targetKind)}
import { handlers, reactionHandlers } from '../src/programs/${slug}/handlers.js';
import { register${parentPascal}Tools } from '../src/programs/${slug}/tools.js';

describe('generated delegation smoke', () => {
  it('runs synthesized delegation hermetically through the route for ${name}', async () => {
${completeScenario}
    const result = resultAt(complete.afterDelegation.domain, ${tsString(resultPath)});
    expect(result.status).toBe('complete');
    expect(Number(result.rounds)).toBeGreaterThanOrEqual(1);
    expect(result.mode).toBe('complete');
${childResultAssertions}
    expect(complete.afterDelegation.domain[${tsString(`${base}.settled`)}]).toBe(true);
    expect(complete.afterDelegation.domain[${tsString(`${base}.degraded`)}]).toBe(false);
    expect(complete.final.mode).toBe('complete');

${degradedScenario}
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
  script?: ScriptedAuthorResponse[];
  completeChild?: boolean;
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
      authorHandle: scenario.script
        ? scriptedAuthor(scenario.script)
        : fanOutAuthor({ completeChild: scenario.completeChild !== false }),
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
    if (!scenario.script) {
      const afterDelegation = await driveUntil(
        client,
        sessionId,
        (snapshot) => snapshot.domain[${tsString(`${base}.settled`)}] === true,
        'delegation settled',
      );
      const final = await driveUntil(
        client,
        sessionId,
        (snapshot) => snapshot.mode === 'complete',
        'terminal complete',
      );
      return { afterDelegation, final };
    }
    await client.sessions.trigger(sessionId, { channel: ${tsString(entryChannel)}, payload: 'dispatch delegated worker' });
    const afterDelegation = await readSnapshot(client, sessionId);
    // The delegation continuation may already have advanced the parent to a terminal
    // mode; tolerate an over-trigger on the completion step.
    await triggerToleratingTerminal(client, sessionId, 'complete parent after delegation settled');
    const final = await readSnapshot(client, sessionId);
    return { afterDelegation, final };
  } finally {
    await server.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function stripConventionSidecarsForRawLoader(spec: Record<string, unknown>): Record<string, unknown> {
  const sidecars = new Set(['view', 'render', 'policies', 'capabilities', 'composite', 'notebook']);
  return Object.fromEntries(Object.entries(spec).filter(([key]) => !sidecars.has(key)));
}

function patchMaxDelegatedRounds(value: unknown, maxDelegatedRounds: number): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => patchMaxDelegatedRounds(entry, maxDelegatedRounds));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
    key,
    key === 'max_delegated_rounds' ? maxDelegatedRounds : patchMaxDelegatedRounds(entry, maxDelegatedRounds),
  ]));
}

function createPatchedParentEntry(tempDir: string, maxDelegatedRounds: number): ProgramEntry {
  const sourcePath = decodeURIComponent(new URL('../src/programs/${slug}/specs.yml', import.meta.url).pathname);
  const patched = patchMaxDelegatedRounds(stripConventionSidecarsForRawLoader(resolveSpecFile(sourcePath)), maxDelegatedRounds);
  const specPath = join(tempDir, 'parent-patched-specs.yml');
  writeFileSync(specPath, JSON.stringify(patched, null, 2), 'utf8');
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

async function driveUntil(
  client: PgasClient,
  sessionId: string,
  predicate: (snapshot: Snapshot) => boolean,
  label: string,
): Promise<Snapshot> {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const snapshot = await readSnapshot(client, sessionId);
    if (predicate(snapshot)) {
      return snapshot;
    }
    await triggerToleratingTerminal(client, sessionId, \`continue generated delegation smoke \${String(attempt + 1)}\`);
    await delayTick();
  }
  const stalled = await readSnapshot(client, sessionId);
  throw new Error(\`timed out waiting for \${label}; mode=\${String(stalled.mode)} domain=\${JSON.stringify(stalled.domain)}\`);
}

async function triggerToleratingTerminal(client: PgasClient, sessionId: string, payload: string): Promise<void> {
  try {
    await client.sessions.trigger(sessionId, { channel: ${tsString(entryChannel)}, payload });
  } catch (error) {
    if (!String((error as Error).message).includes('terminal')) {
      throw error;
    }
  }
}

interface FanOutAuthorOptions {
  completeChild: boolean;
}

interface TerminalActionExample {
  name: string;
  channel?: string;
}

interface FieldSpec {
  name: string;
  type: string;
}

function fanOutAuthor(options: FanOutAuthorOptions) {
  return {
    modelId: 'generated-delegation-fanout-smoke-author',
    async complete(prompt: string) {
      const examples = terminalExamples(prompt);
      if (examples.length === 0) {
        throw new Error('fan-out smoke author found no terminal action in prompt: ' + prompt.slice(0, 500));
      }
      const selected = selectFanOutExample(prompt, examples, options);
      const channel = selected.channel ?? 'widget_output';
      return JSON.stringify(effect(selected.name, fanOutPayloadFor(selected.name, channel, prompt, options), channel));
    },
  };
}

function selectFanOutExample(
  prompt: string,
  examples: readonly TerminalActionExample[],
  options: FanOutAuthorOptions,
): TerminalActionExample {
  if (!options.completeChild && examples.some((example) => example.name === ${tsString(childCompleteAction)})) {
    throw new Error('degrade scenario unexpectedly reached delegated child completion');
  }
  const request = examples.find((example) => example.name === ${tsString(delegationRequestActionName(child))});
  if (request && !hasCompletedFanOut(prompt)) {
    return request;
  }
  const transition = examples.find((example) => example.name === ${tsString(transitionActionName)});
  if (transition && (hasCompletedFanOut(prompt) || !request)) {
    return transition;
  }
  const selected = examples[0];
  if (!selected) {
    throw new Error('fan-out smoke author could not select an action');
  }
  return selected;
}

function terminalExamples(prompt: string): TerminalActionExample[] {
  const examples: TerminalActionExample[] = [];
  const seen = new Set<string>();
  const add = (example: TerminalActionExample): void => {
    if (seen.has(example.name)) return;
    seen.add(example.name);
    examples.push(example);
  };
  const jsonPattern = /Valid terminal action JSON example:\\s*\\{"actions":\\[\\{"kind":"EffectAction","name":"([^"]+)","channel":"([^"]+)","payload":\\{\\}\\}\\]\\}/gu;
  for (const match of prompt.matchAll(jsonPattern)) {
    if (match[1]) {
      add({ name: match[1], ...(match[2] ? { channel: match[2] } : {}) });
    }
  }
  const callPattern = /call ([A-Za-z_][A-Za-z0-9_]*) as the single native tool_call/gu;
  for (const match of prompt.matchAll(callPattern)) {
    if (match[1]) {
      add({ name: match[1] });
    }
  }
  return examples;
}

function hasCompletedFanOut(prompt: string): boolean {
  return /"[^"]+\\.fan_out\\.complete"\\s*:\\s*true/u.test(prompt);
}

function fanOutPayloadFor(
  action: string,
  channel: string,
  prompt: string,
  options: FanOutAuthorOptions,
): Record<string, unknown> {
  if (action === 'begin_work') {
    return {};
  }
  if (action === ${tsString(childCompleteAction)}) {
    return ${childCompletePayload};
  }
  if (action === ${tsString(delegationRequestActionName(child))}) {
    return { request: { intent: options.completeChild ? 'complete-child' : 'force-degrade' } };
  }
  if (prompt.includes('EMPTY payload')) {
    return {};
  }
  const fields = resultFieldsFromPrompt(prompt);
  if (fields.length > 0) {
    const result = Object.fromEntries(fields.map((field) => [field.name, sampleResultValue(field)]));
    const payload: Record<string, unknown> = {
      result_json: JSON.stringify(result),
      items_json: JSON.stringify([deterministicItemFor(action, result)]),
    };
    for (const field of fields) {
      payload[field.name] = sampleArgumentValue(field);
    }
    return payload;
  }
  const payload: Record<string, unknown> = {
    result_json: JSON.stringify({ stage: action, status: 'deterministic' }),
    items_json: JSON.stringify([action]),
  };
  if (channel === 'stage_output') {
    payload.__stage_runtime = {
      now_iso: '2026-07-16T00:00:00.000Z',
      random: 0.25,
    };
  }
  return payload;
}

function resultFieldsFromPrompt(prompt: string): FieldSpec[] {
  const markers = [
    'result_json must be a JSON object containing at least:',
    'Populate every declared result field directly:',
  ];
  const marker = markers.find((candidate) => prompt.includes(candidate));
  const start = marker ? prompt.indexOf(marker) : -1;
  if (start < 0) {
    return [];
  }
  const afterMarker = prompt.slice(start + marker!.length);
  const period = afterMarker.indexOf('.');
  const sentence = period >= 0 ? afterMarker.slice(0, period) : afterMarker;
  const fields: FieldSpec[] = [];
  const fieldPattern = /([A-Za-z_][A-Za-z0-9_]*)\\s+\\(([^)]*)\\)/gu;
  for (const match of sentence.matchAll(fieldPattern)) {
    if (match[1] && match[2]) {
      fields.push({ name: match[1], type: match[2].toLowerCase() });
    }
  }
  return fields;
}

function sampleResultValue(field: FieldSpec): unknown {
  if (field.name === 'leads') {
    return [sampleLead()];
  }
  if (field.name === 'items') {
    return [{ title: 'Deterministic item', email: 'lead@example.com', url: 'https://example.com/deterministic' }];
  }
  if (field.name === 'audit') {
    return [{ action: 'fetch', url: 'https://example.com/deterministic', status: 'ok' }];
  }
  if (field.type.includes('number') || /(?:count|total|score|visited|rounds)$/u.test(field.name)) {
    return 1;
  }
  if (field.type.includes('boolean')) {
    return true;
  }
  if (field.name === 'status') {
    return 'complete';
  }
  if (field.type.includes('array') || field.name.endsWith('s')) {
    return [field.name + '-sample'];
  }
  if (field.name === 'source' || field.name.endsWith('_url')) {
    return 'https://example.com/deterministic';
  }
  if (field.name.includes('email')) {
    return 'lead@example.com';
  }
  return field.name + '-sample';
}

function sampleArgumentValue(field: FieldSpec): unknown {
  const value = sampleResultValue(field);
  if (field.type.includes('record_array')) {
    return value;
  }
  return Array.isArray(value) || (value && typeof value === 'object')
    ? JSON.stringify(value)
    : value;
}

function sampleLead(): Record<string, unknown> {
  return {
    name: 'Deterministic Lead',
    role: 'Director',
    company: 'Example Co',
    email: 'lead@example.com',
    profile_url: 'https://example.com/deterministic',
    notes: 'Generated deterministic lead fixture.',
    relevance_score: 1,
  };
}

function deterministicItemFor(action: string, result: Record<string, unknown>): string {
  if (typeof result.email === 'string') {
    return action + ':' + result.email;
  }
  return action + ':deterministic';
}

function delayTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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

  const itemMutations = descriptor.storage.representation === 'indexed_array'
    ? [
        { op: 'MSet' as const, path: `${descriptor.storage.items_path}.${itemIndex}.${descriptor.item.status_field}`, value: attemptedTo },
        {
          op: 'MSet' as const,
          path: `${descriptor.storage.items_path}.${itemIndex}.${DERIVED_TERMINAL_FIELD}`,
          value: descriptor.aggregate.terminal_statuses.includes(attemptedTo),
        },
        {
          op: 'MSet' as const,
          path: collectionLifecycleTerminalStatusItemsPath(descriptor.storage.items_path),
          value: collectionLifecycleTerminalStatusItems(
            parsedItems.map((item, index) =>
              index === itemIndex && item && typeof item === 'object' && !Array.isArray(item)
                ? {
                    ...item as Record<string, unknown>,
                    [descriptor.item.status_field]: attemptedTo,
                    [DERIVED_TERMINAL_FIELD]: descriptor.aggregate.terminal_statuses.includes(attemptedTo),
                  }
                : item,
            ),
            descriptor,
          ),
        },
      ]
    : [{
        op: 'MSet' as const,
        path: descriptor.storage.items_path,
        value: JSON.stringify(parsedItems.map((item, index) =>
          index === itemIndex && item && typeof item === 'object' && !Array.isArray(item)
            ? { ...item as Record<string, unknown>, [descriptor.item.status_field]: attemptedTo }
            : item,
        )),
      }];
  return {
    mutations: [
      ...itemMutations,
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

  return mutations.length > 0 ? { mutations } : undefined;
}

function confirmationLoopSummarizeCollection(
  snapshot: ReadonlyMap<string, unknown>,
  loop: ConfirmationLoopDescriptor,
  lifecycle: CollectionLifecycleDescriptor,
): ReactionResult | undefined {
  let items: unknown[] = [];
  try {
    items = reconstructArray(Object.fromEntries(snapshot), loop.collection);
  } catch {
    items = [];
  }
  const mutations: ReactionMutations = [];
  appendConfirmationLoopSummaryMutation(
    mutations,
    items,
    loop,
    lifecycle,
    confirmationLoopAllTerminal(items, lifecycle.item.status_field, loop.aggregate.terminal_statuses),
  );
  return { mutations };
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
      mutations.push({
        op: 'MSet' as const,
        path: collectionLifecycleTerminalStatusItemsPath(loop.collection),
        value: collectionLifecycleTerminalStatusItems(seeded, lifecycle),
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
  next[DERIVED_TERMINAL_FIELD] = false;
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
    [DERIVED_TERMINAL_FIELD]: false,
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

function appendConfirmationLoopSummaryMutation(
  mutations: ReactionMutations,
  items: unknown[],
  loop: ConfirmationLoopDescriptor,
  lifecycle: CollectionLifecycleDescriptor,
  allTerminal: boolean,
): void {
  mutations.push({
    op: 'MSet' as const,
    path: confirmationLoopSummaryPath(loop),
    value: confirmationLoopProgressSummary(items, loop, lifecycle, allTerminal),
  });
}

function confirmationLoopProgressSummary(
  items: unknown[],
  loop: ConfirmationLoopDescriptor,
  lifecycle: CollectionLifecycleDescriptor,
  allTerminal: boolean,
): Record<string, unknown> {
  const statusField = lifecycle.item.status_field;
  const terminalStatuses = new Set(loop.aggregate.terminal_statuses);
  const records = items
    .map((item, index) => ({ item, index }))
    .filter((entry): entry is { item: Record<string, unknown>; index: number } =>
      entry.item !== null && typeof entry.item === 'object' && !Array.isArray(entry.item));
  const terminalItems = records.filter(({ item }) => {
    const status = item[statusField];
    return typeof status === 'string' && terminalStatuses.has(status);
  }).length;
  const proposedItems = records.filter(({ item }) => item[statusField] === loop.proposed_status).length;
  const currentIndex = confirmationLoopActiveItemIndex(records, loop, lifecycle);
  const activeRecord = currentIndex >= 0 ? records.find(({ index }) => index === currentIndex)?.item : undefined;
  return {
    total_items: records.length,
    terminal_items: terminalItems,
    pending_items: Math.max(0, records.length - terminalItems),
    proposed_items: proposedItems,
    current_index: currentIndex,
    all_terminal: allTerminal,
    active_item: activeRecord ? confirmationLoopActiveItemView(activeRecord, loop, lifecycle) : {},
  };
}

function confirmationLoopActiveItemIndex(
  records: Array<{ item: Record<string, unknown>; index: number }>,
  loop: ConfirmationLoopDescriptor,
  lifecycle: CollectionLifecycleDescriptor,
): number {
  const statusField = lifecycle.item.status_field;
  const initialStatus = confirmationLoopInitialStatus(lifecycle);
  const terminalStatuses = new Set(loop.aggregate.terminal_statuses);
  return records.find(({ item }) => item[statusField] === loop.proposed_status)?.index
    ?? records.find(({ item }) => item[statusField] === initialStatus)?.index
    ?? records.find(({ item }) => {
      const status = item[statusField];
      return typeof status !== 'string' || !terminalStatuses.has(status);
    })?.index
    ?? -1;
}

function confirmationLoopActiveItemView(
  record: Record<string, unknown>,
  loop: ConfirmationLoopDescriptor,
  lifecycle: CollectionLifecycleDescriptor,
): Record<string, string> {
  return Object.fromEntries(confirmationLoopActiveItemFields(loop, lifecycle).map((field) => [
    field,
    typeof record[field] === 'string' ? record[field] : String(record[field] ?? ''),
  ]));
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
  const terminal = loop.aggregate.terminal_statuses.includes(nextStatus);
  (item as Record<string, unknown>)[statusField] = nextStatus;
  (item as Record<string, unknown>)[DERIVED_TERMINAL_FIELD] = terminal;
  mutations.push({
    op: 'MSet' as const,
    path: `${loop.collection}.${targetIndex}.${statusField}`,
    value: nextStatus,
  });
  mutations.push({
    op: 'MSet' as const,
    path: `${loop.collection}.${targetIndex}.${DERIVED_TERMINAL_FIELD}`,
    value: terminal,
  });
  mutations.push({
    op: 'MSet' as const,
    path: `${collectionLifecycleTerminalStatusItemsPath(loop.collection)}.${targetIndex}.${DERIVED_TERMINAL_STATUS_FIELD}`,
    value: terminal,
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
    record[DERIVED_TERMINAL_FIELD] = false;
    mutations.push({
      op: 'MSet' as const,
      path: `${loop.collection}.${index}.${statusField}`,
      value: initialStatus,
    });
    mutations.push({
      op: 'MSet' as const,
      path: `${loop.collection}.${index}.${DERIVED_TERMINAL_FIELD}`,
      value: false,
    });
    mutations.push({
      op: 'MSet' as const,
      path: `${collectionLifecycleTerminalStatusItemsPath(loop.collection)}.${index}.${DERIVED_TERMINAL_STATUS_FIELD}`,
      value: false,
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
  keyedCollectionPaths?: ReadonlySet<string>,
): string {
  const domainSpecSuffix = domainSpec
    ? [
        `Author-provided domain spec for ${modeName} is normative; implement it exactly and do not infer alternate business logic.`,
        JSON.stringify(domainSpec),
      ]
    : [];
  if (reasoningContract) {
    const fields = reasoningContract.result_schema.fields;
    // pgas#993: keyed record_array fields are appended one record per call
    // through their repeatable append action (upsert-by-key), not populated as a
    // batch array on the terminal action. Direct fields (scalars / non-keyed
    // record arrays) stay top-level args of the completion action.
    const keyedFields = fields.filter((field) => isKeyedRecordArrayField(modeName, field, keyedCollectionPaths));
    const directFields = fields.filter((field) => !isKeyedRecordArrayField(modeName, field, keyedCollectionPaths));
    const hasRecordArrayField = fields.some((field) => field.type === 'record_array');
    const keyedClause = keyedFields.length > 0
      ? ` Append each ${keyedFields.map((field) => field.name).join(', ')} record ONE AT A TIME by calling ${keyedFields.map((field) => keyedRecordArrayAppendActionName(modeName, field.name)).join(' / ')} with a single record object per call (each record is deduplicated by its key); do NOT pass a batch array. Once every record is appended, call the completion action with the remaining summary fields.`
      : '';
    const directSummary = directFields.length > 0
      ? `Populate every declared result field directly: ${directFields.map(reasoningFieldSummary).join(', ')}.`
      : 'Record the extracted records through the append actions described below.';
    const returnInstruction = hasRecordArrayField
      ? `Return your reasoning through the stage action's top-level arguments. ${directSummary}${keyedClause} Do not wrap these fields inside result_json.`
      : `Return your reasoning through the stage action's arguments. result_json must be a JSON object containing at least: ${fields.map(reasoningFieldSummary).join(', ')}. Additional keys are allowed. items_json must be a JSON array of strings matching: ${reasoningContract.items_schema.templates.join(', ')}.`;
    return [
      reasoningContract.reasoning_prompt,
      returnInstruction,
      ...domainSpecSuffix,
    ].join('\n');
  }
  return [`Perform the ${modeName} stage for ${programName}.`, ...domainSpecSuffix].join('\n');
}

function applyTerminalActionPrompts(
  prompts: MutableRecord,
  transitionActionsBySource: Map<string, TransitionAction[]>,
  suppressedActionNames: ReadonlySet<string>,
  firstMode: string,
  reasoningContractsBySlug: ReadonlyMap<string, ReasoningStageContract>,
): void {
  for (const [modeName, actions] of transitionActionsBySource) {
    const activeActions = actions.filter((action) => !suppressedActionNames.has(action.name));
    if (activeActions.length === 0) {
      continue;
    }
    const existing = typeof prompts[modeName] === 'string' ? `${prompts[modeName]}\n` : '';
    prompts[modeName] = `${existing}${terminalActionInstruction(activeActions.map((action) =>
      terminalActionDescriptorForTransition(action, firstMode, reasoningContractsBySlug),
    ))}`;
  }
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
          `${field.name} (${field.type}${field.type === 'enum' ? `, one of: ${(field.enum_values ?? []).join(' | ')}` : ''}${field.type === 'record_array' ? `, records: ${JSON.stringify(field.record_fields ?? {})}` : ''}): ${field.description}`),
        `items_json templates: ${reasoningContract.items_schema.templates.join(', ')}.`,
        'Populate every core argument; the composite result_json must agree with the per-field arguments.',
      );
    }
    return [modeName, stageGuidance];
  }));
}

function queryPolicyForDeclaredPaths(
  schema: MutableRecord,
  projection: MutableRecord,
  stageDomainSpecBySlug: ReadonlyMap<string, StageDomainSpec>,
): { allowedWorldQueryPrefixes: string[]; mode: 'enforce' } {
  const schemaPaths = new Set(Object.keys(schema));
  const candidatePaths = [
    ...Object.values(projection).flatMap((rawProjection) =>
      isRecord(rawProjection) && Array.isArray(rawProjection.include)
        ? rawProjection.include as string[]
        : [],
    ),
    ...[...stageDomainSpecBySlug.values()].flatMap((domainSpec) => domainSpec.reads),
  ];
  return {
    allowedWorldQueryPrefixes: unique(candidatePaths
      .flatMap((path) => queryPolicyPrefixesForDeclaredPath(path, schemaPaths))
      .filter((path) => path.length > 0)
      .sort()),
    mode: 'enforce',
  };
}

function queryPolicyPrefixesForDeclaredPath(path: string, schemaPaths: ReadonlySet<string>): string[] {
  const declaredPath = declaredSchemaPathForQuery(path, schemaPaths);
  return declaredPath ? queryPolicyPrefixesForSchemaPath(declaredPath) : [];
}

function declaredSchemaPathForQuery(path: string, schemaPaths: ReadonlySet<string>): string {
  if (schemaPaths.has(path)) {
    return path;
  }
  const parts = path.split('.');
  for (let length = parts.length - 1; length > 0; length -= 1) {
    const parentPath = parts.slice(0, length).join('.');
    if (schemaPaths.has(parentPath)) {
      return parentPath;
    }
  }
  for (const schemaPath of schemaPaths) {
    const wildcardIndex = schemaPath.indexOf('.*');
    if (wildcardIndex < 0) {
      continue;
    }
    const wildcardBase = schemaPath.slice(0, wildcardIndex);
    if (path === wildcardBase || path.startsWith(`${wildcardBase}.`)) {
      return schemaPath;
    }
  }
  return '';
}

function queryPolicyPrefixesForSchemaPath(path: string): string[] {
  if (path === 'notebook.*' || path === 'notebook_pins' || path.startsWith('notebook.')) {
    return [];
  }
  const wildcardIndex = path.indexOf('.*');
  if (wildcardIndex >= 0) {
    return [path.slice(0, wildcardIndex)];
  }
  return [path];
}

function applyEngineToolkitGuidance(
  guidance: MutableRecord,
  modes: MutableRecord,
  inlineQueryConfigured: boolean,
): void {
  for (const [modeName, rawMode] of Object.entries(modes)) {
    if (!isRecord(rawMode) || rawMode.decision_only === true) {
      continue;
    }
    const vocabulary = Array.isArray(rawMode.vocabulary) ? rawMode.vocabulary as string[] : [];
    const hasNotebookActions = ENGINE_NOTEBOOK_ACTIONS.some((action) => vocabulary.includes(action));
    const hasSessionControls = SESSION_CONTROL_ACTIONS.some((action) => vocabulary.includes(action));
    const existing = Array.isArray(guidance[modeName]) ? guidance[modeName] as string[] : [];
    guidance[modeName] = [
      ...existing,
      'Engine toolkit available in this mode: current projected state is shown each round; inspect it before choosing a tool.',
      inlineQueryConfigured
        ? 'If the query tool is listed, use query({"path":"..."}) to read schema-declared allowed world paths that are not shown in current state; do not query paths outside the allowed policy.'
        : 'No model-facing world query tool is configured in this mode; use only projected current state.',
      hasNotebookActions
        ? 'NOTEBOOK tools are durable working memory: use record_note for reusable facts, read_note before relying on older notes, pin_note/unpin_note for facts that must stay visible, and delete_note for stale notes.'
        : 'Notebook write tools are not active in this mode; use any projected notebook state only as read-only context.',
      ...(hasSessionControls ? [
        'Session controls are for explicit control intent only: status, history, help, new, abort, or resume. Do not use session_* actions for normal stage progression; use the stage completion action instead.',
      ] : []),
    ];
  }
}

function applyTerminalActionGuidance(
  guidance: MutableRecord,
  transitionActionsBySource: Map<string, TransitionAction[]>,
  suppressedActionNames: ReadonlySet<string>,
  firstMode: string,
  reasoningContractsBySlug: ReadonlyMap<string, ReasoningStageContract>,
): void {
  for (const [modeName, actions] of transitionActionsBySource) {
    const activeActions = actions.filter((action) => !suppressedActionNames.has(action.name));
    if (activeActions.length === 0) {
      continue;
    }
    const existing = Array.isArray(guidance[modeName]) ? guidance[modeName] as string[] : [];
    guidance[modeName] = [
      ...existing,
      terminalActionInstruction(activeActions.map((action) =>
        terminalActionDescriptorForTransition(action, firstMode, reasoningContractsBySlug),
      )),
    ];
  }
}

function terminalActionDescriptorForTransition(
  action: TransitionAction,
  firstMode: string,
  reasoningContractsBySlug: ReadonlyMap<string, ReasoningStageContract>,
): TerminalActionDescriptor {
  return {
    name: action.name,
    channel: transitionActionChannel(action, firstMode, reasoningContractsBySlug),
  };
}

function terminalActionInstruction(actions: TerminalActionDescriptor[]): string {
  const descriptors = uniqueTerminalActionDescriptors(actions);
  const names = descriptors.map((action) => action.name).filter((name) => name.trim().length > 0);
  const example = descriptors.length > 0
    ? terminalActionExample(descriptors[0] as TerminalActionDescriptor)
    : TERMINAL_ACTION_GENERIC_EXAMPLE;
  if (names.length === 1) {
    return `Respond with EXACTLY ONE terminal action per response: call ${names[0]} as the single native tool_call when this mode's work is ready. ${example} Do not emit multiple tool_calls, empty action names, or free-form action JSON.`;
  }
  if (names.length > 1) {
    return `Respond with EXACTLY ONE terminal action per response: call exactly one of ${names.join(' | ')} as the single native tool_call when this mode's work is ready. ${example} Do not emit multiple tool_calls, empty action names, or free-form action JSON.`;
  }
  return TERMINAL_ACTION_PROTOCOL;
}

function terminalActionExample(action: TerminalActionDescriptor): string {
  const payload = JSON.stringify(action.payloadExample ?? {});
  return `Valid terminal action JSON example: {"actions":[{"kind":"EffectAction","name":"${action.name}","channel":"${action.channel}","payload":${payload}}]}. Emit exactly ONE such terminal action; do not emit raw MutationActions for a named action.`;
}

function uniqueTerminalActionDescriptors(actions: TerminalActionDescriptor[]): TerminalActionDescriptor[] {
  const seen = new Set<string>();
  const result: TerminalActionDescriptor[] = [];
  for (const action of actions) {
    if (action.name.trim().length === 0) {
      continue;
    }
    const key = `${action.name}\u0000${action.channel}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(action);
  }
  return result;
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

function collectRegisteredTools(
  stages: Stage[],
  modeNames: ReadonlySet<string>,
): RegisteredToolDescriptor[] {
  const tools: RegisteredToolDescriptor[] = [];
  const seenNames = new Set<string>();
  for (const stage of stages) {
    if (stage.tools === undefined) {
      continue;
    }
    const descriptors = requiredArray(stage.tools, `stage ${stage.slug} tools`);
    for (const [index, descriptorValue] of descriptors.entries()) {
      const descriptor = requiredRecord(descriptorValue, `stage ${stage.slug} tools[${String(index)}]`);
      const kind = requiredString(descriptor.kind, `stage ${stage.slug} tools[${String(index)}].kind`);
      if (kind !== 'registered') {
        continue;
      }
      const name = requiredString(descriptor.name, `stage ${stage.slug} tools[${String(index)}].name`);
      if (name !== 'web_search') {
        throw new Error(`stage ${stage.slug} registered tool must be web_search; got ${name}`);
      }
      if (seenNames.has(name)) {
        throw new Error(`registered tool ${name} is declared more than once`);
      }
      seenNames.add(name);
      const provider = registeredToolProvider(descriptor.provider, stage.slug, index);
      const modes = descriptor.modes === undefined
        ? [stage.slug]
        : requiredStringList(descriptor.modes, `stage ${stage.slug} tools[${String(index)}].modes`);
      for (const mode of modes) {
        if (!modeNames.has(mode)) {
          throw new Error(`stage ${stage.slug} tools[${String(index)}].modes includes unknown mode ${mode}`);
        }
      }
      const resultPath = descriptor.result_path === undefined
        ? `${stage.slug}.tool_results.${name}`
        : requiredString(descriptor.result_path, `stage ${stage.slug} tools[${String(index)}].result_path`);
      tools.push({
        name,
        kind,
        provider,
        result_path: resultPath,
        modes: unique(modes),
        description: typeof descriptor.description === 'string' && descriptor.description.trim().length > 0
          ? descriptor.description.trim()
          : 'Search the web for current, source-grounded information.',
        parameters: registeredToolParameters(descriptor.parameters),
      });
    }
  }
  return tools;
}

function registeredToolProvider(value: unknown, stageSlug: string, index: number): RegisteredToolDescriptor['provider'] {
  const provider = value === undefined
    ? 'libraries/search'
    : requiredString(value, `stage ${stageSlug} tools[${String(index)}].provider`);
  if (provider !== 'libraries/search' && provider !== 'tavily' && provider !== 'web_search') {
    throw new Error(`stage ${stageSlug} tools[${String(index)}].provider must be libraries/search; got ${provider}`);
  }
  return 'libraries/search';
}

function registeredToolParameters(value: unknown): RegisteredToolDescriptor['parameters'] {
  if (value === undefined) {
    return webSearchToolParameters();
  }
  const parameters = requiredRecord(value, 'registered tool parameters');
  if (parameters.type !== 'object') {
    throw new Error('registered tool parameters.type must be object');
  }
  const properties = requiredRecord(parameters.properties, 'registered tool parameters.properties');
  return {
    type: 'object',
    properties,
    ...(parameters.required === undefined ? {} : { required: requiredStringList(parameters.required, 'registered tool parameters.required') }),
  };
}

function webSearchToolParameters(): RegisteredToolDescriptor['parameters'] {
  return {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query.',
      },
      jurisdiction: {
        type: 'string',
        description: 'Optional jurisdiction hint appended to the query when not already present.',
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of results to return; default 8, maximum 20.',
      },
    },
    required: ['query'],
  };
}

function nonTerminalStageSlugs(stages: Stage[], completion: Completion): string[] {
  return unique(
    stages
      .filter((stage) => !stage.is_terminal && stage.slug !== completion.final_stage)
      .map((stage) => stage.slug),
  );
}

function bodyStageSlugsFor(
  stages: Stage[],
  completion: Completion,
  stageClassificationBySlug: ReadonlyMap<string, ClassifiedStage>,
): string[] {
  return nonTerminalStageSlugs(stages, completion)
    .filter((stage) => stageClassificationBySlug.get(stage)?.archetype !== 'conversational-hub');
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
  const numericSums = normalizeCollectionLifecycleNumericSums(aggregate.numeric_sums);
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
      ...(numericSums.length > 0 ? { numeric_sums: numericSums } : {}),
    },
  };
}

function normalizeCollectionLifecycleNumericSums(
  value: unknown,
): CollectionLifecycleNumericSumDescriptor[] {
  if (value === undefined) {
    return [];
  }
  return requiredArray(value, 'collection_lifecycle.aggregate.numeric_sums').map((raw, index) => {
    const record = requiredRecord(raw, `collection_lifecycle.aggregate.numeric_sums[${index}]`);
    const predicateRaw = record.predicate;
    const predicate = predicateRaw === undefined
      ? undefined
      : normalizeCollectionLifecycleNumericPredicate(
          predicateRaw,
          `collection_lifecycle.aggregate.numeric_sums[${index}].predicate`,
        );
    return {
      target: requiredString(record.target, `collection_lifecycle.aggregate.numeric_sums[${index}].target`),
      field: requiredString(record.field, `collection_lifecycle.aggregate.numeric_sums[${index}].field`),
      ...(predicate ? { predicate } : {}),
    };
  });
}

function normalizeCollectionLifecycleNumericPredicate(
  value: unknown,
  label: string,
): { kind: NumericAggregatePredicateKind; value: number } {
  const record = requiredRecord(value, label);
  const kind = requiredString(record.kind, `${label}.kind`);
  if (!isNumericAggregatePredicateKind(kind)) {
    throw new Error(`${label}.kind must be a numeric comparison predicate`);
  }
  return {
    kind,
    value: requiredNumber(record.value, `${label}.value`),
  };
}

function isNumericAggregatePredicateKind(kind: string): kind is NumericAggregatePredicateKind {
  return kind === 'FieldLessThan' ||
    kind === 'FieldLessOrEqual' ||
    kind === 'FieldGreaterThan' ||
    kind === 'FieldGreaterOrEqual';
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
  assertCollectionLifecycleNumericSums(descriptor);
}

function assertCollectionLifecycleNumericSums(descriptor: CollectionLifecycleDescriptor): void {
  const sums = descriptor.aggregate.numeric_sums ?? [];
  if (sums.length === 0) {
    return;
  }
  if (descriptor.storage.representation !== 'indexed_array') {
    throw new Error('collection_lifecycle.aggregate.numeric_sums requires indexed_array storage');
  }
  const targets = sums.map((sum) => sum.target);
  if (new Set(targets).size !== targets.length) {
    throw new Error('collection_lifecycle.aggregate.numeric_sums targets must be unique');
  }
  for (const sum of sums) {
    if (!normalizeGuardField(sum.target)) {
      throw new Error('collection_lifecycle.aggregate.numeric_sums[].target must be a path');
    }
    if (descriptor.item.schema[sum.field] !== 'number') {
      throw new Error(`collection_lifecycle.aggregate.numeric_sums field must reference a numeric item schema field; got ${sum.field}`);
    }
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
    ...optionalRecordField(descriptor, 'artifact_shape', 'documents.artifact_shape'),
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
  documentRequiredTokens(descriptor);

  const delegationChildren = Array.isArray(context.delegation?.children)
    ? context.delegation.children
    : [];
  const errors = documentDelegationCompatibilityErrors(descriptor, { children: delegationChildren as DelegationChildDescriptor[] });
  if (errors.length > 0) {
    throw new Error(errors.join('; '));
  }
}

function documentDelegationCompatibilityErrors(
  documents: DocumentsDescriptor | undefined,
  delegation: DelegationDescriptor,
): string[] {
  if (!documents || !Array.isArray(delegation.children)) {
    return [];
  }
  const errors: string[] = [];
  for (const [index, rawChild] of delegation.children.entries()) {
    if (!isRecord(rawChild)) {
      continue;
    }
    if (rawChild.stage !== documents.stage) {
      continue;
    }
    if (sameStageDocumentIngestDelegationCompatible(rawChild, documents)) {
      continue;
    }
    errors.push(sameStageDocumentDelegationRepairMessage(documents, index));
  }
  return errors;
}

function sameStageDocumentIngestDelegationCompatible(
  child: DelegationChildDescriptor | Record<string, unknown>,
  documents: DocumentsDescriptor,
): boolean {
  if (documents.required !== true || child.stage !== documents.stage || !isDocumentIngestDelegationChild(child)) {
    return false;
  }
  const payloadMap = child.payload_map;
  return isRecord(payloadMap) &&
    payloadMap['request.documents'] === documentsCollectionPath(documents) &&
    payloadMap['request.extraction_contract'] === documentsExtractionContractPath(documents);
}

function sameStageDocumentDelegationRepairMessage(documents: DocumentsDescriptor, index: number): string {
  return [
    `documents descriptor and delegation.children[${String(index)}] share host stage ${documents.stage}`,
    'same-stage upload delegation is only supported for a required documents descriptor feeding the manifest-reused document-ingest child',
    `repair by moving the child to a later stage or mapping document-ingest with payload_map request.documents=${documentsCollectionPath(documents)} and request.extraction_contract=${documentsExtractionContractPath(documents)}`,
  ].join('; ');
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

  // Validate EACH of N children. N distinct static children are in scope, and the
  // single dynamic fan-out shape now accepted here is the document-collection loop:
  // one static child channel repeatedly dispatched over work.source.documents with
  // work.source.current_document as the child isolation slice.
  const actionNames = new Set(context.actionNames);
  const channelNames = new Set(context.channelNames);
  const schemaPaths = new Set(context.schemaPaths);
  const seenIds = new Set<string>();
  const seenStages = new Map<string, boolean>();
  const seenResultPaths = new Set<string>();
  const seenTargetSpecs = new Set<string>();
  let documentFanOutChildren = 0;

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
    assertDelegationV1Scope(delegation, child, context);
    if (child.fan_out !== undefined) {
      documentFanOutChildren += 1;
      if (documentFanOutChildren > 1) {
        throw new CapabilityRefusalError([{
          capability: 'delegation_research_agent',
          evidence: 'document fan_out synthesis supports exactly one child loop per host stage today; multiple concurrent fan_out children require an engine batch or scheduler surface',
        }]);
      }
    }

    const id = requiredString(child.id, `delegation.children[${i}].id`);
    if (!/^[a-z][a-z0-9_]*$/u.test(id)) {
      throw new Error(`delegation.children[${i}].id must be a slug-safe identifier; got ${id}`);
    }
    if (seenIds.has(id)) {
      throw new Error(`delegation.children[${i}].id must be unique across children; ${id} is declared more than once`);
    }
    seenIds.add(id);
    const requestAction = typeof child.action_name === 'string'
      ? requiredString(child.action_name, `delegation.children[${i}].action_name`)
      : `request_${id}`;
    if (!/^[a-z][a-z0-9_]*$/u.test(requestAction)) {
      throw new Error(`delegation.children[${i}].action_name must be a slug-safe identifier; got ${requestAction}`);
    }
    if (actionNames.has(requestAction)) {
      throw new Error(`delegation child ${requestAction} action collides with generated action set`);
    }
    actionNames.add(requestAction);
    const callChannel = `${id}_call`;
    if (channelNames.has(callChannel)) {
      throw new Error(`delegation child ${callChannel} channel collides with generated channel set`);
    }

    const stage = requiredString(child.stage, `delegation.children[${i}].stage`);
    const stageRecord = context.stages.find((candidate) => candidate.slug === stage);
    if (!stageRecord || stageRecord.is_bootstrap === true || stageRecord.is_terminal === true) {
      throw new Error(`delegation.children[${i}].stage must reference a declared non-bootstrap non-terminal stage; got ${stage}`);
    }
    if (child.ad_hoc !== undefined && typeof child.ad_hoc !== 'boolean') {
      throw new Error(`delegation.children[${i}].ad_hoc must be boolean when present`);
    }
    const childAdHoc = child.ad_hoc === true;
    const existingStageAdHoc = seenStages.get(stage);
    if (existingStageAdHoc !== undefined && !(existingStageAdHoc && childAdHoc)) {
      throw new Error(`delegation.children[${i}].stage must be unique across children; stage ${stage} is used by more than one child`);
    }
    seenStages.set(stage, childAdHoc);

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
    assertFanOutDescriptor(child, context, i, stage);

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
  context: DelegationChildrenValidationContext,
): void {
  const refusals: Array<{ capability: string; evidence: string }> = [];
  const note = 'v1 delegation is N distinct static/synthesized children plus one sequential document fan_out child, degrade-only (optional:true); generic fan_out / dynamic targeting / continue-mode / strict delegation are not yet synthesizable';
  const add = (capability: string, reason: string): void => {
    refusals.push({
      capability,
      evidence: `${note} — ${capability} stays refuses (${reason})`,
    });
  };
  if (delegation.fan_out !== undefined) {
    add('delegation_research_agent', 'fan_out');
  }
  if (
    child.fan_out !== undefined &&
    !documentFanOutCandidateSupported(child, context.documents) &&
    !leadResearchSourceFanOutCandidateSupported(child, context)
  ) {
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

function assertFanOutDescriptor(
  child: Record<string, unknown>,
  context: DelegationChildrenValidationContext,
  childIndex: number,
  stage: string,
): void {
  if (child.fan_out === undefined) {
    return;
  }
  if (leadResearchSourceFanOutCandidateSupported(child, context)) {
    assertSourceConfigFanOutDescriptor(child, childIndex, stage);
    return;
  }
  assertDocumentFanOutDescriptor(child, context.documents, childIndex, stage);
}

function assertDocumentFanOutDescriptor(
  child: Record<string, unknown>,
  documents: DocumentsDescriptor | undefined,
  childIndex: number,
  stage: string,
): void {
  if (child.fan_out === undefined) {
    return;
  }
  if (!documents) {
    throw new Error(`delegation.children[${childIndex}].fan_out requires intake.documents_json`);
  }
  if (documents.required !== true) {
    throw new Error(`delegation.children[${childIndex}].fan_out requires documents.required: true`);
  }
  const fanOut = requiredRecord(child.fan_out, `delegation.children[${childIndex}].fan_out`);
  const source = requiredString(fanOut.source, `delegation.children[${childIndex}].fan_out.source`);
  const expectedSource = documentsCollectionPath(documents);
  if (source !== expectedSource) {
    throw new Error(`delegation.children[${childIndex}].fan_out.source must equal ${expectedSource}`);
  }
  const currentDocument = requiredString(fanOut.current_document, `delegation.children[${childIndex}].fan_out.current_document`);
  const expectedCurrentDocument = documentsCurrentDocumentPath(documents);
  if (currentDocument !== expectedCurrentDocument) {
    throw new Error(`delegation.children[${childIndex}].fan_out.current_document must equal ${expectedCurrentDocument}`);
  }
  const resultPath = requiredString(fanOut.result_path, `delegation.children[${childIndex}].fan_out.result_path`);
  if (!resultPath.startsWith(`${stage}.`)) {
    throw new Error(`delegation.children[${childIndex}].fan_out.result_path must be under ${stage}.`);
  }
  const completionGuard = requiredString(fanOut.completion_guard, `delegation.children[${childIndex}].fan_out.completion_guard`);
  if (!completionGuard.startsWith(`${stage}.`)) {
    throw new Error(`delegation.children[${childIndex}].fan_out.completion_guard must be under ${stage}.`);
  }
  if (fanOut.index_path !== undefined) {
    const indexPath = requiredString(fanOut.index_path, `delegation.children[${childIndex}].fan_out.index_path`);
    if (!indexPath.startsWith(`${stage}.`)) {
      throw new Error(`delegation.children[${childIndex}].fan_out.index_path must be under ${stage}.`);
    }
  }
}

function leadResearchSourceFanOutCandidateSupported(
  child: Record<string, unknown>,
  context: DelegationChildrenValidationContext,
): boolean {
  return context.programSlug === 'lead-research-agent' &&
    sourceConfigFanOutCandidateSupported(child);
}

function assertSourceConfigFanOutDescriptor(
  child: Record<string, unknown>,
  childIndex: number,
  stage: string,
): void {
  const fanOut = requiredRecord(child.fan_out, `delegation.children[${childIndex}].fan_out`);
  const source = requiredString(fanOut.source, `delegation.children[${childIndex}].fan_out.source`);
  if (source !== LEAD_RESEARCH_SOURCE_FAN_OUT_SOURCE_PATH) {
    throw new Error(`delegation.children[${childIndex}].fan_out.source must equal ${LEAD_RESEARCH_SOURCE_FAN_OUT_SOURCE_PATH}`);
  }
  const currentSource = requiredString(fanOut.current_document, `delegation.children[${childIndex}].fan_out.current_document`);
  if (currentSource !== LEAD_RESEARCH_SOURCE_FAN_OUT_CURRENT_PATH) {
    throw new Error(`delegation.children[${childIndex}].fan_out.current_document must equal ${LEAD_RESEARCH_SOURCE_FAN_OUT_CURRENT_PATH}`);
  }
  const resultPath = requiredString(fanOut.result_path, `delegation.children[${childIndex}].fan_out.result_path`);
  if (resultPath !== LEAD_RESEARCH_SOURCE_FAN_OUT_RESULTS_PATH) {
    throw new Error(`delegation.children[${childIndex}].fan_out.result_path must equal ${LEAD_RESEARCH_SOURCE_FAN_OUT_RESULTS_PATH}`);
  }
  const completionGuard = requiredString(fanOut.completion_guard, `delegation.children[${childIndex}].fan_out.completion_guard`);
  if (!completionGuard.startsWith(`${stage}.`)) {
    throw new Error(`delegation.children[${childIndex}].fan_out.completion_guard must be under ${stage}.`);
  }
  if (fanOut.index_path !== undefined) {
    const indexPath = requiredString(fanOut.index_path, `delegation.children[${childIndex}].fan_out.index_path`);
    if (!indexPath.startsWith(`${stage}.`)) {
      throw new Error(`delegation.children[${childIndex}].fan_out.index_path must be under ${stage}.`);
    }
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

function addDelegationResultSchemaPaths(delegation: DelegationDescriptor, schemaPaths: Set<string>): void {
  for (const child of delegation.children ?? []) {
    if (typeof child.result_path !== 'string') {
      continue;
    }
    schemaPaths.add(child.result_path);
    schemaPaths.add(`${child.result_path}.result`);
  }
}

function reusableDelegationPayloadMapSourceErrors(
  delegation: DelegationDescriptor,
  schemaPaths: ReadonlySet<string>,
): string[] {
  const errors: string[] = [];
  for (const [index, child] of (delegation.children ?? []).entries()) {
    if (!isManifestReusedDelegationChild(child)) {
      continue;
    }
    for (const [target, source] of Object.entries(child.payload_map)) {
      if (delegationSchemaPathDeclared(source, schemaPaths)) {
        continue;
      }
      errors.push(
        `delegation.children[${String(index)}].payload_map manifest source ${source} is not declared in this program's schema; provide a source mapping for child input ${target} from a declared parent path such as inputs.initial_user_text`,
      );
    }
  }
  return errors;
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
  completion: Completion | undefined,
  documents: DocumentsDescriptor | undefined,
): Set<string> {
  const schemaPaths = new Set<string>([
    `inputs.${entryChannel}`,
    initialEntryPath,
  ]);
  if (documents) {
    collectDocumentsSchemaPaths(documents, schemaPaths);
  }
  for (const transition of transitions) {
    const guardField = completion
      ? guardFieldForTransition(transition, completion)
      : normalizeGuardField(transition.guard_field);
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

function collectDocumentsSchemaPaths(documents: DocumentsDescriptor, schemaPaths: Set<string>): void {
  const resultPath = documents.result_path;
  for (const path of [
    DOCUMENT_INTAKE_ROOT,
    `${DOCUMENT_INTAKE_ROOT}.file_refs`,
    `${DOCUMENT_INTAKE_ROOT}.file_refs.*`,
    `${DOCUMENT_INTAKE_ROOT}.file_refs.*.fileId`,
    `${DOCUMENT_INTAKE_ROOT}.file_refs.*.name`,
    `${DOCUMENT_INTAKE_ROOT}.file_refs.*.mimeType`,
    `${DOCUMENT_INTAKE_ROOT}.file_refs.*.size`,
    `${DOCUMENT_INTAKE_ROOT}.documents`,
    `${DOCUMENT_INTAKE_ROOT}.status`,
    `${DOCUMENT_INTAKE_ROOT}.source`,
    `${DOCUMENT_INTAKE_ROOT}.completed`,
    `${DOCUMENT_INTAKE_ROOT}.documents_requested`,
    DOCUMENTS_RECEIVED_PATH,
    resultPath,
    `${resultPath}.full_text`,
    `${resultPath}.documents`,
    `${resultPath}.documents.*`,
    `${resultPath}.documents.*.id`,
    `${resultPath}.documents.*.name`,
    `${resultPath}.documents.*.mime_type`,
    `${resultPath}.documents.*.size`,
    `${resultPath}.documents.*.text`,
    `${resultPath}.documents.*.char_count`,
    `${resultPath}.documents.*.source_index`,
    `${resultPath}.documents.*.extraction_kind`,
    `${resultPath}.documents.*.provenance`,
    `${resultPath}.documents.*.provenance.file_id`,
    `${resultPath}.documents.*.provenance.name`,
    `${resultPath}.documents.*.provenance.mime_type`,
    `${resultPath}.documents.*.provenance.size`,
    `${resultPath}.documents.*.provenance.source_index`,
    `${resultPath}.current_document`,
    `${resultPath}.current_document.id`,
    `${resultPath}.current_document.name`,
    `${resultPath}.current_document.mime_type`,
    `${resultPath}.current_document.size`,
    `${resultPath}.current_document.text`,
    `${resultPath}.current_document.char_count`,
    `${resultPath}.current_document.source_index`,
    `${resultPath}.current_document.extraction_kind`,
    `${resultPath}.current_document.provenance`,
    `${resultPath}.current_document.provenance.file_id`,
    `${resultPath}.current_document.provenance.name`,
    `${resultPath}.current_document.provenance.mime_type`,
    `${resultPath}.current_document.provenance.size`,
    `${resultPath}.current_document.provenance.source_index`,
    `${resultPath}.char_count`,
    `${resultPath}.file_count`,
    `${resultPath}.document_count`,
    `${resultPath}.files_json`,
      `${resultPath}.extraction_kind`,
      `${resultPath}.status`,
      `${resultPath}.reason`,
      documentsSourceReadyPath(documents),
      ...documentDelegatedIngestSchemaEntries(documents).map(([path]) => path),
    ]) {
      schemaPaths.add(path);
    }
}

function collectDomainSpecProducedPaths(
  stageSlug: string,
  produces: Record<string, unknown>,
  schemaPaths: Set<string>,
): void {
  const resultJson = produces.result_json;
  if (resultJson && typeof resultJson === 'object' && !Array.isArray(resultJson)) {
    for (const [field, schemaValue] of Object.entries(resultJson)) {
      schemaPaths.add(`${stageSlug}.${field}`);
      schemaPaths.add(`${stageSlug}.result.${field}`);
      schemaPaths.add(`${stageSlug}.output.result_json.${field}`);
      if (isRepeatedRecordSchema(schemaValue)) {
        schemaPaths.add(`${stageSlug}.result.${field}.*`);
        for (const nestedField of Object.keys(schemaValue[0])) {
          schemaPaths.add(`${stageSlug}.result.${field}.*.${nestedField}`);
        }
      }
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

function parseOptionalJsonDomainField<T>(domain: Record<string, unknown>, path: string): T | undefined {
  const value = domainValue(domain, path);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`optional JSON-string domain field must be a string when present: ${path}`);
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

function optionalSkillCatalogDomainField(domain: Record<string, unknown>): unknown {
  const direct = domainValue(domain, 'intake.skills');
  if (typeof direct === 'string') {
    return JSON.parse(direct) as unknown;
  }
  if (direct !== undefined) {
    return direct;
  }
  return optionalJsonDomainField(domain, 'intake.skills_json');
}

function normalizeSkillCatalog(value: unknown): SkillCatalogEntry[] {
  if (value === undefined) {
    return [];
  }

  const seen = new Set<string>();
  return requiredArray(value, 'intake.skills').map((entry, index) => {
    const record = requiredRecord(entry, `intake.skills[${index}]`);
    const name = requiredString(record.name, `intake.skills[${index}].name`);
    if (seen.has(name)) {
      throw new Error(`duplicate skill name in intake.skills: ${name}`);
    }
    seen.add(name);
    return {
      name,
      body: requiredSkillBody(record.body, `intake.skills[${index}].body`),
    };
  });
}

function requiredSkillBody(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
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

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function optionalStringValue(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requiredString(value, label);
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
