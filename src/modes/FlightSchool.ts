import { Euler, Quaternion, Vector3 } from 'three';
import type { InputAction } from '../config/controlsConfig';
import type { Jet } from '../entities/jet/Jet';
import { GEAR_HEIGHT } from '../entities/jet/JetModel';
import { resolveCourse } from '../race/Course';
import { RaceProgress, type GateResult } from '../race/RaceProgress';
import type { RingShape } from '../world/rings/ringMath';
import type { HeightField } from '../world/terrain/HeightField';
import { LessonTracker, type FlightSnapshot, type LessonDef, type LessonStatus } from './lessons';

export interface SpawnPose {
  position: Vector3;
  orientation: Quaternion;
  heading: number;
  speed: number;
  throttle: number;
  gearDown: boolean;
  onGround: boolean;
}

/** Seconds a failed attempt shows its reason before the lesson restarts. */
export const LESSON_FAIL_DELAY = 2.5;

/** Controller hints (W3C standard gamepad mapping, see GamepadInput). */
const PAD_HINTS: Partial<Record<InputAction, string>> = {
  throttleUp: 'RT',
  throttleDown: 'LT',
  pitchUp: 'left stick ↕',
  pitchDown: 'left stick ↕',
  rollLeft: 'left stick ↔',
  rollRight: 'left stick ↔',
  airbrake: 'A',
  toggleGear: 'B',
  respawn: 'Back',
  pause: 'Start',
};

export const padHint = (action: InputAction): string | null => PAD_HINTS[action] ?? null;

const _fwd = new Vector3();
const _right = new Vector3();

/** Flight snapshot of the player's jet for the lesson objective checks. */
export function snapshotOf(jet: Jet, agl: number, grounded: boolean, progress: RaceProgress | null): FlightSnapshot {
  const s = jet.flight.state;
  const t = jet.flight.telemetry;
  _fwd.set(0, 0, -1).applyQuaternion(s.orientation);
  _right.set(1, 0, 0).applyQuaternion(s.orientation);
  const DEG = 180 / Math.PI;
  return {
    speed: t.speed,
    agl,
    verticalSpeed: s.velocity.y,
    throttle: s.throttle,
    headingDeg: Math.atan2(s.velocity.x, -s.velocity.z) * DEG,
    pitchDeg: Math.asin(Math.max(-1, Math.min(1, _fwd.y))) * DEG,
    bankDeg: -Math.asin(Math.max(-1, Math.min(1, _right.y))) * DEG,
    gearDown: jet.gearDown,
    grounded,
    airbrake: jet.airbrake,
    stalled: t.stalled,
    gatesPassed: progress ? progress.totalGates - progress.missed + (progress.finished ? 1 : 0) : 0,
    gatesMissed: progress?.missed ?? 0,
    gateCount: progress?.gateCount ?? 0,
  };
}

/** One running flight school lesson: spawn, gates and objective tracking. Never touches race records. */
export class FlightSchool {
  tracker: LessonTracker;
  readonly gates: RingShape[];
  progress: RaceProgress | null;
  /** Time since the attempt failed (restart after LESSON_FAIL_DELAY). */
  failTime = 0;
  private time = 0;
  private readonly courseStart: { position: Vector3; heading: number } | null;

  constructor(readonly def: LessonDef, private readonly heightField: HeightField) {
    this.tracker = new LessonTracker(def);
    if (def.course) {
      const c = resolveCourse(def.course, heightField);
      this.gates = c.gates;
      this.courseStart = { position: c.start.position, heading: c.start.heading };
    } else {
      this.gates = [];
      this.courseStart = null;
    }
    this.progress = this.gates.length ? new RaceProgress(this.gates.length, 1) : null;
  }

  /** New attempt from the lesson's start. */
  restart(): void {
    this.tracker = new LessonTracker(this.def);
    this.progress = this.gates.length ? new RaceProgress(this.gates.length, 1) : null;
    this.failTime = 0;
    this.time = 0;
  }

  spawnPose(): SpawnPose {
    const st = this.def.start;
    const hf = this.heightField;
    const r = hf.runway;
    if (st.kind === 'runway') {
      return { position: new Vector3(r.x, r.height + GEAR_HEIGHT, r.z + r.halfLength - 80), orientation: new Quaternion(), heading: 0, speed: 0, throttle: 0, gearDown: true, onGround: true };
    }
    if (st.kind === 'course') {
      const cs = this.courseStart!;
      return { position: cs.position.clone(), orientation: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), cs.heading), heading: cs.heading, speed: st.speed, throttle: st.throttle, gearDown: false, onGround: false };
    }
    // Air start over the runway axis, well clear of the highest terrain within 2.5 km.
    let top = -Infinity;
    for (let dx = -2500; dx <= 2500; dx += 250) {
      for (let dz = -2500; dz <= 2500; dz += 250) {
        if (dx * dx + dz * dz <= 2500 * 2500) top = Math.max(top, hf.getSurfaceHeight(r.x + dx, st.z + dz));
      }
    }
    const pitch = ((st.pitchDeg ?? 0) * Math.PI) / 180;
    return {
      position: new Vector3(r.x, top + st.margin, st.z),
      orientation: new Quaternion().setFromEuler(new Euler(pitch, st.heading, 0, 'YXZ')),
      heading: st.heading,
      speed: st.speed,
      throttle: st.throttle,
      gearDown: false,
      onGround: false,
    };
  }

  /** Gate check for the lesson course (no-op without gates). */
  updateGates(before: readonly Vector3[], after: readonly Vector3[], dt: number): GateResult {
    this.time += dt;
    if (!this.progress || this.tracker.status !== 'running') return null;
    return this.progress.update(before, after, this.gates, this.time, dt);
  }

  /** Objective check after a physics step. */
  step(jet: Jet, agl: number, grounded: boolean, dt: number): LessonStatus {
    const status = this.tracker.step(snapshotOf(jet, agl, grounded, this.progress), dt);
    if (status === 'failed') this.failTime += dt;
    return status;
  }

  get failExpired(): boolean {
    return this.tracker.status === 'failed' && this.failTime >= LESSON_FAIL_DELAY;
  }
}
