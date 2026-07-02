import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { synthesizeDomainLogic } from '../../src/foundry-program/domain-synthesis.js';
import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import type { SynthesizedArtifact } from '../../src/foundry-program/synthesizer-store.js';

interface GoldenFixture {
  name: string;
  domain: Record<string, string>;
  /**
   * 'generator': reasoning contracts come from an injected deterministic
   * meta-LLM stand-in; 'fallback': no provider is configured and the
   * deterministic fallback derivation is regression-locked instead.
   */
  reasoning_contract_mode: 'generator' | 'fallback';
  artifacts: {
    spec_yaml: string;
    contracts_ts: string;
    smoke_test_ts: string;
  };
  stage_body_hashes: Record<string, string>;
  audit: Array<Record<string, unknown>>;
}

const fixturesDir = join(process.cwd(), 'tests/fixtures/domain-synthesis-goldens');

describe('domain synthesis golden fixtures', () => {
  it('matches exact deterministic artifacts and stable generated-body audit metadata for at least three mandates', async () => {
    const fixturePaths = existsSync(fixturesDir)
      ? readdirSync(fixturesDir).filter((path) => path.endsWith('.json')).sort()
      : [];
    expect(fixturePaths.length).toBeGreaterThanOrEqual(3);

    const modes = new Set<string>();
    for (const fixturePath of fixturePaths) {
      const fixture = readFixture(join(fixturesDir, fixturePath));
      modes.add(fixture.reasoning_contract_mode);
      const first = await buildGolden(fixture.domain, fixture.reasoning_contract_mode);
      const second = await buildGolden(fixture.domain, fixture.reasoning_contract_mode);

      expect(first.artifacts, fixture.name).toEqual(fixture.artifacts);
      expect(first.stage_body_hashes, fixture.name).toEqual(fixture.stage_body_hashes);
      expect(first.audit, fixture.name).toEqual(fixture.audit);
      expect(second, fixture.name).toEqual(first);

      for (const entry of fixture.audit) {
        if (entry.archetype !== 'llm-reasoning') continue;
        expect(entry.behavioral_gate, `${fixture.name}/${String(entry.stage)}`).toBe('reasoning_contract_conformance');
        expect(entry.contract_source, `${fixture.name}/${String(entry.stage)}`)
          .toBe(fixture.reasoning_contract_mode === 'generator' ? 'meta_llm' : 'deterministic_fallback');
        expect(entry.contract_hash, `${fixture.name}/${String(entry.stage)}`).toMatch(/^[a-f0-9]{64}$/);
      }
    }
    // Both contract sources must stay regression-locked.
    expect(modes).toEqual(new Set(['generator', 'fallback']));
  });
});

async function buildGolden(
  domain: Record<string, string>,
  reasoningContractMode: 'generator' | 'fallback',
): Promise<Omit<GoldenFixture, 'name' | 'domain' | 'reasoning_contract_mode'>> {
  const cacheDir = mkdtempSync(join(tmpdir(), 'pgas-new-domain-golden-'));
  try {
    const artifact = await synthesizeDomainLogic(artifactFromDomain(domain), {
      cacheDir,
      // 'fallback' mode leaves the reasoning-contract provider unconfigured so
      // the deterministic fallback path is what gets regression-locked.
      providerUrl: reasoningContractMode === 'generator' ? 'http://provider.local/v1' : '',
      model: reasoningContractMode === 'generator' ? 'qwen36-27b' : '',
      generator: async ({ stage, archetype }) => goldenBodyFor(stage, archetype),
      ...(reasoningContractMode === 'generator'
        ? { reasoningContractGenerator: async ({ stage }) => goldenReasoningContractJson(stage) }
        : {}),
    });
    return {
      artifacts: {
        spec_yaml: artifact.spec_yaml,
        contracts_ts: artifact.contracts_ts,
        smoke_test_ts: artifact.smoke_test_ts,
      },
      stage_body_hashes: Object.fromEntries(
        Object.entries(artifact.stage_sources ?? {})
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([stage, body]) => [stage, sha256(body)]),
      ),
      audit: (artifact.domain_synthesis_audit ?? []).map((entry) => ({
        stage: entry.stage,
        archetype: entry.archetype,
        ...(entry.adapter_kind ? { adapter_kind: entry.adapter_kind } : {}),
        ...(entry.behavioral_gate ? { behavioral_gate: entry.behavioral_gate } : {}),
        ...(entry.behavioral_fixture ? { behavioral_fixture: entry.behavioral_fixture } : {}),
        ...(entry.contract_source ? { contract_source: entry.contract_source } : {}),
        ...(entry.contract_hash ? { contract_hash: entry.contract_hash } : {}),
        ...(entry.fallback_reason ? { fallback_reason: entry.fallback_reason } : {}),
        attempts: entry.attempts,
        cache_hit: entry.cache_hit,
        body_hash: entry.body_hash,
      })),
    };
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

function artifactFromDomain(domain: Record<string, string>): SynthesizedArtifact {
  return {
    ...synthesizeProgramSpecFromDomain(domain),
    created_at: '2026-06-28T00:00:00.000Z',
  };
}

function goldenBodyFor(stage: string, archetype: 'pure-compute' | 'external-adapter'): string {
  if (archetype === 'external-adapter') {
    return `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

// TODO(real-service-swap): replace this in-memory mock with the real service adapter.
export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  const recordId = String(input.domain['record.id'] ?? input.domain['account.id'] ?? 'record-demo');
  return {
    result_json: JSON.stringify({
      stage: input.stage,
      status: 'mocked',
      adapter_kind: 'in_memory_mock',
      record_id: recordId,
      observed_at: runtime.now()
    }),
    items_json: JSON.stringify([input.stage + ':' + recordId]),
    digest: '',
    adapter_kind: 'in_memory_mock',
  };
}
`;
  }

  return `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  const score = Math.round(runtime.random() * 100);
  return {
    result_json: JSON.stringify({
      stage: input.stage,
      status: 'computed',
      score,
      owner_queue: String(input.domain['owner.queue'] ?? 'operations'),
      next_action: 'advance',
      summary_ready: true,
      computed_at: runtime.now()
    }),
    items_json: JSON.stringify([input.stage + ':score:' + score]),
    digest: '',
  };
}
`;
}

function goldenReasoningContractJson(stage: string): string {
  return JSON.stringify({
    reasoning_prompt: [
      `Perform the ${stage} judgment for this generated program. Read the original request stored at`,
      'inputs.initial_user_text and every prior stage output available in program state, weigh the recorded facts,',
      'and produce an explicit assessment with a recommended action. Justify the recommendation from concrete',
      'recorded facts and never invent facts that are absent from the request or prior stage outputs.',
    ].join(' '),
    result_schema: {
      fields: [
        { name: 'assessment', type: 'string', description: `Overall ${stage} assessment.` },
        { name: 'recommended_action', type: 'enum', description: 'Recommended next action.', enum_values: ['proceed', 'revise', 'block'] },
        { name: 'confidence', type: 'enum', description: 'Confidence in the assessment.', enum_values: ['low', 'medium', 'high'] },
        { name: 'key_findings', type: 'string_array', description: 'Key findings supporting the assessment.' },
      ],
      allow_extra_fields: true,
    },
    items_schema: {
      templates: [`${stage}:action:<recommended_action>`, `${stage}:confidence:<confidence>`],
      description: `Key:value item strings for the ${stage} judgment.`,
    },
    canned_example: {
      result: {
        assessment: `The recorded ${stage} facts support proceeding.`,
        recommended_action: 'proceed',
        confidence: 'high',
        key_findings: ['recorded facts are consistent'],
      },
      items: [`${stage}:action:proceed`, `${stage}:confidence:high`],
    },
  });
}

function readFixture(path: string): GoldenFixture {
  return JSON.parse(readFileSync(path, 'utf8')) as GoldenFixture;
}

function sha256(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}
