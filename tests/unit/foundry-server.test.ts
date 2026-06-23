import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  const originalOpenAiBaseUrl = process.env.PGAS_OPENAI_BASE_URL;
  const originalDisableJsonResponseFormat = process.env.PGAS_OPENAI_DISABLE_JSON_RESPONSE_FORMAT;
  const originalPgasDb = process.env.PGAS_DB;
  const originalJwtSecret = process.env.PGAS_JWT_SECRET;
  const originalJwtIssuer = process.env.PGAS_JWT_ISSUER;
  const originalJwtExpiresIn = process.env.PGAS_JWT_EXPIRES_IN;
  const originalHome = process.env.HOME;
  let homeDir: string;

  beforeEach(() => {
    createPgasServerMock.mockReset();
    createEntryMock.mockClear();
    homeDir = mkdtempSync(join(tmpdir(), 'pgas-new-foundry-home-'));
    process.env.HOME = homeDir;
    delete process.env.PGAS_FOUNDRY_PORT;
    delete process.env.PGAS_OPENAI_BASE_URL;
    delete process.env.PGAS_OPENAI_DISABLE_JSON_RESPONSE_FORMAT;
    delete process.env.PGAS_DB;
    process.env.PGAS_JWT_SECRET = 'unit-jwt-secret';
    delete process.env.PGAS_JWT_ISSUER;
    delete process.env.PGAS_JWT_EXPIRES_IN;
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
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
    if (originalPgasDb === undefined) {
      delete process.env.PGAS_DB;
    } else {
      process.env.PGAS_DB = originalPgasDb;
    }
    if (originalJwtSecret === undefined) {
      delete process.env.PGAS_JWT_SECRET;
    } else {
      process.env.PGAS_JWT_SECRET = originalJwtSecret;
    }
    if (originalJwtIssuer === undefined) {
      delete process.env.PGAS_JWT_ISSUER;
    } else {
      process.env.PGAS_JWT_ISSUER = originalJwtIssuer;
    }
    if (originalJwtExpiresIn === undefined) {
      delete process.env.PGAS_JWT_EXPIRES_IN;
    } else {
      process.env.PGAS_JWT_EXPIRES_IN = originalJwtExpiresIn;
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
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

  it('passes configured storage and auth settings to createPgasServer', async () => {
    const engine = mockPgasServer({ boundPort: 4562 });
    createPgasServerMock.mockResolvedValue(engine);
    const dbPath = join(homeDir, 'nested', 'configured.db');
    process.env.PGAS_DB = dbPath;
    process.env.PGAS_JWT_SECRET = 'configured-jwt-secret';
    process.env.PGAS_JWT_ISSUER = 'configured-issuer';
    process.env.PGAS_JWT_EXPIRES_IN = '30m';

    await startFoundryServer({ port: 4562, hostname: '127.0.0.1' });

    expect(existsSync(dirname(dbPath))).toBe(true);
    expect(statSync(dirname(dbPath)).isDirectory()).toBe(true);
    expect(serverConfig()).toEqual(expect.objectContaining({
      storage: { dbPath },
      auth: {
        jwtSecret: 'configured-jwt-secret',
        issuer: 'configured-issuer',
        expiresIn: '30m',
      },
    }));
  });

  it('resolves default db path and JWT secret file when env overrides are absent', async () => {
    const engine = mockPgasServer({ boundPort: 4563 });
    createPgasServerMock.mockResolvedValue(engine);
    delete process.env.PGAS_JWT_SECRET;
    const dataDir = join(homeDir, '.local/share/pgas-new');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'jwt.secret'), 'file-jwt-secret\n');

    await startFoundryServer({ port: 4563, hostname: '127.0.0.1' });

    expect(serverConfig()).toEqual(expect.objectContaining({
      storage: { dbPath: join(dataDir, 'pgas-new.db') },
      auth: {
        jwtSecret: 'file-jwt-secret',
        issuer: 'pgas-new',
        expiresIn: '7d',
      },
    }));
  });

  it('throws a clear init error when no JWT secret is configured', async () => {
    delete process.env.PGAS_JWT_SECRET;

    await expect(startFoundryServer({ port: 4564, hostname: '127.0.0.1' }))
      .rejects.toThrow('no JWT secret configured; run `pgas-new init`');
    expect(createPgasServerMock).not.toHaveBeenCalled();
  });

  it('passes initialAdmin when staged and deletes the staging file after successful startup', async () => {
    const engine = mockPgasServer({ boundPort: 4565 });
    createPgasServerMock.mockResolvedValue(engine);
    const dataDir = join(homeDir, '.local/share/pgas-new');
    mkdirSync(dataDir, { recursive: true });
    const initialAdminPath = join(dataDir, 'initial-admin.json');
    writeFileSync(initialAdminPath, JSON.stringify({
      email: 'admin@test',
      password: 'test-password',
    }));

    await startFoundryServer({ port: 4565, hostname: '127.0.0.1' });

    expect(serverConfig().auth).toEqual(expect.objectContaining({
      initialAdmin: { email: 'admin@test', password: 'test-password' },
    }));
    expect(existsSync(initialAdminPath)).toBe(false);
  });

  it('prefers passwordHash from initial-admin.json and omits initialAdmin when absent', async () => {
    const engine = mockPgasServer({ boundPort: 4566 });
    createPgasServerMock.mockResolvedValue(engine);
    const dataDir = join(homeDir, '.local/share/pgas-new');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'initial-admin.json'), JSON.stringify({
      email: 'admin@test',
      password: 'plaintext-password',
      passwordHash: 'stored-hash-value',
    }));

    await startFoundryServer({ port: 4566, hostname: '127.0.0.1' });
    expect(serverConfig().auth).toEqual(expect.objectContaining({
      initialAdmin: { email: 'admin@test', password: 'stored-hash-value' },
    }));

    const secondEngine = mockPgasServer({ boundPort: 4567 });
    createPgasServerMock.mockResolvedValue(secondEngine);
    await startFoundryServer({ port: 4567, hostname: '127.0.0.1' });
    expect(serverConfig().auth).not.toHaveProperty('initialAdmin');
  });

  it('does not rewrite PGAS_OPENAI_BASE_URL before creating the server', async () => {
    const engine = mockPgasServer({ boundPort: 4560 });
    createPgasServerMock.mockImplementation(async () => {
      expect(process.env.PGAS_OPENAI_BASE_URL).toBe('http://provider.local/v1');
      return engine;
    });
    process.env.PGAS_OPENAI_BASE_URL = 'http://provider.local/v1';

    const server = await startFoundryServer({ port: 4560, hostname: '127.0.0.1' });
    await server.kill();

    expect(engine.close).toHaveBeenCalledOnce();
    expect(process.env.PGAS_OPENAI_BASE_URL).toBe('http://provider.local/v1');
  });

  it('applies the local Qwen endpoint default without routing through a proxy', async () => {
    const engine = mockPgasServer({ boundPort: 4561 });
    createPgasServerMock.mockResolvedValue(engine);

    const server = await startFoundryServer({ port: 4561, hostname: '127.0.0.1' });
    await server.kill();

    expect(process.env.PGAS_OPENAI_BASE_URL).toBeUndefined();
  });

  it('does not set OpenAI JSON response format behavior before creating the server', async () => {
    const engine = mockPgasServer({ boundPort: 4558 });
    createPgasServerMock.mockImplementation(async () => {
      expect(process.env.PGAS_OPENAI_DISABLE_JSON_RESPONSE_FORMAT).toBeUndefined();
      return engine;
    });

    await startFoundryServer({ port: 4558, hostname: '127.0.0.1' });

    expect(process.env.PGAS_OPENAI_DISABLE_JSON_RESPONSE_FORMAT).toBeUndefined();
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
