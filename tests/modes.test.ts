import { Vector3 } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TERRAIN_CONFIG } from '../src/config/worldConfig';
import { FlightSchool } from '../src/modes/FlightSchool';
import {
  getLesson,
  headingDelta,
  LessonProgressStore,
  LessonTracker,
  LESSONS,
  nextLesson,
  type FlightSnapshot,
  type LessonId,
} from '../src/modes/lessons';
import { describeSection, PracticeSession, selectSection } from '../src/modes/PracticeSession';
import { BUILTIN_COURSES } from '../src/race/Course';
import type { RingShape } from '../src/world/rings/ringMath';
import { HeightField } from '../src/world/terrain/HeightField';

vi.spyOn(console, 'warn').mockImplementation(() => {});

const snap = (o: Partial<FlightSnapshot> = {}): FlightSnapshot => ({
  speed: 150,
  agl: 200,
  verticalSpeed: 0,
  throttle: 0.6,
  headingDeg: 0,
  pitchDeg: 0,
  bankDeg: 0,
  gearDown: false,
  grounded: false,
  airbrake: false,
  stalled: false,
  gatesPassed: 0,
  gatesMissed: 0,
  gateCount: 0,
  ...o,
});
const tracker = (id: LessonId): LessonTracker => new LessonTracker(getLesson(id)!);
const DT = 1 / 120;

describe('flight school objectives', () => {
  it('takeoff: airborne above 30 m with the gear up', () => {
    const t = tracker('takeoff');
    expect(t.step(snap({ grounded: true, agl: 2, gearDown: true, speed: 80 }), DT)).toBe('running');
    expect(t.step(snap({ agl: 50, gearDown: true }), DT)).toBe('running');
    expect(t.step(snap({ agl: 25, gearDown: false }), DT)).toBe('running');
    expect(t.step(snap({ agl: 31, gearDown: false }), DT)).toBe('complete');
  });

  it('gear: down for 2 s, then up again', () => {
    const t = tracker('gear');
    expect(t.step(snap({ gearDown: false }), DT)).toBe('running');
    for (let i = 0; i < 100; i++) t.step(snap({ gearDown: true }), DT);
    expect(t.step(snap({ gearDown: false }), DT)).toBe('running'); // < 2 s down
    for (let i = 0; i < 200; i++) t.step(snap({ gearDown: true }), DT);
    expect(t.step(snap({ gearDown: false }), DT)).toBe('complete');
  });

  it('turn: 90° of heading change (across north) above 40 m; too low resets the count', () => {
    const t = tracker('turn');
    // Left turn from 30° through north to 300° = 90°.
    let h = 30;
    for (let i = 0; i < 80; i++) {
      h -= 1;
      expect(t.step(snap({ headingDeg: (h + 360) % 360, bankDeg: -60 }), DT)).toBe('running');
    }
    t.step(snap({ headingDeg: (h + 360) % 360, agl: 30 }), DT); // too low
    expect(t.turned).toBe(0);
    expect(t.tooLow).toBe(true);
    for (let i = 0; i < 89; i++) expect(t.step(snap({ headingDeg: (h - i + 360) % 360 }), DT)).toBe('running');
    expect(t.step(snap({ headingDeg: (h - 90 + 360) % 360 }), DT)).toBe('complete');
  });

  it('turn: wobbling back and forth does not add up', () => {
    const t = tracker('turn');
    for (let i = 0; i < 200; i++) expect(t.step(snap({ headingDeg: i % 2 ? 10 : 350 }), DT)).toBe('running');
  });

  it('gates: all gates passed; a missed gate fails the attempt', () => {
    const ok = tracker('gates');
    expect(ok.step(snap({ gateCount: 3, gatesPassed: 2 }), DT)).toBe('running');
    expect(ok.step(snap({ gateCount: 3, gatesPassed: 3 }), DT)).toBe('complete');
    const miss = tracker('gates');
    expect(miss.step(snap({ gateCount: 3, gatesPassed: 1, gatesMissed: 1 }), DT)).toBe('failed');
    expect(miss.failReason).toMatch(/Missed/);
  });

  it('airbrake: slowing below 100 m/s only counts after using the airbrake, above 40 m', () => {
    const t = tracker('airbrake');
    expect(t.step(snap({ speed: 90 }), DT)).toBe('running');
    expect(t.step(snap({ speed: 140, airbrake: true }), DT)).toBe('running');
    expect(t.step(snap({ speed: 95, agl: 30 }), DT)).toBe('running');
    expect(t.step(snap({ speed: 95, agl: 60 }), DT)).toBe('complete');
  });

  it('stall: needs > 70 m/s, level, wings level, not stalled, held for 1 s', () => {
    const t = tracker('stall');
    expect(t.step(snap({ speed: 55, verticalSpeed: -20, stalled: true }), DT)).toBe('running');
    // Fast but diving steeply: not yet level.
    expect(t.step(snap({ speed: 90, verticalSpeed: -40 }), DT)).toBe('running');
    for (let i = 0; i < 100; i++) t.step(snap({ speed: 90, verticalSpeed: -3 }), DT);
    t.step(snap({ speed: 90, bankDeg: 50 }), DT); // banked: hold resets
    let s = t.step(snap({ speed: 90 }), DT);
    for (let i = 0; i < 125 && s === 'running'; i++) s = t.step(snap({ speed: 90, verticalSpeed: 2 }), DT);
    expect(s).toBe('complete');
    expect(t.levelTime).toBeGreaterThanOrEqual(1);
  });

  it('heading delta wraps around north', () => {
    expect(headingDelta(350, 10)).toBe(20);
    expect(headingDelta(10, 350)).toBe(-20);
    expect(headingDelta(0, 180)).toBe(180);
  });

  it('prompts show the actual bindings and the controller when connected', () => {
    const t = tracker('takeoff');
    const keys = { key: (a: string) => (a === 'throttleUp' ? 'Q' : '?'), pad: () => null };
    expect(t.prompt(snap({ grounded: true, throttle: 0 }), keys)).toContain('<kbd>Q</kbd>');
    const pad = { ...keys, pad: (a: string) => (a === 'throttleUp' ? 'RT' : null) };
    expect(t.prompt(snap({ grounded: true, throttle: 0 }), pad)).toContain('RT');
  });

  it('lesson order ends after stall recovery', () => {
    expect(LESSONS.map((l) => l.id)).toEqual(['takeoff', 'gear', 'turn', 'gates', 'airbrake', 'stall']);
    expect(nextLesson('takeoff')?.id).toBe('gear');
    expect(nextLesson('stall')).toBeNull();
  });
});

describe('lesson progress storage', () => {
  it('persists completion and survives a failing storage without throwing', () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    const a = new LessonProgressStore(storage);
    expect(a.markComplete('turn')).toEqual({ ok: true });
    expect(new LessonProgressStore(storage).isComplete('turn')).toBe(true);

    const full = {
      getItem: () => {
        throw Object.assign(new Error('denied'), { name: 'SecurityError' });
      },
      setItem: () => {
        throw Object.assign(new Error('full'), { name: 'QuotaExceededError' });
      },
    };
    const b = new LessonProgressStore(full);
    const r = b.markComplete('stall');
    expect(r.ok).toBe(false);
    expect(b.isComplete('stall')).toBe(true); // still remembered this session
    expect(new LessonProgressStore(null).markComplete('gear').ok).toBe(false);
  });
});

describe('practice section selection', () => {
  it('accepts consecutive sections and wraps loops past the start/finish', () => {
    const r = selectSection(20, true, 17, 5);
    expect(r.ok && r.section.indices).toEqual([17, 18, 19, 0, 1]);
    expect(r.ok && r.section.wraps).toBe(true);
    expect(r.ok && describeSection(r.section)).toMatch(/Gates 18–2 .*start\/finish/);
    const full = selectSection(4, true, 2, 4);
    expect(full.ok && full.section.indices).toEqual([2, 3, 0, 1]);
    const one = selectSection(8, false, 7, 1);
    expect(one.ok && one.section.indices).toEqual([7]);
  });

  it('rejects empty, out-of-range and sprint-overrunning sections', () => {
    expect(selectSection(0, true, 0, 1).ok).toBe(false);
    expect(selectSection(10, true, 0, 0).ok).toBe(false);
    expect(selectSection(10, true, -1, 2).ok).toBe(false);
    expect(selectSection(10, true, 10, 2).ok).toBe(false);
    expect(selectSection(10, true, 1.5, 2).ok).toBe(false);
    expect(selectSection(10, true, 0, 11).ok).toBe(false);
    expect(selectSection(10, true, 0, Number.NaN).ok).toBe(false);
    const sprint = selectSection(10, false, 8, 3);
    expect(sprint.ok).toBe(false);
    expect(!sprint.ok && sprint.error).toMatch(/at most 2 gates/);
  });
});

/** Moves a 3-point "airframe" straight through the centre of a gate along its normal. */
function flyThrough(g: RingShape): { before: Vector3[]; after: Vector3[] } {
  const a = g.center.clone().addScaledVector(g.normal, -2);
  const b = g.center.clone().addScaledVector(g.normal, 2);
  const off = [new Vector3(), new Vector3(3, 0, 0), new Vector3(-3, 0, 0)];
  return { before: off.map((o) => a.clone().add(o)), after: off.map((o) => b.clone().add(o)) };
}

describe('practice and lessons never write records', () => {
  const hf = new HeightField(TERRAIN_CONFIG);
  let writes: string[];
  let original: PropertyDescriptor | undefined;

  beforeEach(() => {
    writes = [];
    original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const data = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string) => void writes.push(k),
        removeItem: (k: string) => void writes.push(k),
        key: () => null,
        length: 0,
      },
    });
  });
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('a practice section across the loop start completes with timing, retries to the same start, and writes nothing', () => {
    const def = BUILTIN_COURSES.find((c) => c.loop)!;
    const r = selectSection(def.gates.length, true, def.gates.length - 2, 4);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = new PracticeSession(def, r.section, hf);
    const spawn = p.spawnPose(hf);
    p.gates.forEach((g, i) => {
      p.update([], [], 1); // flying between gates
      const { before, after } = flyThrough(g);
      const res = p.update(before, after, 0.01);
      expect(res?.kind).toBe('passed');
      expect(res?.gateIndex).toBe(i);
    });
    expect(p.state).toBe('complete');
    expect(p.lastTime).toBeGreaterThan(2.9);
    expect(p.best).toBe(p.lastTime);

    p.retry();
    expect(p.state).toBe('running');
    expect(p.gatesDone).toBe(0);
    const again = p.spawnPose(hf);
    expect(again.position.distanceTo(spawn.position)).toBe(0);
    expect(again.heading).toBe(spawn.heading);
    expect(writes).toEqual([]);
  });

  it('a crash respawns before the next gate of the section and voids the run time', () => {
    const def = BUILTIN_COURSES[0]!;
    const r = selectSection(def.gates.length, false, 2, 3);
    if (!r.ok) throw new Error(r.error);
    const p = new PracticeSession(def, r.section, hf);
    const { before, after } = flyThrough(p.gates[0]!);
    p.update(before, after, 0.01);
    const cp = p.checkpointPose(hf);
    const expected = p.spawnPose(hf, 1);
    expect(cp.position.distanceTo(expected.position)).toBe(0);
    expect(p.crashed).toBe(true);
    for (const g of p.gates.slice(1)) {
      const s = flyThrough(g);
      p.update(s.before, s.after, 0.01);
    }
    expect(p.state).toBe('complete');
    expect(p.lastTime).toBeNull();
    expect(p.best).toBeNull();
    expect(writes).toEqual([]);
  });

  it('the gate lesson completes through its own gates without touching storage', () => {
    const school = new FlightSchool(getLesson('gates')!, hf);
    expect(school.gates.length).toBe(3);
    const pose = school.spawnPose();
    expect(pose.position.y).toBeGreaterThan(hf.getSurfaceHeight(pose.position.x, pose.position.z));
    for (const g of school.gates) {
      const s = flyThrough(g);
      expect(school.updateGates(s.before, s.after, 0.01)?.kind).toBe('passed');
    }
    expect(school.progress?.finished).toBe(true);
    expect(writes).toEqual([]);
  });

  it('air-start lessons spawn clear of the terrain', () => {
    for (const l of LESSONS.filter((x) => x.start.kind === 'air')) {
      const p = new FlightSchool(l, hf).spawnPose();
      expect(p.position.y - hf.getSurfaceHeight(p.position.x, p.position.z)).toBeGreaterThan(100);
    }
  });
});
