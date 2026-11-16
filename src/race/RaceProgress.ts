import type { Vector3 } from 'three';
import { classifyCrossing, type RingShape } from '../world/rings/ringMath';

export const MISSED_GATE_PENALTY = 3;
/** A gate's plane crossed this far (m) outside its rectangle counts as a missed gate. */
export const MISS_RADIUS = 400;
/** Longest gap (s) between two updates that is still treated as one physics step for interpolation. */
const MAX_INTERPOLATED_STEP = 0.1;

export type GateResult = { kind: 'passed' | 'missed'; gateIndex: number; lapCompleted: boolean; finished: boolean } | null;

const _crossing = { t: 0 };

/** Race progress of one racer (player, AI or remote). Pure logic, no rendering. */
export class RaceProgress {
  gateIndex = 0;
  lap = 1;
  finished = false;
  finishTime = 0;
  penalties = 0;
  missed = 0;
  /**
   * Race time when each gate was crossed (flat across laps), interpolated within the physics step
   * from where the airframe crossed the gate plane. Excludes penalties.
   */
  readonly splits: number[] = [];
  /** Accumulated penalties (s) right after each gate (same indexing as `splits`, includes that gate's miss). */
  readonly penaltySplits: number[] = [];
  private lastTime: number | null = null;

  constructor(readonly gateCount: number, readonly laps: number) {}

  /** Gates passed in total across laps. */
  get totalGates(): number {
    return (this.lap - 1) * this.gateCount + this.gateIndex;
  }

  /**
   * Check the movement of every airframe point (before -> after a physics step) against the next gate.
   * `raceTime` is the time at the END of the step; `stepDt` its length. If omitted, the step is inferred
   * from the previous call (so racers updated every step get interpolated times too).
   */
  update(from: readonly Vector3[], to: readonly Vector3[], gates: readonly RingShape[], raceTime: number, stepDt?: number): GateResult {
    const inferred = this.lastTime !== null && raceTime - this.lastTime > 0 && raceTime - this.lastTime <= MAX_INTERPOLATED_STEP ? raceTime - this.lastTime : 0;
    const dt = Math.max(0, stepDt ?? inferred);
    this.lastTime = raceTime;
    if (this.finished) return null;
    const gate = gates[this.gateIndex]!;
    let insideT = Infinity;
    let outsideT = Infinity;
    for (let i = 0; i < from.length; i++) {
      const c = classifyCrossing(from[i]!, to[i]!, gate, MISS_RADIUS, _crossing);
      if (c === 'inside') insideT = Math.min(insideT, _crossing.t);
      else if (c === 'outside') outsideT = Math.min(outsideT, _crossing.t);
    }
    // Any part of the airframe through the opening is a pass, timed by the first part to cross.
    if (insideT !== Infinity) return this.advance('passed', crossingTime(raceTime, dt, insideT));
    if (outsideT !== Infinity) {
      this.penalties += MISSED_GATE_PENALTY;
      this.missed++;
      return this.advance('missed', crossingTime(raceTime, dt, outsideT));
    }
    return null;
  }

  private advance(kind: 'passed' | 'missed', time: number): GateResult {
    const gateIndex = this.gateIndex;
    this.splits.push(time);
    this.penaltySplits.push(this.penalties);
    this.gateIndex++;
    let lapCompleted = false;
    if (this.gateIndex >= this.gateCount) {
      lapCompleted = true;
      if (this.lap >= this.laps) {
        this.finished = true;
        this.finishTime = time + this.penalties;
        this.gateIndex = this.gateCount - 1;
      } else {
        this.lap++;
        this.gateIndex = 0;
      }
    }
    return { kind, gateIndex, lapCompleted, finished: this.finished };
  }
}

/** Time a segment covering (raceTime - dt, raceTime] was at fraction t (0..1). */
export function crossingTime(raceTime: number, dt: number, t: number): number {
  return Math.max(0, raceTime - dt * (1 - Math.min(1, Math.max(0, t))));
}
