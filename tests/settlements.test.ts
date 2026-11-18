import { describe, expect, it } from 'vitest';
import type { CitySite, TerrainSampler } from '../src/world/gen/WorldGenerator';
import { Settlements, cityBuildings } from '../src/world/gen/settlements';
import type { BridgeSpan } from '../src/world/gen/settlements';
import { evaluateCitySpot, maxCityRelief } from '../src/world/gen/settlements/cities';
import { roadProfile } from '../src/world/gen/settlements/roads';
import { collideBridge, collideCell, generateCell } from '../src/world/props/propsPlacement';
import type { PlacementOptions } from '../src/world/props/propsPlacement';
import { collidePackedCell, packCell } from '../src/world/props/propsPacking';
import { PropsManager } from '../src/world/props/PropsManager';
import { DECK_THICKNESS } from '../src/world/gen/settlements/types';
import { Vector3 } from 'three';

const RIVER_LEVEL = 20;
const riverZ = (x: number): number => 9000 + 600 * Math.sin(x / 3000);
const smooth = (a: number, b: number, v: number): number => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Analytic hills, a river band along z ≈ 9 km and an ocean for x > 40 km. */
function fakeTerrain(seed: number): TerrainSampler {
  const base = (x: number, z: number): number => {
    let h = 60 + 25 * Math.sin(x / 1300) * Math.cos(z / 1700) + 160 * Math.max(0, Math.sin(x / 5200 + 1) * Math.sin(z / 4300)) ** 2;
    const d = Math.abs(z - riverZ(x));
    if (d < 300) h = RIVER_LEVEL - 4 + (h - RIVER_LEVEL + 4) * smooth(60, 300, d);
    if (x > 40000) h -= (x - 40000) * 0.05;
    return h;
  };
  return {
    seed,
    baseHeightAt: base,
    waterLevelAt: (x, z) => (Math.abs(z - riverZ(x)) < 150 ? RIVER_LEVEL : x > 40000 ? 0 : -Infinity),
  };
}

const terrain = fakeTerrain(1234);
const layer = new Settlements(terrain);
const allCities = (): CitySite[] => {
  const out: CitySite[] = [];
  for (let j = -4; j <= 4; j++) for (let i = -4; i <= 7; i++) {
    const c = layer.cityAt(i, j);
    if (c) out.push(c);
  }
  return out;
};

describe('settlement layer', { timeout: 60_000 }, () => {
  it('is deterministic for a seed and differs between seeds', () => {
    const again = new Settlements(fakeTerrain(1234));
    expect(again.airfield).toEqual(layer.airfield);
    expect(again.citiesNear(0, 0, 20000)).toEqual(layer.citiesNear(0, 0, 20000));
    for (const [x, z] of [[100, 200], [5000, -3000], [12000, 9100]] as const) {
      expect(again.shapeHeight(x, z, terrain.baseHeightAt(x, z))).toBe(layer.shapeHeight(x, z, terrain.baseHeightAt(x, z)));
      expect(again.pavedAt(x, z)).toBe(layer.pavedAt(x, z));
    }
    const other = new Settlements(fakeTerrain(99));
    expect(other.citiesNear(0, 0, 20000)).not.toEqual(layer.citiesNear(0, 0, 20000));
  });

  it('puts cities only on fairly flat dry land, with towers downtown', () => {
    const cities = allCities();
    expect(cities.length).toBeGreaterThan(20);
    for (const c of cities) {
      expect(c.radius).toBeGreaterThanOrEqual(400);
      expect(c.radius).toBeLessThanOrEqual(1200);
      expect(c.maxBuildingHeight).toBeGreaterThanOrEqual(120);
      expect(c.maxBuildingHeight).toBeLessThanOrEqual(200);
      expect(evaluateCitySpot(terrain, c.x, c.z, c.radius)).not.toBeNull();
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        const x = c.x + Math.cos(a) * c.radius;
        const z = c.z + Math.sin(a) * c.radius;
        const h = terrain.baseHeightAt(x, z);
        expect(terrain.waterLevelAt(x, z)).toBeLessThan(h);
        expect(Math.abs(h - c.groundY)).toBeLessThan(maxCityRelief(c.radius) * 1.5);
      }
    }
    const big = cities.reduce((a, b) => (b.radius > a.radius ? b : a));
    const buildings = cityBuildings(big, 1234);
    const tallest = Math.max(...buildings.map((b) => b.height));
    expect(tallest).toBeGreaterThan(80);
    expect(tallest).toBeLessThanOrEqual(big.maxBuildingHeight);
    for (const b of buildings) expect(Math.hypot(b.width, b.depth) / 2).toBeLessThan(25);
  });

  it('flattens city ground and paves its streets', () => {
    const c = allCities()[0]!;
    expect(layer.shapeHeight(c.x + 10, c.z - 20, terrain.baseHeightAt(c.x + 10, c.z - 20))).toBeCloseTo(c.groundY, 6);
    expect(layer.pavedAt(c.x, c.z)).toBe(1);
  });

  it('links each city to its nearest neighbours with roads', () => {
    let linked = 0;
    for (const c of allCities().filter((c) => c.x < 30000)) {
      for (const n of layer.neighbours(c)) {
        const road = layer.road(c, n);
        if (!road) continue;
        linked++;
        const first = road.pieces[0]!;
        const last = road.pieces[road.pieces.length - 1]!;
        const [a, b] = c.id < n.id ? [c, n] : [n, c];
        expect(Math.hypot(first.ax - a.x, first.az - a.z)).toBeLessThan(a.radius);
        expect(Math.hypot(last.bx - b.x, last.bz - b.z)).toBeLessThan(b.radius);
        for (let k = 1; k < road.pieces.length; k++) {
          const p = road.pieces[k]!;
          const q = road.pieces[k - 1]!;
          expect(p.ax).toBe(q.bx);
          expect(p.ay).toBe(q.by);
          // Grade limit (7 %) between neighbouring samples, with slack for the fixed city ends.
          expect(Math.abs(p.by - p.ay)).toBeLessThan(Math.hypot(p.bx - p.ax, p.bz - p.az) * 0.25 + 0.5);
        }
        // Roads are found by area queries along their length.
        const mid = road.pieces[Math.floor(road.pieces.length / 2)]!;
        expect(layer.roadsNear(mid.ax, mid.az, 5)).toContain(mid);
        expect(layer.pavedAt(mid.ax, mid.az) > 0.99 || mid.bridge).toBe(true);
      }
    }
    expect(linked).toBeGreaterThan(10);
  });

  it('builds bridges over the river with ≥ 35 m clearance and a pier-free opening', () => {
    const bridges: BridgeSpan[] = [];
    for (let x = -20000; x <= 35000; x += 4000) {
      for (const b of layer.bridgesNear(x, riverZ(x), 4000) as BridgeSpan[]) if (!bridges.includes(b)) bridges.push(b);
    }
    const overRiver = bridges.filter((b) => Math.abs(b.bottomY - RIVER_LEVEL) < 1e-9);
    expect(overRiver.length).toBeGreaterThan(0);
    for (const b of overRiver) {
      // Near a city the ramps may only allow the 10 m minimum.
      expect(b.deckY - b.bottomY).toBeGreaterThanOrEqual(10 - 1e-9);
      for (const p of b.piers) expect(Math.hypot(p.x - b.x, p.z - b.z)).toBeGreaterThanOrEqual(b.openHalfWidth - 1);
      // A jet flies under the middle of the deck, not through it.
      expect(collideBridge(b, b.x, (b.bottomY + b.deckY) / 2, b.z)).toBe(false);
      expect(collideBridge(b, b.x, b.deckY + 1, b.z)).toBe(true);
      // The ground under the deck keeps its natural height (no fill dam across the river).
      const h = terrain.baseHeightAt(b.x, b.z);
      expect(layer.shapeHeight(b.x, b.z, h)).toBeCloseTo(h, 6);
    }
    expect(overRiver.some((b) => b.deckY - b.bottomY >= 35)).toBe(true);
  });

  it('raises the profile over water, limited by the ramps from the ends', () => {
    const m = 60;
    const ground = new Float64Array(m).fill(50);
    const water = new Float64Array(m).fill(-Infinity);
    for (let i = 28; i < 32; i++) {
      ground[i] = 10;
      water[i] = 14;
    }
    const y = roadProfile(ground, water, 40, 50, 50);
    for (let i = 28; i < 32; i++) expect(y[i]! - 2.5 - water[i]!).toBeGreaterThanOrEqual(35);
    for (let i = 1; i < m; i++) expect(Math.abs(y[i]! - y[i - 1]!)).toBeLessThanOrEqual(40 * 0.07 + 1e-9);
  });

  it('shapes the ground continuously (no jumps between neighbouring samples)', () => {
    const cities = allCities().slice(0, 4);
    const roads = cities.flatMap((c) => layer.neighbours(c).map((n) => layer.road(c, n))).filter((r) => r);
    const starts: Array<[number, number]> = [
      ...cities.map((c): [number, number] => [c.x - c.radius - 500, c.z]),
      ...roads.map((r): [number, number] => {
        const p = r!.pieces[Math.floor(r!.pieces.length / 3)]!;
        return [p.ax - 200, p.az - 200];
      }),
      [layer.airfield.x - 700, layer.airfield.z - 1300],
    ];
    const f = (x: number, z: number): number => layer.shapeHeight(x, z, terrain.baseHeightAt(x, z));
    const step = 0.5;
    for (const [x0, z0] of starts) {
      for (const [dx, dz] of [[1, 0], [0, 1], [0.6, 0.8]] as const) {
        let prev = f(x0, z0);
        for (let s = step; s < 1600; s += step) {
          const v = f(x0 + dx * s, z0 + dz * s);
          // Natural slopes here are < 0.3; flattening blends add at most ~1.2 m/m.
          expect(Math.abs(v - prev)).toBeLessThan(step * 1.6);
          prev = v;
        }
      }
    }
  });

  it('places a flat, dry 1800 m airfield next to the nearest city, air spawn in front of it', () => {
    const a = layer.airfield;
    expect(a.halfLength * 2).toBe(1800);
    expect(a.halfWidth * 2).toBe(50);
    for (let z = a.z - a.halfLength; z <= a.z + a.halfLength; z += 50) {
      for (const x of [a.x - a.halfWidth, a.x, a.x + a.halfWidth]) {
        const h = terrain.baseHeightAt(x, z);
        expect(layer.shapeHeight(x, z, h)).toBeCloseTo(a.height, 6);
        expect(terrain.waterLevelAt(x, z)).toBeLessThan(a.height);
        expect(layer.pavedAt(x, z)).toBe(1);
      }
    }
    const nearest = allCities().sort((p, q) => Math.hypot(p.x, p.z) - Math.hypot(q.x, q.z))[0]!;
    expect(Math.hypot(a.x - nearest.x, a.z - nearest.z)).toBeLessThan(nearest.radius + 4000);
    expect(layer.airSpawn.heading).toBe(0);
    expect(layer.airSpawn.x).toBe(a.x);
    const gap = a.z - a.halfLength - layer.airSpawn.z;
    expect(gap).toBeGreaterThanOrEqual(1000);
    expect(gap).toBeLessThanOrEqual(1500);
  });

  it('answers point queries quickly once the macro cells are built', () => {
    const run = (): number => {
      let s = 0;
      for (let k = 0; k < 200_000; k++) s += layer.shapeHeight((k % 500) * 13, Math.floor(k / 500) * 13, 50) + layer.pavedAt((k % 400) * 17, Math.floor(k / 400) * 11);
      return s;
    };
    run();
    const t0 = performance.now();
    expect(Number.isFinite(run())).toBe(true);
    // 400k queries; generous for a slow shared CI machine (typically well under 1 µs each).
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});

describe('seeded props', { timeout: 60_000 }, () => {
  const world = {
    waterLevelAt: terrain.waterLevelAt,
    citiesNear: (x: number, z: number, r: number) => layer.citiesNear(x, z, r),
    roadsNear: (x: number, z: number, r: number) => layer.roadsNear(x, z, r),
    bridgesNear: (x: number, z: number, r: number) => layer.bridgesNear(x, z, r),
    airfield: layer.airfield,
  };
  const heightAt = (x: number, z: number): number => layer.shapeHeight(x, z, terrain.baseHeightAt(x, z));
  const placement: PlacementOptions = { seed: 1234, heightAt, world };

  it('places city buildings with collision, and no trees on roads, water or streets', () => {
    const city = allCities()[0]!;
    const ci = Math.floor(city.x / 400);
    const cj = Math.floor(city.z / 400);
    let towers = 0;
    for (let j = cj - 4; j <= cj + 4; j++) {
      for (let i = ci - 4; i <= ci + 4; i++) {
        const cell = generateCell(i, j, 400, placement);
        for (const t of cell.trees) {
          expect(Math.hypot(t.x - city.x, t.z - city.z)).toBeGreaterThan(city.radius);
          expect(layer.pavedAt(t.x, t.z)).toBe(0);
          expect(terrain.waterLevelAt(t.x, t.z)).toBeLessThan(t.y);
          expect(layer.roadsNear(t.x, t.z, 4)).toHaveLength(0);
        }
        for (const b of cell.buildings) if (b.roofHeight === 0) towers++;
      }
    }
    expect(towers).toBeGreaterThan(10);
  });

  it('gives city towers collision, packed and unpacked', () => {
    const city = allCities()[0]!;
    const cell = generateCell(Math.floor(city.x / 400), Math.floor(city.z / 400), 400, placement);
    const tower = cell.buildings.filter((b) => b.roofHeight === 0).sort((a, b) => b.wallHeight - a.wallHeight)[0]!;
    expect(tower).toBeDefined();
    const y = tower.y + tower.wallHeight * 0.9;
    expect(collideCell(cell, tower.x, y, tower.z)).toBe('building');
    expect(collidePackedCell(packCell(cell), tower.x, y, tower.z)).toBe('building');
    expect(collideCell(cell, tower.x, tower.y + tower.wallHeight + 2, tower.z)).toBeNull();
    expect(packCell(cell).instances.tower.colors.length / 3).toBe(cell.buildings.filter((b) => b.roofHeight === 0).length);
  });

  it('PropsManager collides with road bridges and reports their decks to the AI', () => {
    const bridge = (() => {
      for (let x = -20000; x <= 35000; x += 4000) {
        const b = (layer.bridgesNear(x, riverZ(x), 4000) as BridgeSpan[]).find((s) => s.deckY - s.bottomY > 20);
        if (b) return b;
      }
      throw new Error('no bridge');
    })();
    const props = new PropsManager({ seed: 1234, heightAt, world: { ...world, heightAt }, useWorker: false });
    const deckTop = bridge.deckY + DECK_THICKNESS;
    expect(props.collide([new Vector3(bridge.x, deckTop + 0.5, bridge.z)])).toBe('arch');
    expect(props.collide([new Vector3(bridge.x, (bridge.bottomY + bridge.deckY) / 2, bridge.z)])).toBeNull();
    const bands: number[] = [];
    const n = props.hazardBands(bridge.x, bridge.z, 10, bands);
    expect(n).toBeGreaterThan(0);
    expect(bands[0]!).toBeLessThanOrEqual(bridge.deckY + 1e-6);
    // Switching back to a world without settlements removes the bridge.
    props.setWorld({ seed: 1234, heightAt: () => 0, useWorker: false });
    expect(props.collide([new Vector3(bridge.x, deckTop + 0.5, bridge.z)])).toBeNull();
    props.dispose();
  });
});
