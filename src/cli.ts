import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createExistingRepoArtifactPlan,
  createStandaloneArtifactPlan,
  validateProgramIdentity,
} from './pgas-new/artifact-plan.js';
import { prepareExistingRepoAttachment } from './pgas-new/existing-repo.js';
import {
  renderExistingRepoAttachment,
  renderStandaloneScaffold,
  type ProgramTemplate,
} from './pgas-new/template-renderer.js';
import { loadWiringManifest } from './pgas-new/wiring-manifest.js';
import { PGAS_SERVER_PACKAGE, PGAS_SERVER_VERSION } from './pgas-new/version.js';
import { isPgasNewSessionControl } from './pgas-new/control-plane.js';
import { startFoundryServer } from './foundry-server.js';
import { runRepl } from './repl/runner.js';

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ParsedOptions {
  _: string[];
  [key: string]: string | string[];
}

interface AgentArgs {
  slug?: string;
  name?: string;
  outDir?: string;
  nonInteractive?: boolean;
}

interface DomainPatch {
  path: string;
  value: unknown;
}

interface SeededSessionClient {
  sessions: {
    create(body: { program: string; domain_context?: unknown }): Promise<{ sessionId: string }>;
    patchDomain(sessionId: string, body: { patches: DomainPatch[] }): Promise<unknown>;
  };
}

export interface CreateSessionWithInitialStateOptions {
  program: string;
  initialState: Record<string, unknown>;
  domainContext?: unknown;
}

const KNOWN_SUBCOMMANDS = new Set([
  'help',
  'version',
  'session',
  'plan-standalone',
  'render-standalone',
  'validate-manifest',
  'plan-attach',
  'render-attach',
  'curator-request',
]);

export async function runCli(argv: string[]): Promise<CliResult> {
  try {
    if (argv.includes('--help') || argv.includes('-h')) {
      return ok(helpText());
    }

    if (argv.length === 0) {
      return runAgentSession({});
    }

    if (!KNOWN_SUBCOMMANDS.has(argv[0]) && argv[0]?.startsWith('-')) {
      return runAgentSession(parseAgentArgs(argv));
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

async function runAgentSession(args: AgentArgs): Promise<CliResult> {
  const server = await startFoundryServer({});
  const initialDomain = initialDomainFromAgentArgs(args);
  const restoreFetch = installInitialStateSessionCreateInterceptor(initialDomain);
  try {
    const replExit = await runRepl({
      baseUrl: server.url,
      slug: 'pgas-new',
      initialDomain,
      nonInteractive: args.nonInteractive,
    });
    return { exitCode: replExit.exitCode, stdout: '', stderr: '' };
  } finally {
    restoreFetch();
    await server.kill();
  }
}

export async function createSessionWithInitialState(
  client: SeededSessionClient,
  options: CreateSessionWithInitialStateOptions,
): Promise<{ sessionId: string }> {
  const created = await client.sessions.create({
    program: options.program,
    ...(options.domainContext !== undefined ? { domain_context: options.domainContext } : {}),
  });
  const patches = initialStatePatchesFromDomain(options.initialState);
  if (patches.length > 0) {
    await client.sessions.patchDomain(created.sessionId, { patches });
  }
  return created;
}

export function initialStatePatchesFromDomain(initialState: Record<string, unknown>): DomainPatch[] {
  const patches: DomainPatch[] = [];
  const slug = stringValue(initialState['program.slug']);
  const name = stringValue(initialState['program.name']);
  const targetDir = stringValue(initialState['program.target_dir']);

  if (slug !== undefined) patches.push({ path: 'program.slug', value: slug });
  if (name !== undefined) patches.push({ path: 'program.name', value: name });
  if (targetDir !== undefined) patches.push({ path: 'program.target_dir', value: targetDir });
  if (slug !== undefined && name !== undefined && targetDir !== undefined) {
    patches.push({ path: 'program.target_dir_confirmed', value: true });
  }

  return patches;
}

function installInitialStateSessionCreateInterceptor(initialState: Record<string, unknown>): () => void {
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== 'function') return () => {};

  globalThis.fetch = createInitialStateSessionCreateFetch(originalFetch.bind(globalThis), initialState);

  return () => {
    globalThis.fetch = originalFetch;
  };
}

export function createInitialStateSessionCreateFetch(
  originalFetch: typeof fetch,
  initialState: Record<string, unknown>,
): typeof fetch {
  const patches = initialStatePatchesFromDomain(initialState);
  if (patches.length === 0) return originalFetch;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (request.method !== 'POST' || !url.pathname.endsWith('/sessions')) {
      return originalFetch(request);
    }

    const body = await readJsonObject(request.clone());
    if (!body || typeof body.program !== 'string') {
      return originalFetch(request);
    }

    const createResponse = await originalFetch(new Request(request, {
      body: JSON.stringify(stripInitialStateFromCreateBody(body, initialState)),
      headers: jsonHeaders(request.headers),
    }));
    if (!createResponse.ok) return createResponse;

    const created = await readJsonObject(createResponse.clone());
    const sessionId = typeof created?.sessionId === 'string' ? created.sessionId : '';
    if (sessionId.length > 0) {
      const patchResponse = await originalFetch(new Request(sessionDomainUrl(url, sessionId), {
        method: 'PATCH',
        headers: jsonHeaders(request.headers),
        body: JSON.stringify({ patches }),
      }));
      if (!patchResponse.ok) {
        throw new Error(`initial state patch failed (${String(patchResponse.status)}): ${await patchResponse.text()}`);
      }
    }

    return createResponse;
  };
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

function parseAgentArgs(argv: string[]): AgentArgs {
  const parsed: AgentArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const [rawKey, inlineValue] = token.startsWith('--') ? token.slice(2).split('=', 2) : ['', undefined];
    if (!rawKey) {
      throw new Error(`unknown command: ${token}`);
    }

    const readValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) {
        throw new Error(`missing value for --${rawKey}`);
      }
      index += 1;
      return next;
    };

    switch (rawKey) {
      case 'slug':
        parsed.slug = readValue();
        break;
      case 'name':
        parsed.name = readValue();
        break;
      case 'out':
        parsed.outDir = readValue();
        break;
      case 'non-interactive': {
        const value = inlineValue ?? (argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : 'true');
        parsed.nonInteractive = value !== 'false';
        break;
      }
      default:
        throw new Error(`unknown flag: --${rawKey}`);
    }
  }

  if (parsed.slug) {
    validateProgramIdentity({ slug: parsed.slug, name: parsed.name ?? deriveNameFromSlug(parsed.slug) });
  }

  return parsed;
}

function initialDomainFromAgentArgs(args: AgentArgs): Record<string, unknown> {
  const domain: Record<string, unknown> = {};
  if (args.slug) {
    domain['program.slug'] = args.slug;
    domain['program.name'] = args.name ?? deriveNameFromSlug(args.slug);
  } else if (args.name) {
    domain['program.name'] = args.name;
  }
  if (args.outDir) {
    domain['program.target_dir'] = args.outDir;
  }
  return domain;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function readJsonObject(requestOrResponse: Request | Response): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await requestOrResponse.text()) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function stripInitialStateFromCreateBody(
  body: Record<string, unknown>,
  initialState: Record<string, unknown>,
): Record<string, unknown> {
  const domainContext = body.domain_context;
  if (domainContext === null || typeof domainContext !== 'object' || Array.isArray(domainContext)) {
    return body;
  }

  const strippedContext: Record<string, unknown> = { ...domainContext };
  for (const key of Object.keys(initialState)) {
    delete strippedContext[key];
  }

  const strippedBody = { ...body };
  if (Object.keys(strippedContext).length === 0) {
    delete strippedBody.domain_context;
  } else {
    strippedBody.domain_context = strippedContext;
  }
  return strippedBody;
}

function jsonHeaders(headers: Headers): Headers {
  const next = new Headers(headers);
  next.set('content-type', 'application/json');
  next.delete('content-length');
  return next;
}

function sessionDomainUrl(createUrl: URL, sessionId: string): string {
  const patchPath = createUrl.pathname.replace(/\/sessions$/u, `/sessions/${encodeURIComponent(sessionId)}/domain`);
  return `${createUrl.origin}${patchPath}`;
}

function deriveNameFromSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
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
  if (value === 'pgas-new-foundry') {
    return value;
  }
  throw new Error(removedTemplateError(value));
}

function removedTemplateError(template: string): string {
  return `invalid --template: ${template}. In v3.0, only pgas-new-foundry is supported. ` +
    'For per-domain programs, run the bare `pgas-new` REPL and walk the foundry design interview.';
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
    '  render-standalone --slug <slug> --name <name> --out <dir> [--template pgas-new-foundry] [--mandate <text>] [--github-owner <owner> --github-repo <repo>]',
    '  validate-manifest --repo <repo>',
    '  plan-attach --repo <repo> --slug <slug> --name <name>',
    '  render-attach --repo <repo> --slug <slug> --name <name> [--template pgas-new-foundry] [--mandate <text>]',
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
