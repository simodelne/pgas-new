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

const STANDALONE_TEMPLATE_BY_PATH: Record<string, string> = {
  '.pgas/wiring.yml': 'repo/.pgas/wiring.yml.tmpl',
  '.pgas/pgas-new/{{SLUG}}/dossier.yml': 'standalone/.pgas/pgas-new/dossier.yml.tmpl',
  '.pgas/pgas-new/{{SLUG}}/artifacts.json': 'standalone/.pgas/pgas-new/artifacts.json.tmpl',
  'package.json': 'standalone/package.json.tmpl',
  'tsconfig.json': 'standalone/tsconfig.json.tmpl',
  'src/server.ts': 'standalone/src/server.ts.tmpl',
  'src/repl/index.ts': 'standalone/src/repl/index.ts.tmpl',
  'src/programs/{{SLUG}}/specs.yml': 'program/specs.yml.tmpl',
  'src/programs/{{SLUG}}/registration.ts': 'program/registration.ts.tmpl',
  'src/programs/{{SLUG}}/handlers.ts': 'program/handlers.ts.tmpl',
  'src/programs/{{SLUG}}/tools.ts': 'program/tools.ts.tmpl',
  'tests/spec-load.test.ts': 'tests/spec-load.test.ts.tmpl',
  'tests/control-plane.test.ts': 'tests/control-plane.test.ts.tmpl',
  'tests/program-deterministic.test.ts': 'tests/program-deterministic.test.ts.tmpl',
  'tests/api-blackbox.test.ts': 'tests/api-blackbox.test.ts.tmpl',
  'tests/live-provider.test.ts': 'tests/live-provider.test.ts.tmpl',
  'audit/PGAS-NEW-GRADUATION.md': 'audit/PGAS-NEW-GRADUATION.md.tmpl',
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

    const source = readFileSync(join(TEMPLATE_ROOT, templatePath), 'utf8');
    const rendered = renderTemplate(source, tokens, { allowUnusedTokens: true });
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

  return rendered;
}

function templateForPath(path: string, slug: string): string | undefined {
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
