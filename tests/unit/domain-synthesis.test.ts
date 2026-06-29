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
