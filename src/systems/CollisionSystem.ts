import { Vector3 } from 'three';
import { SPAWN_CONFIG } from '../config/worldConfig';
import { EXTREMITY_POINT_INDICES, type Jet } from '../entities/jet/Jet';
import type { ObstacleKind } from '../world/props/PropsManager';
import type { HeightField } from '../world/terrain/HeightField';

export type CrashReason = 'ground' | 'water' | 'damage' | 'hardLanding' | Exclude<ObstacleKind, 'tree'>;

/** Collision rules shared by the player and the AI racers. */
export const IMPACT_RULES = Object.freeze({
  /** Seconds before a crashed racer respawns at its next gate. */
  respawnDelay: SPAWN_CONFIG.respawnDelay,
  treeDamage: 0.3,
  scrapeDamage: 0.35,
  /** Minimum time between two damaging hits (s). */
  damageCooldown: 0.6,
  /** Extra lift (m) above the scrape depth, and minimum climb rate (m/s), after a wing scrape. */
  scrapePushUp: 0.4,
  scrapeClimb: 3,
});

export type ImpactEvent =
  | { kind: 'crash'; reason: CrashReason }
  | { kind: 'damage'; tree: boolean; destroyed: boolean };

/**
 * Turns collision results into crashes and damage with the same rules for every racer:
 * terrain/water/obstacle crashes, tree strikes and wing scrapes (with a cooldown and a push back up).
 */
export class ImpactTracker {
  cooldown = 0;

  tick(dt: number): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
  }

  reset(): void {
    this.cooldown = 0;
  }

  /** Applies the result to the jet (damage, scrape push-up). Returns what happened, or null. */
  apply(c: CollisionResult, jet: Jet): ImpactEvent | null {
    if (c.crash) return { kind: 'crash', reason: c.crash };
    if (!(c.scrape || c.tree) || this.cooldown > 0) return null;
    this.cooldown = IMPACT_RULES.damageCooldown;
    const s = jet.flight.state;
    if (c.scrape) {
      s.position.y += c.scrapeDepth + IMPACT_RULES.scrapePushUp;
      s.velocity.y = Math.max(s.velocity.y, IMPACT_RULES.scrapeClimb);
    }
    const destroyed = jet.damage.apply(c.tree ? IMPACT_RULES.treeDamage : IMPACT_RULES.scrapeDamage);
    return { kind: 'damage', tree: c.tree, destroyed };
  }
}

export interface CollisionResult {
  crash: CrashReason | null;
  /** Only wing/tail tips touched the ground: damage instead of a crash. */
  scrape: boolean;
  /** How deep the deepest extremity went below the surface (m), to push the jet back up. */
  scrapeDepth: number;
  /** Flew through a tree crown: damage, no crash. */
  tree: boolean;
}

export interface ObstacleSource {
  collide(points: readonly Vector3[]): ObstacleKind | null;
  /** Optional AI hazard queries (see PropsManager.obstacleTop / hazardBands). */
  obstacleTop?(x: number, z: number, radius: number): number;
  hazardBands?(x: number, z: number, radius: number, out: number[]): number;
}

const _p = new Vector3();

/** Detects crashes, scrapes and obstacle hits, and predicts terrain impact. */
export class CollisionSystem {
  private readonly result: CollisionResult = { crash: null, scrape: false, scrapeDepth: 0, tree: false };

  constructor(readonly heightField: HeightField, private obstacles: ObstacleSource | null = null) {}

  setObstacles(obstacles: ObstacleSource | null): void {
    this.obstacles = obstacles;
  }

  get obstacleSource(): ObstacleSource | null {
    return this.obstacles;
  }

  check(points: readonly Vector3[]): CollisionResult {
    const r = this.result;
    r.crash = null;
    r.scrape = false;
    r.scrapeDepth = 0;
    r.tree = false;

    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      const surface = this.heightField.getSurfaceHeight(p.x, p.z);
      const depth = surface - p.y;
      if (depth < 0) continue;
      if (EXTREMITY_POINT_INDICES.has(i)) {
        r.scrape = true;
        r.scrapeDepth = Math.max(r.scrapeDepth, depth);
      } else {
        r.crash = surface > this.heightField.getHeightAt(p.x, p.z) + 0.01 ? 'water' : 'ground';
        return r;
      }
    }

    const hit = this.obstacles?.collide(points) ?? null;
    if (hit === 'tree') r.tree = true;
    else if (hit) r.crash = hit;
    return r;
  }

  /** Height above the ground or water directly below the position (radar altitude). */
  altitudeAboveGround(position: Vector3): number {
    return position.y - this.heightField.getSurfaceHeight(position.x, position.z);
  }

  /** True if keeping the current velocity would hit the terrain within `seconds` (PULL UP warning). */
  terrainAhead(position: Vector3, velocity: Vector3, seconds: number, margin = 3): boolean {
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      _p.copy(position).addScaledVector(velocity, (seconds * i) / steps);
      if (_p.y < this.heightField.getSurfaceHeight(_p.x, _p.z) + margin) return true;
    }
    return false;
  }
}
