import { Quaternion, Vector3, type Object3D } from 'three';
import { AIPilot, type AIHazards, type AIWaypoint } from '../ai/AIPilot';
import { createFlightConfig } from '../config/flightConfig';
import { Jet } from '../entities/jet/Jet';
import type { JetDefinition } from '../entities/jet/jetCatalog';
import { RaceProgress } from '../race/RaceProgress';
import { approachPoint } from '../race/Course';
import { CollisionSystem, IMPACT_RULES, ImpactTracker, type CrashReason, type ObstacleSource } from '../systems/CollisionSystem';
import type { RingShape } from '../world/rings/ringMath';
import type { Weather } from '../world/environment/Weather';
import type { HeightField } from '../world/terrain/HeightField';

/** Terrain-only collision worlds for callers that don't pass one (shared per height field). */
const terrainOnly = new WeakMap<HeightField, CollisionSystem>();

function hazardsOf(source: ObstacleSource | null): AIHazards | null {
  return source?.obstacleTop && source.hazardBands ? (source as AIHazards) : null;
}

/**
 * A computer-controlled racer: its own jet + autopilot + race progress. It collides exactly like the
 * player (same CollisionSystem checks, damage, cooldown and respawn delay) and respawns at its next gate.
 */
export class AIRacer {
  readonly jet: Jet;
  readonly progress: RaceProgress;
  private readonly pilot: AIPilot;
  private readonly before: Vector3[] = [];
  private readonly after: Vector3[] = [];
  private readonly impacts = new ImpactTracker();
  private crashTimer = 0;
  private hazardSource: ObstacleSource | null = null;
  private readonly wp: AIWaypoint = { position: new Vector3(), direction: new Vector3() };
  private readonly nextWp: AIWaypoint = { position: new Vector3(), direction: new Vector3() };
  /** Statistics (tests, debugging). */
  crashCount = 0;
  damageHits = 0;
  lastCrashReason: CrashReason | null = null;

  constructor(
    readonly name: string,
    definition: JetDefinition,
    skill: number,
    gateCount: number,
    laps: number,
    private readonly phase: number,
    parent: Object3D,
  ) {
    this.jet = new Jet(definition, createFlightConfig(definition.flight), false);
    this.pilot = new AIPilot({ skill, seed: Math.round(phase * 1000), targetSpeed: 160 + skill * 30 });
    this.progress = new RaceProgress(gateCount, laps);
    parent.add(this.jet.object);
  }

  get crashed(): boolean {
    return this.crashTimer > 0;
  }

  place(position: Vector3, heading: number, speed: number): void {
    this.jet.reset({ position, orientation: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), heading), speed, throttle: 0.75 });
    this.pilot.reset();
  }

  /**
   * @param collision the player's collision world (terrain + props). Without it the AI only collides
   * with the terrain and water.
   */
  fixedUpdate(dt: number, gates: readonly RingShape[], raceTime: number, heightField: HeightField, weather: Weather, collision?: CollisionSystem): void {
    this.impacts.tick(dt);
    if (this.crashTimer > 0) {
      this.crashTimer -= dt;
      if (this.crashTimer <= 0) this.respawnAtLastGate(gates, heightField);
      return;
    }
    if (this.progress.finished) {
      // Cruise on after the finish line.
      this.jet.fixedUpdate(dt, { pitch: 0, roll: 0, throttle: -1 });
      return;
    }
    const world = collision ?? this.terrainCollision(heightField);
    const source = world.obstacleSource;
    if (source !== this.hazardSource) {
      this.hazardSource = source;
      this.pilot.setHazards(hazardsOf(source));
    }

    const gate = gates[this.progress.gateIndex]!;
    this.wp.position.copy(gate.center);
    this.wp.direction.copy(gate.normal);
    const next = gates[(this.progress.gateIndex + 1) % gates.length]!;
    this.nextWp.position.copy(next.center);
    this.nextWp.direction.copy(next.normal);

    const pos = this.jet.position;
    weather.apply(this.jet.flight, pos.y - heightField.getSurfaceHeight(pos.x, pos.z), this.phase * 10);
    const ground = (x: number, z: number): number => heightField.getSurfaceHeight(x, z);
    const controls = this.pilot.computeControls(this.jet.flight, this.wp, ground, dt, this.nextWp);
    this.jet.fixedUpdate(dt, controls);

    this.jet.getPreviousWorldCollisionPoints(this.before);
    this.jet.getWorldCollisionPoints(this.after);
    this.progress.update(this.before, this.after, gates, raceTime);

    const hit = this.impacts.apply(world.check(this.after), this.jet);
    if (!hit) return;
    if (hit.kind === 'crash') this.crash(hit.reason);
    else {
      this.damageHits++;
      if (hit.destroyed) this.crash('damage');
    }
  }

  private crash(reason: CrashReason): void {
    this.crashCount++;
    this.lastCrashReason = reason;
    this.crashTimer = IMPACT_RULES.respawnDelay;
    this.jet.object.visible = false;
  }

  private terrainCollision(heightField: HeightField): CollisionSystem {
    let c = terrainOnly.get(heightField);
    if (!c) {
      c = new CollisionSystem(heightField);
      terrainOnly.set(heightField, c);
    }
    return c;
  }

  /** Same recovery as the player: on the approach to the next gate (RaceSession.respawnPose). */
  private respawnAtLastGate(gates: readonly RingShape[], heightField: HeightField): void {
    const target = gates[this.progress.gateIndex]!;
    const pos = approachPoint(target, target.normal, 450, heightField);
    this.place(pos, Math.atan2(-target.normal.x, -target.normal.z), 150);
  }

  render(alpha: number, time: number, dt: number): void {
    if (!this.crashed) this.jet.render(alpha, time, dt);
  }

  /** Distance to the next gate, for standings. */
  distanceToNextGate(gates: readonly RingShape[]): number {
    return this.jet.position.distanceTo(gates[this.progress.gateIndex]!.center);
  }

  /** Removes the jet and frees its GPU resources (safe to call more than once). */
  dispose(_parent?: Object3D): void {
    this.jet.dispose();
  }
}
