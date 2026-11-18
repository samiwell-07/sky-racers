import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { TERRAIN_CONFIG } from '../src/config/worldConfig';
import type { WorldGenerator } from '../src/world/gen/WorldGenerator';
import { classicCanyonFactor, Weather } from '../src/world/environment/Weather';
import { computeWaterArrays, createWaterMesh, type WaterArrays } from '../src/world/water/water';
import { DEEP_WATER_COLOR } from '../src/world/water/waterArrays';

const cfg = TERRAIN_CONFIG;
const SIZE = cfg.chunkSize;

/** Minimal world: only heightAt and waterLevelAt are used by the water builder. */
function fakeWorld(heightAt: (x: number, z: number) => number, waterLevelAt: (x: number, z: number) => number): WorldGenerator {
  return { heightAt, waterLevelAt } as unknown as WorldGenerator;
}

const dry = fakeWorld(() => 120, () => -Infinity);
// Ocean west of x = 0 (sea level 0), coast rising east; the beach crosses x = 0.
const coast = fakeWorld((x) => x * 0.02 - 4, (x) => (x < 400 ? 0 : -Infinity));
// River along x = 500 whose surface slopes down toward +Z.
const riverLevel = (z: number): number => 40 - z * 0.002;
const river = fakeWorld(
  (x, z) => riverLevel(z) + (Math.abs(x - 500) < 30 ? -4 : 6),
  (x, z) => (Math.abs(x - 500) < 60 ? riverLevel(z) : -Infinity),
);

function noNaN(a: WaterArrays): void {
  for (const arr of [a.positions, a.uvs, a.colors!]) for (const v of arr) expect(Number.isFinite(v)).toBe(true);
  for (const i of a.indices) expect(i).toBeLessThan(a.positions.length / 3);
}

describe('computeWaterArrays', () => {
  it('returns null on dry land and where the water level is below the ground', () => {
    expect(computeWaterArrays(2, 3, 0, cfg, dry)).toBeNull();
    expect(computeWaterArrays(0, 0, 0, cfg, fakeWorld(() => 50, () => 10))).toBeNull();
  });

  it('builds a coarse flat surface for open ocean', () => {
    const a = computeWaterArrays(-3, 1, 0, cfg, coast)!;
    expect(a).not.toBeNull();
    expect(a.positions.length / 3).toBeLessThanOrEqual(25);
    expect(a.minY).toBe(0);
    expect(a.maxY).toBe(0);
    noNaN(a);
    // Covers the whole chunk.
    const xs = [...a.positions].filter((_, i) => i % 3 === 0);
    expect(Math.min(...xs)).toBe(-3 * SIZE);
    expect(Math.max(...xs)).toBe(-2 * SIZE);
    // Deep water is tinted deep blue.
    expect(a.colors![0]).toBeCloseTo(DEEP_WATER_COLOR[0], 3);
  });

  it('follows the coastline and extends the level onto the beach', () => {
    const a = computeWaterArrays(0, 0, 0, cfg, coast)!;
    noNaN(a);
    for (let i = 1; i < a.positions.length; i += 3) expect(a.positions[i]).toBe(0);
    const xs = [...a.positions].filter((_, i) => i % 3 === 0);
    // Wet up to x = 200 (ground = 0 there), plus one cell of shore extension.
    const cell = SIZE / cfg.chunkSegments;
    expect(Math.max(...xs)).toBeGreaterThanOrEqual(200);
    expect(Math.max(...xs)).toBeLessThanOrEqual(200 + cell);
    expect(a.indices.length % 6).toBe(0);
  });

  it('gives a sloping river its own level and matches the neighbouring chunk edge', () => {
    for (const lod of [0, 2]) {
      const a = computeWaterArrays(0, 0, lod, cfg, river)!;
      const b = computeWaterArrays(0, 1, lod, cfg, river)!;
      noNaN(a);
      for (let v = 0; v < a.positions.length / 3; v++) {
        expect(a.positions[v * 3 + 1]).toBeCloseTo(riverLevel(a.positions[v * 3 + 2]!), 3);
        expect(Math.abs(a.positions[v * 3]! - 500)).toBeLessThanOrEqual(30 + (SIZE / cfg.chunkSegments) * (1 << lod));
      }
      const edge = (d: WaterArrays): string[] => {
        const out: string[] = [];
        for (let v = 0; v < d.positions.length / 3; v++) if (d.positions[v * 3 + 2] === SIZE) out.push(`${d.positions[v * 3]},${d.positions[v * 3 + 1]}`);
        return out.sort();
      };
      expect(edge(a).length).toBeGreaterThan(0);
      expect(edge(a)).toEqual(edge(b));
    }
  });

  it('is deterministic', () => {
    const a = computeWaterArrays(0, 0, 1, cfg, coast)!;
    const b = computeWaterArrays(0, 0, 1, cfg, coast)!;
    expect(b.positions).toEqual(a.positions);
    expect(b.uvs).toEqual(a.uvs);
    expect(b.indices).toEqual(a.indices);
    expect(b.colors).toEqual(a.colors);
  });
});

describe('createWaterMesh', () => {
  it('builds a static mesh with a shared material and a bounding box', () => {
    const m1 = createWaterMesh(computeWaterArrays(0, 0, 0, cfg, coast)!)!;
    const m2 = createWaterMesh(computeWaterArrays(-3, 0, 0, cfg, coast)!)!;
    expect(m1.material).toBe(m2.material);
    expect(m1.renderOrder).toBe(1);
    expect(m1.matrixAutoUpdate).toBe(false);
    expect(m1.geometry.boundingBox!.min.x).toBe(0);
    expect(m1.geometry.boundingBox!.max.y).toBe(0);
  });
});

describe('Weather canyon factor', () => {
  it('defaults to the classic canyon and accepts a world canyonFactor', () => {
    const w = new Weather({ windSpeed: 0, windDirection: 0, turbulence: 1 });
    const p = new Vector3(5000, 0, 0);
    expect(classicCanyonFactor(5000, 0)).toBe(0);
    const before = w.turbulenceAt(p, 50);
    w.setCanyonFactor(() => 1);
    expect(w.turbulenceAt(p, 50)).toBeGreaterThan(before);
  });
});
