import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

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
  CapabilityRefusalError,
  capabilityEntry,
} from '../../src/foundry-program/capability-registry.js';
import { startRouteHarness } from './foundry-test-utils.js';
import { renderStructuredDocxDocument } from './fixtures/export-docx-render.golden.js';

// PR-10 / PR-E1 — hand-authored HERMETIC falsifier for the DOCX export render seam.
//
// The render path is pure-compute/deterministic (no LLM, no live provider, no network):
// `renderStructuredDocxDocument` already ships in templates/pgas-new/consumer/export-docx.ts.tmpl
// and produces a real OOXML ZIP. The engine bits use the same scripted-author route-level
// harness as tests/integration/upload-engine-falsifier.test.ts (createPgasServer +
// createPgasClient(appTransport(server.app)) — NOT createTestHarness, which bypasses route
// validation). This falsifier proves the MECHANISM only; PR-E2 adds the deterministic emitter
// and moves F-7 to `scaffolds_with_gap`; the live-drive flip remains PR-E3.
//
// F-4 (diffTokens byte-stability) ships as a focused PR-E2 unit falsifier. See the export design
// doc §4 / §5 (pgas-new-export-design-20260717.md).

const EXPORT_PROGRAM = 'export-render-falsifier';
const CLAUSE_PATH = 'work.clause.text';
const OUTPUT_PATH = 'export_document.output';
const DEFAULT_SENTINEL = 'Client authorized signatory'; // the template's hard-coded fee-proposal fallback
const GOLDEN_PATH = fileURLToPath(new URL('./fixtures/export-docx-render.golden.ts', import.meta.url));

describe('export render route-level falsifier (PR-10 / PR-E1)', () => {
  it('executes F-1..F-7 (render seam, engine domain-injection, honest refusal)', async () => {
    const failures: Error[] = [];

    // ── F-1: renderStructuredDocxDocument produces a real OOXML ZIP ─────────────────
    await recordFalsifier('F-1', failures, async () => {
      const bytes = renderStructuredDocxDocument({
        title: 'F1 Doc',
        sections: [{ title: 'Body', body: 'F1-body-content' }],
      });
      // local file header signature at offset 0 (PK\x03\x04)
      expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
      // end-of-central-directory record present (PK\x05\x06)
      expect(hasSignature(bytes, [0x50, 0x4b, 0x05, 0x06])).toBe(true);
      const entries = parseStoreZip(bytes);
      const names = entries.map((entry) => entry.name);
      expect(names).toContain('[Content_Types].xml');
      expect(names).toContain('word/document.xml');
      // every entry's recomputed CRC-32 matches the stored local-header CRC
      for (const entry of entries) {
        expect(crc32(entry.data), `crc for ${entry.name}`).toBe(entry.crc);
      }
      const contentTypes = decode(entries.find((e) => e.name === '[Content_Types].xml')!.data);
      expect(contentTypes).toContain('wordprocessingml.document.main+xml');
      return { entry_names: names, entry_count: entries.length, byte_length: bytes.length };
    });

    // ── one shared engine drive feeds F-2 (kill) + F-3 (artifact record) ────────────
    const sentinel = `EXPORT-SENTINEL-${randomUUID()}`;
    // ~50 KB clause carrying the run nonce at both ends (size smoke for the state-landing path).
    const clauseText = `${sentinel} ${'lorem clause revision body '.repeat(1800)} ${sentinel}`;
    const drive = await runExportDrive(sentinel, clauseText);

    // ── F-2 — THE KILL TEST: the run nonce reaches word/document.xml only via domain state ──
    await recordFalsifier('F-2', failures, async () => {
      expect(drive.seedMode, 'mode after seed_clause').toBe('render_export');
      expect(drive.finalMode, 'mode after export_document').toBe('complete');
      const base64 = drive.output.docx_base64;
      expect(typeof base64, 'export_document.output.docx_base64 landed at result_path').toBe('string');
      const bytes = Buffer.from(base64 as string, 'base64');
      // real OOXML the client can retrieve + open
      expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
      const docXml = extractEntryText(bytes, 'word/document.xml');
      // (a) the per-run nonce — present in NO template/fixture/prompt — is verbatim in the doc:
      //     it could only reach the zip bytes if the engine injected accumulated domain state
      //     into the export handler payload (getDomainSnapshot → payload.domain).
      expect(docXml, 'run nonce present in document.xml').toContain(sentinel);
      // (b) the template's hard-coded fee-proposal default is ABSENT — the handler did not fall
      //     back to renderStructuredDocxDocument({}) (which would prove domain state was NOT read).
      expect(docXml, 'hard-coded default absent').not.toContain(DEFAULT_SENTINEL);
      // (c) size smoke: the ~50 KB clause round-tripped through state into the bytes intact.
      expect(bytes.length, 'docx byte length').toBeGreaterThan(40 * 1024);
      // the handler read the clause from domain state, not from its own action args.
      expect(drive.exportHandlerSawArgClause, 'export handler received NO clause via action args').toBe(false);
      return {
        docx_bytes: bytes.length,
        section_count: drive.output.section_count,
        sha256: drive.output.sha256,
        nonce_in_docxml: true,
        default_absent: true,
      };
    });

    // ── F-3 (informative): first-class artifact record via ProgramEntry.artifactPolicy ──
    await recordInformativeFalsifier('F-3', async () => {
      const records = extractArtifactRecords(drive.artifacts);
      const record = records.find((r) => r.artifactType === 'docx_export');
      expect(record, 'docx_export SessionArtifactRecord present').toBeTruthy();
      expect(record?.payloadRef).toBe(OUTPUT_PATH);
      // post-terminal retrievability: the payload at payloadRef still decoded in F-2, read
      // AFTER the session reached terminal (compaction-survival of state.domain).
      expect(drive.finalMode === 'complete' || drive.finalStatus === 'complete').toBe(true);
      return { record, artifacts_raw_kind: typeof drive.artifacts, final_status: drive.finalStatus };
    });

    // ── F-5: XML-hostile clause content survives the escapeXml round-trip (no OOXML corruption) ──
    await recordFalsifier('F-5', failures, async () => {
      const hostile = 'A&B "quoted" it\'s <redacted> ✅ end';
      const bytes = renderStructuredDocxDocument({ sections: [{ title: 'Clause', body: hostile }] });
      const docXml = extractEntryText(bytes, 'word/document.xml');
      // XML metacharacters are entity-escaped, never raw — the document stays well-formed.
      expect(docXml).toContain('&amp;');
      expect(docXml).toContain('&quot;');
      expect(docXml).toContain('&apos;');
      expect(docXml).not.toContain('A&B'); // raw ampersand would break the XML
      // the emoji (non-metachar) survives verbatim.
      expect(docXml).toContain('✅');
      // documented, honest limitation: tag-shaped substrings are removed by stripHtml — the
      // literal `<redacted>` does not survive as text (and cannot inject markup).
      expect(docXml).not.toContain('redacted');
      expect(docXml.startsWith('<?xml')).toBe(true);
      return { escaped: true, emoji_survived: true, tag_stripped: true };
    });

    // ── F-6: track-change export is honestly refused; no w:ins/w:del is ever emitted ──
    await recordFalsifier('F-6', failures, async () => {
      let thrown: unknown;
      try {
        assertSynthesizableCapabilities({
          purpose: 'Revise the contract clause-by-clause and export a redlined DOCX with track changes.',
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(CapabilityRefusalError);
      const err = thrown as CapabilityRefusalError;
      const refused = err.refused.map((demand) => demand.capability);
      // co-occurring plain-docx demand does not mask the track-change refusal.
      expect(refused).toContain('export_docx_trackchange');
      expect(err.message).toMatch(/1738|track/i);
      // the foundry must NEVER emit native revision XML it cannot verify — not in a rendered
      // document, not in the golden render source. Match the track-change ELEMENT (`<w:ins ` /
      // `<w:ins>` / `<w:del…`), not the bare substring: prose mentions in comments and the
      // unrelated `<w:instrText>` field element must not trip the guard.
      const trackChangeElement = /<w:(ins|del)[\s>/]/u;
      const doc = extractEntryText(renderStructuredDocxDocument({ sections: [{ title: 'x', body: 'y' }] }), 'word/document.xml');
      expect(doc).not.toMatch(trackChangeElement);
      const goldenSource = readFileSync(GOLDEN_PATH, 'utf8');
      expect(goldenSource).not.toMatch(trackChangeElement);
      return { refused };
    });

    // ── F-7: registry honesty — E3 live-drive proven, export_docx_plain is now synthesizes ──
    await recordFalsifier('F-7', failures, async () => {
      const plain = capabilityEntry('export_docx_plain');
      expect(plain?.status, 'export_docx_plain status at PR-E3 (live-drive proven on qwen)').toBe('synthesizes');
      expect(plain?.evidence ?? '').toMatch(/live-drive|nonce|export_engaged/i);
      const track = capabilityEntry('export_docx_trackchange');
      expect(track?.status).toBe('refuses');
      expect(track?.gap_note ?? '').toMatch(/1738/);
      return { export_docx_plain: plain?.status, export_docx_trackchange: track?.status };
    });

    if (failures.length > 0) {
      throw new Error(failures.map((failure) => failure.message).join('\n'));
    }
  });
});

// ───────────────────────────── engine drive ─────────────────────────────

interface ExportDriveEvidence {
  sessionId: string;
  seedMode: string | null;
  finalMode: string | null;
  finalStatus: string | undefined;
  output: Record<string, unknown>;
  artifacts: unknown;
  exportHandlerSawArgClause: boolean;
}

async function runExportDrive(sentinel: string, clauseText: string): Promise<ExportDriveEvidence> {
  const state: ExportHandlerState = { sawArgClause: false };
  return withServer(
    {
      programName: EXPORT_PROGRAM,
      script: [
        // stage-1 (the content-producing stage): author supplies the clause; it lands in state.
        scripted('seed', effect('seed_clause', { clause_text: clauseText })),
        // stage-2 (export): author supplies NO clause — the handler must read it from domain state.
        scripted('export', effect('export_document', {})),
      ],
      createEntry: (tempDir) => createExportEntry(tempDir, state),
    },
    async ({ client }) => {
      const created = await client.sessions.create({ program: EXPORT_PROGRAM });
      await client.sessions.trigger(created.sessionId, { channel: 'user_text', payload: 'seed the clause' });
      const afterSeed = await client.sessions.get(created.sessionId);
      await client.sessions.trigger(created.sessionId, { channel: 'user_text', payload: 'render the export' });
      const finalSession = await client.sessions.get(created.sessionId);
      const world = await client.sessions.world(created.sessionId);
      const domain = isRecord(world) && isRecord(world.domain) ? world.domain : {};
      let artifacts: unknown;
      try {
        artifacts = await client.sessions.systemArtifacts({ program: EXPORT_PROGRAM, artifactType: 'docx_export' });
      } catch (error) {
        artifacts = { error: errorMessage(error) };
      }
      return {
        sessionId: created.sessionId,
        seedMode: modeOf(afterSeed),
        finalMode: modeOf(finalSession),
        finalStatus: isRecord(finalSession) && typeof finalSession.status === 'string' ? finalSession.status : undefined,
        output: resultAt(domain, OUTPUT_PATH),
        artifacts,
        exportHandlerSawArgClause: state.sawArgClause,
      };
    },
  );
}

interface ExportHandlerState {
  sawArgClause: boolean;
}

interface ExportServerScenario {
  programName: string;
  script: ScriptedResponse[];
  createEntry: (tempDir: string) => ProgramEntry;
}

async function withServer<T>(
  scenario: ExportServerScenario,
  run: (ctx: { client: PgasClient; tempDir: string }) => Promise<T>,
): Promise<T> {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pgas-export-falsifier-'));
  const order: string[] = [];
  const entry = scenario.createEntry(tempDir);
  const { client, close } = await startRouteHarness({
    programs: [{ name: scenario.programName, entry }],
    authorHandle: scriptedAuthor(scenario.script, order),
    observerModelId: 'export-falsifier-observer',
    storage: { uploadsDir: path.join(tempDir, 'uploads') },
  });
  try {
    return await run({ client, tempDir });
  } finally {
    await close();
    rmSync(tempDir, { force: true, recursive: true });
  }
}

function createExportEntry(tempDir: string, state: ExportHandlerState): ProgramEntry {
  const specPath = path.join(tempDir, `${EXPORT_PROGRAM}-${randomUUID()}.yml`);
  writeFileSync(specPath, exportSpecYaml(EXPORT_PROGRAM), 'utf8');
  const { spec } = loadSpecWithPatterns(specPath);
  const handlers = createExportHandlers(state);
  return {
    spec,
    // ProgramEntry.artifactPolicy — the engine's native first-class artifact system (F-3).
    artifactPolicy: {
      rules: [
        {
          artifactType: 'docx_export',
          title: 'Exported DOCX',
          summary: 'Deterministically rendered DOCX artifact (base64 in domain state).',
          payloadRef: OUTPUT_PATH,
          whenAllPaths: [`${OUTPUT_PATH}.docx_base64`],
        },
      ],
    },
    createAdapters: (ctx) => createProgramAdapters(spec, ctx, handlers),
  };
}

function createExportHandlers(state: ExportHandlerState): Record<string, ToolHandler> {
  return {
    async seed_clause(payload) {
      const args = asRecord(payload);
      const text = typeof args.clause_text === 'string' ? args.clause_text : '';
      return { text };
    },
    async export_document(payload) {
      const args = asRecord(payload);
      // record whether the author smuggled the clause via action args (it must NOT — the whole
      // point of the kill test is that the clause arrives via injected domain state).
      if (typeof args.clause_text === 'string' && args.clause_text.length > 0) {
        state.sawArgClause = true;
      }
      const domain = isRecord(args.domain) ? args.domain : {};
      const clauseText = readClauseFromDomain(domain);
      const input = { title: 'Falsifier Export', sections: [{ title: 'Clause', body: clauseText }] };
      const bytes = renderStructuredDocxDocument(input);
      const base64 = Buffer.from(bytes).toString('base64');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      return {
        status: 'rendered',
        result_json: JSON.stringify({ docx_base64: base64, docx_bytes: bytes.length, sha256, section_count: input.sections.length }),
        docx_base64: base64,
        docx_bytes: bytes.length,
        sha256,
        section_count: input.sections.length,
      };
    },
  };
}

function readClauseFromDomain(domain: Record<string, unknown>): string {
  const leaf = domain[CLAUSE_PATH];
  if (typeof leaf === 'string') {
    return leaf;
  }
  const nested = domain['work.clause'];
  if (isRecord(nested) && typeof nested.text === 'string') {
    return nested.text;
  }
  return '';
}

function exportSpecYaml(programName: string): string {
  return `name: "${programName}"
termination: BoundedSession
topology: CyclicTopology
pure: true

preamble: |
  Route-level DOCX export render falsifier.

initial: bootstrap
terminal: [complete]

features:
  - base

channels:
  user_text: { direction: In, sync: Async }
  widget_output: { direction: Out, sync: Sync }

modes:
  bootstrap:
    vocabulary: [seed_clause]
    channels: [user_text, widget_output]
    transitions:
      - target: render_export
        guard: { kind: FieldTruthy, path: ${CLAUSE_PATH} }
  render_export:
    vocabulary: [export_document]
    channels: [user_text, widget_output]
    transitions:
      - target: complete
        guard: { kind: FieldTruthy, path: ${OUTPUT_PATH}.status }
  complete:
    vocabulary: []
    channels: [widget_output]

proceed_to:
  seed_clause: render_export
  export_document: complete

projection:
  bootstrap:
    include: [inputs.user_text]
    exclude: []
  render_export:
    include:
      - work.clause
      - ${CLAUSE_PATH}
    exclude: []
  complete:
    include:
      - ${CLAUSE_PATH}
      - ${OUTPUT_PATH}
      - ${OUTPUT_PATH}.status
      - ${OUTPUT_PATH}.docx_bytes
      - ${OUTPUT_PATH}.section_count
    exclude: []

prompts:
  bootstrap: "Call seed_clause with the clause text."
  render_export: "Call export_document with no arguments."
  complete: "Terminal."

ingestion:
  user_text:
    - inputs.user_text

action_map:
  seed_clause:
    description: "Seed the clause text into work.clause."
    mutations: []
    channel: widget_output
    result_path: work.clause
  export_document:
    description: "Render the accumulated clause into a DOCX artifact."
    mutations: []
    channel: widget_output
    result_path: ${OUTPUT_PATH}

schema:
  inputs.user_text: string
  work.clause: object
  ${CLAUSE_PATH}: string
  ${OUTPUT_PATH}: object
  ${OUTPUT_PATH}.status: string
  ${OUTPUT_PATH}.result_json: string
  ${OUTPUT_PATH}.docx_base64: string
  ${OUTPUT_PATH}.docx_bytes: number
  ${OUTPUT_PATH}.sha256: string
  ${OUTPUT_PATH}.section_count: number

repair_bound: 2

fallback:
  channel: widget_output
  payload: { ok: false }
`;
}

// ───────────────────────────── scripted author ─────────────────────────────

interface ScriptedResponse {
  label: string;
  response: Record<string, unknown>;
}

function effect(name: string, payload: Record<string, unknown>, channel = 'widget_output'): Record<string, unknown> {
  return { actions: [{ kind: 'EffectAction', name, channel, payload }] };
}

function scripted(label: string, response: Record<string, unknown>): ScriptedResponse {
  return { label, response };
}

function scriptedAuthor(
  responses: ScriptedResponse[],
  order: string[],
): { modelId: string; complete(): Promise<string> } {
  let index = 0;
  return {
    modelId: 'export-falsifier-author',
    async complete() {
      const response = responses[index++];
      if (!response) {
        throw new Error(`no export falsifier author response scripted for call ${String(index - 1)}`);
      }
      order.push(response.label);
      return JSON.stringify(response.response);
    },
  };
}

// ───────────────────────────── falsifier recording ─────────────────────────────

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
  process.stdout.write(`[export-render-falsifier] ${id} ${status} ${JSON.stringify(evidence)}\n`);
}

// ───────────────────────────── zip / domain helpers ─────────────────────────────

interface StoreZipEntry {
  name: string;
  data: Uint8Array;
  crc: number;
}

function parseStoreZip(bytes: Uint8Array): StoreZipEntry[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: StoreZipEntry[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length && dv.getUint32(offset, true) === 0x04034b50) {
    const method = dv.getUint16(offset + 8, true);
    const crc = dv.getUint32(offset + 14, true) >>> 0;
    const compSize = dv.getUint32(offset + 18, true);
    const nameLen = dv.getUint16(offset + 26, true);
    const extraLen = dv.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const name = decode(bytes.subarray(nameStart, nameStart + nameLen));
    if (method !== 0) {
      throw new Error(`zip entry ${name} is not STORE method (method=${String(method)})`);
    }
    const dataStart = nameStart + nameLen + extraLen;
    const data = bytes.subarray(dataStart, dataStart + compSize);
    entries.push({ name, data, crc });
    offset = dataStart + compSize;
  }
  return entries;
}

function extractEntryText(bytes: Uint8Array, name: string): string {
  const entry = parseStoreZip(bytes).find((candidate) => candidate.name === name);
  if (!entry) {
    throw new Error(`zip entry ${name} not found`);
  }
  return decode(entry.data);
}

function hasSignature(bytes: Uint8Array, sig: number[]): boolean {
  for (let i = 0; i + sig.length <= bytes.length; i += 1) {
    let match = true;
    for (let j = 0; j < sig.length; j += 1) {
      if (bytes[i + j] !== sig[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      return true;
    }
  }
  return false;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function resultAt(domain: Record<string, unknown>, pathKey: string): Record<string, unknown> {
  const direct = domain[pathKey];
  const result: Record<string, unknown> = isRecord(direct) ? { ...direct } : {};
  const prefix = `${pathKey}.`;
  for (const [key, value] of Object.entries(domain)) {
    if (key.startsWith(prefix)) {
      result[key.slice(prefix.length)] = value;
    }
  }
  return result;
}

function extractArtifactRecords(raw: unknown): Array<Record<string, unknown>> {
  const container = isRecord(raw) && Array.isArray(raw.artifacts) ? raw.artifacts : Array.isArray(raw) ? raw : [];
  return container.filter(isRecord);
}

function modeOf(envelope: unknown): string | null {
  if (!isRecord(envelope)) {
    return null;
  }
  if (typeof envelope.mode === 'string') {
    return envelope.mode;
  }
  if (isRecord(envelope.state) && typeof envelope.state.mode === 'string') {
    return envelope.state.mode;
  }
  return null;
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
