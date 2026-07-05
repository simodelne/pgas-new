/**
 * Generated-program LIVE drive gate (env-gated, mirrors foundry-live-graduation):
 *
 * The hermetic smoke rung (generated-multistage-smoke.test.ts) drives a
 * generated program to `complete` with SCRIPTED authorResponses and a canned
 * reasoning-contract example. This test closes that gap: it synthesizes the
 * same multi-archetype proposal-ops domain with the REAL provider
 * (PGAS_REASONING_CONTRACT_REQUIRE_LLM=1 — no deterministic contract
 * fallback), renders the standalone scaffold, boots it on a real engine, and
 * drives it to `complete` with the REAL provider making every per-stage and
 * reasoning decision. Provider traffic is counted through an in-process proxy
 * so a canned-fallback pass cannot masquerade as live.
 */
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { synthesizeDomainLogic } from '../../src/foundry-program/domain-synthesis.js';
import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import type { SynthesizedArtifact } from '../../src/foundry-program/synthesizer-store.js';
import type { ReasoningField } from '../../src/foundry-program/reasoning-contract.js';
import { driveGeneratedProgramLive } from '../../src/pgas-new/generated-live-drive.js';
import { renderStandaloneScaffold } from '../../src/pgas-new/template-renderer.js';
import { assertNoExecutedPathStubs } from '../../src/pgas-new/verify.js';

const LIVE_DRIVE_ENABLED = process.env.PGAS_LIVE_GRADUATION === '1';
const liveIt = LIVE_DRIVE_ENABLED ? it : it.skip;
const LIVE_TIMEOUT_MS = Number(process.env.PGAS_LIVE_GRADUATION_TIMEOUT_MS ?? '1800000');

const SLUG = 'proposal-ops';
const REASONING_STAGE = 'brief_summary';
const REASONING_ACTION = 'complete_brief_summary';

// Same representative multi-archetype domain shape as the hermetic smoke test:
// pure-compute (intake, fee_modeling) + external-adapter (crm_lookup) +
// llm-reasoning (brief_summary) + terminal (complete).
const multiStageDomain = {
  'program.slug': SLUG,
  'program.name': 'Proposal Ops',
  'program.target_dir': '/tmp/proposal-ops',
  'program.design_path': 'design',
  'intake.purpose': 'Calculate proposal fees, lookup a CRM account, summarize the brief, and close the proposal workflow.',
  'intake.entry_channel': 'user_text',
  'intake.stages_json': JSON.stringify([
    { slug: 'intake', is_bootstrap: true },
    { slug: 'fee_modeling' },
    { slug: 'crm_lookup' },
    { slug: REASONING_STAGE },
    { slug: 'complete', is_terminal: true },
  ]),
  'intake.transitions_json': JSON.stringify([
    { from: 'intake', to: 'fee_modeling', trigger: 'started', guard_field: 'intake.started' },
    { from: 'fee_modeling', to: 'crm_lookup', trigger: 'modeled', guard_field: 'fee_modeling.ready' },
    { from: 'crm_lookup', to: REASONING_STAGE, trigger: 'looked_up', guard_field: 'crm_lookup.ready' },
    { from: REASONING_STAGE, to: 'complete', trigger: 'summarized', guard_field: 'brief_summary.done' },
  ]),
  'intake.delegation_json': JSON.stringify({
    crm_lookup: {
      service: 'crm',
      adapter: 'in-memory mock account lookup',
    },
  }),
  'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'brief_summary.done' }),
};

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('generated program live drive gate', () => {
  liveIt('drives a freshly generated program to complete with the REAL provider making the reasoning decisions', { timeout: LIVE_TIMEOUT_MS }, async () => {
    const env = requireLiveDriveEnv();
    const cacheDir = trackedTempRoot('pgas-new-live-drive-cache-');
    const targetDir = trackedTempRoot('pgas-new-live-drive-render-');

    // Phase 1 — LIVE synthesis. PGAS_REASONING_CONTRACT_REQUIRE_LLM=1 forbids
    // the deterministic fallback contract: synthesis THROWS unless the real
    // meta-LLM produced the reasoning contract.
    const artifact = await withRequiredLlmContract(() =>
      synthesizeDomainLogic(artifactFromDomain(multiStageDomain), {
        cacheDir,
        providerUrl: env.baseUrl,
        model: env.model,
      }));

    const reasoningAudit = artifact.domain_synthesis_audit?.find(
      (entry) => isRecord(entry) && entry.stage === REASONING_STAGE,
    ) as Record<string, unknown> | undefined;
    expect(reasoningAudit, 'reasoning stage audit entry').toBeTruthy();
    // Live-marker #1: the reasoning contract itself came from the meta-LLM.
    expect(reasoningAudit?.contract_source).toBe('meta_llm');

    const contract = reasoningContractFromStageSource(artifact);
    const contractFields = contract.result_schema.fields;
    expect(contractFields.length).toBeGreaterThanOrEqual(3);

    // Phase 2 — render the standalone scaffold exactly as branch_write does.
    renderStandaloneScaffold({
      slug: SLUG,
      name: 'Proposal Ops',
      outDir: targetDir,
      synthesizedSpecYaml: artifact.spec_yaml,
      synthesizedContractsTs: artifact.contracts_ts,
      synthesizedHandlersTs: artifact.handlers_ts,
      synthesizedHandlersIndexTs: artifact.handlers_index_ts,
      synthesizedStageSources: artifact.stage_sources,
      synthesizedToolsTs: artifact.tools_ts,
      synthesizedSmokeTestTs: artifact.smoke_test_ts,
    });
    linkRootNodeModules(targetDir);

    // Phase 3 — LIVE drive: real engine, real provider, no scripted responses.
    const drive = await driveGeneratedProgramLive({
      targetDir,
      slug: SLUG,
      providerBaseUrl: env.baseUrl,
      model: env.model,
      initialText: [
        'Prepare a proposal for Meridian Analytics, an enterprise buyer requesting a',
        'compliance-dashboard build. The board needs a decision-ready summary within',
        'two weeks; budget is value-conscious and assumptions must be transparent.',
        'CRM account id: acct-meridian-042.',
      ].join(' '),
      finalStage: 'complete',
      maxTriggers: 12,
      driveTimeoutMs: 900_000,
    });

    emitEvidence(drive);

    // Assertion 1 — terminal completion by the live-driven program.
    expect(drive.runner_error, `drive runner error (output tail: ${drive.runner_output_excerpt})`).toBeUndefined();
    expect(drive.final_mode).toBe('complete');
    expect(drive.terminal).toBe(true);

    // Assertion 3 — REAL-provider proof. A canned-fallback pass cannot have
    // produced (a) >= 1 successful proxied provider round trip during the
    // drive, and (b) a provider RESPONSE that emitted the reasoning-stage
    // action decision.
    expect(drive.provider_hits).toBeGreaterThanOrEqual(1);
    const reasoningResponses = drive.provider_exchanges.filter(
      (exchange) => exchange.response_status >= 200 &&
        exchange.response_status < 300 &&
        exchange.response_excerpt.includes(REASONING_ACTION),
    );
    expect(
      reasoningResponses.length,
      'at least one live provider response must emit the reasoning-stage action decision',
    ).toBeGreaterThanOrEqual(1);
    expect(drive.actions).toContain(REASONING_ACTION);

    // Assertion 2 — anti-stub scan on the final work product.
    const workProduct = reasoningWorkProduct(drive.world);
    assertNoExecutedPathStubs(workProduct);
    for (const [key, value] of Object.entries(drive.world)) {
      if (/\.(result_json|items_json)$/u.test(key)) {
        assertNoExecutedPathStubs(value);
      }
    }

    // Assertion 4 — semantic sanity: every core field the live-synthesized
    // reasoning contract declares is present and type-conformant in the
    // produced work product.
    for (const field of contractFields) {
      const value = workProduct.result[field.name];
      expect(
        fieldConforms(field, value),
        `work_product.${field.name} must be a non-empty ${field.type} (got ${JSON.stringify(value)})`,
      ).toBe(true);
    }
    expect(workProduct.items.length).toBeGreaterThanOrEqual(1);
  });
});

interface LiveDriveEnv {
  baseUrl: string;
  model: string;
}

function requireLiveDriveEnv(): LiveDriveEnv {
  if (process.env.PGAS_LIVE_GRADUATION !== '1') {
    throw new Error('PGAS_LIVE_GRADUATION=1 is required for the generated live drive');
  }
  const baseUrl = process.env.PGAS_OPENAI_BASE_URL?.trim();
  const model = process.env.PGAS_OPENAI_MODEL?.trim();
  if (!baseUrl) {
    throw new Error('PGAS_LIVE_GRADUATION=1 requires PGAS_OPENAI_BASE_URL');
  }
  if (!model) {
    throw new Error('PGAS_LIVE_GRADUATION=1 requires PGAS_OPENAI_MODEL');
  }
  return { baseUrl, model };
}

async function withRequiredLlmContract<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.PGAS_REASONING_CONTRACT_REQUIRE_LLM;
  process.env.PGAS_REASONING_CONTRACT_REQUIRE_LLM = '1';
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.PGAS_REASONING_CONTRACT_REQUIRE_LLM;
    } else {
      process.env.PGAS_REASONING_CONTRACT_REQUIRE_LLM = previous;
    }
  }
}

function artifactFromDomain(domain: Record<string, unknown>): SynthesizedArtifact {
  return {
    ...synthesizeProgramSpecFromDomain(domain),
    created_at: new Date().toISOString(),
  };
}

interface ExtractedReasoningContract {
  result_schema: { fields: ReasoningField[] };
  canned_example: { result: Record<string, unknown>; items: string[] };
}

/**
 * The rendered reasoning stage source embeds the synthesized contract as
 * `export const reasoningContract = <json> as const;` — the same object the
 * generated handler enforces at runtime. Extract it for field-level checks.
 */
function reasoningContractFromStageSource(artifact: SynthesizedArtifact): ExtractedReasoningContract {
  const source = artifact.stage_sources?.[REASONING_STAGE];
  expect(source, `stage source for ${REASONING_STAGE}`).toBeTruthy();
  const match = (source as string).match(/export const reasoningContract = ([\s\S]*?) as const;/u);
  expect(match, 'reasoningContract literal in stage source').toBeTruthy();
  return JSON.parse((match as RegExpMatchArray)[1]) as ExtractedReasoningContract;
}

interface ReasoningWorkProduct {
  result: Record<string, unknown>;
  items: string[];
}

function reasoningWorkProduct(world: Record<string, unknown>): ReasoningWorkProduct {
  const resultRaw = world[`${REASONING_STAGE}.result_json`];
  const itemsRaw = world[`${REASONING_STAGE}.items_json`];
  expect(typeof resultRaw, `${REASONING_STAGE}.result_json present in world`).toBe('string');
  expect(typeof itemsRaw, `${REASONING_STAGE}.items_json present in world`).toBe('string');
  const result = JSON.parse(resultRaw as string) as Record<string, unknown>;
  const items = JSON.parse(itemsRaw as string) as string[];
  expect(isRecord(result)).toBe(true);
  expect(Array.isArray(items)).toBe(true);
  return { result, items };
}

function fieldConforms(field: ReasoningField, value: unknown): boolean {
  switch (field.type) {
    case 'string':
      return typeof value === 'string' && value.trim().length > 0;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'enum':
      return typeof value === 'string' && (field.enum_values ?? []).includes(value);
    case 'string_array': {
      // string_array rides the JSON-string-scalar pattern in typed paths but is
      // a real array inside result_json.
      const array = typeof value === 'string' ? safeJsonArray(value) : value;
      return Array.isArray(array) && array.length > 0 && array.every((item) => typeof item === 'string');
    }
    default:
      return false;
  }
}

function safeJsonArray(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function emitEvidence(drive: {
  final_mode: string | null;
  terminal: boolean;
  rounds: number;
  triggers: number;
  provider_hits: number;
  actions: string[];
  world: Record<string, unknown>;
}): void {
  const lines = [
    `[live-drive] final_mode=${String(drive.final_mode)} terminal=${String(drive.terminal)} rounds=${String(drive.rounds)} triggers=${String(drive.triggers)}`,
    `[live-drive] provider_hits=${String(drive.provider_hits)}`,
    `[live-drive] actions=${drive.actions.join(' -> ')}`,
    `[live-drive] ${REASONING_STAGE}.result_json=${String(drive.world[`${REASONING_STAGE}.result_json`] ?? '')}`,
    `[live-drive] ${REASONING_STAGE}.items_json=${String(drive.world[`${REASONING_STAGE}.items_json`] ?? '')}`,
  ];
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
}

function linkRootNodeModules(targetDir: string): void {
  const rootNodeModules = join(process.cwd(), 'node_modules');
  if (!existsSync(rootNodeModules)) {
    return;
  }
  symlinkSync(rootNodeModules, join(targetDir, 'node_modules'), 'dir');
}

function trackedTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
