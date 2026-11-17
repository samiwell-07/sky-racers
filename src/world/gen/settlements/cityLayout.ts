import { mulberry32 } from '../../../utils/random';
import type { CitySite } from '../WorldGenerator';
import { STREET_HALF_WIDTH, STREET_PITCH, hash3, smooth01 } from './types';

/**
 * City street grid and buildings. Streets run along the city's local axes on lines every
 * STREET_PITCH m (local X axis = world (cos h, -sin h), local Z = world (sin h, cos h), h = heading).
 * Downtown: towers up to maxBuildingHeight; midtown: flat-roofed blocks; outskirts: low gabled houses.
 */

export interface CityBuilding {
  x: number;
  z: number;
  /** Along local X / local Z. */
  width: number;
  depth: number;
  /** Wall height above the ground (towers) or eaves height (houses). */
  height: number;
  /** 0 for flat-roofed towers and blocks. */
  roofHeight: number;
  heading: number;
  wallColor: number;
  roofColor: number;
}

/** Fraction of the radius that is downtown (towers) and midtown (flat-roofed blocks). */
export const DOWNTOWN = 0.32;
export const MIDTOWN = 0.62;

/** City-local coordinates of a world point: [along local X, along local Z]. */
export function toCityLocal(city: CitySite, x: number, z: number): [number, number] {
  const c = Math.cos(city.heading);
  const s = Math.sin(city.heading);
  const dx = x - city.x;
  const dz = z - city.z;
  return [dx * c - dz * s, dx * s + dz * c];
}

function toWorld(city: CitySite, u: number, w: number): [number, number] {
  const c = Math.cos(city.heading);
  const s = Math.sin(city.heading);
  return [city.x + u * c + w * s, city.z - u * s + w * c];
}

/** 0..1 pavement of the city's streets (and its paved downtown plazas) at (x, z). */
export function cityPavedAt(city: CitySite, x: number, z: number): number {
  const d = Math.hypot(x - city.x, z - city.z);
  if (d >= city.radius) return 0;
  const edge = 1 - smooth01((d - city.radius * 0.93) / (city.radius * 0.07));
  if (d < city.radius * DOWNTOWN * 0.8) return edge;
  const [u, w] = toCityLocal(city, x, z);
  const du = Math.abs(u - STREET_PITCH * Math.round(u / STREET_PITCH));
  const dw = Math.abs(w - STREET_PITCH * Math.round(w / STREET_PITCH));
  const street = 1 - smooth01((Math.min(du, dw) - STREET_HALF_WIDTH) / 1.5);
  return street * edge;
}

const TOWER_COLORS = [0x8fa3b8, 0x6f8296, 0xb8b2a6, 0x9aa7a8, 0x56677a, 0xc9c1b0, 0x7d8a8f];
const BLOCK_COLORS = [0xc8bca8, 0xa89a88, 0xd6d0c4, 0x9b8f84, 0xb5a48c, 0x8d98a0];
const HOUSE_WALLS = [0xf1ece0, 0xe8dcc0, 0xd9d2c5, 0xb8562f, 0xc9b48f];
const ROOFS = [0x7a2e22, 0x5b4a42, 0x8a3b26, 0x4c5156];

/** Largest tower footprint: keeps the half diagonal under the props' 25 m building reach. */
const MAX_FOOTPRINT = 34;
/** Usable half size of a block inside its sidewalks. */
const LOT_HALF = STREET_PITCH / 2 - STREET_HALF_WIDTH - 4;

/** Every building of the city (deterministic from the world seed and the city). */
export function cityBuildings(city: CitySite, seed: number): CityBuilding[] {
  const out: CityBuilding[] = [];
  const n = Math.ceil(city.radius / STREET_PITCH);
  for (let bw = -n; bw < n; bw++) {
    for (let bu = -n; bu < n; bu++) {
      const cu = (bu + 0.5) * STREET_PITCH;
      const cw = (bw + 0.5) * STREET_PITCH;
      const f = Math.hypot(cu, cw) / city.radius;
      if (f > 1 - (STREET_PITCH * 0.45) / city.radius) continue;
      const rand = mulberry32(hash3(seed ^ city.id, bu, bw));
      if (f < MIDTOWN) {
        const lot = LOT_HALF;
        for (const [lu, lw] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
          const rEmpty = rand();
          const rw = rand();
          const rd = rand();
          const rh = rand();
          const rj = rand();
          const rc = rand();
          if (rEmpty < (f < DOWNTOWN ? 0.12 : 0.15)) continue;
          const width = 18 + rw * (MAX_FOOTPRINT - 18);
          const depth = 18 + rd * (MAX_FOOTPRINT - 18);
          // Four lots of `lot` m per block; jitter within the lot's free margin.
          const u = cu + lu * (lot / 2) + (rj - 0.5) * Math.max(0, lot - width - 2);
          const w = cw + lw * (lot / 2) + (rc - 0.5) * Math.max(0, lot - depth - 2);
          const height =
            f < DOWNTOWN
              ? city.maxBuildingHeight * (0.3 + 0.7 * rh * rh) * (1 - 0.45 * (f / DOWNTOWN))
              : 14 + rh * 36 * (1 - 0.5 * ((f - DOWNTOWN) / (MIDTOWN - DOWNTOWN)));
          const [x, z] = toWorld(city, u, w);
          const palette = f < DOWNTOWN ? TOWER_COLORS : BLOCK_COLORS;
          out.push({ x, z, width, depth, height, roofHeight: 0, heading: city.heading, wallColor: palette[Math.floor(rc * palette.length)]!, roofColor: 0x55585c });
        }
      } else {
        const lot = (LOT_HALF * 2) / 3;
        for (let k = 0; k < 9; k++) {
          const rEmpty = rand();
          const rw = rand();
          const rd = rand();
          const rh = rand();
          const rr = rand();
          const rc = rand();
          if (rEmpty < 0.25) continue;
          const u = cu + ((k % 3) - 1) * lot;
          const w = cw + (Math.floor(k / 3) - 1) * lot;
          const [x, z] = toWorld(city, u, w);
          const turn = rr < 0.5 ? 0 : Math.PI / 2;
          out.push({
            x,
            z,
            width: 9 + rw * 5,
            depth: 10 + rd * 6,
            height: 5 + rh * 3,
            roofHeight: 3 + rr * 1.5,
            heading: city.heading + turn,
            wallColor: HOUSE_WALLS[Math.floor(rc * HOUSE_WALLS.length)]!,
            roofColor: ROOFS[Math.floor(rh * ROOFS.length)]!,
          });
        }
      }
    }
  }
  return out;
}
