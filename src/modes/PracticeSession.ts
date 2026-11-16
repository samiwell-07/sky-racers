import { Vector3 } from 'three';
import { approachPoint, resolveCourse, type CourseDef, type ResolvedCourse } from '../race/Course';
import { RaceProgress, type GateResult } from '../race/RaceProgress';
import type { RingShape } from '../world/rings/ringMath';
import type { HeightField } from '../world/terrain/HeightField';

/** A consecutive run of course gates (indices into the course, in flying order). */
export interface PracticeSection {
  /** First gate (0-based course index). */
  start: number;
  count: number;
  /** Course gate indices in flying order (wrapping past the last gate on loops). */
  indices: number[];
  /** Crosses the start/finish of a loop. */
  wraps: boolean;
}

export type SectionResult = { ok: true; section: PracticeSection } | { ok: false; error: string };

/**
 * Validates a gate section. Loops may wrap past the last gate (at most one full lap); sprints must
 * stay inside the course.
 */
export function selectSection(gateCount: number, loop: boolean, start: number, count: number): SectionResult {
  if (!Number.isInteger(gateCount) || gateCount <= 0) return { ok: false, error: 'This course has no gates.' };
  if (!Number.isInteger(start) || start < 0 || start >= gateCount) return { ok: false, error: `Start gate must be between 1 and ${gateCount}.` };
  if (!Number.isInteger(count) || count < 1) return { ok: false, error: 'Choose at least one gate.' };
  if (count > gateCount) return { ok: false, error: `A section can have at most ${gateCount} gates.` };
  if (!loop && start + count > gateCount) return { ok: false, error: `This sprint ends at gate ${gateCount}: choose at most ${gateCount - start} gate${gateCount - start === 1 ? '' : 's'} from gate ${start + 1}.` };
  const indices = Array.from({ length: count }, (_, i) => (start + i) % gateCount);
  return { ok: true, section: { start, count, indices, wraps: start + count > gateCount } };
}

/** "Gates 18–3 (across the start/finish)" (1-based for players). */
export function describeSection(s: PracticeSection): string {
  const first = s.indices[0]! + 1;
  const last = s.indices[s.indices.length - 1]! + 1;
  const range = s.count === 1 ? `Gate ${first}` : `Gates ${first}–${last}`;
  return `${range} · ${s.count} gate${s.count === 1 ? '' : 's'}${s.wraps ? ' (across the start/finish)' : ''}`;
}

export interface PracticeChoice {
  courseId: string;
  start: number;
  count: number;
  timed: boolean;
}

const SPAWN_DISTANCE = 550;
const SPAWN_SPEED = 150;

/**
 * Unranked practice of one gate section. Holds no leaderboard or ghost store, so it can't write
 * records. Retry returns to the section start; a crash respawns on the approach to the next
 * unpassed gate of the section (checkpoint) and voids that run's section time.
 */
export class PracticeSession {
  readonly course: ResolvedCourse;
  readonly gates: RingShape[];
  progress: RaceProgress;
  /** Time since the (re)spawn. */
  time = 0;
  /** Crashed during this run: the section time doesn't count. */
  crashed = false;
  /** Section time of the last completed run (null = none / voided). */
  lastTime: number | null = null;
  /** Best clean section time of this practice session (memory only). */
  best: number | null = null;
  state: 'running' | 'complete' = 'running';

  constructor(def: CourseDef, readonly section: PracticeSection, heightField: HeightField, readonly timed = true) {
    this.course = resolveCourse(def, heightField);
    this.gates = section.indices.map((i) => this.course.gates[i]!);
    this.progress = new RaceProgress(this.gates.length, 1);
  }

  /** Retry from the section start. */
  retry(): void {
    this.progress = new RaceProgress(this.gates.length, 1);
    this.time = 0;
    this.crashed = false;
    this.state = 'running';
  }

  /** Spawn on the approach to section gate `i` (0 = section start). */
  spawnPose(heightField: HeightField, i = 0): { position: Vector3; heading: number; speed: number } {
    const gate = this.gates[Math.min(i, this.gates.length - 1)]!;
    // The very start of the course keeps the course's own start line (e.g. the runway axis).
    if (i === 0 && this.section.indices[0] === 0) {
      const st = this.course.start;
      return { position: st.position.clone(), heading: st.heading, speed: st.speed };
    }
    return { position: approachPoint(gate, gate.normal, SPAWN_DISTANCE, heightField), heading: Math.atan2(-gate.normal.x, -gate.normal.z), speed: SPAWN_SPEED };
  }

  /** Crash respawn: next unpassed gate of this run. */
  checkpointPose(heightField: HeightField): { position: Vector3; heading: number; speed: number } {
    if (this.progress.totalGates > 0 && this.state === 'running') this.crashed = true;
    return this.spawnPose(heightField, this.state === 'complete' ? 0 : this.progress.gateIndex);
  }

  /** Section time so far (from the first gate), including missed-gate penalties; null before the first gate. */
  get sectionTime(): number | null {
    const p = this.progress;
    if (!p.splits.length) return null;
    if (p.finished) return p.finishTime - p.splits[0]!;
    return this.time - p.splits[0]! + p.penalties;
  }

  update(before: readonly Vector3[], after: readonly Vector3[], dt: number): GateResult {
    this.time += dt;
    if (this.state !== 'running') return null;
    const r = this.progress.update(before, after, this.gates, this.time, dt);
    if (r?.finished) {
      this.state = 'complete';
      const t = this.sectionTime;
      this.lastTime = this.crashed ? null : t;
      if (!this.crashed && t !== null && (this.best === null || t < this.best)) this.best = t;
    }
    return r;
  }

  /** Gates passed or missed so far in this run. */
  get gatesDone(): number {
    return this.progress.finished ? this.gates.length : this.progress.gateIndex;
  }
}
