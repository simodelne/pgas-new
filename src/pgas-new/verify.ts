import type { CommandRequest, CommandResult, CommandRunner, SemanticCommandId } from './command-runner.js';

export type VerificationStatus = 'pass' | 'fail' | 'skip';

export interface VerificationEvidence {
  command_id: SemanticCommandId | 'antiStubScan' | 'liveProviderRoundTrip' | 'generatedLiveDrive';
  cwd: string;
  exit_code: number | null;
  duration_ms: number;
  status: VerificationStatus;
  stdout_excerpt?: string;
  stderr_excerpt?: string;
  output_path?: string;
}

export interface VerificationOptions {
  cwd: string;
  runner: CommandRunner;
}

export interface AntiStubFinding {
  path: string;
  marker: string;
  reason: string;
}

export interface LiveProviderVerifier {
  verify(request: {
    cwd: string;
    env: Record<string, string | undefined>;
  }): Promise<Omit<VerificationEvidence, 'command_id' | 'cwd'>>;
}

export async function runStaticVerification(options: VerificationOptions): Promise<VerificationEvidence[]> {
  const request = commandRequest(options);
  return evidenceFor([
    await options.runner.npmInstall(request),
    await options.runner.npmTypecheck(request),
    await options.runner.npmTest(request),
    await options.runner.runGeneratedStaticTests(request),
  ]);
}

export async function runSmokeVerification(
  options: VerificationOptions & { executedOutputs?: unknown[] },
): Promise<VerificationEvidence[]> {
  const findings = (options.executedOutputs ?? []).flatMap((output, index) =>
    findExecutedPathStubMarkers(output).map((finding) => ({
      ...finding,
      path: `executedOutputs[${index}]${finding.path}`,
    })),
  );
  const antiStubEvidence = antiStubEvidenceFor(options.cwd, findings);
  if (findings.length > 0) {
    return [antiStubEvidence];
  }

  return [
    antiStubEvidence,
    ...evidenceFor([await options.runner.runGeneratedSmokeTest(commandRequest(options))]),
  ];
}

export function assertNoExecutedPathStubs(value: unknown): void {
  const findings = findExecutedPathStubMarkers(value);
  if (findings.length > 0) {
    throw new Error(`executed output contains stub markers: ${formatAntiStubFindings(findings)}`);
  }
}

export function findExecutedPathStubMarkers(value: unknown): AntiStubFinding[] {
  const findings: AntiStubFinding[] = [];
  scanExecutedValue(value, '', findings);
  return findings;
}

export async function runPostRebaseVerification(
  options: VerificationOptions & { branch: string },
): Promise<VerificationEvidence[]> {
  const request = commandRequest(options);
  return [
    ...evidenceFor([await options.runner.gitStatus(request), await options.runner.gitRebaseLatest(request)]),
    ...(await runStaticVerification(options)),
  ];
}

export async function runLiveProviderVerification(
  options: { cwd: string; env: Record<string, string | undefined>; verifier?: LiveProviderVerifier },
): Promise<VerificationEvidence[]> {
  const requireLive = options.env.PGAS_REQUIRE_LIVE === '1';
  if (!nonEmpty(options.env.PGAS_LIVE_PROVIDER) || !nonEmpty(options.env.PGAS_API_BASE) || !nonEmpty(options.env.PGAS_API_TOKEN)) {
    if (requireLive) {
      return [
        {
          command_id: 'liveProviderRoundTrip',
          cwd: options.cwd,
          duration_ms: 0,
          exit_code: 1,
          status: 'fail',
          stderr_excerpt: 'PGAS_REQUIRE_LIVE=1 requires PGAS_LIVE_PROVIDER, PGAS_API_BASE, and PGAS_API_TOKEN',
        },
      ];
    }
    return [
      {
        command_id: 'liveProviderRoundTrip',
        cwd: options.cwd,
        duration_ms: 0,
        exit_code: null,
        status: 'skip',
        stdout_excerpt: 'missing PGAS_LIVE_PROVIDER, PGAS_API_BASE, or PGAS_API_TOKEN',
      },
    ];
  }

  if (!options.verifier) {
    return [
      {
        command_id: 'liveProviderRoundTrip',
        cwd: options.cwd,
        duration_ms: 0,
        exit_code: null,
        status: 'fail',
        stderr_excerpt:
          'live provider env present (PGAS_LIVE_PROVIDER + PGAS_API_BASE + PGAS_API_TOKEN) but verifier not configured — graduation cannot proceed',
      },
    ];
  }

  const result = await options.verifier.verify({ cwd: options.cwd, env: options.env });
  if (requireLive && result.status === 'skip') {
    return [
      {
        ...result,
        command_id: 'liveProviderRoundTrip',
        cwd: options.cwd,
        exit_code: result.exit_code === null || result.exit_code === 0 ? 1 : result.exit_code,
        status: 'fail',
        stderr_excerpt: result.stderr_excerpt ?? 'PGAS_REQUIRE_LIVE=1 forbids skipped live-provider verification',
      },
    ];
  }

  return [
    {
      ...result,
      command_id: 'liveProviderRoundTrip',
      cwd: options.cwd,
    },
  ];
}

export interface GeneratedLiveDriveVerifier {
  verify(request: {
    cwd: string;
    env: Record<string, string | undefined>;
  }): Promise<Omit<VerificationEvidence, 'command_id' | 'cwd'>>;
}

/**
 * Generated-program live-drive rung (hard-required for graduation): a rendered
 * generated program must be driven to its completion stage by a REAL provider
 * making the per-stage/reasoning decisions. Mirrors runLiveProviderVerification:
 * missing env skips (or fails under PGAS_REQUIRE_LIVE=1); env present without a
 * verifier fails — graduation must never silently pass this rung.
 */
export async function runGeneratedLiveDriveVerification(
  options: { cwd: string; env: Record<string, string | undefined>; verifier?: GeneratedLiveDriveVerifier },
): Promise<VerificationEvidence[]> {
  const requireLive = options.env.PGAS_REQUIRE_LIVE === '1';
  const model = nonEmpty(options.env.PGAS_OPENAI_MODEL) ?? nonEmpty(options.env.PGAS_MODEL);
  if (!nonEmpty(options.env.PGAS_OPENAI_BASE_URL) || !model) {
    if (requireLive) {
      return [
        {
          command_id: 'generatedLiveDrive',
          cwd: options.cwd,
          duration_ms: 0,
          exit_code: 1,
          status: 'fail',
          stderr_excerpt: 'PGAS_REQUIRE_LIVE=1 requires PGAS_OPENAI_BASE_URL and PGAS_OPENAI_MODEL (or PGAS_MODEL)',
        },
      ];
    }
    return [
      {
        command_id: 'generatedLiveDrive',
        cwd: options.cwd,
        duration_ms: 0,
        exit_code: null,
        status: 'skip',
        stdout_excerpt: 'missing PGAS_OPENAI_BASE_URL or PGAS_OPENAI_MODEL/PGAS_MODEL',
      },
    ];
  }

  if (!options.verifier) {
    return [
      {
        command_id: 'generatedLiveDrive',
        cwd: options.cwd,
        duration_ms: 0,
        exit_code: null,
        status: 'fail',
        stderr_excerpt:
          'generated live-drive env present (PGAS_OPENAI_BASE_URL + model) but verifier not configured — graduation cannot proceed',
      },
    ];
  }

  const result = await options.verifier.verify({ cwd: options.cwd, env: options.env });
  if (requireLive && result.status === 'skip') {
    return [
      {
        ...result,
        command_id: 'generatedLiveDrive',
        cwd: options.cwd,
        exit_code: result.exit_code === null || result.exit_code === 0 ? 1 : result.exit_code,
        status: 'fail',
        stderr_excerpt: result.stderr_excerpt ?? 'PGAS_REQUIRE_LIVE=1 forbids skipped generated live-drive verification',
      },
    ];
  }

  return [
    {
      ...result,
      command_id: 'generatedLiveDrive',
      cwd: options.cwd,
    },
  ];
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function createMockCommandRunner(): CommandRunner & { calls: SemanticCommandId[] } {
  const calls: SemanticCommandId[] = [];
  const run = async (command_id: SemanticCommandId, request: CommandRequest): Promise<CommandResult> => {
    calls.push(command_id);
    return {
      command_id,
      cwd: request.cwd,
      duration_ms: 1,
      exit_code: 0,
      stdout_excerpt: `${command_id} ok`,
    };
  };

  return {
    calls,
    npmInstall: (request) => run('npmInstall', request),
    npmTypecheck: (request) => run('npmTypecheck', request),
    npmTest: (request) => run('npmTest', request),
    runGeneratedStaticTests: (request) => run('runGeneratedStaticTests', request),
    runGeneratedSmokeTest: (request) => run('runGeneratedSmokeTest', request),
    gitStatus: (request) => run('gitStatus', request),
    gitRebaseLatest: (request) => run('gitRebaseLatest', request),
    ghCreatePr: (request) => run('ghCreatePr', request),
  };
}

function scanExecutedValue(value: unknown, path: string, findings: AntiStubFinding[]): void {
  if (typeof value === 'string') {
    scanExecutedString(value, path, findings);
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      findings.push({ path, marker: 'empty_array', reason: 'default [] fallback output' });
    }
    value.forEach((item, index) => scanExecutedValue(item, `${path}[${index}]`, findings));
    return;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.entries(record);
  if (entries.length === 0) {
    findings.push({ path, marker: 'empty_object', reason: 'default {} fallback output' });
    return;
  }

  if (record.kind === 'stage_action_stub') {
    findings.push({ path: appendPath(path, 'kind'), marker: 'stage_action_stub', reason: 'stub action kind reached executed path' });
  }

  for (const [key, child] of entries) {
    const childPath = appendPath(path, key);
    if (key.toLowerCase() === 'todo') {
      findings.push({ path: childPath, marker: 'todo', reason: 'todo field reached executed path' });
    }
    scanExecutedValue(child, childPath, findings);
  }
}

function scanExecutedString(value: string, path: string, findings: AntiStubFinding[]): void {
  const trimmed = value.trim();
  if (trimmed === '{}') {
    findings.push({ path, marker: 'empty_object', reason: 'default {} fallback output encoded as JSON string' });
  }
  if (trimmed === '[]') {
    findings.push({ path, marker: 'empty_array', reason: 'default [] fallback output encoded as JSON string' });
  }

  const markers = [
    { marker: 'stage_action_stub', pattern: /stage_action_stub/u, reason: 'stub action marker reached executed path' },
    { marker: 'TODO', pattern: /\bTODO\b(?!\(real-service-swap\))/u, reason: 'unsafe TODO marker reached executed path' },
    { marker: 'not_implemented', pattern: /not implemented|not_implemented/u, reason: 'not-implemented marker reached executed path' },
    { marker: 'placeholder', pattern: /\bplaceholder\b/u, reason: 'placeholder marker reached executed path' },
  ];
  for (const candidate of markers) {
    if (candidate.pattern.test(value)) {
      findings.push({ path, marker: candidate.marker, reason: candidate.reason });
    }
  }
}

function appendPath(path: string, key: string): string {
  return path ? `${path}.${key}` : `.${key}`;
}

function antiStubEvidenceFor(cwd: string, findings: AntiStubFinding[]): VerificationEvidence {
  return {
    command_id: 'antiStubScan',
    cwd,
    duration_ms: 0,
    exit_code: findings.length === 0 ? 0 : 1,
    status: findings.length === 0 ? 'pass' : 'fail',
    ...(findings.length === 0
      ? { stdout_excerpt: 'anti-stub scan passed' }
      : { stderr_excerpt: formatAntiStubFindings(findings) }),
  };
}

function formatAntiStubFindings(findings: AntiStubFinding[]): string {
  return findings.map((finding) => `${finding.path || '.'}: ${finding.marker} (${finding.reason})`).join('\n');
}

function evidenceFor(results: CommandResult[]): VerificationEvidence[] {
  return results.map((result) => ({
    command_id: result.command_id,
    cwd: result.cwd,
    duration_ms: result.duration_ms,
    exit_code: result.exit_code,
    status: result.exit_code === 0 ? 'pass' : 'fail',
    stdout_excerpt: result.stdout_excerpt,
    stderr_excerpt: result.stderr_excerpt,
    output_path: result.output_path,
  }));
}

function commandRequest(options: VerificationOptions & { branch?: string; env?: Record<string, string | undefined> }): CommandRequest {
  return {
    cwd: options.cwd,
    branch: options.branch,
    env: options.env,
  };
}
