import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createFlightConfig } from '../src/config/flightConfig';
import { TERRAIN_CONFIG } from '../src/config/worldConfig';
import { Jet } from '../src/entities/jet/Jet';
import { GEAR_HEIGHT } from '../src/entities/jet/JetModel';
import { JET_CATALOG } from '../src/entities/jet/jetCatalog';
import { GroundHandling } from '../src/systems/GroundHandling';
import { HeightField } from '../src/world/terrain/HeightField';
import { Weather } from '../src/world/environment/Weather';

const heightField = new HeightField(TERRAIN_CONFIG);
const dt = 1 / 120;

function onRunway(): { jet: Jet; ground: GroundHandling } {
  const r = heightField.runway;
  const jet = new Jet(JET_CATALOG[0]!, createFlightConfig(), false);
  jet.reset({ position: new Vector3(r.x, r.height + GEAR_HEIGHT, r.z + r.halfLength - 80), orientation: new Quaternion(), speed: 0, throttle: 0 }, true);
  const ground = new GroundHandling(heightField);
  ground.reset(true, 0);
  return { jet, ground };
}

describe('GroundHandling', () => {
  it('sits still on the runway with the brakes on', () => {
    const { jet, ground } = onRunway();
    const start = jet.position.clone();
    for (let i = 0; i < 240; i++) {
      jet.fixedUpdate(dt, { pitch: 0, roll: 0, throttle: 0 });
      expect(ground.update(jet, dt)).toBe('rolling');
    }
    expect(jet.position.distanceTo(start)).toBeLessThan(0.5);
  });

  it('stays level and keeps its heading while parked in a crosswind with turbulence', () => {
    const { jet, ground } = onRunway();
    const weather = new Weather({ windSpeed: 6, windDirection: 90, turbulence: 0.5 });
    for (let i = 0; i < 30 * 120; i++) {
      weather.tick(dt);
      weather.apply(jet.flight, GEAR_HEIGHT);
      jet.fixedUpdate(dt, { pitch: 0, roll: 0, throttle: 0 });
      ground.update(jet, dt);
    }
    const nose = new Vector3(0, 0, -1).applyQuaternion(jet.flight.state.orientation);
    expect(Math.abs(Math.atan2(nose.x, -nose.z))).toBeLessThan(1e-6);
    expect(Math.abs(nose.y)).toBeLessThan(1e-6);
  });

  it('takes off: full throttle, rotate at speed, climb away', () => {
    const { jet, ground } = onRunway();
    let t = 0;
    let airborneAt = -1;
    for (; t < 40 && airborneAt < 0; t += dt) {
      const rotate = jet.flight.telemetry.speed > 78;
      jet.fixedUpdate(dt, { pitch: rotate ? 0.6 : 0, roll: 0, throttle: 1 });
      expect(ground.update(jet, dt)).not.toBe('hardLanding');
      if (!ground.grounded && jet.position.y > heightField.runway.height + GEAR_HEIGHT + 20) airborneAt = t;
    }
    expect(airborneAt).toBeGreaterThan(0);
    // Lift-off within the runway length.
    expect(Math.abs(jet.position.z - heightField.runway.z)).toBeLessThan(heightField.runway.halfLength + 300);
  });

  it('detects a hard landing', () => {
    const { jet, ground } = onRunway();
    jet.flight.state.position.y += 30;
    jet.flight.state.velocity.set(0, -12, -70);
    ground.reset(false);
    let event = 'none';
    for (let i = 0; i < 600 && event !== 'hardLanding'; i++) {
      jet.fixedUpdate(dt, { pitch: 0, roll: 0, throttle: 0 });
      jet.flight.state.velocity.y = Math.min(jet.flight.state.velocity.y, -12);
      event = ground.update(jet, dt);
    }
    expect(event).toBe('hardLanding');
  });
});
