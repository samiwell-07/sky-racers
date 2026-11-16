import { describe, expect, it } from 'vitest';
import { applyDeadZone, applyExpo } from '../src/input/inputCurves';

describe('applyDeadZone', () => {
  it('zeros input inside the dead zone', () => {
    expect(applyDeadZone(0.1, 0.15)).toBe(0);
    expect(applyDeadZone(-0.15, 0.15)).toBe(0);
  });

  it('rescales continuously to full range, preserving sign', () => {
    expect(applyDeadZone(0.15 + 1e-9, 0.15)).toBeCloseTo(0, 6);
    expect(applyDeadZone(0.575, 0.15)).toBeCloseTo(0.5, 9);
    expect(applyDeadZone(-1, 0.15)).toBe(-1);
    expect(applyDeadZone(1.3, 0.15)).toBe(1);
  });
});

describe('applyExpo', () => {
  it('is linear at 0 and cubic at 1, keeping endpoints and sign', () => {
    expect(applyExpo(0.5, 0)).toBe(0.5);
    expect(applyExpo(0.5, 1)).toBeCloseTo(0.125, 9);
    expect(applyExpo(-0.5, 0.5)).toBeCloseTo(-(0.25 + 0.0625), 9);
    expect(applyExpo(1, 0.7)).toBeCloseTo(1, 9);
  });
});
