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

export async function startFoundryServer(options: FoundryServerOptions = {}): Promise<StartedFoundryServer> {
  applyFoundryLiveProviderDefaults();
  const requestedPort = resolvePort(options);
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;

  let server: PgasServer;
  try {
    const serverConfig: PgasServerConfig = {
      programs: [{ name: PROGRAM_NAME, entry: createPgasNewFoundryProgramEntry() }],
      port: requestedPort,
      devMode: true,
    };
    server = await createPgasServer(serverConfig);
    const started = await server.start();
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
