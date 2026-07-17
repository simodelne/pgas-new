import { describe, expect, it } from 'vitest';

import {
  assessExportEngagement,
  type GeneratedLiveDriveExportReport,
} from '../../src/pgas-new/generated-live-drive.js';

const NONCE = 'PGAS-EXPORT-NONCE-unit';
const PAYLOAD_REF = 'export_document.output';
const DEFAULT_TEXT = 'Client authorized signatory';

describe('assessExportEngagement', () => {
  it('passes only when artifact record, payload, nonce, anti-default, and STORE OOXML checks all hold', () => {
    const verdict = assessExportEngagement({
      report: exportReport(),
      expectedPayloadRef: PAYLOAD_REF,
      nonce: NONCE,
    });

    expect(verdict.export_engaged).toBe(true);
    expect(verdict.artifact_record_harvested).toBe(true);
    expect(verdict.payload_decoded).toBe(true);
    expect(verdict.nonce_present).toBe(true);
    expect(verdict.default_absent).toBe(true);
    expect(verdict.zip_store_ooxml).toBe(true);
    expect(verdict.reason).toBeNull();
    expect(verdict.notes).toEqual([]);
  });

  it('fails closed when no docx_export artifact record was harvested', () => {
    const verdict = assessExportEngagement({
      report: exportReport({ artifact_records: [] }),
      expectedPayloadRef: PAYLOAD_REF,
      nonce: NONCE,
    });

    expect(verdict.export_engaged).toBe(false);
    expect(verdict.artifact_record_harvested).toBe(false);
    expect(verdict.reason).toBe('artifact_record_absent');
  });

  it('fails closed when the payload base64 is empty', () => {
    const verdict = assessExportEngagement({
      report: exportReport({ docx_base64: '' }),
      expectedPayloadRef: PAYLOAD_REF,
      nonce: NONCE,
    });

    expect(verdict.export_engaged).toBe(false);
    expect(verdict.payload_decoded).toBe(false);
    expect(verdict.reason).toBe('docx_base64_empty');
  });

  it('fails closed when the nonce is absent from word/document.xml', () => {
    const verdict = assessExportEngagement({
      report: exportReport({ docx_base64: docxBase64('proposal text without the nonce') }),
      expectedPayloadRef: PAYLOAD_REF,
      nonce: NONCE,
    });

    expect(verdict.export_engaged).toBe(false);
    expect(verdict.nonce_present).toBe(false);
    expect(verdict.reason).toBe('nonce_absent');
  });

  it('fails closed when the hard-coded fee-proposal default is present', () => {
    const verdict = assessExportEngagement({
      report: exportReport({ docx_base64: docxBase64(`${NONCE} ${DEFAULT_TEXT}`) }),
      expectedPayloadRef: PAYLOAD_REF,
      nonce: NONCE,
    });

    expect(verdict.export_engaged).toBe(false);
    expect(verdict.default_absent).toBe(false);
    expect(verdict.reason).toBe('default_export_text_present');
  });

  it('fails closed when the decoded bytes are not a STORE-method OOXML ZIP', () => {
    const verdict = assessExportEngagement({
      report: exportReport({ docx_base64: Buffer.from('not a zip').toString('base64') }),
      expectedPayloadRef: PAYLOAD_REF,
      nonce: NONCE,
    });

    expect(verdict.export_engaged).toBe(false);
    expect(verdict.zip_store_ooxml).toBe(false);
    expect(verdict.reason).toBe('docx_zip_invalid');
  });
});

function exportReport(overrides: Partial<GeneratedLiveDriveExportReport> = {}): GeneratedLiveDriveExportReport {
  const docx_base64 = docxBase64(`Live export body ${NONCE}`);
  return {
    artifact_records: [
      {
        artifactType: 'docx_export',
        payloadRef: PAYLOAD_REF,
        artifactId: 'artifact-1',
        sourceSessionId: 'session-1',
      },
    ],
    artifact_record: {
      artifactType: 'docx_export',
      payloadRef: PAYLOAD_REF,
      artifactId: 'artifact-1',
      sourceSessionId: 'session-1',
    },
    payload_ref: PAYLOAD_REF,
    docx_base64,
    docx_bytes: Buffer.from(docx_base64, 'base64').length,
    nonce_present: true,
    default_absent: true,
    zip_store_ooxml: true,
    extracted_text_sample: `Live export body ${NONCE}`,
    ...overrides,
  };
}

function docxBase64(documentXmlText: string): string {
  return storeZip([
    {
      name: '[Content_Types].xml',
      text: '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    },
    {
      name: 'word/document.xml',
      text: `<w:document><w:body><w:t>${documentXmlText}</w:t></w:body></w:document>`,
    },
  ]).toString('base64');
}

function storeZip(entries: Array<{ name: string; text: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.text, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralOffset = offset;
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);

  return Buffer.concat([...locals, ...centrals, eocd]);
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
