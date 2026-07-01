import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dump, load } from 'js-yaml';
import {
  createExistingRepoArtifactPlan,
  createStandaloneArtifactPlan,
  type ArtifactPlan,
  type PlannedArtifact,
  type ProgramIdentity,
} from './artifact-plan.js';
import { renderControlPlaneControlsYaml } from './control-plane.js';
import { PGAS_SERVER_VERSION } from './version.js';
import type { WiringManifest } from './wiring-manifest.js';

const TEMPLATE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../templates/pgas-new');

export type ProgramTemplate = 'pgas-new-foundry';

export interface RenderStandaloneOptions extends ProgramIdentity {
  outDir: string;
  githubOwner?: string;
  githubRepo?: string;
  template?: ProgramTemplate;
  mandate?: string;
  synthesizedSpecYaml?: string;
  synthesizedContractsTs?: string;
  synthesizedHandlersTs?: string;
  synthesizedHandlersIndexTs?: string;
  synthesizedStageSources?: Record<string, string>;
  synthesizedToolsTs?: string;
  synthesizedSmokeTestTs?: string;
}

export interface RenderExistingRepoOptions extends ProgramIdentity {
  repoRoot: string;
  manifest: WiringManifest;
  stageSlugs?: string[];
  template?: ProgramTemplate;
  mandate?: string;
  synthesizedSpecYaml?: string;
  synthesizedContractsTs?: string;
  synthesizedHandlersTs?: string;
  synthesizedHandlersIndexTs?: string;
  synthesizedStageSources?: Record<string, string>;
  synthesizedToolsTs?: string;
  synthesizedSmokeTestTs?: string;
}

export interface RenderResult {
  plan: ArtifactPlan;
  written: string[];
}

interface TemplateSpec {
  file: string;
  tokens: readonly string[];
  substitute?: boolean;
  content?: string;
}

interface SynthesizedSources {
  specYaml?: string;
  contractsTs?: string;
  handlersTs?: string;
  handlersIndexTs?: string;
  stageSources?: Record<string, string>;
  toolsTs?: string;
  smokeTestTs?: string;
}

const STANDALONE_TEMPLATE_BY_PATH: Record<string, TemplateSpec> = {
  '.pgas/wiring.yml': spec('repo/.pgas/wiring.yml.tmpl', ['GITHUB_OWNER', 'GITHUB_REPO']),
  '.pgas/pgas-new/{{SLUG}}/dossier.yml': spec('standalone/.pgas/pgas-new/dossier.yml.tmpl', ['MANDATE', 'NAME', 'SLUG']),
  '.pgas/pgas-new/{{SLUG}}/artifacts.json': spec('standalone/.pgas/pgas-new/artifacts.json.tmpl', [
    'NAME',
    'PGAS_SERVER_VERSION',
    'SLUG',
  ]),
  'package.json': spec('standalone/package.json.tmpl', ['PGAS_SERVER_VERSION', 'SLUG']),
  'tsconfig.json': spec('standalone/tsconfig.json.tmpl', []),
  'src/server.ts': spec('standalone/src/server.ts.tmpl', ['PASCAL_NAME', 'SLUG']),
  'src/repl/index.ts': spec('standalone/src/repl/index.ts.tmpl', ['NAME', 'SLUG']),
  'src/repl/renderer.ts': spec('standalone/src/repl/renderer.ts.tmpl', []),
  'src/programs/{{SLUG}}/specs.yml': spec('program/spec-skeleton.yml.tmpl', ['NAME', 'SLUG']),
  'src/programs/{{SLUG}}/registration.ts': spec('program/registration-skeleton.ts.tmpl', ['PASCAL_NAME']),
  'src/programs/{{SLUG}}/handlers.ts': spec('program/handlers-skeleton.ts.tmpl', []),
  'src/programs/{{SLUG}}/handlers/index.ts': spec('program/handlers-index.ts.tmpl', []),
  'src/programs/{{SLUG}}/handlers/_resolver.ts': spec('program/handlers-resolver.ts.tmpl', []),
  'src/programs/{{SLUG}}/tools.ts': spec('program/tools-skeleton.ts.tmpl', ['PASCAL_NAME']),
  'tests/spec-load.test.ts': spec('tests/spec-load.test.ts.tmpl', ['PASCAL_NAME', 'SLUG']),
  'tests/control-plane.test.ts': spec('tests/control-plane.test.ts.tmpl', ['PASCAL_NAME', 'SLUG']),
  'tests/program-deterministic.test.ts': spec('tests/program-deterministic.test.ts.tmpl', ['PASCAL_NAME', 'SLUG']),
  'tests/api-blackbox.test.ts': spec('tests/api-blackbox.test.ts.tmpl', ['PASCAL_NAME', 'SLUG']),
  'tests/live-provider.test.ts': spec('tests/live-provider.test.ts.tmpl', ['SLUG']),
  'audit/PGAS-NEW-GRADUATION.md': spec('audit/PGAS-NEW-GRADUATION.md.tmpl', ['NAME', 'SLUG']),
};

export function renderStandaloneScaffold(options: RenderStandaloneOptions): RenderResult {
  const synthesizedSources = synthesizedSourcesFor(options);
  const plan = createStandaloneArtifactPlan(
    { slug: options.slug, name: options.name },
    {
      stageSlugs: Object.keys(synthesizedSources.stageSources ?? {}),
      includeSmokeTest: typeof synthesizedSources.smokeTestTs === 'string',
    },
  );
  assertSupportedTemplate(options.template);

  assertNoExistingArtifacts(options.outDir, plan);

  return renderPlan({
    plan,
    rootDir: options.outDir,
    templateForArtifact: (artifact) => templateForStandaloneArtifact(artifact, options.slug, synthesizedSources),
    tokens: tokensFor(options, plan),
  });
}

export function renderExistingRepoAttachment(options: RenderExistingRepoOptions): RenderResult {
  const synthesizedSources = existingRepoSynthesizedSources(options, synthesizedSourcesFor(options));
  const plan = createExistingRepoArtifactPlan(
    { slug: options.slug, name: options.name },
    options.manifest,
    {
      stageSlugs: options.stageSlugs ?? Object.keys(synthesizedSources.stageSources ?? {}),
      includeSmokeTest: typeof synthesizedSources.smokeTestTs === 'string',
    },
  );
  assertSupportedTemplate(options.template);

  assertNoExistingArtifacts(options.repoRoot, plan);

  return renderPlan({
    plan,
    rootDir: options.repoRoot,
    templateForArtifact: (artifact) => templateForExistingArtifact(artifact, options.slug, synthesizedSources),
    tokens: tokensFor(options, plan),
  });
}

function existingRepoSynthesizedSources(options: RenderExistingRepoOptions, sources: SynthesizedSources): SynthesizedSources {
  if (!sources.smokeTestTs) {
    return sources;
  }

  return {
    ...sources,
    smokeTestTs: rewriteSmokeTestRegistrationImport(
      sources.smokeTestTs,
      options.slug,
      existingRepoProgramRegistrationImport(options.manifest, options.slug),
    ),
  };
}

function existingRepoProgramRegistrationImport(manifest: WiringManifest, slug: string): string {
  const programsDir = trimRepoRelativePath(manifest.paths.programs_dir);
  const registrationPath = posix.join(programsDir, slug, 'registration.js');
  let relativePath = posix.relative('tests', registrationPath);
  if (!relativePath.startsWith('.')) {
    relativePath = `./${relativePath}`;
  }
  return relativePath;
}

function rewriteSmokeTestRegistrationImport(source: string, slug: string, registrationImportPath: string): string {
  const standaloneImportPath = `../src/programs/${slug}/registration.js`;
  if (!source.includes(standaloneImportPath)) {
    throw new Error(`generated smoke test missing standalone registration import: ${standaloneImportPath}`);
  }
  return source.replaceAll(standaloneImportPath, registrationImportPath);
}

function assertNoExistingArtifacts(rootDir: string, plan: ArtifactPlan): void {
  const collisions = plan.artifacts
    .filter((artifact) => (artifact.writeMode ?? 'create') === 'create')
    .map((artifact) => artifact.path)
    .filter((path) => existsSync(join(rootDir, path)));

  if (collisions.length > 0) {
    throw new Error(`refusing to overwrite existing attach artifacts:\n${collisions.join('\n')}`);
  }
}

export function renderTemplate(
  source: string,
  tokens: Record<string, string>,
  options: { allowUnusedTokens?: boolean } = {},
): string {
  const required = new Set([...source.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((match) => match[1]));
  for (const token of required) {
    if (!(token in tokens)) {
      throw new Error(`missing template token: ${token}`);
    }
  }

  for (const token of Object.keys(tokens)) {
    if (!options.allowUnusedTokens && !required.has(token)) {
      throw new Error(`unused template token: ${token}`);
    }
  }

  let rendered = source;
  for (const token of required) {
    rendered = rendered.replaceAll(`{{${token}}}`, tokens[token]);
  }

  if (/\{\{[^}]+\}\}/.test(rendered)) {
    throw new Error('unrendered template token remains');
  }

  return rendered;
}

function renderPlan(options: {
  plan: ArtifactPlan;
  rootDir: string;
  templateForArtifact: (artifact: PlannedArtifact) => TemplateSpec | undefined;
  tokens: Record<string, string>;
}): RenderResult {
  const written: string[] = [];

  for (const artifact of options.plan.artifacts) {
    const templatePath = options.templateForArtifact(artifact);
    if (!templatePath) {
      throw new Error(`no template for artifact path: ${artifact.path}`);
    }

    const source = templatePath.content ?? readFileSync(join(TEMPLATE_ROOT, templatePath.file), 'utf8');
    const rendered = templatePath.substitute === false
      ? renderDirectSource(source)
      : renderTemplate(source, selectTokens(options.tokens, templatePath.tokens));
    const outPath = join(options.rootDir, artifact.path);
    const output = renderArtifactWriteContent({
      artifact,
      rendered,
      outPath,
      tokens: options.tokens,
    });
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, output);
    written.push(artifact.path);
  }

  return { plan: options.plan, written };
}

function templateForExistingArtifact(
  artifact: PlannedArtifact,
  slug: string,
  synthesizedSources: SynthesizedSources,
): TemplateSpec | undefined {
  const synthesizedTemplate = templateForSynthesizedArtifact(artifact, slug, synthesizedSources);
  if (synthesizedTemplate) {
    return synthesizedTemplate;
  }
  const existingStageTemplate = templateForExistingStageArtifact(artifact, slug);
  if (existingStageTemplate) {
    return existingStageTemplate;
  }
  const handlerDirectoryTemplate = templateForHandlerDirectoryArtifact(artifact, slug);
  if (handlerDirectoryTemplate) {
    return handlerDirectoryTemplate;
  }

  return templateForFoundryArtifact(artifact, slug);
}

function templateForFoundryArtifact(artifact: PlannedArtifact, slug: string): TemplateSpec | undefined {
  if (artifact.kind === 'spec') {
    return STANDALONE_TEMPLATE_BY_PATH['src/programs/{{SLUG}}/specs.yml'];
  }
  if (artifact.kind === 'registration') {
    return spec('program/registration-skeleton.ts.tmpl', ['PASCAL_NAME']);
  }
  if (artifact.kind === 'handler') {
    return STANDALONE_TEMPLATE_BY_PATH['src/programs/{{SLUG}}/handlers.ts'];
  }
  if (artifact.kind === 'tool') {
    return STANDALONE_TEMPLATE_BY_PATH['src/programs/{{SLUG}}/tools.ts'];
  }
  if (artifact.kind === 'dossier') {
    return STANDALONE_TEMPLATE_BY_PATH['.pgas/pgas-new/{{SLUG}}/dossier.yml'];
  }
  if (artifact.kind === 'metadata') {
    return spec('consumer/artifacts.json.tmpl', ['ARTIFACT_PATHS_JSON', 'NAME', 'PGAS_SERVER_VERSION', 'SLUG']);
  }
  if (artifact.kind === 'audit') {
    return STANDALONE_TEMPLATE_BY_PATH['audit/PGAS-NEW-GRADUATION.md'];
  }
  const existingUserFacingTemplate = templateForExistingUserFacingArtifact(artifact, slug);
  if (existingUserFacingTemplate) {
    return existingUserFacingTemplate;
  }

  return templateForStandalonePath(artifact.path, slug);
}

function templateForExistingStageArtifact(artifact: PlannedArtifact, slug: string): TemplateSpec | undefined {
  const stageMatch = artifact.path.match(new RegExp(`/${slug}/stages/([^/]+)\\.ts$`, 'u'));
  const stage = stageMatch?.[1];
  if (artifact.kind !== 'stage' || !stage) {
    return undefined;
  }

  return inlineTemplate(renderMinimalStageSource(stage));
}

function templateForExistingUserFacingArtifact(artifact: PlannedArtifact, slug: string): TemplateSpec | undefined {
  const path = artifact.path;
  if (path.endsWith(`/${slug}/projection.ts`)) {
    return inlineTemplate([
      `export const ${toPascalCase(slug)}Projection = {`,
      `  program: '${slug}',`,
      `  version: 1,`,
      `} as const;`,
      '',
    ].join('\n'));
  }
  if (path.endsWith(`/${slug}/frontend.spec.yml`)) {
    return inlineTemplate([
      `program: ${slug}`,
      'surface: attached_program',
      'projection: projection.ts',
      'states:',
      '  - idle',
      '  - running',
      '  - complete',
      '',
    ].join('\n'));
  }
  if (path.endsWith(`/${slug}/export/html.ts`)) {
    return inlineTemplate([
      'export function renderHtmlDocument(body: string): string {',
      '  return `<!doctype html><html><body>${body}</body></html>`;',
      '}',
      '',
    ].join('\n'));
  }
  if (path.endsWith(`/${slug}/export/docx.ts`)) {
    return inlineTemplate([
      'export function renderDocxDocument(body: string): Uint8Array {',
      '  return new TextEncoder().encode(body);',
      '}',
      '',
    ].join('\n'));
  }
  if (path === `tests/${slug}-deterministic.test.ts`) {
    return inlineTemplate([
      "import { describe, expect, it } from 'vitest';",
      '',
      `describe('${slug} deterministic workflow', () => {`,
      "  it('keeps generated artifacts testable without live provider calls', () => {",
      "    expect('deterministic').toBe('deterministic');",
      '  });',
      '});',
      '',
    ].join('\n'));
  }
  if (path === `qc/e2e-frontend/${slug}.scenario.yml`) {
    return inlineTemplate([
      `program: ${slug}`,
      'scenario: attached_frontend_smoke',
      'steps:',
      '  - open',
      '  - assert_projection',
      '',
    ].join('\n'));
  }
  if (path === `qc/facts/${slug}.facts.yml`) {
    return inlineTemplate([
      `program: ${slug}`,
      'facts:',
      '  deterministic: true',
      '',
    ].join('\n'));
  }
  if (path === 'qc/e2e-coverage.yml') {
    return inlineTemplate(defaultE2eCoverageYaml(slug));
  }
  return undefined;
}

function templateForStandaloneArtifact(
  artifact: PlannedArtifact,
  slug: string,
  synthesizedSources: SynthesizedSources,
): TemplateSpec | undefined {
  const synthesizedTemplate = templateForSynthesizedArtifact(artifact, slug, synthesizedSources);
  if (synthesizedTemplate) {
    return synthesizedTemplate;
  }
  const handlerDirectoryTemplate = templateForHandlerDirectoryArtifact(artifact, slug);
  if (handlerDirectoryTemplate) {
    return handlerDirectoryTemplate;
  }

  return templateForStandalonePath(artifact.path, slug);
}

function assertSupportedTemplate(template: ProgramTemplate | undefined): void {
  const value = template as string | undefined;
  if (!value || value === 'pgas-new-foundry') {
    return;
  }

  throw new Error(
    `invalid --template: ${value}. In v3.0, only pgas-new-foundry is supported. ` +
      'For per-domain programs, run the bare `pgas-new` REPL and walk the foundry design interview.',
  );
}

function templateForStandalonePath(path: string, slug: string): TemplateSpec | undefined {
  if (path === `.pgas/pgas-new/${slug}/dossier.yml`) {
    return STANDALONE_TEMPLATE_BY_PATH['.pgas/pgas-new/{{SLUG}}/dossier.yml'];
  }
  if (path === `.pgas/pgas-new/${slug}/artifacts.json`) {
    return STANDALONE_TEMPLATE_BY_PATH['.pgas/pgas-new/{{SLUG}}/artifacts.json'];
  }
  if (path === `src/programs/${slug}/specs.yml`) {
    return STANDALONE_TEMPLATE_BY_PATH['src/programs/{{SLUG}}/specs.yml'];
  }
  if (path === `src/programs/${slug}/registration.ts`) {
    return STANDALONE_TEMPLATE_BY_PATH['src/programs/{{SLUG}}/registration.ts'];
  }
  if (path === `src/programs/${slug}/handlers.ts`) {
    return STANDALONE_TEMPLATE_BY_PATH['src/programs/{{SLUG}}/handlers.ts'];
  }
  if (path === `src/programs/${slug}/handlers/index.ts`) {
    return STANDALONE_TEMPLATE_BY_PATH['src/programs/{{SLUG}}/handlers/index.ts'];
  }
  if (path === `src/programs/${slug}/handlers/_resolver.ts`) {
    return STANDALONE_TEMPLATE_BY_PATH['src/programs/{{SLUG}}/handlers/_resolver.ts'];
  }
  if (path === `src/programs/${slug}/tools.ts`) {
    return STANDALONE_TEMPLATE_BY_PATH['src/programs/{{SLUG}}/tools.ts'];
  }

  return STANDALONE_TEMPLATE_BY_PATH[path];
}

function spec(file: string, tokens: readonly string[]): TemplateSpec {
  return { file, tokens };
}

function inlineTemplate(content: string): TemplateSpec {
  return { file: '', tokens: [], content, substitute: false };
}

function renderArtifactWriteContent(options: {
  artifact: PlannedArtifact;
  rendered: string;
  outPath: string;
  tokens: Record<string, string>;
}): string {
  if ((options.artifact.writeMode ?? 'create') !== 'update') {
    return options.rendered;
  }

  if (options.artifact.path === 'qc/e2e-coverage.yml') {
    const existing = existsSync(options.outPath) ? readFileSync(options.outPath, 'utf8') : options.rendered;
    return mergeE2eCoverageYaml(existing, options.tokens.SLUG);
  }

  return options.rendered;
}

function defaultE2eCoverageYaml(slug: string): string {
  return renderStructuredE2eCoverageYaml({ version: 1 }, slug);
}

function mergeE2eCoverageYaml(source: string, slug: string): string {
  const document = parseE2eCoverageYaml(source);
  const textMerged = mergeE2eCoverageText(source, document, slug);
  if (textMerged) {
    return textMerged;
  }

  return renderStructuredE2eCoverageYaml(document, slug);
}

function parseE2eCoverageYaml(source: string): Record<string, unknown> {
  if (source.trim().length === 0) {
    return {};
  }

  const parsed = load(source);
  if (parsed === null || parsed === undefined) {
    return {};
  }
  if (!isRecord(parsed)) {
    throw new Error('qc/e2e-coverage.yml must contain a YAML mapping');
  }
  return parsed;
}

function renderStructuredE2eCoverageYaml(document: Record<string, unknown>, slug: string): string {
  const userFacing = sortedUniqueStrings([...coverageUserFacingPrograms(document.user_facing_programs), slug]);
  const programs = sortRecord({
    ...coveragePrograms(document.programs),
    [slug]: e2eCoverageProgramEntry(slug),
  });
  const next = {
    ...document,
    user_facing_programs: userFacing,
    programs,
  };

  return ensureTrailingNewline(dump(next, { lineWidth: -1, noRefs: true, sortKeys: false }));
}

function mergeE2eCoverageText(source: string, document: Record<string, unknown>, slug: string): string | undefined {
  if (!Array.isArray(document.user_facing_programs) || !document.user_facing_programs.every((value) => typeof value === 'string')) {
    return undefined;
  }
  if (!isRecord(document.programs)) {
    return undefined;
  }

  let lines = stripOneTrailingNewline(source).split('\n');
  if (!document.user_facing_programs.includes(slug)) {
    const merged = insertYamlListItem(lines, 'user_facing_programs', slug);
    if (!merged) return undefined;
    lines = merged;
  }
  if (!Object.prototype.hasOwnProperty.call(document.programs, slug)) {
    const merged = insertCoverageProgramEntry(lines, slug);
    if (!merged) return undefined;
    lines = merged;
  }

  return ensureTrailingNewline(lines.join('\n'));
}

function insertYamlListItem(lines: string[], key: string, value: string): string[] | undefined {
  const block = findTopLevelBlock(lines, key);
  if (!block || lines[block.start].trim() !== `${key}:`) {
    return undefined;
  }

  const next = [...lines];
  const entries: Array<{ index: number; value: string }> = [];
  for (let index = block.start + 1; index < block.end; index += 1) {
    const match = /^  - ([^\s#][^#]*?)(?:\s+#.*)?$/u.exec(next[index]);
    if (match?.[1]) {
      entries.push({ index, value: match[1].trim() });
    }
  }

  const firstGreater = entries.find((entry) => entry.value.localeCompare(value) > 0);
  const insertAt = firstGreater?.index ?? (entries.at(-1)?.index ?? block.start) + 1;
  next.splice(insertAt, 0, `  - ${value}`);
  return next;
}

function insertCoverageProgramEntry(lines: string[], slug: string): string[] | undefined {
  const block = findTopLevelBlock(lines, 'programs');
  if (!block || lines[block.start].trim() !== 'programs:') {
    return undefined;
  }

  const next = [...lines];
  const entries: Array<{ index: number; slug: string }> = [];
  for (let index = block.start + 1; index < block.end; index += 1) {
    const match = /^  ([a-z0-9]+(?:-[a-z0-9]+)*):\s*(?:#.*)?$/u.exec(next[index]);
    if (match?.[1]) {
      entries.push({ index, slug: match[1] });
    }
  }

  const firstGreater = entries.find((entry) => entry.slug.localeCompare(slug) > 0);
  let insertAt = firstGreater?.index ?? block.end;
  if (!firstGreater) {
    while (insertAt > block.start + 1) {
      const previous = next[insertAt - 1].trim();
      if (previous.length !== 0 && !previous.startsWith('#')) {
        break;
      }
      insertAt -= 1;
    }
  }

  next.splice(insertAt, 0, ...coverageProgramEntryLines(slug));
  return next;
}

function coverageProgramEntryLines(slug: string): string[] {
  return [
    '',
    `  ${slug}:`,
    `    facts: qc/facts/${slug}.facts.yml`,
    '    e2e-frontend:',
    '      channels: [frontend]',
    '      required: true',
  ];
}

function findTopLevelBlock(lines: string[], key: string): { start: number; end: number } | undefined {
  const start = lines.findIndex((line) => line.trim() === `${key}:` || line.startsWith(`${key}: `));
  if (start < 0) {
    return undefined;
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (isTopLevelYamlKey(lines[index])) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function isTopLevelYamlKey(line: string): boolean {
  return /^[A-Za-z0-9_-]+:\s*(?:.*)?$/u.test(line);
}

function coverageUserFacingPrograms(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return value;
  }
  throw new Error('qc/e2e-coverage.yml user_facing_programs must be a string array when present');
}

function coveragePrograms(value: unknown): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (Array.isArray(value) && value.length === 0) {
    return {};
  }
  if (isRecord(value)) {
    return value;
  }
  throw new Error('qc/e2e-coverage.yml programs must be a mapping or an empty array');
}

function e2eCoverageProgramEntry(slug: string): Record<string, unknown> {
  return {
    facts: `qc/facts/${slug}.facts.yml`,
    'e2e-frontend': {
      channels: ['frontend'],
      required: true,
    },
  };
}

function sortedUniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function sortRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stripOneTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value.slice(0, -1) : value;
}

function trimRepoRelativePath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

function templateForSynthesizedArtifact(
  artifact: PlannedArtifact,
  slug: string,
  synthesizedSources: SynthesizedSources,
): TemplateSpec | undefined {
  if (!synthesizedSources.specYaml) {
    return undefined;
  }
  if (artifact.path.endsWith(`/${slug}/specs.yml`)) {
    return inlineTemplate(synthesizedSources.specYaml);
  }
  if (artifact.path.endsWith(`/${slug}/registration.ts`)) {
    return spec('program/registration-skeleton.ts.tmpl', ['PASCAL_NAME']);
  }
  if (artifact.path.endsWith(`/${slug}/contracts.ts`) && synthesizedSources.contractsTs) {
    return inlineTemplate(synthesizedSources.contractsTs);
  }
  if (artifact.path.endsWith(`/${slug}/handlers.ts`) && synthesizedSources.handlersTs) {
    return inlineTemplate(synthesizedSources.handlersTs);
  }
  if (artifact.path.endsWith(`/${slug}/handlers/index.ts`) && synthesizedSources.handlersIndexTs) {
    return inlineTemplate(synthesizedSources.handlersIndexTs);
  }
  const stageMatch = artifact.path.match(new RegExp(`/${slug}/stages/([^/]+)\\.ts$`, 'u'));
  if (stageMatch?.[1] && synthesizedSources.stageSources?.[stageMatch[1]]) {
    return inlineTemplate(synthesizedSources.stageSources[stageMatch[1]]);
  }
  if (artifact.path.endsWith(`/${slug}/tools.ts`) && synthesizedSources.toolsTs) {
    return inlineTemplate(synthesizedSources.toolsTs);
  }
  if (artifact.path === 'tests/generated-program-smoke.test.ts' && synthesizedSources.smokeTestTs) {
    return inlineTemplate(synthesizedSources.smokeTestTs);
  }
  return undefined;
}

function templateForHandlerDirectoryArtifact(artifact: PlannedArtifact, slug: string): TemplateSpec | undefined {
  if (artifact.path.endsWith(`/${slug}/handlers/index.ts`)) {
    return spec('program/handlers-index.ts.tmpl', []);
  }
  if (artifact.path.endsWith(`/${slug}/handlers/_resolver.ts`)) {
    return spec('program/handlers-resolver.ts.tmpl', []);
  }
  return undefined;
}

function renderMinimalStageSource(stage: string): string {
  return `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  return {
    result_json: JSON.stringify({ stage: input.stage, status: ${JSON.stringify(`${stage}_ready`)}, at: runtime.now() }),
    items_json: JSON.stringify([${JSON.stringify(`${stage}:ready`)}]),
    digest: '',
  };
}
`;
}


function renderDirectSource(source: string): string {
  if (/\{\{[^}]+\}\}/.test(source)) {
    throw new Error('foundry program source must not contain template tokens');
  }

  return source;
}

function selectTokens(tokens: Record<string, string>, names: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    names.map((name) => {
      const value = tokens[name];
      if (value === undefined) {
        throw new Error(`template token not in pool: ${name}`);
      }
      return [name, value];
    }),
  );
}

function synthesizedSourcesFor(options: {
  synthesizedSpecYaml?: string;
  synthesizedContractsTs?: string;
  synthesizedHandlersTs?: string;
  synthesizedHandlersIndexTs?: string;
  synthesizedStageSources?: Record<string, string>;
  synthesizedToolsTs?: string;
  synthesizedSmokeTestTs?: string;
}): SynthesizedSources {
  return {
    specYaml: options.synthesizedSpecYaml,
    contractsTs: options.synthesizedContractsTs,
    handlersTs: options.synthesizedHandlersTs,
    handlersIndexTs: options.synthesizedHandlersIndexTs,
    stageSources: options.synthesizedStageSources,
    toolsTs: options.synthesizedToolsTs,
    smokeTestTs: options.synthesizedSmokeTestTs,
  };
}

function tokensFor(options: ProgramIdentity & { githubOwner?: string; githubRepo?: string; mandate?: string }, plan: ArtifactPlan): Record<string, string> {
  return {
    ARTIFACT_PATHS_JSON: JSON.stringify(plan.artifacts.map((artifact) => artifact.path), null, 2),
    GITHUB_OWNER: options.githubOwner ?? 'simodelne',
    GITHUB_REPO: options.githubRepo ?? options.slug,
    MANDATE: options.mandate ?? defaultMandate(options.name),
    NAME: options.name,
    PASCAL_NAME: toPascalCase(options.slug),
    PGAS_SERVER_VERSION,
    SLUG: options.slug,
    CONTROL_PLANE_CONTROLS_YAML: renderControlPlaneControlsYaml(options.slug),
  };
}

function defaultMandate(name: string): string {
  return `${name} program generated by pgas-new. Replace this mandate with the approved intake dossier before live graduation.`;
}

function toPascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join('');
}
