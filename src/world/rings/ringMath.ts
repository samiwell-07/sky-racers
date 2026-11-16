import { Vector3 } from 'three';

/** Holographic rectangular gate (not solid). The opening is width x height. */
export interface RingShape {
  center: Vector3;
  /** Unit horizontal normal pointing in the direction the gate must be flown through. */
  normal: Vector3;
  /** Inner opening width (m). */
  width: number;
  /** Inner opening height (m). */
  height: number;
  /** Visual thickness of the glowing frame (m). */
  frame: number;
}

const _seg = new Vector3();
const _hit = new Vector3();
const _d = new Vector3();
const _side = new Vector3();
const UP = new Vector3(0, 1, 0);

/** Gate-local coordinates of a point: u = sideways, v = up, n = along the normal. */
function toLocal(point: Vector3, gate: RingShape): { u: number; v: number; n: number } {
  _d.subVectors(point, gate.center);
  _side.crossVectors(UP, gate.normal).normalize();
  return { u: _d.dot(_side), v: _d.y, n: _d.dot(gate.normal) };
}

/** True if the segment from -> to crosses the gate's rectangle (opening or frame) in the forward direction. */
export function segmentPassesRing(from: Vector3, to: Vector3, gate: RingShape): boolean {
  return classifyCrossing(from, to, gate, 0) === 'inside';
}

/**
 * Classifies a forward crossing of the gate's plane: 'inside' the rectangle (frame included),
 * 'outside' it but within `missRadius` meters of it (a missed gate), or null (no crossing).
 * If `out` is given, `out.t` receives where along from -> to (0..1) the plane was crossed.
 */
export function classifyCrossing(from: Vector3, to: Vector3, gate: RingShape, missRadius: number, out?: { t: number }): 'inside' | 'outside' | null {
  const d0 = _d.subVectors(from, gate.center).dot(gate.normal);
  const d1 = _d.subVectors(to, gate.center).dot(gate.normal);
  if (!(d0 < 0 && d1 >= 0)) return null;
  const t = d0 / (d0 - d1);
  if (out) out.t = t;
  _hit.copy(from).addScaledVector(_seg.subVectors(to, from), t);
  const { u, v } = toLocal(_hit, gate);
  const ou = Math.abs(u) - gate.width / 2 - gate.frame;
  const ov = Math.abs(v) - gate.height / 2 - gate.frame;
  if (ou <= 0 && ov <= 0) return 'inside';
  return Math.hypot(Math.max(ou, 0), Math.max(ov, 0)) <= missRadius ? 'outside' : null;
}
