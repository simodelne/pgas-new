import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

export interface StartedToolChoiceProxy {
  url: string;
  kill(): Promise<void>;
}

const PROXY_BASE_PATH = '/v1';
const CHAT_COMPLETIONS_PATH = '/chat/completions';
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export async function startToolChoiceProxy(upstreamBaseUrl: string): Promise<StartedToolChoiceProxy> {
  const upstream = new URL(trimTrailingSlash(upstreamBaseUrl));
  const server = http.createServer((request, response) => {
    forwardRequest(upstream, request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: String(error instanceof Error ? error.message : error) }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeServer(server);
    throw new Error('tool-choice proxy did not bind to a TCP port');
  }

  let closed = false;
  return {
    url: `http://127.0.0.1:${String(address.port)}${PROXY_BASE_PATH}`,
    async kill(): Promise<void> {
      if (closed) return;
      closed = true;
      await closeServer(server);
    },
  };
}

async function forwardRequest(upstream: URL, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const requestBody = await readRequestBody(request);
  const rawPath = request.url ?? '/';
  debugLogIncoming(request.method, rawPath, copyForwardHeaders(request.headers), requestBody);
  const relativePath = stripProxyBasePath(rawPath);
  const upstreamResponse = await forwardBufferedToolChoiceRequest(
    upstream,
    request.method,
    relativePath,
    copyForwardHeaders(request.headers),
    requestBody,
  );

  response.statusCode = upstreamResponse.status;
  response.statusMessage = upstreamResponse.statusText;
  upstreamResponse.headers.forEach((value, key) => {
    response.setHeader(key, value);
  });

  const upstreamBody = upstreamResponse.body;
  if (upstreamBody === null) {
    response.end();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(upstreamBody as unknown as NodeReadableStream).once('error', reject).pipe(response).once('finish', resolve).once('error', reject);
  });
}

export async function forwardToolChoiceProxyRequest(upstreamBaseUrl: string, request: Request): Promise<Response> {
  const parsedUrl = new URL(request.url);
  const requestBody = Buffer.from(await request.arrayBuffer());
  debugLogIncoming(request.method, `${parsedUrl.pathname}${parsedUrl.search}`, copyWebHeaders(request.headers), requestBody);
  return forwardBufferedToolChoiceRequest(
    new URL(trimTrailingSlash(upstreamBaseUrl)),
    request.method,
    `${parsedUrl.pathname}${parsedUrl.search}`,
    copyWebHeaders(request.headers),
    requestBody,
  );
}

async function forwardBufferedToolChoiceRequest(
  upstream: URL,
  method: string | undefined,
  rawRelativePath: string,
  headers: Headers,
  requestBody: Buffer,
): Promise<Response> {
  const relativePath = stripProxyBasePath(rawRelativePath);
  const targetUrl = resolveUpstreamUrl(upstream, relativePath);
  const body = shouldInjectToolChoice(method, relativePath)
    ? injectRequiredToolChoice(requestBody)
    : requestBody;
  debugLogOutgoing(targetUrl, headers, body);

  return fetch(targetUrl, {
    method,
    headers,
    body: methodCanHaveBody(method) ? toFetchBody(body) : undefined,
  });
}

function shouldInjectToolChoice(method: string | undefined, relativePath: string): boolean {
  if (method?.toUpperCase() !== 'POST') return false;
  const pathname = new URL(relativePath, 'http://proxy.local').pathname;
  return pathname === CHAT_COMPLETIONS_PATH || pathname.startsWith(`${CHAT_COMPLETIONS_PATH}/`);
}

function injectRequiredToolChoice(body: Buffer): Buffer {
  if (body.length === 0) return body;

  let payload: unknown;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    return body;
  }

  if (!isJsonObject(payload)) return body;
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return body;

  const payloadWithoutToolChoice = { ...payload };
  delete payloadWithoutToolChoice.tool_choice;
  const toolChoice = deterministicToolChoice(payloadWithoutToolChoice) ?? 'required';
  return Buffer.from(JSON.stringify({ tool_choice: toolChoice, ...payloadWithoutToolChoice }));
}

function deterministicToolChoice(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const tools = toolNames(payload.tools);
  if (tools.length === 0) return undefined;

  const context = messagesText(payload.messages);
  const currentState = extractCurrentState(context);
  const decision = currentState ? userDecision(currentState) : fallbackDecision(context);

  if (decision === 'reject') {
    const instruction = currentState ? userInstruction(currentState) : context;
    const questionNumber = rejectQuestionNumber(instruction);
    const rejectTool = questionNumber === null ? undefined : `reject_design_and_revise_q${String(questionNumber)}`;
    if (rejectTool && tools.includes(rejectTool)) {
      return functionToolChoice(rejectTool);
    }
  }

  if (decision !== 'approve') return undefined;
  if (tools.includes('approve_artifact_plan') && hasDraftArtifactPlan(currentState, context)) {
    return functionToolChoice('approve_artifact_plan');
  }
  if (tools.includes('confirm_design')) {
    return functionToolChoice('confirm_design');
  }

  return undefined;
}

function toolNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((tool) => {
    if (!isJsonObject(tool) || !isJsonObject(tool.function)) return [];
    return typeof tool.function.name === 'string' ? [tool.function.name] : [];
  });
}

function messagesText(value: unknown): string {
  if (!Array.isArray(value)) return '';

  return value.flatMap((message) => {
    if (!isJsonObject(message)) return [];
    const content = message.content;
    if (typeof content === 'string') return [content];
    if (Array.isArray(content)) {
      return content.map((part) => JSON.stringify(part)).join('\n');
    }
    return [];
  }).join('\n\n');
}

function userDecision(state: Record<string, unknown>): 'approve' | 'reject' | undefined {
  const decision = stringStateField(state, 'inputs.user_decision.decision')
    ?? stringStateField(state, 'inputs.user_decision', 'decision');
  return decision === 'approve' || decision === 'reject' ? decision : undefined;
}

function userInstruction(state: Record<string, unknown>): string {
  return stringStateField(state, 'inputs.user_decision.instruction')
    ?? stringStateField(state, 'inputs.user_decision', 'instruction')
    ?? '';
}

function fallbackDecision(context: string): 'approve' | 'reject' | undefined {
  if (hasDecisionText(context, 'reject')) return 'reject';
  if (hasDecisionText(context, 'approve')) return 'approve';
  return undefined;
}

function hasDecisionText(context: string, decision: 'approve' | 'reject'): boolean {
  const escaped = decision.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:inputs\\.user_decision\\.decision|\\bdecision\\b)[^A-Za-z0-9_]+${escaped}\\b`, 'iu').test(context);
}

function hasDraftArtifactPlan(state: Record<string, unknown> | null, context: string): boolean {
  if (state) {
    return stringStateField(state, 'artifact_plan.status') === 'draft'
      || stringStateField(state, 'artifact_plan', 'status') === 'draft';
  }
  return /artifact_plan\.status[^A-Za-z0-9_]+draft\b/iu.test(context);
}

function rejectQuestionNumber(context: string): number | null {
  const match = /\bq([1-6])\b/iu.exec(context);
  return match ? Number(match[1]) : null;
}

function extractCurrentState(context: string): Record<string, unknown> | null {
  const marker = 'Current state:';
  const markerIndex = context.lastIndexOf(marker);
  if (markerIndex < 0) return null;

  const jsonStart = context.indexOf('{', markerIndex + marker.length);
  if (jsonStart < 0) return null;

  const jsonText = readBalancedJsonObject(context, jsonStart);
  if (!jsonText) return null;

  try {
    const parsed = JSON.parse(jsonText);
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readBalancedJsonObject(source: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  return null;
}

function stringStateField(state: Record<string, unknown>, path: string, nestedKey?: string): string | undefined {
  const value = state[path];
  if (nestedKey === undefined) {
    return typeof value === 'string' ? value : undefined;
  }
  if (!isJsonObject(value)) return undefined;
  const nested = value[nestedKey];
  return typeof nested === 'string' ? nested : undefined;
}

function functionToolChoice(name: string): Record<string, unknown> {
  return {
    type: 'function',
    function: { name },
  };
}

function resolveUpstreamUrl(upstream: URL, relativePath: string): URL {
  const target = new URL(upstream.toString());
  target.pathname = joinUrlPaths(upstream.pathname, relativePath);
  target.search = new URL(relativePath, 'http://proxy.local').search;
  return target;
}

function stripProxyBasePath(rawUrl: string): string {
  const parsed = new URL(rawUrl, 'http://proxy.local');
  if (parsed.pathname === PROXY_BASE_PATH) {
    parsed.pathname = '/';
  } else if (parsed.pathname.startsWith(`${PROXY_BASE_PATH}/`)) {
    parsed.pathname = parsed.pathname.slice(PROXY_BASE_PATH.length);
  }
  return `${parsed.pathname}${parsed.search}`;
}

function joinUrlPaths(basePath: string, relativePath: string): string {
  const base = basePath === '/' ? '' : trimTrailingSlash(basePath);
  const relative = new URL(relativePath, 'http://proxy.local').pathname;
  return `${base}${relative.startsWith('/') ? relative : `/${relative}`}`;
}

function copyForwardHeaders(headers: IncomingHttpHeaders): Headers {
  const forwarded = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase()) || value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        forwarded.append(key, item);
      }
    } else {
      forwarded.set(key, value);
    }
  }
  return forwarded;
}

function copyWebHeaders(headers: Headers): Headers {
  const forwarded = new Headers();
  headers.forEach((value, key) => {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) return;
    forwarded.set(key, value);
  });
  return forwarded;
}

function methodCanHaveBody(method: string | undefined): boolean {
  const normalized = method?.toUpperCase();
  return normalized !== 'GET' && normalized !== 'HEAD';
}

function toFetchBody(body: Buffer): BodyInit | undefined {
  if (body.length === 0) return undefined;
  const buffer = new ArrayBuffer(body.byteLength);
  new Uint8Array(buffer).set(body);
  return buffer;
}

function debugLogIncoming(method: string | undefined, path: string, headers: Headers, body: Buffer): void {
  if (!isProxyDebugEnabled()) return;
  process.stderr.write(`[proxy] ${method ?? 'UNKNOWN'} ${path}\n`);
  process.stderr.write(`[proxy] headers ${JSON.stringify(redactHeaders(headers))}\n`);
  process.stderr.write(`[proxy] body ${previewBody(body)}\n`);
}

function debugLogOutgoing(targetUrl: URL, headers: Headers, body: Buffer): void {
  if (!isProxyDebugEnabled()) return;
  process.stderr.write(`[proxy] -> ${targetUrl.toString()}\n`);
  process.stderr.write(`[proxy] -> headers ${JSON.stringify(redactHeaders(headers))}\n`);
  process.stderr.write(`[proxy] -> body ${previewBody(body)}\n`);
}

function isProxyDebugEnabled(): boolean {
  return process.env.PGAS_FOUNDRY_PROXY_DEBUG === '1';
}

function previewBody(body: Buffer): string {
  return body.toString('utf8').slice(0, 500);
}

function redactHeaders(headers: Headers): Record<string, string> {
  const redacted: Record<string, string> = {};
  headers.forEach((value, key) => {
    redacted[key] = key.toLowerCase() === 'authorization' ? '[redacted]' : value;
  });
  return redacted;
}

function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.once('error', reject);
    request.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
  });
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '');
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
