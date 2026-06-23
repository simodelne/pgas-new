import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createPgasServer, type PgasServer, type PgasServerConfig } from '@simodelne/pgas-server/create-server.js';
import { createPgasNewFoundryProgramEntry } from './foundry-program/registration.js';

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
const PROGRAM_NAME = 'pgas-new';
const DATA_DIR_RELATIVE = '.local/share/pgas-new';
const JWT_SECRET_FILE = 'jwt.secret';
const INITIAL_ADMIN_FILE = 'initial-admin.json';

interface ResolvedFoundryConfig {
  dbPath: string;
  auth: NonNullable<PgasServerConfig['auth']>;
  initialAdminPath?: string;
}

export async function startFoundryServer(options: FoundryServerOptions = {}): Promise<StartedFoundryServer> {
  applyFoundryLiveProviderDefaults();
  const requestedPort = resolvePort(options);
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;
  const resolvedConfig = resolveFoundryConfig();

  let server: PgasServer;
  try {
    const serverConfig: PgasServerConfig = {
      programs: [{ name: PROGRAM_NAME, entry: createPgasNewFoundryProgramEntry() }],
      port: requestedPort,
      devMode: true,
      storage: { dbPath: resolvedConfig.dbPath },
      auth: resolvedConfig.auth,
    };
    server = await createPgasServer(serverConfig);
    const started = await server.start();
    if (resolvedConfig.initialAdminPath) {
      rmSync(resolvedConfig.initialAdminPath, { force: true });
    }
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
        if (thrown) throw thrown;
      },
    };
  } catch (error) {
    throw error;
  }
}

function resolveFoundryConfig(): ResolvedFoundryConfig {
  const dataDir = defaultDataDir();
  const dbPath = process.env.PGAS_DB ?? join(dataDir, 'pgas-new.db');
  ensureParentDir(dbPath);

  const jwtSecret = resolveJwtSecret(dataDir);
  const initialAdmin = resolveInitialAdmin(dataDir);
  const auth: NonNullable<PgasServerConfig['auth']> = {
    jwtSecret,
    issuer: process.env.PGAS_JWT_ISSUER ?? 'pgas-new',
    expiresIn: process.env.PGAS_JWT_EXPIRES_IN ?? '7d',
    ...(initialAdmin ? { initialAdmin: initialAdmin.credentials } : {}),
  };

  return {
    dbPath,
    auth,
    ...(initialAdmin ? { initialAdminPath: initialAdmin.path } : {}),
  };
}

function defaultDataDir(): string {
  return join(homedir(), DATA_DIR_RELATIVE);
}

function ensureParentDir(filePath: string): void {
  if (filePath === ':memory:') return;
  mkdirSync(dirname(filePath), { recursive: true });
}

function resolveJwtSecret(dataDir: string): string {
  const envSecret = process.env.PGAS_JWT_SECRET?.trim();
  if (envSecret) return envSecret;

  const secretPath = join(dataDir, JWT_SECRET_FILE);
  if (existsSync(secretPath)) {
    const fileSecret = readFileSync(secretPath, 'utf8').trim();
    if (fileSecret.length > 0) return fileSecret;
  }

  throw new Error('no JWT secret configured; run `pgas-new init`');
}

function resolveInitialAdmin(dataDir: string): { path: string; credentials: { email: string; password: string } } | undefined {
  const initialAdminPath = join(dataDir, INITIAL_ADMIN_FILE);
  if (!existsSync(initialAdminPath)) return undefined;

  const parsed = JSON.parse(readFileSync(initialAdminPath, 'utf8')) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`invalid initial admin file at ${initialAdminPath}: expected object`);
  }

  const email = typeof parsed.email === 'string' ? parsed.email.trim() : '';
  const password = typeof parsed.passwordHash === 'string' && parsed.passwordHash.length > 0
    ? parsed.passwordHash
    : typeof parsed.password === 'string'
      ? parsed.password
      : '';
  if (email.length === 0 || password.length === 0) {
    throw new Error(`invalid initial admin file at ${initialAdminPath}: expected email and password`);
  }

  return {
    path: initialAdminPath,
    credentials: { email, password },
  };
}

function resolvePort(options: FoundryServerOptions): number {
  if (options.port !== undefined) return options.port;

  const envPort = process.env.PGAS_FOUNDRY_PORT;
  if (envPort === undefined || envPort.trim().length === 0) return 0;

  const parsedPort = Number.parseInt(envPort, 10);
  return Number.isNaN(parsedPort) ? 0 : parsedPort;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
