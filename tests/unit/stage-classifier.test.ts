import { describe, expect, it } from 'vitest';
import { classifyStagesForDomain } from '../../src/foundry-program/stage-classifier.js';

const stages = [
  { slug: 'intake', is_bootstrap: true },
  { slug: 'fee_modeling' },
  { slug: 'brief_summary' },
  { slug: 'crm_lookup' },
  { slug: 'complete', is_terminal: true },
];

function domain(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'program.name': 'Fee Proposal',
    'intake.purpose': 'Calculate proposal fees, summarize the final brief, and lookup a client record in a CRM.',
    'intake.stages_json': JSON.stringify(stages),
    'intake.delegation_json': JSON.stringify({
      crm_lookup: {
        service: 'crm',
        behavior: 'fetch client data from an external adapter',
      },
    }),
    ...overrides,
  };
}

describe('stage classifier', () => {
  it('classifies stages deterministically and records rationales', () => {
    const classified = classifyStagesForDomain(domain());

    expect(classified.map((stage) => [stage.slug, stage.archetype])).toEqual([
      ['intake', 'pure-compute'],
      ['fee_modeling', 'pure-compute'],
      ['brief_summary', 'llm-reasoning'],
      ['crm_lookup', 'external-adapter'],
      ['complete', 'pure-compute'],
    ]);

    expect(classified.find((stage) => stage.slug === 'fee_modeling')?.rationale).toContain('compute');
    expect(classified.find((stage) => stage.slug === 'brief_summary')?.rationale).toContain('reasoning');
    expect(classified.find((stage) => stage.slug === 'crm_lookup')).toMatchObject({
      adapter_kind: 'in_memory_mock',
      rationale: expect.stringContaining('external'),
    });
  });

  it('honors explicit delegation archetypes before heuristic stage names', () => {
    const classified = classifyStagesForDomain(domain({
      'intake.stages_json': JSON.stringify([
        { slug: 'intake', is_bootstrap: true },
        { slug: 'scope_definition' },
        { slug: 'draft_assembly' },
        { slug: 'fee_modeling' },
        { slug: 'complete', is_terminal: true },
      ]),
      'intake.delegation_json': JSON.stringify({
        scope_definition: { kind: 'llm-reasoning', target: 'define_scope' },
        draft_assembly: { kind: 'llm-reasoning', target: 'assemble_draft' },
        fee_modeling: { kind: 'pure-compute', target: 'compute_fee_model' },
      }),
    }));

    expect(classified.map((stage) => [stage.slug, stage.archetype])).toEqual([
      ['intake', 'pure-compute'],
      ['scope_definition', 'llm-reasoning'],
      ['draft_assembly', 'llm-reasoning'],
      ['fee_modeling', 'pure-compute'],
      ['complete', 'pure-compute'],
    ]);
    expect(classified.find((stage) => stage.slug === 'scope_definition')?.rationale)
      .toContain('explicitly marked');
  });

  it('leans on purpose and domain_spec cues for authoring, review, and judgment stages without flipping formulaic stages', () => {
    const classified = classifyStagesForDomain(domain({
      'intake.purpose': 'Draft user-facing recommendations, review tradeoffs, and decide the next action from submitted facts.',
      'intake.stages_json': JSON.stringify([
        { slug: 'intake', is_bootstrap: true },
        { slug: 'work_session' },
        {
          slug: 'proposal_body',
          domain_spec: {
            reads: ['inputs.user_text'],
            produces: { result_json: { stage: 'string', body: 'string' } },
            rules: ['Author a concise draft from the user facts.', 'Revise wording for clarity.'],
            invariants: ['The draft must only use recorded facts.'],
          },
        },
        {
          slug: 'decision_packet',
          domain_spec: {
            reads: ['proposal_body.result_json'],
            produces: { result_json: { stage: 'string', recommendation: 'string' } },
            rules: ['Evaluate options, assess tradeoffs, and decide which recommendation to send.'],
            invariants: ['The recommendation must cite the assessed tradeoffs.'],
          },
        },
        {
          slug: 'fee_modeling',
          domain_spec: {
            reads: ['inputs.rate_card'],
            produces: { result_json: { stage: 'string', total_fee: 'number' } },
            rules: ['Compute fees from deterministic rate-card values.'],
            invariants: ['total_fee must be numeric.'],
          },
        },
        {
          slug: 'schema_validation',
          domain_spec: {
            reads: ['proposal_body.result_json'],
            produces: { result_json: { stage: 'string', valid: 'boolean' } },
            rules: ['Validate required fields and parse numeric inputs.'],
            invariants: ['valid must be boolean.'],
          },
        },
        { slug: 'output_formatting', domain_spec: { reads: [], produces: {}, rules: ['Format and render output.'], invariants: [] } },
        { slug: 'risk_scoring', domain_spec: { reads: [], produces: {}, rules: ['Score, tally, and aggregate risk factors.'], invariants: [] } },
        { slug: 'complete', is_terminal: true },
      ]),
      'intake.delegation_json': JSON.stringify({}),
    }));

    expect(classified.map((stage) => [stage.slug, stage.archetype])).toEqual([
      ['intake', 'pure-compute'],
      ['work_session', 'llm-reasoning'],
      ['proposal_body', 'llm-reasoning'],
      ['decision_packet', 'llm-reasoning'],
      ['fee_modeling', 'pure-compute'],
      ['schema_validation', 'pure-compute'],
      ['output_formatting', 'pure-compute'],
      ['risk_scoring', 'pure-compute'],
      ['complete', 'pure-compute'],
    ]);
  });

  it('honors explicit per-stage execution model entries from the Q5 stages wrapper', () => {
    const classified = classifyStagesForDomain(domain({
      'intake.stages_json': JSON.stringify([
        { slug: 'intake', is_bootstrap: true },
        { slug: 'draft_assembly' },
        { slug: 'manual_review' },
        { slug: 'handoff' },
        { slug: 'complete', is_terminal: true },
      ]),
      'intake.delegation_json': JSON.stringify({
        stages: {
          draft_assembly: { kind: 'pure-compute' },
          manual_review: { kind: 'external-adapter' },
          handoff: { reasoning_per_turn: true },
        },
      }),
    }));

    expect(classified.map((stage) => [stage.slug, stage.archetype])).toEqual([
      ['intake', 'pure-compute'],
      ['draft_assembly', 'pure-compute'],
      ['manual_review', 'external-adapter'],
      ['handoff', 'llm-reasoning'],
      ['complete', 'pure-compute'],
    ]);
    expect(classified.find((stage) => stage.slug === 'manual_review')).toMatchObject({
      adapter_kind: 'in_memory_mock',
      rationale: expect.stringContaining('explicitly marked'),
    });
  });
});
