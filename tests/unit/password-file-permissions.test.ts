import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readPasswordFile } from '../../src/cli.js';

describe('readPasswordFile permission check', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pgas-pwfile-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the contents of an owner-only (0600) file', () => {
    const path = join(dir, 'pw');
    writeFileSync(path, 'sup3rs3cret\n', { mode: 0o600 });
    chmodSync(path, 0o600);
    expect(readPasswordFile(path)).toBe('sup3rs3cret');
  });

  it('throws for a group/world-readable (0644) file', () => {
    const path = join(dir, 'pw');
    writeFileSync(path, 'sup3rs3cret\n', { mode: 0o600 });
    chmodSync(path, 0o644);
    expect(() => readPasswordFile(path)).toThrow(/group- or world-accessible/u);
    expect(() => readPasswordFile(path)).toThrow(/chmod 600/u);
  });

  it('throws for a group-writable-only (0620) file', () => {
    const path = join(dir, 'pw');
    writeFileSync(path, 'sup3rs3cret\n', { mode: 0o600 });
    chmodSync(path, 0o620);
    expect(() => readPasswordFile(path)).toThrow(/group- or world-accessible/u);
  });
});
