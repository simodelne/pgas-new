import { describe, expect, it } from 'vitest';
import { handlers, reactionHandlers } from '../../src/foundry-program/handlers.js';

describe('intake Q-action handlers', () => {
  it('record_q3_stages accepts valid JSON arrays', async () => {
    const stages = ['triage_intake', 'root_cause_analysis', 'mitigation', 'resolution'];

    await expect(
      handlers.record_q3_stages({ stages_json: JSON.stringify(stages) }),
    ).resolves.toEqual({
      kind: 'pgas_new_q3_stages_recorded',
      stages,
      stages_json: JSON.stringify(stages),
    });
  });

  it('record_q3_stages preserves rich stage objects with domain specs', async () => {
    const stages = [
      { slug: 'intake', is_bootstrap: true },
      {
        slug: 'fee_modelling',
        domain_spec: {
          reads: ['inputs.initial_user_text.rate_card'],
          produces: {
            result_json: {
              stage: 'string',
              hourly_total: 'number',
              fixed_quote: 'number',
            },
            items_json: ['hourly_total:<hourly_total>', 'fixed_quote:<fixed_quote>'],
          },
          rules: ['Compute quotes from the recorded rate card.'],
          invariants: ['result_json.stage must equal fee_modelling.'],
        },
      },
      { slug: 'complete', is_terminal: true },
    ];

    await expect(
      handlers.record_q3_stages({ stages_json: JSON.stringify(stages) }),
    ).resolves.toEqual({
      kind: 'pgas_new_q3_stages_recorded',
      stages,
      stages_json: JSON.stringify(stages),
    });
  });

  it('record_q3_stages repairs dropped rich-stage boundary braces from tool calls', async () => {
    const malformed = [
      '{"slug":"intake","is_bootstrap":true,"domain_spec":{"reads":["inputs.initial_frontend_intake"],"produces":{"result_json":{"stage":"string","client_name":"string"},"items_json":["client:<client_name>"]},"rules":["Parse intake."],"invariants":["stage equals intake."]}',
      '{"slug":"fee_modelling","domain_spec":{"reads":["intake.output.result_json"],"produces":{"result_json":{"stage":"string","fixed_quote":"number"},"items_json":["fixed_quote:<fixed_quote>"]},"rules":["Compute quote."],"invariants":["stage equals fee_modelling."]}',
      '{"slug":"complete","is_terminal":true}',
    ].join(',');

    await expect(
      handlers.record_q3_stages({ stages_json: `[${malformed}]` }),
    ).resolves.toMatchObject({
      kind: 'pgas_new_q3_stages_recorded',
      stages: [
        expect.objectContaining({ slug: 'intake', domain_spec: expect.any(Object) }),
        expect.objectContaining({ slug: 'fee_modelling', domain_spec: expect.any(Object) }),
        expect.objectContaining({ slug: 'complete', is_terminal: true }),
      ],
    });
  });

  it('record_q3_stages accepts bracketed comma-lists via tolerant fallback', async () => {
    await expect(
      handlers.record_q3_stages({
        stages_json: '[triage_intake, root_cause_analysis, mitigation, resolution]',
      }),
    ).resolves.toEqual({
      kind: 'pgas_new_q3_stages_recorded',
      stages: ['triage_intake', 'root_cause_analysis', 'mitigation', 'resolution'],
      stages_json: '["triage_intake","root_cause_analysis","mitigation","resolution"]',
    });
  });

  it('record_q3_stages rejects garbled input', async () => {
    await expect(
      handlers.record_q3_stages({ stages_json: 'triage_intake, root_cause_analysis' }),
    ).rejects.toThrow();
  });

  it('record_q4_transitions accepts valid JSON arrays', async () => {
    const transitions = [
      { from: 'triage_intake', to: 'root_cause_analysis', guard_field: 'triage_complete' },
      { from: 'root_cause_analysis', to: 'mitigation', guard_field: 'root_cause_identified' },
    ];

    await expect(
      handlers.record_q4_transitions({ transitions_json: JSON.stringify(transitions) }),
    ).resolves.toEqual({
      kind: 'pgas_new_q4_transitions_recorded',
      transitions,
      transitions_json: JSON.stringify(transitions),
    });
  });

  it('record_q4_transitions accepts bracketed comma-lists via tolerant fallback', async () => {
    await expect(
      handlers.record_q4_transitions({
        transitions_json: '[triage_intake->root_cause_analysis, root_cause_analysis->mitigation]',
      }),
    ).resolves.toEqual({
      kind: 'pgas_new_q4_transitions_recorded',
      transitions: ['triage_intake->root_cause_analysis', 'root_cause_analysis->mitigation'],
      transitions_json: '["triage_intake->root_cause_analysis","root_cause_analysis->mitigation"]',
    });
  });

  it('record_q4_transitions normalizes Qwen smart-quoted object arrays', async () => {
    const transitions = [
      { from: 'triage_intake', to: 'root_cause_analysis', guard_field: 'triage_complete' },
      { from: 'root_cause_analysis', to: 'mitigation', guard_field: 'root_cause_identified' },
      { from: 'mitigation', to: 'resolution', guard_field: 'mitigation_applied' },
    ];

    await expect(
      handlers.record_q4_transitions({
        transitions_json:
          '[{\u201cfrom\u201d:\u201dtriage_intake\u201d,\u201dto\u201d:\u201droot_cause_analysis\u201d,\u201dguard_field\u201d:\u201dtriage_complete\u201d},{\u201cfrom\u201d:\u201droot_cause_analysis\u201d,\u201dto\u201d:\u201dmitigation\u201d,\u201dguard_field\u201d:\u201droot_cause_identified\u201d},{\u201cfrom\u201d:\u201dmitigation\u201d,\u201dto\u201d:\u201dresolution\u201d,\u201dguard_field\u201d:\u201dmitigation_applied\u201d}]',
      }),
    ).resolves.toEqual({
      kind: 'pgas_new_q4_transitions_recorded',
      transitions,
      transitions_json: JSON.stringify(transitions),
    });
  });

  it('record_q4_transitions rejects garbled input', async () => {
    await expect(
      handlers.record_q4_transitions({ transitions_json: 'triage_intake->root_cause_analysis' }),
    ).rejects.toThrow();
  });

  it('record_q5_delegation accepts valid JSON objects', async () => {
    const delegation = { enabled: false };

    await expect(
      handlers.record_q5_delegation({ delegation_json: JSON.stringify(delegation) }),
    ).resolves.toEqual({
      kind: 'pgas_new_q5_delegation_recorded',
      delegation,
      delegation_json: JSON.stringify(delegation),
    });
  });

  it('record_q5_delegation repairs a brace-dropped bare mapping (Qwen live variance)', async () => {
    // Observed live 2026-07-04 (UAT scenario A attempt 1, Qwen qwen36-27b):
    // for the user reply "none", Qwen emitted delegation_json "enabled: false"
    // (no braces) which failed strict + tolerant parsing and burned a full
    // retry attempt. The brace-drop repair wraps a bare `key: value` mapping
    // and re-parses tolerantly.
    await expect(
      handlers.record_q5_delegation({ delegation_json: 'enabled: false' }),
    ).resolves.toMatchObject({
      kind: 'pgas_new_q5_delegation_recorded',
      delegation: { enabled: false },
    });
  });

  it('record_q5_delegation rejects bracketed comma-lists and garbled input', async () => {
    await expect(
      handlers.record_q5_delegation({ delegation_json: '[none, human_review]' }),
    ).rejects.toThrow();
    await expect(
      handlers.record_q5_delegation({ delegation_json: 'none, human_review' }),
    ).rejects.toThrow();
  });

  it('record_q6_completion accepts valid JSON objects', async () => {
    const completion = { final_stage: 'resolution', guard_field: 'incident_resolved' };

    await expect(
      handlers.record_q6_completion({ completion_json: JSON.stringify(completion) }),
    ).resolves.toEqual({
      kind: 'pgas_new_q6_completion_recorded',
      completion,
      completion_json: JSON.stringify(completion),
    });
  });

  it('record_q6_completion rejects bracketed comma-lists and garbled input', async () => {
    await expect(
      handlers.record_q6_completion({ completion_json: '[resolution, incident_resolved]' }),
    ).rejects.toThrow();
    await expect(
      handlers.record_q6_completion({ completion_json: 'resolution, incident_resolved' }),
    ).rejects.toThrow();
  });

  it('normalize_intake_json_fields canonicalizes smart-quoted transitions before stale-refresh validation', () => {
    const reaction = reactionHandlers.get('normalize_intake_json_fields');
    if (!reaction) throw new Error('missing normalize_intake_json_fields reaction');

    const transitions = [
      { from: 'triage_intake', to: 'root_cause_analysis', guard_field: 'triage_complete' },
      { from: 'root_cause_analysis', to: 'mitigation', guard_field: 'root_cause_identified' },
      { from: 'mitigation', to: 'resolution', guard_field: 'mitigation_applied' },
    ];

    const result = reaction(
      new Map<string, unknown>([
        [
          'intake.stages_json',
          JSON.stringify([
            { slug: 'triage_intake', is_bootstrap: true },
            { slug: 'root_cause_analysis' },
            { slug: 'mitigation' },
            { slug: 'resolution', is_terminal: true },
          ]),
        ],
        [
          'intake.transitions_json',
          '[{\u201cfrom\u201d:\u201dtriage_intake\u201d,\u201dto\u201d:\u201droot_cause_analysis\u201d,\u201dguard_field\u201d:\u201dtriage_complete\u201d},{\u201cfrom\u201d:\u201droot_cause_analysis\u201d,\u201dto\u201d:\u201dmitigation\u201d,\u201dguard_field\u201d:\u201droot_cause_identified\u201d},{\u201cfrom\u201d:\u201dmitigation\u201d,\u201dto\u201d:\u201dresolution\u201d,\u201dguard_field\u201d:\u201dmitigation_applied\u201d}]',
        ],
        [
          'intake.completion_json',
          JSON.stringify({ final_stage: 'resolution', guard_field: 'incident_resolved' }),
        ],
      ]),
      'user_text',
      'intake_intelligence',
    );

    expect(result).toEqual({
      mutations: [
        {
          op: 'MSet',
          path: 'intake.transitions_json',
          value: JSON.stringify(transitions),
        },
      ],
    });
  });
});
