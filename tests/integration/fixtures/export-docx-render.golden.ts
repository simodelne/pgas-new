// GOLDEN FIXTURE — materialized copy of templates/pgas-new/consumer/export-docx.ts.tmpl
// with the `{{NAME}}` token resolved to a fixed literal. Zero-import, self-contained.
//
// PR-E1 (export falsifier) pins this so the render path can be exercised directly
// (F-1) and driven through the engine route (F-2). PR-E2's `renderDocxExportStageBody`
// emitter must produce a stage body whose bundled render module is byte-equal to the
// live template render fns below (minus the `{{NAME}}` substitution) — the byte-equality
// gate is added in PR-E2. Track-change XML (`w:ins`/`w:del`) MUST NEVER appear here
// (F-6 asserts its permanent absence; simoneos#1738 is host-blocked).

export interface ProgramDocxInput {
  title?: string;
  clientName?: string;
  serviceType?: string;
  sections?: Array<{ title: string; body: string | string[] }>;
}

export function renderDocxDocument(body: string): Uint8Array {
  return buildDocx({
    title: 'Program Document',
    sections: [{ title: 'Proposal', body }],
  });
}

export function renderStructuredDocxDocument(input: ProgramDocxInput): Uint8Array {
  const sections = input.sections && input.sections.length > 0
    ? input.sections
    : [
        { title: 'Client', body: input.clientName ?? 'Client' },
        { title: 'Service', body: input.serviceType ?? 'Professional services' },
        { title: 'Acceptance', body: 'Client authorized signatory: ____________________    Date: __________' },
      ];
  return buildDocx({ title: input.title ?? 'Program Document', sections });
}

function buildDocx(input: Required<Pick<ProgramDocxInput, 'title'>> & { sections: Array<{ title: string; body: string | string[] }> }): Uint8Array {
  const documentXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    '<w:body>',
    paragraph(input.title, 'Title'),
    ...input.sections.flatMap((section) => [
      paragraph(section.title, 'Heading1'),
      ...toParagraphs(section.body).map((line) => paragraph(line, 'Normal')),
    ]),
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>',
    '</w:body></w:document>',
  ].join('');

  return zipStore({
    '[Content_Types].xml': contentTypesXml(),
    '_rels/.rels': relsXml(),
    'docProps/app.xml': appXml(),
    'docProps/core.xml': coreXml(input.title),
    'word/document.xml': documentXml,
    'word/styles.xml': stylesXml(),
  });
}

function toParagraphs(body: string | string[]): string[] {
  return Array.isArray(body) ? body : body.split(/\n+/u);
}

function paragraph(text: string, style: 'Title' | 'Heading1' | 'Normal'): string {
  const styleRun = style === 'Normal' ? '' : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`;
  return `<w:p>${styleRun}<w:r><w:t xml:space="preserve">${escapeXml(stripHtml(text))}</w:t></w:r></w:p>`;
}

function contentTypesXml(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>';
}

function relsXml(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>';
}

function appXml(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>SimoneOS</Application></Properties>';
}

function coreXml(title: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${escapeXml(title)}</dc:title><dc:creator>SimoneOS</dc:creator></cp:coreProperties>`;
}

function stylesXml(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style></w:styles>';
}

function zipStore(files: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(content);
    const crc = crc32(data);
    const local = concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc),
      u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes, data,
    ]);
    chunks.push(local);
    central.push(concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc),
      u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0),
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

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
