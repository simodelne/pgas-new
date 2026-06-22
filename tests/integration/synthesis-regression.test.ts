import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { loadSpecWithPatterns } from '@simodelne/pgas-server/plugin.js';
import { handlers } from '../../src/foundry-program/handlers.js';
import {
  clearSynthesizedArtifact,
  getSynthesizedArtifact,
} from '../../src/foundry-program/synthesizer-store.js';

// The frozen v1 specs at docs/graduation-evidence/<name>/specs.yml.frozen
// were produced by the legacy v1 template path which predates the FM1-FM5
// closure invariants this repo enforces from v3. They are kept ONLY as
// intake-shape fixtures (stage count, stage names, transitions). The v3
// synthesizer's output is the canonical FM-compliant artifact; the v1 frozen
// specs are not.

const GRADUATION_MANDATES = [
  'docs/graduation-evidence/policy-drafting/MANDATE.md',
  'docs/graduation-evidence/social-media-agent/MANDATE.md',
  'docs/graduation-evidence/web-scraper/MANDATE.md',
] as const;

const ENGINE_OWNED_SCHEMA_PATHS = [
  'inputs.query_result.kind',
  'inputs.query_result.value_json',
  'inputs.query_meta.source_path',
  'inputs.query_meta.source_channel',
  'inputs.query_meta.continuation_round',
  'inputs.query_meta.scope_redirect',
  'inputs.query_meta.message',
  'inputs.mode_entry.mode',
  'inputs.mode_entry.from_mode',
  'inputs.mode_entry.entry_round',
  'governance.round_counter',
] as const;

const RESERVED_FOUNDRY_MODE_NAMES = [
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

interface MandateIntake {
  name: string;
  purpose: string;
  entryChannel: string;
  stages: Stage[];
  transitions: IntakeTransition[];
  delegation: Record<string, unknown>;
  completion: Completion;
}

interface Stage {
  slug: string;
  is_bootstrap?: boolean;
  is_terminal?: boolean;
}

interface IntakeTransition {
  from: string;
  to: string;
  trigger: string;
  guard_field: string;
  guard_value: boolean | string;
}

interface Completion {
  final_stage: string;
  guard_field: string;
}

interface SynthesizedSpec {
  modes: Record<string, {
    channels?: string[];
    transitions?: Array<{ target: string; guard?: { path?: string } }>;
    vocabulary?: string[];
  }>;
  schema: Record<string, string>;
  action_map: Record<string, { channel?: string; mutations?: Array<{ path?: string }> }>;
  features?: string[];
  control_plane?: unknown;
}

interface SynthesizedFixture {
  intake: MandateIntake;
  specYaml: string;
  spec: SynthesizedSpec;
}

for (const mandatePath of GRADUATION_MANDATES) {
  const intake = parseMandate(mandatePath);

  describe(`synthesis regression: ${intake.name}`, () => {
    it('reproduces the mandate-declared mode topology', async () => {
      const fixture = await synthesizeFixture(intake);

      expect(Object.keys(fixture.spec.modes)).toEqual(intake.stages.map((stage) => stage.slug));
      expect(Object.keys(fixture.spec.modes)).toHaveLength(intake.stages.length);
      expect(extractTransitions(fixture.spec)).toEqual(
        intake.transitions.map((transition) => ({
          from: transition.from,
          to: transition.to,
          guard_path: transition.guard_field,
        })),
      );
    });

    it('loads the synthesized YAML through the PGAS engine loader', async () => {
      const fixture = await synthesizeFixture(intake);

      expect(() => loadSpecWithPatterns(writeTempSpec(fixture.specYaml))).not.toThrow();
    });

    it('satisfies FM1-FM5 closure on the synthesized YAML only', async () => {
      const fixture = await synthesizeFixture(intake);

      assertFmClosure(fixture.spec);
    });

    it('does not leak reserved foundry mode names into synthesized output', async () => {
      const fixture = await synthesizeFixture(intake);
      const modeNames = Object.keys(fixture.spec.modes);

      for (const modeName of RESERVED_FOUNDRY_MODE_NAMES) {
        expect(modeNames, `${modeName} should not be synthesized`).not.toContain(modeName);
      }
    });
  });
}

const fixtureCache = new Map<string, Promise<SynthesizedFixture>>();

function synthesizeFixture(intake: MandateIntake): Promise<SynthesizedFixture> {
  const cached = fixtureCache.get(intake.name);
  if (cached) return cached;

  const promise = (async () => {
    const sessionId = `synthesis-regression-${intake.name}`;
    clearSynthesizedArtifact(sessionId);

    await handlers.synthesize_program_spec({
      sessionId,
      domain: {
        'program.slug': intake.name,
        'program.name': titleCase(intake.name),
        'program.target_dir': join(tmpdir(), `pgas-new-regression-${intake.name}`),
        'program.design_path': 'design',
        'intake.purpose': intake.purpose,
        'intake.entry_channel': intake.entryChannel,
        'intake.stages_json': JSON.stringify(intake.stages),
        'intake.transitions_json': JSON.stringify(intake.transitions),
        'intake.delegation_json': JSON.stringify(intake.delegation),
        'intake.completion_json': JSON.stringify(intake.completion),
      },
    });

    const artifact = getSynthesizedArtifact(sessionId);
    if (!artifact) {
      throw new Error(`missing synthesized artifact for ${intake.name}`);
    }

    return {
      intake,
      specYaml: artifact.spec_yaml,
      spec: load(artifact.spec_yaml) as SynthesizedSpec,
    };
  })();

  fixtureCache.set(intake.name, promise);
  return promise;
}

function parseMandate(path: string): MandateIntake {
  const text = readFileSync(path, 'utf8');
  const name = basename(dirname(path));
  const purpose = section(text, 'Q1 Purpose').trim().replace(/\s+/gu, ' ');
  const entryChannel = section(text, 'Q2 Entry channel').trim();
  const completionSection = section(text, 'Q6 Completion criteria');
  const finalStage = requiredMatch(completionSection, /Terminal mode:\s*([a-zA-Z0-9_-]+)/u, 'completion terminal');
  const completionGuard = requiredMatch(completionSection, /Guard:\s*([a-zA-Z0-9_.-]+)\s*=/u, 'completion guard');

  const completion = {
    final_stage: slugNorm(finalStage),
    guard_field: completionGuard,
  };
  const stages = section(text, 'Q3 Stages')
    .split(/\r?\n/u)
    .map((line) => line.match(/^\s*\d+\.\s+(.+?)\s+(?:—|-)\s+.+$/u))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match, index) => {
      const slug = slugNorm(match[1] ?? '');
      return {
        slug,
        ...(index === 0 ? { is_bootstrap: true } : {}),
        ...(slug === completion.final_stage ? { is_terminal: true } : {}),
      };
    });

  const transitions = section(text, 'Q4 Decision points')
    .split(/\r?\n/u)
    .map((line) => line.match(/^\s*-\s+(.+?)\s+(?:→|->)\s+(.+?)\s+when\s+([a-zA-Z0-9_.-]+)\s*=\s*(.+?)\s*$/u))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => {
      const guardValue = parseGuardValue(match[4] ?? '');
      return {
        from: slugNorm(match[1] ?? ''),
        to: slugNorm(match[2] ?? ''),
        trigger: `${slugNorm(match[3] ?? 'ready')}_${String(guardValue)}`,
        guard_field: match[3] ?? '',
        guard_value: guardValue,
      };
    });

  return {
    name,
    purpose,
    entryChannel,
    stages,
    transitions,
    delegation: parseDelegation(section(text, 'Q5 Delegation')),
    completion,
  };
}

function section(text: string, heading: string): string {
  const marker = `## ${heading}`;
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`missing mandate section: ${heading}`);
  }
  const bodyStart = text.indexOf('\n', markerIndex);
  if (bodyStart < 0) return '';
  const rest = text.slice(bodyStart + 1);
  const nextHeadingIndex = rest.search(/^## /mu);
  return nextHeadingIndex >= 0 ? rest.slice(0, nextHeadingIndex) : rest;
}

function requiredMatch(text: string, pattern: RegExp, label: string): string {
  const match = text.match(pattern);
  if (!match?.[1]) {
    throw new Error(`missing ${label}`);
  }
  return match[1];
}

function parseDelegation(value: string): Record<string, unknown> {
  const normalized = value.trim().toLowerCase();
  return normalized === 'none' ? {} : { mandate: value.trim() };
}

function parseGuardValue(value: string): boolean | string {
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return trimmed.replace(/^['"]|['"]$/gu, '');
}

function extractTransitions(spec: SynthesizedSpec): Array<{ from: string; to: string; guard_path: string | undefined }> {
  return Object.entries(spec.modes).flatMap(([from, mode]) => (mode.transitions ?? []).map((transition) => ({
    from,
    to: transition.target,
    guard_path: transition.guard?.path,
  })));
}

function assertFmClosure(spec: SynthesizedSpec): void {
  const schemaPaths = Object.keys(spec.schema);

  expect(spec.features, 'FM2 runtime_control feature should be declared').toContain('runtime_control');
  expect(spec.control_plane, 'FM2 control plane should be declared').toBeDefined();

  const firstMode = Object.keys(spec.modes)[0];
  for (const [modeName, mode] of Object.entries(spec.modes)) {
    if (modeName === firstMode) continue;
    expect(mode.channels ?? [], `FM3 ${modeName} should not consume system_mode_entry`).not.toContain('system_mode_entry');
  }

  for (const [modeName, mode] of Object.entries(spec.modes)) {
    for (const action of mode.vocabulary ?? []) {
      expect(spec.action_map[action], `FM4 ${modeName}.${action} should have an action_map entry`).toBeDefined();
    }
  }

  for (const [action, mapping] of Object.entries(spec.action_map)) {
    expect(mapping.channel, `FM4 ${action} should declare widget_output channel`).toBe('widget_output');
    for (const mutation of mapping.mutations ?? []) {
      if (!mutation.path) continue;
      expect(isSchemaDeclared(mutation.path, schemaPaths), `FM1 ${action} mutation path ${mutation.path} should be schema-declared`).toBe(true);
    }
  }

  for (const path of ENGINE_OWNED_SCHEMA_PATHS) {
    expect(spec.schema[path], `FM5 ${path} should be declared`).toBeDefined();
  }
}

function isSchemaDeclared(path: string, schemaPaths: string[]): boolean {
  return schemaPaths.some((schemaPath) => {
    const actualParts = path.split('.');
    const schemaParts = schemaPath.split('.');
    return actualParts.length === schemaParts.length && schemaParts.every((part, index) => part === '*' || part === actualParts[index]);
  });
}

function writeTempSpec(specYaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pgas-new-synthesis-regression-'));
  const specPath = join(dir, 'specs.yml');
  writeFileSync(specPath, specYaml);
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return specPath;
}

function slugNorm(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '');
}

function titleCase(slug: string): string {
  return slug.split('-').map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(' ');
}
