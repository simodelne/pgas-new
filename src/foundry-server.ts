import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface FoundryServerOptions {
  port?: number;
  hostname?: string;
}

export interface StartedFoundryServer {
  url: string;
  kill(): Promise<void>;
}

const DEFAULT_PORT = 4500;
const DEFAULT_HOSTNAME = '127.0.0.1';
const READINESS_TIMEOUT_MS = 30_000;
const READINESS_POLL_MS = 50;

export async function startFoundryServer(options: FoundryServerOptions = {}): Promise<StartedFoundryServer> {
  const port = options.port ?? DEFAULT_PORT;
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;
  const url = `http://${hostname}:${String(port)}`;
  const programDir = join(dirname(fileURLToPath(import.meta.url)), 'foundry-program');
  const child = spawn(
    'pgas-server',
    ['--program-dir', programDir, '--port', String(port), '--hostname', hostname],
    { stdio: 'ignore' },
  );

  await waitForReady(url, child);

  return {
    url,
    async kill(): Promise<void> {
      child.kill('SIGTERM');
    },
  };
}

async function waitForReady(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  let childExited = false;
  let childExitCode: number | null = null;
  let childExitSignal: NodeJS.Signals | null = null;
  let lastError: unknown;

  child.once('exit', (code, signal) => {
    childExited = true;
    childExitCode = code;
    childExitSignal = signal;
  });

  while (Date.now() < deadline) {
    if (childExited) {
      throw new Error(
        `foundry server exited before readiness (code=${String(childExitCode)}, signal=${String(childExitSignal)})`,
      );
    }

    try {
      const response = await fetch(`${url}/healthz`);
      if (response.status === 200) {
        return;
      }
      lastError = new Error(`HTTP ${String(response.status)}`);
    } catch (error) {
      lastError = error;
    }

    await sleep(READINESS_POLL_MS);
  }

  throw new Error(`foundry server did not become ready within ${String(READINESS_TIMEOUT_MS)}ms: ${errorMessage(lastError)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  return String(error);
}
