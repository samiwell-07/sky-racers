import { Vector3, type Quaternion } from 'three';
import { RAD2DEG } from '../utils/math';

const forward = new Vector3();
const right = new Vector3();
const up = new Vector3();

/** Degrees: nose-up pitch, right-wing-down bank, compass heading (not ground track). */
export function flightAttitude(q: Quaternion, out: { pitch: number; bank: number; heading: number }): typeof out {
  forward.set(0, 0, -1).applyQuaternion(q);
  right.set(1, 0, 0).applyQuaternion(q);
  up.set(0, 1, 0).applyQuaternion(q);
  out.pitch = Math.asin(Math.max(-1, Math.min(1, forward.y))) * RAD2DEG;
  out.bank = Math.atan2(-right.y, up.y) * RAD2DEG;
  // Heading is undefined at vertical; keep the last valid heading through the pole.
  if (Math.hypot(forward.x, forward.z) > 1e-6) {
    out.heading = (Math.atan2(forward.x, -forward.z) * RAD2DEG + 360) % 360;
  }
  return out;
}
