import { Quaternion, Vector3 } from 'three';
import type { FlightConfig } from '../config/flightConfig';
import { clamp, dampFactor } from '../utils/math';
import { controlAuthority, liftCoefficient, limitPitchRate } from './aerodynamics';
import {
  createFlightState,
  createTelemetry,
  type FlightControls,
  type FlightState,
  type FlightTelemetry,
} from './types';

export interface SpawnState {
  position: Vector3;
  orientation: Quaternion;
  speed: number;
  throttle: number;
}

const MIN_AERO_SPEED = 8;
/** Lever mode: the throttle moves toward the lever position at this multiple of config.throttleRate. */
export const LEVER_FOLLOW_RATE_SCALE = 2;
const _air = new Vector3();
const _fwd = new Vector3();
const _up = new Vector3();
const _right = new Vector3();
const _vDir = new Vector3();
const _liftDir = new Vector3();
const _accel = new Vector3();
const _tmp = new Vector3();
const _omega = new Vector3();
const _dq = new Quaternion();

/**
 * Semi-realistic jet flight model, independent from rendering.
 *
 * - The stick commands pitch and roll rates (fly-by-wire style); there is no yaw control.
 * - Turning happens by banking: the lift vector tilts and curves the flight path,
 *   and passive directional stability swings the nose to follow it.
 * - Lift depends on speed² and angle of attack; past the stall angle lift collapses and the nose drops.
 */
export class FlightModel {
  readonly state: FlightState = createFlightState();
  readonly telemetry: FlightTelemetry = createTelemetry();
  /** Performance multipliers (damage, airbrake, landing gear...). 1 = nominal. */
  readonly modifiers = { thrust: 1, lift: 1, drag: 1, roll: 1, pitch: 1 };
  /** Air mass motion: steady wind (m/s) and random gust acceleration (m/s²) set by the weather. */
  readonly wind = new Vector3();
  readonly gust = new Vector3();
  /** Small angular disturbances from turbulence (rad/s). */
  readonly turbulenceRates = { pitch: 0, roll: 0 };

  constructor(public config: FlightConfig) {}

  reset(spawn: SpawnState): void {
    const s = this.state;
    s.position.copy(spawn.position);
    s.orientation.copy(spawn.orientation).normalize();
    s.velocity.set(0, 0, -1).applyQuaternion(s.orientation).multiplyScalar(spawn.speed);
    s.pitchRate = 0;
    s.rollRate = 0;
    s.throttle = clamp(spawn.throttle, 0, 1);
    this.updateTelemetry(0, 1, false);
  }

  /** Body axes in world space. */
  getAxes(forward: Vector3, up: Vector3, right: Vector3): void {
    const q = this.state.orientation;
    forward.set(0, 0, -1).applyQuaternion(q);
    up.set(0, 1, 0).applyQuaternion(q);
    right.set(1, 0, 0).applyQuaternion(q);
  }

  step(dt: number, controls: FlightControls): void {
    const s = this.state;
    const c = this.config;
    const m = this.modifiers;

    const lever = controls.throttleLever;
    if (lever != null && Number.isFinite(lever)) {
      // A physical lever is followed at twice the keyboard rate: responsive, but the engine still
      // spools instead of jumping instantly (also smooths noisy axes and reconnections).
      const step = c.throttleRate * LEVER_FOLLOW_RATE_SCALE * dt;
      s.throttle = clamp(s.throttle + clamp(clamp(lever, 0, 1) - s.throttle, -step, step), 0, 1);
    } else {
      s.throttle = clamp(s.throttle + clamp(controls.throttle, -1, 1) * c.throttleRate * dt, 0, 1);
    }

    this.getAxes(_fwd, _up, _right);
    // Aerodynamics use the airspeed (velocity relative to the moving air mass).
    _air.copy(s.velocity).sub(this.wind);
    const speed = _air.length();
    const vF = _air.dot(_fwd);
    const vU = _air.dot(_up);
    const vR = _air.dot(_right);
    // Angles only mean something with real airflow; parked in a light crosswind the airflow is
    // sideways and must not read as a 90° stall.
    const flowing = speed > MIN_AERO_SPEED;
    const aoa = flowing ? Math.atan2(-vU, vF) : 0;
    const sideslip = flowing ? Math.atan2(vR, vF) : 0;
    const stalled = Math.abs(aoa) > c.stallAngle;
    /** Aerodynamic moments scale with dynamic pressure. */
    const moment = clamp(speed / c.fullControlSpeed, 0, 1);

    // ---- Forces (as accelerations) ----
    _accel.set(0, -c.gravity, 0);
    _accel.addScaledVector(_fwd, s.throttle * c.maxThrust * m.thrust);

    const cl = liftCoefficient(aoa, c);
    if (speed > 1) {
      _vDir.copy(_air).divideScalar(speed);

      // Lift is perpendicular to the flight path, in the plane of the jet's up axis.
      _liftDir.copy(_up).addScaledVector(_vDir, -_up.dot(_vDir));
      if (_liftDir.lengthSq() > 1e-8) {
        _liftDir.normalize();
        const maxLift = c.maxG * c.gravity;
        const lift = clamp(c.liftCoefficient * m.lift * speed * speed * cl, -maxLift, maxLift);
        _accel.addScaledVector(_liftDir, lift);
      }

      const drag = (c.dragCoefficient * m.drag + c.inducedDrag * cl * cl) * speed * speed;
      _accel.addScaledVector(_vDir, -drag);

      _accel.addScaledVector(_right, -vR * c.sideForce);
    }
    _accel.add(this.gust);

    // Load factor = non-gravitational acceleration along the jet's up axis.
    _tmp.copy(_accel).y += c.gravity;
    const gLoad = _tmp.dot(_up) / c.gravity;

    s.velocity.addScaledVector(_accel, dt);
    s.position.addScaledVector(s.velocity, dt);

    // ---- Rotation ----
    const authority = controlAuthority(speed, c);
    const response = dampFactor(c.rateResponse, dt);
    s.pitchRate += (clamp(controls.pitch, -1, 1) * c.maxPitchRate * m.pitch * authority - s.pitchRate) * response;
    s.pitchRate = limitPitchRate(s.pitchRate, aoa, c);
    s.rollRate += (clamp(controls.roll, -1, 1) * c.maxRollRate * m.roll * authority - s.rollRate) * response;

    let pitchRate = s.pitchRate + this.turbulenceRates.pitch;
    if (stalled) {
      // Past the stall the nose is pushed back toward the flight path (an aerodynamic moment).
      pitchRate -= Math.sign(aoa) * (Math.abs(aoa) - c.stallAngle + 0.05) * c.stallPitchDown * Math.max(moment, 0.3);
    }
    // Passive weathervane (not player yaw): swings the nose toward the flight path. Fades out at
    // very low airspeed, where the fin has almost no aerodynamic force.
    const yawRate = -sideslip * c.directionalStability * moment;

    // Body angular velocity: X = pitch (nose up +), Y = yaw (nose left +), Z = roll (right wing up +).
    _omega.set(pitchRate, yawRate, -(s.rollRate + this.turbulenceRates.roll));
    const angle = _omega.length() * dt;
    if (angle > 1e-9) {
      _dq.setFromAxisAngle(_omega.normalize(), angle);
      s.orientation.multiply(_dq).normalize();
    }

    this.updateTelemetry(aoa, gLoad, stalled, sideslip);
  }

  private updateTelemetry(aoa: number, gLoad: number, stalled: boolean, sideslip = 0): void {
    const t = this.telemetry;
    const c = this.config;
    t.speed = this.state.velocity.length();
    t.aoa = aoa;
    t.sideslip = sideslip;
    t.gLoad = gLoad;
    t.stalled = stalled;
    t.stallWarning = stalled || Math.abs(aoa) > c.stallAngle * 0.96 || t.speed < c.stallWarningSpeed;
    t.afterburner = this.state.throttle >= c.afterburnerThreshold;
  }
}
