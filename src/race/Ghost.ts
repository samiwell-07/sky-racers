import { Quaternion, Vector3 } from 'three';
import { browserStorage, isFiniteNumber, listKeys, tryGetItem, tryParseJson, trySetItem, type KeyValueStorage, type SaveResult } from '../settings/safeStorage';
import { legacyCourseKey } from './RecordCategory';

export const GHOST_FORMAT_VERSION = 2;
/** Upper bound on samples (~2 h at 20 Hz) so a corrupt entry can't make us allocate forever. */
const MAX_SAMPLES = 150_000;

export interface GhostData {
  /** 1 = legacy (course@laps key, no penalty history), 2 = record category + per-gate penalties. */
  version: number;
  /** Record category key (v2) or `legacy:<course@laps>` (v1). */
  category: string;
  jetId: string;
  /** Total time including penalties. */
  time: number;
  /** Sample interval (s). The replay timeline is physical race time, without penalties. */
  interval: number;
  /** Flat arrays: [x, y, z] and [x, y, z, w] per sample, rounded. */
  positions: number[];
  rotations: number[];
  throttle: number[];
  /** Race time (s, without penalties) at each gate, interpolated within the physics step. */
  splits: number[];
  /** Accumulated penalties (s) at each gate; null for legacy ghosts that never recorded them. */
  penalties: number[] | null;
}

/** Records the player's flight during a race at a fixed rate. */
export class GhostRecorder {
  private positions: number[] = [];
  private rotations: number[] = [];
  private throttle: number[] = [];
  private nextSample = 0;

  constructor(readonly interval = 0.05) {}

  reset(): void {
    this.positions = [];
    this.rotations = [];
    this.throttle = [];
    this.nextSample = 0;
  }

  record(raceTime: number, position: Vector3, rotation: Quaternion, throttle: number): void {
    while (raceTime >= this.nextSample) {
      this.positions.push(round(position.x, 100), round(position.y, 100), round(position.z, 100));
      this.rotations.push(round(rotation.x, 1e4), round(rotation.y, 1e4), round(rotation.z, 1e4), round(rotation.w, 1e4));
      this.throttle.push(round(throttle, 100));
      this.nextSample += this.interval;
    }
  }

  finish(category: string, jetId: string, time: number, splits: readonly number[], penalties: readonly number[]): GhostData {
    return {
      version: GHOST_FORMAT_VERSION,
      category,
      jetId,
      time,
      interval: this.interval,
      positions: this.positions,
      rotations: this.rotations,
      throttle: this.throttle,
      splits: [...splits],
      penalties: [...penalties],
    };
  }
}

const _q1 = new Quaternion();

/** Samples a recorded ghost at any race time (interpolated). */
export function sampleGhost(ghost: GhostData, raceTime: number, position: Vector3, rotation: Quaternion): { throttle: number; done: boolean } {
  const count = ghost.throttle.length;
  if (count === 0) return { throttle: 0, done: true };
  const f = Math.max(0, raceTime / ghost.interval);
  const i = Math.min(Math.floor(f), count - 1);
  const j = Math.min(i + 1, count - 1);
  const t = Math.min(f - i, 1);
  const p = ghost.positions;
  position.set(p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!).lerp(_v.set(p[j * 3]!, p[j * 3 + 1]!, p[j * 3 + 2]!), t);
  const r = ghost.rotations;
  rotation.set(r[i * 4]!, r[i * 4 + 1]!, r[i * 4 + 2]!, r[i * 4 + 3]!).normalize();
  _q1.set(r[j * 4]!, r[j * 4 + 1]!, r[j * 4 + 2]!, r[j * 4 + 3]!).normalize();
  rotation.slerp(_q1, t);
  return { throttle: ghost.throttle[i]!, done: f >= count - 1 };
}
const _v = new Vector3();

const finiteArray = (v: unknown, maxLength: number): v is number[] => Array.isArray(v) && v.length <= maxLength && v.every(isFiniteNumber);
const nonDecreasing = (a: readonly number[]): boolean => a.every((x, i) => x >= 0 && (i === 0 || x >= a[i - 1]!));

/**
 * Validates stored ghost data (v1 legacy or v2). Returns the normalized ghost, or a reason it was rejected.
 * Legacy ghosts are returned with `penalties: null`: their split comparison is unavailable.
 */
export function parseGhost(data: unknown): { ghost: GhostData } | { error: string } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'not an object' };
  const d = data as Record<string, unknown>;
  const version = d.version === undefined ? 1 : d.version;
  if (version !== 1 && version !== GHOST_FORMAT_VERSION) return { error: `unsupported version ${JSON.stringify(version)}` };
  const category = version === 1 ? (typeof d.courseKey === 'string' ? `legacy:${d.courseKey}` : null) : typeof d.category === 'string' ? d.category : null;
  if (!category) return { error: 'missing category' };
  if (typeof d.jetId !== 'string' || !d.jetId) return { error: 'missing jet' };
  if (!isFiniteNumber(d.time) || d.time <= 0) return { error: 'invalid time' };
  if (!isFiniteNumber(d.interval) || d.interval <= 0 || d.interval > 1) return { error: 'invalid sample interval' };
  if (!finiteArray(d.throttle, MAX_SAMPLES) || d.throttle.length === 0) return { error: 'invalid samples' };
  const n = d.throttle.length;
  if (!finiteArray(d.positions, n * 3) || d.positions.length !== n * 3) return { error: 'position samples do not match' };
  if (!finiteArray(d.rotations, n * 4) || d.rotations.length !== n * 4) return { error: 'rotation samples do not match' };
  if (!finiteArray(d.splits, 10_000) || !nonDecreasing(d.splits)) return { error: 'gate times are invalid or out of order' };
  const splits = d.splits;
  let penalties: number[] | null = null;
  if (version === GHOST_FORMAT_VERSION) {
    if (!finiteArray(d.penalties, splits.length) || d.penalties.length !== splits.length || !nonDecreasing(d.penalties)) return { error: 'penalty history is invalid' };
    penalties = d.penalties;
    const last = splits.length - 1;
    if (last >= 0 && Math.abs(splits[last]! + penalties[last]! - d.time) > 0.01) return { error: 'final gate does not match the total time' };
  }
  if (splits.length && splits[splits.length - 1]! > d.time + 1e-6) return { error: 'gate time after the finish' };
  return {
    ghost: { version, category, jetId: d.jetId, time: d.time, interval: d.interval, positions: d.positions, rotations: d.rotations, throttle: d.throttle, splits, penalties },
  };
}

const GHOST_PREFIX = 'sfr.ghost.v2.';
const GHOST_KEY = (category: string): string => `${GHOST_PREFIX}${category}`;
const LEGACY_GHOST_KEY = (courseId: string, laps: number): string => `sfr.ghost.${legacyCourseKey(courseId, laps)}`;

export interface GhostSaveResult {
  /** The run beat the stored best for its category (a new personal best ghost). */
  best: boolean;
  /** The ghost was written to storage (false when not best, or when saving failed). */
  saved: boolean;
  error?: string;
}

/**
 * Best-run ghosts persisted in localStorage, one per record category. Old (legacy) ghosts stay
 * under their old keys and are never used as a race reference.
 */
export class GhostStore {
  /** Best ghosts kept in memory for the session when storage fails. */
  private readonly memory = new Map<string, GhostData>();
  /** Stored ghosts in a format this version cannot read: never overwritten. */
  private readonly unsupported = new Set<string>();

  constructor(private readonly storage: KeyValueStorage | null = browserStorage()) {}

  /** The best ghost of a record category, or null (missing, malformed, or another category). */
  load(category: string): GhostData | null {
    const mem = this.memory.get(category);
    if (mem) return mem;
    const raw = tryGetItem(this.storage, GHOST_KEY(category));
    if (!raw) return null;
    const parsed = tryParseJson(raw, `ghost for ${category}`);
    if (parsed === undefined) return null;
    const r = parseGhost(parsed);
    if ('error' in r) {
      if (r.error.startsWith('unsupported version')) this.unsupported.add(category);
      console.warn(`Ignoring stored ghost for ${category}: ${r.error}.`);
      return null;
    }
    if (r.ghost.category !== category) {
      console.warn(`Ignoring stored ghost for ${category}: it belongs to ${r.ghost.category}.`);
      return null;
    }
    return r.ghost;
  }

  has(category: string): boolean {
    return this.load(category) !== null;
  }

  /** A legacy ghost (saved before record categories), for information only. */
  loadLegacy(courseId: string, laps: number): GhostData | null {
    const raw = tryGetItem(this.storage, LEGACY_GHOST_KEY(courseId, laps));
    const parsed = raw ? tryParseJson(raw, 'legacy ghost') : undefined;
    if (parsed === undefined) return null;
    const r = parseGhost(parsed);
    return 'ghost' in r ? r.ghost : null;
  }

  /** Saves the ghost if it beats the stored one of its category. Never throws. */
  saveIfBest(ghost: GhostData): GhostSaveResult {
    const best = this.load(ghost.category);
    if (best && best.time <= ghost.time) return { best: false, saved: false };
    const r: SaveResult = this.unsupported.has(ghost.category)
      ? { ok: false, error: 'a stored ghost in an unsupported format was kept' }
      : trySetItem(this.storage, GHOST_KEY(ghost.category), JSON.stringify(ghost));
    if (r.ok) {
      this.memory.delete(ghost.category);
      return { best: true, saved: true };
    }
    // Keep it for the rest of the session so the next race can still race against it.
    this.memory.set(ghost.category, ghost);
    console.warn(`Ghost could not be saved: ${r.error}`);
    return { best: true, saved: false, error: r.error };
  }

  /** Categories that have a stored ghost. */
  categories(): string[] {
    return listKeys(this.storage, GHOST_PREFIX).map((k) => k.slice(GHOST_PREFIX.length));
  }
}

function round(v: number, k: number): number {
  return Math.round(v * k) / k;
}
