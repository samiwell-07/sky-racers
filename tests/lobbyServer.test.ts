import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
// @ts-expect-error plain JS module without type declarations
import { DOGFIGHT_KILLS_TO_WIN, dogfightKiller, isValidWorldKey, sanitizeSettings, startRelay } from '../server/relay.mjs';
import { DOGFIGHT_RULES } from '../src/combat/types';
import { parseWorldKey } from '../src/world/gen/WorldGenerator';

const PORT = 18787;
let server: { close(): void };

type Msg = Record<string, any>;

/** Minimal test client that records messages and can wait for one of a given type. */
type Client = { send(m: Msg): void; next(type: string): Promise<Msg>; take(type: string): Msg[]; close(): void };

async function client(name: string): Promise<Client> {
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
    /** Removes and returns every received message of a type (no waiting). */
    take(type: string): Msg[] {
      const out = inbox.filter((m) => m.type === type);
      for (const m of out) inbox.splice(inbox.indexOf(m), 1);
      return out;
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

  it('lets the host force a camera view and a jet, shown as every pilot\'s jet', async () => {
    const host = await client('Host');
    const guest = await client('Guest');
    host.send({ type: 'createLobby', settings: { name: 'Locked' } });
    const lobby = (await host.next('lobby')).lobby;
    expect(lobby.settings).toMatchObject({ forceView: 'any', forceJet: '' });
    guest.send({ type: 'joinLobby', lobbyId: lobby.id });
    await guest.next('lobby');
    host.send({ type: 'updateLobby', settings: { ...lobby.settings, forceView: 'cockpit', forceJet: 'viper' } });
    let latest: Msg;
    do latest = (await guest.next('lobby')).lobby;
    while (latest.settings.forceJet !== 'viper');
    expect(latest.settings.forceView).toBe('cockpit');
    expect(latest.players.map((p: Msg) => p.jetId)).toEqual(['viper', 'viper']);
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

describe('lobby settings validation', () => {
  it('keeps a valid world key and seed text, and defaults old clients to Classic', () => {
    const s = sanitizeSettings({ world: { worldKey: 's12345', seedText: '  my <seed>  ' }, raceDifficulty: 'hard', raceLayout: 'sprint' });
    expect(s.world).toMatchObject({ worldKey: 's12345', seedText: 'my seed', timeOfDay: 14 });
    expect(s).toMatchObject({ raceDifficulty: 'hard', raceLayout: 'sprint' });
    expect(sanitizeSettings({}).world).toMatchObject({ worldKey: 'classic', seedText: '' });
    expect(sanitizeSettings({ world: { worldKey: 's77' } }).world.seedText).toBe('77');
    expect(sanitizeSettings({ world: { worldKey: 'classic', seedText: 'x' } }).world.seedText).toBe('');
  });

  it('rejects malformed keys, difficulties and layouts (falls back to the base)', () => {
    const base = sanitizeSettings({ world: { worldKey: 's5', seedText: 'five' }, raceDifficulty: 'easy', raceLayout: 'loop' });
    for (const worldKey of ['s', 's-1', 's99999999999', 's4294967296', 'S5', 'classic2', 42]) {
      const s = sanitizeSettings({ world: { worldKey, seedText: 'evil' }, raceDifficulty: 'insane', raceLayout: 'zigzag' }, base);
      expect(s.world).toMatchObject({ worldKey: 's5', seedText: 'five' });
      expect(s).toMatchObject({ raceDifficulty: 'easy', raceLayout: 'loop' });
    }
  });

  it('uses the same world key format as parseWorldKey', () => {
    for (const key of ['classic', 's0', 's4294967295', 's4294967296', 's12345678901', 'sabc', 'x1', '']) {
      expect(isValidWorldKey(key)).toBe(parseWorldKey(key) !== null);
    }
  });

  it('caps a dogfight at 4 pilots', () => {
    expect(sanitizeSettings({ mode: 'dogfight', maxPlayers: 8 }).maxPlayers).toBe(4);
    expect(sanitizeSettings({ mode: 'dogfight', maxPlayers: 3 }).maxPlayers).toBe(3);
    expect(sanitizeSettings({ mode: 'race', maxPlayers: 6 }).maxPlayers).toBe(6);
  });

  it('rejects unknown forced views and malformed forced jets', () => {
    const base = sanitizeSettings({ forceView: 'chase', forceJet: 'falcon' });
    expect(sanitizeSettings({ forceView: 'drone', forceJet: '<script>' }, base)).toMatchObject({ forceView: 'chase', forceJet: 'falcon' });
    expect(sanitizeSettings({ forceView: 'any', forceJet: '' }, base)).toMatchObject({ forceView: 'any', forceJet: '' });
  });

  it('gives zone/crash deaths to the opponent and matches the shared kill target', () => {
    expect(DOGFIGHT_KILLS_TO_WIN).toBe(DOGFIGHT_RULES.killsToWin);
    expect(dogfightKiller(['a', 'b'], 'a', 'b')).toBe('b');
    expect(dogfightKiller(['a', 'b'], 'a', null)).toBe('b');
    expect(dogfightKiller(['a', 'b'], 'a', 'a')).toBe('b');
    expect(dogfightKiller(['a', 'b'], 'a', 'ghost')).toBe('b');
    // Free-for-all: only a named shooter scores.
    expect(dogfightKiller(['a', 'b', 'c'], 'a', 'c')).toBe('c');
    expect(dogfightKiller(['a', 'b', 'c'], 'a', null)).toBeNull();
    expect(dogfightKiller(['a', 'b', 'c'], 'a', 'a')).toBeNull();
  });
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Host + guest in a started dogfight. */
async function dogfight(): Promise<{ host: Client; guest: Client; hostId: string; guestId: string }> {
  const host = await client('Host');
  const guest = await client('Guest');
  host.send({ type: 'createLobby', settings: { name: 'Duel', mode: 'dogfight', maxPlayers: 8 } });
  const lobby = (await host.next('lobby')).lobby;
  guest.send({ type: 'joinLobby', lobbyId: lobby.id });
  const joined = (await guest.next('lobby')).lobby;
  const guestId = joined.players.find((p: Msg) => p.name === 'Guest').id;
  guest.send({ type: 'setReady', ready: true });
  await guest.next('lobby');
  host.send({ type: 'startGame' });
  await host.next('start');
  await guest.next('start');
  expect((await guest.next('dogfightScore')).kills).toEqual({ [lobby.hostId]: 0, [guestId]: 0 });
  await host.next('dogfightScore');
  host.take('lobby');
  guest.take('lobby');
  return { host, guest, hostId: lobby.hostId, guestId };
}

describe('dogfight', () => {
  it('caps the lobby at 4 pilots and refuses switching a bigger lobby to dogfight', async () => {
    const host = await client('Host');
    const others = await Promise.all(['A', 'B', 'C', 'D'].map((n) => client(n)));
    const [a, b, c, d] = others;
    host.send({ type: 'createLobby', settings: { mode: 'dogfight', maxPlayers: 8 } });
    const lobby = (await host.next('lobby')).lobby;
    expect(lobby.settings.maxPlayers).toBe(4);
    for (const p of [a, b, c]) {
      p.send({ type: 'joinLobby', lobbyId: lobby.id });
      await p.next('lobby');
    }
    d.send({ type: 'listLobbies' });
    const row = (await d.next('lobbies')).list.find((l: Msg) => l.id === lobby.id);
    expect(row).toMatchObject({ mode: 'dogfight', players: 4, maxPlayers: 4, joinable: false });
    d.send({ type: 'joinLobby', lobbyId: lobby.id });
    expect((await d.next('error')).message).toMatch(/full/);

    const race = await client('Racer');
    race.send({ type: 'createLobby', settings: { mode: 'race', maxPlayers: 8 } });
    const raceLobby = (await race.next('lobby')).lobby;
    for (const p of others) p.send({ type: 'joinLobby', lobbyId: raceLobby.id });
    let latest: Msg;
    do latest = (await race.next('lobby')).lobby;
    while (latest.players.length !== 5);
    race.send({ type: 'updateLobby', settings: { mode: 'dogfight' } });
    expect((await race.next('error')).message).toMatch(/at most 4/);
    [host, ...others, race].forEach((p) => p.close());
  });

  it('keeps a 3-pilot dogfight going when one pilot leaves', async () => {
    const host = await client('Host');
    const a = await client('A');
    const b = await client('B');
    host.send({ type: 'createLobby', settings: { mode: 'dogfight', maxPlayers: 4 } });
    const lobby = (await host.next('lobby')).lobby;
    for (const p of [a, b]) {
      p.send({ type: 'joinLobby', lobbyId: lobby.id });
      await p.next('lobby');
      p.send({ type: 'setReady', ready: true });
    }
    let latest: Msg;
    do latest = (await host.next('lobby')).lobby;
    while (latest.players.filter((p: Msg) => p.ready).length < 2);
    host.send({ type: 'startGame' });
    await host.next('start');
    const first = await host.next('dogfightScore');
    expect(Object.keys(first.kills)).toHaveLength(3);
    b.close();
    do latest = (await host.next('lobby')).lobby;
    while (latest.players.length !== 2);
    expect(latest.state).toBe('playing');
    expect(host.take('dogfightScore').some((s: Msg) => s.winnerId)).toBe(false);
    host.close();
    a.close();
  });

  it('shows the world seed in the lobby list', async () => {
    const host = await client('Host');
    host.send({ type: 'createLobby', settings: { name: 'Seeded', world: { worldKey: 's42', seedText: '42' }, raceLayout: 'sprint' } });
    const lobby = (await host.next('lobby')).lobby;
    host.send({ type: 'listLobbies' });
    const row = (await host.next('lobbies')).list.find((l: Msg) => l.id === lobby.id);
    expect(row).toMatchObject({ worldKey: 's42', seedText: '42', raceLayout: 'sprint', raceDifficulty: 'medium' });
    host.close();
  });

  it('relays valid combat messages to the peer only and drops garbage', async () => {
    const { host, guest, hostId } = await dogfight();
    host.send({ type: 'combat', msg: { t: 'gunFire', p: [1, 2], v: [0, 0, 0] } });
    host.send({ type: 'combat', msg: { t: 'nuke' } });
    host.send({ type: 'combat', msg: { t: 'gunHit', target: 'x', damage: 5 } });
    host.send({ type: 'combat', msg: { t: 'flares', p: [0, 0, 0], v: [0, 0, 0], n: 2, extra: 'x'.repeat(100) } });
    const got = await guest.next('combat');
    expect(got).toEqual({ type: 'combat', id: hostId, msg: { t: 'flares', p: [0, 0, 0], v: [0, 0, 0], n: 2 } });
    await wait(100);
    expect(guest.take('combat')).toEqual([]);
    expect(host.take('combat')).toEqual([]);
    host.close();
    guest.close();
  });

  it('counts kills (zone/crash go to the opponent), ignores double deaths and declares the winner at 3', async () => {
    const { host, guest, hostId, guestId } = await dogfight();
    const score = async (): Promise<Msg> => {
      const s = await host.next('dogfightScore');
      expect(await guest.next('dogfightScore')).toEqual(s);
      return s;
    };
    guest.send({ type: 'combat', msg: { t: 'destroyed', by: hostId, cause: 'gun' } });
    expect((await score()).kills).toEqual({ [hostId]: 1, [guestId]: 0 });
    guest.send({ type: 'combat', msg: { t: 'destroyed', by: hostId, cause: 'gun' } }); // not respawned: ignored
    guest.send({ type: 'combat', msg: { t: 'respawned' } });
    guest.send({ type: 'combat', msg: { t: 'destroyed', by: null, cause: 'crash' } });
    expect((await score()).kills).toEqual({ [hostId]: 2, [guestId]: 0 });
    host.send({ type: 'combat', msg: { t: 'destroyed', by: null, cause: 'zone' } });
    expect((await score()).kills).toEqual({ [hostId]: 2, [guestId]: 1 });
    guest.send({ type: 'combat', msg: { t: 'respawned' } });
    guest.send({ type: 'combat', msg: { t: 'destroyed', by: hostId, cause: 'missile' } });
    const final = await score();
    expect(final).toMatchObject({ kills: { [hostId]: 3, [guestId]: 1 }, winnerId: hostId });
    let latest: Msg;
    do latest = (await guest.next('lobby')).lobby;
    while (latest.state !== 'lobby');
    expect(latest.players.every((p: Msg) => !p.inGame && !p.ready)).toBe(true);
    // Combat after the end is dropped.
    host.send({ type: 'combat', msg: { t: 'respawned' } });
    await wait(100);
    expect(guest.take('combat').filter((m) => m.msg.t === 'respawned' && m.id === hostId)).toEqual([]);
    host.close();
    guest.close();
  });

  it('gives the win to the pilot left behind when the other one quits', async () => {
    const { host, guest, guestId } = await dogfight();
    host.close();
    expect((await guest.next('dogfightScore')).winnerId).toBe(guestId);
    let latest: Msg;
    do latest = (await guest.next('lobby')).lobby;
    while (latest.players.length !== 1);
    expect(latest.state).toBe('lobby');
    guest.close();
  });

  it('rate-limits combat messages per client', async () => {
    const { host, guest } = await dogfight();
    for (let i = 0; i < 120; i++) host.send({ type: 'combat', msg: { t: 'gunFire', p: [i, 0, 0], v: [0, 0, 0] } });
    await guest.next('combat');
    await wait(300);
    const received = guest.take('combat').length + 1;
    expect(received).toBeLessThanOrEqual(60);
    expect(received).toBeGreaterThanOrEqual(50);
    host.close();
    guest.close();
  });
});
