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

export type ProgramTemplate = 'pgas-new-foundry' | 'policy-drafting' | 'web-scraper' | 'social-media-agent';

export interface RenderStandaloneOptions extends ProgramIdentity {
  outDir: string;
  githubOwner?: string;
  githubRepo?: string;
  template?: ProgramTemplate;
  mandate?: string;
}

export interface RenderExistingRepoOptions extends ProgramIdentity {
  repoRoot: string;
  manifest: WiringManifest;
  template?: ProgramTemplate;
  mandate?: string;
}

export interface RenderResult {
  plan: ArtifactPlan;
  written: string[];
}

interface TemplateSpec {
  file: string;
  tokens: readonly string[];
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
  'src/programs/{{SLUG}}/specs.yml': spec('program/specs.yml.tmpl', ['CONTROL_PLANE_CONTROLS_YAML', 'NAME', 'SLUG']),
  'src/programs/{{SLUG}}/registration.ts': spec('program/registration.ts.tmpl', ['PASCAL_NAME']),
  'src/programs/{{SLUG}}/handlers.ts': spec('program/handlers.ts.tmpl', []),
  'src/programs/{{SLUG}}/tools.ts': spec('program/tools.ts.tmpl', ['PASCAL_NAME']),
  'tests/spec-load.test.ts': spec('tests/spec-load.test.ts.tmpl', ['PASCAL_NAME', 'SLUG']),
  'tests/control-plane.test.ts': spec('tests/control-plane.test.ts.tmpl', ['PASCAL_NAME', 'SLUG']),
  'tests/program-deterministic.test.ts': spec('tests/program-deterministic.test.ts.tmpl', ['PASCAL_NAME', 'SLUG']),
  'tests/api-blackbox.test.ts': spec('tests/api-blackbox.test.ts.tmpl', ['PASCAL_NAME', 'SLUG']),
  'tests/live-provider.test.ts': spec('tests/live-provider.test.ts.tmpl', ['SLUG']),
  'audit/PGAS-NEW-GRADUATION.md': spec('audit/PGAS-NEW-GRADUATION.md.tmpl', ['NAME', 'SLUG']),
};

// The three graduation programs are frozen regression evidence, not active
// scaffold templates. They intentionally resolve from docs/graduation-evidence
// while the generic artifact manifest remains under templates/pgas-new/consumer.
const EXISTING_POLICY_TEMPLATE_BY_KIND: Partial<Record<PlannedArtifact['kind'], TemplateSpec>> = {
  spec: spec('../../docs/graduation-evidence/policy-drafting/specs.yml.tmpl', ['CONTROL_PLANE_CONTROLS_YAML', 'MANDATE', 'NAME', 'SLUG']),
  registration: spec('program/registration.ts.tmpl', ['PASCAL_NAME']),
  handler: spec('../../docs/graduation-evidence/policy-drafting/handlers.ts.tmpl', []),
  tool: spec('../../docs/graduation-evidence/policy-drafting/tools.ts.tmpl', ['PASCAL_NAME']),
  dossier: spec('../../docs/graduation-evidence/policy-drafting/dossier.yml.tmpl', ['MANDATE', 'NAME', 'SLUG']),
  metadata: spec('consumer/artifacts.json.tmpl', ['ARTIFACT_PATHS_JSON', 'NAME', 'PGAS_SERVER_VERSION', 'SLUG']),
  audit: spec('audit/PGAS-NEW-GRADUATION.md.tmpl', ['NAME', 'SLUG']),
};

const EXISTING_WEB_SCRAPER_TEMPLATE_BY_KIND: Partial<Record<PlannedArtifact['kind'], TemplateSpec>> = {
  spec: spec('../../docs/graduation-evidence/web-scraper/specs.yml.tmpl', ['CONTROL_PLANE_CONTROLS_YAML', 'MANDATE', 'NAME', 'SLUG']),
  registration: spec('program/registration.ts.tmpl', ['PASCAL_NAME']),
  handler: spec('../../docs/graduation-evidence/web-scraper/handlers.ts.tmpl', []),
  tool: spec('../../docs/graduation-evidence/web-scraper/tools.ts.tmpl', ['PASCAL_NAME']),
  dossier: spec('../../docs/graduation-evidence/web-scraper/dossier.yml.tmpl', ['MANDATE', 'NAME', 'SLUG']),
  metadata: spec('consumer/artifacts.json.tmpl', ['ARTIFACT_PATHS_JSON', 'NAME', 'PGAS_SERVER_VERSION', 'SLUG']),
  audit: spec('audit/PGAS-NEW-GRADUATION.md.tmpl', ['NAME', 'SLUG']),
};

const EXISTING_SOCIAL_MEDIA_AGENT_TEMPLATE_BY_KIND: Partial<Record<PlannedArtifact['kind'], TemplateSpec>> = {
  spec: spec('../../docs/graduation-evidence/social-media-agent/specs.yml.tmpl', ['CONTROL_PLANE_CONTROLS_YAML', 'MANDATE', 'NAME', 'SLUG']),
  registration: spec('program/registration.ts.tmpl', ['PASCAL_NAME']),
  handler: spec('../../docs/graduation-evidence/social-media-agent/handlers.ts.tmpl', []),
  tool: spec('../../docs/graduation-evidence/social-media-agent/tools.ts.tmpl', ['PASCAL_NAME']),
  dossier: spec('../../docs/graduation-evidence/social-media-agent/dossier.yml.tmpl', ['MANDATE', 'NAME', 'SLUG']),
  metadata: spec('consumer/artifacts.json.tmpl', ['ARTIFACT_PATHS_JSON', 'NAME', 'PGAS_SERVER_VERSION', 'SLUG']),
  audit: spec('audit/PGAS-NEW-GRADUATION.md.tmpl', ['NAME', 'SLUG']),
};

const STANDALONE_PROGRAM_OVERRIDE_BY_TEMPLATE: Record<
  Exclude<ProgramTemplate, 'pgas-new-foundry'>,
  Partial<Record<PlannedArtifact['kind'], TemplateSpec>>
> = {
  'policy-drafting': {
    spec: spec('../../docs/graduation-evidence/policy-drafting/specs.yml.tmpl', ['CONTROL_PLANE_CONTROLS_YAML', 'MANDATE', 'NAME', 'SLUG']),
    handler: spec('../../docs/graduation-evidence/policy-drafting/handlers.ts.tmpl', []),
    tool: spec('../../docs/graduation-evidence/policy-drafting/tools.ts.tmpl', ['PASCAL_NAME']),
    dossier: spec('../../docs/graduation-evidence/policy-drafting/dossier.yml.tmpl', ['MANDATE', 'NAME', 'SLUG']),
  },
  'web-scraper': {
    spec: spec('../../docs/graduation-evidence/web-scraper/specs.yml.tmpl', ['CONTROL_PLANE_CONTROLS_YAML', 'MANDATE', 'NAME', 'SLUG']),
    handler: spec('../../docs/graduation-evidence/web-scraper/handlers.ts.tmpl', []),
    tool: spec('../../docs/graduation-evidence/web-scraper/tools.ts.tmpl', ['PASCAL_NAME']),
    dossier: spec('../../docs/graduation-evidence/web-scraper/dossier.yml.tmpl', ['MANDATE', 'NAME', 'SLUG']),
  },
  'social-media-agent': {
    spec: spec('../../docs/graduation-evidence/social-media-agent/specs.yml.tmpl', ['CONTROL_PLANE_CONTROLS_YAML', 'MANDATE', 'NAME', 'SLUG']),
    handler: spec('../../docs/graduation-evidence/social-media-agent/handlers.ts.tmpl', []),
    tool: spec('../../docs/graduation-evidence/social-media-agent/tools.ts.tmpl', ['PASCAL_NAME']),
    dossier: spec('../../docs/graduation-evidence/social-media-agent/dossier.yml.tmpl', ['MANDATE', 'NAME', 'SLUG']),
  },
};

export function renderStandaloneScaffold(options: RenderStandaloneOptions): RenderResult {
  const plan = createStandaloneArtifactPlan({ slug: options.slug, name: options.name });
  const template = options.template ?? 'pgas-new-foundry';

  assertNoExistingArtifacts(options.outDir, plan);

  return renderPlan({
    plan,
    rootDir: options.outDir,
    templateForArtifact: (artifact) => templateForStandaloneArtifact(artifact, options.slug, template),
    tokens: tokensFor(options, plan),
  });
}

export function renderExistingRepoAttachment(options: RenderExistingRepoOptions): RenderResult {
  const plan = createExistingRepoArtifactPlan({ slug: options.slug, name: options.name }, options.manifest);
  const template = options.template ?? 'pgas-new-foundry';

  assertNoExistingArtifacts(options.repoRoot, plan);

  return renderPlan({
    plan,
    rootDir: options.repoRoot,
    templateForArtifact: (artifact) => templateForExistingArtifact(artifact, options.slug, template),
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

    const source = readFileSync(join(TEMPLATE_ROOT, templatePath.file), 'utf8');
    const rendered = renderTemplate(source, selectTokens(options.tokens, templatePath.tokens));
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
  template: ProgramTemplate,
): TemplateSpec | undefined {
  if (template === 'policy-drafting') {
    return EXISTING_POLICY_TEMPLATE_BY_KIND[artifact.kind];
  }
  if (template === 'web-scraper') {
    return EXISTING_WEB_SCRAPER_TEMPLATE_BY_KIND[artifact.kind];
  }
  if (template === 'social-media-agent') {
    return EXISTING_SOCIAL_MEDIA_AGENT_TEMPLATE_BY_KIND[artifact.kind];
  }

  return templateForFoundryArtifact(artifact, slug);
}

function templateForFoundryArtifact(artifact: PlannedArtifact, slug: string): TemplateSpec | undefined {
  if (artifact.kind === 'spec') {
    return STANDALONE_TEMPLATE_BY_PATH['src/programs/{{SLUG}}/specs.yml'];
  }
  if (artifact.kind === 'registration') {
    return STANDALONE_TEMPLATE_BY_PATH['src/programs/{{SLUG}}/registration.ts'];
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
  template: ProgramTemplate,
): TemplateSpec | undefined {
  if (template !== 'pgas-new-foundry') {
    const override = STANDALONE_PROGRAM_OVERRIDE_BY_TEMPLATE[template][artifact.kind];
    if (override) {
      return override;
    }
  }

  return templateForStandalonePath(artifact.path, slug);
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
  if (path === `src/programs/${slug}/tools.ts`) {
    return STANDALONE_TEMPLATE_BY_PATH['src/programs/{{SLUG}}/tools.ts'];
  }

  return STANDALONE_TEMPLATE_BY_PATH[path];
}

function spec(file: string, tokens: readonly string[]): TemplateSpec {
  return { file, tokens };
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
