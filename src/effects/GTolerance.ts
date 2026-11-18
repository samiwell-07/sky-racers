/** Onset threshold (G) above which sustained load starts to drain consciousness. */
const BLACKOUT_ONSET = 6;
/** Negative G below which blood pools in the head. */
const REDOUT_ONSET = -2;
/** Time constant (s) of the body's lagged response; filters out brief spikes. */
const TAU = 1.2;
const BLACKOUT_RATE = 0.32; // per second per G of excess
const REDOUT_RATE = 0.45;
const RECOVERY_BASE = 0.35; // per second
const RECOVERY_PER_G = 0.08;
/** G-LOC: once the blackout is total, the pilot is out (no control, black screen) for this long. */
export const GLOC_SECONDS = 2.5;

export interface GEffects {
  blackout: number;
  redout: number;
  /** G-LOC: the pilot has passed out (screen fully black, no control). */
  unconscious: boolean;
}

/** Simple physiological G-tolerance model (pure, no DOM). */
export class GTolerance {
  private filteredG = 1;
  private blackout = 0;
  private redout = 0;
  private unconsciousTime = 0;
  private readonly result: GEffects = { blackout: 0, redout: 0, unconscious: false };

  get unconscious(): boolean {
    return this.unconsciousTime > 0;
  }

  update(gLoad: number, dt: number): GEffects {
    const step = Math.min(Math.max(dt, 0), 0.25);
    if (Number.isFinite(gLoad) && step > 0) {
      this.filteredG += (gLoad - this.filteredG) * (1 - Math.exp(-step / TAU));
      const g = this.filteredG;

      if (this.unconsciousTime > 0) {
        // Out cold: stay fully blacked out until the timer runs out, then vision starts coming back.
        this.unconsciousTime = Math.max(0, this.unconsciousTime - step);
        this.blackout = this.unconsciousTime > 0 ? 1 : 0.999;
      } else if (g > BLACKOUT_ONSET) {
        this.blackout += (g - BLACKOUT_ONSET) * BLACKOUT_RATE * step;
      } else {
        this.blackout -= (RECOVERY_BASE + (BLACKOUT_ONSET - g) * RECOVERY_PER_G) * step;
      }

      if (g < REDOUT_ONSET) {
        this.redout += (REDOUT_ONSET - g) * REDOUT_RATE * step;
      } else {
        this.redout -= (RECOVERY_BASE + (g - REDOUT_ONSET) * RECOVERY_PER_G) * step;
      }

      this.blackout = Math.min(1, Math.max(0, this.blackout));
      this.redout = Math.min(1, Math.max(0, this.redout));
      if (this.blackout >= 1 && this.unconsciousTime === 0) this.unconsciousTime = GLOC_SECONDS;
    }
    this.result.blackout = this.blackout;
    this.result.redout = this.redout;
    this.result.unconscious = this.unconsciousTime > 0;
    return this.result;
  }

  reset(): void {
    this.filteredG = 1;
    this.blackout = 0;
    this.redout = 0;
    this.unconsciousTime = 0;
    this.result.blackout = 0;
    this.result.redout = 0;
    this.result.unconscious = false;
  }
}
