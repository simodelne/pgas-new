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
    status: 'refuses',
    evidence: 'no synthesis of per-item decision_targeting + confirmation_pairing + one-proposed-at-a-time reactions.',
    since_version: '3.22.0',
    gap_note: 'uplift PR-2 (collection representation v2) + PR-3 (confirmation-loop codegen). Engine DecisionTargetingConfig / ConfirmationPairingConfig are already public on 3.18.0.',
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
const TEXT_DETECTORS: readonly TextDetector[] = [
  {
    // Requires a per-item phrase COUPLED (within 60 chars, either order) with a
    // user approval/decision verb. This excludes mere incremental processing
    // ("draft section by section") which is NOT a per-item user-approval loop.
    capability: 'per_item_confirmation',
    pattern: /(?:(?:\b(?:clause|item|section|line)[- ](?:by[- ])?(?:clause|item|section|line)\b|\bper[- ](?:clause|item|section)\b|\bone (?:clause|item) at a time\b|\beach (?:clause|item|section|line)\b)[^.]{0,60}\b(?:approv|accept|reject|skip|confirm|sign[- ]?off|decision)\b|\b(?:approv|accept|reject|skip|confirm)\w*\b[^.]{0,40}\beach (?:clause|item|section|line)\b)/i,
    label: 'per-item / clause-by-clause user approval loop',
  },
  {
    capability: 'delegation_research_agent',
    pattern: /\b(research agent|legal research|spawn[^.]{0,25}research|research (fan[- ]?out|children|axes)|delegate[^.]{0,25}research)\b/i,
    label: 'research-agent delegation / fan-out',
  },
  {
    capability: 'delegation_child_session',
    pattern: /\b(child session|sub[- ]?agent|subagent|delegate[^.]{0,25}(child|sub[- ]?session)|spawn[^.]{0,25}(child|session))\b/i,
    label: 'child-session delegation',
  },
  {
    capability: 'document_upload_intake',
    pattern: /\b(upload[^.]{0,25}(document|contract|file|pdf|docx)|document[- ]ingest|ingest[^.]{0,20}(a |the )?(contract|document|pdf|docx)|extract[^.]{0,30}(clauses|sections|text)[^.]{0,20}from[^.]{0,20}(document|contract|pdf|upload))\b/i,
    label: 'document upload / ingest',
  },
  {
    capability: 'export_docx_trackchange',
    pattern: /\btrack[- ]?changes?\b/i,
    label: 'track-changes output',
  },
  {
    capability: 'export_docx_plain',
    pattern: /\b(docx|word document|export[^.]{0,20}(docx|word))\b/i,
    label: 'DOCX export',
  },
  {
    capability: 'rich_frontend',
    pattern: /\b(editable[^.]{0,20}(html|view|document|contract)|approval widget|redline (view|editor)|alternatives? selection|choose[^.]{0,20}alternative)\b/i,
    label: 'rich editable / approval frontend',
  },
];

/** Distinguish child/research delegation (refused) from external-adapter service delegation (synthesized). */
function detectDelegationCapabilities(delegation: Record<string, unknown> | undefined): CapabilityDemand[] {
  if (!delegation || typeof delegation !== 'object') return [];
  const demands: CapabilityDemand[] = [];
  for (const [slug, raw] of Object.entries(delegation)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    // external-adapter service delegation (has `service`/`adapter`) IS synthesizable — skip it.
    const isServiceAdapter = typeof entry.service === 'string' || typeof entry.adapter === 'string';
    const childMarker =
      'child' in entry ||
      'target_spec' in entry ||
      'synthesize_child' in entry ||
      'children' in entry ||
      'result_path' in entry ||
      (typeof entry.kind === 'string' && /child|research|delegat|sub[- ]?agent/i.test(entry.kind));
    if (childMarker && !isServiceAdapter) {
      const research =
        (typeof entry.kind === 'string' && /research/i.test(entry.kind)) ||
        'synthesize_child' in entry;
      demands.push({
        capability: research ? 'delegation_research_agent' : 'delegation_child_session',
        evidence: `stage '${slug}' declares a child-session delegation (${Object.keys(entry).join(', ')})`,
      });
    }
  }
  return demands;
}

export function detectRequestedCapabilities(input: CapabilityDetectionInput): CapabilityDemand[] {
  const haystack = [
    input.purpose ?? '',
    input.extraText ?? '',
    ...(input.stages ?? []).map((stage) =>
      Object.values(stage as Record<string, unknown>)
        .filter((value): value is string => typeof value === 'string')
        .join(' '),
    ),
  ]
    .join('\n')
    .trim();

  const found = new Map<string, CapabilityDemand>();
  for (const detector of TEXT_DETECTORS) {
    const match = detector.pattern.exec(haystack);
    if (match && !found.has(detector.capability)) {
      found.set(detector.capability, {
        capability: detector.capability,
        evidence: `${detector.label} (matched "${match[0].slice(0, 60).trim()}")`,
      });
    }
  }
  for (const demand of detectDelegationCapabilities(input.delegation)) {
    if (!found.has(demand.capability)) found.set(demand.capability, demand);
  }
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
