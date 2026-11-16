import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
// @ts-expect-error plain JS module without type declarations
import { startRelay } from '../server/relay.mjs';

const PORT = 18787;
let server: { close(): void };

type Msg = Record<string, any>;

/** Minimal test client that records messages and can wait for one of a given type. */
async function client(name: string): Promise<{ send(m: Msg): void; next(type: string): Promise<Msg>; close(): void }> {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const inbox: Msg[] = [];
  const waiters: Array<() => void> = [];
  ws.on('message', (d) => {
    inbox.push(JSON.parse(d.toString()));
    waiters.splice(0).forEach((w) => w());
  });
  await new Promise((r) => ws.on('open', r));
  const c = {
    send: (m: Msg) => ws.send(JSON.stringify(m)),
    async next(type: string): Promise<Msg> {
      for (;;) {
        const i = inbox.findIndex((m) => m.type === type);
        if (i >= 0) return inbox.splice(i, 1)[0]!;
        await new Promise<void>((r) => waiters.push(r));
      }
    },
    close: () => ws.close(),
  };
  c.send({ type: 'hello', name, jetId: 'falcon' });
  await c.next('welcome');
  return c;
}

beforeAll(() => {
  server = startRelay({ port: PORT, log: () => {} });
});
afterAll(() => server.close());

describe('lobby server', () => {
  it('lists public lobbies, hides private ones, and lets players join by code', async () => {
    const host = await client('Host');
    const guest = await client('Guest');

    host.send({ type: 'createLobby', settings: { name: 'Open', mode: 'free', maxPlayers: 3 } });
    const open = (await host.next('lobby')).lobby;
    expect(open.settings).toMatchObject({ name: 'Open', mode: 'free', maxPlayers: 3, world: { timeOfDay: 14 } });

    const other = await client('Other');
    other.send({ type: 'createLobby', settings: { name: 'Secret', private: true } });
    const secret = (await other.next('lobby')).lobby;

    guest.send({ type: 'listLobbies' });
    const list = (await guest.next('lobbies')).list;
    expect(list.map((l: Msg) => l.name)).toEqual(['Open']);

    guest.send({ type: 'joinLobby', lobbyId: secret.id });
    expect((await guest.next('error')).message).toMatch(/no longer exists/);
    guest.send({ type: 'joinLobby', code: secret.code.toLowerCase() });
    const joined = (await guest.next('lobby')).lobby;
    expect(joined.players.map((p: Msg) => p.name)).toEqual(['Other', 'Guest']);
    [host, guest, other].forEach((c) => c.close());
  });

  it('requires everyone ready to start, relays state in game, and returns to the lobby when all left the game', async () => {
    const host = await client('Host');
    const guest = await client('Guest');
    host.send({ type: 'createLobby', settings: { name: 'Race', mode: 'race', laps: 3 } });
    const lobby = (await host.next('lobby')).lobby;
    guest.send({ type: 'joinLobby', lobbyId: lobby.id });
    await guest.next('lobby');

    host.send({ type: 'startGame' });
    expect((await host.next('error')).message).toMatch(/Guest/);

    guest.send({ type: 'setReady', ready: true });
    host.send({ type: 'startGame' });
    const start = await guest.next('start');
    expect(start.lobby.settings.laps).toBe(3);
    await host.next('start');

    host.send({ type: 'state', p: [1, 2, 3], q: [0, 0, 0, 1], gate: 4, lap: 2 });
    expect(await guest.next('state')).toMatchObject({ p: [1, 2, 3], gate: 4, lap: 2 });

    // Only the host can change settings; players must re-confirm after a change.
    guest.send({ type: 'updateLobby', settings: { laps: 1 } });
    host.send({ type: 'leftGame' });
    guest.send({ type: 'leftGame' });
    let latest: Msg;
    do latest = (await host.next('lobby')).lobby;
    while (latest.state !== 'lobby');
    expect(latest.settings.laps).toBe(3);
    expect(latest.players.every((p: Msg) => !p.ready && !p.inGame)).toBe(true);
    host.close();
    guest.close();
  });

  it('hands the host role over when the host leaves', async () => {
    const host = await client('Host');
    const guest = await client('Guest');
    host.send({ type: 'createLobby', settings: {} });
    const lobby = (await host.next('lobby')).lobby;
    guest.send({ type: 'joinLobby', lobbyId: lobby.id });
    const me = (await guest.next('lobby')).lobby.players.find((p: Msg) => p.name === 'Guest');
    host.close();
    let latest: Msg;
    do latest = (await guest.next('lobby')).lobby;
    while (latest.players.length !== 1);
    expect(latest.hostId).toBe(me.id);
    guest.close();
  });
});
