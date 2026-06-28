import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { synthesizeDomainLogic } from '../../src/foundry-program/domain-synthesis.js';
import type { SynthesizedArtifact } from '../../src/foundry-program/synthesizer-store.js';

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
          attempts: 2,
          cache_hit: false,
          body_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ]);
    });
  });

  it('hard-fails after capped repair attempts without a stub fallback', async () => {
    await withCache(async (cacheDir) => {
      await expect(
        synthesizeDomainLogic(artifact(), {
          cacheDir,
          maxAttempts: 2,
          providerUrl: 'http://provider.local/v1',
          model: 'qwen36-27b',
          generator: async () => 'export const nope = 1;',
        }),
      ).rejects.toThrow(/domain synthesis failed for stage calculate after 2 attempts/u);
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
