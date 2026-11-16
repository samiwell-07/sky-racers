/** Shared lobby protocol types (mirrors server/relay.mjs). */

export type LobbyMode = 'free' | 'race';

export interface LobbyWorld {
  timeOfDay: number;
  cloudCoverage: number;
  windSpeed: number;
  windDirection: number;
  turbulence: number;
}

export interface LobbySettings {
  name: string;
  private: boolean;
  maxPlayers: number;
  mode: LobbyMode;
  courseId: string;
  laps: number;
  allowLateJoin: boolean;
  world: LobbyWorld;
}

/** Same defaults as the server: the game's base world, not the host's personal settings. */
export const DEFAULT_LOBBY_SETTINGS: Readonly<LobbySettings> = Object.freeze({
  name: 'Sky race',
  private: false,
  maxPlayers: 8,
  mode: 'race',
  courseId: 'canyon-loop',
  laps: 2,
  allowLateJoin: true,
  world: Object.freeze({ timeOfDay: 14, cloudCoverage: 0.4, windSpeed: 6, windDirection: 90, turbulence: 0.5 }),
});

export interface LobbyPlayer {
  id: string;
  name: string;
  jetId: string;
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
  players: number;
  maxPlayers: number;
  state: 'lobby' | 'playing';
  joinable: boolean;
}

export const cloneLobbySettings = (s: LobbySettings): LobbySettings => ({ ...s, world: { ...s.world } });
