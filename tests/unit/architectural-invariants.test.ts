import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  PGAS_SERVER_RUNTIME_IMPORTS,
  isBannedImport,
} from '../../src/pgas-new/version.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SPEC_PATH = resolve(ROOT, 'src/foundry-program/specs.yml');
const CLI_PATH = resolve(ROOT, 'src/cli.ts');
const SYNTHESIZER_PATH = resolve(ROOT, 'src/foundry-program/synthesizer.ts');

const REQUIRED_MODES = [
  'intake_intelligence',
  'repo_targeting',
  'architecture_design',
  'scaffold_plan',
  'branch_write',
  'static_verify',
  'live_verify',
  'rebase_verify',
  'pr_graduation',
  'curator_request',
] as const;

const REMOVED_CONSUMER_TEMPLATE_FLAGS = [
  'policy-drafting',
  'web-scraper',
  'social-media-agent',
] as const;

const REQUIRED_BOOTSTRAP_SUBCOMMANDS = [
  'init',
  'login',
  'logout',
  'version',
  'session',
] as const;

const REQUIRED_RUNTIME_IMPORTS = [
  '@simodelne/pgas-server/plugin.js',
  '@simodelne/pgas-server/create-server.js',
  '@simodelne/pgas-server/client.js',
  '@simodelne/pgas-server/channels/index.js',
  '@simodelne/pgas-server/routes/index.js',
] as const;

const REQUIRED_INTAKE_GATE_ACTIONS = [
  'record_program_target',
  'choose_design_path',
  'apply_default_skeleton',
  'record_q1_purpose',
  'record_q2_entry_channel',
  'record_q3_stages',
  'record_q4_transitions',
  'record_q5_delegation',
  'record_q6_completion',
  'record_program_intake_finalize',
  'confirm_design',
  'reject_design_and_revise_q1',
  'reject_design_and_revise_q2',
  'reject_design_and_revise_q3',
  'reject_design_and_revise_q4',
  'reject_design_and_revise_q5',
  'reject_design_and_revise_q6',
] as const;

interface FoundrySpec {
  modes: Record<string, { vocabulary?: unknown }>;
}

let spec: FoundrySpec;
let cliSource: string;
let synthesizerSource: string;

beforeAll(() => {
  spec = load(readFileSync(SPEC_PATH, 'utf8')) as FoundrySpec;
  cliSource = readFileSync(CLI_PATH, 'utf8');
  synthesizerSource = readFileSync(SYNTHESIZER_PATH, 'utf8');
});

describe('foundry PGAS spec mode contract', () => {
  it('declares exactly the 10 CLAUDE.md Program Nature modes', () => {
    const modes = Object.keys(spec.modes);

    expect(
      modes,
      "If this fails: src/foundry-program/specs.yml:27 `modes:` no longer matches CLAUDE.md's Program Nature 10-mode contract.",
    ).toEqual(REQUIRED_MODES);
  });
});

describe('consumer-preset CLI flag removal', () => {
  it('does not expose removed consumer presets as CLI flag values', () => {
    for (const flag of REMOVED_CONSUMER_TEMPLATE_FLAGS) {
      expect(
        cliSource,
        `If this fails: src/cli.ts:720-751 reintroduced removed consumer preset flag value ${flag}.`,
      ).not.toContain(flag);
    }
  });
});

describe('foundry-bootstrap CLI surface', () => {
  it('declares the required bootstrap and session subcommands', () => {
    const subcommands = parseKnownSubcommands(cliSource);

    expect(
      subcommands,
      'If this fails: src/cli.ts:70 KNOWN_SUBCOMMANDS lost a documented foundry bootstrap/session subcommand.',
    ).toEqual(expect.arrayContaining([...REQUIRED_BOOTSTRAP_SUBCOMMANDS]));
  });
});

describe('PGAS server import boundary', () => {
  it('lists only documented runtime public subpaths', () => {
    expect(
      [...PGAS_SERVER_RUNTIME_IMPORTS],
      'If this fails: src/pgas-new/version.ts:5 PGAS_SERVER_RUNTIME_IMPORTS drifted from the documented public runtime surface.',
    ).toEqual([...REQUIRED_RUNTIME_IMPORTS]);
  });

  it('bans private pgas-server api imports', () => {
    expect(
      isBannedImport('@simodelne/pgas-server/api/sessions.js'),
      'If this fails: src/pgas-new/version.ts:26 BANNED_IMPORT_PATTERNS no longer rejects private pgas-server api imports.',
    ).toBe(true);
  });
});

describe('intake_intelligence gate-action vocabulary', () => {
  it('contains the target/design/default/finalize/confirm and Q1-Q6 revision actions', () => {
    const vocabulary = spec.modes.intake_intelligence?.vocabulary;

    expect(
      vocabulary,
      'If this fails: src/foundry-program/specs.yml:28 intake_intelligence vocabulary is no longer an array.',
    ).toEqual(expect.any(Array));
    expect(
      vocabulary as string[],
      'If this fails: src/foundry-program/specs.yml:29 intake_intelligence vocabulary lost a required design gate action.',
    ).toEqual(expect.arrayContaining([...REQUIRED_INTAKE_GATE_ACTIONS]));
  });
});

describe('deterministic synthesizer action topology', () => {
  it('does not emit a shared example_action for synthesized programs', () => {
    expect(
      synthesizerSource,
      'If this fails: src/foundry-program/synthesizer.ts reintroduced a shared synthesized example_action.',
    ).not.toContain('example_action');
  });
});

function parseKnownSubcommands(source: string): string[] {
  const sourceFile = ts.createSourceFile(CLI_PATH, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'KNOWN_SUBCOMMANDS' &&
      node.initializer &&
      ts.isNewExpression(node.initializer)
    ) {
      const [firstArg] = node.initializer.arguments ?? [];
      if (firstArg && ts.isArrayLiteralExpression(firstArg)) {
        for (const element of firstArg.elements) {
          if (ts.isStringLiteral(element)) {
            found.push(element.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}
