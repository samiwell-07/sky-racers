import { applyDeadZone, applyExpo } from './inputCurves';

export interface AxisSettings {
  deadZone: number;
  expo: number;
  invertPitch: boolean;
  /** HOTAS lever: gamepad axis index (default 2). */
  throttleAxis?: number;
  throttleInvert?: boolean;
  /** Calibrated raw axis values at idle (→ 0) and full throttle (→ 1). */
  throttleMin?: number;
  throttleMax?: number;
}

export type GamepadButtonAction =
  | 'toggleCamera'
  | 'respawn'
  | 'pause'
  | 'toggleGear'
  | 'airbrake'
  | 'fireGun'
  | 'fireMissile'
  | 'releaseFlares'
  | 'radarZoom';

export interface GamepadState {
  connected: boolean;
  id: string;
  /** +1 = nose up. */
  pitch: number;
  /** +1 = roll right. */
  roll: number;
  /** Rate of throttle lever change, -1..1 (standard-mapping triggers). */
  throttleRate: number;
  /** Raw value of the configured throttle axis, or null when the pad or axis is missing. */
  throttleRaw: number | null;
  /** Calibrated lever position 0..1 from the configured throttle axis, or null when not available. */
  throttleAbsolute: number | null;
  /** Buttons that went down since the previous poll. */
  pressed: Set<GamepadButtonAction>;
  /** True while the airbrake button is held. */
  airbrakeHeld: boolean;
  /** True while the gun (RB) / missile (LB) buttons are held. */
  fireGunHeld: boolean;
  fireMissileHeld: boolean;
  /** Menu navigation: held direction from the d-pad or left stick (-1, 0, 1; +y = down). */
  navX: number;
  navY: number;
  /** Menu confirm (A / button 0) and back (B / button 1) held. */
  confirmHeld: boolean;
  backHeld: boolean;
}

export interface LeverCalibration {
  min: number;
  max: number;
  invert: boolean;
}

/** Button indices (W3C standard mapping; also used as a best guess for non-standard devices). */
const BUTTON_ACTIONS: ReadonlyArray<readonly [number, GamepadButtonAction]> = [
  [0, 'airbrake'],
  [1, 'toggleGear'],
  [3, 'toggleCamera'],
  [8, 'respawn'],
  [9, 'pause'],
  [5, 'fireGun'],
  [4, 'fireMissile'],
  [2, 'releaseFlares'],
  [13, 'radarZoom'],
];
const AIRBRAKE_BUTTON = 0;
const FIRE_GUN_BUTTON = 5;
const FIRE_MISSILE_BUTTON = 4;
const CONFIRM_BUTTON = 0;
const BACK_BUTTON = 1;
const LT_BUTTON = 6;
const RT_BUTTON = 7;
const DPAD_UP = 12;
const DPAD_DOWN = 13;
const DPAD_LEFT = 14;
const DPAD_RIGHT = 15;
const TRIGGER_DEAD_ZONE = 0.05;
const NAV_STICK_THRESHOLD = 0.5;
/** Calibration spans smaller than this are treated as uncalibrated (full -1..1 range). */
const MIN_CALIBRATION_SPAN = 0.05;

/**
 * Maps a raw lever axis value to 0..1: calibrated idle → 0, full → 1 (either may be the larger
 * raw value), the midpoint → 0.5, clamped outside the calibrated range. `invert` flips the result.
 */
export function mapThrottleLever(raw: number, cal: LeverCalibration): number {
  let min = cal.min;
  let max = cal.max;
  if (!Number.isFinite(min) || !Number.isFinite(max) || Math.abs(max - min) < MIN_CALIBRATION_SPAN) {
    min = -1;
    max = 1;
  }
  const v = Math.min(Math.max((raw - min) / (max - min), 0), 1);
  return cal.invert ? 1 - v : v;
}

function disconnected(): GamepadState {
  return {
    connected: false,
    id: '',
    pitch: 0,
    roll: 0,
    throttleRate: 0,
    throttleRaw: null,
    throttleAbsolute: null,
    pressed: new Set(),
    airbrakeHeld: false,
    fireGunHeld: false,
    fireMissileHeld: false,
    navX: 0,
    navY: 0,
    confirmHeld: false,
    backHeld: false,
  };
}

function buttonDown(pad: Gamepad, index: number): boolean {
  const b = pad.buttons[index];
  return !!b && (b.pressed || b.value > 0.5);
}

function buttonValue(pad: Gamepad, index: number): number {
  const b = pad.buttons[index];
  if (!b) return 0;
  const v = Math.max(b.value, b.pressed ? 1 : 0);
  return v > TRIGGER_DEAD_ZONE ? v : 0;
}

function axis(pad: Gamepad, index: number): number {
  const v = pad.axes[index];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export class GamepadInput {
  private readonly prevButtons = new Map<number, boolean[]>();
  /** Buttons held when input was cleared: ignored until released. */
  private readonly latched = new Set<number>();
  private latchPending = false;

  constructor(private readonly settings: AxisSettings) {}

  /**
   * Forget edge state: buttons held right now count as "up" until they are released, so a button
   * held across a pause / menu / focus change can't fire a press or hold an action afterwards.
   */
  suppressHeld(): void {
    this.latchPending = true;
  }

  poll(): GamepadState {
    const pad = this.findGamepad();
    if (!pad) {
      this.prevButtons.clear();
      this.latched.clear();
      this.latchPending = false;
      return disconnected();
    }

    const shape = (v: number): number => applyExpo(applyDeadZone(v, this.settings.deadZone), this.settings.expo);
    // Stick pulled back reads positive Y on both standard pads and joysticks -> nose up.
    const pitchSign = this.settings.invertPitch ? -1 : 1;
    const roll = shape(axis(pad, 0));
    const pitch = pitchSign * shape(axis(pad, 1));

    let throttleRate = 0;
    if (pad.mapping === 'standard') {
      throttleRate = buttonValue(pad, RT_BUTTON) - buttonValue(pad, LT_BUTTON);
    }
    const leverAxis = this.settings.throttleAxis ?? 2;
    const rawValue = pad.axes[leverAxis];
    const throttleRaw = typeof rawValue === 'number' && Number.isFinite(rawValue) ? rawValue : null;
    const throttleAbsolute =
      throttleRaw === null
        ? null
        : mapThrottleLever(throttleRaw, {
            min: this.settings.throttleMin ?? -1,
            max: this.settings.throttleMax ?? 1,
            invert: !!this.settings.throttleInvert,
          });

    const raw = pad.buttons.map((_, i) => buttonDown(pad, i));
    if (this.latchPending) {
      this.latchPending = false;
      this.latched.clear();
      raw.forEach((d, i) => d && this.latched.add(i));
    }
    for (const i of [...this.latched]) if (!raw[i]) this.latched.delete(i);
    const now = raw.map((d, i) => d && !this.latched.has(i));

    const prev = this.prevButtons.get(pad.index) ?? [];
    const pressed = new Set<GamepadButtonAction>();
    for (const [index, action] of BUTTON_ACTIONS) {
      if (now[index] && !prev[index]) pressed.add(action);
    }
    this.prevButtons.clear();
    this.prevButtons.set(pad.index, now);

    const lx = axis(pad, 0);
    const ly = axis(pad, 1);
    const dir = (neg: boolean, pos: boolean, stick: number): number =>
      pos || stick > NAV_STICK_THRESHOLD ? 1 : neg || stick < -NAV_STICK_THRESHOLD ? -1 : 0;

    return {
      connected: true,
      id: pad.id,
      pitch,
      roll,
      throttleRate: Math.min(Math.max(throttleRate, -1), 1),
      throttleRaw,
      throttleAbsolute,
      pressed,
      airbrakeHeld: !!now[AIRBRAKE_BUTTON],
      fireGunHeld: !!now[FIRE_GUN_BUTTON],
      fireMissileHeld: !!now[FIRE_MISSILE_BUTTON],
      navX: dir(!!now[DPAD_LEFT], !!now[DPAD_RIGHT], lx),
      navY: dir(!!now[DPAD_UP], !!now[DPAD_DOWN], ly),
      confirmHeld: !!now[CONFIRM_BUTTON],
      backHeld: !!now[BACK_BUTTON],
    };
  }

  private findGamepad(): Gamepad | null {
    try {
      const nav = (globalThis as { navigator?: Navigator }).navigator;
      if (!nav || typeof nav.getGamepads !== 'function') return null;
      const pads = nav.getGamepads();
      if (!pads) return null;
      for (const pad of pads) if (pad && pad.connected) return pad;
    } catch {
      // getGamepads can throw in insecure contexts / restrictive permission policies
    }
    return null;
  }
}
