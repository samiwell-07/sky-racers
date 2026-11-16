/**
 * Fixed-timestep loop: physics runs at a constant rate for stable, reproducible flight,
 * rendering runs every animation frame and interpolates between physics steps.
 * When the page becomes visible again the clock restarts, so a hidden tab never causes a
 * simulation catch-up; any single frame is also clamped to maxFrameDt.
 */
export class GameLoop {
  private accumulator = 0;
  private lastTime = 0;
  private frameId = 0;
  private running = false;

  constructor(
    private readonly fixedUpdate: (dt: number) => void,
    private readonly render: (alpha: number, frameDt: number) => void,
    readonly fixedDt = 1 / 120,
    private readonly maxFrameDt = 0.1,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.resetTiming();
    globalThis.document?.addEventListener('visibilitychange', this.onVisibility);
    this.frameId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    globalThis.document?.removeEventListener('visibilitychange', this.onVisibility);
    cancelAnimationFrame(this.frameId);
  }

  /** Forget elapsed time: the next frame starts from now with an empty step accumulator. */
  resetTiming(): void {
    this.lastTime = performance.now();
    this.accumulator = 0;
  }

  private readonly onVisibility = (): void => {
    if (globalThis.document?.visibilityState !== 'hidden') this.resetTiming();
  };

  private readonly tick = (now: number): void => {
    if (!this.running) return;
    const frameDt = Math.min(Math.max(0, (now - this.lastTime) / 1000), this.maxFrameDt);
    this.lastTime = now;
    this.accumulator += frameDt;
    while (this.accumulator >= this.fixedDt) {
      this.fixedUpdate(this.fixedDt);
      this.accumulator -= this.fixedDt;
    }
    this.render(this.accumulator / this.fixedDt, frameDt);
    this.frameId = requestAnimationFrame(this.tick);
  };
}
