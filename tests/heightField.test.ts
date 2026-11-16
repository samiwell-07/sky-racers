import { describe, expect, it } from 'vitest';
import { TERRAIN_CONFIG, type TerrainConfig } from '../src/config/worldConfig';
import { HeightField, valleyCenterX } from '../src/world/terrain/HeightField';

const cfg = { ...TERRAIN_CONFIG, chunkSize: 100, chunkSegments: 2 } as TerrainConfig;

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
});
