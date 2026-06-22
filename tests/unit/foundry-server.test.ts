import type { PgasServer, PgasServerConfig } from '@simodelne/pgas-server/create-server.js';
import type { ProgramEntry } from '@simodelne/pgas-server/plugin.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import { createPgasNewFoundryProgramEntry } from '../../src/foundry-program/registration.js';
import { startFoundryServer } from '../../src/foundry-server.js';

const mocks = vi.hoisted(() => {
  const foundryEntry = {
    spec: { name: 'pgas-new' },
    createAdapters: vi.fn(),
  } as unknown as ProgramEntry;

  return {
    createPgasServer: vi.fn(),
    createPgasNewFoundryProgramEntry: vi.fn(() => foundryEntry),
    foundryEntry,
  };
});

vi.mock('@simodelne/pgas-server/create-server.js', () => ({
  createPgasServer: mocks.createPgasServer,
}));

vi.mock('../../src/foundry-program/registration.js', () => ({
  createPgasNewFoundryProgramEntry: mocks.createPgasNewFoundryProgramEntry,
}));

describe('startFoundryServer', () => {
  const createPgasServerMock = vi.mocked(createPgasServer);
  const createEntryMock = vi.mocked(createPgasNewFoundryProgramEntry);
  const originalFoundryPort = process.env.PGAS_FOUNDRY_PORT;

  beforeEach(() => {
    createPgasServerMock.mockReset();
    createEntryMock.mockClear();
    delete process.env.PGAS_FOUNDRY_PORT;
  });

  afterEach(() => {
    if (originalFoundryPort === undefined) {
      delete process.env.PGAS_FOUNDRY_PORT;
    } else {
      process.env.PGAS_FOUNDRY_PORT = originalFoundryPort;
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

  function serverConfig(): PgasServerConfig {
    const [config] = createPgasServerMock.mock.calls.at(-1) ?? [];
    if (!config) throw new Error('createPgasServer was not called');
    return config;
  }
});

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
