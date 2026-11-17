import type { WeaponStatus } from '../../combat/types';

export type DogfightHudPhase = 'countdown' | 'fighting' | 'dead' | 'finished';
export type DogfightHudResult = 'victory' | 'defeat' | 'opponentLeft';

/** One pilot's line on the scoreboard. */
export interface DogfightStanding {
  id: string;
  name: string;
  kills: number;
  self: boolean;
  /** Left the match (kept on the board with its kills). */
  left: boolean;
}

/** Everything the combat HUD shows, rebuilt by DogfightSession every frame (plain data). */
export interface DogfightHudState {
  phase: DogfightHudPhase;
  /** Seconds left in the start countdown. */
  countdown: number;
  /** Null while not fighting (dead / finished). */
  weapons: WeaponStatus | null;
  myKills: number;
  /** Best score among the other pilots. */
  opponentKills: number;
  killsToWin: number;
  /** The opponent's name in a duel, "N OPPONENTS" in a free-for-all. */
  opponentName: string;
  /** Every pilot, best score first (a duel shows YOU – OPPONENT, more pilots a list). */
  standings: DogfightStanding[];
  /** Name of the match winner once the relay declared one. */
  winnerName: string | null;
  /** Seconds before the zone destroys us; null while inside the zone. */
  zoneTimer: number | null;
  zoneReason: 'radius' | 'ceiling' | null;
  /** Seconds before the respawn; null unless dead. */
  respawnIn: number | null;
  /** Why we died (shown with the respawn countdown). */
  deathText: string | null;
  /** Short kill/hit notice under the score. */
  feed: string | null;
  result: DogfightHudResult | null;
}

/** What DogfightSession needs from the HUD (DogfightHud implements it). */
export interface DogfightHudView {
  update(state: DogfightHudState): void;
  dispose(): void;
}
