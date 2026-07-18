import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import type { WiringAvailableProgram } from '../../src/pgas-new/wiring-manifest.js';

// CAPSTONE — proves Slice A (manifest reuse: research via synthesize_child, ingest/review via
// target_spec) and Slice B (N-distinct-static multi-child delegation) COMPOSE: a single
// foundry-synthesized contract-revision program delegates to ALL THREE existing simoneos agents,
// each reused from the `.pgas/wiring.yml` manifest — the #166 goal (reuse, not reinvent).
//
// research → "SimoneOS Legal Research" (key 'research'), ingest → "SimoneOS Document Ingest"
// (key 'document-ingest'), review → "contract-review-service" (key == spec name).

const RESEARCH_SPEC = 'SimoneOS Legal Research';
const INGEST_SPEC = 'SimoneOS Document Ingest';
const REVIEW_SPEC = 'contract-review-service';

const CONTRACT_REVISION_MANIFEST: WiringAvailableProgram[] = [
  { slug: 'research', target_spec: RESEARCH_SPEC, provides: 'delegation_research_agent' },
  { slug: 'document-ingest', target_spec: INGEST_SPEC, provides: 'delegation_document_ingest' },
  { slug: 'contract-review-service', target_spec: REVIEW_SPEC, provides: 'delegation_review' },
];

describe('contract-revision reuse capstone (Slice A + Slice B)', () => {
  it('delegates one program to all three existing simoneos agents via the manifest — no stub, no gap', () => {
    const artifact = synthesizeProgramSpecFromDomain(contractRevisionDomain(), {
      targetKind: 'existing_repo',
      availablePrograms: CONTRACT_REVISION_MANIFEST,
    });

    const spec = load(artifact.spec_yaml) as { channels: Record<string, Record<string, unknown>> };

    // All three delegation channels wire to the EXISTING simoneos programs by spec name.
    expect(spec.channels.research_call?.target_spec).toBe(RESEARCH_SPEC);
    expect(spec.channels.ingest_call?.target_spec).toBe(INGEST_SPEC);
    expect(spec.channels.review_call?.target_spec).toBe(REVIEW_SPEC);

    // No self-contained/synthesized children remain; research's host-connector stub + gap are gone
    // (manifest-matched → rewritten to target_spec).
    expect(artifact.child_artifacts).toBeUndefined();
    expect(artifact.contracts_ts ?? '').not.toContain('ResearchHostConnector');
    expect(artifact.capability_gaps ?? []).not.toContainEqual(
      expect.objectContaining({ capability: 'delegation_research_agent' }),
    );

    // allowedTargetPrograms carries every spec name AND each distinct registry key (Slice A both-names
    // fix — the engine gates on the key). research/document-ingest have key != spec; review is key==spec.
    const reg = artifact.registration_ts ?? '';
    for (const s of [RESEARCH_SPEC, INGEST_SPEC, REVIEW_SPEC, 'research', 'document-ingest']) {
      expect(reg, `allowedTargetPrograms must contain ${s}`).toContain(s);
    }

    // Slice B: the 3 distinct static children are stamped for reuse and carry no synthesize_child
    // (resynthesis-stable), proving the multi-child validator accepted the contract-draft-style topology.
    const children = (artifact.synthesis_context.delegation?.children ?? []) as unknown as Array<Record<string, unknown>>;
    expect(children).toHaveLength(3);
    expect(children.map((c) => c.target_spec).sort()).toEqual([REVIEW_SPEC, INGEST_SPEC, RESEARCH_SPEC].sort());
    expect(children.map((c) => c.registered_name).sort()).toEqual(
      ['research', 'document-ingest', 'contract-review-service'].sort(),
    );
    for (const c of children) {
      expect(c).not.toHaveProperty('synthesize_child');
    }
  });
});

function contractRevisionDomain(): Record<string, unknown> {
  return {
    'program.slug': 'contract-revision',
    'program.name': 'Contract Revision',
    'program.target_dir': '/tmp/contract-revision',
    'intake.purpose': 'Ingest a contract, research it, review it — reusing existing agents — then finish.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      {
        slug: 'intake',
        is_bootstrap: true,
        domain_spec: {
          reads: ['inputs.initial_user_text'],
          produces: { result_json: { summary: 'string' }, items_json: ['summary:<summary>'] },
          rules: ['Summarize the contract-revision request.'],
          invariants: ['summary is grounded in the request.'],
        },
      },
      { slug: 'research_stage' },
      { slug: 'ingest_stage' },
      { slug: 'review_stage' },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'research_stage', trigger: 'started', guard_field: 'intake.started' },
      { from: 'research_stage', to: 'ingest_stage', trigger: 'researched', guard_field: 'research_stage.ready' },
      { from: 'ingest_stage', to: 'review_stage', trigger: 'ingested', guard_field: 'ingest_stage.ready' },
      { from: 'review_stage', to: 'complete', trigger: 'reviewed', guard_field: 'review_stage.ready' },
    ]),
    'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'review_stage.ready' }),
    'intake.delegation_json': JSON.stringify({
      children: [
        {
          id: 'research',
          stage: 'research_stage',
          synthesize_child: {
            kind: 'research_agent',
            research_backend: 'host_connector',
            purpose: 'legal research on the contract',
            result_fields: { summary: 'string' },
          },
          payload_map: { 'request.topic': 'intake.summary' },
          result_path: 'research_stage.delegation.research.result',
          max_delegated_rounds: 12,
          optional: true,
        },
        {
          id: 'ingest',
          stage: 'ingest_stage',
          target_spec: INGEST_SPEC,
          payload_map: { 'request.topic': 'intake.summary' },
          result_path: 'ingest_stage.delegation.ingest.result',
          max_delegated_rounds: 12,
          optional: true,
        },
        {
          id: 'review',
          stage: 'review_stage',
          target_spec: REVIEW_SPEC,
          payload_map: { 'request.topic': 'intake.summary' },
          result_path: 'review_stage.delegation.review.result',
          max_delegated_rounds: 12,
          optional: true,
        },
      ],
    }),
  };
}
