import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { GunHeat } from '../src/combat/gun';
import { segmentSphereHit } from '../src/combat/math';
import { SeekerLock } from '../src/combat/seeker';
import { NO_WEAPON_INPUT, WeaponSystem, missileId, type WeaponInput } from '../src/combat/WeaponSystem';
import { WEAPON_RULES, type CombatMessage, type Combatant } from '../src/combat/types';

const DT = 1 / 120;
const flat = (): number => -1000;

interface TestJet extends Combatant {
  position: Vector3;
  velocity: Vector3;
  orientation: Quaternion;
  afterburner: boolean;
  alive: boolean;
}

function jet(id: string, position: Vector3, velocity: Vector3, facing = velocity): TestJet {
  const orientation = new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), facing.clone().normalize());
  return { id, position, velocity, orientation, afterburner: false, alive: true };
}

function move(jets: TestJet[], dt: number): void {
  for (const j of jets) j.position.addScaledVector(j.velocity, dt);
}

function run(ws: WeaponSystem, self: TestJet, others: TestJet[], seconds: number, input: Partial<WeaponInput> = {}): void {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    move([self, ...others], DT);
    ws.update(DT, self, others, { ...NO_WEAPON_INPUT, ...input }, flat);
  }
}

describe('gun heat and rate of fire', () => {
  it('fires rateOfFire rounds per second, the first one immediately', () => {
    const gun = new GunHeat();
    let rounds = 0;
    for (let i = 0; i < 120; i++) rounds += gun.update(DT, true).length;
    expect(rounds).toBe(WEAPON_RULES.gun.rateOfFire);
    expect(new GunHeat().update(DT, true)).toHaveLength(1);
  });

  it('overheats under continuous fire, stays silent, then recovers below overheatRecover', () => {
    const g = WEAPON_RULES.gun;
    const gun = new GunHeat();
    let t = 0;
    while (!gun.overheated && t < 30) {
      gun.update(DT, true);
      t += DT;
    }
    expect(gun.overheated).toBe(true);
    // Net heating = rate * heatPerShot - coolRate.
    expect(t).toBeCloseTo(1 / (g.rateOfFire * g.heatPerShot - g.coolRate), 0);
    let silent = 0;
    while (gun.overheated) {
      expect(gun.update(DT, true)).toHaveLength(0);
      silent += DT;
    }
    expect(silent).toBeCloseTo((1 - g.overheatRecover) / g.coolRate, 1);
    expect(gun.heat).toBeLessThan(g.overheatRecover);
    expect(gun.update(DT, true).length).toBe(1);
  });

  it('cools down while the trigger is released', () => {
    const gun = new GunHeat();
    for (let i = 0; i < 120; i++) gun.update(DT, true);
    const hot = gun.heat;
    for (let i = 0; i < 120; i++) gun.update(DT, false);
    expect(gun.heat).toBeCloseTo(Math.max(0, hot - WEAPON_RULES.gun.coolRate), 5);
  });
});

describe('segmentSphereHit', () => {
  const v = (x: number, y: number, z: number) => new Vector3(x, y, z);

  it('hits a static sphere crossed by the segment and misses one beside it', () => {
    expect(segmentSphereHit(v(0, 0, 0), v(0, 0, -100), v(0, 3, -50), v(0, 3, -50), 7)).toBeCloseTo(0.5 - Math.sqrt(40) / 100, 5);
    expect(segmentSphereHit(v(0, 0, 0), v(0, 0, -100), v(0, 10, -50), v(0, 10, -50), 7)).toBeNull();
  });

  it('catches a head-on target that passes the round within one step (no tunnelling)', () => {
    // Neither end position is inside the sphere, but they cross mid-step.
    expect(segmentSphereHit(v(0, 0, 0), v(0, 0, -20), v(0, 0, -40), v(0, 0, 20), 7)).not.toBeNull();
    expect(segmentSphereHit(v(0, 0, 0), v(0, 0, -20), v(0, 0, -40), v(0, 0, -40), 7)).toBeNull();
  });

  it('uses the moving target: a crossing target that left the path is missed, one moving into it is hit', () => {
    // Target crosses x from -30 to +30: the round meets it only if both are there at the same time.
    expect(segmentSphereHit(v(0, 0, 0), v(0, 0, -100), v(-30, 0, -50), v(30, 0, -50), 7)).not.toBeNull();
    expect(segmentSphereHit(v(0, 0, 0), v(0, 0, -100), v(-30, 0, -95), v(30, 0, -95), 7)).toBeNull();
  });
});

describe('seeker lock', () => {
  const self = jet('me', new Vector3(), new Vector3(0, 0, -200));

  it('locks after lockTime with the target in the cone and resets when it leaves', () => {
    const target = jet('b', new Vector3(300, 0, -2000), new Vector3(0, 0, -200));
    const s = new SeekerLock();
    for (let t = 0; t < WEAPON_RULES.missile.lockTime - 0.1; t += DT) s.update(DT, self, [target]);
    expect(s.targetId).toBe('b');
    expect(s.locked).toBe(false);
    expect(s.progress).toBeGreaterThan(0.85);
    for (let t = 0; t < 0.15; t += DT) s.update(DT, self, [target]);
    expect(s.locked).toBe(true);
    target.position.set(2000, 0, -2000); // 45° off the nose
    s.update(DT, self, [target]);
    expect(s.progress).toBe(0);
    expect(s.targetId).toBeNull();
  });

  it('ignores targets out of range, dead or behind, picks the closest, and restarts on a new target', () => {
    const s = new SeekerLock();
    const far = jet('far', new Vector3(0, 0, -(WEAPON_RULES.missile.lockRange + 100)), new Vector3());
    const behind = jet('behind', new Vector3(0, 0, 500), new Vector3());
    const dead = jet('dead', new Vector3(0, 0, -400), new Vector3());
    dead.alive = false;
    s.update(DT, self, [far, behind, dead, self]);
    expect(s.targetId).toBeNull();
    const a = jet('a', new Vector3(0, 0, -3000), new Vector3());
    const b = jet('b', new Vector3(0, 50, -1500), new Vector3());
    for (let i = 0; i < 60; i++) s.update(DT, self, [a, b]);
    expect(s.targetId).toBe('b');
    b.alive = false;
    s.update(DT, self, [a, b]);
    expect(s.targetId).toBe('a');
    expect(s.progress).toBeCloseTo(DT / WEAPON_RULES.missile.lockTime, 6);
  });
});

describe('WeaponSystem', () => {
  const setup = (seed = 1) => {
    const me = jet('me', new Vector3(0, 1000, 0), new Vector3(0, 0, -200));
    const foe = jet('foe', new Vector3(0, 1000, -1500), new Vector3(0, 0, -200));
    return { me, foe, ws: new WeaponSystem('me', { seed }) };
  };

  it('gun: sends one gunFire per round and gunHit for rounds hitting the enemy, never itself', () => {
    const { me, foe, ws } = setup();
    foe.position.z = -500;
    run(ws, me, [foe, me], 0.5, { fireGun: true });
    run(ws, me, [foe, me], 1);
    const out = ws.drainOutbox();
    const fired = out.filter((m) => m.t === 'gunFire');
    const hits = out.filter((m): m is Extract<CombatMessage, { t: 'gunHit' }> => m.t === 'gunHit');
    expect(fired.length).toBeGreaterThanOrEqual(12);
    expect(fired.length).toBeLessThanOrEqual(13);
    expect(hits.length).toBe(fired.length);
    expect(hits.every((h) => h.target === 'foe' && h.damage === WEAPON_RULES.gun.damagePerHit)).toBe(true);
    expect(ws.rounds).toHaveLength(0);
    expect(ws.drainEvents().filter((e) => e.type === 'hit')).toHaveLength(hits.length);
  });

  it('gun: rounds stop at the terrain', () => {
    const { me, ws } = setup();
    me.velocity.set(0, -100, -100);
    me.orientation.setFromUnitVectors(new Vector3(0, 0, -1), me.velocity.clone().normalize());
    me.position.y = 300;
    const ground = (): number => 0;
    ws.update(DT, me, [], { ...NO_WEAPON_INPUT, fireGun: true }, ground);
    for (let i = 0; i < 120; i++) ws.update(DT, me, [], NO_WEAPON_INPUT, ground);
    expect(ws.rounds).toHaveLength(0);
    const impact = ws.drainEvents().find((e) => e.type === 'gunImpact');
    expect(impact?.type === 'gunImpact' && Math.abs(impact.position.y)).toBeLessThan(1);
  });

  it('missile: a locked launch is guided, holding waits for the lock, an early release fires dumb', () => {
    const { me, foe, ws } = setup();
    run(ws, me, [foe], 0.2);
    run(ws, me, [foe], DT, { fireMissile: true, fireMissileHeld: true });
    expect(ws.missiles).toHaveLength(0); // waiting for the lock
    run(ws, me, [foe], 1.2, { fireMissileHeld: true });
    expect(ws.missiles).toHaveLength(1);
    expect(ws.missiles[0]!.targetId).toBe('foe');
    expect(ws.status().missiles).toBe(3);
    expect(ws.status().lock).toBeLessThan(1);
    const launches = ws.drainOutbox().filter((m) => m.t === 'missileLaunch');
    expect(launches).toMatchObject([{ t: 'missileLaunch', id: 'me:1', target: 'foe' }]);

    const early = setup();
    run(early.ws, early.me, [early.foe], 0.2);
    run(early.ws, early.me, [early.foe], DT, { fireMissile: true, fireMissileHeld: true });
    run(early.ws, early.me, [early.foe], 0.3, { fireMissileHeld: true });
    expect(early.ws.missiles).toHaveLength(0);
    run(early.ws, early.me, [early.foe], DT);
    expect(early.ws.missiles).toHaveLength(1);
    expect(early.ws.missiles[0]!.targetId).toBeNull();
  });

  it('missile: no lock and no target fires unguided at once; respects the reload; refill restores everything', () => {
    const { me, ws } = setup();
    run(ws, me, [], DT, { fireMissile: true });
    run(ws, me, [], DT, { fireMissile: true });
    expect(ws.missiles).toHaveLength(1);
    expect(ws.missiles[0]!.targetId).toBeNull();
    for (let i = 0; i < 5; i++) run(ws, me, [], 1.01, { fireMissile: true });
    expect(ws.status().missiles).toBe(0);
    run(ws, me, [], DT, { fireGun: true, releaseFlares: true });
    expect(ws.status().flares).toBe(WEAPON_RULES.flare.count - WEAPON_RULES.flare.salvo);
    ws.refill();
    expect(ws.status()).toMatchObject({ missiles: 4, flares: 30, gunHeat: 0, gunOverheated: false, lock: 0 });
  });

  it('missile: guided shot hits, with ~10 Hz updates and a missileEnd naming the target', () => {
    const { me, foe, ws } = setup();
    foe.position.set(400, 1000, -2500);
    foe.velocity.set(150, 0, -150);
    run(ws, me, [foe], 1.3);
    run(ws, me, [foe], DT, { fireMissile: true });
    run(ws, me, [foe], 1);
    const updates = ws.drainOutbox().filter((m) => m.t === 'missileUpdate');
    expect(updates.length).toBeGreaterThanOrEqual(9);
    expect(updates.length).toBeLessThanOrEqual(11);
    run(ws, me, [foe], 12);
    const end = ws.drainOutbox().find((m) => m.t === 'missileEnd');
    expect(end).toMatchObject({ t: 'missileEnd', hit: 'foe', damage: WEAPON_RULES.missile.damage });
  });

  it('missile ids satisfy the relay id rule even for long or odd player ids', () => {
    const id = missileId('3f2a9c1e-7b44-4d0e-9a51-8c2d6e0f1a2b/x y', 123456);
    expect(id).toMatch(/^[\w.:-]{1,32}$/);
    expect(missileId('', 1)).toBe('m:1');
  });

  it('flares: salvo with cooldown and a flares message', () => {
    const { me, ws } = setup();
    run(ws, me, [], DT, { releaseFlares: true });
    run(ws, me, [], DT, { releaseFlares: true });
    expect(ws.status().flares).toBe(28);
    expect(ws.flares).toHaveLength(2);
    run(ws, me, [], WEAPON_RULES.flare.cooldown, {});
    run(ws, me, [], DT, { releaseFlares: true });
    expect(ws.status().flares).toBe(26);
    const msgs = ws.drainOutbox().filter((m) => m.t === 'flares');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ t: 'flares', n: 2 });
    run(ws, me, [], WEAPON_RULES.flare.life + 0.1);
    expect(ws.flares).toHaveLength(0);
  });

  it('remote messages: tracers, damage from hits, incoming-missile warning and explosions', () => {
    const { me, ws } = setup();
    ws.applyRemote('foe', { t: 'gunFire', p: [0, 1000, -900], v: [0, 0, 1200] });
    expect(ws.rounds).toHaveLength(1);
    ws.applyRemote('foe', { t: 'gunHit', target: 'me', damage: 0.05 });
    ws.applyRemote('foe', { t: 'gunHit', target: 'someone', damage: 0.05 });
    ws.applyRemote('foe', { t: 'missileLaunch', id: 'foe:1', target: 'me', p: [0, 1000, -2000], v: [0, 0, 300] });
    run(ws, me, [], 0.1);
    expect(ws.rounds.every((r) => r.remote)).toBe(true);
    expect(ws.status().incomingMissile).toBe(true);
    ws.applyRemote('foe', { t: 'missileUpdate', id: 'foe:1', p: [0, 1000, -1800], v: [300, 0, 0] });
    run(ws, me, [], 0.5);
    expect(ws.status().incomingMissile).toBe(false); // flying away (decoyed)
    ws.applyRemote('foe', { t: 'missileEnd', id: 'foe:1', p: [0, 1000, -10], hit: 'me', damage: 0.85 });
    expect(ws.remoteMissiles).toHaveLength(0);
    const events = ws.drainEvents();
    const damage = events.filter((e) => e.type === 'damaged');
    expect(damage).toEqual([
      { type: 'damaged', by: 'foe', cause: 'gun', damage: 0.05 },
      { type: 'damaged', by: 'foe', cause: 'missile', damage: 0.85 },
    ]);
    expect(events.some((e) => e.type === 'explosion')).toBe(true);
    // Our own ordnance never damages us and nothing local is ever hit-tested against the remote tracers.
    expect(ws.drainOutbox().filter((m) => m.t === 'gunHit')).toHaveLength(0);
  });
});
