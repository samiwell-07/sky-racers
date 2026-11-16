import type { GameSettings } from '../settings/Settings';
import type { WeatherSettings } from '../world/environment/Weather';
import type { CourseDef } from './Course';

/**
 * Version of the timing/scoring rules (gate geometry, miss penalty, interpolated split timing).
 * Bump it whenever a change makes old times incomparable; old records then stay in their old category.
 */
export const SCORING_RULES_VERSION = 2;

/**
 * Standard time-trial conditions: reproducible weather used for ranked races when the player picks
 * "Standard time trial". These values are a first proposal and still need balance testing; changing
 * them requires a new `id` so records set under the old values are not mixed with new ones.
 */
export const STANDARD_TIME_TRIAL = Object.freeze({
  id: 'std1',
  name: 'Standard time trial',
  windSpeed: 4,
  windDirection: 90,
  turbulence: 0.3,
});

/** Gameplay-relevant race conditions, normalized so equivalent setups compare equal. */
export type RaceConditionsKey =
  | { preset: 'standard'; id: string }
  | { preset: 'custom'; windSpeed: number; windDirection: number; turbulencePct: number };

export interface RecordCategory {
  courseId: string;
  /** Course rules version plus a fingerprint of the gate layout. */
  courseVersion: string;
  laps: number;
  jetId: string;
  conditions: RaceConditionsKey;
  scoring: number;
}

/** Normalizes custom world weather: wind to 1 m/s, direction to 5° (0 when calm), turbulence to 0.05. */
export function normalizeWeather(w: WeatherSettings): WeatherSettings {
  const windSpeed = Math.max(0, Math.round(finiteOr(w.windSpeed, 0)));
  const dir = (((Math.round(finiteOr(w.windDirection, 0) / 5) * 5) % 360) + 360) % 360;
  const turbulence = Math.round(Math.min(1, Math.max(0, finiteOr(w.turbulence, 0))) * 20) / 20;
  return { windSpeed, windDirection: windSpeed === 0 ? 0 : dir, turbulence };
}

/**
 * Weather to use for a ranked single-player race: the standard preset, or the player's world
 * weather normalized exactly as its record category describes it. Time of day and clouds are cosmetic.
 */
export function raceWeather(settings: Pick<GameSettings, 'raceConditions' | 'windSpeed' | 'windDirection' | 'turbulence'>): WeatherSettings {
  if (settings.raceConditions === 'standard') {
    const s = STANDARD_TIME_TRIAL;
    return { windSpeed: s.windSpeed, windDirection: s.windDirection, turbulence: s.turbulence };
  }
  return normalizeWeather(settings);
}

export function raceConditionsKey(settings: Pick<GameSettings, 'raceConditions' | 'windSpeed' | 'windDirection' | 'turbulence'>): RaceConditionsKey {
  if (settings.raceConditions === 'standard') return { preset: 'standard', id: STANDARD_TIME_TRIAL.id };
  const w = normalizeWeather(settings);
  return { preset: 'custom', windSpeed: w.windSpeed, windDirection: w.windDirection, turbulencePct: Math.round(w.turbulence * 100) };
}

/** Course identity version: explicit rules version plus a fingerprint of the (rounded) gate layout. */
export function courseVersion(def: Pick<CourseDef, 'loop' | 'gates' | 'start' | 'version'>): string {
  const parts = [def.loop ? 'L' : 'S', ...def.gates.map((g) => `${Math.round(g.x)},${Math.round(g.z)},${Math.round(g.clearance ?? -1)}`)];
  if (def.start) parts.push(`s${Math.round(def.start.x)},${Math.round(def.start.z)}`);
  return `r${def.version ?? 1}-${fnv1a(parts.join(';'))}`;
}

export function recordCategory(def: CourseDef, laps: number, settings: Pick<GameSettings, 'jetId' | 'raceConditions' | 'windSpeed' | 'windDirection' | 'turbulence'>): RecordCategory {
  return {
    courseId: def.id,
    courseVersion: courseVersion(def),
    laps: def.loop ? Math.max(1, Math.round(laps)) : 1,
    jetId: settings.jetId,
    conditions: raceConditionsKey(settings),
    scoring: SCORING_RULES_VERSION,
  };
}

/** Canonical identifier built only from normalized values (never labels or raw floats). */
export function categoryKey(c: RecordCategory): string {
  const cond = c.conditions.preset === 'standard' ? c.conditions.id : `w${c.conditions.windSpeed}d${c.conditions.windDirection}t${c.conditions.turbulencePct}`;
  return `${c.courseId}~${c.courseVersion}@${c.laps}|${c.jetId}|${cond}|s${c.scoring}`;
}

/** The key used before record categories existed (course + laps only). Read-only "Legacy" data. */
export const legacyCourseKey = (courseId: string, laps: number): string => `${courseId}@${laps}`;

export function describeConditions(c: RaceConditionsKey): string {
  if (c.preset === 'standard') return c.id === STANDARD_TIME_TRIAL.id ? STANDARD_TIME_TRIAL.name : `Standard (${c.id})`;
  return c.windSpeed === 0 ? `Custom: calm, turbulence ${c.turbulencePct}%` : `Custom: wind ${c.windSpeed} m/s toward ${c.windDirection}°, turbulence ${c.turbulencePct}%`;
}

export function isRecordCategory(v: unknown): v is RecordCategory {
  const c = v as RecordCategory;
  if (!c || typeof c !== 'object') return false;
  const cond = c.conditions as RaceConditionsKey | undefined;
  const condOk =
    !!cond &&
    ((cond.preset === 'standard' && typeof cond.id === 'string') ||
      (cond.preset === 'custom' && [cond.windSpeed, cond.windDirection, cond.turbulencePct].every((n) => Number.isInteger(n))));
  return typeof c.courseId === 'string' && typeof c.courseVersion === 'string' && Number.isInteger(c.laps) && c.laps >= 1 && typeof c.jetId === 'string' && Number.isInteger(c.scoring) && condOk;
}

function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
