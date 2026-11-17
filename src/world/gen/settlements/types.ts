import type { BridgeSite, RoadSegment } from '../WorldGenerator';

/** Size (m) of the macro grid: about one city candidate per cell. */
export const MACRO_CELL = 7000;
export const ROAD_HALF_WIDTH = 7;
/** Deck slab thickness (m): BridgeSite.deckY is the underside, the road runs on top. */
export const DECK_THICKNESS = 2.5;
/** Parapet height above the road surface (collision and rendering). */
export const PARAPET_HEIGHT = 1.2;
/** Deck underside at least this far above the water where the ramps allow it. */
export const BRIDGE_CLEARANCE = 35;
/** Half size of a square bridge pier (m). */
export const PIER_HALF = 2.5;
/** City street grid: block pitch and half width of a street (m). */
export const STREET_PITCH = 110;
export const STREET_HALF_WIDTH = 9;

/** A short straight piece of road (≈40 m) with its surface height at both ends. */
export interface RoadPiece extends RoadSegment {
  /** Road surface height at a and at b (deckY, when on a bridge, is the lower of the two). */
  ay: number;
  by: number;
  /** Owning road (ids of its two cities, a < b) and position along it: the global processing order. */
  roadA: number;
  roadB: number;
  index: number;
}

export interface Pier {
  x: number;
  z: number;
  /** Footing (river bed or ground, slightly sunk) and top (deck underside). */
  bottomY: number;
  topY: number;
}

/** A road bridge (over water) or viaduct (over a dip): BridgeSite plus its deck pieces and piers. */
export interface BridgeSpan extends BridgeSite {
  key: string;
  /** Half width of the road on the deck (the deck is 1 m wider on each side). */
  halfWidth: number;
  pieces: readonly RoadPiece[];
  piers: readonly Pier[];
}

export interface Road {
  key: string;
  pieces: RoadPiece[];
  bridges: BridgeSpan[];
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Global order in which overlapping road pieces flatten the ground (keeps shapeHeight continuous). */
export function comparePieces(a: RoadPiece, b: RoadPiece): number {
  return a.roadA - b.roadA || a.roadB - b.roadB || a.index - b.index;
}

/** Map with a size bound: the oldest entry is dropped first (values can always be recomputed). */
export class BoundedCache<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly max: number) {}

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): V {
    if (this.map.size >= this.max) {
      const first = this.map.keys().next();
      if (!first.done) this.map.delete(first.value);
    }
    this.map.set(key, value);
    return value;
  }
}

/** Unique id of macro cell (i, j) (also used as the id of its city). */
export function macroKey(i: number, j: number): number {
  return (i + 32768) * 65536 + (j + 32768);
}

export function hash3(seed: number, a: number, b: number): number {
  let h = Math.imul((seed ^ 0x2c1b3c6d) >>> 0, 0x85ebca6b);
  h = Math.imul(h ^ Math.imul(a | 0, 0x27d4eb2d), 0xc2b2ae35);
  h = Math.imul(h ^ Math.imul(b | 0, 0x165667b1), 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
}

export function smooth01(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/** Distance from (x, z) to segment a-b, and the clamped parameter t along it (written to out[0]). */
export function segmentDistance(x: number, z: number, ax: number, az: number, bx: number, bz: number, out: Float64Array): number {
  const sx = bx - ax;
  const sz = bz - az;
  const l2 = sx * sx + sz * sz;
  let t = l2 > 0 ? ((x - ax) * sx + (z - az) * sz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  out[0] = t;
  const dx = ax + sx * t - x;
  const dz = az + sz * t - z;
  return Math.sqrt(dx * dx + dz * dz);
}
