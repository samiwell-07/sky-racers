import { describe, expect, it } from 'vitest';
import { TERRAIN_CONFIG, type TerrainConfig } from '../src/config/worldConfig';
import { SeededWorld } from '../src/world/gen/SeededWorld';
import type { SettlementFactory } from '../src/world/gen/WorldGenerator';
import { createHeightFunction, HeightField, runwayRect, valleyCenterX } from '../src/world/terrain/HeightField';
import { TerrainStreamer } from '../src/world/terrain/TerrainStreamer';
import { MeshBasicMaterial, Vector3 } from 'three';

const cfg = { ...TERRAIN_CONFIG, chunkSize: 100, chunkSegments: 2 } as TerrainConfig;

/** Natural terrain only (no roads/cities/airfield flattening). */
const bare: SettlementFactory = () => ({
  airfield: { x: 0, z: 0, halfWidth: 25, halfLength: 900, height: 10 },
  airSpawn: { x: 0, z: 2000, heading: 0 },
  citiesNear: () => [],
  roadsNear: () => [],
  bridgesNear: () => [],
  shapeHeight: (_x, _z, h) => h,
  pavedAt: () => 0,
});

describe('HeightField', () => {
  it('interpolates over the same triangles the mesh renders', () => {
    // Single raised vertex: the (1,0)-(0,1) diagonal split gives 5 at the cell center, the other split would give 7.5.
    const field = new HeightField(cfg, (x, z) => (x === 0 && z === 0 ? 10 : 0));
    expect(field.getHeightAt(0, 0)).toBeCloseTo(10);
    expect(field.getHeightAt(25, 0)).toBeCloseTo(5);
    expect(field.getHeightAt(12.5, 12.5)).toBeCloseTo(5);
    expect(field.getHeightAt(-12.5, -12.5)).toBeCloseTo(5);
    expect(field.getHeightAt(-37.5, -37.5)).toBeCloseTo(0);
  });

  it('is infinite: far positions are generated, not clamped', () => {
    const field = new HeightField(cfg, (x) => x / 10);
    expect(field.getHeightAt(50000, 0)).toBeCloseTo(5000);
  });

  it('treats the river surface as solid over the river bed', () => {
    const field = new HeightField(TERRAIN_CONFIG);
    const z = 0;
    const x = valleyCenterX(z);
    expect(field.getHeightAt(x, z)).toBeLessThan(TERRAIN_CONFIG.waterLevel);
    expect(field.getSurfaceHeight(x, z)).toBeCloseTo(TERRAIN_CONFIG.waterLevel);
  });

  it('keeps the classic world unchanged behind the legacy constructor', () => {
    const field = new HeightField(TERRAIN_CONFIG);
    const original = createHeightFunction(TERRAIN_CONFIG);
    for (let k = 0; k < 500; k++) {
      const x = Math.sin(k * 12.9898) * 9000;
      const z = Math.cos(k * 78.233) * 9000;
      expect(field.heightFn(x, z)).toBe(original(x, z));
    }
    expect(field.world.spec.kind).toBe('classic');
    expect(field.runway).toEqual(runwayRect());
    expect(field.isWater(valleyCenterX(0), 0)).toBe(true);
    expect(field.isRiver(valleyCenterX(0) + 400, 0)).toBe(false);
  });

  it('wraps a seeded world: surface = max(ground, water)', { timeout: 60000 }, () => {
    const world = new SeededWorld(2024, bare);
    const field = new HeightField(world);
    expect(field.config).toBe(world.config);
    expect(field.runway).toBe(world.airfield);
    let wet = 0;
    for (let x = -30000; x <= 30000; x += 1500) {
      for (let z = -30000; z <= 30000; z += 1500) {
        const w = world.waterLevelAt(x, z);
        const s = field.getSurfaceHeight(x, z);
        expect(s).toBeGreaterThanOrEqual(field.getHeightAt(x, z));
        if (w > -Infinity) {
          wet++;
          expect(s).toBeGreaterThanOrEqual(w);
        }
      }
    }
    expect(wet).toBeGreaterThan(0);
  });

  it('streams a new world after setWorld()', { timeout: 60000 }, () => {
    const small = { ...TERRAIN_CONFIG, lodDistances: [400] };
    const streamer = new TerrainStreamer(new HeightField(small as TerrainConfig), new MeshBasicMaterial());
    const center = new Vector3(valleyCenterX(0), 0, 0);
    streamer.buildAll(center);
    const before = streamer.chunkCount;
    expect(before).toBeGreaterThan(0);
    const seeded = new HeightField(new SeededWorld(5, bare));
    streamer.setWorld(seeded);
    expect(streamer.chunkCount).toBe(0);
    expect(streamer.group.children.length).toBe(0);
    streamer.update(center, true);
    expect(streamer.chunkCount).toBeGreaterThan(0);
    const chunk = streamer.group.children[0]!;
    const mesh = chunk.children[0] as unknown as { geometry: { getAttribute(n: string): unknown } };
    expect(mesh.geometry.getAttribute('surface')).toBeTruthy();
  });
});