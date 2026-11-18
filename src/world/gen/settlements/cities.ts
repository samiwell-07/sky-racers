import { mulberry32 } from '../../../utils/random';
import type { CitySite, TerrainSampler } from '../WorldGenerator';
import { MACRO_CELL, hash3, macroKey } from './types';

/** Probability that a macro cell holds a city candidate (before the land tests). */
const CITY_CHANCE = 0.8;
const ATTEMPTS = 5;
const MIN_RADIUS = 400;
/** Dry margin kept around the built-up area. */
const DRY_MARGIN = 150;

function isWet(terrain: TerrainSampler, x: number, z: number, h: number): boolean {
  return terrain.waterLevelAt(x, z) > h - 2;
}

/** Height range allowed over a city of radius r ("fairly flat"). */
export function maxCityRelief(r: number): number {
  return 25 + 0.03 * r;
}

/**
 * Ground level of a city of radius r at (x, z), or null if the spot is not fairly flat dry land.
 * Samples the centre, two rings inside and a dry ring just outside.
 */
export function evaluateCitySpot(terrain: TerrainSampler, x: number, z: number, r: number): number | null {
  let lo = Infinity;
  let hi = -Infinity;
  let sum = 0;
  let n = 0;
  const rings: Array<[number, number]> = [[0, 1], [0.5 * r, 6], [r, 10], [r + DRY_MARGIN, 12]];
  for (const [rr, count] of rings) {
    const outer = rr > r;
    for (let k = 0; k < count; k++) {
      const a = (k / count) * Math.PI * 2 + rr * 0.001;
      const px = x + Math.cos(a) * rr;
      const pz = z + Math.sin(a) * rr;
      const h = terrain.baseHeightAt(px, pz);
      if (isWet(terrain, px, pz, h)) return null;
      if (outer) continue;
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
      if (hi - lo > maxCityRelief(r)) return null;
      sum += h;
      n++;
    }
  }
  return sum / n;
}

/** The city of macro cell (i, j), or null (deterministic from the seed). */
export function cityInCell(terrain: TerrainSampler, i: number, j: number): CitySite | null {
  const rand = mulberry32(hash3(terrain.seed, i * 7 + 3, j * 13 + 5));
  if (rand() >= CITY_CHANCE) return null;
  const baseRadius = 400 + rand() * 800;
  const heading = rand() * (Math.PI / 2);
  const towerRoll = rand();
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const x = Math.round((i + 0.2 + 0.6 * rand()) * MACRO_CELL);
    const z = Math.round((j + 0.2 + 0.6 * rand()) * MACRO_CELL);
    for (const scale of [1, 0.75, 0.55]) {
      const radius = Math.max(MIN_RADIUS, Math.round(baseRadius * scale));
      const groundY = evaluateCitySpot(terrain, x, z, radius);
      if (groundY === null) {
        if (radius === MIN_RADIUS) break;
        continue;
      }
      const size = (radius - MIN_RADIUS) / 800;
      return {
        id: macroKey(i, j),
        x,
        z,
        radius,
        heading,
        groundY,
        maxBuildingHeight: Math.round(120 + 80 * towerRoll * (0.5 + 0.5 * size)),
      };
    }
  }
  return null;
}
