import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { shakeOffset } from '../src/effects/CameraShake';

describe('shakeOffset', () => {
  it('is zero at low speed and high altitude without impulse', () => {
    const out = new Vector3(1, 1, 1);
    for (let t = 0; t < 3; t += 0.1) {
      expect(shakeOffset(t, 120, 500, 0, out).length()).toBe(0);
    }
  });

  it('is bounded and non-trivial at high speed', () => {
    const out = new Vector3();
    let max = 0;
    for (let t = 0; t < 10; t += 0.013) {
      const v = shakeOffset(t, 400, 500, 0, out);
      for (const c of [v.x, v.y, v.z]) max = Math.max(max, Math.abs(c));
    }
    expect(max).toBeGreaterThan(0.05);
    expect(max).toBeLessThanOrEqual(0.25);
  });

  it('grows with low altitude and impulse but stays bounded', () => {
    const out = new Vector3();
    let maxLow = 0;
    let maxImp = 0;
    for (let t = 0; t < 10; t += 0.013) {
      maxLow = Math.max(maxLow, shakeOffset(t, 200, 2, 0, out).length());
      maxImp = Math.max(maxImp, shakeOffset(t, 0, 500, 1, out).length());
    }
    const hi = Math.max(...Array.from({ length: 700 }, (_, i) => shakeOffset(i * 0.013, 200, 500, 0, out).length()));
    expect(maxLow).toBeGreaterThan(hi);
    expect(maxImp).toBeGreaterThan(0.2);
    expect(maxImp).toBeLessThan(1.5);
  });
});
