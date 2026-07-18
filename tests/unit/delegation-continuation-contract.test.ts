import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';

import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';

// Falsifier for the delegation-continuation contract (the gap that blocked the
// real contract-revision graduation into simoneos on engine >=3.23). When a Sync
// delegation child returns, the engine fires the inbound `system_query_result`
// channel to wake the parent. Engine >=3.23 STRICTLY requires the generated spec to
// declare that channel + its ingestion + the base schema paths, and to list the
// channel in each delegation-awaiting mode — else the DelegationConsumer continuation
// fails (`channel_not_declared` → `no_ingestion_paths` → CouplingError S-4). Engine
// 3.21 (pgas-new's pin) tolerates the explicit contract, so this stays green here too.

function delegationDomain(): Record<string, unknown> {
  return {
    'program.slug': 'continuation-parent',
    'program.name': 'Continuation Parent',
    'program.target_dir': '/tmp/continuation-parent',
    'intake.purpose': 'Dispatch one delegated child and complete after the result settles.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      { slug: 'dispatch_research' },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'dispatch_research', trigger: 'started', guard_field: 'intake.started' },
      { from: 'dispatch_research', to: 'complete', trigger: 'done', guard_field: 'dispatch_research.ready' },
    ]),
    'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'dispatch_research.ready' }),
    'intake.delegation_json': JSON.stringify({
      stages: { dispatch_research: { kind: 'llm-reasoning', reasoning_per_turn: true } },
      children: [
        {
          id: 'research',
          stage: 'dispatch_research',
          synthesize_child: {
            kind: 'worker',
            purpose: 'Handle delegated work and echo the seeded topic.',
            result_fields: { summary: 'string' },
          },
          payload_map: { 'request.topic': 'inputs.initial_user_text' },
          result_path: 'dispatch_research.delegation.research.result',
          max_delegated_rounds: 12,
          optional: true,
        },
      ],
    }),
  };
}

interface ContinuationSpec {
  channels: Record<string, { direction?: string; sync?: string }>;
  ingestion: Record<string, unknown>;
  schema: Record<string, unknown>;
  modes: Record<string, { channels?: string[] }>;
}

describe('delegation continuation contract (engine >=3.23 requirement)', () => {
  const spec = load(
    synthesizeProgramSpecFromDomain(delegationDomain(), { targetKind: 'existing_repo' }).spec_yaml,
  ) as ContinuationSpec;

  it('declares the system_query_result inbound continuation channel', () => {
    expect(spec.channels.system_query_result).toMatchObject({ direction: 'In', sync: 'Async' });
  });

  it('ingests the continuation payload to the declared base paths', () => {
    expect(spec.ingestion.system_query_result).toEqual(['inputs.query_meta', 'inputs.query_result']);
  });

  it('schema-declares the continuation base paths (satisfies coupling S-4)', () => {
    expect(spec.schema['inputs.query_meta']).toBe('object');
    expect(spec.schema['inputs.query_result']).toBe('any');
  });

  it('lists system_query_result in the delegation-awaiting mode channels', () => {
    expect(spec.modes.dispatch_research?.channels).toContain('system_query_result');
  });

  it('does NOT emit the contract for a non-delegation program', () => {
    const plain = load(
      synthesizeProgramSpecFromDomain(
        {
          'program.slug': 'plain-program',
          'program.name': 'Plain Program',
          'program.target_dir': '/tmp/plain-program',
          'intake.purpose': 'A program with no delegation.',
          'intake.entry_channel': 'user_text',
          'intake.stages_json': JSON.stringify([
            { slug: 'intake', is_bootstrap: true },
            { slug: 'work' },
            { slug: 'complete', is_terminal: true },
          ]),
          'intake.transitions_json': JSON.stringify([
            { from: 'intake', to: 'work', trigger: 'started', guard_field: 'intake.started' },
            { from: 'work', to: 'complete', trigger: 'done', guard_field: 'work.ready' },
          ]),
          'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'work.ready' }),
          'intake.delegation_json': JSON.stringify({}),
        },
        { targetKind: 'existing_repo' },
      ).spec_yaml,
    ) as ContinuationSpec;
    expect(plain.channels.system_query_result).toBeUndefined();
    expect(plain.ingestion.system_query_result).toBeUndefined();
  });
});
