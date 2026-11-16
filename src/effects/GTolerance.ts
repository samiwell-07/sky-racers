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

export interface GEffects {
  blackout: number;
  redout: number;
}

/** Simple physiological G-tolerance model (pure, no DOM). */
export class GTolerance {
  private filteredG = 1;
  private blackout = 0;
  private redout = 0;
  private readonly result: GEffects = { blackout: 0, redout: 0 };

  update(gLoad: number, dt: number): GEffects {
    const step = Math.min(Math.max(dt, 0), 0.25);
    if (Number.isFinite(gLoad) && step > 0) {
      this.filteredG += (gLoad - this.filteredG) * (1 - Math.exp(-step / TAU));
      const g = this.filteredG;

      if (g > BLACKOUT_ONSET) {
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
    }
    this.result.blackout = this.blackout;
    this.result.redout = this.redout;
    return this.result;
  }

  reset(): void {
    this.filteredG = 1;
    this.blackout = 0;
    this.redout = 0;
    this.result.blackout = 0;
    this.result.redout = 0;
  }
}
