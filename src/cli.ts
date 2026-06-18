import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createExistingRepoArtifactPlan, createStandaloneArtifactPlan } from './pgas-new/artifact-plan.js';
import { prepareExistingRepoAttachment } from './pgas-new/existing-repo.js';
import {
  renderExistingRepoAttachment,
  renderStandaloneScaffold,
  type ProgramTemplate,
} from './pgas-new/template-renderer.js';
import { loadWiringManifest } from './pgas-new/wiring-manifest.js';
import { PGAS_SERVER_PACKAGE, PGAS_SERVER_VERSION } from './pgas-new/version.js';
import { isPgasNewSessionControl } from './pgas-new/control-plane.js';

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ParsedOptions {
  _: string[];
  [key: string]: string | string[];
}

export async function runCli(argv: string[]): Promise<CliResult> {
  try {
    if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
      return ok(helpText());
    }

    const parsed = parseArgs(argv);
    const [command, subcommand] = parsed._;

    switch (command) {
      case 'help':
        return ok(helpText());
      case 'version':
        return ok(`pgas-new\nPGAS server: ${PGAS_SERVER_PACKAGE}@${PGAS_SERVER_VERSION}`);
      case 'session':
        return sessionCommand(subcommand);
      case 'plan-standalone':
        return planStandalone(parsed);
      case 'render-standalone':
        return renderStandalone(parsed);
      case 'validate-manifest':
        return validateManifest(parsed);
      case 'plan-attach':
        return planAttach(parsed);
      case 'render-attach':
        return renderAttach(parsed);
      case 'curator-request':
        return curatorRequest(parsed);
      default:
        return fail(`unknown command: ${command ?? '(none)'}`, 2);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error), 1);
  }
}

function sessionCommand(command: string | undefined): CliResult {
  if (!isPgasNewSessionControl(command)) {
    return fail('unknown session command', 2);
  }

  return ok(`control:${command}`);
}

function planStandalone(options: ParsedOptions): CliResult {
  const program = programOptions(options);
  const plan = createStandaloneArtifactPlan(program);
  return ok(formatPlan(plan.artifacts.map((artifact) => artifact.path)));
}

function renderStandalone(options: ParsedOptions): CliResult {
  const program = programOptions(options);
  const outDir = required(options, 'out');
  const result = renderStandaloneScaffold({
    outDir,
    ...program,
    githubOwner: optional(options, 'github-owner'),
    githubRepo: optional(options, 'github-repo'),
  });

  return ok(`written\n${formatPlan(result.written)}`);
}

function validateManifest(options: ParsedOptions): CliResult {
  const repo = required(options, 'repo');
  const result = loadWiringManifest(repo);

  if (!result.ok) {
    return fail(result.errors.join('\n'), 1);
  }

  return ok(`valid ${repo}/.pgas/wiring.yml`);
}

function planAttach(options: ParsedOptions): CliResult {
  const repo = required(options, 'repo');
  const program = programOptions(options);
  const manifest = loadWiringManifest(repo);
  if (!manifest.ok || !manifest.manifest) {
    return fail(manifest.errors.join('\n'), 1);
  }

  const plan = createExistingRepoArtifactPlan(program, manifest.manifest);
  return ok(formatPlan(plan.artifacts.map((artifact) => artifact.path)));
}

function renderAttach(options: ParsedOptions): CliResult {
  const repo = required(options, 'repo');
  const program = programOptions(options);
  const manifest = loadWiringManifest(repo);
  if (!manifest.ok || !manifest.manifest) {
    return fail(manifest.errors.join('\n'), 1);
  }

  const result = renderExistingRepoAttachment({
    repoRoot: repo,
    manifest: manifest.manifest,
    ...program,
  });

  return ok(`written\n${formatPlan(result.written)}`);
}

function curatorRequest(options: ParsedOptions): CliResult {
  const repo = required(options, 'repo');
  const manifest = loadWiringManifest(repo);
  const target = resolveTargetRepo(repo, options, manifest.manifest);
  const result = prepareExistingRepoAttachment(repo, {
    ...programOptions(options),
    githubOwner: target.githubOwner,
    githubRepo: target.githubRepo,
  });

  if (result.ok) {
    return ok(result.registration_request);
  }

  return ok(result.curator_request);
}

function resolveTargetRepo(
  repo: string,
  options: ParsedOptions,
  manifest?: { curator: { github_owner: string; github_repo: string } },
): { githubOwner: string; githubRepo: string } {
  const explicitOwner = optional(options, 'github-owner');
  const explicitRepo = optional(options, 'github-repo');
  if (explicitOwner && explicitRepo) {
    return { githubOwner: explicitOwner, githubRepo: explicitRepo };
  }

  if (manifest) {
    return { githubOwner: manifest.curator.github_owner, githubRepo: manifest.curator.github_repo };
  }

  const remote = readOriginRemote(repo);
  if (remote) {
    return remote;
  }

  throw new Error('missing target repo: provide --github-owner/--github-repo or configure remote.origin.url');
}

function readOriginRemote(repo: string): { githubOwner: string; githubRepo: string } | undefined {
  try {
    const config = readFileSync(join(repo, '.git/config'), 'utf8');
    const match = config.match(/url\s*=\s*(?:git@github\.com:|https:\/\/github\.com\/)([^/\s]+)\/([^\s]+?)(?:\.git)?(?:\s|$)/);
    if (!match) {
      return undefined;
    }
    return { githubOwner: match[1], githubRepo: match[2] };
  } catch {
    return undefined;
  }
}

function parseArgs(argv: string[]): ParsedOptions {
  const parsed: ParsedOptions = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`missing value for --${key}`);
      }
      parsed[key] = value;
      index += 1;
    } else {
      parsed._.push(token);
    }
  }

  return parsed;
}

function programOptions(options: ParsedOptions): {
  slug: string;
  name: string;
  template?: ProgramTemplate;
  mandate?: string;
} {
  return {
    slug: required(options, 'slug'),
    name: required(options, 'name'),
    template: templateOption(options),
    mandate: optional(options, 'mandate'),
  };
}

function templateOption(options: ParsedOptions): ProgramTemplate | undefined {
  const value = optional(options, 'template');
  if (!value) {
    return undefined;
  }
  if (value === 'pgas-new-foundry' || value === 'policy-drafting') {
    return value;
  }
  throw new Error('invalid --template: expected pgas-new-foundry or policy-drafting');
}

function required(options: ParsedOptions, key: string): string {
  const value = options[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`missing --${key}`);
  }

  return value;
}

function optional(options: ParsedOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function formatPlan(paths: string[]): string {
  return paths.map((path) => `- ${path}`).join('\n');
}

function helpText(): string {
  return [
    'pgas-new commands:',
    '  version',
    '  plan-standalone --slug <slug> --name <name>',
    '  render-standalone --slug <slug> --name <name> --out <dir>',
    '  validate-manifest --repo <repo>',
    '  plan-attach --repo <repo> --slug <slug> --name <name>',
    '  render-attach --repo <repo> --slug <slug> --name <name> [--template policy-drafting] [--mandate <text>]',
    '  curator-request --repo <repo> --slug <slug> --name <name> [--github-owner <owner> --github-repo <repo>]',
    '  session new|abort|status|history|resume|help',
  ].join('\n');
}

function ok(stdout: string): CliResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function fail(stderr: string, exitCode: number): CliResult {
  return { exitCode, stdout: '', stderr };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const result = await runCli(process.argv.slice(2));
  if (result.stdout) {
    process.stdout.write(`${result.stdout}\n`);
  }
  if (result.stderr) {
    process.stderr.write(`${result.stderr}\n`);
  }
  process.exitCode = result.exitCode;
}
