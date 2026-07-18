import { File } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { type PgasClient } from '@simodelne/pgas-server/client.js';
import {
  createProgramAdapters,
  loadSpecWithPatterns,
  type ProgramEntry,
  type ToolHandler,
} from '@simodelne/pgas-server/plugin.js';
import { describe, expect, it } from 'vitest';

import {
  assertSynthesizableCapabilities,
  capabilityEntry,
} from '../../src/foundry-program/capability-registry.js';
import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import { createStandaloneArtifactPlan } from '../../src/pgas-new/artifact-plan.js';
import { startRouteHarness } from './foundry-test-utils.js';
import { extractDocxText } from './fixtures/extract-docx.reference.js';
import { renderStructuredDocxDocument } from './fixtures/export-docx-render.golden.js';

// PR-U5-F: hand-authored HERMETIC falsifier for DOCX/PDF upload extraction.
//
// This proves the route-level byte-injection mechanism only. The fixture program embeds the
// reference extractor directly in its ingest_documents handler; no synthesizer/emitter status
// flips happen in this PR.

const SELF_DOCX_PROGRAM = 'extraction-falsifier-self-docx';
const HOST_PDF_PROGRAM = 'extraction-falsifier-host-pdf';
const DOCUMENT_REFS_PATH = 'inputs.document_intake.file_refs';
const DOCUMENT_ROOT_PATH = 'inputs.document_intake';
const SOURCE_PATH = 'work.source';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_MIME = 'application/pdf';
const TEXT_MIME = 'text/plain';
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

describe('extraction route-level engine falsifier (PR-U5-F)', () => {
  it('executes X-1..X-8 through the real upload + document_upload route', async () => {
    const failures: Error[] = [];

    const storeFixture = createStructuredDocxFixture(newNonce(), 'store');
    const storeDrive = await runExtractionDrive(storeFixture, { kind: 'self_docx' });

    await recordFalsifier('X-1', failures, async () => {
      expect(storeDrive.triggerError).toBeUndefined();
      expect(storeDrive.source.status).toBe('extracted');
      expect(storeDrive.source.full_text).toBe(storeFixture.expectedText);
      expect(storeDrive.source.char_count).toBe(storeFixture.expectedCharCount);
      expect(String(storeDrive.source.full_text)).toContain(storeFixture.nonce);
      expect(storeDrive.finalMode).toBe('complete');
      const summary = storeDrive.observations[0]?.documentSummaries[0];
      expect(summary?.has_content_base64).toBe(true);
      expect(summary?.has_content_text).toBe(false);
      return {
        status: storeDrive.source.status,
        char_count: storeDrive.source.char_count,
        expected_char_count: storeFixture.expectedCharCount,
        nonce_present: String(storeDrive.source.full_text).includes(storeFixture.nonce),
        payload_summary: summary,
      };
    });

    const deflateFixture = createDeflateDocxFixture(storeFixture);
    const deflateDrive = await runExtractionDrive(deflateFixture, { kind: 'self_docx' });

    await recordFalsifier('X-2', failures, async () => {
      const evidence = assertNonceThroughDeflate(deflateFixture, deflateDrive);
      return {
        ...evidence,
        extraction_kind: deflateDrive.source.extraction_kind,
        raw_bytes: deflateFixture.bytes.length,
      };
    });

    await recordFalsifier('X-3', failures, async () => {
      expect(deflateFixture.expectedCharCount).toBeGreaterThan(0);
      expect(deflateDrive.source.status).toBe('extracted');
      expect(deflateDrive.source.char_count).toBe(deflateFixture.expectedCharCount);
      expect(String(deflateDrive.source.full_text).length).toBe(deflateFixture.expectedCharCount);
      return {
        char_count: deflateDrive.source.char_count,
        expected_char_count: deflateFixture.expectedCharCount,
      };
    });

    await recordFalsifier('X-4', failures, async () => {
      const fixture = createMultipartDocxFixture(newNonce());
      const drive = await runExtractionDrive(fixture, { kind: 'self_docx' });
      expect(drive.source.status).toBe('extracted');
      expect(drive.source.full_text).toBe(fixture.expectedText);
      expect(drive.source.char_count).toBe(fixture.expectedCharCount);
      expect(String(drive.source.full_text)).toContain('\t');
      expect(String(drive.source.full_text)).toContain('A&B');
      return {
        full_text: drive.source.full_text,
        char_count: drive.source.char_count,
        expected_char_count: fixture.expectedCharCount,
      };
    });

    await recordFalsifier('X-5', failures, async () => {
      const fixture = createCorruptDocxFixture(newNonce());
      const drive = await runExtractionDrive(fixture, { kind: 'self_docx' });
      expect(drive.triggerError).toBeUndefined();
      expect(drive.source.status).toBe('blocked_extraction_failed');
      expect(drive.source.full_text).toBe('');
      expect(drive.source.char_count).toBe(0);
      expect(String(drive.source.reason ?? '')).toMatch(/zip|central|document|truncated|corrupt/i);
      return {
        status: drive.source.status,
        reason: drive.source.reason,
        final_mode: drive.finalMode,
      };
    });

    await recordFalsifier('X-6', failures, async () => {
      const textUnderDocx = await runUploadRejectScenario(
        new File(['plain text under docx MIME'], 'not-a-docx.docx', { type: DOCX_MIME }),
      );
      expect(textUnderDocx.status).toBe(400);
      expect(textUnderDocx.message).toMatch(/signature.*declared content type/i);

      const docxUnderText = await runExtractionDrive(
        { ...storeFixture, name: 'docx-bytes-under-text.txt', mimeType: TEXT_MIME },
        { kind: 'self_docx' },
      );
      expect(docxUnderText.triggerError).toBeUndefined();
      expect(docxUnderText.source.status).toBe('extracted');
      expect(docxUnderText.source.extraction_kind).toBe('content_text');
      expect(docxUnderText.observations[0]?.documentSummaries[0]?.has_content_text).toBe(true);
      return {
        text_under_docx: textUnderDocx,
        docx_under_text: {
          status: docxUnderText.source.status,
          extraction_kind: docxUnderText.source.extraction_kind,
          full_text_preview: String(docxUnderText.source.full_text ?? '').slice(0, 64),
        },
      };
    });

    await recordFalsifier('X-7', failures, async () => {
      const pdfFixture = createPdfFixture(newNonce());
      const hostDrive = await runExtractionDrive(pdfFixture, { kind: 'host_pdf' });
      expect(hostDrive.source.status).toBe('extracted');
      expect(hostDrive.source.extraction_kind).toBe('host_connector_mock_pdf');
      expect(String(hostDrive.source.full_text)).toContain(`HOST_CONNECTOR_MOCK_PDF_TEXT PDF-${pdfFixture.nonce}`);
      const gaps = parseJsonArray(hostDrive.source.capability_gaps_json);
      expect(gaps[0]).toMatchObject({
        capability: 'document_extraction_pdf',
        connector_slug: 'fixture_pdf_text_extractor',
      });

      const selfDrive = await runExtractionDrive(pdfFixture, { kind: 'self_docx' });
      expect(selfDrive.source.status).toBe('blocked_unsupported_type');
      expect(selfDrive.source.full_text).toBe('');
      return {
        host_connector: {
          status: hostDrive.source.status,
          extraction_kind: hostDrive.source.extraction_kind,
          capability_gaps: gaps,
        },
        self_contained_docx: {
          status: selfDrive.source.status,
          reason: selfDrive.source.reason,
        },
      };
    });

    await recordFalsifier('X-8', failures, async () => {
      const docx = capabilityEntry('document_extraction_docx');
      const pdf = capabilityEntry('document_extraction_pdf');
      expect(docx?.status).toBe('synthesizes');
      expect(docx?.evidence ?? '').toMatch(/live-drive|nonce|deflate|extraction_engaged/i);
      expect(pdf?.status).toBe('scaffolds_with_gap');
      expect(pdf?.gap_note ?? '').toMatch(/typed connector|host-side|OCR|scanned/i);

      const assessment = assertSynthesizableCapabilities({
        purpose: 'Extract body text from an uploaded DOCX contract and count the characters.',
      });
      expect(assessment.synthesizes.map((demand) => demand.capability)).toContain('document_extraction_docx');
      expect(assessment.refuses).toEqual([]);
      const artifact = synthesizeProgramSpecFromDomain(synthesizedDocxExtractionDomain());
      expect(artifact.handlers_ts).toContain("import { extractDocxText } from './extract/docx.js'");
      expect(artifact.handlers_ts).toContain("Buffer.from(document.content_base64, 'base64')");
      expect(artifact.document_extraction_surfaces).toEqual({ docx: true });
      const plan = createStandaloneArtifactPlan(
        { slug: 'u5e-docx-extraction', name: 'U5E DOCX Extraction' },
        { stageSlugs: artifact.body_stage_slugs, documentExtractionSurfaces: artifact.document_extraction_surfaces },
      );
      expect(plan.artifacts.map((entry) => entry.path)).toContain('src/programs/u5e-docx-extraction/extract/docx.ts');
      return {
        document_extraction_docx: docx?.status,
        document_extraction_pdf: pdf?.status,
        scaffolds_with_gap: assessment.scaffolds_with_gap.map((demand) => demand.capability),
        emitted_docx_extractor: true,
      };
    });

    await recordInformativeFalsifier('X-9', async () => {
      const oversize = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], 'oversize.docx', { type: DOCX_MIME });
      const evidence = await runUploadRejectScenario(oversize);
      expect(evidence.status).toBe(400);
      expect(evidence.message).toMatch(/exceeds|maximum upload size|25 MB/i);
      return evidence;
    });

    if (failures.length > 0) {
      throw new Error(failures.map((failure) => failure.message).join('\n'));
    }
  });

  it('demonstrates X-2 goes red when inflate or payload-document reads are sabotaged', async () => {
    const base = createStructuredDocxFixture(newNonce(), 'store');
    const fixture = createDeflateDocxFixture(base);
    const failures: Error[] = [];

    await recordFalsifier('X-2-sabotage-inflate-passthrough', failures, async () => {
      const drive = await runExtractionDrive(fixture, {
        kind: 'self_docx',
        sabotage: 'inflate_passthrough',
      });
      const error = await expectX2AssertionFailure(fixture, drive);
      expect(error).toMatch(/to contain|nonce/i);
      return { sabotage: 'inflate_passthrough', x2_failure: error };
    });

    await recordFalsifier('X-2-sabotage-domain-read', failures, async () => {
      const drive = await runExtractionDrive(fixture, {
        kind: 'self_docx',
        sabotage: 'domain_read',
      });
      const error = await expectX2AssertionFailure(fixture, drive);
      expect(error).toMatch(/extracted|nonce|blocked_no_content/i);
      return { sabotage: 'domain_read', x2_failure: error };
    });

    if (failures.length > 0) {
      throw new Error(failures.map((failure) => failure.message).join('\n'));
    }
  });
});

// Engine drive

async function runExtractionDrive(
  fixture: BinaryFixture,
  options: { kind: FixtureProgramKind; sabotage?: SabotageMode },
): Promise<ExtractionDriveEvidence> {
  const state: ExtractionHandlerState = {
    kind: options.kind,
    sabotage: options.sabotage,
    observations: [],
  };
  return withExtractionServer(
    {
      programName: options.kind === 'host_pdf' ? HOST_PDF_PROGRAM : SELF_DOCX_PROGRAM,
      state,
      script: [scripted('extract:ingest_documents', effect('ingest_documents', {}))],
      createEntry: (tempDir) => createEntry(tempDir, options.kind === 'host_pdf' ? HOST_PDF_PROGRAM : SELF_DOCX_PROGRAM, state),
    },
    async ({ client }) => {
      const created = await client.sessions.create({ program: options.kind === 'host_pdf' ? HOST_PDF_PROGRAM : SELF_DOCX_PROGRAM });
      const uploadResponse = await uploadBytes(client, created.sessionId, fixture);
      const [fileRef] = refsFromResponse(uploadResponse);
      let triggerError: string | undefined;
      try {
        await client.sessions.trigger(created.sessionId, {
          channel: 'document_upload',
          payload: documentRefPayload(fileRef),
        });
      } catch (error) {
        triggerError = errorMessage(error);
      }
      const [session, world] = await Promise.all([
        safeRead(() => client.sessions.get(created.sessionId)),
        safeRead(() => client.sessions.world(created.sessionId)),
      ]);
      const domain = world.ok && isRecord(world.value.domain) ? world.value.domain : {};
      return {
        sessionId: created.sessionId,
        fileRef,
        triggerError,
        source: resultAt(domain, SOURCE_PATH),
        finalMode: session.ok ? modeOf(session.value) : null,
        observations: [...state.observations],
      };
    },
  );
}

async function runUploadRejectScenario(file: File): Promise<ApiErrorEvidence> {
  const state: ExtractionHandlerState = { kind: 'self_docx', observations: [] };
  return withExtractionServer(
    {
      programName: SELF_DOCX_PROGRAM,
      state,
      script: [],
      createEntry: (tempDir) => createEntry(tempDir, SELF_DOCX_PROGRAM, state),
    },
    async ({ client }) => {
      const created = await client.sessions.create({ program: SELF_DOCX_PROGRAM });
      return expectUploadReject(client, created.sessionId, file);
    },
  );
}

interface ExtractionServerScenario {
  programName: string;
  state: ExtractionHandlerState;
  script: ScriptedResponse[];
  createEntry: (tempDir: string) => ProgramEntry;
}

async function withExtractionServer<T>(
  scenario: ExtractionServerScenario,
  run: (ctx: { client: PgasClient; tempDir: string; state: ExtractionHandlerState; order: string[] }) => Promise<T>,
): Promise<T> {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pgas-extraction-falsifier-'));
  const order: string[] = [];
  const entry = scenario.createEntry(tempDir);
  const { client, close } = await startRouteHarness({
    programs: [{ name: scenario.programName, entry }],
    authorHandle: scriptedAuthor(scenario.script, order),
    observerModelId: 'extraction-falsifier-observer',
    storage: { uploadsDir: path.join(tempDir, 'uploads') },
  });
  try {
    return await run({ client, tempDir, state: scenario.state, order });
  } finally {
    await close();
    rmSync(tempDir, { force: true, recursive: true });
  }
}

function createEntry(tempDir: string, programName: string, state: ExtractionHandlerState): ProgramEntry {
  const specPath = path.join(tempDir, `${programName}-${randomUUID()}.yml`);
  writeFileSync(specPath, extractionSpecYaml(programName), 'utf8');
  const { spec } = loadSpecWithPatterns(specPath);
  const handlers = createExtractionHandlers(state);
  return {
    spec,
    createAdapters: (ctx) => createProgramAdapters(spec, ctx, handlers),
  };
}

function createExtractionHandlers(state: ExtractionHandlerState): Record<string, ToolHandler> {
  return {
    async ingest_documents(payload) {
      const documents = state.sabotage === 'domain_read'
        ? documentsFromDomain(asRecord(payload).domain)
        : documentsFromPayload(payload);
      const observation = observeDocuments(documents);
      state.observations.push(observation);
      return ingestDocuments(documents, state);
    },
  };
}

function synthesizedDocxExtractionDomain(): Record<string, unknown> {
  return {
    'program.slug': 'u5e-docx-extraction',
    'program.name': 'U5E DOCX Extraction',
    'program.target_dir': '/tmp/u5e-docx-extraction',
    'intake.purpose': 'Extract body text from uploaded DOCX contracts.',
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
      upload_types: [TEXT_MIME, DOCX_MIME],
      extraction: 'self_contained',
      target: { root: SOURCE_PATH },
      required: true,
      fidelity_floor: { min_chars: 1 },
    }),
    'intake.completion_json': JSON.stringify({
      final_stage: 'complete',
      guard_field: 'work.source_ready',
    }),
  };
}

function ingestDocuments(documents: Record<string, unknown>[], state: ExtractionHandlerState): Record<string, unknown> {
  if (documents.length === 0) {
    return blockedSource('blocked_no_content', 'no engine-injected documents were available', []);
  }

  const parts: string[] = [];
  const summaries: Record<string, unknown>[] = [];
  for (const [index, document] of documents.entries()) {
    summaries.push(documentSummary(document));
    const mimeType = documentMimeType(document);
    if (typeof document.content_text === 'string') {
      parts.push(document.content_text);
      continue;
    }
    if (typeof document.content_base64 !== 'string') {
      return blockedSource('blocked_no_content', 'document had no content_text or content_base64', summaries);
    }
    if (mimeType === DOCX_MIME) {
      const bytes = Buffer.from(document.content_base64, 'base64');
      const extracted = state.sabotage === 'inflate_passthrough'
        ? extractDocxTextInflatePassthrough(bytes)
        : extractDocxText(bytes);
      if (!extracted.ok) {
        return blockedSource('blocked_extraction_failed', extracted.reason, summaries);
      }
      parts.push(extracted.text);
      continue;
    }
    if (mimeType === PDF_MIME && state.kind === 'host_pdf') {
      const nonce = pdfNonceFromDocumentName(document) ?? 'unknown';
      parts.push(`HOST_CONNECTOR_MOCK_PDF_TEXT PDF-${nonce}`);
      continue;
    }
    return blockedSource('blocked_unsupported_type', `unsupported binary MIME type ${mimeType || '(missing)'}`, summaries);
  }

  const fullText = parts.length === 1
    ? parts[0] ?? ''
    : parts.map((part, index) => `--- file: ${documentName(documents[index] ?? {}, index)} ---\n\n${part}`).join('\n\n');
  const capabilityGaps = state.kind === 'host_pdf'
    ? [{
        capability: 'document_extraction_pdf',
        stage: 'ingest_documents',
        connector_slug: 'fixture_pdf_text_extractor',
        message: 'PR-U5-F fixture mock; PDF text extraction remains host-side.',
      }]
    : [];
  return {
    status: 'extracted',
    full_text: fullText,
    char_count: fullText.length,
    file_count: documents.length,
    files_json: JSON.stringify(summaries),
    extraction_kind: state.kind === 'host_pdf' ? 'host_connector_mock_pdf' : summaries.some((summary) => summary.has_content_text === true) ? 'content_text' : 'docx_reference',
    capability_gaps_json: JSON.stringify(capabilityGaps),
  };
}

function blockedSource(status: string, reason: string, summaries: Record<string, unknown>[]): Record<string, unknown> {
  return {
    status,
    full_text: '',
    char_count: 0,
    file_count: 0,
    files_json: JSON.stringify(summaries),
    reason,
  };
}

function documentsFromPayload(payload: unknown): Record<string, unknown>[] {
  const request = isRecord(payload) && isRecord(payload.request) ? payload.request : undefined;
  return Array.isArray(request?.documents) ? request.documents.filter(isRecord) : [];
}

function documentsFromDomain(domain: unknown): Record<string, unknown>[] {
  if (!isRecord(domain)) return [];
  const root = domain[DOCUMENT_ROOT_PATH];
  if (isRecord(root) && Array.isArray(root.file_refs)) return root.file_refs.filter(isRecord);
  const refs = domain[DOCUMENT_REFS_PATH];
  if (Array.isArray(refs)) return refs.filter(isRecord);
  return [];
}

function observeDocuments(documents: Record<string, unknown>[]): DocumentObservation {
  return {
    documentCount: documents.length,
    documentSummaries: documents.map(documentSummary),
  };
}

function documentSummary(document: Record<string, unknown>): Record<string, unknown> {
  return {
    name: typeof document.name === 'string' ? document.name : undefined,
    mime_type: documentMimeType(document) || undefined,
    size: typeof document.size === 'number' ? document.size : undefined,
    has_content_text: typeof document.content_text === 'string',
    has_content_base64: typeof document.content_base64 === 'string',
  };
}

function documentMimeType(document: Record<string, unknown>): string {
  const raw = typeof document.mime_type === 'string'
    ? document.mime_type
    : typeof document.mimeType === 'string'
      ? document.mimeType
      : '';
  return raw.toLowerCase();
}

function documentName(document: Record<string, unknown>, index: number): string {
  return typeof document.name === 'string' && document.name.length > 0 ? document.name : `document-${String(index + 1)}`;
}

function pdfNonceFromDocumentName(document: Record<string, unknown>): string | undefined {
  const name = typeof document.name === 'string' ? document.name : '';
  const match = /^pdf-(extract-[0-9a-f-]+)\.pdf$/u.exec(name);
  return match?.[1];
}

function extractionSpecYaml(programName: string): string {
  return `name: "${programName}"
termination: BoundedSession
topology: CyclicTopology
pure: true

preamble: |
  Route-level DOCX/PDF extraction falsifier.

initial: await_upload
terminal: [complete]

features:
  - base

channels:
  document_upload: { direction: In, sync: Async }
  widget_output: { direction: Out, sync: Sync }

modes:
  await_upload:
    vocabulary: [ingest_documents]
    channels: [document_upload, widget_output]
    transitions:
      - target: complete
        guard: { kind: FieldTruthy, path: ${SOURCE_PATH} }
  complete:
    vocabulary: []
    channels: [widget_output]

proceed_to:
  ingest_documents: complete

projection:
  await_upload:
    include:
      - ${DOCUMENT_ROOT_PATH}
      - ${DOCUMENT_REFS_PATH}
      - ${DOCUMENT_REFS_PATH}.0
      - ${DOCUMENT_REFS_PATH}.0.fileId
      - ${SOURCE_PATH}
      - ${SOURCE_PATH}.status
      - ${SOURCE_PATH}.full_text
      - ${SOURCE_PATH}.char_count
      - ${SOURCE_PATH}.file_count
      - ${SOURCE_PATH}.files_json
      - ${SOURCE_PATH}.reason
    exclude: []
  complete:
    include:
      - ${DOCUMENT_ROOT_PATH}
      - ${DOCUMENT_REFS_PATH}
      - ${DOCUMENT_REFS_PATH}.0
      - ${DOCUMENT_REFS_PATH}.0.fileId
      - ${SOURCE_PATH}
      - ${SOURCE_PATH}.status
      - ${SOURCE_PATH}.full_text
      - ${SOURCE_PATH}.char_count
      - ${SOURCE_PATH}.file_count
      - ${SOURCE_PATH}.files_json
      - ${SOURCE_PATH}.reason
      - ${SOURCE_PATH}.extraction_kind
      - ${SOURCE_PATH}.capability_gaps_json
    exclude: []

prompts:
  await_upload: "After document_upload arrives, call ingest_documents with no arguments."
  complete: "Terminal."

ingestion:
  document_upload:
    - ${DOCUMENT_ROOT_PATH}

action_map:
  ingest_documents:
    description: "Read injected request.documents and extract text fail-closed."
    mutations: []
    channel: widget_output
    result_path: ${SOURCE_PATH}

schema:
  ${DOCUMENT_ROOT_PATH}: object
  ${DOCUMENT_REFS_PATH}: array
  ${DOCUMENT_REFS_PATH}.*: object
  ${DOCUMENT_REFS_PATH}.*.fileId: string
  ${DOCUMENT_REFS_PATH}.*.name: string
  ${SOURCE_PATH}: object
  ${SOURCE_PATH}.status: string
  ${SOURCE_PATH}.full_text: string
  ${SOURCE_PATH}.char_count: number
  ${SOURCE_PATH}.file_count: number
  ${SOURCE_PATH}.files_json: string
  ${SOURCE_PATH}.reason: string
  ${SOURCE_PATH}.extraction_kind: string
  ${SOURCE_PATH}.capability_gaps_json: string

repair_bound: 2

fallback:
  channel: widget_output
  payload: { ok: false }
`;
}

// Fixtures

function newNonce(): string {
  return `extract-${randomUUID()}`;
}

function createStructuredDocxFixture(nonce: string, flavor: 'store' | 'deflate'): BinaryFixture {
  const title = 'Extraction Fixture';
  const section = 'Brief';
  const paragraphs = [
    `First body paragraph carries ${nonce}.`,
    'Second paragraph preserves A&B after XML entity decoding.',
  ];
  const bytes = renderStructuredDocxDocument({
    title,
    sections: [{ title: section, body: paragraphs }],
  });
  const expectedText = [title, section, ...paragraphs].join('\n');
  return {
    name: `${flavor}.docx`,
    mimeType: DOCX_MIME,
    nonce,
    bytes,
    expectedText,
    expectedCharCount: expectedText.length,
  };
}

function createDeflateDocxFixture(storeFixture: BinaryFixture): BinaryFixture {
  return {
    ...storeFixture,
    name: 'deflate.docx',
    bytes: rezipDeflate(storeFixture.bytes),
  };
}

function createMultipartDocxFixture(nonce: string): BinaryFixture {
  const xml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    '<w:body>',
    `<w:p><w:r><w:t>Split</w:t></w:r><w:r><w:t>Run ${nonce}</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>A&amp;B</w:t></w:r></w:p>`,
    '<w:p><w:r><w:t>Line</w:t><w:br/><w:t>break</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>Numeric &#65; &#x42; &lt;ok&gt; &quot;q&quot; &apos;s&apos;</w:t></w:r></w:p>',
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>',
    '</w:body></w:document>',
  ].join('');
  const base = renderStructuredDocxDocument({ title: 'placeholder', sections: [{ title: 'placeholder', body: 'placeholder' }] });
  const bytes = replaceStoreZipEntry(base, 'word/document.xml', new TextEncoder().encode(xml));
  const expectedText = [
    `SplitRun ${nonce}\tA&B`,
    'Line\nbreak',
    'Numeric A B <ok> "q" \'s\'',
  ].join('\n');
  return {
    name: 'multipart.docx',
    mimeType: DOCX_MIME,
    nonce,
    bytes,
    expectedText,
    expectedCharCount: expectedText.length,
  };
}

function createCorruptDocxFixture(nonce: string): BinaryFixture {
  const bytes = new TextEncoder().encode(`PK\x03\x04corrupt-docx-${nonce}-no-central-directory`);
  return {
    name: 'corrupt.docx',
    mimeType: DOCX_MIME,
    nonce,
    bytes,
    expectedText: '',
    expectedCharCount: 0,
  };
}

function createPdfFixture(nonce: string): BinaryFixture {
  return {
    name: `pdf-${nonce}.pdf`,
    mimeType: PDF_MIME,
    nonce,
    bytes: minimalPdf(nonce),
    expectedText: `HOST_CONNECTOR_MOCK_PDF_TEXT PDF-${nonce}`,
    expectedCharCount: `HOST_CONNECTOR_MOCK_PDF_TEXT PDF-${nonce}`.length,
  };
}

function rezipDeflate(storeDocxBytes: Uint8Array): Uint8Array {
  const entries = parseStoreZipEntries(storeDocxBytes);
  const deflated = entries.map((entry) => ({
    name: entry.name,
    data: entry.data,
    compressed: deflateRawSync(entry.data),
    crc: crc32(entry.data),
  }));
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of deflated) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const compressed = asUint8Array(entry.compressed);
    const local = concat([
      u32(0x04034b50), u16(20), u16(0), u16(8), u16(0), u16(0), u32(entry.crc),
      u32(compressed.length), u32(entry.data.length), u16(nameBytes.length), u16(0), nameBytes, compressed,
    ]);
    chunks.push(local);
    central.push(concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u16(0), u16(0), u32(entry.crc),
      u32(compressed.length), u32(entry.data.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(offset), nameBytes,
    ]));
    offset += local.length;
  }
  const centralOffset = offset;
  const centralBytes = concat(central);
  const end = concat([
    u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
    u32(centralBytes.length), u32(centralOffset), u16(0),
  ]);
  return concat([...chunks, centralBytes, end]);
}

function replaceStoreZipEntry(storeZipBytes: Uint8Array, name: string, data: Uint8Array): Uint8Array {
  const entries = parseStoreZipEntries(storeZipBytes).map((entry) => entry.name === name ? { ...entry, data } : entry);
  return zipStoreEntries(entries);
}

function zipStoreEntries(entries: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.data);
    const local = concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc),
      u32(entry.data.length), u32(entry.data.length), u16(nameBytes.length), u16(0), nameBytes, entry.data,
    ]);
    chunks.push(local);
    central.push(concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc),
      u32(entry.data.length), u32(entry.data.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(offset), nameBytes,
    ]));
    offset += local.length;
  }
  const centralOffset = offset;
  const centralBytes = concat(central);
  const end = concat([
    u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
    u32(centralBytes.length), u32(centralOffset), u16(0),
  ]);
  return concat([...chunks, centralBytes, end]);
}

function minimalPdf(nonce: string): Uint8Array {
  const text = `PDF-${nonce}`;
  const stream = `BT /F1 12 Tf 72 712 Td (${escapePdfLiteral(text)}) Tj ET`;
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    `5 0 obj\n<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream\nendobj\n`,
  ];
  let body = '%PDF-1.4\n%PGAS\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body, 'ascii'));
    body += object;
  }
  const xrefOffset = Buffer.byteLength(body, 'ascii');
  body += 'xref\n0 6\n';
  body += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

function escapePdfLiteral(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

function parseStoreZipEntries(bytes: Uint8Array): StoreZipEntry[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: StoreZipEntry[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length && dv.getUint32(offset, true) === 0x04034b50) {
    const method = dv.getUint16(offset + 8, true);
    const crc = dv.getUint32(offset + 14, true) >>> 0;
    const compressedSize = dv.getUint32(offset + 18, true);
    const nameLength = dv.getUint16(offset + 26, true);
    const extraLength = dv.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (method !== 0) {
      throw new Error(`expected STORE entry while re-zipping, got method ${String(method)}`);
    }
    if (dataEnd > bytes.length) {
      throw new Error('truncated STORE zip entry');
    }
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength));
    const data = bytes.subarray(dataStart, dataEnd);
    entries.push({ name, data, crc });
    offset = dataEnd;
  }
  if (entries.length === 0) {
    throw new Error('no STORE zip entries found');
  }
  return entries;
}

function extractDocxTextInflatePassthrough(bytes: Uint8Array): { ok: true; text: string; char_count: number } | { ok: false; reason: string } {
  const entry = readCompressedZipEntry(bytes, 'word/document.xml');
  if (!entry.ok) return entry;
  const text = new TextDecoder().decode(entry.bytes);
  return { ok: true, text, char_count: text.length };
}

function readCompressedZipEntry(bytes: Uint8Array, name: string): { ok: true; bytes: Uint8Array } | { ok: false; reason: string } {
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = findEocd(bytes);
    if (eocd < 0) return { ok: false, reason: 'zip end-of-central-directory not found' };
    const entries = dv.getUint16(eocd + 10, true);
    const centralOffset = dv.getUint32(eocd + 16, true);
    let cursor = centralOffset;
    for (let index = 0; index < entries; index += 1) {
      if (dv.getUint32(cursor, true) !== 0x02014b50) return { ok: false, reason: 'bad central directory entry' };
      const compressedSize = dv.getUint32(cursor + 20, true);
      const nameLength = dv.getUint16(cursor + 28, true);
      const extraLength = dv.getUint16(cursor + 30, true);
      const commentLength = dv.getUint16(cursor + 32, true);
      const localOffset = dv.getUint32(cursor + 42, true);
      const entryName = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
      if (entryName === name) {
        if (dv.getUint32(localOffset, true) !== 0x04034b50) return { ok: false, reason: 'bad local header' };
        const localNameLength = dv.getUint16(localOffset + 26, true);
        const localExtraLength = dv.getUint16(localOffset + 28, true);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        const dataEnd = dataStart + compressedSize;
        if (dataEnd > bytes.length) return { ok: false, reason: 'truncated zip data' };
        return { ok: true, bytes: bytes.subarray(dataStart, dataEnd) };
      }
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return { ok: false, reason: `zip entry ${name} not found` };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

function findEocd(bytes: Uint8Array): number {
  const min = Math.max(0, bytes.length - 0xffff - 22);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = bytes.length - 22; offset >= min; offset -= 1) {
    if (dv.getUint32(offset, true) === 0x06054b50) {
      return offset;
    }
  }
  return -1;
}

// Assertions / recording

function assertNonceThroughDeflate(fixture: BinaryFixture, drive: ExtractionDriveEvidence): Record<string, unknown> {
  const rawIncludesNonce = Buffer.from(fixture.bytes).includes(Buffer.from(fixture.nonce));
  const base64 = Buffer.from(fixture.bytes).toString('base64');
  const base64IncludesNonce = base64.includes(fixture.nonce);
  expect(rawIncludesNonce, 'nonce must be absent from raw DEFLATE upload bytes').toBe(false);
  expect(base64IncludesNonce, 'nonce must be absent from DEFLATE upload base64').toBe(false);
  expect(drive.source.status).toBe('extracted');
  expect(String(drive.source.full_text)).toContain(fixture.nonce);
  expect(drive.source.char_count).toBe(fixture.expectedCharCount);
  return {
    nonce_present_in_full_text: true,
    raw_upload_contains_nonce: rawIncludesNonce,
    base64_upload_contains_nonce: base64IncludesNonce,
    char_count: drive.source.char_count,
    expected_char_count: fixture.expectedCharCount,
  };
}

async function expectX2AssertionFailure(fixture: BinaryFixture, drive: ExtractionDriveEvidence): Promise<string> {
  try {
    assertNonceThroughDeflate(fixture, drive);
  } catch (error) {
    return errorMessage(error);
  }
  throw new Error('X-2 unexpectedly stayed green under sabotage');
}

async function recordFalsifier(id: string, failures: Error[], run: () => Promise<unknown>): Promise<void> {
  let evidence: unknown;
  try {
    evidence = await run();
    writeFalsifierLine(id, 'PASS', evidence);
  } catch (error) {
    failures.push(new Error(`${id} failed: ${errorMessage(error)}`));
    writeFalsifierLine(id, 'FAIL', { observed: evidence, error: errorMessage(error) });
  }
}

async function recordInformativeFalsifier(id: string, run: () => Promise<unknown>): Promise<void> {
  try {
    const evidence = await run();
    writeFalsifierLine(id, 'PASS', evidence);
  } catch (error) {
    writeFalsifierLine(id, 'FAIL', { informative: true, soft_fail: true, error: errorMessage(error) });
  }
}

function writeFalsifierLine(id: string, status: 'PASS' | 'FAIL', evidence: unknown): void {
  process.stdout.write(`[extraction-engine-falsifier] ${id} ${status} ${JSON.stringify(evidence)}\n`);
}

// Client / misc helpers

async function uploadBytes(client: PgasClient, sessionId: string, fixture: BinaryFixture): Promise<unknown> {
  const form = new FormData();
  const file = new File([Buffer.from(fixture.bytes)], fixture.name, { type: fixture.mimeType });
  form.append('files', file as unknown as Blob, file.name);
  return client.files.upload(sessionId, form);
}

async function expectUploadReject(client: PgasClient, sessionId: string, file: File): Promise<ApiErrorEvidence> {
  const form = new FormData();
  form.append('files', file as unknown as Blob, file.name);
  try {
    await client.files.upload(sessionId, form);
  } catch (error) {
    return apiErrorEvidence(error);
  }
  throw new Error(`upload unexpectedly succeeded for ${file.name}`);
}

function documentRefPayload(fileRef: FileRef): Record<string, unknown> {
  return { [DOCUMENT_REFS_PATH]: [{ fileId: fileRef.fileId, name: fileRef.name }] };
}

function refsFromResponse(response: unknown): FileRef[] {
  if (!isRecord(response) || !Array.isArray(response.files)) {
    throw new Error(`expected response with files array, got ${JSON.stringify(response)}`);
  }
  return response.files.map((file) => {
    if (!isRecord(file)) throw new Error(`expected FileRef object, got ${JSON.stringify(file)}`);
    return {
      fileId: requiredString(file.fileId, 'fileId'),
      name: requiredString(file.name, 'name'),
      mimeType: requiredString(file.mimeType, 'mimeType'),
      size: requiredNumber(file.size, 'size'),
    };
  });
}

function effect(name: string, payload: Record<string, unknown>, channel = 'widget_output'): Record<string, unknown> {
  return { actions: [{ kind: 'EffectAction', name, channel, payload }] };
}

function scripted(label: string, response: Record<string, unknown>): ScriptedResponse {
  return { label, response };
}

function scriptedAuthor(responses: ScriptedResponse[], order: string[]): { modelId: string; complete(): Promise<string> } {
  let index = 0;
  return {
    modelId: 'extraction-falsifier-author',
    async complete() {
      const response = responses[index++];
      if (!response) {
        throw new Error(`no extraction falsifier author response scripted for call ${String(index - 1)}`);
      }
      order.push(response.label);
      return JSON.stringify(response.response);
    },
  };
}

function resultAt(domain: Record<string, unknown>, pathKey: string): Record<string, unknown> {
  const direct = domain[pathKey];
  if (isRecord(direct)) return direct;
  const prefix = `${pathKey}.`;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(domain)) {
    if (key.startsWith(prefix)) result[key.slice(prefix.length)] = value;
  }
  return result;
}

async function safeRead<T>(read: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function modeOf(envelope: unknown): string | null {
  if (!isRecord(envelope)) return null;
  if (typeof envelope.mode === 'string') return envelope.mode;
  if (isRecord(envelope.state) && typeof envelope.state.mode === 'string') return envelope.state.mode;
  return null;
}

function parseJsonArray(value: unknown): Array<Record<string, unknown>> {
  if (typeof value !== 'string') return [];
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
}

function apiErrorEvidence(error: unknown): ApiErrorEvidence {
  if (isRecord(error)) {
    return {
      name: typeof error.name === 'string' ? error.name : undefined,
      status: typeof error.status === 'number' ? error.status : undefined,
      message: errorMessage(error),
      body: error.body,
      reason: typeof error.reason === 'string' ? error.reason : undefined,
      kind: typeof error.kind === 'string' ? error.kind : undefined,
    };
  }
  return { message: errorMessage(error) };
}

function asUint8Array(value: Uint8Array): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function u16(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);
}

function u32(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});

function requiredString(value: unknown, label: string): string {
  expect(typeof value, label).toBe('string');
  return value as string;
}

function requiredNumber(value: unknown, label: string): number {
  expect(typeof value, label).toBe('number');
  return value as number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface BinaryFixture {
  name: string;
  mimeType: string;
  nonce: string;
  bytes: Uint8Array;
  expectedText: string;
  expectedCharCount: number;
}

interface StoreZipEntry {
  name: string;
  data: Uint8Array;
  crc: number;
}

type FixtureProgramKind = 'self_docx' | 'host_pdf';
type SabotageMode = 'inflate_passthrough' | 'domain_read';

interface ExtractionHandlerState {
  kind: FixtureProgramKind;
  sabotage?: SabotageMode;
  observations: DocumentObservation[];
}

interface DocumentObservation {
  documentCount: number;
  documentSummaries: Array<Record<string, unknown>>;
}

interface ExtractionDriveEvidence {
  sessionId: string;
  fileRef: FileRef;
  triggerError?: string;
  source: Record<string, unknown>;
  finalMode: string | null;
  observations: DocumentObservation[];
}

interface FileRef {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
}

interface ScriptedResponse {
  label: string;
  response: Record<string, unknown>;
}

interface ApiErrorEvidence {
  name?: string;
  status?: number;
  message: string;
  body?: unknown;
  reason?: string;
  kind?: string;
}
