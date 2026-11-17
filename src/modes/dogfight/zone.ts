import { Quaternion, Vector3 } from 'three';
import { DOGFIGHT_RULES } from '../../combat/types';
import type { WorldGenerator } from '../../world/gen/WorldGenerator';

/** The parts of a world the dogfight zone needs (tests pass a fake). */
export type ZoneWorld = Pick<WorldGenerator, 'heightAt' | 'waterLevelAt'> & {
  readonly classicValleyCenterX?: (z: number) => number;
};

/** Cylindrical combat zone (same on both clients). */
export interface DogfightZone {
  cx: number;
  cz: number;
  radius: number;
  ceiling: number;
}

export interface ZoneCheck {
  outside: boolean;
  reason: 'radius' | 'ceiling' | null;
  /** Horizontal distance to the wall (m): positive inside, negative outside. */
  wallDistance: number;
}

export interface DogfightSpawn {
  position: Vector3;
  orientation: Quaternion;
  /** Rotation about +Y (0 = toward -Z, the Game.spawnAt convention). */
  heading: number;
  speed: number;
  velocity: Vector3;
}

/** Candidates are searched on rings around the origin out to this distance (m). */
const SEARCH_RADIUS = 30000;
const RING_STEP = 3750;
/** Spacing of the candidates along a ring (m). */
const RING_SPACING = 4500;
/** Sample rings across a candidate zone (fraction of the radius, points on the ring). */
const SAMPLE_RINGS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [0.35, 6],
  [0.7, 10],
  [1, 14],
];
/** Classic Canyon: the zone sits on the canyon in front of the airfield. */
const CLASSIC_CENTER_Z = -500;
const SPAWN_AXES = 8;
const SPAWN_PATH_SAMPLES = 24;
/** Clearance kept above the highest ground between the spawns and the centre (m). */
const PATH_CLEARANCE = 300;
const UP = new Vector3(0, 1, 0);

function surfaceAt(world: ZoneWorld, x: number, z: number): number {
  return Math.max(world.heightAt(x, z), world.waterLevelAt(x, z));
}

function isWater(world: ZoneWorld, x: number, z: number): boolean {
  return world.waterLevelAt(x, z) > world.heightAt(x, z);
}

/**
 * Score of a zone centred on (cx, cz): rugged terrain (height spread and relief) is good, water
 * (mostly ocean) is bad, and nearer the origin wins ties.
 */
export function scoreDogfightZone(world: ZoneWorld, cx: number, cz: number, radius: number = DOGFIGHT_RULES.zoneRadius): number {
  let n = 0;
  let water = 0;
  let sum = 0;
  let sumSq = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const [f, count] of SAMPLE_RINGS) {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + f;
      const x = cx + Math.cos(a) * radius * f;
      const z = cz + Math.sin(a) * radius * f;
      const h = surfaceAt(world, x, z);
      if (isWater(world, x, z)) water++;
      n++;
      sum += h;
      sumSq += h * h;
      min = Math.min(min, h);
      max = Math.max(max, h);
    }
  }
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  const terrain = Math.min(std, 350) / 350 + (0.5 * Math.min(max - min, 1200)) / 1200;
  const centreWater = isWater(world, cx, cz) ? 0.5 : 0;
  return terrain - 2.5 * (water / n) - centreWater - (0.15 * Math.hypot(cx, cz)) / SEARCH_RADIUS;
}

/**
 * Zone radius for a match of `players` pilots (clamped to 2..4): a duel fights in a zone 6 km
 * across, every extra pilot adds 2 km (8 km for three, 10 km for four).
 */
export function dogfightZoneRadius(players: number): number {
  const R = DOGFIGHT_RULES;
  const n = Math.min(R.maxPlayers, Math.max(R.minPlayers, Math.round(Number.isFinite(players) ? players : R.minPlayers)));
  return R.zoneRadius + (n - R.minPlayers) * R.zoneRadiusPerExtraPlayer;
}

/**
 * Deterministic combat-zone centre: the best-scoring candidate on fixed rings around the origin.
 * Both clients get the same answer for the same world, seed and pilot count (no randomness, fixed
 * order; the first of equal scores wins). The radius grows with the pilot count (dogfightZoneRadius).
 */
export function chooseDogfightZone(world: ZoneWorld, seed: number, players: number = DOGFIGHT_RULES.minPlayers): DogfightZone {
  const radius = dogfightZoneRadius(players);
  const ceiling = DOGFIGHT_RULES.ceiling;
  if (world.classicValleyCenterX) return { cx: world.classicValleyCenterX(CLASSIC_CENTER_Z), cz: CLASSIC_CENTER_Z, radius, ceiling };

  // The seed only turns the candidate rings, so different worlds don't all probe the same bearings.
  const turn = (((seed >>> 0) % 9973) / 9973) * Math.PI * 2;
  let best = { cx: 0, cz: 0, score: scoreDogfightZone(world, 0, 0, radius) };
  for (let r = RING_STEP; r <= SEARCH_RADIUS + 1e-6; r += RING_STEP) {
    const count = Math.ceil((2 * Math.PI * r) / RING_SPACING);
    const offset = turn + r * 0.00017;
    for (let i = 0; i < count; i++) {
      const a = offset + (i / count) * Math.PI * 2;
      const cx = Math.round(Math.cos(a) * r);
      const cz = Math.round(Math.sin(a) * r);
      const score = scoreDogfightZone(world, cx, cz, radius);
      if (score > best.score) best = { cx, cz, score };
    }
  }
  return { cx: best.cx, cz: best.cz, radius, ceiling };
}

/** Out of zone = farther than the radius from the centre (horizontally) or above the ceiling. */
export function checkZone(zone: DogfightZone, x: number, y: number, z: number): ZoneCheck {
  const wallDistance = zone.radius - Math.hypot(x - zone.cx, z - zone.cz);
  if (wallDistance < 0) return { outside: true, reason: 'radius', wallDistance };
  if (y > zone.ceiling) return { outside: true, reason: 'ceiling', wallDistance };
  return { outside: false, reason: null, wallDistance };
}

/**
 * Highest surface on the `n` spokes from the zone centre out to `reach`, the first at angle `a`
 * (rad, in the XZ plane) and the others evenly spread. For n = 2 the spokes form a diameter.
 */
function spokesTop(zone: DogfightZone, world: ZoneWorld, a: number, reach: number, n: number): number {
  let top = -Infinity;
  const perSpoke = SPAWN_PATH_SAMPLES / 2;
  for (let s = 0; s < n; s++) {
    const ux = Math.cos(a + (s / n) * Math.PI * 2);
    const uz = Math.sin(a + (s / n) * Math.PI * 2);
    for (let i = 0; i <= perSpoke; i++) {
      const t = i / perSpoke;
      top = Math.max(top, surfaceAt(world, zone.cx + ux * reach * t, zone.cz + uz * reach * t));
    }
  }
  return top;
}

/**
 * Spawn of player `slot` (0..players-1: order of the sorted player ids) for its `round`-th life.
 * The slots are evenly spread on a circle spawnWallMargin inside the zone wall, nose toward the
 * centre (a duel: opposite ends of a diameter). Spoke layouts are ranked by their highest ground
 * (lowest first); rounds cycle through the best four.
 */
export function dogfightSpawn(zone: DogfightZone, world: ZoneWorld, slot: number, round = 0, players: number = DOGFIGHT_RULES.minPlayers): DogfightSpawn {
  const R = DOGFIGHT_RULES;
  const n = Math.min(R.maxPlayers, Math.max(R.minPlayers, Math.round(players)));
  const reach = Math.max(0, zone.radius - R.spawnWallMargin);
  const sector = (Math.PI * 2) / n;
  const axes: Array<{ a: number; top: number }> = [];
  for (let i = 0; i < SPAWN_AXES; i++) {
    const a = (i / SPAWN_AXES) * sector;
    axes.push({ a, top: spokesTop(zone, world, a, reach, n) });
  }
  axes.sort((p, q) => p.top - q.top || p.a - q.a);
  const axis = axes[Math.abs(Math.floor(round)) % Math.min(4, axes.length)];
  const angle = axis.a + (((Math.floor(slot) % n) + n) % n) * sector;
  const x = zone.cx + Math.cos(angle) * reach;
  const z = zone.cz + Math.sin(angle) * reach;
  const y = Math.min(zone.ceiling - 500, Math.max(surfaceAt(world, x, z) + R.spawnHeightAboveGround, axis.top + PATH_CLEARANCE));
  const heading = Math.atan2(-(zone.cx - x), -(zone.cz - z));
  const forward = new Vector3(-Math.sin(heading), 0, -Math.cos(heading));
  return {
    position: new Vector3(x, y, z),
    orientation: new Quaternion().setFromAxisAngle(UP, heading),
    heading,
    speed: R.spawnSpeed,
    velocity: forward.multiplyScalar(R.spawnSpeed),
  };
}

/** Lobby slot of a player: its index among the sorted player ids (0..n-1; 0 if unknown). */
export function dogfightSlot(selfId: string, playerIds: readonly string[]): number {
  return Math.max(0, [...playerIds].sort().indexOf(selfId));
}
