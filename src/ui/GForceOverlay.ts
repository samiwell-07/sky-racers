import { GTolerance } from '../effects/GTolerance';

/**
 * Full-screen vignette for G-induced blackout (grey/black tunnel vision) and redout.
 * Uses z-index 1 so HUD elements with a higher z-index stay on top.
 */
export class GForceOverlay {
  readonly element: HTMLDivElement;
  private readonly dark: HTMLDivElement;
  private readonly red: HTMLDivElement;
  private readonly tolerance = new GTolerance();
  private lastBlackout = -1;
  private lastRedout = -1;
  private out = false;

  constructor(container: HTMLElement) {
    const layer = (): HTMLDivElement => {
      const d = document.createElement('div');
      Object.assign(d.style, {
        position: 'absolute',
        inset: '0',
        pointerEvents: 'none',
        opacity: '0',
      });
      return d;
    };
    this.element = document.createElement('div');
    Object.assign(this.element.style, {
      position: 'fixed',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '1',
      overflow: 'hidden',
    });
    this.dark = layer();
    this.red = layer();
    this.element.append(this.dark, this.red);
    container.appendChild(this.element);
  }

  /** G-LOC: the pilot has passed out and must not control the jet. */
  get unconscious(): boolean {
    return this.tolerance.unconscious;
  }

  update(gLoad: number, dt: number): void {
    const { blackout, redout, unconscious } = this.tolerance.update(gLoad, dt);
    if (unconscious !== this.out) {
      this.out = unconscious;
      // Out cold: cover the HUD too (menus, z-index 20, stay on top).
      this.element.style.zIndex = unconscious ? '15' : '1';
      this.lastBlackout = -1;
    }
    if (Math.abs(blackout - this.lastBlackout) > 0.002) {
      this.lastBlackout = blackout;
      this.applyBlackout(blackout, unconscious);
    }
    if (Math.abs(redout - this.lastRedout) > 0.002) {
      this.lastRedout = redout;
      this.applyRedout(redout);
    }
  }

  private applyBlackout(b: number, unconscious = false): void {
    const s = this.dark.style;
    if (unconscious) {
      s.background = '#000';
      s.backdropFilter = 'none';
      s.opacity = '1';
      return;
    }
    if (b <= 0.001) {
      s.opacity = '0';
      s.background = 'none';
      s.backdropFilter = 'none';
      return;
    }
    // Tunnel closes in as blackout grows; past ~0.85 the whole view goes black.
    const inner = Math.max(0, 55 - b * 60);
    const outer = Math.max(inner + 8, 95 - b * 55);
    const centerDark = Math.max(0, (b - 0.75) / 0.25);
    s.background =
      `radial-gradient(ellipse at center, rgba(0,0,0,${(centerDark * 0.97).toFixed(3)}) ${inner.toFixed(1)}%, ` +
      `rgba(10,10,10,0.97) ${outer.toFixed(1)}%)`;
    s.backdropFilter = `grayscale(${Math.min(1, b * 1.6).toFixed(2)})`;
    s.opacity = Math.min(1, b * 1.4).toFixed(3);
  }

  private applyRedout(r: number): void {
    const s = this.red.style;
    if (r <= 0.001) {
      s.opacity = '0';
      s.background = 'none';
      return;
    }
    const inner = Math.max(0, 50 - r * 50);
    const fill = Math.max(0, (r - 0.6) / 0.4) * 0.85;
    s.background =
      `radial-gradient(ellipse at center, rgba(150,0,0,${fill.toFixed(3)}) ${inner.toFixed(1)}%, ` +
      `rgba(120,0,0,0.92) 100%)`;
    s.opacity = Math.min(1, r * 1.3).toFixed(3);
  }

  reset(): void {
    this.tolerance.reset();
    this.lastBlackout = -1;
    this.lastRedout = -1;
    this.out = false;
    this.element.style.zIndex = '1';
    this.applyBlackout(0);
    this.applyRedout(0);
  }

  dispose(): void {
    this.element.remove();
  }
}
