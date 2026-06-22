import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { ToolHandler } from '@simodelne/pgas-server/plugin.js';
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

function optionalJsonField(payload: Record<string, unknown>, structuredKey: string, jsonKey: string): unknown {
  const structuredValue = payload[structuredKey];
  if (structuredValue !== undefined) return structuredValue;

  const jsonValue = payload[jsonKey];
  if (typeof jsonValue !== 'string') {
    throw new Error(`missing JSON-string payload field: ${jsonKey}`);
  }
  return JSON.parse(jsonValue) as unknown;
}

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
    return {
      kind: 'pgas_new_q3_stages_recorded',
      stages: optionalJsonField(payload, 'stages', 'stages_json'),
    };
  },

  async record_q4_transitions(payload) {
    return {
      kind: 'pgas_new_q4_transitions_recorded',
      transitions: optionalJsonField(payload, 'transitions', 'transitions_json'),
    };
  },

  async record_q5_delegation(payload) {
    return {
      kind: 'pgas_new_q5_delegation_recorded',
      delegation: optionalJsonField(payload, 'delegation', 'delegation_json'),
    };
  },

  async record_q6_completion(payload) {
    return {
      kind: 'pgas_new_q6_completion_recorded',
      completion: optionalJsonField(payload, 'completion', 'completion_json'),
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
    const repoRoot = stringPayloadField(payload, 'repo_root');
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
    return value as WiringManifest;
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
