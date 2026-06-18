import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStandaloneArtifactPlan, type ArtifactPlan, type ProgramIdentity } from './artifact-plan.js';
import { PGAS_SERVER_VERSION } from './version.js';

const TEMPLATE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../templates/pgas-new');

export interface RenderStandaloneOptions extends ProgramIdentity {
  outDir: string;
  githubOwner?: string;
  githubRepo?: string;
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
  '.pgas/pgas-new/{{SLUG}}/dossier.yml': spec('standalone/.pgas/pgas-new/dossier.yml.tmpl', ['NAME', 'SLUG']),
  '.pgas/pgas-new/{{SLUG}}/artifacts.json': spec('standalone/.pgas/pgas-new/artifacts.json.tmpl', [
    'NAME',
    'PGAS_SERVER_VERSION',
    'SLUG',
  ]),
  'package.json': spec('standalone/package.json.tmpl', ['PGAS_SERVER_VERSION', 'SLUG']),
  'tsconfig.json': spec('standalone/tsconfig.json.tmpl', []),
  'src/server.ts': spec('standalone/src/server.ts.tmpl', ['PASCAL_NAME', 'SLUG']),
  'src/repl/index.ts': spec('standalone/src/repl/index.ts.tmpl', ['PASCAL_NAME', 'SLUG']),
  'src/programs/{{SLUG}}/specs.yml': spec('program/specs.yml.tmpl', ['NAME', 'SLUG']),
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

export function renderStandaloneScaffold(options: RenderStandaloneOptions): RenderResult {
  const plan = createStandaloneArtifactPlan({ slug: options.slug, name: options.name });
  const tokens = tokensFor(options);
  const written: string[] = [];

  for (const artifact of plan.artifacts) {
    const templatePath = templateForPath(artifact.path, options.slug);
    if (!templatePath) {
      throw new Error(`no template for artifact path: ${artifact.path}`);
    }

    const source = readFileSync(join(TEMPLATE_ROOT, templatePath.file), 'utf8');
    const rendered = renderTemplate(source, selectTokens(tokens, templatePath.tokens));
    const outPath = join(options.outDir, artifact.path);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, rendered);
    written.push(artifact.path);
  }

  return { plan, written };
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

function templateForPath(path: string, slug: string): TemplateSpec | undefined {
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
  return Object.fromEntries(names.map((name) => [name, tokens[name] ?? '']));
}

function tokensFor(options: RenderStandaloneOptions): Record<string, string> {
  return {
    GITHUB_OWNER: options.githubOwner ?? 'simodelne',
    GITHUB_REPO: options.githubRepo ?? options.slug,
    NAME: options.name,
    PASCAL_NAME: toPascalCase(options.slug),
    PGAS_SERVER_VERSION,
    SLUG: options.slug,
  };
}

function toPascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join('');
}
