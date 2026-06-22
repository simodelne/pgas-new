import type { PgasServer, PgasServerConfig } from '@simodelne/pgas-server/create-server.js';
import type { ProgramEntry } from '@simodelne/pgas-server/plugin.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import { createPgasNewFoundryProgramEntry } from '../../src/foundry-program/registration.js';
import { startFoundryServer } from '../../src/foundry-server.js';
import { startToolChoiceProxy } from '../../src/foundry-program/tool-choice-proxy.js';

const mocks = vi.hoisted(() => {
  const foundryEntry = {
    spec: { name: 'pgas-new' },
    createAdapters: vi.fn(),
  } as unknown as ProgramEntry;

  return {
    createPgasServer: vi.fn(),
    createPgasNewFoundryProgramEntry: vi.fn(() => foundryEntry),
    foundryEntry,
    startToolChoiceProxy: vi.fn(),
  };
});

vi.mock('@simodelne/pgas-server/create-server.js', () => ({
  createPgasServer: mocks.createPgasServer,
}));

vi.mock('../../src/foundry-program/registration.js', () => ({
  createPgasNewFoundryProgramEntry: mocks.createPgasNewFoundryProgramEntry,
}));

vi.mock('../../src/foundry-program/tool-choice-proxy.js', () => ({
  startToolChoiceProxy: mocks.startToolChoiceProxy,
}));

describe('startFoundryServer', () => {
  const createPgasServerMock = vi.mocked(createPgasServer);
  const createEntryMock = vi.mocked(createPgasNewFoundryProgramEntry);
  const startToolChoiceProxyMock = vi.mocked(startToolChoiceProxy);
  const originalFoundryPort = process.env.PGAS_FOUNDRY_PORT;
  const originalOpenAiBaseUrl = process.env.PGAS_OPENAI_BASE_URL;
  const originalDisableJsonResponseFormat = process.env.PGAS_OPENAI_DISABLE_JSON_RESPONSE_FORMAT;
  let proxies: Array<Awaited<ReturnType<typeof startToolChoiceProxy>>> = [];

  beforeEach(() => {
    createPgasServerMock.mockReset();
    createEntryMock.mockClear();
    startToolChoiceProxyMock.mockReset();
    proxies = [];
    startToolChoiceProxyMock.mockImplementation(async () => {
      const proxy = mockToolChoiceProxy({ url: 'http://127.0.0.1:9001/v1' });
      proxies.push(proxy);
      return proxy;
    });
    delete process.env.PGAS_FOUNDRY_PORT;
    delete process.env.PGAS_OPENAI_BASE_URL;
    delete process.env.PGAS_OPENAI_DISABLE_JSON_RESPONSE_FORMAT;
  });

  afterEach(() => {
    if (originalFoundryPort === undefined) {
      delete process.env.PGAS_FOUNDRY_PORT;
    } else {
      process.env.PGAS_FOUNDRY_PORT = originalFoundryPort;
    }
    if (originalOpenAiBaseUrl === undefined) {
      delete process.env.PGAS_OPENAI_BASE_URL;
    } else {
      process.env.PGAS_OPENAI_BASE_URL = originalOpenAiBaseUrl;
    }
    if (originalDisableJsonResponseFormat === undefined) {
      delete process.env.PGAS_OPENAI_DISABLE_JSON_RESPONSE_FORMAT;
    } else {
      process.env.PGAS_OPENAI_DISABLE_JSON_RESPONSE_FORMAT = originalDisableJsonResponseFormat;
    }
  });

  it('starts the in-process engine with the foundry program entry', async () => {
    const engine = mockPgasServer({ boundPort: 4555 });
    createPgasServerMock.mockResolvedValue(engine);

    const server = await startFoundryServer({ port: 4555, hostname: '127.0.0.1' });

    expect(server.url).toBe('http://127.0.0.1:4555');
    expect(createEntryMock).toHaveBeenCalledOnce();
    expect(createPgasServerMock).toHaveBeenCalledWith(expect.objectContaining({
      programs: [{ name: 'pgas-new', entry: mocks.foundryEntry }],
      port: 4555,
    }));
    expect(engine.start).toHaveBeenCalledOnce();
  });

  it('uses an explicit options.port before PGAS_FOUNDRY_PORT', async () => {
    const engine = mockPgasServer({ boundPort: 4555 });
    createPgasServerMock.mockResolvedValue(engine);
    process.env.PGAS_FOUNDRY_PORT = '4666';

    const server = await startFoundryServer({ port: 4555, hostname: '127.0.0.1' });

    expect(server.url).toBe('http://127.0.0.1:4555');
    expect(serverConfig().port).toBe(4555);
  });

  it('uses PGAS_FOUNDRY_PORT when options.port is absent', async () => {
    const engine = mockPgasServer({ boundPort: 4666 });
    createPgasServerMock.mockResolvedValue(engine);
    process.env.PGAS_FOUNDRY_PORT = '4666';

    const server = await startFoundryServer({ hostname: '127.0.0.1' });

    expect(server.url).toBe('http://127.0.0.1:4666');
    expect(serverConfig().port).toBe(4666);
  });

  it('falls back to an ephemeral port when no port override is configured', async () => {
    const engine = mockPgasServer({ boundPort: 4876 });
    createPgasServerMock.mockResolvedValue(engine);

    const server = await startFoundryServer({ hostname: '127.0.0.1' });

    expect(server.url).toBe('http://127.0.0.1:4876');
    expect(serverConfig().port).toBe(0);
  });

  it('uses the server start readback for an explicitly ephemeral port', async () => {
    const engine = mockPgasServer({ boundPort: 4988 });
    createPgasServerMock.mockResolvedValue(engine);

    const server = await startFoundryServer({ port: 0, hostname: 'localhost' });

    expect(server.url).toBe('http://localhost:4988');
    expect(serverConfig().port).toBe(0);
  });

  it('returns a kill function that closes the in-process server', async () => {
    const engine = mockPgasServer({ boundPort: 4557 });
    createPgasServerMock.mockResolvedValue(engine);

    const server = await startFoundryServer({ port: 4557, hostname: '127.0.0.1' });
    await server.kill();

    expect(engine.close).toHaveBeenCalledOnce();
  });

  it('routes OpenAI-compatible provider traffic through the tool-choice proxy before creating the server', async () => {
    const engine = mockPgasServer({ boundPort: 4560 });
    createPgasServerMock.mockImplementation(async () => {
      expect(process.env.PGAS_OPENAI_BASE_URL).toBe('http://127.0.0.1:9001/v1');
      return engine;
    });
    process.env.PGAS_OPENAI_BASE_URL = 'http://provider.local/v1';

    const server = await startFoundryServer({ port: 4560, hostname: '127.0.0.1' });
    await server.kill();

    expect(startToolChoiceProxyMock).toHaveBeenCalledWith('http://provider.local/v1');
    expect(engine.close).toHaveBeenCalledOnce();
    expect(proxies[0]?.kill).toHaveBeenCalledOnce();
    expect(process.env.PGAS_OPENAI_BASE_URL).toBe('http://provider.local/v1');
  });

  it('uses the local Qwen endpoint as the upstream when PGAS_OPENAI_BASE_URL is unset', async () => {
    const engine = mockPgasServer({ boundPort: 4561 });
    createPgasServerMock.mockResolvedValue(engine);

    await startFoundryServer({ port: 4561, hostname: '127.0.0.1' });

    expect(startToolChoiceProxyMock).toHaveBeenCalledWith('http://100.100.74.6:8000/v1');
    expect(process.env.PGAS_OPENAI_BASE_URL).toBe('http://127.0.0.1:9001/v1');
  });

  it('disables OpenAI JSON response format by default before creating the server', async () => {
    const engine = mockPgasServer({ boundPort: 4558 });
    createPgasServerMock.mockImplementation(async () => {
      expect(process.env.PGAS_OPENAI_DISABLE_JSON_RESPONSE_FORMAT).toBe('1');
      return engine;
    });

    await startFoundryServer({ port: 4558, hostname: '127.0.0.1' });

    expect(process.env.PGAS_OPENAI_DISABLE_JSON_RESPONSE_FORMAT).toBe('1');
    expect(createPgasServerMock).toHaveBeenCalledOnce();
  });

  it('honors an explicit OpenAI JSON response format override', async () => {
    const engine = mockPgasServer({ boundPort: 4559 });
    createPgasServerMock.mockImplementation(async () => {
      expect(process.env.PGAS_OPENAI_DISABLE_JSON_RESPONSE_FORMAT).toBe('0');
      return engine;
    });
    process.env.PGAS_OPENAI_DISABLE_JSON_RESPONSE_FORMAT = '0';

    await startFoundryServer({ port: 4559, hostname: '127.0.0.1' });

    expect(process.env.PGAS_OPENAI_DISABLE_JSON_RESPONSE_FORMAT).toBe('0');
    expect(createPgasServerMock).toHaveBeenCalledOnce();
  });

  function serverConfig(): PgasServerConfig {
    const [config] = createPgasServerMock.mock.calls.at(-1) ?? [];
    if (!config) throw new Error('createPgasServer was not called');
    return config;
  }
});

function mockToolChoiceProxy(options: { url: string }): Awaited<ReturnType<typeof startToolChoiceProxy>> {
  return {
    url: options.url,
    kill: vi.fn(async () => {}),
  };
}

function mockPgasServer(options: { boundPort: number }): PgasServer {
  return {
    app: {} as PgasServer['app'],
    info: {
      programs: ['pgas-new'],
      provider: 'mock',
      model: 'mock',
      port: null,
    },
    start: vi.fn(async () => ({ port: options.boundPort })),
    close: vi.fn(async () => {}),
  };
}
