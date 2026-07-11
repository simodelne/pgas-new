import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { loadSpecWithPatterns, validateSpecWiring, type ActionHandler } from '@simodelne/pgas-server/plugin.js';
import { handlers } from '../../src/foundry-program/handlers.js';
import {
  assertPreconditionVocabularyAlignment,
  synthesizeProgramSpecFromDomain,
} from '../../src/foundry-program/synthesizer.js';
import {
  clearSynthesizedArtifact,
  getSynthesizedArtifact,
} from '../../src/foundry-program/synthesizer-store.js';

const stages = [
  { slug: 'intake', is_bootstrap: true },
  { slug: 'triage' },
  { slug: 'resolved', is_terminal: true },
];

const transitions = [
  { from: 'intake', to: 'triage', trigger: 'ready', guard_field: 'intake.started' },
  { from: 'triage', to: 'resolved', trigger: 'summary_ready', guard_field: 'triage.summary_ready' },
];

const delegation = { triage: { target: 'human-review', when: 'severity_high' } };
const completion = { final_stage: 'resolved', guard_field: 'triage.summary_ready' };
const wiringManifestWithCrm = {
  schema_version: 1,
  repo: {
    kind: 'existing_repo',
    package_manager: 'npm',
  },
  pgas: {
    server_package: '@simodelne/pgas-server',
    allowed_imports: [
      '@simodelne/pgas-server/plugin.js',
      '@simodelne/pgas-server/create-server.js',
      '@simodelne/pgas-server/client.js',
      '@simodelne/pgas-server/channels/index.js',
      '@simodelne/pgas-server/routes/index.js',
    ],
  },
  paths: {
    programs_dir: 'programs',
    audit_dir: 'audit',
    pgas_new_dir: '.pgas/pgas-new',
  },
  registration: {
    strategy: 'curator_request',
  },
  verification: {
    commands: {
      install: 'npm install --no-audit --no-fund',
      typecheck: 'npm run typecheck',
      test: 'npm test',
    },
  },
  curator: {
    github_owner: 'simodelne',
    github_repo: 'simoneos',
  },
  integrations: [
    {
      name: 'crm',
      kind: 'http_api',
      import: '@acme/crm-client',
      factory: 'createCrmClient',
      methods: ['lookupAccount'],
      config_env: ['CRM_BASE_URL', 'CRM_TOKEN'],
    },
  ],
};

function domain(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'program.slug': 'incident-triage',
    'program.name': 'Incident Triage',
    'program.target_dir': '/tmp/incident-triage',
    'program.design_path': 'design',
    'intake.purpose': 'Route incoming incidents into a triage workflow.',
    'intake.entry_channel': 'user_text',
    'intake.stages_json': JSON.stringify(stages),
    'intake.transitions_json': JSON.stringify(transitions),
    'intake.delegation_json': JSON.stringify(delegation),
    'intake.completion_json': JSON.stringify(completion),
    ...overrides,
  };
}

describe('synthesize_program_spec handler', () => {
  it('mechanically synthesizes, validates, and stores YAML without returning it', async () => {
    clearSynthesizedArtifact('session-synth');

    const result = await handlers.synthesize_program_spec({
      sessionId: 'session-synth',
      domain: domain(),
    });

    expect(result).toEqual({
      kind: 'mechanical_synthesis',
      no_llm_call: true,
      mode_names: ['intake', 'triage', 'resolved'],
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result).not.toHaveProperty('spec_yaml');

    const artifact = getSynthesizedArtifact('session-synth');
    expect(artifact).toMatchObject({
      mode_names: ['intake', 'triage', 'resolved'],
      sha256: (result as { sha256: string }).sha256,
    });
    expect(typeof artifact?.created_at).toBe('string');

    const parsed = load(artifact?.spec_yaml ?? '') as {
      name: string;
      initial: string;
      terminal: string[];
      modes: Record<string, { channels?: string[]; transitions?: Array<{ target: string; guard?: { path?: string } }>; vocabulary?: string[] }>;
      projection: Record<string, { include: string[]; exclude: string[] }>;
      schema: Record<string, string>;
      action_map: Record<string, {
        channel?: string;
        result_path?: string;
        mutations: Array<{ path: string; value?: unknown; from_arg?: string }>;
      }>;
      proceed_to: Record<string, string>;
      reactions: Record<string, { event: string; watch: string[]; write_scope: string[] }>;
      guidance: Record<string, string[]>;
    };

    expect(parsed.name).toBe('incident-triage');
    expect(parsed.initial).toBe('intake');
    expect(parsed.terminal).toEqual(['resolved']);
    expect(Object.keys(parsed.modes)).toEqual(['intake', 'triage', 'resolved']);
    expect(parsed.modes.intake.channels).toEqual(expect.arrayContaining(['user_text']));
    expect(parsed.modes.intake.transitions).toEqual([
      { target: 'triage', guard: { kind: 'FieldTruthy', path: 'intake.started' } },
    ]);
    expect(parsed.modes.triage.transitions).toEqual([
      { target: 'resolved', guard: { kind: 'FieldTruthy', path: 'triage.summary_ready' } },
    ]);
    expect(parsed.schema).toMatchObject({
      'intake.started': 'boolean',
      'inputs.initial_user_text': 'string',
      'triage.summary_ready': 'boolean',
      'triage.output': 'object',
      'triage.output.result_json': 'string',
      'triage.output.items_json': 'string',
    });
    expect(parsed.projection.triage.include).toContain('inputs.initial_user_text');
    expect(parsed.reactions.capture_initial_entry_input).toEqual({
      event: 'AfterIngestion',
      watch: ['inputs.user_text'],
      write_scope: ['inputs.initial_user_text'],
    });
    expect(parsed.modes.triage.vocabulary).toEqual(expect.arrayContaining(['complete_triage']));
    expect(parsed.modes.triage.vocabulary).not.toContain('example_action');
    expect(parsed.proceed_to.complete_triage).toBe('resolved');
    expect(parsed.action_map).toHaveProperty('begin_work');
    expect(parsed.action_map).not.toHaveProperty('example_action');
    expect(parsed.action_map.complete_triage.channel).toBe('stage_output');
    expect(parsed.action_map.complete_triage.result_path).toBe('triage.output');
    expect(parsed.action_map.complete_triage.mutations).toEqual([
      { op: 'MSet', path: 'triage.summary_ready', value: true },
    ]);
    expect(parsed.action_map.complete_triage.mutations.map((mutation) => mutation.path)).toEqual([
      'triage.summary_ready',
    ]);
    expect(parsed.guidance.triage.join('\n')).toContain('delegation');
    expect(artifact?.contracts_ts).toContain('triage');
    expect(artifact?.handlers_ts).toContain('runTriage');
    expect(artifact?.handlers_ts).toContain('async begin_work(payload)');
    expect(artifact?.handlers_ts).toContain('capture_initial_entry_input');
    expect(artifact?.handlers_ts).toContain('inputs.initial_user_text');
    expect(artifact?.handlers_ts).toContain('async session_status(payload)');
    expect(artifact?.handlers_ts).toContain("control: 'session_status'");
    expect(artifact?.handlers_ts).not.toContain('stage_action_stub');
    expect(artifact?.handlers_index_ts).toContain('async begin_work(payload)');
    expect(artifact?.smoke_test_ts).toContain('generated program smoke');
    expect(smokeEffectNames(artifact?.smoke_test_ts ?? '')).toEqual(['begin_work', 'complete_triage']);

    expect(() => loadSpecWithPatterns(writeTempSpec(artifact?.spec_yaml ?? ''))).not.toThrow();
    expectGeneratedHandlersToWire(artifact?.spec_yaml ?? '', artifact?.handlers_ts ?? '');
    expectGeneratedHandlersToWire(artifact?.spec_yaml ?? '', artifact?.handlers_index_ts ?? '');
  });

  it('does not emit a begin_work handler when the synthesized action_map does not declare begin_work', () => {
    const artifact = synthesizeProgramSpecFromDomain(domain({
      'intake.stages_json': JSON.stringify([
        { slug: 'intake', is_bootstrap: true },
        { slug: 'draft' },
        { slug: 'blocked', is_terminal: true },
        { slug: 'resolved', is_terminal: true },
      ]),
      'intake.transitions_json': JSON.stringify([
        { from: 'intake', to: 'draft', trigger: 'draft', guard_field: 'intake.draft_requested' },
        { from: 'intake', to: 'blocked', trigger: 'block', guard_field: 'intake.blocked' },
        { from: 'draft', to: 'resolved', trigger: 'done', guard_field: 'draft.ready' },
      ]),
      'intake.completion_json': JSON.stringify({ final_stage: 'resolved', guard_field: 'draft.ready' }),
    }));
    const parsed = load(artifact.spec_yaml) as {
      modes: Record<string, { vocabulary?: string[] }>;
      action_map: Record<string, unknown>;
    };

    expect(parsed.action_map).not.toHaveProperty('begin_work');
    expect(parsed.modes.intake.vocabulary).toEqual(expect.arrayContaining([
      'advance_intake_to_draft',
      'advance_intake_to_blocked',
    ]));
    expect(parsed.modes.intake.vocabulary).not.toContain('begin_work');
    expect(artifact.handlers_ts).not.toContain('async begin_work(payload)');
    expect(artifact.handlers_index_ts).not.toContain('async begin_work(payload)');
    expect(smokeEffectNames(artifact.smoke_test_ts)).not.toContain('begin_work');
    expectGeneratedHandlersToWire(artifact.spec_yaml, artifact.handlers_ts);
    expectGeneratedHandlersToWire(artifact.spec_yaml, artifact.handlers_index_ts);
  });

  it('canonicalizes prose entry_channel answers that mention frontend_intake', () => {
    const proseEntryChannel = 'SimoneOS frontend structured intake plus user_text. Fields: client_name, matter_or_service_type, jurisdiction, complexity_tier, target_deadline, constraints, budget_signal, currency, requested fee_structure, optional rate_card/precedent. Frontend supports edit/review/finalize/export.';
    const rawDomain = domain({ 'intake.entry_channel': proseEntryChannel });
    const artifact = synthesizeProgramSpecFromDomain(rawDomain);
    const parsed = load(artifact.spec_yaml) as {
      channels: Record<string, unknown>;
      control_plane: { controls: { ask: { dispatch: Array<Record<string, unknown>> } } };
      ingestion: Record<string, unknown>;
      modes: Record<string, { channels?: string[] }>;
      projection: Record<string, { include: string[] }>;
      reactions: Record<string, { watch: string[]; write_scope: string[] }>;
      schema: Record<string, string>;
    };
    const normalizedChannel = 'frontend_intake';

    expect(rawDomain['intake.entry_channel']).toBe(proseEntryChannel);
    expect(normalizedChannel).toMatch(/^[a-z0-9_]+$/u);
    expect(normalizedChannel.length).toBeLessThanOrEqual(64);
    expect(parsed.channels).toHaveProperty(normalizedChannel);
    expect(parsed.channels).toHaveProperty('user_text');
    expect(parsed.channels).not.toHaveProperty(proseEntryChannel);
    expect(parsed.ingestion).toHaveProperty(normalizedChannel);
    expect(parsed.ingestion).not.toHaveProperty(proseEntryChannel);
    expect(parsed.schema).toHaveProperty(`inputs.${normalizedChannel}`, 'string');
    expect(parsed.schema).toHaveProperty(`inputs.initial_${normalizedChannel}`, 'string');
    expect(parsed.modes.intake.channels).toContain(normalizedChannel);
    expect(parsed.projection.intake.include).toEqual(expect.arrayContaining([
      `inputs.${normalizedChannel}`,
      `inputs.initial_${normalizedChannel}`,
    ]));
    expect(parsed.reactions.capture_initial_entry_input).toEqual({
      event: 'AfterIngestion',
      watch: [`inputs.${normalizedChannel}`],
      write_scope: [`inputs.initial_${normalizedChannel}`],
    });
    expect(artifact.smoke_test_ts).toContain(`defaultChannel: '${normalizedChannel}'`);
    expect(artifact.smoke_test_ts).not.toContain(proseEntryChannel);
    expect(artifact.synthesis_context.entry_channel).toBe(normalizedChannel);
    expect(parsed.control_plane.controls.ask.dispatch).toContainEqual(expect.objectContaining({
      op: 'trigger',
      channel: normalizedChannel,
    }));
  });

  it('falls back to user_text for empty entry_channel ids and preserves valid short ids', () => {
    const invalidArtifact = synthesizeProgramSpecFromDomain(domain({ 'intake.entry_channel': ' !!! ' }));
    const invalidParsed = load(invalidArtifact.spec_yaml) as {
      channels: Record<string, unknown>;
      ingestion: Record<string, unknown>;
    };
    expect(invalidParsed.channels).toHaveProperty('user_text');
    expect(invalidParsed.ingestion).toHaveProperty('user_text');
    expect(invalidArtifact.smoke_test_ts).toContain("defaultChannel: 'user_text'");
    expect(invalidArtifact.synthesis_context.entry_channel).toBe('user_text');

    const validArtifact = synthesizeProgramSpecFromDomain(domain({ 'intake.entry_channel': 'webhook_event_1' }));
    const validParsed = load(validArtifact.spec_yaml) as {
      channels: Record<string, unknown>;
      control_plane: { controls: { ask: { dispatch: Array<Record<string, unknown>> } } };
      ingestion: Record<string, unknown>;
    };
    expect(validParsed.channels).toHaveProperty('webhook_event_1');
    expect(validParsed.ingestion).toHaveProperty('webhook_event_1');
    expect(validArtifact.smoke_test_ts).toContain("defaultChannel: 'webhook_event_1'");
    expect(validArtifact.synthesis_context.entry_channel).toBe('webhook_event_1');
    expect(validParsed.control_plane.controls.ask.dispatch).toContainEqual(expect.objectContaining({
      op: 'trigger',
      channel: 'webhook_event_1',
    }));
  });

  it('records stage artifacts for an LLM-only program without importing unused stage contracts', () => {
    const artifact = synthesizeProgramSpecFromDomain({
      'program.slug': 'brief-summarizer',
      'program.name': 'Brief Summarizer',
      'program.target_dir': '/tmp/brief-summarizer',
      'program.design_path': 'design',
      'intake.purpose': 'Summarize a natural-language project brief into structured output.',
      'intake.entry_channel': 'user_text',
      'intake.stages_json': JSON.stringify([
        { slug: 'intake', is_bootstrap: true },
        { slug: 'brief_summary' },
        { slug: 'complete', is_terminal: true },
      ]),
      'intake.transitions_json': JSON.stringify([
        { from: 'intake', to: 'brief_summary', trigger: 'started', guard_field: 'intake.started' },
        { from: 'brief_summary', to: 'complete', trigger: 'summarized', guard_field: 'brief_summary.done' },
      ]),
      'intake.delegation_json': JSON.stringify({ enabled: false }),
      'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'brief_summary.done' }),
    });

    expect(artifact.body_stage_slugs).toEqual(['intake', 'brief_summary']);
    expect(artifact.handlers_ts).not.toContain('./contracts.js');
    expect(artifact.handlers_index_ts).not.toContain('../contracts.js');
    expect(artifact.handlers_ts).toContain('async complete_brief_summary(payload)');
  });

  it('carries stage domain specs into runtime prompts for LLM reasoning stages', () => {
    const artifact = synthesizeProgramSpecFromDomain({
      'program.slug': 'brief-summarizer',
      'program.name': 'Brief Summarizer',
      'program.target_dir': '/tmp/brief-summarizer',
      'program.design_path': 'design',
      'intake.purpose': 'Summarize a natural-language project brief into structured output.',
      'intake.entry_channel': 'user_text',
      'intake.stages_json': JSON.stringify([
        { slug: 'intake', is_bootstrap: true },
        {
          slug: 'brief_summary',
          domain_spec: {
            reads: ['inputs.initial_user_text'],
            produces: {
              result_json: {
                stage: 'string',
                audience: 'string',
                deadline: 'string',
                constraint: 'string',
                decision: 'string',
              },
              items_json: 'string[]',
            },
            rules: ['Extract audience, deadline, constraint, and decision from the brief text.'],
            invariants: ['Do not invent billing changes when the brief excludes them.'],
          },
        },
        { slug: 'complete', is_terminal: true },
      ]),
      'intake.transitions_json': JSON.stringify([
        { from: 'intake', to: 'brief_summary', trigger: 'started', guard_field: 'intake.started' },
        { from: 'brief_summary', to: 'complete', trigger: 'summarized', guard_field: 'brief_summary.done' },
      ]),
      'intake.delegation_json': JSON.stringify({ enabled: false }),
      'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'brief_summary.done' }),
    });

    const parsed = load(artifact.spec_yaml) as {
      prompts: Record<string, string>;
      guidance: Record<string, string[]>;
      action_map: Record<string, { arg_descriptions?: Record<string, string> }>;
    };
    expect(parsed.prompts.brief_summary).toContain('Author-provided domain spec for brief_summary');
    expect(parsed.prompts.brief_summary).toContain('Extract audience, deadline, constraint, and decision');
    expect(parsed.guidance.brief_summary.join('\n')).toContain('Do not invent billing changes');
    expect(parsed.action_map.complete_brief_summary.arg_descriptions?.result_json).toContain('audience');
  });

  it('projects prior stage outputs into every later stateful stage', () => {
    const artifact = synthesizeProgramSpecFromDomain({
      'program.slug': 'refund-ledger-stateful-test',
      'program.name': 'Refund Ledger Stateful Test',
      'program.target_dir': '/tmp/refund-ledger-stateful-test',
      'program.design_path': 'design',
      'intake.purpose': 'Normalize a refund, apply policy, and post the resulting ledger entry.',
      'intake.entry_channel': 'user_text',
      'intake.stages_json': JSON.stringify([
        { slug: 'intake', is_bootstrap: true },
        { slug: 'normalize_refund' },
        { slug: 'apply_refund_policy' },
        { slug: 'ledger_posting' },
        { slug: 'complete', is_terminal: true },
      ]),
      'intake.transitions_json': JSON.stringify([
        { from: 'intake', to: 'normalize_refund', trigger: 'started', guard_field: 'intake.started' },
        { from: 'normalize_refund', to: 'apply_refund_policy', trigger: 'normalized', guard_field: 'normalize_refund.ready' },
        { from: 'apply_refund_policy', to: 'ledger_posting', trigger: 'policy_applied', guard_field: 'apply_refund_policy.ready' },
        { from: 'ledger_posting', to: 'complete', trigger: 'posted', guard_field: 'ledger_posting.ready' },
      ]),
      'intake.delegation_json': JSON.stringify({ enabled: false }),
      'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'ledger_posting.ready' }),
    });

    const parsed = load(artifact.spec_yaml) as {
      projection: Record<string, { include: string[] }>;
    };

    expect(parsed.projection.normalize_refund.include).toEqual(expect.arrayContaining([
      'inputs.initial_user_text',
      'normalize_refund.output',
    ]));
    expect(parsed.projection.apply_refund_policy.include).toEqual(expect.arrayContaining([
      'inputs.initial_user_text',
      'normalize_refund.output',
      'apply_refund_policy.output',
    ]));
    expect(parsed.projection.ledger_posting.include).toEqual(expect.arrayContaining([
      'inputs.initial_user_text',
      'normalize_refund.output',
      'apply_refund_policy.output',
      'ledger_posting.output',
    ]));
    expect(parsed.projection.complete.include).toEqual(expect.arrayContaining([
      'inputs.initial_user_text',
      'normalize_refund.output',
      'apply_refund_policy.output',
      'ledger_posting.output',
    ]));
  });

  it('seeds generated smoke input from initial input fields read by stateful domain specs', () => {
    const artifact = synthesizeProgramSpecFromDomain({
      'program.slug': 'stateful-smoke-input-test',
      'program.name': 'Stateful Smoke Input Test',
      'program.target_dir': '/tmp/stateful-smoke-input-test',
      'program.design_path': 'design',
      'intake.purpose': 'Normalize an input, apply a policy, and complete.',
      'intake.entry_channel': 'user_text',
      'intake.stages_json': JSON.stringify([
        { slug: 'intake', is_bootstrap: true },
        {
          slug: 'normalize_request',
          domain_spec: {
            reads: [
              'inputs.initial_user_text.order_id',
              'inputs.initial_user_text.original_amount_cents',
              'inputs.initial_user_text.refund_requested',
            ],
            produces: {
              result_json: {
                stage: 'string',
                order_id: 'string',
                original_amount_cents: 'number',
                refund_requested: 'boolean',
              },
              items_json: 'string[]',
            },
            rules: ['Parse the original entry-channel JSON request before normalizing.'],
            invariants: ['result_json.stage must equal normalize_request.'],
          },
        },
        {
          slug: 'apply_policy',
          domain_spec: {
            reads: [
              'normalize_request.output.result_json.order_id',
              'inputs.initial_user_text.delivered_days_ago',
            ],
            produces: {
              result_json: {
                stage: 'string',
                order_id: 'string',
                delivered_days_ago: 'number',
              },
              items_json: 'string[]',
            },
            rules: ['Read both prior stage output and the original entry-channel JSON request.'],
            invariants: ['order_id must be preserved from normalize_request.'],
          },
        },
        { slug: 'complete', is_terminal: true },
      ]),
      'intake.transitions_json': JSON.stringify([
        { from: 'intake', to: 'normalize_request', trigger: 'started', guard_field: 'intake.started' },
        { from: 'normalize_request', to: 'apply_policy', trigger: 'normalized', guard_field: 'normalize_request.ready' },
        { from: 'apply_policy', to: 'complete', trigger: 'done', guard_field: 'apply_policy.ready' },
      ]),
      'intake.delegation_json': JSON.stringify({ enabled: false }),
      'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'apply_policy.ready' }),
    });

    expect(artifact.smoke_test_ts).toContain('await harness.trigger(JSON.stringify({');
    expect(artifact.smoke_test_ts).toContain('order_id');
    expect(artifact.smoke_test_ts).toContain('original_amount_cents');
    expect(artifact.smoke_test_ts).toContain('refund_requested');
    expect(artifact.smoke_test_ts).toContain('delivered_days_ago');
    expect(artifact.smoke_test_ts).toContain('"delivered_days_ago": 14');
    expect(artifact.smoke_test_ts).not.toContain("await harness.trigger('start generated smoke');");
  });

  it('binds matching existing-repo external stages to declared manifest integrations in stored contracts', async () => {
    const sessionId = 'session-existing-repo-integration-synth';
    clearSynthesizedArtifact(sessionId);

    await handlers.synthesize_program_spec({
      sessionId,
      domain: domain({
        'repo.target_kind': 'existing_repo',
        'repo.wiring_manifest_json': JSON.stringify(wiringManifestWithCrm),
        'intake.purpose': 'Look up an account in the CRM and close the request.',
        'intake.stages_json': JSON.stringify([
          { slug: 'intake', is_bootstrap: true },
          { slug: 'crm_lookup' },
          { slug: 'resolved', is_terminal: true },
        ]),
        'intake.transitions_json': JSON.stringify([
          { from: 'intake', to: 'crm_lookup', trigger: 'ready', guard_field: 'intake.started' },
          { from: 'crm_lookup', to: 'resolved', trigger: 'done', guard_field: 'crm_lookup.ready' },
        ]),
        'intake.delegation_json': JSON.stringify({
          crm_lookup: { service: 'crm', operation: 'lookup account' },
        }),
        'intake.completion_json': JSON.stringify({ final_stage: 'resolved', guard_field: 'crm_lookup.ready' }),
      }),
    });

    const artifact = getSynthesizedArtifact(sessionId);
    expect(artifact?.stage_classification).toContainEqual(expect.objectContaining({
      slug: 'crm_lookup',
      archetype: 'external-adapter',
      adapter_kind: 'repo_integration',
      integration_name: 'crm',
      integration_import: '@acme/crm-client',
      integration_method: 'lookupAccount',
    }));
    expect(artifact?.contracts_ts).toContain('"adapter_kind": "repo_integration"');
    expect(artifact?.contracts_ts).toContain("adapter_kind?: 'in_memory_mock' | 'repo_integration';");
    expect(artifact?.handlers_ts).toContain("'repo_integration'");
    expect(artifact?.smoke_test_ts).toContain('repo_integration');
    expect(artifact?.smoke_test_ts).not.toContain('in_memory_mock');
  });

  it('carries author-provided stage domain specs into stored synthesis context and contracts', async () => {
    const sessionId = 'session-stage-domain-spec-contract';
    clearSynthesizedArtifact(sessionId);

    await handlers.synthesize_program_spec({
      sessionId,
      domain: domain({
        'intake.stages_json': JSON.stringify([
          { slug: 'intake', is_bootstrap: true },
          {
            slug: 'calculate_fee',
            domain_spec: {
              reads: ['inputs.initial_user_text.plan', 'inputs.initial_user_text.seats'],
              produces: {
                result_json: {
                  stage: 'string',
                  plan: 'string',
                  total_fee: 'number',
                },
                items_json: 'string[]',
              },
              rules: [
                'Parse the entry-channel JSON request before computing.',
                'total_fee = per_seat_rate * seats.',
              ],
              invariants: [
                'result_json.stage must equal calculate_fee.',
                'items_json must include the plan identifier.',
              ],
            },
          },
          { slug: 'resolved', is_terminal: true },
        ]),
        'intake.transitions_json': JSON.stringify([
          { from: 'intake', to: 'calculate_fee', trigger: 'ready', guard_field: 'intake.started' },
          { from: 'calculate_fee', to: 'resolved', trigger: 'done', guard_field: 'calculate_fee.ready' },
        ]),
        'intake.completion_json': JSON.stringify({
          final_stage: 'resolved',
          guard_field: 'calculate_fee.ready',
        }),
      }),
    });

    const artifact = getSynthesizedArtifact(sessionId);
    expect(artifact?.synthesis_context?.stages[1]).toMatchObject({
      slug: 'calculate_fee',
      domain_spec: {
        reads: ['inputs.initial_user_text.plan', 'inputs.initial_user_text.seats'],
        rules: expect.arrayContaining(['total_fee = per_seat_rate * seats.']),
      },
    });
    expect(artifact?.contracts_ts).toContain('export interface StageDomainSpec');
    expect(artifact?.contracts_ts).toContain('domain_spec: StageDomainSpec');
    expect(artifact?.contracts_ts).toContain('export const stageDomainSpecs');
    expect(artifact?.contracts_ts).toContain('"calculate_fee"');
    expect(artifact?.contracts_ts).toContain('total_fee = per_seat_rate * seats.');
  });

  it('repairs malformed rich stages_json persisted from the raw Q3 arg so domain_spec survives into stageDomainSpecs (issue #92)', () => {
    // The engine persists intake.stages_json from the raw tool `from_arg`
    // (there is no `from_result` mutation source), so a rich Q3 stages_json
    // that arrived with the known dropped-boundary-brace malformation reaches
    // synthesis unrepaired. Downstream synthesis must apply the same repair the
    // record_q3_stages handler applies, or every per-stage domain_spec is lost
    // (empty stageDomainSpecs) and fee-model params are ignored.
    const rich = (slug: string, param: string): string =>
      `{"slug":"${slug}","domain_spec":{"reads":["inputs.initial_user_text"],"produces":{"result_json":{"stage":"string","${param}":"number"},"items_json":["${param}:<${param}>"]},"rules":["Apply ${param}."],"invariants":["result_json.stage must equal ${slug}."]}`;
    // Each rich stage object is missing its OUTER closing brace before the next
    // `,{"slug":...}` boundary — the exact qwen malformation.
    const malformedStagesJson = `[{"slug":"intake","is_bootstrap":true},${rich('fee_modelling', 'cap_premium_pct')},{"slug":"complete","is_terminal":true}]`;

    const artifact = synthesizeProgramSpecFromDomain(domain({
      'intake.stages_json': malformedStagesJson,
      'intake.transitions_json': JSON.stringify([
        { from: 'intake', to: 'fee_modelling', trigger: 'ready', guard_field: 'intake.started' },
        { from: 'fee_modelling', to: 'complete', trigger: 'done', guard_field: 'fee_modelling.ready' },
      ]),
      'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'fee_modelling.ready' }),
    }));

    // stageDomainSpecs must be populated with the fee param, not empty.
    expect(artifact.contracts_ts).toContain('export const stageDomainSpecs');
    expect(artifact.contracts_ts).toContain('cap_premium_pct');
    expect(artifact.contracts_ts).toContain('Apply cap_premium_pct.');
    expect(artifact.contracts_ts).not.toContain('export const stageDomainSpecs = {} as');
  });

  it('emits mixed guarded and unguarded transitions and parses them through the engine loader', async () => {
    const sessionId = 'session-mixed-transition-guards';
    clearSynthesizedArtifact(sessionId);

    await handlers.synthesize_program_spec({
      sessionId,
      domain: domain({
        'intake.stages_json': JSON.stringify([
          { slug: 'alpha', is_bootstrap: true },
          { slug: 'beta' },
          { slug: 'charlie' },
          { slug: 'delta' },
          { slug: 'terminal', is_terminal: true },
        ]),
        'intake.transitions_json': JSON.stringify([
          { from: 'alpha', to: 'beta', trigger: 'auto' },
          { from: 'beta', to: 'charlie', trigger: 'done', guard_field: 'beta.done' },
          { from: 'charlie', to: 'delta', trigger: 'auto', guard_field: '' },
          { from: 'delta', to: 'terminal', trigger: 'complete', guard_field: 'delta.ready' },
        ]),
        'intake.completion_json': JSON.stringify({
          final_stage: 'terminal',
          guard_field: 'completion.ready',
        }),
      }),
    });

    const artifact = getSynthesizedArtifact(sessionId);
    const parsed = load(artifact?.spec_yaml ?? '') as {
      modes: Record<string, { transitions?: Array<{ target: string; guard?: { path?: string } }> }>;
    };

    expect(parsed.modes.alpha.transitions).toEqual([{ target: 'beta' }]);
    expect(parsed.modes.beta.transitions).toEqual([
      { target: 'charlie', guard: { kind: 'FieldTruthy', path: 'beta.done' } },
    ]);
    expect(parsed.modes.charlie.transitions).toEqual([{ target: 'delta' }]);
    expect(parsed.modes.delta.transitions).toEqual([
      { target: 'terminal', guard: { kind: 'FieldTruthy', path: 'completion.ready' } },
    ]);
    expect(() => loadSpecWithPatterns(writeTempSpec(artifact?.spec_yaml ?? ''))).not.toThrow();
  });

  it('rejects completion without a completion guard field', async () => {
    await expect(
      handlers.synthesize_program_spec({
        sessionId: 'session-missing-completion-guard',
        domain: domain({
          'intake.completion_json': JSON.stringify({ final_stage: 'resolved' }),
        }),
      }),
    ).rejects.toThrow(/completion.*guard_field/u);
  });

  it('rejects intake with fewer than 3 stages', async () => {
    for (const stageList of [[], [{ slug: 'intake' }], [{ slug: 'intake' }, { slug: 'resolved' }]]) {
      await expect(
        handlers.synthesize_program_spec({
          sessionId: `session-${stageList.length}-stages`,
          domain: domain({
            'intake.stages_json': JSON.stringify(stageList),
            'intake.transitions_json': JSON.stringify(transitionsFor(stageList.map((stage) => stage.slug))),
            'intake.completion_json': JSON.stringify({
              final_stage: stageList.at(-1)?.slug ?? 'missing',
              guard_field: 'work.ready',
            }),
          }),
        }),
      ).rejects.toThrow(new RegExp(`synthesizer expects at least 3 stages; got ${stageList.length}`));
    }
  });

  it('synthesizes 5-stage intake graphs and parses them through the engine loader', async () => {
    const stageNames = ['intake', 'classify', 'investigate', 'resolve', 'closed'];
    const result = await synthesizeStageGraph('session-five-stages', stageNames);
    const artifact = getSynthesizedArtifact('session-five-stages');
    const parsed = load(artifact?.spec_yaml ?? '') as {
      modes: Record<string, { vocabulary?: string[] }>;
      schema: Record<string, string>;
      action_map: Record<string, { result_path?: string; mutations: Array<{ path: string }> }>;
      proceed_to: Record<string, string>;
    };

    expect(result).toMatchObject({ mode_names: stageNames });
    expect(Object.keys(parsed.modes)).toEqual(stageNames);
    expect(parsed.action_map).not.toHaveProperty('example_action');
    expect(parsed.modes.classify.vocabulary).toEqual(expect.arrayContaining(['complete_classify']));
    expect(parsed.modes.investigate.vocabulary).toEqual(expect.arrayContaining(['complete_investigate']));
    expect(parsed.modes.resolve.vocabulary).toEqual(expect.arrayContaining(['complete_resolve']));
    expect(parsed.proceed_to).toMatchObject({
      complete_classify: 'investigate',
      complete_investigate: 'resolve',
      complete_resolve: 'closed',
    });
    expect(parsed.action_map.complete_classify.mutations.map((mutation) => mutation.path)).toEqual([
      'classify.ready',
      'classify.result_json',
      'classify.items_json',
    ]);
    expect(parsed.action_map.complete_investigate.mutations.map((mutation) => mutation.path)).toEqual([
      'investigate.ready',
    ]);
    expect(parsed.action_map.complete_investigate.result_path).toBe('investigate.output');
    expect(parsed.action_map.complete_resolve.mutations.map((mutation) => mutation.path)).toEqual([
      'resolve.ready',
    ]);
    expect(parsed.action_map.complete_resolve.result_path).toBe('resolve.output');
    expect(parsed.schema).toMatchObject({
      'classify.result_json': 'string',
      'classify.items_json': 'string',
      'investigate.output': 'object',
      'investigate.output.result_json': 'string',
      'investigate.output.items_json': 'string',
      'resolve.output': 'object',
      'resolve.output.result_json': 'string',
      'resolve.output.items_json': 'string',
    });
    expect(() => loadSpecWithPatterns(writeTempSpec(artifact?.spec_yaml ?? ''))).not.toThrow();
  });

  it('emits distinct branch and loop actions that only open one outgoing guard', async () => {
    const sessionId = 'session-branch-loop-actions';
    clearSynthesizedArtifact(sessionId);

    await handlers.synthesize_program_spec({
      sessionId,
      domain: domain({
        'intake.stages_json': JSON.stringify([
          { slug: 'intake', is_bootstrap: true },
          { slug: 'draft' },
          { slug: 'review' },
          { slug: 'revision' },
          { slug: 'complete', is_terminal: true },
        ]),
        'intake.transitions_json': JSON.stringify([
          { from: 'intake', to: 'draft', trigger: 'started', guard_field: 'intake.started' },
          { from: 'draft', to: 'review', trigger: 'ready', guard_field: 'draft.ready' },
          { from: 'review', to: 'revision', trigger: 'revise', guard_field: 'review.needs_revision' },
          { from: 'review', to: 'complete', trigger: 'approve', guard_field: 'review.approved' },
          { from: 'revision', to: 'review', trigger: 'revised', guard_field: 'revision.ready' },
        ]),
        'intake.completion_json': JSON.stringify({
          final_stage: 'complete',
          guard_field: 'review.done',
        }),
      }),
    });

    const artifact = getSynthesizedArtifact(sessionId);
    const parsed = load(artifact?.spec_yaml ?? '') as {
      modes: Record<string, { transitions?: Array<{ target: string; guard?: { path?: string } }>; vocabulary?: string[] }>;
      action_map: Record<string, { result_path?: string; mutations: Array<{ path: string }> }>;
      proceed_to: Record<string, string>;
    };

    expect(parsed.modes.review.transitions).toEqual([
      { target: 'revision', guard: { kind: 'FieldTruthy', path: 'review.needs_revision' } },
      { target: 'complete', guard: { kind: 'FieldTruthy', path: 'review.done' } },
    ]);
    expect(parsed.modes.revision.transitions).toEqual([
      { target: 'review', guard: { kind: 'FieldTruthy', path: 'revision.ready' } },
    ]);
    expect(parsed.modes.review.vocabulary).toEqual(expect.arrayContaining([
      'advance_review_to_revision',
      'advance_review_to_complete',
    ]));
    expect(parsed.modes.review.vocabulary).not.toContain('complete_review');
    expect(parsed.proceed_to.advance_review_to_revision).toBe('revision');
    expect(parsed.proceed_to.advance_review_to_complete).toBe('complete');
    expect(parsed.proceed_to.complete_revision).toBe('review');
    expect(parsed.action_map.advance_review_to_revision.mutations.map((mutation) => mutation.path)).toEqual([
      'review.needs_revision',
      'review.result_json',
      'review.items_json',
    ]);
    expect(parsed.action_map.advance_review_to_complete.mutations.map((mutation) => mutation.path)).toEqual([
      'review.done',
      'review.result_json',
      'review.items_json',
    ]);
    expect(parsed.action_map.complete_revision.mutations.map((mutation) => mutation.path)).toEqual([
      'revision.ready',
    ]);
    expect(parsed.action_map.complete_revision.result_path).toBe('revision.output');
    expect(parsed.action_map.advance_review_to_revision.mutations.map((mutation) => mutation.path)).not.toContain('review.done');
    expect(parsed.action_map.advance_review_to_complete.mutations.map((mutation) => mutation.path)).not.toContain('review.needs_revision');
    expect(() => loadSpecWithPatterns(writeTempSpec(artifact?.spec_yaml ?? ''))).not.toThrow();
  });

  it('drives generated smoke tests through the forward branch when a revision loop is also reachable', async () => {
    const artifact = synthesizeProgramSpecFromDomain(domain({
      'program.slug': 'fee-proposal-drafter',
      'program.name': 'Fee Proposal Drafter',
      'program.target_dir': '/tmp/fee-proposal-drafter',
      'intake.purpose': 'Draft a fee proposal, collect partner approval, and deliver the client-ready version.',
      'intake.stages_json': JSON.stringify([
        { slug: 'intake', is_bootstrap: true },
        { slug: 'fee_modelling' },
        { slug: 'draft_assembly' },
        { slug: 'partner_review' },
        { slug: 'revision' },
        { slug: 'client_delivery' },
        { slug: 'complete', is_terminal: true },
      ]),
      'intake.transitions_json': JSON.stringify([
        { from: 'intake', to: 'fee_modelling', trigger: 'started', guard_field: 'intake.started' },
        { from: 'fee_modelling', to: 'draft_assembly', trigger: 'modelled', guard_field: 'fee_modelling.ready' },
        { from: 'draft_assembly', to: 'partner_review', trigger: 'drafted', guard_field: 'draft_assembly.ready' },
        { from: 'partner_review', to: 'revision', trigger: 'reject', guard_field: 'partner_review.rejected' },
        { from: 'partner_review', to: 'client_delivery', trigger: 'approve', guard_field: 'partner_review.approved' },
        { from: 'revision', to: 'draft_assembly', trigger: 'revised', guard_field: 'revision.ready' },
        { from: 'client_delivery', to: 'complete', trigger: 'delivered', guard_field: 'client_delivery.ready' },
      ]),
      'intake.delegation_json': JSON.stringify({ enabled: false }),
      'intake.completion_json': JSON.stringify({
        final_stage: 'complete',
        guard_field: 'client_delivery.ready',
      }),
    }));
    const parsed = load(artifact.spec_yaml) as {
      proceed_to: Record<string, string>;
    };
    const smokeActionNames = smokeEffectNames(artifact.smoke_test_ts);

    expect(smokeActionNames).toEqual([
      'begin_work',
      'complete_fee_modelling',
      'complete_draft_assembly',
      'advance_partner_review_to_client_delivery',
      'complete_client_delivery',
    ]);
    expect(smokeActionNames).not.toContain('advance_partner_review_to_revision');
    expect(smokeActionNames).not.toContain('complete_revision');
    expect(parsed.proceed_to[smokeActionNames.at(-1) as string]).toBe('complete');
    expect(artifact.smoke_test_ts).toContain("expect(snapshot.mode).toBe('complete')");
  });

  it('synthesizes revised stages after stale Q4 default transitions are refreshed', async () => {
    const sessionId = 'session-revised-stale-transitions';
    clearSynthesizedArtifact(sessionId);

    await handlers.synthesize_program_spec({
      sessionId,
      domain: domain({
        'intake.stages_json': JSON.stringify([
          { slug: 'intake', is_bootstrap: true },
          { slug: 'review' },
          { slug: 'remediation' },
          { slug: 'resolved', is_terminal: true },
        ]),
        'intake.transitions_json': JSON.stringify([
          { from: 'intake', to: 'triage', trigger: 'auto' },
          { from: 'triage', to: 'resolved', trigger: 'auto' },
        ]),
        'intake.completion_json': JSON.stringify({
          final_stage: 'resolved',
          guard_field: 'triage.summary_ready',
        }),
      }),
    });

    const artifact = getSynthesizedArtifact(sessionId);
    const parsed = load(artifact?.spec_yaml ?? '') as {
      modes: Record<string, { transitions?: Array<{ target: string; guard?: { path?: string } }> }>;
    };

    expect(Object.keys(parsed.modes)).toEqual(['intake', 'review', 'remediation', 'resolved']);
    expect(parsed.modes.intake.transitions).toEqual([{ target: 'review' }]);
    expect(parsed.modes.review.transitions).toEqual([{ target: 'remediation' }]);
    expect(parsed.modes.remediation.transitions).toEqual([
      { target: 'resolved', guard: { kind: 'FieldTruthy', path: 'triage.summary_ready' } },
    ]);
    expect(() => loadSpecWithPatterns(writeTempSpec(artifact?.spec_yaml ?? ''))).not.toThrow();
  });

  it('accepts completion before a later blocked terminal sink', async () => {
    const stageNames = ['intake', 'draft', 'review', 'complete', 'blocked'];
    clearSynthesizedArtifact('session-nonfinal-completion');

    await handlers.synthesize_program_spec({
      sessionId: 'session-nonfinal-completion',
      domain: domain({
        'intake.stages_json': JSON.stringify(stageNames.map((slug, index) => ({
          slug,
          is_bootstrap: index === 0 || undefined,
          is_terminal: slug === 'complete' || slug === 'blocked' || undefined,
        }))),
        'intake.transitions_json': JSON.stringify([
          { from: 'intake', to: 'draft', trigger: 'started', guard_field: 'intake.started' },
          { from: 'draft', to: 'review', trigger: 'ready', guard_field: 'draft.ready' },
          { from: 'review', to: 'complete', trigger: 'approved', guard_field: 'review.approved' },
          { from: 'draft', to: 'blocked', trigger: 'blocked', guard_field: 'draft.blocked' },
        ]),
        'intake.completion_json': JSON.stringify({
          final_stage: 'complete',
          guard_field: 'review.done',
        }),
      }),
    });

    const artifact = getSynthesizedArtifact('session-nonfinal-completion');
    const parsed = load(artifact?.spec_yaml ?? '') as {
      terminal: string[];
      modes: Record<string, { transitions?: Array<{ target: string; guard?: { path?: string } }>; vocabulary?: string[] }>;
    };

    expect(Object.keys(parsed.modes)).toEqual(stageNames);
    expect(parsed.terminal).toEqual(['complete', 'blocked']);
    expect(parsed.modes.complete.transitions).toEqual([]);
    expect(parsed.modes.blocked.transitions).toEqual([]);
    expect(parsed.modes.review.transitions).toEqual([
      { target: 'complete', guard: { kind: 'FieldTruthy', path: 'review.done' } },
    ]);
    expect(parsed.modes.complete.vocabulary).toEqual(['session_status', 'session_history', 'session_help']);
    expect(parsed.modes.blocked.vocabulary).toEqual(['session_status', 'session_history', 'session_help']);
    expect(() => loadSpecWithPatterns(writeTempSpec(artifact?.spec_yaml ?? ''))).not.toThrow();
  });

  it('synthesizes 9-stage intake graphs and parses them through the engine loader', async () => {
    const stageNames = [
      'intake',
      'intelligence',
      'egress_verification',
      'web_analysis',
      'strategy_review',
      'scraping',
      'asset_verification',
      'reporting',
      'complete',
    ];
    const result = await synthesizeStageGraph('session-nine-stages', stageNames);
    const artifact = getSynthesizedArtifact('session-nine-stages');
    const parsed = load(artifact?.spec_yaml ?? '') as {
      modes: Record<string, unknown>;
      schema: Record<string, string>;
    };

    expect(result).toMatchObject({ mode_names: stageNames });
    expect(Object.keys(parsed.modes)).toEqual(stageNames);
    expect(parsed.schema).toMatchObject({
      'intelligence.output.result_json': 'string',
      'web_analysis.items_json': 'string',
      'asset_verification.output.result_json': 'string',
      'reporting.output.items_json': 'string',
    });
    expect(() => loadSpecWithPatterns(writeTempSpec(artifact?.spec_yaml ?? ''))).not.toThrow();
  });

  it('rejects intake with wrong JSON-string field types', async () => {
    await expect(
      handlers.synthesize_program_spec({
        sessionId: 'session-bad-json',
        domain: domain({ 'intake.transitions_json': transitions }),
      }),
    ).rejects.toThrow(/missing JSON-string domain field: intake\.transitions_json/);
  });

  describe('demand-driven flat stage-output mirror', () => {
    function flatMirrorDomain(applyPolicyReads: string[]): Record<string, unknown> {
      return {
        'program.slug': 'flat-mirror-demand',
        'program.name': 'Flat Mirror Demand',
        'program.target_dir': '/tmp/flat-mirror-demand',
        'program.design_path': 'design',
        'intake.purpose': 'Normalize an input, apply a policy, update a ledger, and complete.',
        'intake.entry_channel': 'user_text',
        'intake.stages_json': JSON.stringify([
          { slug: 'intake', is_bootstrap: true },
          { slug: 'normalize_request' },
          {
            slug: 'apply_policy',
            domain_spec: {
              reads: applyPolicyReads,
              produces: {
                result_json: { stage: 'string', order_id: 'string' },
                items_json: 'string[]',
              },
              rules: ['Apply the policy to the normalized request.'],
              invariants: ['result_json.stage must equal apply_policy.'],
            },
          },
          { slug: 'update_ledger' },
          { slug: 'complete', is_terminal: true },
        ]),
        'intake.transitions_json': JSON.stringify([
          { from: 'intake', to: 'normalize_request', trigger: 'started', guard_field: 'intake.started' },
          { from: 'normalize_request', to: 'apply_policy', trigger: 'normalized', guard_field: 'normalize_request.ready' },
          { from: 'apply_policy', to: 'update_ledger', trigger: 'applied', guard_field: 'apply_policy.ready' },
          { from: 'update_ledger', to: 'complete', trigger: 'done', guard_field: 'update_ledger.ready' },
        ]),
        'intake.delegation_json': JSON.stringify({
          normalize_request: { kind: 'pure-compute' },
          apply_policy: { kind: 'pure-compute' },
          update_ledger: { kind: 'pure-compute' },
        }),
        'intake.completion_json': JSON.stringify({ final_stage: 'complete', guard_field: 'update_ledger.ready' }),
      };
    }

    interface ParsedFlatMirrorSpec {
      reactions: Record<string, { event: string; watch?: string[]; write_scope: string[] }>;
      schema: Record<string, string>;
      projection: Record<string, { include: string[]; exclude: string[] }>;
    }

    it('stays inert when no stage references a flat path: nested-only reads emit no mirror surface', () => {
      const artifact = synthesizeProgramSpecFromDomain(
        flatMirrorDomain(['normalize_request.output.result_json.order_id']),
      );
      const parsed = load(artifact.spec_yaml) as ParsedFlatMirrorSpec;

      expect(artifact.stage_classification).toContainEqual(
        expect.objectContaining({ slug: 'normalize_request', archetype: 'pure-compute' }),
      );
      expect(Object.keys(parsed.reactions).filter((name) => name.startsWith('mirror_'))).toEqual([]);
      expect(parsed.schema['normalize_request.output.result_json']).toBe('string');
      expect(parsed.schema).not.toHaveProperty('normalize_request.result_json');
      expect(parsed.schema).not.toHaveProperty('normalize_request.items_json');
      expect(parsed.schema).not.toHaveProperty('apply_policy.result_json');
      expect(parsed.schema).not.toHaveProperty('update_ledger.result_json');
      expect(parsed.projection.apply_policy?.include).toContain('normalize_request.output');
      expect(parsed.projection.apply_policy?.include).not.toContain('normalize_request.result_json');
      expect(parsed.projection.normalize_request?.include).not.toContain('normalize_request.result_json');
      expect(artifact.handlers_ts).not.toContain('mirrorStageOutput');
      expect(artifact.handlers_ts).not.toContain('ReactionResult');
    });

    it('emits the flat mirror only for the pure-compute stage a flat read demands', () => {
      const artifact = synthesizeProgramSpecFromDomain(
        flatMirrorDomain(['normalize_request.result_json.order_id']),
      );
      const parsed = load(artifact.spec_yaml) as ParsedFlatMirrorSpec;

      expect(parsed.reactions.mirror_normalize_request_output).toEqual({
        event: 'AfterRound',
        write_scope: ['normalize_request.result_json', 'normalize_request.items_json'],
      });
      expect(parsed.reactions).not.toHaveProperty('mirror_apply_policy_output');
      expect(parsed.reactions).not.toHaveProperty('mirror_update_ledger_output');

      expect(parsed.schema['normalize_request.result_json']).toBe('string');
      expect(parsed.schema['normalize_request.items_json']).toBe('string');
      expect(parsed.schema['normalize_request.output.result_json']).toBe('string');
      expect(parsed.schema).not.toHaveProperty('apply_policy.result_json');
      expect(parsed.schema).not.toHaveProperty('update_ledger.result_json');

      expect(parsed.projection.normalize_request?.include).toEqual(
        expect.arrayContaining(['normalize_request.output', 'normalize_request.result_json', 'normalize_request.items_json']),
      );
      expect(parsed.projection.apply_policy?.include).toContain('normalize_request.result_json');
      expect(parsed.projection.apply_policy?.include).not.toContain('apply_policy.result_json');
      expect(parsed.projection.update_ledger?.include).not.toContain('update_ledger.result_json');

      expect(artifact.handlers_ts).toContain('mirror_normalize_request_output');
      expect(artifact.handlers_ts).toContain('function mirrorStageOutput(');
      expect(artifact.handlers_ts).toContain('ReactionResult');
      expect(artifact.handlers_ts).toContain('new Map<string, ReactionHandler>');
      expect(artifact.handlers_ts).not.toContain('mirror_apply_policy_output');
      expect(artifact.handlers_ts).not.toContain('mirror_update_ledger_output');
      expect(artifact.handlers_index_ts).not.toContain('mirrorStageOutput');

      expect(() => loadSpecWithPatterns(writeTempSpec(artifact.spec_yaml))).not.toThrow();
    });
  });
});

describe('precondition vocabulary alignment (pgas#620 pre-positioning)', () => {
  it('locks every synthesized mode: precondition keys are a subset of the mode vocabulary', () => {
    const synthesized = synthesizeProgramSpecFromDomain(domain());
    const parsed = load(synthesized.spec_yaml) as {
      modes: Record<string, { vocabulary?: string[]; preconditions?: Record<string, unknown> }>;
    };

    expect(Object.keys(parsed.modes).length).toBeGreaterThanOrEqual(3);
    for (const [modeName, mode] of Object.entries(parsed.modes)) {
      const vocabulary = new Set(mode.vocabulary ?? []);
      for (const actionName of Object.keys(mode.preconditions ?? {})) {
        expect(vocabulary.has(actionName), `mode "${modeName}" precondition "${actionName}"`).toBe(true);
      }
    }
    // The invariant also holds through the exported synthesis-time assertion,
    // which validateSynthesizedSpec runs on every synthesized spec.
    expect(() => assertPreconditionVocabularyAlignment(load(synthesized.spec_yaml))).not.toThrow();
  });

  it('rejects a mode that declares a precondition for an action outside its vocabulary', () => {
    const misaligned = {
      modes: {
        review: {
          vocabulary: ['approve_review'],
          preconditions: {
            reject_review: [{ kind: 'FieldTruthy', path: 'review.ready' }],
          },
        },
      },
    };

    expect(() => assertPreconditionVocabularyAlignment(misaligned)).toThrow(
      /mode "review" declares a precondition for action "reject_review"/u,
    );
  });

  it('rejects structurally malformed preconditions instead of skipping them', () => {
    expect(() => assertPreconditionVocabularyAlignment({
      modes: { start: { vocabulary: ['begin_work'], preconditions: ['begin_work'] } },
    })).toThrow(/preconditions must be a mapping/u);
    expect(() => assertPreconditionVocabularyAlignment({ modes: [] })).toThrow(/spec\.modes/u);
    expect(() => assertPreconditionVocabularyAlignment('not a spec')).toThrow(/parsed spec object/u);
  });
});

async function synthesizeStageGraph(sessionId: string, stageNames: string[]) {
  clearSynthesizedArtifact(sessionId);
  return handlers.synthesize_program_spec({
    sessionId,
    domain: domain({
      'intake.stages_json': JSON.stringify(stageNames.map((slug, index) => ({
        slug,
        is_bootstrap: index === 0 || undefined,
        is_terminal: index === stageNames.length - 1 || undefined,
      }))),
      'intake.transitions_json': JSON.stringify(transitionsFor(stageNames)),
      'intake.completion_json': JSON.stringify({
        final_stage: stageNames.at(-1),
        guard_field: `${stageNames.at(-2)}.ready`,
      }),
    }),
  });
}

function transitionsFor(stageNames: string[]) {
  return stageNames.slice(0, -1).map((from, index) => ({
    from,
    to: stageNames[index + 1],
    trigger: index === 0 ? 'started' : 'ready',
    guard_field: index === 0 ? `${from}.started` : `${from}.ready`,
  }));
}

function smokeEffectNames(source: string): string[] {
  return Array.from(source.matchAll(/effect\('([^']+)'/gu), (match) => match[1] as string);
}

function expectGeneratedHandlersToWire(specYaml: string, handlersSource: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'pgas-new-synth-wire-'));
  const specPath = join(dir, 'specs.yml');
  writeFileSync(specPath, specYaml);
  const spec = loadSpecWithPatterns(specPath).spec;
  rmSync(dir, { recursive: true, force: true });
  expect(() => validateSpecWiring(spec, handlerMapFromSource(handlersSource))).not.toThrow();
}

function handlerMapFromSource(source: string): Map<string, ActionHandler> {
  const names = Array.from(source.matchAll(/^\s+async\s+([a-zA-Z0-9_]+)\(/gmu), (match) => match[1] as string);
  return new Map(names.map((name) => [name, () => ({})]));
}

function writeTempSpec(specYaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pgas-new-synth-load-'));
  const specPath = join(dir, 'specs.yml');
  writeFileSync(specPath, specYaml);
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return specPath;
}
