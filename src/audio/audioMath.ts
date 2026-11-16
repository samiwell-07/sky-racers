/** Pure audio helpers (no Web Audio): timbres, mixer gains, ducking, flyby voice allocation. */

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0);

/** Synthesis parameters for one jet's engine sound. */
export interface JetTimbre {
  /** Whine fundamental at idle and the extra Hz added at full throttle. */
  whineBase: number;
  whineRange: number;
  /** Frequency ratios of the three whine oscillators (detune / fifth). */
  whineRatios: readonly [number, number, number];
  whineTypes: readonly [OscillatorType, OscillatorType, OscillatorType];
  whineGain: number;
  /** Whine lowpass at idle and its extra Hz at full throttle. */
  whineCutoff: number;
  whineCutoffRange: number;
  roarCutoff: number;
  roarCutoffRange: number;
  roarGain: number;
  /** Afterburner rumble lowpass and level. */
  abCutoff: number;
  abGain: number;
  /** Sub-bass sine one octave below the whine fundamental ÷ subDivisor. */
  subDivisor: number;
  subGain: number;
}

export const JET_TIMBRES: Readonly<Record<string, JetTimbre>> = {
  // Balanced all-rounder.
  falcon: {
    whineBase: 220,
    whineRange: 520,
    whineRatios: [1, 1.007, 1.497],
    whineTypes: ['sawtooth', 'sawtooth', 'triangle'],
    whineGain: 1,
    whineCutoff: 1200,
    whineCutoffRange: 3800,
    roarCutoff: 300,
    roarCutoffRange: 2200,
    roarGain: 1,
    abCutoff: 140,
    abGain: 0.55,
    subDivisor: 4,
    subGain: 0.04,
  },
  // Light and high-revving: higher, brighter whine, thinner roar.
  viper: {
    whineBase: 330,
    whineRange: 760,
    whineRatios: [1, 1.012, 2.005],
    whineTypes: ['sawtooth', 'square', 'triangle'],
    whineGain: 1.15,
    whineCutoff: 1800,
    whineCutoffRange: 5200,
    roarCutoff: 450,
    roarCutoffRange: 2800,
    roarGain: 0.75,
    abCutoff: 220,
    abGain: 0.4,
    subDivisor: 4,
    subGain: 0.015,
  },
  // Heavy twin-engine: deep whine, dark heavy roar, big rumble.
  raptor: {
    whineBase: 140,
    whineRange: 360,
    whineRatios: [1, 1.004, 1.335],
    whineTypes: ['sawtooth', 'triangle', 'sawtooth'],
    whineGain: 0.8,
    whineCutoff: 800,
    whineCutoffRange: 2400,
    roarCutoff: 200,
    roarCutoffRange: 1500,
    roarGain: 1.3,
    abCutoff: 95,
    abGain: 0.75,
    subDivisor: 2,
    subGain: 0.09,
  },
};

export function getJetTimbre(jetId: string): JetTimbre {
  return JET_TIMBRES[jetId] ?? JET_TIMBRES.falcon!;
}

export interface MixerLevels {
  master: number;
  engine: number;
  effects: number;
  warnings: number;
}

/** Slider position (0..1) → linear gain. Quadratic is closer to perceived loudness than linear. */
export function sliderToGain(v: number): number {
  const c = clamp01(v);
  return c * c;
}

/** Maximum attenuation of engine/effects while a warning sounds (≈ -8 dB). */
export const DUCK_DEPTH = 0.6;

/**
 * Gain multiplier for the engine/effects channels. `activity` 0..1 is how strongly a warning
 * is sounding; a muted warning channel never ducks anything.
 */
export function duckGain(activity: number, warningsLevel: number, depth = DUCK_DEPTH): number {
  return 1 - clamp01(depth) * clamp01(activity) * (clamp01(warningsLevel) > 0 ? 1 : 0);
}

/** Channel bus gains (master applied separately on the master bus). */
export function channelGains(levels: MixerLevels, warningActivity: number): MixerLevels {
  const duck = duckGain(warningActivity, levels.warnings);
  return {
    master: sliderToGain(levels.master),
    engine: sliderToGain(levels.engine) * duck,
    effects: sliderToGain(levels.effects) * duck,
    warnings: sliderToGain(levels.warnings),
  };
}

/** Frame-rate independent exponential approach of `current` toward `target` with time constant `tau`. */
export function approach(current: number, target: number, dt: number, tau: number): number {
  if (!(dt > 0)) return current;
  if (!(tau > 0)) return target;
  return target + (current - target) * Math.exp(-dt / tau);
}

// ---- flybys ----

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export const MAX_FLYBY_VOICES = 3;
export const FLYBY_MAX_DISTANCE = 900;
const FLYBY_REF_DISTANCE = 40;

/** Distance attenuation: 1 within the reference distance, inverse-distance beyond, fading to 0 at max. */
export function distanceGain(d: number, ref = FLYBY_REF_DISTANCE, max = FLYBY_MAX_DISTANCE): number {
  if (!(d < max)) return 0;
  const inv = d <= ref ? 1 : ref / d;
  const edge = clamp01((max - d) / (max * 0.25)); // smooth fade over the last quarter
  return inv * edge;
}

/**
 * Doppler pitch ratio. `closing` is the rate (m/s) at which the source-listener distance shrinks.
 * Exaggeration < 1 keeps jet-speed shifts musical rather than physically extreme.
 */
export function dopplerRatio(closing: number, speedOfSound = 343, exaggeration = 0.5): number {
  if (!Number.isFinite(closing)) return 1;
  const v = Math.max(-0.8, Math.min(0.8, (closing * exaggeration) / speedOfSound));
  return Math.max(0.6, Math.min(1.6, 1 / (1 - v)));
}

/** Rate at which the distance between source and listener shrinks (positive = approaching). */
export function closingSpeed(src: Vec3Like, srcVel: Vec3Like, lis: Vec3Like, lisVel: Vec3Like): number {
  const dx = lis.x - src.x;
  const dy = lis.y - src.y;
  const dz = lis.z - src.z;
  const d = Math.hypot(dx, dy, dz);
  if (d < 1e-3) return 0;
  const rvx = srcVel.x - lisVel.x;
  const rvy = srcVel.y - lisVel.y;
  const rvz = srcVel.z - lisVel.z;
  return (rvx * dx + rvy * dy + rvz * dz) / d;
}

/** Stereo pan −1..1 from the source direction relative to the listener's right vector. */
export function stereoPan(src: Vec3Like, lis: Vec3Like, right: Vec3Like): number {
  const dx = src.x - lis.x;
  const dy = src.y - lis.y;
  const dz = src.z - lis.z;
  const d = Math.hypot(dx, dy, dz);
  if (d < 1e-3) return 0;
  const p = (dx * right.x + dy * right.y + dz * right.z) / d;
  return Math.max(-0.9, Math.min(0.9, p));
}

/** Keys of the nearest `max` sources within `maxDistance`, nearest first. */
export function selectNearest<T extends { key: string; position: Vec3Like }>(
  sources: readonly T[],
  listener: Vec3Like,
  max = MAX_FLYBY_VOICES,
  maxDistance = FLYBY_MAX_DISTANCE,
): T[] {
  const scored: Array<{ s: T; d: number }> = [];
  for (const s of sources) {
    const d = Math.hypot(s.position.x - listener.x, s.position.y - listener.y, s.position.z - listener.z);
    if (d < maxDistance) scored.push({ s, d });
  }
  scored.sort((a, b) => a.d - b.d);
  return scored.slice(0, Math.max(0, max)).map((e) => e.s);
}

/**
 * Stable voice assignment: a key that already owns a voice keeps it; new keys take free voices;
 * voices whose key is no longer wanted are released (null). Returns the new slot table.
 */
export function assignVoices(slots: readonly (string | null)[], wanted: readonly string[]): (string | null)[] {
  const want = new Set(wanted);
  const next = slots.map((k) => (k !== null && want.has(k) ? k : null));
  const taken = new Set(next.filter((k): k is string => k !== null));
  for (const key of wanted) {
    if (taken.has(key)) continue;
    const free = next.indexOf(null);
    if (free < 0) break;
    next[free] = key;
    taken.add(key);
  }
  return next;
}
