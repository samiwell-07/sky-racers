import type { InputAction } from '../config/controlsConfig';
import type { BindingStorage } from './KeyBindings';

/** Actions a controller button can be bound to (sticks and menu navigation are fixed). */
export const PAD_ACTIONS = [
  'throttleUp',
  'throttleDown',
  'airbrake',
  'toggleGear',
  'toggleLights',
  'toggleCamera',
  'respawn',
  'pause',
  'toggleHelp',
  'radarZoom',
  'fireGun',
  'fireMissile',
  'releaseFlares',
] as const satisfies readonly InputAction[];

export type PadAction = (typeof PAD_ACTIONS)[number];

/** Default buttons (W3C standard gamepad mapping indices). */
export const DEFAULT_PAD_BINDINGS: Readonly<Record<PadAction, number>> = {
  throttleUp: 7,
  throttleDown: 6,
  airbrake: 0,
  toggleGear: 1,
  toggleLights: 12,
  toggleCamera: 3,
  respawn: 8,
  pause: 9,
  toggleHelp: 14,
  radarZoom: 13,
  fireGun: 5,
  fireMissile: 4,
  releaseFlares: 2,
};

/** Fixed (non-rebindable) controller hints. */
const STICK_HINTS: Partial<Record<InputAction, string>> = {
  pitchUp: 'left stick ↕',
  pitchDown: 'left stick ↕',
  rollLeft: 'left stick ↔',
  rollRight: 'left stick ↔',
};

const STORAGE_KEY = 'sfr.padbindings';
const MAX_BUTTON = 31;

const BUTTON_LABELS = [
  'A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'L-stick click', 'R-stick click',
  'D-pad ↑', 'D-pad ↓', 'D-pad ←', 'D-pad →', 'Home',
];

/** Label of a standard-mapping button index (other devices show the raw number). */
export function padButtonLabel(index: number): string {
  return BUTTON_LABELS[index] ?? `Button ${index}`;
}

const isPadAction = (a: string): a is PadAction => (PAD_ACTIONS as readonly string[]).includes(a);

function defaultStorage(): BindingStorage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

/** Persisted controller button bindings: one button per action (or none), each button used once. */
export class PadBindings {
  private readonly storage: BindingStorage | null;
  private bindings = new Map<PadAction, number | null>();
  private readonly listeners = new Set<() => void>();

  constructor(storage?: BindingStorage | null) {
    this.storage = storage === undefined ? defaultStorage() : storage;
    this.loadDefaults();
    this.load();
  }

  get(action: PadAction): number | null {
    return this.bindings.get(action) ?? null;
  }

  /** True when the player changed this action's button from the default. */
  isCustom(action: PadAction): boolean {
    return this.get(action) !== DEFAULT_PAD_BINDINGS[action];
  }

  /** Binds a button to an action; the button is removed from any other action. */
  rebind(action: PadAction, button: number): void {
    for (const [other, b] of this.bindings) if (other !== action && b === button) this.bindings.set(other, null);
    this.bindings.set(action, button);
    this.commit();
  }

  unbind(action: PadAction): void {
    this.bindings.set(action, null);
    this.commit();
  }

  resetDefaults(): void {
    this.loadDefaults();
    try {
      this.storage?.removeItem(STORAGE_KEY);
    } catch {
      // storage unavailable; defaults still apply for this session
    }
    this.emit();
  }

  /** Controller hint for any action: the bound button, a fixed stick hint, or null. */
  hint(action: InputAction): string | null {
    if (isPadAction(action)) {
      const b = this.get(action);
      return b === null ? null : padButtonLabel(b);
    }
    return STICK_HINTS[action] ?? null;
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  private loadDefaults(): void {
    this.bindings = new Map(PAD_ACTIONS.map((a) => [a, DEFAULT_PAD_BINDINGS[a]]));
  }

  private load(): void {
    let parsed: unknown;
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      if (!raw) return;
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const record = parsed as Record<string, unknown>;
    for (const action of PAD_ACTIONS) {
      const v = record[action];
      if (v === null) this.bindings.set(action, null);
      else if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_BUTTON) this.bindings.set(action, v);
    }
  }

  private commit(): void {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(this.bindings)));
    } catch {
      // ignore persistence failures
    }
    this.emit();
  }

  private emit(): void {
    for (const cb of [...this.listeners]) cb();
  }
}
