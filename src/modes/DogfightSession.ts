import { Vector3, type Camera, type Object3D } from 'three';
import { WEAPON_RULES } from '../combat/types';
import {
  CombatEffects,
  NO_WEAPON_INPUT,
  WeaponSystem,
  combatantFromJet,
  playCombatEvents,
  type CombatEvent,
  type CombatMessage,
  type Combatant,
  type DeathCause,
  type DogfightScore,
  type JetLike,
  type SurfaceHeight,
  type WeaponInput,
  type WeaponSystemOptions,
} from '../combat';
import type { AudioEngine } from '../audio/AudioEngine';
import type { RadarZone } from '../ui/radar/types';
import type { DogfightHudState, DogfightHudView, DogfightReticle, DogfightStanding } from '../ui/dogfight/types';
import { DogfightCore, type DogfightPhase, type DogfightResult } from './dogfight/DogfightCore';
import { ZoneWall } from './dogfight/ZoneWall';
import { PickupField, PickupGatesView } from './dogfight/pickups';
import { chooseDogfightZone, dogfightSpawn, type DogfightSpawn, type DogfightZone, type ZoneWorld } from './dogfight/zone';

export { chooseDogfightZone, dogfightSpawn, dogfightSlot, dogfightZoneRadius, checkZone, type DogfightSpawn, type DogfightZone, type ZoneWorld } from './dogfight/zone';
export type { DogfightPhase, DogfightResult } from './dogfight/DogfightCore';

type Unsubscribe = () => unknown;

/** The NetClient parts the dogfight uses (structural, so tests pass a fake). */
export interface DogfightNet {
  readonly combat: { on(cb: (fromId: string, msg: CombatMessage) => void): Unsubscribe };
  readonly dogfightScore: { on(cb: (score: DogfightScore) => void): Unsubscribe };
  readonly left: { on(cb: (id: string) => void): Unsubscribe };
  /** Lobby updates: an opponent no longer in the game (went back to the lobby) has left the match. */
  readonly lobbyChanged?: { on(cb: (lobby: { players: ReadonlyArray<{ id: string; inGame: boolean }> } | null) => void): Unsubscribe };
  readonly lastDogfightScore: DogfightScore | null;
  sendCombat(msg: CombatMessage): void;
}

/** The local jet as the dogfight sees it (Jet satisfies it). */
export type DogfightJet = JetLike & {
  readonly damage: { readonly destroyed: boolean; apply(amount: number): boolean; heal?(amount: number): void };
};

export type DogfightAudio = Parameters<typeof playCombatEvents>[0] & Pick<AudioEngine, 'updateCombatTones'>;

/** Game callbacks: the session decides WHEN, the game does the jet/scene work. */
export interface DogfightHooks {
  /** Place the local jet (start and every respawn): e.g. `spawnAt(s.position, s.heading, s.speed, false)`. */
  respawn(spawn: DogfightSpawn): void;
  /**
   * The session destroyed the local jet (zone timer or weapon damage): play the crash/explosion and
   * hide the jet, but don't respawn (the session calls respawn() after respawnDelay).
   * Not called for onLocalCrash() (the game already handled that crash).
   */
  destroyed?(cause: DeathCause, by: string | null): void;
  /** An opponent announced its death (explosion at its last position, kill sound...). */
  opponentDestroyed?(id: string, by: string | null, cause: DeathCause): void;
  countdownBeep?(go: boolean): void;
  /** Match over: the HUD shows the results; its button calls the game's back-to-lobby. */
  finished?(result: DogfightResult): void;
}

export interface DogfightPilot {
  id: string;
  name: string;
}

export interface DogfightSessionOptions {
  net: DogfightNet;
  selfId: string;
  /** The other pilots of the match (1 in a duel, up to 3 in a free-for-all). */
  opponents: readonly DogfightPilot[];
  world: ZoneWorld;
  /** Seed for the zone choice: the world seed (0 for Classic). */
  seed: number;
  /** Lobby order (dogfightSlot(selfId, playerIds)). */
  slot: number;
  jet: DogfightJet;
  hooks: DogfightHooks;
  /** Scene to add the zone wall and the combat effects to (omit both in tests). */
  scene?: Object3D;
  hud?: DogfightHudView;
  audio?: DogfightAudio;
  /** Seconds of start countdown (default 3). */
  countdown?: number;
  /** Ground for the projectiles; default = world surface (terrain or water). */
  groundHeight?: SurfaceHeight;
  weaponOptions?: WeaponSystemOptions;
}

/** Per fixed step input from the game. */
export interface DogfightFixedContext {
  /** Trigger state (InputManager). Ignored unless fighting. */
  input: WeaponInput;
  /** The opponents as Combatants (interpolated remote players) that are in the game. */
  opponents: readonly Combatant[];
}

export interface DogfightFrameContext {
  camera?: Camera;
  viewportHeight?: number;
  /** Listener for the combat sounds (default: the local jet). */
  listener?: Vector3;
}

const FEED_SECONDS = 3;
/** Seconds the gun crosshair / lock box stay red after a hit. */
const GUN_HIT_FLASH = 0.25;
const MISSILE_HIT_FLASH = 0.8;
/** Distance (m) ahead of the nose where the gun crosshair and the lock box are projected. */
const GUN_AIM_DISTANCE = 600;
const BOX_DISTANCE = 1500;
const _f = new Vector3();
const _r = new Vector3();
const _u = new Vector3();
const _pt = new Vector3();

function projectNdc(p: Vector3, camera: Camera): [number, number] | null {
  _pt.copy(p).project(camera);
  if (_pt.z > 1 || _pt.z < -1) return null;
  return [_pt.x, _pt.y];
}

/** @param killer name of the pilot credited with the kill (null: nobody). */
function deathText(cause: DeathCause, killer: string | null): string {
  switch (cause) {
    case 'gun':
      return killer ? `Shot down by ${killer}` : 'Shot down';
    case 'missile':
      return killer ? `Missile kill by ${killer}` : 'Hit by a missile';
    case 'zone':
      return 'Left the combat zone';
    case 'crash':
      return 'Crashed';
  }
}

/**
 * One dogfight match for the local player (free-for-all, 2-4 pilots): owns the WeaponSystem, its
 * effects and network wiring, the combat zone (wall + timer, sized for the pilot count),
 * death/respawn, the relay's score and the end of the match.
 * Game calls start(), fixedUpdate() every fixed step (also while crashed), frameUpdate() every
 * frame, onLocalCrash() when its collision code crashes the jet, and dispose() when leaving.
 */
export class DogfightSession {
  readonly core: DogfightCore;
  readonly weapons: WeaponSystem;
  readonly zone: DogfightZone;
  readonly self: Combatant;
  /** Pilots at the start of the match (self included); sizes the zone and spreads the spawns. */
  readonly players: number;
  readonly effects: CombatEffects | null;
  readonly wall: ZoneWall | null;
  readonly pickups: PickupField;
  private readonly pickupView: PickupGatesView | null;
  private readonly opts: DogfightSessionOptions;
  private readonly names = new Map<string, string>();
  /** Opponents between their 'destroyed' and 'respawned'. */
  private readonly dead = new Set<string>();
  private readonly groundHeight: SurfaceHeight;
  private readonly unsubs: Unsubscribe[] = [];
  private readonly targets: Combatant[] = [];
  private feed: { text: string; ttl: number } | null = null;
  private gunHitTimer = 0;
  private missileHitTimer = 0;
  private reticle: DogfightReticle | null = null;
  private disposed = false;

  constructor(options: DogfightSessionOptions) {
    this.opts = options;
    const { world } = options;
    const opponents = options.opponents.filter((p) => p.id !== options.selfId);
    for (const p of opponents) this.names.set(p.id, p.name);
    this.players = opponents.length + 1;
    this.zone = chooseDogfightZone(world, options.seed, this.players);
    this.core = new DogfightCore({ selfId: options.selfId, opponentIds: opponents.map((p) => p.id), zone: this.zone, countdown: options.countdown });
    this.weapons = new WeaponSystem(options.selfId, options.weaponOptions);
    this.self = combatantFromJet(options.selfId, options.jet, () => this.core.fighting && !options.jet.damage.destroyed);
    this.groundHeight = options.groundHeight ?? ((x, z) => Math.max(world.heightAt(x, z), world.waterLevelAt(x, z)));
    this.pickups = new PickupField(this.zone, this.groundHeight, options.seed);
    if (options.scene) {
      this.effects = new CombatEffects();
      this.wall = new ZoneWall(this.zone);
      this.pickupView = new PickupGatesView();
      options.scene.add(this.effects.group, this.wall.mesh, this.pickupView.group);
    } else {
      this.effects = null;
      this.wall = null;
      this.pickupView = null;
    }

    const { net } = options;
    this.unsubs.push(
      net.combat.on((from, msg) => this.onRemote(from, msg)),
      net.dogfightScore.on((score) => {
        this.core.setScore(score);
        this.handleCoreEvents();
      }),
      net.left.on((id) => {
        this.core.playerLeft(id);
        this.handleCoreEvents();
      }),
    );
    if (net.lobbyChanged) {
      this.unsubs.push(
        net.lobbyChanged.on((lobby) => {
          if (!lobby) return;
          for (const id of [...this.core.opponentIds]) {
            if (!lobby.players.some((p) => p.id === id && p.inGame)) this.core.playerLeft(id);
          }
          this.handleCoreEvents();
        }),
      );
    }
    if (net.lastDogfightScore) this.core.setScore(net.lastDogfightScore);
  }

  get phase(): DogfightPhase {
    return this.core.phase;
  }

  get finished(): boolean {
    return this.core.phase === 'finished';
  }

  get result(): DogfightResult | null {
    return this.core.result;
  }

  /** The jet must not move during the start countdown (skip its physics, like RaceSession.frozen). */
  get frozen(): boolean {
    return this.core.frozen;
  }

  /** Opponents still in the match. */
  get opponentIds(): readonly string[] {
    return this.core.opponentIds;
  }

  isOpponent(id: string): boolean {
    return this.core.opponentIds.includes(id);
  }

  /** False between an opponent's 'destroyed' and 'respawned' (radar, puppet, weapons ignore it). */
  isOpponentAlive(id: string): boolean {
    return !this.dead.has(id);
  }

  /** Display name of a pilot ('YOU' for the local player). */
  nameOf(id: string | null): string {
    if (id === null) return 'NOBODY';
    if (id === this.opts.selfId) return 'YOU';
    return this.names.get(id) ?? 'OPPONENT';
  }

  radarZone(): RadarZone {
    return { cx: this.zone.cx, cz: this.zone.cz, radius: this.zone.radius };
  }

  /** Current spawn for this player's life (round). */
  spawnPoint(round = this.core.round): DogfightSpawn {
    return dogfightSpawn(this.zone, this.opts.world, this.opts.slot, round, this.players);
  }

  /** Puts the jet on its first spawn (call once after construction). */
  start(): void {
    this.opts.hooks.respawn(this.spawnPoint(0));
    this.weapons.refill();
  }

  /** Every fixed step, after the jet's physics and collisions (also while crashed / dead). */
  fixedUpdate(dt: number, ctx: DogfightFixedContext): void {
    if (this.disposed) return;
    this.core.step(dt, this.opts.jet.flight.state.position);
    this.handleCoreEvents();
    const input = this.core.fighting ? ctx.input : NO_WEAPON_INPUT;
    const targets = this.targets;
    targets.length = 0;
    for (const c of ctx.opponents) if (c.id !== this.opts.selfId && !this.dead.has(c.id)) targets.push(c);
    this.weapons.update(dt, this.self, targets, input, this.groundHeight);
    for (const g of this.pickups.update(dt, this.self.position, this.core.fighting && this.self.alive)) {
      if (g.kind === 'health') this.opts.jet.damage.heal?.(g.amount);
      else if (g.kind === 'missile') this.weapons.addMissiles(g.amount);
      else this.weapons.addFlares(g.amount);
      this.showFeed(g.label);
    }
    this.flush();
  }

  /** Every render frame: damage, effects, sounds, wall and HUD. */
  frameUpdate(dt: number, ctx: DogfightFrameContext = {}): void {
    if (this.disposed) return;
    const events = this.weapons.drainEvents();
    this.handleCombatEvents(events);
    if (this.effects) {
      this.effects.handleEvents(events);
      this.effects.update(dt, this.weapons, ctx.camera, ctx.viewportHeight);
    }
    const jetPos = this.opts.jet.flight.state.position;
    const audio = this.opts.audio;
    if (audio) {
      playCombatEvents(audio, events, ctx.listener ?? jetPos);
      audio.updateCombatTones(this.core.fighting ? this.weapons.status() : null, dt);
    }
    this.wall?.update(dt, jetPos);
    this.pickupView?.sync(dt, this.pickups.gates);
    if (this.feed && (this.feed.ttl -= dt) <= 0) this.feed = null;
    this.gunHitTimer = Math.max(0, this.gunHitTimer - dt);
    this.missileHitTimer = Math.max(0, this.missileHitTimer - dt);
    this.reticle = ctx.camera && this.core.fighting && this.self.alive ? this.computeReticle(ctx.camera) : null;
    this.opts.hud?.update(this.hudState());
    this.flush();
  }

  private computeReticle(camera: Camera): DogfightReticle {
    const pos = this.self.position;
    const q = this.self.orientation;
    camera.updateMatrixWorld();
    const f = _f.set(0, 0, -1).applyQuaternion(q);
    const r = _r.set(1, 0, 0).applyQuaternion(q);
    const u = _u.set(0, 1, 0).applyQuaternion(q);
    const gun = projectNdc(new Vector3().copy(pos).addScaledVector(f, GUN_AIM_DISTANCE), camera);
    const half = Math.tan(WEAPON_RULES.missile.lockBoxHalfAngle) * BOX_DISTANCE;
    const box: [number, number][] = [];
    for (const [sx, sy] of [[-1, 1], [1, 1], [1, -1], [-1, -1]] as const) {
      const c = new Vector3().copy(pos).addScaledVector(f, BOX_DISTANCE).addScaledVector(r, sx * half).addScaledVector(u, sy * half);
      const p = projectNdc(c, camera);
      if (!p) break;
      box.push(p);
    }
    const s = this.weapons.status();
    const boxState =
      this.missileHitTimer > 0 ? 'hit' : s.missiles > 0 && s.lock >= 1 ? 'locked' : s.missiles > 0 && s.lockTargetId !== null ? 'locking' : 'idle';
    return { gun, gunHit: this.gunHitTimer > 0, box: box.length === 4 ? box : null, boxState };
  }

  /** Game's collision code crashed the jet (terrain, obstacle, hard landing). */
  onLocalCrash(): void {
    if (this.core.destroyed(null, 'crash')) this.flush();
    this.handleCoreEvents(true);
  }

  /** Applies combat events to the local jet (weapon damage); exposed for tests. */
  handleCombatEvents(events: readonly CombatEvent[]): void {
    for (const e of events) {
      if (e.type === 'damaged') {
        this.core.noteDamage(e.by);
        if (this.core.fighting && this.opts.jet.damage.apply(e.damage)) this.destroyLocal(e.by, e.cause);
      } else if (e.type === 'hit') {
        if (e.cause === 'missile') this.missileHitTimer = MISSILE_HIT_FLASH;
        else this.gunHitTimer = GUN_HIT_FLASH;
        this.showFeed(e.cause === 'missile' ? 'Missile hit!' : 'Hit!');
      }
    }
  }

  /** Every pilot of the match (self first on ties), best score first. */
  standings(): DogfightStanding[] {
    const c = this.core;
    const ids = [this.opts.selfId, ...this.names.keys()];
    return ids
      .map((id) => ({ id, name: this.nameOf(id), kills: c.score.kills[id] ?? 0, self: id === this.opts.selfId, left: id !== this.opts.selfId && !c.opponentIds.includes(id) }))
      .sort((a, b) => b.kills - a.kills || Number(b.self) - Number(a.self));
  }

  hudState(): DogfightHudState {
    const c = this.core;
    const death = c.lastDeath;
    const duelOpponent = this.names.size === 1 ? [...this.names.values()][0]! : null;
    return {
      phase: c.phase,
      countdown: c.countdown,
      weapons: c.fighting ? this.weapons.status() : null,
      myKills: c.myKills,
      opponentKills: c.opponentKills,
      killsToWin: c.rules.killsToWin,
      opponentName: duelOpponent ?? `${this.names.size} OPPONENTS`,
      standings: this.standings(),
      winnerName: c.score.winnerId ? this.nameOf(c.score.winnerId) : null,
      zoneTimer: c.zoneTimer === null ? null : Math.max(0, c.zoneTimer),
      zoneReason: c.zoneReason,
      respawnIn: c.phase === 'dead' ? c.respawnTimer : null,
      deathText: c.phase === 'dead' && death ? deathText(death.cause, death.by !== null && this.names.has(death.by) ? this.nameOf(death.by) : null) : null,
      feed: this.feed?.text ?? null,
      reticle: this.reticle,
      result: c.result,
    };
  }

  /** Leaving the mode: drops projectiles, effects, wall, HUD and listeners. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.weapons.clear();
    if (this.effects) {
      this.effects.group.removeFromParent();
      this.effects.dispose();
    }
    this.wall?.dispose();
    this.pickupView?.dispose();
    this.opts.hud?.dispose();
    this.opts.audio?.updateCombatTones(null, 0);
  }

  private destroyLocal(by: string | null, cause: DeathCause): void {
    if (!this.core.destroyed(by, cause)) return;
    this.flush();
    this.handleCoreEvents();
  }

  private onRemote(from: string, msg: CombatMessage): void {
    if (this.disposed) return;
    this.weapons.applyRemote(from, msg);
    if (msg.t === 'destroyed') {
      this.dead.add(from);
      const victim = this.nameOf(from);
      let text: string;
      if (msg.by === this.opts.selfId) text = `${victim} shot down!`;
      else if (msg.by !== null && this.names.has(msg.by)) text = `${this.nameOf(msg.by)} shot down ${victim}`;
      else text = msg.cause === 'zone' ? `${victim} left the zone` : `${victim} crashed`;
      this.showFeed(text);
      this.opts.hooks.opponentDestroyed?.(from, msg.by, msg.cause);
    } else if (msg.t === 'respawned') {
      this.dead.delete(from);
    }
  }

  /** @param crashHandled the game already crashed the jet itself (onLocalCrash). */
  private handleCoreEvents(crashHandled = false): void {
    const hooks = this.opts.hooks;
    for (const e of this.core.drainEvents()) {
      switch (e.type) {
        case 'countdownBeep':
          hooks.countdownBeep?.(e.go);
          break;
        case 'destroyed':
          if (!crashHandled) hooks.destroyed?.(e.cause, e.by);
          break;
        case 'respawn':
          hooks.respawn(this.spawnPoint(e.round));
          this.weapons.refill();
          break;
        case 'finished':
          this.feed = null;
          hooks.finished?.(e.result);
          break;
      }
    }
    // 'respawned' must follow the refill (the relay only counts later deaths after it).
    this.flush();
  }

  private showFeed(text: string): void {
    this.feed = { text, ttl: FEED_SECONDS };
  }

  private flush(): void {
    const net = this.opts.net;
    for (const m of this.weapons.drainOutbox()) net.sendCombat(m);
    for (const m of this.core.drainOutbox()) net.sendCombat(m);
  }
}

