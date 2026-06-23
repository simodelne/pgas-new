import { createPgasServer, type PgasServer, type PgasServerConfig } from '@simodelne/pgas-server/create-server.js';
import type { CompletionResponse, ConversationMessage, OpenAIToolDefinition, UnifiedAuthorDriverOptions } from '@simodelne/pgas-server/plugin.js';
import { createPgasNewFoundryProgramEntry } from './foundry-program/registration.js';
import { startToolChoiceProxy } from './foundry-program/tool-choice-proxy.js';

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

export function ensureOpenAiJsonResponseFormatDisabled(): void {
  if (process.env.PGAS_OPENAI_DISABLE_JSON_RESPONSE_FORMAT === undefined) {
    process.env.PGAS_OPENAI_DISABLE_JSON_RESPONSE_FORMAT = '1';
  }
}

export async function startFoundryServer(options: FoundryServerOptions = {}): Promise<StartedFoundryServer> {
  applyFoundryLiveProviderDefaults();
  const requestedPort = resolvePort(options);
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;
  const originalOpenAiBaseUrl = process.env.PGAS_OPENAI_BASE_URL;
  const upstreamOpenAiBaseUrl = originalOpenAiBaseUrl ?? DEFAULT_OPENAI_BASE_URL;
  const toolChoiceProxy = await startToolChoiceProxy(upstreamOpenAiBaseUrl);
  process.env.PGAS_OPENAI_BASE_URL = toolChoiceProxy.url;
  /**
   * Phase 3.16 tightened native tool schemas, but Section 10 Round 9 still
   * captured Qwen emitting legacy MutationAction content with hadToolCalls=false.
   * The installed PGAS server forces OpenAI JSON response_format unless this env
   * var is set, and JSON mode + tools pulls Qwen into content instead of
   * native tool_calls. Default it off for foundry launches while honoring an
   * explicit override such as =0 for diagnostics.
   */
  ensureOpenAiJsonResponseFormatDisabled();

  let server: PgasServer;
  try {
    const serverConfig: PgasServerConfig = {
      programs: [{ name: PROGRAM_NAME, entry: createPgasNewFoundryProgramEntry() }],
      port: requestedPort,
      devMode: true,
    };
    if (shouldUseUnifiedOpenAiDriver()) {
      serverConfig.drivers = {
        authorMode: 'unified',
        unified: {
          complete: createOpenAiUnifiedComplete(),
        },
      };
    }
    server = await createPgasServer(serverConfig);
    const started = await server.start();
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
        try {
          await toolChoiceProxy.kill();
        } catch (error) {
          thrown ??= error;
        } finally {
          restoreOpenAiBaseUrl(originalOpenAiBaseUrl, toolChoiceProxy.url);
        }
        if (thrown) throw thrown;
      },
    };
  } catch (error) {
    restoreOpenAiBaseUrl(originalOpenAiBaseUrl, toolChoiceProxy.url);
    await toolChoiceProxy.kill();
    throw error;
  }
}

function resolvePort(options: FoundryServerOptions): number {
  if (options.port !== undefined) return options.port;

  const envPort = process.env.PGAS_FOUNDRY_PORT;
  if (envPort === undefined || envPort.trim().length === 0) return 0;

  const parsedPort = Number.parseInt(envPort, 10);
  return Number.isNaN(parsedPort) ? 0 : parsedPort;
}

function restoreOpenAiBaseUrl(originalValue: string | undefined, proxyUrl: string): void {
  if (process.env.PGAS_OPENAI_BASE_URL !== proxyUrl) return;

  if (originalValue === undefined) {
    delete process.env.PGAS_OPENAI_BASE_URL;
  } else {
    process.env.PGAS_OPENAI_BASE_URL = originalValue;
  }
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

function shouldUseUnifiedOpenAiDriver(): boolean {
  const provider = process.env.PGAS_PROVIDER?.trim().toLowerCase();
  if (provider === 'openai') return true;
  if (provider !== undefined && provider.length > 0) return false;
  if ((process.env.GOOGLE_API_KEY ?? '').trim().length > 0) return false;
  return (process.env.PGAS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? '').trim().length > 0;
}

function createOpenAiUnifiedComplete(): UnifiedAuthorDriverOptions['complete'] {
  return async (messages, tools) => {
    const baseUrl = trimTrailingSlash(nonEmpty(process.env.PGAS_OPENAI_BASE_URL) ?? DEFAULT_OPENAI_BASE_URL);
    const apiKey = nonEmpty(process.env.PGAS_OPENAI_API_KEY) ?? nonEmpty(process.env.OPENAI_API_KEY);
    if (apiKey === undefined) {
      throw new Error('PGAS_OPENAI_API_KEY or OPENAI_API_KEY is required for foundry OpenAI unified mode');
    }

    const payload = createOpenAiUnifiedPayload(messages, tools);
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

    return parseOpenAiUnifiedResponse(await response.json());
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
    payload.tool_choice = 'auto';
  }

  return payload;
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
