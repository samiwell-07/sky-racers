import { SimplexNoise2D } from '../../utils/noise';
import { mulberry32 } from '../../utils/random';
import { smoothstep } from '../../utils/math';

/**
 * Pure, deterministic prop placement. The same plain data feeds both the renderer (PropsManager)
 * and collision, so obstacles exist for collision even before their meshes are streamed in.
 */

export type ObstacleKind = 'tree' | 'rock' | 'building' | 'powerline' | 'arch';

/**
 * Rectangle kept free of trees/rocks/buildings. `heading` is a rotation about +Y (Three.js
 * rotation.y convention): the length axis is local +Z, i.e. world (sin heading, cos heading).
 */
export interface ClearZone {
  x: number;
  z: number;
  halfWidth: number;
  halfLength: number;
  heading: number;
}

export interface PlacementOptions {
  seed: number;
  heightAt: (x: number, z: number) => number;
  valleyCenterX: (z: number) => number;
  powerLineZ?: readonly number[];
  archZ?: readonly number[];
  clearZones?: readonly ClearZone[];
  /** Candidate density multiplier (1 = full). */
  density?: number;
}

export type TreeKind = 'conifer' | 'broadleaf';

export interface TreeData {
  kind: TreeKind;
  x: number;
  /** Base of the trunk (slightly sunk into the ground). */
  y: number;
  z: number;
  height: number;
  /** Horizontal scale relative to the unit tree shape. */
  widthScale: number;
  rotation: number;
  tint: [number, number, number];
}

export interface RockData {
  x: number;
  /** Center of the (squashed) rock. */
  y: number;
  z: number;
  radius: number;
  /** Vertical scale relative to radius. */
  squash: number;
  rotation: number;
  shade: number;
}

export interface BuildingData {
  x: number;
  /** Base of the walls. */
  y: number;
  z: number;
  /** Along local X. */
  width: number;
  /** Along local Z (the roof ridge runs along this axis). */
  depth: number;
  wallHeight: number;
  roofHeight: number;
  heading: number;
  wallColor: number;
  roofColor: number;
}

export interface CellData {
  cellX: number;
  cellZ: number;
  trees: TreeData[];
  rocks: RockData[];
  buildings: BuildingData[];
  /** Highest point of any obstacle in the cell (collision early-out). */
  maxTop: number;
}

export interface PylonData {
  x: number;
  /** Base of the pylon. */
  y: number;
  z: number;
  height: number;
  /** Local +X (crossarm) runs along the valley. */
  heading: number;
}

export interface PowerLineData {
  z: number;
  heading: number;
  pylons: [PylonData, PylonData];
  /** Three cables, each a polyline of world-space points. */
  cables: Array<Array<[number, number, number]>>;
  lowestCableY: number;
  floorY: number;
  bounds: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
}

export interface ArchData {
  /** Center of the span (on the valley centerline). */
  x: number;
  z: number;
  /** Local +X spans across the valley, local Z runs along it. */
  heading: number;
  floorY: number;
  bottomY: number;
  springY: number;
  deckY: number;
  uLeft: number;
  uRight: number;
  openHalfWidth: number;
  openRise: number;
  halfDepth: number;
}

export interface Features {
  powerLines: PowerLineData[];
  arches: ArchData[];
}

/** Unit tree shapes (fractions of tree height). Shared by the renderer and collision. */
export const CONIFER_SHAPE = Object.freeze({
  trunkTop: 0.25,
  trunkRadius: 0.045,
  crownBase: 0.15,
  crownRadius: 0.3,
});
export const BROADLEAF_SHAPE = Object.freeze({
  trunkTop: 0.5,
  trunkRadius: 0.06,
  crownCenter: 0.62,
  crownRadius: 0.36,
});

export const CORRIDOR_HALF_WIDTH = 55;
export const PYLON_MIN_OFFSET = 110;
export const PYLON_MAX_OFFSET = 300;
export const PYLON_BASE_HALF = 4;
export const PYLON_ARM_HALF = 10;
export const CABLE_OFFSETS = [-7, 0, 7] as const;
export const CABLE_DROP = 2.5;
export const CABLE_HIT_RADIUS = 1.5;
const CABLE_SAMPLES = 32;
const MIN_CABLE_ABOVE_FLOOR = 70;

const ARCH_OPEN_HALF = 80;
const ARCH_OPEN_RISE = 72;
const ARCH_SPRING_DROP = 6;
const ARCH_DECK_ABOVE_FLOOR = 84;
const ARCH_HALF_DEPTH = 8;
const ARCH_MAX_HALF_SPAN = 450;

const MAX_TREE_ALTITUDE = 430;
const MAX_TREE_SLOPE = 0.6;

function hashCell(seed: number, cx: number, cz: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ Math.imul(cx, 0x27d4eb2d), 0xc2b2ae35);
  h = Math.imul(h ^ Math.imul(cz, 0x165667b1), 0x9e3779b1);
  h ^= h >>> 15;
  return h >>> 0;
}

const noiseCache = new Map<number, SimplexNoise2D>();
function forestNoise(seed: number): SimplexNoise2D {
  let n = noiseCache.get(seed);
  if (!n) {
    n = new SimplexNoise2D(mulberry32(seed ^ 0x5eed7ee5));
    noiseCache.set(seed, n);
  }
  return n;
}

/** Normalized [x, z] direction of the valley centerline at z (toward -Z). */
export function centerlineDirection(centerX: (z: number) => number, z: number): [number, number] {
  const dx = centerX(z - 1) - centerX(z + 1);
  const len = Math.hypot(dx, -2);
  return [dx / len, -2 / len];
}

/**
 * Horizontal distance from (x, z) to the valley centerline curve. Accurate (to ~2 m) when the
 * distance is below 320 m; otherwise returns a value ≥ 320.
 */
export function distanceToCenterline(centerX: (z: number) => number, x: number, z: number): number {
  const d0 = Math.abs(x - centerX(z));
  const window = Math.min(d0, 320);
  let best = d0;
  let bestDz = 0;
  for (let dz = -window; dz <= window; dz += 16) {
    const d = Math.hypot(x - centerX(z + dz), dz);
    if (d < best) {
      best = d;
      bestDz = dz;
    }
  }
  for (let dz = bestDz - 16; dz <= bestDz + 16; dz += 2) {
    const d = Math.hypot(x - centerX(z + dz), dz);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Rotated rectangle exclusion test in a precomputed, allocation-free form: the point is excluded
 * if |local x| < halfX + margin and |local z| < halfZ + margin (strict or inclusive, see `inclusive`).
 * Local axes: u = dx·cos(h) - dz·sin(h), w = dx·sin(h) + dz·cos(h) (heading about +Y, Three.js convention).
 */
interface Exclusion {
  ox: number;
  oz: number;
  c: number;
  s: number;
  /** Bounds on u and w (before margin). */
  uMin: number;
  uMax: number;
  wHalf: number;
  /** Clear zones use <=, features use <. */
  inclusive: boolean;
  /** Bounding radius (before margin) for a quick distance reject. */
  reach: number;
}

function clearZoneExclusion(zone: ClearZone): Exclusion {
  return {
    ox: zone.x,
    oz: zone.z,
    c: Math.cos(zone.heading),
    s: Math.sin(zone.heading),
    uMin: -zone.halfWidth,
    uMax: zone.halfWidth,
    wHalf: zone.halfLength,
    inclusive: true,
    reach: Math.hypot(zone.halfWidth, zone.halfLength),
  };
}

function featureExclusions(features: Features): Exclusion[] {
  const out: Exclusion[] = [];
  for (const line of features.powerLines) {
    const [p0, p1] = line.pylons;
    const halfSpan = Math.hypot(p1.x - p0.x, p1.z - p0.z) / 2;
    // u runs along the valley (|u| < 20), w across it between the pylons.
    out.push({
      ox: (p0.x + p1.x) / 2,
      oz: (p0.z + p1.z) / 2,
      c: Math.cos(line.heading),
      s: Math.sin(line.heading),
      uMin: -20,
      uMax: 20,
      wHalf: halfSpan + 15,
      inclusive: false,
      reach: Math.hypot(20, halfSpan + 15),
    });
  }
  for (const arch of features.arches) {
    // u spans the valley, |w| < halfDepth + 8.
    out.push({
      ox: arch.x,
      oz: arch.z,
      c: Math.cos(arch.heading),
      s: Math.sin(arch.heading),
      uMin: arch.uLeft - 8,
      uMax: arch.uRight + 8,
      wHalf: arch.halfDepth + 8,
      inclusive: false,
      reach: Math.hypot(Math.max(-arch.uLeft, arch.uRight) + 8, arch.halfDepth + 8),
    });
  }
  return out;
}

function excluded(list: readonly Exclusion[], x: number, z: number, margin: number): boolean {
  for (let k = 0; k < list.length; k++) {
    const e = list[k]!;
    const dx = x - e.ox;
    const dz = z - e.oz;
    const r = e.reach + margin * Math.SQRT2 + 1;
    if (dx * dx + dz * dz > r * r) continue;
    const u = dx * e.c - dz * e.s;
    const w = dx * e.s + dz * e.c;
    if (e.inclusive) {
      if (u >= e.uMin - margin && u <= e.uMax + margin && Math.abs(w) <= e.wHalf + margin) return true;
    } else if (u > e.uMin - margin && u < e.uMax + margin && Math.abs(w) < e.wHalf + margin) {
      return true;
    }
  }
  return false;
}

/** Exclusions that can affect points within `pad` of the square cell. */
function exclusionsNearCell(list: readonly Exclusion[], x0: number, z0: number, size: number, pad: number): Exclusion[] {
  return list.filter((e) => {
    const dx = Math.max(x0 - e.ox, 0, e.ox - (x0 + size));
    const dz = Math.max(z0 - e.oz, 0, e.oz - (z0 + size));
    return Math.hypot(dx, dz) <= e.reach + pad;
  });
}

const CENTERLINE_STEP = 2;
/** Covers the ±320 m search window plus the ±16 m refinement of distanceToCenterline(). */
const CENTERLINE_MARGIN = 344;

/**
 * Valley centerline tabulated every 2 m over one cell's search range, so distance queries use
 * table lookups instead of trigonometry. Linear interpolation error is well below a millimeter.
 */
class CenterlineTable {
  private readonly values: Float64Array;
  private readonly zStart: number;
  /** 1 / sqrt(1 + maxSlope²): the curve is at least d0 · factor away from a point d0 off it in x. */
  private readonly lowerBoundFactor: number;

  constructor(private readonly centerX: (z: number) => number, zMin: number, zMax: number) {
    this.zStart = Math.floor(zMin / CENTERLINE_STEP) * CENTERLINE_STEP;
    const n = Math.ceil((zMax - this.zStart) / CENTERLINE_STEP) + 2;
    this.values = new Float64Array(n);
    let maxSlope = 0;
    for (let k = 0; k < n; k++) {
      this.values[k] = centerX(this.zStart + k * CENTERLINE_STEP);
      if (k > 0) maxSlope = Math.max(maxSlope, Math.abs(this.values[k]! - this.values[k - 1]!) / CENTERLINE_STEP);
    }
    // Margin for slope variation inside a step.
    maxSlope += 0.05;
    this.lowerBoundFactor = 1 / Math.sqrt(1 + maxSlope * maxSlope);
  }

  at(z: number): number {
    const f = (z - this.zStart) / CENTERLINE_STEP;
    const k = Math.floor(f);
    if (k < 0 || k >= this.values.length - 1) return this.centerX(z);
    const a = this.values[k]!;
    return a + (this.values[k + 1]! - a) * (f - k);
  }

  /** Same contract and search as distanceToCenterline(), with a lower-bound shortcut far from the valley. */
  distance(x: number, z: number): number {
    const d0 = Math.abs(x - this.at(z));
    const lower = d0 * this.lowerBoundFactor;
    if (lower >= 330) return lower;
    const window = Math.min(d0, 320);
    let best = d0;
    let bestDz = 0;
    for (let dz = -window; dz <= window; dz += 16) {
      const dx = x - this.at(z + dz);
      const d2 = dx * dx + dz * dz;
      if (d2 < best * best) {
        best = Math.sqrt(d2);
        bestDz = dz;
      }
    }
    for (let dz = bestDz - 16; dz <= bestDz + 16; dz += 2) {
      const dx = x - this.at(z + dz);
      const d2 = dx * dx + dz * dz;
      if (d2 < best * best) best = Math.sqrt(d2);
    }
    return best;
  }
}

function slopeAt(heightAt: (x: number, z: number) => number, x: number, z: number): number {
  const e = 3;
  const gx = heightAt(x + e, z) - heightAt(x - e, z);
  const gz = heightAt(x, z + e) - heightAt(x, z - e);
  return Math.hypot(gx, gz) / (2 * e);
}

const featureCache = new WeakMap<PlacementOptions, Features>();
/** Power lines and arches for the given options (cached per options object). */
export function getFeatures(options: PlacementOptions): Features {
  let f = featureCache.get(options);
  if (!f) {
    f = {
      powerLines: (options.powerLineZ ?? []).map((z) => generatePowerLine(z, options)),
      arches: (options.archZ ?? []).map((z) => generateArch(z, options)),
    };
    featureCache.set(options, f);
  }
  return f;
}

interface ExclusionSet {
  zones: Exclusion[];
  features: Exclusion[];
}
const exclusionCache = new WeakMap<PlacementOptions, ExclusionSet>();
function getExclusions(options: PlacementOptions): ExclusionSet {
  let e = exclusionCache.get(options);
  if (!e) {
    e = { zones: (options.clearZones ?? []).map(clearZoneExclusion), features: featureExclusions(getFeatures(options)) };
    exclusionCache.set(options, e);
  }
  return e;
}

/** Power line crossing the valley at z: pylons on both rims, three sagging cables ≥ 70 m above the floor. */
export function generatePowerLine(z: number, options: PlacementOptions): PowerLineData {
  const { heightAt } = options;
  const cx = options.valleyCenterX(z);
  const [dx, dz] = centerlineDirection(options.valleyCenterX, z);
  const px = -dz;
  const pz = dx;
  const heading = Math.atan2(-dz, dx);
  const floorY = heightAt(cx, z);

  const pylons = ([-1, 1] as const).map((side): PylonData => {
    // Walk up the valley wall until the ground is high enough for the cables to clear the floor.
    let offset = PYLON_MIN_OFFSET;
    while (offset < PYLON_MAX_OFFSET && heightAt(cx + px * side * offset, z + pz * side * offset) < floorY + 55) offset += 5;
    const x = cx + px * side * offset;
    const pzz = z + pz * side * offset;
    const ground = heightAt(x, pzz);
    const base = ground - 1;
    const attach = Math.max(ground + 30, floorY + MIN_CABLE_ABOVE_FLOOR + 12);
    return { x, y: base, z: pzz, height: attach - base + CABLE_DROP, heading };
  }) as [PylonData, PylonData];

  const [p0, p1] = pylons;
  const a0 = p0.y + p0.height - CABLE_DROP;
  const a1 = p1.y + p1.height - CABLE_DROP;
  const cableY = (t: number, sag: number): number => a0 + (a1 - a0) * t - sag * 4 * t * (1 - t);
  const groundSamples: number[] = [];
  for (let i = 0; i <= CABLE_SAMPLES; i++) {
    const t = i / CABLE_SAMPLES;
    groundSamples.push(heightAt(p0.x + (p1.x - p0.x) * t, p0.z + (p1.z - p0.z) * t));
  }
  const clearanceOk = (sag: number): boolean => {
    for (let i = 0; i <= CABLE_SAMPLES; i++) {
      const y = cableY(i / CABLE_SAMPLES, sag);
      if (y < floorY + MIN_CABLE_ABOVE_FLOOR || y < groundSamples[i]! + 12) return false;
    }
    return true;
  };
  let sag = 0;
  if (clearanceOk(0)) {
    let lo = 0;
    let hi = 150;
    if (clearanceOk(hi)) lo = hi;
    else {
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (clearanceOk(mid)) lo = mid;
        else hi = mid;
      }
    }
    sag = lo;
  }

  const cables = CABLE_OFFSETS.map((offset) => {
    const pts: Array<[number, number, number]> = [];
    for (let i = 0; i <= CABLE_SAMPLES; i++) {
      const t = i / CABLE_SAMPLES;
      pts.push([
        p0.x + (p1.x - p0.x) * t + dx * offset,
        cableY(t, sag),
        p0.z + (p1.z - p0.z) * t + dz * offset,
      ]);
    }
    return pts;
  });

  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  const grow = (x: number, y: number, zz: number): void => {
    bounds.minX = Math.min(bounds.minX, x - 15);
    bounds.maxX = Math.max(bounds.maxX, x + 15);
    bounds.minY = Math.min(bounds.minY, y - 5);
    bounds.maxY = Math.max(bounds.maxY, y + 5);
    bounds.minZ = Math.min(bounds.minZ, zz - 15);
    bounds.maxZ = Math.max(bounds.maxZ, zz + 15);
  };
  for (const p of pylons) {
    grow(p.x, p.y, p.z);
    grow(p.x, p.y + p.height, p.z);
  }
  let lowestCableY = Infinity;
  for (const cable of cables) {
    for (const [x, y, zz] of cable) {
      grow(x, y, zz);
      lowestCableY = Math.min(lowestCableY, y);
    }
  }
  return { z, heading, pylons, cables, lowestCableY, floorY, bounds };
}

/** Stone arch bridge spanning the valley at z, perpendicular to the valley direction. */
export function generateArch(z: number, options: PlacementOptions): ArchData {
  const { heightAt } = options;
  const cx = options.valleyCenterX(z);
  const [dx, dz] = centerlineDirection(options.valleyCenterX, z);
  const px = -dz;
  const pz = dx;
  const heading = Math.atan2(-pz, px);
  const floorY = heightAt(cx, z);
  const deckY = floorY + ARCH_DECK_ABOVE_FLOOR;
  const springY = floorY - ARCH_SPRING_DROP;

  const reach = (side: number): number => {
    for (let u = ARCH_OPEN_HALF + 10; u < ARCH_MAX_HALF_SPAN; u += 5) {
      if (heightAt(cx + px * side * u, z + pz * side * u) >= deckY + 3) return Math.min(u + 12, ARCH_MAX_HALF_SPAN);
    }
    return ARCH_MAX_HALF_SPAN;
  };
  return {
    x: cx,
    z,
    heading,
    floorY,
    bottomY: springY,
    springY,
    deckY,
    uLeft: -reach(-1),
    uRight: reach(1),
    openHalfWidth: ARCH_OPEN_HALF,
    openRise: ARCH_OPEN_RISE,
    halfDepth: ARCH_HALF_DEPTH,
  };
}

/** Height of the arch opening's intrados at span coordinate u (or -Infinity outside the opening). */
export function archOpeningTop(arch: ArchData, u: number): number {
  const t = u / arch.openHalfWidth;
  if (Math.abs(t) >= 1) return -Infinity;
  return arch.springY + arch.openRise * Math.sqrt(1 - t * t);
}

const HOUSE_WALLS = [0xf1ece0, 0xe8dcc0, 0xd9d2c5, 0xb8562f, 0xc9b48f];
const ROOFS = [0x7a2e22, 0x5b4a42, 0x8a3b26, 0x4c5156];

/** Deterministically generates the trees, rocks and buildings of one square cell. */
export function generateCell(cellX: number, cellZ: number, cellSize: number, options: PlacementOptions): CellData {
  const rand = mulberry32(hashCell(options.seed, cellX, cellZ));
  const noise = forestNoise(options.seed);
  const density = options.density ?? 1;
  const { heightAt } = options;
  const x0 = cellX * cellSize;
  const z0 = cellZ * cellSize;
  const area = cellSize * cellSize;
  const centerline = new CenterlineTable(options.valleyCenterX, z0 - CENTERLINE_MARGIN, z0 + cellSize + CENTERLINE_MARGIN);
  const allExclusions = getExclusions(options);
  // Largest margin used below is 40 m (farm), scaled for the rectangle corners.
  const zones = exclusionsNearCell(allExclusions.zones, x0, z0, cellSize, 64);
  const featureZones = exclusionsNearCell(allExclusions.features, x0, z0, cellSize, 64);
  const trees: TreeData[] = [];
  const rocks: RockData[] = [];
  const buildings: BuildingData[] = [];
  let maxTop = -Infinity;

  // Every candidate always consumes the same number of random values, so a lower density
  // yields a prefix (subset) of the full-density trees.
  const treeCount = Math.round((area / 550) * density);
  for (let i = 0; i < treeCount; i++) {
    const x = x0 + rand() * cellSize;
    const z = z0 + rand() * cellSize;
    const rAccept = rand();
    const rKind = rand();
    const rHeight = rand();
    const rWidth = rand();
    const rRot = rand();
    const t0 = rand();
    const t1 = rand();
    const t2 = rand();

    // Cheap rejections first; every test is an independent rejection, so the order doesn't change the result.
    const dist = centerline.distance(x, z);
    if (dist < CORRIDOR_HALF_WIDTH + 4) continue;
    const forest = smoothstep(-0.25, 0.35, noise.fbm(x, z, 3, 1 / 650));
    const edgeBoost = 0.65 * (1 - smoothstep(110, 280, dist));
    const baseProb = Math.min(1, forest * 0.9 + edgeBoost);
    if (rAccept >= baseProb) continue;
    const ground = heightAt(x, z);
    if (ground > MAX_TREE_ALTITUDE) continue;
    let prob = baseProb * (1 - smoothstep(330, MAX_TREE_ALTITUDE, ground));
    if (rAccept >= prob) continue;
    const kind: TreeKind = rKind < 0.3 + 0.55 * smoothstep(60, 320, ground) ? 'conifer' : 'broadleaf';
    const height = kind === 'conifer' ? 9 + rHeight * 13 : 7 + rHeight * 8;
    const widthScale = 0.8 + rWidth * 0.45;
    const crownR = height * widthScale * (kind === 'conifer' ? CONIFER_SHAPE.crownRadius : BROADLEAF_SHAPE.crownRadius);
    if (dist < CORRIDOR_HALF_WIDTH + crownR + 4) continue;
    if (excluded(zones, x, z, crownR + 5) || excluded(featureZones, x, z, crownR)) continue;
    const slope = slopeAt(heightAt, x, z);
    if (slope > MAX_TREE_SLOPE) continue;
    prob *= 1 - smoothstep(0.35, MAX_TREE_SLOPE, slope);
    if (rAccept >= prob) continue;

    const tint: [number, number, number] =
      kind === 'conifer'
        ? [0.8 + t0 * 0.3, 0.85 + t1 * 0.3, 0.8 + t2 * 0.25]
        : [0.85 + t0 * 0.4, 0.85 + t1 * 0.3, 0.75 + t2 * 0.3];
    const y = ground - 0.4;
    trees.push({ kind, x, y, z, height, widthScale, rotation: rRot * Math.PI * 2, tint });
    maxTop = Math.max(maxTop, y + height);
  }

  const rockCount = Math.round((area / 5000) * density);
  for (let i = 0; i < rockCount; i++) {
    const x = x0 + rand() * cellSize;
    const z = z0 + rand() * cellSize;
    const rAccept = rand();
    const rSize = rand();
    const rSquash = rand();
    const rRot = rand();
    const rShade = rand();

    const radius = rSize < 0.85 ? 1.5 + rSize * 4 : 6 + (rSize - 0.85) * 20;
    // Acceptance is 0.15 + 0.7 · smoothstep(slope) ∈ [0.15, 0.85]: the slope only matters in between.
    if (rAccept >= 0.85) continue;
    const dist = centerline.distance(x, z);
    if (dist < CORRIDOR_HALF_WIDTH + radius + 4) continue;
    if (excluded(zones, x, z, radius + 5) || excluded(featureZones, x, z, radius)) continue;
    const ground = heightAt(x, z);
    if (ground > 650) continue;
    if (rAccept >= 0.15 && rAccept >= 0.15 + 0.7 * smoothstep(0.25, 0.8, slopeAt(heightAt, x, z))) continue;
    const squash = 0.55 + rSquash * 0.35;
    const y = ground + radius * squash * 0.3;
    rocks.push({ x, y, z, radius, squash, rotation: rRot * Math.PI * 2, shade: 0.75 + rShade * 0.35 });
    maxTop = Math.max(maxTop, y + radius * squash);
  }

  const rFarm = rand();
  const fx = x0 + 40 + rand() * (cellSize - 80);
  const fz = z0 + 40 + rand() * (cellSize - 80);
  const farmHeading = rand() * Math.PI * 2;
  const farmRandoms = new Float64Array(3 * 6);
  for (let k = 0; k < farmRandoms.length; k++) farmRandoms[k] = rand();
  if (rFarm < 0.32 * Math.min(1, density * 1.4)) {
    if (
      !excluded(zones, fx, fz, 40) &&
      !excluded(featureZones, fx, fz, 40) &&
      centerline.distance(fx, fz) > 320 &&
      heightAt(fx, fz) < 280 &&
      slopeAt(heightAt, fx, fz) < 0.12
    ) {
      const count = 1 + Math.floor(farmRandoms[0]! * 3);
      for (let b = 0; b < count; b++) {
        const r = (k: number): number => farmRandoms[b * 6 + k]!;
        const barn = b > 0 && r(1) < 0.6;
        const width = barn ? 12 + r(2) * 6 : 8 + r(2) * 4;
        const depth = barn ? 18 + r(3) * 8 : 10 + r(3) * 4;
        const wallHeight = barn ? 6 + r(4) * 3 : 5 + r(4) * 2;
        const roofHeight = barn ? 4 + r(5) * 2 : 3 + r(5) * 2;
        const heading = farmHeading + (b === 0 ? 0 : (Math.PI / 2) * Math.round(r(1) * 3));
        const angle = farmHeading + b * 2.1;
        const off = b === 0 ? 0 : 24 + r(5) * 10;
        const x = fx + Math.cos(angle) * off;
        const z = fz + Math.sin(angle) * off;
        if (excluded(zones, x, z, 15) || slopeAt(heightAt, x, z) > 0.2) continue;
        const c = Math.cos(heading);
        const s = Math.sin(heading);
        let base = Infinity;
        for (const [lx, lz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
          const wx = (lx * width) / 2;
          const wz = (lz * depth) / 2;
          base = Math.min(base, heightAt(x + wx * c + wz * s, z - wx * s + wz * c));
        }
        base -= 0.5;
        const walls = wallHeight + (heightAt(x, z) - base);
        buildings.push({
          x,
          y: base,
          z,
          width,
          depth,
          wallHeight: walls,
          roofHeight,
          heading,
          wallColor: barn ? (r(2) < 0.5 ? 0x9c3b2a : 0x8a6a4a) : HOUSE_WALLS[Math.floor(r(2) * HOUSE_WALLS.length)]!,
          roofColor: ROOFS[Math.floor(r(3) * ROOFS.length)]!,
        });
        maxTop = Math.max(maxTop, base + walls + roofHeight);
      }
    }
  }

  return { cellX, cellZ, trees, rocks, buildings, maxTop };
}

/** Tree hit test (kind 0 = conifer, 1 = broadleaf); (tx, ty, tz) is the trunk base. */
export function collideTreeAt(
  kind: number, tx: number, ty: number, tz: number, height: number, widthScale: number,
  x: number, y: number, z: number,
): boolean {
  const h = (y - ty) / height;
  if (h < 0 || h > 1) return false;
  // Horizontal distance in units of (height * widthScale), vertical in units of height.
  const r = Math.hypot(x - tx, z - tz) / (height * widthScale);
  if (kind === 0) {
    if (h <= CONIFER_SHAPE.trunkTop && r <= CONIFER_SHAPE.trunkRadius) return true;
    if (h < CONIFER_SHAPE.crownBase) return false;
    return r <= CONIFER_SHAPE.crownRadius * (1 - (h - CONIFER_SHAPE.crownBase) / (1 - CONIFER_SHAPE.crownBase));
  }
  if (h <= BROADLEAF_SHAPE.trunkTop && r <= BROADLEAF_SHAPE.trunkRadius) return true;
  const R = BROADLEAF_SHAPE.crownRadius * 0.9;
  const dy = h - BROADLEAF_SHAPE.crownCenter;
  return r * r + dy * dy <= R * R;
}

/** Squashed-ellipsoid rock hit test; (rx, ry, rz) is the rock center. */
export function collideRockAt(
  rx: number, ry: number, rz: number, radius: number, squash: number,
  x: number, y: number, z: number,
): boolean {
  const k = radius * 0.9;
  const dx = (x - rx) / k;
  const dy = (y - ry) / (k * squash);
  const dz = (z - rz) / k;
  return dx * dx + dy * dy + dz * dz <= 1;
}

function insideBox(
  x: number, y: number, z: number,
  ox: number, oy: number, oz: number,
  halfX: number, halfZ: number, height: number, heading: number,
): boolean {
  if (y < oy || y > oy + height) return false;
  const dx = x - ox;
  const dz = z - oz;
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  return Math.abs(dx * c - dz * s) <= halfX && Math.abs(dx * s + dz * c) <= halfZ;
}

/** Building hit test (walls plus the lower part of the roof). */
export function collideBuildingAt(
  bx: number, by: number, bz: number, width: number, depth: number, wallHeight: number, roofHeight: number, heading: number,
  x: number, y: number, z: number,
): boolean {
  return insideBox(x, y, z, bx, by, bz, width / 2, depth / 2, wallHeight + roofHeight * 0.6, heading);
}

/** Obstacle hit by the point among the cell's trees, rocks and buildings, or null. */
export function collideCell(cell: CellData, x: number, y: number, z: number): ObstacleKind | null {
  if (y > cell.maxTop + 1) return null;
  for (const t of cell.trees) {
    const reach = t.height * t.widthScale * 0.4;
    if (Math.abs(x - t.x) > reach || Math.abs(z - t.z) > reach) continue;
    if (collideTreeAt(t.kind === 'conifer' ? 0 : 1, t.x, t.y, t.z, t.height, t.widthScale, x, y, z)) return 'tree';
  }
  for (const r of cell.rocks) {
    if (Math.abs(x - r.x) > r.radius || Math.abs(z - r.z) > r.radius) continue;
    if (collideRockAt(r.x, r.y, r.z, r.radius, r.squash, x, y, z)) return 'rock';
  }
  for (const b of cell.buildings) {
    if (Math.abs(x - b.x) > 25 || Math.abs(z - b.z) > 25) continue;
    if (collideBuildingAt(b.x, b.y, b.z, b.width, b.depth, b.wallHeight, b.roofHeight, b.heading, x, y, z)) return 'building';
  }
  return null;
}

function distanceToSegmentSq(
  x: number, y: number, z: number,
  a: readonly [number, number, number], b: readonly [number, number, number],
): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = len2 > 0 ? ((x - a[0]) * abx + (y - a[1]) * aby + (z - a[2]) * abz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = x - (a[0] + abx * t);
  const dy = y - (a[1] + aby * t);
  const dz = z - (a[2] + abz * t);
  return dx * dx + dy * dy + dz * dz;
}

/** True if the point is inside a pylon / crossarm or within CABLE_HIT_RADIUS of a cable. */
export function collidePowerLine(line: PowerLineData, x: number, y: number, z: number): boolean {
  const b = line.bounds;
  if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY || z < b.minZ || z > b.maxZ) return false;
  for (const p of line.pylons) {
    if (insideBox(x, y, z, p.x, p.y, p.z, PYLON_BASE_HALF + 0.5, PYLON_BASE_HALF + 0.5, p.height, p.heading)) return true;
    if (insideBox(x, y, z, p.x, p.y + p.height - CABLE_DROP - 1, p.z, PYLON_ARM_HALF + 0.5, 1, CABLE_DROP + 1, p.heading)) return true;
  }
  const r2 = CABLE_HIT_RADIUS * CABLE_HIT_RADIUS;
  for (const cable of line.cables) {
    for (let i = 0; i < cable.length - 1; i++) {
      if (distanceToSegmentSq(x, y, z, cable[i]!, cable[i + 1]!) <= r2) return true;
    }
  }
  return false;
}

/** True if the point is inside the arch's stone (not in its opening). */
export function collideArch(arch: ArchData, x: number, y: number, z: number): boolean {
  if (y < arch.bottomY || y > arch.deckY) return false;
  const dx = x - arch.x;
  const dz = z - arch.z;
  if (Math.abs(dx) > ARCH_MAX_HALF_SPAN + arch.halfDepth || Math.abs(dz) > ARCH_MAX_HALF_SPAN + arch.halfDepth) return false;
  const c = Math.cos(arch.heading);
  const s = Math.sin(arch.heading);
  const u = dx * c - dz * s;
  const w = dx * s + dz * c;
  if (Math.abs(w) > arch.halfDepth || u < arch.uLeft || u > arch.uRight) return false;
  return y >= archOpeningTop(arch, u);
}
