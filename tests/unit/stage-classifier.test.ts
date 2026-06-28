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
});
