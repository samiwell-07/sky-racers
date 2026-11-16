export const clamp = (v: number, min: number, max: number): number =>
  v < min ? min : v > max ? max : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Frame-rate independent smoothing factor for exponential damping (0..1). */
export const dampFactor = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);

export const RAD2DEG = 180 / Math.PI;
export const DEG2RAD = Math.PI / 180;
