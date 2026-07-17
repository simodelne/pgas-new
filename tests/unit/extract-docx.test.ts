import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it } from 'vitest';

import { extractDocxText as referenceExtractDocxText } from '../integration/fixtures/extract-docx.reference.js';
import { renderStructuredDocxDocument } from '../integration/fixtures/export-docx-render.golden.js';

const DOCX_TEMPLATE_PATH = fileURLToPath(new URL('../../templates/pgas-new/consumer/extract-docx.ts.tmpl', import.meta.url));

type ExtractDocxText = typeof referenceExtractDocxText;

describe('DOCX extraction template', () => {
  it('is a token-free Node-builtin-only consumer template', () => {
    const source = readFileSync(DOCX_TEMPLATE_PATH, 'utf8');

    expect(source).not.toContain('{{');
    expect([...source.matchAll(/^import .* from ['"]([^'"]+)['"];$/gmu)].map((match) => match[1]))
      .toEqual(['node:zlib']);
  });

  it('matches the U5-F reference on STORE docx render round-trips', async () => {
    const templateExtractDocxText = await loadTemplateExtractDocxText();
    const bytes = renderStructuredDocxDocument({
      title: 'Round Trip',
      sections: [
        {
          title: 'Brief',
          body: ['First paragraph.', 'Second paragraph with A&B.'],
        },
      ],
    });

    const expectedText = ['Round Trip', 'Brief', 'First paragraph.', 'Second paragraph with A&B.'].join('\n');
    expect(templateExtractDocxText(bytes)).toEqual(referenceExtractDocxText(bytes));
    expect(templateExtractDocxText(bytes)).toEqual({
      ok: true,
      text: expectedText,
      char_count: expectedText.length,
    });
  });

  it('matches the reference on DEFLATE-rezipped docx bytes', async () => {
    const templateExtractDocxText = await loadTemplateExtractDocxText();
    const storeBytes = renderStructuredDocxDocument({
      title: 'Deflated',
      sections: [{ title: 'Body', body: 'Nonce-through-deflate text.' }],
    });
    const deflated = rezipDeflate(storeBytes);

    expect(templateExtractDocxText(deflated)).toEqual(referenceExtractDocxText(deflated));
    expect(templateExtractDocxText(deflated)).toMatchObject({
      ok: true,
      text: 'Deflated\nBody\nNonce-through-deflate text.',
      char_count: 'Deflated\nBody\nNonce-through-deflate text.'.length,
    });
  });

  it('fails closed on corrupt inputs exactly like the reference', async () => {
    const templateExtractDocxText = await loadTemplateExtractDocxText();
    for (const bytes of [
      new Uint8Array(),
      new TextEncoder().encode('not a zip'),
      renderStructuredDocxDocument({ title: 'Truncated', sections: [{ title: 'Body', body: 'x' }] }).slice(0, 48),
    ]) {
      const template = templateExtractDocxText(bytes);
      const reference = referenceExtractDocxText(bytes);
      expect(template).toEqual(reference);
      expect(template.ok).toBe(false);
    }
  });

  it('matches the reference for split runs, tab, break, and XML entities with amp decoded last', async () => {
    const templateExtractDocxText = await loadTemplateExtractDocxText();
    const xml = [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
      '<w:body>',
      '<w:p><w:r><w:t>Split</w:t></w:r><w:r><w:t>Run</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>A&amp;B</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>Line</w:t><w:br/><w:t>break</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>&amp;lt;kept entity&amp;gt; &lt;decoded&gt; &#65; &#x42; &quot;q&quot; &apos;s&apos;</w:t></w:r></w:p>',
      '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>',
      '</w:body></w:document>',
    ].join('');
    const base = renderStructuredDocxDocument({ title: 'placeholder', sections: [{ title: 'placeholder', body: 'placeholder' }] });
    const bytes = replaceStoreZipEntry(base, 'word/document.xml', new TextEncoder().encode(xml));
    const expectedText = ['SplitRun\tA&B', 'Line\nbreak', '&lt;kept entity&gt; <decoded> A B "q" \'s\''].join('\n');

    expect(templateExtractDocxText(bytes)).toEqual(referenceExtractDocxText(bytes));
    expect(templateExtractDocxText(bytes)).toEqual({
      ok: true,
      text: expectedText,
      char_count: expectedText.length,
    });
  });
});

let templateExtractorPromise: Promise<ExtractDocxText> | undefined;

async function loadTemplateExtractDocxText(): Promise<ExtractDocxText> {
  templateExtractorPromise ??= (async () => {
    const source = readFileSync(DOCX_TEMPLATE_PATH, 'utf8');
    const output = transpileModule(source, {
      compilerOptions: {
        module: ModuleKind.ES2022,
        target: ScriptTarget.ES2022,
      },
    }).outputText;
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`;
    const module = await import(moduleUrl) as { extractDocxText?: unknown };
    if (typeof module.extractDocxText !== 'function') {
      throw new Error('extract-docx template did not export extractDocxText');
    }
    return module.extractDocxText as ExtractDocxText;
  })();
  return templateExtractorPromise;
}

function rezipDeflate(storeDocxBytes: Uint8Array): Uint8Array {
  const entries = parseStoreZipEntries(storeDocxBytes);
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const compressed = asUint8Array(deflateRawSync(entry.data));
    const crc = crc32(entry.data);
    const local = concat([
      u32(0x04034b50), u16(20), u16(0), u16(8), u16(0), u16(0), u32(crc),
      u32(compressed.length), u32(entry.data.length), u16(nameBytes.length), u16(0), nameBytes, compressed,
    ]);
    chunks.push(local);
    central.push(concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u16(0), u16(0), u32(crc),
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
  return zipStoreEntries(parseStoreZipEntries(storeZipBytes).map((entry) => entry.name === name ? { ...entry, data } : entry));
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

function parseStoreZipEntries(bytes: Uint8Array): Array<{ name: string; data: Uint8Array }> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: Array<{ name: string; data: Uint8Array }> = [];
  let offset = 0;
  while (offset + 4 <= bytes.length && dv.getUint32(offset, true) === 0x04034b50) {
    const method = dv.getUint16(offset + 8, true);
    const compressedSize = dv.getUint32(offset + 18, true);
    const nameLength = dv.getUint16(offset + 26, true);
    const extraLength = dv.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (method !== 0 || dataEnd > bytes.length) {
      throw new Error('expected a valid STORE zip entry');
    }
    entries.push({
      name: new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength)),
      data: bytes.subarray(dataStart, dataEnd),
    });
    offset = dataEnd;
  }
  return entries;
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

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function u16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}

function asUint8Array(value: Uint8Array): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}
