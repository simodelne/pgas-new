import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  parseWiringManifest,
  type WiringAvailableProgram,
} from '../../src/pgas-new/wiring-manifest.js';
import {
  synthesizeProgramSpecFromDomain,
  type SynthesizedSpec,
} from '../../src/foundry-program/synthesizer.js';

const VALID_MANIFEST = `
schema_version: 1
repo:
  kind: existing_repo
  package_manager: npm
pgas:
  server_package: "@simodelne/pgas-server"
  allowed_imports:
    - "@simodelne/pgas-server/plugin.js"
    - "@simodelne/pgas-server/create-server.js"
    - "@simodelne/pgas-server/client.js"
    - "@simodelne/pgas-server/channels/index.js"
    - "@simodelne/pgas-server/routes/index.js"
paths:
  programs_dir: "programs"
  audit_dir: "audit"
  pgas_new_dir: ".pgas/pgas-new"
registration:
  strategy: curator_request
verification:
  commands:
    install: "npm install --no-audit --no-fund"
    typecheck: "npm run typecheck"
    test: "npm test"
curator:
  github_owner: simodelne
  github_repo: simoneos
`;

const MANIFEST_ENTRY: WiringAvailableProgram = {
  slug: 'research',
  target_spec: 'SimoneOS Legal Research',
  provides: 'delegation_research_agent',
};

const RESEARCH_DEMAND = {
  children: [
    {
      id: 'research',
      stage: 'dispatch_research',
      synthesize_child: {
        kind: 'research_agent',
        research_backend: 'host_connector',
        purpose: 'legal research',
        result_fields: { summary: 'string' },
      },
      payload_map: { 'request.topic': 'inputs.user_text' },
      result_path: 'dispatch_research.delegation.research.result',
      max_delegated_rounds: 12,
      optional: true,
    },
  ],
};

const LINEAR_DOMAIN: Record<string, unknown> = {
  'program.slug': 'manifest-driven-parent',
  'program.name': 'Manifest Driven Parent',
  'program.target_dir': '/tmp/manifest-driven-parent',
  'intake.purpose': 'Dispatch backed research and finish.',
  'intake.entry_channel': 'user_text',
  'intake.stages_json': JSON.stringify([
    {
      slug: 'intake',
      is_bootstrap: true,
      domain_spec: {
        reads: ['inputs.user_text'],
        produces: { result_json: { summary: 'string' } },
        rules: ['Capture the requested legal research topic.'],
        invariants: ['The topic is preserved for delegation.'],
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
  'intake.delegation_json': JSON.stringify(RESEARCH_DEMAND),
};

describe('manifest-driven connector schema', () => {
  it('F-1 accepts available_programs entries and preserves backward compatibility without them', () => {
    const withAvailablePrograms = parseWiringManifest(`${VALID_MANIFEST}
available_programs:
  - slug: research
    target_spec: "SimoneOS Legal Research"
    provides: delegation_research_agent
    payload_map:
      request.topic: inputs.user_text
    result_path: dispatch_research.delegation.research.result
`);

    expect(withAvailablePrograms.ok).toBe(true);
    expect(withAvailablePrograms.errors).toEqual([]);
    expect(withAvailablePrograms.manifest?.available_programs).toEqual([
      {
        ...MANIFEST_ENTRY,
        payload_map: { 'request.topic': 'inputs.user_text' },
        result_path: 'dispatch_research.delegation.research.result',
      },
    ]);

    expect(parseWiringManifest(VALID_MANIFEST)).toMatchObject({ ok: true, errors: [] });
  });

  it('F-1 rejects malformed available_programs declarations', () => {
    const result = parseWiringManifest(`${VALID_MANIFEST}
available_programs:
  - slug: "Bad Slug"
    provides: delegation_document_ingest
    payload_map: []
    result_path: research
  - slug: research
    target_spec: ""
    provides: delegation_research_agent
    payload_map:
      request.topic: ""
`);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'available_programs[0].slug must be a non-empty logical identifier',
      'available_programs[0].target_spec must be a non-empty string',
      'available_programs[0].provides must be one of: delegation_research_agent',
      'available_programs[0].payload_map must be an object when present',
      'available_programs[0].result_path must be a non-empty dotted path',
      'available_programs[1].target_spec must be a non-empty string',
      'available_programs[1].payload_map.request.topic must be a non-empty string',
    ]));
  });
});

describe('manifest-driven connector foundry falsifier', () => {
  it.fails('F-3 proves the manifest reuse gap while availablePrograms is still dead plumbing', () => {
    const artifact = synthesizeResearchDemand([MANIFEST_ENTRY]);
    const parsed = load(artifact.spec_yaml) as ParsedDelegationSpec;
    const child = artifact.synthesis_context.delegation?.children?.[0] as Record<string, unknown> | undefined;

    expect(parsed.channels.research_call.target_spec).toBe('SimoneOS Legal Research');
    expect(artifact.child_artifacts).toBeUndefined();
    expect(artifact.contracts_ts).not.toContain('ResearchHostConnector');
    expect((artifact.child_artifacts ?? []).map((childArtifact) => childArtifact.contracts_ts).join('\n'))
      .not.toContain('ResearchHostConnector');
    expect(artifact.capability_gaps ?? []).not.toContainEqual(expect.objectContaining({
      capability: 'delegation_research_agent',
    }));
    expect(artifact.registration_ts).toContain('SimoneOS Legal Research');
    expect(artifact.registration_ts).toContain('research');
    expect(child).toMatchObject({
      target_spec: 'SimoneOS Legal Research',
      registered_name: 'research',
    });
    expect(child).not.toHaveProperty('synthesize_child');
  });

  it('Case B emits the synthesized ResearchHostConnector stub and gap when no manifest entry is available', () => {
    expectStubbedResearchFallback(synthesizeResearchDemand([]));
  });

  it('Case B negative keeps the stub path when the manifest provides tag does not match the demand', () => {
    const nonMatchingEntry = {
      slug: 'document-ingest',
      target_spec: 'SimoneOS Document Ingest',
      provides: 'delegation_document_ingest',
    } as unknown as WiringAvailableProgram;

    expectStubbedResearchFallback(synthesizeResearchDemand([nonMatchingEntry]));
  });
});

function synthesizeResearchDemand(availablePrograms: WiringAvailableProgram[]): SynthesizedSpec {
  return synthesizeProgramSpecFromDomain(LINEAR_DOMAIN, {
    targetKind: 'existing_repo',
    availablePrograms,
  });
}

function expectStubbedResearchFallback(artifact: SynthesizedSpec): void {
  const parsed = load(artifact.spec_yaml) as ParsedDelegationSpec;
  const childArtifacts = artifact.child_artifacts ?? [];
  const child = childArtifacts[0];

  expect(parsed.channels.research_call.target_spec).toBe('research');
  expect(childArtifacts).toHaveLength(1);
  expect(child?.contracts_ts).toContain('ResearchHostConnector');
  expect(child?.capability_gaps).toEqual(expect.arrayContaining([
    expect.objectContaining({
      capability: 'delegation_research_agent',
      connector_slug: 'research',
    }),
  ]));
  expect(artifact.capability_gaps).toEqual(expect.arrayContaining([
    expect.objectContaining({
      capability: 'delegation_research_agent',
      connector_slug: 'research',
    }),
  ]));
}

interface ParsedDelegationSpec {
  channels: Record<string, Record<string, unknown>>;
}
