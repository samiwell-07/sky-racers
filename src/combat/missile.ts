import { Vector3 } from 'three';
import { WEAPON_RULES } from './types';
import { GRAVITY, offBoresight } from './math';

type MissileRules = typeof WEAPON_RULES.missile;

/** Quadratic drag coefficient after motor burn-out (1/m): ~28 m/s² of deceleration at 680 m/s. */
export const MISSILE_DRAG = 6e-5;
/**
 * The in-flight seeker gimbal is wider than the launch cone so a missile launched at the edge of
 * the lock cone (and leading its target) keeps tracking; flare decoys still use seekerHalfAngle.
 */
export const TRACK_GIMBAL_FACTOR = 1.6;

/** Something a missile can home on: a jet or a flare. */
export interface TrackTarget {
  readonly position: Vector3;
  readonly velocity: Vector3;
  readonly alive: boolean;
}

const _r = new Vector3();
const _vr = new Vector3();
const _omega = new Vector3();
const _acc = new Vector3();
const _vhat = new Vector3();
const _tmp = new Vector3();
const _tAcc = new Vector3();

/**
 * Proportional-navigation lateral acceleration command (m/s², perpendicular to the missile's
 * velocity, limited to maxG), with gravity compensation and an augmented term for target manoeuvres.
 */
export function pnCommand(
  missilePos: Vector3,
  missileVel: Vector3,
  targetPos: Vector3,
  targetVel: Vector3,
  targetAccel: Vector3 | null,
  rules: MissileRules,
  out = new Vector3(),
): Vector3 {
  const r = _r.subVectors(targetPos, missilePos);
  const vr = _vr.subVectors(targetVel, missileVel);
  const dist2 = Math.max(r.lengthSq(), 1);
  const omega = _omega.crossVectors(r, vr).divideScalar(dist2);
  const rhat = _tmp.copy(r).normalize();
  const closing = Math.max(-rhat.dot(vr), 0.2 * missileVel.length());
  out.crossVectors(omega, rhat).multiplyScalar(rules.navGain * closing);
  if (targetAccel) out.addScaledVector(targetAccel, rules.navGain / 2);
  out.y += GRAVITY;
  return limitLateral(out, missileVel, rules.maxG * GRAVITY);
}

/** Removes the component of `acc` along `vel` and clamps the remainder to `max`. */
export function limitLateral(acc: Vector3, vel: Vector3, max: number): Vector3 {
  const vhat = _vhat.copy(vel);
  if (vhat.lengthSq() > 1e-9) {
    vhat.normalize();
    acc.addScaledVector(vhat, -acc.dot(vhat));
  }
  const m = acc.length();
  if (m > max) acc.multiplyScalar(max / m);
  return acc;
}

export class Missile {
  readonly position = new Vector3();
  readonly previous = new Vector3();
  readonly velocity = new Vector3();
  age = 0;
  travelled = 0;
  alive = true;
  /** Combatant id the seeker tracks; null once it lost the target or for a dumb launch. */
  targetId: string | null;
  /** Set when a flare seduced the seeker: the missile now homes on it instead. */
  decoy: TrackTarget | null = null;
  /** Magnitude of the last lateral (aerodynamic) acceleration command, m/s². */
  lastLateralAccel = 0;
  private readonly lastTargetVel = new Vector3();
  private hasLastTargetVel = false;

  constructor(
    readonly id: string,
    readonly ownerId: string,
    targetId: string | null,
    position: Vector3,
    velocity: Vector3,
    private readonly rules: MissileRules = WEAPON_RULES.missile,
  ) {
    this.targetId = targetId;
    this.position.copy(position);
    this.previous.copy(position);
    this.velocity.copy(velocity);
  }

  get guided(): boolean {
    return this.decoy !== null || this.targetId !== null;
  }

  get burning(): boolean {
    return this.age < this.rules.burnTime;
  }

  /** The proximity fuse arms once the missile is minRange away from the launch point. */
  get armed(): boolean {
    return this.travelled >= this.rules.minRange;
  }

  /** Drops the target (out of the gimbal, dead, or a decoy that burnt out): the missile flies on unguided. */
  loseTrack(): void {
    this.targetId = null;
    this.decoy = null;
    this.hasLastTargetVel = false;
  }

  /** Seduced by a flare. */
  decoyTo(flare: TrackTarget): void {
    this.decoy = flare;
    this.targetId = null;
    this.hasLastTargetVel = false;
  }

  /** True when `point` is inside the seeker's tracking gimbal around the velocity vector. */
  canSee(point: Vector3, halfAngle = this.rules.seekerHalfAngle * TRACK_GIMBAL_FACTOR): boolean {
    return offBoresight(this.position, this.velocity, point) <= halfAngle;
  }

  /**
   * One flight step. `target` is what the seeker tracks (resolved by the caller from targetId or
   * decoy), or null for unguided flight. Returns 'terrain' on ground impact, 'expired' at maxLife.
   */
  step(dt: number, target: TrackTarget | null, surfaceHeight: (x: number, z: number) => number): 'terrain' | 'expired' | null {
    const r = this.rules;
    this.previous.copy(this.position);
    if (target && (!target.alive || !this.canSee(target.position))) {
      this.loseTrack();
      target = null;
    }
    const acc = _acc.set(0, 0, 0);
    if (target) {
      let tAcc: Vector3 | null = null;
      if (this.hasLastTargetVel && dt > 0) tAcc = _tAcc.subVectors(target.velocity, this.lastTargetVel).divideScalar(dt);
      pnCommand(this.position, this.velocity, target.position, target.velocity, tAcc, r, acc);
      this.lastTargetVel.copy(target.velocity);
      this.hasLastTargetVel = true;
    }
    this.lastLateralAccel = acc.length();
    const speed = this.velocity.length();
    if (speed > 1e-6) {
      const axial = this.burning ? r.boostSpeed / r.burnTime : -MISSILE_DRAG * speed * speed;
      acc.addScaledVector(_vhat.copy(this.velocity).divideScalar(speed), axial);
    }
    acc.y -= GRAVITY;
    this.velocity.addScaledVector(acc, dt);
    this.position.addScaledVector(this.velocity, dt);
    this.travelled += this.velocity.length() * dt;
    this.age += dt;
    if (this.position.y <= surfaceHeight(this.position.x, this.position.z)) {
      this.alive = false;
      return 'terrain';
    }
    if (this.age >= r.maxLife) {
      this.alive = false;
      return 'expired';
    }
    return null;
  }
}
