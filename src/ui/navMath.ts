/** Pure math for the gate navigator: course sequencing, turn cues and screen placement. */

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface GateSequence {
  next: number;
  /** The gate after `next`, or null when `next` is the last gate of the race. */
  after: number | null;
  /** The gate flown through before `next` (null at the very start). */
  prev: number | null;
  final: boolean;
  /** `after` is the first gate of the next lap. */
  lapWrap: boolean;
}

export function gateSequence(gateCount: number, gateIndex: number, lap: number, laps: number, loop: boolean): GateSequence {
  const next = Math.min(Math.max(gateIndex, 0), gateCount - 1);
  const prev = next > 0 ? next - 1 : loop && lap > 1 ? gateCount - 1 : null;
  const lastOfLap = next === gateCount - 1;
  const after = !lastOfLap ? next + 1 : loop && lap < laps ? 0 : null;
  return { next, after, prev, final: after === null, lapWrap: lastOfLap && after === 0 };
}

export type TurnKind = 'left' | 'right' | 'climb' | 'descend' | 'straight';

export interface TurnCue {
  kind: TurnKind;
  /** Horizontal turn at the gate (degrees, positive = right). */
  turn: number;
  /** Change of flight-path angle at the gate (degrees, positive = climb). */
  climb: number;
}

const RAD2DEG = 180 / Math.PI;
export const TURN_THRESHOLD = 12;
export const CLIMB_THRESHOLD = 4;

/** Turn needed at `gate` to head for `after`, given the approach from `from` (three.js axes: y up, -z forward). */
export function nextTurnCue(from: Vec3Like, gate: Vec3Like, after: Vec3Like): TurnCue {
  const ax = gate.x - from.x;
  const ay = gate.y - from.y;
  const az = gate.z - from.z;
  const bx = after.x - gate.x;
  const by = after.y - gate.y;
  const bz = after.z - gate.z;
  // Right of a heading (x, z) is (-z, x); cross.y < 0 means a right turn.
  const cross = az * bx - ax * bz;
  const dot = ax * bx + az * bz;
  const turn = Math.atan2(-cross, dot) * RAD2DEG;
  const climb = (Math.atan2(by, Math.hypot(bx, bz)) - Math.atan2(ay, Math.hypot(ax, az))) * RAD2DEG;
  let kind: TurnKind = 'straight';
  if (Math.abs(turn) >= TURN_THRESHOLD) kind = turn > 0 ? 'right' : 'left';
  else if (Math.abs(climb) >= CLIMB_THRESHOLD) kind = climb > 0 ? 'climb' : 'descend';
  return { kind, turn, climb };
}

export function formatTurnCue(cue: TurnCue): string {
  const deg = Math.round(Math.abs(cue.turn) / 5) * 5;
  const vertical = Math.abs(cue.climb) >= CLIMB_THRESHOLD ? (cue.climb > 0 ? ' ▲' : ' ▼') : '';
  switch (cue.kind) {
    case 'left':
      return `NEXT ◀ LEFT ${deg}°${vertical}`;
    case 'right':
      return `NEXT RIGHT ${deg}° ▶${vertical}`;
    case 'climb':
      return 'NEXT ▲ CLIMB';
    case 'descend':
      return 'NEXT ▼ DESCEND';
    default:
      return 'NEXT STRAIGHT';
  }
}

/** Indicator size; `anchorY` is where the icon center sits from the box top. */
export interface IndicatorBox {
  w: number;
  h: number;
  anchorY: number;
}

export type Placement =
  | { kind: 'onscreen'; x: number; y: number }
  /** `angle` in screen radians (0 = right, +y = down). */
  | { kind: 'edge'; x: number; y: number; angle: number }
  /** Behind the camera: pinned to the bottom edge; `side` = shortest turn direction. */
  | { kind: 'behind'; x: number; y: number; side: -1 | 1 };

export interface ScreenSpec {
  width: number;
  height: number;
  /** Area the indicator box must stay inside. */
  safe: Rect;
  obstacles: readonly Rect[];
}

/**
 * Places the gate indicator. `view` is the gate center in camera space (-z forward);
 * `sx`, `sy` are the projection's x/y scale (projectionMatrix elements 0 and 5).
 */
export function placeIndicator(view: Vec3Like, sx: number, sy: number, screen: ScreenSpec, box: IndicatorBox): Placement {
  const { width: W, height: H } = screen;
  const track = trackRect(screen.safe, box);
  const forward = -view.z;
  if (forward <= 0) {
    // Behind the camera plane: the screen projection would be mirrored, so never point through it.
    const side: -1 | 1 = view.x < 0 ? -1 : 1;
    const x = clampNum(W / 2 + side * Math.min(W * 0.12, (track.right - track.left) / 2), track.left, track.right);
    const p = avoid({ x, y: track.bottom }, track, box, screen.obstacles);
    return { kind: 'behind', x: p.x, y: p.y, side };
  }
  const px = ((sx * view.x) / forward + 1) * 0.5 * W;
  const py = (1 - (sy * view.y) / forward) * 0.5 * H;
  if (px >= track.left && px <= track.right && py >= track.top && py <= track.bottom && !hits(px, py, box, screen.obstacles)) {
    return { kind: 'onscreen', x: px, y: py };
  }
  const dx = sx * view.x * W;
  const dy = -sy * view.y * H;
  const p = avoid(rayToRect(W / 2, H / 2, dx, dy, track), track, box, screen.obstacles);
  return { kind: 'edge', x: p.x, y: p.y, angle: Math.atan2(py - p.y, px - p.x) };
}

/** Rectangle the anchor point may move in so the whole box stays inside `safe`. */
export function trackRect(safe: Rect, box: IndicatorBox): Rect {
  const left = safe.left + box.w / 2;
  const right = Math.max(left, safe.right - box.w / 2);
  const top = safe.top + box.anchorY;
  const bottom = Math.max(top, safe.bottom - (box.h - box.anchorY));
  return { left, top, right, bottom };
}

/** Where a ray from (cx, cy) along (dx, dy) leaves `r` ((cx, cy) clamped into `r` first). */
export function rayToRect(cx: number, cy: number, dx: number, dy: number, r: Rect): { x: number; y: number } {
  const x0 = clampNum(cx, r.left, r.right);
  const y0 = clampNum(cy, r.top, r.bottom);
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return { x: x0, y: r.top };
  let t = Infinity;
  if (dx > 0) t = Math.min(t, (r.right - x0) / dx);
  else if (dx < 0) t = Math.min(t, (r.left - x0) / dx);
  if (dy > 0) t = Math.min(t, (r.bottom - y0) / dy);
  else if (dy < 0) t = Math.min(t, (r.top - y0) / dy);
  return { x: clampNum(x0 + dx * t, r.left, r.right), y: clampNum(y0 + dy * t, r.top, r.bottom) };
}

function boxAt(x: number, y: number, box: IndicatorBox): Rect {
  return { left: x - box.w / 2, top: y - box.anchorY, right: x + box.w / 2, bottom: y - box.anchorY + box.h };
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function hits(x: number, y: number, box: IndicatorBox, obstacles: readonly Rect[]): boolean {
  const b = boxAt(x, y, box);
  return obstacles.some((o) => overlaps(b, o));
}

/** Slides a point on the track's perimeter to the nearest spot where the box clears every obstacle. */
export function avoid(p: { x: number; y: number }, track: Rect, box: IndicatorBox, obstacles: readonly Rect[]): { x: number; y: number } {
  if (!hits(p.x, p.y, box, obstacles)) return p;
  const w = track.right - track.left;
  const h = track.bottom - track.top;
  const perimeter = 2 * (w + h);
  if (perimeter <= 0) return p;
  const s0 = perimeterOf(p, track);
  const step = 4;
  for (let d = step; d <= perimeter / 2; d += step) {
    for (const s of [s0 + d, s0 - d]) {
      const q = pointAt(s, track);
      if (!hits(q.x, q.y, box, obstacles)) return q;
    }
  }
  return p;
}

/** Clockwise distance along the perimeter, starting at the top-left corner. */
function perimeterOf(p: { x: number; y: number }, r: Rect): number {
  const w = r.right - r.left;
  const h = r.bottom - r.top;
  const d = [Math.abs(p.y - r.top), Math.abs(p.x - r.right), Math.abs(p.y - r.bottom), Math.abs(p.x - r.left)];
  const edge = d.indexOf(Math.min(...d));
  if (edge === 0) return clampNum(p.x - r.left, 0, w);
  if (edge === 1) return w + clampNum(p.y - r.top, 0, h);
  if (edge === 2) return w + h + clampNum(r.right - p.x, 0, w);
  return 2 * w + h + clampNum(r.bottom - p.y, 0, h);
}

function pointAt(s: number, r: Rect): { x: number; y: number } {
  const w = r.right - r.left;
  const h = r.bottom - r.top;
  const per = 2 * (w + h);
  s = ((s % per) + per) % per;
  if (s <= w) return { x: r.left + s, y: r.top };
  s -= w;
  if (s <= h) return { x: r.right, y: r.top + s };
  s -= h;
  if (s <= w) return { x: r.right - s, y: r.bottom };
  s -= w;
  return { x: r.left, y: r.bottom - s };
}

function clampNum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
