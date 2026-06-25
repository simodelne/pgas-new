import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createPgasServer, type PgasServer, type PgasServerConfig } from '@simodelne/pgas-server/create-server.js';
import {
  createCodexCliUnifiedComplete,
  type CompletionResponse,
  type ConversationMessage,
  type OpenAIToolDefinition,
  type UnifiedAuthorDriverOptions,
} from '@simodelne/pgas-server/plugin.js';
import { createPgasNewFoundryProgramEntry } from './foundry-program/registration.js';

export interface FoundryServerOptions {
  port?: number;
  hostname?: string;
}

export interface StartedFoundryServer {
  url: string;
  kill(): Promise<void>;
}

const DEFAULT_HOSTNAME = '127.0.0.1';
const DEFAULT_OPENAI_BASE_URL = 'http://100.100.74.6:8000/v1';
const DEFAULT_OPENAI_MODEL = 'glm-4.7';
const PROGRAM_NAME = 'pgas-new';
const DATA_DIR_RELATIVE = '.local/share/pgas-new';
const JWT_SECRET_FILE = 'jwt.secret';
const INITIAL_ADMIN_FILE = 'initial-admin.json';
const VALID_TOOL_CHOICES = new Set(['auto', 'required', 'none']);

interface ResolvedFoundryConfig {
  dbPath: string;
  auth: NonNullable<PgasServerConfig['auth']>;
  initialAdminPath?: string;
}

export async function startFoundryServer(options: FoundryServerOptions = {}): Promise<StartedFoundryServer> {
  applyFoundryLiveProviderDefaults();
  const requestedPort = resolvePort(options);
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;
  const resolvedConfig = resolveFoundryConfig();

  let server: PgasServer;
  try {
    const serverConfig: PgasServerConfig = {
      programs: [{ name: PROGRAM_NAME, entry: createPgasNewFoundryProgramEntry() }],
      port: requestedPort,
      devMode: true,
      storage: { dbPath: resolvedConfig.dbPath },
      auth: resolvedConfig.auth,
    };
    if (shouldUseCodexCliDriver()) {
      // codex-cli unified driver (engine v2.14.0+). Selector precedence: codex-cli
      // wins over OpenAI when both env vars are set, so users explicitly opting
      // into PGAS_AUTHOR_DRIVER=codex-cli get codex-cli even if PGAS_OPENAI_API_KEY
      // is also configured for other tooling.
      //
      // The engine's createCodexCliUnifiedComplete refuses to load unless
      // PGAS_ENABLE_CODEX_DRIVER=1. Treat the user's explicit selector
      // (PGAS_AUTHOR_DRIVER=codex-cli or PGAS_PROVIDER=codex-cli) as the
      // opt-in signal and set the engine env var here — saves the user from
      // setting two env vars to express one intent.
      setDefaultEnv('PGAS_ENABLE_CODEX_DRIVER', '1');
      serverConfig.drivers = {
        authorMode: 'unified',
        unified: {
          complete: createCodexCliUnifiedComplete(),
        },
      };
    } else if (shouldUseUnifiedOpenAiDriver()) {
      serverConfig.drivers = {
        authorMode: 'unified',
        unified: {
          complete: createOpenAiUnifiedComplete(),
        },
      };
    }
    server = await createPgasServer(serverConfig);
    const started = await server.start();
    if (resolvedConfig.initialAdminPath) {
      rmSync(resolvedConfig.initialAdminPath, { force: true });
    }
    const actualPort = server.info.port ?? started.port;

    return {
      url: `http://${hostname}:${String(actualPort)}`,
      async kill(): Promise<void> {
        let thrown: unknown;
        try {
          await server.close();
        } catch (error) {
          thrown = error;
        }
        if (thrown) throw thrown;
      },
    };
  } catch (error) {
    throw error;
  }
}

function resolveFoundryConfig(): ResolvedFoundryConfig {
  const dataDir = defaultDataDir();
  const dbPath = process.env.PGAS_DB ?? join(dataDir, 'pgas-new.db');
  ensureParentDir(dbPath);

  const jwtSecret = resolveJwtSecret(dataDir);
  const initialAdmin = resolveInitialAdmin(dataDir);
  const auth: NonNullable<PgasServerConfig['auth']> = {
    jwtSecret,
    issuer: process.env.PGAS_JWT_ISSUER ?? 'pgas-new',
    expiresIn: process.env.PGAS_JWT_EXPIRES_IN ?? '7d',
    ...(initialAdmin ? { initialAdmin: initialAdmin.credentials } : {}),
  };

  return {
    dbPath,
    auth,
    ...(initialAdmin ? { initialAdminPath: initialAdmin.path } : {}),
  };
}

function defaultDataDir(): string {
  return join(homedir(), DATA_DIR_RELATIVE);
}

function ensureParentDir(filePath: string): void {
  if (filePath === ':memory:') return;
  mkdirSync(dirname(filePath), { recursive: true });
}

function resolveJwtSecret(dataDir: string): string {
  const envSecret = process.env.PGAS_JWT_SECRET?.trim();
  if (envSecret) return envSecret;

  const secretPath = join(dataDir, JWT_SECRET_FILE);
  if (existsSync(secretPath)) {
    const fileSecret = readFileSync(secretPath, 'utf8').trim();
    if (fileSecret.length > 0) return fileSecret;
  }

  throw new Error('no JWT secret configured; run `pgas-new init`');
}

function resolveInitialAdmin(dataDir: string): { path: string; credentials: { email: string; password: string } } | undefined {
  const initialAdminPath = join(dataDir, INITIAL_ADMIN_FILE);
  if (!existsSync(initialAdminPath)) return undefined;

  const parsed = JSON.parse(readFileSync(initialAdminPath, 'utf8')) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`invalid initial admin file at ${initialAdminPath}: expected object`);
  }

  const email = typeof parsed.email === 'string' ? parsed.email.trim() : '';
  const password = typeof parsed.passwordHash === 'string' && parsed.passwordHash.length > 0
    ? parsed.passwordHash
    : typeof parsed.password === 'string'
      ? parsed.password
      : '';
  if (email.length === 0 || password.length === 0) {
    throw new Error(`invalid initial admin file at ${initialAdminPath}: expected email and password`);
  }

  return {
    path: initialAdminPath,
    credentials: { email, password },
  };
}

function resolvePort(options: FoundryServerOptions): number {
  if (options.port !== undefined) return options.port;

  const envPort = process.env.PGAS_FOUNDRY_PORT;
  if (envPort === undefined || envPort.trim().length === 0) return 0;

  const parsedPort = Number.parseInt(envPort, 10);
  return Number.isNaN(parsedPort) ? 0 : parsedPort;
}

function applyFoundryLiveProviderDefaults(): void {
  if (process.env.PGAS_LIVE_PROVIDER?.trim().toLowerCase() !== 'qwen36-27b') return;
  setDefaultEnv('PGAS_PROVIDER', 'openai');
  setDefaultEnv('PGAS_OPENAI_BASE_URL', DEFAULT_OPENAI_BASE_URL);
  setDefaultEnv('PGAS_OPENAI_API_KEY', 'local');
  setDefaultEnv('PGAS_MODEL', 'qwen36-27b');
}

function setDefaultEnv(name: string, value: string): void {
  if ((process.env[name] ?? '').trim().length === 0) {
    process.env[name] = value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shouldUseUnifiedOpenAiDriver(): boolean {
  const provider = process.env.PGAS_PROVIDER?.trim().toLowerCase();
  if (provider === 'openai') return true;
  if (provider !== undefined && provider.length > 0) return false;
  if ((process.env.GOOGLE_API_KEY ?? '').trim().length > 0) return false;
  return (process.env.PGAS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? '').trim().length > 0;
}

export function shouldUseCodexCliDriver(): boolean {
  const author = process.env.PGAS_AUTHOR_DRIVER?.trim().toLowerCase();
  if (author === 'codex-cli') return true;
  const provider = process.env.PGAS_PROVIDER?.trim().toLowerCase();
  return provider === 'codex-cli';
}

function createOpenAiUnifiedComplete(): UnifiedAuthorDriverOptions['complete'] {
  return async (messages, tools) => {
    const baseUrl = trimTrailingSlash(nonEmpty(process.env.PGAS_OPENAI_BASE_URL) ?? DEFAULT_OPENAI_BASE_URL);
    const apiKey = nonEmpty(process.env.PGAS_OPENAI_API_KEY) ?? nonEmpty(process.env.OPENAI_API_KEY);
    if (apiKey === undefined) {
      throw new Error('PGAS_OPENAI_API_KEY or OPENAI_API_KEY is required for foundry OpenAI unified mode');
    }

    const payload = createOpenAiUnifiedPayload(messages, tools);
    const callId = `unified-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`;
    maybeDumpUnifiedRequest(callId, payload);

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI-compatible unified HTTP ${String(response.status)}: ${body.slice(0, 400)}`);
    }

    const rawBody = await response.json();
    maybeDumpUnifiedResponse(callId, rawBody);
    return parseOpenAiUnifiedResponse(rawBody);
  };
}

function createOpenAiUnifiedPayload(
  messages: ConversationMessage[],
  tools: OpenAIToolDefinition[],
): Record<string, unknown> {
  const model = nonEmpty(process.env.PGAS_MODEL) ?? nonEmpty(process.env.PGAS_OPENAI_MODEL) ?? DEFAULT_OPENAI_MODEL;
  const qwenModel = model.toLowerCase().startsWith('qwen');
  const maxTokens = optionalNumber('PGAS_OPENAI_MAX_TOKENS') ?? 4096;
  const temperature = optionalNumber('PGAS_OPENAI_TEMPERATURE') ?? (qwenModel ? 0.7 : 0.3);
  const payload: Record<string, unknown> = {
    model,
    ...(qwenModel && process.env.PGAS_OPENAI_DISABLE_THINKING !== '0' ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    messages,
    temperature,
    max_tokens: maxTokens,
  };

  const topP = optionalNumber('PGAS_OPENAI_TOP_P') ?? (qwenModel ? 0.8 : undefined);
  const topK = optionalNumber('PGAS_OPENAI_TOP_K') ?? (qwenModel ? 20 : undefined);
  const minP = optionalNumber('PGAS_OPENAI_MIN_P') ?? (qwenModel ? 0 : undefined);
  const presencePenalty = optionalNumber('PGAS_OPENAI_PRESENCE_PENALTY') ?? (qwenModel ? 1.5 : undefined);
  if (topP !== undefined) payload.top_p = topP;
  if (topK !== undefined) payload.top_k = topK;
  if (minP !== undefined) payload.min_p = minP;
  if (presencePenalty !== undefined) payload.presence_penalty = presencePenalty;
  if (tools.length > 0) {
    payload.tools = tools;
    payload.tool_choice = resolveToolChoiceFromEnv();
  }

  return payload;
}

function resolveToolChoiceFromEnv(): 'auto' | 'required' | 'none' {
  const fromEnv = process.env.PGAS_OPENAI_TOOL_CHOICE?.trim().toLowerCase();
  if (fromEnv !== undefined && VALID_TOOL_CHOICES.has(fromEnv)) {
    return fromEnv as 'auto' | 'required' | 'none';
  }
  return 'auto';
}

function parseOpenAiUnifiedResponse(body: unknown): CompletionResponse {
  const message = isJsonObject(body)
    && Array.isArray(body.choices)
    && isJsonObject(body.choices[0])
    && isJsonObject(body.choices[0].message)
    ? body.choices[0].message
    : undefined;
  if (message === undefined) return { content: '' };

  if (Array.isArray(message.tool_calls)) {
    const toolCalls = message.tool_calls
      .filter(isJsonObject)
      .map((toolCall) => ({
        id: typeof toolCall.id === 'string' ? toolCall.id : undefined,
        type: typeof toolCall.type === 'string' ? toolCall.type : 'function',
        function: isJsonObject(toolCall.function)
          ? {
              name: typeof toolCall.function.name === 'string' ? toolCall.function.name : undefined,
              arguments: typeof toolCall.function.arguments === 'string' || isJsonObject(toolCall.function.arguments)
                ? toolCall.function.arguments
                : undefined,
            }
          : undefined,
      }));
    return { tool_calls: toolCalls } as CompletionResponse;
  }

  const rawContent = message.content ?? message.reasoning_content;
  return {
    content: typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent ?? ''),
  };
}

function optionalNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new TypeError(`Invalid ${name}: expected a finite number, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '');
}

/**
 * Diagnostic-only: when PGAS_FOUNDRY_DEBUG_PROMPTS is set to a directory
 * path, write each unified-driver request payload to <dir>/<callId>-request.json
 * and the raw provider response to <dir>/<callId>-response.json. Wire payload
 * is unchanged. Used to debug LLM tool-selection divergence at the
 * scaffold_plan /approve gate — see .uat/codex-phase-5-v2-blocker-2.md.
 */
function maybeDumpUnifiedRequest(callId: string, payload: Record<string, unknown>): void {
  const dir = nonEmpty(process.env.PGAS_FOUNDRY_DEBUG_PROMPTS);
  if (dir === undefined) return;
  try {
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${callId}-request.json`);
    const tools = Array.isArray((payload as { tools?: unknown }).tools)
      ? (payload as { tools: unknown[] }).tools
      : [];
    const summary = {
      callId,
      timestamp: new Date().toISOString(),
      tool_choice: (payload as { tool_choice?: unknown }).tool_choice ?? null,
      tools_count: tools.length,
      tool_names: tools
        .map((tool) => {
          if (typeof tool !== 'object' || tool === null) return null;
          const fn = (tool as { function?: { name?: string } }).function;
          return typeof fn?.name === 'string' ? fn.name : null;
        })
        .filter((name): name is string => name !== null),
      payload,
    };
    writeFileSyncSafe(filePath, JSON.stringify(summary, null, 2));
  } catch {
    // Diagnostic-only — never break the round on dump failure.
  }
}

function maybeDumpUnifiedResponse(callId: string, body: unknown): void {
  const dir = nonEmpty(process.env.PGAS_FOUNDRY_DEBUG_PROMPTS);
  if (dir === undefined) return;
  try {
    const filePath = join(dir, `${callId}-response.json`);
    writeFileSyncSafe(filePath, JSON.stringify({ callId, body }, null, 2));
  } catch {
    // Diagnostic-only.
  }
}

function writeFileSyncSafe(filePath: string, content: string): void {
  writeFileSync(filePath, content);
}
