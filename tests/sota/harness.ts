import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { StageBodyGenerator } from '../../src/foundry-program/domain-synthesis.js';
import { runAdvisoryJudge } from './judge.js';
import type { SotaBenchmarkInput, SotaOracle } from './oracle-types.js';
import type { SotaScorecard } from './score.js';

export interface SotaExpectedTopology {
  entry_channel: string;
  stages: string[];
  final_stage: string;
  stage_archetypes: Record<string, 'pure-compute' | 'llm-reasoning' | 'external-adapter'>;
  body_stages: string[];
  llm_stages: string[];
  external_adapter_stages: string[];
}

export interface SotaBenchmarkMeta {
  slug: string;
  name: string;
  archetype_tags: string[];
  holdout: boolean;
  repair_budget: number;
  expected_topology: SotaExpectedTopology;
}

export interface SotaBenchmark {
  slug: string;
  dir: string;
  mandate: Record<string, unknown>;
  meta: SotaBenchmarkMeta;
  inputs: SotaBenchmarkInput[];
  rubric: string;
  oraclePath: string;
}

export interface LiveSynthConfig {
  providerUrl: string;
  model: string;
}

export interface RunSotaHarnessOptions {
  corpusRoot?: string;
  slugs?: string[];
  split?: 'all' | 'dev' | 'holdout';
  cacheDir: string;
  model: string;
  providerUrl: string;
  outputDir?: string;
  runId?: string;
  createdAt?: string;
  scorecardDir?: string;
  baselinePath?: string | null;
  writeBaseline?: boolean;
  generator?: StageBodyGenerator;
  advisoryJudge?: boolean;
}

const SOTA_ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CORPUS_ROOT = join(SOTA_ROOT, 'corpus');
const DEFAULT_SCORECARD_DIR = join(SOTA_ROOT, 'scorecard');
const DEFAULT_BASELINE_PATH = join(DEFAULT_SCORECARD_DIR, 'baseline-v3.5.0.json');

export async function loadSotaCorpus(corpusRoot = DEFAULT_CORPUS_ROOT): Promise<SotaBenchmark[]> {
  const entries = await readdir(corpusRoot, { withFileTypes: true });
  const benchmarks = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => loadBenchmark(join(corpusRoot, entry.name))));
  return benchmarks.sort((left, right) => left.slug.localeCompare(right.slug));
}

export async function loadOracle(benchmark: SotaBenchmark): Promise<SotaOracle> {
  const module = await import(pathToFileURL(benchmark.oraclePath).href) as Partial<SotaOracle> & { default?: Partial<SotaOracle> };
  const oracle = module.default ?? module;
  if (
    typeof oracle.expected !== 'function' ||
    typeof oracle.assertOutput !== 'function' ||
    typeof oracle.mutations !== 'function'
  ) {
    throw new Error(`oracle for ${benchmark.slug} must export expected, assertOutput, and mutations`);
  }
  return oracle as SotaOracle;
}

export function requireLiveSynthConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): LiveSynthConfig {
  if (env.PGAS_LIVE_SYNTH !== '1') {
    throw new Error('full SOTA corpus run requires PGAS_LIVE_SYNTH=1; use replay/fake generator only for hermetic tests');
  }
  if (!env.PGAS_OPENAI_BASE_URL) {
    throw new Error('PGAS_LIVE_SYNTH=1 requires PGAS_OPENAI_BASE_URL');
  }
  if (!env.PGAS_OPENAI_MODEL) {
    throw new Error('PGAS_LIVE_SYNTH=1 requires PGAS_OPENAI_MODEL');
  }
  return {
    providerUrl: env.PGAS_OPENAI_BASE_URL,
    model: env.PGAS_OPENAI_MODEL,
  };
}

export async function runSotaHarness(options: RunSotaHarnessOptions): Promise<SotaScorecard> {
  const { createScorecard, runBenchmark, writeScorecardFiles } = await import('./score.js');
  const allBenchmarks = await loadSotaCorpus(options.corpusRoot);
  const selected = selectBenchmarks(allBenchmarks, options);
  const createdAt = options.createdAt ?? new Date().toISOString();
  const runId = options.runId ?? `sota-${createdAt.replace(/[:.]/gu, '-')}`;
  const outputDir = options.outputDir ?? join(SOTA_ROOT, 'generated', runId);
  const baselinePath = options.baselinePath === undefined ? DEFAULT_BASELINE_PATH : options.baselinePath;
  const baseline = baselinePath && existsSync(baselinePath) && !options.writeBaseline
    ? await readScorecard(baselinePath)
    : null;
  const results = [];

  for (const benchmark of selected) {
    results.push(await runBenchmark(benchmark, {
      cacheDir: options.cacheDir,
      model: options.model,
      providerUrl: options.providerUrl,
      outputDir,
      keepGenerated: true,
      ...(options.generator ? { generator: options.generator } : {}),
      advisoryJudge: options.advisoryJudge
        ? (result) => runAdvisoryJudge(benchmark, result, {
            providerUrl: options.providerUrl,
            model: options.model,
          })
        : undefined,
    }));
  }

  const scorecard = createScorecard({
    run_id: runId,
    created_at: createdAt,
    model_id: options.model,
    provider_url: options.providerUrl,
    baseline_scorecard: options.writeBaseline ? null : baselinePath,
    results,
    baseline,
  });
  const scorecardDir = options.scorecardDir ?? DEFAULT_SCORECARD_DIR;
  const basename = options.writeBaseline ? 'baseline-v3.5.0' : runId;
  await writeScorecardFiles(scorecard, scorecardDir, basename);
  return scorecard;
}

async function loadBenchmark(dir: string): Promise<SotaBenchmark> {
  const mandate = await readJson<Record<string, unknown>>(join(dir, 'mandate.json'));
  const meta = await readJson<SotaBenchmarkMeta>(join(dir, 'meta.json'));
  const inputDir = join(dir, 'inputs');
  const inputEntries = await readdir(inputDir, { withFileTypes: true });
  const inputs = await Promise.all(inputEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => readJson<SotaBenchmarkInput>(join(inputDir, entry.name))));
  const rubric = await readFile(join(dir, 'rubric.md'), 'utf8');
  const oraclePath = join(dir, 'oracle.ts');
  validateBenchmark(dir, mandate, meta, inputs);
  return {
    slug: meta.slug,
    dir,
    mandate,
    meta,
    inputs,
    rubric,
    oraclePath,
  };
}

function validateBenchmark(
  dir: string,
  mandate: Record<string, unknown>,
  meta: SotaBenchmarkMeta,
  inputs: SotaBenchmarkInput[],
): void {
  if (typeof meta.slug !== 'string' || meta.slug.length === 0) {
    throw new Error(`${dir}/meta.json missing slug`);
  }
  if (!Array.isArray(meta.archetype_tags) || meta.archetype_tags.length === 0) {
    throw new Error(`${meta.slug} meta must declare archetype_tags`);
  }
  if (meta.repair_budget !== 4) {
    throw new Error(`${meta.slug} repair_budget must default to 4 for Spec 1`);
  }
  if (!Array.isArray(meta.expected_topology.stages) || meta.expected_topology.stages.length < 3) {
    throw new Error(`${meta.slug} expected_topology.stages must declare at least 3 stages`);
  }
  if (meta.expected_topology.stages.at(-1) !== meta.expected_topology.final_stage) {
    throw new Error(`${meta.slug} final_stage must be the final expected stage`);
  }
  if (mandate['program.slug'] !== meta.slug) {
    throw new Error(`${meta.slug} mandate program.slug must match meta slug`);
  }
  if (inputs.length === 0) {
    throw new Error(`${meta.slug} must include at least one input fixture`);
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

function selectBenchmarks(benchmarks: SotaBenchmark[], options: RunSotaHarnessOptions): SotaBenchmark[] {
  const slugSet = options.slugs ? new Set(options.slugs) : undefined;
  return benchmarks.filter((benchmark) => {
    if (slugSet && !slugSet.has(benchmark.slug)) return false;
    if (options.split === 'dev') return !benchmark.meta.holdout;
    if (options.split === 'holdout') return benchmark.meta.holdout;
    return true;
  });
}

async function readScorecard(path: string): Promise<SotaScorecard> {
  return JSON.parse(await readFile(path, 'utf8')) as SotaScorecard;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const replay = args.flags.has('replay');
  const live = replay ? { providerUrl: args.values.providerUrl ?? 'http://sota-replay.local/v1', model: args.values.model ?? 'sota-replay-model' } : requireLiveSynthConfig();
  const scorecard = await runSotaHarness({
    slugs: args.values.slug ? args.values.slug.split(',').filter(Boolean) : undefined,
    split: args.flags.has('holdout') ? 'holdout' : args.flags.has('dev') ? 'dev' : 'all',
    cacheDir: resolve(args.values.cacheDir ?? join(SOTA_ROOT, '.body-cache', live.model)),
    model: live.model,
    providerUrl: live.providerUrl,
    outputDir: resolve(args.values.outputDir ?? join(SOTA_ROOT, 'generated', args.values.runId ?? 'latest')),
    runId: args.values.runId,
    scorecardDir: resolve(args.values.scorecardDir ?? DEFAULT_SCORECARD_DIR),
    baselinePath: args.values.baselinePath ?? DEFAULT_BASELINE_PATH,
    writeBaseline: args.flags.has('baseline'),
    advisoryJudge: !replay && !args.flags.has('no-advisory-judge'),
    generator: replay ? replayMissGenerator : undefined,
  });
  process.stdout.write(`${JSON.stringify(scorecard.aggregate, null, 2)}\n`);
  for (const result of scorecard.benchmarks) {
    process.stdout.write(`${result.slug}: ${result.passed ? 'PASS' : 'FAIL'} ${result.failure_taxonomy ?? ''} attempts=${result.attempts_total} latency_ms=${result.latency_ms}\n`);
  }
}

function parseArgs(argv: string[]): { flags: Set<string>; values: Record<string, string> } {
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/gu, (_, char: string) => char.toUpperCase());
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags.add(key);
      continue;
    }
    values[key] = next;
    index += 1;
  }
  return { flags, values };
}

const replayMissGenerator: StageBodyGenerator = async (request) => {
  throw new Error(`replay body cache miss for stage ${request.stage}`);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
