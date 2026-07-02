import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertReasoningContract,
  deriveFallbackReasoningContract,
  REASONING_CONTRACT_VERSION,
  reasoningContextForStage,
  runtimeTypeNameFor,
  synthesizeReasoningContract,
  type ReasoningStageContract,
} from '../../src/foundry-program/reasoning-contract.js';
import type { SynthesizedArtifact } from '../../src/foundry-program/synthesizer-store.js';

const envKeys = ['ALLOW_REASONING_FALLBACK', 'PGAS_REASONING_CONTRACT_REQUIRE_LLM'] as const;
const savedEnv = new Map<string, string | undefined>(envKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of envKeys) {
    const value = savedEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function artifact(overrides: Partial<SynthesizedArtifact> = {}): SynthesizedArtifact {
  return {
    spec_yaml: 'name: risk-memo',
    mode_names: ['intake', 'risk_assessment', 'recommendation', 'review', 'complete'],
    sha256: 'sha',
    created_at: '2026-07-02T00:00:00.000Z',
    contracts_ts: 'export interface StageInput {}',
    handlers_ts: 'export const handlers = {};',
    handlers_index_ts: 'export const handlers = {};',
    tools_ts: 'export const stageActionTools = {};',
    smoke_test_ts: 'describe("generated program smoke", () => {});',
    stage_classification: [
      { slug: 'risk_assessment', archetype: 'pure-compute', rationale: 'compute' },
      { slug: 'recommendation', archetype: 'llm-reasoning', rationale: 'recommendation is judgment work' },
      { slug: 'review', archetype: 'llm-reasoning', rationale: 'review is judgment work' },
    ],
    body_stage_slugs: ['intake', 'risk_assessment', 'recommendation', 'review'],
    synthesis_context: {
      program_slug: 'risk-memo',
      program_name: 'Risk Memo',
      purpose: 'Draft a professional risk acceptance memo from an assessment.',
      entry_channel: 'user_text',
      stages: [
        { slug: 'intake', is_bootstrap: true },
        { slug: 'risk_assessment' },
        { slug: 'recommendation' },
        { slug: 'review' },
        { slug: 'complete', is_terminal: true },
      ],
      transitions: [
        { from: 'intake', to: 'risk_assessment', trigger: 'started', guard_field: 'intake.started' },
        { from: 'risk_assessment', to: 'recommendation', trigger: 'assessed', guard_field: 'risk_assessment.ready' },
        { from: 'recommendation', to: 'review', trigger: 'recommended', guard_field: 'recommendation.ready' },
        { from: 'review', to: 'recommendation', trigger: 'revise', guard_field: 'review.revision_requested' },
        { from: 'review', to: 'complete', trigger: 'approve', guard_field: 'review.approved' },
      ],
      delegation: {
        recommendation: { notes: 'draft accept, mitigate, or reject recommendation with rationale' },
      },
      completion: { final_stage: 'complete', guard_field: 'review.approved' },
    },
    ...overrides,
  };
}

function validContract(overrides: Partial<ReasoningStageContract> = {}): ReasoningStageContract {
  return {
    contract_version: REASONING_CONTRACT_VERSION,
    stage: 'recommendation',
    reasoning_prompt: [
      'Weigh the risk assessment stored at risk_assessment.output.result_json and draft an explicit accept, mitigate,',
      'or reject recommendation for the described risk. Justify the recommendation from the recorded likelihood and',
      'impact facts, name the residual risk that remains after any proposed mitigation, and state your confidence.',
    ].join(' '),
    result_schema: {
      fields: [
        { name: 'recommendation', type: 'enum', description: 'The drafted recommendation.', enum_values: ['accept', 'mitigate', 'reject'] },
        { name: 'rationale', type: 'string', description: 'Justification for the recommendation.' },
        { name: 'acceptance_period_days', type: 'number', description: 'Days the acceptance remains valid.' },
        { name: 'confidence', type: 'enum', description: 'Confidence in the recommendation.', enum_values: ['low', 'medium', 'high'] },
      ],
      allow_extra_fields: true,
    },
    items_schema: {
      templates: ['recommendation:<recommendation>', 'confidence:<confidence>'],
      description: 'Key:value item strings for the drafted recommendation.',
    },
    canned_example: {
      result: {
        recommendation: 'mitigate',
        rationale: 'Likelihood is high and a compensating control is available.',
        acceptance_period_days: 90,
        confidence: 'high',
      },
      items: ['recommendation:mitigate', 'confidence:high'],
    },
    contract_source: 'meta_llm',
    ...overrides,
  };
}

function withCache<T>(fn: (cacheDir: string) => Promise<T>): Promise<T> {
  const cacheDir = mkdtempSync(join(tmpdir(), 'pgas-reasoning-contract-test-'));
  return fn(cacheDir).finally(() => rmSync(cacheDir, { recursive: true, force: true }));
}

describe('assertReasoningContract', () => {
  it('accepts a conformant contract and returns the normalized record', () => {
    const contract = assertReasoningContract(validContract(), { stage: 'recommendation' });
    expect(contract.stage).toBe('recommendation');
    expect(contract.result_schema.fields).toHaveLength(4);
    expect(contract.result_schema.allow_extra_fields).toBe(true);
  });

  const rejections: Array<[string, () => unknown, RegExp]> = [
    ['wrong contract_version', () => ({ ...validContract(), contract_version: 'v0' }), /contract_version/u],
    ['wrong stage when pinned', () => validContract({ stage: 'other' }), /stage must equal recommendation/u],
    ['short reasoning prompt', () => validContract({ reasoning_prompt: 'too short' }), /200\.\.1600/u],
    ['too few fields', () => {
      const contract = validContract();
      contract.result_schema.fields = contract.result_schema.fields.slice(0, 2);
      return contract;
    }, /3\.\.7 core fields/u],
    ['too many fields', () => {
      const contract = validContract();
      contract.result_schema.fields = Array.from({ length: 8 }, (_, index) => ({
        name: `field_${index}`,
        type: 'string' as const,
        description: 'x',
      }));
      return contract;
    }, /3\.\.7 core fields/u],
    ['reserved field name', () => {
      const contract = validContract();
      contract.result_schema.fields[0] = { name: 'result_json', type: 'string', description: 'x' };
      return contract;
    }, /reserved/u],
    ['invalid field name shape', () => {
      const contract = validContract();
      contract.result_schema.fields[0] = { name: 'BadName', type: 'string', description: 'x' };
      return contract;
    }, /must match/u],
    ['duplicate field names', () => {
      const contract = validContract();
      contract.result_schema.fields[1] = { ...contract.result_schema.fields[0] };
      return contract;
    }, /unique/u],
    ['enum without enum_values', () => {
      const contract = validContract();
      contract.result_schema.fields[0] = { name: 'recommendation', type: 'enum', description: 'x' };
      return contract;
    }, /enum_values/u],
    ['enum with too many values', () => {
      const contract = validContract();
      contract.result_schema.fields[0] = {
        name: 'recommendation',
        type: 'enum',
        description: 'x',
        enum_values: Array.from({ length: 9 }, (_, index) => `value_${index}`),
      };
      return contract;
    }, /2\.\.8/u],
    ['non-enum carrying enum_values', () => {
      const contract = validContract();
      contract.result_schema.fields[1] = { name: 'rationale', type: 'string', description: 'x', enum_values: ['a', 'b'] };
      return contract;
    }, /omit enum_values/u],
    ['allow_extra_fields false', () => {
      const contract = validContract();
      (contract.result_schema as { allow_extra_fields: unknown }).allow_extra_fields = false;
      return contract;
    }, /allow_extra_fields/u],
    ['placeholder-anchored item template', () => {
      const contract = validContract();
      contract.items_schema.templates = ['<stage>:decision:<recommendation>'];
      contract.canned_example.items = ['recommendation:decision:mitigate'];
      return contract;
    }, /literal anchor/u],
    ['canned example missing core field', () => {
      const contract = validContract();
      delete contract.canned_example.result.rationale;
      return contract;
    }, /canned_example\.result\.rationale/u],
    ['canned example off-enum value', () => {
      const contract = validContract();
      contract.canned_example.result.recommendation = 'escalate';
      return contract;
    }, /enum values/u],
    ['canned example wrong runtime type', () => {
      const contract = validContract();
      contract.canned_example.result.acceptance_period_days = 'ninety';
      return contract;
    }, /finite number/u],
    ['canned items not matching templates', () => {
      const contract = validContract();
      contract.canned_example.items = ['recommendation:mitigate'];
      return contract;
    }, /positionally/u],
    ['canned items diverging from a template literal', () => {
      const contract = validContract();
      contract.canned_example.items = ['recommendation:mitigate', 'certainty:high'];
      return contract;
    }, /must match template/u],
    ['stub marker in canned example', () => {
      const contract = validContract();
      contract.canned_example.result.rationale = 'stage_action_stub output';
      return contract;
    }, /stub marker/u],
  ];

  for (const [label, build, pattern] of rejections) {
    it(`rejects ${label}`, () => {
      expect(() => assertReasoningContract(build(), { stage: 'recommendation' })).toThrow(pattern);
    });
  }

  it('rejects field names colliding with outgoing guard-field tails', () => {
    const contract = validContract();
    contract.result_schema.fields[1] = { name: 'ready', type: 'string', description: 'x' };
    contract.canned_example.result.ready = 'yes';
    expect(() => assertReasoningContract(contract, { stage: 'recommendation', reservedFieldNames: ['ready'] }))
      .toThrow(/reserved/u);
  });

  it('enforces normative domain-spec field names, order, and types when a domain spec is provided', () => {
    const domainSpec = {
      reads: ['inputs.initial_user_text'],
      produces: {
        result_json: { stage: 'string', audience: 'string', deadline: 'string', constraint: 'string', decision: 'string' },
        items_json: ['audience:<audience>', 'deadline:<deadline>'],
      },
      rules: ['Extract facts.'],
      invariants: ['stage must equal brief_summary.'],
    };
    const conformant = validContract({
      stage: 'brief_summary',
      result_schema: {
        fields: [
          { name: 'audience', type: 'string', description: 'x' },
          { name: 'deadline', type: 'string', description: 'x' },
          { name: 'constraint', type: 'string', description: 'x' },
          { name: 'decision', type: 'string', description: 'x' },
        ],
        allow_extra_fields: true,
      },
      items_schema: { templates: ['audience:<audience>', 'deadline:<deadline>'], description: 'items' },
      canned_example: {
        result: { audience: 'ops', deadline: '2026-07-15', constraint: 'no billing changes', decision: 'launch beta' },
        items: ['audience:ops', 'deadline:2026-07-15'],
      },
    });
    expect(() => assertReasoningContract(conformant, { stage: 'brief_summary', domainSpec })).not.toThrow();

    const wrongFields = validContract({ stage: 'brief_summary' });
    expect(() => assertReasoningContract(wrongFields, { stage: 'brief_summary', domainSpec }))
      .toThrow(/normative domain_spec\.produces\.result_json keys/u);

    const wrongTemplates = { ...conformant, items_schema: { templates: ['audience:<audience>'], description: 'items' } };
    wrongTemplates.canned_example = { ...conformant.canned_example, items: ['audience:ops'] };
    expect(() => assertReasoningContract(wrongTemplates, { stage: 'brief_summary', domainSpec }))
      .toThrow(/items_json templates verbatim/u);
  });

  it('maps contract field types to nominal GKType runtime type names', () => {
    expect(runtimeTypeNameFor('string')).toBe('string');
    expect(runtimeTypeNameFor('enum')).toBe('string');
    expect(runtimeTypeNameFor('number')).toBe('number');
    expect(runtimeTypeNameFor('boolean')).toBe('boolean');
    expect(runtimeTypeNameFor('string_array')).toBe('array');
  });
});

describe('synthesizeReasoningContract', () => {
  it('accepts a conformant meta-LLM contract on the first attempt and caches it', async () => {
    await withCache(async (cacheDir) => {
      let calls = 0;
      const generator = async () => {
        calls += 1;
        const { contract_version, stage, contract_source, ...body } = validContract();
        void contract_version; void stage; void contract_source;
        return JSON.stringify(body);
      };
      const first = await synthesizeReasoningContract('recommendation', artifact(), { cacheDir, generator });
      expect(first.contract_source).toBe('meta_llm');
      expect(first.cache_hit).toBe(false);
      expect(first.attempts).toBe(1);
      expect(first.contract.result_schema.fields.map((field) => field.name)).toEqual([
        'recommendation', 'rationale', 'acceptance_period_days', 'confidence',
      ]);
      expect(readdirSync(cacheDir).filter((file) => file.endsWith('.reasoning.json'))).toHaveLength(1);

      const second = await synthesizeReasoningContract('recommendation', artifact(), {
        cacheDir,
        generator: async () => {
          throw new Error('cache hit must not invoke the generator');
        },
      });
      expect(second.cache_hit).toBe(true);
      expect(second.attempts).toBe(0);
      expect(second.contract).toEqual(first.contract);
      expect(calls).toBe(1);
    });
  });

  it('re-prompts with repair context and accepts the corrected contract', async () => {
    await withCache(async (cacheDir) => {
      const repairs: string[] = [];
      const generator = async ({ repair }: { repair?: { lastError: string } }) => {
        repairs.push(repair?.lastError ?? 'initial');
        if (repairs.length === 1) {
          return JSON.stringify({ reasoning_prompt: 'too short' });
        }
        const { contract_version, stage, contract_source, ...body } = validContract();
        void contract_version; void stage; void contract_source;
        return JSON.stringify(body);
      };
      const result = await synthesizeReasoningContract('recommendation', artifact(), { cacheDir, generator });
      expect(result.attempts).toBe(2);
      expect(repairs).toEqual(['initial', expect.stringContaining('200..1600')]);
    });
  });

  it('hard-fails by default when a configured provider keeps failing', async () => {
    await withCache(async (cacheDir) => {
      let attempts = 0;
      await expect(synthesizeReasoningContract('recommendation', artifact(), {
        cacheDir,
        maxAttempts: 2,
        generator: async () => {
          attempts += 1;
          return 'not json';
        },
      })).rejects.toThrow(/reasoning contract synthesis failed for stage recommendation after 2 attempts/u);
      expect(attempts).toBe(2);
    });
  });

  it('falls back with an audited reason only when ALLOW_REASONING_FALLBACK=1 opts in', async () => {
    await withCache(async (cacheDir) => {
      process.env.ALLOW_REASONING_FALLBACK = '1';
      const result = await synthesizeReasoningContract('recommendation', artifact(), {
        cacheDir,
        maxAttempts: 2,
        generator: async () => {
          throw new Error('provider is down');
        },
      });
      expect(result.contract_source).toBe('deterministic_fallback');
      expect(result.fallback_reason).toContain('provider is down');
      expect(result.attempts).toBe(2);
      expect(readdirSync(cacheDir).filter((file) => file.endsWith('.reasoning.json'))).toHaveLength(0);
    });
  });

  it('hard-fails on provider failure when PGAS_REASONING_CONTRACT_REQUIRE_LLM=1 even with the fallback opt-in', async () => {
    await withCache(async (cacheDir) => {
      process.env.ALLOW_REASONING_FALLBACK = '1';
      process.env.PGAS_REASONING_CONTRACT_REQUIRE_LLM = '1';
      await expect(synthesizeReasoningContract('recommendation', artifact(), {
        cacheDir,
        maxAttempts: 1,
        generator: async () => 'not json',
      })).rejects.toThrow(/reasoning contract synthesis failed/u);
    });
  });

  it('hard-fails on the no-provider path when PGAS_REASONING_CONTRACT_REQUIRE_LLM=1', async () => {
    await withCache(async (cacheDir) => {
      process.env.PGAS_REASONING_CONTRACT_REQUIRE_LLM = '1';
      await expect(synthesizeReasoningContract('recommendation', artifact(), { cacheDir }))
        .rejects.toThrow(/PGAS_REASONING_CONTRACT_REQUIRE_LLM=1 requires a configured meta-LLM provider/u);
    });
  });

  it('derives the audited deterministic fallback on the hermetic no-provider path', async () => {
    await withCache(async (cacheDir) => {
      const result = await synthesizeReasoningContract('review', artifact(), { cacheDir });
      expect(result.contract_source).toBe('deterministic_fallback');
      expect(result.fallback_reason).toContain('no meta-LLM provider configured');
      expect(result.cache_hit).toBe(false);
      expect(result.contract.stage).toBe('review');
    });
  });

  it('rotates the cache key when the synthesis context or model changes', async () => {
    await withCache(async (cacheDir) => {
      let calls = 0;
      const generator = async () => {
        calls += 1;
        const { contract_version, stage, contract_source, ...body } = validContract();
        void contract_version; void stage; void contract_source;
        return JSON.stringify(body);
      };
      await synthesizeReasoningContract('recommendation', artifact(), { cacheDir, generator, model: 'model-a', providerUrl: 'http://a' });
      await synthesizeReasoningContract('recommendation', artifact(), { cacheDir, generator, model: 'model-b', providerUrl: 'http://a' });
      const changedPurpose = artifact();
      changedPurpose.synthesis_context = {
        ...changedPurpose.synthesis_context!,
        purpose: 'A different purpose entirely.',
      };
      await synthesizeReasoningContract('recommendation', changedPurpose, { cacheDir, generator, model: 'model-a', providerUrl: 'http://a' });
      expect(calls).toBe(3);
      expect(readdirSync(cacheDir).filter((file) => file.endsWith('.reasoning.json'))).toHaveLength(3);
    });
  });
});

describe('deriveFallbackReasoningContract', () => {
  it('is deterministic across runs and passes its own validation', () => {
    const first = deriveFallbackReasoningContract('review', artifact());
    const second = deriveFallbackReasoningContract('review', artifact());
    expect(second).toEqual(first);
    expect(() => assertReasoningContract(first, {
      stage: 'review',
      reservedFieldNames: reasoningContextForStage('review', artifact()).guard_field_tails,
    })).not.toThrow();
  });

  it('derives the decision enum from outgoing guard-field tails for a branching stage', () => {
    const contract = deriveFallbackReasoningContract('review', artifact());
    const decision = contract.result_schema.fields.find((field) => field.name === 'decision');
    expect(decision?.type).toBe('enum');
    expect(decision?.enum_values).toEqual(['revision_requested', 'approved']);
    expect(contract.items_schema.templates[0]).toBe('review:decision:<decision>');
    expect(contract.items_schema.templates[0]?.startsWith('<')).toBe(false);
  });

  it('uses the generic proceed/blocked enum for single-exit stages', () => {
    const contract = deriveFallbackReasoningContract('recommendation', artifact());
    const decision = contract.result_schema.fields.find((field) => field.name === 'decision');
    expect(decision?.enum_values).toEqual(['proceed', 'blocked']);
    expect(contract.reasoning_prompt).toContain('risk_assessment.output.result_json');
    expect(contract.reasoning_prompt.length).toBeGreaterThanOrEqual(200);
  });

  it('derives core fields and templates from an author-provided domain spec', () => {
    const withSpec = artifact();
    withSpec.synthesis_context = {
      ...withSpec.synthesis_context!,
      stages: withSpec.synthesis_context!.stages.map((stage) => stage.slug === 'recommendation'
        ? {
            ...stage,
            domain_spec: {
              reads: ['risk_assessment.output.result_json.risk_score'],
              produces: {
                result_json: { stage: 'string', approved: 'boolean', basis: 'string', total_usd: 'number' },
                items_json: ['approved:<approved>', 'total_usd:<total_usd>'],
              },
              rules: ['approved = total_usd <= budget.'],
              invariants: ['stage must equal recommendation.'],
            },
          }
        : stage),
    };
    const contract = deriveFallbackReasoningContract('recommendation', withSpec);
    expect(contract.result_schema.fields.map((field) => [field.name, field.type])).toEqual([
      ['approved', 'boolean'],
      ['basis', 'string'],
      ['total_usd', 'number'],
    ]);
    expect(contract.items_schema.templates).toEqual(['approved:<approved>', 'total_usd:<total_usd>']);
    expect(contract.canned_example.result.approved).toBe(true);
    expect(contract.canned_example.items).toEqual(['approved:true', 'total_usd:1']);
  });

  it('derives an honest generic contract when the artifact has no synthesis context', () => {
    const bare = artifact({ synthesis_context: undefined });
    const contract = deriveFallbackReasoningContract('review', bare);
    expect(() => assertReasoningContract(contract, { stage: 'review' })).not.toThrow();
    expect(contract.contract_source).toBe('deterministic_fallback');
  });
});
