import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { loadSpecWithPatterns } from '@simodelne/pgas-server/plugin.js';
import {
  createCollectionLifecycleAllTerminalReaction,
  synthesizeProgramSpecFromDomain,
  type SynthesizedSpec,
} from '../../src/foundry-program/synthesizer.js';

const baseDomain = {
  'program.slug': 'work-unit-flow',
  'program.name': 'Work Unit Flow',
  'program.target_dir': '/tmp/work-unit-flow',
  'program.design_path': 'design',
  'intake.purpose': 'Move generic work units through review until completion.',
  'intake.entry_channel': 'user_text',
  'intake.stages_json': JSON.stringify([
    { slug: 'intake', is_bootstrap: true },
    { slug: 'review_work' },
    { slug: 'complete', is_terminal: true },
  ]),
  'intake.transitions_json': JSON.stringify([
    { from: 'intake', to: 'review_work', trigger: 'started', guard_field: 'intake.started' },
    { from: 'review_work', to: 'complete', trigger: 'done', guard_field: 'review_work.done' },
  ]),
  'intake.delegation_json': JSON.stringify({ enabled: false }),
  'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'review_work.done' }),
};

const genericLifecycle = {
  version: 1,
  name: 'work_units',
  item_label: 'work unit',
  storage: {
    items_path: 'work_units.items_json',
    event_path: 'work_units.pending_event_json',
    violation_path: 'work_units.lifecycle_violation_json',
  },
  item: {
    id_field: 'id',
    status_field: 'status',
    schema: {
      id: 'string',
      title: 'string',
      summary: 'string',
      status: 'string',
    },
  },
  statuses: [
    { name: 'pending', initial: true },
    { name: 'in_review' },
    { name: 'accepted', terminal: true },
    { name: 'removed', terminal: true },
  ],
  transitions: [
    { from: 'pending', to: 'in_review', stage: 'review_work', action: 'start_review', managed_by: 'llm' },
    { from: 'in_review', to: 'accepted', stage: 'review_work', action: 'accept_work_unit', managed_by: 'reaction', trigger: 'user_confirmation' },
    { from: 'accepted', to: 'in_review', stage: 'review_work', action: 'reopen_work_unit', managed_by: 'llm', guard_field: 'review_work.reopen_requested' },
  ],
  aggregate: {
    guard_field: 'work_units.all_terminal',
    terminal_statuses: ['accepted', 'removed'],
    require_non_empty: true,
  },
};

interface ParsedSpec {
  modes: Record<string, { transitions?: Array<{ target: string; guard?: { kind: string; path: string } }> }>;
  schema: Record<string, string>;
  reactions: Record<string, { event: string; watch: string[]; write_scope: string[] }>;
  action_map: Record<string, unknown>;
}

describe('collection_lifecycle descriptor synthesis', () => {
  it('accepts a generic lifecycle descriptor and rejects invalid descriptors', () => {
    expect(() => synthesizeProgramSpecFromDomain(domainWithLifecycle(genericLifecycle))).not.toThrow();

    const invalidCases: Array<[string, (descriptor: typeof genericLifecycle) => void, RegExp]> = [
      ['no statuses', (descriptor) => { descriptor.statuses = []; }, /statuses/u],
      ['no initial status', (descriptor) => { descriptor.statuses = descriptor.statuses.map(({ initial: _initial, ...status }) => status); }, /initial/u],
      ['unknown from status', (descriptor) => { descriptor.transitions[0] = { ...descriptor.transitions[0], from: 'unknown' }; }, /unknown.*from/u],
      ['unknown to status', (descriptor) => { descriptor.transitions[0] = { ...descriptor.transitions[0], to: 'unknown' }; }, /unknown.*to/u],
      ['duplicate action names', (descriptor) => { descriptor.transitions[1] = { ...descriptor.transitions[1], action: 'start_review' }; }, /duplicate.*action/u],
      ['terminal status outside statuses', (descriptor) => { descriptor.aggregate.terminal_statuses = ['accepted', 'archived']; }, /terminal_statuses/u],
      ['missing aggregate guard field', (descriptor) => { descriptor.aggregate.guard_field = ''; }, /aggregate\.guard_field/u],
    ];

    for (const [label, mutate, message] of invalidCases) {
      const descriptor = clone(genericLifecycle);
      mutate(descriptor);
      expect(
        () => synthesizeProgramSpecFromDomain(domainWithLifecycle(descriptor)),
        label,
      ).toThrow(message);
    }
  });

  it('emits lifecycle state paths, aggregate reaction, and completion guard wiring', () => {
    const artifact = synthesizeProgramSpecFromDomain(domainWithLifecycle(genericLifecycle));
    const parsed = load(artifact.spec_yaml) as ParsedSpec;

    expect(parsed.schema).toMatchObject({
      'work_units.items_json': 'string',
      'work_units.pending_event_json': 'string',
      'work_units.lifecycle_violation_json': 'string',
      'work_units.all_terminal': 'boolean',
    });
    expect(parsed.reactions.compute_work_units_all_terminal).toEqual({
      event: 'AfterMutation',
      watch: ['work_units.items_json'],
      write_scope: ['work_units.all_terminal'],
    });
    expect(parsed.modes.review_work.transitions).toEqual([
      { target: 'complete', guard: { kind: 'FieldTruthy', path: 'work_units.all_terminal' } },
    ]);
    expect(parsed.action_map).not.toHaveProperty('start_review');
    expect(parsed.action_map).not.toHaveProperty('accept_work_unit');
    expect(parsed.action_map).not.toHaveProperty('reopen_work_unit');
    expect(artifact.handlers_ts).toContain("['compute_work_units_all_terminal', (snapshot, trigger, mode) =>");
    expect(artifact.handlers_ts).toContain("'work_units.items_json'");
    expect(artifact.handlers_ts).toContain("'work_units.all_terminal'");
    expect(artifact.handlers_ts).toContain("return { mutations: [{ op: 'MSet' as const, path: 'work_units.all_terminal', value: allTerminal }] };");
    expect(() => loadSpecWithPatterns(writeTempSpec(artifact.spec_yaml))).not.toThrow();
  });

  it('sets the aggregate guard true only for non-empty all-terminal collections', () => {
    const reaction = createCollectionLifecycleAllTerminalReaction(genericLifecycle);

    expect(runAllTerminalReaction(reaction, [
      { id: 'wu-1', status: 'accepted' },
      { id: 'wu-2', status: 'removed' },
    ])).toBe(true);
    expect(runAllTerminalReaction(reaction, [])).toBe(false);
    expect(runAllTerminalReaction(reaction, [
      { id: 'wu-1', status: 'accepted' },
      { id: 'wu-2', status: 'pending' },
    ])).toBe(false);
    expect(runAllTerminalReaction(reaction, { id: 'not-an-array', status: 'accepted' })).toBe(false);
    expect(runAllTerminalReaction(reaction, '[not json')).toBe(false);
  });

  it('keeps no-descriptor synthesis byte-identical to the pre-lifecycle baseline', () => {
    expect(hashArtifact(synthesizeProgramSpecFromDomain(baseDomain))).toEqual({
      spec_yaml: '9dcfe499925d995bc46442ba71b847b271380bc01e6cfd78f48f643fc8f09a9a',
      contracts_ts: '9cf1c34fb09d664aef1bbb2b9cf31cb54a6e2943c81007cd561d0975dd2d43af',
      handlers_ts: '487b83115c463a60c3c53d3ccb21350e05a4f4d29a39d9f03ad77e804e56d04d',
      handlers_index_ts: '3fb01bfefde1d5a455f7ff53fbf48333c0e36dc9b49f7e82e6a3e5e56f342531',
      tools_ts: '33ddf30cb9b4787506ba6e9b332fb570e3dfa185470c000dbd429083e0630e7d',
      smoke_test_ts: 'cfb74d966744cd252918dd8820602ce9b762ea406a7cd39c26ff4e4edc821a92',
    });
  });
});

function domainWithLifecycle(lifecycle: unknown): Record<string, unknown> {
  return {
    ...baseDomain,
    'intake.completion_json': JSON.stringify({
      final_stage: 'complete',
      guard_field: 'review_work.done',
      collection_lifecycle: lifecycle,
    }),
  };
}

function runAllTerminalReaction(
  reaction: ReturnType<typeof createCollectionLifecycleAllTerminalReaction>,
  items: unknown,
): unknown {
  const stored = typeof items === 'string' ? items : JSON.stringify(items);
  const result = reaction(new Map([['work_units.items_json', stored]]), 'AfterMutation', 'review_work');
  return result?.mutations?.find((mutation) => mutation.path === 'work_units.all_terminal')?.value;
}

function hashArtifact(artifact: SynthesizedSpec): Record<string, string> {
  return Object.fromEntries(
    (['spec_yaml', 'contracts_ts', 'handlers_ts', 'handlers_index_ts', 'tools_ts', 'smoke_test_ts'] as const)
      .map((key) => [key, createHash('sha256').update(artifact[key]).digest('hex')]),
  );
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function writeTempSpec(specYaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pgas-new-lifecycle-load-'));
  const specPath = join(dir, 'specs.yml');
  writeFileSync(specPath, specYaml);
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return specPath;
}
