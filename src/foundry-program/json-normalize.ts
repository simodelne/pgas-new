/**
 * Shared, deterministic JSON normalization for governed intake JSON-string
 * fields (Q3 stages, Q4 transitions, Q5 delegation, Q6 completion).
 *
 * Extracted from handlers.ts so the SAME repair/normalization runs both:
 *   1. at the tool-call boundary (record_qN_* handlers), and
 *   2. downstream at mechanical synthesis (synthesizeProgramSpecFromDomain).
 *
 * This matters for issue #92: the engine only supports `from_arg` reaction
 * mutations, so `intake.stages_json` is persisted from the RAW tool argument,
 * NOT from the handler's normalized/canonical output. Without applying the
 * same repair downstream, a rich Q3 stages_json carrying per-stage domain_spec
 * that arrives with a known qwen malformation (dropped boundary brace) is
 * stored raw and then strict-parsed downstream — dropping every domain_spec
 * (empty stageDomainSpecs) or failing synthesis outright.
 *
 * All functions are pure and mechanical (SI-3): no LLM, no freeform emission.
 */

export interface NormalizedJsonField {
  value: unknown;
  canonical: string;
}

export type JsonTopLevelType = 'array' | 'object';

export function parseAndNormalizeJson(rawValue: string, label: string): NormalizedJsonField {
  const normalizedRawValue = normalizeSmartQuotes(unescapeCommonHtmlEntities(rawValue));
  let value: unknown;
  try {
    value = JSON.parse(normalizedRawValue) as unknown;
  } catch (strictError) {
    try {
      value = new JsonishParser(normalizedRawValue).parse();
    } catch (tolerantError) {
      throw new Error(
        `invalid JSON-string payload field: ${label}; strict JSON.parse failed (${errorMessage(strictError)}) and tolerant JSON5-style parse failed (${errorMessage(tolerantError)})`,
      );
    }
  }
  return {
    value,
    canonical: canonicalJson(value, label),
  };
}

/**
 * Stages-specific normalization. In addition to the shared smart-quote / HTML
 * entity / JSON5 tolerance, this repairs the known qwen malformation where the
 * closing brace of a rich stage object is dropped just before the next
 * `,{"slug":...}` boundary (`]},{"slug"` -> `]}},{"slug"`), which otherwise
 * discards the trailing per-stage domain_spec objects.
 */
export function parseAndNormalizeStagesJson(rawValue: string): NormalizedJsonField {
  try {
    return parseAndNormalizeJson(rawValue, 'intake.stages_json');
  } catch (error) {
    const normalizedRawValue = normalizeSmartQuotes(unescapeCommonHtmlEntities(rawValue));
    const repaired = normalizedRawValue.replace(/\]\}(?=,\s*\{"slug"\s*:)/gu, ']}}');
    if (repaired === normalizedRawValue) {
      throw error;
    }
    try {
      return parseAndNormalizeJson(repaired, 'intake.stages_json');
    } catch {
      throw error;
    }
  }
}

export function normalizeSmartQuotes(value: string): string {
  return value.replace(/[“”]/gu, '"').replace(/[‘’]/gu, '\'');
}

export function unescapeCommonHtmlEntities(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < 5; pass += 1) {
    const previous = decoded;
    decoded = decodeAmpNumericEntities(
      decodeNonAmpNumericEntities(
        decoded
          .replace(/&quot;/giu, '"')
          .replace(/&lt;/giu, '<')
          .replace(/&gt;/giu, '>')
          .replace(/&apos;/giu, '\''),
      )
        .replace(/&amp;/giu, '&'),
    );
    if (decoded === previous) {
      return decoded;
    }
  }
  return decoded;
}

function decodeNonAmpNumericEntities(value: string): string {
  return decodeNumericEntities(value, false);
}

function decodeAmpNumericEntities(value: string): string {
  return decodeNumericEntities(value, true);
}

function decodeNumericEntities(value: string, ampersandOnly: boolean): string {
  return value.replace(
    /&#(?:x([0-9a-f]+)|(\d+));/giu,
    (entity: string, hex: string | undefined, decimal: string | undefined) => {
      const codePoint = Number.parseInt(hex ?? decimal ?? '', hex === undefined ? 10 : 16);
      if (codePoint === 38) {
        return '&';
      }
      if (ampersandOnly) {
        return entity;
      }
      switch (codePoint) {
        case 34:
          return '"';
        case 39:
          return '\'';
        case 60:
          return '<';
        case 62:
          return '>';
        default:
          return entity;
      }
    },
  );
}

export function canonicalJson(value: unknown, label: string): string {
  const canonical = JSON.stringify(value);
  if (canonical === undefined) {
    throw new Error(`JSON payload field ${label} cannot be canonicalized`);
  }
  return canonical;
}

export function assertJsonTopLevelType(value: unknown, expectedType: JsonTopLevelType, label: string): void {
  if (expectedType === 'array') {
    if (!Array.isArray(value)) {
      throw new Error(`invalid JSON-string payload field: ${label}; expected a JSON array`);
    }
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid JSON-string payload field: ${label}; expected a JSON object`);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class JsonishParser {
  private offset = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    const value = this.parseValue();
    this.skipWhitespace();
    if (!this.isDone()) {
      throw new Error(`unexpected token ${JSON.stringify(this.current())} at position ${this.offset}`);
    }
    return value;
  }

  private parseValue(): unknown {
    this.skipWhitespace();
    if (this.isDone()) {
      throw new Error('unexpected end of input');
    }

    const char = this.current();
    if (char === '{') return this.parseObject();
    if (char === '[') return this.parseArray();
    if (char === '"' || char === '\'') return this.parseString();
    return this.parseBareValue();
  }

  private parseObject(): Record<string, unknown> {
    this.consume('{');
    const object: Record<string, unknown> = {};
    this.skipWhitespace();
    if (this.current() === '}') {
      this.offset += 1;
      return object;
    }

    while (true) {
      const key = this.parseObjectKey();
      this.skipWhitespace();
      this.consume(':');
      object[key] = this.parseValue();
      this.skipWhitespace();
      if (this.current() === ',') {
        this.offset += 1;
        this.skipWhitespace();
        if (this.current() === '}') {
          this.offset += 1;
          return object;
        }
        continue;
      }
      if (this.current() === '}') {
        this.offset += 1;
        return object;
      }
      throw new Error(`expected "," or "}" at position ${this.offset}`);
    }
  }

  private parseArray(): unknown[] {
    this.consume('[');
    const array: unknown[] = [];
    this.skipWhitespace();
    if (this.current() === ']') {
      this.offset += 1;
      return array;
    }

    while (true) {
      array.push(this.parseValue());
      this.skipWhitespace();
      if (this.current() === ',') {
        this.offset += 1;
        this.skipWhitespace();
        if (this.current() === ']') {
          this.offset += 1;
          return array;
        }
        continue;
      }
      if (this.current() === ']') {
        this.offset += 1;
        return array;
      }
      throw new Error(`expected "," or "]" at position ${this.offset}`);
    }
  }

  private parseObjectKey(): string {
    this.skipWhitespace();
    const char = this.current();
    if (char === '"' || char === '\'') {
      return this.parseString();
    }

    const start = this.offset;
    while (!this.isDone() && this.current() !== ':') {
      this.offset += 1;
    }
    const key = this.source.slice(start, this.offset).trim();
    if (key.length === 0) {
      throw new Error(`empty object key at position ${start}`);
    }
    if (/[,\[\]{}]/u.test(key)) {
      throw new Error(`invalid unquoted object key ${JSON.stringify(key)} at position ${start}`);
    }
    return key;
  }

  private parseString(): string {
    const quote = this.current();
    this.offset += 1;
    let value = '';
    while (!this.isDone()) {
      const char = this.current();
      this.offset += 1;
      if (char === quote) return value;
      if (char !== '\\') {
        value += char;
        continue;
      }
      if (this.isDone()) {
        throw new Error('unterminated string escape');
      }
      const escaped = this.current();
      this.offset += 1;
      switch (escaped) {
        case '"':
        case '\'':
        case '\\':
        case '/':
          value += escaped;
          break;
        case 'b':
          value += '\b';
          break;
        case 'f':
          value += '\f';
          break;
        case 'n':
          value += '\n';
          break;
        case 'r':
          value += '\r';
          break;
        case 't':
          value += '\t';
          break;
        case 'u': {
          const hex = this.source.slice(this.offset, this.offset + 4);
          if (!/^[0-9a-fA-F]{4}$/u.test(hex)) {
            throw new Error(`invalid unicode escape at position ${this.offset - 2}`);
          }
          value += String.fromCharCode(Number.parseInt(hex, 16));
          this.offset += 4;
          break;
        }
        default:
          value += escaped;
          break;
      }
    }
    throw new Error('unterminated string');
  }

  private parseBareValue(): unknown {
    const start = this.offset;
    while (!this.isDone() && !/[\s,\]}]/u.test(this.current())) {
      this.offset += 1;
    }
    const token = this.source.slice(start, this.offset).trim();
    if (token.length === 0) {
      throw new Error(`expected value at position ${start}`);
    }
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(token)) {
      return Number(token);
    }
    return token;
  }

  private consume(expected: string): void {
    this.skipWhitespace();
    if (this.current() !== expected) {
      throw new Error(`expected ${JSON.stringify(expected)} at position ${this.offset}`);
    }
    this.offset += 1;
  }

  private skipWhitespace(): void {
    while (!this.isDone() && /\s/u.test(this.current())) {
      this.offset += 1;
    }
  }

  private current(): string {
    return this.source[this.offset] ?? '';
  }

  private isDone(): boolean {
    return this.offset >= this.source.length;
  }
}
