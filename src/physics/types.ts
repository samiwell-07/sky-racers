import { Quaternion, Vector3 } from 'three';

/** Pilot inputs, each in [-1, 1]. There is deliberately no yaw input. */
export interface FlightControls {
  /** +1 = nose up, -1 = nose down. */
  pitch: number;
  /** +1 = roll right, -1 = roll left. */
  roll: number;
  /** +1 = push throttle forward, -1 = pull back. */
  throttle: number;
  /**
   * Absolute throttle lever position 0..1 (HOTAS lever mode). When set, the throttle follows it
   * and the rate input `throttle` is ignored; null/undefined = rate control.
   */
  throttleLever?: number | null;
}

export interface FlightState {
  position: Vector3;
  velocity: Vector3;
  /** Body frame: forward = -Z, up = +Y, right = +X. */
  orientation: Quaternion;
  /** Current body pitch rate (rad/s), positive = nose up. */
  pitchRate: number;
  /** Current body roll rate (rad/s), positive = roll right. */
  rollRate: number;
  /** 0..1 */
  throttle: number;
}

export interface FlightTelemetry {
  speed: number;
  /** Angle of attack (rad). */
  aoa: number;
  /** Sideslip angle (rad). */
  sideslip: number;
  /** Load factor felt by the pilot (1 = level flight). */
  gLoad: number;
  stalled: boolean;
  stallWarning: boolean;
  afterburner: boolean;
}

export const createFlightState = (): FlightState => ({
  position: new Vector3(),
  velocity: new Vector3(),
  orientation: new Quaternion(),
  pitchRate: 0,
  rollRate: 0,
  throttle: 0,
});

export const createTelemetry = (): FlightTelemetry => ({
  speed: 0,
  aoa: 0,
  sideslip: 0,
  gLoad: 1,
  stalled: false,
  stallWarning: false,
  afterburner: false,
});
