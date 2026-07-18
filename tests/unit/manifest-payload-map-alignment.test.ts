import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';

import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import type { WiringAvailableProgram } from '../../src/pgas-new/wiring-manifest.js';

// Per-agent payload_map alignment: a manifest available_program may carry a payload_map
// that maps parent state onto the REAL agent's input contract, so the reused delegation
// is payload-contract-faithful (not a generic request.topic). Targets may use the canonical
// SimoneOS delegated-input roots (request.*, domain_context.*, answers.*, document_intake.*),
// and a later child may source from an earlier child's landed result (result-chaining).

const AVAILABLE: WiringAvailableProgram[] = [
  {
    slug: 'research',
    target_spec: 'SimoneOS Legal Research',
    provides: 'delegation_research_agent',
    payload_map: { 'answers.research_question': 'intake.summary' },
  },
  {
    slug: 'document-ingest',
    target_spec: 'SimoneOS Document Ingest',
    provides: 'delegation_document_ingest',
    payload_map: { 'request.extraction_contract': 'intake.summary' },
  },
  {
    slug: 'review-service',
    target_spec: 'SimoneOS Review Service',
    provides: 'delegation_review',
    payload_map: {
      'document_intake.work_product': 'ingest_stage.delegation.ingest.result',
      'domain_context.review_axes': 'intake.summary',
    },
  },
];

function contractRevisionDomain(): Record<string, unknown> {
  return {
    'program.slug': 'contract-revision',
    'program.name': 'Contract Revision',
    'program.target_dir': '/tmp/contract-revision',
    'intake.purpose': 'Ingest, research, and review a contract by reusing existing agents.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      {
        slug: 'intake',
        is_bootstrap: true,
        domain_spec: {
          reads: ['inputs.initial_user_text'],
          produces: { result_json: { summary: 'string' }, items_json: ['summary:<summary>'] },
          rules: ['Summarize the request.'],
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
          synthesize_child: { kind: 'research_agent', research_backend: 'host_connector', purpose: 'p', result_fields: { summary: 'string' } },
          payload_map: { 'request.topic': 'intake.summary' },
          result_path: 'research_stage.delegation.research.result',
          max_delegated_rounds: 12,
          optional: true,
        },
        {
          id: 'ingest',
          stage: 'ingest_stage',
          target_spec: 'SimoneOS Document Ingest',
          payload_map: { 'request.topic': 'intake.summary' },
          result_path: 'ingest_stage.delegation.ingest.result',
          max_delegated_rounds: 12,
          optional: true,
        },
        {
          id: 'review',
          stage: 'review_stage',
          target_spec: 'SimoneOS Review Service',
          payload_map: { 'request.topic': 'intake.summary' },
          result_path: 'review_stage.delegation.review.result',
          max_delegated_rounds: 12,
          optional: true,
        },
      ],
    }),
  };
}

describe('manifest per-agent payload_map alignment', () => {
  const artifact = synthesizeProgramSpecFromDomain(contractRevisionDomain(), {
    targetKind: 'existing_repo',
    availablePrograms: AVAILABLE,
  });
  const registration = artifact.registration_ts ?? '';

  it('rewrites each delegation to its agent\'s real input contract (not generic request.topic)', () => {
    expect(registration).toContain('answers.research_question');
    expect(registration).toContain('request.extraction_contract');
    expect(registration).toContain('document_intake.work_product');
    expect(registration).toContain('domain_context.review_axes');
    expect(registration).not.toContain("target: 'request.topic'");
  });

  it('chains the review work_product from the document-ingest landed result', () => {
    expect(registration).toContain('ingest_stage.delegation.ingest.result');
  });

  it('still reuses all 3 agents by target_spec with no stubs/gaps', () => {
    const spec = load(artifact.spec_yaml) as { channels: Record<string, Record<string, unknown>> };
    expect(spec.channels.research_call?.target_spec).toBe('SimoneOS Legal Research');
    expect(spec.channels.ingest_call?.target_spec).toBe('SimoneOS Document Ingest');
    expect(spec.channels.review_call?.target_spec).toBe('SimoneOS Review Service');
    expect(artifact.child_artifacts).toBeUndefined();
    expect(artifact.capability_gaps ?? []).toHaveLength(0);
  });
});
