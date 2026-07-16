import { describe, expect, it } from 'vitest';
import { CapabilityRefusalError, capabilityStatus, detectRequestedCapabilities } from '../../src/foundry-program/capability-registry.js';
import { handlers } from '../../src/foundry-program/handlers.js';
import {
  assertDocumentsDescriptor,
  synthesizeProgramSpecFromDomain,
} from '../../src/foundry-program/synthesizer.js';

const stages = [
  { slug: 'intake', is_bootstrap: true },
  { slug: 'ingest_source' },
  { slug: 'dispatch_research' },
  { slug: 'complete', is_terminal: true },
];

const validationContext = {
  stages,
  delegation: { enabled: false },
};

function validDocuments(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stage: 'ingest_source',
    upload_types: ['text/plain', 'text/markdown'],
    extraction: 'self_contained',
    result_path: 'ingest_source.source',
    required: true,
    fidelity_floor: { min_chars: 40 },
    ...patch,
  };
}

function validDelegationOn(stage: string): Record<string, unknown> {
  return {
    children: [
      {
        id: 'research',
        stage,
        synthesize_child: {
          kind: 'research_agent',
          purpose: 'Research the uploaded source.',
          result_fields: { summary: 'string' },
        },
        payload_map: { 'request.topic': 'inputs.initial_user_text' },
        result_path: `${stage}.delegation.research.result`,
        max_delegated_rounds: 12,
        optional: true,
      },
    ],
  };
}

function linearDomain(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'program.slug': 'document-intake-parent',
    'program.name': 'Document Intake Parent',
    'program.target_dir': '/tmp/document-intake-parent',
    'intake.purpose': 'Read uploaded source documents and summarize them.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      { slug: 'intake', is_bootstrap: true },
      { slug: 'ingest_source' },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: 'ingest_source', trigger: 'started', guard_field: 'intake.started' },
      { from: 'ingest_source', to: 'complete', trigger: 'ingested', guard_field: 'ingest_source.ready' },
    ]),
    'intake.delegation_json': JSON.stringify({ enabled: false }),
    'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'ingest_source.ready' }),
    ...overrides,
  };
}

function expectValidationThrow(documents: unknown, pattern: RegExp): void {
  expect(() => assertDocumentsDescriptor(documents, validationContext)).toThrow(pattern);
}

describe('documents descriptor validation', () => {
  it('accepts a single self-contained text descriptor', () => {
    expect(() => assertDocumentsDescriptor(validDocuments(), validationContext)).not.toThrow();
  });

  it('requires exactly one documents descriptor', () => {
    expectValidationThrow(undefined, /documents descriptor is required/u);
    expectValidationThrow([], /documents must declare exactly one descriptor/u);
    expectValidationThrow([validDocuments(), validDocuments()], /documents must declare exactly one descriptor/u);
  });

  it('requires the host stage to be declared, non-bootstrap, and non-terminal', () => {
    expectValidationThrow(validDocuments({ stage: 'missing_stage' }), /stage must reference a declared non-bootstrap non-terminal stage/u);
    expectValidationThrow(validDocuments({ stage: 'intake' }), /stage must reference a declared non-bootstrap non-terminal stage/u);
    expectValidationThrow(validDocuments({ stage: 'complete' }), /stage must reference a declared non-bootstrap non-terminal stage/u);
  });

  it('requires a non-empty upload_types subset of the engine allow-list', () => {
    expectValidationThrow(validDocuments({ upload_types: [] }), /upload_types must be a non-empty array/u);
    expectValidationThrow(validDocuments({ upload_types: ['image/png'] }), /upload_types must be a subset of the engine upload allow-list/u);
  });

  it('routes self-contained binary extraction to an honest capability refusal', () => {
    let thrown: unknown;
    try {
      assertDocumentsDescriptor(validDocuments({ upload_types: ['application/pdf'] }), validationContext);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CapabilityRefusalError);
    const err = thrown as CapabilityRefusalError;
    expect(err.refused.map((demand) => demand.capability)).toContain('document_upload_intake');
    expect(err.message).toContain('DOCX/PDF extraction is a host connector — use extraction: host_connector (PR-U5); self-contained is text/markdown only');
  });

  it('allows binary upload types only with host_connector extraction', () => {
    expect(() =>
      assertDocumentsDescriptor(
        validDocuments({
          upload_types: ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
          extraction: 'host_connector',
        }),
        validationContext,
      ),
    ).not.toThrow();
  });

  it('requires result_path to stay under the host stage namespace', () => {
    expectValidationThrow(
      validDocuments({ result_path: 'work.source' }),
      /result_path must be under ingest_source\./u,
    );
  });

  it('rejects v1 documents plus delegation children on the same host stage', () => {
    expect(() =>
      assertDocumentsDescriptor(validDocuments(), {
        stages,
        delegation: validDelegationOn('ingest_source'),
      }),
    ).toThrow(/documents descriptor and delegation\.children\[0\] must not share host stage ingest_source/u);
  });
});

describe('documents descriptor capability routing', () => {
  it('detects documents_json as document_upload_intake while the registry still refuses it', () => {
    const demands = detectRequestedCapabilities({
      documents: validDocuments(),
    });
    expect(demands).toContainEqual({
      capability: 'document_upload_intake',
      evidence: 'intake.documents_json declares a documents upload descriptor',
    });
    expect(capabilityStatus('document_upload_intake')).toBe('refuses');
  });

  it('keeps the existing upload/ingest text detector routed to document_upload_intake', () => {
    const demands = detectRequestedCapabilities({
      purpose: 'Ingest an uploaded PDF contract and extract its clauses.',
    });
    expect(demands.map((demand) => demand.capability)).toContain('document_upload_intake');
  });

  it('validates documents_json before the current capability gate refuses synthesis', () => {
    expect(() =>
      synthesizeProgramSpecFromDomain(linearDomain({
        'intake.documents_json': JSON.stringify(validDocuments({ upload_types: ['image/png'] })),
      })),
    ).toThrow(/upload_types must be a subset of the engine upload allow-list/u);

    expect(() =>
      synthesizeProgramSpecFromDomain(linearDomain({
        'intake.documents_json': JSON.stringify(validDocuments()),
      })),
    ).toThrow(CapabilityRefusalError);
  });
});

describe('documents descriptor intake capture', () => {
  it('record_documents_descriptor accepts tolerant JSON object input', async () => {
    await expect(
      handlers.record_documents_descriptor({
        documents_json: '{stage:"ingest_source", upload_types:["text/plain"], result_path:"ingest_source.source"}',
      }),
    ).resolves.toEqual({
      kind: 'pgas_new_documents_descriptor_recorded',
      documents: {
        stage: 'ingest_source',
        upload_types: ['text/plain'],
        result_path: 'ingest_source.source',
      },
      documents_json: '{"stage":"ingest_source","upload_types":["text/plain"],"result_path":"ingest_source.source"}',
    });
  });

  it('record_documents_descriptor normalizes no-documents sentinel answers', async () => {
    await expect(
      handlers.record_documents_descriptor({ documents_json: 'none' }),
    ).resolves.toMatchObject({
      kind: 'pgas_new_documents_descriptor_recorded',
      documents: { enabled: false },
      documents_json: '{"enabled":false}',
    });
  });
});
