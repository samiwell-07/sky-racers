import { Vector3 } from 'three';
import { GATE_CONFIG, JET_SIZE, LANDMARKS } from '../config/worldConfig';
import { LOOP_LAYOUT, loopPasses, runwayRect, valleyCenterX, type HeightField, type PassArc } from '../world/terrain/HeightField';
import type { RingShape } from '../world/rings/ringMath';

/** Course definition (gate positions on the ground plane). Heights are relative to the ground. */
export interface CourseDef {
  id: string;
  name: string;
  /** Closed loop (laps) or point-to-point sprint. */
  loop: boolean;
  defaultLaps: number;
  gates: Array<{ x: number; z: number; clearance?: number }>;
  /** Optional start point; by default 700 m before the first gate. */
  start?: { x: number; z: number };
  /** Optional medal times in seconds per lap; derived from the course length if missing. */
  medals?: { gold: number; silver: number; bronze: number };
  /** Course rules version (part of the record category); bump when the course changes meaningfully. */
  version?: number;
}

export interface ResolvedCourse {
  def: CourseDef;
  gates: RingShape[];
  start: { position: Vector3; heading: number; speed: number };
  /** Path length of one lap (m). */
  lapLength: number;
  medals: { gold: number; silver: number; bronze: number };
}

const _dir = new Vector3();

/**
 * A point `distance` m before a gate (on its approach line) at a height that clears the terrain
 * all the way to the gate. Used for race starts and respawns.
 */
export function approachPoint(gate: RingShape, direction: Vector3, distance: number, heightField: HeightField, margin = 45): Vector3 {
  const start = gate.center.clone().addScaledVector(direction, -distance);
  let y = gate.center.y;
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const x = start.x + (gate.center.x - start.x) * t;
    const z = start.z + (gate.center.z - start.z) * t;
    y = Math.max(y, heightField.getSurfaceHeight(x, z) + margin);
  }
  start.y = y;
  return start;
}

/** Places the gates on the terrain and orients each one along the course. */
export function resolveCourse(def: CourseDef, heightField: HeightField): ResolvedCourse {
  const width = JET_SIZE.span * GATE_CONFIG.widthToSpan;
  const height = JET_SIZE.height * GATE_CONFIG.heightToJetHeight;
  const n = def.gates.length;
  const points = def.gates.map((g) => new Vector3(g.x, 0, g.z));

  const gates: RingShape[] = def.gates.map((g, i) => {
    const prev = points[i - 1] ?? (def.loop ? points[n - 1]! : null);
    const next = points[i + 1] ?? (def.loop ? points[0]! : null);
    const here = points[i]!;
    _dir.set(0, 0, 0);
    if (prev) _dir.add(here.clone().sub(prev).normalize());
    if (next) _dir.add(next.clone().sub(here).normalize());
    if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, -1);
    const normal = _dir.clone().setY(0).normalize();
    const side = new Vector3(-normal.z, 0, normal.x);

    // Highest ground under the gate's footprint, so the bottom bar never sinks into a bump.
    let ground = -Infinity;
    for (const s of [-1, -0.5, 0, 0.5, 1]) {
      const p = here.clone().addScaledVector(side, (s * width) / 2);
      ground = Math.max(ground, heightField.getSurfaceHeight(p.x, p.z));
    }
    const bottom = ground + (g.clearance ?? GATE_CONFIG.groundClearance) + GATE_CONFIG.frame;
    return { center: new Vector3(g.x, bottom + height / 2, g.z), normal, width, height, frame: GATE_CONFIG.frame };
  });

  let lapLength = 0;
  for (let i = 1; i < n; i++) lapLength += gates[i]!.center.distanceTo(gates[i - 1]!.center);
  if (def.loop && n > 1) lapLength += gates[0]!.center.distanceTo(gates[n - 1]!.center);

  const first = gates[0]!;
  let approach = first.normal.clone();
  let distance = 700;
  if (def.start) {
    approach = new Vector3(first.center.x - def.start.x, 0, first.center.z - def.start.z);
    distance = approach.length();
    approach.normalize();
  }
  const heading = Math.atan2(-approach.x, -approach.z);
  const startPos = approachPoint(first, approach, distance, heightField);

  return { def, gates, start: { position: startPos, heading, speed: 165 }, lapLength, medals: medalsFor(def) };
}

/** Horizontal length (m) of one lap along the gate line (gate heights depend on the terrain). */
export function horizontalLapLength(def: Pick<CourseDef, 'gates' | 'loop'>): number {
  const g = def.gates;
  let length = 0;
  for (let i = 1; i < g.length; i++) length += Math.hypot(g[i]!.x - g[i - 1]!.x, g[i]!.z - g[i - 1]!.z);
  if (def.loop && g.length > 1) length += Math.hypot(g[0]!.x - g[g.length - 1]!.x, g[0]!.z - g[g.length - 1]!.z);
  return length;
}

/** Medal times per lap (s). Par speed ~190 m/s along the gate line (real lines are longer, so gold needs a tight line). */
export function medalsFor(def: CourseDef): { gold: number; silver: number; bronze: number } {
  if (def.medals) return def.medals;
  const par = horizontalLapLength(def) / 190;
  return { gold: par * 1.05, silver: par * 1.18, bronze: par * 1.35 };
}

/** Typical race pace (m/s) for the duration estimate: between the silver and bronze medal pace. */
const ESTIMATE_SPEED = 150;

export interface CourseSummary {
  type: 'loop' | 'sprint';
  laps: number;
  gatesPerLap: number;
  totalGates: number;
  /** Lap length (m, horizontal along the gate line). */
  lapLength: number;
  /** Distance from the start to the first gate (m). */
  startDistance: number;
  /** Total race distance (m). */
  raceLength: number;
  /** Approximate race duration (s) at a typical pace; an estimate, not a target. */
  estimatedDuration: number;
  /** Medal times for the whole race at these laps (s). */
  medals: { gold: number; silver: number; bronze: number };
}

/** Course facts for the race setup screen (no terrain needed). */
export function courseSummary(def: CourseDef, laps: number): CourseSummary {
  const n = def.loop ? Math.max(1, Math.round(laps)) : 1;
  const lapLength = horizontalLapLength(def);
  const first = def.gates[0];
  const startDistance = def.start && first ? Math.hypot(first.x - def.start.x, first.z - def.start.z) : 700;
  const raceLength = startDistance + lapLength * n;
  const m = medalsFor(def);
  return {
    type: def.loop ? 'loop' : 'sprint',
    laps: n,
    gatesPerLap: def.gates.length,
    totalGates: def.gates.length * n,
    lapLength,
    startDistance,
    raceLength,
    estimatedDuration: raceLength / ESTIMATE_SPEED,
    medals: { gold: m.gold * n, silver: m.silver * n, bronze: m.bronze * n },
  };
}

type GatePoint = CourseDef['gates'][number];

/** Gates every ~`step` m along the valley centerline; bridges get a gate 225 m before and after them. */
function valleyGates(fromZ: number, toZ: number, step: number): GatePoint[] {
  const dir = Math.sign(toZ - fromZ);
  let zs: number[] = [];
  for (let z = fromZ; dir * (toZ - z) > step * 0.4; z += dir * step) zs.push(z);
  zs.push(toZ);
  for (const a of LANDMARKS.archZ) {
    if (dir * (a - fromZ) < 0 || dir * (toZ - a) < 0) continue;
    zs = zs.filter((z) => Math.abs(z - a) > 330);
    zs.push(a - dir * 225, a + dir * 225);
  }
  zs.sort((p, q) => dir * (p - q));
  // Fill long gaps: a straight line between far-apart gates would cut into the canyon walls.
  const filled: number[] = [];
  for (const z of zs) {
    const prev = filled[filled.length - 1];
    if (prev !== undefined && Math.abs(z - prev) > step * 1.1) {
      const n = Math.ceil(Math.abs(z - prev) / step);
      for (let k = 1; k < n; k++) filled.push(prev + ((z - prev) * k) / n);
    }
    filled.push(z);
  }
  return filled.map((z) => {
    for (const p of LANDMARKS.powerLineZ) if (Math.abs(z - p) < 90) z = p - dir * 90;
    return { x: Math.round(valleyCenterX(z)), z: Math.round(z) };
  });
}

/** Gates along a mountain pass arc (exclusive of the end points). */
function passGates(arc: PassArc, count: number, reverse = false): GatePoint[] {
  const gates: GatePoint[] = [];
  for (let i = 1; i <= count; i++) {
    const f = i / (count + 1);
    const a = arc.from + (arc.to - arc.from) * (reverse ? 1 - f : f);
    gates.push({ x: Math.round(arc.cx + Math.cos(a) * arc.radius), z: Math.round(arc.cz + Math.sin(a) * arc.radius), clearance: 4 });
  }
  return gates;
}

const [southPass, northPass] = loopPasses() as [PassArc, PassArc];
/** Race start: in the air on the runway's axis, which lines up with the canyon entrance (first gate). */
const VALLEY_START = { x: Math.round(runwayRect().x), z: 3300 };

/** Built-in courses. */
export const BUILTIN_COURSES: readonly CourseDef[] = [
  {
    id: 'canyon-sprint',
    name: 'Canyon Sprint',
    loop: false,
    defaultLaps: 1,
    start: VALLEY_START,
    gates: valleyGates(2600, -3300, 600),
  },
  {
    id: 'canyon-loop',
    name: 'Canyon Loop',
    loop: true,
    defaultLaps: 2,
    start: VALLEY_START,
    gates: [
      // Down the canyon...
      ...valleyGates(LOOP_LAYOUT.north, LOOP_LAYOUT.south, 600),
      // ...through the southern pass...
      ...passGates(southPass, 5),
      // ...back north low over the hills...
      ...[-2100, -1300, -500, 300, 1100, 1900].map((z) => ({ x: Math.round(valleyCenterX(z) + LOOP_LAYOUT.returnOffset), z, clearance: 4 })),
      // ...and through the northern pass into the canyon again (arc runs from the return leg side).
      ...passGates(northPass, 5),
    ],
  },
];