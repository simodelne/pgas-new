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
// The fix routes the premature system_mode_entry re-entry to a no-write
// await_artifact_plan_approval action, keeping approve_artifact_plan available for
// the real user approval. This locks the exact spec wiring that fix depends on so
// a spec edit that reopens #81 fails CI deterministically (no LLM/round timing).
// Behaviorally proven on the live foundry path (session pgas-new-1782923109541).

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SPEC_PATH = resolve(ROOT, 'src/foundry-program/specs.yml');

interface Precondition {
  kind: string;
  path?: string;
  value?: unknown;
  triggerSet?: string[];
}

interface Mutation {
  op: string;
  path: string;
  value?: unknown;
}

interface FoundrySpec {
  modes: Record<string, {
    vocabulary?: string[];
    preconditions?: Record<string, Precondition[]>;
  }>;
  proceed_to?: Record<string, string>;
  action_map?: Record<string, { mutations?: Mutation[]; channel?: string }>;
  schema?: Record<string, string>;
}

let spec: FoundrySpec;

beforeAll(() => {
  spec = load(readFileSync(SPEC_PATH, 'utf8')) as FoundrySpec;
});

function hasPrecondition(
  preconditions: Precondition[] | undefined,
  match: (precondition: Precondition) => boolean,
): boolean {
  return Array.isArray(preconditions) && preconditions.some(match);
}

describe('#81 scaffold_plan approval gating (await_artifact_plan_approval regression lock)', () => {
  it('scaffold_plan vocabulary declares await_artifact_plan_approval and approve_artifact_plan', () => {
    const vocabulary = spec.modes.scaffold_plan?.vocabulary;

    expect(
      vocabulary,
      'If this fails: src/foundry-program/specs.yml scaffold_plan.vocabulary is no longer an array.',
    ).toEqual(expect.any(Array));
    expect(
      vocabulary as string[],
      'If this fails: scaffold_plan vocabulary dropped await_artifact_plan_approval or approve_artifact_plan (reopens #81).',
    ).toEqual(expect.arrayContaining(['await_artifact_plan_approval', 'approve_artifact_plan']));
  });

  it('await_artifact_plan_approval fires only on system_mode_entry while the plan is draft, unapproved, and not yet awaiting', () => {
    const preconditions = spec.modes.scaffold_plan?.preconditions?.await_artifact_plan_approval;

    expect(
      preconditions,
      'If this fails: await_artifact_plan_approval precondition was removed — the #81 fix is reverted.',
    ).toEqual(expect.any(Array));
    expect(
      hasPrecondition(
        preconditions,
        (p) => p.kind === 'TriggerType' && Array.isArray(p.triggerSet)
          && p.triggerSet.length === 1 && p.triggerSet[0] === 'system_mode_entry',
      ),
      'If this fails: await_artifact_plan_approval must be gated to system_mode_entry only.',
    ).toBe(true);
    expect(
      hasPrecondition(preconditions, (p) => p.kind === 'FieldEquals' && p.path === 'artifact_plan.status' && p.value === 'draft'),
      'If this fails: await_artifact_plan_approval must require artifact_plan.status=draft.',
    ).toBe(true);
    expect(
      hasPrecondition(preconditions, (p) => p.kind === 'FieldFalsy' && p.path === 'artifact_plan.approved'),
      'If this fails: await_artifact_plan_approval must require artifact_plan.approved to be falsy.',
    ).toBe(true);
    expect(
      hasPrecondition(preconditions, (p) => p.kind === 'FieldFalsy' && p.path === 'artifact_plan.awaiting_user_approval'),
      'If this fails: await_artifact_plan_approval must require artifact_plan.awaiting_user_approval to be falsy (fires once).',
    ).toBe(true);
  });

  it('approve_artifact_plan stays gated to user_confirmation so it cannot fire on a premature system_mode_entry (#81 root cause)', () => {
    const preconditions = spec.modes.scaffold_plan?.preconditions?.approve_artifact_plan;

    expect(
      preconditions,
      'If this fails: approve_artifact_plan precondition is missing.',
    ).toEqual(expect.any(Array));
    const triggerGates = (preconditions ?? []).filter((p) => p.kind === 'TriggerType');
    expect(
      triggerGates.length,
      'If this fails: approve_artifact_plan must have exactly one TriggerType gate.',
    ).toBe(1);
    expect(
      triggerGates[0]?.triggerSet,
      'If this fails: approve_artifact_plan must be gated to user_confirmation ONLY; allowing system_mode_entry reopens #81.',
    ).toEqual(['user_confirmation']);
  });

  it('await_artifact_plan_approval only sets awaiting_user_approval=true on widget_output (no other effects)', () => {
    const entry = spec.action_map?.await_artifact_plan_approval;

    expect(
      entry,
      'If this fails: action_map.await_artifact_plan_approval is missing.',
    ).toBeDefined();
    expect(entry?.channel).toBe('widget_output');
    expect(
      entry?.mutations,
      'If this fails: await_artifact_plan_approval must set exactly artifact_plan.awaiting_user_approval=true.',
    ).toEqual([{ op: 'MSet', path: 'artifact_plan.awaiting_user_approval', value: true }]);
  });

  it('await_artifact_plan_approval is non-advancing while approve_artifact_plan transitions to domain_synthesis', () => {
    expect(
      spec.proceed_to?.await_artifact_plan_approval,
      'If this fails: await_artifact_plan_approval became a transition trigger — it must keep the session in scaffold_plan awaiting user approval.',
    ).toBeUndefined();
    expect(
      spec.proceed_to?.approve_artifact_plan,
      'If this fails: approve_artifact_plan no longer transitions to domain_synthesis.',
    ).toBe('domain_synthesis');
  });

  it('declares the artifact_plan.awaiting_user_approval boolean schema path', () => {
    expect(
      spec.schema?.['artifact_plan.awaiting_user_approval'],
      'If this fails: artifact_plan.awaiting_user_approval schema path is missing/mistyped.',
    ).toBe('boolean');
  });
});
