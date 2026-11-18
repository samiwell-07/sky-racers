import type { RunwayRect } from '../../terrain/HeightField';
import type { CitySite, TerrainSampler } from '../WorldGenerator';

export const RUNWAY_HALF_LENGTH = 900;
export const RUNWAY_HALF_WIDTH = 25;
/** Flattened area around the runway (shoulders, taxiway, apron). */
export const AIRFIELD_MARGIN_X = 170;
export const AIRFIELD_MARGIN_Z = 100;

interface Candidate {
  x: number;
  z: number;
  relief: number;
  height: number;
}

/** Relief and mean height of the airfield area at (x, z), or null where it touches water. */
export function evaluateAirfield(terrain: TerrainSampler, x: number, z: number): Candidate | null {
  let lo = Infinity;
  let hi = -Infinity;
  let sum = 0;
  let n = 0;
  let water = -Infinity;
  for (let k = -6; k <= 6; k++) {
    const pz = z + (k / 6) * (RUNWAY_HALF_LENGTH + AIRFIELD_MARGIN_Z);
    for (const sx of [-1, -0.5, 0, 0.5, 1]) {
      const px = x + sx * (RUNWAY_HALF_WIDTH + AIRFIELD_MARGIN_X);
      const h = terrain.baseHeightAt(px, pz);
      const w = terrain.waterLevelAt(px, pz);
      if (w > h - 2) return null;
      water = Math.max(water, w);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
      sum += h;
      n++;
    }
  }
  return { x, z, relief: hi - lo, height: Math.max(sum / n, water + 3) };
}

/**
 * Airfield next to `city`: the flattest dry spot on rings around it, clear of every city in `cities`.
 * Returns null when no spot is acceptable.
 */
export function airfieldNearCity(terrain: TerrainSampler, city: CitySite, cities: readonly CitySite[]): RunwayRect | null {
  let best: (Candidate & { score: number }) | null = null;
  for (const extra of [350, 900, 1600]) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      // Distance from the city centre to the rectangle's edge in this direction.
      const reach = Math.min(
        Math.abs(ca) > 1e-6 ? (RUNWAY_HALF_WIDTH + AIRFIELD_MARGIN_X) / Math.abs(ca) : Infinity,
        Math.abs(sa) > 1e-6 ? (RUNWAY_HALF_LENGTH + AIRFIELD_MARGIN_Z) / Math.abs(sa) : Infinity,
      );
      const d = city.radius + extra + reach;
      const x = Math.round(city.x + ca * d);
      const z = Math.round(city.z + sa * d);
      if (cities.some((c) => rectCircleDistance(x, z, c) < 150)) continue;
      const cand = evaluateAirfield(terrain, x, z);
      if (!cand) continue;
      const score = cand.relief + extra * 0.01;
      if (!best || score < best.score) best = { ...cand, score };
    }
    if (best && best.relief < 30) break;
  }
  if (!best || best.relief > 80) return null;
  return { x: best.x, z: best.z, halfWidth: RUNWAY_HALF_WIDTH, halfLength: RUNWAY_HALF_LENGTH, height: best.height };
}

/** Distance from the airfield area centred at (x, z) to the edge of the city's disc (negative = overlap). */
function rectCircleDistance(x: number, z: number, c: CitySite): number {
  const dx = Math.max(0, Math.abs(c.x - x) - RUNWAY_HALF_WIDTH - AIRFIELD_MARGIN_X);
  const dz = Math.max(0, Math.abs(c.z - z) - RUNWAY_HALF_LENGTH - AIRFIELD_MARGIN_Z);
  return Math.hypot(dx, dz) - c.radius;
}

/** Fallback when there is no usable city near the origin: the flattest dry spot on a spiral. */
export function airfieldOnSpiral(terrain: TerrainSampler): RunwayRect {
  let best: (Candidate & { score: number }) | null = null;
  for (let i = 0; i < 400; i++) {
    const r = 500 * Math.sqrt(i);
    const a = i * 2.399963;
    const cand = evaluateAirfield(terrain, Math.round(Math.cos(a) * r), Math.round(Math.sin(a) * r));
    if (!cand) continue;
    const score = cand.relief + r * 0.002;
    if (!best || score < best.score) best = { ...cand, score };
    if (best.score < 8) break;
  }
  const b = best ?? { x: 0, z: 0, height: terrain.baseHeightAt(0, 0) };
  return { x: b.x, z: b.z, halfWidth: RUNWAY_HALF_WIDTH, halfLength: RUNWAY_HALF_LENGTH, height: Math.max(b.height, 2) };
}
