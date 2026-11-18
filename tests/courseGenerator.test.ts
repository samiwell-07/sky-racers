import { Group } from 'three';
import { describe, expect, it } from 'vitest';
import { TERRAIN_CONFIG } from '../src/config/worldConfig';
import { JET_CATALOG } from '../src/entities/jet/jetCatalog';
import { AIRacer } from '../src/game/AIRacer';
import { resolveCourse, type CourseDef } from '../src/race/Course';
import { generateCourse, generateCourseDetailed, generateCourseForRequest, generatedCourseById, listGeneratedCourses, DIFFICULTY_PARAMS } from '../src/race/CourseGenerator';
import { generatedCourseId } from '../src/race/generatedCourse';
import { GATE_CENTER_OFFSET } from '../src/race/gen/courseGeometry';
import { CollisionSystem } from '../src/systems/CollisionSystem';
import { Weather } from '../src/world/environment/Weather';
import { createWorld } from '../src/world/gen/createWorld';
import type { WorldGenerator } from '../src/world/gen/WorldGenerator';
import { HeightField } from '../src/world/terrain/HeightField';

const SEED = 12345;
const world = createWorld({ kind: 'seeded', seed: SEED });
const heightField = new HeightField(world);

function fakeWorld(seed: number, heightAt: (x: number, z: number) => number, water: number): WorldGenerator {
  return {
    spec: { kind: 'seeded', seed },
    config: TERRAIN_CONFIG,
    heightAt,
    waterLevelAt: () => water,
    biomeAt: () => (water > -Infinity ? 'ocean' : 'mountains'),
    surfaceAt: (_x, _z, out) => out,
    canyonFactor: () => 0,
    airfield: { x: 0, z: 0, halfWidth: 25, halfLength: 900, height: 0 },
    airSpawn: { x: 0, z: -2000, heading: 0 },
    citiesNear: () => [],
    roadsNear: () => [],
    bridgesNear: () => [],
  };
}

/** Every gate sits above the surface and every straight leg clears it (resolved like the game does). */
function expectClear(def: CourseDef, hf: HeightField, margin: number): void {
  const course = resolveCourse(def, hf);
  const g = course.gates;
  for (const gate of g) {
    expect(gate.center.y).toBeGreaterThanOrEqual(hf.getSurfaceHeight(gate.center.x, gate.center.z) + GATE_CENTER_OFFSET - 0.01);
  }
  const legs = def.loop ? g.length : g.length - 1;
  for (let i = 0; i < legs; i++) {
    const a = g[i]!.center;
    const b = g[(i + 1) % g.length]!.center;
    for (let t = 0; t <= 1; t += 0.02) {
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      const y = a.y + (b.y - a.y) * t;
      expect(y - hf.getSurfaceHeight(x, z), `leg ${i} at t=${t.toFixed(2)}`).toBeGreaterThan(margin);
    }
  }
}

describe('CourseGenerator', () => {
  it('is deterministic per seed and differs between worlds', () => {
    const a = generateCourseDetailed(world, SEED, 'medium', 'sprint');
    expect(generateCourse(world, SEED, 'medium', 'sprint')).toBe(a.def);
    // Fresh world instance (no cache): identical gates.
    const again = generateCourse(fakeCopy(world), SEED, 'medium', 'sprint');
    expect(again.gates).toEqual(a.def.gates);
    const other = generateCourse(createWorld({ kind: 'seeded', seed: 777 }), 777, 'medium', 'sprint');
    expect(other.gates).not.toEqual(a.def.gates);
    expect(a.def.id).toBe(generatedCourseId({ world: world.spec, layout: 'sprint', difficulty: 'medium' }));
    expect(a.def.world).toEqual(world.spec);
    expect(a.def.name).toMatch(/Sprint – Medium$/);
  });

  it('keeps gates and legs clear of the terrain for every difficulty and layout', () => {
    for (const entry of listGeneratedCourses(world, SEED)) {
      const def = entry.course();
      const p = DIFFICULTY_PARAMS[entry.difficulty];
      expect(def.gates.length).toBeGreaterThanOrEqual(p.gates[0]);
      expect(def.gates.length).toBeLessThanOrEqual(p.gates[1]);
      expect(def.loop).toBe(entry.layout === 'loop');
      // Generator margin minus the gap between the analytic world and the rendered grid.
      expectClear(def, heightField, p.margin * 0.5);
    }
  });

  it('starts at the air spawn and sprints finish far from it', () => {
    const s = world.airSpawn;
    for (const layout of ['sprint', 'loop'] as const) {
      const def = generateCourse(world, SEED, 'easy', layout);
      expect(def.start).toEqual({ x: Math.round(s.x), z: Math.round(s.z) });
      const first = def.gates[0]!;
      expect(Math.hypot(first.x - s.x, first.z - s.z)).toBeLessThan(1200);
      if (layout === 'sprint') {
        const last = def.gates[def.gates.length - 1]!;
        expect(Math.hypot(last.x - s.x, last.z - s.z)).toBeGreaterThan(3000);
      }
    }
  });

  it('orders difficulties: hard has more gates and a higher turn load than easy', () => {
    for (const seed of [SEED, 777]) {
      const w = createWorld({ kind: 'seeded', seed });
      for (const layout of ['sprint', 'loop'] as const) {
        const easy = generateCourseDetailed(w, seed, 'easy', layout);
        const hard = generateCourseDetailed(w, seed, 'hard', layout);
        expect(hard.def.gates.length).toBeGreaterThan(easy.def.gates.length);
        expect(hard.stats.peakLoad).toBeGreaterThan(easy.stats.peakLoad);
        expect(easy.stats.maxLoad).toBeLessThanOrEqual(DIFFICULTY_PARAMS.easy.maxG);
        expect(hard.stats.maxLoad).toBeLessThanOrEqual(DIFFICULTY_PARAMS.hard.maxG);
      }
    }
  });

  it('falls back to a safe course on an all-ocean or all-mountain world', () => {
    const ocean = fakeWorld(900001, () => -200, 0);
    const mountains = fakeWorld(900002, (x, z) => 1500 + 900 * Math.abs(Math.sin(x / 90) * Math.cos(z / 110)), -Infinity);
    for (const w of [ocean, mountains]) {
      for (const layout of ['sprint', 'loop'] as const) {
        const r = generateCourseDetailed(w, 1, 'hard', layout);
        expect(r.def.gates.length).toBeGreaterThanOrEqual(DIFFICULTY_PARAMS.hard.gates[0]);
        expect(r.def.gates.every((g) => Number.isFinite(g.x) && Number.isFinite(g.z) && (g.clearance ?? 0) >= 0)).toBe(true);
        expectClear(r.def, new HeightField(w), 10);
      }
    }
    expect(generateCourseDetailed(mountains, 1, 'easy', 'loop').stats.fallback).toBe(true);
  });

  it('resolves lobby requests and ids', () => {
    const req = { world: { kind: 'seeded' as const, seed: SEED }, difficulty: 'hard' as const, layout: 'loop' as const };
    const def = generateCourseForRequest(req);
    expect(def).toBe(generateCourse(world, SEED, 'hard', 'loop'));
    expect(generatedCourseById(def.id)).toBe(def);
    expect(generatedCourseById('canyon-loop')).toBeNull();
  });

  it.each([['medium', 'sprint'], ['hard', 'loop']] as const)('AI flies the %s %s course without crashing', (difficulty, layout) => {
    const def = generateCourse(world, SEED, difficulty, layout);
    const course = resolveCourse(def, heightField);
    const collision = new CollisionSystem(heightField, null);
    const weather = new Weather({ windSpeed: 0, windDirection: 0, turbulence: 0 });
    const ai = new AIRacer('Test', JET_CATALOG[0]!, 0.8, course.gates.length, 1, 1, new Group());
    ai.place(course.start.position.clone(), course.start.heading, course.start.speed);
    const dt = 1 / 60;
    const missed: number[] = [];
    let t = 0;
    for (; t < 200 && !ai.progress.finished; t += dt) {
      const gate = ai.progress.gateIndex;
      const before = ai.progress.missed;
      ai.fixedUpdate(dt, course.gates, t, heightField, weather, collision);
      if (ai.progress.missed > before) missed.push(gate);
    }
    console.info(`[courseGenerator] ${def.name}: finished=${ai.progress.finished} t=${t.toFixed(1)} s missed=${missed.join(',')} crashes=${ai.crashCount}`);
    expect(ai.progress.finished).toBe(true);
    expect(ai.crashCount).toBe(0);
    expect(missed).toEqual([]);
  }, 120_000);
});

/** Same world behaviour behind a new object identity (bypasses the per-world course cache). */
function fakeCopy(w: WorldGenerator): WorldGenerator {
  return {
    spec: w.spec,
    config: w.config,
    heightAt: (x, z) => w.heightAt(x, z),
    waterLevelAt: (x, z) => w.waterLevelAt(x, z),
    biomeAt: (x, z) => w.biomeAt(x, z),
    surfaceAt: (x, z, o) => w.surfaceAt(x, z, o),
    canyonFactor: (x, z) => w.canyonFactor(x, z),
    airfield: w.airfield,
    airSpawn: w.airSpawn,
    citiesNear: (x, z, r) => w.citiesNear(x, z, r),
    roadsNear: (x, z, r) => w.roadsNear(x, z, r),
    bridgesNear: (x, z, r) => w.bridgesNear(x, z, r),
  };
}
