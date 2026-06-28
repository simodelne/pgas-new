import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    { stageSlugs: Object.keys(synthesizedSources.stageSources ?? {}) },
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
  const synthesizedSources = synthesizedSourcesFor(options);
  const plan = createExistingRepoArtifactPlan(
    { slug: options.slug, name: options.name },
    options.manifest,
    { stageSlugs: Object.keys(synthesizedSources.stageSources ?? {}) },
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

function assertNoExistingArtifacts(rootDir: string, plan: ArtifactPlan): void {
  const collisions = plan.artifacts
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
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, rendered);
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

  return templateForStandalonePath(artifact.path, slug);
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
