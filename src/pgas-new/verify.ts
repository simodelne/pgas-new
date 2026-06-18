import type { CommandRequest, CommandResult, CommandRunner, SemanticCommandId } from './command-runner.js';

export type VerificationStatus = 'pass' | 'fail' | 'skip';

export interface VerificationEvidence {
  command_id: SemanticCommandId | 'runLiveProviderVerification';
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

export async function runStaticVerification(options: VerificationOptions): Promise<VerificationEvidence[]> {
  const request = commandRequest(options);
  return evidenceFor([
    await options.runner.npmInstall(request),
    await options.runner.npmTypecheck(request),
    await options.runner.npmTest(request),
    await options.runner.runGeneratedStaticTests(request),
  ]);
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
  options: VerificationOptions & { env: Record<string, string | undefined> },
): Promise<VerificationEvidence[]> {
  if (!options.env.PGAS_LIVE_PROVIDER || !options.env.PGAS_API_BASE || !options.env.PGAS_API_TOKEN) {
    return [
      {
        command_id: 'runLiveProviderVerification',
        cwd: options.cwd,
        duration_ms: 0,
        exit_code: null,
        status: 'skip',
        stdout_excerpt: 'missing PGAS_LIVE_PROVIDER, PGAS_API_BASE, or PGAS_API_TOKEN',
      },
    ];
  }

  return evidenceFor([await options.runner.runLiveProviderVerification(commandRequest(options))]);
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
    runLiveProviderVerification: (request) => run('runLiveProviderVerification', request),
    gitStatus: (request) => run('gitStatus', request),
    gitRebaseLatest: (request) => run('gitRebaseLatest', request),
    ghCreatePr: (request) => run('ghCreatePr', request),
  };
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
