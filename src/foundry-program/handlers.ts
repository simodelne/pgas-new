import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { ReactionHandler, ToolHandler } from '@simodelne/pgas-server/plugin.js';
import { createExistingRepoArtifactPlan, createStandaloneArtifactPlan } from '../pgas-new/artifact-plan.js';
import { renderMissingWiringRequest } from '../pgas-new/curator-request.js';
import { renderExistingRepoAttachment, renderStandaloneScaffold } from '../pgas-new/template-renderer.js';
import { graduationEvidenceRows, renderFinalizedGraduationAudit } from '../pgas-new/graduation-audit.js';
import { sanitizedVerificationEnv } from '../pgas-new/verification-env.js';
import {
  WIRING_MANIFEST_PATH,
  isSafeRepoRelativePath,
  loadWiringManifest as readWiringManifest,
  type WiringManifest,
} from '../pgas-new/wiring-manifest.js';
import { runCompositeStaticChecks } from './composite-checks.js';
import { synthesizeDomainLogic, type StageBodyGenerator } from './domain-synthesis.js';
import { refreshStaleTransitionsForStages, synthesizeProgramSpecFromDomain } from './synthesizer.js';
import { putSynthesizedArtifact, requireSynthesizedArtifact, type SynthesizedArtifact } from './synthesizer-store.js';

const defaultStages = [
  { slug: 'start', is_bootstrap: true },
  { slug: 'working' },
  { slug: 'complete', is_terminal: true },
];

const defaultTransitions = [
  { from: 'start', to: 'working', trigger: 'auto' },
  {
    from: 'working',
    to: 'complete',
    trigger: 'auto',
    guard_field: 'work.example_ready',
    guard_value: true,
  },
];

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stringField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string') {
    throw new Error(`missing string payload field: ${key}`);
  }
  return value;
}

function numberField(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (typeof value !== 'number') {
    throw new Error(`missing number payload field: ${key}`);
  }
  return value;
}

interface NormalizedJsonField {
  value: unknown;
  canonical: string;
}

type JsonTopLevelType = 'array' | 'object';

function optionalJsonField(
  payload: Record<string, unknown>,
  structuredKey: string,
  jsonKey: string,
  expectedType: JsonTopLevelType,
): NormalizedJsonField {
  const structuredValue = payload[structuredKey];
  if (structuredValue !== undefined) {
    assertJsonTopLevelType(structuredValue, expectedType, jsonKey);
    return {
      value: structuredValue,
      canonical: canonicalJson(structuredValue, jsonKey),
    };
  }

  const jsonValue = payload[jsonKey];
  if (typeof jsonValue !== 'string') {
    throw new Error(`missing JSON-string payload field: ${jsonKey}`);
  }
  const normalized = parseAndNormalizeJson(jsonValue, jsonKey);
  assertJsonTopLevelType(normalized.value, expectedType, jsonKey);
  return normalized;
}

function parseAndNormalizeJson(rawValue: string, label: string): NormalizedJsonField {
  const normalizedRawValue = normalizeSmartQuotes(unescapeCommonHtmlEntities(rawValue));
  let value: unknown;
  try {
    value = JSON.parse(normalizedRawValue) as unknown;
  } catch (strictError) {
    try {
      value = new JsonishParser(normalizedRawValue).parse();
    } catch (tolerantError) {
      throw new Error(
        `invalid JSON-string payload field: ${label}; strict JSON.parse failed (${errorMessage(strictError)}) and tolerant JSON5-style parse failed (${errorMessage(tolerantError)})`,
      );
    }
  }
  return {
    value,
    canonical: canonicalJson(value, label),
  };
}

function normalizeSmartQuotes(value: string): string {
  return value.replace(/[\u201c\u201d]/gu, '"').replace(/[\u2018\u2019]/gu, '\'');
}

function unescapeCommonHtmlEntities(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < 5; pass += 1) {
    const previous = decoded;
    decoded = decodeAmpNumericEntities(
      decodeNonAmpNumericEntities(
        decoded
          .replace(/&quot;/giu, '"')
          .replace(/&lt;/giu, '<')
          .replace(/&gt;/giu, '>')
          .replace(/&apos;/giu, '\''),
      )
        .replace(/&amp;/giu, '&'),
    );
    if (decoded === previous) {
      return decoded;
    }
  }
  return decoded;
}

function decodeNonAmpNumericEntities(value: string): string {
  return decodeNumericEntities(value, false);
}

function decodeAmpNumericEntities(value: string): string {
  return decodeNumericEntities(value, true);
}

function decodeNumericEntities(value: string, ampersandOnly: boolean): string {
  return value.replace(
    /&#(?:x([0-9a-f]+)|(\d+));/giu,
    (entity: string, hex: string | undefined, decimal: string | undefined) => {
      const codePoint = Number.parseInt(hex ?? decimal ?? '', hex === undefined ? 10 : 16);
      if (codePoint === 38) {
        return '&';
      }
      if (ampersandOnly) {
        return entity;
      }
      switch (codePoint) {
        case 34:
          return '"';
        case 39:
          return '\'';
        case 60:
          return '<';
        case 62:
          return '>';
        default:
          return entity;
      }
    },
  );
}

function canonicalJson(value: unknown, label: string): string {
  const canonical = JSON.stringify(value);
  if (canonical === undefined) {
    throw new Error(`JSON payload field ${label} cannot be canonicalized`);
  }
  return canonical;
}

function assertJsonTopLevelType(value: unknown, expectedType: JsonTopLevelType, label: string): void {
  if (expectedType === 'array') {
    if (!Array.isArray(value)) {
      throw new Error(`invalid JSON-string payload field: ${label}; expected a JSON array`);
    }
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid JSON-string payload field: ${label}; expected a JSON object`);
  }
}

/**
 * Q5 delegation accepts user-typed sentinel answers ("none", "no", "n/a",
 * or empty) and substitutes the canonical empty-delegation object
 * `{ enabled: false }`. This keeps `record_q5_delegation` deterministic
 * against Qwen's variable interpretations of the user's "none" reply.
 *
 * Returns a NEW payload (does not mutate input) with `delegation_json`
 * rewritten to '{"enabled":false}' when the sentinel matches. Other
 * payload keys pass through unchanged.
 */
function applyOptionalDelegationSentinel(payload: Record<string, unknown>): Record<string, unknown> {
  const raw = payload.delegation_json;
  if (typeof raw !== 'string') return payload;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'none' || trimmed === 'no' || trimmed === 'n/a' || trimmed === '') {
    return { ...payload, delegation_json: '{"enabled":false}' };
  }
  return payload;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class JsonishParser {
  private offset = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    const value = this.parseValue();
    this.skipWhitespace();
    if (!this.isDone()) {
      throw new Error(`unexpected token ${JSON.stringify(this.current())} at position ${this.offset}`);
    }
    return value;
  }

  private parseValue(): unknown {
    this.skipWhitespace();
    if (this.isDone()) {
      throw new Error('unexpected end of input');
    }

    const char = this.current();
    if (char === '{') return this.parseObject();
    if (char === '[') return this.parseArray();
    if (char === '"' || char === '\'') return this.parseString();
    return this.parseBareValue();
  }

  private parseObject(): Record<string, unknown> {
    this.consume('{');
    const object: Record<string, unknown> = {};
    this.skipWhitespace();
    if (this.current() === '}') {
      this.offset += 1;
      return object;
    }

    while (true) {
      const key = this.parseObjectKey();
      this.skipWhitespace();
      this.consume(':');
      object[key] = this.parseValue();
      this.skipWhitespace();
      if (this.current() === ',') {
        this.offset += 1;
        this.skipWhitespace();
        if (this.current() === '}') {
          this.offset += 1;
          return object;
        }
        continue;
      }
      if (this.current() === '}') {
        this.offset += 1;
        return object;
      }
      throw new Error(`expected "," or "}" at position ${this.offset}`);
    }
  }

  private parseArray(): unknown[] {
    this.consume('[');
    const array: unknown[] = [];
    this.skipWhitespace();
    if (this.current() === ']') {
      this.offset += 1;
      return array;
    }

    while (true) {
      array.push(this.parseValue());
      this.skipWhitespace();
      if (this.current() === ',') {
        this.offset += 1;
        this.skipWhitespace();
        if (this.current() === ']') {
          this.offset += 1;
          return array;
        }
        continue;
      }
      if (this.current() === ']') {
        this.offset += 1;
        return array;
      }
      throw new Error(`expected "," or "]" at position ${this.offset}`);
    }
  }

  private parseObjectKey(): string {
    this.skipWhitespace();
    const char = this.current();
    if (char === '"' || char === '\'') {
      return this.parseString();
    }

    const start = this.offset;
    while (!this.isDone() && this.current() !== ':') {
      this.offset += 1;
    }
    const key = this.source.slice(start, this.offset).trim();
    if (key.length === 0) {
      throw new Error(`empty object key at position ${start}`);
    }
    if (/[,\[\]{}]/u.test(key)) {
      throw new Error(`invalid unquoted object key ${JSON.stringify(key)} at position ${start}`);
    }
    return key;
  }

  private parseString(): string {
    const quote = this.current();
    this.offset += 1;
    let value = '';
    while (!this.isDone()) {
      const char = this.current();
      this.offset += 1;
      if (char === quote) return value;
      if (char !== '\\') {
        value += char;
        continue;
      }
      if (this.isDone()) {
        throw new Error('unterminated string escape');
      }
      const escaped = this.current();
      this.offset += 1;
      switch (escaped) {
        case '"':
        case '\'':
        case '\\':
        case '/':
          value += escaped;
          break;
        case 'b':
          value += '\b';
          break;
        case 'f':
          value += '\f';
          break;
        case 'n':
          value += '\n';
          break;
        case 'r':
          value += '\r';
          break;
        case 't':
          value += '\t';
          break;
        case 'u': {
          const hex = this.source.slice(this.offset, this.offset + 4);
          if (!/^[0-9a-fA-F]{4}$/u.test(hex)) {
            throw new Error(`invalid unicode escape at position ${this.offset - 2}`);
          }
          value += String.fromCharCode(Number.parseInt(hex, 16));
          this.offset += 4;
          break;
        }
        default:
          value += escaped;
          break;
      }
    }
    throw new Error('unterminated string');
  }

  private parseBareValue(): unknown {
    const start = this.offset;
    while (!this.isDone() && !/[\s,\]}]/u.test(this.current())) {
      this.offset += 1;
    }
    const token = this.source.slice(start, this.offset).trim();
    if (token.length === 0) {
      throw new Error(`expected value at position ${start}`);
    }
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(token)) {
      return Number(token);
    }
    return token;
  }

  private consume(expected: string): void {
    this.skipWhitespace();
    if (this.current() !== expected) {
      throw new Error(`expected ${JSON.stringify(expected)} at position ${this.offset}`);
    }
    this.offset += 1;
  }

  private skipWhitespace(): void {
    while (!this.isDone() && /\s/u.test(this.current())) {
      this.offset += 1;
    }
  }

  private current(): string {
    return this.source[this.offset] ?? '';
  }

  private isDone(): boolean {
    return this.offset >= this.source.length;
  }
}

const intakeJsonPaths = [
  'intake.stages_json',
  'intake.transitions_json',
  'intake.delegation_json',
  'intake.completion_json',
] as const;

const approveArtifactPlanPreconditions = [
  { label: 'repo.write_authorized', path: 'repo.write_authorized', expect: true },
  { label: 'program.synthesis_complete', path: 'program.synthesis_complete', expect: true },
  { label: 'artifact_plan.status', path: 'artifact_plan.status', expect: 'draft' },
  { label: 'artifact_plan.approved', path: 'artifact_plan.approved', expect: false },
  { label: 'trigger', path: 'trigger', expect: 'user_confirmation' },
  { label: 'inputs.user_decision.decision', path: 'inputs.user_decision.decision', expect: 'approve' },
] as const;

function foundryDebugEnabled(): boolean {
  return process.env.PGAS_FOUNDRY_DEBUG === '1';
}

function debugApprovalPreconditions(snapshot: ReadonlyMap<string, unknown>, trigger: string, mode: string): void {
  if (!foundryDebugEnabled()) return;
  if (mode !== 'scaffold_plan') return;
  if (trigger !== 'user_confirmation' && trigger !== 'system_mode_entry') return;

  const values = Object.fromEntries(
    approveArtifactPlanPreconditions.map((precondition) => [
      precondition.label,
      precondition.path === 'trigger' ? trigger : snapshot.get(precondition.path),
    ]),
  );
  const userDecision = {
    decision: snapshot.get('inputs.user_decision.decision'),
    instruction: snapshot.get('inputs.user_decision.instruction'),
    note_mode: snapshot.get('inputs.user_decision.note_mode'),
    timestamp: snapshot.get('inputs.user_decision.timestamp'),
  };
  const failed = approveArtifactPlanPreconditions
    .filter((precondition) => values[precondition.label] !== precondition.expect)
    .map((precondition) => precondition.label);

  console.error(
    '[PGAS_FOUNDRY_DEBUG] approve_artifact_plan preconditions',
    JSON.stringify({
      mode,
      trigger,
      values,
      user_decision: userDecision,
      failed,
    }),
  );
}

export const reactionHandlers: Map<string, ReactionHandler> = new Map([
  ['debug_approve_artifact_plan_preconditions', (snapshot, trigger, mode) => {
    debugApprovalPreconditions(snapshot, trigger, mode);
  }],
  ['normalize_static_verification_status', (snapshot) => normalizeVerificationStatus(snapshot, 'graduation.static_verification')],
  ['normalize_smoke_verification_status', (snapshot) => normalizeVerificationStatus(snapshot, 'graduation.smoke_verification')],
  ['normalize_live_verification_status', (snapshot) => normalizeVerificationStatus(snapshot, 'graduation.live_verification')],
  ['normalize_rebase_status', (snapshot) => normalizeVerificationStatus(snapshot, 'graduation.rebase_status')],
  ['normalize_rebase_static_verification_status', (snapshot) => normalizeVerificationStatus(snapshot, 'graduation.rebase_verification')],
  ['normalize_intake_json_fields', (snapshot) => {
    const mutations = intakeJsonPaths.flatMap((path) => {
      const value = snapshot.get(path);
      if (typeof value !== 'string') return [];
      const expectedType = path === 'intake.stages_json' || path === 'intake.transitions_json' ? 'array' : 'object';
      const normalized = parseAndNormalizeJson(value, path);
      assertJsonTopLevelType(normalized.value, expectedType, path);
      const canonical = normalized.canonical;
      return canonical === value ? [] : [{ op: 'MSet' as const, path, value: canonical }];
    });
    const transitionRefresh = staleTransitionRefreshMutation(snapshot);
    const allMutations = [...mutations, ...transitionRefresh];
    return allMutations.length > 0 ? { mutations: allMutations } : undefined;
  }],
]);

function normalizeVerificationStatus(snapshot: ReadonlyMap<string, unknown>, statusPath: string) {
  const rawStatus = snapshot.get(statusPath);
  if (typeof rawStatus !== 'string') return undefined;

  const canonical = canonicalizeVerificationStatus(rawStatus);
  if (!canonical || rawStatus === canonical) return undefined;
  return { mutations: [{ op: 'MSet' as const, path: statusPath, value: canonical }] };
}

const VERIFICATION_STATUS_SYNONYMS: Record<string, 'passed' | 'failed' | 'skipped'> = {
  passed: 'passed', pass: 'passed', passing: 'passed', succeeded: 'passed', success: 'passed',
  successful: 'passed', ok: 'passed', green: 'passed', complete: 'passed', completed: 'passed', done: 'passed',
  failed: 'failed', fail: 'failed', failing: 'failed', failure: 'failed', error: 'failed', errored: 'failed', red: 'failed',
  skipped: 'skipped', skip: 'skipped', na: 'skipped', none: 'skipped',
};

/**
 * Map a reported verification status to the canonical enum the graduation gates
 * require. Returns undefined for an unrecognized value (left untouched so a
 * genuinely unexpected status is not silently masked as passed). "pending" maps
 * to itself and is left as-is.
 */
function canonicalizeVerificationStatus(value: string): 'passed' | 'failed' | 'skipped' | undefined {
  const key = value.trim().toLowerCase().replace(/[\s/_-]+/gu, '');
  if (key === 'pending') return undefined;
  return VERIFICATION_STATUS_SYNONYMS[key];
}

function staleTransitionRefreshMutation(snapshot: ReadonlyMap<string, unknown>) {
  const stagesRaw = snapshot.get('intake.stages_json');
  const transitionsRaw = snapshot.get('intake.transitions_json');
  const completionRaw = snapshot.get('intake.completion_json');
  if (
    typeof stagesRaw !== 'string' ||
    typeof transitionsRaw !== 'string' ||
    typeof completionRaw !== 'string'
  ) {
    return [];
  }

  const stages = parseAndNormalizeJson(stagesRaw, 'intake.stages_json');
  const transitions = parseAndNormalizeJson(transitionsRaw, 'intake.transitions_json');
  const completion = parseAndNormalizeJson(completionRaw, 'intake.completion_json');
  assertJsonTopLevelType(stages.value, 'array', 'intake.stages_json');
  assertJsonTopLevelType(transitions.value, 'array', 'intake.transitions_json');
  assertJsonTopLevelType(completion.value, 'object', 'intake.completion_json');

  const refreshed = refreshStaleTransitionsForStages(
    stages.value as unknown[],
    transitions.value as unknown[],
    completion.value,
  );
  if (!refreshed) return [];

  const canonical = canonicalJson(refreshed, 'intake.transitions_json');
  return canonical === transitions.canonical
    ? []
    : [{ op: 'MSet' as const, path: 'intake.transitions_json', value: canonical }];
}

export const handlers: Record<string, ToolHandler> = {
  // Opt-in parallel-effect feature (v3.3). Delegates to the published
  // composite-effect adapter, which fans the static checks out concurrently and
  // returns one combined envelope. The engine writes that envelope to the
  // action's result_path (graduation.composite_checks). Single-call verify
  // actions remain the default; this only runs when the author packs.
  async run_parallel_static_checks(payload) {
    return runCompositeStaticChecks(payload);
  },

  async synthesize_program_spec(payload) {
    const sessionId = sessionIdFromPayload(payload);
    const domain = domainFromPayload(payload);
    const synthesized = synthesizeProgramSpecFromDomain(domain, synthesisOptionsFromDomain(domain));
    putSynthesizedArtifact(sessionId, {
      spec_yaml: synthesized.spec_yaml,
      mode_names: synthesized.mode_names,
      sha256: synthesized.sha256,
      contracts_ts: synthesized.contracts_ts,
      handlers_ts: synthesized.handlers_ts,
      handlers_index_ts: synthesized.handlers_index_ts,
      tools_ts: synthesized.tools_ts,
      smoke_test_ts: synthesized.smoke_test_ts,
      stage_classification: synthesized.stage_classification,
      body_stage_slugs: synthesized.body_stage_slugs,
      synthesis_context: synthesized.synthesis_context,
      created_at: new Date().toISOString(),
    });
    return {
      kind: 'mechanical_synthesis',
      no_llm_call: true,
      mode_names: synthesized.mode_names,
      sha256: synthesized.sha256,
    };
  },

  async record_program_target(payload) {
    return {
      kind: 'pgas_new_target_recorded',
      target_dir: stringField(payload, 'target_dir'),
      confirmed: true,
    };
  },

  async choose_design_path(payload) {
    const choice = stringField(payload, 'choice');
    if (choice !== 'default' && choice !== 'design') {
      throw new Error('choose_design_path choice must be "default" or "design"');
    }
    return {
      kind: 'pgas_new_design_path_chosen',
      choice,
    };
  },

  async apply_default_skeleton() {
    return {
      kind: 'pgas_new_default_skeleton_applied',
      stages: cloneJson(defaultStages),
      transitions: cloneJson(defaultTransitions),
    };
  },

  async ask_design_question(payload) {
    return {
      kind: 'ask_design_question',
      question_number: numberField(payload, 'question_number'),
      question_text: stringField(payload, 'question_text'),
    };
  },

  async record_q1_purpose(payload) {
    return {
      kind: 'pgas_new_q1_purpose_recorded',
      purpose: stringField(payload, 'purpose'),
    };
  },

  async record_q2_entry_channel(payload) {
    return {
      kind: 'pgas_new_q2_entry_channel_recorded',
      entry_channel: stringField(payload, 'entry_channel'),
    };
  },

  async record_q3_stages(payload) {
    const stages = optionalJsonField(payload, 'stages', 'stages_json', 'array');
    return {
      kind: 'pgas_new_q3_stages_recorded',
      stages: stages.value,
      stages_json: stages.canonical,
    };
  },

  async record_q4_transitions(payload) {
    const transitions = optionalJsonField(payload, 'transitions', 'transitions_json', 'array');
    return {
      kind: 'pgas_new_q4_transitions_recorded',
      transitions: transitions.value,
      transitions_json: transitions.canonical,
    };
  },

  async record_q5_delegation(payload) {
    // Q5 explicitly tells the user "none" is a valid answer for the delegation
    // question. Qwen has been observed to forward that literal string as
    // `delegation_json: "none"` instead of translating it to a JSON object,
    // which then fails the optionalJsonField parse. Accept the sentinel
    // forms here and translate to the canonical empty-delegation object
    // before delegating to the shared parser. See
    // .uat/session-logs-current/pgas-new-1782236782870/session-log.ndjson
    // (R12) for the live evidence.
    const normalized = applyOptionalDelegationSentinel(payload);
    const delegation = optionalJsonField(normalized, 'delegation', 'delegation_json', 'object');
    return {
      kind: 'pgas_new_q5_delegation_recorded',
      delegation: delegation.value,
      delegation_json: delegation.canonical,
    };
  },

  async record_q6_completion(payload) {
    const completion = optionalJsonField(payload, 'completion', 'completion_json', 'object');
    return {
      kind: 'pgas_new_q6_completion_recorded',
      completion: completion.value,
      completion_json: completion.canonical,
    };
  },

  async record_program_intake_finalize() {
    return {
      kind: 'pgas_new_intake_finalized',
      finalized: true,
    };
  },

  async confirm_design() {
    return {
      kind: 'pgas_new_design_confirmed',
      approved: true,
    };
  },

  async reject_design_and_revise_q1() {
    return designRevisionRequested(1);
  },

  async reject_design_and_revise_q2() {
    return designRevisionRequested(2);
  },

  async reject_design_and_revise_q3() {
    return designRevisionRequested(3);
  },

  async reject_design_and_revise_q4() {
    return designRevisionRequested(4);
  },

  async reject_design_and_revise_q5() {
    return designRevisionRequested(5);
  },

  async reject_design_and_revise_q6() {
    return designRevisionRequested(6);
  },

  async authorize_standalone_target() {
    return {
      kind: 'pgas_new_standalone_target_authorized',
      write_authorized: true,
    };
  },

  async authorize_existing_repo_target() {
    return {
      kind: 'pgas_new_existing_repo_target_authorized',
      write_authorized: true,
    };
  },

  async plan_artifacts(payload) {
    return planArtifactsFromPayload(payload);
  },

  async await_artifact_plan_approval() {
    return {
      kind: 'pgas_new_artifact_plan_awaiting_approval',
      awaiting_user_approval: true,
    };
  },

  async revise_artifact_plan(payload) {
    return planArtifactsFromPayload(payload);
  },

  async approve_artifact_plan(payload) {
    if (foundryDebugEnabled()) {
      const domain = domainFromPayload(payload);
      console.error(
        '[PGAS_FOUNDRY_DEBUG] approve_artifact_plan handler',
        JSON.stringify({
          user_decision: {
            decision: domain['inputs.user_decision.decision'],
            instruction: domain['inputs.user_decision.instruction'],
            note_mode: domain['inputs.user_decision.note_mode'],
            timestamp: domain['inputs.user_decision.timestamp'],
          },
        }),
      );
    }
    return {
      kind: 'pgas_new_artifact_plan_approved',
      approved: true,
    };
  },

  async record_user_note(payload) {
    return {
      kind: 'note_recorded',
      payload,
    };
  },

  async synthesize_domain_logic(payload) {
    const sessionId = sessionIdFromPayload(payload);
    const domain = domainFromPayload(payload);
    const synthesized = requireSynthesizedArtifact(sessionId);
    const result = await synthesizeDomainLogic(synthesized, {
      cacheDir: optionalStringPayloadField(payload, 'cache_dir'),
      providerUrl: optionalStringPayloadField(payload, 'provider_url'),
      model: optionalStringPayloadField(payload, 'model'),
      generator: optionalStageBodyGenerator(payload),
      ...synthesisOptionsFromDomain(domain),
    });
    putSynthesizedArtifact(sessionId, result);
    return {
      kind: 'domain_synthesis',
      status: 'passed',
      stage_count: result.domain_synthesis_audit?.length ?? 0,
      audit: result.domain_synthesis_audit ?? [],
    };
  },

  /**
   * create_curator_request
   * side effects: writes a markdown request under the manifest audit_dir.
   * secret redaction: request bodies are written as provided; handler never reads
   * env vars or token files.
   */
  async create_curator_request(payload) {
    const domain = optionalDomainFromPayload(payload);
    const repoRoot = curatorRequestRepoRoot(payload, domain);
    const slug = safeArtifactSlug(
      optionalStringPayloadField(payload, 'slug')
        ?? (domain ? optionalStringDomainField(domain, 'program.slug') : undefined)
        ?? basename(resolve(repoRoot)),
    );
    const programName = domain
      ? optionalStringDomainField(domain, 'program.name') ?? humanizeSlug(slug)
      : humanizeSlug(slug);
    const title = optionalStringPayloadField(payload, 'title') ?? `PGAS-New Curator Request: ${programName}`;
    const body = optionalStringPayloadField(payload, 'body')
      ?? defaultCuratorRequestBody({
        programName,
        repoRoot,
        slug,
        message: optionalStringPayloadField(payload, 'message'),
      });
    const manifest = domain ? parseWiringManifestDomainField(domain) : undefined;
    const auditDir = manifest?.paths?.audit_dir ?? 'audit';
    const relativePath = `${trimSlashes(auditDir)}/PGAS-NEW-${slug}.md`;
    const outPath = join(repoRoot, relativePath);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `# ${title}\n\n${body}\n`);
    return {
      kind: 'curator_request_created',
      path: relativePath,
      title,
    };
  },

  async write_scaffold_artifacts(payload) {
    const sessionId = sessionIdFromPayload(payload);
    const domain = domainFromPayload(payload);
    const synthesized = requireSynthesizedArtifact(sessionId);
    const program = {
      slug: stringDomainField(domain, 'program.slug'),
      name: stringDomainField(domain, 'program.name'),
    };
    const targetDir = stringDomainField(domain, 'program.target_dir');
    const targetKind = optionalStringDomainField(domain, 'repo.target_kind') ?? optionalStringDomainField(domain, 'repo.kind');
    const stageSources = requireAcceptedStageSources(synthesized);
    const result = targetKind === 'existing_repo'
      ? renderExistingRepoAttachment({
          ...program,
          repoRoot: targetDir,
          manifest: parseWiringManifestDomainField(domain),
          stageSlugs: existingRepoStageSlugs(synthesized),
          synthesizedSpecYaml: synthesized.spec_yaml,
          synthesizedContractsTs: synthesized.contracts_ts,
          synthesizedHandlersTs: synthesized.handlers_ts,
          synthesizedHandlersIndexTs: synthesized.handlers_index_ts,
          synthesizedStageSources: stageSources,
          synthesizedToolsTs: synthesized.tools_ts,
          synthesizedSmokeTestTs: synthesized.smoke_test_ts,
        })
      : renderStandaloneScaffold({
          ...program,
          outDir: targetDir,
          synthesizedSpecYaml: synthesized.spec_yaml,
          synthesizedContractsTs: synthesized.contracts_ts,
          synthesizedHandlersTs: synthesized.handlers_ts,
          synthesizedHandlersIndexTs: synthesized.handlers_index_ts,
          synthesizedStageSources: stageSources,
          synthesizedToolsTs: synthesized.tools_ts,
          synthesizedSmokeTestTs: synthesized.smoke_test_ts,
        });
    assertAllPlannedArtifactsWritten(domain, result.written);

    return {
      kind: 'artifacts_written',
      target: result.plan.target,
      generated_paths: result.written,
      synthesized_spec_sha256: synthesized.sha256,
    };
  },

  /**
   * npm_install
   * side effects: spawns npm install --no-audit --no-fund.
   * secret redaction: inherits env for npm auth but never logs env values or
   * .npmrc content; NPM_TOKEN is not included in returned data.
   * cwd safety: cwd must resolve inside program.target_dir.
   */
  async npm_install(payload) {
    const cwd = safeCwd(payload);
    const result = await runCommand('npm', ['install', '--no-audit', '--no-fund'], cwd, 300_000, { sanitizeEnv: true });
    return commandResult('npm install --no-audit --no-fund', result, 'install');
  },

  /**
   * npm_typecheck
   * side effects: spawns npm run typecheck for standalone scaffolds, or the
   * attached repo manifest's static/typecheck/build command for existing repos.
   * secret redaction: no env values are logged or returned.
   * cwd safety: cwd must resolve inside program.target_dir.
   */
  async npm_typecheck(payload) {
    const cwd = safeCwd(payload);
    const command = typecheckCommandForPayload(payload, cwd);
    if ('skipReason' in command) {
      return skippedCommandResult(command.label, command.skipReason, 'static');
    }
    const result = await runCommand(command.executable, command.args, cwd, 120_000, { sanitizeEnv: true });
    return commandResult(command.label, result, 'static');
  },

  /**
   * npm_test
   * side effects: spawns npm test.
   * secret redaction: no env values are logged or returned.
   * cwd safety: cwd must resolve inside program.target_dir.
   */
  async npm_test(payload) {
    const cwd = safeCwd(payload);
    const result = await runCommand('npm', ['test'], cwd, 180_000, { sanitizeEnv: true });
    return commandResult('npm test', result, 'static');
  },

  /**
   * git_status
   * side effects: spawns git status --porcelain.
   * secret redaction: no env values are logged or returned.
   * cwd safety: cwd must resolve inside program.target_dir.
   */
  async git_status(payload) {
    const cwd = safeCwd(payload);
    // #106: a fresh standalone output is not a git repository. `git status` would
    // fatally fail; report a clean/no-repo status instead of crashing the round.
    if (!(await isGitRepo(cwd))) {
      return { clean: true, lines: [], not_a_git_repo: true };
    }
    const result = await runCommand('git', ['status', '--porcelain'], cwd, 60_000);
    const lines = result.stdout.split(/\r?\n/u).filter(Boolean);
    return { clean: lines.length === 0, lines };
  },

  /**
   * run_static_verification
   * Records the aggregate static-verification result. The caller reports the
   * status (after running npm_install/typecheck/test); this handler canonicalizes
   * it to the graduation enum (#107) so a synonym like "succeeded" can't be
   * persisted verbatim and then block the exact-"passed" smoke gate. An
   * unrecognized status is passed through untouched (never masked as passed).
   */
  async run_static_verification(payload) {
    const rawStatus = optionalStringPayloadField(payload, 'status') ?? 'passed';
    return {
      kind: 'static_verification',
      status: canonicalizeVerificationStatus(rawStatus) ?? rawStatus,
      evidence_id: optionalStringPayloadField(payload, 'evidence_id') ?? evidenceId('static'),
    };
  },

  /**
   * git_rebase_latest
   * side effects: spawns git fetch origin, then git rebase --autostash origin/<target_branch>.
   * secret redaction: no env values are logged or returned.
   * cwd safety: cwd must resolve inside program.target_dir.
   */
  async git_rebase_latest(payload) {
    const cwd = safeCwd(payload);
    const targetBranch = optionalStringPayloadField(payload, 'target_branch') ?? 'main';
    // #106: a fresh standalone output is a plain directory (no git repo) or a git
    // repo with no `origin` upstream. There is nothing to rebase onto — the
    // generated tree IS the tip — so the rebase requirement is vacuously
    // satisfied. Skip the fetch/rebase instead of hard-failing on `git fetch
    // origin`. Existing-repo attachments (which have origin) rebase as before.
    if (!(await gitHasOriginRemote(cwd))) {
      return {
        kind: 'git_rebase_latest',
        status: 'passed',
        evidence_id: evidenceId('rebase'),
        reason: 'standalone target has no git origin to rebase onto; generated output is the tip',
      };
    }
    await runCommand('git', ['fetch', 'origin'], cwd, 300_000);
    try {
      await runCommand('git', ['rebase', '--autostash', `origin/${targetBranch}`], cwd, 300_000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const unmerged = message
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => /^[A-Z?]{2}\s+/u.test(line));
      if (unmerged.length > 0) {
        throw new Error(`git rebase conflict; unmerged paths:\n${unmerged.join('\n')}`);
      }
      throw error;
    }
    return { kind: 'git_rebase_latest', status: 'passed', evidence_id: evidenceId('rebase') };
  },

  /**
   * run_rebase_static_verification
   * Records post-rebase static verification evidence (status/evidence_id pass
   * through from the caller) AND reconciles the graduation audit artifact from
   * governed graduation.* state (pgas-new#100). This is the last guaranteed
   * action before the terminal pr_graduation mode (the session terminates on
   * pr_graduation entry, so there is no actionable round inside it), which makes
   * it the deterministic place to finalize the audit — no LLM sequencing.
   * side effects: rewrites the graduation audit markdown under the target repo.
   * The audit write is non-fatal: a failure records audit_finalized=false rather
   * than blocking graduation, and surfaces audit_error (never silent).
   */
  async run_rebase_static_verification(payload) {
    const domainRaw = (payload as { domain?: unknown }).domain;
    const domain = domainRaw && typeof domainRaw === 'object' && !Array.isArray(domainRaw)
      ? (domainRaw as Record<string, unknown>)
      : undefined;
    const rawStatus = optionalStringPayloadField(payload, 'status') ?? 'passed';
    const status = canonicalizeVerificationStatus(rawStatus) ?? rawStatus;
    const evidenceIdValue = optionalStringPayloadField(payload, 'evidence_id') ?? evidenceId('rebase-static');

    let auditPath = '';
    let auditFinalized = false;
    let auditError: string | undefined;
    if (domain) {
      try {
        auditPath = finalizeGraduationAudit(domain, status, evidenceIdValue);
        auditFinalized = true;
      } catch (error) {
        auditError = error instanceof Error ? error.message : String(error);
      }
    } else {
      auditError = 'no domain snapshot available to reconcile graduation audit';
    }

    return {
      kind: 'rebase_static_verification',
      status,
      evidence_id: evidenceIdValue,
      audit_finalized: auditFinalized,
      audit_path: auditPath,
      ...(auditError ? { audit_error: auditError } : {}),
    };
  },

  /**
   * open_pull_request
   * side effects: spawns gh pr create.
   * secret redaction: GITHUB_TOKEN is never logged or returned.
   * cwd safety: cwd must resolve inside program.target_dir.
   */
  async open_pull_request(payload) {
    const cwd = safeCwd(payload);
    const title = stringPayloadField(payload, 'title');
    const body = stringPayloadField(payload, 'body');
    const result = await runCommand('gh', ['pr', 'create', '--title', title, '--body', body], cwd, 120_000);
    const url = result.stdout.trim().split(/\s+/u).find((part) => part.startsWith('https://')) ?? '';
    const number = Number(url.match(/\/pull\/(\d+)/u)?.[1] ?? 0);
    return { url, number };
  },

  /**
   * load_wiring_manifest
   * side effects: reads <repo_root>/.pgas/wiring.yml.
   * secret redaction: does not read env, token files, or .npmrc.
   * cwd safety: no process spawn.
   */
  async load_wiring_manifest(payload) {
    const domain = optionalDomainFromPayload(payload);
    const repoRoot = optionalStringPayloadField(payload, 'repo_root')
      ?? (domain ? optionalStringDomainField(domain, 'program.target_dir') : undefined);
    if (!repoRoot) {
      throw new Error('missing string payload field: repo_root');
    }
    const manifestPath = join(repoRoot, WIRING_MANIFEST_PATH);
    if (!existsSync(manifestPath)) {
      writeMissingWiringCuratorRequest(repoRoot, manifestPath, domain, payload);
      throw new Error(`no wiring manifest at ${manifestPath}; foundry must lodge a curator request instead of writing`);
    }
    const result = readWiringManifest(repoRoot);
    if (!result.ok || !result.manifest) {
      throw new Error(`invalid wiring manifest at ${manifestPath}: ${result.errors.join('; ')}`);
    }
    return {
      kind: 'wiring_manifest_loaded',
      status: 'valid',
      path: WIRING_MANIFEST_PATH,
      write_authorized: true,
      wiring_manifest_json: JSON.stringify(result.manifest),
      allowed_imports: result.manifest.pgas.allowed_imports,
    };
  },

  /**
   * run_api_blackbox_verification
   * side effects: spawns npm test -- tests/api-blackbox.test.ts.
   * secret redaction: no env values are logged or returned.
   * cwd safety: cwd must resolve inside program.target_dir.
   */
  async run_api_blackbox_verification(payload) {
    const cwd = safeCwd(payload);
    const result = await runCommand('npm', ['test', '--', 'tests/api-blackbox.test.ts'], cwd, 180_000, { sanitizeEnv: true });
    return commandResult('npm test -- tests/api-blackbox.test.ts', result, 'static');
  },

  async run_smoke_verification(payload) {
    const cwd = safeCwd(payload);
    const result = await runCommand('npm', ['test', '--', 'tests/generated-program-smoke.test.ts'], cwd, 180_000, { sanitizeEnv: true });
    return { ...commandResult('npm test -- tests/generated-program-smoke.test.ts', result, 'smoke'), kind: 'smoke_verification' };
  },

  /**
   * run_live_provider_verification
   * side effects: probes provider URL, then spawns live-provider test when reachable.
   * secret redaction: provider URL may be returned on SKIP; API keys/env values are
   * never logged or returned.
   * cwd safety: cwd must resolve inside program.target_dir.
   */
  async run_live_provider_verification(payload) {
    const cwd = safeCwd(payload);
    const providerUrl = process.env.PGAS_OPENAI_BASE_URL ?? 'http://100.100.74.6:8000/v1';
    if (!(await isReachable(providerUrl))) {
      return { kind: 'live_provider_verification', status: 'skipped', reason: `provider unreachable: ${providerUrl}` };
    }
    const result = await runCommand('npm', ['test', '--', 'tests/live-provider.test.ts'], cwd, 600_000);
    return { ...commandResult('npm test -- tests/live-provider.test.ts', result, 'live'), kind: 'live_provider_verification' };
  },

  /**
   * web_research
   * side effects: none in v3.0; returns a stub and records integration debt.
   * secret redaction: no env values, API keys, or external results are read.
   * cwd safety: no process spawn.
   */
  async web_research(payload) {
    const domain = domainFromPayload(payload);
    if (domainValue(domain, 'intake.user_research_authorized') !== true) {
      throw new Error('user research requires explicit authorization');
    }
    return { kind: 'web_research_stub', query: stringPayloadField(payload, 'query'), results: [] };
  },
};

function designRevisionRequested(questionNumber: number): Record<string, unknown> {
  return {
    kind: 'pgas_new_design_revision_requested',
    question_number: questionNumber,
  };
}

function sessionIdFromPayload(payload: Record<string, unknown>): string {
  const direct = payload.session_id ?? payload.sessionId;
  if (typeof direct === 'string' && direct.length > 0) {
    return direct;
  }
  const domain = payload.domain;
  if (domain && typeof domain === 'object' && !Array.isArray(domain)) {
    const domainRecord = domain as Record<string, unknown>;
    const fromDomain = domainRecord.session_id ?? domainRecord.sessionId ?? domainRecord['session.id'];
    if (typeof fromDomain === 'string' && fromDomain.length > 0) {
      return fromDomain;
    }
  }
  throw new Error('synthesize_program_spec requires a session id in payload.session_id, payload.sessionId, or payload.domain');
}

function domainFromPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const domain = payload.domain;
  if (!domain || typeof domain !== 'object' || Array.isArray(domain)) {
    throw new Error('synthesize_program_spec requires payload.domain from the engine domain snapshot');
  }
  return domain as Record<string, unknown>;
}

function writeMissingWiringCuratorRequest(
  repoRoot: string,
  manifestPath: string,
  domain: Record<string, unknown> | undefined,
  payload: Record<string, unknown>,
): void {
  const slug = safeArtifactSlug(
    optionalStringPayloadField(payload, 'slug')
      ?? (domain ? optionalStringDomainField(domain, 'program.slug') : undefined)
      ?? 'missing-wiring',
  );
  const target = resolveCuratorTarget(repoRoot, slug);
  const relativePath = `audit/PGAS-NEW-${slug}.md`;
  const outPath = join(repoRoot, relativePath);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    renderMissingWiringRequest({
      githubOwner: target.githubOwner,
      githubRepo: target.githubRepo,
      reason: `missing ${WIRING_MANIFEST_PATH}: no wiring manifest at ${manifestPath}`,
      action: 'Publish or correct the binding wiring manifest at .pgas/wiring.yml.',
    }),
  );
}

function resolveCuratorTarget(repoRoot: string, fallbackRepo: string): { githubOwner: string; githubRepo: string } {
  const remote = readOriginRemote(repoRoot);
  if (remote) return remote;
  const repoName = safeArtifactSlug(basename(resolve(repoRoot))) || fallbackRepo;
  return { githubOwner: 'unknown', githubRepo: repoName };
}

function readOriginRemote(repoRoot: string): { githubOwner: string; githubRepo: string } | undefined {
  try {
    const config = readFileSync(join(repoRoot, '.git/config'), 'utf8');
    const match = config.match(/url\s*=\s*(?:git@github\.com:|https:\/\/github\.com\/)([^/\s]+)\/([^\s]+?)(?:\.git)?(?:\s|$)/u);
    if (!match) return undefined;
    return { githubOwner: match[1], githubRepo: match[2] };
  } catch {
    return undefined;
  }
}

function safeArtifactSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'missing-wiring';
}

function optionalDomainFromPayload(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const domain = payload.domain;
  if (!domain || typeof domain !== 'object' || Array.isArray(domain)) {
    return undefined;
  }
  return domain as Record<string, unknown>;
}

function curatorRequestRepoRoot(payload: Record<string, unknown>, domain: Record<string, unknown> | undefined): string {
  const repoRoot = optionalStringPayloadField(payload, 'repo_root')
    ?? (domain ? optionalStringDomainField(domain, 'repo.wiring_manifest.repo_root') : undefined)
    ?? (domain ? optionalStringDomainField(domain, 'program.target_dir') : undefined);
  if (!repoRoot) {
    throw new Error('create_curator_request requires repo_root in payload, repo.wiring_manifest.repo_root, or program.target_dir');
  }
  return repoRoot;
}

function defaultCuratorRequestBody(options: {
  programName: string;
  repoRoot: string;
  slug: string;
  message?: string;
}): string {
  return [
    `Program: ${options.programName} (\`${options.slug}\`)`,
    `Repository: ${options.repoRoot}`,
    '',
    `Context: ${options.message ?? 'pgas-new needs curator review before writing to this existing repo.'}`,
    '',
    'Requested action: Review the repository wiring and publish any required curator registration.',
  ].join('\n');
}

function humanizeSlug(slug: string): string {
  return slug
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ') || 'PGAS Program';
}

function stringDomainField(domain: Record<string, unknown>, path: string): string {
  const value = domainValue(domain, path);
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`missing string domain field: ${path}`);
  }
  return value;
}

function optionalStringDomainField(domain: Record<string, unknown>, path: string): string | undefined {
  const value = domainValue(domain, path);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Reconcile the graduation audit artifact from governed graduation.* state
 * (pgas-new#100). Returns the repo-relative path written. The post-rebase row
 * uses the current step's status/evidence because graduation.rebase_verification
 * is set by this same action and is not yet in the domain snapshot here.
 */
function finalizeGraduationAudit(
  domain: Record<string, unknown>,
  postRebaseStatus: string,
  postRebaseEvidenceId: string,
): string {
  const slug = stringDomainField(domain, 'program.slug');
  const name = optionalStringDomainField(domain, 'program.name') ?? humanizeSlug(slug);
  const targetDir = stringDomainField(domain, 'program.target_dir');
  const targetKind = optionalStringDomainField(domain, 'repo.target_kind')
    ?? optionalStringDomainField(domain, 'repo.kind');

  const relativePath = targetKind === 'existing_repo'
    ? `${trimSlashes(parseWiringManifestDomainField(domain).paths?.audit_dir ?? 'audit')}/PGAS-NEW-${slug}.md`
    : 'audit/PGAS-NEW-GRADUATION.md';

  const rows = graduationEvidenceRows({
    static_verification: optionalStringDomainField(domain, 'graduation.static_verification'),
    static_evidence_id: optionalStringDomainField(domain, 'graduation.static_evidence_id'),
    smoke_verification: optionalStringDomainField(domain, 'graduation.smoke_verification'),
    smoke_evidence_id: optionalStringDomainField(domain, 'graduation.smoke_evidence_id'),
    live_verification: optionalStringDomainField(domain, 'graduation.live_verification'),
    live_evidence_id: optionalStringDomainField(domain, 'graduation.live_evidence_id'),
    rebase_status: optionalStringDomainField(domain, 'graduation.rebase_status'),
    rebase_evidence_id: optionalStringDomainField(domain, 'graduation.rebase_evidence_id'),
    rebase_verification: postRebaseStatus,
    rebase_static_evidence_id: postRebaseEvidenceId,
  });

  const content = renderFinalizedGraduationAudit({ name, slug, rows });
  const outPath = join(targetDir, relativePath);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, content);
  return relativePath;
}

function planArtifactsFromPayload(payload: Record<string, unknown>) {
  const sessionId = sessionIdFromPayload(payload);
  const domain = domainFromPayload(payload);
  const synthesized = requireSynthesizedArtifact(sessionId);
  const program = {
    slug: stringDomainField(domain, 'program.slug'),
    name: stringDomainField(domain, 'program.name'),
  };
  const targetKind = optionalStringDomainField(domain, 'repo.target_kind') ?? optionalStringDomainField(domain, 'repo.kind');
  const plan = targetKind === 'existing_repo'
    ? createExistingRepoArtifactPlan(program, parseWiringManifestDomainField(domain), {
        stageSlugs: existingRepoStageSlugs(synthesized),
        requestedArtifactPaths: requestedArtifactPathsFromDomain(domain),
      })
    : createStandaloneArtifactPlan(program, {
        stageSlugs: synthesized.body_stage_slugs,
      });

  return plan.artifacts;
}

function existingRepoStageSlugs(synthesized: SynthesizedArtifact): string[] {
  const contextStages = synthesized.synthesis_context?.stages.map((stage) => stage.slug).filter((stage) => stage.length > 0);
  if (contextStages && contextStages.length > 0) {
    return contextStages;
  }
  if (synthesized.mode_names.length > 0) {
    return synthesized.mode_names;
  }
  return synthesized.body_stage_slugs;
}

function requestedArtifactPathsFromDomain(domain: Record<string, unknown>): string[] {
  return uniqueStrings(stringsFromDomain(domain).flatMap(extractRequestedArtifactPaths));
}

function stringsFromDomain(domain: Record<string, unknown>): string[] {
  const values: string[] = [];
  for (const path of [
    'inputs.user_decision.instruction',
    'inputs.user_text',
    'intake.purpose',
  ]) {
    const value = optionalStringDomainField(domain, path);
    if (value) values.push(value);
  }
  collectStrings(domainValue(domain, 'notebook.entries'), values);
  collectStrings(domainValue(domain, 'notebook.pins'), values);
  return values;
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStrings(item, out);
    }
  }
}

function extractRequestedArtifactPaths(text: string): string[] {
  const paths: string[] = [];
  const artifactPathPattern = /(?:^|[\s`'"])([A-Za-z0-9._/-]+\.(?:ts|tsx|yml|yaml|json|md|html|docx))(?:[\s.,;:)\]'"`]|$)/gu;
  for (const match of text.matchAll(artifactPathPattern)) {
    const path = match[1];
    if (path && isSafeRepoRelativePath(path)) {
      paths.push(path);
    }
  }
  return paths;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function parseWiringManifestDomainField(domain: Record<string, unknown>): WiringManifest {
  const value = domainValue(domain, 'repo.wiring_manifest_json') ?? domainValue(domain, 'repo.wiring_manifest');
  if (typeof value === 'string') {
    return JSON.parse(value) as WiringManifest;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const nestedJson = (value as Record<string, unknown>).wiring_manifest_json;
    if (typeof nestedJson === 'string') {
      return JSON.parse(nestedJson) as WiringManifest;
    }
    return value as WiringManifest;
  }
  const manifestRoot = optionalStringDomainField(domain, 'repo.wiring_manifest.repo_root')
    ?? optionalStringDomainField(domain, 'program.target_dir');
  if (
    manifestRoot &&
    domainValue(domain, 'repo.wiring_manifest.status') === 'valid' &&
    domainValue(domain, 'repo.wiring_manifest.path') === WIRING_MANIFEST_PATH
  ) {
    const result = readWiringManifest(manifestRoot);
    if (result.ok && result.manifest) {
      return result.manifest;
    }
  }
  throw new Error('existing-repo artifact planning requires repo.wiring_manifest_json');
}

function assertAllPlannedArtifactsWritten(domain: Record<string, unknown>, written: string[]): void {
  const planned = artifactPlanPathsFromDomain(domain);
  if (planned.length === 0) {
    return;
  }

  const writtenPaths = new Set(written);
  const missing = planned.filter((path) => !writtenPaths.has(path));
  if (missing.length > 0) {
    throw new Error(`branch_write did not write planned artifacts:\n${missing.join('\n')}`);
  }
}

function artifactPlanPathsFromDomain(domain: Record<string, unknown>): string[] {
  const value = domainValue(domain, 'artifact_plan.artifacts');
  const artifacts = typeof value === 'string' ? parseJsonArray(value, 'artifact_plan.artifacts') : value;
  if (!Array.isArray(artifacts)) {
    return [];
  }
  return uniqueStrings(
    artifacts.flatMap((artifact) => {
      if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
        return [];
      }
      const path = (artifact as Record<string, unknown>).path;
      return typeof path === 'string' && path.length > 0 ? [path] : [];
    }),
  );
}

function parseJsonArray(value: string, label: string): unknown[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must decode to an array`);
  }
  return parsed;
}

function synthesisOptionsFromDomain(domain: Record<string, unknown>): {
  targetKind: 'standalone_repo' | 'existing_repo';
  integrations: WiringManifest['integrations'];
} {
  const targetKind = optionalStringDomainField(domain, 'repo.target_kind') ?? optionalStringDomainField(domain, 'repo.kind');
  if (targetKind !== 'existing_repo') {
    return { targetKind: 'standalone_repo', integrations: [] };
  }
  const manifest = parseWiringManifestDomainField(domain);
  return {
    targetKind: 'existing_repo',
    integrations: manifest.integrations ?? [],
  };
}

function domainValue(domain: Record<string, unknown>, path: string): unknown {
  if (Object.prototype.hasOwnProperty.call(domain, path)) {
    return domain[path];
  }

  let current: unknown = domain;
  for (const segment of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function stringPayloadField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`missing string payload field: ${key}`);
  }
  return value;
}

function optionalStringPayloadField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalStageBodyGenerator(payload: Record<string, unknown>): StageBodyGenerator | undefined {
  const body = payload.__domain_synthesis_body;
  if (typeof body === 'string') {
    return async () => body;
  }
  const generator = payload.__domain_synthesis_generator;
  return typeof generator === 'function' ? generator as StageBodyGenerator : undefined;
}

function requireAcceptedStageSources(artifact: SynthesizedArtifact): Record<string, string> {
  const stageSources = artifact.stage_sources ?? {};
  const missing = artifact.body_stage_slugs.filter((stage) => typeof stageSources[stage] !== 'string');
  if (missing.length > 0) {
    throw new Error(`domain synthesis incomplete; missing accepted stage bodies: ${missing.join(', ')}`);
  }
  return stageSources;
}

interface ParsedCommand {
  executable: string;
  args: string[];
  label: string;
}

interface SkippedCommand {
  label: string;
  skipReason: string;
}

function typecheckCommandForPayload(payload: Record<string, unknown>, cwd: string): ParsedCommand | SkippedCommand {
  const domain = domainFromPayload(payload);
  const targetKind = optionalStringDomainField(domain, 'repo.target_kind') ?? optionalStringDomainField(domain, 'repo.kind');
  if (targetKind !== 'existing_repo') {
    return parseCommandLine('npm run typecheck');
  }

  const manifestCommand = attachedRepoStaticCommand(domain);
  if (manifestCommand) {
    return parseCommandLine(manifestCommand);
  }

  const packageScriptCommand = packageJsonStaticCommand(cwd);
  if (packageScriptCommand) {
    return parseCommandLine(packageScriptCommand);
  }

  return {
    label: 'attached repo static verification',
    skipReason: 'attached repo has no .pgas/wiring.yml verification.commands.typecheck/static/build command and no package.json typecheck/build script',
  };
}

function attachedRepoStaticCommand(domain: Record<string, unknown>): string | undefined {
  try {
    const manifest = parseWiringManifestDomainField(domain);
    return firstCommand(manifest.verification?.commands, ['typecheck', 'static', 'build']);
  } catch {
    return undefined;
  }
}

function firstCommand(commands: Record<string, string> | undefined, names: string[]): string | undefined {
  if (!commands) {
    return undefined;
  }
  for (const name of names) {
    const command = commands[name];
    if (typeof command === 'string' && command.trim().length > 0) {
      return command.trim();
    }
  }
  return undefined;
}

function packageJsonStaticCommand(cwd: string): string | undefined {
  const packageJsonPath = join(cwd, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return undefined;
  }
  const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) {
    return undefined;
  }
  const scriptNames = new Set(Object.keys(scripts as Record<string, unknown>));
  if (scriptNames.has('typecheck')) {
    return 'npm run typecheck';
  }
  if (scriptNames.has('build')) {
    return 'npm run build';
  }
  return undefined;
}

function parseCommandLine(commandLine: string): ParsedCommand {
  const parts = splitCommandLine(commandLine);
  const executable = parts[0];
  if (!executable) {
    throw new Error('verification command must not be empty');
  }
  return {
    executable,
    args: parts.slice(1),
    label: commandLine,
  };
}

function splitCommandLine(commandLine: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < commandLine.length; index += 1) {
    const char = commandLine[index] as string;
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else if (char === '\\' && quote === '"' && index + 1 < commandLine.length) {
        index += 1;
        current += commandLine[index] as string;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (current.length > 0) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    if (char === '\\' && index + 1 < commandLine.length) {
      index += 1;
      current += commandLine[index] as string;
      continue;
    }
    current += char;
  }
  if (quote) {
    throw new Error(`unterminated quote in verification command: ${commandLine}`);
  }
  if (current.length > 0) {
    parts.push(current);
  }
  return parts;
}

/**
 * True only when `cwd` is a git repository that has an `origin` remote. A fresh
 * standalone output (plain directory, or a git repo with no upstream) returns
 * false, letting git_rebase_latest skip the rebase gracefully (#106).
 */
async function gitHasOriginRemote(cwd: string): Promise<boolean> {
  try {
    const result = await runCommand('git', ['remote'], cwd, 30_000);
    return result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .includes('origin');
  } catch {
    // `git remote` fails when cwd is not a git repository.
    return false;
  }
}

/** True when `cwd` is inside a git work tree (a standalone output is not). */
async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await runCommand('git', ['rev-parse', '--is-inside-work-tree'], cwd, 30_000);
    return true;
  } catch {
    return false;
  }
}

function safeCwd(payload: Record<string, unknown>): string {
  const targetDir = resolve(stringDomainField(domainFromPayload(payload), 'program.target_dir'));
  const cwd = resolve(optionalStringPayloadField(payload, 'cwd') ?? targetDir);
  if (cwd !== targetDir && !cwd.startsWith(`${targetDir}${sep}`)) {
    throw new Error(`cwd must be inside program.target_dir (${targetDir}); got ${cwd}`);
  }
  return cwd;
}

interface ProcessResult {
  stdout: string;
  stderr: string;
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  options: { sanitizeEnv?: boolean } = {},
): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: options.sanitizeEnv ? sanitizedVerificationEnv(process.env) : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolveResult({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} failed (${code ?? signal}): ${tail(`${stderr}\n${stdout}`)}`));
    });
  });
}

function commandResult(command: string, result: ProcessResult, prefix: string): Record<string, unknown> {
  return {
    kind: 'command_result',
    command,
    status: 'passed',
    evidence_id: evidenceId(prefix),
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function skippedCommandResult(command: string, reason: string, prefix: string): Record<string, unknown> {
  return {
    kind: 'command_result',
    command,
    status: 'skipped',
    evidence_id: evidenceId(prefix),
    reason,
  };
}

function evidenceId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}`;
}

function tail(value: string): string {
  return value.slice(-1000);
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/gu, '');
}

async function isReachable(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
