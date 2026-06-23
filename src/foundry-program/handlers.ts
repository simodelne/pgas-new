import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { ReactionHandler, ToolHandler } from '@simodelne/pgas-server/plugin.js';
import { createExistingRepoArtifactPlan, createStandaloneArtifactPlan } from '../pgas-new/artifact-plan.js';
import { renderExistingRepoAttachment, renderStandaloneScaffold } from '../pgas-new/template-renderer.js';
import {
  WIRING_MANIFEST_PATH,
  loadWiringManifest as readWiringManifest,
  type WiringManifest,
} from '../pgas-new/wiring-manifest.js';
import { synthesizeProgramSpecFromDomain } from './synthesizer.js';
import { putSynthesizedArtifact, requireSynthesizedArtifact } from './synthesizer-store.js';

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
  const normalizedRawValue = unescapeCommonHtmlEntities(rawValue);
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
    return mutations.length > 0 ? { mutations } : undefined;
  }],
]);

export const handlers: Record<string, ToolHandler> = {
  async synthesize_program_spec(payload) {
    const sessionId = sessionIdFromPayload(payload);
    const synthesized = synthesizeProgramSpecFromDomain(domainFromPayload(payload));
    putSynthesizedArtifact(sessionId, {
      spec_yaml: synthesized.spec_yaml,
      mode_names: synthesized.mode_names,
      sha256: synthesized.sha256,
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
    const delegation = optionalJsonField(payload, 'delegation', 'delegation_json', 'object');
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
    const sessionId = sessionIdFromPayload(payload);
    const domain = domainFromPayload(payload);
    requireSynthesizedArtifact(sessionId);
    const program = {
      slug: stringDomainField(domain, 'program.slug'),
      name: stringDomainField(domain, 'program.name'),
    };
    const targetKind = optionalStringDomainField(domain, 'repo.target_kind') ?? optionalStringDomainField(domain, 'repo.kind');
    const plan = targetKind === 'existing_repo'
      ? createExistingRepoArtifactPlan(program, parseWiringManifestDomainField(domain))
      : createStandaloneArtifactPlan(program);

    return plan.artifacts;
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

  /**
   * create_curator_request
   * side effects: writes a markdown request under the manifest audit_dir.
   * secret redaction: request bodies are written as provided; handler never reads
   * env vars or token files.
   */
  async create_curator_request(payload) {
    const repoRoot = stringPayloadField(payload, 'repo_root');
    const slug = optionalStringPayloadField(payload, 'slug') ?? stringDomainField(domainFromPayload(payload), 'program.slug');
    const title = stringPayloadField(payload, 'title');
    const body = stringPayloadField(payload, 'body');
    const manifest = parseWiringManifestDomainField(domainFromPayload(payload));
    const relativePath = `${trimSlashes(manifest.paths.audit_dir)}/PGAS-NEW-${slug}.md`;
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
    const result = targetKind === 'existing_repo'
      ? renderExistingRepoAttachment({
          ...program,
          repoRoot: targetDir,
          manifest: parseWiringManifestDomainField(domain),
          synthesizedSpecYaml: synthesized.spec_yaml,
        })
      : renderStandaloneScaffold({
          ...program,
          outDir: targetDir,
          synthesizedSpecYaml: synthesized.spec_yaml,
        });

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
    const result = await runCommand('npm', ['install', '--no-audit', '--no-fund'], cwd, 300_000);
    return commandResult('npm install --no-audit --no-fund', result, 'install');
  },

  /**
   * npm_typecheck
   * side effects: spawns npm run typecheck.
   * secret redaction: no env values are logged or returned.
   * cwd safety: cwd must resolve inside program.target_dir.
   */
  async npm_typecheck(payload) {
    const cwd = safeCwd(payload);
    const result = await runCommand('npm', ['run', 'typecheck'], cwd, 120_000);
    return commandResult('npm run typecheck', result, 'static');
  },

  /**
   * npm_test
   * side effects: spawns npm test.
   * secret redaction: no env values are logged or returned.
   * cwd safety: cwd must resolve inside program.target_dir.
   */
  async npm_test(payload) {
    const cwd = safeCwd(payload);
    const result = await runCommand('npm', ['test'], cwd, 180_000);
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
    const result = await runCommand('git', ['status', '--porcelain'], cwd, 60_000);
    const lines = result.stdout.split(/\r?\n/u).filter(Boolean);
    return { clean: lines.length === 0, lines };
  },

  /**
   * git_rebase_latest
   * side effects: spawns git fetch origin, then git rebase origin/<target_branch>.
   * secret redaction: no env values are logged or returned.
   * cwd safety: cwd must resolve inside program.target_dir.
   */
  async git_rebase_latest(payload) {
    const cwd = safeCwd(payload);
    const targetBranch = stringPayloadField(payload, 'target_branch');
    await runCommand('git', ['fetch', 'origin'], cwd, 300_000);
    try {
      await runCommand('git', ['rebase', `origin/${targetBranch}`], cwd, 300_000);
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
    return { kind: 'git_rebase_latest', status: 'success', evidence_id: evidenceId('rebase') };
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
    const result = await runCommand('npm', ['test', '--', 'tests/api-blackbox.test.ts'], cwd, 180_000);
    return commandResult('npm test -- tests/api-blackbox.test.ts', result, 'static');
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

function optionalDomainFromPayload(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const domain = payload.domain;
  if (!domain || typeof domain !== 'object' || Array.isArray(domain)) {
    return undefined;
  }
  return domain as Record<string, unknown>;
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

function safeCwd(payload: Record<string, unknown>): string {
  const cwd = resolve(stringPayloadField(payload, 'cwd'));
  const targetDir = resolve(stringDomainField(domainFromPayload(payload), 'program.target_dir'));
  if (cwd !== targetDir && !cwd.startsWith(`${targetDir}${sep}`)) {
    throw new Error(`cwd must be inside program.target_dir (${targetDir}); got ${cwd}`);
  }
  return cwd;
}

interface ProcessResult {
  stdout: string;
  stderr: string;
}

function runCommand(command: string, args: string[], cwd: string, timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
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
