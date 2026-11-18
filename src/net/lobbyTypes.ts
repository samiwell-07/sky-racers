/** Shared lobby protocol types (mirrors server/relay.mjs). */
import { JET_CATALOG } from '../entities/jet/jetCatalog';
import type { JetAppearance } from '../entities/jet/jetAppearance';
import { generatedCourseId, type CourseRequest, type RaceDifficulty, type RaceLayout } from '../race/generatedCourse';
import { randomSeedText, seedFromText } from '../utils/seed';
import { CLASSIC_WORLD, parseWorldKey, worldKey, type WorldSpec } from '../world/gen/WorldGenerator';

/** 'dogfight' = free-for-all combat between 2 and 4 pilots (the server caps maxPlayers at 4). */
export type LobbyMode = 'free' | 'race' | 'dogfight';
/** Camera view the host imposes on everyone ('any' = each pilot chooses with C). */
export type LobbyView = 'any' | 'chase' | 'cockpit';

export interface LobbyWorld {
  timeOfDay: number;
  cloudCoverage: number;
  windSpeed: number;
  windDirection: number;
  turbulence: number;
  /** Seed text the host typed (display / sharing only; '' for the Classic Canyon). */
  seedText: string;
  /** 'classic' or 's<seed>' (see worldKey); the source of truth for which world is played. */
  worldKey: string;
}

export interface LobbySettings {
  name: string;
  private: boolean;
  maxPlayers: number;
  mode: LobbyMode;
  /** Classic Canyon races: the built-in course. */
  courseId: string;
  /** Laps of a loop (classic loop course or generated 'loop' layout). */
  laps: number;
  /** Seeded-world races: generated course difficulty and layout. */
  raceDifficulty: RaceDifficulty;
  raceLayout: RaceLayout;
  allowLateJoin: boolean;
  /** Camera view imposed on every pilot. */
  forceView: LobbyView;
  /** Jet id imposed on every pilot ('' = each pilot flies their own jet). */
  forceJet: string;
  world: LobbyWorld;
}

export const LOBBY_MAX_PLAYERS = 8;
export const DOGFIGHT_MIN_PLAYERS = 2;
export const DOGFIGHT_MAX_PLAYERS = 4;
export const MAX_SEED_TEXT_LEN = 32;

/**
 * Same defaults as the server (also what old clients get): the game's base world, Classic Canyon.
 * Hosts creating a lobby start from newLobbySettings() instead (random seeded world).
 */
export const DEFAULT_LOBBY_SETTINGS: Readonly<LobbySettings> = Object.freeze({
  name: 'Sky race',
  private: false,
  maxPlayers: 8,
  mode: 'race',
  courseId: 'canyon-loop',
  laps: 2,
  raceDifficulty: 'medium',
  raceLayout: 'loop',
  allowLateJoin: true,
  forceView: 'any',
  forceJet: '',
  world: Object.freeze({ timeOfDay: 14, cloudCoverage: 0.4, windSpeed: 6, windDirection: 90, turbulence: 0.5, seedText: '', worldKey: 'classic' }),
});

/** Same cleanup the server applies to seed text, so the displayed text always reproduces the key. */
export const cleanSeedText = (text: string): string =>
  text.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, MAX_SEED_TEXT_LEN);

/** Sets a seeded world from what the host typed (empty text = a new random seed). */
export function setLobbySeed(world: LobbyWorld, text: string, random: () => number = Math.random): LobbyWorld {
  const seedText = cleanSeedText(text) || randomSeedText(random);
  world.seedText = seedText;
  world.worldKey = worldKey({ kind: 'seeded', seed: seedFromText(seedText) });
  return world;
}

/** Switches the lobby to the hand-made Classic Canyon. */
export function setLobbyClassic(world: LobbyWorld): LobbyWorld {
  world.seedText = '';
  world.worldKey = 'classic';
  return world;
}

/** Settings for a new lobby: defaults on a random seeded world. */
export function newLobbySettings(name: string, random: () => number = Math.random): LobbySettings {
  const s = { ...cloneLobbySettings(DEFAULT_LOBBY_SETTINGS), name };
  setLobbySeed(s.world, '', random);
  return s;
}

/** The jet a pilot flies in this lobby: the host's forced jet, else their own choice. */
export function lobbyJetId(s: Partial<Pick<LobbySettings, 'forceJet'>>, ownJetId: string): string {
  return s.forceJet && JET_CATALOG.some((j) => j.id === s.forceJet) ? s.forceJet : ownJetId;
}

/** The camera view the host imposes, or null when pilots choose. */
export function lobbyForcedView(s: Partial<Pick<LobbySettings, 'forceView'>>): 'chase' | 'cockpit' | null {
  return s.forceView === 'chase' || s.forceView === 'cockpit' ? s.forceView : null;
}

/** World to load for a lobby (Classic for old/malformed keys). */
export function lobbyWorldSpec(world: Pick<LobbyWorld, 'worldKey'>): WorldSpec {
  return parseWorldKey(world.worldKey) ?? CLASSIC_WORLD;
}

/** Short label for lists and the room: "Classic Canyon" or "Seed <text>". */
export function lobbyWorldLabel(world: Pick<LobbyWorld, 'worldKey' | 'seedText'>): string {
  const spec = lobbyWorldSpec(world);
  if (spec.kind === 'classic') return 'Classic Canyon';
  return `Seed ${world.seedText || String(spec.seed)}`;
}

/** The race a lobby runs: a built-in Classic course, or a course generated on the seeded world. */
export type LobbyRaceCourse =
  | { kind: 'classic'; courseId: string; laps: number }
  | { kind: 'generated'; courseId: string; request: CourseRequest; laps: number };

export function lobbyRaceCourse(s: LobbySettings): LobbyRaceCourse {
  const world = lobbyWorldSpec(s.world);
  if (world.kind === 'classic') return { kind: 'classic', courseId: s.courseId, laps: s.laps };
  const request: CourseRequest = { world, difficulty: s.raceDifficulty, layout: s.raceLayout };
  return { kind: 'generated', courseId: generatedCourseId(request), request, laps: s.raceLayout === 'loop' ? s.laps : 1 };
}

export type LobbyTeam = 'alpha' | 'beta' | 'gamma' | 'delta';

/** The 4 lobby teams, in order (mirrors TEAMS in server/relay.mjs). */
export const LOBBY_TEAMS: ReadonlyArray<{ id: LobbyTeam; name: string; color: string }> = [
  { id: 'alpha', name: 'Alpha', color: '#ff6b6b' },
  { id: 'beta', name: 'Beta', color: '#4da3ff' },
  { id: 'gamma', name: 'Gamma', color: '#59e68a' },
  { id: 'delta', name: 'Delta', color: '#ffc21a' },
];

/** Team info for a player (Alpha when an older server sent none). */
export const lobbyTeam = (team: string | undefined): (typeof LOBBY_TEAMS)[number] =>
  LOBBY_TEAMS.find((t) => t.id === team) ?? LOBBY_TEAMS[0]!;

export interface LobbyPlayer {
  id: string;
  name: string;
  jetId: string;
  appearance?: JetAppearance;
  /** Optional: older servers don't send teams. */
  team?: LobbyTeam;
  ready: boolean;
  inGame: boolean;
}

export interface Lobby {
  id: string;
  code: string;
  hostId: string;
  state: 'lobby' | 'playing';
  startedAt: number;
  settings: LobbySettings;
  players: LobbyPlayer[];
}

export interface LobbySummary {
  id: string;
  name: string;
  hostName: string;
  mode: LobbyMode;
  courseId: string;
  laps: number;
  raceDifficulty: RaceDifficulty;
  raceLayout: RaceLayout;
  worldKey: string;
  seedText: string;
  players: number;
  maxPlayers: number;
  state: 'lobby' | 'playing';
  joinable: boolean;
}

/** Clones settings, filling fields omitted by older multiplayer servers. */
export const cloneLobbySettings = (s: LobbySettings): LobbySettings => ({
  ...DEFAULT_LOBBY_SETTINGS,
  ...s,
  world: { ...DEFAULT_LOBBY_SETTINGS.world, ...s.world },
});

/** Validates a locally saved lobby before it is used to prefill the host's next lobby. */
export function isLobbySettings(value: unknown): value is LobbySettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  if (!s.world || typeof s.world !== 'object' || Array.isArray(s.world)) return false;
  const w = s.world as Record<string, unknown>;
  const numberIn = (v: unknown, min: number, max: number): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
  const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
  return (
    text(s.name, 32) && s.name.trim().length > 0 &&
    typeof s.private === 'boolean' && typeof s.allowLateJoin === 'boolean' &&
    (s.mode === 'race' || s.mode === 'free' || s.mode === 'dogfight') &&
    numberIn(s.maxPlayers, 2, s.mode === 'dogfight' ? DOGFIGHT_MAX_PLAYERS : LOBBY_MAX_PLAYERS) && Number.isInteger(s.maxPlayers) &&
    text(s.courseId, 48) && s.courseId.length > 0 &&
    numberIn(s.laps, 1, 5) && Number.isInteger(s.laps) &&
    (s.raceDifficulty === 'easy' || s.raceDifficulty === 'medium' || s.raceDifficulty === 'hard') &&
    (s.raceLayout === 'sprint' || s.raceLayout === 'loop') &&
    // Optional: lobbies saved before these rules existed still load (cloneLobbySettings fills them).
    (s.forceView === undefined || s.forceView === 'any' || s.forceView === 'chase' || s.forceView === 'cockpit') &&
    (s.forceJet === undefined || text(s.forceJet, 32)) &&
    text(w.seedText, MAX_SEED_TEXT_LEN) && typeof w.worldKey === 'string' && parseWorldKey(w.worldKey) !== null &&
    numberIn(w.timeOfDay, 0, 24) && numberIn(w.cloudCoverage, 0, 1) &&
    numberIn(w.windSpeed, 0, 25) && numberIn(w.windDirection, 0, 359) && numberIn(w.turbulence, 0, 1)
  );
}
