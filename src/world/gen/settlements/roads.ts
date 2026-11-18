import type { CitySite, TerrainSampler } from '../WorldGenerator';
import { BRIDGE_CLEARANCE, DECK_THICKNESS, PIER_HALF, ROAD_HALF_WIDTH } from './types';
import type { BridgeSpan, Pier, Road, RoadPiece } from './types';

/** Cities farther apart than this are never linked. */
export const MAX_LINK = 16000;
/** Each city is linked to this many nearest neighbours. */
export const LINKS_PER_CITY = 2;
/** Largest sideways detour of a road from the straight line between its cities. */
export const MAX_DETOUR = 1200;
/** Roads crossing more water than this (m) are not built. */
const MAX_WATER_LENGTH = 1600;
const NODE_SPACING = 250;
const OFFSET_STEPS = 4;
/** Distance (m) between road samples: the length of a RoadPiece. */
export const ROAD_STEP = 40;
/** Steepest road grade. */
export const MAX_GRADE = 0.07;
/** Cost of one meter of climbing, in meters of road. */
const CLIMB_COST = 12;
/** Extra cost per meter of water crossed. */
const WATER_COST = 4;
/** The road leaves the street grid at this fraction of the city radius. */
const CITY_EXIT = 0.95;
/** Road higher than this above the natural ground is carried by a bridge / viaduct. */
export const BRIDGE_FILL = 7;
const PIER_SPACING = 70;
const LOW_BRIDGE_CLEARANCE = 10;

type Point = [number, number];

/** The (up to) LINKS_PER_CITY nearest cities of `city` among `others` within MAX_LINK. */
export function nearestNeighbours(city: CitySite, others: readonly CitySite[]): CitySite[] {
  return others
    .filter((o) => o.id !== city.id && Math.hypot(o.x - city.x, o.z - city.z) <= MAX_LINK)
    .map((o) => ({ o, d: Math.hypot(o.x - city.x, o.z - city.z) }))
    .sort((p, q) => p.d - q.d || p.o.id - q.o.id)
    .slice(0, LINKS_PER_CITY)
    .map((p) => p.o);
}

export function roadKey(a: CitySite, b: CitySite): string {
  return a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
}

function isWet(terrain: TerrainSampler, x: number, z: number, h: number): boolean {
  return terrain.waterLevelAt(x, z) > h - 0.5;
}

/**
 * Picks a path between the two city exits that bends around high ground and water: nodes every
 * ~250 m, each with a sideways offset chosen by dynamic programming (length + climbing + water cost).
 */
export function routeRoad(terrain: TerrainSampler, start: Point, end: Point): Point[] {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const length = Math.hypot(dx, dz);
  if (length < NODE_SPACING * 2) return [start, end];
  const ux = dx / length;
  const uz = dz / length;
  const nx = -uz;
  const nz = ux;
  const nodes = Math.ceil(length / NODE_SPACING);
  const maxOffset = Math.min(MAX_DETOUR, length * 0.3);
  const k = OFFSET_STEPS * 2 + 1;
  const pos = (n: number, o: number): Point => {
    const t = n / nodes;
    const off = ((o - OFFSET_STEPS) / OFFSET_STEPS) * maxOffset;
    return [start[0] + dx * t + nx * off, start[1] + dz * t + nz * off];
  };
  const allowed = (n: number, o: number): boolean => {
    const off = Math.abs(((o - OFFSET_STEPS) / OFFSET_STEPS) * maxOffset);
    return off <= Math.min(n, nodes - n) * NODE_SPACING * 0.7 + 1e-6;
  };
  const heights = new Float64Array((nodes + 1) * k);
  const wet = new Uint8Array((nodes + 1) * k);
  for (let n = 0; n <= nodes; n++) {
    for (let o = 0; o < k; o++) {
      if (!allowed(n, o)) continue;
      const [x, z] = pos(n, o);
      const h = terrain.baseHeightAt(x, z);
      heights[n * k + o] = h;
      wet[n * k + o] = isWet(terrain, x, z, h) ? 1 : 0;
    }
  }
  const cost = new Float64Array((nodes + 1) * k).fill(Infinity);
  const from = new Int8Array((nodes + 1) * k).fill(-1);
  cost[OFFSET_STEPS] = 0;
  for (let n = 1; n <= nodes; n++) {
    for (let o = 0; o < k; o++) {
      if (!allowed(n, o)) continue;
      const [x1, z1] = pos(n, o);
      const h1 = heights[n * k + o]!;
      for (let p = Math.max(0, o - 1); p <= Math.min(k - 1, o + 1); p++) {
        const prev = cost[(n - 1) * k + p]!;
        if (prev === Infinity) continue;
        const [x0, z0] = pos(n - 1, p);
        const h0 = heights[(n - 1) * k + p]!;
        const mx = (x0 + x1) / 2;
        const mz = (z0 + z1) / 2;
        const hm = terrain.baseHeightAt(mx, mz);
        const seg = Math.hypot(x1 - x0, z1 - z0);
        const water = (wet[(n - 1) * k + p]! + wet[n * k + o]! + 2 * (isWet(terrain, mx, mz, hm) ? 1 : 0)) / 4;
        const c = prev + seg + CLIMB_COST * (Math.abs(hm - h0) + Math.abs(h1 - hm)) + WATER_COST * seg * water;
        if (c < cost[n * k + o]!) {
          cost[n * k + o] = c;
          from[n * k + o] = p;
        }
      }
    }
  }
  const offsets: number[] = new Array(nodes + 1);
  offsets[nodes] = OFFSET_STEPS;
  for (let n = nodes; n > 0; n--) offsets[n - 1] = from[n * k + offsets[n]!]!;
  const path: Point[] = [];
  for (let n = 0; n <= nodes; n++) path.push(n === 0 ? start : n === nodes ? end : pos(n, offsets[n]!));
  return path;
}

/** Chaikin corner cutting (end points kept). */
export function smoothPath(path: readonly Point[], iterations = 2): Point[] {
  let p = [...path];
  for (let it = 0; it < iterations; it++) {
    if (p.length < 3) return p;
    const out: Point[] = [p[0]!];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i]!;
      const b = p[i + 1]!;
      if (i > 0) out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      if (i < p.length - 2) out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    out.push(p[p.length - 1]!);
    p = out;
  }
  return p;
}

/** Points every ~`step` m along the polyline (first and last point kept). */
export function resample(path: readonly Point[], step: number): Point[] {
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1]! + Math.hypot(path[i]![0] - path[i - 1]![0], path[i]![1] - path[i - 1]![1]));
  const total = cum[cum.length - 1]!;
  const count = Math.max(1, Math.round(total / step));
  const out: Point[] = [];
  let seg = 0;
  for (let n = 0; n <= count; n++) {
    const s = (n / count) * total;
    while (seg < path.length - 2 && cum[seg + 1]! < s) seg++;
    const a = path[seg]!;
    const b = path[seg + 1] ?? a;
    const len = cum[seg + 1]! - cum[seg]!;
    const t = len > 0 ? (s - cum[seg]!) / len : 0;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

/**
 * Smooth, grade-limited road surface heights: the natural ground smoothed and clamped to MAX_GRADE
 * (cut and fill), city ends at the city level, then raised over water so the deck clears it by
 * BRIDGE_CLEARANCE when the ramps from both ends allow it (at least LOW_BRIDGE_CLEARANCE otherwise).
 */
export function roadProfile(ground: Float64Array, water: Float64Array, ds: number, startY: number, endY: number): Float64Array {
  const m = ground.length;
  const wet = (i: number): boolean => water[i]! > ground[i]! - 0.5;
  const target = new Float64Array(m);
  for (let i = 0; i < m; i++) target[i] = wet(i) ? water[i]! + 1 : ground[i]!;
  const y = new Float64Array(m);
  const w = 5;
  for (let i = 0; i < m; i++) {
    let sum = 0;
    let n = 0;
    for (let k = Math.max(0, i - w); k <= Math.min(m - 1, i + w); k++) {
      sum += target[k]!;
      n++;
    }
    y[i] = sum / n;
  }
  y[0] = startY;
  y[m - 1] = endY;
  const g = MAX_GRADE * ds;
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < m - 1; i++) y[i] = Math.min(Math.max(y[i]!, y[i - 1]! - g), y[i - 1]! + g);
    for (let i = m - 2; i > 0; i--) y[i] = Math.min(Math.max(y[i]!, y[i + 1]! - g), y[i + 1]! + g);
  }
  const wantDeck = BRIDGE_CLEARANCE + DECK_THICKNESS + 0.5;
  for (let i = 1; i < m - 1; i++) {
    if (!wet(i)) continue;
    const cap = Math.min(startY + g * i, endY + g * (m - 1 - i));
    y[i] = Math.max(y[i]!, Math.max(water[i]! + LOW_BRIDGE_CLEARANCE + DECK_THICKNESS, Math.min(water[i]! + wantDeck, cap)));
  }
  for (let i = 1; i < m - 1; i++) y[i] = Math.max(y[i]!, y[i - 1]! - g);
  for (let i = m - 2; i > 0; i--) y[i] = Math.max(y[i]!, y[i + 1]! - g);
  return y;
}

/** Exit point of a city toward (tx, tz). */
function cityExit(city: CitySite, tx: number, tz: number): Point {
  const d = Math.hypot(tx - city.x, tz - city.z) || 1;
  const r = city.radius * CITY_EXIT;
  return [city.x + ((tx - city.x) / d) * r, city.z + ((tz - city.z) / d) * r];
}

/** Builds the road between two cities (null if it would cross too much water). Depends only on a, b and the terrain. */
export function buildRoad(terrain: TerrainSampler, c0: CitySite, c1: CitySite): Road | null {
  const [a, b] = c0.id < c1.id ? [c0, c1] : [c1, c0];
  const start = cityExit(a, b.x, b.z);
  const end = cityExit(b, a.x, a.z);
  const pts = resample(smoothPath(routeRoad(terrain, start, end)), ROAD_STEP);
  const m = pts.length;
  const ground = new Float64Array(m);
  const water = new Float64Array(m);
  let wetLength = 0;
  const ds = Math.hypot(pts[1]![0] - pts[0]![0], pts[1]![1] - pts[0]![1]);
  for (let i = 0; i < m; i++) {
    const [x, z] = pts[i]!;
    ground[i] = terrain.baseHeightAt(x, z);
    water[i] = terrain.waterLevelAt(x, z);
    if (water[i]! > ground[i]! - 0.5) wetLength += ds;
  }
  if (wetLength > MAX_WATER_LENGTH) return null;
  const y = roadProfile(ground, water, ds, a.groundY, b.groundY);
  const elevated = (i: number): boolean => water[i]! > ground[i]! - 0.5 || y[i]! - ground[i]! > BRIDGE_FILL;

  const pieces: RoadPiece[] = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < m - 1; i++) {
    const [ax, az] = pts[i]!;
    const [bx, bz] = pts[i + 1]!;
    const bridge = elevated(i) || elevated(i + 1);
    const piece: RoadPiece = {
      ax, az, bx, bz,
      halfWidth: ROAD_HALF_WIDTH,
      bridge,
      ay: y[i]!,
      by: y[i + 1]!,
      roadA: a.id,
      roadB: b.id,
      index: i,
    };
    if (bridge) piece.deckY = Math.min(piece.ay, piece.by);
    pieces.push(piece);
    minX = Math.min(minX, ax, bx);
    maxX = Math.max(maxX, ax, bx);
    minZ = Math.min(minZ, az, bz);
    maxZ = Math.max(maxZ, az, bz);
  }
  const key = roadKey(a, b);
  const bridges = findBridges(key, pts, y, ground, water, pieces);
  return { key, pieces, bridges, minX, maxX, minZ, maxZ };
}

/** Groups consecutive bridge pieces into BridgeSpans, with a pier-free opening over the water. */
function findBridges(
  key: string, pts: readonly Point[], y: Float64Array, ground: Float64Array, water: Float64Array, pieces: readonly RoadPiece[],
): BridgeSpan[] {
  const out: BridgeSpan[] = [];
  let i = 0;
  while (i < pieces.length) {
    if (!pieces[i]!.bridge) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < pieces.length && pieces[j + 1]!.bridge) j++;
    out.push(makeBridge(key, pts, y, ground, water, pieces.slice(i, j + 1), i, j + 1));
    i = j + 1;
  }
  return out;
}

function makeBridge(
  key: string, pts: readonly Point[], y: Float64Array, ground: Float64Array, water: Float64Array,
  pieces: RoadPiece[], first: number, last: number,
): BridgeSpan {
  const wet = (k: number): boolean => water[k]! > ground[k]! - 0.5;
  let w0 = -1;
  let w1 = -1;
  let bottomY = -Infinity;
  for (let k = first; k <= last; k++) {
    if (!wet(k)) continue;
    if (w0 < 0) w0 = k;
    w1 = k;
    bottomY = Math.max(bottomY, water[k]!);
  }
  let center: number;
  if (w0 >= 0) {
    center = (w0 + w1) / 2;
  } else {
    // Viaduct over a dip: centred on its highest point above the ground.
    center = first;
    for (let k = first; k <= last; k++) if (y[k]! - ground[k]! > y[center]! - ground[center]!) center = k;
    bottomY = Infinity;
    for (let k = first; k <= last; k++) bottomY = Math.min(bottomY, ground[k]!);
  }
  const ds = Math.hypot(pts[1]![0] - pts[0]![0], pts[1]![1] - pts[0]![1]);
  const at = (s: number): Point => {
    const k = Math.min(Math.max(Math.floor(s), 0), pts.length - 2);
    const t = s - k;
    return [pts[k]![0] + (pts[k + 1]![0] - pts[k]![0]) * t, pts[k]![1] + (pts[k + 1]![1] - pts[k]![1]) * t];
  };
  const valueAt = (arr: Float64Array, s: number): number => {
    const k = Math.min(Math.max(Math.floor(s), 0), arr.length - 2);
    return arr[k]! + (arr[k + 1]! - arr[k]!) * (s - k);
  };
  const [cx, cz] = at(center);
  const k0 = Math.min(Math.floor(center), pts.length - 2);
  const heading = Math.atan2(pts[k0 + 1]![0] - pts[k0]![0], pts[k0 + 1]![1] - pts[k0]![1]);
  const waterHalf = w0 >= 0 ? ((w1 - w0) / 2) * ds : 0;
  const openHalfWidth = Math.min(110, Math.max(45, waterHalf + 15));
  const piers: Pier[] = [];
  for (const dir of [-1, 1]) {
    // Pier faces stay outside the opening (also where the deck curves a little).
    for (let off = openHalfWidth + PIER_HALF + 1; ; off += PIER_SPACING) {
      const s = center + (dir * off) / ds;
      // No pier within 20 m of an abutment.
      if (s <= first + 20 / ds || s >= last - 20 / ds) break;
      const [px, pz] = at(s);
      const topY = valueAt(y, s) - DECK_THICKNESS;
      const bottom = valueAt(ground, s) - 2;
      if (topY - bottom > 2) piers.push({ x: px, z: pz, bottomY: bottom, topY });
    }
  }
  return {
    key: `${key}:${first}`,
    x: cx,
    z: cz,
    heading,
    halfSpan: (Math.max(center - first, last - center) * ds),
    bottomY,
    deckY: valueAt(y, center) - DECK_THICKNESS,
    openHalfWidth,
    halfWidth: ROAD_HALF_WIDTH,
    pieces,
    piers,
  };
}
