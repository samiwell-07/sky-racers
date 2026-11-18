import { describe, expect, it } from 'vitest';
import { GTolerance } from '../src/effects/GTolerance';

const run = (g: GTolerance, gLoad: number, seconds: number, dt = 1 / 60) => {
  let r = g.update(gLoad, 0);
  for (let t = 0; t < seconds; t += dt) r = g.update(gLoad, dt);
  return { ...r };
};

describe('GTolerance', () => {
  it('blacks out under sustained 9 G within a few seconds', () => {
    const g = new GTolerance();
    expect(run(g, 9, 1).blackout).toBeLessThan(0.1);
    expect(run(g, 9, 3).blackout).toBeGreaterThan(0.9);
  });

  it('ignores a brief spike', () => {
    const g = new GTolerance();
    run(g, 9, 0.4);
    expect(run(g, 1, 1).blackout).toBeLessThan(0.05);
  });

  it('recovers after unloading', () => {
    const g = new GTolerance();
    expect(run(g, 9, 5).blackout).toBe(1);
    expect(run(g, 1, 5).blackout).toBe(0);
  });

  it('accumulates redout under sustained negative G', () => {
    const g = new GTolerance();
    expect(run(g, -3, 6).redout).toBeGreaterThan(0.5);
    expect(run(g, -3, 6).blackout).toBe(0);
    g.reset();
    expect(run(g, 1, 0.1)).toEqual({ blackout: 0, redout: 0, unconscious: false });
  });

  it('passes out (G-LOC) for 2-3 s once the blackout is total, even if the load is gone', () => {
    const g = new GTolerance();
    let t = 0;
    while (!g.unconscious && t < 10) {
      g.update(9, 1 / 60);
      t += 1 / 60;
    }
    expect(g.unconscious).toBe(true);
    expect(run(g, 1, 2).blackout).toBe(1);
    expect(g.unconscious).toBe(true);
    const after = run(g, 1, 0.6);
    expect(after.unconscious).toBe(false);
    expect(after.blackout).toBeLessThan(1);
    expect(run(g, 1, 3).blackout).toBe(0);
  });
});
