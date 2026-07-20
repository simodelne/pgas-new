import { isRecord } from '../util/guards.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dump, load } from 'js-yaml';
import ts from 'typescript';
import {
  createExistingRepoArtifactPlan,
  createStandaloneArtifactPlan,
  type ArtifactPlan,
  type GeneratedArtifactPlanOptions,
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
  synthesizedCapabilityGaps?: CapabilityGapInput[];
  synthesizedSpecYaml?: string;
  synthesizedRegistrationTs?: string;
  synthesizedContractsTs?: string;
  synthesizedHandlersTs?: string;
  synthesizedHandlersIndexTs?: string;
  synthesizedStageSources?: Record<string, string>;
  synthesizedToolsTs?: string;
  synthesizedSmokeTestTs?: string;
  synthesizedChildArtifacts?: SynthesizedChildSourceInput[];
  synthesizedExportSurfaces?: GeneratedArtifactPlanOptions['exportSurfaces'];
  synthesizedDocumentExtractionSurfaces?: GeneratedArtifactPlanOptions['documentExtractionSurfaces'];
}

export interface RenderExistingRepoOptions extends ProgramIdentity {
  repoRoot: string;
  manifest: WiringManifest;
  stageSlugs?: string[];
  template?: ProgramTemplate;
  mandate?: string;
  synthesizedSpecYaml?: string;
  synthesizedRegistrationTs?: string;
  synthesizedContractsTs?: string;
  synthesizedHandlersTs?: string;
  synthesizedHandlersIndexTs?: string;
  synthesizedStageSources?: Record<string, string>;
  synthesizedToolsTs?: string;
  synthesizedSmokeTestTs?: string;
  synthesizedDocumentExtractionSurfaces?: GeneratedArtifactPlanOptions['documentExtractionSurfaces'];
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
  registrationTs?: string;
  contractsTs?: string;
  handlersTs?: string;
  handlersIndexTs?: string;
  stageSources?: Record<string, string>;
  toolsTs?: string;
  smokeTestTs?: string;
  exportSurfaces?: GeneratedArtifactPlanOptions['exportSurfaces'];
  documentExtractionSurfaces?: GeneratedArtifactPlanOptions['documentExtractionSurfaces'];
  capabilityGaps: CapabilityGapInput[];
  childArtifacts: SynthesizedChildSources[];
}

interface CapabilityGapInput {
  capability: string;
  stage: string;
  connector_slug: string;
  message: string;
}

interface SynthesizedChildSourceInput {
  slug: string;
  name: string;
  spec_yaml: string;
  registration_ts?: string;
  contracts_ts: string;
  handlers_ts: string;
  handlers_index_ts: string;
  stage_sources?: Record<string, string>;
  tools_ts: string;
  smoke_test_ts: string;
}

interface SynthesizedChildSources extends SynthesizedSources {
  slug: string;
  name: string;
}

interface ResolvedSynthesizedSources extends SynthesizedSources {
  slug: string;
}

interface RenderedArtifact {
  artifact: PlannedArtifact;
  outPath: string;
  output: string;
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
  'src/author-driver.ts': spec('standalone/src/author-driver.ts.tmpl', []),
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
  const basePlan = createStandaloneArtifactPlan(
    { slug: options.slug, name: options.name },
    {
      stageSlugs: Object.keys(synthesizedSources.stageSources ?? {}),
      includeSmokeTest: typeof synthesizedSources.smokeTestTs === 'string',
      capabilityGaps: synthesizedSources.capabilityGaps,
      exportSurfaces: synthesizedSources.exportSurfaces,
      documentExtractionSurfaces: synthesizedSources.documentExtractionSurfaces,
    },
  );
  const plan = withSynthesizedChildArtifacts(basePlan, synthesizedSources.childArtifacts);
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
      documentExtractionSurfaces: synthesizedSources.documentExtractionSurfaces,
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
  // The program lands at <programs_dir>/<slug> in the existing repo. Consumer QC/spec-graph
  // discovery (and the frontend catalog) locate the spec via ProgramEntry.frontendSpecPath,
  // so stamp the repo-relative program directory into the generated registration.
  const frontendSpecPath = `${trimRepoRelativePath(options.manifest.paths.programs_dir)}/${options.slug}`;
  const registrationTs = sources.registrationTs
    ? injectFrontendSpecPath(sources.registrationTs, frontendSpecPath)
    : sources.registrationTs;

  return {
    ...sources,
    registrationTs,
    smokeTestTs: sources.smokeTestTs
      ? rewriteSmokeTestRegistrationImport(
          sources.smokeTestTs,
          options.slug,
          existingRepoProgramRegistrationImport(options.manifest, options.slug),
        )
      : sources.smokeTestTs,
  };
}

function injectFrontendSpecPath(registrationTs: string, frontendSpecPath: string): string {
  if (registrationTs.includes('frontendSpecPath:')) return registrationTs;
  const anchor = 'return {\n    spec,\n';
  if (!registrationTs.includes(anchor)) return registrationTs;
  return registrationTs.replace(anchor, `return {\n    spec,\n    frontendSpecPath: '${frontendSpecPath}',\n`);
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
  const renderedArtifacts: RenderedArtifact[] = [];

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
    renderedArtifacts.push({ artifact, outPath, output });
  }

  assertNoDuplicateRenderedHandlerBodies(renderedArtifacts);

  for (const { artifact, outPath, output } of renderedArtifacts) {
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
    return spec('consumer/registration-attached.ts.tmpl', ['CAMEL_NAME', 'PASCAL_NAME', 'SLUG']);
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
    return spec('consumer/projection.ts.tmpl', ['CAMEL_NAME', 'PASCAL_NAME', 'SLUG']);
  }
  if (path.endsWith(`/${slug}/frontend.spec.yml`)) {
    return spec('consumer/frontend.spec.yml.tmpl', ['NAME', 'SLUG']);
  }
  if (path.endsWith(`/${slug}/export/html.ts`)) {
    return spec('consumer/export-html.ts.tmpl', ['NAME']);
  }
  if (path.endsWith(`/${slug}/export/docx.ts`)) {
    return spec('consumer/export-docx.ts.tmpl', ['NAME']);
  }
  if (path.endsWith(`/${slug}/extract/docx.ts`)) {
    return spec('consumer/extract-docx.ts.tmpl', []);
  }
  if (path.endsWith(`/${slug}/export/diff.ts`)) {
    return spec('consumer/export-diff.ts.tmpl', []);
  }
  if (path === `tests/${slug}-deterministic.test.ts`) {
    return spec('consumer/deterministic.test.ts.tmpl', ['CAMEL_NAME', 'SLUG']);
  }
  if (path === `qc/e2e-frontend/${slug}.scenario.yml`) {
    return spec('consumer/e2e-frontend.scenario.yml.tmpl', ['SLUG']);
  }
  if (path === `qc/facts/${slug}.facts.yml`) {
    return spec('consumer/facts.yml.tmpl', ['SLUG']);
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
  if (artifact.path === 'README.md' && synthesizedSources.capabilityGaps.length > 0) {
    return inlineTemplate(renderCapabilityGapReadme(slug, synthesizedSources.capabilityGaps));
  }
  if (artifact.path === 'audit/PGAS-NEW-GRADUATION.md' && synthesizedSources.capabilityGaps.length > 0) {
    return inlineTemplate(renderCapabilityGapGraduationAudit(slug, synthesizedSources.capabilityGaps));
  }
  if (artifact.path === 'src/server.ts' && synthesizedSources.childArtifacts.length > 0) {
    return inlineTemplate(renderMultiProgramServerSource(slug, synthesizedSources.childArtifacts.map((child) => child.slug)));
  }
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
  if (path === `src/programs/${slug}/export/html.ts`) {
    return spec('consumer/export-html.ts.tmpl', ['NAME']);
  }
  if (path === `src/programs/${slug}/export/docx.ts`) {
    return spec('consumer/export-docx.ts.tmpl', ['NAME']);
  }
  if (path === `src/programs/${slug}/extract/docx.ts`) {
    return spec('consumer/extract-docx.ts.tmpl', []);
  }
  if (path === `src/programs/${slug}/export/diff.ts`) {
    return spec('consumer/export-diff.ts.tmpl', []);
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
  const selected = synthesizedSourcesForArtifact(artifact.path, slug, synthesizedSources);
  if (!selected?.specYaml) {
    return undefined;
  }
  if (artifact.path.endsWith(`/${selected.slug}/specs.yml`)) {
    return inlineTemplate(selected.specYaml);
  }
  if (artifact.path.endsWith(`/${selected.slug}/registration.ts`)) {
    if (selected.registrationTs) {
      return inlineTemplate(selected.registrationTs);
    }
    if (artifact.path !== `src/programs/${selected.slug}/registration.ts`) {
      return spec('consumer/registration-attached.ts.tmpl', ['CAMEL_NAME', 'PASCAL_NAME', 'SLUG']);
    }
    return spec('program/registration-skeleton.ts.tmpl', ['PASCAL_NAME']);
  }
  if (artifact.path.endsWith(`/${selected.slug}/contracts.ts`) && selected.contractsTs) {
    return inlineTemplate(selected.contractsTs);
  }
  if (artifact.path.endsWith(`/${selected.slug}/handlers.ts`) && selected.handlersTs) {
    return inlineTemplate(selected.handlersTs);
  }
  if (artifact.path.endsWith(`/${selected.slug}/handlers/index.ts`)) {
    if (selected.handlersTs && selected.handlersIndexTs) {
      assertNoDuplicateHandlerBodies(selected.handlersTs, selected.handlersIndexTs, artifact.path);
    }
    return inlineTemplate(renderHandlersIndexBarrelSource());
  }
  const stageMatch = artifact.path.match(new RegExp(`/${selected.slug}/stages/([^/]+)\\.ts$`, 'u'));
  if (stageMatch?.[1] && selected.stageSources?.[stageMatch[1]]) {
    return inlineTemplate(selected.stageSources[stageMatch[1]]);
  }
  if (artifact.path.endsWith(`/${selected.slug}/tools.ts`) && selected.toolsTs) {
    return inlineTemplate(selected.toolsTs);
  }
  if (artifact.path === 'tests/generated-program-smoke.test.ts' && selected.smokeTestTs) {
    return inlineTemplate(selected.smokeTestTs);
  }
  return undefined;
}

function synthesizedSourcesForArtifact(
  artifactPath: string,
  primarySlug: string,
  sources: SynthesizedSources,
): ResolvedSynthesizedSources | undefined {
  if (artifactPath === 'tests/generated-program-smoke.test.ts') {
    return { ...sources, slug: primarySlug };
  }
  if (artifactPathBelongsToProgram(artifactPath, primarySlug)) {
    return { ...sources, slug: primarySlug };
  }
  return sources.childArtifacts.find((child) =>
    artifactPathBelongsToProgram(artifactPath, child.slug));
}

function artifactPathBelongsToProgram(artifactPath: string, slug: string): boolean {
  return artifactPath.includes(`/${slug}/`) || artifactPath.startsWith(`${slug}/`);
}

function withSynthesizedChildArtifacts(plan: ArtifactPlan, children: SynthesizedChildSources[]): ArtifactPlan {
  if (children.length === 0) {
    return plan;
  }
  return {
    ...plan,
    artifacts: uniquePlannedArtifacts([
      ...plan.artifacts,
      ...children.flatMap(childProgramArtifacts),
    ]),
  };
}

function childProgramArtifacts(child: SynthesizedChildSources): PlannedArtifact[] {
  const slug = child.slug;
  const stageSlugs = Object.keys(child.stageSources ?? {});
  return [
    plannedArtifact('spec', `src/programs/${slug}/specs.yml`, 'Declare synthesized delegated child PGAS program spec.', 'branch_write', [
      'spec-load',
    ]),
    plannedArtifact('registration', `src/programs/${slug}/registration.ts`, 'Register synthesized delegated child program using public plugin.js helpers.', 'branch_write', [
      'typecheck',
    ]),
    ...(stageSlugs.length > 0
      ? [
          plannedArtifact('contract', `src/programs/${slug}/contracts.ts`, 'Declare delegated child stage contracts.', 'domain_synthesis', [
            'typecheck',
          ]),
          ...stageSlugs.map((stageSlug) =>
            plannedArtifact('stage', `src/programs/${slug}/stages/${stageSlug}.ts`, `Implement delegated child stage ${stageSlug}.`, 'domain_synthesis', [
              'typecheck',
            ])),
        ]
      : []),
    plannedArtifact('handler', `src/programs/${slug}/handlers.ts`, 'Implement delegated child handlers and reactions.', 'branch_write', [
      'typecheck',
    ]),
    plannedArtifact('handler', `src/programs/${slug}/handlers/index.ts`, 'Expose delegated child handlers from the handler directory.', 'branch_write', [
      'typecheck',
    ]),
    plannedArtifact('handler', `src/programs/${slug}/handlers/_resolver.ts`, 'Resolve delegated child handler values from payload or state.', 'branch_write', [
      'typecheck',
    ]),
    plannedArtifact('tool', `src/programs/${slug}/tools.ts`, 'Declare delegated child action metadata.', 'branch_write', [
      'typecheck',
    ]),
  ];
}

function plannedArtifact(
  kind: PlannedArtifact['kind'],
  path: string,
  purpose: string,
  mode_introduced: PlannedArtifact['mode_introduced'],
  verification: string[],
): PlannedArtifact {
  return {
    kind,
    path,
    purpose,
    owner: 'pgas-new',
    mode_introduced,
    verification,
  };
}

function uniquePlannedArtifacts(artifacts: PlannedArtifact[]): PlannedArtifact[] {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    if (seen.has(artifact.path)) {
      return false;
    }
    seen.add(artifact.path);
    return true;
  });
}

function renderCapabilityGapReadme(slug: string, gaps: readonly CapabilityGapInput[]): string {
  return `# ${slug}

This PGAS program was generated by pgas-new.

## Capability Gaps

${gaps.map((gap) => `- ${gap.capability} (${gap.stage}): ${gap.message}`).join('\n')}
`;
}

function renderCapabilityGapGraduationAudit(slug: string, gaps: readonly CapabilityGapInput[]): string {
  return `# ${slug} PGAS-New Graduation

Program: \`${slug}\`

Static verification is required before live verification. Final graduation requires a real provider round trip through the external API and must not be inferred from deterministic tests.

## Capability Gaps

${gaps.map((gap) => `- ${gap.capability} (${gap.stage}): ${gap.message}`).join('\n')}

## Evidence

- Static verification: pending
- API black-box verification: pending
- Live provider verification: pending
- Post-rebase verification: pending
- Pull request: pending
`;
}

function renderMultiProgramServerSource(primarySlug: string, childSlugs: string[]): string {
  const imports = [
    `import { create${toPascalCase(primarySlug)}ProgramEntry } from './programs/${primarySlug}/registration.js';`,
    ...childSlugs.map((slug) => `import { create${toPascalCase(slug)}ProgramEntry } from './programs/${slug}/registration.js';`),
  ].join('\n');
  const programs = [
    `{ name: '${primarySlug}', entry: create${toPascalCase(primarySlug)}ProgramEntry() }`,
    ...childSlugs.map((slug) => `{ name: '${slug}', entry: create${toPascalCase(slug)}ProgramEntry() }`),
  ].join(',\n    ');
  return `import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import { resolveAuthorDrivers } from './author-driver.js';
${imports}

// Opt-in unified native-tools author driver (PGAS_AUTHOR_DRIVER=unified).
// Default (env unset): \`drivers\` is undefined, no \`drivers\` key is passed,
// and the engine boots its legacy JSON author path exactly as before.
const drivers = resolveAuthorDrivers();

const server = await createPgasServer({
  programs: [
    ${programs},
  ],
  devMode: process.env.PGAS_DEV_MODE === '1',
  ...(drivers ? { drivers } : {}),
});

await server.start();
`;
}

function templateForHandlerDirectoryArtifact(artifact: PlannedArtifact, slug: string): TemplateSpec | undefined {
  void slug;
  if (artifact.path.endsWith('/handlers/index.ts')) {
    return spec('program/handlers-index.ts.tmpl', []);
  }
  if (artifact.path.endsWith('/handlers/_resolver.ts')) {
    return spec('program/handlers-resolver.ts.tmpl', []);
  }
  return undefined;
}

function renderHandlersIndexBarrelSource(): string {
  return "export { handlers, reactionHandlers } from '../handlers.js';\n";
}

function assertNoDuplicateRenderedHandlerBodies(renderedArtifacts: RenderedArtifact[]): void {
  const byProgramDir = new Map<string, { primary?: RenderedArtifact; index?: RenderedArtifact }>();
  for (const rendered of renderedArtifacts) {
    const path = rendered.artifact.path;
    if (!path.endsWith('/handlers.ts') && !path.endsWith('/handlers/index.ts')) {
      continue;
    }
    const key = path.endsWith('/handlers.ts')
      ? path.slice(0, -'/handlers.ts'.length)
      : path.slice(0, -'/handlers/index.ts'.length);
    const entry = byProgramDir.get(key) ?? {};
    if (path.endsWith('/handlers.ts')) {
      entry.primary = rendered;
    } else {
      entry.index = rendered;
    }
    byProgramDir.set(key, entry);
  }

  for (const entry of byProgramDir.values()) {
    if (entry.primary && entry.index) {
      assertNoDuplicateHandlerBodies(entry.primary.output, entry.index.output, entry.index.artifact.path);
    }
  }
}

function assertNoDuplicateHandlerBodies(primarySource: string, indexSource: string, indexPath: string): void {
  const primaryBodies = new Set(handlerFunctionBodies(primarySource));
  if (primaryBodies.size === 0) {
    return;
  }
  for (const body of handlerFunctionBodies(indexSource)) {
    if (primaryBodies.has(body)) {
      throw new Error(`duplicate generated handler implementation in ${indexPath}; handlers/index.ts must re-export handlers.ts`);
    }
  }
}

function handlerFunctionBodies(source: string): string[] {
  const sourceFile = ts.createSourceFile('handlers.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bodies: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && node.body) {
      bodies.push(normalizeFunctionBody(node.body.getText(sourceFile)));
    }
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isFunctionExpression(node.initializer) || ts.isArrowFunction(node.initializer)) &&
      ts.isBlock(node.initializer.body)
    ) {
      bodies.push(normalizeFunctionBody(node.initializer.body.getText(sourceFile)));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bodies;
}

function normalizeFunctionBody(body: string): string {
  return body.replace(/\s+/gu, ' ').trim();
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
  synthesizedRegistrationTs?: string;
  synthesizedContractsTs?: string;
  synthesizedHandlersTs?: string;
  synthesizedHandlersIndexTs?: string;
  synthesizedStageSources?: Record<string, string>;
  synthesizedToolsTs?: string;
  synthesizedSmokeTestTs?: string;
  synthesizedExportSurfaces?: GeneratedArtifactPlanOptions['exportSurfaces'];
  synthesizedDocumentExtractionSurfaces?: GeneratedArtifactPlanOptions['documentExtractionSurfaces'];
  synthesizedCapabilityGaps?: CapabilityGapInput[];
  synthesizedChildArtifacts?: SynthesizedChildSourceInput[];
}): SynthesizedSources {
  return {
    specYaml: options.synthesizedSpecYaml,
    registrationTs: options.synthesizedRegistrationTs,
    contractsTs: options.synthesizedContractsTs,
    handlersTs: options.synthesizedHandlersTs,
    handlersIndexTs: options.synthesizedHandlersIndexTs,
    stageSources: options.synthesizedStageSources,
    toolsTs: options.synthesizedToolsTs,
    smokeTestTs: options.synthesizedSmokeTestTs,
    exportSurfaces: options.synthesizedExportSurfaces,
    documentExtractionSurfaces: options.synthesizedDocumentExtractionSurfaces,
    capabilityGaps: options.synthesizedCapabilityGaps ?? [],
    childArtifacts: (options.synthesizedChildArtifacts ?? []).map((child) => ({
      slug: child.slug,
      name: child.name,
      specYaml: child.spec_yaml,
      registrationTs: child.registration_ts,
      contractsTs: child.contracts_ts,
      handlersTs: child.handlers_ts,
      handlersIndexTs: child.handlers_index_ts,
      stageSources: child.stage_sources,
      toolsTs: child.tools_ts,
      smokeTestTs: child.smoke_test_ts,
      capabilityGaps: [],
      childArtifacts: [],
    })),
  };
}

function tokensFor(options: ProgramIdentity & { githubOwner?: string; githubRepo?: string; mandate?: string }, plan: ArtifactPlan): Record<string, string> {
  return {
    ARTIFACT_PATHS_JSON: JSON.stringify(plan.artifacts.map((artifact) => artifact.path), null, 2),
    GITHUB_OWNER: options.githubOwner ?? 'simodelne',
    GITHUB_REPO: options.githubRepo ?? options.slug,
    MANDATE: options.mandate ?? defaultMandate(options.name),
    NAME: options.name,
    CAMEL_NAME: toCamelCase(options.slug),
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

function toCamelCase(value: string): string {
  const pascal = toPascalCase(value);
  return `${pascal[0]?.toLowerCase() ?? ''}${pascal.slice(1)}`;
}
