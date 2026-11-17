import { Vector3 } from 'three';
import { WEAPON_RULES } from './types';
import { GRAVITY } from './math';
import type { Missile, TrackTarget } from './missile';

type FlareRules = typeof WEAPON_RULES.flare;

/** Quadratic drag (1/m): flares shed the jet's speed within a second or two, then fall. */
export const FLARE_DRAG = 0.012;
/** An afterburning jet outshines its flares: the decoy chance is scaled by this. */
export const AFTERBURNER_DECOY_FACTOR = 0.6;

export class Flare implements TrackTarget {
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  age = 0;

  constructor(
    readonly ownerId: string,
    position: Vector3,
    velocity: Vector3,
    private readonly life: number = WEAPON_RULES.flare.life,
  ) {
    this.position.copy(position);
    this.velocity.copy(velocity);
  }

  get alive(): boolean {
    return this.age < this.life;
  }

  /** 1 when fresh → 0 when burnt out. */
  get intensity(): number {
    return Math.max(0, 1 - this.age / this.life);
  }

  step(dt: number, surfaceHeight: (x: number, z: number) => number): void {
    const speed = this.velocity.length();
    this.velocity.multiplyScalar(1 / (1 + FLARE_DRAG * speed * dt));
    this.velocity.y -= GRAVITY * dt;
    this.position.addScaledVector(this.velocity, dt);
    const ground = surfaceHeight(this.position.x, this.position.z);
    if (this.position.y <= ground) {
      this.position.y = ground;
      this.velocity.set(0, 0, 0);
    }
    this.age += dt;
  }
}

const _dir = new Vector3();
const _right = new Vector3();

/**
 * Deterministic salvo pattern from the jet's position and velocity only (so the remote copy of a
 * 'flares' message spawns the same flares): alternately left/right, slightly down, behind the jet.
 */
export function spawnFlareSalvo(ownerId: string, position: Vector3, velocity: Vector3, n: number, life?: number): Flare[] {
  const dir = _dir.copy(velocity);
  if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
  dir.normalize();
  const right = _right.crossVectors(dir, new Vector3(0, 1, 0));
  if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
  right.normalize();
  const out: Flare[] = [];
  for (let i = 0; i < n; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const p = position.clone().addScaledVector(dir, -6).add(new Vector3(0, -1, 0));
    const v = velocity
      .clone()
      .multiplyScalar(0.85)
      .addScaledVector(right, side * (18 + 4 * Math.floor(i / 2)))
      .add(new Vector3(0, -12, 0));
    out.push(new Flare(ownerId, p, v, life));
  }
  return out;
}

/**
 * Called when `victimId` releases a salvo: every missile tracking the victim rolls the decoy chance
 * once and, on success, switches to the first fresh flare inside its seeker cone.
 * Returns the missiles that were decoyed.
 */
export function rollFlareDecoys(
  missiles: readonly Missile[],
  victimId: string,
  victimAfterburner: boolean,
  flares: readonly Flare[],
  rng: () => number,
  rules: FlareRules = WEAPON_RULES.flare,
  seekerHalfAngle: number = WEAPON_RULES.missile.seekerHalfAngle,
): Missile[] {
  const chance = rules.decoyChance * (victimAfterburner ? AFTERBURNER_DECOY_FACTOR : 1);
  const decoyed: Missile[] = [];
  for (const m of missiles) {
    if (!m.alive || m.targetId !== victimId) continue;
    if (rng() >= chance) continue;
    const flare = flares.find((f) => f.alive && m.canSee(f.position, seekerHalfAngle));
    if (!flare) continue;
    m.decoyTo(flare);
    decoyed.push(m);
  }
  return decoyed;
}
