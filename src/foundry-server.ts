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

const DEFAULT_HOSTNAME = '127.0.0.1';
const READINESS_TIMEOUT_MS = 30_000;
const READINESS_POLL_MS = 50;
const BOUND_PORT_PATTERN = /\blistening\s+on\s+port\s+([0-9]+)\b/i;

export async function startFoundryServer(options: FoundryServerOptions = {}): Promise<StartedFoundryServer> {
  const requestedPort = resolvePort(options);
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;
  const programDir = join(dirname(fileURLToPath(import.meta.url)), 'foundry-program');
  const child = spawn(
    'pgas-server',
    ['--program-dir', programDir, '--port', String(requestedPort), '--hostname', hostname],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const boundPort = observeBoundPort(child);

  let actualPort: number;
  try {
    actualPort = await waitForReady(hostname, requestedPort, boundPort, child);
  } finally {
    boundPort.dispose();
  }
  const url = `http://${hostname}:${String(actualPort)}`;

  return {
    url,
    async kill(): Promise<void> {
      child.kill('SIGTERM');
    },
  };
}

async function waitForReady(
  hostname: string,
  requestedPort: number,
  boundPort: BoundPortObserver,
  child: ChildProcess,
): Promise<number> {
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
    const probePort = requestedPort === 0 ? boundPort.current() : requestedPort;

    if (childExited) {
      throw new Error(
        `foundry server exited before readiness (code=${String(childExitCode)}, signal=${String(childExitSignal)})`,
      );
    }

    if (probePort === undefined) {
      lastError = new Error('waiting for foundry server to report bound port');
    } else {
      const url = `http://${hostname}:${String(probePort)}`;
      try {
        const response = await fetch(`${url}/healthz`);
        if (response.status === 200) {
          return probePort;
        }
        lastError = new Error(`HTTP ${String(response.status)}`);
      } catch (error) {
        lastError = error;
      }
    }

    await sleep(READINESS_POLL_MS);
  }

  throw new Error(`foundry server did not become ready within ${String(READINESS_TIMEOUT_MS)}ms: ${errorMessage(lastError)}`);
}

interface BoundPortObserver {
  current(): number | undefined;
  dispose(): void;
}

function resolvePort(options: FoundryServerOptions): number {
  if (options.port !== undefined) return options.port;

  const envPort = process.env.PGAS_FOUNDRY_PORT;
  if (envPort === undefined || envPort.trim().length === 0) return 0;

  const parsedPort = Number.parseInt(envPort, 10);
  return Number.isNaN(parsedPort) ? 0 : parsedPort;
}

function observeBoundPort(child: ChildProcess): BoundPortObserver {
  let stdoutBuffer = '';
  let port: number | undefined;

  const onData = (chunk: unknown): void => {
    stdoutBuffer += String(chunk);
    const match = BOUND_PORT_PATTERN.exec(stdoutBuffer);
    if (match?.[1]) {
      port = Number.parseInt(match[1], 10);
    }
    stdoutBuffer = stdoutBuffer.slice(-1024);
  };

  child.stdout?.on('data', onData);

  return {
    current() {
      return port;
    },
    dispose() {
      child.stdout?.off('data', onData);
    },
  };
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
