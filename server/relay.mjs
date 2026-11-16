// Multiplayer lobby server + game relay (WebSocket).
// Started automatically by `npm run dev` (see vite.config.ts), or on its own with `npm run server`.
import { WebSocketServer } from 'ws';
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const MAX_MESSAGE_BYTES = 4096;
const MAX_MESSAGES_PER_SEC = 60;
const MAX_NAME_LEN = 24;
const MAX_LOBBY_PLAYERS = 8;
const EVENTS = new Set(['finish', 'crash', 'gate']);
const MODES = new Set(['free', 'race']);
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Default lobby settings: the game's base world (not the host's personal settings). */
export const DEFAULT_LOBBY_SETTINGS = Object.freeze({
  name: 'Sky race',
  private: false,
  maxPlayers: 8,
  mode: 'race',
  courseId: 'canyon-loop',
  laps: 2,
  allowLateJoin: true,
  world: { timeOfDay: 14, cloudCoverage: 0.4, windSpeed: 6, windDirection: 90, turbulence: 0.5 },
});

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const isVec = (a, len) => Array.isArray(a) && a.length === len && a.every(isNum);
const clamp = (v, min, max, fallback) => (isNum(v) ? Math.min(max, Math.max(min, v)) : fallback);
const cleanStr = (s, fallback, max = MAX_NAME_LEN) =>
  typeof s === 'string' && s.trim() ? s.trim().replace(/[\u0000-\u001f<>]/g, '').slice(0, max) : fallback;

/** Validates lobby settings from a client, filling gaps from `base`. */
export function sanitizeSettings(input, base = DEFAULT_LOBBY_SETTINGS) {
  const s = input && typeof input === 'object' ? input : {};
  const w = s.world && typeof s.world === 'object' ? s.world : {};
  return {
    name: cleanStr(s.name, base.name, 32),
    private: typeof s.private === 'boolean' ? s.private : base.private,
    maxPlayers: Math.round(clamp(s.maxPlayers, 2, MAX_LOBBY_PLAYERS, base.maxPlayers)),
    mode: MODES.has(s.mode) ? s.mode : base.mode,
    courseId: cleanStr(s.courseId, base.courseId, 48),
    laps: Math.round(clamp(s.laps, 1, 5, base.laps)),
    allowLateJoin: typeof s.allowLateJoin === 'boolean' ? s.allowLateJoin : base.allowLateJoin,
    world: {
      timeOfDay: clamp(w.timeOfDay, 0, 24, base.world.timeOfDay),
      cloudCoverage: clamp(w.cloudCoverage, 0, 1, base.world.cloudCoverage),
      windSpeed: clamp(w.windSpeed, 0, 25, base.world.windSpeed),
      windDirection: clamp(w.windDirection, 0, 359, base.world.windDirection),
      turbulence: clamp(w.turbulence, 0, 1, base.world.turbulence),
    },
  };
}

export function startRelay({ port = Number(process.env.PORT) || 8787, log = console.log } = {}) {
  /** @type {Map<string, any>} lobby id -> lobby */
  const lobbies = new Map();
  /** @type {Map<string, any>} player id -> player */
  const players = new Map();
  let nextId = 1;
  let nextLobbyId = 1;

  const send = (p, msg) => {
    if (p.ws.readyState === p.ws.OPEN) p.ws.send(JSON.stringify(msg));
  };

  const newCode = () => {
    let code;
    do {
      code = Array.from({ length: 5 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
    } while ([...lobbies.values()].some((l) => l.code === code));
    return code;
  };

  const lobbyView = (lobby) => ({
    id: lobby.id,
    code: lobby.code,
    hostId: lobby.hostId,
    state: lobby.state,
    startedAt: lobby.startedAt,
    settings: lobby.settings,
    players: [...lobby.members.values()].map((p) => ({ id: p.id, name: p.name, jetId: p.jetId, ready: p.ready, inGame: p.inGame })),
  });

  const summary = (lobby) => ({
    id: lobby.id,
    name: lobby.settings.name,
    hostName: lobby.members.get(lobby.hostId)?.name ?? '?',
    mode: lobby.settings.mode,
    courseId: lobby.settings.courseId,
    laps: lobby.settings.laps,
    players: lobby.members.size,
    maxPlayers: lobby.settings.maxPlayers,
    state: lobby.state,
    joinable: lobby.members.size < lobby.settings.maxPlayers && (lobby.state === 'lobby' || lobby.settings.allowLateJoin),
  });

  const broadcastLobby = (lobby) => {
    const view = lobbyView(lobby);
    for (const p of lobby.members.values()) send(p, { type: 'lobby', lobby: view });
  };

  const relay = (lobby, fromId, msg) => {
    const data = JSON.stringify(msg);
    for (const p of lobby.members.values()) {
      if (p.id !== fromId && p.ws.readyState === p.ws.OPEN) p.ws.send(data);
    }
  };

  /** Back to the lobby screen once nobody is still playing. */
  const checkGameOver = (lobby) => {
    if (lobby.state === 'playing' && ![...lobby.members.values()].some((p) => p.inGame)) {
      lobby.state = 'lobby';
      for (const p of lobby.members.values()) p.ready = false;
    }
  };

  const leaveLobby = (player) => {
    const lobby = player.lobby;
    if (!lobby) return;
    lobby.members.delete(player.id);
    player.lobby = null;
    player.ready = false;
    player.inGame = false;
    if (lobby.members.size === 0) {
      lobbies.delete(lobby.id);
      log(`[lobby ${lobby.code}] closed`);
      return;
    }
    if (lobby.hostId === player.id) lobby.hostId = lobby.members.keys().next().value;
    checkGameOver(lobby);
    broadcastLobby(lobby);
  };

  const joinLobby = (player, lobby) => {
    if (lobby.members.size >= lobby.settings.maxPlayers) return send(player, { type: 'error', message: 'This lobby is full.' });
    if (lobby.state === 'playing' && !lobby.settings.allowLateJoin) return send(player, { type: 'error', message: 'This lobby is already playing.' });
    leaveLobby(player);
    lobby.members.set(player.id, player);
    player.lobby = lobby;
    player.ready = false;
    // Late joiners of a free-flight session go straight in; race late joiners wait for the next race.
    player.inGame = lobby.state === 'playing' && lobby.settings.mode === 'free';
    broadcastLobby(lobby);
    if (player.inGame) send(player, { type: 'start', lobby: lobbyView(lobby), late: true });
    log(`[lobby ${lobby.code}] ${player.name} joined (${lobby.members.size}/${lobby.settings.maxPlayers})`);
  };

  const wss = new WebSocketServer({ port, maxPayload: MAX_MESSAGE_BYTES });

  wss.on('connection', (ws) => {
    const player = { ws, id: String(nextId++), name: 'Pilot', jetId: 'falcon', ready: false, inGame: false, hello: false, lobby: null };
    players.set(player.id, player);
    let windowStart = Date.now();
    let count = 0;

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        count = 0;
      }
      if (++count > MAX_MESSAGES_PER_SEC) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'hello') {
        player.name = cleanStr(msg.name, `Pilot ${player.id}`);
        player.jetId = cleanStr(msg.jetId, player.jetId);
        if (!player.hello) send(player, { type: 'welcome', id: player.id });
        player.hello = true;
        if (player.lobby) broadcastLobby(player.lobby);
        return;
      }
      if (!player.hello) return;
      const lobby = player.lobby;

      switch (msg.type) {
        case 'listLobbies':
          send(player, { type: 'lobbies', list: [...lobbies.values()].filter((l) => !l.settings.private).map(summary) });
          return;
        case 'createLobby': {
          const settings = sanitizeSettings(msg.settings);
          const created = { id: String(nextLobbyId++), code: newCode(), hostId: player.id, state: 'lobby', startedAt: 0, settings, members: new Map() };
          lobbies.set(created.id, created);
          joinLobby(player, created);
          log(`[lobby ${created.code}] created by ${player.name} (${settings.private ? 'private' : 'public'}, ${settings.mode})`);
          return;
        }
        case 'joinLobby': {
          const code = typeof msg.code === 'string' ? msg.code.trim().toUpperCase() : '';
          const target = code ? [...lobbies.values()].find((l) => l.code === code) : lobbies.get(String(msg.lobbyId));
          if (!target || (!code && target.settings.private)) return send(player, { type: 'error', message: code ? `No lobby with code ${code}.` : 'That lobby no longer exists.' });
          joinLobby(player, target);
          return;
        }
        case 'leaveLobby':
          leaveLobby(player);
          send(player, { type: 'lobby', lobby: null });
          return;
      }
      if (!lobby) return;
      const isHost = lobby.hostId === player.id;

      switch (msg.type) {
        case 'updateLobby':
          if (!isHost) return;
          lobby.settings = sanitizeSettings(msg.settings, lobby.settings);
          if (lobby.settings.maxPlayers < lobby.members.size) lobby.settings.maxPlayers = lobby.members.size;
          for (const p of lobby.members.values()) p.ready = false; // settings changed: everyone re-confirms
          broadcastLobby(lobby);
          return;
        case 'setReady':
          player.ready = !!msg.ready;
          broadcastLobby(lobby);
          return;
        case 'kick': {
          const target = lobby.members.get(String(msg.id));
          if (!isHost || !target || target === player) return;
          leaveLobby(target);
          send(target, { type: 'lobby', lobby: null });
          send(target, { type: 'error', message: 'You were removed from the lobby by the host.' });
          return;
        }
        case 'startGame': {
          if (!isHost || lobby.state !== 'lobby') return;
          const notReady = [...lobby.members.values()].filter((p) => p.id !== player.id && !p.ready);
          if (notReady.length) return send(player, { type: 'error', message: `Waiting for ${notReady.map((p) => p.name).join(', ')} to be ready.` });
          lobby.state = 'playing';
          lobby.startedAt = Date.now();
          for (const p of lobby.members.values()) p.inGame = true;
          const view = lobbyView(lobby);
          for (const p of lobby.members.values()) send(p, { type: 'start', lobby: view });
          broadcastLobby(lobby);
          log(`[lobby ${lobby.code}] started ${lobby.settings.mode}`);
          return;
        }
        case 'leftGame':
          player.inGame = false;
          player.ready = false;
          checkGameOver(lobby);
          broadcastLobby(lobby);
          return;
        case 'state':
          if (!player.inGame || !isVec(msg.p, 3) || !isVec(msg.q, 4)) return;
          relay(lobby, player.id, {
            type: 'state',
            id: player.id,
            p: msg.p,
            q: msg.q,
            v: isVec(msg.v, 3) ? msg.v : [0, 0, 0],
            thr: isNum(msg.thr) ? msg.thr : 0,
            ab: !!msg.ab,
            gate: isNum(msg.gate) ? msg.gate : 0,
            lap: isNum(msg.lap) ? msg.lap : 0,
          });
          return;
        case 'event':
          if (!EVENTS.has(msg.event)) return;
          relay(lobby, player.id, { type: 'event', id: player.id, event: msg.event, data: msg.data ?? null });
          return;
        case 'chat': {
          const text = cleanStr(msg.text, '', 200);
          if (text) for (const p of lobby.members.values()) send(p, { type: 'chat', id: player.id, name: player.name, text });
          return;
        }
      }
    });

    ws.on('close', () => {
      leaveLobby(player);
      players.delete(player.id);
    });
    ws.on('error', () => ws.terminate());
  });

  wss.on('listening', () => log(`Multiplayer server listening on ws://localhost:${port}`));
  return wss;
}

// Run directly: `node server/relay.mjs`
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase()) {
  startRelay();
}
