import { Euler, Quaternion, Vector3 } from 'three';
import type { Jet } from '../entities/jet/Jet';
import { GEAR_HEIGHT } from '../entities/jet/JetModel';
import { distanceToRunway, type HeightField } from '../world/terrain/HeightField';
import { dampFactor } from '../utils/math';

const _euler = new Euler(0, 0, 0, 'YXZ');
const _q = new Quaternion();
const _fwd = new Vector3();

export type GroundEvent = 'none' | 'rolling' | 'touchdown' | 'hardLanding';

/**
 * Wheels-on-runway physics: with the gear down over the runway the jet can sit, taxi, take off
 * and land. Roll input steers the nose wheel; zero throttle applies the brakes.
 */
export class GroundHandling {
  private onGround = false;
  /** Heading held by the wheels while on the ground (null = not yet captured). */
  private yaw: number | null = null;

  constructor(private readonly heightField: HeightField) {}

  get grounded(): boolean {
    return this.onGround;
  }

  /** @param yaw heading to hold when starting on the ground (the spawn heading). */
  reset(onGround: boolean, yaw: number | null = null): void {
    this.onGround = onGround;
    this.yaw = onGround ? yaw : null;
  }

  isOverRunway(position: Vector3): boolean {
    return distanceToRunway(position.x, position.z, this.heightField.runway, 5) === 0;
  }

  /** Call after each physics step. */
  update(jet: Jet, dt: number): GroundEvent {
    const s = jet.flight.state;
    const fullyDown = jet.gearDeploy > 0.98;
    if (!fullyDown || !this.isOverRunway(s.position)) {
      this.onGround = false;
      this.yaw = null;
      return 'none';
    }
    const groundY = this.heightField.runway.height;
    const wheelsY = s.position.y - GEAR_HEIGHT;
    if (wheelsY > groundY + 0.05) {
      this.onGround = false;
      this.yaw = null;
      return 'none';
    }

    let event: GroundEvent = 'rolling';
    if (!this.onGround) event = s.velocity.y < -7 ? 'hardLanding' : 'touchdown';
    this.onGround = true;

    s.position.y = groundY + GEAR_HEIGHT;
    if (s.velocity.y < 0) s.velocity.y = 0;

    _euler.setFromQuaternion(s.orientation, 'YXZ');
    // The tyres hold the heading: wind can't weathervane a jet sitting on its wheels.
    this.yaw ??= _euler.y;
    const speed = Math.hypot(s.velocity.x, s.velocity.z);
    // Nose-wheel steering (needs the jet to be rolling).
    if (speed > 1) this.yaw -= jet.controls.roll * 0.35 * Math.min(1, speed / 25) * dt;
    _euler.y = this.yaw;
    _euler.z += (0 - _euler.z) * dampFactor(10, dt); // wings level
    // The nose wheel keeps the jet level until it is fast enough to rotate for takeoff.
    _euler.x = speed < 40 ? 0 : Math.max(0, _euler.x);
    s.orientation.setFromEuler(_euler);
    s.rollRate = 0;
    if (speed < 40 || (_euler.x <= 0 && s.pitchRate < 0)) s.pitchRate = 0;

    // Keep the ground velocity aligned with the nose (tyres don't slide sideways).
    _fwd.set(0, 0, -1).applyQuaternion(_q.setFromEuler(new Euler(0, _euler.y, 0)));
    const along = s.velocity.x * _fwd.x + s.velocity.z * _fwd.z;
    const brake = s.throttle < 0.02 ? 6 : 0.4;
    const newAlong = Math.max(0, along - brake * dt);
    s.velocity.x = _fwd.x * newAlong;
    s.velocity.z = _fwd.z * newAlong;
    jet.flight.telemetry.gLoad = 1;
    jet.flight.telemetry.aoa = 0;
    return event;
  }
}
