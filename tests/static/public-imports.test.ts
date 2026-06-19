import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  isAllowedPgasServerImport,
  isAllowedPgasServerTestImport,
  isBannedImport,
} from '../../src/pgas-new/version.js';
import { renderStandaloneScaffold } from '../../src/pgas-new/template-renderer.js';

describe('generated public PGAS imports', () => {
  it('uses only approved pgas-server public imports in generated TypeScript', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pgas-new-public-imports-'));
    try {
      renderStandaloneScaffold({ outDir, slug: 'pgas-new', name: 'PGAS New' });

      const violations: string[] = [];
      for (const file of tsFiles(outDir)) {
        const body = readFileSync(file, 'utf8');
        const relativePath = relative(outDir, file);
        for (const specifier of importSpecifiers(body)) {
          if (isBannedImport(specifier)) {
            violations.push(`${relativePath} imports banned ${specifier}`);
          } else if (
            specifier.startsWith('@simodelne/pgas-server') &&
            !isAllowedPgasServerImport(specifier) &&
            !(relativePath.startsWith('tests/') && isAllowedPgasServerTestImport(specifier))
          ) {
            violations.push(`${relativePath} imports non-approved ${specifier}`);
          }
        }
      }

      expect(violations).toEqual([]);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('detects side-effect, dynamic, require, and export module specifiers', () => {
    expect(
      importSpecifiers(`
        import '@simodelne/pgas-server/testing.js';
        const client = await import('@simodelne/pgas-server/client.js');
        const routes = require('@simodelne/pgas-server/routes/index.js');
        export { x } from '@simodelne/pgas-server/plugin.js';
      `),
    ).toEqual([
      '@simodelne/pgas-server/testing.js',
      '@simodelne/pgas-server/client.js',
      '@simodelne/pgas-server/routes/index.js',
      '@simodelne/pgas-server/plugin.js',
    ]);
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
  const sourceFile = ts.createSourceFile('generated.ts', body, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }

    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      specifiers.push(node.arguments[0].text);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
}
