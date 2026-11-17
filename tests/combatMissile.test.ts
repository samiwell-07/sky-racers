import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { GRAVITY, closestApproach } from '../src/combat/math';
import { Missile, type TrackTarget } from '../src/combat/missile';
import { AFTERBURNER_DECOY_FACTOR, rollFlareDecoys, spawnFlareSalvo } from '../src/combat/flares';
import { NO_WEAPON_INPUT, WeaponSystem } from '../src/combat/WeaponSystem';
import { WEAPON_RULES, type Combatant } from '../src/combat/types';
import { mulberry32 } from '../src/utils/random';

const DT = 1 / 120;
const flat = (): number => -1e4;
const MAX_ACCEL = WEAPON_RULES.missile.maxG * GRAVITY;

interface Target extends TrackTarget {
  position: Vector3;
  velocity: Vector3;
  alive: boolean;
}

/** Flies a missile at a target moved by `advance`; returns the hit time or null, and the peak lateral accel. */
function engage(missile: Missile, target: Target, advance: (t: Target, dt: number) => void) {
  let peakCommand = 0;
  let peakMeasured = 0;
  const prevTarget = new Vector3();
  const v0 = new Vector3();
  const dv = new Vector3();
  while (missile.alive) {
    prevTarget.copy(target.position);
    advance(target, DT);
    v0.copy(missile.velocity);
    const res = missile.step(DT, missile.targetId ? target : null, flat);
    peakCommand = Math.max(peakCommand, missile.lastLateralAccel);
    // Measured acceleration perpendicular to the flight path, without gravity.
    dv.subVectors(missile.velocity, v0).divideScalar(DT);
    dv.y += GRAVITY;
    const along = v0.clone().normalize();
    dv.addScaledVector(along, -dv.dot(along));
    peakMeasured = Math.max(peakMeasured, dv.length());
    if (missile.armed && closestApproach(missile.previous, missile.position, prevTarget, target.position).distance <= WEAPON_RULES.missile.fuseRadius) {
      return { hitAt: missile.age, peakCommand, peakMeasured };
    }
    if (res) break;
  }
  return { hitAt: null, peakCommand, peakMeasured };
}

const launch = (targetId: string | null = 'b') =>
  new Missile('a:1', 'a', targetId, new Vector3(0, 2000, 0), new Vector3(0, 0, -230));

describe('missile flight (proportional navigation)', () => {
  it('hits a straight crossing target within its life', () => {
    const target: Target = { position: new Vector3(-900, 2100, -3000), velocity: new Vector3(240, 0, 0), alive: true };
    const r = engage(launch(), target, (t, dt) => t.position.addScaledVector(t.velocity, dt));
    expect(r.hitAt).not.toBeNull();
    expect(r.hitAt!).toBeLessThan(WEAPON_RULES.missile.maxLife);
    expect(r.peakCommand).toBeLessThanOrEqual(MAX_ACCEL + 1e-6);
    expect(r.peakMeasured).toBeLessThanOrEqual(MAX_ACCEL * 1.02);
  });

  it('hits a target in a hard 7 g turn, never pulling more than maxG', () => {
    const speed = 250;
    const omega = (7 * GRAVITY) / speed;
    const target: Target = { position: new Vector3(300, 2000, -2500), velocity: new Vector3(speed, 0, 0), alive: true };
    const r = engage(launch(), target, (t, dt) => {
      t.velocity.applyAxisAngle(new Vector3(0, 1, 0), omega * dt);
      t.position.addScaledVector(t.velocity, dt);
    });
    expect(r.hitAt).not.toBeNull();
    expect(r.peakCommand).toBeLessThanOrEqual(MAX_ACCEL + 1e-6);
    expect(r.peakMeasured).toBeLessThanOrEqual(MAX_ACCEL * 1.02);
  });

  it('boosts for burnTime, then slows; a dumb missile flies ballistic and self-destructs at maxLife', () => {
    const m = launch(null);
    const target: Target = { position: new Vector3(0, 0, 1e6), velocity: new Vector3(), alive: true };
    let speedAtBurnout = 0;
    let result: string | null = null;
    while (m.alive) {
      result = m.step(DT, null, flat);
      if (speedAtBurnout === 0 && !m.burning) speedAtBurnout = m.velocity.length();
    }
    expect(speedAtBurnout).toBeGreaterThan(230 + WEAPON_RULES.missile.boostSpeed - 30);
    expect(m.velocity.length()).toBeLessThan(speedAtBurnout);
    expect(result).toBe('expired');
    expect(m.age).toBeCloseTo(WEAPON_RULES.missile.maxLife, 1);
    expect(target.alive).toBe(true);
  });

  it('explodes on the terrain and loses a target that leaves the seeker gimbal', () => {
    const m = new Missile('a:2', 'a', 'b', new Vector3(0, 50, 0), new Vector3(0, -100, -200));
    let res: string | null = null;
    while (m.alive) res = m.step(DT, null, () => 0);
    expect(res).toBe('terrain');

    const g = launch();
    const behind: Target = { position: new Vector3(0, 2000, 500), velocity: new Vector3(), alive: true };
    g.step(DT, behind, flat);
    expect(g.targetId).toBeNull();
    expect(g.guided).toBe(false);
  });
});

describe('flares', () => {
  const victim = (afterburner = false) => ({
    position: new Vector3(0, 2000, -2000),
    velocity: new Vector3(0, 0, -220),
    afterburner,
  });

  const decoyRate = (afterburner: boolean, seeds = 400) => {
    let decoyed = 0;
    for (let seed = 1; seed <= seeds; seed++) {
      const v = victim(afterburner);
      const m = launch();
      const flares = spawnFlareSalvo('b', v.position, v.velocity, 2);
      decoyed += rollFlareDecoys([m], 'b', v.afterburner, flares, mulberry32(seed)).length;
    }
    return decoyed / seeds;
  };

  it('fall with drag and gravity and burn for `life`', () => {
    const v = victim();
    const [f] = spawnFlareSalvo('b', v.position, v.velocity, 1);
    const y0 = f!.position.y;
    for (let t = 0; t < 2; t += DT) f!.step(DT, flat);
    expect(f!.velocity.length()).toBeLessThan(100);
    expect(f!.position.y).toBeLessThan(y0 - 10);
    expect(f!.alive).toBe(true);
    for (let t = 0; t < WEAPON_RULES.flare.life - 1.9; t += DT) f!.step(DT, flat);
    expect(f!.alive).toBe(false);
  });

  it('decoy a tracking missile with decoyChance (deterministic per seed), less often when afterburning', () => {
    const once = (seed: number) => rollFlareDecoys([launch()], 'b', false, spawnFlareSalvo('b', victim().position, victim().velocity, 2), mulberry32(seed)).length;
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(once)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map(once));
    expect(decoyRate(false)).toBeCloseTo(WEAPON_RULES.flare.decoyChance, 1);
    expect(decoyRate(true)).toBeCloseTo(WEAPON_RULES.flare.decoyChance * AFTERBURNER_DECOY_FACTOR, 1);
  });

  it('never decoy a missile tracking someone else or when no flare is in the seeker cone', () => {
    const v = victim();
    const flares = spawnFlareSalvo('b', v.position, v.velocity, 2);
    expect(rollFlareDecoys([launch('c')], 'b', false, flares, () => 0)).toHaveLength(0);
    const sideways = spawnFlareSalvo('b', new Vector3(3000, 2000, 0), v.velocity, 2);
    expect(rollFlareDecoys([launch()], 'b', false, sideways, () => 0)).toHaveLength(0);
  });

  it('a decoyed missile flies to the flare and misses the jet', () => {
    const v = victim();
    const m = launch();
    const flares = spawnFlareSalvo('b', v.position, v.velocity, 2);
    expect(rollFlareDecoys([m], 'b', false, flares, () => 0)).toEqual([m]);
    const jet: Target = { position: v.position.clone(), velocity: new Vector3(0, 200, -150), alive: true };
    const r = engage(m, jet, (t, dt) => {
      t.position.addScaledVector(t.velocity, dt);
      for (const f of flares) f.step(dt, flat);
    });
    expect(r.hitAt).toBeNull();
  });

  it('remote flares decoy our in-flight missile through WeaponSystem.applyRemote (fixed seed)', () => {
    const results: boolean[] = [];
    for (let seed = 1; seed <= 6; seed++) {
      const me: Combatant = {
        id: 'me',
        position: new Vector3(0, 2000, 0),
        velocity: new Vector3(0, 0, -220),
        orientation: new Quaternion(),
        afterburner: false,
        alive: true,
      };
      const foe = { ...victim(), id: 'foe', orientation: new Quaternion(), alive: true };
      const ws = new WeaponSystem('me', { seed });
      for (let t = 0; t < 1.3; t += DT) ws.update(DT, me, [foe], NO_WEAPON_INPUT, flat);
      ws.update(DT, me, [foe], { ...NO_WEAPON_INPUT, fireMissile: true }, flat);
      expect(ws.missiles[0]?.targetId).toBe('foe');
      ws.applyRemote('foe', { t: 'flares', p: [0, 2000, -2000], v: [0, 0, -220], n: 2 });
      const decoyed = ws.missiles[0]!.decoy !== null;
      expect(ws.drainEvents().some((e) => e.type === 'decoyed')).toBe(decoyed);
      results.push(decoyed);
    }
    const again = new WeaponSystem('me', { seed: 1 });
    expect(again).toBeTruthy();
    expect(results.some((d) => d)).toBe(true);
    expect(results).toMatchSnapshot();
  });
});
