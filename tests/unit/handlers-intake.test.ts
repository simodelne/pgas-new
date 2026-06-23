import { describe, expect, it } from 'vitest';
import { handlers } from '../../src/foundry-program/handlers.js';

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
});
