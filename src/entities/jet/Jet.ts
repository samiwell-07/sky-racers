import { Group, Quaternion, Vector3, type BufferGeometry, type Mesh, type Object3D } from 'three';
import type { FlightConfig } from '../../config/flightConfig';
import { FlightModel, type SpawnState } from '../../physics/FlightModel';
import type { FlightControls } from '../../physics/types';
import { HeatHaze } from '../../effects/HeatHaze';
import { Afterburner } from './Afterburner';
import { NavLights } from './NavLights';
import { DamageModel } from './DamageModel';
import { buildJetModel, type JetParts } from './JetModel';
import type { JetDefinition } from './jetCatalog';
import { tryLoadGltfJet } from './gltfJet';
import { disposeObject3D } from './disposeObject';

/** Points on the airframe (local space) used for ground/obstacle collision. */
export const JET_COLLISION_POINTS: readonly Vector3[] = [
  new Vector3(0, 0, -10.2), // 0 nose
  new Vector3(0, -0.9, -3), // 1 belly front
  new Vector3(0, -0.9, 4), // 2 belly rear
  new Vector3(-6.6, 0, 4), // 3-4 wing tips
  new Vector3(6.6, 0, 4),
  new Vector3(-3.8, -0.65, 2.2), // 5-6 under-wing stores
  new Vector3(3.8, -0.65, 2.2),
  new Vector3(-4.3, -0.05, 8.5), // 7-8 stabilizer tips
  new Vector3(4.3, -0.05, 8.5),
  new Vector3(-2.2, 3.7, 7.5), // 9-10 fin tips
  new Vector3(2.2, 3.7, 7.5),
  new Vector3(0, -0.5, 9.3), // 11 exhaust
];

/** Collision points on the extremities: touching the ground with only these is a scrape, not a crash. */
export const EXTREMITY_POINT_INDICES: ReadonlySet<number> = new Set([3, 4, 5, 6, 7, 8, 9, 10]);

/**
 * A jet (player, AI or ghost): flight physics + visual model, with render interpolation between physics steps.
 *
 * Ownership: the jet owns every geometry, material and texture of its procedural model (including the
 * camo canvas textures), its afterburner, heat haze and nav-light materials, and an optional loaded
 * glTF model. dispose() frees them all; the nav-light glow texture and three's sprite geometry are
 * shared module-level resources and are never freed. Materials swapped in by others (e.g. PuppetJet's
 * see-through clones) belong to whoever created them.
 */
export class Jet {
  readonly object = new Group();
  readonly flight: FlightModel;
  readonly parts: JetParts;
  readonly damage = new DamageModel();
  private readonly afterburner: Afterburner;
  private readonly heatHaze: HeatHaze;
  readonly lights: NavLights;
  private readonly prevPosition = new Vector3();
  private readonly prevOrientation = new Quaternion();
  private lastControls: FlightControls = { pitch: 0, roll: 0, throttle: 0 };

  gearDown = false;
  /** 0 = retracted, 1 = down. Animated toward gearDown. */
  gearDeploy = 0;
  airbrake = false;
  private airbrakeDeploy = 0;
  private readonly geometries: BufferGeometry[] = [];
  private readonly gltfAbort = new AbortController();
  private gltfModel: Object3D | null = null;
  private disposed = false;

  constructor(readonly definition: JetDefinition, config: FlightConfig, loadGltf = true) {
    this.flight = new FlightModel(config);
    this.parts = buildJetModel(definition.paint, definition.id);
    this.parts.root.traverse((o) => {
      const g = (o as Mesh).geometry;
      if (g && !this.geometries.includes(g)) this.geometries.push(g);
    });
    this.afterburner = new Afterburner(this.parts.nozzles);
    this.heatHaze = new HeatHaze(this.parts.nozzles);
    this.lights = new NavLights(this.parts.navigationLights);
    this.object.add(this.parts.root, this.afterburner.group, this.heatHaze.object, this.lights.group);
    if (loadGltf) {
      void tryLoadGltfJet(definition.id, this.parts.root, this.object, this.gltfAbort.signal).then((model) => {
        if (model && this.disposed) disposeObject3D(model);
        else this.gltfModel = model;
      });
    }
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Detaches the jet and frees the GPU resources it owns (see the class comment). Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // A model still loading is dropped (and freed) instead of being attached to a dead jet.
    this.gltfAbort.abort();
    this.object.removeFromParent();
    for (const g of this.geometries) g.dispose();
    this.geometries.length = 0;
    for (const m of this.parts.materials) m.dispose();
    for (const t of this.parts.textures) t.dispose();
    this.afterburner.dispose();
    this.heatHaze.dispose();
    this.lights.dispose();
    if (this.gltfModel) disposeObject3D(this.gltfModel);
    this.gltfModel = null;
  }

  get position(): Vector3 {
    return this.flight.state.position;
  }

  reset(spawn: SpawnState, gearDown = false): void {
    this.flight.reset(spawn);
    this.prevPosition.copy(spawn.position);
    this.prevOrientation.copy(this.flight.state.orientation);
    this.object.position.copy(spawn.position);
    this.object.quaternion.copy(this.flight.state.orientation);
    this.object.visible = true;
    this.gearDown = gearDown;
    this.gearDeploy = gearDown ? 1 : 0;
    this.airbrake = false;
    this.airbrakeDeploy = 0;
    this.damage.reset();
    this.applyModifiers();
  }

  fixedUpdate(dt: number, controls: FlightControls): void {
    this.prevPosition.copy(this.flight.state.position);
    this.prevOrientation.copy(this.flight.state.orientation);
    this.lastControls = controls;
    this.gearDeploy = moveToward(this.gearDeploy, this.gearDown ? 1 : 0, dt / 3);
    this.airbrakeDeploy = moveToward(this.airbrakeDeploy, this.airbrake ? 1 : 0, dt * 2);
    this.applyModifiers();
    this.flight.step(dt, controls);
  }

  /** Re-derive physics multipliers from damage, gear and airbrake. */
  applyModifiers(): void {
    const m = this.flight.modifiers;
    const d = this.damage;
    m.roll = d.rollFactor;
    m.pitch = d.pitchFactor;
    m.lift = d.liftFactor;
    m.thrust = d.thrustFactor;
    m.drag = 1 + this.gearDeploy * 0.7 + this.airbrakeDeploy * 2.2 + d.dragPenalty;
  }

  /** Smoothly place the visual model between the last two physics states. */
  render(alpha: number, time: number, dt: number): void {
    const s = this.flight.state;
    this.object.position.lerpVectors(this.prevPosition, s.position, alpha);
    this.object.quaternion.slerpQuaternions(this.prevOrientation, s.orientation, alpha);

    const c = this.flight.config;
    const pitch = s.pitchRate / c.maxPitchRate;
    const roll = s.rollRate / c.maxRollRate;
    const p = this.parts;
    // Leading edge down (negative rotation) pitches the nose up; differential deflection rolls.
    p.stabilizerRight.rotation.x = -pitch * 0.3 - roll * 0.2;
    p.stabilizerLeft.rotation.x = -pitch * 0.3 + roll * 0.2;
    // Aileron trailing edge down (positive rotation) lifts that wing.
    p.aileronLeft.rotation.x = roll * 0.35;
    p.aileronRight.rotation.x = -roll * 0.35;
    const flaps = this.gearDeploy * 0.45 + Math.max(0, pitch) * 0.1;
    p.flapLeft.rotation.x = flaps;
    p.flapRight.rotation.x = flaps;
    p.airbrake.rotation.x = -this.airbrakeDeploy * 0.9;
    for (const leg of p.gearLegs) {
      leg.rotation.x = (1 - this.gearDeploy) * (Math.PI / 2);
      leg.visible = this.gearDeploy > 0.02;
    }

    this.afterburner.update(s.throttle, this.flight.telemetry.afterburner, time, dt);
    this.heatHaze.update(time, s.throttle);
    this.lights.update(time);
  }

  get controls(): FlightControls {
    return this.lastControls;
  }

  /** Airframe points in world space, using the current physics state. */
  getWorldCollisionPoints(out: Vector3[]): Vector3[] {
    return this.toWorld(this.flight.state.position, this.flight.state.orientation, out);
  }

  /** Airframe points in world space, using the state before the last physics step. */
  getPreviousWorldCollisionPoints(out: Vector3[]): Vector3[] {
    return this.toWorld(this.prevPosition, this.prevOrientation, out);
  }

  private toWorld(position: Vector3, orientation: Quaternion, out: Vector3[]): Vector3[] {
    JET_COLLISION_POINTS.forEach((p, i) => {
      const v = (out[i] ??= new Vector3());
      v.copy(p).applyQuaternion(orientation).add(position);
    });
    out.length = JET_COLLISION_POINTS.length;
    return out;
  }
}

function moveToward(value: number, target: number, maxDelta: number): number {
  return value < target ? Math.min(target, value + maxDelta) : Math.max(target, value - maxDelta);
}
