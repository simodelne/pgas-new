import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFoundryServer, type StartedFoundryServer } from '../../src/foundry-server.js';

const canOpenLoopbackListener = await canBindLoopbackListener();

describe('foundry server live bootstrap', () => {
  const originalProvider = process.env.PGAS_PROVIDER;
  const originalEnableMockProvider = process.env.PGAS_ENABLE_MOCK_PROVIDER;
  const originalPgasDb = process.env.PGAS_DB;
  const originalJwtSecret = process.env.PGAS_JWT_SECRET;
  let server: StartedFoundryServer | null = null;

  beforeEach(() => {
    process.env.PGAS_PROVIDER = 'mock';
    process.env.PGAS_ENABLE_MOCK_PROVIDER = '1';
    process.env.PGAS_DB = ':memory:';
    process.env.PGAS_JWT_SECRET = 'foundry-live-jwt-secret';
  });

  afterEach(async () => {
    if (server) {
      await server.kill();
      server = null;
    }
    restoreEnv('PGAS_PROVIDER', originalProvider);
    restoreEnv('PGAS_ENABLE_MOCK_PROVIDER', originalEnableMockProvider);
    restoreEnv('PGAS_DB', originalPgasDb);
    restoreEnv('PGAS_JWT_SECRET', originalJwtSecret);
  });

  (canOpenLoopbackListener ? it : it.skip)('serves /health and closes the listener through kill', async () => {
    server = await startFoundryServer({ port: 0 });

    const health = await fetch(`${server.url}/health`);
    expect(health.status).toBe(200);
    const body = await health.json() as { status?: unknown; programs?: unknown };
    expect(body.status).toBe('ok');
    expect(body.programs).toEqual(expect.arrayContaining(['pgas-new']));

    const closedUrl = server.url;
    await server.kill();
    server = null;

    await expect(fetch(`${closedUrl}/health`)).rejects.toThrow();
  });
});

async function canBindLoopbackListener(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => {
      resolve(false);
    });
    probe.listen(0, '127.0.0.1', () => {
      probe.close(() => {
        resolve(true);
      });
    });
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
