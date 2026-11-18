import type { Quaternion, Vector3 } from 'three';

/**
 * SHARED CONTRACT (phase 0): weapons, dogfight rules and the combat network messages.
 * Combat code lives in src/combat and NEVER edits the jet model (src/entities/jet/**): projectiles,
 * missiles and flares are separate scene objects spawned from offsets of the jet's position/orientation,
 * and damage goes through the existing `jet.damage.apply(amount)` (DamageModel) API only.
 */

export const WEAPON_RULES = Object.freeze({
  gun: Object.freeze({
    /** Rounds per second while the trigger is held. */
    rateOfFire: 25,
    /** Muzzle speed added to the jet's velocity (m/s). */
    muzzleSpeed: 1050,
    /** Rounds disappear after this distance (m). */
    range: 1400,
    /** Airframe health removed per hit (health 1 = intact). */
    damagePerHit: 0.05,
    /** Heat per round (0..1); at 1 the gun overheats. */
    heatPerShot: 0.014,
    /** Heat lost per second. */
    coolRate: 0.22,
    /** After an overheat the gun fires again once heat drops below this. */
    overheatRecover: 0.35,
    /** Random cone half-angle of the rounds (rad). */
    spread: 0.003,
    /** Hit radius around the target jet's centre (m): about half a wingspan. */
    hitRadius: 7,
  }),
  missile: Object.freeze({
    count: 4,
    /** Seeker field of view half-angle (rad) for lock and tracking. */
    seekerHalfAngle: (28 * Math.PI) / 180,
    /** Half-size (rad) of the square lock box around the nose: the target must stay inside it while locking. */
    lockBoxHalfAngle: (10 * Math.PI) / 180,
    /** Seconds the target must stay in the lock box before the missile locks. */
    lockTime: 1.2,
    lockRange: 4500,
    minRange: 250,
    /** Speed gained over the launch speed during the motor burn (m/s). */
    boostSpeed: 480,
    burnTime: 5,
    /** Self-destructs after this many seconds. */
    maxLife: 16,
    /** Max lateral acceleration (g). */
    maxG: 30,
    /** Proportional-navigation gain. */
    navGain: 4,
    /** Proximity fuse radius (m). */
    fuseRadius: 16,
    damage: 0.85,
    /** Seconds between two launches. */
    reload: 1,
  }),
  flare: Object.freeze({
    count: 30,
    /** Flares released per press. */
    salvo: 2,
    cooldown: 0.4,
    life: 4,
    /** Chance (0..1) that a missile tracking you switches to a fresh flare inside its seeker cone (per salvo). */
    decoyChance: 0.75,
  }),
});

export const DOGFIGHT_RULES = Object.freeze({
  killsToWin: 3,
  /** Free-for-all between 2 (duel) and 4 pilots. */
  minPlayers: 2,
  maxPlayers: 4,
  /** Combat zone: a cylinder 6 km across for a duel (20 km ceiling)... */
  zoneRadius: 3000,
  /** ...plus 2 km of diameter for every pilot beyond two (8 km for 3, 10 km for 4). */
  zoneRadiusPerExtraPlayer: 1000,
  ceiling: 20000,
  outOfZoneSeconds: 10,
  respawnDelay: 3,
  /** Spawns sit this far inside the zone wall (2300 m from the centre in a duel), evenly spread, facing the centre. */
  spawnWallMargin: 700,
  spawnHeightAboveGround: 600,
  spawnSpeed: 200,
  /** A crash or zone death within this many seconds of being hit counts as a kill for the last attacker. */
  killCreditSeconds: 10,
});

/** Weapon state shown on the combat HUD. */
export interface WeaponStatus {
  gunHeat: number;
  gunOverheated: boolean;
  missiles: number;
  flares: number;
  /** 0..1 seeker lock progress on the current target; 1 = locked. */
  lock: number;
  lockTargetId: string | null;
  /** A missile is tracking us (missile warning). */
  incomingMissile: boolean;
}

/** Anything that can be shot at or launch weapons (the local jet or an interpolated remote player). */
export interface Combatant {
  readonly id: string;
  readonly position: Vector3;
  readonly velocity: Vector3;
  readonly orientation: Quaternion;
  readonly afterburner: boolean;
  readonly alive: boolean;
}

export type DeathCause = 'gun' | 'missile' | 'zone' | 'crash';

type V3 = [number, number, number];

/**
 * Combat messages relayed between the dogfight players (net-lobby workstream transports them;
 * NetClient.sendCombat(msg) / NetClient.combat signal (fromId, msg)).
 * Authority: the SHOOTER decides gun and missile hits (against its view of the target, including the
 * target's flares) and sends them; the VICTIM applies the damage and announces its own death.
 * The relay counts kills from 'destroyed' messages and announces the score / winner.
 */
export type CombatMessage =
  | { t: 'gunFire'; p: V3; v: V3 }
  | { t: 'gunHit'; target: string; damage: number }
  | { t: 'missileLaunch'; id: string; target: string | null; p: V3; v: V3 }
  | { t: 'missileUpdate'; id: string; p: V3; v: V3 }
  | { t: 'missileEnd'; id: string; p: V3; hit: string | null; damage: number }
  | { t: 'flares'; p: V3; v: V3; n: number }
  | { t: 'destroyed'; by: string | null; cause: DeathCause }
  | { t: 'respawned' };

/** Server-announced dogfight score (relay -> clients). */
export interface DogfightScore {
  kills: Record<string, number>;
  winnerId: string | null;
}
