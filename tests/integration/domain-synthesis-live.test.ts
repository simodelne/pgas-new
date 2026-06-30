import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { synthesizeDomainLogic } from '../../src/foundry-program/domain-synthesis.js';
import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import type { SynthesizedArtifact } from '../../src/foundry-program/synthesizer-store.js';
import { startLocalhostHttpApiStub } from '../fixtures/localhost-http-api.js';

const liveEnabled = process.env.PGAS_LIVE_SYNTH === '1' &&
  !!process.env.PGAS_OPENAI_BASE_URL &&
  !!process.env.PGAS_OPENAI_MODEL;

describe.skipIf(!liveEnabled)('live Qwen domain synthesis', () => {
  it('generates a non-stub runStage body through the actual synthesizeDomainLogic provider path', { timeout: 240_000 }, async () => {
    await withCache(async (cacheDir) => {
      const result = await synthesizeDomainLogic(artifactFromDomain(singleComputeDomain()), {
        cacheDir,
        providerUrl: process.env.PGAS_OPENAI_BASE_URL,
        model: process.env.PGAS_OPENAI_MODEL,
      });
      const body = expectStageSource(result, 'calculate_fee', 'pure-compute');

      expect(body).toContain('function runStage');
      expect(body).not.toContain('stage_action_stub');
      expectAstSafeStageBody(body);
      expect(result.domain_synthesis_audit?.[0]).toEqual(expect.objectContaining({
        stage: 'calculate_fee',
        archetype: 'pure-compute',
        cache_hit: false,
        behavioral_gate: 'passed',
      }));
      expect(Number(result.domain_synthesis_audit?.[0]?.attempts)).toBeGreaterThanOrEqual(1);

      emitLiveEvidence('single-stage audit', JSON.stringify(result.domain_synthesis_audit, null, 2));
      emitLiveEvidence('calculate_fee sha256', sha256(body));
      emitLiveEvidence('calculate_fee excerpt', excerpt(body));
    });
  });

  it('generates non-stub compute and external mock stage bodies for a three-archetype program', { timeout: 360_000 }, async () => {
    await withCache(async (cacheDir) => {
      const artifact = artifactFromDomain(multiArchetypeDomain());
      expect(stageKinds(artifact)).toEqual([
        ['intake', 'pure-compute'],
        ['fee_modeling', 'pure-compute'],
        ['crm_lookup', 'external-adapter'],
        ['brief_summary', 'llm-reasoning'],
        ['complete', 'pure-compute'],
      ]);

      const result = await synthesizeDomainLogic(artifact, {
        cacheDir,
        providerUrl: process.env.PGAS_OPENAI_BASE_URL,
        model: process.env.PGAS_OPENAI_MODEL,
      });
      const computeBody = expectStageSource(result, 'fee_modeling', 'pure-compute');
      const externalBody = expectStageSource(result, 'crm_lookup', 'external-adapter');

      for (const body of [computeBody, externalBody]) {
        expect(body).toContain('function runStage');
        expect(body).not.toContain('stage_action_stub');
        expectAstSafeStageBody(body);
      }
      expect(externalBody).toContain('adapter_kind');
      expect(result.domain_synthesis_audit).toEqual([
        expect.objectContaining({
          stage: 'fee_modeling',
          archetype: 'pure-compute',
          cache_hit: false,
          behavioral_gate: 'passed',
          attempts: expect.any(Number),
        }),
        expect.objectContaining({
          stage: 'crm_lookup',
          archetype: 'external-adapter',
          adapter_kind: 'in_memory_mock',
          cache_hit: false,
          behavioral_gate: 'passed',
          attempts: expect.any(Number),
        }),
      ]);
      for (const audit of result.domain_synthesis_audit ?? []) {
        expect(Number(audit.attempts)).toBeGreaterThanOrEqual(1);
      }

      emitLiveEvidence('multi-stage audit', JSON.stringify(result.domain_synthesis_audit, null, 2));
      emitLiveEvidence('fee_modeling sha256', sha256(computeBody));
      emitLiveEvidence('fee_modeling excerpt', excerpt(computeBody));
      emitLiveEvidence('crm_lookup sha256', sha256(externalBody));
      emitLiveEvidence('crm_lookup excerpt', excerpt(externalBody));
    });
  });

  it('generates a manifest-bound repo integration adapter while live synthesis remains behavioral-gated', { timeout: 360_000 }, async () => {
    await withCache(async (cacheDir) => {
      const stub = await startLocalhostHttpApiStub((entry) => ({
        ok: true,
        service: 'live-loopback-crm',
        path: entry.path,
      }));
      const previousBaseUrl = process.env.CRM_BASE_URL;
      process.env.CRM_BASE_URL = stub.baseUrl;
      const artifact = artifactFromDomain(multiArchetypeDomain(), {
        targetKind: 'existing_repo',
        integrations: [
          {
            name: 'crm',
            kind: 'http_api',
            import: '@acme/crm-client',
            factory: 'createCrmClient',
            methods: ['lookupAccount'],
            config_env: ['CRM_BASE_URL', 'CRM_TOKEN'],
          },
        ],
      });
      try {
        const result = await synthesizeDomainLogic(artifact, {
          cacheDir,
          providerUrl: process.env.PGAS_OPENAI_BASE_URL,
          model: process.env.PGAS_OPENAI_MODEL,
          targetKind: 'existing_repo',
          integrations: [
            {
              name: 'crm',
              kind: 'http_api',
              import: '@acme/crm-client',
              factory: 'createCrmClient',
              methods: ['lookupAccount'],
              config_env: ['CRM_BASE_URL', 'CRM_TOKEN'],
            },
          ],
        });
        const externalBody = expectStageSource(result, 'crm_lookup', 'external-adapter');

        expect(externalBody).toContain("process.env['CRM_BASE_URL']");
        expect(externalBody).toContain('fetch(endpoint');
        expect(externalBody).toContain('lookupAccount');
        expect(externalBody).toContain("adapter_kind: 'repo_integration'");
        expectAstSafeStageBody(externalBody, undefined, { allowFetch: true });
        expect(stub.ledger).toHaveLength(1);
        expect(result.domain_synthesis_audit).toContainEqual(expect.objectContaining({
          stage: 'crm_lookup',
          archetype: 'external-adapter',
          adapter_kind: 'repo_integration',
          integration_name: 'crm',
          behavioral_gate: 'repo_integration_loopback_call',
          real_call_verified: true,
        }));

        emitLiveEvidence('repo integration audit', JSON.stringify(result.domain_synthesis_audit, null, 2));
        emitLiveEvidence('crm_lookup repo_integration sha256', sha256(externalBody));
        emitLiveEvidence('crm_lookup repo_integration excerpt', excerpt(externalBody));
      } finally {
        if (previousBaseUrl === undefined) {
          delete process.env.CRM_BASE_URL;
        } else {
          process.env.CRM_BASE_URL = previousBaseUrl;
        }
        await stub.close();
      }
    });
  });
});

function singleComputeDomain(): Record<string, unknown> {
  return {
    'program.slug': 'fee-calculator',
    'program.name': 'Fee Calculator',
    'program.target_dir': '/tmp/fee-calculator',
    'program.design_path': 'design',
    'intake.purpose': 'Calculate a deterministic project fee from intake facts.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      { slug: 'calculate_fee' },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'calculate_fee', trigger: 'started', guard_field: 'intake.started' },
      { from: 'calculate_fee', to: 'complete', trigger: 'calculated', guard_field: 'calculate_fee.ready' },
    ]),
    'intake.delegation_json': JSON.stringify({}),
    'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'calculate_fee.ready' }),
  };
}

function multiArchetypeDomain(): Record<string, unknown> {
  return {
    'program.slug': 'proposal-ops-live',
    'program.name': 'Proposal Ops Live',
    'program.target_dir': '/tmp/proposal-ops-live',
    'program.design_path': 'design',
    'intake.purpose': 'Calculate proposal fees, lookup a CRM account through a mock adapter, summarize the brief, and close.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      { slug: 'fee_modeling' },
      { slug: 'crm_lookup' },
      { slug: 'brief_summary' },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'fee_modeling', trigger: 'started', guard_field: 'intake.started' },
      { from: 'fee_modeling', to: 'crm_lookup', trigger: 'modeled', guard_field: 'fee_modeling.ready' },
      { from: 'crm_lookup', to: 'brief_summary', trigger: 'looked_up', guard_field: 'crm_lookup.ready' },
      { from: 'brief_summary', to: 'complete', trigger: 'summarized', guard_field: 'brief_summary.done' },
    ]),
    'intake.delegation_json': JSON.stringify({
      crm_lookup: {
        service: 'crm',
        adapter: 'in-memory mock account lookup',
      },
    }),
    'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'brief_summary.done' }),
  };
}

function artifactFromDomain(
  domain: Record<string, unknown>,
  options: Parameters<typeof synthesizeProgramSpecFromDomain>[1] = {},
): SynthesizedArtifact {
  return {
    ...synthesizeProgramSpecFromDomain(domain, options),
    created_at: '2026-06-28T00:00:00.000Z',
  };
}

async function withCache<T>(fn: (cacheDir: string) => Promise<T>): Promise<T> {
  const cacheDir = mkdtempSync(join(tmpdir(), 'pgas-live-domain-synthesis-'));
  try {
    return await fn(cacheDir);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

function expectStageSource(
  artifact: SynthesizedArtifact,
  stage: string,
  archetype: 'pure-compute' | 'external-adapter',
): string {
  const body = artifact.stage_sources?.[stage];
  expect(body, `${stage} source should be generated`).toEqual(expect.any(String));
  expect(artifact.domain_synthesis_audit).toContainEqual(expect.objectContaining({
    stage,
    archetype,
    cache_hit: false,
  }));
  return body as string;
}

function stageKinds(artifact: SynthesizedArtifact): Array<[string, string]> {
  return artifact.stage_classification.map((stage) => {
    const record = stage as { slug: string; archetype: string };
    return [record.slug, record.archetype];
  });
}

function expectAstSafeStageBody(
  body: string,
  allowedIntegrationImport?: string,
  options: { allowFetch?: boolean } = {},
): void {
  const source = ts.createSourceFile('stage.ts', body, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const banned: string[] = [];
  const allowedImports = new Set(['../contracts.js']);
  if (allowedIntegrationImport) {
    allowedImports.add(allowedIntegrationImport);
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (!allowedImports.has(specifier)) {
        banned.push(`import:${specifier}`);
      }
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        banned.push('dynamic-import');
      }
      if (ts.isIdentifier(node.expression) && ['eval', 'require'].includes(node.expression.text)) {
        banned.push(node.expression.text);
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === 'fetch' && !options.allowFetch) {
        banned.push(node.expression.text);
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') {
      banned.push('Function');
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'process' &&
      node.expression.name.text === 'env'
    ) {
      banned.push('process.env');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(banned).toEqual([]);
}

function excerpt(body: string): string {
  return body.split('\n').slice(0, 14).join('\n');
}

function sha256(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function emitLiveEvidence(label: string, value: string): void {
  process.stderr.write(`[pgas-live] ${label}:\n${value}\n`);
}
