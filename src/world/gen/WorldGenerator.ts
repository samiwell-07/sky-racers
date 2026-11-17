import type { TerrainConfig } from '../../config/worldConfig';
import type { RunwayRect } from '../terrain/HeightField';

/**
 * SHARED CONTRACT (phase 0). Every world (the hand-made Classic Canyon and the infinite seeded
 * worlds) implements WorldGenerator. All functions are pure and deterministic for a given spec, so
 * Web Workers (terrain chunks, props) rebuild the identical world from the spec alone:
 * `createWorld(spec)` in ./createWorld.ts.
 */

/** Which world to play. Classic = the original canyon (its courses and records are unchanged). */
export type WorldSpec = { kind: 'classic' } | { kind: 'seeded'; seed: number };

export const CLASSIC_WORLD: WorldSpec = Object.freeze({ kind: 'classic' });

/** Stable key used in course ids, record categories and lobby settings: 'classic' or 's<seed>'. */
export function worldKey(spec: WorldSpec): string {
  return spec.kind === 'classic' ? 'classic' : `s${spec.seed >>> 0}`;
}

/** Inverse of worldKey (null if malformed). */
export function parseWorldKey(key: string): WorldSpec | null {
  if (key === 'classic') return CLASSIC_WORLD;
  const m = /^s(\d{1,10})$/.exec(key);
  if (!m) return null;
  const n = Number(m[1]);
  return n <= 4294967295 ? { kind: 'seeded', seed: n } : null;
}

export type Biome = 'ocean' | 'beach' | 'plains' | 'hills' | 'forest' | 'valley' | 'mountains' | 'snow' | 'river' | 'lake' | 'city';

/** Per-point ground surface for the terrain splat (vertex attribute `surface` = vec2(paved, sand)). */
export interface SurfaceSample {
  /** 0..1 asphalt / city pavement. */
  paved: number;
  /** 0..1 beach sand / dry river bed. */
  sand: number;
}

export interface RoadSegment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  halfWidth: number;
  /** True where the road crosses water on a bridge (deck height = deckY). */
  bridge: boolean;
  deckY?: number;
}

export interface CitySite {
  id: number;
  x: number;
  z: number;
  /** Radius of the built-up area (m). */
  radius: number;
  /** Street grid orientation (rad, rotation about +Y). */
  heading: number;
  /** Flattened ground level of the city. */
  groundY: number;
  /** Tallest buildings (m): towers downtown, low houses at the edge. */
  maxBuildingHeight: number;
}

/** A bridge a jet can fly under (road bridge over a river/lake/bay, or Classic's stone arches). */
export interface BridgeSite {
  x: number;
  z: number;
  /** Direction of the deck (rad about +Y). Jets fly under it perpendicular to this. */
  heading: number;
  /** Half the length of the deck span (m). */
  halfSpan: number;
  /** Bottom of the opening (water or ground) and underside of the deck (m). */
  bottomY: number;
  deckY: number;
  /** Half width of the free opening between piers (m). */
  openHalfWidth: number;
}

export interface SpawnPoint {
  x: number;
  z: number;
  /** Rotation about +Y; 0 = flying toward -Z (same convention as Game.spawnAt). */
  heading: number;
}

export interface WorldGenerator {
  readonly spec: WorldSpec;
  readonly config: TerrainConfig;
  /** Final ground height (after roads/cities/airfield flattening): what is rendered and collided. */
  heightAt(x: number, z: number): number;
  /** Water surface height (ocean, river, lake) at (x, z), or -Infinity where there is no water. */
  waterLevelAt(x: number, z: number): number;
  biomeAt(x: number, z: number): Biome;
  surfaceAt(x: number, z: number, out: SurfaceSample): SurfaceSample;
  /** 0..1: how enclosed the spot is (deep valley/canyon) – drives low-level turbulence in Weather. */
  canyonFactor(x: number, z: number): number;
  /** Main airfield: runway along the Z axis, takeoff toward -Z (RunwayRect convention). */
  readonly airfield: RunwayRect;
  /** Air start for free flight (above the airfield axis, in front of the runway). */
  readonly airSpawn: SpawnPoint;
  citiesNear(x: number, z: number, radius: number): readonly CitySite[];
  roadsNear(x: number, z: number, radius: number): readonly RoadSegment[];
  bridgesNear(x: number, z: number, radius: number): readonly BridgeSite[];
  /** Classic world only: the canyon centerline (props power lines/arches, menu camera). */
  readonly classicValleyCenterX?: (z: number) => number;
}

/** Natural terrain before settlements are carved in (input of the settlement layer). */
export interface TerrainSampler {
  readonly seed: number;
  baseHeightAt(x: number, z: number): number;
  waterLevelAt(x: number, z: number): number;
}

/**
 * Roads, cities, bridges and the airfield of a seeded world (./settlements). SeededWorld calls
 * shapeHeight() last in heightAt(): it must be pure, continuous and cheap (macro cells cached).
 */
export interface SettlementLayer {
  readonly airfield: RunwayRect;
  readonly airSpawn: SpawnPoint;
  citiesNear(x: number, z: number, radius: number): readonly CitySite[];
  roadsNear(x: number, z: number, radius: number): readonly RoadSegment[];
  bridgesNear(x: number, z: number, radius: number): readonly BridgeSite[];
  /** Flattens ground under roads, city blocks and the airfield; `h` = natural height at (x, z). */
  shapeHeight(x: number, z: number, h: number): number;
  /** 0..1 pavement amount (roads, city streets, airfield apron). */
  pavedAt(x: number, z: number): number;
}

export type SettlementFactory = (terrain: TerrainSampler) => SettlementLayer;
