import type { Vector3 } from 'three';

const SPEED_ONSET = 150; // m/s
const SPEED_FULL = 220; // m/s
const MAX_SPEED_AMP = 0.25; // m
const LOW_ALT = 30; // m, buffeting starts below this AGL
const MAX_LOW_AMP = 0.1; // m
const IMPULSE_AMP = 0.6; // m per unit impulse

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Smooth pseudo-noise in [-1, 1]: sum of sines with incommensurate frequencies. */
function wobble(t: number, seed: number): number {
  return (
    Math.sin(t * 13.1 + seed) * 0.5 +
    Math.sin(t * 23.7 + seed * 2.3) * 0.3 +
    Math.sin(t * 41.3 + seed * 4.1) * 0.2
  );
}

/**
 * Camera shake offset (meters) from high-speed buffeting, very low altitude turbulence
 * and an external impulse (crashes/damage, 0..1+).
 */
export function shakeOffset(time: number, speed: number, agl: number, impulse: number, out: Vector3): Vector3 {
  const s = clamp01((speed - SPEED_ONSET) / (SPEED_FULL - SPEED_ONSET));
  const speedAmp = MAX_SPEED_AMP * s * Math.sqrt(s);
  const low = clamp01(1 - Math.max(agl, 0) / LOW_ALT);
  const lowAmp = MAX_LOW_AMP * low * low * clamp01((speed - 60) / 100);
  const imp = Number.isFinite(impulse) ? Math.max(0, impulse) : 0;
  const amp = speedAmp + lowAmp + imp * IMPULSE_AMP;
  if (amp <= 0 || !Number.isFinite(amp)) return out.set(0, 0, 0);
  return out.set(
    wobble(time, 0.0) * amp,
    wobble(time * 1.13, 1.7) * amp,
    wobble(time * 0.87, 3.9) * amp * 0.4,
  );
}
