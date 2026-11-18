import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { DOGFIGHT_RULES, type CombatMessage, type DogfightScore } from '../src/combat/types';
import { NO_WEAPON_INPUT } from '../src/combat';
import { DogfightSession, type DogfightHooks, type DogfightJet, type DogfightSpawn } from '../src/modes/DogfightSession';
import { DogfightCore } from '../src/modes/dogfight/DogfightCore';
import { ZoneWall } from '../src/modes/dogfight/ZoneWall';
import { PICKUP_REWARDS, PICKUP_RULES, PickupField } from '../src/modes/dogfight/pickups';
import { checkZone, chooseDogfightZone, dogfightSlot, dogfightSpawn, dogfightZoneRadius, type ZoneWorld } from '../src/modes/dogfight/zone';

/** Rugged terrain everywhere; the sea covers everything west of x = 6000. */
const coastWorld: ZoneWorld = {
  heightAt: (x, z) => (x > 6000 ? 260 : -60) + 160 * Math.sin(x / 700) * Math.cos(z / 900),
  waterLevelAt: (x, z) => ((x > 6000 ? 260 : -60) + 160 * Math.sin(x / 700) * Math.cos(z / 900) < 0 ? 0 : -Infinity),
};

/** Flat ground at 100 m with a 900 m ridge along x = 0 (north–south). */
const ridgeWorld: ZoneWorld = {
  heightAt: (x) => 100 + 800 * Math.max(0, 1 - Math.abs(x) / 400),
  waterLevelAt: () => -Infinity,
};

function waterFraction(world: ZoneWorld, cx: number, cz: number, r: number): number {
  let water = 0;
  let n = 0;
  for (let i = 0; i < 24; i++) {
    for (const f of [0.25, 0.6, 1]) {
      const a = (i / 24) * Math.PI * 2;
      const x = cx + Math.cos(a) * r * f;
      const z = cz + Math.sin(a) * r * f;
      if (world.waterLevelAt(x, z) > world.heightAt(x, z)) water++;
      n++;
    }
  }
  return water / n;
}

describe('chooseDogfightZone', () => {
  it('is deterministic and prefers land over sea', () => {
    const a = chooseDogfightZone(coastWorld, 1234);
    const b = chooseDogfightZone(coastWorld, 1234);
    expect(a).toEqual(b);
    expect(a.radius).toBe(DOGFIGHT_RULES.zoneRadius);
    expect(a.ceiling).toBe(DOGFIGHT_RULES.ceiling);
    expect(Math.hypot(a.cx, a.cz)).toBeLessThanOrEqual(30001);
    expect(waterFraction(coastWorld, a.cx, a.cz, a.radius)).toBeLessThan(0.1);
    expect(a.cx).toBeGreaterThan(6000);
  });

  it('uses the canyon near the origin in the classic world', () => {
    const classic: ZoneWorld = { ...ridgeWorld, classicValleyCenterX: (z) => 40 + z * 0.01 };
    const zone = chooseDogfightZone(classic, 0);
    expect(zone.cz).toBe(-500);
    expect(zone.cx).toBeCloseTo(35);
  });
});

describe('dogfightSpawn', () => {
  const zone = { cx: 1000, cz: -2000, radius: 3000, ceiling: 20000 };
  const forward = (s: DogfightSpawn) => new Vector3(0, 0, -1).applyQuaternion(s.orientation);

  it('puts the two slots on opposite sides, facing each other, above the ground', () => {
    for (const round of [0, 1, 2]) {
      const s0 = dogfightSpawn(zone, ridgeWorld, 0, round);
      const s1 = dogfightSpawn(zone, ridgeWorld, 1, round);
      const centre = new Vector3(zone.cx, 0, zone.cz);
      const h0 = s0.position.clone().setY(0);
      const h1 = s1.position.clone().setY(0);
      expect(h0.distanceTo(centre)).toBeCloseTo(DOGFIGHT_RULES.zoneRadius - DOGFIGHT_RULES.spawnWallMargin, 3);
      expect(h0.clone().add(h1).multiplyScalar(0.5).distanceTo(centre)).toBeLessThan(1e-6);
      // Each nose points at the other jet / the centre (horizontally).
      expect(forward(s0).dot(h1.clone().sub(h0).normalize())).toBeGreaterThan(0.9999);
      expect(forward(s1).dot(h0.clone().sub(h1).normalize())).toBeGreaterThan(0.9999);
      expect(s0.velocity.length()).toBeCloseTo(DOGFIGHT_RULES.spawnSpeed);
      expect(s0.velocity.clone().normalize().dot(forward(s0))).toBeGreaterThan(0.9999);
      expect(s0.speed).toBe(DOGFIGHT_RULES.spawnSpeed);
      for (const s of [s0, s1]) {
        expect(s.position.y).toBeGreaterThanOrEqual(ridgeWorld.heightAt(s.position.x, s.position.z) + DOGFIGHT_RULES.spawnHeightAboveGround - 1e-6);
      }
    }
  });

  it('clears the highest ground between the two jets', () => {
    // Zone centred on the ridge: every diameter crosses it.
    const z = { ...zone, cx: 0, cz: 0 };
    const s = dogfightSpawn(z, ridgeWorld, 0, 0);
    expect(s.position.y).toBeGreaterThan(900);
  });

  it('orders players by sorted id', () => {
    expect(dogfightSlot('b', ['b', 'a'])).toBe(1);
    expect(dogfightSlot('a', ['b', 'a'])).toBe(0);
    expect(dogfightSlot('c', ['d', 'b', 'a', 'c'])).toBe(2);
  });

  it('spreads 4 pilots evenly around the zone, all facing the centre', () => {
    const big = { ...zone, radius: dogfightZoneRadius(4) };
    const centre = new Vector3(big.cx, 0, big.cz);
    const spawns = [0, 1, 2, 3].map((slot) => dogfightSpawn(big, ridgeWorld, slot, 0, 4));
    const flat = spawns.map((s) => s.position.clone().setY(0));
    for (let i = 0; i < 4; i++) {
      expect(flat[i].distanceTo(centre)).toBeCloseTo(big.radius - DOGFIGHT_RULES.spawnWallMargin, 3);
      expect(forward(spawns[i]).dot(centre.clone().sub(flat[i]).normalize())).toBeGreaterThan(0.9999);
      // Neighbours a quarter turn apart.
      const a = flat[i].clone().sub(centre).normalize();
      const b = flat[(i + 1) % 4].clone().sub(centre).normalize();
      expect(a.dot(b)).toBeCloseTo(0, 6);
    }
  });
});

describe('dogfightZoneRadius', () => {
  it('is 6 km across for a duel and grows 2 km per extra pilot up to 4', () => {
    expect(dogfightZoneRadius(2) * 2).toBe(6000);
    expect(dogfightZoneRadius(3) * 2).toBe(8000);
    expect(dogfightZoneRadius(4) * 2).toBe(10000);
    expect(dogfightZoneRadius(1)).toBe(dogfightZoneRadius(2));
    expect(dogfightZoneRadius(8)).toBe(dogfightZoneRadius(4));
    expect(chooseDogfightZone(coastWorld, 1234, 4).radius).toBe(5000);
  });
});

describe('zone checks', () => {
  const zone = { cx: 0, cz: 0, radius: 3000, ceiling: 20000 };
  it('counts the radius and the ceiling as out of zone', () => {
    expect(checkZone(zone, 2000, 500, 0).outside).toBe(false);
    expect(checkZone(zone, 3001, 500, 0)).toMatchObject({ outside: true, reason: 'radius' });
    expect(checkZone(zone, 0, 20001, 0)).toMatchObject({ outside: true, reason: 'ceiling' });
  });

  it('fades the wall in within 600 m', () => {
    expect(ZoneWall.fadeFor(1000)).toBe(0);
    expect(ZoneWall.fadeFor(300)).toBeGreaterThan(0);
    expect(ZoneWall.fadeFor(0)).toBe(1);
    expect(ZoneWall.fadeFor(-200)).toBe(1);
  });
});

// ---------------------------------------------------------------- session

type Cb<A extends unknown[]> = (...a: A) => void;

function fakeNet() {
  const combat: Cb<[string, CombatMessage]>[] = [];
  const score: Cb<[DogfightScore]>[] = [];
  const left: Cb<[string]>[] = [];
  const sent: CombatMessage[] = [];
  return {
    sent,
    lastDogfightScore: { kills: { A: 0, B: 0 }, winnerId: null } as DogfightScore | null,
    combat: { on: (cb: Cb<[string, CombatMessage]>) => (combat.push(cb), () => combat.splice(combat.indexOf(cb), 1)) },
    dogfightScore: { on: (cb: Cb<[DogfightScore]>) => (score.push(cb), () => score.splice(score.indexOf(cb), 1)) },
    left: { on: (cb: Cb<[string]>) => (left.push(cb), () => left.splice(left.indexOf(cb), 1)) },
    sendCombat(m: CombatMessage) {
      sent.push(m);
    },
    emitCombat: (from: string, m: CombatMessage) => combat.forEach((cb) => cb(from, m)),
    emitScore: (s: DogfightScore) => score.forEach((cb) => cb(s)),
    emitLeft: (id: string) => left.forEach((cb) => cb(id)),
  };
}

function fakeJet() {
  const damage = {
    health: 1,
    apply(n: number) {
      this.health = Math.max(0, this.health - n);
      return this.health <= 0;
    },
    get destroyed() {
      return this.health <= 0;
    },
  };
  const jet = {
    flight: {
      state: { position: new Vector3(), velocity: new Vector3(0, 0, -200), orientation: new Quaternion() },
      telemetry: { afterburner: false },
    },
    damage,
  };
  return jet satisfies DogfightJet;
}

const flatWorld: ZoneWorld = { heightAt: () => 50, waterLevelAt: () => -Infinity };

function setup(countdown = 0, opponentIds: string[] = ['B']) {
  const net = fakeNet();
  const jet = fakeJet();
  const log: string[] = [];
  const spawns: DogfightSpawn[] = [];
  const hooks: DogfightHooks = {
    respawn: (s) => {
      spawns.push(s);
      jet.flight.state.position.copy(s.position);
      jet.damage.health = 1;
      log.push('respawn');
    },
    destroyed: (cause, by) => log.push(`destroyed:${cause}:${by}`),
    finished: (r) => log.push(`finished:${r}`),
    countdownBeep: (go) => log.push(go ? 'go' : 'beep'),
  };
  const session = new DogfightSession({ net, selfId: 'A', opponents: opponentIds.map((id) => ({ id, name: id })), world: flatWorld, seed: 7, slot: 0, jet, hooks, countdown, weaponOptions: { seed: 1 } });
  session.start();
  const step = (seconds: number, dt = 0.05) => {
    for (let t = 0; t < seconds - 1e-9; t += dt) session.fixedUpdate(dt, { input: NO_WEAPON_INPUT, opponents: [] });
  };
  const moveTo = (x: number, y: number, z: number) => jet.flight.state.position.set(session.zone.cx + x, y, session.zone.cz + z);
  const destroyedMsgs = () => net.sent.filter((m) => m.t === 'destroyed');
  return { net, jet, log, spawns, session, step, moveTo, destroyedMsgs };
}

describe('DogfightSession', () => {
  it('runs the start countdown frozen, then fights', () => {
    const { session, step, log } = setup(3);
    expect(session.frozen).toBe(true);
    step(3.05);
    expect(session.phase).toBe('fighting');
    expect(session.frozen).toBe(false);
    expect(log.filter((l) => l === 'beep')).toHaveLength(3);
    expect(log).toContain('go');
  });

  it('destroys the jet (by = null, cause zone) after 10 s out of the zone', () => {
    const { session, step, moveTo, destroyedMsgs, log } = setup();
    moveTo(3200, 500, 0);
    step(9.5);
    expect(destroyedMsgs()).toHaveLength(0);
    expect(session.hudState().zoneTimer).toBeCloseTo(0.5, 5);
    expect(session.hudState().zoneReason).toBe('radius');
    step(0.55);
    expect(destroyedMsgs()).toEqual([{ t: 'destroyed', by: null, cause: 'zone' }]);
    expect(session.phase).toBe('dead');
    expect(log).toContain('destroyed:zone:null');
  });

  it('resets the zone timer on re-entry', () => {
    const { session, step, moveTo, destroyedMsgs } = setup();
    moveTo(3200, 500, 0);
    step(8);
    moveTo(0, 500, 0);
    step(0.05);
    expect(session.hudState().zoneTimer).toBeNull();
    moveTo(3200, 500, 0);
    step(9.5);
    expect(destroyedMsgs()).toHaveLength(0);
    step(0.6);
    expect(destroyedMsgs()).toHaveLength(1);
  });

  it('counts the ceiling as out of zone', () => {
    const { session, step, moveTo, destroyedMsgs } = setup();
    moveTo(0, DOGFIGHT_RULES.ceiling + 100, 0);
    step(1);
    expect(session.hudState().zoneReason).toBe('ceiling');
    step(9.05);
    expect(destroyedMsgs()).toEqual([{ t: 'destroyed', by: null, cause: 'zone' }]);
  });

  it('respawns after the delay: new spawn, refilled weapons, then sends respawned', () => {
    const { session, step, net, spawns, jet } = setup();
    const missilesAtSend: number[] = [];
    const send = net.sendCombat.bind(net);
    net.sendCombat = (m) => {
      if (m.t === 'respawned') missilesAtSend.push(session.weapons.missilesLeft);
      send(m);
    };
    session.weapons.missilesLeft = 0;
    session.weapons.flaresLeft = 3;
    session.onLocalCrash();
    expect(net.sent).toEqual([{ t: 'destroyed', by: null, cause: 'crash' }]);
    step(DOGFIGHT_RULES.respawnDelay - 0.1);
    expect(session.phase).toBe('dead');
    step(0.15);
    expect(session.phase).toBe('fighting');
    expect(net.sent.at(-1)).toEqual({ t: 'respawned' });
    expect(missilesAtSend).toEqual([4]);
    expect(session.weapons.flaresLeft).toBe(30);
    expect(spawns).toHaveLength(2);
    expect(spawns[1].position.equals(session.spawnPoint(1).position)).toBe(true);
    expect(jet.damage.health).toBe(1);
  });

  it('announces a weapon death once with the shooter, and ignores the crash that follows', () => {
    const { session, net, log } = setup();
    session.handleCombatEvents([{ type: 'damaged', by: 'B', cause: 'missile', damage: 1 }]);
    session.onLocalCrash();
    session.handleCombatEvents([{ type: 'damaged', by: 'B', cause: 'gun', damage: 0.1 }]);
    expect(net.sent).toEqual([{ t: 'destroyed', by: 'B', cause: 'missile' }]);
    expect(log.filter((l) => l.startsWith('destroyed'))).toEqual(['destroyed:missile:B']);
    expect(session.hudState().deathText).toContain('Missile kill');
  });

  it('finishes on the relay winner', () => {
    const { session, net, log } = setup();
    net.emitScore({ kills: { A: 2, B: 1 }, winnerId: null });
    expect(session.hudState()).toMatchObject({ myKills: 2, opponentKills: 1, phase: 'fighting' });
    net.emitScore({ kills: { A: 2, B: 3 }, winnerId: 'B' });
    expect(session.finished).toBe(true);
    expect(session.result).toBe('defeat');
    expect(log).toContain('finished:defeat');
  });

  it('finishes when the opponent leaves (not when someone else does)', () => {
    const { session, net, log, step } = setup();
    net.emitLeft('C');
    expect(session.finished).toBe(false);
    net.emitLeft('B');
    expect(session.result).toBe('opponentLeft');
    expect(log).toContain('finished:opponentLeft');
    // No respawn or zone death after the end.
    step(12);
    expect(net.sent).toHaveLength(0);
  });

  it('tracks the opponent being alive for the radar', () => {
    const { session, net } = setup();
    net.emitCombat('B', { t: 'destroyed', by: 'A', cause: 'gun' });
    expect(session.isOpponentAlive('B')).toBe(false);
    expect(session.hudState().feed).toContain('shot down');
    net.emitCombat('B', { t: 'respawned' });
    expect(session.isOpponentAlive('B')).toBe(true);
    expect(session.radarZone()).toEqual({ cx: session.zone.cx, cz: session.zone.cz, radius: 3000 });
  });

  it('core ignores a death outside the fight', () => {
    const core = new DogfightCore({ selfId: 'A', opponentIds: ['B'], zone: { cx: 0, cz: 0, radius: 3000, ceiling: 20000 }, countdown: 3 });
    expect(core.destroyed(null, 'crash')).toBe(false);
    expect(core.drainOutbox()).toEqual([]);
  });

  it('sizes the zone for a free-for-all and lists every pilot', () => {
    const { session } = setup(0, ['B', 'C', 'D']);
    expect(session.zone.radius).toBe(5000);
    expect(session.hudState().standings.map((s) => s.name).sort()).toEqual(['B', 'C', 'D', 'YOU']);
  });

  it('credits a crash shortly after a hit to the last attacker', () => {
    const { session, net } = setup(0, ['B', 'C']);
    session.handleCombatEvents([{ type: 'damaged', by: 'C', cause: 'gun', damage: 0.1 }]);
    session.onLocalCrash();
    expect(net.sent).toEqual([{ t: 'destroyed', by: 'C', cause: 'crash' }]);
  });

  it('does not credit a crash long after the last hit', () => {
    const { session, net, step } = setup(0, ['B', 'C']);
    session.handleCombatEvents([{ type: 'damaged', by: 'C', cause: 'gun', damage: 0.1 }]);
    step(DOGFIGHT_RULES.killCreditSeconds + 0.5);
    session.onLocalCrash();
    expect(net.sent).toEqual([{ t: 'destroyed', by: null, cause: 'crash' }]);
  });

  it('keeps fighting in a free-for-all until every opponent has left', () => {
    const { session, net } = setup(0, ['B', 'C']);
    net.emitLeft('B');
    expect(session.finished).toBe(false);
    expect(session.isOpponent('B')).toBe(false);
    net.emitLeft('C');
    expect(session.result).toBe('opponentLeft');
  });

  it('reports third-party kills in the feed', () => {
    const { session, net } = setup(0, ['B', 'C']);
    net.emitCombat('C', { t: 'destroyed', by: 'B', cause: 'missile' });
    expect(session.isOpponentAlive('C')).toBe(false);
    expect(session.isOpponentAlive('B')).toBe(true);
    expect(session.hudState().feed).toMatch(/B.*C/);
  });
});

describe('pickup gates', () => {
  const zone = { cx: 0, cz: 0, radius: 6000, ceiling: 4000 };
  const ground = (): number => 100;

  it('keeps at most 2 gates inside the zone, takes one when flown through and replaces it after the delay', () => {
    const field = new PickupField(zone, ground, 42);
    expect(field.gates).toHaveLength(PICKUP_RULES.maxGates);
    for (const g of field.gates) {
      expect(Math.hypot(g.position.x, g.position.z)).toBeLessThanOrEqual(zone.radius * PICKUP_RULES.zoneFraction + 1e-6);
      expect(g.position.y).toBeGreaterThanOrEqual(100 + PICKUP_RULES.minAgl);
    }
    const amounts = { health: new Set<number>(), missile: new Set<number>(), flare: new Set<number>() };
    const many = new PickupField(zone, ground, 7);
    for (let i = 0; i < 200; i++) {
      const g = many.gates[0]!;
      const rw = PICKUP_REWARDS[g.kind];
      expect(g.amount).toBeGreaterThanOrEqual(rw.min);
      expect(g.amount).toBeLessThanOrEqual(rw.max);
      amounts[g.kind].add(g.amount);
      many.update(0.1, g.position.clone().add(new Vector3(0, 0, 50)), true);
      many.update(0.1, g.position.clone().add(new Vector3(0, 0, -50)), true);
      many.update(PICKUP_RULES.respawnDelay, g.position, false);
    }
    expect([...amounts.missile].sort()).toEqual([1, 2, 3]);
    expect(amounts.flare.size).toBeGreaterThan(1);
    expect(amounts.health.size).toBeGreaterThan(1);
    const g = field.gates[0]!;
    const p = g.position.clone().add(new Vector3(0, 0, 100));
    expect(field.update(0.1, p, true)).toEqual([]);
    p.z -= 200; // straight through the ring
    expect(field.update(0.1, p, true).map((x) => x.id)).toEqual([g.id]);
    expect(field.gates).toHaveLength(1);
    expect(field.update(0.1, p, true)).toEqual([]);
    field.update(PICKUP_RULES.respawnDelay, p, true);
    expect(field.gates).toHaveLength(2);
    expect(field.gates.some((x) => x.id === g.id)).toBe(false);
  });
});
