import { describe, expect, it } from 'vitest';
import { TERRAIN_CONFIG } from '../src/config/worldConfig';
import { ClassicWorld } from '../src/world/gen/ClassicWorld';
import { createWorld } from '../src/world/gen/createWorld';
import { SeededWorld, SimplexNoiseD } from '../src/world/gen/SeededWorld';
import type { Biome, SettlementFactory } from '../src/world/gen/WorldGenerator';
import { computeChunkArrays } from '../src/world/terrain/chunkMeshData';
import { createHeightFunction } from '../src/world/terrain/HeightField';
import { mulberry32 } from '../src/utils/random';

/** No airfield flattening: tests see the natural terrain. */
const bare: SettlementFactory = () => ({
  airfield: { x: 0, z: 0, halfWidth: 25, halfLength: 900, height: 10 },
  airSpawn: { x: 0, z: 2000, heading: 0 },
  citiesNear: () => [],
  roadsNear: () => [],
  bridgesNear: () => [],
  shapeHeight: (_x, _z, h) => h,
  pavedAt: () => 0,
});

/** Grid of sample points covering ±half meters around the origin. */
function grid(half: number, step: number): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let z = -half; z <= half; z += step) for (let x = -half; x <= half; x += step) pts.push([x + 0.37, z - 0.61]);
  return pts;
}

describe('ClassicWorld', () => {
  it('keeps the classic heights bit-identical', () => {
    const world = new ClassicWorld();
    const original = createHeightFunction(TERRAIN_CONFIG);
    const rnd = mulberry32(7);
    for (let k = 0; k < 4000; k++) {
      const x = (rnd() - 0.5) * 30000;
      const z = (rnd() - 0.5) * 30000;
      expect(world.heightAt(x, z)).toBe(original(x, z));
    }
    expect(createWorld({ kind: 'classic' }).heightAt(123.4, -567.8)).toBe(original(123.4, -567.8));
  });

  it('has its river as the only water', () => {
    const world = new ClassicWorld();
    expect(world.waterLevelAt(world.classicValleyCenterX(0), 0)).toBe(TERRAIN_CONFIG.waterLevel);
    expect(world.waterLevelAt(world.classicValleyCenterX(0) + 500, 0)).toBe(-Infinity);
    expect(world.bridgesNear(world.classicValleyCenterX(1250), 1250, 100).length).toBe(1);
  });
});

describe('SimplexNoiseD', () => {
  it('returns the analytic gradient', () => {
    const n = new SimplexNoiseD(mulberry32(3));
    const e = 1e-5;
    for (const [x, y] of [[0.3, 1.7], [-4.2, 2.9], [10.1, -3.3]] as const) {
      n.noise(x, y);
      const { dx, dz } = n;
      const fx = (n.noise(x + e, y) - n.noise(x - e, y)) / (2 * e);
      const fz = (n.noise(x, y + e) - n.noise(x, y - e)) / (2 * e);
      expect(dx).toBeCloseTo(fx, 4);
      expect(dz).toBeCloseTo(fz, 4);
    }
  });
});

describe('SeededWorld', () => {
  it('is deterministic per seed and different across seeds', { timeout: 60000 }, () => {
    const a = new SeededWorld(42, bare);
    const b = new SeededWorld(42, bare);
    const c = new SeededWorld(43, bare);
    let diff = 0;
    for (const [x, z] of grid(20000, 2500)) {
      expect(a.heightAt(x, z)).toBe(b.heightAt(x, z));
      expect(a.waterLevelAt(x, z)).toBe(b.waterLevelAt(x, z));
      diff += Math.abs(a.heightAt(x, z) - c.heightAt(x, z));
    }
    expect(diff / grid(20000, 2500).length).toBeGreaterThan(20);
  });

  it('is mostly land, with ocean, mountains, valleys and every biome over a large area', { timeout: 60000 }, () => {
    for (const seed of [1, 2, 3, 12345]) {
      const world = new SeededWorld(seed, bare);
      const counts = new Map<Biome, number>();
      let land = 0;
      let maxH = -Infinity;
      const pts = grid(60000, 1000);
      for (const [x, z] of pts) {
        const biome = world.biomeAt(x, z);
        counts.set(biome, (counts.get(biome) ?? 0) + 1);
        if (biome !== 'ocean') land++;
        maxH = Math.max(maxH, world.heightAt(x, z));
      }
      const landShare = land / pts.length;
      expect(landShare, `seed ${seed}`).toBeGreaterThan(0.55);
      expect(landShare, `seed ${seed}`).toBeLessThan(0.85);
      expect(maxH, `seed ${seed}`).toBeGreaterThan(700);
      expect(maxH, `seed ${seed}`).toBeLessThan(1500);
      for (const b of ['ocean', 'plains', 'hills', 'forest', 'valley', 'mountains'] as const) {
        expect(counts.get(b) ?? 0, `seed ${seed} ${b}`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps water above the ground where it exists and continuous along rivers', { timeout: 60000 }, () => {
    const world = new SeededWorld(7, bare);
    let water = 0;
    let rivers = 0;
    for (const [x, z] of grid(10000, 50)) {
      const w = world.waterLevelAt(x, z);
      if (w === -Infinity) continue;
      water++;
      expect(w).toBeGreaterThan(world.heightAt(x, z));
      if (world.biomeAt(x, z) !== 'river') continue;
      rivers++;
      // Water surface varies smoothly: neighbours with water are at almost the same level.
      for (const [dx, dz] of [[8, 0], [0, 8]]) {
        const n = world.waterLevelAt(x + dx!, z + dz!);
        if (n > -Infinity) expect(Math.abs(n - w)).toBeLessThan(1);
      }
    }
    expect(water).toBeGreaterThan(0);
    expect(rivers).toBeGreaterThan(20);
  });

  it('carves valleys deep into mountains (canyons)', { timeout: 60000 }, () => {
    const world = new SeededWorld(5, bare);
    let canyons = 0;
    for (const [x, z] of grid(60000, 600)) if (world.canyonFactor(x, z) > 0.8 && world.heightAt(x, z) < 400) canyons++;
    expect(canyons).toBeGreaterThan(10);
  });

  it('is fast enough for terrain workers (100k samples)', { timeout: 60000 }, () => {
    const world = new SeededWorld(99, bare);
    let sum = 0;
    const t0 = performance.now();
    for (let k = 0; k < 100000; k++) sum += world.heightAt((k % 317) * 15.625 + 1e4, Math.floor(k / 317) * 15.625);
    const ms = performance.now() - t0;
    console.log(`SeededWorld.heightAt: 100k samples in ${ms.toFixed(1)} ms`);
    expect(Number.isFinite(sum)).toBe(true);
    // ~0.4-0.6 s here on a busy shared machine (the classic height function takes ~1-1.4 s).
    expect(ms).toBeLessThan(5000);
  });

  it('builds chunk surface and water data from a world', { timeout: 60000 }, () => {
    expect(createWorld({ kind: 'seeded', seed: 11 })).toBe(createWorld({ kind: 'seeded', seed: 11 }));
    const world = new SeededWorld(11, bare);
    const data = computeChunkArrays(0, 0, 1, world.config, world);
    const n = TERRAIN_CONFIG.chunkSegments / 2 + 1;
    expect(data.surface.length).toBe(data.uvs.length);
    expect(data.surface.length).toBe((n * n + (n - 1) * 4) * 2);
    for (const v of data.surface) expect(v >= 0 && v <= 1).toBe(true);
  });
});
