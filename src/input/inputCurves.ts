/** Zero inside the dead zone, then rescaled so |out| rises continuously from 0 to 1. Sign preserved; input clamped to [-1, 1]. */
export function applyDeadZone(v: number, deadZone: number): number {
  const dz = Math.min(Math.max(deadZone, 0), 0.999);
  const mag = Math.min(Math.abs(v), 1);
  if (!(mag > dz)) return 0;
  return Math.sign(v) * ((mag - dz) / (1 - dz));
}

/** Blend between linear (expo 0) and cubic (expo 1): out = (1-e)*v + e*v^3. */
export function applyExpo(v: number, expo: number): number {
  const e = Math.min(Math.max(expo, 0), 1);
  return (1 - e) * v + e * v * v * v;
}
