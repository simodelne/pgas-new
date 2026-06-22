import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startFoundryServer } from '../../src/foundry-server.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

describe('startFoundryServer', () => {
  const spawnMock = vi.mocked(spawn);

  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('spawns pgas-server with the foundry program directory and requested host/port', async () => {
    const child = mockChildProcess();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

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
      expect.objectContaining({ stdio: 'ignore' }),
    );
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4555/healthz');
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

function mockChildProcess(): EventEmitter & { kill: ReturnType<typeof vi.fn> } {
  return Object.assign(new EventEmitter(), {
    kill: vi.fn(() => true),
  });
}
