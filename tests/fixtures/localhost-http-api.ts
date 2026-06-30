import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StubRequestLedgerEntry {
  method: string;
  url: string;
  path: string;
  headers: IncomingMessage['headers'];
  rawBody: string;
  body: unknown;
}

export interface LocalhostHttpApiStub {
  baseUrl: string;
  ledger: StubRequestLedgerEntry[];
  close(): Promise<void>;
}

export async function startLocalhostHttpApiStub(
  handler: (entry: StubRequestLedgerEntry) => Record<string, unknown> | Promise<Record<string, unknown>>,
): Promise<LocalhostHttpApiStub> {
  const ledger: StubRequestLedgerEntry[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const rawBody = await readBody(request);
    const entry: StubRequestLedgerEntry = {
      method: request.method ?? 'GET',
      url: request.url ?? '/',
      path: new URL(request.url ?? '/', 'http://127.0.0.1').pathname,
      headers: request.headers,
      rawBody,
      body: parseBody(rawBody),
    };
    ledger.push(entry);

    try {
      const payload = await handler(entry);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    ledger,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    }),
  };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function parseBody(rawBody: string): unknown {
  if (rawBody.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return rawBody;
  }
}
