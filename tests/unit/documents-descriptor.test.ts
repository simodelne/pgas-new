import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpecWithPatterns } from '@simodelne/pgas-server/plugin.js';
import { CapabilityRefusalError, capabilityStatus, detectRequestedCapabilities } from '../../src/foundry-program/capability-registry.js';
import { handlers } from '../../src/foundry-program/handlers.js';
import {
  adaptReusableDelegationPayloadMapsForDomain,
  assertDocumentsDescriptor,
  synthesizeProgramSpecFromDomain,
} from '../../src/foundry-program/synthesizer.js';
import type { DelegationDescriptor } from '../../src/foundry-program/synthesizer-store.js';
import { stripConventionSidecars } from '../fixtures/convention-sidecars.js';

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
    target: { root: 'work.source' },
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

function validDocumentIngestDelegationOn(stage: string): Record<string, unknown> {
  return {
    children: [
      {
        id: 'document_ingest',
        stage,
        target_spec: 'SimoneOS Document Ingest',
        registered_name: 'document-ingest',
        target_slug: 'document-ingest',
        payload_map: {
          'request.documents': 'work.source.documents',
          'request.extraction_contract': 'work.source.extraction_contract',
        },
        result_path: `${stage}.delegation.document_ingest.result`,
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
      { from: 'ingest_source', to: 'complete', trigger: 'ingested', guard_field: 'work.source_ready' },
    ]),
    'intake.delegation_json': JSON.stringify({ enabled: false }),
    'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'work.source_ready' }),
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

  it('routes self-contained PDF extraction to an honest capability refusal', () => {
    let thrown: unknown;
    try {
      assertDocumentsDescriptor(validDocuments({ upload_types: ['application/pdf'] }), validationContext);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CapabilityRefusalError);
    const err = thrown as CapabilityRefusalError;
    expect(err.refused.map((demand) => demand.capability)).toContain('document_upload_intake');
    expect(err.message).toContain('PDF extraction is a host connector');
    expect(err.message).toContain('self-contained DOCX is supported');
  });

  it('allows self-contained DOCX extraction', () => {
    expect(() =>
      assertDocumentsDescriptor(
        validDocuments({
          upload_types: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
          extraction: 'self_contained',
        }),
        validationContext,
      ),
    ).not.toThrow();
  });

  it('allows binary upload types with host_connector extraction', () => {
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

  it('rejects result paths under the engine-owned document intake namespace', () => {
    expectValidationThrow(
      validDocuments({ target: { root: 'inputs.document_intake.source' } }),
      /result_path must not be under inputs\.document_intake/u,
    );
  });

  it('allows required upload descriptor plus same-stage manifest document-ingest delegation', () => {
    expect(() =>
      assertDocumentsDescriptor(validDocuments(), {
        stages,
        delegation: validDocumentIngestDelegationOn('ingest_source'),
      }),
    ).not.toThrow();
  });

  it('rejects same-stage delegation children that are not upload-to-document-ingest compatible', () => {
    expect(() =>
      assertDocumentsDescriptor(validDocuments(), {
        stages,
        delegation: validDelegationOn('ingest_source'),
      }),
    ).toThrow(/same-stage upload delegation is only supported.*document-ingest.*request\.documents=work\.source\.documents.*request\.extraction_contract=work\.source\.extraction_contract/u);
  });

  it('surfaces incompatible same-stage delegation as a reusable intake repair error', () => {
    const compatibility = adaptReusableDelegationPayloadMapsForDomain(
      linearDomain({
        'intake.documents_json': JSON.stringify(validDocuments()),
        'intake.delegation_json': JSON.stringify(validDelegationOn('ingest_source')),
      }),
      validDelegationOn('ingest_source') as DelegationDescriptor,
      [],
    );

    expect(compatibility.errors).toHaveLength(1);
    expect(compatibility.errors[0]).toMatch(/same-stage upload delegation is only supported.*later stage.*request\.documents=work\.source\.documents/u);
  });
});

describe('documents descriptor capability routing', () => {
  it('detects documents_json as document_upload_intake (registry: synthesizes, live-drive proven)', () => {
    const demands = detectRequestedCapabilities({
      documents: validDocuments(),
    });
    expect(demands).toContainEqual({
      capability: 'document_upload_intake',
      evidence: 'intake.documents_json declares a documents upload descriptor',
    });
    expect(capabilityStatus('document_upload_intake')).toBe('synthesizes');
  });

  it('keeps the existing upload/ingest text detector routed to document_upload_intake', () => {
    const demands = detectRequestedCapabilities({
      purpose: 'Ingest an uploaded PDF contract and extract its clauses.',
    });
    expect(demands.map((demand) => demand.capability)).toContain('document_upload_intake');
  });

  it('validates documents_json before synthesis proceeds', () => {
    expect(() =>
      synthesizeProgramSpecFromDomain(linearDomain({
        'intake.documents_json': JSON.stringify(validDocuments({ upload_types: ['image/png'] })),
      })),
    ).toThrow(/upload_types must be a subset of the engine upload allow-list/u);

    const artifact = synthesizeProgramSpecFromDomain(linearDomain({
      'intake.documents_json': JSON.stringify(validDocuments()),
    }));
    const parsed = load(artifact.spec_yaml) as {
      modes: Record<string, {
        transitions?: Array<{ target: string; when?: Record<string, unknown> }>;
      }>;
    };
    expect(artifact.spec_yaml).toContain('document_upload:');
    expect(artifact.spec_yaml).toContain('ingest_documents:');
    expect(parsed.modes.ingest_source.transitions).toEqual([
      {
        target: 'complete',
        when: {
          kind: 'All',
          subs: [
            { kind: 'FieldTruthy', path: 'work.source_ready' },
            { kind: 'FieldGreaterOrEqual', path: 'work.source.char_count', value: 40 },
          ],
        },
      },
    ]);
    expect(artifact.handlers_ts).not.toContain('charCount < 40');
  });

  it('emits retained collection-backed coverage for required document tokens', () => {
    const artifact = synthesizeProgramSpecFromDomain(linearDomain({
      'intake.documents_json': JSON.stringify(validDocuments({
        fidelity_floor: { min_chars: 40, required_tokens: ['Acme', 'renewal'] },
      })),
    }));
    const parsed = load(artifact.spec_yaml) as {
      features?: string[];
      reference_data?: Record<string, unknown>;
      modes: Record<string, {
        transitions?: Array<{ target: string; when?: Record<string, unknown> }>;
      }>;
    };

    expect(parsed.modes.ingest_source.transitions).toEqual([
      {
        target: 'complete',
        when: {
          kind: 'All',
          subs: [
            { kind: 'FieldTruthy', path: 'work.source_ready' },
            { kind: 'FieldGreaterOrEqual', path: 'work.source.char_count', value: 40 },
            {
              kind: 'FieldContainsAllFromCollection',
              path: 'work.source.full_text',
              source_path: 'reference.document_required_tokens',
            },
          ],
        },
      },
    ]);
    expect(parsed.features).toContain('reference_data');
    expect(parsed.reference_data).toEqual({
      document_required_tokens: {
        schema: {
          'reference.document_required_tokens': 'array',
          'reference.document_required_tokens.*': 'string',
        },
        data: ['Acme', 'renewal'],
      },
    });
    const domainFile = artifact.spec_files.find((file) => file.path === 'domain.yml');
    expect((load(domainFile!.content) as { reference_data: unknown }).reference_data)
      .toEqual(parsed.reference_data);
    expect(() => loadSpecWithPatterns(writeTempSpec(artifact.spec_yaml))).not.toThrow();
  });

  it('keeps regex invariants and drops redundant deterministic-copy grounding', () => {
    const artifact = synthesizeProgramSpecFromDomain(linearDomain({
      'intake.documents_json': JSON.stringify(validDocuments({
        fidelity_floor: {
          required_patterns: ['ACME-[0-9]{4}'],
          forbidden_patterns: ['DRAFT ONLY'],
          source_grounded_extractors: ['capitalized_names'],
        },
      })),
    }));
    const parsed = load(artifact.spec_yaml) as {
      features?: string[];
      schema?: Record<string, string>;
      schema_invariants?: Array<{
        collection: string;
        invariants: Array<Record<string, unknown>>;
      }>;
    };

    expect(parsed.features).toContain('schema_invariants');
    expect(parsed.schema?.['inputs.document_intake.documents.*.content_text']).toBe('string');
    expect(parsed.schema_invariants).toEqual([
      {
        collection: 'work.source.documents',
        invariants: [
          { kind: 'FieldMatchesPattern', path: 'text', pattern: 'ACME-[0-9]{4}' },
          { kind: 'FieldNotMatchesPattern', path: 'text', pattern: 'DRAFT ONLY' },
        ],
      },
    ]);
    expect(() => loadSpecWithPatterns(writeTempSpec(artifact.spec_yaml))).not.toThrow();
  });

  it('emits neither removed kind nor validate for source-copy grounding alone', () => {
    const artifact = synthesizeProgramSpecFromDomain(linearDomain({
      'intake.documents_json': JSON.stringify(validDocuments({
        fidelity_floor: {
          source_grounded_extractors: ['capitalized_names', 'citation_ids', 'figure_refs'],
        },
      })),
    }));
    const parsed = load(artifact.spec_yaml) as {
      features?: string[];
      schema_invariants?: unknown;
      action_map: Record<string, { mutations: unknown[]; validate?: unknown }>;
    };
    expect(parsed.schema_invariants).toBeUndefined();
    expect(parsed.features).not.toContain('schema_invariants');
    expect(parsed.features).not.toContain('substantive_validation');
    expect(parsed.action_map.ingest_documents.mutations).toEqual([]);
    expect(Object.values(parsed.action_map).every((action) => action.validate === undefined)).toBe(true);
    expect(artifact.spec_yaml).not.toMatch(/kind: (?:FieldContainsAll|FieldSourceGrounded)\b/u);
    expect(() => loadSpecWithPatterns(writeTempSpec(artifact.spec_yaml))).not.toThrow();
  });

  it('rejects blank document token coverage entries fail-closed', () => {
    expect(() =>
      synthesizeProgramSpecFromDomain(linearDomain({
        'intake.documents_json': JSON.stringify(validDocuments({
          fidelity_floor: { required_tokens: ['Acme', ' '] },
        })),
      })),
    ).toThrow(/required_tokens.*non-blank/u);
  });

  it('rejects blank #862 document regex and grounding entries fail-closed', () => {
    expect(() =>
      synthesizeProgramSpecFromDomain(linearDomain({
        'intake.documents_json': JSON.stringify(validDocuments({
          fidelity_floor: { required_patterns: [' '] },
        })),
      })),
    ).toThrow(/required_patterns.*non-blank/u);

    expect(() =>
      synthesizeProgramSpecFromDomain(linearDomain({
        'intake.documents_json': JSON.stringify(validDocuments({
          fidelity_floor: { source_grounded_extractors: ['names'] },
        })),
      })),
    ).toThrow(/source_grounded_extractors.*capitalized_names/u);
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

function writeTempSpec(specYaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pgas-new-documents-load-'));
  const specPath = join(dir, 'specs.yml');
  writeFileSync(specPath, stripConventionSidecars(specYaml));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return specPath;
}
