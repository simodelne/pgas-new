import type { PgasServerConfig } from '@simodelne/pgas-server/create-server.js';
import type {
  CompletionResponse,
  ConversationMessage,
  OpenAIToolDefinition,
  UnifiedAuthorDriverOptions,
} from '@simodelne/pgas-server/plugin.js';

const VALID_TOOL_CHOICES = new Set(['auto', 'required', 'none']);

/**
 * Opt-in unified native-tools author driver (engine `authorMode: 'unified'`).
 *
 * DEFAULT-OFF: when `PGAS_AUTHOR_DRIVER` is unset (or any value other than
 * `unified`) this returns `undefined`, the server passes no `drivers` block to
 * `createPgasServer`, and the engine boots its default legacy JSON author
 * path — byte-identical to a scaffold without this module.
 *
 * Set `PGAS_AUTHOR_DRIVER=unified` to route every authoring round through the
 * provider's native tool-call protocol against an OpenAI-compatible
 * `/chat/completions` endpoint. The engine synthesizes one native tool per
 * vocabulary action from the program's action_map (descriptions and
 * arg_descriptions included); this module only supplies the provider-shaped
 * completion function the engine cannot derive itself.
 *
 * Required env when enabled:
 * - `PGAS_OPENAI_BASE_URL`  OpenAI-compatible base URL ending in /v1.
 * - `PGAS_OPENAI_MODEL` or `PGAS_MODEL`  model identifier.
 * - `PGAS_OPENAI_API_KEY` or `OPENAI_API_KEY`  bearer token (use any
 *   non-empty placeholder such as `local` for unauthenticated local servers).
 *
 * Optional env: `PGAS_OPENAI_TOOL_CHOICE` (auto|required|none, default auto),
 * `PGAS_OPENAI_MAX_TOKENS`, `PGAS_OPENAI_TEMPERATURE`, `PGAS_OPENAI_TOP_P`,
 * `PGAS_OPENAI_TOP_K`, `PGAS_OPENAI_MIN_P`, `PGAS_OPENAI_PRESENCE_PENALTY`,
 * `PGAS_OPENAI_DISABLE_THINKING` (Qwen-family default on; set 0 to keep
 * thinking enabled).
 */
export function resolveAuthorDrivers(): PgasServerConfig['drivers'] {
  if ((process.env.PGAS_AUTHOR_DRIVER ?? '').trim().toLowerCase() !== 'unified') {
    return undefined;
  }
  console.error('[pgas-author-driver] unified native-tools author driver enabled (PGAS_AUTHOR_DRIVER=unified)');
  return {
    authorMode: 'unified',
    unified: {
      complete: createOpenAiUnifiedComplete(),
    },
  };
}

function createOpenAiUnifiedComplete(): UnifiedAuthorDriverOptions['complete'] {
  return async (messages, tools) => {
    const baseUrl = nonEmpty(process.env.PGAS_OPENAI_BASE_URL);
    if (baseUrl === undefined) {
      throw new Error('PGAS_AUTHOR_DRIVER=unified requires PGAS_OPENAI_BASE_URL (OpenAI-compatible base URL ending in /v1)');
    }
    const apiKey = nonEmpty(process.env.PGAS_OPENAI_API_KEY) ?? nonEmpty(process.env.OPENAI_API_KEY);
    if (apiKey === undefined) {
      throw new Error('PGAS_AUTHOR_DRIVER=unified requires PGAS_OPENAI_API_KEY or OPENAI_API_KEY');
    }

    const response = await fetch(`${trimTrailingSlash(baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(createOpenAiUnifiedPayload(messages, tools)),
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
  const model = nonEmpty(process.env.PGAS_OPENAI_MODEL) ?? nonEmpty(process.env.PGAS_MODEL);
  if (model === undefined) {
    throw new Error('PGAS_AUTHOR_DRIVER=unified requires PGAS_OPENAI_MODEL or PGAS_MODEL');
  }
  const qwenModel = model.toLowerCase().startsWith('qwen');
  const payload: Record<string, unknown> = {
    model,
    ...(qwenModel && process.env.PGAS_OPENAI_DISABLE_THINKING !== '0' ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    messages,
    temperature: optionalNumber('PGAS_OPENAI_TEMPERATURE') ?? (qwenModel ? 0.7 : 0.3),
    max_tokens: optionalNumber('PGAS_OPENAI_MAX_TOKENS') ?? 4096,
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
