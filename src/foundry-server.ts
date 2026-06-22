import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
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
const PROGRAM_NAME = 'pgas-new';

export async function startFoundryServer(options: FoundryServerOptions = {}): Promise<StartedFoundryServer> {
  const requestedPort = resolvePort(options);
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;
  const server = await createPgasServer({
    programs: [{ name: PROGRAM_NAME, entry: createPgasNewFoundryProgramEntry() }],
    port: requestedPort,
    devMode: true,
  });
  const started = await server.start();
  const actualPort = server.info.port ?? started.port;

  return {
    url: `http://${hostname}:${String(actualPort)}`,
    async kill(): Promise<void> {
      await server.close();
    },
  };
}

function resolvePort(options: FoundryServerOptions): number {
  if (options.port !== undefined) return options.port;

  const envPort = process.env.PGAS_FOUNDRY_PORT;
  if (envPort === undefined || envPort.trim().length === 0) return 0;

  const parsedPort = Number.parseInt(envPort, 10);
  return Number.isNaN(parsedPort) ? 0 : parsedPort;
}
