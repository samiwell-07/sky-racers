import { Quaternion, Vector3 } from 'three';
import type { CombatMessage, DogfightScore } from '../combat/types';
import type { Lobby, LobbySettings, LobbySummary } from './lobbyTypes';
import { SnapshotBuffer, type Snapshot } from './SnapshotBuffer';

export interface RemotePlayerInfo {
  id: string;
  name: string;
  jetId: string;
}

export interface LocalNetState {
  position: Vector3;
  quaternion: Quaternion;
  velocity: Vector3;
  throttle: number;
  afterburner: boolean;
  gate: number;
  lap: number;
}

export interface RemoteSnapshot {
  position: Vector3;
  quaternion: Quaternion;
  /** Interpolated world velocity (m/s). */
  velocity: Vector3;
  throttle: number;
  afterburner: boolean;
}

/** Latest race progress reported by a remote player. */
export interface RemoteProgress {
  gate: number;
  lap: number;
  finishTime: number | null;
}

export type NetEventName = 'finish' | 'crash' | 'gate';

const SEND_INTERVAL_MS = 50; // 20 Hz

const round = (n: number, digits = 1000): number => Math.round(n * digits) / digits;

type Listener<T extends unknown[]> = (...args: T) => void;

class Signal<T extends unknown[]> {
  private readonly listeners = new Set<Listener<T>>();
  on(cb: Listener<T>): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit(...args: T): void {
    for (const cb of [...this.listeners]) cb(...args);
  }
}

/** Client for the lobby server: lobbies, ready/start, and in-game state relay. */
export class NetClient {
  private ws: WebSocket | null = null;
  private selfId: string | null = null;
  private currentLobby: Lobby | null = null;
  private readonly playerMap = new Map<string, RemotePlayerInfo>();
  private readonly buffers = new Map<string, SnapshotBuffer>();
  private readonly progress = new Map<string, RemoteProgress>();
  private lastSendTime = -Infinity;
  private readonly scratch: Snapshot = { time: 0, position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], throttle: 0, afterburner: false };

  readonly joined = new Signal<[RemotePlayerInfo]>();
  readonly left = new Signal<[string]>();
  readonly events = new Signal<[string, string, unknown]>();
  /** Lobby changed (null = not in a lobby). */
  readonly lobbyChanged = new Signal<[Lobby | null]>();
  readonly lobbyList = new Signal<[LobbySummary[]]>();
  /** The host started the game (late = joined a session already in progress). */
  readonly started = new Signal<[Lobby, boolean]>();
  readonly errors = new Signal<[string]>();
  readonly chat = new Signal<[string, string]>();
  readonly disconnected = new Signal<[]>();
  /** Combat message relayed from another player of the lobby (dogfight). */
  readonly combat = new Signal<[fromId: string, msg: CombatMessage]>();
  /** Server dogfight score: after the start (all zero), after each kill, and when the game ends (winnerId). */
  readonly dogfightScore = new Signal<[DogfightScore]>();
  private latestScore: DogfightScore | null = null;

  /** Last dogfight score received since the current game started (null before the first one). */
  get lastDogfightScore(): DogfightScore | null {
    return this.latestScore;
  }
  get id(): string | null {
    return this.selfId;
  }

  get connected(): boolean {
    return this.ws !== null && this.selfId !== null && this.ws.readyState === WebSocket.OPEN;
  }

  get lobby(): Lobby | null {
    return this.currentLobby;
  }

  get isHost(): boolean {
    return !!this.currentLobby && this.currentLobby.hostId === this.selfId;
  }

  get players(): ReadonlyMap<string, RemotePlayerInfo> {
    return this.playerMap;
  }

  // Compatibility helpers used by RemotePlayers.
  onJoin(cb: (p: RemotePlayerInfo) => void): () => void {
    return this.joined.on(cb);
  }
  onLeave(cb: (id: string) => void): () => void {
    return this.left.on(cb);
  }
  onEvent(cb: (id: string, event: string, data: unknown) => void): () => void {
    return this.events.on(cb);
  }

  connect(url: string, name: string, jetId: string, timeoutMs = 5000): Promise<void> {
    this.disconnect();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (message: string): void => {
        if (settled) return;
        settled = true;
        this.disconnect();
        reject(new Error(message));
      };
      const timer = setTimeout(() => fail('timeout'), timeoutMs);
      let ws: WebSocket;
      try {
        ws = new globalThis.WebSocket(url);
      } catch {
        clearTimeout(timer);
        fail(`Invalid server address: ${url}`);
        return;
      }
      this.ws = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', name, jetId }));
      ws.onerror = () => fail(`Could not reach ${url}`);
      ws.onclose = () => {
        clearTimeout(timer);
        const wasConnected = this.ws === ws && this.selfId !== null;
        if (this.ws === ws) this.reset();
        if (wasConnected) this.disconnected.emit();
        fail('Connection closed');
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(ev.data) as Record<string, unknown>;
        } catch {
          return;
        }
        if (msg.type === 'welcome') {
          this.selfId = String(msg.id);
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }
        this.handleMessage(msg);
      };
    });
  }

  disconnect(): void {
    const ws = this.ws;
    this.reset();
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
  }

  /** Update name / jet shown to others. */
  setProfile(name: string, jetId: string): void {
    this.send({ type: 'hello', name, jetId });
  }

  listLobbies(): void {
    this.send({ type: 'listLobbies' });
  }
  createLobby(settings: LobbySettings): void {
    this.send({ type: 'createLobby', settings });
  }
  joinLobby(lobbyId: string): void {
    this.send({ type: 'joinLobby', lobbyId });
  }
  joinByCode(code: string): void {
    this.send({ type: 'joinLobby', code });
  }
  leaveLobby(): void {
    this.send({ type: 'leaveLobby' });
  }
  updateLobby(settings: LobbySettings): void {
    this.send({ type: 'updateLobby', settings });
  }
  setReady(ready: boolean): void {
    this.send({ type: 'setReady', ready });
  }
  startGame(): void {
    this.send({ type: 'startGame' });
  }
  /** Tell the lobby we are back on the lobby screen. */
  leftGame(): void {
    this.send({ type: 'leftGame' });
  }
  kick(id: string): void {
    this.send({ type: 'kick', id });
  }
  sendChat(text: string): void {
    this.send({ type: 'chat', text });
  }

  sendState(state: LocalNetState, now: number): void {
    if (!this.connected || !this.currentLobby || now - this.lastSendTime < SEND_INTERVAL_MS) return;
    this.lastSendTime = now;
    const { position: p, quaternion: q, velocity: v } = state;
    this.send({
      type: 'state',
      p: [round(p.x), round(p.y), round(p.z)],
      q: [round(q.x, 1e5), round(q.y, 1e5), round(q.z, 1e5), round(q.w, 1e5)],
      v: [round(v.x), round(v.y), round(v.z)],
      thr: round(state.throttle),
      ab: state.afterburner,
      gate: state.gate,
      lap: state.lap,
    });
  }

  sendEvent(event: NetEventName, data?: unknown): void {
    if (this.connected && this.currentLobby) this.send({ type: 'event', event, data: data ?? null });
  }

  /** Sends a combat message to the other players right away (not throttled like state). */
  sendCombat(msg: CombatMessage): void {
    if (this.connected && this.currentLobby) this.send({ type: 'combat', msg });
  }

  /**
   * Interpolated state of a remote player. `out` is reused when given; a missing `velocity` vector is
   * created on it once (older callers pass objects without one).
   */
  getRemoteSnapshot(id: string, now: number, out?: Omit<RemoteSnapshot, 'velocity'> & { velocity?: Vector3 }): RemoteSnapshot | null {
    const buf = this.buffers.get(id);
    if (!buf) return null;
    const s = buf.sample(now, this.scratch);
    if (!s) return null;
    const target = out ?? { position: new Vector3(), quaternion: new Quaternion(), throttle: 0, afterburner: false };
    target.velocity ??= new Vector3();
    const result = target as RemoteSnapshot;
    result.position.fromArray(s.position);
    result.quaternion.fromArray(s.quaternion);
    result.velocity.fromArray(s.velocity);
    result.throttle = s.throttle;
    result.afterburner = s.afterburner;
    return result;
  }

  getProgress(id: string): RemoteProgress | undefined {
    return this.progress.get(id);
  }

  /** Forget race progress (new race). */
  resetProgress(): void {
    this.progress.clear();
    for (const b of this.buffers.values()) b.clear();
  }

  private send(msg: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private reset(): void {
    this.ws = null;
    this.selfId = null;
    this.setLobby(null);
    this.lastSendTime = -Infinity;
    this.latestScore = null;
  }

  /** Applies a lobby update, firing join/leave for players that appeared or went away. */
  private setLobby(lobby: Lobby | null): void {
    this.currentLobby = lobby;
    const next = new Map<string, RemotePlayerInfo>();
    for (const p of lobby?.players ?? []) if (p.id !== this.selfId) next.set(p.id, { id: p.id, name: p.name, jetId: p.jetId });
    for (const id of [...this.playerMap.keys()]) {
      if (!next.has(id)) {
        this.playerMap.delete(id);
        this.buffers.delete(id);
        this.progress.delete(id);
        this.left.emit(id);
      }
    }
    for (const [id, info] of next) {
      const old = this.playerMap.get(id);
      if (old && old.jetId === info.jetId && old.name === info.name) continue;
      if (old) this.left.emit(id); // jet or name changed: recreate
      this.playerMap.set(id, info);
      if (!this.buffers.has(id)) this.buffers.set(id, new SnapshotBuffer());
      this.joined.emit(info);
    }
    this.lobbyChanged.emit(lobby);
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const id = msg.id === undefined ? '' : String(msg.id);
    switch (msg.type) {
      case 'lobby':
        this.setLobby((msg.lobby as Lobby | null) ?? null);
        break;
      case 'lobbies':
        this.lobbyList.emit(Array.isArray(msg.list) ? (msg.list as LobbySummary[]) : []);
        break;
      case 'start':
        this.currentLobby = msg.lobby as Lobby;
        this.latestScore = null;
        this.resetProgress();
        this.started.emit(this.currentLobby, msg.late === true);
        break;
      case 'error':
        this.errors.emit(String(msg.message ?? 'Error'));
        break;
      case 'chat':
        this.chat.emit(String(msg.name), String(msg.text));
        break;
      case 'state': {
        const buf = this.buffers.get(id);
        const p = msg.p as number[] | undefined;
        const q = msg.q as number[] | undefined;
        if (!buf || !Array.isArray(p) || !Array.isArray(q) || p.length !== 3 || q.length !== 4) break;
        const v = Array.isArray(msg.v) && msg.v.length === 3 ? (msg.v as number[]) : [0, 0, 0];
        buf.push({
          time: performance.now(),
          position: [p[0]!, p[1]!, p[2]!],
          quaternion: [q[0]!, q[1]!, q[2]!, q[3]!],
          velocity: [v[0]!, v[1]!, v[2]!],
          throttle: typeof msg.thr === 'number' ? msg.thr : 0,
          afterburner: msg.ab === true,
        });
        const prog = this.progress.get(id) ?? { gate: 0, lap: 1, finishTime: null };
        if (typeof msg.gate === 'number') prog.gate = msg.gate;
        if (typeof msg.lap === 'number') prog.lap = msg.lap;
        this.progress.set(id, prog);
        break;
      }
      case 'event':
        if (msg.event === 'finish' && typeof msg.data === 'number') {
          const prog = this.progress.get(id) ?? { gate: 0, lap: 1, finishTime: null };
          prog.finishTime = msg.data;
          this.progress.set(id, prog);
        }
        this.events.emit(id, String(msg.event), msg.data);
        break;
      case 'combat': {
        const m = msg.msg as CombatMessage | undefined;
        if (id && m && typeof m === 'object' && typeof m.t === 'string') this.combat.emit(id, m);
        break;
      }
      case 'dogfightScore': {
        const kills = msg.kills && typeof msg.kills === 'object' ? (msg.kills as Record<string, number>) : {};
        this.latestScore = { kills: { ...kills }, winnerId: typeof msg.winnerId === 'string' ? msg.winnerId : null };
        this.dogfightScore.emit(this.latestScore);
        break;
      }
    }
  }
}
