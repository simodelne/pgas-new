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

export function ensureOpenAiJsonResponseFormatDisabled(): void {
  if (process.env.PGAS_OPENAI_DISABLE_JSON_RESPONSE_FORMAT === undefined) {
    process.env.PGAS_OPENAI_DISABLE_JSON_RESPONSE_FORMAT = '1';
  }
}

export async function startFoundryServer(options: FoundryServerOptions = {}): Promise<StartedFoundryServer> {
  const requestedPort = resolvePort(options);
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;
  /**
   * Phase 3.16 tightened native tool schemas, but Section 10 Round 9 still
   * captured Qwen emitting legacy MutationAction content with hadToolCalls=false.
   * The installed PGAS server forces OpenAI JSON response_format unless this env
   * var is set, and JSON mode + tools pulls Qwen into content instead of
   * native tool_calls. Default it off for foundry launches while honoring an
   * explicit override such as =0 for diagnostics.
   */
  ensureOpenAiJsonResponseFormatDisabled();

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
