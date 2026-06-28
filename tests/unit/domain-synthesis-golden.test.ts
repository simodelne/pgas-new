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

    for (const fixturePath of fixturePaths) {
      const fixture = readFixture(join(fixturesDir, fixturePath));
      const first = await buildGolden(fixture.domain);
      const second = await buildGolden(fixture.domain);

      expect(first.artifacts, fixture.name).toEqual(fixture.artifacts);
      expect(first.stage_body_hashes, fixture.name).toEqual(fixture.stage_body_hashes);
      expect(first.audit, fixture.name).toEqual(fixture.audit);
      expect(second, fixture.name).toEqual(first);
    }
  });
});

async function buildGolden(domain: Record<string, string>): Promise<Omit<GoldenFixture, 'name' | 'domain'>> {
  const cacheDir = mkdtempSync(join(tmpdir(), 'pgas-new-domain-golden-'));
  try {
    const artifact = await synthesizeDomainLogic(artifactFromDomain(domain), {
      cacheDir,
      providerUrl: 'http://provider.local/v1',
      model: 'qwen36-27b',
      generator: async ({ stage, archetype }) => goldenBodyFor(stage, archetype),
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

function readFixture(path: string): GoldenFixture {
  return JSON.parse(readFileSync(path, 'utf8')) as GoldenFixture;
}

function sha256(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}
