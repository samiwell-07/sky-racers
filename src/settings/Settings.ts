import { JET_CATALOG } from '../entities/jet/jetCatalog';
import { isLobbySettings, type LobbySettings } from '../net/lobbyTypes';
import { snapRadarRange } from '../ui/radar/radarMath';
import { browserStorage, isFiniteNumber, tryGetItem, tryParseJson, trySetItem, type KeyValueStorage } from './safeStorage';

export type GraphicsQuality = 'low' | 'medium' | 'high';

export interface GameSettings {
  playerName: string;
  jetId: string;
  graphics: GraphicsQuality;
  masterVolume: number;
  /** Multiplies keyboard/gamepad pitch and roll input (0.3 - 1.5). */
  stickSensitivity: number;
  invertPitch: boolean;
  mouseFlight: boolean;
  mouseSensitivity: number;
  gamepadDeadZone: number;
  gamepadExpo: number;
  timeOfDay: number;
  cloudCoverage: number;
  windSpeed: number;
  windDirection: number;
  turbulence: number;
  /** Race options. */
  laps: number;
  aiOpponents: number;
  aiSkill: number;
  showGhost: boolean;
  startOnRunway: boolean;
  serverUrl: string;
  /** HOTAS: 'rate' = keys/triggers move the lever; 'lever' = a physical throttle axis sets it directly. */
  throttleMode: 'rate' | 'lever';
  /** Gamepad axis index of the physical throttle lever. */
  throttleAxis: number;
  throttleInvert: boolean;
  /** Calibrated raw axis values at idle and full throttle. */
  throttleMin: number;
  throttleMax: number;
  /** HUD instruments: everything, or just the essentials. */
  hudLayout: 'detailed' | 'compact';
  /** HUD text/instrument scale (0.75 - 1.5). */
  hudScale: number;
  /** Mixer channels under the master volume. */
  engineVolume: number;
  effectsVolume: number;
  warningsVolume: number;
  /** Race conditions: 'standard' = fixed time-trial weather, 'custom' = the World settings. */
  raceConditions: 'standard' | 'custom';
  /** HUD radar on/off. */
  showRadar: boolean;
  /** Radar range in metres (one of the radar zoom levels: 2, 5, 10 or 20 km). */
  radarRange: number;
  /** Solo free flight / race world: a seeded world (worldSeed) or the hand-made Classic Canyon. */
  worldSource: 'seeded' | 'classic';
  /** Last seed text typed or rolled (empty = roll a random one). */
  worldSeed: string;
  /** Generated races on seeded worlds. */
  raceDifficulty: 'easy' | 'medium' | 'hard';
  raceLayout: 'sprint' | 'loop';
  /** Last server-confirmed settings hosted by this player, separate from solo settings. */
  lobbySettings: LobbySettings | null;
}

export const DEFAULT_SETTINGS: Readonly<GameSettings> = Object.freeze({
  playerName: 'Pilot',
  jetId: 'falcon',
  graphics: 'high',
  masterVolume: 0.7,
  stickSensitivity: 1,
  invertPitch: false,
  mouseFlight: false,
  mouseSensitivity: 1,
  gamepadDeadZone: 0.12,
  gamepadExpo: 0.35,
  timeOfDay: 14,
  cloudCoverage: 0.4,
  windSpeed: 6,
  windDirection: 90,
  turbulence: 0.5,
  laps: 2,
  aiOpponents: 3,
  aiSkill: 0.75,
  showGhost: true,
  startOnRunway: true,
  serverUrl: 'ws://localhost:8787',
  throttleMode: 'rate',
  throttleAxis: 2,
  throttleInvert: false,
  throttleMin: -1,
  throttleMax: 1,
  hudLayout: 'detailed',
  hudScale: 1,
  engineVolume: 1,
  effectsVolume: 1,
  warningsVolume: 1,
  raceConditions: 'standard',
  showRadar: true,
  radarRange: 5000,
  worldSource: 'seeded',
  worldSeed: '',
  raceDifficulty: 'medium',
  raceLayout: 'loop',
  lobbySettings: null,
});

export interface GraphicsPreset {
  /** Max render scale; dynamic resolution lowers it automatically when frames are slow. */
  pixelRatio: number;
  minPixelRatio: number;
  antialias: boolean;
  shadows: boolean;
  shadowMap: number;
  viewScale: number;
  props: GraphicsQuality;
  clouds: number;
  /** Cheaper terrain shader (fewer texture samples, no normal map). */
  simpleTerrain: boolean;
}

export const GRAPHICS_PRESETS: Record<GraphicsQuality, GraphicsPreset> = {
  low: { pixelRatio: 0.75, minPixelRatio: 0.5, antialias: false, shadows: false, shadowMap: 512, viewScale: 0.55, props: 'low', clouds: 25, simpleTerrain: true },
  medium: { pixelRatio: 1, minPixelRatio: 0.6, antialias: false, shadows: true, shadowMap: 1024, viewScale: 0.75, props: 'medium', clouds: 60, simpleTerrain: false },
  high: { pixelRatio: 1.5, minPixelRatio: 0.75, antialias: true, shadows: true, shadowMap: 2048, viewScale: 1, props: 'high', clouds: 120, simpleTerrain: false },
};

const STORAGE_KEY = 'sfr.settings';

type Validator = (v: unknown) => { ok: true; value: unknown } | { ok: false };
const accept = (value: unknown): { ok: true; value: unknown } => ({ ok: true, value });
const REJECT = { ok: false } as const;

/** Finite number, clamped into [min, max] (optionally rounded to an integer). */
const num = (min: number, max: number, integer = false): Validator => (v) => {
  if (!isFiniteNumber(v)) return REJECT;
  const n = Math.min(max, Math.max(min, integer ? Math.round(v) : v));
  return accept(n);
};
const oneOf = (...allowed: readonly string[]): Validator => (v) => (typeof v === 'string' && allowed.includes(v) ? accept(v) : REJECT);
const bool: Validator = (v) => (typeof v === 'boolean' ? accept(v) : REJECT);
const str = (maxLength: number, allowEmpty = false): Validator => (v) => {
  if (typeof v !== 'string') return REJECT;
  const s = v.trim().slice(0, maxLength);
  return s || allowEmpty ? accept(s) : REJECT;
};

/** Allowed values / ranges per setting. Fields without an entry fall back to a type check. */
export const SETTINGS_VALIDATORS: Partial<Record<keyof GameSettings, Validator>> = {
  playerName: str(24),
  jetId: (v) => (typeof v === 'string' && JET_CATALOG.some((j) => j.id === v) ? accept(v) : REJECT),
  graphics: oneOf('low', 'medium', 'high'),
  masterVolume: num(0, 1),
  stickSensitivity: num(0.3, 1.5),
  invertPitch: bool,
  mouseFlight: bool,
  mouseSensitivity: num(0.2, 3),
  gamepadDeadZone: num(0, 0.4),
  gamepadExpo: num(0, 1),
  timeOfDay: num(0, 24),
  cloudCoverage: num(0, 1),
  windSpeed: num(0, 25),
  windDirection: (v) => (isFiniteNumber(v) ? accept(((v % 360) + 360) % 360) : REJECT),
  turbulence: num(0, 1),
  laps: num(1, 5, true),
  aiOpponents: num(0, 7, true),
  aiSkill: num(0.2, 1),
  showGhost: bool,
  startOnRunway: bool,
  serverUrl: str(200),
  throttleMode: oneOf('rate', 'lever'),
  throttleAxis: (v) => (isFiniteNumber(v) && Number.isInteger(v) && v >= 0 && v <= 7 ? accept(v) : REJECT),
  throttleInvert: bool,
  throttleMin: num(-1, 1),
  throttleMax: num(-1, 1),
  hudLayout: oneOf('detailed', 'compact'),
  hudScale: num(0.75, 1.5),
  engineVolume: num(0, 1),
  effectsVolume: num(0, 1),
  warningsVolume: num(0, 1),
  raceConditions: oneOf('standard', 'custom'),
  showRadar: bool,
  radarRange: (v) => (isFiniteNumber(v) ? accept(snapRadarRange(v)) : REJECT),
  worldSource: oneOf('seeded', 'classic'),
  worldSeed: str(32, true),
  raceDifficulty: oneOf('easy', 'medium', 'hard'),
  raceLayout: oneOf('sprint', 'loop'),
  lobbySettings: (v) => (v === null || isLobbySettings(v) ? accept(v) : REJECT),
};

/**
 * Validates stored settings field by field: valid fields are kept, out-of-range numbers are clamped,
 * anything else falls back to its default. Returns the settings and a list of problems found.
 */
export function validateSettings(input: unknown): { values: GameSettings; problems: string[] } {
  const values: GameSettings = { ...DEFAULT_SETTINGS };
  const problems: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    if (input !== undefined) problems.push('settings data is not an object');
    return { values, problems };
  }
  const src = input as Record<string, unknown>;
  const out = values as unknown as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof GameSettings>) {
    if (!(key in src)) continue;
    const raw = src[key];
    const validate = SETTINGS_VALIDATORS[key];
    const r: ReturnType<Validator> = validate ? validate(raw) : typeof raw === typeof DEFAULT_SETTINGS[key] ? accept(raw) : REJECT;
    if (!r.ok) {
      problems.push(`${key}: invalid value ${JSON.stringify(raw)}, using default`);
      continue;
    }
    if (r.value !== raw) problems.push(`${key}: ${JSON.stringify(raw)} adjusted to ${JSON.stringify(r.value)}`);
    out[key] = r.value;
  }
  if (values.throttleMin === values.throttleMax) {
    values.throttleMin = DEFAULT_SETTINGS.throttleMin;
    values.throttleMax = DEFAULT_SETTINGS.throttleMax;
    problems.push('throttle calibration endpoints were identical, using defaults');
  }
  return { values, problems };
}

/**
 * Settings persisted in localStorage, with change notifications. Changes always apply in memory for
 * the session; if storage fails, `lastSaveError` says why (and listeners still run).
 */
export class SettingsStore {
  readonly values: GameSettings;
  /** Problems found while loading (invalid fields reset to defaults). */
  readonly loadProblems: string[] = [];
  /** Reason the most recent save failed, or null if it succeeded. */
  lastSaveError: string | null = null;
  private readonly listeners = new Set<(s: GameSettings) => void>();
  private readonly storage: KeyValueStorage | null;

  constructor(storage: KeyValueStorage | null = browserStorage()) {
    this.storage = storage;
    const raw = tryGetItem(storage, STORAGE_KEY);
    let parsed: unknown;
    if (raw) {
      parsed = tryParseJson(raw, 'settings');
      if (parsed === undefined) this.loadProblems.push('settings data was malformed, using defaults');
    }
    const { values, problems } = validateSettings(parsed);
    this.values = values;
    this.loadProblems.push(...problems);
    if (this.loadProblems.length) console.warn(`Settings: ${this.loadProblems.join('; ')}`);
  }

  /** Applies a setting (always) and persists it; check `lastSaveError` to see whether saving worked. */
  set<K extends keyof GameSettings>(key: K, value: GameSettings[K]): void {
    this.values[key] = value;
    this.save();
  }

  /** Call after mutating `values` directly (e.g. from a form). Returns false if saving failed. */
  save(): boolean {
    const r = trySetItem(this.storage, STORAGE_KEY, JSON.stringify(this.values));
    this.lastSaveError = r.ok ? null : r.error;
    if (!r.ok) console.warn(`Settings could not be saved: ${r.error}`);
    this.listeners.forEach((l) => l(this.values));
    return r.ok;
  }

  reset(): boolean {
    Object.assign(this.values, DEFAULT_SETTINGS);
    return this.save();
  }

  onChange(listener: (s: GameSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
