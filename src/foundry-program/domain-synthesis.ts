import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, Script } from 'node:vm';
import ts from 'typescript';
import type { WiringIntegration } from '../pgas-new/wiring-manifest.js';
import type { SynthesizedArtifact } from './synthesizer-store.js';

const SYNTHESIS_VERSION = 'foundry-domain-synthesis-v2';

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
  targetKind?: 'standalone_repo' | 'existing_repo';
  integrations?: WiringIntegration[];
}

interface StageClassification {
  slug: string;
  archetype: string;
  rationale?: string;
  adapter_kind?: string;
  integration_name?: string;
  integration_import?: string;
  integration_method?: string;
  integration_gap?: boolean;
  audit_note?: string;
}

interface CacheRecord {
  body: string;
  body_hash: string;
  behavioral_gate?: string;
  behavioral_fixture?: StageBehaviorFixture;
}

interface StageBehaviorFixture {
  input_stage: string;
  expected_result_stage: string;
  expected_items_non_empty: true;
  expected_adapter_kind?: 'in_memory_mock' | 'repo_integration';
  expected_integration?: string;
  expected_method?: string;
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
  const targetKind = options.targetKind ?? 'standalone_repo';
  const integrations = options.integrations ?? [];
  const stageSources: Record<string, string> = { ...(artifact.stage_sources ?? {}) };
  const audit: Array<Record<string, unknown>> = [];

  mkdirSync(cacheDir, { recursive: true });

  for (const stage of artifact.body_stage_slugs) {
    const classification = resolveIntegrationBinding(classificationFor(artifact, stage), targetKind, integrations);
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
        ...auditFieldsFor(classification),
        ...behaviorAuditFields(cached),
        attempts: 0,
        cache_hit: true,
        body_hash: cached.body_hash,
      });
      continue;
    }

    let lastError = '';
    let accepted: CacheRecord | undefined;
    let attemptsUsed = 0;
    const repoIntegration = integrationForClassification(classification, integrations);
    if (classification.adapter_kind === 'repo_integration' && repoIntegration) {
      attemptsUsed = 1;
      const body = renderRepoIntegrationStageBody(stage, repoIntegration);
      const verification = await verifyStageBody(body, classification.archetype, {
        stage,
        allowedIntegrationImport: repoIntegration.import,
        integrationName: repoIntegration.name,
        integrationMethod: repoIntegration.methods[0],
      });
      if (verification.ok) {
        accepted = {
          body,
          body_hash: sha256(body),
          behavioral_gate: verification.behavioral_gate,
          behavioral_fixture: verification.behavioral_fixture,
        };
      } else {
        lastError = verification.error;
      }
    } else {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        attemptsUsed = attempt;
        const body = await generator({
          stage,
          archetype: classification.archetype,
          contract: artifact.contracts_ts,
          prompt,
          ...(lastError ? { repair: { attempt, lastError } } : {}),
        });
        const verification = await verifyStageBody(body, classification.archetype, { stage });
        if (verification.ok) {
          accepted = {
            body,
            body_hash: sha256(body),
            behavioral_gate: verification.behavioral_gate,
            behavioral_fixture: verification.behavioral_fixture,
          };
          break;
        }
        lastError = verification.error;
      }
    }

    if (!accepted) {
      throw new Error(`domain synthesis failed for stage ${stage} after ${maxAttempts} attempts; last error: ${lastError}`);
    }

    writeFileSync(cachePath, JSON.stringify(accepted, null, 2));
    stageSources[stage] = accepted.body;
    audit.push({
      stage,
      archetype: classification.archetype,
      ...auditFieldsFor(classification),
      ...behaviorAuditFields(accepted),
      attempts: attemptsUsed,
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

function verifyStageBody(
  body: string,
  archetype: 'pure-compute' | 'external-adapter',
  options: {
    stage: string;
    allowedIntegrationImport?: string;
    integrationName?: string;
    integrationMethod?: string;
  },
): Promise<
  | { ok: true; behavioral_gate: string; behavioral_fixture: StageBehaviorFixture }
  | { ok: false; error: string }
> {
  const stubError = scanBodyStubMarkers(body, archetype);
  if (stubError) {
    return Promise.resolve({ ok: false, error: stubError });
  }

  const source = ts.createSourceFile('stage.ts', body, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const safetyError = scanSafety(source, options);
  if (safetyError) {
    return Promise.resolve({ ok: false, error: safetyError });
  }

  if (!exportsRunStage(source)) {
    return Promise.resolve({ ok: false, error: 'stage body must export function runStage' });
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
    return Promise.resolve({
      ok: false,
      error: diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n'),
    });
  }

  return runBehavioralGate(body, archetype, options);
}

function scanBodyStubMarkers(body: string, archetype: 'pure-compute' | 'external-adapter'): string | undefined {
  const todoMatches = [...body.matchAll(/\bTODO(?:\(([^)]+)\))?/gu)];
  for (const match of todoMatches) {
    const marker = match[0];
    const qualifier = match[1];
    if (archetype === 'external-adapter' && marker === 'TODO(real-service-swap)' && qualifier === 'real-service-swap') {
      continue;
    }
    return `stub marker in generated stage body: ${marker}`;
  }

  const markerPatterns = [
    { marker: 'stage_action_stub', pattern: /stage_action_stub/u },
    { marker: 'not implemented', pattern: /not implemented|not_implemented/u },
    { marker: 'placeholder', pattern: /\bplaceholder\b/u },
  ];
  for (const candidate of markerPatterns) {
    if (candidate.pattern.test(body)) {
      return `stub marker in generated stage body: ${candidate.marker}`;
    }
  }

  return undefined;
}

function scanSafety(source: ts.SourceFile, options: { allowedIntegrationImport?: string }): string | undefined {
  let error: string | undefined;
  const allowedImports = new Set(['../contracts.js']);
  if (options.allowedIntegrationImport) {
    allowedImports.add(options.allowedIntegrationImport);
  }
  const visit = (node: ts.Node): void => {
    if (error) return;
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (isBannedStageImport(specifier)) {
        error = `banned import: ${specifier}`;
        return;
      }
      if (!allowedImports.has(specifier)) {
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

function isBannedStageImport(specifier: string): boolean {
  return [
    'child_process',
    'node:child_process',
    'http',
    'node:http',
    'https',
    'node:https',
    'net',
    'node:net',
    'tls',
    'node:tls',
    'dgram',
    'node:dgram',
  ].includes(specifier);
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
          {
            role: 'system',
            content: [
              'Return only TypeScript source code. Do not use markdown fences.',
              'Do not include comments.',
              'Do not include the literal words TODO, placeholder, stage_action_stub, or not implemented.',
              "The only allowed import is: import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';",
            ].join(' '),
          },
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
  const context = contextForStage(stage, classification, artifact);
  const entryPath = `inputs.${context.entry_channel}`;
  return [
    `Generate src/programs/<slug>/stages/${stage}.ts for a PGAS generated program.`,
    `Stage archetype: ${classification.archetype}.`,
    classification.archetype === 'external-adapter'
      ? externalAdapterPromptLine(classification)
      : 'Implement deterministic local pure-compute logic.',
    'Stage synthesis context:',
    JSON.stringify(context, null, 2),
    'Do not include comments or any stub marker words: TODO, placeholder, stage_action_stub, not implemented.',
    "Use exactly one import line: import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';",
    'Do not import handlers, resolver helpers, Node built-ins, runtime packages, or any other module.',
    'Export exactly: async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput>.',
    'Return JSON strings result_json and items_json; do not compute digest yourself.',
    'Runtime data access contract:',
    `The entry-channel text is stored as a string at input.domain['${entryPath}']; read that path for user request facts.`,
    "Parse JSON-looking user requests into typed facts before computing.",
    'When parsed request facts contain numeric fields whose names describe a calculation, compute from those fields directly instead of inventing base fees, complexity multipliers, or random constants.',
    'Use common named-field arithmetic: hours multiplied by hourly rates produce subtotals; discount_pct is a percentage applied to a subtotal; budget fields are comparison thresholds, not fee inputs.',
    'When parsed request facts contain identifiers, echo those identifiers; do not replace them with synthetic IDs from runtime.random().',
    "Prior deterministic stage outputs are stored as objects at input.domain['<stage>.output']; parse their result_json and items_json strings before using them.",
    "Prior LLM reasoning stage outputs are stored as strings at input.domain['<stage>.result_json'] and input.domain['<stage>.items_json']; parse them before using them.",
    'Do not treat input.payload.__stage_runtime as business input; use runtime.now() and runtime.random() through StageRuntime only.',
    'Shape result_json from the mandate, stage slug, input facts, and prior stage outputs. Preserve concrete field names from the request and prior results when they are meaningful.',
    'Do not use a generic status/summary/details template when the mandate names concrete fields.',
    'Keep final business fields at the top level; do not wrap all important facts under generic inputs, details, or calculation objects.',
    'Keep key computed facts at the top level of result_json so later stages can consume them without guessing nested structures.',
    'For pure-compute stages, build a complete deterministic object from input.stage, runtime.now(), parsed request facts, and prior stage outputs. If no domain fact is relevant, still return a meaningful non-empty object with status, summary, severity, owner_queue, next_action, and summary_ready fields.',
    'For items_json, return a non-empty JSON array of concise strings derived from the result object.',
    'Do not use eval, dynamic import, child_process, shell, fetch/raw network, process.env, or secret reads.',
    'Untrusted generated spec context:',
    artifact.spec_yaml,
    'Frozen contract:',
    artifact.contracts_ts,
  ].join('\n');
}

function contextForStage(
  stage: string,
  classification: StageClassification,
  artifact: SynthesizedArtifact,
): Record<string, unknown> & { entry_channel: string } {
  const synthesisContext = artifact.synthesis_context;
  const orderedStages = synthesisContext?.stages.map((item) => item.slug) ?? artifact.mode_names;
  const stageIndex = orderedStages.indexOf(stage);
  const previousStages = stageIndex > 0 ? orderedStages.slice(0, stageIndex) : [];
  const laterStages = stageIndex >= 0 ? orderedStages.slice(stageIndex + 1) : [];
  const transitions = synthesisContext?.transitions ?? [];
  return {
    program_slug: synthesisContext?.program_slug ?? unknownProgramSlug(artifact.spec_yaml),
    program_name: synthesisContext?.program_name ?? 'generated program',
    purpose: synthesisContext?.purpose ?? unknownPurpose(artifact.spec_yaml),
    entry_channel: synthesisContext?.entry_channel ?? inferEntryChannel(artifact.spec_yaml),
    stage,
    archetype: classification.archetype,
    ...(classification.rationale ? { stage_rationale: classification.rationale } : {}),
    ...(classification.adapter_kind ? { adapter_kind: classification.adapter_kind } : {}),
    previous_stages: previousStages,
    next_stages: laterStages,
    incoming_transitions: transitions.filter((transition) => transition.to === stage),
    outgoing_transitions: transitions.filter((transition) => transition.from === stage),
    delegation: synthesisContext?.delegation ?? {},
    completion: synthesisContext?.completion ?? null,
  };
}

function inferEntryChannel(specYaml: string): string {
  const match = specYaml.match(/\ningestion:\n\s+([a-zA-Z0-9_]+):\n\s+- inputs\.\1/u);
  return match?.[1] ?? 'user_text';
}

function unknownProgramSlug(specYaml: string): string {
  const match = specYaml.match(/^name:\s*([^\n]+)/u);
  return match?.[1]?.trim() ?? 'generated-program';
}

function unknownPurpose(specYaml: string): string {
  const match = specYaml.match(/preamble:\s*\|-\n\s+Program:\s*([^\n]+)/u);
  return match?.[1]?.trim() ?? 'Generated PGAS program.';
}

function externalAdapterPromptLine(classification: StageClassification): string {
  if (classification.adapter_kind === 'repo_integration') {
    return `Use the declared repo integration ${classification.integration_name} only.`;
  }
  const gap = classification.integration_gap && classification.audit_note ? ` ${classification.audit_note}` : '';
  return `Use an in-memory mock only and include adapter_kind in the returned output. The only permitted TODO marker is TODO(real-service-swap).${gap}`;
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
    ...(typeof record.rationale === 'string' ? { rationale: record.rationale } : {}),
    ...(record.adapter_kind === 'in_memory_mock' || record.adapter_kind === 'repo_integration'
      ? { adapter_kind: record.adapter_kind }
      : {}),
    ...(typeof record.integration_name === 'string' ? { integration_name: record.integration_name } : {}),
    ...(typeof record.integration_import === 'string' ? { integration_import: record.integration_import } : {}),
    ...(typeof record.integration_method === 'string' ? { integration_method: record.integration_method } : {}),
    ...(record.integration_gap === true ? { integration_gap: true } : {}),
    ...(typeof record.audit_note === 'string' ? { audit_note: record.audit_note } : {}),
  };
}

function resolveIntegrationBinding(
  classification: StageClassification,
  targetKind: 'standalone_repo' | 'existing_repo',
  integrations: WiringIntegration[],
): StageClassification {
  if (classification.archetype !== 'external-adapter' || targetKind !== 'existing_repo') {
    return classification;
  }

  if (classification.adapter_kind === 'repo_integration' && classification.integration_name) {
    return classification;
  }

  const matched = matchIntegration(classification, integrations);
  if (matched) {
    return {
      ...classification,
      adapter_kind: 'repo_integration',
      integration_name: matched.name,
      integration_import: matched.import,
      integration_method: matched.methods[0],
      integration_gap: false,
      audit_note: undefined,
    };
  }

  return {
    ...classification,
    adapter_kind: 'in_memory_mock',
    integration_gap: true,
    audit_note: `existing repo external-adapter stage ${classification.slug} has no matching integration declared in .pgas/wiring.yml`,
  };
}

function matchIntegration(classification: StageClassification, integrations: WiringIntegration[]): WiringIntegration | undefined {
  const haystack = [classification.slug, classification.rationale, classification.audit_note, classification.integration_name]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  const tokens = new Set(haystack.split(/[^a-z0-9]+/u).filter(Boolean));
  return integrations.find((integration) => tokens.has(integration.name.toLowerCase()));
}

function integrationForClassification(
  classification: StageClassification,
  integrations: WiringIntegration[],
): WiringIntegration | undefined {
  return classification.integration_name
    ? integrations.find((integration) => integration.name === classification.integration_name)
    : undefined;
}

function auditFieldsFor(classification: StageClassification): Record<string, unknown> {
  return {
    ...(classification.adapter_kind ? { adapter_kind: classification.adapter_kind } : {}),
    ...(classification.integration_name ? { integration_name: classification.integration_name } : {}),
    ...(classification.integration_import ? { integration_import: classification.integration_import } : {}),
    ...(classification.integration_method ? { integration_method: classification.integration_method } : {}),
    ...(classification.integration_gap ? { integration_gap: true } : {}),
    ...(classification.audit_note ? { audit_note: classification.audit_note } : {}),
  };
}

function behaviorAuditFields(record: Pick<CacheRecord, 'behavioral_gate' | 'behavioral_fixture'>): Record<string, unknown> {
  return {
    ...(record.behavioral_gate ? { behavioral_gate: record.behavioral_gate } : {}),
    ...(record.behavioral_fixture ? { behavioral_fixture: record.behavioral_fixture } : {}),
  };
}

async function runBehavioralGate(
  body: string,
  archetype: 'pure-compute' | 'external-adapter',
  options: {
    stage: string;
    allowedIntegrationImport?: string;
    integrationName?: string;
    integrationMethod?: string;
  },
): Promise<
  | { ok: true; behavioral_gate: string; behavioral_fixture: StageBehaviorFixture }
  | { ok: false; error: string }
> {
  if (options.allowedIntegrationImport) {
    return {
      ok: true,
      behavioral_gate: 'repo_integration_static_call',
      behavioral_fixture: {
        input_stage: options.stage,
        expected_result_stage: options.stage,
        expected_items_non_empty: true,
        expected_adapter_kind: 'repo_integration',
        ...(options.integrationName ? { expected_integration: options.integrationName } : {}),
        ...(options.integrationMethod ? { expected_method: options.integrationMethod } : {}),
      },
    };
  }

  try {
    const runStage = loadRunStageForBehavior(body);
    const fixture = behaviorFixtureFor(options.stage, archetype);
    const output = await withBehaviorTimeout(
      Promise.resolve(runStage(fixture.input, fixture.runtime)),
      `behavioral gate failed for stage ${options.stage}: runStage timed out`,
    );
    const behaviorError = assertBehavioralOutput(output, options.stage, archetype);
    if (behaviorError) {
      return { ok: false, error: `behavioral gate failed for stage ${options.stage}: ${behaviorError}` };
    }
    return {
      ok: true,
      behavioral_gate: 'passed',
      behavioral_fixture: fixture.audit,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `behavioral gate failed for stage ${options.stage}: ${message}` };
  }
}

function loadRunStageForBehavior(body: string): (input: unknown, runtime: unknown) => Promise<unknown> | unknown {
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
  });
  new Script(transpiled.outputText, { filename: 'stage.behavior.cjs' }).runInContext(context, {
    timeout: 1_000,
  });
  const exported = moduleObject.exports as Record<string, unknown>;
  const runStage = exported.runStage ?? exportsObject.runStage;
  if (typeof runStage !== 'function') {
    throw new Error('runStage export was not callable');
  }
  return runStage as (input: unknown, runtime: unknown) => Promise<unknown> | unknown;
}

function behaviorFixtureFor(
  stage: string,
  archetype: 'pure-compute' | 'external-adapter',
): {
  input: Record<string, unknown>;
  runtime: Record<string, unknown>;
  audit: StageBehaviorFixture;
} {
  const expectedAdapterKind = archetype === 'external-adapter' ? { expected_adapter_kind: 'in_memory_mock' as const } : {};
  return {
    input: {
      stage,
      payload: {
        __stage_runtime: {
          now_iso: '2026-06-28T00:00:00.000Z',
          random: 0.25,
        },
      },
      domain: {
        'account.id': 'acct-behavior-001',
        'record.id': 'record-behavior-001',
        'owner.queue': 'operations',
      },
    },
    runtime: {
      now: () => '2026-06-28T00:00:00.000Z',
      random: () => 0.25,
      llm: async () => {
        throw new Error('StageRuntime.llm is not available in behavioral verification');
      },
    },
    audit: {
      input_stage: stage,
      expected_result_stage: stage,
      expected_items_non_empty: true,
      ...expectedAdapterKind,
    },
  };
}

async function withBehaviorTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 1_000);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function assertBehavioralOutput(
  output: unknown,
  stage: string,
  archetype: 'pure-compute' | 'external-adapter',
): string | undefined {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return 'runStage returned a non-object output';
  }
  const candidate = output as { result_json?: unknown; items_json?: unknown; adapter_kind?: unknown };
  if (typeof candidate.result_json !== 'string') {
    return 'result_json must be a JSON string';
  }
  if (typeof candidate.items_json !== 'string') {
    return 'items_json must be a JSON string';
  }

  let result: unknown;
  let items: unknown;
  try {
    result = JSON.parse(candidate.result_json) as unknown;
  } catch (error) {
    return `result_json must parse as JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  try {
    items = JSON.parse(candidate.items_json) as unknown;
  } catch (error) {
    return `items_json must parse as JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return 'result_json must encode an object';
  }
  if ((result as { stage?: unknown }).stage !== stage) {
    return `expected result_json.stage to equal ${stage}; got ${String((result as { stage?: unknown }).stage)}`;
  }
  if (!Array.isArray(items) || items.length === 0) {
    return 'expected items_json to encode a non-empty array';
  }
  if (archetype === 'external-adapter') {
    const resultAdapterKind = (result as { adapter_kind?: unknown }).adapter_kind;
    const adapterKind = candidate.adapter_kind ?? resultAdapterKind;
    if (adapterKind !== 'in_memory_mock') {
      return `expected external-adapter mock adapter_kind to equal in_memory_mock; got ${String(adapterKind)}`;
    }
  }
  return undefined;
}

function renderRepoIntegrationStageBody(stage: string, integration: WiringIntegration): string {
  const method = integration.methods[0] as string;
  const envNames = JSON.stringify(integration.config_env);
  const importLine = integration.factory
    ? `import { ${integration.factory} } from ${tsString(integration.import)};`
    : `import { ${method} } from ${tsString(integration.import)};`;
  const callLines = integration.factory
    ? [
        `  const client = ${integration.factory}();`,
        `  const integrationResult = await client.${method}({`,
      ]
    : [`  const integrationResult = await ${method}({`];
  return `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';
${importLine}

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
${callLines.join('\n')}
    stage: input.stage,
    domain: input.domain,
    requested_at: runtime.now(),
  });
  return {
    result_json: JSON.stringify({
      stage: input.stage,
      status: 'connected',
      adapter_kind: 'repo_integration',
      integration: ${tsString(integration.name)},
      method: ${tsString(method)},
      config_env: ${envNames},
      result: integrationResult,
    }),
    items_json: JSON.stringify([input.stage + ':' + ${tsString(integration.name)} + ':' + ${tsString(method)}]),
    digest: '',
    adapter_kind: 'repo_integration',
  };
}
`;
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
    ? {
        body: parsed.body,
        body_hash: parsed.body_hash,
        ...(typeof parsed.behavioral_gate === 'string' ? { behavioral_gate: parsed.behavioral_gate } : {}),
        ...(isStageBehaviorFixture(parsed.behavioral_fixture) ? { behavioral_fixture: parsed.behavioral_fixture } : {}),
      }
    : undefined;
}

function isStageBehaviorFixture(value: unknown): value is StageBehaviorFixture {
  return !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { input_stage?: unknown }).input_stage === 'string' &&
    typeof (value as { expected_result_stage?: unknown }).expected_result_stage === 'string' &&
    (value as { expected_items_non_empty?: unknown }).expected_items_non_empty === true;
}

function extractCode(content: string): string {
  const fence = content.match(/```(?:ts|typescript)?\s*([\s\S]*?)```/u);
  return (fence?.[1] ?? content).trim();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function tsString(value: string): string {
  return `'${value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'")}'`;
}
