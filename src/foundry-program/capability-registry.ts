// pgas-new #166 — foundry capability registry + honest refusal (uplift PR-1).
//
// The live 2026-07-14 Codex-driven session for the SimoneOS `contract-revision`
// program exposed the failure this module exists to stop: asked to synthesize a
// program requiring per-clause approval loops, child-session delegation, document
// upload, a rich frontend, and DOCX track-changes, the foundry SILENTLY ran its
// standard linear 6-question → linear-synthesis flow and would have emitted an
// inadequate scaffold. Per the #166 mandate + the no-bullshit reporting rule, the
// foundry must instead DECLARE what it can synthesize and REFUSE (safe-stop) when
// a required capability is beyond its current envelope — never fake a green scaffold.
//
// The engine primitives for these capabilities are already public on the pinned
// @simodelne/pgas-server (3.18.0): per-item decision targeting, confirmation
// pairing, delegation with degrade, and POST /sessions/:id/files upload. The gap
// is FOUNDRY SYNTHESIS, not engine surface. As the uplift's PR-sized increments
// land (PR-2 collection-v2, PR-3 confirmation loops, PR-5 delegation, PR-7 ingest,
// PR-9 frontend, …), each capability's `status` here flips from `refuses` to
// `synthesizes`. Until then, demanding one is a hard, honest stop.

export type CapabilityStatus = 'synthesizes' | 'scaffolds_with_gap' | 'refuses';

export interface CapabilityEntry {
  /** stable capability id */
  readonly capability: string;
  /** what the foundry can do with this surface today */
  readonly status: CapabilityStatus;
  /** why it's at this status (foundry-side evidence) */
  readonly evidence: string;
  /** pgas-new version at which the current status became true */
  readonly since_version: string;
  /** for scaffolds_with_gap / refuses: what synthesis is missing + the uplift PR that adds it */
  readonly gap_note?: string;
}

// Versioned self-assessment. Ordered roughly by the uplift plan. Keep entries in
// lockstep with docs/… and the FOUNDRY_UPLIFT increments; a status only becomes
// `synthesizes` when a generated program's choreography is proven by the live-drive
// hard gate (not mock-green).
export const FOUNDRY_CAPABILITY_REGISTRY: readonly CapabilityEntry[] = [
  {
    capability: 'linear_stage_chain',
    status: 'synthesizes',
    evidence: 'core deterministic synthesizer emits a linear mode/stage chain with transitions + guards.',
    since_version: '3.0.0',
  },
  {
    capability: 'stage_archetypes',
    status: 'synthesizes',
    evidence: 'stage-classifier emits pure-compute / llm-reasoning / external-adapter stage bodies.',
    since_version: '3.10.0',
  },
  {
    capability: 'collection_lifecycle_aggregate',
    status: 'synthesizes',
    evidence: 'collection_lifecycle synthesis emits per-status transitions + an all-terminal aggregate gate (Gap 2).',
    since_version: '3.13.0',
  },
  {
    capability: 'per_item_confirmation',
    status: 'synthesizes',
    evidence: 'confirmation_loop descriptors synthesize a seeded indexed_array collection (from an upstream llm-reasoning stage), decision_targeting + confirmation_pairing, and AfterIngestion reaction-owned per-item status enforcement (approve/request_revision/reject → accepted/proposed/skipped, one-proposed-at-a-time demotion, aggregate flip). PROVEN end-to-end by the choreography live-drive hard gate against a real provider (qwen36-27b): the generated program booted on createPgasServer, planned + proposed items, applied scripted decisions through the real route, and reached complete — provider_hits=7, decisions_applied=3, proposed_overlap_max=1, loop_engaged=true, both items accepted, all_terminal=true. The verdict is fail-closed (PR-5b), so a stall cannot read green; this is live-proven, not mock.',
    since_version: '3.23.0',
  },
  {
    capability: 'delegation_child_session',
    status: 'refuses',
    evidence: 'no synthesis of child-session delegation wiring (spawn / payload_map / result routing / degrade).',
    since_version: '3.22.0',
    gap_note: 'uplift PR-5 (delegation emission). Engine target_spec / max_delegated_rounds / optional-degrade are public on 3.18.0.',
  },
  {
    capability: 'delegation_research_agent',
    status: 'refuses',
    evidence: 'no synthesis of a research-agent child pattern (fan-out with caps, timeout→degrade).',
    since_version: '3.22.0',
    gap_note: 'uplift PR-6 (research-agent child synthesis), gated on the default-delegation-resolution spike.',
  },
  {
    capability: 'document_upload_intake',
    status: 'refuses',
    evidence: 'no synthesis of an upload/ingest channel or extraction artifact model.',
    since_version: '3.22.0',
    gap_note: 'uplift PR-7 (document ingest). Engine POST /sessions/:id/files + FileStore + request_file_upload are public on 3.18.0.',
  },
  {
    capability: 'rich_frontend',
    status: 'refuses',
    evidence: 'only basic widget projection is emitted; no editable-view / approval-widget / alternatives / progress frontend spec.',
    since_version: '3.22.0',
    gap_note: 'uplift PR-9 (frontend synthesis, existing-repo/simoneos targets); maps to the SimoneOS widget catalog.',
  },
  {
    capability: 'export_html',
    status: 'refuses',
    evidence: 'no synthesis of an HTML export/render artifact path.',
    since_version: '3.22.0',
    gap_note: 'uplift PR-10 (export boundaries).',
  },
  {
    capability: 'export_docx_plain',
    status: 'refuses',
    evidence: 'no synthesis wiring into a DOCX export path.',
    since_version: '3.22.0',
    gap_note: 'uplift PR-10 (export boundaries); integrates the SimoneOS host export code — declare-and-require-host, not portable synthesis.',
  },
  {
    capability: 'export_docx_trackchange',
    status: 'refuses',
    evidence: 'native OOXML track changes (w:ins/w:del) are not implemented anywhere on the platform.',
    since_version: '3.22.0',
    gap_note: 'BLOCKED at platform level (simoneos#1738: current "track changes" is a [Deleted] text-marker simulation). Declare + host-required; not synthesizable until the host implements native revisions.',
  },
  {
    capability: 'loop_reset',
    status: 'refuses',
    evidence: 'no synthesis of reset-on-re-entry choreography for cyclic correction loops.',
    since_version: '3.22.0',
    gap_note: 'uplift PR-8 (loop resets), after PR-3.',
  },
];

const REGISTRY_BY_ID = new Map(FOUNDRY_CAPABILITY_REGISTRY.map((entry) => [entry.capability, entry]));

export function capabilityEntry(name: string): CapabilityEntry | undefined {
  return REGISTRY_BY_ID.get(name);
}

export function capabilityStatus(name: string): CapabilityStatus | undefined {
  return REGISTRY_BY_ID.get(name)?.status;
}

// ───────────────────────── detection from intake signals ─────────────────────────

export interface CapabilityDetectionInput {
  readonly purpose?: string;
  /** stage descriptors (any object shape — only their string values are scanned) */
  readonly stages?: ReadonlyArray<object>;
  /** parsed intake.delegation_json */
  readonly delegation?: Record<string, unknown>;
  /** parsed intake.completion_json (its string leaves are scanned too) */
  readonly completion?: unknown;
  /** any additional free text (e.g. intake notes) to scan */
  readonly extraText?: string;
}

export interface CapabilityDemand {
  readonly capability: string;
  /** the concrete signal that triggered detection (for the refusal message + audit) */
  readonly evidence: string;
}

interface TextDetector {
  readonly capability: string;
  readonly pattern: RegExp;
  readonly label: string;
}

// Conservative, high-signal detectors. They must NOT fire on today's linear /
// external-adapter programs (fee-calculator, crm-mock-lookup, proposal-ops, …),
// which is why each requires an explicit per-item / child-session / upload /
// docx-track-change phrase, not merely "approve" or "service".
// per_item_confirmation is detected by TWO required signals (below), not a single
// coupling regex — so automated "compute an approval score" (iteration without a
// user decision) does NOT match, while synonym-phrased "review every provision and
// ask the user to accept or reject … before continuing" (deep-flattened) does.
const PER_ITEM_ITERATION =
  /\b(?:(?:clause|item|section|line|provision|paragraph|article|term)[- ]by[- ](?:clause|item|section|line|provision|paragraph|article|term)|per[- ](?:clause|item|section|provision|paragraph|article)|(?:each|every) (?:clause|item|section|line|provision|paragraph|article|term)|one (?:clause|item|provision|section) at a time|(?:review|revis\w+|process|iterate)\w*[^.]{0,25}(?:each|every) (?:clause|item|section|provision|paragraph))\b/i;
// The user signal must be an APPROVAL ACTION (approve/accept/reject/skip/sign-off/
// confirm) tied to the user — NOT merely the word "user" near the output noun
// "decision"/"decision memo" (a realistic linear summarizer says "pasted by the
// user … into a decision memo" and must not trip this). "decide/decision" as bare
// nouns are excluded; genuine per-item approval loops still say approve/accept/reject.
const USER_APPROVAL =
  /(?:\b(?:user|human|client|reviewer|counterparty|attorney|lawyer)\b[^.]{0,45}\b(?:approv\w*|accept\w*|reject\w*|skip\w*|sign[- ]?off|confirm\w*)\b|\b(?:ask|prompt|require)\w*\b[^.]{0,25}\b(?:user|client|reviewer|human)\b[^.]{0,25}\b(?:approv\w*|accept\w*|reject\w*|choose)\b|\baccept or reject\b|\bapprove or reject\b|\b(?:approv\w*|accept\w*|reject\w*|skip\w*)[^.]{0,25}\bbefore (?:continuing|proceeding|moving on)\b|\bawait\w*[^.]{0,20}(?:user|approval)\b|\bexplicit(?:ly)? approv\w*\b)/i;

// Text detectors (per_item handled above). Each requires an explicit capability
// phrase; none fire on plain linear/external-adapter programs.
const TEXT_DETECTORS: readonly TextDetector[] = [
  {
    capability: 'delegation_research_agent',
    pattern: /\b(?:research agent|spawn\w*[^.]{0,25}research|research (?:fan[- ]?out|children|axes)|delegate\w*[^.]{0,25}research)\b/i,
    label: 'research-agent delegation / fan-out',
  },
  {
    capability: 'delegation_child_session',
    pattern: /\b(?:child session|sub[- ]?agents?|delegate\w*[^.]{0,25}(?:child|sub[- ]?session)|spawn\w*[^.]{0,25}(?:child|session))\b/i,
    label: 'child-session delegation',
  },
  {
    capability: 'document_upload_intake',
    pattern: /\b(?:upload\w*[^.]{0,25}(?:document|contract|file|pdf|docx|agreement)|document[- ]ingest|ingest\w*[^.]{0,20}(?:a |the )?(?:contract|document|pdf|docx|agreement)|extract\w*[^.]{0,35}(?:clauses|sections|provisions|terms|text)[^.]{0,20}from[^.]{0,25}(?:document|contract|pdf|upload|agreement|source)|(?:attached|uploaded|source)[^.]{0,15}(?:agreement|contract|document))\b/i,
    label: 'document upload / ingest',
  },
  {
    capability: 'export_docx_trackchange',
    pattern: /\btrack[- ]?changes?\b/i,
    label: 'track-changes output',
  },
  {
    // "Word" must be a document/export TYPE (word document/doc/file/redline/format,
    // or .docx) — NOT arbitrary "word" content like "word frequency". The export/
    // download branches require an explicit docx/Word-document object.
    capability: 'export_docx_plain',
    pattern: /\b(?:\.?docx\b|word (?:documents?|docs?|file|redline|format|export)|(?:export|download|generate|produce|render|save)\w*[^.]{0,20}(?:\.?docx\b|word (?:documents?|docs?|file)))\b/i,
    label: 'DOCX/Word export',
  },
  {
    capability: 'export_html',
    pattern: /\b(?:editable html (?:contract|document|view)|html (?:redline|revision table)|render\w*[^.]{0,20}html (?:contract|redline|revision))\b/i,
    label: 'HTML export/render',
  },
  {
    capability: 'rich_frontend',
    pattern: /\b(?:editable[^.]{0,20}(?:html|view|document|contract)|approval widget|redline (?:view|editor|preview)|alternatives? (?:selection|to (?:accept|choose))|choose[^.]{0,20}(?:an )?alternative|side[- ]by[- ]side redline)\b/i,
    label: 'rich editable / approval / redline frontend',
  },
];

// Deep-flatten every string leaf (bounded depth) so nested domain_spec rules /
// invariants and completion outputs are scanned, not just top-level fields.
function collectStringLeaves(value: unknown, out: string[], depth = 0): void {
  if (value == null || depth > 8) return;
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, out, depth + 1);
  } else if (typeof value === 'object') {
    for (const item of Object.values(value)) collectStringLeaves(item, out, depth + 1);
  }
}

/**
 * Classify structured delegation. `kind`/structural fields are AUTHORITATIVE:
 *  - An explicit child/research `kind` (or a child structural field) marks child
 *    delegation even if `service`/`adapter` is also present (service-backed research
 *    must not evade refusal).
 *  - `result_path` (and other output metadata) is NOT a child marker — external-adapter
 *    and llm-reasoning stages legitimately use it, and flagging them was a false positive.
 */
function detectDelegationCapabilities(delegation: Record<string, unknown> | undefined): CapabilityDemand[] {
  if (!delegation || typeof delegation !== 'object') return [];
  const demands: CapabilityDemand[] = [];
  for (const [slug, raw] of Object.entries(delegation)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const kind = typeof entry.kind === 'string' ? entry.kind.toLowerCase() : '';
    const explicitResearch = /research/.test(kind) || 'synthesize_child' in entry;
    const explicitChildKind = /\b(?:child|sub[- ]?agent|subagent|research[_ -]?agent)\b/.test(kind) || /\bdelegat/.test(kind);
    const structuralChild =
      'target_spec' in entry ||
      'synthesize_child' in entry ||
      'children' in entry ||
      'child' in entry ||
      'max_delegated_rounds' in entry ||
      'fan_out' in entry;
    if (explicitResearch) {
      demands.push({
        capability: 'delegation_research_agent',
        evidence: `stage '${slug}' declares a research-agent delegation (kind=${kind || '?'})`,
      });
    } else if (explicitChildKind || structuralChild) {
      demands.push({
        capability: 'delegation_child_session',
        evidence: `stage '${slug}' declares a child-session delegation (${Object.keys(entry).join(', ')})`,
      });
    }
    // else: external-adapter / llm-reasoning / service stage (incl. result_path) — synthesizable, not flagged.
  }
  return demands;
}

export function detectRequestedCapabilities(input: CapabilityDetectionInput): CapabilityDemand[] {
  // Scan ALL string leaves (deep) of purpose + stages (incl. nested domain_spec
  // rules/invariants) + completion + extra text — not just top-level fields.
  const leaves: string[] = [];
  if (input.purpose) leaves.push(input.purpose);
  if (input.extraText) leaves.push(input.extraText);
  for (const stage of input.stages ?? []) collectStringLeaves(stage, leaves);
  collectStringLeaves(input.completion, leaves);
  const haystack = leaves.join('\n').trim();

  const found = new Map<string, CapabilityDemand>();
  const add = (capability: string, evidence: string): void => {
    if (!found.has(capability)) found.set(capability, { capability, evidence });
  };

  // per_item_confirmation: requires BOTH a per-item iteration phrase AND a
  // user-facing approval/decision phrase (anywhere in the flattened text).
  const iteration = PER_ITEM_ITERATION.exec(haystack);
  const approval = USER_APPROVAL.exec(haystack);
  if (iteration && approval) {
    add(
      'per_item_confirmation',
      `per-item user-approval loop (iteration "${iteration[0].slice(0, 40).trim()}" + user decision "${approval[0].slice(0, 40).trim()}")`,
    );
  }

  for (const detector of TEXT_DETECTORS) {
    const match = detector.pattern.exec(haystack);
    if (match) add(detector.capability, `${detector.label} (matched "${match[0].slice(0, 60).trim()}")`);
  }
  for (const demand of detectDelegationCapabilities(input.delegation)) add(demand.capability, demand.evidence);
  return [...found.values()];
}

// ───────────────────────── assessment + safe-stop ─────────────────────────

export interface CapabilityAssessment {
  readonly synthesizes: CapabilityDemand[];
  readonly scaffolds_with_gap: CapabilityDemand[];
  readonly refuses: CapabilityDemand[];
  /** demands whose capability id is not in the registry (treated as refuses, conservatively) */
  readonly unknown: CapabilityDemand[];
}

export function assessCapabilities(demands: readonly CapabilityDemand[]): CapabilityAssessment {
  const synthesizes: CapabilityDemand[] = [];
  const scaffolds_with_gap: CapabilityDemand[] = [];
  const refuses: CapabilityDemand[] = [];
  const unknown: CapabilityDemand[] = [];
  for (const demand of demands) {
    const status = capabilityStatus(demand.capability);
    if (status === 'synthesizes') synthesizes.push(demand);
    else if (status === 'scaffolds_with_gap') scaffolds_with_gap.push(demand);
    else if (status === 'refuses') refuses.push(demand);
    else unknown.push(demand); // unknown capability → conservative refusal
  }
  return { synthesizes, scaffolds_with_gap, refuses, unknown };
}

export class CapabilityRefusalError extends Error {
  readonly kind = 'capability_refusal';
  readonly refused: readonly CapabilityDemand[];
  constructor(refused: readonly CapabilityDemand[]) {
    const lines = refused.map((demand) => {
      const entry = capabilityEntry(demand.capability);
      const gap = entry?.gap_note ? ` — ${entry.gap_note}` : '';
      return `  • ${demand.capability}: ${demand.evidence}${gap}`;
    });
    super(
      `pgas_new_capability_refusal: this program requires foundry synthesis capabilities that are not yet available ` +
        `(#166 uplift). The foundry refuses to emit an inadequate linear scaffold. Missing:\n${lines.join('\n')}\n` +
        `Route: lodge a curator request for the missing capability, or hand-author the program until the uplift lands.`,
    );
    this.name = 'CapabilityRefusalError';
    this.refused = refused;
  }
}

/**
 * Honest safe-stop for the synthesis path. Detects the capabilities a program
 * demands from its intake, and throws CapabilityRefusalError if any are `refuses`
 * (or unknown). Returns the assessment when synthesis may proceed. A linear /
 * external-adapter program triggers no detectors, so this is a no-op for today's
 * programs (byte-identical output preserved).
 */
export function assertSynthesizableCapabilities(input: CapabilityDetectionInput): CapabilityAssessment {
  const assessment = assessCapabilities(detectRequestedCapabilities(input));
  const blocking = [...assessment.refuses, ...assessment.unknown];
  if (blocking.length > 0) {
    throw new CapabilityRefusalError(blocking);
  }
  return assessment;
}
