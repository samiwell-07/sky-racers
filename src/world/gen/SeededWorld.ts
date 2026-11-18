import { SEEDED_TERRAIN, TERRAIN_CONFIG, type TerrainConfig } from '../../config/worldConfig';
import { clamp, lerp, smoothstep } from '../../utils/math';
import { SimplexNoise2D } from '../../utils/noise';
import { mulberry32 } from '../../utils/random';
import { subSeed } from '../../utils/seed';
import type { RunwayRect } from '../terrain/HeightField';
import { createSettlements } from './settlements';
import type {
  Biome,
  BridgeSite,
  CitySite,
  RoadSegment,
  SettlementFactory,
  SettlementLayer,
  SpawnPoint,
  SurfaceSample,
  TerrainSampler,
  WorldGenerator,
  WorldSpec,
} from './WorldGenerator';

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const GX = [1, -1, 1, -1, 1, -1, 0, 0];
const GZ = [1, 1, -1, -1, 0, 0, 1, -1];

/**
 * 2D simplex noise that also returns its analytic gradient (in `dx`, `dz` after each call), so
 * the distance to a noise contour (rivers) costs no extra evaluations.
 */
export class SimplexNoiseD {
  private readonly perm = new Uint8Array(512);
  dx = 0;
  dz = 0;

  constructor(random: () => number) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      const tmp = p[i]!;
      p[i] = p[j]!;
      p[j] = tmp;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255]!;
  }

  noise(x: number, y: number): number {
    const perm = this.perm;
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = 1 - i1;
    const ii = i & 255;
    const jj = j & 255;
    let n = 0;
    let gx = 0;
    let gy = 0;
    for (let c = 0; c < 3; c++) {
      const cx = c === 0 ? x0 : c === 1 ? x0 - i1 + G2 : x0 - 1 + 2 * G2;
      const cy = c === 0 ? y0 : c === 1 ? y0 - j1 + G2 : y0 - 1 + 2 * G2;
      const tt = 0.5 - cx * cx - cy * cy;
      if (tt <= 0) continue;
      const oi = c === 0 ? 0 : c === 1 ? i1 : 1;
      const oj = c === 0 ? 0 : c === 1 ? j1 : 1;
      const g = perm[ii + oi + perm[jj + oj]!]! & 7;
      const dot = GX[g]! * cx + GZ[g]! * cy;
      const t2 = tt * tt;
      const t4 = t2 * t2;
      n += t4 * dot;
      // d/dx (t^4 * dot) = t^4 * gx - 8 t^3 * x * dot
      const k = 8 * t2 * tt * dot;
      gx += t4 * GX[g]! - k * cx;
      gy += t4 * GZ[g]! - k * cy;
    }
    this.dx = 70 * gx;
    this.dz = 70 * gy;
    return 70 * n;
  }
}

/** Everything heightAt() works out at one point, reused by water, biome, surface and canyon queries. */
interface Sample {
  x: number;
  z: number;
  /** Continentalness relative to the coast (< 0 ocean). */
  land: number;
  /** Water surface of rivers / lakes / the sea here (the "valley floor" level), continuous everywhere. */
  level: number;
  /** Natural height before valleys and lakes were carved. */
  natural: number;
  /** Base height (natural terrain, carved), before settlements. */
  base: number;
  mountain: number;
  hilly: number;
  plateau: number;
  /** Distance to the river centerline (m) and the channel half width. */
  riverDist: number;
  riverHalf: number;
  valleyHalf: number;
  /** 0 = natural, 1 = river valley, 2 = lake basin (whichever carve is lowest). */
  carve: number;
}

const T = SEEDED_TERRAIN;
/** Beyond this distance from a river the valley walls are always above the natural terrain. */
const VALLEY_REACH = 2600;
const RIVER_DEPTH = 6;
/** Valley floor height above the water. */
const FLOOR_ABOVE_WATER = 3.5;

/** Smooth minimum (polynomial); k = blend width. */
function smin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** Stepped mesa profile: flat terraces separated by cliffs. */
function terrace(h: number, step: number): number {
  const k = h / step;
  const f = k - Math.floor(k);
  return (Math.floor(k) + smoothstep(0.7, 1, f)) * step;
}

/** Ground height relative to the water level across the coast: sea floor, beach, rising land. */
function coastProfile(land: number): number {
  if (land < 0) return -3 - 160 * smoothstep(0, 0.18, -land);
  return -3 + 9 * smoothstep(0, 0.05, land) + 40 * smoothstep(0.03, 0.4, land);
}

/**
 * Infinite Minecraft-style world from a 32-bit seed: oceans and coasts, plains, hills, forests,
 * plateaus, snowy ridged mountain ranges, and river valleys (canyons in the mountains) running
 * down to the sea, plus lakes. Roads, cities and the airfield come from the settlement layer.
 *
 * Water level trick: rivers and lakes sit at `level`, a smooth function of continentalness that
 * equals sea level at the coast, and the natural land is always above it. Carving a channel or a
 * basin below `level` makes water, so the surface is continuous and never floats over dry land.
 */
export class SeededWorld implements WorldGenerator {
  readonly spec: WorldSpec;
  readonly config: TerrainConfig;
  readonly settlements: SettlementLayer;
  private readonly warpA: SimplexNoiseD;
  private readonly warpB: SimplexNoiseD;
  private readonly riverA: SimplexNoiseD;
  private readonly riverB: SimplexNoiseD;
  private readonly continent: SimplexNoise2D;
  private readonly region: SimplexNoise2D;
  private readonly hills: SimplexNoise2D;
  private readonly ridges: SimplexNoise2D;
  private readonly plateaus: SimplexNoise2D;
  private readonly lakes: SimplexNoise2D;
  private readonly forests: SimplexNoise2D;
  private readonly s: Sample = {
    x: Number.NaN,
    z: Number.NaN,
    land: 0,
    level: 0,
    natural: 0,
    base: 0,
    mountain: 0,
    hilly: 0,
    plateau: 0,
    riverDist: Infinity,
    riverHalf: 0,
    valleyHalf: 0,
    carve: 0,
  };

  constructor(seed: number, settlementFactory: SettlementFactory = createSettlements) {
    const s = seed >>> 0;
    this.spec = { kind: 'seeded', seed: s };
    this.config = Object.freeze({ ...TERRAIN_CONFIG, seed: s, waterLevel: T.seaLevel });
    const rng = (salt: number): (() => number) => mulberry32(subSeed(s, salt));
    this.warpA = new SimplexNoiseD(rng(1));
    this.warpB = new SimplexNoiseD(rng(2));
    this.riverA = new SimplexNoiseD(rng(3));
    this.riverB = new SimplexNoiseD(rng(4));
    this.continent = new SimplexNoise2D(rng(5));
    this.region = new SimplexNoise2D(rng(6));
    this.hills = new SimplexNoise2D(rng(7));
    this.ridges = new SimplexNoise2D(rng(8));
    this.plateaus = new SimplexNoise2D(rng(9));
    this.lakes = new SimplexNoise2D(rng(10));
    this.forests = new SimplexNoise2D(rng(11));
    const sampler: TerrainSampler = {
      seed: s,
      baseHeightAt: (x, z) => this.baseHeightAt(x, z),
      waterLevelAt: (x, z) => {
        const p = this.sample(x, z);
        return p.base < p.level ? p.level : -Infinity;
      },
    };
    this.settlements = settlementFactory(sampler);
  }

  get airfield(): RunwayRect {
    return this.settlements.airfield;
  }

  get airSpawn(): SpawnPoint {
    return this.settlements.airSpawn;
  }

  /** Natural terrain (valleys and lakes carved), before roads/cities/airfield. */
  baseHeightAt(x: number, z: number): number {
    return this.sample(x, z).base;
  }

  heightAt(x: number, z: number): number {
    return this.settlements.shapeHeight(x, z, this.sample(x, z).base);
  }

  waterLevelAt(x: number, z: number): number {
    const p = this.sample(x, z);
    const level = p.level;
    if (p.base >= level) return -Infinity;
    return this.settlements.shapeHeight(x, z, p.base) < level ? level : -Infinity;
  }

  biomeAt(x: number, z: number): Biome {
    if (this.waterLevelAt(x, z) > -Infinity) {
      const p = this.sample(x, z);
      if (p.carve === 2) return 'lake';
      return p.carve === 1 && p.land > 0 && p.riverDist < p.riverHalf + 2 ? 'river' : 'ocean';
    }
    for (const c of this.settlements.citiesNear(x, z, 0)) if (Math.hypot(x - c.x, z - c.z) < c.radius) return 'city';
    const p = this.sample(x, z);
    const { land, level, base, natural, mountain, hilly, plateau, riverDist, valleyHalf } = p;
    if (this.sandAt(p) > 0.5) return 'beach';
    if (base > T.snowLine) return 'snow';
    const canyon = clamp((natural - base) / 250, 0, 1);
    if (canyon > 0.35 || riverDist < valleyHalf + 60) return 'valley';
    if (mountain > 0.45) return 'mountains';
    if (plateau > 0.5) return 'hills';
    if (land > 0.03 && base - level < 500 && this.forests.fbm(x, z, 2, 1 / 3000) > 0.12) return 'forest';
    return hilly > 0.5 ? 'hills' : 'plains';
  }

  surfaceAt(x: number, z: number, out: SurfaceSample): SurfaceSample {
    out.sand = this.sandAt(this.sample(x, z));
    out.paved = this.settlements.pavedAt(x, z);
    return out;
  }

  canyonFactor(x: number, z: number): number {
    const p = this.sample(x, z);
    return clamp((p.natural - p.base) / 250, 0, 1);
  }

  citiesNear(x: number, z: number, radius: number): readonly CitySite[] {
    return this.settlements.citiesNear(x, z, radius);
  }

  roadsNear(x: number, z: number, radius: number): readonly RoadSegment[] {
    return this.settlements.roadsNear(x, z, radius);
  }

  bridgesNear(x: number, z: number, radius: number): readonly BridgeSite[] {
    return this.settlements.bridgesNear(x, z, radius);
  }

  /** Beaches, lake shores and gravel river banks (0..1). */
  private sandAt(p: Sample): number {
    const shore = (1 - smoothstep(p.level + 1, p.level + 3, p.base)) * smoothstep(p.level - 6, p.level - 2, p.base);
    const bank = p.riverHalf > 0 ? 1 - smoothstep(p.riverHalf + 4, p.riverHalf + 12, p.riverDist) : 0;
    return Math.max(shore, bank);
  }

  /** Evaluates the terrain at (x, z) (memoized for the last point: heightAt + waterLevelAt + surfaceAt). */
  private sample(x: number, z: number): Sample {
    const s = this.s;
    if (s.x === x && s.z === z) return s;

    // Domain warp (with its Jacobian, for the river distance).
    const fw = 1 / T.warpScale;
    const A = T.warpAmount;
    const ua = this.warpA.noise(x * fw, z * fw);
    const jxx = 1 + A * fw * this.warpA.dx;
    const jxz = A * fw * this.warpA.dz;
    const ub = this.warpB.noise(x * fw, z * fw);
    const jzx = A * fw * this.warpB.dx;
    const jzz = 1 + A * fw * this.warpB.dz;
    const wx = x + A * ua;
    const wz = z + A * ub;

    // Continents: oceans, coasts, islands. Water level rises gently inland.
    const land = this.continent.fbm(wx, wz, 3, 1 / T.continentScale, 2.2, 0.45) - T.landThreshold;
    const up = Math.max(0, land);
    const level = T.seaLevel + (T.inlandRise * up * up) / (up + 0.05);
    const landMask = smoothstep(0, 0.12, land);

    // Regions: plains (low), hills, mountain ranges (high).
    const m = this.region.fbm(wx, wz, 2, 1 / T.regionScale);
    const mountain = smoothstep(0.08, 0.42, m) * smoothstep(0.05, 0.22, land);
    const hilly = smoothstep(-0.3, 0.1, m);
    const hillN = this.hills.fbm(wx, wz, 3, 1 / T.hillScale, 2.1, 0.45) * 0.5 + 0.5;
    let natural = level + coastProfile(land) + landMask * hillN * lerp(14, 150, hilly);
    if (mountain > 0) {
      const r = this.ridges.ridged(wx, wz, 3, 1 / T.ridgeScale, 2.1, 0.5);
      natural += mountain * (140 + T.mountainHeight * r * r);
    }
    let plateau = 0;
    const plateauRoom = hilly * (1 - mountain) * landMask;
    if (plateauRoom > 0) {
      plateau = smoothstep(0.25, 0.42, this.plateaus.noise(x / 7000, z / 7000)) * plateauRoom;
      if (plateau > 0) natural = lerp(natural, level + terrace(natural - level + 110, 50), plateau);
    }

    // Rivers: the zero contour of a warped noise; distance = |R| / |grad R| (chain rule through the warp).
    const fr = 1 / T.riverScale;
    const ra = this.riverA.noise(wx * fr, wz * fr);
    let gwx = this.riverA.dx * fr;
    let gwz = this.riverA.dz * fr;
    const rb = this.riverB.noise(wx * fr * 2.3, wz * fr * 2.3);
    gwx += 0.3 * this.riverB.dx * fr * 2.3;
    gwz += 0.3 * this.riverB.dz * fr * 2.3;
    const R = ra + 0.3 * rb;
    const gx = gwx * jxx + gwz * jzx;
    const gz = gwx * jxz + gwz * jzz;
    const riverDist = Math.abs(R) / Math.max(Math.hypot(gx, gz), 1e-7);

    let base = natural;
    let carve = 0;
    const riverHalf = 18 + 20 * (1 - smoothstep(0, 0.4, land));
    const valleyHalf = lerp(190, 90, mountain);
    if (riverDist < VALLEY_REACH) {
      let profile: number;
      if (riverDist < riverHalf) {
        const t = riverDist / riverHalf;
        profile = level - 0.3 - RIVER_DEPTH * (1 - t * t);
      } else {
        const w = Math.max(0, riverDist - valleyHalf);
        const slope = lerp(0.22, 1.5, mountain);
        const bank = smoothstep(riverHalf, riverHalf + 12, riverDist);
        profile = level - 0.3 + bank * (FLOOR_ABOVE_WATER + 0.3 + (hillN - 0.5) * 2) + w * slope + w * w * 0.0006;
      }
      if (profile < base) carve = 1;
      base = smin(base, profile, Math.min(40, Math.max(0, Math.min(base, profile) - level) * 2));
    }

    // Lakes: gentle basins around maxima of a lake noise, away from mountains and the sea.
    if (landMask > 0 && mountain < 0.6) {
      const q = this.lakes.noise(x / T.lakeScale, z / T.lakeScale);
      const bottom = level - 9 + Math.max(0, 0.64 - q) * 320 + mountain * 3000 + (1 - landMask) * 400;
      const lake = Math.max(level - 14, bottom);
      if (lake < base + 40) {
        if (lake < base) carve = 2;
        base = smin(base, lake, Math.min(40, Math.max(0, Math.min(base, lake) - level) * 2));
      }
    }

    s.x = x;
    s.z = z;
    s.land = land;
    s.level = level;
    s.natural = natural;
    s.base = base;
    s.mountain = mountain;
    s.hilly = hilly;
    s.plateau = plateau;
    s.riverDist = riverDist;
    s.riverHalf = riverDist < VALLEY_REACH ? riverHalf : 0;
    s.valleyHalf = valleyHalf;
    s.carve = carve;
    return s;
  }
}
