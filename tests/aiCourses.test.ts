import { Group } from 'three';
import { describe, expect, it } from 'vitest';
import { LANDMARKS, TERRAIN_CONFIG } from '../src/config/worldConfig';
import { JET_CATALOG } from '../src/entities/jet/jetCatalog';
import { AIRacer } from '../src/game/AIRacer';
import { BUILTIN_COURSES, resolveCourse } from '../src/race/Course';
import { CollisionSystem } from '../src/systems/CollisionSystem';
import { Weather } from '../src/world/environment/Weather';
import { PropsManager } from '../src/world/props/PropsManager';
import { HeightField, valleyCenterX } from '../src/world/terrain/HeightField';

const heightField = new HeightField(TERRAIN_CONFIG);
// Same obstacles as the game (Game constructor); no Worker in Node, so cells are generated synchronously.
const props = new PropsManager({
  seed: TERRAIN_CONFIG.seed,
  heightAt: (x, z) => heightField.getHeightAt(x, z),
  valleyCenterX,
  powerLineZ: [...LANDMARKS.powerLineZ],
  archZ: [...LANDMARKS.archZ],
  clearZones: [{ x: heightField.runway.x, z: heightField.runway.z, halfWidth: 140, halfLength: heightField.runway.halfLength + 300, heading: 0 }],
  useWorker: false,
});
const collision = new CollisionSystem(heightField, props);

describe.each(BUILTIN_COURSES.map((c) => [c.name, c] as const))('AI on %s', (name, def) => {
  it('flies a full lap through the real terrain and obstacles, with the player collision rules', () => {
    const course = resolveCourse(def, heightField);
    const weather = new Weather({ windSpeed: 6, windDirection: 90, turbulence: 0.5 });
    const ai = new AIRacer('Test', JET_CATALOG[0]!, 0.8, course.gates.length, 1, 1, new Group());
    ai.place(course.start.position.clone(), course.start.heading, course.start.speed);
    const dt = 1 / 120;
    const missedGates: number[] = [];
    let t = 0;
    for (; t < 240 && !ai.progress.finished; t += dt) {
      weather.tick(dt);
      const gate = ai.progress.gateIndex;
      const missedBefore = ai.progress.missed;
      ai.fixedUpdate(dt, course.gates, t, heightField, weather, collision);
      if (ai.progress.missed > missedBefore) missedGates.push(gate);
    }
    // Representative completion with obstacle immunity removed (see the test output).
    console.info(`[aiCourses] ${name}: finished=${ai.progress.finished} time=${t.toFixed(1)} s crashes=${ai.crashCount} hits=${ai.damageHits} health=${ai.jet.damage.health.toFixed(2)}`);
    expect(ai.progress.finished).toBe(true);
    expect(missedGates).toEqual([]);
    expect(ai.crashCount).toBe(0);
    expect(ai.damageHits).toBe(0);
  }, 120_000);
});
