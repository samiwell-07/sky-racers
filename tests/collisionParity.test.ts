import { Group, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createFlightConfig } from '../src/config/flightConfig';
import { LANDMARKS, TERRAIN_CONFIG } from '../src/config/worldConfig';
import { Jet } from '../src/entities/jet/Jet';
import { JET_CATALOG } from '../src/entities/jet/jetCatalog';
import { AIRacer } from '../src/game/AIRacer';
import { BUILTIN_COURSES, resolveCourse } from '../src/race/Course';
import { CollisionSystem, IMPACT_RULES, ImpactTracker, type ImpactEvent } from '../src/systems/CollisionSystem';
import { Weather } from '../src/world/environment/Weather';
import { PropsManager } from '../src/world/props/PropsManager';
import { generateCell } from '../src/world/props/propsPlacement';
import type { PlacementOptions } from '../src/world/props/propsPlacement';
import { HeightField, valleyCenterX } from '../src/world/terrain/HeightField';

const heightField = new HeightField(TERRAIN_CONFIG);
const heightAt = (x: number, z: number): number => heightField.getHeightAt(x, z);
const placement: PlacementOptions = { seed: TERRAIN_CONFIG.seed, heightAt, valleyCenterX, powerLineZ: [...LANDMARKS.powerLineZ], archZ: [...LANDMARKS.archZ] };
const props = new PropsManager({ seed: placement.seed, heightAt, valleyCenterX, powerLineZ: [...LANDMARKS.powerLineZ], archZ: [...LANDMARKS.archZ], useWorker: false });
const collision = new CollisionSystem(heightField, props);
const course = resolveCourse(BUILTIN_COURSES[0]!, heightField);
const weather = new Weather({ windSpeed: 0, windDirection: 0, turbulence: 0 });
const DT = 1 / 120;
const HEADING = Math.PI / 2;

/** A pose whose airframe (collision points) hits an obstacle of the given kind and nothing else. */
function poseInside(kind: 'tree' | 'building'): Vector3 {
  const probe = spawnPlayer(new Vector3());
  for (let k = 0; k < 600; k++) {
    const cell = generateCell((k % 30) - 15, Math.floor(k / 30) - 10, 400, placement);
    const candidates =
      kind === 'tree'
        ? cell.trees.map((t) => new Vector3(t.x, t.y + t.height * 0.4, t.z))
        : cell.buildings.map((b) => new Vector3(b.x, b.y + b.wallHeight * 0.6, b.z));
    for (const c of candidates) {
      // Slide the jet along its axis (heading +90°: nose toward -X) so a fuselage point sits in the obstacle.
      for (const along of [-3, 4, 0, -9]) {
        const p = c.clone().setX(c.x - along);
        probe.reset({ position: p, orientation: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), HEADING), speed: 0, throttle: 0 });
        const r = collision.check(probe.getWorldCollisionPoints([]));
        if (r.scrape) continue;
        if (kind === 'tree' ? r.tree && !r.crash : r.crash === 'building') return p;
      }
    }
  }
  throw new Error(`no ${kind} found`);
}

/** The player's path in Game.fixedUpdate: one physics step, then CollisionSystem + ImpactTracker. */
function playerStep(jet: Jet, impacts: ImpactTracker): ImpactEvent | null {
  impacts.tick(DT);
  jet.fixedUpdate(DT, { pitch: 0, roll: 0, throttle: 0 });
  return impacts.apply(collision.check(jet.getWorldCollisionPoints([])), jet);
}

function spawnAI(at: Vector3): AIRacer {
  const ai = new AIRacer('AI', JET_CATALOG[0]!, 0.8, course.gates.length, 1, 1, new Group());
  ai.place(at, HEADING, 60);
  return ai;
}

function spawnPlayer(at: Vector3): Jet {
  const jet = new Jet(JET_CATALOG[0]!, createFlightConfig(JET_CATALOG[0]!.flight), false);
  jet.reset({ position: at, orientation: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), HEADING), speed: 60, throttle: 0.75 });
  return jet;
}

describe('player / AI collision parity', { timeout: 60_000 }, () => {
  it('a tree strike costs the AI exactly what it costs the player, with the same cooldown', () => {
    const at = poseInside('tree');
    const ai = spawnAI(at.clone());
    const player = spawnPlayer(at.clone());
    const impacts = new ImpactTracker();

    ai.fixedUpdate(DT, course.gates, 0, heightField, weather, collision);
    const hit = playerStep(player, impacts);
    expect(hit).toEqual({ kind: 'damage', tree: true, destroyed: false });
    expect(ai.damageHits).toBe(1);
    expect(ai.crashed).toBe(false);
    expect(ai.jet.damage.health).toBeCloseTo(1 - IMPACT_RULES.treeDamage, 6);
    expect(player.damage.health).toBeCloseTo(ai.jet.damage.health, 6);

    // Still in the crown on the next step: the cooldown protects both.
    ai.fixedUpdate(DT, course.gates, DT, heightField, weather, collision);
    playerStep(player, impacts);
    expect(ai.damageHits).toBe(1);
    expect(player.damage.health).toBeCloseTo(ai.jet.damage.health, 6);
  });

  it('flying into a building crashes the AI like the player, with the player respawn delay', () => {
    const at = poseInside('building');
    const ai = spawnAI(at.clone());
    const hit = playerStep(spawnPlayer(at.clone()), new ImpactTracker());
    expect(hit).toEqual({ kind: 'crash', reason: 'building' });

    ai.fixedUpdate(DT, course.gates, 0, heightField, weather, collision);
    expect(ai.crashed).toBe(true);
    expect(ai.lastCrashReason).toBe('building');
    let t = 0;
    while (ai.crashed && t < 10) {
      ai.fixedUpdate(DT, course.gates, t, heightField, weather, collision);
      t += DT;
    }
    expect(t).toBeCloseTo(IMPACT_RULES.respawnDelay, 1);
    // Respawned on the approach to its next gate, repaired.
    expect(ai.jet.damage.health).toBe(1);
    expect(collision.check(ai.jet.getWorldCollisionPoints([])).crash).toBeNull();
  });

  it('a wingtip scrape damages and lifts the AI like the player (it used to ignore extremities)', () => {
    const x = valleyCenterX(0);
    const at = new Vector3(x, heightField.getSurfaceHeight(x, 0) + 3, 0);
    // Banked 60°: the low wingtip, stores and stabilizer dig ~3 m into the ground, the fuselage stays clear.
    const roll = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 3);
    const ai = spawnAI(at.clone());
    ai.jet.flight.state.orientation.multiply(roll);
    const player = spawnPlayer(at.clone());
    player.flight.state.orientation.multiply(roll);

    ai.fixedUpdate(DT, course.gates, 0, heightField, weather, collision);
    const hit = playerStep(player, new ImpactTracker());
    expect(hit).toEqual({ kind: 'damage', tree: false, destroyed: false });
    expect(ai.crashed).toBe(false);
    expect(ai.damageHits).toBe(1);
    expect(ai.jet.damage.health).toBeCloseTo(1 - IMPACT_RULES.scrapeDamage, 6);
    expect(player.damage.health).toBeCloseTo(ai.jet.damage.health, 6);
    // Both pushed back up out of the ground.
    expect(ai.jet.position.y).toBeGreaterThan(at.y + 2);
    expect(player.position.y).toBeGreaterThan(at.y + 2);
  });
});
