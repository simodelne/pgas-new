import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { beforeAll, describe, expect, it } from 'vitest';

// Regression lock for pgas-new#81 — "scaffold approval native tool call falls
// back despite passing gates". Root cause: on the post-plan_artifacts
// system_mode_entry auto-continuation the model called approve_artifact_plan,
// which (approve requires TriggerType user_confirmation) collapsed to
// __fallback__ pre-gate; the premature attempt then left the REAL user_confirmation
// approve unable to commit, stranding the session in scaffold_plan/draft.
//
// ORIGINAL fix: a synthetic no-write await_artifact_plan_approval action absorbed
// the premature system_mode_entry re-entry. That mechanism was MIGRATED to the
// engine-native `awaits_user_decision` (pgas#641): plan_artifacts now declares
// `awaits_user_decision: { channel: user_confirmation }`, so the runtime parks
// automation for explicit user approval (suppresses auto-continue) — no
// hand-rolled wait action / awaiting flag. This lock now asserts the engine-native
// wiring AND the still-load-bearing invariant that approve_artifact_plan can only
// fire on user_confirmation (the actual #81 root cause).

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SPEC_PATH = resolve(ROOT, 'src/foundry-program/specs.yml');

interface Precondition {
  kind: string;
  path?: string;
  value?: unknown;
  triggerSet?: string[];
}

interface ActionEntry {
  mutations?: Array<{ op: string; path: string; value?: unknown }>;
  channel?: string;
  awaits_user_decision?: { channel: string; intent?: string };
}

interface FoundrySpec {
  modes: Record<string, {
    vocabulary?: string[];
    preconditions?: Record<string, Precondition[]>;
  }>;
  proceed_to?: Record<string, string>;
  action_map?: Record<string, ActionEntry>;
  schema?: Record<string, string>;
}

let spec: FoundrySpec;

beforeAll(() => {
  spec = load(readFileSync(SPEC_PATH, 'utf8')) as FoundrySpec;
});

describe('#81 scaffold_plan approval gating (awaits_user_decision regression lock)', () => {
  it('scaffold_plan vocabulary declares plan_artifacts and approve_artifact_plan', () => {
    const vocabulary = spec.modes.scaffold_plan?.vocabulary;
    expect(vocabulary, 'scaffold_plan.vocabulary is no longer an array.').toEqual(expect.any(Array));
    expect(
      vocabulary as string[],
      'If this fails: scaffold_plan vocabulary dropped plan_artifacts or approve_artifact_plan (reopens #81).',
    ).toEqual(expect.arrayContaining(['plan_artifacts', 'approve_artifact_plan']));
  });

  it('plan_artifacts declares awaits_user_decision on user_confirmation — the engine-native #81 approval park', () => {
    const entry = spec.action_map?.plan_artifacts;
    expect(entry, 'action_map.plan_artifacts is missing.').toBeDefined();
    expect(
      entry?.awaits_user_decision?.channel,
      'If this fails: plan_artifacts lost awaits_user_decision on user_confirmation — the engine no longer parks for user approval and #81 (premature auto-approval) reopens.',
    ).toBe('user_confirmation');
  });

  it('the synthetic await_artifact_plan_approval mechanism is fully removed (migrated to awaits_user_decision)', () => {
    expect(
      spec.modes.scaffold_plan?.vocabulary?.includes('await_artifact_plan_approval'),
      'await_artifact_plan_approval should no longer be in the vocabulary (migrated).',
    ).toBe(false);
    expect(spec.action_map?.await_artifact_plan_approval, 'await_artifact_plan_approval action_map entry should be gone.').toBeUndefined();
    expect(spec.modes.scaffold_plan?.preconditions?.await_artifact_plan_approval, 'await_artifact_plan_approval preconditions should be gone.').toBeUndefined();
    expect(spec.schema?.['artifact_plan.awaiting_user_approval'], 'artifact_plan.awaiting_user_approval schema path should be removed.').toBeUndefined();
  });

  it('approve_artifact_plan stays gated to user_confirmation so it cannot fire on a premature system_mode_entry (#81 root cause — LOAD-BEARING)', () => {
    const preconditions = spec.modes.scaffold_plan?.preconditions?.approve_artifact_plan;
    expect(preconditions, 'approve_artifact_plan precondition is missing.').toEqual(expect.any(Array));
    const triggerGates = (preconditions ?? []).filter((p) => p.kind === 'TriggerType');
    expect(triggerGates.length, 'approve_artifact_plan must have exactly one TriggerType gate.').toBe(1);
    expect(
      triggerGates[0]?.triggerSet,
      'If this fails: approve_artifact_plan must be gated to user_confirmation ONLY; allowing system_mode_entry reopens #81.',
    ).toEqual(['user_confirmation']);
  });

  it('approve_artifact_plan transitions to domain_synthesis; plan_artifacts stays in scaffold_plan', () => {
    expect(
      spec.proceed_to?.approve_artifact_plan,
      'If this fails: approve_artifact_plan no longer transitions to domain_synthesis.',
    ).toBe('domain_synthesis');
    expect(
      spec.proceed_to?.plan_artifacts,
      'plan_artifacts must NOT be a transition trigger — it drafts and parks for approval.',
    ).toBeUndefined();
  });
});
