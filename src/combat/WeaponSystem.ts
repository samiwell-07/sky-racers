import { Vector3 } from 'three';
import { mulberry32 } from '../utils/random';
import { WEAPON_RULES, type CombatMessage, type Combatant, type WeaponStatus } from './types';
import { GunHeat, createRound, stepRound, type Round } from './gun';
import { Missile, TRACK_GIMBAL_FACTOR, type TrackTarget } from './missile';
import { SeekerLock } from './seeker';
import { Flare, rollFlareDecoys, spawnFlareSalvo } from './flares';
import { closestApproach, forwardOf, fromV3, jitterDirection, localToWorld, offBoresight, segmentSphereHit, toV3 } from './math';

export type SurfaceHeight = (x: number, z: number) => number;

/** Trigger state for one fixed step (read from InputManager: isDown / consumePressed). */
export interface WeaponInput {
  /** isDown('fireGun') */
  fireGun: boolean;
  /** consumePressed('fireMissile') */
  fireMissile: boolean;
  /** isDown('fireMissile'): holding after the press waits for the lock before launching. */
  fireMissileHeld: boolean;
  /** consumePressed('releaseFlares') */
  releaseFlares: boolean;
}

export const NO_WEAPON_INPUT: Readonly<WeaponInput> = Object.freeze({
  fireGun: false,
  fireMissile: false,
  fireMissileHeld: false,
  releaseFlares: false,
});

/** Local happenings for sound, effects and the game mode (drain once per frame with drainEvents()). */
export type CombatEvent =
  | { type: 'gunFired'; local: boolean; rounds: number; position: Vector3 }
  | { type: 'gunImpact'; position: Vector3 }
  | { type: 'missileLaunched'; local: boolean; id: string; position: Vector3 }
  | { type: 'flaresReleased'; local: boolean; count: number; position: Vector3 }
  /** Our weapon hit `target` (we already sent the hit message). */
  | { type: 'hit'; target: string; cause: 'gun' | 'missile'; damage: number; position: Vector3 }
  /** We were hit: the game applies `jet.damage.apply(damage)` and announces its own death. */
  | { type: 'damaged'; by: string; cause: 'gun' | 'missile'; damage: number }
  | { type: 'explosion'; position: Vector3; hit: boolean }
  /** A missile (ours) was seduced by a flare. */
  | { type: 'decoyed'; missileId: string };

/** The remote player's missile, driven by its 10 Hz updates and extrapolated in between. */
export interface RemoteMissile {
  readonly id: string;
  readonly ownerId: string;
  readonly targetId: string | null;
  readonly position: Vector3;
  readonly velocity: Vector3;
  /** Remaining position error from the last update, blended out over a few frames. */
  readonly correction: Vector3;
  age: number;
}

export interface WeaponSystemOptions {
  /** Seed for gun spread and flare-decoy rolls (deterministic tests); default random. */
  seed?: number;
  rng?: () => number;
  /** Gun muzzle in the jet's body frame (forward = -Z). */
  muzzleOffset?: Vector3;
  /** Missile launch rail in the body frame. */
  launchOffset?: Vector3;
  /** Seconds between two missileUpdate messages per missile (default 0.1 = 10 Hz). */
  missileUpdateInterval?: number;
}

const DEFAULT_MUZZLE = new Vector3(1.5, 0, -6);
const DEFAULT_RAIL = new Vector3(0, -1.2, -2);
/** Missile ejection speed added along the nose at launch (m/s). */
const LAUNCH_EJECT_SPEED = 25;
/** Remote missiles not heard from for this long are dropped (lost missileEnd). */
const REMOTE_MISSILE_TIMEOUT = 2;
const CORRECTION_RATE = 12;

const _fwd = new Vector3();
const _dir = new Vector3();
const _v = new Vector3();
const _p = new Vector3();
const _c0 = new Vector3();
const _rel = new Vector3();

/**
 * One jet's weapons: gun (heat), 4 IR missiles with seeker lock, 30 flares, plus the projectiles in
 * flight (own and the remote player's) and the outbox of CombatMessages to relay.
 * Call update() once per fixed step AFTER the jets moved; apply incoming network messages with
 * applyRemote(). Hits are decided by the shooter: the victim gets a 'damaged' event.
 */
export class WeaponSystem {
  readonly gun: GunHeat;
  readonly seeker: SeekerLock;
  readonly rounds: Round[] = [];
  readonly missiles: Missile[] = [];
  readonly remoteMissiles: RemoteMissile[] = [];
  /** Every live flare (ours and the remote player's). */
  readonly flares: Flare[] = [];
  missilesLeft: number = WEAPON_RULES.missile.count;
  flaresLeft: number = WEAPON_RULES.flare.count;
  /** Seconds since the gun last fired (muzzle flash), and where. */
  muzzleFlashAge = Infinity;
  readonly muzzlePosition = new Vector3();

  private readonly rng: () => number;
  private readonly muzzleOffset: Vector3;
  private readonly launchOffset: Vector3;
  private readonly updateInterval: number;
  private missileReload = 0;
  private flareCooldown = 0;
  private pendingLaunch = false;
  private missileCounter = 0;
  private updateTimer = 0;
  private incoming = false;
  private readonly prevPositions = new Map<string, Vector3>();
  private readonly lastOthers = new Map<string, Combatant>();
  private readonly lastUpdate = new Map<string, number>();
  private outbox: CombatMessage[] = [];
  private events: CombatEvent[] = [];

  constructor(
    readonly selfId: string,
    options: WeaponSystemOptions = {},
  ) {
    this.rng = options.rng ?? mulberry32(options.seed ?? Math.floor(Math.random() * 2 ** 31));
    this.muzzleOffset = (options.muzzleOffset ?? DEFAULT_MUZZLE).clone();
    this.launchOffset = (options.launchOffset ?? DEFAULT_RAIL).clone();
    this.updateInterval = options.missileUpdateInterval ?? 0.1;
    this.gun = new GunHeat();
    this.seeker = new SeekerLock();
  }

  /** Full ammo, cool gun, no lock (respawn). Projectiles already in flight keep flying. */
  refill(): void {
    this.gun.reset();
    this.seeker.reset();
    this.missilesLeft = WEAPON_RULES.missile.count;
    this.flaresLeft = WEAPON_RULES.flare.count;
    this.missileReload = 0;
    this.flareCooldown = 0;
    this.pendingLaunch = false;
  }

  /** Removes every projectile and pending message/event (leaving the mode). */
  clear(): void {
    this.rounds.length = 0;
    this.missiles.length = 0;
    this.remoteMissiles.length = 0;
    this.flares.length = 0;
    this.outbox = [];
    this.events = [];
    this.prevPositions.clear();
    this.lastOthers.clear();
    this.incoming = false;
  }

  status(): WeaponStatus {
    return {
      gunHeat: this.gun.heat,
      gunOverheated: this.gun.overheated,
      missiles: this.missilesLeft,
      flares: this.flaresLeft,
      lock: this.seeker.progress,
      lockTargetId: this.seeker.targetId,
      incomingMissile: this.incoming,
    };
  }

  /** Messages to send to the other player since the last call. */
  drainOutbox(): CombatMessage[] {
    const out = this.outbox;
    this.outbox = [];
    return out;
  }

  drainEvents(): CombatEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  /**
   * One fixed step. `self` = the local jet (ignored by our own rounds), `others` = enemies
   * (interpolated remote players). Fires, moves every projectile, resolves our hits.
   */
  update(dt: number, self: Combatant, others: readonly Combatant[], input: WeaponInput, surfaceHeight: SurfaceHeight): void {
    const enemies = others.filter((c) => c.id !== self.id);
    for (const c of enemies) this.lastOthers.set(c.id, c);

    this.fireGun(dt, self, input.fireGun && self.alive);
    this.seeker.update(dt, self, enemies, this.missilesLeft > 0);
    this.updateLaunch(dt, self, input);
    this.updateFlareRelease(dt, self, input.releaseFlares);

    this.stepRounds(dt, enemies, surfaceHeight);
    for (const f of this.flares) f.step(dt, surfaceHeight);
    this.stepMissiles(dt, enemies, surfaceHeight);
    this.stepRemoteMissiles(dt, self);
    removeDead(this.flares, (f) => f.alive);

    for (const c of enemies) {
      const prev = this.prevPositions.get(c.id);
      if (prev) prev.copy(c.position);
      else this.prevPositions.set(c.id, c.position.clone());
    }
  }

  /** Applies a message received from the other player (`fromId`). */
  applyRemote(fromId: string, msg: CombatMessage): void {
    switch (msg.t) {
      case 'gunFire': {
        const p = fromV3(msg.p);
        this.rounds.push(createRound(p, fromV3(msg.v), true));
        this.events.push({ type: 'gunFired', local: false, rounds: 1, position: p });
        break;
      }
      case 'gunHit':
        if (msg.target === this.selfId) this.events.push({ type: 'damaged', by: fromId, cause: 'gun', damage: msg.damage });
        break;
      case 'missileLaunch': {
        const m: RemoteMissile = {
          id: msg.id,
          ownerId: fromId,
          targetId: msg.target,
          position: fromV3(msg.p),
          velocity: fromV3(msg.v),
          correction: new Vector3(),
          age: 0,
        };
        this.remoteMissiles.push(m);
        this.lastUpdate.set(m.id, 0);
        this.events.push({ type: 'missileLaunched', local: false, id: m.id, position: m.position.clone() });
        break;
      }
      case 'missileUpdate': {
        const m = this.remoteMissiles.find((r) => r.id === msg.id);
        if (!m) break;
        m.correction.copy(fromV3(msg.p, _p)).sub(m.position);
        fromV3(msg.v, m.velocity);
        this.lastUpdate.set(m.id, m.age);
        break;
      }
      case 'missileEnd': {
        const i = this.remoteMissiles.findIndex((r) => r.id === msg.id);
        if (i >= 0) this.remoteMissiles.splice(i, 1);
        this.lastUpdate.delete(msg.id);
        this.events.push({ type: 'explosion', position: fromV3(msg.p), hit: msg.hit !== null });
        if (msg.hit === this.selfId) this.events.push({ type: 'damaged', by: fromId, cause: 'missile', damage: msg.damage });
        break;
      }
      case 'flares': {
        const p = fromV3(msg.p);
        const salvo = spawnFlareSalvo(fromId, p, fromV3(msg.v), msg.n);
        this.flares.push(...salvo);
        this.events.push({ type: 'flaresReleased', local: false, count: msg.n, position: p });
        const hot = this.lastOthers.get(fromId)?.afterburner ?? false;
        for (const m of rollFlareDecoys(this.missiles, fromId, hot, salvo, this.rng)) {
          this.events.push({ type: 'decoyed', missileId: m.id });
        }
        break;
      }
      default:
        break;
    }
  }

  // ------------------------------------------------------------ gun

  private fireGun(dt: number, self: Combatant, trigger: boolean): void {
    const ages = this.gun.update(dt, trigger);
    this.muzzleFlashAge += dt;
    if (ages.length === 0) return;
    const r = WEAPON_RULES.gun;
    const fwd = forwardOf(self.orientation, _fwd);
    localToWorld(self.position, self.orientation, this.muzzleOffset, this.muzzlePosition);
    for (const age of ages) {
      const dir = jitterDirection(fwd, r.spread, this.rng, _dir);
      const v = _v.copy(self.velocity).addScaledVector(dir, r.muzzleSpeed);
      // Fired ge s before the end of the step: start it one step back along its path so the
      // regular round step brings it to where it is now (muzzle + (v - jet velocity) * age).
      _p.copy(this.muzzlePosition).addScaledVector(v, age - dt).addScaledVector(self.velocity, -age);
      this.rounds.push(createRound(_p, v, false));
      this.outbox.push({ t: 'gunFire', p: toV3(this.muzzlePosition), v: toV3(v) });
    }
    this.muzzleFlashAge = 0;
    this.events.push({ type: 'gunFired', local: true, rounds: ages.length, position: this.muzzlePosition.clone() });
  }

  private stepRounds(dt: number, enemies: readonly Combatant[], surfaceHeight: SurfaceHeight): void {
    for (const round of this.rounds) {
      if (round.alive) this.advanceRound(round, dt, enemies, surfaceHeight);
    }
    removeDead(this.rounds, (r) => r.alive);
  }

  private advanceRound(round: Round, dt: number, enemies: readonly Combatant[], surfaceHeight: SurfaceHeight): void {
    const result = stepRound(round, dt, surfaceHeight);
    if (!round.remote) {
      for (const c of enemies) {
        if (!c.alive) continue;
        const c0 = this.prevPositionOf(c, dt);
        if (segmentSphereHit(round.previous, round.position, c0, c.position, WEAPON_RULES.gun.hitRadius) === null) continue;
        round.alive = false;
        const damage = WEAPON_RULES.gun.damagePerHit;
        this.outbox.push({ t: 'gunHit', target: c.id, damage });
        this.events.push({ type: 'hit', target: c.id, cause: 'gun', damage, position: c.position.clone() });
        return;
      }
    }
    if (result === 'terrain') this.events.push({ type: 'gunImpact', position: round.position.clone() });
  }

  /** Where the target was at the start of this step (its velocity extrapolated back when unknown). */
  private prevPositionOf(c: Combatant, dt: number): Vector3 {
    return this.prevPositions.get(c.id) ?? _c0.copy(c.position).addScaledVector(c.velocity, -dt);
  }

  // ------------------------------------------------------------ missiles

  private updateLaunch(dt: number, self: Combatant, input: WeaponInput): void {
    this.missileReload = Math.max(0, this.missileReload - dt);
    if (!self.alive || this.missilesLeft <= 0) {
      this.pendingLaunch = false;
      return;
    }
    if (input.fireMissile && this.missileReload <= 0 && !this.pendingLaunch) {
      if (this.seeker.locked) this.launch(self, this.seeker.targetId);
      else if (this.seeker.targetId !== null) this.pendingLaunch = true;
      else this.launch(self, null);
      return;
    }
    if (!this.pendingLaunch) return;
    if (this.seeker.locked) this.launch(self, this.seeker.targetId);
    else if (!input.fireMissileHeld) this.launch(self, null);
  }

  private launch(self: Combatant, targetId: string | null): void {
    this.pendingLaunch = false;
    this.missilesLeft--;
    this.missileReload = WEAPON_RULES.missile.reload;
    const p = localToWorld(self.position, self.orientation, this.launchOffset, new Vector3());
    const v = self.velocity.clone().addScaledVector(forwardOf(self.orientation, _fwd), LAUNCH_EJECT_SPEED);
    const id = missileId(this.selfId, ++this.missileCounter);
    this.missiles.push(new Missile(id, this.selfId, targetId, p, v));
    this.outbox.push({ t: 'missileLaunch', id, target: targetId, p: toV3(p), v: toV3(v) });
    this.events.push({ type: 'missileLaunched', local: true, id, position: p.clone() });
    // The seeker starts over for the next missile.
    this.seeker.reset();
  }

  private stepMissiles(dt: number, enemies: readonly Combatant[], surfaceHeight: SurfaceHeight): void {
    const r = WEAPON_RULES.missile;
    this.updateTimer += dt;
    const sendUpdates = this.updateTimer >= this.updateInterval;
    if (sendUpdates) this.updateTimer = 0;
    for (const m of this.missiles) {
      const target = this.trackTargetOf(m, enemies);
      const result = m.step(dt, target, surfaceHeight);
      // The seeker may have dropped the target during the step.
      const fuseTargets: Array<{ id: string | null; t: TrackTarget }> = m.decoy
        ? [{ id: null, t: m.decoy }]
        : m.targetId !== null
          ? enemies.filter((c) => c.id === m.targetId).map((c) => ({ id: c.id, t: c }))
          : enemies.map((c) => ({ id: c.id, t: c }));
      let hit: string | null = null;
      let detonated = false;
      if (m.armed) {
        for (const f of fuseTargets) {
          if (!f.t.alive) continue;
          const c0 = f.id !== null ? this.prevPositionOf(f.t as Combatant, dt) : _c0.copy(f.t.position).addScaledVector(f.t.velocity, -dt);
          if (closestApproach(m.previous, m.position, c0, f.t.position).distance <= r.fuseRadius) {
            hit = f.id;
            detonated = true;
            break;
          }
        }
      }
      if (detonated || result !== null) {
        m.alive = false;
        const damage = hit !== null ? r.damage : 0;
        this.outbox.push({ t: 'missileEnd', id: m.id, p: toV3(m.position), hit, damage });
        this.events.push({ type: 'explosion', position: m.position.clone(), hit: hit !== null });
        if (hit !== null) this.events.push({ type: 'hit', target: hit, cause: 'missile', damage, position: m.position.clone() });
      } else if (sendUpdates) {
        this.outbox.push({ t: 'missileUpdate', id: m.id, p: toV3(m.position), v: toV3(m.velocity) });
      }
    }
    removeDead(this.missiles, (m) => m.alive);
  }

  private trackTargetOf(m: Missile, enemies: readonly Combatant[]): TrackTarget | null {
    if (m.decoy) return m.decoy;
    if (m.targetId === null) return null;
    const c = enemies.find((e) => e.id === m.targetId);
    if (!c) {
      m.loseTrack();
      return null;
    }
    return c;
  }

  private stepRemoteMissiles(dt: number, self: Combatant): void {
    const k = 1 - Math.exp(-CORRECTION_RATE * dt);
    let incoming = false;
    for (const m of this.remoteMissiles) {
      m.age += dt;
      m.position.addScaledVector(m.velocity, dt);
      const fix = _p.copy(m.correction).multiplyScalar(k);
      m.position.add(fix);
      m.correction.sub(fix);
      if (m.targetId === this.selfId && self.alive && isTracking(m, self)) incoming = true;
    }
    const lastUpdate = this.lastUpdate;
    removeDead(this.remoteMissiles, (m) => {
      const keep = m.age - (lastUpdate.get(m.id) ?? 0) < REMOTE_MISSILE_TIMEOUT;
      if (!keep) lastUpdate.delete(m.id);
      return keep;
    });
    this.incoming = incoming;
  }

  // ------------------------------------------------------------ flares

  private updateFlareRelease(dt: number, self: Combatant, pressed: boolean): void {
    this.flareCooldown = Math.max(0, this.flareCooldown - dt);
    if (!pressed || !self.alive || this.flaresLeft <= 0 || this.flareCooldown > 0) return;
    const n = Math.min(WEAPON_RULES.flare.salvo, this.flaresLeft);
    this.flaresLeft -= n;
    this.flareCooldown = WEAPON_RULES.flare.cooldown;
    this.flares.push(...spawnFlareSalvo(this.selfId, self.position, self.velocity, n));
    this.outbox.push({ t: 'flares', p: toV3(self.position), v: toV3(self.velocity), n });
    this.events.push({ type: 'flaresReleased', local: true, count: n, position: self.position.clone() });
  }
}

/** A remote missile "tracks" us while we're inside its seeker gimbal and it is closing in. */
function isTracking(m: RemoteMissile, self: Combatant): boolean {
  if (offBoresight(m.position, m.velocity, self.position) > WEAPON_RULES.missile.seekerHalfAngle * TRACK_GIMBAL_FACTOR) return false;
  const rel = _rel.subVectors(self.position, m.position);
  return rel.dot(_v.subVectors(m.velocity, self.velocity)) > 0;
}

/** Relay-safe missile id (/^[\w.:-]{1,32}$/): sanitized, shortened owner id + counter. */
export function missileId(ownerId: string, n: number): string {
  const owner = ownerId.replace(/[^\w.-]/g, '').slice(0, 20) || 'm';
  return `${owner}:${n}`;
}

function removeDead<T>(list: T[], keep: (x: T) => boolean): void {
  let j = 0;
  for (let i = 0; i < list.length; i++) {
    const x = list[i]!;
    if (keep(x)) list[j++] = x;
  }
  list.length = j;
}
