import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { AIPilot, type AIHazards, type AIWaypoint } from '../src/ai/AIPilot';
import { createFlightConfig } from '../src/config/flightConfig';
import { FlightModel } from '../src/physics/FlightModel';

const DT = 1 / 120;
const ground = (): number => 0;

/** Heading change (deg, + = right) applied at each gate, gate spacing (m) and gate height above ground (m). */
const COURSES: Record<string, { turns: number[]; spacing: number[]; heights: number[] }> = {
  sweeping: {
    turns: [0, 40, 60, -30, -70, -45, 35, 65],
    spacing: [900, 850, 1000, 800, 950, 1000, 850, 900],
    heights: [30, 25, 40, 28, 35, 25, 38, 30],
  },
  esses: {
    turns: [0, -50, -35, 30, 70, 45, -30, -60],
    spacing: [950, 900, 850, 1000, 800, 900, 1000, 850],
    heights: [35, 28, 25, 40, 30, 26, 36, 32],
  },
};

/** 8 gates on flat ground; each gate faces from the previous gate toward the next one. */
function buildCourse(name: string): AIWaypoint[] {
  const { turns, spacing, heights } = COURSES[name];
  const points: Vector3[] = [new Vector3(0, 80, 0)];
  let heading = 0; // 0 = -Z, positive = toward +X
  for (let i = 0; i < turns.length; i++) {
    const prev = points[points.length - 1];
    points.push(
      new Vector3(prev.x + Math.sin(heading) * spacing[i], heights[i], prev.z - Math.cos(heading) * spacing[i]),
    );
    heading += (turns[i + 1] ?? 0) * (Math.PI / 180);
  }
  const gates = points.slice(1);
  return gates.map((position, i) => {
    const after = gates[i + 1] ?? position;
    const direction = new Vector3(after.x - points[i].x, 0, after.z - points[i].z).normalize();
    return { position, direction };
  });
}

function race(course: string, skill: number, pilot = new AIPilot({ skill, seed: 7 })) {
  const model = new FlightModel(createFlightConfig());
  model.reset({ position: new Vector3(0, 80, 0), orientation: new Quaternion(), speed: 160, throttle: 0.6 });
  const gates = buildCourse(course);
  const misses: number[] = [];
  const tmp = new Vector3();
  let index = 0;
  let closest = Infinity;
  let minAltitude = Infinity;
  let time = 0;
  while (index < gates.length && time < 120) {
    const gate = gates[index];
    model.step(DT, pilot.computeControls(model, gate, ground, DT, gates[index + 1]));
    time += DT;
    const pos = model.state.position;
    minAltitude = Math.min(minAltitude, pos.y - ground());
    closest = Math.min(closest, pos.distanceTo(gate.position));
    if (tmp.subVectors(pos, gate.position).dot(gate.direction) > 0) {
      misses.push(closest);
      closest = Infinity;
      index++;
    }
  }
  return { misses, minAltitude, time, finished: index === gates.length };
}

describe('AIPilot', { timeout: 60_000 }, () => {
  for (const course of Object.keys(COURSES)) {
    it(`threads every gate of the "${course}" course (skill 0.8)`, () => {
      const r = race(course, 0.8);
      expect(r.finished).toBe(true);
      expect(r.misses).toHaveLength(8);
      expect(Math.max(...r.misses)).toBeLessThan(15);
      expect(r.minAltitude).toBeGreaterThan(5);
      expect(r.time).toBeLessThan(60);
    });

    it(`a low-skill pilot is sloppier but still makes every gate of "${course}" (skill 0.4)`, () => {
      const r = race(course, 0.4);
      expect(r.finished).toBe(true);
      expect(Math.max(...r.misses)).toBeLessThan(25);
      expect(r.minAltitude).toBeGreaterThan(5);
      expect(r.time).toBeLessThan(70);
    });
  }

  it('is deterministic for a given seed, including after reset()', () => {
    const pilot = new AIPilot({ skill: 0.6, seed: 3 });
    const first = race('sweeping', 0.6, pilot);
    pilot.reset();
    expect(race('sweeping', 0.6, pilot)).toEqual(first);
  });
});

describe('AIPilot hazard avoidance', { timeout: 60_000 }, () => {
  const HAZARD_Z = -1000;
  /** Flies a straight 40 m high line across a hazard at z = -1000; returns the height there. */
  function crossHazard(hazards: AIHazards | null): number {
    const pilot = new AIPilot({ skill: 0.8, seed: 5, hazards });
    const model = new FlightModel(createFlightConfig());
    model.reset({ position: new Vector3(0, 40, 0), orientation: new Quaternion(), speed: 170, throttle: 0.6 });
    const dir = new Vector3(0, 0, -1);
    const gates: AIWaypoint[] = [
      { position: new Vector3(0, 40, -2000), direction: dir },
      { position: new Vector3(0, 40, -3000), direction: dir },
    ];
    let crossing = NaN;
    for (let t = 0; t < 20 && Number.isNaN(crossing); t += DT) {
      const before = model.state.position.z;
      model.step(DT, pilot.computeControls(model, gates[0]!, ground, DT, gates[1]));
      if (before > HAZARD_Z && model.state.position.z <= HAZARD_Z) crossing = model.state.position.y;
    }
    return crossing;
  }
  const band = (bottom: number, top: number): AIHazards => ({
    obstacleTop: () => -Infinity,
    hazardBands: (_x, z, radius, out) => {
      if (Math.abs(z - HAZARD_Z) > radius + 2) return 0;
      out[0] = bottom;
      out[1] = top;
      return 1;
    },
  });

  it('would fly into the hazards when blind to them', () => {
    const y = crossHazard(null);
    expect(y).toBeGreaterThan(32);
    expect(y).toBeLessThan(48);
  });

  it('passes under a cable when there is room', () => {
    expect(crossHazard(band(32, 48))).toBeLessThan(32 - 3);
  });

  it('climbs over a band with no room underneath', () => {
    expect(crossHazard(band(5, 60))).toBeGreaterThan(60 + 3);
  });

  it('keeps clear above solid obstacles (trees, buildings) on its path', () => {
    const tower: AIHazards = {
      obstacleTop: (_x, z, radius) => (Math.abs(z - HAZARD_Z) <= radius + 20 ? 52 : -Infinity),
      hazardBands: () => 0,
    };
    expect(crossHazard(tower)).toBeGreaterThan(52 + 5);
  });
});
