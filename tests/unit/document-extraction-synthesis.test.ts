import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import type { SynthesizedArtifact } from '../../src/foundry-program/synthesizer-store.js';
import { createExistingRepoArtifactPlan, createStandaloneArtifactPlan } from '../../src/pgas-new/artifact-plan.js';
import { renderExistingRepoAttachment, renderStandaloneScaffold } from '../../src/pgas-new/template-renderer.js';
import type { WiringManifest } from '../../src/pgas-new/wiring-manifest.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('document extraction synthesis (PR-U5-E)', () => {
  it('emits self-contained DOCX extraction handler wiring and demand-driven extract/docx.ts placement', () => {
    const artifact = artifactFromDomain(documentDomain({
      slug: 'docx-extraction-demo',
      name: 'DOCX Extraction Demo',
      uploadTypes: ['text/plain', DOCX_MIME],
      extraction: 'self_contained',
    }));

    expect(artifact.document_extraction_surfaces).toEqual({ docx: true });
    expect(artifact.capability_gaps).toBeUndefined();
    expect(artifact.handlers_ts).toContain("import { extractDocxText } from './extract/docx.js'");
    expect(artifact.handlers_index_ts).toBe("export { handlers, reactionHandlers } from '../handlers.js';\n");
    expect(artifact.handlers_ts).toContain("Buffer.from(document.content_base64, 'base64')");
    expect(artifact.handlers_ts).toContain('blocked_extraction_failed');
    expect(artifact.handlers_ts).toContain('extractDocxText(bytes)');
    expect(artifact.handlers_ts).toContain('extraction_kind: docxExtractionKind(bytes)');
    expect(artifact.handlers_ts).toContain("return sawDeflate ? 'docx_deflate' : 'docx_store';");

    const standalonePlan = createStandaloneArtifactPlan(
      { slug: 'docx-extraction-demo', name: 'DOCX Extraction Demo' },
      { stageSlugs: artifact.body_stage_slugs, documentExtractionSurfaces: artifact.document_extraction_surfaces },
    );
    expect(standalonePlan.artifacts.map((entry) => entry.path)).toContain('src/programs/docx-extraction-demo/extract/docx.ts');
    expect(
      createStandaloneArtifactPlan({ slug: 'no-extraction', name: 'No Extraction' }).artifacts.map((entry) => entry.path),
    ).not.toContain('src/programs/no-extraction/extract/docx.ts');

    const outDir = mkdtempSync(join(tmpdir(), 'pgas-new-docx-extraction-render-'));
    try {
      renderStandaloneScaffold({
        outDir,
        slug: 'docx-extraction-demo',
        name: 'DOCX Extraction Demo',
        synthesizedSpecYaml: artifact.spec_yaml,
        synthesizedContractsTs: artifact.contracts_ts,
        synthesizedHandlersTs: artifact.handlers_ts,
        synthesizedHandlersIndexTs: artifact.handlers_index_ts,
        synthesizedStageSources: artifact.stage_sources,
        synthesizedToolsTs: artifact.tools_ts,
        synthesizedSmokeTestTs: artifact.smoke_test_ts,
        synthesizedDocumentExtractionSurfaces: artifact.document_extraction_surfaces,
      });
      expect(readFileSync(join(outDir, 'src/programs/docx-extraction-demo/extract/docx.ts'), 'utf8'))
        .toContain("import { inflateRawSync } from 'node:zlib'");
      expect(readFileSync(join(outDir, 'src/programs/docx-extraction-demo/handlers.ts'), 'utf8'))
        .toContain("from './extract/docx.js'");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('plans attached extract/docx.ts only when synthesized DOCX extraction demands it', () => {
    const plan = createExistingRepoArtifactPlan(
      { slug: 'review', name: 'Review' },
      MANIFEST,
      { documentExtractionSurfaces: { docx: true } },
    );
    expect(plan.artifacts.map((entry) => entry.path)).toContain('programs/review/extract/docx.ts');

    const repoRoot = mkdtempSync(join(tmpdir(), 'pgas-new-attached-docx-extraction-'));
    try {
      renderExistingRepoAttachment({
        repoRoot,
        manifest: MANIFEST,
        slug: 'review',
        name: 'Review',
        synthesizedDocumentExtractionSurfaces: { docx: true },
      });
      expect(readFileSync(join(repoRoot, 'programs/review/extract/docx.ts'), 'utf8'))
        .toContain("import { inflateRawSync } from 'node:zlib'");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('emits PDF host connector contracts, mock, and per-program capability gap without a foundry PDF extractor', () => {
    const artifact = artifactFromDomain(documentDomain({
      slug: 'pdf-host-demo',
      name: 'PDF Host Demo',
      uploadTypes: ['application/pdf'],
      extraction: 'host_connector',
      connectorSlug: 'fixture_pdf_text_extractor',
    }));

    expect(artifact.document_extraction_surfaces).toBeUndefined();
    expect(artifact.capability_gaps).toEqual([
      {
        capability: 'document_extraction_pdf',
        stage: 'ingest_source',
        connector_slug: 'fixture_pdf_text_extractor',
        message: expect.stringMatching(/PDF text extraction is host-required/),
      },
    ]);
    expect(artifact.contracts_ts).toContain('export interface DocumentExtractionHostConnectorRequest');
    expect(artifact.contracts_ts).toContain('export interface DocumentExtractionHostConnectorResult');
    expect(artifact.contracts_ts).toContain('export interface DocumentExtractionHostConnector');
    expect(artifact.contracts_ts).toContain('export const documentExtractionHostConnectorContract');
    expect(artifact.contracts_ts).toContain('documentExtractionHostConnectorFixtureMock');
    expect(artifact.contracts_ts).toContain('export const capabilityGaps');
    expect(artifact.contracts_ts).not.toContain('pdf-parse');
    expect(artifact.handlers_ts).not.toContain('extractPdf');
  });
});

function artifactFromDomain(domain: Record<string, unknown>): SynthesizedArtifact {
  return {
    ...synthesizeProgramSpecFromDomain(domain),
    created_at: '2026-07-17T00:00:00.000Z',
  };
}

function documentDomain(options: {
  slug: string;
  name: string;
  uploadTypes: string[];
  extraction: 'self_contained' | 'host_connector';
  connectorSlug?: string;
}): Record<string, unknown> {
  return {
    'program.slug': options.slug,
    'program.name': options.name,
    'program.target_dir': `/tmp/${options.slug}`,
    'intake.purpose': `Ingest uploaded documents for ${options.name}.`,
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
      upload_types: options.uploadTypes,
      extraction: options.extraction,
      target: { root: 'work.source' },
      required: true,
      fidelity_floor: { min_chars: 1 },
      ...(options.connectorSlug ? { connector_slug: options.connectorSlug } : {}),
    }),
    'intake.completion_json': JSON.stringify({
      final_stage: 'complete',
      guard_field: 'work.source_ready',
    }),
  };
}

const MANIFEST: WiringManifest = {
  schema_version: 1,
  repo: { kind: 'existing_repo', package_manager: 'npm' },
  pgas: {
    server_package: '@simodelne/pgas-server',
    allowed_imports: [
      '@simodelne/pgas-server/plugin.js',
      '@simodelne/pgas-server/create-server.js',
      '@simodelne/pgas-server/client.js',
      '@simodelne/pgas-server/channels/index.js',
      '@simodelne/pgas-server/routes/index.js',
    ],
  },
  paths: {
    programs_dir: 'programs',
    audit_dir: 'audit',
    pgas_new_dir: '.pgas/pgas-new',
  },
  registration: { strategy: 'curator_request' },
  verification: {
    commands: {
      install: 'npm install --no-audit --no-fund',
      typecheck: 'npm run typecheck',
      test: 'npm test',
    },
  },
  curator: {
    github_owner: 'simodelne',
    github_repo: 'simoneos',
  },
};
