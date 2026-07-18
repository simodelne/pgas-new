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
    provides: delegation_unknown_tag
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
      'available_programs[0].provides must be one of: delegation_research_agent, delegation_document_ingest, delegation_review',
      'available_programs[0].payload_map must be an object when present',
      'available_programs[0].result_path must be a non-empty dotted path',
      'available_programs[1].target_spec must be a non-empty string',
      'available_programs[1].payload_map.request.topic must be a non-empty string',
    ]));
  });
});

describe('manifest-driven connector foundry falsifier', () => {
  it('F-3 rewrites a backed research demand to manifest target_spec reuse', () => {
    expectManifestReuse(synthesizeResearchDemand([MANIFEST_ENTRY]));
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

  it('real simoneos manifest fixture wires legal research and leaves sibling entries inert', () => {
    // Scope note: delegation v1 validates exactly one child, so this fixture proves
    // sibling manifest entries do not interfere rather than attempting 3-way fan-out.
    const realSimoneosPrograms = [
      MANIFEST_ENTRY,
      {
        slug: 'document-ingest',
        target_spec: 'SimoneOS Document Ingest',
        provides: 'delegation_document_ingest',
      },
      {
        slug: 'contract-review-service',
        target_spec: 'contract-review-service',
        provides: 'delegation_contract_review',
      },
    ] as unknown as WiringAvailableProgram[];

    const artifact = synthesizeResearchDemand(realSimoneosPrograms);

    expectManifestReuse(artifact);
    expect(artifact.registration_ts).not.toContain('document-ingest');
    expect(artifact.registration_ts).not.toContain('contract-review-service');
  });
});

describe('manifest-driven agent reuse (Slice A: document-ingest + review)', () => {
  for (const scenario of [DOCUMENT_INGEST_CASE, REVIEW_CASE]) {
    it(`Case A wires the ${scenario.label} child to the manifest program's target_spec + registry key`, () => {
      expectAgentReuse(synthesizeReuseAgentDemand(scenario, [manifestEntryFor(scenario)]), scenario);
    });

    it(`KILL TEST — removing the ${scenario.label} manifest entry flips reuse off (fallback)`, () => {
      expectAgentReuseFallback(synthesizeReuseAgentDemand(scenario, []), scenario);
    });

    it(`Case B negative — a non-matching provides tag does not wire the ${scenario.label} child`, () => {
      const nonMatching: WiringAvailableProgram = {
        slug: scenario.slug,
        target_spec: scenario.targetSpec,
        provides: 'delegation_research_agent',
      };
      expectAgentReuseFallback(synthesizeReuseAgentDemand(scenario, [nonMatching]), scenario);
    });
  }

  it('reuse is target_spec-keyed: a manifest ingest entry does not wire a review child', () => {
    // The ingest manifest entry names "SimoneOS Document Ingest"; a review child
    // names "contract-review-service" — no target_spec/slug match, so the review
    // child falls back even though a valid document-ingest entry is present.
    expectAgentReuseFallback(
      synthesizeReuseAgentDemand(REVIEW_CASE, [manifestEntryFor(DOCUMENT_INGEST_CASE)]),
      REVIEW_CASE,
    );
  });
});

function synthesizeResearchDemand(availablePrograms: WiringAvailableProgram[]): SynthesizedSpec {
  return synthesizeProgramSpecFromDomain(LINEAR_DOMAIN, {
    targetKind: 'existing_repo',
    availablePrograms,
  });
}

// Slice A: reuse of the existing simoneos document-ingest / review agents.
// These children are target_spec-only from the notebook (nothing to synthesize),
// so the manifest match rule validate-and-stamps registered_name + normalizes
// target_spec to the canonical manifest spec name — riding the same target_spec
// reuse machinery as delegation_research_agent.

interface ReuseAgentCase {
  label: string;
  childId: string;
  stage: string;
  channel: string;
  targetSpec: string;
  slug: string;
  provides: WiringAvailableProgram['provides'];
}

const DOCUMENT_INGEST_CASE: ReuseAgentCase = {
  label: 'document-ingest',
  childId: 'document_ingest',
  stage: 'dispatch_ingest',
  channel: 'document_ingest_call',
  targetSpec: 'SimoneOS Document Ingest',
  slug: 'document-ingest',
  provides: 'delegation_document_ingest',
};

const REVIEW_CASE: ReuseAgentCase = {
  label: 'review',
  childId: 'review',
  stage: 'dispatch_review',
  channel: 'review_call',
  targetSpec: 'contract-review-service',
  slug: 'contract-review-service',
  provides: 'delegation_review',
};

function reuseAgentDomain(scenario: ReuseAgentCase): Record<string, unknown> {
  return {
    'program.slug': `manifest-reuse-${scenario.label}`,
    'program.name': `Manifest Reuse ${scenario.label}`,
    'program.target_dir': `/tmp/manifest-reuse-${scenario.label}`,
    'intake.purpose': `Reuse the existing simoneos ${scenario.label} agent via delegation.`,
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify([
      {
        slug: 'intake',
        is_bootstrap: true,
        domain_spec: {
          reads: ['inputs.user_text'],
          produces: { result_json: { topic: 'string' } },
          rules: ['Capture the requested contract-revision input.'],
          invariants: ['The input is preserved for delegation.'],
        },
      },
      { slug: scenario.stage },
      { slug: 'complete', is_terminal: true },
    ]),
    'intake.transitions_json': JSON.stringify([
      { from: 'intake', to: scenario.stage, trigger: 'started', guard_field: 'intake.started' },
      { from: scenario.stage, to: 'complete', trigger: 'done', guard_field: `${scenario.stage}.ready` },
    ]),
    'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: `${scenario.stage}.ready` }),
    'intake.delegation_json': JSON.stringify({
      children: [
        {
          id: scenario.childId,
          stage: scenario.stage,
          target_spec: scenario.targetSpec,
          payload_map: { 'request.topic': 'inputs.user_text' },
          result_path: `${scenario.stage}.delegation.${scenario.childId}.result`,
          max_delegated_rounds: 12,
          optional: true,
        },
      ],
    }),
  };
}

function manifestEntryFor(scenario: ReuseAgentCase): WiringAvailableProgram {
  return { slug: scenario.slug, target_spec: scenario.targetSpec, provides: scenario.provides };
}

function synthesizeReuseAgentDemand(
  scenario: ReuseAgentCase,
  availablePrograms: WiringAvailableProgram[],
): SynthesizedSpec {
  return synthesizeProgramSpecFromDomain(reuseAgentDomain(scenario), {
    targetKind: 'existing_repo',
    availablePrograms,
  });
}

function allowedTargetProgramsFrom(registrationTs: string | undefined): string[] {
  const match = /allowedTargetPrograms:\s*\[([^\]]*)\]/u.exec(registrationTs ?? '');
  if (!match) {
    return [];
  }
  return match[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^['"]|['"]$/gu, ''))
    .filter((entry) => entry.length > 0);
}

function expectAgentReuse(artifact: SynthesizedSpec, scenario: ReuseAgentCase): void {
  const parsed = load(artifact.spec_yaml) as ParsedDelegationSpec;
  const child = artifact.synthesis_context.delegation?.children?.[0] as Record<string, unknown> | undefined;

  expect(parsed.channels[scenario.channel].target_spec).toBe(scenario.targetSpec);
  expect(artifact.child_artifacts).toBeUndefined();
  expect(child).toMatchObject({
    target_spec: scenario.targetSpec,
    registered_name: scenario.slug,
  });
  expect(child).not.toHaveProperty('synthesize_child');
  // allowedTargetPrograms carries BOTH the spec name and the registry key.
  const allowed = allowedTargetProgramsFrom(artifact.registration_ts);
  expect(allowed).toContain(scenario.targetSpec);
  expect(allowed).toContain(scenario.slug);
  // The reuse smoke variant registers an inline stub child under the registry key.
  expect(artifact.smoke_test_ts).toContain('createManifestReuseStubChildEntry');
  expect(artifact.smoke_test_ts).toContain(`name: '${scenario.slug}'`);
  expect(artifact.smoke_test_ts).not.toContain(`src/programs/${scenario.targetSpec}/`);
}

function expectAgentReuseFallback(artifact: SynthesizedSpec, scenario: ReuseAgentCase): void {
  const parsed = load(artifact.spec_yaml) as ParsedDelegationSpec;
  const child = artifact.synthesis_context.delegation?.children?.[0] as Record<string, unknown> | undefined;

  // No manifest match: the target_spec-only child stays as the author declared
  // it — no registered_name stamped, so allowedTargetPrograms carries ONLY the
  // spec name and the engine (F-2k) declines the un-allowed registry key.
  expect(parsed.channels[scenario.channel].target_spec).toBe(scenario.targetSpec);
  expect(child).toMatchObject({ target_spec: scenario.targetSpec });
  expect(child).not.toHaveProperty('registered_name');
  // The registry key is a distinct name from the spec name only for
  // document-ingest; when slug === target_spec (review) the singleton array
  // still proves no second reuse entry was stamped.
  const allowed = allowedTargetProgramsFrom(artifact.registration_ts);
  expect(allowed).toEqual([scenario.targetSpec]);
}

function expectManifestReuse(artifact: SynthesizedSpec): void {
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
  expect(artifact.smoke_test_ts).toContain('createManifestReuseStubChildEntry');
  expect(artifact.smoke_test_ts).toContain("name: 'research'");
  expect(artifact.smoke_test_ts).not.toContain("../src/programs/SimoneOS Legal Research/registration.js");
  expect(artifact.smoke_test_ts).not.toContain('src/programs/SimoneOS Legal Research/');
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
