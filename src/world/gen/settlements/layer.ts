import type { RunwayRect } from '../../terrain/HeightField';
import type { BridgeSite, CitySite, RoadSegment, SettlementLayer, SpawnPoint, TerrainSampler } from '../WorldGenerator';
import { AIRFIELD_MARGIN_X, AIRFIELD_MARGIN_Z, airfieldNearCity, airfieldOnSpiral } from './airfield';
import { cityInCell } from './cities';
import { cityPavedAt } from './cityLayout';
import { BRIDGE_FILL, MAX_DETOUR, buildRoad, nearestNeighbours, roadKey } from './roads';
import { BoundedCache, MACRO_CELL, ROAD_HALF_WIDTH, comparePieces, macroKey, segmentDistance, smooth01 } from './types';
import type { BridgeSpan, Road, RoadPiece } from './types';

/** Largest city blend ring past the radius (m). */
const CITY_BLEND_MAX = 400;
const ROAD_SHOULDER = 4;
const ROAD_BLEND_MAX = 140;
/** Farthest a road piece flattens the ground from its centreline. */
const ROAD_REACH = ROAD_HALF_WIDTH + ROAD_SHOULDER + ROAD_BLEND_MAX;
const AIRFIELD_BLEND_MAX = 450;
/** Spatial hash inside a macro cell. */
const BIN = 250;
const BINS = Math.ceil(MACRO_CELL / BIN);
/** Cities are searched this many macro cells around a city for its nearest neighbours. */
const LINK_CELLS = Math.ceil((MACRO_CELL * 0.4 + 16000) / MACRO_CELL);
/** Air start distance in front of the runway's -Z end. */
export const AIR_SPAWN_DISTANCE = 1250;

/** Everything that shapes or paves the ground inside one macro cell, binned for point queries. */
interface CellIndex {
  cities: CitySite[];
  pieces: RoadPiece[];
  bridges: BridgeSpan[];
  /** bins[b] .. bins[b + 1] index into binItems (piece indices, in comparePieces order). */
  binStart: Int32Array;
  binItems: Int32Array;
}

const _t = new Float64Array(1);

function cellOf(id: number): [number, number] {
  return [Math.floor(id / 65536) - 32768, (id % 65536) - 32768];
}

function rectOverlaps(minX: number, maxX: number, minZ: number, maxZ: number, x0: number, z0: number, size: number): boolean {
  return maxX >= x0 && minX <= x0 + size && maxZ >= z0 && minZ <= z0 + size;
}

/**
 * Infinite, deterministic settlement layer: cities on a jittered macro grid, roads to each city's
 * nearest neighbours (bridges over water), and the airfield next to the city nearest the origin.
 * All data is computed lazily per macro cell and kept in bounded caches.
 */
export class Settlements implements SettlementLayer {
  readonly airfield: RunwayRect;
  readonly airSpawn: SpawnPoint;
  private readonly cityCache = new BoundedCache<number, CitySite | null>(4096);
  private readonly linkCache = new BoundedCache<number, CitySite[]>(2048);
  private readonly roadCache = new BoundedCache<string, Road | null>(1024);
  private readonly cellCache = new BoundedCache<number, CellIndex>(96);
  private lastKey = NaN;
  private lastCell: CellIndex | null = null;

  constructor(private readonly terrain: TerrainSampler) {
    this.airfield = this.pickAirfield();
    this.airSpawn = { x: this.airfield.x, z: this.airfield.z - this.airfield.halfLength - AIR_SPAWN_DISTANCE, heading: 0 };
  }

  /** City of macro cell (i, j), or null. */
  cityAt(i: number, j: number): CitySite | null {
    const key = macroKey(i, j);
    const hit = this.cityCache.get(key);
    if (hit !== undefined) return hit;
    return this.cityCache.set(key, cityInCell(this.terrain, i, j));
  }

  /** The cities `city` links to (its nearest neighbours). */
  neighbours(city: CitySite): CitySite[] {
    const hit = this.linkCache.get(city.id);
    if (hit) return hit;
    const [ci, cj] = cellOf(city.id);
    const others: CitySite[] = [];
    for (let j = cj - LINK_CELLS; j <= cj + LINK_CELLS; j++) {
      for (let i = ci - LINK_CELLS; i <= ci + LINK_CELLS; i++) {
        const c = this.cityAt(i, j);
        if (c) others.push(c);
      }
    }
    return this.linkCache.set(city.id, nearestNeighbours(city, others));
  }

  /** The road between two cities (null if not buildable). */
  road(a: CitySite, b: CitySite): Road | null {
    const key = roadKey(a, b);
    const hit = this.roadCache.get(key);
    if (hit !== undefined) return hit;
    return this.roadCache.set(key, buildRoad(this.terrain, a, b));
  }

  citiesNear(x: number, z: number, radius: number): readonly CitySite[] {
    const out: CitySite[] = [];
    const reach = radius + 1200;
    const i0 = Math.floor((x - reach) / MACRO_CELL);
    const i1 = Math.floor((x + reach) / MACRO_CELL);
    const j0 = Math.floor((z - reach) / MACRO_CELL);
    const j1 = Math.floor((z + reach) / MACRO_CELL);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = this.cityAt(i, j);
        if (c && Math.hypot(c.x - x, c.z - z) <= radius + c.radius) out.push(c);
      }
    }
    return out;
  }

  roadsNear(x: number, z: number, radius: number): readonly RoadSegment[] {
    const out: RoadPiece[] = [];
    const seen = new Set<RoadPiece>();
    this.forCells(x, z, radius, (cell) => {
      for (const p of cell.pieces) {
        if (seen.has(p)) continue;
        if (segmentDistance(x, z, p.ax, p.az, p.bx, p.bz, _t) > radius + p.halfWidth) continue;
        seen.add(p);
        out.push(p);
      }
    });
    return out;
  }

  bridgesNear(x: number, z: number, radius: number): readonly BridgeSite[] {
    const out: BridgeSpan[] = [];
    this.forCells(x, z, radius, (cell) => {
      for (const b of cell.bridges) {
        if (out.includes(b)) continue;
        if (Math.hypot(b.x - x, b.z - z) <= radius + b.halfSpan + b.halfWidth) out.push(b);
      }
    });
    return out;
  }

  shapeHeight(x: number, z: number, h: number): number {
    const cell = this.cellAt(x, z);
    let y = h;
    for (const c of cell.cities) {
      const d = Math.hypot(x - c.x, z - c.z);
      const blend = Math.min(CITY_BLEND_MAX, 150 + 0.6 * Math.abs(c.groundY - h));
      if (d >= c.radius + blend) continue;
      const w = 1 - smooth01((d - c.radius) / blend);
      y += (c.groundY - y) * w;
    }
    const b = this.binOf(x, z);
    const items = cell.binItems;
    for (let k = cell.binStart[b]!; k < cell.binStart[b + 1]!; k++) {
      const p = cell.pieces[items[k]!]!;
      const d = segmentDistance(x, z, p.ax, p.az, p.bx, p.bz, _t);
      if (d >= ROAD_REACH) continue;
      const roadY = p.ay + (p.by - p.ay) * _t[0]!;
      const fill = roadY - h;
      // Elevated road (bridge / viaduct): the ground goes back to its natural height under it.
      const fade = 1 - smooth01((fill - BRIDGE_FILL) / 4);
      if (fade <= 0) continue;
      const core = p.halfWidth + ROAD_SHOULDER;
      const blend = Math.min(ROAD_BLEND_MAX, 25 + 0.8 * Math.abs(fill));
      if (d >= core + blend) continue;
      const w = (1 - smooth01((d - core) / blend)) * fade;
      y += (roadY - y) * w;
    }
    const a = this.airfield;
    const dx = Math.abs(x - a.x) - a.halfWidth - AIRFIELD_MARGIN_X;
    const dz = Math.abs(z - a.z) - a.halfLength - AIRFIELD_MARGIN_Z;
    if (dx < AIRFIELD_BLEND_MAX && dz < AIRFIELD_BLEND_MAX) {
      const d = Math.hypot(Math.max(0, dx), Math.max(0, dz));
      const blend = Math.min(AIRFIELD_BLEND_MAX, 150 + Math.abs(a.height - h));
      if (d < blend) y += (a.height - y) * (1 - smooth01(d / blend));
    }
    return y;
  }

  pavedAt(x: number, z: number): number {
    let paved = airfieldPavedAt(this.airfield, x, z);
    if (paved >= 1) return 1;
    const cell = this.cellAt(x, z);
    for (const c of cell.cities) paved = Math.max(paved, cityPavedAt(c, x, z));
    const b = this.binOf(x, z);
    for (let k = cell.binStart[b]!; k < cell.binStart[b + 1]! && paved < 1; k++) {
      const p = cell.pieces[cell.binItems[k]!]!;
      if (p.bridge) continue;
      const d = segmentDistance(x, z, p.ax, p.az, p.bx, p.bz, _t);
      if (d < p.halfWidth + 1.5) paved = Math.max(paved, 1 - smooth01((d - p.halfWidth) / 1.5));
    }
    return paved;
  }

  private binOf(x: number, z: number): number {
    const bi = Math.min(BINS - 1, Math.floor((x - Math.floor(x / MACRO_CELL) * MACRO_CELL) / BIN));
    const bj = Math.min(BINS - 1, Math.floor((z - Math.floor(z / MACRO_CELL) * MACRO_CELL) / BIN));
    return bj * BINS + bi;
  }

  private forCells(x: number, z: number, radius: number, fn: (cell: CellIndex) => void): void {
    const i0 = Math.floor((x - radius) / MACRO_CELL);
    const i1 = Math.floor((x + radius) / MACRO_CELL);
    const j0 = Math.floor((z - radius) / MACRO_CELL);
    const j1 = Math.floor((z + radius) / MACRO_CELL);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(this.cellIndex(i, j));
  }

  private cellAt(x: number, z: number): CellIndex {
    const i = Math.floor(x / MACRO_CELL);
    const j = Math.floor(z / MACRO_CELL);
    const key = macroKey(i, j);
    if (key === this.lastKey && this.lastCell) return this.lastCell;
    const cell = this.cellIndex(i, j);
    this.lastKey = key;
    this.lastCell = cell;
    return cell;
  }

  private cellIndex(i: number, j: number): CellIndex {
    const key = macroKey(i, j);
    const hit = this.cellCache.get(key);
    if (hit) return hit;
    const x0 = i * MACRO_CELL;
    const z0 = j * MACRO_CELL;
    const cities: CitySite[] = [];
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const c = this.cityAt(i + di, j + dj);
        if (!c) continue;
        const r = c.radius + CITY_BLEND_MAX;
        if (rectOverlaps(c.x - r, c.x + r, c.z - r, c.z + r, x0, z0, MACRO_CELL)) cities.push(c);
      }
    }
    cities.sort((a, b) => a.id - b.id);

    const roads: Road[] = [];
    const seen = new Set<string>();
    const span = LINK_CELLS;
    const pre = MAX_DETOUR + ROAD_REACH + 200;
    for (let dj = -span; dj <= span; dj++) {
      for (let di = -span; di <= span; di++) {
        const a = this.cityAt(i + di, j + dj);
        if (!a) continue;
        for (const b of this.neighbours(a)) {
          const k = roadKey(a, b);
          if (seen.has(k)) continue;
          seen.add(k);
          if (!rectOverlaps(Math.min(a.x, b.x) - pre, Math.max(a.x, b.x) + pre, Math.min(a.z, b.z) - pre, Math.max(a.z, b.z) + pre, x0, z0, MACRO_CELL)) continue;
          const road = this.road(a, b);
          if (road && rectOverlaps(road.minX - ROAD_REACH, road.maxX + ROAD_REACH, road.minZ - ROAD_REACH, road.maxZ + ROAD_REACH, x0, z0, MACRO_CELL)) roads.push(road);
        }
      }
    }
    const pieces: RoadPiece[] = [];
    const bridges: BridgeSpan[] = [];
    for (const road of roads) {
      for (const p of road.pieces) {
        if (rectOverlaps(Math.min(p.ax, p.bx) - ROAD_REACH, Math.max(p.ax, p.bx) + ROAD_REACH, Math.min(p.az, p.bz) - ROAD_REACH, Math.max(p.az, p.bz) + ROAD_REACH, x0, z0, MACRO_CELL)) pieces.push(p);
      }
      for (const b of road.bridges) {
        const r = b.halfSpan + b.halfWidth + 20;
        if (rectOverlaps(b.x - r, b.x + r, b.z - r, b.z + r, x0, z0, MACRO_CELL)) bridges.push(b);
      }
    }
    pieces.sort(comparePieces);

    const binRange = (p: RoadPiece): [number, number, number, number] => [
      Math.max(0, Math.floor((Math.min(p.ax, p.bx) - ROAD_REACH - x0) / BIN)),
      Math.min(BINS - 1, Math.floor((Math.max(p.ax, p.bx) + ROAD_REACH - x0) / BIN)),
      Math.max(0, Math.floor((Math.min(p.az, p.bz) - ROAD_REACH - z0) / BIN)),
      Math.min(BINS - 1, Math.floor((Math.max(p.az, p.bz) + ROAD_REACH - z0) / BIN)),
    ];
    const counts = new Int32Array(BINS * BINS + 1);
    for (const p of pieces) {
      const [bi0, bi1, bj0, bj1] = binRange(p);
      for (let bj = bj0; bj <= bj1; bj++) for (let bi = bi0; bi <= bi1; bi++) counts[bj * BINS + bi + 1]!++;
    }
    for (let k = 1; k < counts.length; k++) counts[k]! += counts[k - 1]!;
    const binStart = counts;
    const fill = binStart.slice(0, BINS * BINS);
    const binItems = new Int32Array(binStart[BINS * BINS]!);
    pieces.forEach((p, idx) => {
      const [bi0, bi1, bj0, bj1] = binRange(p);
      for (let bj = bj0; bj <= bj1; bj++) for (let bi = bi0; bi <= bi1; bi++) binItems[fill[bj * BINS + bi]!++] = idx;
    });
    return this.cellCache.set(key, { cities, pieces, bridges, binStart, binItems });
  }

  private pickAirfield(): RunwayRect {
    // Nearest city to the origin: search rings of macro cells until one is found, then one ring more.
    let found: CitySite[] = [];
    for (let ring = 0; ring <= 6 && found.length === 0; ring++) {
      for (let j = -ring - 1; j <= ring; j++) {
        for (let i = -ring - 1; i <= ring; i++) {
          if (Math.max(Math.abs(i + 0.5), Math.abs(j + 0.5)) !== ring + 0.5) continue;
          const c = this.cityAt(i, j);
          if (c) found.push(c);
        }
      }
      if (found.length > 0) {
        const r = ring + 1;
        found = [];
        for (let j = -r - 1; j <= r; j++) for (let i = -r - 1; i <= r; i++) {
          const c = this.cityAt(i, j);
          if (c) found.push(c);
        }
      }
    }
    found.sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z) || a.id - b.id);
    for (const city of found.slice(0, 3)) {
      const rect = airfieldNearCity(this.terrain, city, this.citiesNear(city.x, city.z, 6000));
      if (rect) return rect;
    }
    return airfieldOnSpiral(this.terrain);
  }
}

function rectPaved(x: number, z: number, cx: number, cz: number, hx: number, hz: number): number {
  const d = Math.max(Math.abs(x - cx) - hx, Math.abs(z - cz) - hz);
  return 1 - smooth01(d / 1.5);
}

/** Runway with shoulders, a parallel taxiway and an apron on the +X side. */
export function airfieldPavedAt(a: RunwayRect, x: number, z: number): number {
  if (Math.abs(x - a.x) > a.halfWidth + 170 || Math.abs(z - a.z) > a.halfLength + 20) return 0;
  return Math.max(
    rectPaved(x, z, a.x, a.z, a.halfWidth + 10, a.halfLength + 10),
    rectPaved(x, z, a.x + a.halfWidth + 45, a.z, 10, a.halfLength),
    rectPaved(x, z, a.x + a.halfWidth + 25, a.z, 25, 12),
    rectPaved(x, z, a.x + a.halfWidth + 105, a.z, 60, 200),
  );
}
