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
    if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
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

  // These commands are projections of the PGAS control-plane vocabulary that
  // the GENERATED REPL implements end-to-end (with a server connection). The
  // foundry CLI itself has no session state, so it emits the semantic control
  // id plus a pointer to where the command actually runs.
  return ok(
    [
      `control: ${command}`,
      '',
      'This is the control-plane id. Run the command inside the generated REPL:',
      `  npm run repl   →   /${command}`,
      '',
      'The foundry CLI does not hold session state; the generated scaffold does.',
    ].join('\n'),
  );
}

function planStandalone(options: ParsedOptions): CliResult {
  const program = programOptions(options);
  const plan = createStandaloneArtifactPlan(program);
  return ok(formatPlan(plan.artifacts.map((artifact) => artifact.path)));
}

function renderStandalone(options: ParsedOptions): CliResult {
  const program = programOptions(options);
  const outDir = required(options, 'out');
  const warning = consumerTemplateDeprecationWarning(program.template);
  const result = renderStandaloneScaffold({
    outDir,
    ...program,
    githubOwner: optional(options, 'github-owner'),
    githubRepo: optional(options, 'github-repo'),
  });

  return ok(`written\n${formatPlan(result.written)}`, warning);
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
  const warning = consumerTemplateDeprecationWarning(program.template);
  const manifest = loadWiringManifest(repo);
  if (!manifest.ok || !manifest.manifest) {
    return fail(manifest.errors.join('\n'), 1);
  }

  const result = renderExistingRepoAttachment({
    repoRoot: repo,
    manifest: manifest.manifest,
    ...program,
  });

  return ok(`written\n${formatPlan(result.written)}`, warning);
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
  if (
    value === 'pgas-new-foundry' ||
    value === 'policy-drafting' ||
    value === 'web-scraper' ||
    value === 'social-media-agent'
  ) {
    return value;
  }
  throw new Error(
    'invalid --template: expected pgas-new-foundry, policy-drafting, web-scraper, or social-media-agent',
  );
}

function consumerTemplateDeprecationWarning(template: ProgramTemplate | undefined): string {
  if (template !== 'policy-drafting' && template !== 'web-scraper' && template !== 'social-media-agent') {
    return '';
  }

  return [
    `⚠ --template ${template} is deprecated and will be removed in v3.0.`,
    `  The ${template} graduation program is preserved in docs/graduation-evidence/ for reference.`,
    '  Use `pgas-new design <slug>` to interactively design your own program.',
    '  (Phase 2 of the v3.0 plan: ships in v2.8.0.)',
  ].join('\n');
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
    '  render-standalone --slug <slug> --name <name> --out <dir> [--template pgas-new-foundry|policy-drafting (deprecated)|web-scraper (deprecated)|social-media-agent (deprecated)] [--mandate <text>] [--github-owner <owner> --github-repo <repo>]',
    '  validate-manifest --repo <repo>',
    '  plan-attach --repo <repo> --slug <slug> --name <name>',
    '  render-attach --repo <repo> --slug <slug> --name <name> [--template pgas-new-foundry|policy-drafting (deprecated)|web-scraper (deprecated)|social-media-agent (deprecated)] [--mandate <text>]',
    '  curator-request --repo <repo> --slug <slug> --name <name> [--github-owner <owner> --github-repo <repo>]',
    '  session new|abort|status|history|resume|help',
  ].join('\n');
}

function ok(stdout: string, stderr = ''): CliResult {
  return { exitCode: 0, stdout, stderr };
}

function fail(stderr: string, exitCode: number): CliResult {
  return { exitCode, stdout: '', stderr };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const result = await runCli(process.argv.slice(2));
  if (result.stderr) {
    process.stderr.write(`${result.stderr}\n`);
  }
  if (result.stdout) {
    process.stdout.write(`${result.stdout}\n`);
  }
  process.exitCode = result.exitCode;
}
