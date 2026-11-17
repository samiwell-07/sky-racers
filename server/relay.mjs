// Multiplayer lobby server + game relay (WebSocket).
// Started automatically by `npm run dev` (see vite.config.ts), or on its own with `npm run server`.
import { WebSocketServer } from 'ws';
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const MAX_MESSAGE_BYTES = 4096;
const MAX_MESSAGES_PER_SEC = 60;
/** Combat messages have their own budget (gun bursts, missile updates) so they don't starve state. */
const MAX_COMBAT_PER_SEC = 60;
/** Hard cap on everything a client sends, checked before parsing. */
const MAX_RAW_PER_SEC = MAX_MESSAGES_PER_SEC + MAX_COMBAT_PER_SEC + 30;
const MAX_COMBAT_BYTES = 1024;
const MAX_NAME_LEN = 24;
const MAX_LOBBY_PLAYERS = 8;
const MAX_SEED_TEXT_LEN = 32;
const EVENTS = new Set(['finish', 'crash', 'gate']);
const MODES = new Set(['free', 'race', 'dogfight']);
const DIFFICULTIES = new Set(['easy', 'medium', 'hard']);
const LAYOUTS = new Set(['sprint', 'loop']);
const VIEWS = new Set(['any', 'chase', 'cockpit']);
/** Jet ids look like 'falcon' (the client falls back to the pilot's own jet for unknown ids). */
const isJetIdOrAny = (s) => s === '' || (typeof s === 'string' && /^[\w-]{1,32}$/.test(s));
const DEATH_CAUSES = new Set(['gun', 'missile', 'zone', 'crash']);
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** Mirrors DOGFIGHT_RULES.killsToWin / minPlayers / maxPlayers (src/combat/types.ts). */
export const DOGFIGHT_KILLS_TO_WIN = 3;
export const DOGFIGHT_MIN_PLAYERS = 2;
export const DOGFIGHT_MAX_PLAYERS = 4;

/** Default lobby settings: the game's base world (not the host's personal settings); old clients get Classic. */
export const DEFAULT_LOBBY_SETTINGS = Object.freeze({
  name: 'Sky race',
  private: false,
  maxPlayers: 8,
  mode: 'race',
  courseId: 'canyon-loop',
  laps: 2,
  raceDifficulty: 'medium',
  raceLayout: 'loop',
  allowLateJoin: true,
  forceView: 'any',
  forceJet: '',
  world: { timeOfDay: 14, cloudCoverage: 0.4, windSpeed: 6, windDirection: 90, turbulence: 0.5, seedText: '', worldKey: 'classic' },
});

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const isVec = (a, len) => Array.isArray(a) && a.length === len && a.every(isNum);
const clamp = (v, min, max, fallback) => (isNum(v) ? Math.min(max, Math.max(min, v)) : fallback);
const cleanStr = (s, fallback, max = MAX_NAME_LEN) =>
  typeof s === 'string' && s.trim() ? s.trim().replace(/[\u0000-\u001f<>]/g, '').slice(0, max) : fallback;
/** Same cleanup as cleanSeedText (src/net/lobbyTypes.ts). */
const cleanSeedText = (s) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, MAX_SEED_TEXT_LEN) : '');

/** Same format as parseWorldKey (src/world/gen/WorldGenerator.ts): 'classic' or 's<uint32>'. */
export function isValidWorldKey(key) {
  if (key === 'classic') return true;
  const m = typeof key === 'string' ? /^s(\d{1,10})$/.exec(key) : null;
  return !!m && Number(m[1]) <= 4294967295;
}

function sanitizeWorldId(w, base) {
  if (!isValidWorldKey(w.worldKey)) return { seedText: base.seedText ?? '', worldKey: isValidWorldKey(base.worldKey) ? base.worldKey : 'classic' };
  if (w.worldKey === 'classic') return { seedText: '', worldKey: 'classic' };
  return { seedText: cleanSeedText(w.seedText) || w.worldKey.slice(1), worldKey: w.worldKey };
}

/** Validates lobby settings from a client, filling gaps from `base`. */
export function sanitizeSettings(input, base = DEFAULT_LOBBY_SETTINGS) {
  const s = input && typeof input === 'object' ? input : {};
  const w = s.world && typeof s.world === 'object' ? s.world : {};
  const mode = MODES.has(s.mode) ? s.mode : base.mode;
  const maxPlayers = Math.round(clamp(s.maxPlayers, 2, MAX_LOBBY_PLAYERS, base.maxPlayers));
  return {
    name: cleanStr(s.name, base.name, 32),
    private: typeof s.private === 'boolean' ? s.private : base.private,
    maxPlayers: mode === 'dogfight' ? Math.min(DOGFIGHT_MAX_PLAYERS, maxPlayers) : maxPlayers,
    mode,
    courseId: cleanStr(s.courseId, base.courseId, 48),
    laps: Math.round(clamp(s.laps, 1, 5, base.laps)),
    raceDifficulty: DIFFICULTIES.has(s.raceDifficulty) ? s.raceDifficulty : base.raceDifficulty ?? DEFAULT_LOBBY_SETTINGS.raceDifficulty,
    raceLayout: LAYOUTS.has(s.raceLayout) ? s.raceLayout : base.raceLayout ?? DEFAULT_LOBBY_SETTINGS.raceLayout,
    allowLateJoin: typeof s.allowLateJoin === 'boolean' ? s.allowLateJoin : base.allowLateJoin,
    forceView: VIEWS.has(s.forceView) ? s.forceView : base.forceView ?? DEFAULT_LOBBY_SETTINGS.forceView,
    forceJet: isJetIdOrAny(s.forceJet) ? s.forceJet : base.forceJet ?? DEFAULT_LOBBY_SETTINGS.forceJet,
    world: {
      timeOfDay: clamp(w.timeOfDay, 0, 24, base.world.timeOfDay),
      cloudCoverage: clamp(w.cloudCoverage, 0, 1, base.world.cloudCoverage),
      windSpeed: clamp(w.windSpeed, 0, 25, base.world.windSpeed),
      windDirection: clamp(w.windDirection, 0, 359, base.world.windDirection),
      turbulence: clamp(w.turbulence, 0, 1, base.world.turbulence),
      ...sanitizeWorldId(w, base.world),
    },
  };
}

const isId = (s) => typeof s === 'string' && /^[\w.:-]{1,32}$/.test(s);
const isIdOrNull = (s) => s === null || isId(s);
const isDamage = (d) => isNum(d) && d >= 0 && d <= 1;

/** Validates a combat message (src/combat/types.ts CombatMessage); returns a clean copy or null. */
export function sanitizeCombat(m) {
  if (!m || typeof m !== 'object') return null;
  switch (m.t) {
    case 'gunFire':
      return isVec(m.p, 3) && isVec(m.v, 3) ? { t: m.t, p: m.p, v: m.v } : null;
    case 'gunHit':
      return isId(m.target) && isDamage(m.damage) ? { t: m.t, target: m.target, damage: m.damage } : null;
    case 'missileLaunch':
      return isId(m.id) && isIdOrNull(m.target) && isVec(m.p, 3) && isVec(m.v, 3) ? { t: m.t, id: m.id, target: m.target, p: m.p, v: m.v } : null;
    case 'missileUpdate':
      return isId(m.id) && isVec(m.p, 3) && isVec(m.v, 3) ? { t: m.t, id: m.id, p: m.p, v: m.v } : null;
    case 'missileEnd':
      return isId(m.id) && isVec(m.p, 3) && isIdOrNull(m.hit) && isDamage(m.damage) ? { t: m.t, id: m.id, p: m.p, hit: m.hit, damage: m.damage } : null;
    case 'flares':
      return isVec(m.p, 3) && isVec(m.v, 3) && Number.isInteger(m.n) && m.n >= 1 && m.n <= 10 ? { t: m.t, p: m.p, v: m.v, n: m.n } : null;
    case 'destroyed':
      return isIdOrNull(m.by) && DEATH_CAUSES.has(m.cause) ? { t: m.t, by: m.by, cause: m.cause } : null;
    case 'respawned':
      return { t: m.t };
    default:
      return null;
  }
}

/**
 * Who scores a dogfight kill: the reported killer when it is another pilot of the match; otherwise
 * (zone, crash, by = null or nonsense) the other pilot of a duel, who "forced" the death. In a
 * free-for-all such a death scores for nobody (clients already credit a recent attacker in `by`).
 */
export function dogfightKiller(pilotIds, victimId, by) {
  if (by && by !== victimId && pilotIds.includes(by)) return by;
  const others = pilotIds.filter((id) => id !== victimId);
  return others.length === 1 ? others[0] : null;
}

export function startRelay({ port = Number(process.env.PORT ?? 8787), host = process.env.HOST || 'localhost', log = console.log } = {}) {
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
    // A jet forced by the host is what everyone flies, so it's what everyone sees.
    players: [...lobby.members.values()].map((p) => ({ id: p.id, name: p.name, jetId: lobby.settings.forceJet || p.jetId, ready: p.ready, inGame: p.inGame })),
  });

  /** Joining a game in progress: allowed by the host (dogfight and race late joiners wait in the lobby for the next one). */
  const canJoinPlaying = (lobby) => lobby.settings.allowLateJoin;

  const summary = (lobby) => ({
    id: lobby.id,
    name: lobby.settings.name,
    hostName: lobby.members.get(lobby.hostId)?.name ?? '?',
    mode: lobby.settings.mode,
    courseId: lobby.settings.courseId,
    laps: lobby.settings.laps,
    raceDifficulty: lobby.settings.raceDifficulty,
    raceLayout: lobby.settings.raceLayout,
    worldKey: lobby.settings.world.worldKey,
    seedText: lobby.settings.world.seedText,
    players: lobby.members.size,
    maxPlayers: lobby.settings.maxPlayers,
    state: lobby.state,
    joinable: lobby.members.size < lobby.settings.maxPlayers && (lobby.state === 'lobby' || canJoinPlaying(lobby)),
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

  const sendScore = (lobby) => {
    const d = lobby.dogfight;
    if (!d) return;
    for (const p of lobby.members.values()) send(p, { type: 'dogfightScore', kills: d.kills, winnerId: d.winnerId });
  };

  /** A dogfight is over (winner or forfeit): everyone goes back to the lobby, like after a race. */
  const endDogfight = (lobby) => {
    lobby.state = 'lobby';
    for (const p of lobby.members.values()) {
      p.inGame = false;
      p.ready = false;
    }
    log(`[lobby ${lobby.code}] dogfight over, winner ${lobby.dogfight?.winnerId ?? 'none'}`);
  };

  /** Pilots still in the running dogfight. */
  const pilotsOf = (lobby) => [...lobby.members.values()].filter((p) => p.inGame);

  /**
   * A pilot left a running dogfight (left the lobby or the game): once a single pilot is left, it
   * wins by forfeit; with two or more left the match goes on.
   */
  const forfeitDogfight = (lobby, quitter) => {
    const d = lobby.dogfight;
    if (lobby.settings.mode !== 'dogfight' || lobby.state !== 'playing' || !d || d.winnerId) return;
    const remaining = pilotsOf(lobby).filter((p) => p.id !== quitter.id);
    if (remaining.length >= DOGFIGHT_MIN_PLAYERS) return;
    d.winnerId = remaining[0]?.id ?? null;
    sendScore(lobby);
    endDogfight(lobby);
  };

  /** Counts a kill from the victim's own 'destroyed' message. */
  const recordDeath = (lobby, victim, by) => {
    const d = lobby.dogfight;
    if (!d || d.winnerId || !victim.alive) return;
    victim.alive = false;
    const killer = dogfightKiller(pilotsOf(lobby).map((p) => p.id), victim.id, by);
    if (!killer) return;
    d.kills[killer] = (d.kills[killer] ?? 0) + 1;
    if (d.kills[killer] >= DOGFIGHT_KILLS_TO_WIN) d.winnerId = killer;
    sendScore(lobby);
    if (d.winnerId) {
      endDogfight(lobby);
      broadcastLobby(lobby);
    }
  };

  const leaveLobby = (player) => {
    const lobby = player.lobby;
    if (!lobby) return;
    const wasInGame = player.inGame;
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
    if (wasInGame) forfeitDogfight(lobby, player);
    checkGameOver(lobby);
    broadcastLobby(lobby);
  };

  const joinLobby = (player, lobby) => {
    if (lobby.members.size >= lobby.settings.maxPlayers) return send(player, { type: 'error', message: 'This lobby is full.' });
    if (lobby.state === 'playing' && !canJoinPlaying(lobby)) return send(player, { type: 'error', message: 'This lobby is already playing.' });
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

  const wss = new WebSocketServer({ port, host, maxPayload: MAX_MESSAGE_BYTES });

  wss.on('connection', (ws) => {
    const player = { ws, id: String(nextId++), name: 'Pilot', jetId: 'falcon', ready: false, inGame: false, alive: true, hello: false, lobby: null };
    players.set(player.id, player);
    let windowStart = Date.now();
    let rawCount = 0;
    let count = 0;
    let combatCount = 0;

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        rawCount = count = combatCount = 0;
      }
      if (++rawCount > MAX_RAW_PER_SEC) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'combat') {
        if (++combatCount > MAX_COMBAT_PER_SEC || raw.length > MAX_COMBAT_BYTES) return;
      } else if (++count > MAX_MESSAGES_PER_SEC) return;

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
        case 'updateLobby': {
          if (!isHost) return;
          const next = sanitizeSettings(msg.settings, lobby.settings);
          if (next.mode === 'dogfight' && lobby.members.size > DOGFIGHT_MAX_PLAYERS) {
            return send(player, { type: 'error', message: `A dogfight takes at most ${DOGFIGHT_MAX_PLAYERS} pilots: ${lobby.members.size} are in this lobby.` });
          }
          lobby.settings = next;
          if (lobby.settings.maxPlayers < lobby.members.size) lobby.settings.maxPlayers = lobby.members.size;
          for (const p of lobby.members.values()) p.ready = false; // settings changed: everyone re-confirms
          broadcastLobby(lobby);
          return;
        }
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
          const dogfight = lobby.settings.mode === 'dogfight';
          if (dogfight && lobby.members.size < DOGFIGHT_MIN_PLAYERS) return send(player, { type: 'error', message: `A dogfight needs at least ${DOGFIGHT_MIN_PLAYERS} pilots.` });
          lobby.state = 'playing';
          lobby.startedAt = Date.now();
          lobby.dogfight = dogfight ? { kills: Object.fromEntries([...lobby.members.keys()].map((id) => [id, 0])), winnerId: null } : null;
          for (const p of lobby.members.values()) {
            p.inGame = true;
            p.alive = true;
          }
          const view = lobbyView(lobby);
          for (const p of lobby.members.values()) send(p, { type: 'start', lobby: view });
          sendScore(lobby);
          broadcastLobby(lobby);
          log(`[lobby ${lobby.code}] started ${lobby.settings.mode}`);
          return;
        }
        case 'leftGame':
          if (player.inGame) forfeitDogfight(lobby, player);
          player.inGame = false;
          player.ready = false;
          checkGameOver(lobby);
          broadcastLobby(lobby);
          return;
        case 'combat': {
          if (!player.inGame || lobby.state !== 'playing' || lobby.settings.mode !== 'dogfight') return;
          const clean = sanitizeCombat(msg.msg);
          if (!clean) return;
          const data = JSON.stringify({ type: 'combat', id: player.id, msg: clean });
          for (const p of lobby.members.values()) {
            if (p.id !== player.id && p.inGame && p.ws.readyState === p.ws.OPEN) p.ws.send(data);
          }
          if (clean.t === 'destroyed') recordDeath(lobby, player, clean.by);
          else if (clean.t === 'respawned') player.alive = true;
          return;
        }
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

  wss.on('listening', () => {
    const address = wss.address();
    const hostname = address.address.includes(':') ? `[${address.address}]` : address.address;
    log(`Multiplayer server listening on ws://${hostname}:${address.port}`);
  });
  return wss;
}

/** Release the listener even when browsers still have active WebSocket connections. */
export function stopRelay(wss) {
  for (const client of wss.clients) client.terminate();
  return new Promise((resolve, reject) => {
    wss.close((error) => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
      else resolve();
    });
  });
}

// Run directly: `node server/relay.mjs`
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase()) {
  startRelay();
}
