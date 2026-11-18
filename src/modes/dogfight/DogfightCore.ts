import { DOGFIGHT_RULES, type CombatMessage, type DeathCause, type DogfightScore } from '../../combat/types';
import { checkZone, type DogfightZone } from './zone';

export type DogfightPhase = 'countdown' | 'fighting' | 'dead' | 'finished';
export type DogfightResult = 'victory' | 'defeat' | 'opponentLeft';

export type DogfightRules = Pick<typeof DOGFIGHT_RULES, 'killsToWin' | 'outOfZoneSeconds' | 'respawnDelay' | 'killCreditSeconds'>;

/** What happened during a step (the session reacts: sounds, respawning the jet, results panel). */
export type DogfightCoreEvent =
  | { type: 'countdownBeep'; go: boolean }
  | { type: 'destroyed'; by: string | null; cause: DeathCause }
  | { type: 'respawn'; round: number }
  | { type: 'finished'; result: DogfightResult };

export interface DogfightCoreOptions {
  selfId: string;
  /** The other pilots of the match (1 in a duel, up to 3). */
  opponentIds: readonly string[];
  zone: DogfightZone;
  /** Seconds before the fight starts (0 = fight right away). */
  countdown?: number;
  rules?: DogfightRules;
}

export interface Point3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Dogfight rules for the local player, without Three.js or the DOM: start countdown, combat-zone
 * timer, death and respawn timer, the relay's score and the end of the match (free-for-all, 2-4
 * pilots). Messages for the other players collect in the outbox; local happenings in the events.
 */
export class DogfightCore {
  phase: DogfightPhase;
  countdown: number;
  /** Seconds left before the zone destroys us; null while inside. */
  zoneTimer: number | null = null;
  zoneReason: 'radius' | 'ceiling' | null = null;
  /** Horizontal distance to the zone wall at the last step (negative outside). */
  wallDistance = Infinity;
  respawnTimer = 0;
  /** Lives used so far (0 = first spawn). */
  round = 0;
  score: DogfightScore = { kills: {}, winnerId: null };
  result: DogfightResult | null = null;
  lastDeath: { by: string | null; cause: DeathCause } | null = null;
  readonly selfId: string;
  /** Opponents still in the match (players who left are removed). */
  readonly opponentIds: string[];
  readonly zone: DogfightZone;
  readonly rules: DogfightRules;
  /** Seconds since the core was created (clock for the kill credit). */
  private clock = 0;
  private lastAttacker: { id: string; at: number } | null = null;
  private lastBeep = Infinity;
  private outbox: CombatMessage[] = [];
  private events: DogfightCoreEvent[] = [];

  constructor(options: DogfightCoreOptions) {
    this.selfId = options.selfId;
    this.opponentIds = options.opponentIds.filter((id) => id !== options.selfId);
    this.zone = options.zone;
    this.rules = options.rules ?? DOGFIGHT_RULES;
    this.countdown = Math.max(0, options.countdown ?? 3);
    this.phase = this.countdown > 0 ? 'countdown' : 'fighting';
  }

  get myKills(): number {
    return this.score.kills[this.selfId] ?? 0;
  }

  /** Best score among the other pilots. */
  get opponentKills(): number {
    let best = 0;
    for (const [id, k] of Object.entries(this.score.kills)) if (id !== this.selfId) best = Math.max(best, k);
    return best;
  }

  /** True while the jet must stay still (start countdown). */
  get frozen(): boolean {
    return this.phase === 'countdown';
  }

  /** Weapons work and the zone counts only while alive in the fight. */
  get fighting(): boolean {
    return this.phase === 'fighting';
  }

  /** Another pilot damaged us: a crash or zone death soon after counts as its kill. */
  noteDamage(by: string): void {
    if (by !== this.selfId && this.phase === 'fighting') this.lastAttacker = { id: by, at: this.clock };
  }

  /** One fixed step; `position` = the local jet (ignored unless fighting). */
  step(dt: number, position: Point3): void {
    this.clock += dt;
    switch (this.phase) {
      case 'countdown': {
        this.countdown = Math.max(0, this.countdown - dt);
        if (this.countdown <= 0) {
          this.events.push({ type: 'countdownBeep', go: true });
          this.phase = 'fighting';
          break;
        }
        const n = Math.ceil(this.countdown);
        if (n < this.lastBeep) {
          this.lastBeep = n;
          this.events.push({ type: 'countdownBeep', go: false });
        }
        break;
      }
      case 'fighting': {
        const z = checkZone(this.zone, position.x, position.y, position.z);
        this.wallDistance = z.wallDistance;
        this.zoneReason = z.reason;
        if (!z.outside) {
          this.zoneTimer = null;
          break;
        }
        this.zoneTimer = (this.zoneTimer ?? this.rules.outOfZoneSeconds) - dt;
        if (this.zoneTimer <= 1e-9) this.destroyed(null, 'zone');
        break;
      }
      case 'dead':
        this.respawnTimer -= dt;
        if (this.respawnTimer <= 0) {
          this.respawnTimer = 0;
          this.phase = 'fighting';
          this.round++;
          this.events.push({ type: 'respawn', round: this.round });
          this.outbox.push({ t: 'respawned' });
        }
        break;
      case 'finished':
        break;
    }
  }

  /**
   * The local jet died (crash, zone, weapons): announces it with `destroyed` and starts the respawn
   * timer. Ignored (false) unless fighting, so a second report of the same death is harmless.
   * A death without a shooter (crash, zone) shortly after a hit is credited to the last attacker.
   */
  destroyed(by: string | null, cause: DeathCause): boolean {
    if (this.phase !== 'fighting') return false;
    const a = this.lastAttacker;
    if (by === null && a && this.clock - a.at <= this.rules.killCreditSeconds && this.opponentIds.includes(a.id)) by = a.id;
    this.lastAttacker = null;
    this.phase = 'dead';
    this.respawnTimer = this.rules.respawnDelay;
    this.zoneTimer = null;
    this.zoneReason = null;
    this.lastDeath = { by, cause };
    this.outbox.push({ t: 'destroyed', by, cause });
    this.events.push({ type: 'destroyed', by, cause });
    return true;
  }

  /** Relay-authoritative score; a winner ends the match. */
  setScore(score: DogfightScore): void {
    this.score = { kills: { ...score.kills }, winnerId: score.winnerId };
    if (score.winnerId !== null) this.finish(score.winnerId === this.selfId ? 'victory' : 'defeat');
  }

  /** A player left the game: the match is over once no opponent is left. */
  playerLeft(id: string): void {
    const i = this.opponentIds.indexOf(id);
    if (i >= 0) this.opponentIds.splice(i, 1);
    if (this.opponentIds.length === 0) this.finish('opponentLeft');
  }

  private finish(result: DogfightResult): void {
    if (this.phase === 'finished') return;
    this.phase = 'finished';
    this.result = result;
    this.zoneTimer = null;
    this.zoneReason = null;
    this.events.push({ type: 'finished', result });
  }

  drainOutbox(): CombatMessage[] {
    const out = this.outbox;
    this.outbox = [];
    return out;
  }

  drainEvents(): DogfightCoreEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }
}
