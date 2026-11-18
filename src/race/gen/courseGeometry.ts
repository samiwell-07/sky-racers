import { GATE_CONFIG, JET_SIZE } from '../../config/worldConfig';
import type { BridgeSite, CitySite, WorldGenerator } from '../../world/gen/WorldGenerator';
import { HeightField } from '../../world/terrain/HeightField';

/** Gate frame size, as built by resolveCourse. */
export const GATE_WIDTH = JET_SIZE.span * GATE_CONFIG.widthToSpan;
export const GATE_HEIGHT = JET_SIZE.height * GATE_CONFIG.heightToJetHeight;
/** Gate center height above its clearance base (frame + half the opening). */
export const GATE_CENTER_OFFSET = GATE_CONFIG.frame + GATE_HEIGHT / 2;
export const GRAVITY = 9.81;

export interface Point2 {
  x: number;
  z: number;
}

/**
 * Terrain/obstacle sampling for the generator, through a HeightField (the same interpolated grid,
 * vertex cache included, that resolveCourse, the AI and collisions use).
 */
export class TerrainProbe {
  readonly heightField: HeightField;
  constructor(
    readonly world: WorldGenerator,
    readonly cities: readonly CitySite[] = [],
    readonly bridges: readonly BridgeSite[] = [],
  ) {
    this.heightField = new HeightField(world);
  }

  private readonly waterCache = new Map<number, number>();

  /** Solid surface (ground or water) as the game samples it (rendered grid; water on an 8 m lattice). */
  gridSurface(x: number, z: number): number {
    const ground = this.heightField.getHeightAt(x, z);
    const water = this.waterAt(x, z);
    return water > ground ? water : ground;
  }

  /** Cheaper surface for route sampling: the world height on a 4 m lattice (one evaluation per point). */
  surface(x: number, z: number): number {
    const ground = this.groundAt(x, z);
    const water = this.waterAt(x, z);
    return water > ground ? water : ground;
  }

  private readonly groundCache = new Map<number, number>();

  private groundAt(x: number, z: number): number {
    const i = Math.round(x / 4);
    const j = Math.round(z / 4);
    const key = (i + 2097152) * 4194304 + (j + 2097152);
    let h = this.groundCache.get(key);
    if (h === undefined) {
      if (this.groundCache.size > 300000) this.groundCache.clear();
      h = this.world.heightAt(i * 4, j * 4);
      this.groundCache.set(key, h);
    }
    return h;
  }

  private waterAt(x: number, z: number): number {
    const i = Math.round(x / 8);
    const j = Math.round(z / 8);
    const key = (i + 1048576) * 2097152 + (j + 1048576);
    let w = this.waterCache.get(key);
    if (w === undefined) {
      if (this.waterCache.size > 200000) this.waterCache.clear();
      w = this.world.waterLevelAt(i * 8, j * 8);
      this.waterCache.set(key, w);
    }
    return w;
  }

  /** Building top over a city (rough: towers downtown, blocks midtown, houses outside), or -Infinity. */
  buildingTop(x: number, z: number): number {
    let top = -Infinity;
    for (const c of this.cities) {
      const d = Math.hypot(x - c.x, z - c.z);
      if (d >= c.radius + 30) continue;
      const f = d / c.radius;
      const h = f < 0.4 ? c.maxBuildingHeight : f < 0.7 ? c.maxBuildingHeight * 0.55 : 35;
      top = Math.max(top, c.groundY + h);
    }
    return top;
  }

  /** Bridge deck top near (x, z) (within its width + margin), or -Infinity. `skip` = bridge flown under. */
  deckTop(x: number, z: number, skip?: BridgeSite): number {
    let top = -Infinity;
    for (const b of this.bridges) {
      if (b === skip) continue;
      const dx = Math.sin(b.heading);
      const dz = Math.cos(b.heading);
      const rx = x - b.x;
      const rz = z - b.z;
      const along = rx * dx + rz * dz;
      if (Math.abs(along) > b.halfSpan + 20) continue;
      const across = Math.abs(rx * dz - rz * dx);
      if (across > 30) continue;
      top = Math.max(top, b.deckY + 4);
    }
    return top;
  }

  /** Highest solid thing at (x, z): terrain/water, buildings, bridge decks. */
  obstacle(x: number, z: number, skip?: BridgeSite): number {
    return Math.max(this.surface(x, z), this.buildingTop(x, z), this.deckTop(x, z, skip));
  }

  /** Highest surface under a gate's footprint (same 5 samples as resolveCourse). */
  footprintGround(x: number, z: number, nx: number, nz: number): number {
    let g = -Infinity;
    for (const s of [-1, -0.5, 0, 0.5, 1]) g = Math.max(g, this.gridSurface(x - (nz * s * GATE_WIDTH) / 2, z + (nx * s * GATE_WIDTH) / 2));
    return g;
  }
}

/** Horizontal gate normals exactly as resolveCourse computes them (bisector of the legs). */
export function gateNormals(points: readonly Point2[], loop: boolean): Point2[] {
  const n = points.length;
  return points.map((p, i) => {
    const prev = points[i - 1] ?? (loop ? points[n - 1]! : null);
    const next = points[i + 1] ?? (loop ? points[0]! : null);
    let x = 0;
    let z = 0;
    if (prev) {
      const l = Math.hypot(p.x - prev.x, p.z - prev.z) || 1;
      x += (p.x - prev.x) / l;
      z += (p.z - prev.z) / l;
    }
    if (next) {
      const l = Math.hypot(next.x - p.x, next.z - p.z) || 1;
      x += (next.x - p.x) / l;
      z += (next.z - p.z) / l;
    }
    const l = Math.hypot(x, z);
    return l < 1e-6 ? { x: 0, z: -1 } : { x: x / l, z: z / l };
  });
}

/** Radius of the circle through three 3D points (Infinity when collinear). */
export function circumradius(a: readonly number[], b: readonly number[], c: readonly number[]): number {
  const ab = Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!);
  const bc = Math.hypot(c[0]! - b[0]!, c[1]! - b[1]!, c[2]! - b[2]!);
  const ca = Math.hypot(a[0]! - c[0]!, a[1]! - c[1]!, a[2]! - c[2]!);
  const ux = b[0]! - a[0]!;
  const uy = b[1]! - a[1]!;
  const uz = b[2]! - a[2]!;
  const vx = c[0]! - a[0]!;
  const vy = c[1]! - a[1]!;
  const vz = c[2]! - a[2]!;
  const cross = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  if (cross < 1e-9) return Infinity;
  return (ab * bc * ca) / (2 * cross);
}

/** Load factor (g) needed to fly through three consecutive gate centers at `speed` m/s. */
export function turnLoad(a: readonly number[], b: readonly number[], c: readonly number[], speed: number): number {
  return (speed * speed) / (circumradius(a, b, c) * GRAVITY);
}

/** Turn loads at every gate that has two neighbours (all gates on a loop). */
export function turnLoads(centers: readonly (readonly number[])[], loop: boolean, speed: number): number[] {
  const n = centers.length;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!loop && (i === 0 || i === n - 1)) continue;
    out.push(turnLoad(centers[(i - 1 + n) % n]!, centers[i]!, centers[(i + 1) % n]!, speed));
  }
  return out;
}
