import type { FlightConfig } from '../config/flightConfig';
import { clamp } from '../utils/math';

/** Lift coefficient: linear up to the stall angle, then drops off sharply. */
export function liftCoefficient(aoa: number, c: FlightConfig): number {
  const clMax = c.cl0 + c.clAlpha * c.stallAngle;
  const linear = clamp(c.cl0 + c.clAlpha * aoa, -clMax, clMax);
  const overStall = Math.abs(aoa) - c.stallAngle;
  if (overStall <= 0) return linear;
  const falloff = clamp(1 - overStall * 4, c.postStallLift, 1);
  return linear * falloff;
}

/** Fraction of control authority available at a given airspeed. */
export function controlAuthority(speed: number, c: FlightConfig): number {
  const t = (speed - c.minControlSpeed) / Math.max(1, c.fullControlSpeed - c.minControlSpeed);
  return clamp(t, c.minControlAuthority, 1);
}

/**
 * Fly-by-wire alpha limiter applied to the pitch rate: fades out rotation that would push the
 * angle of attack past ~92% of the stall angle, and pushes back if it overshoots.
 * Rotation that reduces AoA always passes through.
 */
export function limitPitchRate(rate: number, aoa: number, c: FlightConfig): number {
  if (!c.alphaLimiter || rate === 0) return rate;
  const limit = c.stallAngle * 0.92;
  const fadeStart = limit * 0.75;
  const dir = Math.sign(rate);
  const aoaInRateDir = dir * aoa;
  if (aoaInRateDir <= fadeStart) return rate;
  if (aoaInRateDir >= limit) return -dir * (aoaInRateDir - limit) * 10;
  return rate * ((limit - aoaInRateDir) / (limit - fadeStart));
}
