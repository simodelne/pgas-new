import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import type { SynthesizedArtifact } from '../../src/foundry-program/synthesizer-store.js';
import { renderStandaloneScaffold, type RenderStandaloneOptions } from '../../src/pgas-new/template-renderer.js';

const uploadDomain = {
  'program.slug': 'document-upload-hermetic',
  'program.name': 'Document Upload Hermetic',
  'program.target_dir': '/tmp/document-upload-hermetic',
  'program.design_path': 'design',
  'intake.purpose': 'Request an uploaded text document, ingest its text deterministically, and complete.',
  'intake.entry_channel': 'user_text',
  'intake.stages_json': JSON.stringify([
    { slug: 'intake', is_bootstrap: true },
    { slug: 'ingest_source' },
    { slug: 'complete', is_terminal: true },
  ]),
  'intake.transitions_json': JSON.stringify([
    { from: 'intake', to: 'ingest_source', trigger: 'started', guard_field: 'intake.started' },
    { from: 'ingest_source', to: 'complete', trigger: 'source_ready', guard_field: 'work.source_ready' },
  ]),
  'intake.delegation_json': JSON.stringify({ enabled: false }),
  'intake.documents_json': JSON.stringify({
    version: 1,
    stage: 'ingest_source',
    upload_types: ['text/plain', 'text/markdown'],
    extraction: 'self_contained',
    target: { root: 'work.source' },
    required: false,
    fidelity_floor: { min_chars: 40 },
  }),
  'intake.completion_json': JSON.stringify({
    final_stage: 'complete',
    guard_field: 'work.source_ready',
  }),
};

describe('generated document upload smoke test', () => {
  it('boots synthesized self-contained upload intake through the route and proves text extraction plus skip', { timeout: 120_000 }, () => {
    const artifact = artifactFromDomain(uploadDomain);
    const targetDir = mkdtempSync(join(tmpdir(), 'pgas-new-upload-render-'));

    try {
      renderStandaloneScaffold({
        slug: 'document-upload-hermetic',
        name: 'Document Upload Hermetic',
        outDir: targetDir,
        synthesizedSpecYaml: artifact.spec_yaml,
        synthesizedContractsTs: artifact.contracts_ts,
        synthesizedHandlersTs: artifact.handlers_ts,
        synthesizedHandlersIndexTs: artifact.handlers_index_ts,
        synthesizedStageSources: {
          ingest_source: `import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  return {
    result_json: JSON.stringify({ stage: input.stage, status: 'source_ready', at: runtime.now() }),
    items_json: JSON.stringify(['source-ready']),
    digest: '',
  };
}
`,
        },
        synthesizedToolsTs: artifact.tools_ts,
        synthesizedSmokeTestTs: artifact.smoke_test_ts,
      } satisfies RenderStandaloneOptions);
      linkRootNodeModules(targetDir);

      expect(artifact.spec_yaml).toContain('document_upload:');
      expect(artifact.spec_yaml).toContain("document_upload:\n    - inputs.document_intake");
      expect(artifact.spec_yaml).toContain('request_documents:');
      expect(artifact.spec_yaml).toContain('ingest_documents:');
      expect(artifact.spec_yaml).toContain('work.source.full_text: string');
      expect(artifact.spec_yaml).toContain('work.source_ready: boolean');
      expect(artifact.handlers_ts).toContain('const request = payload.request');
      expect(artifact.handlers_ts).toContain('request?.documents');
      expect(artifact.spec_yaml).not.toContain('arg_descriptions:\n      request:');
      expect(artifact.smoke_test_ts).toContain('runs synthesized document upload hermetically through the route');
      expect(artifact.smoke_test_ts).toContain('client.files.upload');
      expect(artifact.smoke_test_ts).not.toContain('createTestHarness');

      const registration = readFileSync(join(targetDir, 'src/programs/document-upload-hermetic/registration.ts'), 'utf8');
      expect(registration).toContain('loadSpecWithPatterns');

      const output = runGeneratedSmokeTest(targetDir);
      expect(output).toContain('2 passed');
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});

function artifactFromDomain(domain: Record<string, unknown>): SynthesizedArtifact {
  return {
    ...synthesizeProgramSpecFromDomain(domain),
    created_at: '2026-07-16T00:00:00.000Z',
  };
}

function linkRootNodeModules(targetDir: string): void {
  const rootNodeModules = join(process.cwd(), 'node_modules');
  if (!existsSync(rootNodeModules)) {
    return;
  }
  symlinkSync(rootNodeModules, join(targetDir, 'node_modules'), 'dir');
}

function runGeneratedSmokeTest(targetDir: string): string {
  const vitestBin = join(process.cwd(), 'node_modules/vitest/vitest.mjs');
  return execFileSync(process.execPath, [vitestBin, 'run', '--pool=threads', 'tests/generated-program-smoke.test.ts'], {
    cwd: targetDir,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', RAYON_NUM_THREADS: '1' },
  });
}
