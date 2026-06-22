import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startFoundryServer } from '../../src/foundry-server.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

describe('startFoundryServer', () => {
  const spawnMock = vi.mocked(spawn);
  const originalFoundryPort = process.env.PGAS_FOUNDRY_PORT;

  beforeEach(() => {
    spawnMock.mockReset();
    delete process.env.PGAS_FOUNDRY_PORT;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalFoundryPort === undefined) {
      delete process.env.PGAS_FOUNDRY_PORT;
    } else {
      process.env.PGAS_FOUNDRY_PORT = originalFoundryPort;
    }
  });

  it('uses an explicit options.port before PGAS_FOUNDRY_PORT', async () => {
    const child = mockChildProcess();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.PGAS_FOUNDRY_PORT = '4666';

    const server = await startFoundryServer({ port: 4555, hostname: '127.0.0.1' });

    expect(server.url).toBe('http://127.0.0.1:4555');
    expect(spawnMock).toHaveBeenCalledWith(
      'pgas-server',
      [
        '--program-dir',
        expect.stringMatching(/src\/foundry-program$/),
        '--port',
        '4555',
        '--hostname',
        '127.0.0.1',
      ],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'ignore'] }),
    );
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4555/healthz');
  });

  it('uses PGAS_FOUNDRY_PORT when options.port is absent', async () => {
    const child = mockChildProcess();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.PGAS_FOUNDRY_PORT = '4666';

    const server = await startFoundryServer({ hostname: '127.0.0.1' });

    expect(server.url).toBe('http://127.0.0.1:4666');
    expect(spawnMock).toHaveBeenCalledWith(
      'pgas-server',
      [
        '--program-dir',
        expect.stringMatching(/src\/foundry-program$/),
        '--port',
        '4666',
        '--hostname',
        '127.0.0.1',
      ],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'ignore'] }),
    );
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4666/healthz');
  });

  it('falls back to an ephemeral port when no port override is configured', async () => {
    const child = mockChildProcess();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    emitStdoutListening(child, 4876);

    const server = await startFoundryServer({ hostname: '127.0.0.1' });

    expect(server.url).toBe('http://127.0.0.1:4876');
    expect(spawnMock).toHaveBeenCalledWith(
      'pgas-server',
      [
        '--program-dir',
        expect.stringMatching(/src\/foundry-program$/),
        '--port',
        '0',
        '--hostname',
        '127.0.0.1',
      ],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'ignore'] }),
    );
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4876/healthz');
  });

  it('parses the bound port from stdout before probing readiness', async () => {
    const child = mockChildProcess();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from('foundry server listening '));
      child.stdout.emit('data', Buffer.from('on port 4988\n'));
    });

    const server = await startFoundryServer({ port: 0, hostname: 'localhost' });

    expect(server.url).toBe('http://localhost:4988');
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4988/healthz');
  });

  it('polls readiness until /healthz returns HTTP 200', async () => {
    const child = mockChildProcess();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await startFoundryServer({ port: 4556, hostname: 'localhost' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://localhost:4556/healthz');
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://localhost:4556/healthz');
  });

  it('returns a kill function that terminates the child process', async () => {
    const child = mockChildProcess();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })));

    const server = await startFoundryServer({ port: 4557, hostname: '127.0.0.1' });
    await server.kill();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

function mockChildProcess(): EventEmitter & { kill: ReturnType<typeof vi.fn>; stdout: EventEmitter } {
  return Object.assign(new EventEmitter(), {
    kill: vi.fn(() => true),
    stdout: new EventEmitter(),
  });
}

function emitStdoutListening(child: { stdout: EventEmitter }, port: number): void {
  process.nextTick(() => {
    child.stdout.emit('data', `foundry server listening on port ${String(port)}\n`);
  });
}
