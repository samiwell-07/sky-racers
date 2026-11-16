import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { MISSED_GATE_PENALTY, RaceProgress } from '../src/race/RaceProgress';
import type { RingShape } from '../src/world/rings/ringMath';

const gate = (z: number): RingShape => ({ center: new Vector3(0, 20, z), normal: new Vector3(0, 0, -1), width: 60, height: 50, frame: 1 });
const gates = [gate(-100), gate(-300)];
const cross = (p: RaceProgress, x: number, z: number, t: number) =>
  p.update([new Vector3(x, 20, z + 1)], [new Vector3(x, 20, z - 1)], gates, t);

describe('RaceProgress', () => {
  it('counts gates in order across laps and finishes after the last lap', () => {
    const p = new RaceProgress(2, 2);
    expect(cross(p, 0, -100, 1)?.kind).toBe('passed');
    expect(cross(p, 0, -300, 2)).toMatchObject({ kind: 'passed', lapCompleted: true, finished: false });
    expect(p.lap).toBe(2);
    cross(p, 0, -100, 3);
    expect(cross(p, 0, -300, 4)).toMatchObject({ finished: true });
    expect(p.finishTime).toBe(4);
  });

  it('adds a penalty for a gate plane crossed outside the gate, and ignores the next gate until then', () => {
    const p = new RaceProgress(2, 1);
    expect(cross(p, 0, -300, 1)).toBeNull();
    expect(cross(p, 120, -100, 2)?.kind).toBe('missed');
    expect(p.penalties).toBe(MISSED_GATE_PENALTY);
    cross(p, 0, -300, 3);
    expect(p.finishTime).toBe(3 + MISSED_GATE_PENALTY);
  });

  it('interpolates the crossing time within the physics step and records cumulative penalties', () => {
    const p = new RaceProgress(2, 1);
    // Crosses the plane a quarter of the way through a 10 ms step ending at t = 1.
    p.update([new Vector3(0, 20, -99)], [new Vector3(0, 20, -103)], gates, 1, 0.01);
    expect(p.splits[0]).toBeCloseTo(0.9925, 6);
    // Without an explicit step, it is inferred from the previous update (AI racers).
    p.update([new Vector3(120, 20, -290)], [new Vector3(120, 20, -290)], gates, 1.99);
    p.update([new Vector3(120, 20, -299)], [new Vector3(120, 20, -301)], gates, 2);
    expect(p.splits[1]).toBeCloseTo(1.995, 6);
    expect(p.penaltySplits).toEqual([0, MISSED_GATE_PENALTY]);
    expect(p.finishTime).toBeCloseTo(1.995 + MISSED_GATE_PENALTY, 6);
  });
});
