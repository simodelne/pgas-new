import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { loadSpecWithPatterns } from '@simodelne/pgas-server/plugin.js';
import {
  resynthesizeWithReasoningContracts,
  synthesizeProgramSpecFromDomain,
} from '../../src/foundry-program/synthesizer.js';
import {
  REASONING_CONTRACT_VERSION,
  type ReasoningStageContract,
} from '../../src/foundry-program/reasoning-contract.js';

const branchDomain = {
  'program.slug': 'memo-review',
  'program.name': 'Memo Review',
  'program.target_dir': '/tmp/memo-review',
  'program.design_path': 'design',
  'intake.purpose': 'Review drafted memos and either approve them or send them back for revision.',
  'intake.entry_channel': 'user_text',
  'intake.stages_json': JSON.stringify([
    { slug: 'intake', is_bootstrap: true },
    { slug: 'draft' },
    { slug: 'review' },
    { slug: 'revision' },
    { slug: 'complete', is_terminal: true },
  ]),
  'intake.transitions_json': JSON.stringify([
    { from: 'intake', to: 'draft', trigger: 'started', guard_field: 'intake.started' },
    { from: 'draft', to: 'review', trigger: 'ready', guard_field: 'draft.ready' },
    { from: 'review', to: 'revision', trigger: 'revise', guard_field: 'review.needs_revision' },
    { from: 'review', to: 'complete', trigger: 'approve', guard_field: 'review.approved' },
    { from: 'revision', to: 'review', trigger: 'revised', guard_field: 'revision.ready' },
  ]),
  'intake.delegation_json': JSON.stringify({ review: { notes: 'approve or request revision with rationale' } }),
  'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'review.approved' }),
};

function reviewContract(): ReasoningStageContract {
  return {
    contract_version: REASONING_CONTRACT_VERSION,
    stage: 'review',
    reasoning_prompt: [
      'Review the drafted memo stored at draft.result_json against the original request. Judge whether the memo is',
      'accurate, complete, and appropriately scoped. Decide explicitly between approving the memo and requesting a',
      'revision, justify the decision from concrete memo content, and list the memo gaps that drove your decision.',
    ].join(' '),
    result_schema: {
      fields: [
        { name: 'decision', type: 'enum', description: 'The review decision.', enum_values: ['approve', 'request_revision'] },
        { name: 'rationale', type: 'string', description: 'Justification for the review decision.' },
        { name: 'quality_score', type: 'number', description: 'Overall memo quality from 0 to 100.' },
        { name: 'blocking', type: 'boolean', description: 'Whether any finding blocks approval.' },
        { name: 'gaps', type: 'string_array', description: 'Concrete memo gaps found during review.' },
      ],
      allow_extra_fields: true,
    },
    items_schema: {
      templates: ['review:decision:<decision>', 'review:quality:<quality_score>'],
      description: 'Key:value item strings for the review judgment.',
    },
    canned_example: {
      result: {
        decision: 'approve',
        rationale: 'The memo covers every requested risk with accurate figures.',
        quality_score: 92,
        blocking: false,
        gaps: ['none material'],
      },
      items: ['review:decision:approve', 'review:quality:92'],
    },
    contract_source: 'meta_llm',
  };
}

interface ParsedSpec {
  prompts: Record<string, string>;
  guidance: Record<string, string[]>;
  schema: Record<string, string>;
  projection: Record<string, { include: string[] }>;
  action_map: Record<string, {
    channel?: string;
    arg_descriptions?: Record<string, string>;
    mutations: Array<{ op: string; path: string; value?: unknown; from_arg?: string }>;
  }>;
}

describe('reasoning contract weave', () => {
  const woven = synthesizeProgramSpecFromDomain(branchDomain, { reasoningContracts: { review: reviewContract() } });
  const parsed = load(woven.spec_yaml) as ParsedSpec;

  it('replaces the generic mode prompt with the contract reasoning prompt and field inventory', () => {
    expect(parsed.prompts.review).not.toContain('Perform the review stage');
    expect(parsed.prompts.review).toContain('Review the drafted memo stored at draft.result_json');
    expect(parsed.prompts.review).toContain('result_json must be a JSON object containing at least: decision (enum: approve | request_revision), rationale (string), quality_score (number), blocking (boolean), gaps (string_array; pass the argument as a JSON array string)');
    expect(parsed.prompts.review).toContain('items_json must be a JSON array of strings matching: review:decision:<decision>, review:quality:<quality_score>');
    expect(parsed.prompts.draft).toBe('Perform the draft stage for Memo Review.');
  });

  it('appends per-field contract guidance while preserving base guidance', () => {
    const guidance = parsed.guidance.review.join('\n');
    expect(parsed.guidance.review[0]).toBe('Use the synthesized JSON-string scalar fields for structured handler results.');
    expect(guidance).toContain('decision (enum, one of: approve | request_revision): The review decision.');
    expect(guidance).toContain('gaps (string_array): Concrete memo gaps found during review.');
    expect(guidance).toContain('items_json templates: review:decision:<decision>, review:quality:<quality_score>.');
    expect(guidance).toContain('Populate every core argument; the composite result_json must agree with the per-field arguments.');
  });

  it('adds per-field from_arg mutations to every action sourced at the reasoning stage', () => {
    for (const actionName of ['advance_review_to_revision', 'advance_review_to_complete']) {
      const action = parsed.action_map[actionName];
      const fromArgPaths = action.mutations.filter((mutation) => mutation.from_arg).map((mutation) => [mutation.path, mutation.from_arg]);
      expect(fromArgPaths).toEqual([
        ['review.result_json', 'result_json'],
        ['review.items_json', 'items_json'],
        ['review.result.decision', 'decision'],
        ['review.result.rationale', 'rationale'],
        ['review.result.quality_score', 'quality_score'],
        ['review.result.blocking', 'blocking'],
        ['review.result.gaps', 'gaps'],
      ]);
      expect(action.channel).toBe('widget_output');
      expect(action.arg_descriptions?.decision).toBe('The review decision. One of: approve | request_revision.');
      expect(action.arg_descriptions?.quality_score).toBe('Overall memo quality from 0 to 100.');
      expect(action.arg_descriptions?.gaps).toBe('Concrete memo gaps found during review. Provide the value as a JSON array string.');
      expect(action.arg_descriptions?.result_json).toContain('Must encode a JSON object containing at least: decision (enum: approve | request_revision)');
      expect(action.arg_descriptions?.items_json).toContain('Must match the templates: review:decision:<decision>, review:quality:<quality_score>.');
    }
  });

  it('declares GKType-typed schema paths for the composite record and each core field', () => {
    expect(parsed.schema).toMatchObject({
      'review.result_json': 'string',
      'review.items_json': 'string',
      'review.result': 'object',
      'review.result.decision': 'string',
      'review.result.rationale': 'string',
      'review.result.quality_score': 'number',
      'review.result.blocking': 'boolean',
      // S-11: MSet into array-typed paths is forbidden; string_array fields
      // are JSON array strings under GKType string.
      'review.result.gaps': 'string',
    });
  });

  it('projects the typed record into the stage mode, downstream modes, and terminal modes', () => {
    expect(parsed.projection.review.include).toEqual(expect.arrayContaining([
      'review.result_json', 'review.items_json', 'review.result',
    ]));
    expect(parsed.projection.revision.include).toContain('review.result');
    expect(parsed.projection.complete.include).toContain('review.result');
  });

  it('embeds the contract record in contracts_ts and tools metadata', () => {
    expect(woven.contracts_ts).toContain('export interface ReasoningStageContract');
    expect(woven.contracts_ts).toContain('export const stageReasoningContracts');
    expect(woven.contracts_ts).toContain('"quality_score"');
    expect(woven.tools_ts).toContain("result_fields: ['decision', 'rationale', 'quality_score', 'blocking', 'gaps'],");
    expect(woven.tools_ts).toContain("result_record_path: 'review.result',");
  });

  it('adds the observability envelope to the generated reasoning handlers', () => {
    expect(woven.handlers_ts).toContain("decision: resolveDomainValue<unknown>(payload as HandlerPayload, 'decision', null),");
    expect(woven.handlers_ts).toContain("contract_conformant: reasoningOutputConformant(resultJson, fields, ['decision', 'rationale', 'quality_score', 'blocking', 'gaps']),");
    expect(woven.handlers_ts).toContain('function reasoningOutputConformant(');
    expect(woven.handlers_index_ts).toBe("export { handlers, reactionHandlers } from '../handlers.js';\n");
  });

  it('drives the generated smoke test with the canned example on the declared widget_output channel', () => {
    expect(woven.smoke_test_ts).toContain("effect('advance_review_to_complete', {");
    expect(woven.smoke_test_ts).toContain('"decision":"approve"');
    expect(woven.smoke_test_ts).toContain('quality_score: 92,');
    expect(woven.smoke_test_ts).toContain('gaps: "[\\"none material\\"]",');
    expect(woven.smoke_test_ts).toContain("}, 'widget_output'),");
    // draft is llm-reasoning without a contract in this fixture and keeps the
    // legacy generic effect; the contract-bearing review effect must not.
    const reviewEffect = woven.smoke_test_ts.slice(woven.smoke_test_ts.indexOf("effect('advance_review_to_complete'"));
    expect(reviewEffect.slice(0, reviewEffect.indexOf('effect(', 1))).not.toContain("status: 'reasoned'");
    expect(woven.smoke_test_ts).toContain('channel: channel ?? (');
  });

  it('still loads the woven spec through the engine loader', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pgas-new-weave-load-'));
    try {
      const specPath = join(dir, 'specs.yml');
      writeFileSync(specPath, woven.spec_yaml);
      expect(() => loadSpecWithPatterns(specPath)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('no-contract byte identity', () => {
  it('produces byte-identical artifacts when reasoningContracts is empty or absent', () => {
    const base = synthesizeProgramSpecFromDomain(branchDomain);
    const withEmpty = synthesizeProgramSpecFromDomain(branchDomain, { reasoningContracts: {} });
    expect(withEmpty).toEqual(base);
    expect(withEmpty.spec_yaml).toBe(base.spec_yaml);
    expect(withEmpty.contracts_ts).toBe(base.contracts_ts);
    expect(withEmpty.handlers_ts).toBe(base.handlers_ts);
    expect(withEmpty.tools_ts).toBe(base.tools_ts);
    expect(withEmpty.smoke_test_ts).toBe(base.smoke_test_ts);
    expect(base.contracts_ts).not.toContain('stageReasoningContracts');
    expect(base.handlers_ts).not.toContain('reasoningOutputConformant');
  });

  it('ignores contracts keyed to non-reasoning stages', () => {
    const base = synthesizeProgramSpecFromDomain(branchDomain);
    const withMiskeyed = synthesizeProgramSpecFromDomain(branchDomain, {
      reasoningContracts: { intake: { ...reviewContract(), stage: 'intake' } },
    });
    expect(withMiskeyed).toEqual(base);
  });

  it('round-trips byte-identically through resynthesizeWithReasoningContracts with no contracts', () => {
    const base = synthesizeProgramSpecFromDomain(branchDomain);
    const rewoven = resynthesizeWithReasoningContracts(
      { ...base, created_at: '2026-07-02T00:00:00.000Z' },
      {},
    );
    expect(rewoven.spec_yaml).toBe(base.spec_yaml);
    expect(rewoven.sha256).toBe(base.sha256);
    expect(rewoven.contracts_ts).toBe(base.contracts_ts);
    expect(rewoven.handlers_ts).toBe(base.handlers_ts);
    expect(rewoven.handlers_index_ts).toBe(base.handlers_index_ts);
    expect(rewoven.tools_ts).toBe(base.tools_ts);
    expect(rewoven.smoke_test_ts).toBe(base.smoke_test_ts);
  });

  it('rotates only the reasoning-stage surface when a contract is woven', () => {
    const base = synthesizeProgramSpecFromDomain(branchDomain);
    const rewoven = resynthesizeWithReasoningContracts(
      { ...base, created_at: '2026-07-02T00:00:00.000Z' },
      { review: reviewContract() },
    );
    expect(rewoven.sha256).not.toBe(base.sha256);
    expect(rewoven.mode_names).toEqual(base.mode_names);
    const baseParsed = load(base.spec_yaml) as ParsedSpec;
    const rewovenParsed = load(rewoven.spec_yaml) as ParsedSpec;
    expect(rewovenParsed.prompts.draft).toBe(baseParsed.prompts.draft);
    expect(rewovenParsed.action_map.complete_draft).toEqual(baseParsed.action_map.complete_draft);
    expect(rewovenParsed.prompts.review).not.toBe(baseParsed.prompts.review);
  });

  it('requires a synthesis context to re-weave', () => {
    const base = synthesizeProgramSpecFromDomain(branchDomain);
    expect(() => resynthesizeWithReasoningContracts(
      { ...base, created_at: '2026-07-02T00:00:00.000Z', synthesis_context: undefined },
      { review: reviewContract() },
    )).toThrow(/requires artifact.synthesis_context/u);
  });
});
