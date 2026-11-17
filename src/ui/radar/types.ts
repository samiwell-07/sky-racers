/**
 * SHARED CONTRACT (phase 0): data fed to the HUD radar each frame. The radar is a round,
 * heading-up display; every mode builds a RadarFrame from its own state (Game wires providers).
 */

export type RadarContactKind =
  /** Dogfight opponent. */
  | 'enemy'
  /** Other human players (race / free flight). */
  | 'player'
  | 'ai'
  | 'ghost'
  | 'gate'
  | 'nextGate'
  | 'missile'
  /** A missile tracking the local player. */
  | 'incomingMissile'
  | 'flare'
  | 'airfield';

export interface RadarContact {
  kind: RadarContactKind;
  x: number;
  y: number;
  z: number;
  /** Rotation about +Y (0 = toward -Z), for jets drawn as arrows. */
  heading?: number;
  label?: string;
}

/** Circular combat zone (dogfight) drawn as a ring. */
export interface RadarZone {
  cx: number;
  cz: number;
  radius: number;
}

export interface RadarFrame {
  self: { x: number; y: number; z: number; heading: number };
  contacts: readonly RadarContact[];
  zone?: RadarZone | null;
}
