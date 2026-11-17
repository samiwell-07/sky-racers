import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createFlightConfig } from '../src/config/flightConfig';
import { getJetDefinition, JET_CATALOG } from '../src/entities/jet/jetCatalog';
import { FlightModel } from '../src/physics/FlightModel';
import { jetHandling } from '../src/ui/jetHandling';

const trait = (id: string, t: string) => jetHandling(getJetDefinition(id)).find((h) => h.id === t)!;

describe('jetHandling', () => {
  it('rates the standard airframe as the middle of every bar', () => {
    for (const h of jetHandling({ flight: {} })) {
      expect(h.ratio).toBeCloseTo(1);
      expect(h.bar).toBeCloseTo(0.5);
      expect(h.verdict).toBe('Similar');
    }
  });

  it('follows the catalog overrides: Raptor is faster and steadier, Viper turns quicker', () => {
    expect(trait('raptor', 'topSpeed').ratio).toBeGreaterThan(trait('viper', 'topSpeed').ratio);
    expect(trait('raptor', 'acceleration').bar).toBeGreaterThan(0.5);
    expect(trait('viper', 'turn').ratio).toBeGreaterThan(trait('falcon', 'turn').ratio);
    expect(trait('raptor', 'turn').ratio).toBeLessThan(1);
    expect(trait('raptor', 'stability').ratio).toBeGreaterThan(trait('viper', 'stability').ratio);
  });

  it('keeps extreme values inside the bar', () => {
    const h = jetHandling({ flight: { maxThrust: 300, maxRollRate: 0.01 } });
    for (const t of h) {
      expect(t.bar).toBeGreaterThanOrEqual(0.04);
      expect(t.bar).toBeLessThanOrEqual(0.96);
    }
  });

  it('gives both new jets distinct ratings and meaningful handling differences from every other jet', () => {
    for (const id of ['kestrel', 'specter']) {
      const definition = getJetDefinition(id);
      const handling = jetHandling(definition);
      for (const other of JET_CATALOG.filter((jet) => jet.id !== id)) {
        expect(definition.stats, `${id} vs ${other.id}`).not.toEqual(other.stats);
        const differences = jetHandling(other).map((value, i) => Math.abs(value.ratio - handling[i]!.ratio));
        expect(Math.max(...differences), `${id} vs ${other.id}`).toBeGreaterThan(0.1);
      }
    }
  });

  it('keeps Kestrel technical and Specter fast without eclipsing Viper or Raptor', () => {
    for (const name of ['topSpeed', 'acceleration']) {
      const order = ['kestrel', 'viper', 'falcon', 'specter', 'raptor'];
      for (let i = 1; i < order.length; i++) {
        expect(trait(order[i]!, name).ratio).toBeGreaterThan(trait(order[i - 1]!, name).ratio);
      }
    }
    const turnOrder = ['raptor', 'falcon', 'specter', 'kestrel', 'viper'];
    for (let i = 1; i < turnOrder.length; i++) {
      expect(trait(turnOrder[i]!, 'turn').ratio).toBeGreaterThan(trait(turnOrder[i - 1]!, 'turn').ratio);
    }
  });

  it('delivers Kestrel low-speed lift and control advantages and Specter acceleration in actual flight', () => {
    const fly = (id: string, speed: number, roll: number, seconds: number): FlightModel => {
      const model = new FlightModel(createFlightConfig(getJetDefinition(id).flight));
      model.reset({ position: new Vector3(0, 1000, 0), orientation: new Quaternion(), speed, throttle: 1 });
      for (let i = 0; i < seconds * 120; i++) model.step(1 / 120, { pitch: 0, roll, throttle: 0 });
      return model;
    };
    const kestrel = fly('kestrel', 80, 0, 0.5);
    const specter = fly('specter', 80, 0, 0.5);
    expect(kestrel.state.position.y).toBeGreaterThan(specter.state.position.y);
    expect(fly('kestrel', 80, 1, 0.25).state.rollRate).toBeGreaterThan(fly('specter', 80, 1, 0.25).state.rollRate * 1.2);
    expect(fly('specter', 150, 0, 3).telemetry.speed).toBeGreaterThan(fly('kestrel', 150, 0, 3).telemetry.speed + 10);
  });
});
