/**
 * Generated-program live-drive verification (the fourth verification rung).
 *
 * Gap this closes: runSmokeVerification drives a GENERATED program to its
 * completion stage but hermetically (scripted authorResponses + canned
 * reasoning-contract example), and runLiveProviderVerification is a single
 * provider round trip that never drives a generated program. Before this
 * module there was NO rung where a foundry-generated program was driven to
 * `complete` by a REAL provider making the per-stage/reasoning decisions.
 *
 * The drive boots the rendered standalone scaffold's own program registration
 * on a real `createPgasServer` (the engine's env-configured OpenAI-compatible
 * author driver makes every round's decisions) and pushes entry-channel
 * triggers until the program reaches its completion stage. All provider
 * traffic is routed through an in-process counting proxy so the caller gets
 * tamper-proof evidence that the REAL provider produced the stage decisions
 * (hit count + request/response excerpts) — a canned-fallback pass cannot
 * masquerade as live.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import type { SynthesisContext } from '../foundry-program/synthesizer-store.js';
import { findExecutedPathStubMarkers } from './verify.js';

export interface ProviderExchange {
  path: string;
  response_status: number;
  request_excerpt: string;
  response_excerpt: string;
}

export interface CountingProviderProxy {
  /** OpenAI-compatible base URL (ends with /v1) that forwards to the upstream. */
  url: string;
  /** Successful (HTTP 2xx) chat-completions round trips through the proxy. */
  hits(): number;
  exchanges(): ProviderExchange[];
  close(): Promise<void>;
}

// Request excerpts must be long enough to preserve the native-tools evidence
// fields (`tools`, `tool_choice`, `role:"tool"` feedback messages) that the
// unified-driver live proof asserts on; tool declarations serialize at the
// END of the payload, so a short prefix would silently drop them.
const REQUEST_EXCERPT_LIMIT = 200_000;
const RESPONSE_EXCERPT_LIMIT = 200_000;

export async function startCountingProviderProxy(upstreamBaseUrl: string): Promise<CountingProviderProxy> {
  const upstream = upstreamBaseUrl.replace(/\/+$/u, '');
  const exchanges: ProviderExchange[] = [];

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void (async () => {
        const body = Buffer.concat(chunks);
        const path = req.url ?? '/';
        const target = `${upstream}${path.replace(/^\/v1/u, '')}`;
        try {
          const response = await fetch(target, {
            method: req.method ?? 'POST',
            headers: {
              'content-type': req.headers['content-type'] ?? 'application/json',
              ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
            },
            ...(body.length > 0 ? { body } : {}),
          });
          const text = await response.text();
          if (path.includes('chat/completions')) {
            exchanges.push({
              path,
              response_status: response.status,
              request_excerpt: body.toString('utf8').slice(0, REQUEST_EXCERPT_LIMIT),
              response_excerpt: text.slice(0, RESPONSE_EXCERPT_LIMIT),
            });
          }
          res.statusCode = response.status;
          res.setHeader('content-type', response.headers.get('content-type') ?? 'application/json');
          res.end(text);
        } catch (error) {
          res.statusCode = 502;
          res.end(JSON.stringify({ error: `live-drive proxy upstream failure: ${errorMessage(error)}` }));
        }
      })();
    });
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address !== 'object') {
    throw new Error('live-drive proxy failed to bind a port');
  }

  return {
    url: `http://127.0.0.1:${String(address.port)}/v1`,
    hits: () => exchanges.filter((exchange) => exchange.response_status >= 200 && exchange.response_status < 300).length,
    exchanges: () => [...exchanges],
    close: () => new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise());
    }),
  };
}

export interface GeneratedLiveDriveOptions {
  /** Rendered standalone scaffold root (node_modules present or symlinked). */
  targetDir: string;
  slug: string;
  /** REAL provider base URL (OpenAI-compatible, e.g. http://host:8000/v1). */
  providerBaseUrl: string;
  model: string;
  initialText: string;
  entryChannel?: string;
  finalStage?: string;
  maxTriggers?: number;
  driveTimeoutMs?: number;
  env?: Record<string, string | undefined>;
  confirmationScript?: GeneratedLiveDriveConfirmationScript;
  delegationScript?: GeneratedLiveDriveDelegationScript;
  uploadScript?: GeneratedLiveDriveUploadScript;
  exportScript?: GeneratedLiveDriveExportScript;
  extractionScript?: GeneratedLiveDriveExtractionScript;
}

export interface DriveTerminalAction {
  name: string;
  payload_excerpt: string;
}

export interface GeneratedLiveDriveResult {
  final_mode: string | null;
  terminal: boolean;
  rounds: number;
  triggers: number;
  actions: string[];
  terminal_actions: DriveTerminalAction[];
  world: Record<string, unknown>;
  parent_session_id: string | null;
  provider_hits: number;
  provider_exchanges: ProviderExchange[];
  /**
   * Which author-driver config the runner actually booted with: 'unified'
   * when the scaffold's resolveAuthorDrivers opted in (PGAS_AUTHOR_DRIVER=
   * unified), 'default' for the engine's legacy JSON author path, null when
   * the runner produced no report.
   */
  author_driver: 'unified' | 'default' | null;
  status_history: GeneratedLiveDriveStatusHistoryEntry[];
  choreography: GeneratedLiveDriveChoreographyVerdict;
  delegation: GeneratedLiveDriveDelegationReport | null;
  delegation_verdict: GeneratedLiveDriveDelegationVerdict;
  delegation_engaged: boolean;
  upload: GeneratedLiveDriveUploadReport | null;
  upload_verdict: GeneratedLiveDriveUploadVerdict;
  upload_engaged: boolean;
  export: GeneratedLiveDriveExportReport | null;
  export_verdict: GeneratedLiveDriveExportVerdict;
  export_engaged: boolean;
  extraction: GeneratedLiveDriveExtractionReport | null;
  extraction_verdict: GeneratedLiveDriveExtractionVerdict;
  extraction_engaged: boolean;
  runner_exit_code: number | null;
  runner_output_excerpt: string;
  runner_error?: string;
  runner_timeout_kind?: string;
}

const DEFAULT_FINAL_STAGE = 'complete';
const DEFAULT_MAX_TRIGGERS = 12;
const DEFAULT_DRIVE_TIMEOUT_MS = 600_000;

type ConfirmationLoopDescriptorForScript = NonNullable<NonNullable<SynthesisContext['interaction']>['confirmation_loops']>[number];
type CollectionLifecycleForScript = NonNullable<SynthesisContext['completion']['collection_lifecycle']>;

export interface GeneratedLiveDriveScriptDecision {
  decision: string;
  instruction?: string;
}

export interface GeneratedLiveDriveConfirmationScript {
  channel: string;
  itemsPath: string;
  statusField: string;
  proposedStatus: string;
  decisionField?: string;
  instructionField?: string;
  fallbackDecision: string;
  decisions: GeneratedLiveDriveScriptDecision[];
  decisionTable: Record<string, string>;
  terminalStatuses: string[];
}

export interface GeneratedLiveDriveDelegationScript {
  resultPath: string;
  settledPath: string;
  degradedPath: string;
  stage: string;
  childProgram: string;
}

export interface GeneratedLiveDriveUploadScript {
  resultPath: string;
  sourceReadyPath: string;
  stage: string;
  sentinel: string;
  expectedCharCount: number;
}

export interface GeneratedLiveDriveExportScript {
  resultPath: string;
  stage: string;
  nonce: string;
}

export interface GeneratedLiveDriveExtractionScript {
  resultPath: string;
  sourceReadyPath: string;
  stage: string;
  sentinel: string;
}

export interface GeneratedLiveDriveDelegationReport {
  child_program: string;
  result_status: string | null;
  child_session_id: string | null;
  child_rounds: number;
  optional: boolean;
  settled: boolean;
  degraded: boolean;
  degrade_reason: string;
  exported_fields: Record<string, unknown>;
}

export interface GeneratedLiveDriveUploadReport {
  source_status: string | null;
  char_count: number;
  expected_char_count: number;
  source_ready: boolean;
  full_text_excerpt: string;
  sentinel_present: boolean;
  uploaded_file_id: string | null;
  refs_landed: boolean;
  upload_accepted: boolean;
}

export interface GeneratedLiveDriveExtractionReport {
  source_status: string | null;
  char_count: number;
  expected_char_count: number;
  source_ready: boolean;
  full_text_excerpt: string;
  sentinel_present: boolean;
  uploaded_file_id: string | null;
  refs_landed: boolean;
  upload_accepted: boolean;
  extraction_kind: string | null;
  sentinel_not_in_raw_upload: boolean;
}

export interface GeneratedLiveDriveExportArtifactRecord {
  artifactType: string;
  payloadRef: string;
  artifactId?: string;
  sourceSessionId?: string;
  [key: string]: unknown;
}

export interface GeneratedLiveDriveExportReport {
  artifact_records: GeneratedLiveDriveExportArtifactRecord[];
  artifact_record: GeneratedLiveDriveExportArtifactRecord | null;
  payload_ref: string | null;
  docx_base64: string | null;
  docx_bytes: number;
  nonce_present: boolean;
  default_absent: boolean;
  zip_store_ooxml: boolean;
  extracted_text_sample: string;
}

export interface GeneratedLiveDriveStatusItem {
  index: number;
  id?: string;
  title?: string;
  status: string | null;
}

export interface GeneratedLiveDriveStatusHistoryEntry {
  round: number;
  items: GeneratedLiveDriveStatusItem[];
  decision?: {
    index: number;
    decision: string;
    instruction?: string;
  };
}

export interface GeneratedLiveDriveChoreographyVerdict {
  decision_table_respected: boolean;
  one_proposed_invariant_held: boolean;
  proposed_overlap_max: number;
  items_seen_max: number;
  decisions_applied: number;
  terminal_items_final: number;
  loop_engaged: boolean;
  provider_hits_ok: boolean;
  notes: string[];
}

export interface GeneratedLiveDriveDelegationVerdict {
  delegation_engaged: boolean;
  result_complete: boolean;
  child_session_distinct: boolean;
  child_rounds_ok: boolean;
  settled: boolean;
  parent_complete: boolean;
  provider_hits_ok: boolean;
  no_stub_markers: boolean;
  notes: string[];
}

export interface GeneratedLiveDriveUploadVerdict {
  upload_engaged: boolean;
  upload_accepted: boolean;
  refs_landed: boolean;
  content_extracted: boolean;
  sentinel_present: boolean;
  extraction_exact: boolean;
  source_ready: boolean;
  parent_complete: boolean;
  provider_hits_ok: boolean;
  no_stub_markers: boolean;
  notes: string[];
}

export interface GeneratedLiveDriveExportVerdict {
  export_engaged: boolean;
  artifact_record_harvested: boolean;
  payload_decoded: boolean;
  nonce_present: boolean;
  default_absent: boolean;
  zip_store_ooxml: boolean;
  reason: string | null;
  notes: string[];
}

export interface GeneratedLiveDriveExtractionVerdict {
  extraction_engaged: boolean;
  upload_accepted: boolean;
  refs_landed: boolean;
  content_extracted: boolean;
  sentinel_present: boolean;
  extraction_exact: boolean;
  source_ready: boolean;
  parent_complete: boolean;
  provider_hits_ok: boolean;
  no_stub_markers: boolean;
  extraction_kind_docx_deflate: boolean;
  sentinel_not_in_raw_upload: boolean;
  reason: string | null;
  notes: string[];
}

export interface GeneratedLiveDriveDelegationAssessmentInput {
  report: GeneratedLiveDriveDelegationReport | null;
  parentSessionId: string | null;
  finalMode: string | null;
  expectedFinalMode?: string;
  providerHits: number;
  parentProviderHitMinimum?: number;
  stubFindings?: readonly string[];
  /** the delegation host stage; its items_json is legitimately empty (it delegates, not produces items). */
  hostStage?: string;
}

export interface GeneratedLiveDriveUploadAssessmentInput {
  report: GeneratedLiveDriveUploadReport | null;
  finalMode: string | null;
  expectedFinalMode?: string;
  providerHits: number;
  stubFindings?: readonly string[];
  /** the upload host stage; its items_json may be legitimately empty when it only ingests source. */
  hostStage?: string;
}

export interface GeneratedLiveDriveExtractionAssessmentInput {
  report: GeneratedLiveDriveExtractionReport | null;
  finalMode: string | null;
  expectedFinalMode?: string;
  providerHits: number;
  stubFindings?: readonly string[];
  /** the extraction host stage; its items_json may be legitimately empty when it only ingests source. */
  hostStage?: string;
}

export interface GeneratedLiveDriveExportAssessmentInput {
  report: GeneratedLiveDriveExportReport | null;
  expectedPayloadRef: string;
  nonce: string;
}

export function buildUploadLiveDriveFixtureText(sentinel: string): string {
  return [
    `PGAS upload live-drive fixture.`,
    `Sentinel: ${sentinel}`,
    'This ASCII source document exists only for the upload live-drive gate.',
    'The generated program must read these exact bytes through request.documents content_text.',
  ].join('\n');
}

export function deriveConfirmationScript(
  descriptor: ConfirmationLoopDescriptorForScript,
  cannedOrder: readonly (string | GeneratedLiveDriveScriptDecision)[],
  lifecycle?: CollectionLifecycleForScript,
): GeneratedLiveDriveConfirmationScript {
  const decisionTable = Object.fromEntries(
    Object.entries(descriptor.decisions).map(([decision, config]) => [canonicalConfirmationDecision(decision), config.to]),
  );
  const declaredDecisions = new Set(Object.keys(descriptor.decisions));
  const runtimeDecisions = new Set(Object.keys(decisionTable));
  const decisions = cannedOrder.flatMap((entry) => {
    const decision = typeof entry === 'string' ? { decision: entry } : entry;
    const canonicalDecision = canonicalConfirmationDecision(decision.decision);
    return declaredDecisions.has(decision.decision) || runtimeDecisions.has(canonicalDecision)
      ? [{ decision: canonicalDecision, ...(decision.instruction ? { instruction: decision.instruction } : {}) }]
      : [];
  });
  return {
    channel: 'user_confirmation',
    itemsPath: lifecycle?.storage.items_path ?? descriptor.collection,
    statusField: lifecycle?.item.status_field ?? descriptorStatusField(descriptor) ?? 'status',
    proposedStatus: descriptor.proposed_status,
    decisionField: 'inputs.user_decision.decision',
    instructionField: 'inputs.user_decision.instruction',
    fallbackDecision: 'approve',
    decisions,
    decisionTable,
    terminalStatuses: [...descriptor.aggregate.terminal_statuses],
  };
}

function canonicalConfirmationDecision(decision: string): string {
  if (decision === 'revise') return 'request_revision';
  if (decision === 'skip') return 'reject';
  return decision;
}

export function assessChoreography(
  history: readonly GeneratedLiveDriveStatusHistoryEntry[],
  script: GeneratedLiveDriveConfirmationScript,
  providerHits = 1,
): GeneratedLiveDriveChoreographyVerdict {
  const notes: string[] = [];
  let proposedOverlapMax = 0;
  let itemsSeenMax = 0;
  let decisionsApplied = 0;
  let decisionTableRespected = true;

  for (const snapshot of history) {
    itemsSeenMax = Math.max(itemsSeenMax, snapshot.items.length);
    const proposedCount = snapshot.items.filter((item) => item.status === script.proposedStatus).length;
    proposedOverlapMax = Math.max(proposedOverlapMax, proposedCount);
  }

  for (const snapshot of history) {
    if (!snapshot.decision) {
      continue;
    }
    const expectedStatus = script.decisionTable[snapshot.decision.decision];
    const item = snapshot.items.find((candidate) => candidate.index === snapshot.decision?.index);
    const actualStatus = item?.status ?? null;
    if (!expectedStatus) {
      decisionTableRespected = false;
      notes.push(`decision_table_unknown:round=${String(snapshot.round)}:index=${String(snapshot.decision.index)}:decision=${snapshot.decision.decision}`);
      continue;
    }
    if (actualStatus === expectedStatus) {
      decisionsApplied += 1;
    } else {
      decisionTableRespected = false;
      notes.push(
        `decision_table_mismatch:round=${String(snapshot.round)}:index=${String(snapshot.decision.index)}:decision=${snapshot.decision.decision}:expected=${expectedStatus}:actual=${String(actualStatus)}`,
      );
    }
  }

  if (script.decisions.length > 0 && decisionsApplied === 0) {
    decisionTableRespected = false;
    notes.push('decision_table_vacuous:no_decision_applied');
  }
  const oneProposedInvariantHeld = proposedOverlapMax <= 1;
  if (!oneProposedInvariantHeld) {
    notes.push(`one_proposed_invariant_violated:max=${String(proposedOverlapMax)}`);
  }
  const lastSnapshot = history[history.length - 1];
  const terminalStatuses = new Set(script.terminalStatuses);
  const terminalItemsFinal = lastSnapshot
    ? lastSnapshot.items.filter((item) => item.status !== null && terminalStatuses.has(item.status)).length
    : 0;
  const loopEngaged = itemsSeenMax >= 1 && proposedOverlapMax >= 1 && decisionsApplied >= 1;
  const providerHitsOk = providerHits >= 1;
  if (!providerHitsOk) {
    notes.push('provider_hits_below_minimum');
  }

  return {
    decision_table_respected: decisionTableRespected,
    one_proposed_invariant_held: oneProposedInvariantHeld,
    proposed_overlap_max: proposedOverlapMax,
    items_seen_max: itemsSeenMax,
    decisions_applied: decisionsApplied,
    terminal_items_final: terminalItemsFinal,
    loop_engaged: loopEngaged,
    provider_hits_ok: providerHitsOk,
    notes,
  };
}

export function assessDelegationEngagement(
  input: GeneratedLiveDriveDelegationAssessmentInput,
): GeneratedLiveDriveDelegationVerdict {
  const notes: string[] = [];
  const expectedFinalMode = input.expectedFinalMode ?? DEFAULT_FINAL_STAGE;
  const report = input.report;

  const resultComplete = report?.result_status === 'complete';
  if (!report) {
    notes.push('delegation_result_absent');
  } else if (!resultComplete) {
    notes.push(`delegation_result_not_complete:${String(report.result_status)}`);
  }

  const childSessionId = report?.child_session_id;
  const childSessionDistinct = typeof childSessionId === 'string' &&
    childSessionId.length > 0 &&
    childSessionId !== input.parentSessionId;
  if (!childSessionDistinct) {
    notes.push(childSessionId === input.parentSessionId
      ? 'child_session_id_matches_parent'
      : 'child_session_id_missing');
  }

  const childRounds = report?.child_rounds ?? 0;
  const childRoundsOk = Number.isFinite(childRounds) && childRounds >= 1;
  if (!childRoundsOk) {
    notes.push(`child_rounds_below_minimum:${String(childRounds)}`);
  }

  const settled = report?.settled === true;
  if (!settled) {
    notes.push('delegation_not_settled');
  }

  const parentComplete = input.finalMode === expectedFinalMode;
  if (!parentComplete) {
    notes.push(`parent_not_complete:expected=${expectedFinalMode}:actual=${String(input.finalMode)}`);
  }

  const parentProviderHitMinimum = input.parentProviderHitMinimum ?? 1;
  const providerHitMinimum = parentProviderHitMinimum + Math.max(childRounds, 0);
  const providerHitsOk = input.providerHits >= providerHitMinimum;
  if (!providerHitsOk) {
    notes.push(`provider_hits_below_parent_plus_child:min=${String(providerHitMinimum)}:actual=${String(input.providerHits)}`);
  }

  // The delegation host stage delegates; it does not produce items, so its items_json is legitimately
  // an empty array which the generic stub scan flags as a "default [] fallback" false positive (proven
  // by the qwen delegation drive: every other criterion green, only no_stub_markers red on
  // `<hostStage>.items_json: empty_array`). Exclude ONLY the host stage's items_json; every other stub still counts.
  const hostItemsPrefix = input.hostStage ? `${input.hostStage}.items_json` : null;
  const stubFindings = (input.stubFindings ?? []).filter(
    (finding) => hostItemsPrefix === null || !finding.startsWith(hostItemsPrefix),
  );
  const noStubMarkers = stubFindings.length === 0;
  if (!noStubMarkers) {
    notes.push(`stub_markers_present:${stubFindings.slice(0, 3).join(';')}`);
  }

  return {
    delegation_engaged: resultComplete &&
      childSessionDistinct &&
      childRoundsOk &&
      settled &&
      parentComplete &&
      providerHitsOk &&
      noStubMarkers,
    result_complete: resultComplete,
    child_session_distinct: childSessionDistinct,
    child_rounds_ok: childRoundsOk,
    settled,
    parent_complete: parentComplete,
    provider_hits_ok: providerHitsOk,
    no_stub_markers: noStubMarkers,
    notes,
  };
}

export function assessUploadEngagement(
  input: GeneratedLiveDriveUploadAssessmentInput,
): GeneratedLiveDriveUploadVerdict {
  const notes: string[] = [];
  const expectedFinalMode = input.expectedFinalMode ?? DEFAULT_FINAL_STAGE;
  const report = input.report;

  const uploadAccepted = report?.upload_accepted === true;
  if (!report) {
    notes.push('upload_result_absent');
  } else if (!uploadAccepted) {
    notes.push('upload_not_accepted');
  }

  const refsLanded = report?.refs_landed === true;
  if (!refsLanded) {
    notes.push('file_refs_not_landed');
  }

  const contentExtracted = report?.source_status === 'extracted';
  if (!contentExtracted) {
    notes.push(`source_status_not_extracted:${String(report?.source_status ?? null)}`);
  }

  const sentinelPresent = report?.sentinel_present === true;
  if (!sentinelPresent) {
    notes.push('sentinel_absent');
  }

  const actualCharCount = report?.char_count ?? 0;
  const expectedCharCount = report?.expected_char_count ?? 0;
  const extractionExact = Number.isFinite(actualCharCount) &&
    Number.isFinite(expectedCharCount) &&
    expectedCharCount > 0 &&
    actualCharCount === expectedCharCount;
  if (!extractionExact) {
    notes.push(`char_count_mismatch:expected=${String(expectedCharCount)}:actual=${String(actualCharCount)}`);
  }

  const sourceReady = report?.source_ready === true;
  if (!sourceReady) {
    notes.push('source_ready_false');
  }

  const parentComplete = input.finalMode === expectedFinalMode;
  if (!parentComplete) {
    notes.push(`parent_not_complete:expected=${expectedFinalMode}:actual=${String(input.finalMode)}`);
  }

  const providerHitsOk = input.providerHits >= 1;
  if (!providerHitsOk) {
    notes.push('provider_hits_below_minimum');
  }

  const hostItemsPrefix = input.hostStage ? `${input.hostStage}.items_json` : null;
  const stubFindings = (input.stubFindings ?? []).filter(
    (finding) => hostItemsPrefix === null || !finding.startsWith(hostItemsPrefix),
  );
  const noStubMarkers = stubFindings.length === 0;
  if (!noStubMarkers) {
    notes.push(`stub_markers_present:${stubFindings.slice(0, 3).join(';')}`);
  }

  return {
    upload_engaged: uploadAccepted &&
      refsLanded &&
      contentExtracted &&
      sentinelPresent &&
      extractionExact &&
      sourceReady &&
      parentComplete &&
      providerHitsOk &&
      noStubMarkers,
    upload_accepted: uploadAccepted,
    refs_landed: refsLanded,
    content_extracted: contentExtracted,
    sentinel_present: sentinelPresent,
    extraction_exact: extractionExact,
    source_ready: sourceReady,
    parent_complete: parentComplete,
    provider_hits_ok: providerHitsOk,
    no_stub_markers: noStubMarkers,
    notes,
  };
}

export function assessExtractionEngagement(
  input: GeneratedLiveDriveExtractionAssessmentInput,
): GeneratedLiveDriveExtractionVerdict {
  const notes: string[] = [];
  const expectedFinalMode = input.expectedFinalMode ?? DEFAULT_FINAL_STAGE;
  const report = input.report;

  const uploadAccepted = report?.upload_accepted === true;
  if (!report) {
    notes.push('extraction_report_absent');
  } else if (!uploadAccepted) {
    notes.push('upload_not_accepted');
  }

  const refsLanded = report?.refs_landed === true;
  if (!refsLanded) {
    notes.push('file_refs_not_landed');
  }

  const contentExtracted = report?.source_status === 'extracted';
  if (!contentExtracted) {
    notes.push(`source_status_not_extracted:${String(report?.source_status ?? null)}`);
  }

  const sentinelPresent = report?.sentinel_present === true;
  if (!sentinelPresent) {
    notes.push('sentinel_absent');
  }

  const actualCharCount = report?.char_count ?? 0;
  const expectedCharCount = report?.expected_char_count ?? 0;
  const extractionExact = Number.isFinite(actualCharCount) &&
    Number.isFinite(expectedCharCount) &&
    expectedCharCount > 0 &&
    actualCharCount === expectedCharCount;
  if (!extractionExact) {
    notes.push(`char_count_mismatch:expected=${String(expectedCharCount)}:actual=${String(actualCharCount)}`);
  }

  const sourceReady = report?.source_ready === true;
  if (!sourceReady) {
    notes.push('source_ready_false');
  }

  const parentComplete = input.finalMode === expectedFinalMode;
  if (!parentComplete) {
    notes.push(`parent_not_complete:expected=${expectedFinalMode}:actual=${String(input.finalMode)}`);
  }

  const providerHitsOk = input.providerHits >= 1;
  if (!providerHitsOk) {
    notes.push('provider_hits_below_minimum');
  }

  const hostItemsPrefix = input.hostStage ? `${input.hostStage}.items_json` : null;
  const stubFindings = (input.stubFindings ?? []).filter(
    (finding) => hostItemsPrefix === null || !finding.startsWith(hostItemsPrefix),
  );
  const noStubMarkers = stubFindings.length === 0;
  if (!noStubMarkers) {
    notes.push(`stub_markers_present:${stubFindings.slice(0, 3).join(';')}`);
  }

  const extractionKindDocxDeflate = report?.extraction_kind === 'docx_deflate';
  if (!extractionKindDocxDeflate) {
    notes.push(`extraction_kind_not_docx_deflate:${String(report?.extraction_kind ?? null)}`);
  }

  const sentinelNotInRawUpload = report?.sentinel_not_in_raw_upload === true;
  if (!sentinelNotInRawUpload) {
    notes.push('sentinel_visible_in_raw_upload');
  }

  const extractionEngaged = uploadAccepted &&
    refsLanded &&
    contentExtracted &&
    sentinelPresent &&
    extractionExact &&
    sourceReady &&
    parentComplete &&
    providerHitsOk &&
    noStubMarkers &&
    extractionKindDocxDeflate &&
    sentinelNotInRawUpload;

  return {
    extraction_engaged: extractionEngaged,
    upload_accepted: uploadAccepted,
    refs_landed: refsLanded,
    content_extracted: contentExtracted,
    sentinel_present: sentinelPresent,
    extraction_exact: extractionExact,
    source_ready: sourceReady,
    parent_complete: parentComplete,
    provider_hits_ok: providerHitsOk,
    no_stub_markers: noStubMarkers,
    extraction_kind_docx_deflate: extractionKindDocxDeflate,
    sentinel_not_in_raw_upload: sentinelNotInRawUpload,
    reason: extractionEngaged ? null : notes[0] ?? 'extraction_engagement_failed',
    notes,
  };
}

export function assessExportEngagement(
  input: GeneratedLiveDriveExportAssessmentInput,
): GeneratedLiveDriveExportVerdict {
  const notes: string[] = [];
  const report = input.report;

  if (!report) {
    notes.push('export_report_absent');
  }

  const artifactRecordHarvested = (report?.artifact_records ?? []).some((record) =>
    record.artifactType === 'docx_export' && record.payloadRef === input.expectedPayloadRef);
  if (!artifactRecordHarvested) {
    notes.push('artifact_record_absent');
  }

  const base64 = report?.docx_base64;
  const payloadDecoded = typeof base64 === 'string' &&
    base64.length > 0 &&
    isStrictBase64(base64) &&
    Buffer.from(base64, 'base64').length > 0;
  if (!payloadDecoded) {
    notes.push(typeof base64 === 'string' && base64.length === 0 ? 'docx_base64_empty' : 'docx_base64_invalid');
  }

  const parsedDocx = payloadDecoded ? parseStoreOoxmlDocument(Buffer.from(base64 as string, 'base64')) : null;
  const zipStoreOoxml = parsedDocx !== null;
  if (!zipStoreOoxml) {
    notes.push('docx_zip_invalid');
  }

  const docXml = parsedDocx?.documentXml ?? '';
  const noncePresent = zipStoreOoxml && input.nonce.length > 0 && docXml.includes(input.nonce);
  if (!noncePresent) {
    notes.push('nonce_absent');
  }

  const defaultAbsent = zipStoreOoxml && !docXml.includes('Client authorized signatory');
  if (!defaultAbsent) {
    notes.push('default_export_text_present');
  }

  const exportEngaged = artifactRecordHarvested &&
    payloadDecoded &&
    noncePresent &&
    defaultAbsent &&
    zipStoreOoxml;

  return {
    export_engaged: exportEngaged,
    artifact_record_harvested: artifactRecordHarvested,
    payload_decoded: payloadDecoded,
    nonce_present: noncePresent,
    default_absent: defaultAbsent,
    zip_store_ooxml: zipStoreOoxml,
    reason: exportEngaged ? null : notes[0] ?? 'export_engagement_failed',
    notes,
  };
}

export async function driveGeneratedProgramLive(options: GeneratedLiveDriveOptions): Promise<GeneratedLiveDriveResult> {
  const workDir = join(options.targetDir, '.pgas-new-live-drive');
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(join(workDir, 'session-logs'), { recursive: true });
  // The upload runner boots createPgasServer({ storage: { uploadsDir } }) at this path — the
  // dir MUST exist or the server crashes at boot before the runner can log or write a report
  // (observed: upload live-drive runner_exit=1 with empty output / no report).
  mkdirSync(join(workDir, 'uploads'), { recursive: true });
  const runnerPath = join(workDir, 'runner.ts');
  const reportPath = join(workDir, 'report.json');
  const driveTimeoutMs = options.driveTimeoutMs ?? DEFAULT_DRIVE_TIMEOUT_MS;

  const proxy = await startCountingProviderProxy(options.providerBaseUrl);
  try {
    writeFileSync(runnerPath, renderLiveDriveRunnerSource(
      options.slug,
      options.confirmationScript,
      options.delegationScript,
      options.uploadScript,
      options.exportScript,
      options.extractionScript,
    ));

    const runner = await runNodeScript(runnerPath, {
      cwd: options.targetDir,
      timeoutMs: driveTimeoutMs,
      env: {
        ...process.env,
        ...options.env,
        PGAS_PROVIDER: 'openai',
        PGAS_OPENAI_BASE_URL: proxy.url,
        PGAS_OPENAI_MODEL: options.model,
        PGAS_MODEL: options.model,
        PGAS_OPENAI_API_KEY: process.env.PGAS_OPENAI_API_KEY ?? 'local',
        PGAS_OPENAI_TOOL_CHOICE: process.env.PGAS_OPENAI_TOOL_CHOICE ?? 'required',
        PGAS_OPENAI_DISABLE_THINKING: process.env.PGAS_OPENAI_DISABLE_THINKING ?? '1',
        PGAS_OPENAI_TEMPERATURE: process.env.PGAS_OPENAI_TEMPERATURE ?? '0.2',
        PGAS_DB: join(workDir, 'live-drive.db'),
        PGAS_SESSION_LOG_DIR: join(workDir, 'session-logs'),
        PGAS_LIVE_DRIVE_REPORT: reportPath,
        PGAS_LIVE_DRIVE_ENTRY_CHANNEL: options.entryChannel ?? 'user_text',
        PGAS_LIVE_DRIVE_INITIAL_TEXT: options.initialText,
        PGAS_LIVE_DRIVE_FINAL_STAGE: options.finalStage ?? DEFAULT_FINAL_STAGE,
        PGAS_LIVE_DRIVE_MAX_TRIGGERS: String(options.maxTriggers ?? DEFAULT_MAX_TRIGGERS),
        PGAS_LIVE_DRIVE_TIMEOUT_MS: String(Math.max(driveTimeoutMs - 30_000, 60_000)),
        ...(options.confirmationScript
          ? { PGAS_LIVE_DRIVE_CONFIRMATION_SCRIPT: JSON.stringify(options.confirmationScript) }
          : {}),
        ...(options.delegationScript
          ? { PGAS_LIVE_DRIVE_DELEGATION_SCRIPT: JSON.stringify(options.delegationScript) }
          : {}),
        ...(options.uploadScript
          ? {
              PGAS_LIVE_DRIVE_UPLOAD_SCRIPT: JSON.stringify(options.uploadScript),
              PGAS_LIVE_DRIVE_UPLOADS_DIR: join(workDir, 'uploads'),
            }
          : {}),
        ...(options.exportScript
          ? { PGAS_LIVE_DRIVE_EXPORT_SCRIPT: JSON.stringify(options.exportScript) }
          : {}),
        ...(options.extractionScript
          ? {
              PGAS_LIVE_DRIVE_EXTRACTION_SCRIPT: JSON.stringify(options.extractionScript),
              PGAS_LIVE_DRIVE_UPLOADS_DIR: join(workDir, 'uploads'),
            }
          : {}),
      },
    });

    const report = readDriveReport(reportPath);
    const providerHits = proxy.hits();
    const statusHistory = parseStatusHistory(report?.status_history);
    const finalMode = typeof report?.final_mode === 'string' ? report.final_mode : null;
    const world = isRecord(report?.world) ? report.world : {};
    const parentSessionId = typeof report?.session_id === 'string' ? report.session_id : null;
    const delegation = parseDelegationReport(report?.delegation);
    const upload = parseUploadReport(report?.upload);
    const exportReport = parseExportReport(report?.export);
    const extraction = parseExtractionReport(report?.extraction);
    const delegationVerdict = options.delegationScript
      ? assessDelegationEngagement({
          report: delegation,
          parentSessionId,
          finalMode,
          expectedFinalMode: options.finalStage ?? DEFAULT_FINAL_STAGE,
          providerHits,
          parentProviderHitMinimum: 1,
          stubFindings: generatedStageOutputStubFindings(world),
          hostStage: options.delegationScript.stage,
        })
      : noDelegationScriptVerdict(providerHits);
    const choreography = options.confirmationScript
      ? assessChoreography(statusHistory, options.confirmationScript, providerHits)
      : noConfirmationScriptChoreography(providerHits);
    const uploadVerdict = options.uploadScript
      ? assessUploadEngagement({
          report: upload,
          finalMode,
          expectedFinalMode: options.finalStage ?? DEFAULT_FINAL_STAGE,
          providerHits,
          stubFindings: generatedStageOutputStubFindings(world),
          hostStage: options.uploadScript.stage,
        })
      : noUploadScriptVerdict(providerHits);
    const exportVerdict = options.exportScript
      ? assessExportEngagement({
          report: exportReport,
          expectedPayloadRef: options.exportScript.resultPath,
          nonce: options.exportScript.nonce,
        })
      : noExportScriptVerdict();
    const extractionVerdict = options.extractionScript
      ? assessExtractionEngagement({
          report: extraction,
          finalMode,
          expectedFinalMode: options.finalStage ?? DEFAULT_FINAL_STAGE,
          providerHits,
          stubFindings: generatedStageOutputStubFindings(world),
          hostStage: options.extractionScript.stage,
        })
      : noExtractionScriptVerdict(providerHits);
    return {
      final_mode: finalMode,
      terminal: report?.terminal === true,
      rounds: typeof report?.rounds === 'number' ? report.rounds : 0,
      triggers: typeof report?.triggers === 'number' ? report.triggers : 0,
      actions: Array.isArray(report?.actions) ? report.actions.filter(isNonEmptyString) : [],
      terminal_actions: parseTerminalActions(report?.terminal_actions),
      world,
      parent_session_id: parentSessionId,
      provider_hits: providerHits,
      provider_exchanges: proxy.exchanges(),
      author_driver: report?.author_driver === 'unified' || report?.author_driver === 'default'
        ? report.author_driver
        : null,
      status_history: statusHistory,
      choreography,
      delegation,
      delegation_verdict: delegationVerdict,
      delegation_engaged: delegationVerdict.delegation_engaged,
      upload,
      upload_verdict: uploadVerdict,
      upload_engaged: uploadVerdict.upload_engaged,
      export: exportReport,
      export_verdict: exportVerdict,
      export_engaged: exportVerdict.export_engaged,
      extraction,
      extraction_verdict: extractionVerdict,
      extraction_engaged: extractionVerdict.extraction_engaged,
      runner_exit_code: runner.exitCode,
      runner_output_excerpt: runner.output.slice(-4_000),
      ...(typeof report?.error === 'string' ? { runner_error: report.error } : {}),
      ...(typeof report?.timeout_kind === 'string' ? { runner_timeout_kind: report.timeout_kind } : {}),
    };
  } finally {
    await proxy.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * The runner executes INSIDE the rendered scaffold (cwd = targetDir) via
 * `node --import tsx`, so it resolves the scaffold's own dependencies and
 * imports the generated program registration exactly as the scaffold's
 * production server does. It boots a real engine (no scripted authorResponses,
 * no stub drivers — the env-configured provider makes every decision) and
 * drives the session to the completion stage over the entry channel.
 */
export function renderLiveDriveRunnerSource(
  slug: string,
  confirmationScript?: GeneratedLiveDriveConfirmationScript,
  delegationScript?: GeneratedLiveDriveDelegationScript,
  uploadScript?: GeneratedLiveDriveUploadScript,
  exportScript?: GeneratedLiveDriveExportScript,
  extractionScript?: GeneratedLiveDriveExtractionScript,
): string {
  if (extractionScript) {
    return renderExtractionLiveDriveRunnerSource(slug);
  }
  if (uploadScript) {
    return renderUploadLiveDriveRunnerSource(slug);
  }
  if (exportScript) {
    return renderExportLiveDriveRunnerSource(slug);
  }
  if (delegationScript) {
    return renderDelegationLiveDriveRunnerSource(slug, delegationScript.childProgram);
  }
  if (confirmationScript) {
    return renderConfirmationLiveDriveRunnerSource(slug);
  }
  return renderEntryOnlyLiveDriveRunnerSource(slug);
}

function renderEntryOnlyLiveDriveRunnerSource(slug: string): string {
  const pascal = toPascalCase(slug);
  return `import { writeFileSync } from 'node:fs';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import { appTransport, createPgasClient, type PgasClient } from '@simodelne/pgas-server/client.js';
import { create${pascal}ProgramEntry } from '../src/programs/${slug}/registration.js';

const REPORT_PATH = process.env.PGAS_LIVE_DRIVE_REPORT ?? '';
const ENTRY_CHANNEL = process.env.PGAS_LIVE_DRIVE_ENTRY_CHANNEL ?? 'user_text';
const INITIAL_TEXT = process.env.PGAS_LIVE_DRIVE_INITIAL_TEXT ?? 'start generated live drive';
const FINAL_STAGE = process.env.PGAS_LIVE_DRIVE_FINAL_STAGE ?? 'complete';
const MAX_TRIGGERS = Number(process.env.PGAS_LIVE_DRIVE_MAX_TRIGGERS ?? '12');
const DEADLINE = Date.now() + Number(process.env.PGAS_LIVE_DRIVE_TIMEOUT_MS ?? '540000');

interface DriveState {
  mode: string | null;
  terminal: boolean;
  roundCount: number;
  world: Record<string, unknown>;
  actions: string[];
  terminalActions: Array<{ name: string; payload_excerpt: string }>;
}

async function main(): Promise<void> {
  // Opt-in unified native-tools author driver: mirrors the rendered scaffold's
  // src/server.ts gating. Default (PGAS_AUTHOR_DRIVER unset) boots the engine's
  // legacy JSON author path exactly as before; the dynamic import keeps the
  // default path byte-identical even against a scaffold without the module.
  let drivers: Parameters<typeof createPgasServer>[0]['drivers'];
  if ((process.env.PGAS_AUTHOR_DRIVER ?? '').trim().toLowerCase() === 'unified') {
    const authorDriver = await import('../src/author-driver.js');
    drivers = authorDriver.resolveAuthorDrivers();
  }
  const server = await createPgasServer({
    programs: [{ name: '${slug}', entry: create${pascal}ProgramEntry() }],
    devMode: true,
    ...(drivers ? { drivers } : {}),
  });
  const client = createPgasClient(appTransport(server.app, { token: 'dev-token' }));
  const created = await client.sessions.create({
    program: '${slug}',
    domain_context: { query: INITIAL_TEXT },
  });
  const sessionId = created.sessionId;

  let payloadText = INITIAL_TEXT;
  let triggers = 0;
  let state = await readState(client, sessionId);
  while (state.mode !== FINAL_STAGE && !state.terminal && triggers < MAX_TRIGGERS && Date.now() < DEADLINE) {
    const before = state.roundCount;
    try {
      await client.sessions.trigger(sessionId, { channel: ENTRY_CHANNEL, payload: payloadText });
    } catch (error) {
      if (/terminal/iu.test(String(error))) break;
      throw error;
    }
    triggers += 1;
    payloadText = 'Continue to the next stage of the workflow.';
    state = await waitForRound(client, sessionId, before);
  }

  state = await readState(client, sessionId);
  writeReport({
    final_mode: state.mode,
    terminal: state.terminal,
    rounds: state.roundCount,
    triggers,
    actions: state.actions,
    terminal_actions: state.terminalActions,
    world: state.world,
    author_driver: drivers ? 'unified' : 'default',
  });
  process.exit(0);
}

async function waitForRound(client: PgasClient, sessionId: string, before: number): Promise<DriveState> {
  let latest = await readState(client, sessionId);
  while (latest.roundCount <= before && !latest.terminal && Date.now() < DEADLINE) {
    await sleep(1_000);
    latest = await readState(client, sessionId);
  }
  return latest;
}

async function readState(client: PgasClient, sessionId: string): Promise<DriveState> {
  const [envelope, worldResponse, roundsResponse] = await Promise.all([
    client.sessions.get(sessionId),
    client.sessions.world(sessionId),
    client.sessions.rounds(sessionId),
  ]);
  const rounds = Array.isArray(roundsResponse.rounds) ? roundsResponse.rounds : [];
  const status = typeof envelope.status === 'string' ? envelope.status : '';
  const stateRecord = envelope.state as Record<string, unknown> | undefined;
  const mode = firstString(envelope.mode, stateRecord?.mode);
  const terminalActions = rounds.flatMap((round) => terminalActionOf(round));
  return {
    mode,
    terminal: Boolean(stateRecord?.terminal ?? envelope.terminal) || status.toLowerCase() === 'completed',
    roundCount: rounds.length,
    world: worldResponse.domain as Record<string, unknown>,
    actions: terminalActions.map((action) => action.name),
    terminalActions,
  };
}

function terminalActionOf(round: unknown): Array<{ name: string; payload_excerpt: string }> {
  if (!round || typeof round !== 'object' || Array.isArray(round)) return [];
  const result = (round as { result?: unknown }).result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
  const terminal = (result as { terminal?: unknown }).terminal;
  if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)) return [];
  const name = (terminal as { name?: unknown }).name;
  if (typeof name !== 'string' || name.length === 0) return [];
  const payload = (terminal as { payload?: unknown }).payload;
  return [{ name, payload_excerpt: JSON.stringify(payload ?? null).slice(0, 4_000) }];
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function writeReport(report: Record<string, unknown>): void {
  if (REPORT_PATH.length > 0) {
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

process.on('unhandledRejection', (reason: unknown) => {
  const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  console.error('[live-drive-runner] unhandledRejection:', msg);
  try { writeReport({ error: 'unhandledRejection: ' + msg }); } catch {}
  process.exit(1);
});
main().catch((error: unknown) => {
  const msg = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error('[live-drive-runner] CRASH:', msg);
  writeReport({ error: msg });
  process.exit(1);
});
`;
}

export function renderDelegationLiveDriveRunnerSource(slug: string, childProgram: string): string {
  const pascal = toPascalCase(slug);
  const childPascal = toPascalCase(childProgram);
  return `import { writeFileSync } from 'node:fs';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import { appTransport, createPgasClient, type PgasClient } from '@simodelne/pgas-server/client.js';
import { create${pascal}ProgramEntry } from '../src/programs/${slug}/registration.js';
import { create${childPascal}ProgramEntry } from '../src/programs/${childProgram}/registration.js';

const REPORT_PATH = process.env.PGAS_LIVE_DRIVE_REPORT ?? '';
const ENTRY_CHANNEL = process.env.PGAS_LIVE_DRIVE_ENTRY_CHANNEL ?? 'user_text';
const INITIAL_TEXT = process.env.PGAS_LIVE_DRIVE_INITIAL_TEXT ?? 'start generated live drive';
const FINAL_STAGE = process.env.PGAS_LIVE_DRIVE_FINAL_STAGE ?? 'complete';
const MAX_TRIGGERS = Number(process.env.PGAS_LIVE_DRIVE_MAX_TRIGGERS ?? '12');
const DEADLINE = Date.now() + Number(process.env.PGAS_LIVE_DRIVE_TIMEOUT_MS ?? '540000');
const delegationScript = parseDelegationScript(process.env.PGAS_LIVE_DRIVE_DELEGATION_SCRIPT ?? '');

interface DriveState {
  mode: string | null;
  terminal: boolean;
  roundCount: number;
  world: Record<string, unknown>;
  actions: string[];
  terminalActions: Array<{ name: string; payload_excerpt: string }>;
}

interface DelegationScript {
  resultPath: string;
  settledPath: string;
  degradedPath: string;
  stage: string;
  childProgram: string;
}

async function main(): Promise<void> {
  // Opt-in unified native-tools author driver: mirrors the rendered scaffold's
  // src/server.ts gating. Default (PGAS_AUTHOR_DRIVER unset) boots the engine's
  // legacy JSON author path exactly as before; the dynamic import keeps the
  // default path byte-identical even against a scaffold without the module.
  let drivers: Parameters<typeof createPgasServer>[0]['drivers'];
  if ((process.env.PGAS_AUTHOR_DRIVER ?? '').trim().toLowerCase() === 'unified') {
    const authorDriver = await import('../src/author-driver.js');
    drivers = authorDriver.resolveAuthorDrivers();
  }
  const server = await createPgasServer({
    programs: [
      { name: '${slug}', entry: create${pascal}ProgramEntry() },
      { name: '${childProgram}', entry: create${childPascal}ProgramEntry() },
    ],
    devMode: true,
    ...(drivers ? { drivers } : {}),
  });
  const client = createPgasClient(appTransport(server.app, { token: 'dev-token' }));
  const created = await client.sessions.create({
    program: '${slug}',
    domain_context: { query: INITIAL_TEXT },
  });
  const sessionId = created.sessionId;

  let payloadText = INITIAL_TEXT;
  let triggers = 0;
  let state = await readState(client, sessionId);
  while (state.mode !== FINAL_STAGE && !state.terminal && triggers < MAX_TRIGGERS && Date.now() < DEADLINE) {
    const before = state.roundCount;
    try {
      await triggerWithDeadline(client, sessionId, { channel: ENTRY_CHANNEL, payload: payloadText });
    } catch (error) {
      if (/terminal/iu.test(String(error))) break;
      if (isTriggerInFlightTimeout(error)) {
        const latest = await safeReadState(client, sessionId, state);
        writeDriveReport({
          session_id: sessionId,
          state: latest,
          triggers,
          drivers,
          timeout_kind: 'trigger_in_flight',
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
        process.exit(1);
      }
      throw error;
    }
    triggers += 1;
    payloadText = 'Continue to the next stage of the workflow.';
    state = await waitForRound(client, sessionId, before);
  }

  state = await readState(client, sessionId);
  writeDriveReport({ session_id: sessionId, state, triggers, drivers });
  process.exit(0);
}

async function triggerWithDeadline(
  client: PgasClient,
  sessionId: string,
  payload: { channel: string; payload: unknown },
): Promise<void> {
  const remaining = DEADLINE - Date.now();
  if (remaining <= 0) {
    throw new Error('trigger_in_flight_timeout: deadline reached before trigger');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.sessions.trigger(sessionId, payload),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('trigger_in_flight_timeout: parent trigger exceeded live-drive deadline')), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isTriggerInFlightTimeout(error: unknown): boolean {
  return /trigger_in_flight_timeout/u.test(error instanceof Error ? error.message : String(error));
}

async function waitForRound(client: PgasClient, sessionId: string, before: number): Promise<DriveState> {
  let latest = await readState(client, sessionId);
  while (latest.roundCount <= before && !latest.terminal && Date.now() < DEADLINE) {
    await sleep(1_000);
    latest = await readState(client, sessionId);
  }
  return latest;
}

async function safeReadState(client: PgasClient, sessionId: string, fallback: DriveState): Promise<DriveState> {
  try {
    return await readState(client, sessionId);
  } catch {
    return fallback;
  }
}

async function readState(client: PgasClient, sessionId: string): Promise<DriveState> {
  const [envelope, worldResponse, roundsResponse] = await Promise.all([
    client.sessions.get(sessionId),
    client.sessions.world(sessionId),
    client.sessions.rounds(sessionId),
  ]);
  const rounds = Array.isArray(roundsResponse.rounds) ? roundsResponse.rounds : [];
  const status = typeof envelope.status === 'string' ? envelope.status : '';
  const stateRecord = envelope.state as Record<string, unknown> | undefined;
  const mode = firstString(envelope.mode, stateRecord?.mode);
  const terminalActions = rounds.flatMap((round) => terminalActionOf(round));
  return {
    mode,
    terminal: Boolean(stateRecord?.terminal ?? envelope.terminal) || status.toLowerCase() === 'completed',
    roundCount: rounds.length,
    world: worldResponse.domain as Record<string, unknown>,
    actions: terminalActions.map((action) => action.name),
    terminalActions,
  };
}

function parseDelegationScript(raw: string): DelegationScript {
  if (raw.trim().length === 0) {
    throw new Error('PGAS_LIVE_DRIVE_DELEGATION_SCRIPT is required for delegation live drive');
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('PGAS_LIVE_DRIVE_DELEGATION_SCRIPT must be an object');
  }
  const script = {
    resultPath: stringField(parsed, 'resultPath'),
    settledPath: stringField(parsed, 'settledPath'),
    degradedPath: stringField(parsed, 'degradedPath'),
    stage: stringField(parsed, 'stage'),
    childProgram: stringField(parsed, 'childProgram'),
  };
  if (!script.resultPath || !script.settledPath || !script.degradedPath || !script.stage || !script.childProgram) {
    throw new Error('PGAS_LIVE_DRIVE_DELEGATION_SCRIPT is missing required resultPath/settledPath/degradedPath/stage/childProgram');
  }
  return script;
}

function writeDriveReport(input: {
  session_id: string;
  state: DriveState;
  triggers: number;
  drivers: Parameters<typeof createPgasServer>[0]['drivers'];
  timeout_kind?: string;
  error?: string;
}): void {
  writeReport({
    final_mode: input.state.mode,
    terminal: input.state.terminal,
    rounds: input.state.roundCount,
    triggers: input.triggers,
    actions: input.state.actions,
    terminal_actions: input.state.terminalActions,
    world: input.state.world,
    session_id: input.session_id,
    author_driver: input.drivers ? 'unified' : 'default',
    delegation: delegationReportFromWorld(input.state.world, delegationScript),
    ...(input.timeout_kind ? { timeout_kind: input.timeout_kind } : {}),
    ...(input.error ? { error: input.error } : {}),
  });
}

function delegationReportFromWorld(world: Record<string, unknown>, script: DelegationScript): Record<string, unknown> {
  const result = recordFromWorldPath(world, script.resultPath);
  const status = stringValue(result.status);
  const sessionId = stringValue(result.sessionId);
  const rounds = numberValue(result.rounds);
  const settled = valueAtWorldPath(world, script.settledPath) === true;
  const degraded = valueAtWorldPath(world, script.degradedPath) === true;
  const degradeReason = stringValue(valueAtWorldPath(world, degradeReasonPath(script))) ?? '';
  return {
    child_program: script.childProgram,
    result_status: status,
    child_session_id: sessionId,
    child_rounds: rounds ?? 0,
    optional: result.optional === true,
    settled,
    degraded,
    degrade_reason: degradeReason,
    exported_fields: exportedFields(result),
  };
}

function recordFromWorldPath(world: Record<string, unknown>, path: string): Record<string, unknown> {
  const direct = valueAtWorldPath(world, path);
  const record = isRecord(direct) ? { ...direct } : {};
  const prefix = path + '.';
  for (const [key, value] of Object.entries(world)) {
    if (!key.startsWith(prefix)) continue;
    const field = key.slice(prefix.length);
    if (field.length > 0 && !field.includes('.')) {
      record[field] = value;
    }
  }
  return record;
}

function exportedFields(result: Record<string, unknown>): Record<string, unknown> {
  const reserved = new Set(['status', 'sessionId', 'rounds', 'mode', 'reason', 'optional', 'result']);
  const fields: Record<string, unknown> = {};
  if (isRecord(result.result)) {
    Object.assign(fields, result.result);
  }
  for (const [key, value] of Object.entries(result)) {
    if (!reserved.has(key)) {
      fields[key] = value;
    }
  }
  return fields;
}

function degradeReasonPath(script: DelegationScript): string {
  return script.degradedPath.endsWith('.degraded')
    ? script.degradedPath.slice(0, -'.degraded'.length) + '.degrade_reason'
    : script.degradedPath + '.reason';
}

function valueAtWorldPath(world: Record<string, unknown>, path: string): unknown {
  if (Object.prototype.hasOwnProperty.call(world, path)) {
    return world[path];
  }
  let cursor: unknown = world;
  for (const part of path.split('.')) {
    if (!isRecord(cursor) || !Object.prototype.hasOwnProperty.call(cursor, part)) {
      return undefined;
    }
    cursor = cursor[part];
  }
  return cursor;
}

function terminalActionOf(round: unknown): Array<{ name: string; payload_excerpt: string }> {
  if (!round || typeof round !== 'object' || Array.isArray(round)) return [];
  const result = (round as { result?: unknown }).result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
  const terminal = (result as { terminal?: unknown }).terminal;
  if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)) return [];
  const name = (terminal as { name?: unknown }).name;
  if (typeof name !== 'string' || name.length === 0) return [];
  const payload = (terminal as { payload?: unknown }).payload;
  return [{ name, payload_excerpt: JSON.stringify(payload ?? null).slice(0, 4_000) }];
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function writeReport(report: Record<string, unknown>): void {
  if (REPORT_PATH.length > 0) {
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

process.on('unhandledRejection', (reason: unknown) => {
  const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  console.error('[live-drive-runner] unhandledRejection:', msg);
  try { writeReport({ error: 'unhandledRejection: ' + msg }); } catch {}
  process.exit(1);
});
main().catch((error: unknown) => {
  const msg = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error('[live-drive-runner] CRASH:', msg);
  writeReport({ error: msg });
  process.exit(1);
});
`;
}

export function renderExtractionLiveDriveRunnerSource(slug: string): string {
  const pascal = toPascalCase(slug);
  return `import { writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import { appTransport, createPgasClient, type PgasClient } from '@simodelne/pgas-server/client.js';
import { create${pascal}ProgramEntry } from '../src/programs/${slug}/registration.js';
import { renderStructuredDocxDocument } from '../src/programs/${slug}/export/docx.js';

const REPORT_PATH = process.env.PGAS_LIVE_DRIVE_REPORT ?? '';
const ENTRY_CHANNEL = process.env.PGAS_LIVE_DRIVE_ENTRY_CHANNEL ?? 'user_text';
const INITIAL_TEXT = process.env.PGAS_LIVE_DRIVE_INITIAL_TEXT ?? 'start generated live drive';
const FINAL_STAGE = process.env.PGAS_LIVE_DRIVE_FINAL_STAGE ?? 'complete';
const MAX_TRIGGERS = Number(process.env.PGAS_LIVE_DRIVE_MAX_TRIGGERS ?? '12');
const DEADLINE = Date.now() + Number(process.env.PGAS_LIVE_DRIVE_TIMEOUT_MS ?? '540000');
const UPLOADS_DIR = process.env.PGAS_LIVE_DRIVE_UPLOADS_DIR ?? '';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const extractionScript = parseExtractionScript(process.env.PGAS_LIVE_DRIVE_EXTRACTION_SCRIPT ?? '');

interface DriveState {
  mode: string | null;
  terminal: boolean;
  roundCount: number;
  world: Record<string, unknown>;
  actions: string[];
  terminalActions: Array<{ name: string; payload_excerpt: string }>;
}

interface ExtractionScript {
  resultPath: string;
  sourceReadyPath: string;
  stage: string;
  sentinel: string;
}

interface ExtractionAttempt {
  attempted: boolean;
  uploadAccepted: boolean;
  uploadedFileId: string | null;
  fileRef: Record<string, unknown> | null;
  expectedCharCount: number;
  sentinelNotInRawUpload: boolean;
}

async function main(): Promise<void> {
  // Opt-in unified native-tools author driver: mirrors the rendered scaffold's
  // src/server.ts gating. Default (PGAS_AUTHOR_DRIVER unset) boots the engine's
  // legacy JSON author path exactly as before; the dynamic import keeps the
  // default path byte-identical even against a scaffold without the module.
  let drivers: Parameters<typeof createPgasServer>[0]['drivers'];
  if ((process.env.PGAS_AUTHOR_DRIVER ?? '').trim().toLowerCase() === 'unified') {
    const authorDriver = await import('../src/author-driver.js');
    drivers = authorDriver.resolveAuthorDrivers();
  }
  const server = await createPgasServer({
    programs: [{ name: '${slug}', entry: create${pascal}ProgramEntry() }],
    devMode: true,
    ...(UPLOADS_DIR.length > 0 ? { storage: { uploadsDir: UPLOADS_DIR } } : {}),
    ...(drivers ? { drivers } : {}),
  });
  const client = createPgasClient(appTransport(server.app, { token: 'dev-token' }));
  const created = await client.sessions.create({
    program: '${slug}',
    domain_context: { query: INITIAL_TEXT },
  });
  const sessionId = created.sessionId;

  let payloadText = INITIAL_TEXT;
  let triggers = 0;
  let extraction = noExtractionAttempt();
  let state = await readState(client, sessionId);
  while (state.mode !== FINAL_STAGE && !state.terminal && triggers < MAX_TRIGGERS && Date.now() < DEADLINE) {
    if (!extraction.attempted && state.mode === extractionScript.stage) {
      extraction = await uploadDeflatedDocxFixture(client, sessionId, extractionScript);
      if (extraction.fileRef) {
        const before = state.roundCount;
        try {
          await triggerWithDeadline(client, sessionId, {
            channel: 'document_upload',
            payload: { 'inputs.document_intake.file_refs': [extraction.fileRef] },
          });
        } catch (error) {
          if (/terminal/iu.test(String(error))) break;
          throw error;
        }
        triggers += 1;
        state = await waitForRoundOrUploadLanding(client, sessionId, before, extraction.uploadedFileId);
        continue;
      }
    }

    const before = state.roundCount;
    try {
      await triggerWithDeadline(client, sessionId, { channel: ENTRY_CHANNEL, payload: payloadText });
    } catch (error) {
      if (/terminal/iu.test(String(error))) break;
      if (isTriggerInFlightTimeout(error)) {
        const latest = await safeReadState(client, sessionId, state);
        writeDriveReport({
          session_id: sessionId,
          state: latest,
          triggers,
          drivers,
          extraction,
          timeout_kind: 'trigger_in_flight',
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
        process.exit(1);
      }
      throw error;
    }
    triggers += 1;
    payloadText = 'Continue to the next stage of the workflow.';
    state = await waitForRound(client, sessionId, before);
  }

  state = await readState(client, sessionId);
  writeDriveReport({ session_id: sessionId, state, triggers, drivers, extraction });
  process.exit(0);
}

async function uploadDeflatedDocxFixture(
  client: PgasClient,
  sessionId: string,
  script: ExtractionScript,
): Promise<ExtractionAttempt> {
  const fixture = buildDeflatedDocxFixture(script.sentinel);
  if (zipCompressionKind(fixture.bytes) !== 'docx_deflate') {
    throw new Error('extraction fixture was not DEFLATE-compressed');
  }
  const raw = Buffer.from(fixture.bytes);
  const sentinelBytes = Buffer.from(script.sentinel, 'utf8');
  const sentinelNotInRawUpload = !raw.includes(sentinelBytes) && !raw.toString('base64').includes(script.sentinel);
  const form = new FormData();
  form.append('files', new Blob([fixture.bytes], { type: DOCX_MIME }), \`pgas-extraction-live-drive-\${Date.now()}.docx\`);
  const uploaded = await client.files.upload(sessionId, form);
  const files = isRecord(uploaded) && Array.isArray(uploaded.files)
    ? uploaded.files.filter(isRecord)
    : [];
  const fileRef = files[0] ?? null;
  const fileId = fileRef ? stringValue(fileRef.fileId) : null;
  return {
    attempted: true,
    uploadAccepted: fileId !== null,
    uploadedFileId: fileId,
    fileRef,
    expectedCharCount: fixture.expectedCharCount,
    sentinelNotInRawUpload,
  };
}

function buildDeflatedDocxFixture(sentinel: string): { bytes: Uint8Array; expectedCharCount: number } {
  const title = 'PGAS DOCX Extraction Live Drive';
  const sectionTitle = 'Source';
  const body = [
    \`Nonce: \${sentinel}\`,
    'This DEFLATE-compressed DOCX fixture is authored inside the live-drive runner.',
    'The generated program must inflate OOXML and extract this exact body text.',
  ];
  const expectedText = [title, sectionTitle, ...body].join('\\n');
  const storeDocx = renderStructuredDocxDocument({
    title,
    sections: [{ title: sectionTitle, body }],
  });
  return {
    bytes: rezipDeflate(storeDocx),
    expectedCharCount: expectedText.length,
  };
}

function rezipDeflate(storeDocxBytes: Uint8Array): Uint8Array {
  const entries = parseStoreZipEntries(storeDocxBytes);
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const compressed = asUint8Array(deflateRawSync(entry.data));
    const crc = crc32(entry.data);
    const local = concat([
      u32(0x04034b50), u16(20), u16(0), u16(8), u16(0), u16(0), u32(crc),
      u32(compressed.length), u32(entry.data.length), u16(nameBytes.length), u16(0), nameBytes, compressed,
    ]);
    chunks.push(local);
    central.push(concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u16(0), u16(0), u32(crc),
      u32(compressed.length), u32(entry.data.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(offset), nameBytes,
    ]));
    offset += local.length;
  }
  const centralOffset = offset;
  const centralBytes = concat(central);
  const end = concat([
    u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
    u32(centralBytes.length), u32(centralOffset), u16(0),
  ]);
  return concat([...chunks, centralBytes, end]);
}

function parseStoreZipEntries(bytes: Uint8Array): Array<{ name: string; data: Uint8Array }> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: Array<{ name: string; data: Uint8Array }> = [];
  let offset = 0;
  while (offset + 4 <= bytes.length && dv.getUint32(offset, true) === 0x04034b50) {
    const method = dv.getUint16(offset + 8, true);
    const compressedSize = dv.getUint32(offset + 18, true);
    const nameLength = dv.getUint16(offset + 26, true);
    const extraLength = dv.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (method !== 0 || dataEnd > bytes.length) {
      throw new Error('expected a valid STORE zip entry');
    }
    entries.push({
      name: new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength)),
      data: bytes.subarray(dataStart, dataEnd),
    });
    offset = dataEnd;
  }
  return entries;
}

function zipCompressionKind(bytes: Uint8Array): string {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let sawEntry = false;
  let sawDeflate = false;
  while (offset + 4 <= bytes.length && dv.getUint32(offset, true) === 0x04034b50) {
    sawEntry = true;
    const method = dv.getUint16(offset + 8, true);
    const compressedSize = dv.getUint32(offset + 18, true);
    const nameLength = dv.getUint16(offset + 26, true);
    const extraLength = dv.getUint16(offset + 28, true);
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
  if (!sawEntry) return 'docx_unknown';
  return sawDeflate ? 'docx_deflate' : 'docx_store';
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function u16(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);
}

function u32(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function asUint8Array(value: Uint8Array): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

async function triggerWithDeadline(
  client: PgasClient,
  sessionId: string,
  payload: { channel: string; payload: unknown },
): Promise<void> {
  const remaining = DEADLINE - Date.now();
  if (remaining <= 0) {
    throw new Error('trigger_in_flight_timeout: deadline reached before trigger');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.sessions.trigger(sessionId, payload),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('trigger_in_flight_timeout: trigger exceeded live-drive deadline')), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isTriggerInFlightTimeout(error: unknown): boolean {
  return /trigger_in_flight_timeout/u.test(error instanceof Error ? error.message : String(error));
}

async function waitForRound(client: PgasClient, sessionId: string, before: number): Promise<DriveState> {
  let latest = await readState(client, sessionId);
  while (latest.roundCount <= before && !latest.terminal && Date.now() < DEADLINE) {
    await sleep(1_000);
    latest = await readState(client, sessionId);
  }
  return latest;
}

async function waitForRoundOrUploadLanding(
  client: PgasClient,
  sessionId: string,
  before: number,
  fileId: string | null,
): Promise<DriveState> {
  let latest = await readState(client, sessionId);
  while (latest.roundCount <= before && !latest.terminal && !refsLanded(latest.world, fileId) && Date.now() < DEADLINE) {
    await sleep(1_000);
    latest = await readState(client, sessionId);
  }
  return latest;
}

async function safeReadState(client: PgasClient, sessionId: string, fallback: DriveState): Promise<DriveState> {
  try {
    return await readState(client, sessionId);
  } catch {
    return fallback;
  }
}

async function readState(client: PgasClient, sessionId: string): Promise<DriveState> {
  const [envelope, worldResponse, roundsResponse] = await Promise.all([
    client.sessions.get(sessionId),
    client.sessions.world(sessionId),
    client.sessions.rounds(sessionId),
  ]);
  const rounds = Array.isArray(roundsResponse.rounds) ? roundsResponse.rounds : [];
  const status = typeof envelope.status === 'string' ? envelope.status : '';
  const stateRecord = envelope.state as Record<string, unknown> | undefined;
  const mode = firstString(envelope.mode, stateRecord?.mode);
  const terminalActions = rounds.flatMap((round) => terminalActionOf(round));
  return {
    mode,
    terminal: Boolean(stateRecord?.terminal ?? envelope.terminal) || status.toLowerCase() === 'completed',
    roundCount: rounds.length,
    world: worldResponse.domain as Record<string, unknown>,
    actions: terminalActions.map((action) => action.name),
    terminalActions,
  };
}

function parseExtractionScript(raw: string): ExtractionScript {
  if (raw.trim().length === 0) {
    throw new Error('PGAS_LIVE_DRIVE_EXTRACTION_SCRIPT is required for extraction live drive');
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('PGAS_LIVE_DRIVE_EXTRACTION_SCRIPT must be an object');
  }
  const script = {
    resultPath: stringField(parsed, 'resultPath'),
    sourceReadyPath: stringField(parsed, 'sourceReadyPath'),
    stage: stringField(parsed, 'stage'),
    sentinel: stringField(parsed, 'sentinel'),
  };
  if (!script.resultPath || !script.sourceReadyPath || !script.stage || !script.sentinel) {
    throw new Error('PGAS_LIVE_DRIVE_EXTRACTION_SCRIPT is missing required resultPath/sourceReadyPath/stage/sentinel');
  }
  return script;
}

function writeDriveReport(input: {
  session_id: string;
  state: DriveState;
  triggers: number;
  drivers: Parameters<typeof createPgasServer>[0]['drivers'];
  extraction: ExtractionAttempt;
  timeout_kind?: string;
  error?: string;
}): void {
  const report = {
    final_mode: input.state.mode,
    terminal: input.state.terminal,
    rounds: input.state.roundCount,
    triggers: input.triggers,
    actions: input.state.actions,
    terminal_actions: input.state.terminalActions,
    world: input.state.world,
    session_id: input.session_id,
    author_driver: input.drivers ? 'unified' : 'default',
    extraction: extractionReportFromWorld(input.state.world, extractionScript, input.extraction),
    ...(input.timeout_kind ? { timeout_kind: input.timeout_kind } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
  writeReport(report);
  process.stdout.write(JSON.stringify({ extraction: report.extraction }) + '\\n');
}

function extractionReportFromWorld(
  world: Record<string, unknown>,
  script: ExtractionScript,
  extraction: ExtractionAttempt,
): Record<string, unknown> {
  const source = recordFromWorldPath(world, script.resultPath);
  const fullText = typeof source.full_text === 'string' ? source.full_text : '';
  return {
    source_status: stringValue(source.status),
    char_count: numberValue(source.char_count) ?? 0,
    expected_char_count: extraction.expectedCharCount,
    source_ready: valueAtWorldPath(world, script.sourceReadyPath) === true,
    full_text_excerpt: fullText.slice(0, 4_000),
    sentinel_present: fullText.includes(script.sentinel),
    uploaded_file_id: extraction.uploadedFileId,
    refs_landed: refsLanded(world, extraction.uploadedFileId),
    upload_accepted: extraction.uploadAccepted,
    extraction_kind: stringValue(source.extraction_kind),
    sentinel_not_in_raw_upload: extraction.sentinelNotInRawUpload,
  };
}

function refsLanded(world: Record<string, unknown>, fileId: string | null): boolean {
  if (!fileId) {
    return false;
  }
  if (valueAtWorldPath(world, 'inputs.document_intake.file_refs.0.fileId') === fileId) {
    return true;
  }
  const directRefs = valueAtWorldPath(world, 'inputs.document_intake.file_refs');
  if (Array.isArray(directRefs) && directRefs.some((ref) => isRecord(ref) && ref.fileId === fileId)) {
    return true;
  }
  const root = valueAtWorldPath(world, 'inputs.document_intake');
  return isRecord(root) &&
    Array.isArray(root.file_refs) &&
    root.file_refs.some((ref) => isRecord(ref) && ref.fileId === fileId);
}

function recordFromWorldPath(world: Record<string, unknown>, path: string): Record<string, unknown> {
  const direct = valueAtWorldPath(world, path);
  const record = isRecord(direct) ? { ...direct } : {};
  const prefix = path + '.';
  for (const [key, value] of Object.entries(world)) {
    if (!key.startsWith(prefix)) continue;
    const field = key.slice(prefix.length);
    if (field.length > 0 && !field.includes('.')) {
      record[field] = value;
    }
  }
  return record;
}

function valueAtWorldPath(world: Record<string, unknown>, path: string): unknown {
  if (Object.prototype.hasOwnProperty.call(world, path)) {
    return world[path];
  }
  let cursor: unknown = world;
  for (const part of path.split('.')) {
    if (!isRecord(cursor) || !Object.prototype.hasOwnProperty.call(cursor, part)) {
      return undefined;
    }
    cursor = cursor[part];
  }
  return cursor;
}

function noExtractionAttempt(): ExtractionAttempt {
  return {
    attempted: false,
    uploadAccepted: false,
    uploadedFileId: null,
    fileRef: null,
    expectedCharCount: 0,
    sentinelNotInRawUpload: false,
  };
}

function terminalActionOf(round: unknown): Array<{ name: string; payload_excerpt: string }> {
  if (!round || typeof round !== 'object' || Array.isArray(round)) return [];
  const result = (round as { result?: unknown }).result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
  const terminal = (result as { terminal?: unknown }).terminal;
  if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)) return [];
  const name = (terminal as { name?: unknown }).name;
  if (typeof name !== 'string' || name.length === 0) return [];
  const payload = (terminal as { payload?: unknown }).payload;
  return [{ name, payload_excerpt: JSON.stringify(payload ?? null).slice(0, 4_000) }];
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function writeReport(report: Record<string, unknown>): void {
  if (REPORT_PATH.length > 0) {
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

process.on('unhandledRejection', (reason: unknown) => {
  const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  console.error('[live-drive-runner] unhandledRejection:', msg);
  try { writeReport({ error: 'unhandledRejection: ' + msg }); } catch {}
  process.exit(1);
});
main().catch((error: unknown) => {
  const msg = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error('[live-drive-runner] CRASH:', msg);
  writeReport({ error: msg });
  process.exit(1);
});
`;
}

export function renderUploadLiveDriveRunnerSource(slug: string): string {
  const pascal = toPascalCase(slug);
  return `import { writeFileSync } from 'node:fs';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import { appTransport, createPgasClient, type PgasClient } from '@simodelne/pgas-server/client.js';
import { create${pascal}ProgramEntry } from '../src/programs/${slug}/registration.js';

const REPORT_PATH = process.env.PGAS_LIVE_DRIVE_REPORT ?? '';
const ENTRY_CHANNEL = process.env.PGAS_LIVE_DRIVE_ENTRY_CHANNEL ?? 'user_text';
const INITIAL_TEXT = process.env.PGAS_LIVE_DRIVE_INITIAL_TEXT ?? 'start generated live drive';
const FINAL_STAGE = process.env.PGAS_LIVE_DRIVE_FINAL_STAGE ?? 'complete';
const MAX_TRIGGERS = Number(process.env.PGAS_LIVE_DRIVE_MAX_TRIGGERS ?? '12');
const DEADLINE = Date.now() + Number(process.env.PGAS_LIVE_DRIVE_TIMEOUT_MS ?? '540000');
const UPLOADS_DIR = process.env.PGAS_LIVE_DRIVE_UPLOADS_DIR ?? '';
const uploadScript = parseUploadScript(process.env.PGAS_LIVE_DRIVE_UPLOAD_SCRIPT ?? '');

interface DriveState {
  mode: string | null;
  terminal: boolean;
  roundCount: number;
  world: Record<string, unknown>;
  actions: string[];
  terminalActions: Array<{ name: string; payload_excerpt: string }>;
}

interface UploadScript {
  resultPath: string;
  sourceReadyPath: string;
  stage: string;
  sentinel: string;
  expectedCharCount: number;
}

interface UploadAttempt {
  attempted: boolean;
  uploadAccepted: boolean;
  uploadedFileId: string | null;
  fileRef: Record<string, unknown> | null;
}

async function main(): Promise<void> {
  // Opt-in unified native-tools author driver: mirrors the rendered scaffold's
  // src/server.ts gating. Default (PGAS_AUTHOR_DRIVER unset) boots the engine's
  // legacy JSON author path exactly as before; the dynamic import keeps the
  // default path byte-identical even against a scaffold without the module.
  let drivers: Parameters<typeof createPgasServer>[0]['drivers'];
  if ((process.env.PGAS_AUTHOR_DRIVER ?? '').trim().toLowerCase() === 'unified') {
    const authorDriver = await import('../src/author-driver.js');
    drivers = authorDriver.resolveAuthorDrivers();
  }
  const server = await createPgasServer({
    programs: [{ name: '${slug}', entry: create${pascal}ProgramEntry() }],
    devMode: true,
    ...(UPLOADS_DIR.length > 0 ? { storage: { uploadsDir: UPLOADS_DIR } } : {}),
    ...(drivers ? { drivers } : {}),
  });
  const client = createPgasClient(appTransport(server.app, { token: 'dev-token' }));
  const created = await client.sessions.create({
    program: '${slug}',
    domain_context: { query: INITIAL_TEXT },
  });
  const sessionId = created.sessionId;

  let payloadText = INITIAL_TEXT;
  let triggers = 0;
  let upload = noUploadAttempt();
  let state = await readState(client, sessionId);
  while (state.mode !== FINAL_STAGE && !state.terminal && triggers < MAX_TRIGGERS && Date.now() < DEADLINE) {
    if (!upload.attempted && state.mode === uploadScript.stage) {
      upload = await uploadFixture(client, sessionId, uploadScript);
      if (upload.fileRef) {
        const before = state.roundCount;
        try {
          await triggerWithDeadline(client, sessionId, {
            channel: 'document_upload',
            payload: { 'inputs.document_intake.file_refs': [upload.fileRef] },
          });
        } catch (error) {
          if (/terminal/iu.test(String(error))) break;
          throw error;
        }
        triggers += 1;
        state = await waitForRoundOrUploadLanding(client, sessionId, before, upload.uploadedFileId);
        continue;
      }
    }

    const before = state.roundCount;
    try {
      await triggerWithDeadline(client, sessionId, { channel: ENTRY_CHANNEL, payload: payloadText });
    } catch (error) {
      if (/terminal/iu.test(String(error))) break;
      if (isTriggerInFlightTimeout(error)) {
        const latest = await safeReadState(client, sessionId, state);
        writeDriveReport({
          session_id: sessionId,
          state: latest,
          triggers,
          drivers,
          upload,
          timeout_kind: 'trigger_in_flight',
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
        process.exit(1);
      }
      throw error;
    }
    triggers += 1;
    payloadText = 'Continue to the next stage of the workflow.';
    state = await waitForRound(client, sessionId, before);
  }

  state = await readState(client, sessionId);
  writeDriveReport({ session_id: sessionId, state, triggers, drivers, upload });
  process.exit(0);
}

async function uploadFixture(client: PgasClient, sessionId: string, script: UploadScript): Promise<UploadAttempt> {
  const fixtureText = buildUploadFixtureText(script.sentinel);
  const actualBytes = new TextEncoder().encode(fixtureText).length;
  if (actualBytes !== script.expectedCharCount) {
    throw new Error(\`upload fixture byte length mismatch: expected \${String(script.expectedCharCount)} actual \${String(actualBytes)}\`);
  }
  const form = new FormData();
  form.append('files', new Blob([fixtureText], { type: 'text/plain' }), \`pgas-upload-live-drive-\${Date.now()}.txt\`);
  const uploaded = await client.files.upload(sessionId, form);
  const files = isRecord(uploaded) && Array.isArray(uploaded.files)
    ? uploaded.files.filter(isRecord)
    : [];
  const fileRef = files[0] ?? null;
  const fileId = fileRef ? stringValue(fileRef.fileId) : null;
  return {
    attempted: true,
    uploadAccepted: fileId !== null,
    uploadedFileId: fileId,
    fileRef,
  };
}

async function triggerWithDeadline(
  client: PgasClient,
  sessionId: string,
  payload: { channel: string; payload: unknown },
): Promise<void> {
  const remaining = DEADLINE - Date.now();
  if (remaining <= 0) {
    throw new Error('trigger_in_flight_timeout: deadline reached before trigger');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.sessions.trigger(sessionId, payload),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('trigger_in_flight_timeout: trigger exceeded live-drive deadline')), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isTriggerInFlightTimeout(error: unknown): boolean {
  return /trigger_in_flight_timeout/u.test(error instanceof Error ? error.message : String(error));
}

async function waitForRound(client: PgasClient, sessionId: string, before: number): Promise<DriveState> {
  let latest = await readState(client, sessionId);
  while (latest.roundCount <= before && !latest.terminal && Date.now() < DEADLINE) {
    await sleep(1_000);
    latest = await readState(client, sessionId);
  }
  return latest;
}

async function waitForRoundOrUploadLanding(
  client: PgasClient,
  sessionId: string,
  before: number,
  fileId: string | null,
): Promise<DriveState> {
  let latest = await readState(client, sessionId);
  while (latest.roundCount <= before && !latest.terminal && !refsLanded(latest.world, fileId) && Date.now() < DEADLINE) {
    await sleep(1_000);
    latest = await readState(client, sessionId);
  }
  return latest;
}

async function safeReadState(client: PgasClient, sessionId: string, fallback: DriveState): Promise<DriveState> {
  try {
    return await readState(client, sessionId);
  } catch {
    return fallback;
  }
}

async function readState(client: PgasClient, sessionId: string): Promise<DriveState> {
  const [envelope, worldResponse, roundsResponse] = await Promise.all([
    client.sessions.get(sessionId),
    client.sessions.world(sessionId),
    client.sessions.rounds(sessionId),
  ]);
  const rounds = Array.isArray(roundsResponse.rounds) ? roundsResponse.rounds : [];
  const status = typeof envelope.status === 'string' ? envelope.status : '';
  const stateRecord = envelope.state as Record<string, unknown> | undefined;
  const mode = firstString(envelope.mode, stateRecord?.mode);
  const terminalActions = rounds.flatMap((round) => terminalActionOf(round));
  return {
    mode,
    terminal: Boolean(stateRecord?.terminal ?? envelope.terminal) || status.toLowerCase() === 'completed',
    roundCount: rounds.length,
    world: worldResponse.domain as Record<string, unknown>,
    actions: terminalActions.map((action) => action.name),
    terminalActions,
  };
}

function parseUploadScript(raw: string): UploadScript {
  if (raw.trim().length === 0) {
    throw new Error('PGAS_LIVE_DRIVE_UPLOAD_SCRIPT is required for upload live drive');
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('PGAS_LIVE_DRIVE_UPLOAD_SCRIPT must be an object');
  }
  const script = {
    resultPath: stringField(parsed, 'resultPath'),
    sourceReadyPath: stringField(parsed, 'sourceReadyPath'),
    stage: stringField(parsed, 'stage'),
    sentinel: stringField(parsed, 'sentinel'),
    expectedCharCount: numberField(parsed, 'expectedCharCount'),
  };
  if (!script.resultPath || !script.sourceReadyPath || !script.stage || !script.sentinel || script.expectedCharCount <= 0) {
    throw new Error('PGAS_LIVE_DRIVE_UPLOAD_SCRIPT is missing required resultPath/sourceReadyPath/stage/sentinel/expectedCharCount');
  }
  return script;
}

function writeDriveReport(input: {
  session_id: string;
  state: DriveState;
  triggers: number;
  drivers: Parameters<typeof createPgasServer>[0]['drivers'];
  upload: UploadAttempt;
  timeout_kind?: string;
  error?: string;
}): void {
  writeReport({
    final_mode: input.state.mode,
    terminal: input.state.terminal,
    rounds: input.state.roundCount,
    triggers: input.triggers,
    actions: input.state.actions,
    terminal_actions: input.state.terminalActions,
    world: input.state.world,
    session_id: input.session_id,
    author_driver: input.drivers ? 'unified' : 'default',
    upload: uploadReportFromWorld(input.state.world, uploadScript, input.upload),
    ...(input.timeout_kind ? { timeout_kind: input.timeout_kind } : {}),
    ...(input.error ? { error: input.error } : {}),
  });
}

function uploadReportFromWorld(world: Record<string, unknown>, script: UploadScript, upload: UploadAttempt): Record<string, unknown> {
  const source = recordFromWorldPath(world, script.resultPath);
  const fullText = typeof source.full_text === 'string' ? source.full_text : '';
  return {
    source_status: stringValue(source.status),
    char_count: numberValue(source.char_count) ?? 0,
    expected_char_count: script.expectedCharCount,
    source_ready: valueAtWorldPath(world, script.sourceReadyPath) === true,
    full_text_excerpt: fullText.slice(0, 4_000),
    sentinel_present: fullText.includes(script.sentinel),
    uploaded_file_id: upload.uploadedFileId,
    refs_landed: refsLanded(world, upload.uploadedFileId),
    upload_accepted: upload.uploadAccepted,
  };
}

function refsLanded(world: Record<string, unknown>, fileId: string | null): boolean {
  if (!fileId) {
    return false;
  }
  if (valueAtWorldPath(world, 'inputs.document_intake.file_refs.0.fileId') === fileId) {
    return true;
  }
  const directRefs = valueAtWorldPath(world, 'inputs.document_intake.file_refs');
  if (Array.isArray(directRefs) && directRefs.some((ref) => isRecord(ref) && ref.fileId === fileId)) {
    return true;
  }
  const root = valueAtWorldPath(world, 'inputs.document_intake');
  return isRecord(root) &&
    Array.isArray(root.file_refs) &&
    root.file_refs.some((ref) => isRecord(ref) && ref.fileId === fileId);
}

function recordFromWorldPath(world: Record<string, unknown>, path: string): Record<string, unknown> {
  const direct = valueAtWorldPath(world, path);
  const record = isRecord(direct) ? { ...direct } : {};
  const prefix = path + '.';
  for (const [key, value] of Object.entries(world)) {
    if (!key.startsWith(prefix)) continue;
    const field = key.slice(prefix.length);
    if (field.length > 0 && !field.includes('.')) {
      record[field] = value;
    }
  }
  return record;
}

function valueAtWorldPath(world: Record<string, unknown>, path: string): unknown {
  if (Object.prototype.hasOwnProperty.call(world, path)) {
    return world[path];
  }
  let cursor: unknown = world;
  for (const part of path.split('.')) {
    if (!isRecord(cursor) || !Object.prototype.hasOwnProperty.call(cursor, part)) {
      return undefined;
    }
    cursor = cursor[part];
  }
  return cursor;
}

function buildUploadFixtureText(sentinel: string): string {
  return [
    \`PGAS upload live-drive fixture.\`,
    \`Sentinel: \${sentinel}\`,
    'This ASCII source document exists only for the upload live-drive gate.',
    'The generated program must read these exact bytes through request.documents content_text.',
  ].join('\\n');
}

function noUploadAttempt(): UploadAttempt {
  return {
    attempted: false,
    uploadAccepted: false,
    uploadedFileId: null,
    fileRef: null,
  };
}

function terminalActionOf(round: unknown): Array<{ name: string; payload_excerpt: string }> {
  if (!round || typeof round !== 'object' || Array.isArray(round)) return [];
  const result = (round as { result?: unknown }).result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
  const terminal = (result as { terminal?: unknown }).terminal;
  if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)) return [];
  const name = (terminal as { name?: unknown }).name;
  if (typeof name !== 'string' || name.length === 0) return [];
  const payload = (terminal as { payload?: unknown }).payload;
  return [{ name, payload_excerpt: JSON.stringify(payload ?? null).slice(0, 4_000) }];
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function writeReport(report: Record<string, unknown>): void {
  if (REPORT_PATH.length > 0) {
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

process.on('unhandledRejection', (reason: unknown) => {
  const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  console.error('[live-drive-runner] unhandledRejection:', msg);
  try { writeReport({ error: 'unhandledRejection: ' + msg }); } catch {}
  process.exit(1);
});
main().catch((error: unknown) => {
  const msg = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error('[live-drive-runner] CRASH:', msg);
  writeReport({ error: msg });
  process.exit(1);
});
`;
}

export function renderExportLiveDriveRunnerSource(slug: string): string {
  const pascal = toPascalCase(slug);
  return `import { writeFileSync } from 'node:fs';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import { appTransport, createPgasClient, type PgasClient } from '@simodelne/pgas-server/client.js';
import { create${pascal}ProgramEntry } from '../src/programs/${slug}/registration.js';

const REPORT_PATH = process.env.PGAS_LIVE_DRIVE_REPORT ?? '';
const ENTRY_CHANNEL = process.env.PGAS_LIVE_DRIVE_ENTRY_CHANNEL ?? 'user_text';
const INITIAL_TEXT = process.env.PGAS_LIVE_DRIVE_INITIAL_TEXT ?? 'start generated live drive';
const FINAL_STAGE = process.env.PGAS_LIVE_DRIVE_FINAL_STAGE ?? 'complete';
const MAX_TRIGGERS = Number(process.env.PGAS_LIVE_DRIVE_MAX_TRIGGERS ?? '12');
const DEADLINE = Date.now() + Number(process.env.PGAS_LIVE_DRIVE_TIMEOUT_MS ?? '540000');
const exportScript = parseExportScript(process.env.PGAS_LIVE_DRIVE_EXPORT_SCRIPT ?? '');

interface DriveState {
  mode: string | null;
  terminal: boolean;
  roundCount: number;
  world: Record<string, unknown>;
  actions: string[];
  terminalActions: Array<{ name: string; payload_excerpt: string }>;
}

interface ExportScript {
  resultPath: string;
  stage: string;
  nonce: string;
}

async function main(): Promise<void> {
  // Opt-in unified native-tools author driver: mirrors the rendered scaffold's
  // src/server.ts gating. Default (PGAS_AUTHOR_DRIVER unset) boots the engine's
  // legacy JSON author path exactly as before; the dynamic import keeps the
  // default path byte-identical even against a scaffold without the module.
  let drivers: Parameters<typeof createPgasServer>[0]['drivers'];
  if ((process.env.PGAS_AUTHOR_DRIVER ?? '').trim().toLowerCase() === 'unified') {
    const authorDriver = await import('../src/author-driver.js');
    drivers = authorDriver.resolveAuthorDrivers();
  }
  const server = await createPgasServer({
    programs: [{ name: '${slug}', entry: create${pascal}ProgramEntry() }],
    devMode: true,
    ...(drivers ? { drivers } : {}),
  });
  const client = createPgasClient(appTransport(server.app, { token: 'dev-token' }));
  const created = await client.sessions.create({
    program: '${slug}',
    domain_context: { query: INITIAL_TEXT },
  });
  const sessionId = created.sessionId;

  let payloadText = INITIAL_TEXT;
  let triggers = 0;
  let state = await readState(client, sessionId);
  while (state.mode !== FINAL_STAGE && !state.terminal && triggers < MAX_TRIGGERS && Date.now() < DEADLINE) {
    const before = state.roundCount;
    try {
      await triggerWithDeadline(client, sessionId, { channel: ENTRY_CHANNEL, payload: payloadText });
    } catch (error) {
      if (/terminal/iu.test(String(error))) break;
      if (isTriggerInFlightTimeout(error)) {
        const latest = await safeReadState(client, sessionId, state);
        writeDriveReport({
          session_id: sessionId,
          state: latest,
          triggers,
          drivers,
          timeout_kind: 'trigger_in_flight',
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
        process.exit(1);
      }
      throw error;
    }
    triggers += 1;
    payloadText = 'Continue to the next stage of the workflow.';
    state = await waitForRound(client, sessionId, before);
  }

  state = await readState(client, sessionId);
  const exportReport = await exportReportFromArtifacts(client, sessionId, exportScript);
  writeDriveReport({ session_id: sessionId, state, triggers, drivers, exportReport });
  process.exit(0);
}

async function triggerWithDeadline(
  client: PgasClient,
  sessionId: string,
  payload: { channel: string; payload: unknown },
): Promise<void> {
  const remaining = DEADLINE - Date.now();
  if (remaining <= 0) {
    throw new Error('trigger_in_flight_timeout: deadline reached before trigger');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.sessions.trigger(sessionId, payload),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('trigger_in_flight_timeout: trigger exceeded live-drive deadline')), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isTriggerInFlightTimeout(error: unknown): boolean {
  return /trigger_in_flight_timeout/u.test(error instanceof Error ? error.message : String(error));
}

async function waitForRound(client: PgasClient, sessionId: string, before: number): Promise<DriveState> {
  let latest = await readState(client, sessionId);
  while (latest.roundCount <= before && !latest.terminal && Date.now() < DEADLINE) {
    await sleep(1_000);
    latest = await readState(client, sessionId);
  }
  return latest;
}

async function safeReadState(client: PgasClient, sessionId: string, fallback: DriveState): Promise<DriveState> {
  try {
    return await readState(client, sessionId);
  } catch {
    return fallback;
  }
}

async function readState(client: PgasClient, sessionId: string): Promise<DriveState> {
  const [envelope, worldResponse, roundsResponse] = await Promise.all([
    client.sessions.get(sessionId),
    client.sessions.world(sessionId),
    client.sessions.rounds(sessionId),
  ]);
  const rounds = Array.isArray(roundsResponse.rounds) ? roundsResponse.rounds : [];
  const status = typeof envelope.status === 'string' ? envelope.status : '';
  const stateRecord = envelope.state as Record<string, unknown> | undefined;
  const mode = firstString(envelope.mode, stateRecord?.mode);
  const terminalActions = rounds.flatMap((round) => terminalActionOf(round));
  return {
    mode,
    terminal: Boolean(stateRecord?.terminal ?? envelope.terminal) || status.toLowerCase() === 'completed',
    roundCount: rounds.length,
    world: worldResponse.domain as Record<string, unknown>,
    actions: terminalActions.map((action) => action.name),
    terminalActions,
  };
}

function parseExportScript(raw: string): ExportScript {
  if (raw.trim().length === 0) {
    throw new Error('PGAS_LIVE_DRIVE_EXPORT_SCRIPT is required for export live drive');
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('PGAS_LIVE_DRIVE_EXPORT_SCRIPT must be an object');
  }
  const script = {
    resultPath: stringField(parsed, 'resultPath'),
    stage: stringField(parsed, 'stage'),
    nonce: stringField(parsed, 'nonce'),
  };
  if (!script.resultPath || !script.stage || !script.nonce) {
    throw new Error('PGAS_LIVE_DRIVE_EXPORT_SCRIPT is missing required resultPath/stage/nonce');
  }
  return script;
}

async function exportReportFromArtifacts(
  client: PgasClient,
  sessionId: string,
  script: ExportScript,
): Promise<Record<string, unknown>> {
  let artifactsRaw: unknown = [];
  let artifact_error: string | undefined;
  try {
    artifactsRaw = await client.sessions.systemArtifacts({ program: '${slug}', artifactType: 'docx_export' });
  } catch (error) {
    artifact_error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  }
  const artifact_records = artifactRecords(artifactsRaw);
  const artifact_record = artifact_records.find((record) =>
    record.artifactType === 'docx_export' && record.payloadRef === script.resultPath) ?? null;

  const worldResponse = await client.sessions.world(sessionId);
  const world = isRecord(worldResponse.domain) ? worldResponse.domain : {};
  const payloadRef = typeof artifact_record?.payloadRef === 'string' ? artifact_record.payloadRef : script.resultPath;
  const payload = recordFromWorldPath(world, payloadRef);
  const result = resultFromPayload(payload);
  const docx_base64 = typeof result.docx_base64 === 'string' && result.docx_base64.length > 0
    ? result.docx_base64
    : null;
  const bytes = docx_base64 ? Buffer.from(docx_base64, 'base64') : Buffer.alloc(0);
  const documentXml = docx_base64 ? extractStoreZipEntryText(bytes, 'word/document.xml') : null;

  return {
    artifact_records,
    artifact_record,
    payload_ref: payloadRef,
    docx_base64,
    docx_bytes: bytes.length,
    nonce_present: documentXml !== null && documentXml.includes(script.nonce),
    default_absent: documentXml !== null && !documentXml.includes('Client authorized signatory'),
    zip_store_ooxml: documentXml !== null,
    extracted_text_sample: documentXml?.slice(0, 4_000) ?? '',
    ...(artifact_error ? { artifact_error } : {}),
  };
}

function artifactRecords(raw: unknown): Array<Record<string, unknown>> {
  const container = isRecord(raw) && Array.isArray(raw.artifacts) ? raw.artifacts : Array.isArray(raw) ? raw : [];
  return container.filter(isRecord);
}

function resultFromPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const resultJson = typeof payload.result_json === 'string' ? parseJsonValue(payload.result_json) : undefined;
  if (isRecord(resultJson)) {
    return { ...payload, ...resultJson };
  }
  return payload;
}

function recordFromWorldPath(world: Record<string, unknown>, path: string): Record<string, unknown> {
  const direct = valueAtWorldPath(world, path);
  const record = isRecord(direct) ? { ...direct } : {};
  const prefix = path + '.';
  for (const [key, value] of Object.entries(world)) {
    if (!key.startsWith(prefix)) continue;
    const field = key.slice(prefix.length);
    if (field.length > 0 && !field.includes('.')) {
      record[field] = value;
    }
  }
  return record;
}

function valueAtWorldPath(world: Record<string, unknown>, path: string): unknown {
  if (Object.prototype.hasOwnProperty.call(world, path)) {
    return world[path];
  }
  let cursor: unknown = world;
  for (const part of path.split('.')) {
    if (!isRecord(cursor) || !Object.prototype.hasOwnProperty.call(cursor, part)) {
      return undefined;
    }
    cursor = cursor[part];
  }
  return cursor;
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function extractStoreZipEntryText(bytes: Uint8Array, entryName: string): string | null {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) {
    return null;
  }

  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature === 0x02014b50 || signature === 0x06054b50) {
      break;
    }
    if (signature !== 0x04034b50 || offset + 30 > buffer.length) {
      return null;
    }
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    if (method !== 0 || compressedSize !== uncompressedSize) {
      return null;
    }
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (nameStart + nameLength > buffer.length || dataEnd > buffer.length) {
      return null;
    }
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    entries.set(name, buffer.subarray(dataStart, dataEnd));
    offset = dataEnd;
  }

  const contentTypes = entries.get('[Content_Types].xml')?.toString('utf8') ?? '';
  if (!contentTypes.includes('wordprocessingml.document.main+xml')) {
    return null;
  }
  return entries.get(entryName)?.toString('utf8') ?? null;
}

function writeDriveReport(input: {
  session_id: string;
  state: DriveState;
  triggers: number;
  drivers: Parameters<typeof createPgasServer>[0]['drivers'];
  exportReport?: Record<string, unknown>;
  timeout_kind?: string;
  error?: string;
}): void {
  const report = {
    final_mode: input.state.mode,
    terminal: input.state.terminal,
    rounds: input.state.roundCount,
    triggers: input.triggers,
    actions: input.state.actions,
    terminal_actions: input.state.terminalActions,
    world: input.state.world,
    session_id: input.session_id,
    author_driver: input.drivers ? 'unified' : 'default',
    export: input.exportReport ?? null,
    ...(input.timeout_kind ? { timeout_kind: input.timeout_kind } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
  writeReport(report);
  process.stdout.write(JSON.stringify({ export: report.export }) + '\\n');
}

function terminalActionOf(round: unknown): Array<{ name: string; payload_excerpt: string }> {
  if (!round || typeof round !== 'object' || Array.isArray(round)) return [];
  const result = (round as { result?: unknown }).result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
  const terminal = (result as { terminal?: unknown }).terminal;
  if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)) return [];
  const name = (terminal as { name?: unknown }).name;
  if (typeof name !== 'string' || name.length === 0) return [];
  const payload = (terminal as { payload?: unknown }).payload;
  return [{ name, payload_excerpt: JSON.stringify(payload ?? null).slice(0, 4_000) }];
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function writeReport(report: Record<string, unknown>): void {
  if (REPORT_PATH.length > 0) {
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

process.on('unhandledRejection', (reason: unknown) => {
  const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  console.error('[live-drive-runner] unhandledRejection:', msg);
  try { writeReport({ error: 'unhandledRejection: ' + msg }); } catch {}
  process.exit(1);
});
main().catch((error: unknown) => {
  const msg = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error('[live-drive-runner] CRASH:', msg);
  writeReport({ error: msg });
  process.exit(1);
});
`;
}

function renderConfirmationLiveDriveRunnerSource(slug: string): string {
  const pascal = toPascalCase(slug);
  return `import { writeFileSync } from 'node:fs';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import { appTransport, createPgasClient, type PgasClient } from '@simodelne/pgas-server/client.js';
import { create${pascal}ProgramEntry } from '../src/programs/${slug}/registration.js';

const REPORT_PATH = process.env.PGAS_LIVE_DRIVE_REPORT ?? '';
const ENTRY_CHANNEL = process.env.PGAS_LIVE_DRIVE_ENTRY_CHANNEL ?? 'user_text';
const INITIAL_TEXT = process.env.PGAS_LIVE_DRIVE_INITIAL_TEXT ?? 'start generated live drive';
const FINAL_STAGE = process.env.PGAS_LIVE_DRIVE_FINAL_STAGE ?? 'complete';
const MAX_TRIGGERS = Number(process.env.PGAS_LIVE_DRIVE_MAX_TRIGGERS ?? '12');
const DEADLINE = Date.now() + Number(process.env.PGAS_LIVE_DRIVE_TIMEOUT_MS ?? '540000');
const confirmationScript = parseConfirmationScript(process.env.PGAS_LIVE_DRIVE_CONFIRMATION_SCRIPT ?? '');

interface DriveState {
  mode: string | null;
  terminal: boolean;
  roundCount: number;
  world: Record<string, unknown>;
  actions: string[];
  terminalActions: Array<{ name: string; payload_excerpt: string }>;
}

interface ConfirmationScript {
  channel: string;
  itemsPath: string;
  statusField: string;
  proposedStatus: string;
  fallbackDecision: string;
  decisions: Array<{ decision: string; instruction?: string }>;
  decisionTable: Record<string, string>;
  terminalStatuses: string[];
}

interface StatusHistoryItem {
  index: number;
  id?: string;
  title?: string;
  status: string | null;
}

interface StatusHistoryEntry {
  round: number;
  items: StatusHistoryItem[];
  decision?: { index: number; decision: string; instruction?: string };
}

async function main(): Promise<void> {
  // Opt-in unified native-tools author driver: mirrors the rendered scaffold's
  // src/server.ts gating. Default (PGAS_AUTHOR_DRIVER unset) boots the engine's
  // legacy JSON author path exactly as before; the dynamic import keeps the
  // default path byte-identical even against a scaffold without the module.
  let drivers: Parameters<typeof createPgasServer>[0]['drivers'];
  if ((process.env.PGAS_AUTHOR_DRIVER ?? '').trim().toLowerCase() === 'unified') {
    const authorDriver = await import('../src/author-driver.js');
    drivers = authorDriver.resolveAuthorDrivers();
  }
  const server = await createPgasServer({
    programs: [{ name: '${slug}', entry: create${pascal}ProgramEntry() }],
    devMode: true,
    ...(drivers ? { drivers } : {}),
  });
  const client = createPgasClient(appTransport(server.app, { token: 'dev-token' }));
  const created = await client.sessions.create({
    program: '${slug}',
    domain_context: { query: INITIAL_TEXT },
  });
  const sessionId = created.sessionId;

  const statusHistory: StatusHistoryEntry[] = [];
  let payloadText = INITIAL_TEXT;
  let triggers = 0;
  let scriptIndex = 0;
  let state = await readState(client, sessionId);
  recordStatusSnapshot(statusHistory, state, confirmationScript);
  while (state.mode !== FINAL_STAGE && !state.terminal && triggers < MAX_TRIGGERS && Date.now() < DEADLINE) {
    const proposed = findProposedItem(state.world, confirmationScript);
    if (proposed) {
      const fallbackDecision = { decision: confirmationScript.fallbackDecision };
      const decision = scriptIndex < confirmationScript.decisions.length
        ? confirmationScript.decisions[scriptIndex] as { decision: string; instruction?: string }
        : fallbackDecision;
      if (scriptIndex < confirmationScript.decisions.length) scriptIndex += 1;
      const before = state.roundCount;
      const payload = buildConfirmationPayload(confirmationScript, proposed, decision);
      try {
        await client.sessions.trigger(sessionId, { channel: confirmationScript.channel, payload });
      } catch (error) {
        if (/terminal/iu.test(String(error))) break;
        throw error;
      }
      triggers += 1;
      state = await waitForRound(client, sessionId, before);
      const recordedDecision = canonicalConfirmationDecision(decision.decision);
      recordStatusSnapshot(statusHistory, state, confirmationScript, {
        index: proposed.index,
        decision: recordedDecision,
        ...(decision.instruction ? { instruction: decision.instruction } : {}),
      });
      continue;
    }

    const before = state.roundCount;
    try {
      await client.sessions.trigger(sessionId, { channel: ENTRY_CHANNEL, payload: payloadText });
    } catch (error) {
      if (/terminal/iu.test(String(error))) break;
      throw error;
    }
    triggers += 1;
    payloadText = 'Continue to the next stage of the workflow.';
    state = await waitForRound(client, sessionId, before);
    recordStatusSnapshot(statusHistory, state, confirmationScript);
  }

  state = await readState(client, sessionId);
  recordStatusSnapshot(statusHistory, state, confirmationScript);
  writeReport({
    final_mode: state.mode,
    terminal: state.terminal,
    rounds: state.roundCount,
    triggers,
    actions: state.actions,
    terminal_actions: state.terminalActions,
    world: state.world,
    author_driver: drivers ? 'unified' : 'default',
    status_history: statusHistory,
  });
  process.exit(0);
}

async function waitForRound(client: PgasClient, sessionId: string, before: number): Promise<DriveState> {
  let latest = await readState(client, sessionId);
  while (latest.roundCount <= before && !latest.terminal && Date.now() < DEADLINE) {
    await sleep(1_000);
    latest = await readState(client, sessionId);
  }
  return latest;
}

async function readState(client: PgasClient, sessionId: string): Promise<DriveState> {
  const [envelope, worldResponse, roundsResponse] = await Promise.all([
    client.sessions.get(sessionId),
    client.sessions.world(sessionId),
    client.sessions.rounds(sessionId),
  ]);
  const rounds = Array.isArray(roundsResponse.rounds) ? roundsResponse.rounds : [];
  const status = typeof envelope.status === 'string' ? envelope.status : '';
  const stateRecord = envelope.state as Record<string, unknown> | undefined;
  const mode = firstString(envelope.mode, stateRecord?.mode);
  const terminalActions = rounds.flatMap((round) => terminalActionOf(round));
  return {
    mode,
    terminal: Boolean(stateRecord?.terminal ?? envelope.terminal) || status.toLowerCase() === 'completed',
    roundCount: rounds.length,
    world: worldResponse.domain as Record<string, unknown>,
    actions: terminalActions.map((action) => action.name),
    terminalActions,
  };
}

function parseConfirmationScript(raw: string): ConfirmationScript {
  if (raw.trim().length === 0) {
    throw new Error('PGAS_LIVE_DRIVE_CONFIRMATION_SCRIPT is required for confirmation live drive');
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('PGAS_LIVE_DRIVE_CONFIRMATION_SCRIPT must be an object');
  }
  const decisions = Array.isArray(parsed.decisions)
    ? parsed.decisions.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.decision !== 'string' || entry.decision.length === 0) return [];
        return [{
          decision: entry.decision,
          ...(typeof entry.instruction === 'string' && entry.instruction.length > 0 ? { instruction: entry.instruction } : {}),
        }];
      })
    : [];
  const decisionTable = isRecord(parsed.decisionTable)
    ? Object.fromEntries(Object.entries(parsed.decisionTable).flatMap(([decision, status]) =>
        typeof status === 'string' ? [[decision, status]] : []))
    : {};
  const terminalStatuses = Array.isArray(parsed.terminalStatuses)
    ? parsed.terminalStatuses.filter((status): status is string => typeof status === 'string' && status.length > 0)
    : [];
  const script = {
    channel: stringField(parsed, 'channel'),
    itemsPath: stringField(parsed, 'itemsPath'),
    statusField: stringField(parsed, 'statusField'),
    proposedStatus: stringField(parsed, 'proposedStatus'),
    fallbackDecision: typeof parsed.fallbackDecision === 'string' && parsed.fallbackDecision.length > 0
      ? parsed.fallbackDecision
      : 'approve',
    decisions,
    decisionTable,
    terminalStatuses,
  };
  if (!script.channel || !script.itemsPath || !script.statusField || !script.proposedStatus) {
    throw new Error('PGAS_LIVE_DRIVE_CONFIRMATION_SCRIPT is missing required channel/itemsPath/statusField/proposedStatus');
  }
  return script;
}

function recordStatusSnapshot(
  history: StatusHistoryEntry[],
  state: DriveState,
  script: ConfirmationScript,
  decision?: StatusHistoryEntry['decision'],
): void {
  if (!decision && history[history.length - 1]?.round === state.roundCount) {
    return;
  }
  history.push({
    round: state.roundCount,
    items: statusItemsFromWorld(state.world, script),
    ...(decision ? { decision } : {}),
  });
}

function findProposedItem(world: Record<string, unknown>, script: ConfirmationScript): StatusHistoryItem | null {
  return statusItemsFromWorld(world, script).find((item) => item.status === script.proposedStatus) ?? null;
}

function statusItemsFromWorld(world: Record<string, unknown>, script: ConfirmationScript): StatusHistoryItem[] {
  const itemsByIndex = new Map<number, StatusHistoryItem>();
  const arrayValue = world[script.itemsPath];
  if (Array.isArray(arrayValue)) {
    arrayValue.forEach((item, index) => {
      if (!isRecord(item)) return;
      itemsByIndex.set(index, {
        index,
        ...optionalStringValue('id', firstString(item.id, item.item_id)),
        ...optionalStringValue('title', firstString(item.title, item.name)),
        status: typeof item[script.statusField] === 'string' ? item[script.statusField] : null,
      });
    });
  }

  const prefix = script.itemsPath + '.';
  for (const [path, value] of Object.entries(world)) {
    if (!path.startsWith(prefix)) continue;
    const match = path.slice(prefix.length).match(/^(\\d+)\\.([^.]*)$/u);
    if (!match) continue;
    const index = Number(match[1]);
    const field = match[2] as string;
    const current = itemsByIndex.get(index) ?? { index, status: null };
    if (field === script.statusField) {
      current.status = typeof value === 'string' ? value : null;
    } else if ((field === 'id' || field === 'item_id') && typeof value === 'string') {
      current.id = value;
    } else if ((field === 'title' || field === 'name') && typeof value === 'string') {
      current.title = value;
    }
    itemsByIndex.set(index, current);
  }

  return [...itemsByIndex.values()].sort((left, right) => left.index - right.index);
}

function buildConfirmationPayload(
  script: ConfirmationScript,
  target: StatusHistoryItem,
  decision: { decision: string; instruction?: string },
): Record<string, unknown> {
  void script;
  void target;
  const canonicalDecision = canonicalConfirmationDecision(decision.decision);
  const instruction = decision.instruction ?? '';
  return { decision: canonicalDecision, ...(instruction.length > 0 ? { instruction } : {}) };
}

function canonicalConfirmationDecision(decision: string): string {
  if (decision === 'revise') return 'request_revision';
  if (decision === 'skip') return 'reject';
  return decision;
}

function terminalActionOf(round: unknown): Array<{ name: string; payload_excerpt: string }> {
  if (!round || typeof round !== 'object' || Array.isArray(round)) return [];
  const result = (round as { result?: unknown }).result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
  const terminal = (result as { terminal?: unknown }).terminal;
  if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)) return [];
  const name = (terminal as { name?: unknown }).name;
  if (typeof name !== 'string' || name.length === 0) return [];
  const payload = (terminal as { payload?: unknown }).payload;
  return [{ name, payload_excerpt: JSON.stringify(payload ?? null).slice(0, 4_000) }];
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function optionalStringValue(key: 'id' | 'title', value: string | null): { id?: string; title?: string } {
  return value ? { [key]: value } : {};
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function writeReport(report: Record<string, unknown>): void {
  if (REPORT_PATH.length > 0) {
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

process.on('unhandledRejection', (reason: unknown) => {
  const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  console.error('[live-drive-runner] unhandledRejection:', msg);
  try { writeReport({ error: 'unhandledRejection: ' + msg }); } catch {}
  process.exit(1);
});
main().catch((error: unknown) => {
  const msg = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error('[live-drive-runner] CRASH:', msg);
  writeReport({ error: msg });
  process.exit(1);
});
`;
}

interface RunnerOutcome {
  exitCode: number | null;
  output: string;
}

function runNodeScript(
  scriptPath: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<RunnerOutcome> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ['--import', 'tsx', scriptPath], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const record = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      if (output.length > 100_000) {
        output = output.slice(-100_000);
      }
    };
    child.stdout.on('data', record);
    child.stderr.on('data', record);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, options.timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code, output });
    });
  });
}

interface DriveReport {
  session_id?: unknown;
  final_mode?: unknown;
  terminal?: unknown;
  rounds?: unknown;
  triggers?: unknown;
  actions?: unknown[];
  terminal_actions?: unknown;
  world?: unknown;
  author_driver?: unknown;
  status_history?: unknown;
  delegation?: unknown;
  upload?: unknown;
  export?: unknown;
  extraction?: unknown;
  timeout_kind?: unknown;
  error?: unknown;
}

function readDriveReport(reportPath: string): (DriveReport & { world?: Record<string, unknown> }) | undefined {
  try {
    const parsed = JSON.parse(readFileSync(reportPath, 'utf8')) as unknown;
    return isRecord(parsed) ? (parsed as DriveReport & { world?: Record<string, unknown> }) : undefined;
  } catch {
    return undefined;
  }
}

function parseTerminalActions(value: unknown): DriveTerminalAction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.name !== 'string') return [];
    return [{
      name: entry.name,
      payload_excerpt: typeof entry.payload_excerpt === 'string' ? entry.payload_excerpt : '',
    }];
  });
}

function parseStatusHistory(value: unknown): GeneratedLiveDriveStatusHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.round !== 'number' || !Array.isArray(entry.items)) {
      return [];
    }
    const items = entry.items.flatMap((item) => {
      if (!isRecord(item) || typeof item.index !== 'number') return [];
      return [{
        index: item.index,
        ...(typeof item.id === 'string' ? { id: item.id } : {}),
        ...(typeof item.title === 'string' ? { title: item.title } : {}),
        status: typeof item.status === 'string' ? item.status : null,
      }];
    });
    const decision = isRecord(entry.decision) &&
      typeof entry.decision.index === 'number' &&
      typeof entry.decision.decision === 'string'
      ? {
          index: entry.decision.index,
          decision: entry.decision.decision,
          ...(typeof entry.decision.instruction === 'string' ? { instruction: entry.decision.instruction } : {}),
        }
      : undefined;
    return [{
      round: entry.round,
      items,
      ...(decision ? { decision } : {}),
    }];
  });
}

function parseDelegationReport(value: unknown): GeneratedLiveDriveDelegationReport | null {
  if (!isRecord(value)) return null;
  return {
    child_program: stringOrEmpty(value.child_program),
    result_status: nullableString(value.result_status),
    child_session_id: nullableString(value.child_session_id),
    child_rounds: numberOrZero(value.child_rounds),
    optional: value.optional === true,
    settled: value.settled === true,
    degraded: value.degraded === true,
    degrade_reason: stringOrEmpty(value.degrade_reason),
    exported_fields: isRecord(value.exported_fields) ? value.exported_fields : {},
  };
}

function parseUploadReport(value: unknown): GeneratedLiveDriveUploadReport | null {
  if (!isRecord(value)) return null;
  return {
    source_status: nullableString(value.source_status),
    char_count: numberOrZero(value.char_count),
    expected_char_count: numberOrZero(value.expected_char_count),
    source_ready: value.source_ready === true,
    full_text_excerpt: stringOrEmpty(value.full_text_excerpt),
    sentinel_present: value.sentinel_present === true,
    uploaded_file_id: nullableString(value.uploaded_file_id),
    refs_landed: value.refs_landed === true,
    upload_accepted: value.upload_accepted === true,
  };
}

function parseExtractionReport(value: unknown): GeneratedLiveDriveExtractionReport | null {
  if (!isRecord(value)) return null;
  return {
    source_status: nullableString(value.source_status),
    char_count: numberOrZero(value.char_count),
    expected_char_count: numberOrZero(value.expected_char_count),
    source_ready: value.source_ready === true,
    full_text_excerpt: stringOrEmpty(value.full_text_excerpt),
    sentinel_present: value.sentinel_present === true,
    uploaded_file_id: nullableString(value.uploaded_file_id),
    refs_landed: value.refs_landed === true,
    upload_accepted: value.upload_accepted === true,
    extraction_kind: nullableString(value.extraction_kind),
    sentinel_not_in_raw_upload: value.sentinel_not_in_raw_upload === true,
  };
}

function parseExportReport(value: unknown): GeneratedLiveDriveExportReport | null {
  if (!isRecord(value)) return null;
  const artifactRecords = parseExportArtifactRecords(value.artifact_records);
  const artifactRecord = parseExportArtifactRecord(value.artifact_record);
  return {
    artifact_records: artifactRecords,
    artifact_record: artifactRecord,
    payload_ref: nullableString(value.payload_ref),
    docx_base64: nullableString(value.docx_base64),
    docx_bytes: numberOrZero(value.docx_bytes),
    nonce_present: value.nonce_present === true,
    default_absent: value.default_absent === true,
    zip_store_ooxml: value.zip_store_ooxml === true,
    extracted_text_sample: stringOrEmpty(value.extracted_text_sample),
  };
}

function parseExportArtifactRecords(value: unknown): GeneratedLiveDriveExportArtifactRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = parseExportArtifactRecord(entry);
    return record ? [record] : [];
  });
}

function parseExportArtifactRecord(value: unknown): GeneratedLiveDriveExportArtifactRecord | null {
  if (!isRecord(value) || typeof value.artifactType !== 'string' || typeof value.payloadRef !== 'string') {
    return null;
  }
  return {
    ...value,
    artifactType: value.artifactType,
    payloadRef: value.payloadRef,
    ...(typeof value.artifactId === 'string' ? { artifactId: value.artifactId } : {}),
    ...(typeof value.sourceSessionId === 'string' ? { sourceSessionId: value.sourceSessionId } : {}),
  };
}

function noConfirmationScriptChoreography(providerHits: number): GeneratedLiveDriveChoreographyVerdict {
  return {
    decision_table_respected: true,
    one_proposed_invariant_held: true,
    proposed_overlap_max: 0,
    items_seen_max: 0,
    decisions_applied: 0,
    terminal_items_final: 0,
    loop_engaged: true,
    provider_hits_ok: providerHits >= 1,
    notes: providerHits >= 1 ? ['confirmation_script_absent'] : ['confirmation_script_absent', 'provider_hits_below_minimum'],
  };
}

function noDelegationScriptVerdict(providerHits: number): GeneratedLiveDriveDelegationVerdict {
  return {
    delegation_engaged: false,
    result_complete: false,
    child_session_distinct: false,
    child_rounds_ok: false,
    settled: false,
    parent_complete: false,
    provider_hits_ok: providerHits >= 1,
    no_stub_markers: true,
    notes: providerHits >= 1 ? ['delegation_script_absent'] : ['delegation_script_absent', 'provider_hits_below_minimum'],
  };
}

function noUploadScriptVerdict(providerHits: number): GeneratedLiveDriveUploadVerdict {
  return {
    upload_engaged: false,
    upload_accepted: false,
    refs_landed: false,
    content_extracted: false,
    sentinel_present: false,
    extraction_exact: false,
    source_ready: false,
    parent_complete: false,
    provider_hits_ok: providerHits >= 1,
    no_stub_markers: true,
    notes: providerHits >= 1 ? ['upload_script_absent'] : ['upload_script_absent', 'provider_hits_below_minimum'],
  };
}

function noExtractionScriptVerdict(providerHits: number): GeneratedLiveDriveExtractionVerdict {
  return {
    extraction_engaged: false,
    upload_accepted: false,
    refs_landed: false,
    content_extracted: false,
    sentinel_present: false,
    extraction_exact: false,
    source_ready: false,
    parent_complete: false,
    provider_hits_ok: providerHits >= 1,
    no_stub_markers: true,
    extraction_kind_docx_deflate: false,
    sentinel_not_in_raw_upload: false,
    reason: 'extraction_script_absent',
    notes: providerHits >= 1 ? ['extraction_script_absent'] : ['extraction_script_absent', 'provider_hits_below_minimum'],
  };
}

function noExportScriptVerdict(): GeneratedLiveDriveExportVerdict {
  return {
    export_engaged: false,
    artifact_record_harvested: false,
    payload_decoded: false,
    nonce_present: false,
    default_absent: false,
    zip_store_ooxml: false,
    reason: 'export_script_absent',
    notes: ['export_script_absent'],
  };
}

function generatedStageOutputStubFindings(world: Record<string, unknown>): string[] {
  const findings: string[] = [];
  for (const [key, value] of Object.entries(world)) {
    if (!/\.(result_json|items_json|output)($|\.)/u.test(key) && !/\.result($|\.)/u.test(key)) {
      continue;
    }
    for (const finding of findExecutedPathStubMarkers(value)) {
      findings.push(`${key}${finding.path}: ${finding.marker}`);
    }
  }
  return findings;
}

interface ParsedStoreOoxmlDocument {
  documentXml: string;
}

function isStrictBase64(value: string): boolean {
  return value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value) &&
    Buffer.from(value, 'base64').toString('base64') === value;
}

function parseStoreOoxmlDocument(bytes: Uint8Array): ParsedStoreOoxmlDocument | null {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) {
    return null;
  }

  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature === 0x02014b50 || signature === 0x06054b50) {
      break;
    }
    if (signature !== 0x04034b50 || offset + 30 > buffer.length) {
      return null;
    }

    const compressionMethod = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    if (compressionMethod !== 0 || compressedSize !== uncompressedSize) {
      return null;
    }

    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (nameStart + nameLength > buffer.length || dataEnd > buffer.length) {
      return null;
    }

    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    entries.set(name, buffer.subarray(dataStart, dataEnd));
    offset = dataEnd;
  }

  const contentTypes = entries.get('[Content_Types].xml')?.toString('utf8') ?? '';
  const documentXml = entries.get('word/document.xml')?.toString('utf8');
  if (!documentXml || !contentTypes.includes('wordprocessingml.document.main+xml')) {
    return null;
  }
  return { documentXml };
}

function descriptorStatusField(descriptor: ConfirmationLoopDescriptorForScript): string | undefined {
  const record = descriptor as Record<string, unknown>;
  const direct = record.status_field;
  if (typeof direct === 'string' && direct.length > 0) {
    return direct;
  }
  const item = record.item;
  if (isRecord(item) && typeof item.status_field === 'string' && item.status_field.length > 0) {
    return item.status_field;
  }
  return undefined;
}

function toPascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join('');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberOrZero(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
