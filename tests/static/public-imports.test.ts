import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAllowedPgasServerImport, isBannedImport } from '../../src/pgas-new/version.js';
import { renderStandaloneScaffold } from '../../src/pgas-new/template-renderer.js';

describe('generated public PGAS imports', () => {
  it('uses only approved pgas-server public imports in generated TypeScript', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pgas-new-public-imports-'));
    try {
      renderStandaloneScaffold({ outDir, slug: 'pgas-new', name: 'PGAS New' });

      const violations: string[] = [];
      for (const file of tsFiles(outDir)) {
        const body = readFileSync(file, 'utf8');
        for (const specifier of importSpecifiers(body)) {
          if (isBannedImport(specifier)) {
            violations.push(`${relative(outDir, file)} imports banned ${specifier}`);
          } else if (specifier.startsWith('@simodelne/pgas-server') && !isAllowedPgasServerImport(specifier)) {
            violations.push(`${relative(outDir, file)} imports non-approved ${specifier}`);
          }
        }
      }

      expect(violations).toEqual([]);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

function tsFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...tsFiles(path));
    } else if (path.endsWith('.ts')) {
      files.push(path);
    }
  }

  return files;
}

function importSpecifiers(body: string): string[] {
  return [...body.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
}
