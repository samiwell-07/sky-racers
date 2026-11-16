import { Vector3 } from 'three';
import type { FlightModel } from '../physics/FlightModel';
import type { FlightControls } from '../physics/types';
import { liftCoefficient } from '../physics/aerodynamics';
import { clamp, lerp } from '../utils/math';
import { mulberry32 } from '../utils/random';

export interface AIWaypoint {
  /** Gate center. */
  position: Vector3;
  /** Unit horizontal direction to fly through the gate. */
  direction: Vector3;
}

export interface AIPilotOptions {
  /** 0..1 (default 0.8): lower = smaller pull limits, slower reactions, more wobble. */
  skill?: number;
  /** Cruise speed in m/s (default 170). */
  targetSpeed?: number;
  seed?: number;
  /** Obstacles to avoid besides the terrain (the same ones the racers collide with). */
  hazards?: AIHazards | null;
}

/** Obstacle queries for path planning (implemented by PropsManager). */
export interface AIHazards {
  /** Highest top (m) of solid obstacles (trees, rocks, buildings, pylons) within `radius` of (x, z), or -Infinity. */
  obstacleTop(x: number, z: number, radius: number): number;
  /** Elevated hazards to pass under or over (cables, arch stone) as [bottom, top] pairs in `out`; returns the count. */
  hazardBands(x: number, z: number, radius: number, out: number[]): number;
}

const WORLD_UP = new Vector3(0, 1, 0);
const PREDICT_TIMES = [0.75, 1.5, 2.25];
/** Half-width (m) of the corridor checked for obstacles (half wingspan + margin). */
const OBSTACLE_RADIUS = 11;
/** Height (m) kept above the tops of solid obstacles (trees, rocks, buildings, pylons). */
const OBSTACLE_CLEARANCE = 8;
/** Vertical clearance (m) kept from cables and arch stone, and the room needed to pass under them. */
const HAZARD_MARGIN = 9;
const HAZARD_UNDER_ROOM = 14;
/** Obstacle sweep: sample spacing and horizon (s) along the predicted path. */
const HAZARD_STEP = 0.1;
const HAZARD_HORIZON = 2.5;
/** The sweep runs every this many control steps (30 Hz at the 120 Hz physics rate). */
const HAZARD_EVERY = 4;
const _bands: number[] = [];
const _pred = { x: 0, z: 0 };
/** Look-ahead times (s) for the constant-turn-rate terrain check. */
const ARC_PREDICT_TIMES = [0.5, 1, 1.5];
/** Guidance range floor (seconds of flight) so the gains stay bounded right at the gate. */
const MIN_RANGE_TIME = 0.5;
/** Optimal-guidance gains (4 / 2 is the textbook min-energy pair; these hold up better when the turn saturates). */
const GUIDANCE_LOS_GAIN = 3.5;
const GUIDANCE_ARRIVAL_GAIN = 0.5;
/** Extra vertical lift (in g) tolerated while the bank is still catching up. */
const VERTICAL_SLACK = 2;
/** Beyond this bank angle (rad) the jet counts as inverted. */
const INVERTED_BANK = 2.2;
/** Height above the terrain (m) below which the pilot starts climbing away from it. */
const TERRAIN_FLOOR = 18;
/** Racing-line lookahead (seconds of flight) for low and high skill. */
const PATH_LOOKAHEAD_LOW = 1.2;
const PATH_LOOKAHEAD_HIGH = 0.9;
/** Vertical tracking uses a longer lookahead than lateral (softer height changes, less coupling). */
const VERTICAL_LOOKAHEAD_SCALE = 1.5;
/** The height profile never dips below this height over the terrain under the lookahead point (m). */
const PROFILE_MIN_AGL = 25;
const _fwd = new Vector3();
const _up = new Vector3();
const _right = new Vector3();
const _vDir = new Vector3();
const _air = new Vector3();
const _aim = new Vector3();
const _aDes = new Vector3();
const _lift = new Vector3();
const _rightL = new Vector3();
const _upL = new Vector3();
const _tmp = new Vector3();

const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** Samples per gate-to-gate path segment. */
const PATH_SAMPLES = 24;
/** Straight run-out appended after the last known gate (m). */
const PATH_RUNOUT = 800;
/** Beyond this distance from the racing line (m) the pilot flies straight at the gate instead. */
const PATH_MAX_ERROR = 250;
const _px = new Float64Array(PATH_SAMPLES * 2 + 3);
const _pz = new Float64Array(PATH_SAMPLES * 2 + 3);
const _py = new Float64Array(PATH_SAMPLES * 2 + 3);
let _pn = 0;
/** Bumped whenever the path buffer is rebuilt (invalidates the closest-point memo). */
let _pathVersion = 0;
const _closest = { version: -1, x: NaN, z: NaN, i: 0, u: 0, d2: Infinity };
const _look = { x: 0, y: 0, z: 0, dist: 0 };

/** Appends a Hermite curve from gate a to gate b (horizontal tangents = gate directions) to the path buffer. */
function appendHermite(a: AIWaypoint, b: AIWaypoint): void {
  const len = Math.hypot(b.position.x - a.position.x, b.position.z - a.position.z);
  for (let i = _pn === 0 ? 0 : 1; i <= PATH_SAMPLES; i++) {
    const t = i / PATH_SAMPLES;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = (t3 - 2 * t2 + t) * len;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = (t3 - t2) * len;
    _px[_pn] = h00 * a.position.x + h10 * a.direction.x + h01 * b.position.x + h11 * b.direction.x;
    _pz[_pn] = h00 * a.position.z + h10 * a.direction.z + h01 * b.position.z + h11 * b.direction.z;
    // Height eases between gate heights, level at each gate.
    _py[_pn] = h00 * a.position.y + h01 * b.position.y;
    _pn++;
  }
}

/**
 * Finds the point `lookahead` meters ahead along the path buffer from the point closest to (x, z).
 * Returns false when the jet is too far from the path to follow it.
 */
function findLookahead(x: number, z: number, lookahead: number): boolean {
  const memo = _closest;
  if (memo.version !== _pathVersion || memo.x !== x || memo.z !== z) {
    let best = Infinity;
    let bestI = 0;
    let bestU = 0;
    for (let i = 0; i < _pn - 1; i++) {
      const sx = _px[i + 1]! - _px[i]!;
      const sz = _pz[i + 1]! - _pz[i]!;
      const l2 = sx * sx + sz * sz;
      const u = l2 > 1e-9 ? clamp(((x - _px[i]!) * sx + (z - _pz[i]!) * sz) / l2, 0, 1) : 0;
      const dx = _px[i]! + sx * u - x;
      const dz = _pz[i]! + sz * u - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) {
        best = d2;
        bestI = i;
        bestU = u;
      }
    }
    memo.version = _pathVersion;
    memo.x = x;
    memo.z = z;
    memo.i = bestI;
    memo.u = bestU;
    memo.d2 = best;
  }
  const best = memo.d2;
  const bestI = memo.i;
  const bestU = memo.u;
  if (best > PATH_MAX_ERROR * PATH_MAX_ERROR) return false;
  let i = bestI;
  let cx = _px[i]! + (_px[i + 1]! - _px[i]!) * bestU;
  let cz = _pz[i]! + (_pz[i + 1]! - _pz[i]!) * bestU;
  let cy = _py[i]! + (_py[i + 1]! - _py[i]!) * bestU;
  let remaining = lookahead;
  while (i < _pn - 1) {
    const nx = _px[i + 1]!;
    const nz = _pz[i + 1]!;
    const seg = Math.hypot(nx - cx, nz - cz);
    if (seg >= remaining) {
      const f = seg > 1e-9 ? remaining / seg : 0;
      cx += (nx - cx) * f;
      cz += (nz - cz) * f;
      remaining = 0;
      break;
    }
    remaining -= seg;
    cx = nx;
    cz = nz;
    i++;
  }
  _look.x = cx;
  _look.y = cy;
  _look.z = cz;
  _look.dist = Math.hypot(cx - x, cz - z);
  return true;
}

/**
 * Autopilot for rival jets. Flies the same FlightModel as the player using only pitch/roll/throttle.
 * Once it knows the previous gate it follows a smooth racing line (Hermite curves through the previous,
 * current and next gates, easing between gate heights) with L1 path following; otherwise it uses
 * arrival-angle guidance straight to the gate. It banks so the lift vector points along the desired
 * acceleration and pulls the angle of attack required to produce it (bank-to-turn).
 */
export class AIPilot {
  readonly skill: number;
  readonly targetSpeed: number;
  private readonly seed: number;
  private rng: () => number;
  private readonly filteredAccel = new Vector3();
  private readonly wobble = new Vector3();
  private readonly wobbleTarget = new Vector3();
  private wobbleTimer = 0;
  private initialized = false;
  /** The gate being flown to and the one before it: the racing line runs between them. */
  private readonly current: AIWaypoint = { position: new Vector3(), direction: new Vector3() };
  private readonly previous: AIWaypoint = { position: new Vector3(), direction: new Vector3() };
  private hasCurrent = false;
  private hasPrevious = false;
  /** Measured ground-track turn rate (rad/s, + = right), for predicting where the jet really goes. */
  private turnRate = 0;
  private lastHeading = 0;
  private hasHeading = false;
  private readonly controls: FlightControls = { pitch: 0, roll: 0, throttle: 0 };
  private hazards: AIHazards | null;
  /** Cached result of the last obstacle sweep (see HAZARD_EVERY). */
  private readonly sweep = { countdown: 0, cap: Infinity, floor: -Infinity, deficit: -Infinity, minAgl: Infinity };

  constructor(options: AIPilotOptions = {}) {
    this.skill = clamp(options.skill ?? 0.8, 0, 1);
    this.targetSpeed = options.targetSpeed ?? 170;
    this.seed = options.seed ?? 1;
    this.rng = mulberry32(this.seed);
    this.hazards = options.hazards ?? null;
  }

  setHazards(hazards: AIHazards | null): void {
    this.hazards = hazards;
    this.sweep.countdown = 0;
  }

  reset(): void {
    this.rng = mulberry32(this.seed);
    this.filteredAccel.set(0, 0, 0);
    this.wobble.set(0, 0, 0);
    this.wobbleTarget.set(0, 0, 0);
    this.wobbleTimer = 0;
    this.initialized = false;
    this.hasCurrent = false;
    this.hasPrevious = false;
    this.turnRate = 0;
    this.hasHeading = false;
    this.controls.pitch = 0;
    this.controls.roll = 0;
    this.controls.throttle = 0;
    this.sweep.countdown = 0;
  }

  computeControls(
    model: FlightModel,
    waypoint: AIWaypoint,
    groundHeight: (x: number, z: number) => number,
    dt: number,
    nextWaypoint?: AIWaypoint,
  ): FlightControls {
    const s = model.state;
    const c = model.config;
    const skill = this.skill;
    const pos = s.position;
    const m = model.modifiers;
    const hazards = this.hazards;
    // Solid obstacles are treated as raised ground, lowered so the terrain clearance rules keep the
    // jet OBSTACLE_CLEARANCE (not TERRAIN_FLOOR) above them: tall margins over forests ruin the line.
    const floorAt = hazards
      ? (x: number, z: number): number => Math.max(groundHeight(x, z), hazards.obstacleTop(x, z, OBSTACLE_RADIUS) + OBSTACLE_CLEARANCE - TERRAIN_FLOOR)
      : groundHeight;
    // Aerodynamics work on the airspeed (velocity relative to the wind); guidance on the ground track.
    _air.copy(s.velocity).sub(model.wind);
    const speed = Math.max(_air.length(), 1);
    _vDir.copy(_air).divideScalar(speed);
    model.getAxes(_fwd, _up, _right);

    // Once past the gate plane (before the race logic switches waypoints), go for the next one.
    let wp = waypoint;
    if (nextWaypoint && _tmp.subVectors(pos, waypoint.position).dot(waypoint.direction) > 0) wp = nextWaypoint;
    if (!this.hasCurrent || this.current.position.distanceToSquared(waypoint.position) > 1) {
      if (this.hasCurrent) {
        this.previous.position.copy(this.current.position);
        this.previous.direction.copy(this.current.direction);
        this.hasPrevious = true;
      }
      this.current.position.copy(waypoint.position);
      this.current.direction.copy(waypoint.direction);
      this.hasCurrent = true;
    }

    // Racing line: smooth curves through the previous, current and next gates, then a straight run-out.
    _pn = 0;
    _pathVersion++;
    let lastGate: AIWaypoint | null = null;
    if (wp !== waypoint) {
      appendHermite(waypoint, wp);
      lastGate = wp;
    } else if (this.hasPrevious) {
      appendHermite(this.previous, waypoint);
      lastGate = waypoint;
      if (nextWaypoint) {
        appendHermite(waypoint, nextWaypoint);
        lastGate = nextWaypoint;
      }
    }
    if (lastGate) {
      _px[_pn] = lastGate.position.x + lastGate.direction.x * PATH_RUNOUT;
      _pz[_pn] = lastGate.position.z + lastGate.direction.z * PATH_RUNOUT;
      _py[_pn] = lastGate.position.y;
      _pn++;
    }

    // ---- Wobble: slowly drifting aim offset, larger for weaker pilots ----
    this.wobbleTimer -= dt;
    if (this.wobbleTimer <= 0) {
      const amp = (1 - skill) * 5;
      this.wobbleTarget.set((this.rng() * 2 - 1) * amp, (this.rng() * 2 - 1) * amp * 0.6, 0);
      this.wobbleTimer = 0.8 + this.rng() * 1.2;
    }
    this.wobble.lerp(this.wobbleTarget, 1 - Math.exp(-1.5 * dt));

    // Aim at the gate center, offset by the wobble in the gate's lateral frame.
    const dir = wp.direction;
    const dist = pos.distanceTo(wp.position);
    _tmp.crossVectors(dir, WORLD_UP).normalize();
    const wobbleFade = clamp(dist / 150, 0.3, 1);
    _aim.copy(wp.position).addScaledVector(_tmp, this.wobble.x * wobbleFade).y += this.wobble.y * wobbleFade;

    // ---- Horizontal: optimal guidance with arrival-direction constraint ----
    // a = V²/R · (N1·(LOS − heading) + N2·(LOS − gate direction)): reaches the gate flying along it.
    // Headings are measured from -Z, positive toward +X (turning right).
    const hSpeed = Math.max(Math.hypot(s.velocity.x, s.velocity.z), 1);
    const hx = s.velocity.x / hSpeed;
    const hz = s.velocity.z / hSpeed;
    const ax = _aim.x - pos.x;
    const az = _aim.z - pos.z;
    const heading = Math.atan2(hx, -hz);
    const los = Math.atan2(ax, -az);
    const gateHeading = Math.atan2(dir.x, -dir.z);
    const range = Math.max(Math.hypot(ax, az), hSpeed * MIN_RANGE_TIME);
    const losErr = wrapAngle(los - heading);
    const arrivalErr = clamp(wrapAngle(los - gateHeading), -1.2, 1.2);
    const aMax = lerp(4, 8, skill) * c.gravity;
    let aLat =
      Math.abs(losErr) > Math.PI / 2
        ? Math.sign(losErr) * aMax
        : clamp(
            ((hSpeed * hSpeed) / range) * (GUIDANCE_LOS_GAIN * losErr + GUIDANCE_ARRIVAL_GAIN * arrivalErr),
            -aMax,
            aMax,
          );

    // On the racing line: L1 path following toward a point a fixed time ahead along the line.
    let lookX = _aim.x;
    let lookZ = _aim.z;
    const lookahead = hSpeed * lerp(PATH_LOOKAHEAD_LOW, PATH_LOOKAHEAD_HIGH, skill);
    const onPath = _pn > 1 && findLookahead(pos.x, pos.z, lookahead);
    if (onPath) {
      lookX = _look.x + _tmp.x * this.wobble.x;
      lookZ = _look.z + _tmp.z * this.wobble.x;
      const lx = lookX - pos.x;
      const lz = lookZ - pos.z;
      const ld = Math.max(Math.hypot(lx, lz), 1);
      const cosEta = (lx * hx + lz * hz) / ld;
      const sinEta = (lx * -hz + lz * hx) / ld;
      aLat = cosEta < 0 ? Math.sign(sinEta || 1) * aMax : clamp((2 * hSpeed * hSpeed * sinEta) / ld, -aMax, aMax);
    }

    // ---- Vertical: same guidance law, arriving level at the gate height ----
    const gamma = Math.atan2(s.velocity.y, hSpeed);
    const elev = Math.atan2(_aim.y - pos.y, range);
    let aVert = clamp(
      ((hSpeed * hSpeed) / range) * (GUIDANCE_LOS_GAIN * (elev - gamma) + GUIDANCE_ARRIVAL_GAIN * elev),
      -0.7 * c.gravity,
      2 * c.gravity,
    );
    if (onPath) {
      // L1 on the racing line's height profile, which eases from gate height to gate height.
      const ld = Math.max(Math.hypot(lookX - pos.x, lookZ - pos.z), 1) * VERTICAL_LOOKAHEAD_SCALE;
      // Never aim lower than a safe height over the terrain under the lookahead point.
      const lookY = Math.max(_look.y + this.wobble.y, floorAt(lookX, lookZ) + PROFILE_MIN_AGL);
      const lookElev = Math.atan2(lookY - pos.y, ld);
      aVert = clamp((2 * hSpeed * hSpeed * Math.sin(lookElev - gamma)) / ld, -1.5 * c.gravity, 2 * c.gravity);
    }
    _aDes.set(-hz * aLat, aVert, hx * aLat);

    // ---- Terrain avoidance ----
    // Predict along the intended path (current heading blending into the line of sight to the
    // aim point / racing line), not straight ahead: in a curving canyon a straight projection hits the walls.
    const agl = pos.y - floorAt(pos.x, pos.z);
    let minPredAgl = agl;
    let clearanceDeficit = TERRAIN_FLOOR - agl;
    const tx = lookX - pos.x;
    const tz = lookZ - pos.z;
    const losLen = Math.max(Math.hypot(tx, tz), 1);
    /** Predicted horizontal position after t seconds along the intended path (into _pred). */
    const predict = (t: number): void => {
      const blend = Math.min(1, t / 1.2);
      let dx = hx * (1 - blend) + (tx / losLen) * blend;
      let dz = hz * (1 - blend) + (tz / losLen) * blend;
      const dl = Math.max(Math.hypot(dx, dz), 1e-6);
      dx /= dl;
      dz /= dl;
      const reach = Math.min(hSpeed * t, losLen);
      _pred.x = pos.x + dx * reach;
      _pred.z = pos.z + dz * reach;
      // On the racing line, the prediction follows the line itself.
      if (onPath && findLookahead(pos.x, pos.z, hSpeed * t)) {
        _pred.x = _pred.x * (1 - blend) + _look.x * blend;
        _pred.z = _pred.z * (1 - blend) + _look.z * blend;
      }
    };
    for (const t of PREDICT_TIMES) {
      predict(t);
      const predAgl = pos.y + s.velocity.y * t - groundHeight(_pred.x, _pred.z);
      minPredAgl = Math.min(minPredAgl, predAgl);
      // Terrain further ahead can still be cleared by a gentle climb started later.
      clearanceDeficit = Math.max(clearanceDeficit, TERRAIN_FLOOR - 0.25 * c.gravity * t * t - predAgl);
    }
    // ---- Obstacle avoidance: a dense sweep along the same predicted path (thin obstacles fall between the terrain samples) ----
    // Vertical acceleration limits from elevated hazards ahead (pass under: cap, pass over: floor).
    // Runs every HAZARD_EVERY steps; the results are reused in between.
    const sw = this.sweep;
    if (hazards && --sw.countdown <= 0) {
      sw.countdown = HAZARD_EVERY;
      sw.cap = Infinity;
      sw.floor = -Infinity;
      sw.deficit = -Infinity;
      sw.minAgl = Infinity;
      for (let t = HAZARD_STEP; t <= HAZARD_HORIZON + 1e-9; t += HAZARD_STEP) {
        predict(t);
        const py = pos.y + s.velocity.y * t;
        const floorY = floorAt(_pred.x, _pred.z);
        const predAgl = py - floorY;
        sw.minAgl = Math.min(sw.minAgl, predAgl);
        sw.deficit = Math.max(sw.deficit, TERRAIN_FLOOR - 0.25 * c.gravity * t * t - predAgl);
        const n = hazards.hazardBands(_pred.x, _pred.z, OBSTACLE_RADIUS, _bands);
        for (let k = 0; k < n; k++) {
          const bottom = _bands[k * 2]! - HAZARD_MARGIN;
          const top = _bands[k * 2 + 1]! + HAZARD_MARGIN;
          if (py <= bottom || py >= top) continue;
          // Acceleration that reaches the target height at time t (from the coasting prediction).
          if (bottom - floorY >= HAZARD_UNDER_ROOM && py < top - HAZARD_MARGIN) {
            sw.cap = Math.min(sw.cap, (2 * (bottom - py)) / (t * t));
          } else {
            sw.floor = Math.max(sw.floor, (2 * (top - py)) / (t * t));
          }
        }
      }
    }
    // Also check where the jet is really going (current turn rate): catches drifting off the line into a wall.
    if (this.hasHeading) {
      const rate = wrapAngle(heading - this.lastHeading) / Math.max(dt, 1e-6);
      this.turnRate += (rate - this.turnRate) * (1 - Math.exp(-dt / 0.15));
    }
    this.lastHeading = heading;
    this.hasHeading = true;
    for (const t of ARC_PREDICT_TIMES) {
      const turn = clamp(this.turnRate * t, -1.2, 1.2);
      const mid = heading + turn / 2;
      const chord = hSpeed * t * (Math.abs(turn) > 1e-4 ? Math.sin(turn / 2) / (turn / 2) : 1);
      const predAgl = pos.y + s.velocity.y * t - floorAt(pos.x + Math.sin(mid) * chord, pos.z - Math.cos(mid) * chord);
      minPredAgl = Math.min(minPredAgl, predAgl);
      clearanceDeficit = Math.max(clearanceDeficit, TERRAIN_FLOOR - 0.25 * c.gravity * t * t - predAgl);
    }
    if (hazards) {
      minPredAgl = Math.min(minPredAgl, sw.minAgl);
      clearanceDeficit = Math.max(clearanceDeficit, sw.deficit);
      if (sw.floor > -Infinity) _aDes.y = Math.max(_aDes.y, Math.min(sw.floor, 4 * c.gravity));
      else if (sw.cap < Infinity) _aDes.y = Math.min(_aDes.y, Math.max(sw.cap, -1.5 * c.gravity));
    }
    // Terrain has priority over the height profile and the hazards: stop descending, then climb.
    if (clearanceDeficit > 0) _aDes.y = Math.max(_aDes.y, 0) + clamp(clearanceDeficit * 0.8, 0, 4 * c.gravity);
    const emergency = minPredAgl < 6 || agl < 8;

    // ---- Reaction lag ----
    if (!this.initialized) {
      this.filteredAccel.copy(_aDes);
      this.initialized = true;
    }
    const tau = lerp(0.22, 0.04, skill);
    this.filteredAccel.lerp(_aDes, 1 - Math.exp(-dt / tau));

    // Desired lift = desired acceleration + gravity compensation − the other forces the airframe
    // already produces (thrust off the flight path, fuselage side force), perpendicular to the path.
    _lift.copy(this.filteredAccel);
    _lift.y += c.gravity;
    _lift.addScaledVector(_fwd, -s.throttle * c.maxThrust * m.thrust);
    _lift.addScaledVector(_right, _air.dot(_right) * c.sideForce);
    // Gusts are felt immediately (seat of the pants): lean against them.
    _lift.sub(model.gust);
    _lift.addScaledVector(_vDir, -_lift.dot(_vDir));

    // Wings-level reference frame around the forward axis.
    _rightL.crossVectors(_fwd, WORLD_UP);
    if (_rightL.lengthSq() < 1e-6) _rightL.copy(_right);
    _rightL.normalize();
    _upL.crossVectors(_rightL, _fwd).normalize();

    const lr = _lift.dot(_rightL);
    const lu = _lift.dot(_upL);
    let bankDes: number;
    let liftSign = 1;
    if (lu >= 0 || Math.abs(lr) > -lu * 2) {
      bankDes = Math.atan2(lr, lu);
    } else {
      // Needs to push down: keep the wings near level and use negative lift.
      bankDes = Math.atan2(-lr, -lu);
      liftSign = -1;
    }
    const maxBank = lerp(1.45, 2.1, skill);
    bankDes = clamp(bankDes, -maxBank, maxBank);
    let liftMag = Math.sqrt(lr * lr + lu * lu) * liftSign;

    const bank = Math.atan2(_up.dot(_rightL), _up.dot(_upL));
    if (emergency) {
      bankDes = 0;
      liftMag = 3.5 * c.gravity;
    }
    // ---- Roll: rate command proportional to bank error ----
    // Roll back through wings-level unless already mostly inverted (then take the short way).
    const bankErr = Math.abs(bank) < INVERTED_BANK ? bankDes - bank : wrapAngle(bankDes - bank);
    const rollGain = lerp(3, 5, skill);
    const rollCmd = (bankErr * rollGain - s.rollRate * 0.15) / c.maxRollRate;

    // ---- Pitch: track the angle of attack that produces the required lift ----
    const q = c.liftCoefficient * m.lift * speed * speed;
    const aoa = Math.atan2(-_air.dot(_up), _air.dot(_fwd));
    // Only pull once the lift vector points roughly where it should; never pull toward the ground.
    let effLift = liftMag >= 0 ? Math.max(liftMag * Math.cos(bankErr), -c.gravity) : liftMag;
    // While still rolling in, cap the pull so the vertical part of the lift doesn't balloon the jet.
    const cosBank = Math.cos(bank);
    if (!emergency && liftMag > 0 && cosBank > 0.1) {
      effLift = Math.min(effLift, (lu + VERTICAL_SLACK * c.gravity) / cosBank);
    }
    const aoaMax = c.stallAngle * lerp(0.7, 0.88, skill);
    const clMax = c.cl0 + c.clAlpha * c.stallAngle;
    const clDes = clamp(effLift / q, -clMax, clMax);
    let aoaDes = clamp((clDes - c.cl0) / c.clAlpha, -0.12, aoaMax);
    if (emergency) aoaDes = Math.max(aoaDes, aoaMax);
    // Feed-forward: rate at which the flight path currently rotates in the pitch plane.
    const actualLift = clamp(q * liftCoefficient(aoa, c), -c.maxG * c.gravity, c.maxG * c.gravity);
    const pathRate = (actualLift - c.gravity * _up.y) / speed;
    let pitchCmd = (pathRate + (aoaDes - aoa) * 6) / c.maxPitchRate;

    // Inverted with the ground near: roll out first, don't pull toward the ground.
    if (emergency && Math.abs(bank) > Math.PI / 2) pitchCmd = Math.min(pitchCmd, 0);

    // ---- Throttle: lever position toward the level that holds the target speed ----
    const leverDes = clamp(0.6 + (this.targetSpeed - speed) * 0.04, 0, 1);

    this.controls.pitch = clamp(pitchCmd, -1, 1);
    this.controls.roll = clamp(rollCmd, -1, 1);
    this.controls.throttle = clamp((leverDes - s.throttle) * 6, -1, 1);
    return this.controls;
  }
}
