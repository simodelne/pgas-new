import { describe, expect, it } from 'vitest';
import {
  FOUNDRY_CAPABILITY_REGISTRY,
  CapabilityRefusalError,
  assertSynthesizableCapabilities,
  assessCapabilities,
  capabilityStatus,
  detectRequestedCapabilities,
} from '../../src/foundry-program/capability-registry.js';
import { synthesizeProgramSpecFromDomain } from '../../src/foundry-program/synthesizer.js';

// #166 uplift PR-1 — the foundry must DECLARE its synthesis capabilities and
// REFUSE (safe-stop) when a program demands a surface beyond its envelope, rather
// than silently emitting an inadequate linear scaffold (the 2026-07-14 live
// Codex-session failure). These tests lock the registry + detection + refusal, and
// — critically — that today's linear / external-adapter programs trigger NOTHING.

describe('foundry capability registry (#166 PR-1)', () => {
  it('every registry entry is well-formed; refuses/gap entries carry a gap_note', () => {
    expect(FOUNDRY_CAPABILITY_REGISTRY.length).toBeGreaterThan(5);
    for (const entry of FOUNDRY_CAPABILITY_REGISTRY) {
      expect(entry.capability, 'capability id').toMatch(/^[a-z0-9_]+$/);
      expect(['synthesizes', 'scaffolds_with_gap', 'refuses']).toContain(entry.status);
      expect(entry.evidence.length, `${entry.capability} evidence`).toBeGreaterThan(0);
      expect(entry.since_version, `${entry.capability} since_version`).toMatch(/^\d+\.\d+\.\d+$/);
      if (entry.status !== 'synthesizes') {
        expect(entry.gap_note, `${entry.capability} must document its gap`).toBeTruthy();
      }
    }
  });

  it('classifies the load-bearing Contract-Revision capabilities as refuses (foundry can synthesize linear + collections today)', () => {
    expect(capabilityStatus('linear_stage_chain')).toBe('synthesizes');
    expect(capabilityStatus('collection_lifecycle_aggregate')).toBe('synthesizes');
    for (const cap of [
      'per_item_confirmation',
      'delegation_child_session',
      'delegation_research_agent',
      'document_upload_intake',
      'rich_frontend',
      'export_docx_trackchange',
    ]) {
      expect(capabilityStatus(cap), cap).toBe('refuses');
    }
  });
});

describe('capability detection precision', () => {
  it('detects the Contract-Revision capability demands from intake signals', () => {
    const demands = detectRequestedCapabilities({
      purpose:
        'Ingest an uploaded contract, run legal research via a research agent, then do a clause-by-clause revision where the user approves each clause, and export a revised DOCX with track changes.',
      stages: [{ slug: 'clause_revision', description: 'per-clause approval loop with editable HTML view' }],
      delegation: { research: { kind: 'research_agent', result_path: 'research.findings' } },
    });
    const caps = new Set(demands.map((d) => d.capability));
    expect(caps).toContain('per_item_confirmation');
    expect(caps).toContain('document_upload_intake');
    expect(caps).toContain('delegation_research_agent');
    expect(caps).toContain('export_docx_trackchange');
    expect(caps).toContain('rich_frontend');
  });

  it('does NOT fire on a linear program (no false positives)', () => {
    const demands = detectRequestedCapabilities({
      purpose: 'Calculate proposal fees, summarize the brief, and close the workflow with a decision.',
      stages: [{ slug: 'fee_modeling', description: 'compute the recommended fee' }],
    });
    expect(demands).toEqual([]);
  });

  it('does NOT flag an external-adapter service delegation as child-session delegation (synthesizable today)', () => {
    const demands = detectRequestedCapabilities({
      purpose: 'Look up a CRM account and summarize it.',
      stages: [{ slug: 'crm_lookup', description: 'lookup an account' }],
      delegation: { crm_lookup: { service: 'crm', adapter: 'in-memory mock account lookup' } },
    });
    expect(demands).toEqual([]);
  });
});

describe('honest refusal safe-stop', () => {
  it('assertSynthesizableCapabilities passes silently for a linear program', () => {
    expect(() =>
      assertSynthesizableCapabilities({
        purpose: 'Triage an expense submission and decide approve/reject.',
        stages: [{ slug: 'triage', description: 'apply policy rules' }],
      }),
    ).not.toThrow();
  });

  it('throws CapabilityRefusalError listing the refused capabilities for a Contract-Revision demand', () => {
    let thrown: unknown;
    try {
      assertSynthesizableCapabilities({
        purpose: 'Clause-by-clause revision where the user approves each clause; export DOCX with track changes.',
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CapabilityRefusalError);
    const err = thrown as CapabilityRefusalError;
    expect(err.kind).toBe('capability_refusal');
    expect(err.refused.map((d) => d.capability)).toEqual(
      expect.arrayContaining(['per_item_confirmation', 'export_docx_trackchange']),
    );
    expect(err.message).toContain('capability_refusal');
    expect(err.message).toContain('uplift'); // gap_note routed into the message
  });

  it('treats an unknown capability id conservatively as a refusal', () => {
    const assessment = assessCapabilities([{ capability: 'made_up_surface', evidence: 'x' }]);
    expect(assessment.unknown.map((d) => d.capability)).toEqual(['made_up_surface']);
  });
});

describe('synthesizer integration', () => {
  const linearDomain: Record<string, unknown> = {
    'program.slug': 'fee-calc',
    'program.name': 'Fee Calc',
    'program.target_dir': '/tmp/fee-calc',
    'intake.purpose': 'Compute a recommended fee from inputs and finish.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      { slug: 'fee_modeling' },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'fee_modeling', trigger: 'started', guard_field: 'intake.started' },
      { from: 'fee_modeling', to: 'complete', trigger: 'modeled', guard_field: 'fee_modeling.ready' },
    ]),
    'intake.delegation_json': JSON.stringify({}),
    'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'fee_modeling.ready' }),
  };

  it('synthesizes a linear program without triggering the capability gate', () => {
    expect(() => synthesizeProgramSpecFromDomain(linearDomain)).not.toThrow();
  });

  it('refuses to synthesize a Contract-Revision-class program (safe-stop, not a linear scaffold)', () => {
    const crDomain = {
      ...linearDomain,
      'program.slug': 'contract-revision',
      'intake.purpose':
        'Ingest an uploaded contract and run a clause-by-clause revision where the user approves each clause, then export a revised DOCX with track changes.',
    };
    expect(() => synthesizeProgramSpecFromDomain(crDomain)).toThrow(CapabilityRefusalError);
  });
});
