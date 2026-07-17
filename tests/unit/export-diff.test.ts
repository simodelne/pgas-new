import { readFileSync } from 'node:fs';
import { Script, createContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

type DiffToken = { op: 'eq' | 'ins' | 'del'; text: string };

describe('export diffTokens template', () => {
  it('is byte-stable and returns the expected word-level eq/ins/del sequence', () => {
    const diffTokens = loadTemplateDiffTokens();
    const original = 'alpha beta gamma';
    const accepted = 'alpha delta gamma omega';

    const first = diffTokens(original, accepted);
    const second = diffTokens(original, accepted);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toEqual<DiffToken[]>([
      { op: 'eq', text: 'alpha' },
      { op: 'del', text: 'beta' },
      { op: 'ins', text: 'delta' },
      { op: 'eq', text: 'gamma' },
      { op: 'ins', text: 'omega' },
    ]);
  });
});

function loadTemplateDiffTokens(): (original: string, accepted: string) => DiffToken[] {
  const templatePath = fileURLToPath(new URL('../../templates/pgas-new/consumer/export-diff.ts.tmpl', import.meta.url));
  const source = readFileSync(templatePath, 'utf8');
  expect(source).not.toContain('Date');
  expect(source).not.toContain('Math.random');
  expect(source).not.toContain('import ');

  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
  });
  const exportsObject: Record<string, unknown> = {};
  const moduleObject = { exports: exportsObject };
  const context = createContext({ exports: exportsObject, module: moduleObject });
  new Script(transpiled.outputText, { filename: 'export-diff.template.cjs' }).runInContext(context);
  const exported = moduleObject.exports as Record<string, unknown>;
  const candidate = exported.diffTokens ?? exportsObject.diffTokens;
  if (typeof candidate !== 'function') {
    throw new Error('export-diff template did not export diffTokens');
  }
  return candidate as (original: string, accepted: string) => DiffToken[];
}
