import { browserStorage, isFiniteNumber, listKeys, tryGetItem, tryParseJson, trySetItem, type KeyValueStorage } from '../settings/safeStorage';
import { isRecordCategory, legacyCourseKey, type RecordCategory } from './RecordCategory';

export type Medal = 'gold' | 'silver' | 'bronze' | null;

export interface LeaderboardEntry {
  name: string;
  jetId: string;
  time: number;
  penalties: number;
  medal: Medal;
  date: string;
}

export function medalFor(time: number, perLap: { gold: number; silver: number; bronze: number }, laps: number): Medal {
  if (time <= perLap.gold * laps) return 'gold';
  if (time <= perLap.silver * laps) return 'silver';
  if (time <= perLap.bronze * laps) return 'bronze';
  return null;
}

export const LEADERBOARD_FORMAT_VERSION = 2;
const PREFIX = 'sfr.leaderboard.v2.';
const KEY = (category: string): string => `${PREFIX}${category}`;
const LEGACY_KEY = (courseId: string, laps: number): string => `sfr.leaderboard.${legacyCourseKey(courseId, laps)}`;

/** Stored board of one record category. */
interface StoredBoard {
  version: number;
  key: string;
  category: RecordCategory;
  entries: LeaderboardEntry[];
}

export function isLeaderboardEntry(v: unknown): v is LeaderboardEntry {
  const e = v as LeaderboardEntry;
  return (
    !!e &&
    typeof e === 'object' &&
    typeof e.name === 'string' &&
    typeof e.jetId === 'string' &&
    isFiniteNumber(e.time) &&
    e.time > 0 &&
    isFiniteNumber(e.penalties) &&
    e.penalties >= 0 &&
    e.penalties <= e.time &&
    (e.medal === null || e.medal === 'gold' || e.medal === 'silver' || e.medal === 'bronze') &&
    typeof e.date === 'string'
  );
}

/** Keeps the valid entries of a stored list (one corrupt entry never erases the others). */
export function validEntries(list: unknown, where: string): LeaderboardEntry[] {
  if (!Array.isArray(list)) {
    console.warn(`Ignoring ${where}: not a list.`);
    return [];
  }
  const ok = list.filter(isLeaderboardEntry);
  if (ok.length < list.length) console.warn(`Ignoring ${list.length - ok.length} invalid entr${list.length - ok.length === 1 ? 'y' : 'ies'} in ${where}.`);
  return ok.sort((a, b) => a.time - b.time);
}

export interface LeaderboardAddResult {
  /** 1-based rank in the (in-memory) board, or 0 if it did not make the board. */
  rank: number;
  /** The board was written to storage. */
  saved: boolean;
  error?: string;
}

/**
 * Local top-10 times per record category (course + version, laps, jet, conditions, rules), persisted
 * in localStorage. Boards from before record categories are kept read-only as "legacy".
 */
export class Leaderboard {
  /** Boards whose last save failed: kept in memory for the session. */
  private readonly memory = new Map<string, { category: RecordCategory; entries: LeaderboardEntry[] }>();
  /** Stored boards in a format this version cannot read: never overwritten. */
  private readonly unsupported = new Set<string>();

  constructor(private readonly storage: KeyValueStorage | null = browserStorage(), readonly size = 10) {}

  get(categoryKey: string): LeaderboardEntry[] {
    return [...(this.memory.get(categoryKey)?.entries ?? this.readBoard(categoryKey)?.entries ?? [])];
  }

  /** Adds an entry. The result is ranked even if saving fails (`saved: false`). Never throws. */
  add(category: RecordCategory, categoryKey: string, entry: LeaderboardEntry): LeaderboardAddResult {
    const list = [...this.get(categoryKey), entry].sort((a, b) => a.time - b.time).slice(0, this.size);
    const rank = list.indexOf(entry) + 1;
    const board: StoredBoard = { version: LEADERBOARD_FORMAT_VERSION, key: categoryKey, category, entries: list };
    const r = this.unsupported.has(categoryKey)
      ? { ok: false as const, error: 'a stored board in an unsupported format was kept' }
      : trySetItem(this.storage, KEY(categoryKey), JSON.stringify(board));
    if (r.ok) {
      this.memory.delete(categoryKey);
      return { rank, saved: true };
    }
    this.memory.set(categoryKey, { category, entries: list });
    console.warn(`Leaderboard could not be saved: ${r.error}`);
    return { rank, saved: false, error: r.error };
  }

  best(categoryKey: string): LeaderboardEntry | undefined {
    return this.get(categoryKey)[0];
  }

  /** Read-only times saved before record categories existed (course + laps only). */
  legacy(courseId: string, laps: number): LeaderboardEntry[] {
    const raw = tryGetItem(this.storage, LEGACY_KEY(courseId, laps));
    if (!raw) return [];
    const parsed = tryParseJson(raw, `legacy leaderboard ${courseId}@${laps}`);
    return parsed === undefined ? [] : validEntries(parsed, `legacy leaderboard ${courseId}@${laps}`);
  }

  /** Every stored category for a course (for browsing other jets/conditions/laps). */
  categories(courseId: string): Array<{ key: string; category: RecordCategory }> {
    const keys = new Set([...listKeys(this.storage, PREFIX).map((k) => k.slice(PREFIX.length)), ...this.memory.keys()]);
    const out: Array<{ key: string; category: RecordCategory }> = [];
    for (const key of keys) {
      const category = this.memory.get(key)?.category ?? this.readBoard(key)?.category;
      if (category && category.courseId === courseId) out.push({ key, category });
    }
    return out;
  }

  private readBoard(categoryKey: string): { category: RecordCategory; entries: LeaderboardEntry[] } | null {
    const raw = tryGetItem(this.storage, KEY(categoryKey));
    if (!raw) return null;
    const where = `leaderboard ${categoryKey}`;
    const parsed = tryParseJson(raw, where) as Partial<StoredBoard> | undefined;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.version !== LEADERBOARD_FORMAT_VERSION) {
      console.warn(`Ignoring ${where}: unsupported version ${JSON.stringify(parsed.version)}.`);
      this.unsupported.add(categoryKey);
      return null;
    }
    if (parsed.key !== categoryKey || !isRecordCategory(parsed.category)) {
      console.warn(`Ignoring ${where}: category does not match.`);
      return null;
    }
    return { category: parsed.category, entries: validEntries(parsed.entries, where) };
  }
}
