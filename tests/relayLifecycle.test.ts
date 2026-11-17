import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createLogger, createServer, type Plugin, type ViteDevServer } from 'vite';
import WebSocket, { type WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain JS module without type declarations
import { startRelay, stopRelay } from '../server/relay.mjs';
import { multiplayerServer } from '../vite.config';

const cleanup: Array<() => Promise<unknown>> = [];

beforeEach(() => {
  vi.stubEnv('VITEST', '');
  vi.stubEnv('PORT', '0');
  vi.stubEnv('HOST', 'localhost');
});

afterEach(async () => {
  try {
    for (const close of cleanup.reverse()) await close();
  } finally {
    cleanup.length = 0;
    vi.unstubAllEnvs();
  }
});

async function relay(options = {}): Promise<WebSocketServer> {
  const server = startRelay({ port: 0, log: () => {}, ...options });
  cleanup.push(() => stopRelay(server));
  await once(server, 'listening');
  return server;
}

async function configure(plugin: Plugin, log = vi.fn()) {
  const hook = plugin.configureServer;
  if (typeof hook !== 'function') throw new Error('Expected configureServer hook');
  await hook.call({} as never, {
    config: { server: { host: '127.0.0.1' }, logger: { info: log, error: vi.fn() } },
  } as unknown as ViteDevServer);
  const start = plugin.buildStart;
  if (typeof start === 'function') await start.call({} as never, {} as never);
}

function track(plugin: Plugin) {
  cleanup.push(async () => {
    const hook = plugin.closeServer;
    if (typeof hook === 'function') await hook.call({} as never, { reason: 'close' });
  });
  return plugin;
}

describe('relay lifecycle', () => {
  it('defaults to loopback and logs the actual bound address and ephemeral port', async () => {
    const log = vi.fn();
    const server = await relay({ log });
    const address = server.address() as AddressInfo;
    expect(['127.0.0.1', '::1']).toContain(address.address);
    const host = address.address.includes(':') ? `[${address.address}]` : address.address;
    expect(log).toHaveBeenCalledWith(`Multiplayer server listening on ws://${host}:${address.port}`);
  });

  it('closes connected clients and releases the relay port before plugin shutdown completes', async () => {
    const plugin = track(multiplayerServer());
    const log = vi.fn();
    await configure(plugin, log);
    const url = log.mock.calls[0]![0].match(/ws:\/\/\S+/)![0] as string;
    const client = new WebSocket(url);
    cleanup.push(async () => { client.terminate(); });
    await once(client, 'open');
    const disconnected = once(client, 'close');
    const close = plugin.closeServer;
    if (typeof close !== 'function') throw new Error('Expected closeServer hook');
    await close.call({} as never, { reason: 'close' });
    await disconnected;
    const replacement = await relay({ host: '127.0.0.1', port: Number(new URL(url).port) });
    expect((replacement.address() as AddressInfo).port).toBe(Number(new URL(url).port));
  });

  it('rejects startup rather than claiming an occupied relay is usable', async () => {
    const existing = await relay({ host: '127.0.0.1' });
    vi.stubEnv('PORT', String((existing.address() as AddressInfo).port));
    const log = vi.fn();
    await expect(configure(track(multiplayerServer()), log)).rejects.toThrow(/refusing to reuse a possibly outdated server/);
    expect(log).not.toHaveBeenCalled();
    expect(existing.address()).not.toBeNull();
  });

  it('restarts a real Vite server with an active client, rebinds the relay and closes both listeners', async () => {
    const logger = createLogger('silent');
    const info = vi.spyOn(logger, 'info');
    const error = vi.spyOn(logger, 'error');
    const server = await createServer({
      customLogger: logger,
      server: { host: '127.0.0.1', port: 0, open: false },
    });
    cleanup.push(() => server.close());
    await server.listen();
    const url = info.mock.calls.find(([message]) => message.includes('[multiplayer]'))![0].match(/ws:\/\/\S+/)![0]!;
    const port = Number(new URL(url).port);
    vi.stubEnv('PORT', String(port));
    const client = new WebSocket(url);
    cleanup.push(async () => { client.terminate(); });
    await once(client, 'open');
    const disconnected = once(client, 'close');
    await server.restart();
    await disconnected;
    expect(error).not.toHaveBeenCalled();
    const replacement = new WebSocket(url);
    cleanup.push(async () => { replacement.terminate(); });
    await once(replacement, 'open');
    const replacementClosed = once(replacement, 'close');
    const httpPort = (server.httpServer!.address() as AddressInfo).port;
    await server.close();
    await replacementClosed;
    expect(server.httpServer!.listening).toBe(false);
    await relay({ host: '127.0.0.1', port });
    const httpProbe = await relay({ host: '127.0.0.1', port: httpPort });
    expect((httpProbe.address() as AddressInfo).port).toBe(httpPort);
  }, 15_000);
});
