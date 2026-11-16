import type { InputAction } from '../config/controlsConfig';
import type { CourseDef } from '../race/Course';
import { browserStorage, tryGetItem, tryParseJson, trySetItem, type KeyValueStorage, type SaveResult } from '../settings/safeStorage';
import { runwayRect } from '../world/terrain/HeightField';

/**
 * Flight school lessons: definitions, objective checks and contextual prompts. Pure logic (no
 * rendering, no physics): the game feeds a `FlightSnapshot` every physics step.
 */

export type LessonId = 'takeoff' | 'gear' | 'turn' | 'gates' | 'airbrake' | 'stall';

/** What the objective checks need to know about the player's jet after a physics step. */
export interface FlightSnapshot {
  /** m/s */
  speed: number;
  /** Height above ground/water (m). */
  agl: number;
  /** m/s, positive = climbing. */
  verticalSpeed: number;
  /** 0..1 */
  throttle: number;
  /** Direction of travel, degrees (0 = north / -Z, 90 = east / +X). */
  headingDeg: number;
  /** Nose above the horizon, degrees. */
  pitchDeg: number;
  /** Bank angle, degrees (positive = right wing down). */
  bankDeg: number;
  gearDown: boolean;
  grounded: boolean;
  airbrake: boolean;
  stalled: boolean;
  /** Lesson gates passed / missed / total (0 when the lesson has no gates). */
  gatesPassed: number;
  gatesMissed: number;
  gateCount: number;
}

/** Where and how a lesson starts. Air starts: `margin` = metres above the highest terrain around the spawn. */
export type LessonStart =
  | { kind: 'runway' }
  | { kind: 'air'; z: number; heading: number; speed: number; throttle: number; margin: number; pitchDeg?: number }
  | { kind: 'course'; speed: number; throttle: number };

export interface LessonDef {
  id: LessonId;
  title: string;
  /** The one objective, as shown in the lesson list and the HUD box. */
  objective: string;
  start: LessonStart;
  /** Gate lesson course (resolved on the terrain by the game). */
  course?: CourseDef;
}

/** Calm, daytime, low-cloud world used for every lesson (the player's own settings return afterwards). */
export const LESSON_WORLD = Object.freeze({ timeOfDay: 13, cloudCoverage: 0.2, windSpeed: 0, windDirection: 0, turbulence: 0 });

export const TURN_MIN_AGL = 40;
export const TURN_TARGET_DEG = 90;
export const AIRBRAKE_TARGET_SPEED = 100;
export const STALL_RECOVERY_SPEED = 70;

/** Three wide gates straight down the runway (flat ground, no obstacles), small sideways offsets. */
function runwayGatesCourse(): CourseDef {
  const x = Math.round(runwayRect().x);
  return {
    id: 'flight-school-gates',
    name: 'Flight school gates',
    loop: false,
    defaultLaps: 1,
    start: { x, z: 5600 },
    gates: [
      { x, z: 4800 },
      { x: x + 50, z: 4000 },
      { x: x - 40, z: 3200 },
    ],
  };
}

export const LESSONS: readonly LessonDef[] = [
  {
    id: 'takeoff',
    title: 'Throttle & takeoff',
    objective: 'Take off from the runway, raise the gear and climb above 30 m.',
    start: { kind: 'runway' },
  },
  {
    id: 'gear',
    title: 'Landing gear',
    objective: 'Lower the landing gear, feel the drag, then raise it again.',
    start: { kind: 'air', z: 5200, heading: 0, speed: 120, throttle: 0.5, margin: 150 },
  },
  {
    id: 'turn',
    title: 'Bank and pull',
    objective: `Turn at least ${TURN_TARGET_DEG}° while staying above ${TURN_MIN_AGL} m.`,
    start: { kind: 'air', z: 4500, heading: 0, speed: 150, throttle: 0.6, margin: 250 },
  },
  {
    id: 'gates',
    title: 'Gate approach',
    objective: 'Fly through all three gates over the runway.',
    start: { kind: 'course', speed: 130, throttle: 0.6 },
    course: runwayGatesCourse(),
  },
  {
    id: 'airbrake',
    title: 'Airbrake & slowing down',
    objective: `Use the airbrake to slow below ${Math.round(AIRBRAKE_TARGET_SPEED * 3.6)} km/h, staying above 40 m.`,
    start: { kind: 'air', z: 5400, heading: 0, speed: 175, throttle: 0.8, margin: 200 },
  },
  {
    id: 'stall',
    title: 'Stall recovery',
    objective: `Recover from a nose-high stall to level flight above ${Math.round(STALL_RECOVERY_SPEED * 3.6)} km/h.`,
    start: { kind: 'air', z: 4800, heading: 0, speed: 55, throttle: 0.3, margin: 500, pitchDeg: 28 },
  },
];

export function getLesson(id: string): LessonDef | undefined {
  return LESSONS.find((l) => l.id === id);
}

export function nextLesson(id: LessonId): LessonDef | null {
  const i = LESSONS.findIndex((l) => l.id === id);
  return i >= 0 ? (LESSONS[i + 1] ?? null) : null;
}

/** Signed smallest difference b - a between two headings (degrees, -180..180]. */
export function headingDelta(a: number, b: number): number {
  let d = (((b - a) % 360) + 360) % 360;
  if (d > 180) d -= 360;
  return d;
}

/** Flight-path angle (degrees) from vertical speed and airspeed. */
export const flightPathDeg = (s: Pick<FlightSnapshot, 'speed' | 'verticalSpeed'>): number =>
  s.speed > 1 ? (Math.asin(Math.max(-1, Math.min(1, s.verticalSpeed / s.speed))) * 180) / Math.PI : 0;

/** Held "level" this long (s) to count the stall as recovered. */
export const STALL_LEVEL_HOLD = 1;
/** Gear must be down this long (s) before raising it completes the gear lesson. */
export const GEAR_DOWN_HOLD = 2;

export type LessonStatus = 'running' | 'complete' | 'failed';

/** Labels for the player's real controls (keyboard bindings + controller when connected). */
export interface PromptKeys {
  /** Short key label(s) for an action, e.g. "↑ / L-Shift". */
  key(action: InputAction): string;
  /** Controller hint for an action, or null when no controller is connected. */
  pad(action: InputAction): string | null;
}

/** Objective tracking for one attempt at a lesson. Feed it one snapshot per physics step. */
export class LessonTracker {
  status: LessonStatus = 'running';
  failReason = '';
  /** Turn lesson: degrees turned so far (signed; the objective uses the absolute value). */
  turned = 0;
  tooLow = false;
  gearDownTime = 0;
  braked = false;
  levelTime = 0;
  private lastHeading: number | null = null;

  constructor(readonly def: LessonDef) {}

  step(s: FlightSnapshot, dt: number): LessonStatus {
    if (this.status !== 'running') return this.status;
    if (this.objectiveMet(s, dt)) this.status = 'complete';
    return this.status;
  }

  private objectiveMet(s: FlightSnapshot, dt: number): boolean {
    switch (this.def.id) {
      case 'takeoff':
        return !s.grounded && s.agl > 30 && !s.gearDown;
      case 'gear':
        if (s.gearDown && !s.grounded) this.gearDownTime += dt;
        return this.gearDownTime >= GEAR_DOWN_HOLD && !s.gearDown && !s.grounded && s.agl > 20;
      case 'turn': {
        this.tooLow = s.agl < TURN_MIN_AGL;
        if (this.tooLow) {
          // Forgiving: going too low restarts the count instead of failing the lesson.
          this.turned = 0;
          this.lastHeading = null;
          return false;
        }
        if (s.speed < 20) return false;
        if (this.lastHeading !== null) this.turned += headingDelta(this.lastHeading, s.headingDeg);
        this.lastHeading = s.headingDeg;
        return Math.abs(this.turned) >= TURN_TARGET_DEG;
      }
      case 'gates':
        if (s.gatesMissed > 0) {
          this.status = 'failed';
          this.failReason = 'Missed a gate – aim for the middle of the frame';
          return false;
        }
        return s.gateCount > 0 && s.gatesPassed >= s.gateCount;
      case 'airbrake':
        if (s.airbrake) this.braked = true;
        return this.braked && s.speed < AIRBRAKE_TARGET_SPEED && s.agl > 40 && !s.grounded;
      case 'stall': {
        const level = s.speed > STALL_RECOVERY_SPEED && Math.abs(flightPathDeg(s)) < 10 && Math.abs(s.bankDeg) < 30 && !s.stalled && s.agl > 40;
        this.levelTime = level ? this.levelTime + dt : 0;
        return this.levelTime >= STALL_LEVEL_HOLD;
      }
    }
  }

  /** The contextual hint for the current situation (HTML; keys in <kbd>). */
  prompt(s: FlightSnapshot, k: PromptKeys): string {
    const key = (a: InputAction): string => {
      const pad = k.pad(a);
      return `<kbd>${escapeHtml(k.key(a))}</kbd>${pad ? ` <span class="mode-pad">(${escapeHtml(pad)})</span>` : ''}`;
    };
    if (this.status === 'complete') return 'Objective complete!';
    if (this.status === 'failed') return `${escapeHtml(this.failReason)}. Restarting…`;
    switch (this.def.id) {
      case 'takeoff':
        if (s.grounded && s.throttle < 0.95) return `Hold ${key('throttleUp')} for full throttle.`;
        if (s.grounded && s.speed < 75) return 'Accelerate down the runway to about 280 km/h…';
        if (s.grounded) return `Now raise the nose: hold ${key('pitchUp')}.`;
        if (s.gearDown) return `Positive climb – raise the gear with ${key('toggleGear')}.`;
        return 'Keep climbing gently – above 30 m.';
      case 'gear':
        if (this.gearDownTime < GEAR_DOWN_HOLD && !s.gearDown) return `Lower the landing gear with ${key('toggleGear')}.`;
        if (this.gearDownTime < GEAR_DOWN_HOLD) return 'Gear down: feel the drag slow you. Lower it only to land (it locks on the runway).';
        return `Raise the gear again with ${key('toggleGear')} to fly fast.`;
      case 'turn':
        if (this.tooLow) return `Too low! Level the wings and climb above ${TURN_MIN_AGL} m with ${key('pitchUp')}.`;
        if (Math.abs(s.bankDeg) < 35) return `No rudder: roll into a bank with ${key('rollLeft')} / ${key('rollRight')} (about 60°)…`;
        return `…then pull with ${key('pitchUp')} to turn. Turned ${Math.round(Math.abs(this.turned))}° of ${TURN_TARGET_DEG}°.`;
      case 'gates':
        if (s.gatesPassed === 0) return `Line up early: small rolls with ${key('rollLeft')} / ${key('rollRight')}, height with ${key('pitchUp')} / ${key('pitchDown')}. Follow the gate arrow.`;
        return `Gate ${s.gatesPassed}/${s.gateCount}! Level the wings before each gate, then make small corrections.`;
      case 'airbrake':
        if (!s.airbrake) return `Throttle back with ${key('throttleDown')} and hold ${key('airbrake')} for the airbrake.`;
        if (s.agl < 40) return 'Too low – raise the nose a little while you slow down.';
        return `Keep holding ${key('airbrake')}… ${Math.round(s.speed * 3.6)} km/h (target below ${Math.round(AIRBRAKE_TARGET_SPEED * 3.6)}).`;
      case 'stall':
        if (s.speed < STALL_RECOVERY_SPEED) return `Stalled! Nose down with ${key('pitchDown')} and full throttle ${key('throttleUp')}. Don't pull yet.`;
        if (Math.abs(s.bankDeg) >= 30) return `Level the wings with ${key('rollLeft')} / ${key('rollRight')}.`;
        return `Speed is back: ease out of the dive with ${key('pitchUp')} and hold level flight.`;
    }
  }
}

export const escapeHtml = (s: string): string => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

const PROGRESS_KEY = 'sfr.flightSchool.v1';

/** Lesson completion: persisted when storage works, always remembered for this session. Separate from race records. */
export class LessonProgressStore {
  private readonly done = new Set<LessonId>();

  constructor(private readonly storage: KeyValueStorage | null = browserStorage()) {
    const raw = tryGetItem(storage, PROGRESS_KEY);
    const parsed = raw ? tryParseJson(raw, 'flight school progress') : null;
    if (Array.isArray(parsed)) for (const id of parsed) if (typeof id === 'string' && getLesson(id)) this.done.add(id as LessonId);
  }

  isComplete(id: LessonId): boolean {
    return this.done.has(id);
  }

  /** Marks a lesson complete; a failed save is reported, never thrown. */
  markComplete(id: LessonId): SaveResult {
    this.done.add(id);
    return trySetItem(this.storage, PROGRESS_KEY, JSON.stringify([...this.done]));
  }
}
