import { RUNWAY_CONFIG, type RunwayConfig, type TerrainConfig } from '../../config/worldConfig';
import { clamp, lerp, smoothstep } from '../../utils/math';
import { SimplexNoise2D } from '../../utils/noise';
import { mulberry32 } from '../../utils/random';
// Circular import (ClassicWorld uses this module's classic functions): only used at runtime, in the constructor.
import { ClassicWorld } from '../gen/ClassicWorld';
import type { WorldGenerator } from '../gen/WorldGenerator';

/**
 * X coordinate of the valley centerline at a given Z: a meandering path running along the Z axis.
 * Tightest bends have a ~650 m radius, about a 4 G turn at race speed.
 */
export function valleyCenterX(z: number): number {
  return 380 * Math.sin(z / 950) + 110 * Math.sin(z / 420 + 1.3) + 12 * Math.sin(z / 160 + 0.4);
}

/** Direction of travel (toward -Z) along the valley, as a normalized [x, z] pair. */
export function valleyDirection(z: number): [number, number] {
  const eps = 1;
  const dx = valleyCenterX(z - eps) - valleyCenterX(z + eps);
  const dz = -2 * eps;
  const len = Math.hypot(dx, dz);
  return [dx / len, dz / len];
}

/** A curved mountain pass: a circular arc (in the XZ plane) carved into the terrain. */
export interface PassArc {
  cx: number;
  cz: number;
  radius: number;
  /** Start/end angle (rad) with x = cx + r·cos(a), z = cz + r·sin(a). */
  from: number;
  to: number;
}

/** Offset of the Canyon Loop's return leg from the valley, and where the loop turns around. */
export const LOOP_LAYOUT = Object.freeze({ returnOffset: 1900, north: 2600, south: -2700 });

/** The two passes linking the canyon to the return leg of the Canyon Loop. */
export function loopPasses(): PassArc[] {
  const r = LOOP_LAYOUT.returnOffset / 2;
  return [
    { cx: valleyCenterX(LOOP_LAYOUT.south) + r, cz: LOOP_LAYOUT.south, radius: r, from: Math.PI, to: 2 * Math.PI },
    { cx: valleyCenterX(LOOP_LAYOUT.north) + r, cz: LOOP_LAYOUT.north, radius: r, from: 0, to: Math.PI },
  ];
}

/** Distance from (x, z) to the arc, and the position along it (0..1). */
function arcDistance(x: number, z: number, arc: PassArc): { d: number; t: number } {
  const dx = x - arc.cx;
  const dz = z - arc.cz;
  let a = Math.atan2(dz, dx);
  while (a < arc.from) a += 2 * Math.PI;
  while (a > arc.from + 2 * Math.PI) a -= 2 * Math.PI;
  if (a <= arc.to) return { d: Math.abs(Math.hypot(dx, dz) - arc.radius), t: (a - arc.from) / (arc.to - arc.from) };
  const ex0 = arc.cx + Math.cos(arc.from) * arc.radius;
  const ez0 = arc.cz + Math.sin(arc.from) * arc.radius;
  const ex1 = arc.cx + Math.cos(arc.to) * arc.radius;
  const ez1 = arc.cz + Math.sin(arc.to) * arc.radius;
  const d0 = Math.hypot(x - ex0, z - ez0);
  const d1 = Math.hypot(x - ex1, z - ez1);
  return d0 < d1 ? { d: d0, t: 0 } : { d: d1, t: 1 };
}

export interface RunwayRect {
  x: number;
  z: number;
  halfWidth: number;
  halfLength: number;
  height: number;
}

/** The runway is aligned with the Z axis (takeoff toward -Z), on the same line as the canyon entrance. */
export function runwayRect(r: RunwayConfig = RUNWAY_CONFIG): RunwayRect {
  return { x: valleyCenterX(r.alignZ), z: r.z, halfWidth: r.width / 2, halfLength: r.length / 2, height: r.height };
}

/** Distance from a point to the runway rectangle (0 inside). */
export function distanceToRunway(x: number, z: number, rect: RunwayRect, margin = 0): number {
  const dx = Math.max(0, Math.abs(x - rect.x) - rect.halfWidth - margin);
  const dz = Math.max(0, Math.abs(z - rect.z) - rect.halfLength - margin);
  return Math.hypot(dx, dz);
}

/**
 * Procedural, infinite height function: rolling hills, ridged mountains lining a meandering
 * valley with a river, and a flattened airfield at the valley entrance.
 */
export function createHeightFunction(cfg: TerrainConfig, runway: RunwayConfig = RUNWAY_CONFIG): (x: number, z: number) => number {
  const noise = new SimplexNoise2D(mulberry32(cfg.seed));
  const valleyEdge = cfg.valleyHalfWidth + cfg.valleyWallWidth;
  const rect = runwayRect(runway);
  const approachEnd = rect.z - rect.halfLength;
  const approach: RunwayRect = {
    x: rect.x,
    z: (approachEnd + runway.alignZ) / 2,
    halfWidth: 70,
    halfLength: (approachEnd - runway.alignZ) / 2,
    height: rect.height,
  };

  /** Stepped "mesa" profile: flat terraces separated by steep cliffs. */
  const terrace = (h: number, step: number): number => {
    const k = h / step;
    const f = k - Math.floor(k);
    return (Math.floor(k) + smoothstep(0.7, 1, f)) * step;
  };

  /**
   * Landscape away from the canyon, varying by region (several km across): flat plains, rolling
   * hills, high massifs with snowy peaks and terraced plateaus. Domain warping bends features so
   * they don't look like grid-aligned noise.
   */
  const land = (x: number, z: number, dx: number): number => {
    const wx = x + noise.fbm(x + 7000, z - 2000, 2, 1 / 2500) * 450;
    const wz = z + noise.fbm(x - 4000, z + 9000, 2, 1 / 2500) * 450;

    const region = clamp((noise.fbm(x - 20000, z + 15000, 2, 1 / 7000) * 0.5 + 0.5 - 0.5) * 1.9 + 0.5, 0, 1);
    const mountainous = smoothstep(0.55, 0.85, region);
    const flat = 1 - smoothstep(0.18, 0.4, region);
    const plateau = smoothstep(0.58, 0.72, noise.fbm(x + 30000, z - 12000, 2, 1 / 4500) * 0.5 + 0.5) * (1 - mountainous) * (1 - flat);

    // The canyon keeps its mountain walls whatever the region.
    const nearValley = 1 - smoothstep(valleyEdge + 300, valleyEdge + 1600, dx);
    const hills = (noise.fbm(wx, wz, 5, 1 / 1400) * 0.5 + 0.5) * cfg.hillHeight * (1 - 0.85 * flat * (1 - nearValley));
    const ridges = noise.ridged(wx + 5000, wz - 3000, 5, 1 / 900);
    const ridgeAmount = Math.max(0.25 + 0.75 * nearValley, (1 - flat) * 0.35 + mountainous * 1.4);
    let h = cfg.baseHeight * (1 - 0.6 * flat) + hills + ridges * cfg.mountainHeight * ridgeAmount;

    // Big massifs: tall, sharp, snow-capped peaks in mountain regions.
    const massif = noise.ridged(wx - 8000, wz + 6000, 4, 1 / 2600);
    h += massif * massif * 900 * mountainous * mountainous;

    // Plains: gentle swells and shallow basins.
    h += noise.fbm(x + 600, z - 900, 2, 1 / 650) * 10 * flat;

    // Plateaus: lifted, terraced tablelands with cliffs.
    if (plateau > 0.001) h = lerp(h, terrace(h + 140, 55), plateau);

    // The Canyon Loop's return leg runs down a broad, gentle lowland valley.
    const z0 = LOOP_LAYOUT.south - 600;
    const z1 = LOOP_LAYOUT.north + 600;
    if (z > z0 - 800 && z < z1 + 800) {
      const dRet = Math.abs(x - valleyCenterX(z) - LOOP_LAYOUT.returnOffset);
      const along = smoothstep(z0 - 800, z0, z) * (1 - smoothstep(z1, z1 + 800, z));
      const open = (1 - smoothstep(350, 900, dRet)) * along;
      if (open > 0) h = lerp(h, cfg.baseHeight + hills * 0.8, open);
    }

    return h + cfg.valleyRimBoost * (1 - smoothstep(valleyEdge, valleyEdge + 700, dx));
  };

  const base = (x: number, z: number): number => {
    const dx = Math.abs(x - valleyCenterX(z));
    const ground = land(x, z, dx);

    let floor = cfg.valleyFloorHeight + noise.fbm(x, z, 3, 1 / 350) * 3;
    floor -= cfg.riverDepth * (1 - smoothstep(cfg.riverHalfWidth * 0.5, cfg.riverHalfWidth + 14, dx));
    let h = lerp(floor, ground, smoothstep(cfg.valleyHalfWidth, valleyEdge, dx));

    h += noise.fbm(x + 999, z + 999, 3, 1 / 70) * 2.5 * smoothstep(cfg.riverHalfWidth, cfg.riverHalfWidth + 30, dx);
    return h;
  };

  // Mountain passes: the pass floor slopes from the canyon floor to the ground at the far end.
  const passes = loopPasses().map((arc) => {
    const returnEnd = arc.from === 0 ? arc.from : arc.to;
    return {
      arc,
      h0: cfg.valleyFloorHeight + 4,
      h1: Math.min(base(arc.cx + Math.cos(returnEnd) * arc.radius, arc.cz + Math.sin(returnEnd) * arc.radius), 160),
    };
  });
  const passHalfWidth = 75;
  const passWall = 220;

  return (x: number, z: number): number => {
    let h = base(x, z);
    for (const p of passes) {
      const { d, t } = arcDistance(x, z, p.arc);
      if (d > passHalfWidth + passWall) continue;
      // Swap ends for the northern pass, which runs from the return leg back into the canyon.
      const floorT = p.arc.from === 0 ? 1 - t : t;
      const floor = lerp(p.h0, p.h1, smoothstep(0.15, 1, floorT)) + noise.fbm(x, z, 2, 1 / 300) * 3;
      if (h > floor) h = lerp(floor, h, smoothstep(passHalfWidth, passHalfWidth + passWall, d));
    }

    const dRunway = distanceToRunway(x, z, rect, 25);
    if (dRunway < runway.blend) h = lerp(rect.height, h, smoothstep(0, runway.blend, dRunway));
    // Approach corridor: a flat cut from the runway's end straight to the canyon entrance.
    const dApproach = distanceToRunway(x, z, approach, 0);
    if (dApproach < runway.blend) {
      const floor = lerp(cfg.valleyFloorHeight + 2, rect.height, smoothstep(approach.z - approach.halfLength, approach.z + approach.halfLength, z));
      if (h > floor) h = lerp(floor, h, smoothstep(0, runway.blend, dApproach));
    }
    return h;
  };
}


/**
 * Infinite terrain of a world sampled on a regular grid (cellSize = chunkSize / chunkSegments).
 * getHeightAt() interpolates over the exact same triangles the full-detail terrain renders,
 * so collision matches what the player sees close up.
 *
 * `new HeightField(world)` wraps any WorldGenerator (see createWorld). The legacy form
 * `new HeightField(config, heightFn?)` is the Classic Canyon (optionally with a test height function).
 */
export class HeightField {
  readonly cellSize: number;
  readonly config: TerrainConfig;
  readonly world: WorldGenerator;
  readonly heightFn: (x: number, z: number) => number;
  private readonly cache = new Map<number, number>();

  constructor(source: TerrainConfig | WorldGenerator, heightFn?: (x: number, z: number) => number) {
    if (isWorld(source)) {
      this.world = source;
      this.heightFn = heightFn ?? ((x, z) => source.heightAt(x, z));
    } else {
      const classic = new ClassicWorld(source, heightFn ?? createHeightFunction(source));
      this.world = classic;
      this.heightFn = classic.heightAt;
    }
    this.config = this.world.config;
    this.cellSize = this.config.chunkSize / this.config.chunkSegments;
  }

  /** Height at grid vertex (i, j) = world (i * cellSize, j * cellSize). Cached. */
  heightAtVertex(i: number, j: number): number {
    // Cantor-free packing: grid indices stay well within ±2^20 for any reachable position.
    const key = (i + 1048576) * 2097152 + (j + 1048576);
    let h = this.cache.get(key);
    if (h === undefined) {
      if (this.cache.size > 200000) this.cache.clear();
      h = this.heightFn(i * this.cellSize, j * this.cellSize);
      this.cache.set(key, h);
    }
    return h;
  }

  getHeightAt(x: number, z: number): number {
    const gx = x / this.cellSize;
    const gz = z / this.cellSize;
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const fx = gx - i;
    const fz = gz - j;
    const h00 = this.heightAtVertex(i, j);
    const h10 = this.heightAtVertex(i + 1, j);
    const h01 = this.heightAtVertex(i, j + 1);
    const h11 = this.heightAtVertex(i + 1, j + 1);
    // Triangles split along the (i+1, j) -> (i, j+1) diagonal, matching the terrain chunk index buffer.
    if (fx + fz <= 1) return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
    return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
  }

  /** Water surface (sea, river, lake) at (x, z), or -Infinity on dry land. */
  waterLevelAt(x: number, z: number): number {
    return this.world.waterLevelAt(x, z);
  }

  /** True if (x, z) is over water (sea, river or lake). */
  isWater(x: number, z: number): boolean {
    return this.world.waterLevelAt(x, z) > -Infinity;
  }

  /** True if (x, z) is over water. Kept for the Classic Canyon, whose only water is its river. */
  isRiver(x: number, z: number): boolean {
    return this.isWater(x, z);
  }

  /** Solid surface height: ground, or the water surface where it is above the ground. */
  getSurfaceHeight(x: number, z: number): number {
    const ground = this.getHeightAt(x, z);
    const water = this.world.waterLevelAt(x, z);
    return water > ground ? water : ground;
  }

  get runway(): RunwayRect {
    return this.world.airfield;
  }

  /** Smooth surface normal from central differences of the height function (seamless across chunks). */
  normalAt(x: number, z: number, step: number, out: { x: number; y: number; z: number }): void {
    const hL = this.heightFn(x - step, z);
    const hR = this.heightFn(x + step, z);
    const hD = this.heightFn(x, z - step);
    const hU = this.heightFn(x, z + step);
    const nx = hL - hR;
    const nz = hD - hU;
    const ny = 2 * step;
    const len = Math.hypot(nx, ny, nz);
    out.x = nx / len;
    out.y = ny / len;
    out.z = nz / len;
  }
}

function isWorld(source: TerrainConfig | WorldGenerator): source is WorldGenerator {
  return typeof (source as WorldGenerator).heightAt === 'function';
}