import { inflateRawSync } from 'node:zlib';

export type ExtractDocxResult =
  | { ok: true; text: string; char_count: number }
  | { ok: false; reason: string };

const TEXT_DECODER = new TextDecoder();
const TARGET_ENTRY = 'word/document.xml';

export function extractDocxText(bytes: Uint8Array): ExtractDocxResult {
  try {
    const entry = readZipEntry(bytes, TARGET_ENTRY);
    if (!entry.ok) return entry;
    const xml = TEXT_DECODER.decode(entry.data);
    const text = extractWordBodyText(xml);
    if (!text.ok) return text;
    return { ok: true, text: text.text, char_count: text.text.length };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

function readZipEntry(bytes: Uint8Array, wantedName: string): { ok: true; data: Uint8Array } | { ok: false; reason: string } {
  if (bytes.length < 22) {
    return { ok: false, reason: 'not a zip: end-of-central-directory not found' };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory(bytes);
  if (eocdOffset < 0) {
    return { ok: false, reason: 'not a zip: end-of-central-directory not found' };
  }

  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const centralDisk = view.getUint16(eocdOffset + 6, true);
  const entriesOnDisk = view.getUint16(eocdOffset + 8, true);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    return { ok: false, reason: 'unsupported zip: multi-disk archives are not supported' };
  }
  if (centralOffset + centralSize > bytes.length || centralOffset >= eocdOffset) {
    return { ok: false, reason: 'corrupt zip: central directory is truncated' };
  }

  let cursor = centralOffset;
  const centralEnd = centralOffset + centralSize;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > centralEnd || cursor + 46 > bytes.length) {
      return { ok: false, reason: 'corrupt zip: central directory entry is truncated' };
    }
    if (view.getUint32(cursor, true) !== 0x02014b50) {
      return { ok: false, reason: 'corrupt zip: bad central directory signature' };
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true) >>> 0;
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    const next = nameEnd + extraLength + commentLength;
    if (next > centralEnd || next > bytes.length) {
      return { ok: false, reason: 'corrupt zip: central directory entry metadata is truncated' };
    }
    const name = TEXT_DECODER.decode(bytes.subarray(nameStart, nameEnd));
    if (name === wantedName) {
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
        return { ok: false, reason: 'unsupported zip: ZIP64 entries are not supported' };
      }
      return readLocalEntry(bytes, {
        flags,
        method,
        crc,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        name,
      });
    }
    cursor = next;
  }

  return { ok: false, reason: `${wantedName} not found in docx zip` };
}

function readLocalEntry(bytes: Uint8Array, entry: CentralDirectoryEntry): { ok: true; data: Uint8Array } | { ok: false; reason: string } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (entry.flags & 0x1) {
    return { ok: false, reason: `unsupported zip: ${entry.name} is encrypted` };
  }
  if (entry.method !== 0 && entry.method !== 8) {
    return { ok: false, reason: `unsupported zip method ${String(entry.method)} for ${entry.name}` };
  }
  const localOffset = entry.localHeaderOffset;
  if (localOffset + 30 > bytes.length) {
    return { ok: false, reason: 'corrupt zip: local header is truncated' };
  }
  if (view.getUint32(localOffset, true) !== 0x04034b50) {
    return { ok: false, reason: 'corrupt zip: bad local header signature' };
  }
  const localNameLength = view.getUint16(localOffset + 26, true);
  const localExtraLength = view.getUint16(localOffset + 28, true);
  const dataStart = localOffset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataStart > bytes.length || dataEnd > bytes.length) {
    return { ok: false, reason: `corrupt zip: ${entry.name} data is truncated` };
  }
  const compressed = bytes.subarray(dataStart, dataEnd);
  let data: Uint8Array;
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.uncompressedSize) {
      return { ok: false, reason: `corrupt zip: STORE size mismatch for ${entry.name}` };
    }
    data = compressed;
  } else {
    try {
      data = asUint8Array(inflateRawSync(compressed));
    } catch (error) {
      return { ok: false, reason: `deflate inflate failed for ${entry.name}: ${errorMessage(error)}` };
    }
  }
  if (data.length !== entry.uncompressedSize) {
    return { ok: false, reason: `corrupt zip: ${entry.name} inflated size mismatch` };
  }
  const actualCrc = crc32(data);
  if (actualCrc !== entry.crc) {
    return { ok: false, reason: `corrupt zip: ${entry.name} CRC mismatch` };
  }
  return { ok: true, data };
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const minOffset = Math.max(0, bytes.length - 0xffff - 22);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = bytes.length - 22; offset >= minOffset; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      const commentLength = view.getUint16(offset + 20, true);
      if (offset + 22 + commentLength === bytes.length) {
        return offset;
      }
    }
  }
  return -1;
}

function extractWordBodyText(xml: string): { ok: true; text: string } | { ok: false; reason: string } {
  const bodyMatch = /<w:body(?:\s[^>]*)?>/u.exec(xml);
  if (!bodyMatch || bodyMatch.index === undefined) {
    return { ok: false, reason: 'word/document.xml missing w:body' };
  }
  const bodyStart = bodyMatch.index + bodyMatch[0].length;
  const bodyEnd = xml.indexOf('</w:body>', bodyStart);
  if (bodyEnd < 0) {
    return { ok: false, reason: 'word/document.xml has truncated w:body' };
  }
  return { ok: true, text: parseBodyXmlText(xml.slice(bodyStart, bodyEnd)) };
}

function parseBodyXmlText(bodyXml: string): string {
  const paragraphs: string[] = [];
  let paragraph: string | undefined;
  let inText = false;
  let cursor = 0;
  const tagPattern = /<[^>]*>/gu;
  for (const match of bodyXml.matchAll(tagPattern)) {
    const tagStart = match.index ?? 0;
    if (inText && tagStart > cursor) {
      paragraph = appendText(paragraph, decodeXmlEntities(bodyXml.slice(cursor, tagStart)));
    }
    const tag = parseXmlTag(match[0]);
    if (tag) {
      if (!tag.closing && tag.localName === 'p') {
        if (paragraph !== undefined) paragraphs.push(paragraph);
        paragraph = '';
      } else if (tag.closing && tag.localName === 'p') {
        paragraphs.push(paragraph ?? '');
        paragraph = undefined;
        inText = false;
      } else if (!tag.closing && tag.localName === 't') {
        inText = !tag.selfClosing;
      } else if (tag.closing && tag.localName === 't') {
        inText = false;
      } else if (!tag.closing && tag.localName === 'tab') {
        paragraph = appendText(paragraph, '\t');
      } else if (!tag.closing && tag.localName === 'br') {
        paragraph = appendText(paragraph, '\n');
      }
    }
    cursor = tagStart + match[0].length;
  }
  if (inText && cursor < bodyXml.length) {
    paragraph = appendText(paragraph, decodeXmlEntities(bodyXml.slice(cursor)));
  }
  if (paragraph !== undefined) {
    paragraphs.push(paragraph);
  }
  return paragraphs.join('\n');
}

function appendText(paragraph: string | undefined, text: string): string {
  return `${paragraph ?? ''}${text}`;
}

function parseXmlTag(rawTag: string): XmlTag | undefined {
  let raw = rawTag.slice(1, -1).trim();
  if (raw.length === 0 || raw.startsWith('?') || raw.startsWith('!')) {
    return undefined;
  }
  const closing = raw.startsWith('/');
  if (closing) raw = raw.slice(1).trimStart();
  const selfClosing = raw.endsWith('/');
  if (selfClosing) raw = raw.slice(0, -1).trimEnd();
  const name = raw.split(/\s+/u)[0] ?? '';
  const localName = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
  if (localName.length === 0) return undefined;
  return { localName, closing, selfClosing };
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/gu, (match, hex: string) => codePointEntity(match, Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/gu, (match, decimal: string) => codePointEntity(match, Number.parseInt(decimal, 10)))
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function codePointEntity(original: string, codePoint: number): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return original;
  }
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return original;
  }
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

function asUint8Array(value: Uint8Array): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface CentralDirectoryEntry {
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  name: string;
}

interface XmlTag {
  localName: string;
  closing: boolean;
  selfClosing: boolean;
}
