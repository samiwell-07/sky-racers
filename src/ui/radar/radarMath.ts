/**
 * Pure math for the heading-up radar. World: +Y up, heading = rotation about +Y with 0 = toward -Z
 * (forward = (-sin h, 0, -cos h), right = (cos h, 0, -sin h)). Radar: origin at the centre, +x right,
 * +y DOWN (canvas convention), so straight ahead is up (negative y).
 */

/** Zoom levels (radar radius in metres), cycled by Radar.cycleRange(). */
export const RADAR_RANGES: readonly number[] = Object.freeze([2000, 5000, 10000, 20000]);
export const DEFAULT_RADAR_RANGE = 5000;
/** Jets more than this far above/below get an altitude cue (m). */
export const ALTITUDE_CUE_METERS = 150;

export interface RadarPoint {
  x: number;
  y: number;
}

/**
 * World position (x, z) relative to the player → radar pixels (written into `out`).
 * `pxPerMeter` = radar radius in px / range in metres.
 */
export function worldToRadar(selfX: number, selfZ: number, heading: number, x: number, z: number, pxPerMeter: number, out: RadarPoint): RadarPoint {
  const dx = x - selfX;
  const dz = z - selfZ;
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  const right = dx * c - dz * s;
  const ahead = -dx * s - dz * c;
  out.x = right * pxPerMeter;
  out.y = -ahead * pxPerMeter;
  return out;
}

/** Pulls a radar point back onto a circle of `radius` if it lies outside; returns true when clamped. */
export function clampToRadius(p: RadarPoint, radius: number): boolean {
  const d2 = p.x * p.x + p.y * p.y;
  if (d2 <= radius * radius) return false;
  const k = radius / Math.sqrt(d2);
  p.x *= k;
  p.y *= k;
  return true;
}

/**
 * Canvas rotation (clockwise, rad) for a symbol drawn pointing up that should show a contact flying
 * along `contactHeading`, seen from a player flying along `selfHeading`. Wrapped to (-π, π].
 */
export function relativeBearing(contactHeading: number, selfHeading: number): number {
  return wrapAngle(selfHeading - contactHeading);
}

export function wrapAngle(a: number): number {
  const t = Math.PI * 2;
  const w = a - t * Math.floor((a + Math.PI) / t);
  return w === -Math.PI ? Math.PI : w;
}

/** +1 when the contact is well above the player, -1 well below, 0 roughly level. */
export function altitudeCue(dy: number, threshold = ALTITUDE_CUE_METERS): -1 | 0 | 1 {
  return dy > threshold ? 1 : dy < -threshold ? -1 : 0;
}

export interface RadarCircle extends RadarPoint {
  r: number;
}

/** A world circle (cx, cz, radius) → radar circle in px (rotation keeps it a circle). */
export function circleToRadar(selfX: number, selfZ: number, heading: number, cx: number, cz: number, radius: number, pxPerMeter: number, out: RadarCircle): RadarCircle {
  worldToRadar(selfX, selfZ, heading, cx, cz, pxPerMeter, out);
  out.r = radius * pxPerMeter;
  return out;
}

export type ZoneStatus = 'inside' | 'near' | 'outside';

/** Where the player is relative to a circular zone; 'near' within `margin` m of the edge. */
export function zoneStatus(x: number, z: number, cx: number, cz: number, radius: number, margin = Math.min(600, radius * 0.2)): ZoneStatus {
  const d = Math.hypot(x - cx, z - cz);
  if (d > radius) return 'outside';
  return d > radius - margin ? 'near' : 'inside';
}

/** Index of the zoom level closest to `meters`. */
export function rangeIndexFor(meters: number): number {
  let best = 0;
  for (let i = 1; i < RADAR_RANGES.length; i++) {
    if (Math.abs(RADAR_RANGES[i]! - meters) < Math.abs(RADAR_RANGES[best]! - meters)) best = i;
  }
  return best;
}

/** Nearest valid zoom level for any number (used to sanitise stored settings). */
export function snapRadarRange(meters: number): number {
  return RADAR_RANGES[rangeIndexFor(meters)]!;
}

/** Next zoom level (wraps from the widest back to the closest). */
export function nextRadarRange(meters: number): number {
  return RADAR_RANGES[(rangeIndexFor(meters) + 1) % RADAR_RANGES.length]!;
}

export function rangeLabel(meters: number): string {
  return meters >= 1000 ? `${+(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

/** Heading (about +Y, 0 = -Z) of a body whose local forward is -Z, from its quaternion. */
export function headingFromQuaternion(q: { x: number; y: number; z: number; w: number }): number {
  return Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y));
}

/** Heading of a horizontal direction / velocity (x, z); 0 when it is (almost) zero. */
export function headingFromDirection(x: number, z: number): number {
  return x * x + z * z < 1e-9 ? 0 : Math.atan2(-x, -z);
}
