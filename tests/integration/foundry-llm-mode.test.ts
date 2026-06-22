import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFoundryServer, type StartedFoundryServer } from '../../src/foundry-server.js';

const canOpenLoopbackListener = await canBindLoopbackListener();

describe('foundry LLM mode bootstrap', () => {
  const originalProvider = process.env.PGAS_PROVIDER;
  const originalEnableMockProvider = process.env.PGAS_ENABLE_MOCK_PROVIDER;
  const originalDisableJsonResponseFormat = process.env.PGAS_OPENAI_DISABLE_JSON_RESPONSE_FORMAT;
  let server: StartedFoundryServer | null = null;

  beforeEach(() => {
    process.env.PGAS_PROVIDER = 'mock';
    process.env.PGAS_ENABLE_MOCK_PROVIDER = '1';
    delete process.env.PGAS_OPENAI_DISABLE_JSON_RESPONSE_FORMAT;
  });

  afterEach(async () => {
    if (server) {
      await server.kill();
      server = null;
    }
    restoreEnv('PGAS_PROVIDER', originalProvider);
    restoreEnv('PGAS_ENABLE_MOCK_PROVIDER', originalEnableMockProvider);
    restoreEnv('PGAS_OPENAI_DISABLE_JSON_RESPONSE_FORMAT', originalDisableJsonResponseFormat);
  });

  (canOpenLoopbackListener ? it : it.skip)('sets PGAS_OPENAI_DISABLE_JSON_RESPONSE_FORMAT to 1 by default', async () => {
    server = await startFoundryServer({ port: 0 });

    expect(process.env.PGAS_OPENAI_DISABLE_JSON_RESPONSE_FORMAT).toBe('1');
  });

  (canOpenLoopbackListener ? it : it.skip)('preserves an explicit JSON response format override', async () => {
    process.env.PGAS_OPENAI_DISABLE_JSON_RESPONSE_FORMAT = '0';

    server = await startFoundryServer({ port: 0 });

    expect(process.env.PGAS_OPENAI_DISABLE_JSON_RESPONSE_FORMAT).toBe('0');
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
