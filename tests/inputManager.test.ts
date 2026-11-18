import { Quaternion, Vector3 } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFlightConfig } from '../src/config/flightConfig';
import { mapThrottleLever } from '../src/input/GamepadInput';
import {
  InputManager,
  LEVER_LOST_MESSAGE,
  LEVER_NOT_FOUND_MESSAGE,
  type MenuNavAction,
} from '../src/input/InputManager';
import { KeyBindings } from '../src/input/KeyBindings';
import { PadBindings } from '../src/input/PadBindings';
import { FlightModel } from '../src/physics/FlightModel';
import { DEFAULT_SETTINGS, type GameSettings } from '../src/settings/Settings';

interface FakePad {
  id: string;
  index: number;
  connected: boolean;
  mapping: string;
  axes: number[];
  buttons: Array<{ pressed: boolean; value: number }>;
}

let pads: Array<FakePad | null> = [];

function pad(axes: number[], mapping = '', pressedButtons: number[] = []): FakePad {
  const buttons = Array.from({ length: 17 }, (_, i) => ({ pressed: pressedButtons.includes(i), value: pressedButtons.includes(i) ? 1 : 0 }));
  return { id: 'Test pad', index: 0, connected: true, mapping, axes, buttons };
}

class FakeDocument extends EventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible';
  focus = true;
  hasFocus(): boolean {
    return this.focus;
  }
}

class FakeWindow extends EventTarget {
  readonly document = new FakeDocument();
}

function key(type: 'keydown' | 'keyup', code: string, repeat = false): Event & { prevented: boolean } {
  const e = new Event(type, { cancelable: true }) as Event & { prevented: boolean };
  Object.defineProperty(e, 'code', { value: code });
  Object.defineProperty(e, 'repeat', { value: repeat });
  Object.defineProperty(e, 'prevented', { get: () => e.defaultPrevented });
  return e;
}

function setup(overrides: Partial<GameSettings> = {}) {
  const settings: GameSettings = { ...DEFAULT_SETTINGS, mouseFlight: false, ...overrides };
  const win = new FakeWindow();
  const input = new InputManager(new KeyBindings(null), settings, {} as HTMLElement, win as unknown as Window);
  return { input, win, settings };
}

beforeEach(() => {
  pads = [];
  vi.stubGlobal('navigator', { getGamepads: () => pads });
});
afterEach(() => vi.unstubAllGlobals());

describe('throttle lever mapping', () => {
  it('maps calibrated endpoints to 0 and 1 and the midpoint to 0.5', () => {
    expect(mapThrottleLever(-1, { min: -1, max: 1, invert: false })).toBe(0);
    expect(mapThrottleLever(1, { min: -1, max: 1, invert: false })).toBe(1);
    expect(mapThrottleLever(0, { min: -1, max: 1, invert: false })).toBeCloseTo(0.5);
    // Reversed calibration (forward reads negative) and a partial range.
    const cal = { min: 0.8, max: -0.9, invert: false };
    expect(mapThrottleLever(0.8, cal)).toBe(0);
    expect(mapThrottleLever(-0.9, cal)).toBe(1);
    expect(mapThrottleLever(-0.05, cal)).toBeCloseTo(0.5);
    expect(mapThrottleLever(1, cal)).toBe(0);
    expect(mapThrottleLever(-1, cal)).toBe(1);
  });

  it('inverts and falls back to the full range for a degenerate calibration', () => {
    expect(mapThrottleLever(-1, { min: -1, max: 1, invert: true })).toBe(1);
    expect(mapThrottleLever(1, { min: -1, max: 1, invert: true })).toBe(0);
    expect(mapThrottleLever(0.5, { min: 0.2, max: 0.2, invert: false })).toBeCloseTo(0.75);
  });
});

describe('InputManager throttle lever', () => {
  it('lever mode: the configured axis is authoritative over keyboard throttle', () => {
    const { input, win } = setup({ throttleMode: 'lever', throttleAxis: 3 });
    pads = [pad([0, 0, 0.9, 1])];
    win.dispatchEvent(key('keydown', 'ControlLeft'));
    input.poll(1 / 60);
    expect(input.throttleLeverStatus).toBe('active');
    expect(input.getFlightControls()).toMatchObject({ throttle: 0, throttleLever: 1 });
    pads = [pad([0, 0, 0.9, -1])];
    input.poll(1 / 60);
    expect(input.getFlightControls().throttleLever).toBe(0);
    pads = [pad([0, 0, 0.9, 0])];
    input.poll(1 / 60);
    expect(input.getFlightControls().throttleLever).toBeCloseTo(0.5);
  });

  it('applies inversion and calibration from settings', () => {
    const { input, settings } = setup({ throttleMode: 'lever', throttleMin: 1, throttleMax: -1 });
    pads = [pad([0, 0, -1])];
    input.poll(1 / 60);
    expect(input.getFlightControls().throttleLever).toBe(1);
    settings.throttleInvert = true;
    input.applySettings();
    input.poll(1 / 60);
    expect(input.getFlightControls().throttleLever).toBe(0);
    expect(input.throttleLeverRaw).toBe(-1);
  });

  it('missing axis: falls back to rate controls and reports it once', () => {
    const { input, win } = setup({ throttleMode: 'lever', throttleAxis: 5 });
    pads = [pad([0, 0, 0.3])];
    input.poll(1 / 60);
    expect(input.throttleLeverStatus).toBe('missing');
    expect(input.consumeThrottleLeverNotice()).toBe(LEVER_NOT_FOUND_MESSAGE);
    expect(input.consumeThrottleLeverNotice()).toBeNull();
    win.dispatchEvent(key('keydown', 'ArrowUp'));
    input.poll(1 / 60);
    const c = input.getFlightControls();
    expect(c.throttle).toBe(1);
    expect(c.throttleLever).toBeUndefined();
  });

  it('disconnect: keeps the last throttle, enables rate controls and notifies once', () => {
    const { input, win } = setup({ throttleMode: 'lever' });
    const model = new FlightModel(createFlightConfig());
    model.reset({ position: new Vector3(0, 1000, 0), orientation: new Quaternion(), speed: 150, throttle: 0.2 });
    pads = [pad([0, 0, 0.6])]; // 80 %
    for (let i = 0; i < 240; i++) {
      input.poll(1 / 120);
      model.step(1 / 120, input.getFlightControls());
    }
    expect(model.state.throttle).toBeCloseTo(0.8, 5);
    expect(input.consumeThrottleLeverNotice()).toBeNull();

    pads = [];
    for (let i = 0; i < 120; i++) {
      input.poll(1 / 120);
      model.step(1 / 120, input.getFlightControls());
    }
    expect(input.throttleLeverStatus).toBe('missing');
    expect(model.state.throttle).toBeCloseTo(0.8, 5);
    expect(input.consumeThrottleLeverNotice()).toBe(LEVER_LOST_MESSAGE);
    expect(input.consumeThrottleLeverNotice()).toBeNull();

    win.dispatchEvent(key('keydown', 'ArrowDown'));
    input.poll(1 / 120);
    model.step(1 / 120, input.getFlightControls());
    expect(model.state.throttle).toBeLessThan(0.8);
  });

  it('rate mode is unchanged: triggers and keys drive the rate, the lever is ignored', () => {
    const { input, win } = setup();
    pads = [pad([0, 0, -1, 0], 'standard', [7])];
    input.poll(1 / 60);
    expect(input.throttleLeverStatus).toBe('off');
    expect(input.getFlightControls()).toEqual({ pitch: 0, roll: 0, throttle: 1 });
    pads = [pad([0, 0, -1])]; // non-standard HOTAS in rate mode: no throttle input, as before
    input.poll(1 / 60);
    expect(input.getFlightControls()).toEqual({ pitch: 0, roll: 0, throttle: 0 });
    win.dispatchEvent(key('keydown', 'ControlLeft'));
    expect(input.getFlightControls().throttle).toBe(-1);
    expect(input.consumeThrottleLeverNotice()).toBeNull();
  });
});

describe('FlightModel throttle lever', () => {
  it('follows the lever at twice throttleRate and ignores the rate input', () => {
    const config = createFlightConfig();
    const model = new FlightModel(config);
    model.reset({ position: new Vector3(0, 1000, 0), orientation: new Quaternion(), speed: 150, throttle: 0 });
    for (let i = 0; i < 30; i++) model.step(1 / 120, { pitch: 0, roll: 0, throttle: -1, throttleLever: 1 });
    expect(model.state.throttle).toBeCloseTo(config.throttleRate * 2 * 0.25, 5);
    for (let i = 0; i < 600; i++) model.step(1 / 120, { pitch: 0, roll: 0, throttle: 1, throttleLever: 0.5 });
    expect(model.state.throttle).toBeCloseTo(0.5, 5);
  });
});

describe('InputManager focus loss', () => {
  it('releases held keys and one-shot presses once per blur, and reports focus return', () => {
    const { input, win } = setup();
    const events: boolean[] = [];
    input.onFocusChange((f) => events.push(f));
    win.dispatchEvent(key('keydown', 'ArrowUp'));
    win.dispatchEvent(key('keydown', 'KeyR'));
    input.poll(0.5);
    expect(input.getFlightControls().throttle).toBe(1);

    win.dispatchEvent(new Event('blur'));
    win.dispatchEvent(new Event('blur'));
    win.document.visibilityState = 'hidden';
    win.document.dispatchEvent(new Event('visibilitychange'));
    expect(events).toEqual([false]);
    expect(input.hasFocus).toBe(false);
    input.poll(1 / 60);
    expect(input.getFlightControls()).toEqual({ pitch: 0, roll: 0, throttle: 0 });
    expect(input.consumePressed('respawn')).toBe(false);

    win.document.visibilityState = 'visible';
    win.document.dispatchEvent(new Event('visibilitychange'));
    win.dispatchEvent(new Event('focus'));
    expect(events).toEqual([false, true]);

    // A key still held from before only acts again after it is re-pressed.
    win.dispatchEvent(key('keydown', 'ArrowUp', true));
    expect(input.getFlightControls().throttle).toBe(0);
    win.dispatchEvent(key('keyup', 'ArrowUp'));
    win.dispatchEvent(key('keydown', 'ArrowUp'));
    expect(input.getFlightControls().throttle).toBe(1);
  });

  it('a gamepad button held across focus loss fires nothing until released', () => {
    const { input, win } = setup();
    pads = [pad([0, 0], 'standard', [0])];
    input.poll(1 / 60);
    expect(input.isDown('airbrake')).toBe(true);
    win.dispatchEvent(new Event('blur'));
    pads = [pad([0, 0], 'standard', [0, 3])];
    input.poll(1 / 60);
    expect(input.isDown('airbrake')).toBe(false);
    expect(input.consumePressed('toggleCamera')).toBe(false);
    pads = [pad([0, 0], 'standard')];
    input.poll(1 / 60);
    pads = [pad([0, 0], 'standard', [0])];
    input.poll(1 / 60);
    expect(input.isDown('airbrake')).toBe(true);
  });
});

describe('InputManager gamepad actions', () => {
  it('d-pad up / left toggle lights and help, and any button press is reported as activity', () => {
    const { input } = setup();
    pads = [pad([0, 0], 'standard')];
    input.poll(1 / 60);
    expect(input.gamepadActivity).toBe(false);
    pads = [pad([0, 0], 'standard', [12, 14])];
    input.poll(1 / 60);
    expect(input.consumePressed('toggleLights')).toBe(true);
    expect(input.consumePressed('toggleHelp')).toBe(true);
    expect(input.gamepadActivity).toBe(true);
    pads = [pad([0, 0], 'standard', [12, 14])];
    input.poll(1 / 60);
    expect(input.gamepadActivity).toBe(false);
    expect(input.consumePressed('toggleLights')).toBe(false);
  });

  it('follows remapped buttons, including held and analog throttle buttons', () => {
    const padBindings = new PadBindings(null);
    padBindings.rebind('fireGun', 0); // A: airbrake becomes unbound
    padBindings.rebind('throttleUp', 5); // RB
    const input = new InputManager(new KeyBindings(null), { ...DEFAULT_SETTINGS, mouseFlight: false }, {} as HTMLElement, new FakeWindow() as unknown as Window, padBindings);
    pads = [pad([0, 0], 'standard', [0, 5])];
    input.poll(1 / 60);
    expect(input.isDown('fireGun')).toBe(true);
    expect(input.isDown('airbrake')).toBe(false);
    expect(input.getFlightControls().throttle).toBe(1);
    // Non-standard device: a remapped throttle button still works.
    pads = [pad([0, 0], '', [5])];
    input.poll(1 / 60);
    expect(input.getFlightControls().throttle).toBe(1);
  });

  it('captures the next button press for remapping without navigating the menu', () => {
    const { input } = setup();
    const nav: MenuNavAction[] = [];
    input.onMenuNavigate((a) => nav.push(a));
    input.setMenuMode(true);
    pads = [pad([0, 0], 'standard', [0])]; // A still held from choosing "Change"
    input.poll(1 / 60);
    const got: number[] = [];
    input.captureNextPadButton = (b) => got.push(b);
    input.poll(1 / 60);
    expect(got).toEqual([]);
    pads = [pad([0, 0], 'standard', [0, 13])];
    input.poll(1 / 60);
    expect(got).toEqual([13]);
    expect(input.capturing).toBe(false);
    pads = [pad([0, 0], 'standard')];
    input.poll(1 / 60);
    input.poll(1 / 60);
    expect(nav).toEqual([]);
  });

  it('Escape cancels a pending button capture', () => {
    const { input, win } = setup();
    let cancelled = false;
    input.captureNextPadButton = () => {};
    input.padCaptureCancelled = () => (cancelled = true);
    win.dispatchEvent(key('keydown', 'Escape'));
    expect(cancelled).toBe(true);
    expect(input.capturing).toBe(false);
    expect(input.consumePressed('pause')).toBe(false);
  });
});

describe('InputManager menu mode', () => {
  it('leaves navigation keys to the menu and only passes pause through', () => {
    const { input, win } = setup();
    win.dispatchEvent(key('keydown', 'KeyR'));
    input.setMenuMode(true);
    expect(input.consumePressed('respawn')).toBe(false);
    for (const code of ['ArrowUp', 'Enter', 'Tab', 'Space']) {
      const e = key('keydown', code);
      win.dispatchEvent(e);
      expect(e.prevented).toBe(false);
    }
    win.dispatchEvent(key('keydown', 'KeyG'));
    win.dispatchEvent(key('keydown', 'Escape'));
    input.poll(1 / 60);
    expect(input.getFlightControls().throttle).toBe(0);
    expect(input.consumePressed('toggleGear')).toBe(false);
    expect(input.consumePressed('pause')).toBe(true);

    // Held menu keys don't leak into flight once the menu closes.
    input.setMenuMode(false);
    win.dispatchEvent(key('keydown', 'ArrowUp', true));
    expect(input.getFlightControls().throttle).toBe(0);
    const e = key('keydown', 'ArrowUp');
    win.dispatchEvent(e);
    expect(e.prevented).toBe(true);
  });

  it('navigates with d-pad / stick (with repeat) and confirms / backs with A / B', () => {
    const { input } = setup();
    const nav: MenuNavAction[] = [];
    const off = input.onMenuNavigate((a) => nav.push(a));
    pads = [pad([0, 0], 'standard', [13])];
    input.poll(1 / 60);
    expect(nav).toEqual([]); // menu mode off

    pads = [pad([0, 0], 'standard')];
    input.setMenuMode(true);
    input.poll(1 / 60);
    pads = [pad([0, 0], 'standard', [13])];
    input.poll(1 / 60);
    expect(nav).toEqual(['down']);
    input.poll(0.3);
    expect(nav).toEqual(['down']);
    input.poll(0.15);
    input.poll(0.13);
    expect(nav).toEqual(['down', 'down', 'down']);

    pads = [pad([0.9, 0], 'standard')];
    input.poll(1 / 60);
    pads = [pad([0, 0], 'standard', [0])];
    input.poll(1 / 60);
    input.poll(1 / 60);
    pads = [pad([0, 0], 'standard', [1])];
    input.poll(1 / 60);
    expect(nav).toEqual(['down', 'down', 'down', 'right', 'confirm', 'back']);
    expect(input.consumePressed('airbrake')).toBe(false);
    expect(input.consumePressed('toggleGear')).toBe(false);

    off();
    pads = [pad([0, -1], 'standard')];
    input.poll(1 / 60);
    expect(nav).toHaveLength(6);
  });

  it('the button that confirms in a menu does not act in flight until released', () => {
    const { input } = setup();
    input.setMenuMode(true);
    pads = [pad([0, 0], 'standard', [0])];
    input.poll(1 / 60);
    input.setMenuMode(false);
    input.poll(1 / 60);
    expect(input.isDown('airbrake')).toBe(false);
    expect(input.consumePressed('airbrake')).toBe(false);
  });
});
