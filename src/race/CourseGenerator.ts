import type { CourseDef } from './Course';
import { generatedCourseId, parseGeneratedCourseId, RACE_DIFFICULTIES, type CourseRequest, type RaceDifficulty, type RaceLayout } from './generatedCourse';
import { GATE_CENTER_OFFSET, GATE_HEIGHT, GATE_WIDTH, TerrainProbe, gateNormals, turnLoad, turnLoads, type Point2 } from './gen/courseGeometry';
import { createWorld } from '../world/gen/createWorld';
import type { Biome, BridgeSite, WorldGenerator, WorldSpec } from '../world/gen/WorldGenerator';
import { GATE_CONFIG } from '../config/worldConfig';
import { mulberry32 } from '../utils/random';
import { subSeed } from '../utils/seed';

/**
 * Procedural race courses for any world (seeded or Classic). Deterministic: the same world, seed,
 * difficulty and layout always give the same gates (seeded PRNG, fixed iteration order).
 * Candidate routes are steered through valleys, rivers, passes and cities, repaired so every leg
 * clears the terrain, rejected when unflyable (turn load, slope, clearance) and scored for
 * challenge; a high safe circuit/line is the fallback so generation never fails.
 */

export interface DifficultyParams {
  /** Gate count range (inclusive). */
  gates: readonly [number, number];
  /** Nominal gate spacing (m) of a sprint, and of a loop (shorter laps = tighter circuits). */
  spacing: number;
  loopSpacing: number;
  /** Max load factor (g) through any three gates at RACE_SPEED. */
  maxG: number;
  /** Max lateral offset (m) of a gate from the base path. */
  wander: number;
  /** Gate clearance range above the ground (m), before repairs. */
  clearance: readonly [number, number];
  /** Minimum height (m) of the straight line between gates above any obstacle. */
  margin: number;
  /** Max climb gradient between gates. */
  maxSlope: number;
  /** Max descent gradient between gates (the AI and players dive late). */
  maxDescent: number;
  /** Max change of gradient at a gate (sharp dips/crests between legs are missed vertically). */
  maxGradeChange: number;
  /** Same at a crest (level or climbing, then diving): pilots push over late, so it is stricter. */
  maxCrest: number;
  /** Clearance cap (m); routes needing more are rejected. */
  maxClearance: number;
}

export const DIFFICULTY_PARAMS: Readonly<Record<RaceDifficulty, DifficultyParams>> = Object.freeze({
  easy: { gates: [8, 10], spacing: 1100, loopSpacing: 1200, maxG: 3.5, wander: 260, clearance: [45, 90], margin: 40, maxSlope: 0.12, maxDescent: 0.06, maxGradeChange: 0.06, maxCrest: 0.035, maxClearance: 320 },
  medium: { gates: [12, 14], spacing: 760, loopSpacing: 700, maxG: 5, wander: 420, clearance: [14, 60], margin: 28, maxSlope: 0.16, maxDescent: 0.07, maxGradeChange: 0.08, maxCrest: 0.045, maxClearance: 300 },
  hard: { gates: [16, 20], spacing: 580, loopSpacing: 480, maxG: 6, wander: 520, clearance: [10, 50], margin: 20, maxSlope: 0.2, maxDescent: 0.08, maxGradeChange: 0.1, maxCrest: 0.055, maxClearance: 280 },
});

/** Speed (m/s) used to turn gate curvature into a load factor. */
export const RACE_SPEED = 200;
const CANDIDATES = 36;
/** Distance from the start (air spawn) to the first gate of a sprint (m). */
const SPRINT_LEAD = 800;
/** Distance from the start to the first gate of a loop; the last gate sits as far before the start. */
const LOOP_LEAD = 600;
/** Cities/bridges further than this from the start are ignored (courses stay well inside). */
const QUERY_RADIUS = 14000;

export interface CourseStats {
  /** Generator score of the chosen route (higher = more challenging/interesting). */
  score: number;
  /** True when no candidate was flyable and the safe fallback was used. */
  fallback: boolean;
  candidatesTried: number;
  candidatesFlyable: number;
  maxLoad: number;
  meanLoad: number;
  /** Mean of the hardest third of the turns (g): how demanding the course is at its tightest. */
  peakLoad: number;
  /** Gate center heights (m), estimated from the world (resolveCourse uses the rendered grid). */
  gateHeights: number[];
  altitudeStdDev: number;
  theme: string;
}

export interface GeneratedCourse {
  def: CourseDef;
  stats: CourseStats;
  request: CourseRequest;
  seed: number;
}

/** Default course seed of a world: the world seed (Classic uses a fixed constant). */
export function defaultCourseSeed(spec: WorldSpec): number {
  return spec.kind === 'seeded' ? spec.seed >>> 0 : 0x5ca1ab1e;
}

interface WorldContext {
  probe: TerrainProbe;
  cache: Map<string, GeneratedCourse>;
}
const contexts = new WeakMap<WorldGenerator, WorldContext>();

function contextFor(world: WorldGenerator): WorldContext {
  let ctx = contexts.get(world);
  if (!ctx) {
    const s = world.airSpawn;
    const cities = [...world.citiesNear(s.x, s.z, QUERY_RADIUS)];
    const bridges = [...world.bridgesNear(s.x, s.z, QUERY_RADIUS)];
    ctx = { probe: new TerrainProbe(world, cities, bridges), cache: new Map() };
    contexts.set(world, ctx);
  }
  return ctx;
}

/** The course for (world, seed, difficulty, layout); cached per id and seed. */
export function generateCourse(world: WorldGenerator, seed: number, difficulty: RaceDifficulty, layout: RaceLayout): CourseDef {
  return generateCourseDetailed(world, seed, difficulty, layout).def;
}

export function generateCourseDetailed(world: WorldGenerator, seed: number, difficulty: RaceDifficulty, layout: RaceLayout): GeneratedCourse {
  const ctx = contextFor(world);
  const request: CourseRequest = { world: world.spec, difficulty, layout };
  const id = generatedCourseId(request);
  const key = `${id}#${seed >>> 0}`;
  let result = ctx.cache.get(key);
  if (!result) {
    result = build(world, ctx.probe, seed >>> 0, request, id);
    ctx.cache.set(key, result);
  }
  return result;
}

/** The course for a lobby/menu request (`lobbyRaceCourse(settings).request`), on its world's default seed. */
export function generateCourseForRequest(request: CourseRequest): CourseDef {
  return generateCourse(createWorld(request.world), defaultCourseSeed(request.world), request.difficulty, request.layout);
}

/** The generated course for a `gen:...` id (null if the id is not a generated course id). */
export function generatedCourseById(id: string): CourseDef | null {
  const req = parseGeneratedCourseId(id);
  return req ? generateCourseForRequest(req) : null;
}

export interface GeneratedCourseEntry {
  id: string;
  difficulty: RaceDifficulty;
  layout: RaceLayout;
  /** Short label without generating (e.g. "Hard Sprint"). */
  label: string;
  /** Generates (once, cached) and returns the course. */
  course(): CourseDef;
}

/** The 6 difficulty × layout combos of a world, generated lazily on first `course()` call. */
export function listGeneratedCourses(world: WorldGenerator, seed: number = defaultCourseSeed(world.spec)): GeneratedCourseEntry[] {
  const out: GeneratedCourseEntry[] = [];
  for (const layout of ['sprint', 'loop'] as const) {
    for (const difficulty of RACE_DIFFICULTIES) {
      out.push({
        id: generatedCourseId({ world: world.spec, difficulty, layout }),
        difficulty,
        layout,
        label: `${DIFFICULTY_LABEL[difficulty]} ${LAYOUT_LABEL[layout]}`,
        course: () => generateCourse(world, seed, difficulty, layout),
      });
    }
  }
  return out;
}

const DIFFICULTY_LABEL: Record<RaceDifficulty, string> = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };
const LAYOUT_LABEL: Record<RaceLayout, string> = { sprint: 'Sprint', loop: 'Circuit' };

// ---------------------------------------------------------------------------------------------

interface Style {
  valley: number;
  water: number;
  city: number;
  smooth: number;
  lowBias: number;
  bend: number;
  wavelength: number;
  phase: number;
  side: 1 | -1;
  ecc: number;
  veer: number;
}

interface BasePoint {
  x: number;
  z: number;
  tx: number;
  tz: number;
}

interface Route {
  points: Point2[];
  clearance: number[];
  bridges: (BridgeSite | null)[];
  heights: number[];
}

interface Scored {
  route: Route;
  score: number;
  loads: number[];
  theme: string;
}

function build(world: WorldGenerator, probe: TerrainProbe, seed: number, request: CourseRequest, id: string): GeneratedCourse {
  const { difficulty, layout } = request;
  const loop = layout === 'loop';
  const base = DIFFICULTY_PARAMS[difficulty];
  const p: DifficultyParams = loop ? { ...base, spacing: base.loopSpacing } : base;
  const salt = (loop ? 20 : 10) + RACE_DIFFICULTIES.indexOf(difficulty);
  const courseSeed = subSeed(seed, salt);

  let best: Scored | null = null;
  let flyable = 0;
  for (let c = 0; c < CANDIDATES; c++) {
    const rng = mulberry32(subSeed(courseSeed, c + 1));
    const route = buildRoute(world, probe, p, loop, difficulty, rng);
    if (!route) continue;
    const loads = validate(world, route, p, loop);
    if (!loads) continue;
    flyable++;
    const scored = score(probe, route, loads, p, loop, difficulty);
    if (!best || scored.score > best.score) best = scored;
  }

  const fallback = !best;
  if (!best) {
    const route = fallbackRoute(world, probe, p, loop);
    const loads = turnLoads(centers(route), loop, RACE_SPEED);
    best = { route, loads, score: 0, theme: 'Airfield' };
  }

  const r = best.route;
  const def: CourseDef = {
    id,
    name: `${best.theme} ${LAYOUT_LABEL[layout]} – ${DIFFICULTY_LABEL[difficulty]}`,
    loop,
    defaultLaps: loop ? (difficulty === 'easy' ? 3 : 2) : 1,
    gates: r.points.map((pt, i) => ({ x: pt.x, z: pt.z, clearance: Math.ceil(r.clearance[i]!) })),
    start: { x: Math.round(world.airSpawn.x), z: Math.round(world.airSpawn.z) },
    version: 1,
    world: request.world,
  };
  const heights = r.heights;
  const mean = heights.reduce((a, b) => a + b, 0) / heights.length;
  const std = Math.sqrt(heights.reduce((a, b) => a + (b - mean) ** 2, 0) / heights.length);
  const loads = best.loads;
  return {
    def,
    request,
    seed,
    stats: {
      score: best.score,
      fallback,
      candidatesTried: CANDIDATES,
      candidatesFlyable: flyable,
      maxLoad: loads.length ? Math.max(...loads) : 0,
      meanLoad: loads.length ? loads.reduce((a, b) => a + b, 0) / loads.length : 0,
      peakLoad: peakLoad(loads),
      gateHeights: heights.slice(),
      altitudeStdDev: std,
      theme: best.theme,
    },
  };
}

function peakLoad(loads: readonly number[]): number {
  if (!loads.length) return 0;
  const top = [...loads].sort((a, b) => b - a).slice(0, Math.max(1, Math.ceil(loads.length / 3)));
  return top.reduce((a, b) => a + b, 0) / top.length;
}

function spawnFrame(world: WorldGenerator): { sx: number; sz: number; dx: number; dz: number } {
  const s = world.airSpawn;
  return { sx: s.x, sz: s.z, dx: -Math.sin(s.heading), dz: -Math.cos(s.heading) };
}

/** Base path (no terrain): a bending line for sprints, a slightly elliptic circle for loops. */
function basePath(world: WorldGenerator, p: DifficultyParams, loop: boolean, n: number, style: Style): BasePoint[] {
  const { sx, sz, dx, dz } = spawnFrame(world);
  const out: BasePoint[] = [];
  if (loop) {
    const length = n * p.spacing;
    const radius = length / (2 * Math.PI);
    const lead = Math.min(LOOP_LEAD, p.spacing * 0.75);
    const step = (length - 2 * lead) / (n - 1);
    // Center to the left or right of the spawn, so the spawn lies on the circle heading along it.
    const ux = -dz * style.side;
    const uz = dx * style.side;
    const cx = sx - ux * radius;
    const cz = sz - uz * radius;
    const at = (a: number): Point2 => {
      const rho = radius * (1 + style.ecc * (Math.cos(2 * a + style.phase) - Math.cos(style.phase)));
      return { x: cx + rho * (ux * Math.cos(a) + dx * Math.sin(a)), z: cz + rho * (uz * Math.cos(a) + dz * Math.sin(a)) };
    };
    for (let i = 0; i < n; i++) {
      const a = (lead + i * step) / radius;
      const q = at(a);
      const q0 = at(a - 0.01);
      const q1 = at(a + 0.01);
      const tl = Math.hypot(q1.x - q0.x, q1.z - q0.z) || 1;
      out.push({ x: q.x, z: q.z, tx: (q1.x - q0.x) / tl, tz: (q1.z - q0.z) / tl });
    }
    return out;
  }
  const h0 = Math.atan2(dx, dz);
  const heading = (d: number): number => {
    // Gradual veer off the spawn axis over the first few km, then a gentle meander.
    const v = Math.min(1, Math.max(0, (d - SPRINT_LEAD) / 3000));
    return h0 + style.veer * v * v * (3 - 2 * v) + style.bend * (Math.sin((2 * Math.PI * d) / style.wavelength + style.phase) - Math.sin(style.phase));
  };
  let x = sx;
  let z = sz;
  let d = 0;
  const STEP = 20;
  for (let i = 0; i < n; i++) {
    const target = SPRINT_LEAD + i * p.spacing;
    while (d < target) {
      const h = heading(d + STEP / 2);
      x += Math.sin(h) * STEP;
      z += Math.cos(h) * STEP;
      d += STEP;
    }
    const h = heading(d);
    out.push({ x, z, tx: Math.sin(h), tz: Math.cos(h) });
  }
  return out;
}

function horizontalLoad(a: Point2, b: Point2, c: Point2): number {
  return turnLoad([a.x, 0, a.z], [b.x, 0, b.z], [c.x, 0, c.z], RACE_SPEED);
}

function buildRoute(world: WorldGenerator, probe: TerrainProbe, p: DifficultyParams, loop: boolean, difficulty: RaceDifficulty, rng: () => number): Route | null {
  const n = p.gates[0] + Math.floor(rng() * (p.gates[1] - p.gates[0] + 1));
  const style: Style = {
    valley: 0.5 + rng() * 1.5,
    water: rng() * 1.2,
    city: difficulty === 'easy' ? rng() * 0.3 : rng() * 1.2,
    smooth: difficulty === 'hard' ? 0.2 + rng() * 0.4 : 0.6 + rng() * 0.8,
    lowBias: difficulty === 'hard' ? 1.2 + rng() * 2 : 0.7 + rng() * 1.2,
    bend: (rng() - 0.5) * (difficulty === 'easy' ? 0.8 : 1.4),
    wavelength: 3000 + rng() * 5000,
    phase: rng() * Math.PI * 2,
    side: rng() < 0.5 ? 1 : -1,
    ecc: rng() * (difficulty === 'easy' ? 0.08 : difficulty === 'medium' ? 0.2 : 0.32),
    veer: (rng() - 0.5) * Math.PI * 1.2,
  };
  const base = basePath(world, p, loop, n, style);
  const { sx, sz } = spawnFrame(world);
  const start = { x: sx, z: sz };

  const points: Point2[] = [];
  const bridges: (BridgeSite | null)[] = [];
  let prevOffset = 0;
  const OPTIONS = 7;
  for (let i = 0; i < n; i++) {
    const b = base[i]!;
    const nx = -b.tz;
    const nz = b.tx;
    const firstOrLast = i === 0 || (loop && i === n - 1);
    const limit = firstOrLast ? p.spacing * 0.12 : p.wander;
    const maxDelta = firstOrLast ? limit : p.wander * 0.6;
    const opts: Array<{ o: number; x: number; z: number; ground: number; water: boolean; city: boolean }> = [];
    let minGround = Infinity;
    for (let k = 0; k < OPTIONS; k++) {
      const raw = prevOffset + ((k / (OPTIONS - 1)) * 2 - 1) * maxDelta + (rng() - 0.5) * maxDelta * 0.3;
      const o = Math.max(-limit, Math.min(limit, raw));
      const x = Math.round(b.x + nx * o);
      const z = Math.round(b.z + nz * o);
      const ground = probe.surface(x, z);
      const water = world.waterLevelAt(x, z) > -Infinity;
      const city = probe.buildingTop(x, z) > -Infinity;
      minGround = Math.min(minGround, ground);
      opts.push({ o, x, z, ground, water, city });
    }
    let pick = opts[0]!;
    let bestScore = -Infinity;
    const prev = points[i - 1] ?? start;
    const prev2 = i >= 2 ? points[i - 2]! : i === 1 ? start : null;
    for (const opt of opts) {
      let s =
        (-style.valley * (opt.ground - minGround)) / 60 +
        (opt.water ? style.water : 0) +
        (opt.city ? style.city : 0) -
        (style.smooth * Math.abs(opt.o - prevOffset)) / Math.max(1, maxDelta) +
        rng() * 0.3;
      if (prev2 && horizontalLoad(prev2, prev, opt) > p.maxG * 0.8) s -= 100;
      if (s > bestScore) {
        bestScore = s;
        pick = opt;
      }
    }
    let point: Point2 = { x: pick.x, z: pick.z };
    let bridge: BridgeSite | null = null;
    if (difficulty === 'hard' && i > 0 && i < n - 1) {
      bridge = bridgeNear(probe, point, 260);
      if (bridge) point = { x: Math.round(bridge.x), z: Math.round(bridge.z) };
    }
    points.push(point);
    bridges.push(bridge);
    prevOffset = pick.o;
  }

  // Clearances: random within the difficulty band (biased low on hard), lifted over buildings.
  const normals = gateNormals(points, loop);
  const ground = points.map((pt, i) => probe.footprintGround(pt.x, pt.z, normals[i]!.x, normals[i]!.z));
  const clearance = points.map((pt, i) => {
    if (bridges[i]) return 1;
    let c = p.clearance[0] + (p.clearance[1] - p.clearance[0]) * Math.pow(rng(), style.lowBias);
    const roof = probe.buildingTop(pt.x, pt.z);
    if (roof > -Infinity) c = Math.max(c, roof - ground[i]! + 10);
    return c;
  });

  const route: Route = { points, clearance, bridges, heights: [] };
  const heightsOf = (): number[] => points.map((_, i) => ground[i]! + clearance[i]! + GATE_CENTER_OFFSET);
  route.heights = heightsOf();

  // Bridge gates must fit under their deck.
  for (let i = 0; i < n; i++) {
    const br = bridges[i];
    if (br && route.heights[i]! + GATE_HEIGHT / 2 + GATE_CONFIG.frame > br.deckY - 3) return null;
  }

  // Repair: raise gates until every straight leg clears the obstacles by the margin.
  const legs = loop ? n : n - 1;
  for (let pass = 0; pass < 6; pass++) {
    let worst = 0;
    for (let a = 0; a < legs; a++) {
      const bIdx = (a + 1) % n;
      const deficit = legDeficit(probe, points[a]!, route.heights[a]!, points[bIdx]!, route.heights[bIdx]!, p.margin, bridges[a] ?? bridges[bIdx] ?? undefined);
      if (deficit.need <= 0.5) continue;
      worst = Math.max(worst, deficit.need);
      const fa = !!bridges[a];
      const fb = !!bridges[bIdx];
      if (fa && fb) return null;
      const t = deficit.t;
      if (!fa && !fb) {
        clearance[a]! += deficit.need + 2;
        clearance[bIdx]! += deficit.need + 2;
      } else if (fa) {
        clearance[bIdx]! += (deficit.need + 2) / Math.max(0.2, t);
      } else {
        clearance[a]! += (deficit.need + 2) / Math.max(0.2, 1 - t);
      }
      if (clearance[a]! > p.maxClearance || clearance[bIdx]! > p.maxClearance) return null;
      route.heights = heightsOf();
    }
    if (worst === 0) return smoothProfile(route, p, loop) ? route : null;
  }
  return null;
}

/**
 * Raises gates (never lowers: legs only move away from the ground) until no gate has a sharper
 * dip or crest than `maxGradeChange`. False if that needs more than the clearance cap.
 */
function smoothProfile(route: Route, p: DifficultyParams, loop: boolean): boolean {
  const { points, clearance, heights, bridges } = route;
  const n = points.length;
  const dist = (a: number, b: number): number => Math.hypot(points[b]!.x - points[a]!.x, points[b]!.z - points[a]!.z) || 1;
  const raise = (i: number, d: number): void => {
    if (bridges[i]) return;
    clearance[i]! += d;
    heights[i]! += d;
  };
  for (let pass = 0; pass < 40; pass++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      if (!loop && (i === 0 || i === n - 1)) continue;
      const a = (i - 1 + n) % n;
      const b = (i + 1) % n;
      const d1 = dist(a, i);
      const d2 = dist(i, b);
      const g1 = (heights[i]! - heights[a]!) / d1;
      const g2 = (heights[b]! - heights[i]!) / d2;
      const excess = g2 > g1 ? g2 - g1 - p.maxGradeChange : g1 - g2 - p.maxCrest;
      if (excess <= 1e-4) continue;
      const delta = excess / (1 / d1 + 1 / d2) + 0.01;
      if (g2 > g1) {
        raise(i, delta);
      } else {
        raise(a, delta);
        raise(b, delta);
      }
      changed = true;
    }
    if (!changed) break;
  }
  return clearance.every((c) => c <= p.maxClearance);
}

function bridgeNear(probe: TerrainProbe, pt: Point2, radius: number): BridgeSite | null {
  const needed = GATE_HEIGHT + 2 * GATE_CONFIG.frame + 1 + 6;
  let best: BridgeSite | null = null;
  let bestD = radius;
  for (const b of probe.bridges) {
    const d = Math.hypot(b.x - pt.x, b.z - pt.z);
    if (d < bestD && b.deckY - b.bottomY >= needed && b.openHalfWidth >= GATE_WIDTH / 2 + 10) {
      best = b;
      bestD = d;
    }
  }
  return best;
}

/** Largest shortfall of the straight leg a→b below obstacle + margin (and where along it). */
function legDeficit(probe: TerrainProbe, a: Point2, ya: number, b: Point2, yb: number, margin: number, skip?: BridgeSite): { need: number; t: number } {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const m = Math.max(2, Math.ceil(len / 50));
  let need = 0;
  let at = 0.5;
  for (let k = 1; k < m; k++) {
    const t = k / m;
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    const y = ya + (yb - ya) * t;
    const d = probe.obstacle(x, z, skip) + margin - y;
    if (d > need) {
      need = d;
      at = t;
    }
  }
  return { need, t: at };
}

function centers(route: Route): number[][] {
  return route.points.map((pt, i) => [pt.x, route.heights[i]!, pt.z]);
}

/** Turn loads if the route is flyable for the difficulty, else null. */
function validate(world: WorldGenerator, route: Route, p: DifficultyParams, loop: boolean): number[] | null {
  const pts = route.points;
  const n = pts.length;
  const c = centers(route);
  const loads = turnLoads(c, loop, RACE_SPEED);
  const { sx, sz } = spawnFrame(world);
  loads.push(turnLoad([sx, c[0]![1]!, sz], c[0]!, c[1]!, RACE_SPEED));
  if (loads.some((g) => !(g <= p.maxG))) return null;
  const legs = loop ? n : n - 1;
  for (let a = 0; a < legs; a++) {
    const b = (a + 1) % n;
    const h = Math.hypot(pts[b]!.x - pts[a]!.x, pts[b]!.z - pts[a]!.z);
    if (h < p.spacing * 0.45 || h > p.spacing * 2.2) return null;
    const grade = (route.heights[b]! - route.heights[a]!) / h;
    if (grade > p.maxSlope || -grade > p.maxDescent) return null;
    if (loop || a + 1 < legs) {
      const c2 = (b + 1) % n;
      const h2 = Math.hypot(pts[c2]!.x - pts[b]!.x, pts[c2]!.z - pts[b]!.z) || 1;
      const next = (route.heights[c2]! - route.heights[b]!) / h2;
      if (next - grade > p.maxGradeChange + 0.005 || grade - next > p.maxCrest + 0.005) return null;
    }
  }
  if (route.clearance.some((cl) => !(cl >= 0))) return null;
  // Gates must not crowd each other (e.g. a loop folding back on itself).
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (loop && i === 0 && j === n - 1) continue;
      if (Math.hypot(pts[i]!.x - pts[j]!.x, pts[i]!.z - pts[j]!.z) < p.spacing * 0.6) return null;
    }
  }
  if (!loop) {
    const last = pts[n - 1]!;
    if (Math.hypot(last.x - sx, last.z - sz) < n * p.spacing * 0.45) return null;
  }
  return loads;
}

const SCORE_WEIGHTS: Record<RaceDifficulty, { turn: number; alt: number; low: number; obstacles: number; variety: number; valley: number }> = {
  easy: { turn: -0.6, alt: 0.2, low: 0.1, obstacles: 0.4, variety: 0.8, valley: 0.6 },
  medium: { turn: 0.8, alt: 0.5, low: 0.6, obstacles: 0.6, variety: 0.6, valley: 0.8 },
  hard: { turn: 2, alt: 0.8, low: 1, obstacles: 1, variety: 0.4, valley: 1 },
};

function score(probe: TerrainProbe, route: Route, loads: number[], p: DifficultyParams, loop: boolean, difficulty: RaceDifficulty): Scored {
  const world = probe.world;
  const n = route.points.length;
  const biomes = new Map<Biome, number>();
  let water = 0;
  let city = 0;
  let canyon = 0;
  for (const pt of route.points) {
    const b = world.biomeAt(pt.x, pt.z);
    biomes.set(b, (biomes.get(b) ?? 0) + 1);
    if (world.waterLevelAt(pt.x, pt.z) > -Infinity) water++;
    if (probe.buildingTop(pt.x, pt.z) > -Infinity) city++;
    canyon += world.canyonFactor(pt.x, pt.z);
  }
  canyon /= n;
  const bridgeCount = route.bridges.filter((b) => b).length;
  const meanLoad = loads.reduce((a, b) => a + b, 0) / loads.length;
  const h = route.heights;
  const mean = h.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(h.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const low = route.clearance.reduce((a, c) => a + Math.exp(-c / 40), 0) / n;
  const obstacles = Math.min(1, (city + bridgeCount * 2 + water * 0.5) / n);
  const w = SCORE_WEIGHTS[difficulty];
  const total =
    w.turn * ((meanLoad + peakLoad(loads)) / (2 * p.maxG)) +
    w.alt * Math.min(1, std / 120) +
    w.low * low +
    w.obstacles * obstacles +
    w.variety * Math.min(1, biomes.size / 5) +
    w.valley * canyon;

  const frac = (...names: Biome[]): number => names.reduce((a, b) => a + (biomes.get(b) ?? 0), 0) / n;
  let theme: string;
  if (bridgeCount > 0) theme = 'Bridge';
  else if (city >= 2) theme = 'Skyline';
  else if (water / n >= 0.35) theme = frac('ocean', 'beach') > frac('river', 'lake') ? 'Coastal' : 'River';
  else if (canyon >= 0.45) theme = 'Canyon';
  else if (frac('mountains', 'snow') >= 0.35) theme = 'Ridge';
  else if (frac('valley') >= 0.3) theme = 'Valley';
  else if (frac('forest') >= 0.35) theme = 'Forest';
  else if (frac('hills') >= 0.35) theme = 'Hill';
  else theme = loop ? 'Meadow' : 'Plains';
  return { route, score: total, loads, theme };
}

/** Safe route: the base circle/line at one flat altitude above everything along it. */
function fallbackRoute(world: WorldGenerator, probe: TerrainProbe, p: DifficultyParams, loop: boolean): Route {
  const n = p.gates[0];
  // Loops: a circle no tighter than 70 % of the difficulty's turn cap.
  const minRadius = (RACE_SPEED * RACE_SPEED) / (9.81 * p.maxG * 0.7);
  if (loop) p = { ...p, spacing: Math.max(p.spacing, (2 * Math.PI * minRadius) / n) };
  const style: Style = { valley: 0, water: 0, city: 0, smooth: 0, lowBias: 1, bend: 0, wavelength: 5000, phase: 0, side: 1, ecc: 0, veer: 0 };
  const base = basePath(world, p, loop, n, style);
  const points = base.map((b) => ({ x: Math.round(b.x), z: Math.round(b.z) }));
  const normals = gateNormals(points, loop);
  const ground = points.map((pt, i) => probe.footprintGround(pt.x, pt.z, normals[i]!.x, normals[i]!.z));
  let top = Math.max(...ground);
  const { sx, sz } = spawnFrame(world);
  const path = [{ x: sx, z: sz }, ...points, ...(loop ? [points[0]!] : [])];
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1]!;
    const b = path[k]!;
    const m = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 50));
    for (let j = 0; j <= m; j++) top = Math.max(top, probe.obstacle(a.x + ((b.x - a.x) * j) / m, a.z + ((b.z - a.z) * j) / m));
  }
  const y = top + p.margin + 60;
  const clearance = ground.map((g) => y - GATE_CENTER_OFFSET - g);
  return { points, clearance, bridges: points.map(() => null), heights: points.map(() => y) };
}
