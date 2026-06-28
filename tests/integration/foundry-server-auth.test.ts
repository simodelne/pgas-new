import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFoundryServer, type StartedFoundryServer } from '../../src/foundry-server.js';

const require = createRequire(import.meta.url);
const BetterSqlite3 = require('better-sqlite3') as new (filename: string) => SqliteDatabase;
const canOpenDefaultListener = await canBindDefaultListener();

describe('foundry server auth bootstrap', () => {
  const originalEnv = {
    HOME: process.env.HOME,
    PGAS_DB: process.env.PGAS_DB,
    PGAS_JWT_SECRET: process.env.PGAS_JWT_SECRET,
    PGAS_JWT_ISSUER: process.env.PGAS_JWT_ISSUER,
    PGAS_JWT_EXPIRES_IN: process.env.PGAS_JWT_EXPIRES_IN,
    PGAS_PROVIDER: process.env.PGAS_PROVIDER,
    PGAS_ENABLE_MOCK_PROVIDER: process.env.PGAS_ENABLE_MOCK_PROVIDER,
  };
  let rootDir: string;
  let server: StartedFoundryServer | null = null;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'pgas-new-foundry-auth-'));
    process.env.HOME = join(rootDir, 'home');
    process.env.PGAS_DB = join(rootDir, 'pgas-new.db');
    process.env.PGAS_JWT_SECRET = 'integration-jwt-secret';
    process.env.PGAS_JWT_ISSUER = 'pgas-new-test';
    process.env.PGAS_JWT_EXPIRES_IN = '1h';
    process.env.PGAS_PROVIDER = 'mock';
    process.env.PGAS_ENABLE_MOCK_PROVIDER = '1';
  });

  afterEach(async () => {
    if (server) {
      await server.kill();
      server = null;
    }
    restoreEnv('HOME', originalEnv.HOME);
    restoreEnv('PGAS_DB', originalEnv.PGAS_DB);
    restoreEnv('PGAS_JWT_SECRET', originalEnv.PGAS_JWT_SECRET);
    restoreEnv('PGAS_JWT_ISSUER', originalEnv.PGAS_JWT_ISSUER);
    restoreEnv('PGAS_JWT_EXPIRES_IN', originalEnv.PGAS_JWT_EXPIRES_IN);
    restoreEnv('PGAS_PROVIDER', originalEnv.PGAS_PROVIDER);
    restoreEnv('PGAS_ENABLE_MOCK_PROVIDER', originalEnv.PGAS_ENABLE_MOCK_PROVIDER);
    rmSync(rootDir, { recursive: true, force: true });
  });

  (canOpenDefaultListener ? it : it.skip)('seeds initial admin once and reuses the persisted user on restart', async () => {
    const dataDir = join(process.env.HOME!, '.local/share/pgas-new');
    mkdirSync(dataDir, { recursive: true });
    const initialAdminPath = join(dataDir, 'initial-admin.json');
    writeFileSync(initialAdminPath, JSON.stringify({
      email: 'admin@test',
      password: 'test-pw1',
    }));

    server = await startFoundryServer({ port: 0 });

    expect(existsSync(initialAdminPath)).toBe(false);
    expect(readUserRole(process.env.PGAS_DB!, 'admin@test')).toBe('admin');
    await expect(login(server.url, 'admin@test', 'test-pw1')).resolves.toEqual(expect.objectContaining({
      email: 'admin@test',
      role: 'admin',
      token: expect.any(String),
    }));

    await server.kill();
    server = null;

    server = await startFoundryServer({ port: 0 });

    expect(existsSync(initialAdminPath)).toBe(false);
    expect(readUserRole(process.env.PGAS_DB!, 'admin@test')).toBe('admin');
    await expect(login(server.url, 'admin@test', 'test-pw1')).resolves.toEqual(expect.objectContaining({
      email: 'admin@test',
      role: 'admin',
      token: expect.any(String),
    }));
  });
});

async function canBindDefaultListener(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => {
      resolve(false);
    });
    probe.listen(0, () => {
      probe.close(() => {
        resolve(true);
      });
    });
  });
}

interface SqliteDatabase {
  prepare(sql: string): { get(...params: unknown[]): unknown };
  close(): void;
}

function readUserRole(dbPath: string, email: string): string | undefined {
  const db = new BetterSqlite3(dbPath);
  try {
    const row = db.prepare('SELECT role FROM users WHERE email = ?').get(email);
    return isRecord(row) && typeof row.role === 'string' ? row.role : undefined;
  } finally {
    db.close();
  }
}

async function login(baseUrl: string, email: string, password: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) {
    throw new Error(`login failed ${String(response.status)}: ${JSON.stringify(body)}`);
  }
  return body as Record<string, unknown>;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
