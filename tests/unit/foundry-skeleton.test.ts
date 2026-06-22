import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { renderTemplate } from '../../src/pgas-new/template-renderer.js';

const require = createRequire(import.meta.url);

const ENGINE_OWNED_SCHEMA_PATHS = [
  'inputs.query_result.kind',
  'inputs.query_result.value_json',
  'inputs.query_meta.source_path',
  'inputs.query_meta.source_channel',
  'inputs.query_meta.continuation_round',
  'inputs.query_meta.scope_redirect',
  'inputs.query_meta.message',
  'inputs.mode_entry.mode',
  'inputs.mode_entry.from_mode',
  'inputs.mode_entry.entry_round',
  'governance.round_counter',
] as const;

const SPEC_SKELETON = 'templates/pgas-new/program/spec-skeleton.yml.tmpl';
const HANDLERS_SKELETON = 'templates/pgas-new/program/handlers-skeleton.ts.tmpl';
const REGISTRATION_SKELETON = 'templates/pgas-new/program/registration-skeleton.ts.tmpl';
const FOUNDRY_SPEC = 'src/foundry-program/specs.yml';

interface SkeletonSpec {
  channels: Record<string, { direction: string; sync: string }>;
  ingestion: Record<string, string[]>;
  modes: Record<string, { channels?: string[] }>;
  schema: Record<string, string>;
}

describe('foundry generic program skeleton', () => {
  it('declares FM5 engine-owned schema paths', () => {
    const spec = readSkeletonSpec();

    for (const path of ENGINE_OWNED_SCHEMA_PATHS) {
      expect(spec.schema[path], `${path} should be declared`).toBeDefined();
    }
  });

  it('declares the FM1 handler index plus resolver layout', () => {
    const handlers = readFileSync(HANDLERS_SKELETON, 'utf8');

    expect(handlers).toContain('handlers/index.ts');
    expect(handlers).toContain('handlers/_resolver.ts');
    expect(handlers).toContain('resolveDomainValue');
  });

  it('declares the internal mode-entry channel for bootstrap continuation', () => {
    const spec = readSkeletonSpec();

    expect(spec.channels.system_mode_entry).toEqual({ direction: 'In', sync: 'Async' });
    expect(spec.ingestion.system_mode_entry).toEqual(['inputs.mode_entry']);
    expect(spec.modes.start.channels ?? []).toContain('system_mode_entry');
  });

  it('uses the createAdapters override convention in registration', () => {
    const registration = readFileSync(REGISTRATION_SKELETON, 'utf8');

    expect(registration).toContain('createAdapters');
    expect(registration).toContain('createProgramAdapters');
    expect(registration).toContain('adapters.outputs.set');
  });
});

const engineTestingPath = resolveEngineTestingPath();
const enginePluginPath = resolveEnginePluginPath();
const engineLoaderTest = engineTestingPath && enginePluginPath ? it : it.skip;

describe('foundry generic program skeleton engine loader', () => {
  engineLoaderTest('loads through the installed @simodelne/pgas-server loader', async () => {
    const specText = renderSkeletonSpec();
    const dir = mkdtempSync(join(tmpdir(), 'pgas-new-skeleton-load-'));
    try {
      const specPath = join(dir, 'specs.yml');
      writeFileSync(specPath, specText);
      await import(/* @vite-ignore */ pathToFileURL(engineTestingPath as string).href);
      const plugin = await import(/* @vite-ignore */ pathToFileURL(enginePluginPath as string).href) as Record<string, unknown>;
      const loadSpecWithPatterns = plugin.loadSpecWithPatterns as ((path: string) => unknown) | undefined;

      expect(typeof loadSpecWithPatterns).toBe('function');
      expect(() => loadSpecWithPatterns?.(specPath)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  engineLoaderTest('loads the foundry runtime spec through the installed @simodelne/pgas-server loader', async () => {
    await import(/* @vite-ignore */ pathToFileURL(engineTestingPath as string).href);
    const plugin = await import(/* @vite-ignore */ pathToFileURL(enginePluginPath as string).href) as Record<string, unknown>;
    const loadSpecWithPatterns = plugin.loadSpecWithPatterns as ((path: string) => unknown) | undefined;

    expect(typeof loadSpecWithPatterns).toBe('function');
    expect(() => loadSpecWithPatterns?.(FOUNDRY_SPEC)).not.toThrow();
  });
});

function readSkeletonSpec(): SkeletonSpec {
  return load(renderSkeletonSpec()) as SkeletonSpec;
}

function renderSkeletonSpec(): string {
  return renderTemplate(readFileSync(SPEC_SKELETON, 'utf8'), {
    NAME: 'Sample Program',
    SLUG: 'sample-program',
  });
}

function resolveEngineTestingPath(): string | undefined {
  try {
    return require.resolve('@simodelne/pgas-server/testing.js');
  } catch {
    return undefined;
  }
}

function resolveEnginePluginPath(): string | undefined {
  try {
    return require.resolve('@simodelne/pgas-server/plugin.js');
  } catch {
    return undefined;
  }
}
