import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTestHarness, type TestHarnessAuthorResponse } from '@simodelne/pgas-server/testing.js';
import { synthesizeDomainLogic, type DomainSynthesisOptions } from '../../src/foundry-program/domain-synthesis.js';
import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import type { SynthesizedArtifact } from '../../src/foundry-program/synthesizer-store.js';
import { renderStandaloneScaffold } from '../../src/pgas-new/template-renderer.js';
import { findExecutedPathStubMarkers } from '../../src/pgas-new/verify.js';
import { loadOracle, type SotaBenchmark } from './harness.js';
import type { SotaBenchmarkInput, SotaFunctionalActual, SotaStageActual } from './oracle-types.js';

export type SotaGateName = 'typecheck' | 'smoke' | 'behavioral' | 'functional_oracle';
export type SotaGateStatus = 'pass' | 'fail';
export type SotaFailureTaxonomy =
  | 'typecheck'
  | 'smoke'
  | 'behavioral'
  | 'functional-oracle'
  | 'hardfail-exhausted';

export interface SotaGateResult {
  status: SotaGateStatus;
  duration_ms: number;
  stdout_excerpt?: string;
  stderr_excerpt?: string;
}

export interface SotaBenchmarkResult {
  slug: string;
  holdout: boolean;
  archetype_tags: string[];
  passed: boolean;
  failure_taxonomy: SotaFailureTaxonomy | null;
  gates: Record<SotaGateName, SotaGateResult>;
  attempts_total: number;
  stage_attempts: Record<string, number>;
  cache_hits: Record<string, boolean>;
  latency_ms: number;
  body_hashes: Record<string, string>;
  prompt_hash: string;
  scorecard_path: string | null;
  advisory_judge: AdvisoryJudgeResult | null;
}

export interface AdvisoryJudgeResult {
  status: 'pass' | 'error';
  model_id: string;
  rubric_scores?: Record<string, number>;
  summary?: string;
  error?: string;
  latency_ms: number;
}

export interface SotaScorecard {
  schema_version: 1;
  run_id: string;
  created_at: string;
  model_id: string;
  provider_url: string;
  prompt_hash: string;
  baseline_scorecard: string | null;
  aggregate: SotaAggregate;
  benchmarks: SotaBenchmarkResult[];
  baseline_vs_v3_5_0: BaselineComparison | null;
}

export interface SotaAggregate {
  total: number;
  passed: number;
  failed: number;
  pass_at_1: number;
  task_success_rate: number;
  attempts_total: number;
  latency_ms: number;
  holdout: SotaSplitAggregate;
  dev: SotaSplitAggregate;
  failure_taxonomy: Partial<Record<SotaFailureTaxonomy, number>>;
}

export interface SotaSplitAggregate {
  total: number;
  passed: number;
  task_success_rate: number;
}

export interface BaselineComparison {
  baseline_task_success_rate: number;
  current_task_success_rate: number;
  delta_task_success_rate: number;
  regressions: string[];
}

export interface CreateScorecardInput {
  run_id: string;
  created_at: string;
  model_id: string;
  provider_url: string;
  prompt_hash?: string;
  baseline_scorecard?: string | null;
  results: SotaBenchmarkResult[];
  baseline?: SotaScorecard | null;
}

export interface RunBenchmarkOptions {
  cacheDir: string;
  model: string;
  providerUrl: string;
  outputDir?: string;
  generator?: DomainSynthesisOptions['generator'];
  keepGenerated?: boolean;
  advisoryJudge?: (result: SotaBenchmarkResult) => Promise<AdvisoryJudgeResult | null>;
}

const EMPTY_GATE: SotaGateResult = { status: 'fail', duration_ms: 0 };
const COMMAND_TIMEOUT_MS = 120_000;

export async function runBenchmark(
  benchmark: SotaBenchmark,
  options: RunBenchmarkOptions,
): Promise<SotaBenchmarkResult> {
  const started = Date.now();
  const promptHash = sha256(JSON.stringify(benchmark.mandate));
  let targetDir: string | undefined;

  try {
    const artifact = await synthesizeBenchmarkArtifact(benchmark, options);
    const stageAttempts = attemptsByStage(artifact);
    const cacheHits = cacheHitsByStage(artifact);
    const bodyHashes = bodyHashesFor(artifact);
    targetDir = await renderBenchmark(benchmark, artifact, options.outputDir);

    const typecheck = await runTypecheck(targetDir);
    const smoke = typecheck.status === 'pass'
      ? await runGeneratedSmoke(targetDir)
      : { ...EMPTY_GATE, stderr_excerpt: 'not run because typecheck failed' };
    const behavioral = behavioralGate(artifact);
    const functional = typecheck.status === 'pass'
      ? await functionalOracleGate(benchmark, targetDir)
      : { ...EMPTY_GATE, stderr_excerpt: 'not run because typecheck failed' };

    const gates = { typecheck, smoke, behavioral, functional_oracle: functional };
    const failureTaxonomy = failureTaxonomyFor(gates);
    const result: SotaBenchmarkResult = {
      slug: benchmark.slug,
      holdout: benchmark.meta.holdout,
      archetype_tags: benchmark.meta.archetype_tags,
      passed: failureTaxonomy === null,
      failure_taxonomy: failureTaxonomy,
      gates,
      attempts_total: Object.values(stageAttempts).reduce((sum, value) => sum + value, 0),
      stage_attempts: stageAttempts,
      cache_hits: cacheHits,
      latency_ms: Date.now() - started,
      body_hashes: bodyHashes,
      prompt_hash: promptHash,
      scorecard_path: null,
      advisory_judge: null,
    };
    result.advisory_judge = options.advisoryJudge ? await options.advisoryJudge(result) : null;
    return result;
  } catch (error) {
    return hardFailResult(benchmark, promptHash, Date.now() - started, error);
  } finally {
    if (targetDir && !options.keepGenerated && !options.outputDir) {
      rmSync(targetDir, { recursive: true, force: true });
    }
  }
}

export function createScorecard(input: CreateScorecardInput): SotaScorecard {
  const aggregate = aggregateResults(input.results);
  const promptHash = input.prompt_hash ?? sha256(input.results.map((result) => result.prompt_hash).join('\n'));
  return {
    schema_version: 1,
    run_id: input.run_id,
    created_at: input.created_at,
    model_id: input.model_id,
    provider_url: input.provider_url,
    prompt_hash: promptHash,
    baseline_scorecard: input.baseline_scorecard ?? null,
    aggregate,
    benchmarks: input.results,
    baseline_vs_v3_5_0: input.baseline ? compareBaseline(input.baseline, input.results, aggregate) : null,
  };
}

export function validateScorecard(value: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ['scorecard must be an object'] };
  }
  requireField(value, 'schema_version', 'number', errors);
  requireField(value, 'run_id', 'string', errors);
  requireField(value, 'created_at', 'string', errors);
  requireField(value, 'model_id', 'string', errors);
  requireField(value, 'provider_url', 'string', errors);
  requireField(value, 'prompt_hash', 'string', errors);
  if (!isRecord(value.aggregate)) {
    errors.push('aggregate must be an object');
  }
  if (!Array.isArray(value.benchmarks)) {
    errors.push('benchmarks must be an array');
  } else {
    for (const [index, benchmark] of value.benchmarks.entries()) {
      if (!isRecord(benchmark)) {
        errors.push(`benchmarks[${index}] must be an object`);
        continue;
      }
      requireField(benchmark, 'slug', 'string', errors, `benchmarks[${index}].`);
      if (!isRecord(benchmark.gates)) {
        errors.push(`benchmarks[${index}].gates must be an object`);
        continue;
      }
      for (const gate of ['typecheck', 'smoke', 'behavioral', 'functional_oracle'] as const) {
        if (!isRecord(benchmark.gates[gate])) {
          errors.push(`benchmarks[${index}].gates.${gate} must be an object`);
        } else if (benchmark.gates[gate].status !== 'pass' && benchmark.gates[gate].status !== 'fail') {
          errors.push(`benchmarks[${index}].gates.${gate}.status must be pass or fail`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export async function writeScorecardFiles(scorecard: SotaScorecard, outDir: string, basename: string): Promise<{ jsonPath: string; markdownPath: string }> {
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, `${basename}.json`);
  const markdownPath = join(outDir, `${basename}.md`);
  await writeFile(jsonPath, `${JSON.stringify(scorecard, null, 2)}\n`);
  await writeFile(markdownPath, renderScorecardMarkdown(scorecard));
  return { jsonPath, markdownPath };
}

async function synthesizeBenchmarkArtifact(
  benchmark: SotaBenchmark,
  options: RunBenchmarkOptions,
): Promise<SynthesizedArtifact> {
  const spec = synthesizeProgramSpecFromDomain(benchmark.mandate);
  return synthesizeDomainLogic(
    {
      ...spec,
      created_at: new Date(0).toISOString(),
    },
    {
      cacheDir: options.cacheDir,
      maxAttempts: benchmark.meta.repair_budget,
      providerUrl: options.providerUrl,
      model: options.model,
      ...(options.generator ? { generator: options.generator } : {}),
    },
  );
}

async function renderBenchmark(
  benchmark: SotaBenchmark,
  artifact: SynthesizedArtifact,
  outputDir: string | undefined,
): Promise<string> {
  const parent = outputDir ?? tmpdir();
  mkdirSync(parent, { recursive: true });
  const targetDir = await mkdtemp(join(parent, `pgas-sota-${benchmark.slug}-`));
  renderStandaloneScaffold({
    slug: String(benchmark.mandate['program.slug']),
    name: String(benchmark.mandate['program.name']),
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
  return targetDir;
}

async function runTypecheck(targetDir: string): Promise<SotaGateResult> {
  writeFileSync(join(targetDir, 'tsconfig.sota-typecheck.json'), JSON.stringify({
    extends: './tsconfig.json',
    include: ['src/programs/**/*.ts', 'tests/generated-program-smoke.test.ts'],
  }, null, 2));
  const tscBin = join(process.cwd(), 'node_modules/typescript/bin/tsc');
  return runCommand(process.execPath, [tscBin, '-p', 'tsconfig.sota-typecheck.json'], targetDir, COMMAND_TIMEOUT_MS);
}

async function runGeneratedSmoke(targetDir: string): Promise<SotaGateResult> {
  writeFileSync(join(targetDir, 'vitest.sota-smoke.config.ts'), [
    "import { defineConfig } from 'vitest/config';",
    '',
    'export default defineConfig({',
    "  test: { include: ['tests/generated-program-smoke.test.ts'] },",
    '});',
    '',
  ].join('\n'));
  const vitestBin = join(process.cwd(), 'node_modules/vitest/vitest.mjs');
  return runCommand(process.execPath, [vitestBin, 'run', '--config', 'vitest.sota-smoke.config.ts'], targetDir, COMMAND_TIMEOUT_MS);
}

async function functionalOracleGate(benchmark: SotaBenchmark, targetDir: string): Promise<SotaGateResult> {
  const started = Date.now();
  try {
    const oracle = await loadOracle(benchmark);
    for (const input of benchmark.inputs) {
      const actual = await runFixtureThroughProgram(benchmark, targetDir, input);
      const findings = findExecutedPathStubMarkers(actual.domain);
      if (findings.length > 0) {
        throw new Error(`executed state contains stub markers: ${findings.map((finding) => `${finding.path}:${finding.marker}`).join(', ')}`);
      }
      oracle.assertOutput(input, actual);
    }
    return { status: 'pass', duration_ms: Date.now() - started };
  } catch (error) {
    return {
      status: 'fail',
      duration_ms: Date.now() - started,
      stderr_excerpt: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runFixtureThroughProgram(
  benchmark: SotaBenchmark,
  targetDir: string,
  input: SotaBenchmarkInput,
): Promise<SotaFunctionalActual> {
  const slug = String(benchmark.mandate['program.slug']);
  const exportName = `create${toPascalCase(slug)}ProgramEntry`;
  const registrationPath = join(targetDir, 'src/programs', slug, 'registration.ts');
  const registration = await import(pathToFileURL(registrationPath).href) as Record<string, unknown>;
  const createEntry = registration[exportName];
  if (typeof createEntry !== 'function') {
    throw new Error(`generated registration missing ${exportName}`);
  }

  const actions = pathActionsFor(benchmark);
  let callIndex = 0;
  const harness = await createTestHarness(createEntry(), {
    programName: slug,
    defaultChannel: benchmark.meta.expected_topology.entry_channel,
    author: (() => {
      const action = actions[callIndex];
      callIndex += 1;
      if (!action) {
        throw new Error(`no scripted action for call ${callIndex - 1}`);
      }
      return effect(action.name, channelForAction(action.name), payloadForAction(benchmark, input, action.source));
    }) satisfies TestHarnessAuthorResponse,
  });

  try {
    for (const [index] of actions.entries()) {
      await harness.trigger(index === 0
        ? { channel: benchmark.meta.expected_topology.entry_channel, payload: input.prompt }
        : 'continue');
    }
    const snapshot = await harness.snapshot();
    return {
      final_stage: snapshot.mode,
      domain: snapshot.domain,
      stages: collectStageOutputs(benchmark, snapshot.domain),
    };
  } finally {
    await harness.close();
  }
}

function pathActionsFor(benchmark: SotaBenchmark): Array<{ name: string; source: string; target: string }> {
  const stages = benchmark.meta.expected_topology.stages;
  return stages.slice(0, -1).map((source, index) => ({
    source,
    target: stages[index + 1] as string,
    name: index === 0 ? 'begin_work' : `complete_${source}`,
  }));
}

function payloadForAction(
  benchmark: SotaBenchmark,
  input: SotaBenchmarkInput,
  source: string,
): Record<string, unknown> {
  const archetype = benchmark.meta.expected_topology.stage_archetypes[source];
  if (archetype === 'llm-reasoning') {
    const output = input.llm_outputs?.[source];
    if (!output) {
      throw new Error(`input ${input.id} missing llm_outputs.${source}`);
    }
    return output;
  }
  return {
    __stage_runtime: {
      now_iso: input.runtime?.now_iso ?? '2026-06-29T00:00:00.000Z',
      random: input.runtime?.random ?? 0.5,
    },
  };
}

function collectStageOutputs(benchmark: SotaBenchmark, domain: Record<string, unknown>): Record<string, SotaStageActual> {
  const outputs: Record<string, SotaStageActual> = {};
  for (const stage of benchmark.meta.expected_topology.stages.slice(1, -1)) {
    const archetype = benchmark.meta.expected_topology.stage_archetypes[stage];
    if (archetype === 'llm-reasoning') {
      const resultJson = stringField(domain, `${stage}.result_json`);
      const itemsJson = stringField(domain, `${stage}.items_json`);
      outputs[stage] = parsedStageOutput(stage, { result_json: resultJson, items_json: itemsJson });
      continue;
    }
    const raw = domain[`${stage}.output`];
    if (!isRecord(raw)) {
      throw new Error(`missing generated output for stage ${stage}`);
    }
    outputs[stage] = parsedStageOutput(stage, raw);
  }
  return outputs;
}

function parsedStageOutput(stage: string, raw: Record<string, unknown>): SotaStageActual {
  const resultJson = typeof raw.result_json === 'string' ? raw.result_json : '';
  const itemsJson = typeof raw.items_json === 'string' ? raw.items_json : '';
  if (!resultJson || !itemsJson) {
    throw new Error(`stage ${stage} did not expose result_json and items_json`);
  }
  return {
    stage,
    result: JSON.parse(resultJson) as Record<string, unknown>,
    items: JSON.parse(itemsJson) as unknown[],
    raw: {
      result_json: resultJson,
      items_json: itemsJson,
      ...(typeof raw.digest === 'string' ? { digest: raw.digest } : {}),
      ...(typeof raw.adapter_kind === 'string' ? { adapter_kind: raw.adapter_kind } : {}),
    },
  };
}

function behavioralGate(artifact: SynthesizedArtifact): SotaGateResult {
  const started = Date.now();
  const audit = artifact.domain_synthesis_audit ?? [];
  const failures = audit.filter((entry) => {
    const gate = entry.behavioral_gate;
    return gate !== 'passed' && gate !== 'repo_integration_static_call';
  });
  return failures.length === 0
    ? { status: 'pass', duration_ms: Date.now() - started }
    : {
        status: 'fail',
        duration_ms: Date.now() - started,
        stderr_excerpt: JSON.stringify(failures),
      };
}

function runCommand(command: string, args: string[], cwd: string, timeoutMs: number): Promise<SotaGateResult> {
  const started = Date.now();
  return new Promise((resolveResult) => {
    execFile(command, args, {
      cwd,
      timeout: timeoutMs,
      env: { ...process.env, CI: '1' },
    }, (error, stdout, stderr) => {
      resolveResult({
        status: error ? 'fail' : 'pass',
        duration_ms: Date.now() - started,
        stdout_excerpt: excerpt(stdout),
        stderr_excerpt: excerpt(stderr || (error instanceof Error ? error.message : '')),
      });
    });
  });
}

function hardFailResult(
  benchmark: SotaBenchmark,
  promptHash: string,
  latencyMs: number,
  error: unknown,
): SotaBenchmarkResult {
  const message = error instanceof Error ? error.message : String(error);
  const gate = { ...EMPTY_GATE, stderr_excerpt: message };
  return {
    slug: benchmark.slug,
    holdout: benchmark.meta.holdout,
    archetype_tags: benchmark.meta.archetype_tags,
    passed: false,
    failure_taxonomy: 'hardfail-exhausted',
    gates: {
      typecheck: gate,
      smoke: gate,
      behavioral: gate,
      functional_oracle: gate,
    },
    attempts_total: benchmark.meta.repair_budget,
    stage_attempts: {},
    cache_hits: {},
    latency_ms: latencyMs,
    body_hashes: {},
    prompt_hash: promptHash,
    scorecard_path: null,
    advisory_judge: null,
  };
}

function failureTaxonomyFor(gates: Record<SotaGateName, SotaGateResult>): SotaFailureTaxonomy | null {
  if (gates.typecheck.status === 'fail') return 'typecheck';
  if (gates.smoke.status === 'fail') return 'smoke';
  if (gates.behavioral.status === 'fail') return 'behavioral';
  if (gates.functional_oracle.status === 'fail') return 'functional-oracle';
  return null;
}

function aggregateResults(results: SotaBenchmarkResult[]): SotaAggregate {
  const passed = results.filter((result) => result.passed).length;
  const failures = results.reduce<Partial<Record<SotaFailureTaxonomy, number>>>((acc, result) => {
    if (result.failure_taxonomy) {
      acc[result.failure_taxonomy] = (acc[result.failure_taxonomy] ?? 0) + 1;
    }
    return acc;
  }, {});
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    pass_at_1: ratio(passed, results.length),
    task_success_rate: ratio(passed, results.length),
    attempts_total: results.reduce((sum, result) => sum + result.attempts_total, 0),
    latency_ms: results.reduce((sum, result) => sum + result.latency_ms, 0),
    holdout: splitAggregate(results.filter((result) => result.holdout)),
    dev: splitAggregate(results.filter((result) => !result.holdout)),
    failure_taxonomy: failures,
  };
}

function splitAggregate(results: SotaBenchmarkResult[]): SotaSplitAggregate {
  const passed = results.filter((result) => result.passed).length;
  return {
    total: results.length,
    passed,
    task_success_rate: ratio(passed, results.length),
  };
}

function compareBaseline(
  baseline: SotaScorecard,
  results: SotaBenchmarkResult[],
  aggregate: SotaAggregate,
): BaselineComparison {
  const baselineBySlug = new Map(baseline.benchmarks.map((result) => [result.slug, result]));
  const regressions = results
    .filter((result) => baselineBySlug.get(result.slug)?.passed === true && !result.passed)
    .map((result) => result.slug);
  return {
    baseline_task_success_rate: baseline.aggregate.task_success_rate,
    current_task_success_rate: aggregate.task_success_rate,
    delta_task_success_rate: aggregate.task_success_rate - baseline.aggregate.task_success_rate,
    regressions,
  };
}

function attemptsByStage(artifact: SynthesizedArtifact): Record<string, number> {
  return Object.fromEntries((artifact.domain_synthesis_audit ?? []).map((entry) => [
    String(entry.stage),
    typeof entry.attempts === 'number' ? entry.attempts : Number(entry.attempts ?? 0),
  ]));
}

function cacheHitsByStage(artifact: SynthesizedArtifact): Record<string, boolean> {
  return Object.fromEntries((artifact.domain_synthesis_audit ?? []).map((entry) => [
    String(entry.stage),
    entry.cache_hit === true,
  ]));
}

function bodyHashesFor(artifact: SynthesizedArtifact): Record<string, string> {
  return Object.fromEntries(Object.entries(artifact.stage_sources ?? {}).map(([stage, body]) => [stage, sha256(body)]));
}

function linkRootNodeModules(targetDir: string): void {
  const rootNodeModules = resolve(process.cwd(), 'node_modules');
  const targetNodeModules = join(targetDir, 'node_modules');
  if (existsSync(rootNodeModules) && !existsSync(targetNodeModules)) {
    symlinkSync(rootNodeModules, targetNodeModules, 'dir');
  }
}

function effect(name: string, channel: string, payload: Record<string, unknown>): Record<string, unknown> {
  return { actions: [{ kind: 'EffectAction', name, channel, payload }] };
}

function channelForAction(name: string): string {
  return name === 'begin_work' ? 'widget_output' : 'stage_output';
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new Error(`missing string field ${key}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireField(
  value: Record<string, unknown>,
  key: string,
  type: 'string' | 'number',
  errors: string[],
  prefix = '',
): void {
  if (typeof value[key] !== type) {
    errors.push(`${prefix}${key} must be ${type}`);
  }
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));
}

function excerpt(value: string): string {
  return value.length > 4000 ? value.slice(-4000) : value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function toPascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join('');
}

function renderScorecardMarkdown(scorecard: SotaScorecard): string {
  const lines = [
    `# SOTA Scorecard ${scorecard.run_id}`,
    '',
    `- Model: ${scorecard.model_id}`,
    `- Provider: ${scorecard.provider_url}`,
    `- pass@1: ${scorecard.aggregate.pass_at_1}`,
    `- task success rate: ${scorecard.aggregate.task_success_rate}`,
    `- holdout: ${scorecard.aggregate.holdout.passed}/${scorecard.aggregate.holdout.total}`,
    `- dev: ${scorecard.aggregate.dev.passed}/${scorecard.aggregate.dev.total}`,
    '',
    '| Benchmark | Split | Passed | Failure | Attempts | Latency ms |',
    '|---|---:|---:|---|---:|---:|',
  ];
  for (const result of scorecard.benchmarks) {
    lines.push([
      result.slug,
      result.holdout ? 'holdout' : 'dev',
      result.passed ? 'yes' : 'no',
      result.failure_taxonomy ?? '',
      String(result.attempts_total),
      String(result.latency_ms),
    ].join(' | ').replace(/^/u, '| ').replace(/$/u, ' |'));
  }
  return `${lines.join('\n')}\n`;
}
