import type { InputAction } from '../config/controlsConfig';
import type { GameSettings } from '../settings/Settings';
import type { FlightControls } from '../physics/types';
import { GamepadInput, type GamepadButtonAction } from './GamepadInput';
import type { KeyBindings } from './KeyBindings';
import { MouseFlight } from './MouseFlight';
import { PadBindings } from './PadBindings';
import { clamp } from '../utils/math';

export type MenuNavAction = 'up' | 'down' | 'left' | 'right' | 'confirm' | 'back';

/**
 * 'off' = rate throttle mode; 'active' = lever mode with the axis present;
 * 'missing' = lever mode but the device/axis is unavailable (rate controls take over).
 */
export type ThrottleLeverStatus = 'off' | 'active' | 'missing';

export const LEVER_LOST_MESSAGE = 'Throttle lever disconnected – keyboard throttle active';
export const LEVER_NOT_FOUND_MESSAGE = 'Throttle lever not detected – keyboard throttle active';
export const LEVER_CONNECTED_MESSAGE = 'Throttle lever connected';

/** Gamepad menu navigation auto-repeat (seconds). */
const NAV_REPEAT_DELAY = 0.4;
const NAV_REPEAT_INTERVAL = 0.12;
/** Actions keys may still trigger while a menu is open. */
const MENU_KEY_ACTIONS: ReadonlySet<InputAction> = new Set<InputAction>(['pause', 'fullscreen']);
const MENU_PAD_ACTIONS: ReadonlySet<GamepadButtonAction> = new Set<GamepadButtonAction>(['pause']);

interface KeyLikeEvent {
  code: string;
  repeat: boolean;
  target: EventTarget | null;
  preventDefault(): void;
}

/**
 * Merges keyboard (rebindable), gamepad/HOTAS and mouse flight into flight axes and one-shot
 * actions. Keyboard axes ramp smoothly so a tap gives a small input; sensitivity scales them.
 * Also tracks window focus (for auto-pause) and provides gamepad menu navigation.
 */
export class InputManager {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<InputAction>();
  private readonly gamepad: GamepadInput;
  readonly mouse: MouseFlight;
  private padState: ReturnType<GamepadInput['poll']> | null = null;
  private keyPitch = 0;
  private keyRoll = 0;
  /** When set, the next key press is reported here instead of triggering actions (key remapping). */
  captureNextKey: ((code: string) => void) | null = null;
  /** Called when a pending key capture is abandoned (menu left, pause, controller navigation). */
  captureCancelled: (() => void) | null = null;
  /** When set, the next controller button press is reported here (button remapping); Esc cancels. */
  captureNextPadButton: ((button: number) => void) | null = null;
  /** Called when a pending controller button capture is abandoned. */
  padCaptureCancelled: (() => void) | null = null;
  enabled = true;

  private menuModeOn = false;
  private readonly menuListeners = new Set<(action: MenuNavAction) => void>();
  private readonly navRepeat = { x: 0, y: 0, tx: 0, ty: 0, primed: false, confirm: false, back: false };

  private focused = true;
  private readonly focusListeners = new Set<(focused: boolean) => void>();
  private readonly doc: Document | null;

  private leverStatus: ThrottleLeverStatus = 'off';
  private leverNotice: string | null = null;
  private leverMissingNotified = false;

  private readonly padSettings: {
    deadZone: number;
    expo: number;
    invertPitch: boolean;
    throttleAxis: number;
    throttleInvert: boolean;
    throttleMin: number;
    throttleMax: number;
  };
  private readonly mouseSettings: { sensitivity: number; invertPitch: boolean };

  constructor(
    private readonly bindings: KeyBindings,
    private readonly settings: GameSettings,
    element: HTMLElement,
    private readonly target: Window = window,
    readonly padBindings: PadBindings = new PadBindings(null),
  ) {
    this.padSettings = {
      deadZone: settings.gamepadDeadZone,
      expo: settings.gamepadExpo,
      invertPitch: settings.invertPitch,
      throttleAxis: settings.throttleAxis,
      throttleInvert: settings.throttleInvert,
      throttleMin: settings.throttleMin,
      throttleMax: settings.throttleMax,
    };
    this.mouseSettings = { sensitivity: settings.mouseSensitivity, invertPitch: settings.invertPitch };
    this.gamepad = new GamepadInput(this.padSettings, padBindings);
    this.mouse = new MouseFlight(element, this.mouseSettings);
    this.doc = (target as { document?: Document }).document ?? null;
    target.addEventListener('keydown', this.onKeyDown as unknown as EventListener);
    target.addEventListener('keyup', this.onKeyUp as unknown as EventListener);
    target.addEventListener('blur', this.onBlur);
    target.addEventListener('focus', this.onFocus);
    this.doc?.addEventListener('visibilitychange', this.onVisibility);
    // Ctrl is a throttle key, so Ctrl+W (close tab) is easy to hit by accident: ask before leaving.
    target.addEventListener('beforeunload', this.onBeforeUnload);
    this.applySettings();
  }

  /** Re-read device settings (after the settings menu changed them). */
  applySettings(): void {
    const s = this.settings;
    Object.assign(this.padSettings, {
      deadZone: s.gamepadDeadZone,
      expo: s.gamepadExpo,
      invertPitch: s.invertPitch,
      throttleAxis: s.throttleAxis,
      throttleInvert: s.throttleInvert,
      throttleMin: s.throttleMin,
      throttleMax: s.throttleMax,
    });
    Object.assign(this.mouseSettings, { sensitivity: s.mouseSensitivity, invertPitch: s.invertPitch });
    if (s.mouseFlight) this.mouse.enable();
    else this.mouse.disable();
  }

  dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown as unknown as EventListener);
    this.target.removeEventListener('keyup', this.onKeyUp as unknown as EventListener);
    this.target.removeEventListener('blur', this.onBlur);
    this.target.removeEventListener('focus', this.onFocus);
    this.doc?.removeEventListener('visibilitychange', this.onVisibility);
    this.target.removeEventListener('beforeunload', this.onBeforeUnload);
    this.mouse.dispose();
    this.menuListeners.clear();
    this.focusListeners.clear();
  }

  isDown(action: InputAction): boolean {
    return this.bindings.get(action).some((code) => this.down.has(code)) || this.padHeld(action);
  }

  /** Hold-type gamepad buttons (airbrake, gun trigger, missile button for a locked launch). */
  private padHeld(action: InputAction): boolean {
    const pad = this.padState;
    if (!pad) return false;
    if (action === 'airbrake') return pad.airbrakeHeld;
    if (action === 'fireGun') return pad.fireGunHeld;
    if (action === 'fireMissile') return pad.fireMissileHeld;
    return false;
  }

  /** True once per key/button press. */
  consumePressed(action: InputAction): boolean {
    const was = this.pressed.has(action);
    this.pressed.delete(action);
    return was;
  }

  /**
   * Drops every held key, queued one-shot press, mouse virtual-stick deflection and gamepad edge
   * state. Keys / buttons still physically held must be released before they act again.
   */
  releaseAll(): void {
    this.down.clear();
    this.pressed.clear();
    this.keyPitch = 0;
    this.keyRoll = 0;
    this.mouse.release();
    this.gamepad.suppressHeld();
    if (this.padState) {
      this.padState.airbrakeHeld = false;
      this.padState.fireGunHeld = false;
      this.padState.fireMissileHeld = false;
    }
  }

  // ------------------------------------------------------------ menus

  get menuMode(): boolean {
    return this.menuModeOn;
  }

  /**
   * Call with true while a menu is on screen. Menu mode leaves Tab/Enter/Space/arrows to the
   * browser (focusable buttons), only lets keys trigger pause/fullscreen, turns the gamepad into a
   * menu navigator (see onMenuNavigate) and clears all input on every change so menu keys can't
   * leak into flight. Idempotent: safe to call every frame.
   */
  setMenuMode(on: boolean): void {
    if (on === this.menuModeOn) return;
    this.menuModeOn = on;
    this.releaseAll();
    this.navRepeat.primed = false;
  }

  /**
   * Gamepad menu navigation (only while menu mode is on): d-pad / left stick with auto-repeat,
   * A (button 0) = confirm, B (button 1) = back. Returns an unsubscribe function.
   */
  onMenuNavigate(cb: (action: MenuNavAction) => void): () => void {
    this.menuListeners.add(cb);
    return () => void this.menuListeners.delete(cb);
  }

  // ------------------------------------------------------------ focus

  /** False while the page is hidden or the window doesn't have focus. */
  get hasFocus(): boolean {
    return this.focused;
  }

  /**
   * Called with false when the page is hidden / the window loses focus (after all input was
   * released) and with true when it comes back. Repeated browser events are de-duplicated.
   */
  onFocusChange(cb: (focused: boolean) => void): () => void {
    this.focusListeners.add(cb);
    return () => void this.focusListeners.delete(cb);
  }

  // ------------------------------------------------------------ throttle lever

  get throttleLeverStatus(): ThrottleLeverStatus {
    return this.leverStatus;
  }

  /** Calibrated lever position 0..1 from the configured axis (in any throttle mode), if present. */
  get throttleLever(): number | null {
    return this.padState?.throttleAbsolute ?? null;
  }

  /** Raw value of the configured lever axis, for calibration. */
  get throttleLeverRaw(): number | null {
    return this.padState?.throttleRaw ?? null;
  }

  /** A one-time player notice about the lever (lost / not found / reconnected), or null. */
  consumeThrottleLeverNotice(): string | null {
    const n = this.leverNotice;
    this.leverNotice = null;
    return n;
  }

  /** Poll gamepad and mouse once per frame. */
  poll(dt: number): void {
    this.padState = this.gamepad.poll();
    if (this.captureNextPadButton) {
      // Remapping: the first new button press is the answer; nothing else (menu nav, actions) sees it.
      const button = this.padState.buttonsPressed[0];
      if (button !== undefined) {
        const cb = this.captureNextPadButton;
        this.captureNextPadButton = null;
        this.padCaptureCancelled = null;
        cb(button);
        this.gamepad.suppressHeld();
      }
      this.navRepeat.primed = false;
    } else {
      for (const a of this.padState.pressed) {
        if (!this.menuModeOn || MENU_PAD_ACTIONS.has(a)) this.pressed.add(a);
      }
      if (this.menuModeOn) this.pollMenuNav(dt);
    }
    this.updateLeverStatus();
    this.mouse.update(dt);
    const axis = (neg: InputAction, pos: InputAction): number => (this.isDown(pos) ? 1 : 0) - (this.isDown(neg) ? 1 : 0);
    const ramp = (current: number, target: number): number => {
      const rate = target === 0 || Math.sign(target) !== Math.sign(current) ? 12 : 5;
      const step = rate * Math.max(0, dt);
      return clamp(current + clamp(target - current, -step, step), -1, 1);
    };
    this.keyPitch = ramp(this.keyPitch, axis('pitchDown', 'pitchUp'));
    this.keyRoll = ramp(this.keyRoll, axis('rollLeft', 'rollRight'));
  }

  get gamepadConnected(): boolean {
    return !!this.padState?.connected;
  }

  /** True on a frame where any controller button went down (menus included). */
  get gamepadActivity(): boolean {
    return !!this.padState?.anyPressed;
  }

  getFlightControls(): FlightControls {
    const s = this.settings;
    if (!this.enabled) return { pitch: 0, roll: 0, throttle: 0 };
    let pitch = this.keyPitch * (s.invertPitch ? -1 : 1);
    let roll = this.keyRoll;
    let throttle = (this.isDown('throttleUp') ? 1 : 0) - (this.isDown('throttleDown') ? 1 : 0);
    const pad = this.padState;
    if (pad?.connected) {
      pitch += pad.pitch;
      roll += pad.roll;
      throttle += pad.throttleRate;
    }
    if (this.mouse.enabled) {
      const m = this.mouse.get();
      pitch += m.pitch;
      roll += m.roll;
      throttle += this.mouse.consumeThrottleDelta() * 8;
    }
    const out: FlightControls = {
      pitch: clamp(pitch * s.stickSensitivity, -1, 1),
      roll: clamp(roll * s.stickSensitivity, -1, 1),
      throttle: clamp(throttle, -1, 1),
    };
    // Lever mode: the lever is authoritative; the other throttle inputs only act while it's missing.
    if (this.leverStatus === 'active' && pad?.throttleAbsolute != null) {
      out.throttle = 0;
      out.throttleLever = pad.throttleAbsolute;
    }
    return out;
  }

  private updateLeverStatus(): void {
    if (this.settings.throttleMode !== 'lever') {
      this.leverStatus = 'off';
      this.leverNotice = null;
      this.leverMissingNotified = false;
      return;
    }
    const available = this.padState?.throttleAbsolute != null;
    const prev = this.leverStatus;
    this.leverStatus = available ? 'active' : 'missing';
    if (this.leverStatus === prev) return;
    if (!available) {
      this.leverNotice = prev === 'active' ? LEVER_LOST_MESSAGE : LEVER_NOT_FOUND_MESSAGE;
      this.leverMissingNotified = true;
    } else {
      this.leverNotice = prev === 'missing' && this.leverMissingNotified ? LEVER_CONNECTED_MESSAGE : null;
      this.leverMissingNotified = false;
    }
  }

  private pollMenuNav(dt: number): void {
    const pad = this.padState;
    const n = this.navRepeat;
    const x = pad?.navX ?? 0;
    const y = pad?.navY ?? 0;
    const confirm = !!pad?.confirmHeld;
    const back = !!pad?.backHeld;
    if (!n.primed) {
      // A direction already held when the menu opened waits for the auto-repeat delay.
      Object.assign(n, { x, y, tx: NAV_REPEAT_DELAY, ty: NAV_REPEAT_DELAY, primed: true, confirm, back });
      return;
    }
    const step = (cur: number, prev: number, timer: number, neg: MenuNavAction, pos: MenuNavAction): number => {
      if (cur === 0) return NAV_REPEAT_DELAY;
      if (cur !== prev) {
        this.emitMenu(cur > 0 ? pos : neg);
        return NAV_REPEAT_DELAY;
      }
      const left = timer - Math.max(0, dt);
      if (left > 0) return left;
      this.emitMenu(cur > 0 ? pos : neg);
      return NAV_REPEAT_INTERVAL;
    };
    n.ty = step(y, n.y, n.ty, 'up', 'down');
    n.tx = step(x, n.x, n.tx, 'left', 'right');
    n.x = x;
    n.y = y;
    if (confirm && !n.confirm) this.emitMenu('confirm');
    if (back && !n.back) this.emitMenu('back');
    n.confirm = confirm;
    n.back = back;
  }

  private emitMenu(action: MenuNavAction): void {
    for (const cb of [...this.menuListeners]) cb(action);
  }

  private setFocused(focused: boolean): void {
    if (focused === this.focused) return;
    this.focused = focused;
    if (!focused) this.releaseAll();
    for (const cb of [...this.focusListeners]) cb(focused);
  }

  /** Abandons a pending key capture without rebinding anything. */
  cancelKeyCapture(): void {
    if (!this.captureNextKey) return;
    const cancelled = this.captureCancelled;
    this.captureNextKey = null;
    this.captureCancelled = null;
    cancelled?.();
  }

  /** Abandons a pending controller button capture without rebinding anything. */
  cancelPadCapture(): void {
    if (!this.captureNextPadButton) return;
    const cancelled = this.padCaptureCancelled;
    this.captureNextPadButton = null;
    this.padCaptureCancelled = null;
    cancelled?.();
  }

  /** True while waiting for a key or controller button to remap. */
  get capturing(): boolean {
    return this.captureNextKey !== null || this.captureNextPadButton !== null;
  }

  /** Abandons any pending key / button capture. */
  cancelCapture(): void {
    this.cancelKeyCapture();
    this.cancelPadCapture();
  }

  private readonly onKeyDown = (e: KeyLikeEvent): void => {
    if (this.captureNextPadButton && e.code === 'Escape') {
      e.preventDefault();
      this.cancelPadCapture();
      return;
    }
    if (this.captureNextKey) {
      e.preventDefault();
      const cb = this.captureNextKey;
      this.captureNextKey = null;
      this.captureCancelled = null;
      cb(e.code);
      return;
    }
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
    const actions = this.bindings.actionsFor(e.code);
    if (this.menuModeOn) {
      // Navigation keys stay with the focused menu controls; nothing is held for flight.
      if (!e.repeat) for (const a of actions) if (MENU_KEY_ACTIONS.has(a)) this.pressed.add(a);
      return;
    }
    if (actions.length > 0) e.preventDefault();
    // Auto-repeat of a key held across a pause / menu / focus change: ignored until re-pressed.
    if (e.repeat && !this.down.has(e.code)) return;
    if (!e.repeat) for (const a of actions) this.pressed.add(a);
    this.down.add(e.code);
  };

  private readonly onKeyUp = (e: KeyLikeEvent): void => {
    this.down.delete(e.code);
  };

  private readonly onBlur = (): void => {
    this.setFocused(false);
  };

  private readonly onFocus = (): void => {
    if (this.doc?.visibilityState !== 'hidden') this.setFocused(true);
  };

  private readonly onVisibility = (): void => {
    if (this.doc?.visibilityState === 'hidden') this.setFocused(false);
    else if (this.doc?.hasFocus?.() !== false) this.setFocused(true);
  };

  private readonly onBeforeUnload = (e: Event): void => {
    if (this.isDown('throttleDown')) e.preventDefault();
  };
}
