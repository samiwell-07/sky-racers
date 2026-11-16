import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createFlightConfig } from '../src/config/flightConfig';
import { FlightModel } from '../src/physics/FlightModel';
import type { FlightControls } from '../src/physics/types';

const DT = 1 / 120;
const NONE: FlightControls = { pitch: 0, roll: 0, throttle: 0 };

function spawn(speed = 150, throttle = 0.5): FlightModel {
  const model = new FlightModel(createFlightConfig());
  model.reset({ position: new Vector3(0, 1000, 0), orientation: new Quaternion(), speed, throttle });
  return model;
}

function fly(model: FlightModel, seconds: number, controls: FlightControls): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) model.step(DT, controls);
}

describe('FlightModel', () => {
  it('holds a steady, roughly level flight path with hands off the stick', () => {
    const m = spawn();
    fly(m, 5, NONE);
    expect(Math.abs(m.state.position.y - 1000)).toBeLessThan(60);
    expect(Math.abs(m.state.position.x)).toBeLessThan(0.01);
    expect(m.telemetry.speed).toBeGreaterThan(120);
  });

  it('cannot change heading without banking (no yaw control)', () => {
    const m = spawn();
    fly(m, 3, { pitch: 1, roll: 0, throttle: 1 });
    fly(m, 3, { pitch: -1, roll: 0, throttle: 0 });
    expect(Math.abs(m.state.position.x)).toBeLessThan(0.01);
    expect(Math.abs(m.state.velocity.x)).toBeLessThan(0.01);
  });

  it('turns right by banking right and pulling', () => {
    const m = spawn(180, 0.8);
    fly(m, 0.35, { pitch: 0, roll: 1, throttle: 0 });
    fly(m, 4, { pitch: 1, roll: 0, throttle: 0 });
    expect(m.state.velocity.x).toBeGreaterThan(50);
    expect(m.state.position.x).toBeGreaterThan(100);
  });

  it('climbs when pulling up and dives when pushing', () => {
    const up = spawn();
    fly(up, 1.5, { pitch: 1, roll: 0, throttle: 0 });
    const down = spawn();
    fly(down, 1.5, { pitch: -1, roll: 0, throttle: 0 });
    expect(up.state.velocity.y).toBeGreaterThan(20);
    expect(down.state.velocity.y).toBeLessThan(-20);
  });

  it('stalls and sinks when too slow', () => {
    const m = spawn(55, 0);
    fly(m, 3, { pitch: 1, roll: 0, throttle: 0 });
    expect(m.telemetry.stallWarning).toBe(true);
    expect(m.state.position.y).toBeLessThan(1000);
    expect(m.state.velocity.y).toBeLessThan(0);
  });

  it('pulls harder G when the alpha limiter is disabled, and can then stall', () => {
    const m = new FlightModel(createFlightConfig({ alphaLimiter: false }));
    m.reset({ position: new Vector3(0, 1000, 0), orientation: new Quaternion(), speed: 120, throttle: 0.5 });
    let stalled = false;
    for (let i = 0; i < 240; i++) {
      m.step(DT, { pitch: 1, roll: 0, throttle: 0 });
      stalled ||= m.telemetry.stalled;
    }
    expect(stalled).toBe(true);

    const limited = spawn(120, 0.5);
    let limitedStalled = false;
    for (let i = 0; i < 240; i++) {
      limited.step(DT, { pitch: 1, roll: 0, throttle: 0 });
      limitedStalled ||= limited.telemetry.stalled;
    }
    expect(limitedStalled).toBe(false);
  });

  it('keeps throttle within 0..1 and reports afterburner at high throttle', () => {
    const m = spawn(150, 0.5);
    fly(m, 3, { ...NONE, throttle: 1 });
    expect(m.state.throttle).toBe(1);
    expect(m.telemetry.afterburner).toBe(true);
    fly(m, 3, { ...NONE, throttle: -1 });
    expect(m.state.throttle).toBe(0);
  });
});
