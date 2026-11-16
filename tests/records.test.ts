import { Group, Quaternion, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { TERRAIN_CONFIG, type TerrainConfig } from '../src/config/worldConfig';
import { RaceSession } from '../src/game/RaceSession';
import type { CourseDef } from '../src/race/Course';
import { GhostStore, parseGhost, type GhostData } from '../src/race/Ghost';
import { Leaderboard, type LeaderboardEntry } from '../src/race/Leaderboard';
import { categoryKey, raceWeather, recordCategory, STANDARD_TIME_TRIAL } from '../src/race/RecordCategory';
import { compareWithGhost, describeSplit, formatRaceClock, formatSplitMs, splitDeltaMs } from '../src/race/Splits';
import { DEFAULT_SETTINGS, SettingsStore, type GameSettings } from '../src/settings/Settings';
import { HeightField } from '../src/world/terrain/HeightField';

vi.spyOn(console, 'warn').mockImplementation(() => {});

/** In-memory Storage double; `failWrites` simulates a full/blocked storage. */
class MemoryStorage {
  readonly data = new Map<string, string>();
  failWrites: string | null = null;
  failReads = false;
  get length(): number {
    return this.data.size;
  }
  key(i: number): string | null {
    return [...this.data.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    if (this.failReads) throw Object.assign(new Error('denied'), { name: 'SecurityError' });
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    if (this.failWrites) throw Object.assign(new Error('full'), { name: this.failWrites });
    this.data.set(k, v);
  }
}

const course: CourseDef = { id: 'test', name: 'Test', loop: true, defaultLaps: 2, gates: [{ x: 0, z: -500 }, { x: 0, z: -1500 }, { x: 600, z: -1000 }] };
const settings = (o: Partial<GameSettings> = {}): GameSettings => ({ ...DEFAULT_SETTINGS, ...o });
const key = (o: Partial<GameSettings> = {}, laps = 2, def = course): string => categoryKey(recordCategory(def, laps, settings(o)));
const entry = (time: number, name = 'A'): LeaderboardEntry => ({ name, jetId: 'falcon', time, penalties: 0, medal: null, date: 'd' });

describe('record categories', () => {
  it('shares a category for equivalent normalized setups and cosmetic changes', () => {
    const custom = { raceConditions: 'custom' as const };
    expect(key({ ...custom, windSpeed: 6.2, windDirection: 88, turbulence: 0.51 })).toBe(key({ ...custom, windSpeed: 5.8, windDirection: 91, turbulence: 0.49 }));
    expect(key({ timeOfDay: 6, cloudCoverage: 1, graphics: 'low', hudScale: 1.5, masterVolume: 0, aiOpponents: 0 })).toBe(key());
    // Standard preset ignores the world wind; calm wind ignores the direction.
    expect(key({ raceConditions: 'standard', windSpeed: 20 })).toBe(key({ raceConditions: 'standard', windSpeed: 0 }));
    expect(key({ ...custom, windSpeed: 0, windDirection: 10 })).toBe(key({ ...custom, windSpeed: 0, windDirection: 200 }));
  });

  it('separates jets, laps, conditions, course layout and wind', () => {
    const base = key();
    expect(key({ jetId: 'raptor' })).not.toBe(base);
    expect(key({}, 3)).not.toBe(base);
    expect(key({ raceConditions: 'custom' })).not.toBe(base);
    expect(key({ raceConditions: 'custom', windSpeed: 7 })).not.toBe(key({ raceConditions: 'custom', windSpeed: 8 }));
    expect(key({}, 2, { ...course, gates: [...course.gates.slice(0, 2), { x: 650, z: -1000 }] })).not.toBe(base);
    expect(key({}, 2, { ...course, version: 2 })).not.toBe(base);
  });

  it('applies the standard preset or the normalized custom weather', () => {
    expect(raceWeather(settings({ raceConditions: 'standard' }))).toEqual({ windSpeed: STANDARD_TIME_TRIAL.windSpeed, windDirection: STANDARD_TIME_TRIAL.windDirection, turbulence: STANDARD_TIME_TRIAL.turbulence });
    expect(raceWeather(settings({ raceConditions: 'custom', windSpeed: 6.4, windDirection: 358, turbulence: 0.33 }))).toEqual({ windSpeed: 6, windDirection: 0, turbulence: 0.35 });
  });
});

describe('settings validation and saving', () => {
  it('recovers from malformed JSON and blocked storage', () => {
    const s = new MemoryStorage();
    s.data.set('sfr.settings', '{not json');
    expect(new SettingsStore(s).values).toEqual(DEFAULT_SETTINGS);
    s.failReads = true;
    expect(new SettingsStore(s).values).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps valid fields, clamps ranges and resets invalid ones', () => {
    const s = new MemoryStorage();
    s.data.set('sfr.settings', JSON.stringify({ playerName: 'Ace', laps: 99, hudScale: 3, graphics: 'ultra', masterVolume: 'loud', throttleAxis: 2.5, raceConditions: 'custom', windSpeed: NaN, jetId: 'nope' }));
    const store = new SettingsStore(s);
    expect(store.values).toMatchObject({ playerName: 'Ace', laps: 5, hudScale: 1.5, graphics: DEFAULT_SETTINGS.graphics, masterVolume: DEFAULT_SETTINGS.masterVolume, throttleAxis: DEFAULT_SETTINGS.throttleAxis, raceConditions: 'custom', jetId: DEFAULT_SETTINGS.jetId });
    expect(store.loadProblems.length).toBeGreaterThan(0);
  });

  it('applies a setting even when saving fails, and reports it', () => {
    const s = new MemoryStorage();
    const store = new SettingsStore(s);
    s.failWrites = 'QuotaExceededError';
    store.set('laps', 4);
    expect(store.values.laps).toBe(4);
    expect(store.lastSaveError).toMatch(/full/);
    s.failWrites = null;
    expect(store.save()).toBe(true);
    expect(store.lastSaveError).toBeNull();
  });
});

describe('leaderboard storage', () => {
  const cat = recordCategory(course, 2, settings());
  const k = categoryKey(cat);

  it('keeps valid entries when one is corrupt and ignores unsupported versions without overwriting them', () => {
    const s = new MemoryStorage();
    s.data.set(`sfr.leaderboard.v2.${k}`, JSON.stringify({ version: 2, key: k, category: cat, entries: [entry(50), { name: 'x', time: 'fast' }, entry(40, 'B')] }));
    const lb = new Leaderboard(s);
    expect(lb.get(k).map((e) => e.time)).toEqual([40, 50]);
    s.data.set(`sfr.leaderboard.v2.${k}`, JSON.stringify({ version: 9, key: k, category: cat, entries: [] }));
    const lb2 = new Leaderboard(s);
    expect(lb2.get(k)).toEqual([]);
    expect(lb2.add(cat, k, entry(30)).saved).toBe(false);
    expect(JSON.parse(s.data.get(`sfr.leaderboard.v2.${k}`)!).version).toBe(9);
  });

  it('ranks a result even when saving fails and keeps it for the session', () => {
    const s = new MemoryStorage();
    s.failWrites = 'QuotaExceededError';
    const lb = new Leaderboard(s);
    const r = lb.add(cat, k, entry(42));
    expect(r).toMatchObject({ rank: 1, saved: false });
    expect(lb.best(k)?.time).toBe(42);
  });

  it('reads legacy boards separately, never as the category board', () => {
    const s = new MemoryStorage();
    s.data.set('sfr.leaderboard.test@2', JSON.stringify([entry(33), { bad: true }]));
    const lb = new Leaderboard(s);
    expect(lb.legacy('test', 2).map((e) => e.time)).toEqual([33]);
    expect(lb.get(k)).toEqual([]);
  });
});

const ghost = (o: Partial<GhostData> = {}): GhostData => ({
  version: 2,
  category: 'c',
  jetId: 'falcon',
  time: 13,
  interval: 0.05,
  positions: [0, 0, 0, 1, 1, 1],
  rotations: [0, 0, 0, 1, 0, 0, 0, 1],
  throttle: [1, 1],
  splits: [4, 10],
  penalties: [0, 3],
  ...o,
});

describe('ghost data', () => {
  it('validates structure, timing order, sample lengths and versions', () => {
    expect('ghost' in parseGhost(ghost())).toBe(true);
    expect(parseGhost(ghost({ splits: [10, 4] }))).toHaveProperty('error');
    expect(parseGhost(ghost({ positions: [0, 0] }))).toHaveProperty('error');
    expect(parseGhost(ghost({ version: 3 }))).toHaveProperty('error');
    expect(parseGhost(ghost({ time: 12 }))).toHaveProperty('error');
    expect(parseGhost('nope')).toHaveProperty('error');
  });

  it('treats a legacy ghost without penalty history as split-unavailable', () => {
    const { version: _v, category: _c, penalties: _p, ...rest } = ghost();
    const r = parseGhost({ ...rest, courseKey: 'test@2' });
    expect('ghost' in r).toBe(true);
    const legacy = (r as { ghost: GhostData }).ghost;
    expect(legacy.penalties).toBeNull();
    expect(compareWithGhost(legacy, 0, 4, 0).kind).toBe('unavailable');
  });

  it('reports a new best that could not be saved and does not load another category', () => {
    const s = new MemoryStorage();
    const store = new GhostStore(s);
    expect(store.saveIfBest(ghost())).toEqual({ best: true, saved: true });
    expect(store.load('other')).toBeNull();
    s.data.set('sfr.ghost.v2.other', JSON.stringify(ghost()));
    expect(store.load('other')).toBeNull(); // stored under the wrong category
    s.failWrites = 'QuotaExceededError';
    expect(store.saveIfBest(ghost({ time: 12, penalties: [0, 2] }))).toMatchObject({ best: true, saved: false });
    expect(store.saveIfBest(ghost({ time: 20, splits: [4, 17] }))).toEqual({ best: false, saved: false });
  });
});

describe('millisecond splits', () => {
  it('matches the spec examples', () => {
    expect(formatSplitMs(splitDeltaMs(42.125, 3, 43.25, 0))).toBe('+1875 ms | BEHIND');
    expect(formatSplitMs(splitDeltaMs(41.5, 1, 42, 1))).toBe('-500 ms | AHEAD');
    expect(formatSplitMs(splitDeltaMs(10.0001, 0, 10.0002, 0))).toBe('0 ms | EVEN');
    expect(describeSplit({ kind: 'pending' }).text).toBe('No split yet');
    expect(describeSplit({ kind: 'no-reference', reason: 'x' }).text).toBe('No reference');
  });

  it('formats the race clock as M:SS.mmm', () => {
    expect(formatRaceClock(84.583)).toBe('1:24.583');
    expect(formatRaceClock(5.0004)).toBe('0:05.000');
  });

  it('compares cumulative penalties at the same gate', () => {
    expect(compareWithGhost(ghost(), 1, 9, 3)).toEqual({ kind: 'delta', ms: -1000 });
    expect(compareWithGhost(ghost(), 2, 9, 3).kind).toBe('unavailable');
  });
});

describe('race session records', () => {
  const flat = new HeightField({ ...TERRAIN_CONFIG, chunkSize: 100, chunkSegments: 2 } as TerrainConfig, () => 0);
  const sprint: CourseDef = { id: 'sprint', name: 'Sprint', loop: false, defaultLaps: 1, gates: [{ x: 0, z: -500 }, { x: 0, z: -1500 }] };
  const run = (session: RaceSession, missFirst = false): void => {
    for (let i = 0; i < 400 && session.state === 'countdown'; i++) session.tick(1 / 120);
    session.course.gates.forEach((g, i) => {
      for (let k = 0; k < 120; k++) session.tick(1 / 120);
      const off = missFirst && i === 0 ? new Vector3(200, 0, 0) : new Vector3();
      const before = [g.center.clone().add(off).addScaledVector(g.normal, -1)];
      const after = [g.center.clone().add(off).addScaledVector(g.normal, 3)];
      session.updatePlayer(before, after, after[0]!, new Quaternion(), 1);
    });
  };
  const make = (s: MemoryStorage, ranked: boolean): RaceSession =>
    new RaceSession(sprint, settings({ aiOpponents: 0, showGhost: false }), flat, new Group(), new Leaderboard(s), { ranked, ghostStore: new GhostStore(s) });

  it('never writes records for unranked runs', () => {
    const s = new MemoryStorage();
    const session = make(s, false);
    expect(session.weather).toBeNull();
    run(session);
    const r = session.finish(new Vector3());
    expect(r).toMatchObject({ ranked: false, rank: 0, newBest: false, ghostSaved: null, leaderboardSaved: null });
    expect(s.data.size).toBe(0);
  });

  it('still returns the result when saving fails, then splits against the saved best', () => {
    const s = new MemoryStorage();
    s.failWrites = 'QuotaExceededError';
    const first = make(s, true);
    expect(describeSplit(first.split).text).toBe('No reference');
    run(first, true);
    const r = first.finish(new Vector3());
    expect(r).toMatchObject({ ranked: true, rank: 1, newBest: true, ghostSaved: false, leaderboardSaved: false, penalties: 3 });
    expect(r.time).toBeGreaterThan(3);

    s.failWrites = null;
    const second = make(new MemoryStorage(), true);
    run(second);
    second.finish(new Vector3());
    // The reference is a clean run; missing gate 1 puts the player 3 s behind at every later gate.
    const store = new GhostStore(s);
    store.saveIfBest(second['ghostStore'].load(second.key)!);
    const third = make(s, true);
    expect(third.split.kind).toBe('pending');
    run(third, true);
    expect(third.split).toMatchObject({ kind: 'delta', lap: 1, gate: 2, ms: 3000 });
  });
});
