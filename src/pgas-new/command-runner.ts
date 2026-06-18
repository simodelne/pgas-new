export type SemanticCommandId =
  | 'npmInstall'
  | 'npmTypecheck'
  | 'npmTest'
  | 'runGeneratedStaticTests'
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
  gitStatus(request: CommandRequest): Promise<CommandResult>;
  gitRebaseLatest(request: CommandRequest): Promise<CommandResult>;
  ghCreatePr(request: CommandRequest): Promise<CommandResult>;
}
