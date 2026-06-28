import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import type { SynthesizedArtifact } from './synthesizer-store.js';

const SYNTHESIS_VERSION = 'foundry-domain-synthesis-v1';

export interface StageBodyRequest {
  stage: string;
  archetype: 'pure-compute' | 'external-adapter';
  contract: string;
  prompt: string;
  repair?: {
    attempt: number;
    lastError: string;
  };
}

export interface StageBodyGenerator {
  (request: StageBodyRequest): Promise<string>;
}

export interface DomainSynthesisOptions {
  generator?: StageBodyGenerator;
  cacheDir?: string;
  maxAttempts?: number;
  providerUrl?: string;
  model?: string;
}

interface StageClassification {
  slug: string;
  archetype: string;
  adapter_kind?: string;
}

interface CacheRecord {
  body: string;
  body_hash: string;
}

export async function synthesizeDomainLogic(
  artifact: SynthesizedArtifact,
  options: DomainSynthesisOptions = {},
): Promise<SynthesizedArtifact> {
  const cacheDir = options.cacheDir ?? join(process.cwd(), '.pgas-new-domain-synthesis-cache');
  const maxAttempts = options.maxAttempts ?? 4;
  const providerUrl = options.providerUrl ?? process.env.PGAS_OPENAI_BASE_URL ?? '';
  const model = options.model ?? process.env.PGAS_OPENAI_MODEL ?? process.env.PGAS_MODEL ?? '';
  const generator = options.generator ?? createOpenAiCompatibleBodyGenerator({ providerUrl, model });
  const stageSources: Record<string, string> = { ...(artifact.stage_sources ?? {}) };
  const audit: Array<Record<string, unknown>> = [];

  mkdirSync(cacheDir, { recursive: true });

  for (const stage of artifact.body_stage_slugs) {
    const classification = classificationFor(artifact, stage);
    if (classification.archetype === 'llm-reasoning') {
      continue;
    }
    if (classification.archetype !== 'pure-compute' && classification.archetype !== 'external-adapter') {
      throw new Error(`unsupported stage archetype for ${stage}: ${classification.archetype}`);
    }

    const prompt = promptForStage(stage, classification, artifact);
    const cacheKey = cacheKeyFor({
      stage,
      contract: artifact.contracts_ts,
      prompt,
      model,
      providerUrl,
    });
    const cachePath = join(cacheDir, `${cacheKey}.json`);
    const cached = readCache(cachePath);
    if (cached) {
      stageSources[stage] = cached.body;
      audit.push({
        stage,
        archetype: classification.archetype,
        adapter_kind: classification.adapter_kind,
        attempts: 0,
        cache_hit: true,
        body_hash: cached.body_hash,
      });
      continue;
    }

    let lastError = '';
    const seenFailures = new Set<string>();
    let accepted: CacheRecord | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const body = await generator({
        stage,
        archetype: classification.archetype,
        contract: artifact.contracts_ts,
        prompt,
        ...(lastError ? { repair: { attempt, lastError } } : {}),
      });
      const verification = verifyStageBody(body);
      if (verification.ok) {
        accepted = {
          body,
          body_hash: sha256(body),
        };
        break;
      }
      lastError = verification.error;
      const signature = sha256(lastError);
      if (seenFailures.has(signature)) {
        break;
      }
      seenFailures.add(signature);
    }

    if (!accepted) {
      throw new Error(`domain synthesis failed for stage ${stage} after ${maxAttempts} attempts; last error: ${lastError}`);
    }

    writeFileSync(cachePath, JSON.stringify(accepted, null, 2));
    stageSources[stage] = accepted.body;
    audit.push({
      stage,
      archetype: classification.archetype,
      adapter_kind: classification.adapter_kind,
      attempts: seenFailures.size + 1,
      cache_hit: false,
      body_hash: accepted.body_hash,
    });
  }

  return {
    ...artifact,
    stage_sources: stageSources,
    domain_synthesis_audit: audit,
  };
}

function verifyStageBody(body: string): { ok: true } | { ok: false; error: string } {
  const source = ts.createSourceFile('stage.ts', body, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const safetyError = scanSafety(source);
  if (safetyError) {
    return { ok: false, error: safetyError };
  }

  if (!exportsRunStage(source)) {
    return { ok: false, error: 'stage body must export function runStage' };
  }

  const transpiled = ts.transpileModule(body, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
    reportDiagnostics: true,
  });
  const diagnostics = transpiled.diagnostics ?? [];
  if (diagnostics.length > 0) {
    return {
      ok: false,
      error: diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n'),
    };
  }

  return { ok: true };
}

function scanSafety(source: ts.SourceFile): string | undefined {
  let error: string | undefined;
  const visit = (node: ts.Node): void => {
    if (error) return;
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (specifier !== '../contracts.js') {
        error = `banned import: ${specifier}`;
        return;
      }
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        error = 'banned capability: dynamic import';
        return;
      }
      if (ts.isIdentifier(node.expression) && ['eval', 'require', 'fetch'].includes(node.expression.text)) {
        error = `banned capability: ${node.expression.text}`;
        return;
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') {
      error = 'banned capability: Function constructor';
      return;
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'process' &&
      node.expression.name.text === 'env'
    ) {
      error = 'banned capability: process.env secret read';
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return error;
}

function exportsRunStage(source: ts.SourceFile): boolean {
  return source.statements.some((statement) =>
    ts.isFunctionDeclaration(statement) &&
    statement.name?.text === 'runStage' &&
    statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
  );
}

function createOpenAiCompatibleBodyGenerator(config: { providerUrl: string; model: string }): StageBodyGenerator {
  return async (request) => {
    if (!config.providerUrl || !config.model) {
      throw new Error('domain synthesis requires PGAS_OPENAI_BASE_URL and PGAS_OPENAI_MODEL');
    }
    const response = await fetch(`${config.providerUrl.replace(/\/+$/u, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.PGAS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? 'local'}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        messages: [
          { role: 'system', content: 'Return only TypeScript source code. Do not use markdown fences.' },
          {
            role: 'user',
            content: request.repair
              ? `${request.prompt}\n\nPrevious attempt failed:\n${request.repair.lastError}`
              : request.prompt,
          },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(`domain synthesis provider failed: HTTP ${response.status}`);
    }
    const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('domain synthesis provider returned no content');
    }
    return extractCode(content);
  };
}

function promptForStage(stage: string, classification: StageClassification, artifact: SynthesizedArtifact): string {
  return [
    `Generate src/programs/<slug>/stages/${stage}.ts for a PGAS generated program.`,
    `Stage archetype: ${classification.archetype}.`,
    classification.archetype === 'external-adapter'
      ? 'Use an in-memory mock only and include adapter_kind in the returned output. The only permitted TODO marker is TODO(real-service-swap).'
      : 'Implement deterministic local pure-compute logic.',
    'Export exactly: async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput>.',
    'Return JSON strings result_json and items_json; do not compute digest yourself.',
    'Do not use eval, dynamic import, child_process, shell, fetch/raw network, process.env, or secret reads.',
    'Frozen contract:',
    artifact.contracts_ts,
  ].join('\n');
}

function classificationFor(artifact: SynthesizedArtifact, stage: string): StageClassification {
  const found = artifact.stage_classification.find((candidate) =>
    !!candidate &&
    typeof candidate === 'object' &&
    !Array.isArray(candidate) &&
    (candidate as { slug?: unknown }).slug === stage,
  );
  if (!found || typeof found !== 'object' || Array.isArray(found)) {
    return { slug: stage, archetype: 'pure-compute' };
  }
  const record = found as Record<string, unknown>;
  return {
    slug: stage,
    archetype: typeof record.archetype === 'string' ? record.archetype : 'pure-compute',
    ...(record.adapter_kind === 'in_memory_mock' ? { adapter_kind: 'in_memory_mock' } : {}),
  };
}

function cacheKeyFor(input: { stage: string; contract: string; prompt: string; model: string; providerUrl: string }): string {
  return sha256([
    SYNTHESIS_VERSION,
    input.stage,
    input.contract,
    input.prompt,
    input.model,
    input.providerUrl,
  ].join('\n---\n'));
}

function readCache(path: string): CacheRecord | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CacheRecord>;
  return typeof parsed.body === 'string' && typeof parsed.body_hash === 'string'
    ? { body: parsed.body, body_hash: parsed.body_hash }
    : undefined;
}

function extractCode(content: string): string {
  const fence = content.match(/```(?:ts|typescript)?\s*([\s\S]*?)```/u);
  return (fence?.[1] ?? content).trim();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
