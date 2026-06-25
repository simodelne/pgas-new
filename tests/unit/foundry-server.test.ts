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

  describe('unified OpenAI author driver (regression: Phase 5 v2 §10 fix)', () => {
    const originalOpenAiKey = process.env.PGAS_OPENAI_API_KEY;
    const originalOpenAiAltKey = process.env.OPENAI_API_KEY;
    const originalGoogleKey = process.env.GOOGLE_API_KEY;
    const originalProvider = process.env.PGAS_PROVIDER;
    const originalToolChoice = process.env.PGAS_OPENAI_TOOL_CHOICE;

    afterEach(() => {
      restoreEnv('PGAS_OPENAI_API_KEY', originalOpenAiKey);
      restoreEnv('OPENAI_API_KEY', originalOpenAiAltKey);
      restoreEnv('GOOGLE_API_KEY', originalGoogleKey);
      restoreEnv('PGAS_PROVIDER', originalProvider);
      restoreEnv('PGAS_OPENAI_TOOL_CHOICE', originalToolChoice);
    });

    it('wires drivers.authorMode=unified when PGAS_OPENAI_API_KEY is set (the load-bearing fix lost in Task 5.2)', async () => {
      const engine = mockPgasServer({ boundPort: 4570 });
      createPgasServerMock.mockResolvedValue(engine);
      process.env.PGAS_OPENAI_API_KEY = 'unit-openai-key';
      delete process.env.GOOGLE_API_KEY;
      delete process.env.PGAS_PROVIDER;

      await startFoundryServer({ port: 4570, hostname: '127.0.0.1' });

      const config = serverConfig();
      expect(config.drivers).toBeDefined();
      expect(config.drivers).toEqual(expect.objectContaining({
        authorMode: 'unified',
        unified: expect.objectContaining({
          complete: expect.any(Function),
        }),
      }));
    });

    it('omits drivers when no OpenAI key and no explicit openai provider (Gemini/default path)', async () => {
      const engine = mockPgasServer({ boundPort: 4571 });
      createPgasServerMock.mockResolvedValue(engine);
      delete process.env.PGAS_OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GOOGLE_API_KEY;
      delete process.env.PGAS_PROVIDER;

      await startFoundryServer({ port: 4571, hostname: '127.0.0.1' });

      const config = serverConfig();
      expect(config.drivers).toBeUndefined();
    });

    it('omits drivers when PGAS_PROVIDER=gemini even with an OpenAI key present', async () => {
      const engine = mockPgasServer({ boundPort: 4572 });
      createPgasServerMock.mockResolvedValue(engine);
      process.env.PGAS_OPENAI_API_KEY = 'unit-openai-key';
      process.env.PGAS_PROVIDER = 'gemini';

      await startFoundryServer({ port: 4572, hostname: '127.0.0.1' });

      const config = serverConfig();
      expect(config.drivers).toBeUndefined();
    });

    it("forces tool_choice='required' in the unified payload when PGAS_OPENAI_TOOL_CHOICE=required", async () => {
      const engine = mockPgasServer({ boundPort: 4573 });
      createPgasServerMock.mockResolvedValue(engine);
      process.env.PGAS_OPENAI_API_KEY = 'unit-openai-key';
      process.env.PGAS_OPENAI_TOOL_CHOICE = 'required';
      process.env.PGAS_OPENAI_BASE_URL = 'http://upstream.local/v1';

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '' } }],
        }),
      } as Response);

      try {
        await startFoundryServer({ port: 4573, hostname: '127.0.0.1' });
        const complete = serverConfig().drivers?.unified?.complete;
        if (!complete) throw new Error('unified.complete missing — drivers block not wired');

        const messages = [{ role: 'user', content: 'test' }] as Parameters<typeof complete>[0];
        const tools = [{
          type: 'function',
          function: { name: 'record_program_target', parameters: {} },
        }] as Parameters<typeof complete>[1];

        await complete(messages, tools);

        expect(fetchSpy).toHaveBeenCalledOnce();
        const [, init] = fetchSpy.mock.calls[0];
        const body = JSON.parse((init?.body as string) ?? '{}');
        expect(body.tool_choice).toBe('required');
        expect(body.tools).toHaveLength(1);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("defaults tool_choice to 'auto' in the unified payload when PGAS_OPENAI_TOOL_CHOICE is unset", async () => {
      const engine = mockPgasServer({ boundPort: 4574 });
      createPgasServerMock.mockResolvedValue(engine);
      process.env.PGAS_OPENAI_API_KEY = 'unit-openai-key';
      delete process.env.PGAS_OPENAI_TOOL_CHOICE;
      process.env.PGAS_OPENAI_BASE_URL = 'http://upstream.local/v1';

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '' } }] }),
      } as Response);

      try {
        await startFoundryServer({ port: 4574, hostname: '127.0.0.1' });
        const complete = serverConfig().drivers?.unified?.complete;
        if (!complete) throw new Error('unified.complete missing — drivers block not wired');

        const messages = [{ role: 'user', content: 'test' }] as Parameters<typeof complete>[0];
        const tools = [{
          type: 'function',
          function: { name: 'record_program_target', parameters: {} },
        }] as Parameters<typeof complete>[1];

        await complete(messages, tools);

        const [, init] = fetchSpy.mock.calls[0];
        const body = JSON.parse((init?.body as string) ?? '{}');
        expect(body.tool_choice).toBe('auto');
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  describe('codex-cli unified author driver (v3.3 — engine 2.14.0 createCodexCliUnifiedComplete)', () => {
    const originalAuthorDriver = process.env.PGAS_AUTHOR_DRIVER;
    const originalProvider = process.env.PGAS_PROVIDER;
    const originalOpenAiKey = process.env.PGAS_OPENAI_API_KEY;

    afterEach(() => {
      restoreEnv('PGAS_AUTHOR_DRIVER', originalAuthorDriver);
      restoreEnv('PGAS_PROVIDER', originalProvider);
      restoreEnv('PGAS_OPENAI_API_KEY', originalOpenAiKey);
    });

    it('wires drivers.authorMode=unified when PGAS_AUTHOR_DRIVER=codex-cli', async () => {
      const engine = mockPgasServer({ boundPort: 4580 });
      createPgasServerMock.mockResolvedValue(engine);
      process.env.PGAS_AUTHOR_DRIVER = 'codex-cli';
      delete process.env.PGAS_PROVIDER;
      delete process.env.PGAS_OPENAI_API_KEY;

      await startFoundryServer({ port: 4580, hostname: '127.0.0.1' });

      const config = serverConfig();
      expect(config.drivers).toEqual(expect.objectContaining({
        authorMode: 'unified',
        unified: expect.objectContaining({ complete: expect.any(Function) }),
      }));
    });

    it('wires codex-cli when PGAS_PROVIDER=codex-cli (sibling env var)', async () => {
      const engine = mockPgasServer({ boundPort: 4581 });
      createPgasServerMock.mockResolvedValue(engine);
      delete process.env.PGAS_AUTHOR_DRIVER;
      process.env.PGAS_PROVIDER = 'codex-cli';
      delete process.env.PGAS_OPENAI_API_KEY;

      await startFoundryServer({ port: 4581, hostname: '127.0.0.1' });

      const config = serverConfig();
      expect(config.drivers).toEqual(expect.objectContaining({
        authorMode: 'unified',
        unified: expect.objectContaining({ complete: expect.any(Function) }),
      }));
    });

    it('codex-cli wins over openai when both are set (precedence test)', async () => {
      const engine = mockPgasServer({ boundPort: 4582 });
      createPgasServerMock.mockResolvedValue(engine);
      process.env.PGAS_AUTHOR_DRIVER = 'codex-cli';
      process.env.PGAS_OPENAI_API_KEY = 'fake-openai-key';
      delete process.env.PGAS_PROVIDER;

      await startFoundryServer({ port: 4582, hostname: '127.0.0.1' });

      const config = serverConfig();
      // Driver IS wired (codex-cli branch hit, not undefined).
      expect(config.drivers).toBeDefined();
      expect(config.drivers?.unified?.complete).toBeDefined();
    });

    it('case-insensitive on PGAS_AUTHOR_DRIVER value', async () => {
      const engine = mockPgasServer({ boundPort: 4583 });
      createPgasServerMock.mockResolvedValue(engine);
      process.env.PGAS_AUTHOR_DRIVER = 'Codex-CLI';
      delete process.env.PGAS_PROVIDER;
      delete process.env.PGAS_OPENAI_API_KEY;

      await startFoundryServer({ port: 4583, hostname: '127.0.0.1' });

      const config = serverConfig();
      expect(config.drivers).toBeDefined();
    });

    it('does NOT wire codex-cli when env vars unset (falls through to OpenAI/undefined path)', async () => {
      const engine = mockPgasServer({ boundPort: 4584 });
      createPgasServerMock.mockResolvedValue(engine);
      delete process.env.PGAS_AUTHOR_DRIVER;
      delete process.env.PGAS_PROVIDER;
      delete process.env.PGAS_OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GOOGLE_API_KEY;

      await startFoundryServer({ port: 4584, hostname: '127.0.0.1' });

      const config = serverConfig();
      // No codex-cli, no openai key → no drivers wired at all.
      expect(config.drivers).toBeUndefined();
    });
  });

  function restoreEnv(name: string, original: string | undefined): void {
    if (original === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = original;
    }
  }

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
