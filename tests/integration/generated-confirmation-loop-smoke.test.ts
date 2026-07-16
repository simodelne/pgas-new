import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';
import type { SynthesizedArtifact } from '../../src/foundry-program/synthesizer-store.js';
import { renderStandaloneScaffold } from '../../src/pgas-new/template-renderer.js';

const confirmationLifecycle = {
  version: 1,
  name: 'work_units',
  item_label: 'work unit',
  storage: {
    items_path: 'work_units.items',
    event_path: 'work_units.pending_event_json',
    violation_path: 'work_units.lifecycle_violation_json',
    representation: 'indexed_array',
  },
  item: {
    id_field: 'id',
    status_field: 'status',
    schema: {
      id: 'string',
      title: 'string',
      proposed_text: 'string',
      user_instruction: 'string',
    },
  },
  statuses: [
    { name: 'pending', initial: true },
    { name: 'proposed' },
    { name: 'accepted', terminal: true },
    { name: 'skipped', terminal: true },
  ],
  transitions: [],
  aggregate: {
    guard_field: 'work_units.all_terminal',
    terminal_statuses: ['accepted', 'skipped'],
    require_non_empty: true,
  },
};

const confirmationLoop = {
  collection: 'work_units.items',
  proposed_status: 'proposed',
  seed: { source_stage: 'plan_work', id_prefix: 'unit' },
  decisions: {
    approve: { to: 'accepted' },
    revise: {
      to: 'proposed',
      requires_instruction: true,
      instruction_path: 'work_units.items.*.user_instruction',
      re_propose: true,
    },
    skip: { to: 'skipped' },
  },
  one_proposed_at_a_time: true,
  aggregate: {
    guard_field: 'work_units.all_terminal',
    terminal_statuses: ['accepted', 'skipped'],
  },
  stage: 'review_work',
  summary_path: 'summary.confirmation_loop',
  violation_path: 'work_units.confirmation_violation_json',
  pending_action_path: 'decisions.pending_review_work_action',
};

const confirmationLoopDomain = {
  'program.slug': 'work-unit-flow-hermetic',
  'program.name': 'Work Unit Flow Hermetic',
  'program.target_dir': '/tmp/work-unit-flow-hermetic',
  'program.design_path': 'design',
  'intake.purpose': 'Plan two work units, then review each one at a time with explicit user confirmation before completion.',
  'intake.entry_channel': 'user_text',
  'intake.stages_json': JSON.stringify([
    { slug: 'intake', is_bootstrap: true },
    { slug: 'plan_work' },
    { slug: 'review_work' },
    { slug: 'complete', is_terminal: true },
  ]),
  'intake.transitions_json': JSON.stringify([
    { from: 'intake', to: 'plan_work', trigger: 'started', guard_field: 'intake.started' },
    { from: 'plan_work', to: 'review_work', trigger: 'planned', guard_field: 'plan_work.done' },
    { from: 'review_work', to: 'complete', trigger: 'done', guard_field: 'work_units.all_terminal' },
  ]),
  'intake.delegation_json': JSON.stringify({
    plan_work: { kind: 'llm-reasoning' },
  }),
  'intake.completion_json': JSON.stringify({
    final_stage: 'complete',
    guard_field: 'work_units.all_terminal',
    collection_lifecycle: confirmationLifecycle,
  }),
  'intake.interaction_json': JSON.stringify({ confirmation_loops: [confirmationLoop] }),
};

describe('generated confirmation-loop smoke test', () => {
  it('boots the rebuilt generated program and reaches complete hermetically', { timeout: 120_000 }, () => {
    const artifact = artifactFromDomain(confirmationLoopDomain);
    const targetDir = mkdtempSync(join(tmpdir(), 'pgas-new-confirmation-loop-render-'));

    try {
      renderStandaloneScaffold({
        slug: 'work-unit-flow-hermetic',
        name: 'Work Unit Flow Hermetic',
        outDir: targetDir,
        synthesizedSpecYaml: artifact.spec_yaml,
        synthesizedContractsTs: artifact.contracts_ts,
        synthesizedHandlersTs: artifact.handlers_ts,
        synthesizedHandlersIndexTs: artifact.handlers_index_ts,
        synthesizedStageSources: artifact.stage_sources,
        synthesizedToolsTs: artifact.tools_ts,
        synthesizedSmokeTestTs: artifact.smoke_test_ts,
      });
      linkRootNodeModules(targetDir);

      expect(artifact.smoke_test_ts).toContain('runs the confirmation loop choreography hermetically');
      expect(artifact.smoke_test_ts).toContain("await harness.trigger({ channel: 'user_confirmation'");
      expect(artifact.smoke_test_ts).toContain("expect(snapshot.mode).toBe('complete')");

      const output = runGeneratedSmokeTest(targetDir);
      expect(output).toContain('1 passed');
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});

function artifactFromDomain(domain: Record<string, unknown>): SynthesizedArtifact {
  return {
    ...synthesizeProgramSpecFromDomain(domain),
    created_at: '2026-07-16T00:00:00.000Z',
  };
}

function linkRootNodeModules(targetDir: string): void {
  const rootNodeModules = join(process.cwd(), 'node_modules');
  if (!existsSync(rootNodeModules)) {
    return;
  }
  symlinkSync(rootNodeModules, join(targetDir, 'node_modules'), 'dir');
}

function runGeneratedSmokeTest(targetDir: string): string {
  const vitestBin = join(process.cwd(), 'node_modules/vitest/vitest.mjs');
  return execFileSync(process.execPath, [vitestBin, 'run', '--pool=threads', 'tests/generated-program-smoke.test.ts'], {
    cwd: targetDir,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', RAYON_NUM_THREADS: '1' },
  });
}
