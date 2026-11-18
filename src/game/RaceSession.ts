import { Quaternion, Vector3, type Object3D } from 'three';
import { getJetDefinition, JET_CATALOG } from '../entities/jet/jetCatalog';
import { approachPoint, resolveCourse, type CourseDef, type ResolvedCourse } from '../race/Course';
import { GhostRecorder, GhostStore, sampleGhost, type GhostData } from '../race/Ghost';
import { Leaderboard, medalFor, type LeaderboardEntry, type Medal } from '../race/Leaderboard';
import { RaceProgress, type GateResult } from '../race/RaceProgress';
import { categoryKey, describeConditions, raceWeather, recordCategory, type RecordCategory } from '../race/RecordCategory';
import { compareWithGhost, type SplitState } from '../race/Splits';
import type { GameSettings } from '../settings/Settings';
import type { Weather, WeatherSettings } from '../world/environment/Weather';
import type { HeightField } from '../world/terrain/HeightField';
import { AIRacer } from './AIRacer';
import { PuppetJet } from './PuppetJet';
import type { Jet } from '../entities/jet/Jet';

const COUNTDOWN = 3;
const AI_NAMES = ['Maverick', 'Viper', 'Iceman', 'Goose', 'Phoenix', 'Hangman', 'Rooster'];

export interface Standing {
  name: string;
  isPlayer: boolean;
  finished: boolean;
  time: number;
  totalGates: number;
  distance: number;
}

export interface RaceFinish {
  time: number;
  penalties: number;
  medal: Medal;
  /** Leaderboard rank (0 = not on the board, or an unranked run). */
  rank: number;
  position: number;
  racers: number;
  /** Ranked run that beat the best ghost of its category (whether or not it could be saved). */
  newBest: boolean;
  /** Ranked run: records were eligible to be saved. */
  ranked: boolean;
  /** null = no save attempted (unranked, or the ghost wasn't a new best). */
  ghostSaved: boolean | null;
  leaderboardSaved: boolean | null;
  top: LeaderboardEntry[];
  /** Final split comparison (at the finish gate). */
  split: SplitState;
  /** Human-readable record category (jet, conditions, laps). */
  categoryLabel: string;
}

export interface RaceSessionOptions {
  /**
   * Ranked runs (default) save leaderboard entries and best ghosts for their record category and use
   * the category's best ghost as the split reference. Unranked runs (multiplayer, practice, lessons)
   * never write records.
   */
  ranked?: boolean;
  /** Weather forced for the race. Default: `raceWeather(settings)` for ranked runs, null (world weather) otherwise. */
  weather?: WeatherSettings | null;
  /** Compare splits against the category's best ghost. Default: same as `ranked`. */
  reference?: boolean;
  ghostStore?: GhostStore;
}

/** One race: course, countdown, timing, player progress, AI opponents, best-run ghost, results. */
export class RaceSession {
  readonly course: ResolvedCourse;
  readonly laps: number;
  /** Record category, frozen at race start. */
  readonly category: RecordCategory;
  /** Canonical record category key. */
  readonly key: string;
  readonly ranked: boolean;
  /** Weather the game must apply during this race (null = keep the world/lobby weather). */
  readonly weather: WeatherSettings | null;
  readonly player: RaceProgress;
  readonly ais: AIRacer[] = [];
  state: 'countdown' | 'racing' | 'finished' = 'countdown';
  countdown = COUNTDOWN;
  raceTime = 0;
  /** Length of the current physics step of the race clock (0 on the GO step). */
  private stepDt = 0;
  private readonly recorder = new GhostRecorder();
  private readonly ghostStore: GhostStore;
  /** Split reference: the category's best ghost, chosen once at race start. */
  private readonly reference: GhostData | null;
  private ghostJet: PuppetJet | null = null;
  private readonly ghostPos = new Vector3();
  private readonly ghostRot = new Quaternion();
  private readonly playerName: string;
  /** Latest split comparison; stays until the next gate. */
  split: SplitState;

  constructor(
    def: CourseDef,
    settings: GameSettings,
    heightField: HeightField,
    private readonly parent: Object3D,
    private readonly leaderboard: Leaderboard,
    options: RaceSessionOptions = {},
  ) {
    this.course = resolveCourse(def, heightField);
    this.laps = def.loop ? settings.laps : 1;
    this.ranked = options.ranked ?? true;
    this.category = recordCategory(def, this.laps, settings);
    this.key = categoryKey(this.category);
    this.weather = options.weather !== undefined ? options.weather : this.ranked ? raceWeather(settings) : null;
    this.playerName = settings.playerName;
    this.ghostStore = options.ghostStore ?? new GhostStore();
    this.player = new RaceProgress(this.course.gates.length, this.laps);
    this.reference = (options.reference ?? this.ranked) ? this.ghostStore.load(this.key) : null;
    if (this.reference) this.split = { kind: 'pending' };
    else if (!this.ranked && !options.reference) this.split = { kind: 'no-reference', reason: 'Unranked run' };
    else this.split = { kind: 'no-reference', reason: this.ghostStore.loadLegacy(def.id, this.laps) ? 'Only a legacy ghost (older rules)' : 'No best ghost for this jet/conditions yet' };
    if (this.reference && settings.showGhost) this.ghostJet = new PuppetJet(getJetDefinition(this.reference.jetId), parent, 0.35);

    const { position, heading } = this.course.start;
    const fwd = new Vector3(-Math.sin(heading), 0, -Math.cos(heading));
    const side = new Vector3(-fwd.z, 0, fwd.x);
    for (let i = 0; i < settings.aiOpponents; i++) {
      const def = JET_CATALOG[(i + 1) % JET_CATALOG.length]!;
      const ai = new AIRacer(AI_NAMES[i % AI_NAMES.length]!, def, settings.aiSkill * (0.85 + 0.3 * ((i * 37) % 10) / 10), this.course.gates.length, this.laps, i + 1, parent);
      const row = Math.floor(i / 2) + 1;
      const col = i % 2 === 0 ? -1 : 1;
      ai.place(position.clone().addScaledVector(side, col * 45).addScaledVector(fwd, -row * 70), heading, this.course.start.speed);
      this.ais.push(ai);
    }
  }

  /** Player start pose. */
  get startPosition(): Vector3 {
    return this.course.start.position;
  }

  get frozen(): boolean {
    return this.state === 'countdown';
  }

  /** The visible ghost jet, if any (radar). */
  get ghost(): Jet | null {
    return this.ghostJet?.jet.object.visible ? this.ghostJet.jet : null;
  }

  /** Advances countdown / race clock. Returns the countdown beep to play (3, 2, 1, 0 = GO) if any. */
  tick(dt: number): number | null {
    if (this.state === 'countdown') {
      const before = Math.ceil(this.countdown);
      this.countdown -= dt;
      const after = Math.ceil(this.countdown);
      if (this.countdown <= 0) {
        this.state = 'racing';
        this.stepDt = 0;
        return 0;
      }
      return after !== before ? after : null;
    }
    if (this.state === 'racing') {
      this.raceTime += dt;
      this.stepDt = dt;
    }
    return null;
  }

  fixedUpdateAIs(dt: number, heightField: HeightField, weather: Weather, collision?: Parameters<AIRacer['fixedUpdate']>[5]): void {
    if (this.state === 'countdown') return;
    for (const ai of this.ais) ai.fixedUpdate(dt, this.course.gates, this.raceTime, heightField, weather, collision);
  }

  /** Player gate check; records the ghost and the split vs the reference. */
  updatePlayer(before: readonly Vector3[], after: readonly Vector3[], position: Vector3, rotation: Quaternion, throttle: number): GateResult {
    if (this.state !== 'racing') return null;
    if (this.ranked) this.recorder.record(this.raceTime, position, rotation, throttle);
    const r = this.player.update(before, after, this.course.gates, this.raceTime, this.stepDt);
    if (r) {
      this.updateSplit(r.kind === 'missed');
      if (r.finished) this.state = 'finished';
    }
    return r;
  }

  private updateSplit(missed: boolean): void {
    const p = this.player;
    const i = p.splits.length - 1;
    const lap = Math.floor(i / p.gateCount) + 1;
    const gate = (i % p.gateCount) + 1;
    if (!this.reference) return; // stays "No reference"
    const c = compareWithGhost(this.reference, i, p.splits[i]!, p.penaltySplits[i]!);
    this.split = c.kind === 'delta' ? { kind: 'delta', ms: c.ms, lap, gate, missed } : { kind: 'unavailable', lap, gate, reason: c.reason };
  }

  /** Human-readable record category. */
  get categoryLabel(): string {
    const jet = JET_CATALOG.find((j) => j.id === this.category.jetId)?.name ?? this.category.jetId;
    return `${jet} · ${describeConditions(this.category.conditions)} · ${this.laps} lap${this.laps === 1 ? '' : 's'}`;
  }

  /**
   * Ranked runs save the leaderboard entry + best ghost of the category (failures are reported, never
   * thrown). Call once when the player finishes.
   */
  finish(playerPosition: Vector3, others: Standing[] = []): RaceFinish {
    const p = this.player;
    const medal = medalFor(p.finishTime, this.course.medals, this.laps);
    let rank = 0;
    let newBest = false;
    let ghostSaved: boolean | null = null;
    let leaderboardSaved: boolean | null = null;
    if (this.ranked) {
      const entry: LeaderboardEntry = {
        name: this.playerName,
        jetId: this.category.jetId,
        time: p.finishTime,
        penalties: p.penalties,
        medal,
        date: new Date().toLocaleDateString(),
      };
      try {
        const lb = this.leaderboard.add(this.category, this.key, entry);
        rank = lb.rank;
        leaderboardSaved = lb.saved;
      } catch (e) {
        console.warn('Leaderboard could not be saved', e);
        leaderboardSaved = false;
      }
      try {
        const g = this.ghostStore.saveIfBest(this.recorder.finish(this.key, this.category.jetId, p.finishTime, p.splits, p.penaltySplits));
        newBest = g.best;
        ghostSaved = g.best ? g.saved : null;
      } catch (e) {
        console.warn('Ghost could not be saved', e);
        ghostSaved = false;
      }
    }
    const standings = this.standings(playerPosition, others);
    const position = standings.findIndex((s) => s.isPlayer) + 1;
    return {
      time: p.finishTime,
      penalties: p.penalties,
      medal,
      rank,
      position,
      racers: standings.length,
      newBest,
      ranked: this.ranked,
      ghostSaved,
      leaderboardSaved,
      top: this.ranked ? this.leaderboard.get(this.key) : [],
      split: this.split,
      categoryLabel: this.categoryLabel,
    };
  }

  /** Respawn pose for the player after a crash: on the approach to their next gate. */
  respawnPose(heightField: HeightField): { position: Vector3; heading: number; speed: number } {
    if (this.player.totalGates === 0) {
      return { position: this.course.start.position.clone(), heading: this.course.start.heading, speed: this.course.start.speed };
    }
    const target = this.course.gates[this.player.gateIndex]!;
    const pos = approachPoint(target, target.normal, 450, heightField);
    return { position: pos, heading: Math.atan2(-target.normal.x, -target.normal.z), speed: 150 };
  }

  render(time: number, dt: number, alpha: number): void {
    for (const ai of this.ais) ai.render(alpha, time, dt);
    if (this.ghostJet && this.reference) {
      const s = sampleGhost(this.reference, this.raceTime, this.ghostPos, this.ghostRot);
      this.ghostJet.visible = this.state !== 'countdown' && !s.done;
      this.ghostJet.set(this.ghostPos, this.ghostRot, s.throttle, time, dt);
    }
  }

  /** @param others extra racers (multiplayer opponents). */
  standings(playerPosition: Vector3, others: Standing[] = []): Standing[] {
    const gates = this.course.gates;
    const list: Standing[] = [
      {
        name: this.playerName,
        isPlayer: true,
        finished: this.player.finished,
        time: this.player.finishTime,
        totalGates: this.player.totalGates,
        distance: playerPosition.distanceTo(gates[this.player.gateIndex]!.center),
      },
      ...this.ais.map((a) => ({
        name: a.name,
        isPlayer: false,
        finished: a.progress.finished,
        time: a.progress.finishTime,
        totalGates: a.progress.totalGates,
        distance: a.distanceToNextGate(gates),
      })),
      ...others,
    ];
    return list.sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished) return a.time - b.time;
      if (a.totalGates !== b.totalGates) return b.totalGates - a.totalGates;
      return a.distance - b.distance;
    });
  }

  dispose(): void {
    for (const ai of this.ais) ai.dispose(this.parent);
    this.ghostJet?.dispose(this.parent);
  }
}
