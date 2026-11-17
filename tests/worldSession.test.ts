import { describe, expect, it } from 'vitest';
import { SPAWN_CONFIG } from '../src/config/worldConfig';
import { freeSpawnPose, menuCameraPose, menuOrbitHeight, propsOptionsFor } from '../src/game/worldSession';
import { createWorld } from '../src/world/gen/createWorld';
import { CLASSIC_WORLD, type WorldGenerator } from '../src/world/gen/WorldGenerator';

const classic = createWorld(CLASSIC_WORLD);
const surface = (x: number, z: number): number => x * 0.01 + z * 0.02;

/** A non-Classic world: only what the helpers read. */
const fakeSeeded = {
  spec: { kind: 'seeded', seed: 7 },
  config: classic.config,
  airfield: { x: 5000, z: -3000, halfWidth: 25, halfLength: 900, height: 42 },
  airSpawn: { x: 5000, z: -1500, heading: Math.PI / 2 },
  heightAt: () => 0,
} as unknown as WorldGenerator;

describe('freeSpawnPose', () => {
  it('keeps the Classic spawns (runway grid and air start)', () => {
    const r = classic.airfield;
    expect(freeSpawnPose(classic, 3, true, surface, 2)).toEqual({ x: r.x - 14, y: r.height + 2, z: r.z + r.halfLength - 80 - 120, heading: 0, speed: 0, onGround: true });
    const z = SPAWN_CONFIG.z + 240;
    const air = freeSpawnPose(classic, 4, false, surface, 2);
    expect(air).toMatchObject({ heading: 0, speed: SPAWN_CONFIG.speed, onGround: false });
    expect(air.x).toBeCloseTo(r.x + 42);
    expect(air.z).toBeCloseTo(z);
    expect(air.y).toBeCloseTo(surface(r.x, z) + SPAWN_CONFIG.heightAboveGround);
  });

  it('spawns on a seeded world airfield, and behind its rotated air start', () => {
    const r = fakeSeeded.airfield;
    expect(freeSpawnPose(fakeSeeded, 0, true, surface, 2)).toMatchObject({ x: r.x, y: r.height + 2, z: r.z + r.halfLength - 80, heading: 0 });
    // Heading π/2 flies toward -X: slot 2 sits 120 m behind (+X) and 42 m to the right.
    const p = freeSpawnPose(fakeSeeded, 2, false, surface, 2);
    expect(p.heading).toBe(Math.PI / 2);
    expect(p.x).toBeCloseTo(5120);
    expect(p.z).toBeCloseTo(-1500 - 42);
  });
});

describe('menu flyover', () => {
  it('runs down the Classic canyon centerline', () => {
    const p = menuCameraPose(classic, 0, surface, 0);
    expect(p.position[0]).toBeCloseTo(classic.classicValleyCenterX!(1500));
    expect(p.position[2]).toBe(1500);
  });

  it('orbits the air start above every sampled ground point elsewhere', () => {
    const hilly = (x: number, z: number): number => 300 + 200 * Math.sin(x / 300) * Math.cos(z / 400);
    const y = menuOrbitHeight(fakeSeeded, hilly);
    for (const t of [0, 10, 50, 120]) {
      const p = menuCameraPose(fakeSeeded, t, hilly, y);
      expect(p.position[1]).toBeGreaterThan(hilly(p.position[0], p.position[2]) + 100);
      expect(p.target[0]).toBe(5000);
    }
  });
});

describe('propsOptionsFor', () => {
  it('keeps Classic landmarks and passes seeded worlds through', () => {
    expect(propsOptionsFor(classic).powerLineZ?.length).toBeGreaterThan(0);
    const o = propsOptionsFor(fakeSeeded);
    expect(o.world).toBe(fakeSeeded);
    expect(o.powerLineZ).toBeUndefined();
  });
});
