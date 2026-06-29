import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { synthesizeDomainLogic } from '../../src/foundry-program/domain-synthesis.js';
import type { SynthesizedArtifact } from '../../src/foundry-program/synthesizer-store.js';
import { loadWiringManifest } from '../../src/pgas-new/wiring-manifest.js';

const validBody = `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void runtime;
  return {
    result_json: JSON.stringify({ stage: input.stage, status: 'ok' }),
    items_json: JSON.stringify([input.stage]),
    digest: '',
  };
}
`;

const validExternalMockBody = `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

// TODO(real-service-swap): replace the in-memory mock with the real adapter in a future integration.
export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void runtime;
  return {
    result_json: JSON.stringify({ stage: input.stage, adapter_kind: 'in_memory_mock' }),
    items_json: JSON.stringify(['mocked']),
    digest: '',
    adapter_kind: 'in_memory_mock',
  };
}
`;

const validDomainSpecBody = `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void runtime;
  const raw = input.domain['inputs.initial_user_text'];
  const facts = typeof raw === 'string' ? JSON.parse(raw) as Record<string, unknown> : {};
  return {
    result_json: JSON.stringify({ stage: input.stage, plan: String(facts.plan ?? 'unknown'), total_fee: 0 }),
    items_json: JSON.stringify(['plan:' + String(facts.plan ?? 'unknown')]),
    digest: '',
  };
}
`;

function artifact(): SynthesizedArtifact {
  return {
    spec_yaml: 'name: test',
    mode_names: ['intake', 'calculate', 'done'],
    sha256: 'sha',
    created_at: '2026-06-28T00:00:00.000Z',
    contracts_ts: 'export interface StageInput {}; export interface StageRuntime {}; export interface StageOutput {};',
    handlers_ts: 'export const handlers = {};',
    handlers_index_ts: 'export const handlers = {};',
    tools_ts: 'export const stageActionTools = {};',
    smoke_test_ts: 'describe("generated program smoke", () => {});',
    stage_classification: [
      { slug: 'calculate', archetype: 'pure-compute', rationale: 'compute' },
    ],
    body_stage_slugs: ['calculate'],
  };
}

function artifactWithContext(): SynthesizedArtifact {
  return {
    ...artifact(),
    synthesis_context: {
      program_slug: 'fee-calculator',
      program_name: 'Fee Calculator',
      purpose: 'Calculate a deterministic subscription fee from plan, seats, and region facts.',
      entry_channel: 'user_text',
      stages: [
        { slug: 'intake', is_bootstrap: true },
        { slug: 'calculate' },
        { slug: 'done', is_terminal: true },
      ],
      transitions: [
        { from: 'intake', to: 'calculate', trigger: 'started', guard_field: 'intake.started' },
        { from: 'calculate', to: 'done', trigger: 'calculated', guard_field: 'calculate.ready' },
      ],
      delegation: { enabled: false },
      completion: { final_stage: 'done', guard_field: 'calculate.ready' },
    },
  };
}

function artifactWithDomainSpecContext(): SynthesizedArtifact {
  return {
    ...artifactWithContext(),
    synthesis_context: {
      ...artifactWithContext().synthesis_context!,
      stages: [
        { slug: 'intake', is_bootstrap: true },
        {
          slug: 'calculate',
          domain_spec: {
            reads: ['inputs.initial_user_text.plan', 'inputs.initial_user_text.seats'],
            produces: {
              result_json: {
                stage: 'string',
                plan: 'string',
                total_fee: 'number',
              },
              items_json: ['plan:<plan>'],
            },
            rules: [
              'Parse input.domain["inputs.initial_user_text"] as JSON before computing.',
              'total_fee = seats * per_seat_rate.',
            ],
            invariants: [
              'result_json.stage must equal calculate.',
              'items_json must include the selected plan.',
            ],
          },
        } as Record<string, unknown> as { slug: string },
        { slug: 'done', is_terminal: true },
      ],
    },
    contracts_ts: [
      'export interface StageDomainSpec { reads: readonly string[]; produces: Record<string, unknown>; rules: readonly string[]; invariants: readonly string[]; }',
      'export interface StageInput { domain_spec: StageDomainSpec; }',
      'export interface StageRuntime {}',
      'export interface StageOutput {}',
      'export const stageDomainSpecs = { calculate: { rules: ["total_fee = seats * per_seat_rate."] } };',
    ].join('\n'),
  };
}

function externalArtifact(stage = 'crm_lookup'): SynthesizedArtifact {
  return {
    ...artifact(),
    mode_names: ['intake', stage, 'done'],
    stage_classification: [
      { slug: stage, archetype: 'external-adapter', adapter_kind: 'in_memory_mock', rationale: `${stage} calls an external adapter` },
    ],
    body_stage_slugs: [stage],
  };
}

function withCache<T>(fn: (cacheDir: string) => Promise<T>): Promise<T> {
  const cacheDir = mkdtempSync(join(tmpdir(), 'pgas-domain-synthesis-test-'));
  return fn(cacheDir).finally(() => rmSync(cacheDir, { recursive: true, force: true }));
}

describe('domain logic synthesis', () => {
  it('repairs a rejected body and records accepted stage audit', async () => {
    await withCache(async (cacheDir) => {
      const attempts: string[] = [];
      const result = await synthesizeDomainLogic(artifact(), {
        cacheDir,
        maxAttempts: 3,
        providerUrl: 'http://provider.local/v1',
        model: 'qwen36-27b',
        generator: async ({ repair }) => {
          attempts.push(repair?.lastError ?? 'initial');
          return attempts.length === 1 ? 'export const nope = 1;' : validBody;
        },
      });

      expect(attempts).toEqual(['initial', expect.stringContaining('runStage')]);
      expect(result.stage_sources).toEqual({ calculate: validBody });
      expect(result.domain_synthesis_audit).toEqual([
        expect.objectContaining({
          stage: 'calculate',
          archetype: 'pure-compute',
          behavioral_gate: 'passed',
          attempts: 2,
          cache_hit: false,
          body_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ]);
    });
  });

  it('passes the behavioral gate for a body that returns the expected fixture shape', async () => {
    await withCache(async (cacheDir) => {
      const result = await synthesizeDomainLogic(artifact(), {
        cacheDir,
        providerUrl: 'http://provider.local/v1',
        model: 'qwen36-27b',
        generator: async () => validBody,
      });

      expect(result.domain_synthesis_audit?.[0]).toEqual(expect.objectContaining({
        stage: 'calculate',
        behavioral_gate: 'passed',
        behavioral_fixture: expect.objectContaining({
          input_stage: 'calculate',
          expected_result_stage: 'calculate',
          expected_items_non_empty: true,
        }),
      }));
    });
  });

  it('behaviorally verifies bodies that read request facts from the stable initial input path', async () => {
    await withCache(async (cacheDir) => {
      const requestFactBody = `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void runtime;
  const raw = input.domain['inputs.initial_user_text'];
  const facts = typeof raw === 'string' ? JSON.parse(raw) as Record<string, unknown> : {};
  return {
    result_json: JSON.stringify({ stage: input.stage, plan: facts.plan, seats: facts.seats }),
    items_json: JSON.stringify(['plan:' + String(facts.plan), 'seats:' + String(facts.seats)]),
    digest: '',
  };
}
`;

      const result = await synthesizeDomainLogic(artifact(), {
        cacheDir,
        providerUrl: 'http://provider.local/v1',
        model: 'qwen36-27b',
        generator: async () => requestFactBody,
      });

      expect(result.domain_synthesis_audit?.[0]).toEqual(expect.objectContaining({
        behavioral_gate: 'passed',
      }));
    });
  });

  it('provides stable request facts in the behavioral fixture for fact-dependent item output', async () => {
    await withCache(async (cacheDir) => {
      const factDependentItemsBody = `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void runtime;
  const raw = input.domain['inputs.initial_user_text'];
  const facts = typeof raw === 'string' ? JSON.parse(raw) as Record<string, unknown> : {};
  const items: string[] = [];
  if (typeof facts.base_hours === 'number') items.push('base_hours:' + facts.base_hours);
  if (typeof facts.hourly_rate_usd === 'number') items.push('hourly_rate_usd:' + facts.hourly_rate_usd);
  return {
    result_json: JSON.stringify({ stage: input.stage, base_hours: facts.base_hours, hourly_rate_usd: facts.hourly_rate_usd }),
    items_json: JSON.stringify(items),
    digest: '',
  };
}
`;

      const result = await synthesizeDomainLogic(artifact(), {
        cacheDir,
        providerUrl: 'http://provider.local/v1',
        model: 'qwen36-27b',
        generator: async () => factDependentItemsBody,
      });

      expect(result.domain_synthesis_audit?.[0]).toEqual(expect.objectContaining({
        behavioral_gate: 'passed',
      }));
    });
  });

  it('behaviorally verifies bodies that parse prior stage outputs from the fixture domain', async () => {
    await withCache(async (cacheDir) => {
      const priorOutputBody = `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void runtime;
  const prior = input.domain['estimate_fee.output'] as { result_json?: string } | undefined;
  const result = prior?.result_json ? JSON.parse(prior.result_json) as Record<string, unknown> : {};
  return {
    result_json: JSON.stringify({ stage: input.stage, subtotal_usd: result.subtotal_usd }),
    items_json: JSON.stringify(['subtotal_usd:' + String(result.subtotal_usd)]),
    digest: '',
  };
}
`;

      const result = await synthesizeDomainLogic(artifact(), {
        cacheDir,
        providerUrl: 'http://provider.local/v1',
        model: 'qwen36-27b',
        generator: async () => priorOutputBody,
      });

      expect(result.domain_synthesis_audit?.[0]).toEqual(expect.objectContaining({
        behavioral_gate: 'passed',
      }));
    });
  });

  it('behaviorally verifies bodies that read domain-spec prior output dependencies', async () => {
    await withCache(async (cacheDir) => {
      const statefulBody = `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void runtime;
  const requestRaw = input.domain['inputs.initial_user_text'];
  const request = typeof requestRaw === 'string' ? JSON.parse(requestRaw) as Record<string, unknown> : {};
  const previousRaw = input.domain['normalize_refund.output'];
  const previousOutput = previousRaw && typeof previousRaw === 'object' && !Array.isArray(previousRaw)
    ? previousRaw as Record<string, unknown>
    : {};
  const previousResultRaw = previousOutput.result_json;
  const previous = typeof previousResultRaw === 'string'
    ? JSON.parse(previousResultRaw) as Record<string, unknown>
    : {};
  const originalAmountCents = Number(previous.original_amount_cents);
  const deliveredDaysAgo = Number(request.delivered_days_ago);
  const refundPct = deliveredDaysAgo <= 30 ? 100 : deliveredDaysAgo <= 60 ? 50 : 0;
  const refundCents = Math.round(originalAmountCents * refundPct / 100);
  const policyCode = refundPct === 100 ? 'full_refund_window' : refundPct === 50 ? 'partial_refund_window' : 'outside_refund_window';
  return {
    result_json: JSON.stringify({
      stage: input.stage,
      order_id: String(previous.order_id),
      delivered_days_ago: deliveredDaysAgo,
      refund_pct: refundPct,
      refund_cents: refundCents,
      policy_code: policyCode,
    }),
    items_json: JSON.stringify(['policy:' + policyCode, 'refund_cents:' + refundCents]),
    digest: '',
  };
}
`;

      const result = await synthesizeDomainLogic({
        ...artifactWithContext(),
        mode_names: ['intake', 'normalize_refund', 'apply_refund_policy', 'done'],
        stage_classification: [
          { slug: 'normalize_refund', archetype: 'pure-compute', rationale: 'compute' },
          { slug: 'apply_refund_policy', archetype: 'pure-compute', rationale: 'compute' },
        ],
        body_stage_slugs: ['apply_refund_policy'],
        synthesis_context: {
          ...artifactWithContext().synthesis_context!,
          stages: [
            { slug: 'intake', is_bootstrap: true },
            {
              slug: 'normalize_refund',
              domain_spec: {
                reads: [
                  'inputs.initial_user_text.order_id',
                  'inputs.initial_user_text.original_amount_cents',
                  'inputs.initial_user_text.refund_requested',
                ],
                produces: {
                  result_json: {
                    stage: 'string',
                    order_id: 'string',
                    original_amount_cents: 'number',
                    refund_requested: 'boolean',
                  },
                  items_json: ['order:<order_id>', 'amount_cents:<original_amount_cents>'],
                },
                rules: ['Echo request refund fields.'],
                invariants: ['result_json.stage must equal normalize_refund.'],
              },
            },
            {
              slug: 'apply_refund_policy',
              domain_spec: {
                reads: [
                  'normalize_refund.output.result_json.order_id',
                  'normalize_refund.output.result_json.original_amount_cents',
                  'inputs.initial_user_text.delivered_days_ago',
                ],
                produces: {
                  result_json: {
                    stage: 'string',
                    order_id: 'string',
                    delivered_days_ago: 'number',
                    refund_pct: 'number',
                    refund_cents: 'number',
                    policy_code: 'string',
                  },
                  items_json: ['policy:<policy_code>', 'refund_cents:<refund_cents>'],
                },
                rules: [
                  'Parse normalize_refund.output.result_json and the original request JSON before applying policy.',
                  'If delivered_days_ago is greater than 30 and less than or equal to 60, refund_pct is 50 and policy_code is partial_refund_window.',
                  'refund_cents = Math.round(original_amount_cents * refund_pct / 100).',
                ],
                invariants: ['result_json.stage must equal apply_refund_policy.'],
              },
            },
            { slug: 'done', is_terminal: true },
          ],
          transitions: [
            { from: 'intake', to: 'normalize_refund', trigger: 'started', guard_field: 'intake.started' },
            { from: 'normalize_refund', to: 'apply_refund_policy', trigger: 'normalized', guard_field: 'normalize_refund.ready' },
            { from: 'apply_refund_policy', to: 'done', trigger: 'applied', guard_field: 'apply_refund_policy.ready' },
          ],
        },
      }, {
        cacheDir,
        providerUrl: 'http://provider.local/v1',
        model: 'qwen36-27b',
        generator: async () => statefulBody,
      });

      expect(result.domain_synthesis_audit?.[0]).toEqual(expect.objectContaining({
        stage: 'apply_refund_policy',
        behavioral_gate: 'passed',
        behavioral_fixture: expect.objectContaining({
          available_domain_paths: expect.arrayContaining([
            'inputs.initial_user_text',
            'normalize_refund.output',
          ]),
          domain_spec_reads: expect.arrayContaining([
            'normalize_refund.output.result_json.original_amount_cents',
            'inputs.initial_user_text.delivered_days_ago',
          ]),
          expected_items_templates: ['policy:<policy_code>', 'refund_cents:<refund_cents>'],
        }),
      }));
    });
  });

  it('feeds stateful domain-spec paths into behavioral repair feedback', async () => {
    await withCache(async (cacheDir) => {
      const attempts: string[] = [];
      const emptyItemsBody = `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void runtime;
  return {
    result_json: JSON.stringify({ stage: input.stage, previous_total_usd: 200, discount_pct: 10, discounted_total_usd: 180 }),
    items_json: JSON.stringify([]),
    digest: '',
  };
}
`;
      const validStatefulBody = `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void runtime;
  const estimateOutput = input.domain['estimate_fee.output'] as Record<string, unknown>;
  const estimate = JSON.parse(String(estimateOutput.result_json)) as Record<string, unknown>;
  const request = JSON.parse(String(input.domain['inputs.initial_user_text'])) as Record<string, unknown>;
  const previousTotal = Number(estimate.subtotal_usd);
  const discountPct = Number(request.discount_pct);
  const discountedTotal = previousTotal * (1 - discountPct / 100);
  return {
    result_json: JSON.stringify({ stage: input.stage, previous_total_usd: previousTotal, discount_pct: discountPct, discounted_total_usd: discountedTotal }),
    items_json: JSON.stringify(['previous_total_usd:' + previousTotal, 'discounted_total_usd:' + discountedTotal]),
    digest: '',
  };
}
`;

      const statefulArtifact = {
        ...artifactWithContext(),
        mode_names: ['intake', 'estimate_fee', 'apply_discount', 'done'],
        stage_classification: [
          { slug: 'estimate_fee', archetype: 'pure-compute', rationale: 'compute' },
          { slug: 'apply_discount', archetype: 'pure-compute', rationale: 'compute' },
        ],
        body_stage_slugs: ['apply_discount'],
        synthesis_context: {
          ...artifactWithContext().synthesis_context!,
          stages: [
            { slug: 'intake', is_bootstrap: true },
            { slug: 'estimate_fee' },
            {
              slug: 'apply_discount',
              domain_spec: {
                reads: [
                  'inputs.initial_user_text.discount_pct',
                  'estimate_fee.output.result_json.subtotal_usd',
                ],
                produces: {
                  result_json: {
                    stage: 'string',
                    previous_total_usd: 'number',
                    discount_pct: 'number',
                    discounted_total_usd: 'number',
                  },
                  items_json: ['previous_total_usd:<previous_total_usd>', 'discounted_total_usd:<discounted_total_usd>'],
                },
                rules: [
                  'Parse estimate_fee.output.result_json and the original request JSON before computing.',
                  'previous_total_usd = estimate_fee.output.result_json.subtotal_usd.',
                  'discounted_total_usd = previous_total_usd * (1 - discount_pct / 100).',
                ],
                invariants: ['result_json.stage must equal apply_discount.'],
              },
            },
            { slug: 'done', is_terminal: true },
          ],
        },
      } satisfies SynthesizedArtifact;

      const result = await synthesizeDomainLogic(statefulArtifact, {
        cacheDir,
        maxAttempts: 2,
        providerUrl: 'http://provider.local/v1',
        model: 'qwen36-27b',
        generator: async ({ repair }) => {
          attempts.push(repair?.lastError ?? 'initial');
          return attempts.length === 1 ? emptyItemsBody : validStatefulBody;
        },
      });

      expect(result.domain_synthesis_audit?.[0]).toEqual(expect.objectContaining({
        behavioral_gate: 'passed',
        attempts: 2,
      }));
      expect(attempts[1]).toContain('domain_spec.reads');
      expect(attempts[1]).toContain('estimate_fee.output.result_json.subtotal_usd');
      expect(attempts[1]).toContain('Available behavioral fixture domain paths');
      expect(attempts[1]).toContain('estimate_fee.output');
      expect(attempts[1]).toContain('domain_spec.produces.items_json');
      expect(attempts[1]).toContain('previous_total_usd:<previous_total_usd>');
    });
  });

  it('prompts generated stage bodies to read the entry-channel request and prior stage outputs', async () => {
    await withCache(async (cacheDir) => {
      let prompt = '';
      await synthesizeDomainLogic(artifactWithContext(), {
        cacheDir,
        providerUrl: 'http://provider.local/v1',
        model: 'qwen36-27b',
        generator: async (request) => {
          prompt = request.prompt;
          return validBody;
        },
      });

      expect(prompt).toContain('Stage synthesis context:');
      expect(prompt).toContain("input.domain['inputs.initial_user_text']");
      expect(prompt).toContain('latest trigger text');
      expect(prompt).toContain("input.domain['<stage>.output']");
      expect(prompt).toContain('Parse JSON-looking user requests into typed facts before computing.');
      expect(prompt).toContain('When parsed request facts contain numeric fields whose names describe a calculation, compute from those fields directly instead of inventing base fees, complexity multipliers, or random constants.');
      expect(prompt).toContain('Use common named-field arithmetic: hours multiplied by hourly rates produce subtotals; discount_pct is a percentage applied to a subtotal; budget fields are comparison thresholds, not fee inputs.');
      expect(prompt).toContain('When parsed request facts contain identifiers, echo those identifiers; do not replace them with synthetic IDs from runtime.random().');
      expect(prompt).toContain('assign unknown object values to Record<string, unknown> before indexing');
      expect(prompt).toContain('concise lower-case key:value strings');
      expect(prompt).toContain('Keep final business fields at the top level; do not wrap all important facts under generic inputs, details, or calculation objects.');
      expect(prompt).toContain('Do not use a generic status/summary/details template when the mandate names concrete fields.');
    });
  });

  it('treats the author-provided stage domain spec as the normative synthesis contract', async () => {
    await withCache(async (cacheDir) => {
      let prompt = '';
      await synthesizeDomainLogic(artifactWithDomainSpecContext(), {
        cacheDir,
        providerUrl: 'http://provider.local/v1',
        model: 'qwen36-27b',
        generator: async (request) => {
          prompt = request.prompt;
          return validDomainSpecBody;
        },
      });

      expect(prompt).toContain('Author-provided domain spec for this stage is normative.');
      expect(prompt).toContain('"reads":');
      expect(prompt).toContain('"produces":');
      expect(prompt).toContain('"rules":');
      expect(prompt).toContain('"invariants":');
      expect(prompt).toContain('total_fee = seats * per_seat_rate.');
      expect(prompt).toContain('result_json.stage must equal calculate.');
      expect(prompt).toContain('Implement these rules exactly; do not infer alternate business logic.');
      expect(prompt).toContain('Treat domain_spec.produces.result_json as the exact result_json object schema and insertion order');
      expect(prompt).toContain('When domain_spec.produces.items_json is an array, treat it as the exact ordered item template list');
      expect(prompt).toContain('construct result_json with exactly those declared top-level keys, in that declared order');
      expect(prompt).toContain('construct items_json with exactly those item templates, in order');
    });
  });

  it('repairs bodies whose result_json does not match the domain spec schema exactly', async () => {
    await withCache(async (cacheDir) => {
      const attempts: string[] = [];
      const wrongSchemaBody = `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void runtime;
  return {
    result_json: JSON.stringify({ stage: input.stage, total_fee: 0, plan: 'pro', extra: true }),
    items_json: JSON.stringify(['plan:pro']),
    digest: '',
  };
}
`;

      const result = await synthesizeDomainLogic(artifactWithDomainSpecContext(), {
        cacheDir,
        maxAttempts: 2,
        providerUrl: 'http://provider.local/v1',
        model: 'qwen36-27b',
        generator: async ({ repair }) => {
          attempts.push(repair?.lastError ?? 'initial');
          return attempts.length === 1 ? wrongSchemaBody : validDomainSpecBody;
        },
      });

      expect(attempts).toEqual([
        'initial',
        expect.stringContaining('expected result_json keys to exactly match domain_spec.produces.result_json in order'),
      ]);
      expect(result.stage_sources?.calculate).toBe(validDomainSpecBody);
    });
  });

  it('repairs bodies whose items_json does not match the domain spec templates exactly', async () => {
    await withCache(async (cacheDir) => {
      const attempts: string[] = [];
      const wrongItemsBody = `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void runtime;
  return {
    result_json: JSON.stringify({ stage: input.stage, plan: 'pro', total_fee: 0 }),
    items_json: JSON.stringify(['plan:pro', 'total_fee:0']),
    digest: '',
  };
}
`;

      const result = await synthesizeDomainLogic(artifactWithDomainSpecContext(), {
        cacheDir,
        maxAttempts: 2,
        providerUrl: 'http://provider.local/v1',
        model: 'qwen36-27b',
        generator: async ({ repair }) => {
          attempts.push(repair?.lastError ?? 'initial');
          return attempts.length === 1 ? wrongItemsBody : validDomainSpecBody;
        },
      });

      expect(attempts).toEqual([
        'initial',
        expect.stringContaining('expected items_json to contain exactly 1 items from domain_spec.produces.items_json'),
      ]);
      expect(result.stage_sources?.calculate).toBe(validDomainSpecBody);
    });
  });

  it('feeds behavioral gate failures into repair and accepts the corrected body', async () => {
    await withCache(async (cacheDir) => {
      const attempts: string[] = [];
      const wrongBody = `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void input;
  void runtime;
  return {
    result_json: JSON.stringify({ stage: 'wrong-stage', status: 'ok' }),
    items_json: JSON.stringify(['wrong-stage']),
    digest: '',
  };
}
`;
      const result = await synthesizeDomainLogic(artifact(), {
        cacheDir,
        maxAttempts: 3,
        providerUrl: 'http://provider.local/v1',
        model: 'qwen36-27b',
        generator: async ({ repair }) => {
          attempts.push(repair?.lastError ?? 'initial');
          return attempts.length === 1 ? wrongBody : validBody;
        },
      });

      expect(attempts).toEqual(['initial', expect.stringContaining('behavioral gate failed')]);
      expect(result.domain_synthesis_audit?.[0]).toEqual(expect.objectContaining({
        attempts: 2,
        behavioral_gate: 'passed',
      }));
    });
  });

  it('repairs bodies that omit required contract type imports before project typecheck', async () => {
    await withCache(async (cacheDir) => {
      const attempts: string[] = [];
      const missingOutputImport = `import type { StageInput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void runtime;
  return {
    result_json: JSON.stringify({ stage: input.stage, status: 'ok' }),
    items_json: JSON.stringify([input.stage]),
    digest: '',
  };
}
`;

      const result = await synthesizeDomainLogic(artifact(), {
        cacheDir,
        maxAttempts: 2,
        providerUrl: 'http://provider.local/v1',
        model: 'qwen36-27b',
        generator: async ({ repair }) => {
          attempts.push(repair?.lastError ?? 'initial');
          return attempts.length === 1 ? missingOutputImport : validBody;
        },
      });

      expect(attempts).toEqual(['initial', expect.stringContaining('StageOutput')]);
      expect(result.stage_sources?.calculate).toBe(validBody);
    });
  });

  it('repairs bodies with strict TypeScript errors that transpileModule would miss', async () => {
    await withCache(async (cacheDir) => {
      const attempts: string[] = [];
      const unsafeObjectIndexing = `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void runtime;
  const previous = input.domain['previous.output'];
  let value = 'none';
  if (previous && typeof previous === 'object' && !Array.isArray(previous)) {
    value = String(previous['result_json'] ?? 'none');
  }
  return {
    result_json: JSON.stringify({ stage: input.stage, value }),
    items_json: JSON.stringify([value]),
    digest: '',
  };
}
`;

      const result = await synthesizeDomainLogic(artifact(), {
        cacheDir,
        maxAttempts: 2,
        providerUrl: 'http://provider.local/v1',
        model: 'qwen36-27b',
        generator: async ({ repair }) => {
          attempts.push(repair?.lastError ?? 'initial');
          return attempts.length === 1 ? unsafeObjectIndexing : validBody;
        },
      });

      expect(attempts).toEqual(['initial', expect.stringContaining("can't be used to index type")]);
      expect(result.stage_sources?.calculate).toBe(validBody);
    });
  });

  it('hard-fails a repeatedly wrong body on behavioral gate failure', async () => {
    await withCache(async (cacheDir) => {
      let attempts = 0;
      await expect(
        synthesizeDomainLogic(artifact(), {
          cacheDir,
          maxAttempts: 2,
          providerUrl: 'http://provider.local/v1',
          model: 'qwen36-27b',
          generator: async () => {
            attempts += 1;
            return `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void input;
  void runtime;
  return {
    result_json: JSON.stringify({ stage: 'wrong-stage', status: 'ok' }),
    items_json: JSON.stringify([]),
    digest: '',
  };
}
`;
          },
        }),
      ).rejects.toThrow(/behavioral gate failed.*expected result_json.stage to equal calculate/u);
      expect(attempts).toBe(2);
    });
  });

  it('hard-fails after capped repair attempts without a stub fallback', async () => {
    await withCache(async (cacheDir) => {
      let attempts = 0;
      await expect(
        synthesizeDomainLogic(artifact(), {
          cacheDir,
          maxAttempts: 2,
          providerUrl: 'http://provider.local/v1',
          model: 'qwen36-27b',
          generator: async () => {
            attempts += 1;
            return 'export const nope = 1;';
          },
        }),
      ).rejects.toThrow(/domain synthesis failed for stage calculate after 2 attempts/u);
      expect(attempts).toBe(2);
    });
  });

  it('rejects banned stage body capabilities before acceptance', async () => {
    await withCache(async (cacheDir) => {
      await expect(
        synthesizeDomainLogic(artifact(), {
          cacheDir,
          maxAttempts: 1,
          providerUrl: 'http://provider.local/v1',
          model: 'qwen36-27b',
          generator: async () => `export async function runStage() { return eval('1'); }`,
        }),
      ).rejects.toThrow(/banned capability.*eval/u);
    });
  });

  it('rejects pure-compute bodies that still contain stub markers', async () => {
    await withCache(async (cacheDir) => {
      await expect(
        synthesizeDomainLogic(artifact(), {
          cacheDir,
          maxAttempts: 1,
          providerUrl: 'http://provider.local/v1',
          model: 'qwen36-27b',
          generator: async () => `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void input;
  void runtime;
  // TODO: fill this in later
  return { result_json: '{}', items_json: '[]', digest: '' };
}
`,
        }),
      ).rejects.toThrow(/stub marker.*TODO/u);
    });
  });

  it('allows the real-service-swap TODO only for external-adapter mock bodies', async () => {
    const externalArtifact = {
      ...artifact(),
      stage_classification: [
        { slug: 'calculate', archetype: 'external-adapter', adapter_kind: 'in_memory_mock', rationale: 'adapter' },
      ],
    } satisfies SynthesizedArtifact;

    await withCache(async (cacheDir) => {
      const result = await synthesizeDomainLogic(externalArtifact, {
        cacheDir,
        providerUrl: 'http://provider.local/v1',
        model: 'qwen36-27b',
        generator: async () => `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

// TODO(real-service-swap): replace the in-memory mock with the real adapter in a future integration.
export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void runtime;
  return {
    result_json: JSON.stringify({ stage: input.stage, adapter_kind: 'in_memory_mock' }),
    items_json: JSON.stringify(['mocked']),
    digest: '',
  };
}
`,
      });

      expect(result.stage_sources?.calculate).toContain('TODO(real-service-swap)');
      expect(result.domain_synthesis_audit?.[0]).toEqual(expect.objectContaining({
        archetype: 'external-adapter',
        adapter_kind: 'in_memory_mock',
      }));
    });
  });

  it('generates a real repo integration adapter for an existing-repo external stage that matches the manifest', async () => {
    await withCache(async (cacheDir) => {
      const manifest = loadWiringManifest(join(process.cwd(), 'tests/fixtures/existing-repo-with-integration'));
      expect(manifest.ok).toBe(true);
      let generatorCalls = 0;
      const result = await synthesizeDomainLogic(externalArtifact('crm_lookup'), {
        cacheDir,
        providerUrl: 'http://provider.local/v1',
        model: 'qwen36-27b',
        targetKind: 'existing_repo',
        integrations: manifest.manifest?.integrations ?? [],
        generator: async () => {
          generatorCalls += 1;
          return validExternalMockBody;
        },
      } as Parameters<typeof synthesizeDomainLogic>[1] & Record<string, unknown>);

      const body = result.stage_sources?.crm_lookup ?? '';
      expect(generatorCalls).toBe(0);
      expect(body).toContain("import { createCrmClient } from '@fixture/crm-client';");
      expect(body).toContain('createCrmClient()');
      expect(body).toContain('lookupAccount');
      expect(body).toContain("adapter_kind: 'repo_integration'");
      expect(body).not.toContain('TODO(real-service-swap)');
      expect(body).not.toContain('in_memory_mock');
      expect(result.domain_synthesis_audit?.[0]).toEqual(expect.objectContaining({
        stage: 'crm_lookup',
        archetype: 'external-adapter',
        adapter_kind: 'repo_integration',
        integration_name: 'crm',
        integration_import: '@fixture/crm-client',
      }));
    });
  });

  it('keeps an explicit in-memory mock audit gap when an existing repo has no matching integration', async () => {
    await withCache(async (cacheDir) => {
      const result = await synthesizeDomainLogic(externalArtifact('crm_lookup'), {
        cacheDir,
        providerUrl: 'http://provider.local/v1',
        model: 'qwen36-27b',
        targetKind: 'existing_repo',
        integrations: [
          {
            name: 'billing',
            kind: 'sdk',
            import: '@acme/billing-client',
            methods: ['lookupInvoice'],
            config_env: ['BILLING_TOKEN'],
          },
        ],
        generator: async () => validExternalMockBody,
      } as Parameters<typeof synthesizeDomainLogic>[1] & Record<string, unknown>);

      expect(result.stage_sources?.crm_lookup).toContain('TODO(real-service-swap)');
      expect(result.domain_synthesis_audit?.[0]).toEqual(expect.objectContaining({
        adapter_kind: 'in_memory_mock',
        integration_gap: true,
        audit_note: expect.stringContaining('no matching integration declared'),
      }));
    });
  });

  it('keeps standalone external adapters as in-memory mocks even when a matching integration option is present', async () => {
    await withCache(async (cacheDir) => {
      const result = await synthesizeDomainLogic(externalArtifact('crm_lookup'), {
        cacheDir,
        providerUrl: 'http://provider.local/v1',
        model: 'qwen36-27b',
        targetKind: 'standalone_repo',
        integrations: [
          {
            name: 'crm',
            kind: 'http_api',
            import: '@acme/crm-client',
            methods: ['lookupAccount'],
            config_env: ['CRM_TOKEN'],
          },
        ],
        generator: async () => validExternalMockBody,
      } as Parameters<typeof synthesizeDomainLogic>[1] & Record<string, unknown>);

      expect(result.stage_sources?.crm_lookup).toContain('TODO(real-service-swap)');
      expect(result.stage_sources?.crm_lookup).not.toContain('@acme/crm-client');
      expect(result.domain_synthesis_audit?.[0]).toEqual(expect.objectContaining({
        adapter_kind: 'in_memory_mock',
      }));
      expect(result.domain_synthesis_audit?.[0]).not.toHaveProperty('integration_name');
    });
  });

  it('reuses cached accepted bodies for unchanged contracts', async () => {
    await withCache(async (cacheDir) => {
      let calls = 0;
      const first = await synthesizeDomainLogic(artifact(), {
        cacheDir,
        providerUrl: 'http://provider.local/v1',
        model: 'qwen36-27b',
        generator: async () => {
          calls += 1;
          return validBody;
        },
      });
      const second = await synthesizeDomainLogic(artifact(), {
        cacheDir,
        providerUrl: 'http://provider.local/v1',
        model: 'qwen36-27b',
        generator: async () => {
          calls += 1;
          return validBody;
        },
      });

      expect(calls).toBe(1);
      expect(second.stage_sources).toEqual(first.stage_sources);
      expect(second.domain_synthesis_audit?.[0]).toEqual(expect.objectContaining({ cache_hit: true }));
    });
  });
});
