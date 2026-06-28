import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';

export type SemanticCommandId =
  | 'npmInstall'
  | 'npmTypecheck'
  | 'npmTest'
  | 'runGeneratedStaticTests'
  | 'runGeneratedSmokeTest'
  | 'gitStatus'
  | 'gitRebaseLatest'
  | 'ghCreatePr';

export interface CommandRequest {
  cwd: string;
  branch?: string;
  env?: Record<string, string | undefined>;
}

export interface CommandResult {
  command_id: SemanticCommandId;
  cwd: string;
  exit_code: number;
  duration_ms: number;
  stdout_excerpt: string;
  stderr_excerpt?: string;
  output_path?: string;
}

export interface CommandRunner {
  npmInstall(request: CommandRequest): Promise<CommandResult>;
  npmTypecheck(request: CommandRequest): Promise<CommandResult>;
  npmTest(request: CommandRequest): Promise<CommandResult>;
  runGeneratedStaticTests(request: CommandRequest): Promise<CommandResult>;
  runGeneratedSmokeTest(request: CommandRequest): Promise<CommandResult>;
  gitStatus(request: CommandRequest): Promise<CommandResult>;
  gitRebaseLatest(request: CommandRequest): Promise<CommandResult>;
  ghCreatePr(request: CommandRequest): Promise<CommandResult>;
}

interface SpawnedProcess {
  stdout?: Readable | null;
  stderr?: Readable | null;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: (code: number | null) => void): this;
}

export type SpawnImpl = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; shell: false },
) => SpawnedProcess;

type CommandSpec =
  | { command: string; args: string[] }
  | { sequence: Array<{ command: string; args: string[] }> };

const MAX_EXCERPT_LENGTH = 4000;

export function createNodeCommandRunner(spawnImpl: SpawnImpl = spawn as unknown as SpawnImpl): CommandRunner {
  return {
    npmInstall: (request) => runSemanticCommand('npmInstall', request, { command: 'npm', args: ['install', '--no-audit', '--no-fund'] }, spawnImpl),
    npmTypecheck: (request) => runSemanticCommand('npmTypecheck', request, { command: 'npm', args: ['run', 'typecheck'] }, spawnImpl),
    npmTest: (request) => runSemanticCommand('npmTest', request, { command: 'npm', args: ['test'] }, spawnImpl),
    runGeneratedStaticTests: (request) =>
      runSemanticCommand('runGeneratedStaticTests', request, { command: 'npm', args: ['run', 'test:static'] }, spawnImpl),
    runGeneratedSmokeTest: (request) =>
      runSemanticCommand('runGeneratedSmokeTest', request, { command: 'npm', args: ['test', '--', 'tests/generated-program-smoke.test.ts'] }, spawnImpl),
    gitStatus: (request) => runSemanticCommand('gitStatus', request, { command: 'git', args: ['status', '--short'] }, spawnImpl),
    gitRebaseLatest: (request) => {
      const branch = request.branch ?? 'main';
      if (!isSafeGitBranchName(branch)) {
        return Promise.resolve(invalidCommandResult('gitRebaseLatest', request, `invalid git branch name: ${branch}`));
      }
      return runSemanticCommand(
        'gitRebaseLatest',
        request,
        {
          sequence: [
            { command: 'git', args: ['fetch', 'origin', branch, '--prune'] },
            { command: 'git', args: ['rebase', `origin/${branch}`] },
          ],
        },
        spawnImpl,
      );
    },
    ghCreatePr: (request) => runSemanticCommand('ghCreatePr', request, { command: 'gh', args: ['pr', 'create', '--fill'] }, spawnImpl),
  };
}

export function isSafeGitBranchName(branch: string): boolean {
  if (branch.length === 0 || branch.startsWith('-') || branch.endsWith('/') || branch.endsWith('.')) {
    return false;
  }

  if (/[\s\0~^:?*[\]\\]/u.test(branch)) {
    return false;
  }

  if (branch.includes('..') || branch.includes('//') || branch.includes('@{')) {
    return false;
  }

  return branch.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..' && !part.endsWith('.lock'));
}

async function runSemanticCommand(
  commandId: SemanticCommandId,
  request: CommandRequest,
  spec: CommandSpec,
  spawnImpl: SpawnImpl,
): Promise<CommandResult> {
  const started = Date.now();
  const steps = 'sequence' in spec ? spec.sequence : [spec];
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode = 0;

  for (const step of steps) {
    const result = await runProcess(step.command, step.args, request, spawnImpl);
    stdout.push(result.stdout);
    stderr.push(result.stderr);
    exitCode = result.exitCode;
    if (exitCode !== 0) {
      break;
    }
  }

  return {
    command_id: commandId,
    cwd: request.cwd,
    exit_code: exitCode,
    duration_ms: Date.now() - started,
    stdout_excerpt: excerpt(stdout.join('\n')),
    stderr_excerpt: excerpt(stderr.join('\n')),
  };
}

function runProcess(
  command: string,
  args: string[],
  request: CommandRequest,
  spawnImpl: SpawnImpl,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawnImpl(command, args, {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
    } else {
      stderr += '[command-runner] child stdout not piped — output not captured\n';
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
    } else {
      stderr += '[command-runner] child stderr not piped — output not captured\n';
    }
    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      stderr += error.message;
      resolve({ exitCode: 1, stdout, stderr });
    });
    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function excerpt(value: string): string {
  if (value.length <= MAX_EXCERPT_LENGTH) {
    return value;
  }

  return value.slice(-MAX_EXCERPT_LENGTH);
}

function invalidCommandResult(
  commandId: SemanticCommandId,
  request: CommandRequest,
  message: string,
): CommandResult {
  return {
    command_id: commandId,
    cwd: request.cwd,
    exit_code: 1,
    duration_ms: 0,
    stdout_excerpt: '',
    stderr_excerpt: message,
  };
}
