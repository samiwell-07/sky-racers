export interface MouseFlightSettings {
  sensitivity: number;
  invertPitch: boolean;
}

/** Stick deflection per pixel of mouse movement at sensitivity 1. */
const DEFLECTION_PER_PIXEL = 0.004;
/** Exponential spring-back rate toward center (1/s). */
const CENTERING_RATE = 2.5;
/** Throttle change per wheel "notch". */
const THROTTLE_PER_NOTCH = 0.1;

/**
 * Pointer-lock "virtual stick": mouse movement deflects the stick, which springs back to center.
 * Moving the mouse down/back = nose up (unless invertPitch). Wheel up = throttle up.
 */
export class MouseFlight {
  private active = false;
  private pitch = 0;
  private roll = 0;
  private throttleAccum = 0;

  constructor(
    private readonly element: HTMLElement,
    private readonly settings: MouseFlightSettings,
  ) {}

  get enabled(): boolean {
    return this.active;
  }

  /** Starts listening; pointer lock is requested on the next click on the element. */
  enable(): void {
    if (this.active) return;
    this.active = true;
    this.element.addEventListener('click', this.onClick);
    this.element.addEventListener('wheel', this.onWheel, { passive: false });
    document.addEventListener('mousemove', this.onMouseMove);
  }

  disable(): void {
    if (!this.active) return;
    this.active = false;
    this.element.removeEventListener('click', this.onClick);
    this.element.removeEventListener('wheel', this.onWheel);
    document.removeEventListener('mousemove', this.onMouseMove);
    if (this.isLocked()) document.exitPointerLock?.();
    this.pitch = 0;
    this.roll = 0;
    this.throttleAccum = 0;
  }

  update(dt: number): void {
    if (!(dt > 0)) return;
    const k = Math.exp(-CENTERING_RATE * dt);
    this.pitch *= k;
    this.roll *= k;
    if (Math.abs(this.pitch) < 1e-4) this.pitch = 0;
    if (Math.abs(this.roll) < 1e-4) this.roll = 0;
  }

  get(): { pitch: number; roll: number } {
    return { pitch: this.pitch, roll: this.roll };
  }

  /** Wheel input accumulated since the last call (positive = throttle up), clamped to -1..1. */
  consumeThrottleDelta(): number {
    const v = this.throttleAccum;
    this.throttleAccum = 0;
    return v;
  }

  /** Recenters the virtual stick, drops pending wheel throttle and releases pointer lock. */
  release(): void {
    this.pitch = 0;
    this.roll = 0;
    this.throttleAccum = 0;
    if (this.isLocked()) document.exitPointerLock?.();
  }

  dispose(): void {
    this.disable();
  }

  private isLocked(): boolean {
    return typeof document !== 'undefined' && document.pointerLockElement === this.element;
  }

  private readonly onClick = (): void => {
    if (!this.isLocked()) {
      try {
        const result = this.element.requestPointerLock?.() as unknown;
        if (result instanceof Promise) result.catch(() => undefined);
      } catch {
        // pointer lock not permitted; ignore
      }
    }
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.isLocked()) return;
    const gain = DEFLECTION_PER_PIXEL * this.settings.sensitivity;
    const pitchSign = this.settings.invertPitch ? -1 : 1;
    this.roll = clamp1(this.roll + e.movementX * gain);
    this.pitch = clamp1(this.pitch + pitchSign * e.movementY * gain);
  };

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.isLocked()) return;
    e.preventDefault();
    // Normalize to "notches": ~100px per notch in pixel mode, ~3 lines per notch in line mode.
    const notchSize = e.deltaMode === 0 ? 100 : e.deltaMode === 1 ? 3 : 1;
    this.throttleAccum = clamp1(this.throttleAccum - (e.deltaY / notchSize) * THROTTLE_PER_NOTCH);
  };
}

function clamp1(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}
