import { Vector3, type Quaternion } from 'three';

/** Gravity (m/s²) used by rounds, missiles and flares. */
export const GRAVITY = 9.81;

const _rel0 = new Vector3();
const _rel1 = new Vector3();
const _d = new Vector3();
const _a = new Vector3();
const _b = new Vector3();

/**
 * Earliest fraction t in [0,1] at which a point moving p0 → p1 comes within `radius` of a sphere
 * centre moving c0 → c1 over the same interval (both linear), or null. Solved in the target's
 * frame so fast closing speeds can't tunnel through.
 */
export function segmentSphereHit(p0: Vector3, p1: Vector3, c0: Vector3, c1: Vector3, radius: number): number | null {
  const r0 = _rel0.subVectors(p0, c0);
  const r1 = _rel1.subVectors(p1, c1);
  const d = _d.subVectors(r1, r0);
  const r2 = radius * radius;
  const c = r0.lengthSq() - r2;
  if (c <= 0) return 0;
  const a = d.lengthSq();
  if (a < 1e-12) return null;
  const b = r0.dot(d);
  if (b >= 0) return null;
  const disc = b * b - a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / a;
  return t <= 1 ? t : null;
}

/** Closest distance between two linearly moving points over one step (positions at start and end). */
export function closestApproach(p0: Vector3, p1: Vector3, c0: Vector3, c1: Vector3): { distance: number; t: number } {
  const r0 = _rel0.subVectors(p0, c0);
  const d = _d.subVectors(_rel1.subVectors(p1, c1), r0);
  const a = d.lengthSq();
  const t = a < 1e-12 ? 0 : Math.min(1, Math.max(0, -r0.dot(d) / a));
  return { distance: _a.copy(r0).addScaledVector(d, t).length(), t };
}

/** Angle (rad) between direction `dir` (need not be normalized) and the line from `from` to `to`. */
export function offBoresight(from: Vector3, dir: Vector3, to: Vector3): number {
  const los = _a.subVectors(to, from);
  const l = los.length() * dir.length();
  if (l < 1e-9) return 0;
  return Math.acos(Math.min(1, Math.max(-1, los.dot(dir) / l)));
}

/** World-space point at a body-frame offset (forward = -Z, up = +Y, right = +X). */
export function localToWorld(position: Vector3, orientation: Quaternion, local: Vector3, out = new Vector3()): Vector3 {
  return out.copy(local).applyQuaternion(orientation).add(position);
}

/** Body forward (-Z) as a world unit vector. */
export function forwardOf(orientation: Quaternion, out = new Vector3()): Vector3 {
  return out.set(0, 0, -1).applyQuaternion(orientation);
}

export type V3 = [number, number, number];
export const toV3 = (v: Vector3): V3 => [round2(v.x), round2(v.y), round2(v.z)];
export const fromV3 = (a: readonly number[], out = new Vector3()): Vector3 => out.set(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0);
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Unit vector of a random direction within `halfAngle` of `dir` (unit), from rng in [0,1). */
export function jitterDirection(dir: Vector3, halfAngle: number, rng: () => number, out = new Vector3()): Vector3 {
  if (halfAngle <= 0) return out.copy(dir);
  const helper = Math.abs(dir.y) < 0.9 ? _b.set(0, 1, 0) : _b.set(1, 0, 0);
  const u = _a.crossVectors(dir, helper).normalize();
  const v = helper.crossVectors(dir, u).normalize();
  const ang = halfAngle * Math.sqrt(rng());
  const phi = rng() * Math.PI * 2;
  const s = Math.sin(ang);
  return out
    .copy(dir)
    .multiplyScalar(Math.cos(ang))
    .addScaledVector(u, s * Math.cos(phi))
    .addScaledVector(v, s * Math.sin(phi))
    .normalize();
}
