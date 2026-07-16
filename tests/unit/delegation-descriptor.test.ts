import { describe, expect, it } from 'vitest';
import { CapabilityRefusalError } from '../../src/foundry-program/capability-registry.js';
import {
  assertDelegationChildrenDescriptor,
  synthesizeProgramSpecFromDomain,
} from '../../src/foundry-program/synthesizer.js';

const stages = [
  { slug: 'intake', is_bootstrap: true },
  { slug: 'dispatch_research' },
  { slug: 'complete', is_terminal: true },
];

const validationContext = {
  programSlug: 'parent-program',
  programName: 'Parent Program',
  stages,
  actionNames: new Set(['begin_work', 'complete_dispatch_research', 'request_dispatch_research']),
  channelNames: new Set(['user_text', 'widget_output', 'stage_output', 'stage_output_call']),
  schemaPaths: new Set(['inputs.initial_user_text', 'intake.summary', 'dispatch_research.ready']),
};

function validDelegation(): Record<string, unknown> {
  return {
    stages: {
      dispatch_research: { kind: 'llm-reasoning', reasoning_per_turn: true },
    },
    children: [
      {
        id: 'research',
        stage: 'dispatch_research',
        synthesize_child: {
          kind: 'research_agent',
          purpose: 'Research the intake topic and return concise findings.',
          result_fields: {
            findings: 'string',
            confidence: 'string',
          },
        },
        payload_map: {
          'request.topic': 'intake.summary',
          'domain_context.original_request': 'inputs.initial_user_text',
        },
        result_path: 'dispatch_research.delegation.research.result',
        max_delegated_rounds: 12,
        round_timeout_ms: 120000,
        optional: true,
      },
    ],
  };
}

function withChild(patch: Record<string, unknown>): Record<string, unknown> {
  const child = validChild();
  return { ...validDelegation(), children: [{ ...child, ...patch }] };
}

function validChild(): Record<string, unknown> {
  const child = (validDelegation().children as Record<string, unknown>[])[0];
  if (!child) {
    throw new Error('test fixture missing child descriptor');
  }
  return child;
}

function expectValidationThrow(delegation: Record<string, unknown>, pattern: RegExp): void {
  expect(() => assertDelegationChildrenDescriptor(delegation, validationContext)).toThrow(pattern);
}

function expectCapabilityRefusal(delegation: Record<string, unknown>, capability: string): void {
  let thrown: unknown;
  try {
    assertDelegationChildrenDescriptor(delegation, validationContext);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CapabilityRefusalError);
  const err = thrown as CapabilityRefusalError;
  expect(err.refused.map((demand) => demand.capability)).toContain(capability);
  expect(err.message).toContain('v1 delegation is single static/synthesized child');
  expect(err.message).toContain(`${capability} stays refuses`);
}

describe('delegation children descriptor validation', () => {
  it('accepts a single static synthesized child descriptor', () => {
    expect(() => assertDelegationChildrenDescriptor(validDelegation(), validationContext)).not.toThrow();
  });

  it('ignores delegation descriptors without children', () => {
    expect(() =>
      assertDelegationChildrenDescriptor({ enabled: false }, validationContext),
    ).not.toThrow();
  });

  it('requires exactly one child descriptor', () => {
    expectValidationThrow({ children: [] }, /delegation\.children must declare exactly one child/u);
    expectValidationThrow(
      { ...validDelegation(), children: [validChild(), validChild()] },
      /delegation\.children must declare exactly one child/u,
    );
  });

  it('requires the child stage to be declared, non-bootstrap, and non-terminal', () => {
    expectValidationThrow(withChild({ stage: 'missing_stage' }), /stage must reference a declared non-bootstrap non-terminal stage/u);
    expectValidationThrow(withChild({ stage: 'intake' }), /stage must reference a declared non-bootstrap non-terminal stage/u);
    expectValidationThrow(withChild({ stage: 'complete' }), /stage must reference a declared non-bootstrap non-terminal stage/u);
  });

  it('requires a slug-safe id and rejects generated action/channel collisions', () => {
    expectValidationThrow(withChild({ id: 'Bad Id' }), /id must be a slug-safe identifier/u);
    expectValidationThrow(
      withChild({ id: 'dispatch_research' }),
      /request_dispatch_research action collides with generated action set/u,
    );
    expectValidationThrow(
      withChild({ id: 'stage_output' }),
      /stage_output_call channel collides with generated channel set/u,
    );
  });

  it('requires exactly one of target_spec or synthesize_child', () => {
    expectValidationThrow(withChild({ target_spec: 'research-program' }), /exactly one of target_spec or synthesize_child/u);
    expectValidationThrow(
      withChild({ synthesize_child: undefined }),
      /exactly one of target_spec or synthesize_child/u,
    );
  });

  it('rejects parent self-targeting for static and synthesized children', () => {
    expectValidationThrow(
      withChild({ target_spec: 'parent-program', synthesize_child: undefined }),
      /target_spec must not reference the parent program/u,
    );
    expectValidationThrow(
      withChild({ id: 'parent_program' }),
      /synthesized child slug must not match the parent program slug/u,
    );
  });

  it('requires payload_map sources to be schema-declared parent paths and targets to be seeded namespaces', () => {
    expectValidationThrow(
      withChild({ payload_map: { 'request.topic': 'missing.summary' } }),
      /payload_map source missing\.summary must be declared in the parent schema/u,
    );
    expectValidationThrow(
      withChild({ payload_map: { 'child_request.topic': 'intake.summary' } }),
      /payload_map target child_request\.topic must start with request\. or domain_context\./u,
    );
  });

  it('requires result_path to stay under the host stage namespace', () => {
    expectValidationThrow(
      withChild({ result_path: 'delegation.research.result' }),
      /result_path must be under dispatch_research\./u,
    );
  });

  it('requires max_delegated_rounds to be a positive integer no greater than 80', () => {
    expectValidationThrow(withChild({ max_delegated_rounds: 0 }), /max_delegated_rounds must be a positive integer <= 80/u);
    expectValidationThrow(withChild({ max_delegated_rounds: 81 }), /max_delegated_rounds must be a positive integer <= 80/u);
  });

  it('routes fan-out, dynamic targets, continue-mode, and strict delegation to capability refusal', () => {
    expectCapabilityRefusal(withChild({ fan_out: { axes: ['web', 'files'] } }), 'delegation_research_agent');
    expectCapabilityRefusal(withChild({ dynamic_target_arg: 'request.target' }), 'delegation_child_session');
    expectCapabilityRefusal(withChild({ delegation_mode: 'continue' }), 'delegation_child_session');
    expectCapabilityRefusal(withChild({ optional: false }), 'delegation_child_session');
    expectCapabilityRefusal(withChild({ optional: undefined }), 'delegation_child_session');
  });
});

describe('delegation children descriptor synthesis gate', () => {
  const linearDomain: Record<string, unknown> = {
    'program.slug': 'parent-program',
    'program.name': 'Parent Program',
    'program.target_dir': '/tmp/parent-program',
    'intake.purpose': 'Dispatch research from intake and finish.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      {
        slug: 'intake',
        is_bootstrap: true,
        domain_spec: {
          reads: ['inputs.initial_user_text'],
          produces: { result_json: { summary: 'string' }, items_json: ['summary:<summary>'] },
          rules: ['Summarize the request.'],
          invariants: ['summary is grounded in the request.'],
        },
      },
      { slug: 'dispatch_research' },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'dispatch_research', trigger: 'started', guard_field: 'intake.started' },
      { from: 'dispatch_research', to: 'complete', trigger: 'done', guard_field: 'dispatch_research.ready' },
    ]),
    'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'dispatch_research.ready' }),
  };

  it('still refuses valid delegation children at the capability gate until emitters land', () => {
    expect(() =>
      synthesizeProgramSpecFromDomain({
        ...linearDomain,
        'intake.delegation_json': JSON.stringify(validDelegation()),
      }),
    ).toThrow(CapabilityRefusalError);
  });

  it('preserves synthesis for programs without children descriptors', () => {
    expect(() =>
      synthesizeProgramSpecFromDomain({
        ...linearDomain,
        'intake.delegation_json': JSON.stringify({ enabled: false }),
      }),
    ).not.toThrow();
  });
});
