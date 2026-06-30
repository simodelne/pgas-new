import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, Script } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { synthesizeDomainLogic } from '../../src/foundry-program/domain-synthesis.js';
import type { SynthesizedArtifact } from '../../src/foundry-program/synthesizer-store.js';
import { startLocalhostHttpApiStub } from '../fixtures/localhost-http-api.js';

const LOOPBACK_BASE_URL_ENV = 'PGAS_LOOPBACK_CRM_BASE_URL';

describe('domain synthesis repo integration loopback gate', () => {
  it('verifies an http_api repo_integration with a real localhost request and consumes the response', async () => {
    const stub = await startLocalhostHttpApiStub((entry) => ({
      ok: true,
      service: 'loopback-crm',
      observed_path: entry.path,
      request_stage: isRecord(entry.body) ? entry.body.stage : undefined,
      account_id: isRecord(entry.body) && isRecord(entry.body.domain)
        ? entry.body.domain['account.id']
        : undefined,
    }));
    const cacheDir = mkdtempSync(join(tmpdir(), 'pgas-domain-loopback-cache-'));
    const previousBaseUrl = process.env[LOOPBACK_BASE_URL_ENV];
    process.env[LOOPBACK_BASE_URL_ENV] = stub.baseUrl;

    try {
      const result = await synthesizeDomainLogic(externalArtifact(), {
        cacheDir,
        providerUrl: 'http://provider.local/v1',
        model: 'qwen36-27b',
        targetKind: 'existing_repo',
        integrations: [
          {
            name: 'crm',
            kind: 'http_api',
            import: '@fixture/crm-http-api',
            methods: ['lookupAccount'],
            config_env: [LOOPBACK_BASE_URL_ENV],
          },
        ],
        generator: async () => {
          throw new Error('repo integration rendering must not call the body generator');
        },
      });

      expect(stub.ledger).toHaveLength(1);
      expect(stub.ledger[0]).toEqual(expect.objectContaining({
        method: 'POST',
        path: '/lookupAccount',
      }));
      expect(stub.ledger[0]?.body).toEqual(expect.objectContaining({
        stage: 'crm_lookup',
        requested_at: '2026-06-28T00:00:00.000Z',
      }));

      expect(result.domain_synthesis_audit?.[0]).toEqual(expect.objectContaining({
        stage: 'crm_lookup',
        archetype: 'external-adapter',
        adapter_kind: 'repo_integration',
        integration_name: 'crm',
        integration_import: '@fixture/crm-http-api',
        integration_method: 'lookupAccount',
        behavioral_gate: 'repo_integration_loopback_call',
        real_call_verified: true,
      }));

      const runStage = loadRunStage(result.stage_sources?.crm_lookup ?? '');
      const stageOutput = await runStage({
        stage: 'crm_lookup',
        payload: {},
        domain: {
          'account.id': 'acct-loopback-001',
        },
      }, {
        now: () => '2026-06-30T00:00:00.000Z',
        random: () => 0.5,
        llm: async () => {
          throw new Error('llm is not used by repo integrations');
        },
      });
      const parsedOutput = parseStageOutput(stageOutput);

      expect(stub.ledger).toHaveLength(2);
      expect(stub.ledger[1]?.body).toEqual(expect.objectContaining({
        stage: 'crm_lookup',
        requested_at: '2026-06-30T00:00:00.000Z',
      }));
      expect(parsedOutput.adapter_kind).toBe('repo_integration');
      expect(parsedOutput.result).toEqual(expect.objectContaining({
        stage: 'crm_lookup',
        status: 'connected',
        adapter_kind: 'repo_integration',
        integration: 'crm',
        method: 'lookupAccount',
        result: expect.objectContaining({
          ok: true,
          service: 'loopback-crm',
          observed_path: '/lookupAccount',
          request_stage: 'crm_lookup',
          account_id: 'acct-loopback-001',
        }),
      }));
    } finally {
      if (previousBaseUrl === undefined) {
        delete process.env[LOOPBACK_BASE_URL_ENV];
      } else {
        process.env[LOOPBACK_BASE_URL_ENV] = previousBaseUrl;
      }
      await stub.close();
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});

function externalArtifact(): SynthesizedArtifact {
  return {
    spec_yaml: 'name: loopback-crm',
    mode_names: ['intake', 'crm_lookup', 'done'],
    sha256: 'sha',
    created_at: '2026-06-30T00:00:00.000Z',
    contracts_ts: 'export interface StageInput {}; export interface StageRuntime {}; export interface StageOutput {};',
    handlers_ts: 'export const handlers = {};',
    handlers_index_ts: 'export const handlers = {};',
    tools_ts: 'export const stageActionTools = {};',
    smoke_test_ts: 'describe("generated program smoke", () => {});',
    stage_classification: [
      {
        slug: 'crm_lookup',
        archetype: 'external-adapter',
        adapter_kind: 'in_memory_mock',
        rationale: 'crm_lookup calls the crm integration',
      },
    ],
    body_stage_slugs: ['crm_lookup'],
  };
}

function loadRunStage(body: string): (input: unknown, runtime: unknown) => Promise<unknown> {
  const transpiled = ts.transpileModule(body, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
  });
  const exportsObject: Record<string, unknown> = {};
  const moduleObject = { exports: exportsObject };
  const context = createContext({
    exports: exportsObject,
    module: moduleObject,
    fetch,
    process: { env: { ...process.env } },
    URL,
  });
  new Script(transpiled.outputText, { filename: 'loopback-stage.behavior.cjs' }).runInContext(context, {
    timeout: 1_000,
  });
  const exported = moduleObject.exports as Record<string, unknown>;
  const runStage = exported.runStage ?? exportsObject.runStage;
  if (typeof runStage !== 'function') {
    throw new Error('runStage export was not callable');
  }
  return runStage as (input: unknown, runtime: unknown) => Promise<unknown>;
}

function parseStageOutput(output: unknown): {
  adapter_kind: unknown;
  result: Record<string, unknown>;
} {
  if (!isRecord(output) || typeof output.result_json !== 'string') {
    throw new Error('stage output did not include result_json');
  }
  const result = JSON.parse(output.result_json) as unknown;
  if (!isRecord(result)) {
    throw new Error('result_json did not encode an object');
  }
  return {
    adapter_kind: output.adapter_kind,
    result,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
