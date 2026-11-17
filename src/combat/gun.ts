import { Vector3 } from 'three';
import { WEAPON_RULES } from './types';
import { GRAVITY } from './math';

type GunRules = typeof WEAPON_RULES.gun;

/**
 * Gun trigger + heat model. Heat rises by heatPerShot per round and always bleeds off at coolRate;
 * reaching 1 overheats the gun, which stays silent until heat drops below overheatRecover.
 */
export class GunHeat {
  heat = 0;
  overheated = false;
  /** Seconds until the next round may leave the barrel (≤ 0 = ready). */
  private nextShot = 0;

  constructor(private readonly rules: GunRules = WEAPON_RULES.gun) {}

  reset(): void {
    this.heat = 0;
    this.overheated = false;
    this.nextShot = 0;
  }

  /**
   * Advance by dt with the trigger state. Returns, for each round fired during this step, how long
   * ago (s, 0..dt) it was fired so rounds can be spaced along their path.
   */
  update(dt: number, trigger: boolean): number[] {
    const r = this.rules;
    const fired: number[] = [];
    if (trigger) {
      const interval = 1 / r.rateOfFire;
      // nextShot is relative to the start of the step; a round fires at time (nextShot) into it.
      while (this.nextShot < dt && !this.overheated) {
        const at = Math.max(0, this.nextShot);
        fired.push(dt - at);
        this.nextShot = at + interval;
        this.heat += r.heatPerShot;
        if (this.heat >= 1) {
          this.heat = 1;
          this.overheated = true;
        }
      }
      this.nextShot -= dt;
    } else {
      this.nextShot = Math.max(0, this.nextShot - dt);
    }
    this.heat = Math.max(0, this.heat - r.coolRate * dt);
    if (this.overheated && this.heat < r.overheatRecover) this.overheated = false;
    return fired;
  }
}

/** A simulated gun round (also used for the remote player's tracers, which never hit-test). */
export interface Round {
  readonly position: Vector3;
  readonly previous: Vector3;
  readonly velocity: Vector3;
  travelled: number;
  alive: boolean;
  /** Tracers of the remote player are visual only: the shooter decides hits. */
  readonly remote: boolean;
}

export function createRound(position: Vector3, velocity: Vector3, remote: boolean): Round {
  return { position: position.clone(), previous: position.clone(), velocity: velocity.clone(), travelled: 0, alive: true, remote };
}

/**
 * Moves a round by dt (ballistic). Returns 'terrain' when it struck the surface (position is set to
 * the impact point), 'expired' past the range, otherwise null.
 */
export function stepRound(
  round: Round,
  dt: number,
  surfaceHeight: (x: number, z: number) => number,
  range: number = WEAPON_RULES.gun.range,
): 'terrain' | 'expired' | null {
  round.previous.copy(round.position);
  round.velocity.y -= GRAVITY * dt;
  round.position.addScaledVector(round.velocity, dt);
  round.travelled += round.velocity.length() * dt;
  const ground = surfaceHeight(round.position.x, round.position.z);
  if (round.position.y <= ground) {
    // Interpolate the impact point along the step.
    const h0 = round.previous.y - surfaceHeight(round.previous.x, round.previous.z);
    const h1 = round.position.y - ground;
    const t = h0 > 0 ? h0 / (h0 - h1) : 0;
    round.position.lerpVectors(round.previous, round.position, Math.min(1, Math.max(0, t)));
    round.alive = false;
    return 'terrain';
  }
  if (round.travelled >= range) {
    round.alive = false;
    return 'expired';
  }
  return null;
}
