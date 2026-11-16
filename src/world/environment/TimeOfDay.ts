import { Color } from 'three';
import { clamp, smoothstep } from '../../utils/math';
import type { Lights } from './Lights';
import type { Sky } from './Sky';

interface SkyKey {
  /** Sun elevation in degrees at which this palette applies. */
  elevation: number;
  zenith: string;
  horizon: string;
  ground: string;
  sun: string;
  sunIntensity: number;
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
}

const KEYS: SkyKey[] = [
  { elevation: -12, zenith: '#050a18', horizon: '#141c30', ground: '#0c1018', sun: '#8090c0', sunIntensity: 0.25, hemiSky: '#3a4a70', hemiGround: '#151820', hemiIntensity: 0.45 },
  { elevation: -2, zenith: '#1c2a52', horizon: '#c0705a', ground: '#4a3a40', sun: '#ff8a50', sunIntensity: 0.6, hemiSky: '#7080b0', hemiGround: '#40342c', hemiIntensity: 0.8 },
  { elevation: 6, zenith: '#3a5ea0', horizon: '#f0b080', ground: '#a08070', sun: '#ffb070', sunIntensity: 1.6, hemiSky: '#b0c0e0', hemiGround: '#6a5a48', hemiIntensity: 1.2 },
  { elevation: 25, zenith: '#3f78c4', horizon: '#c4d8ea', ground: '#9fb3c4', sun: '#fff4e0', sunIntensity: 2.6, hemiSky: '#d6e6ff', hemiGround: '#8a8468', hemiIntensity: 1.6 },
  { elevation: 90, zenith: '#2f6cc0', horizon: '#c0d8f0', ground: '#9fb3c4', sun: '#ffffff', sunIntensity: 2.9, hemiSky: '#d6e6ff', hemiGround: '#8a8468', hemiIntensity: 1.7 },
];

const _a = new Color();
const _b = new Color();

function mix(out: Color, a: string, b: string, t: number): void {
  out.copy(_a.set(a)).lerp(_b.set(b), t);
}

/**
 * Sets the sun position, sky palette and lighting for an hour of the day (0-24).
 * Sunrise ~6h, noon 12h, sunset ~18h. The sun moves east (+X) to west (-X).
 */
export function applyTimeOfDay(hour: number, sky: Sky, lights: Lights): void {
  const dayAngle = ((hour - 6) / 12) * Math.PI; // 0 at sunrise, PI at sunset
  const maxElevation = 62 * (Math.PI / 180);
  const elevation = Math.asin(clamp(Math.sin(dayAngle) * Math.sin(maxElevation), -1, 1));
  const azimuth = dayAngle;
  const dir = lights.sunDirection.set(Math.cos(azimuth) * Math.cos(elevation), Math.sin(elevation), 0.45 * Math.cos(elevation)).normalize();
  // Keep a minimum height for the shadow light so night/dusk shadows don't streak forever.
  sky.sunDirection.copy(dir);
  if (lights.sunDirection.y < 0.12) lights.sunDirection.y = 0.12;
  lights.sunDirection.normalize();

  const elevDeg = (elevation * 180) / Math.PI;
  let i = 0;
  while (i < KEYS.length - 2 && elevDeg > KEYS[i + 1]!.elevation) i++;
  const k0 = KEYS[i]!;
  const k1 = KEYS[i + 1]!;
  const t = clamp((elevDeg - k0.elevation) / (k1.elevation - k0.elevation), 0, 1);

  mix(sky.colors.zenith, k0.zenith, k1.zenith, t);
  mix(sky.colors.horizon, k0.horizon, k1.horizon, t);
  mix(sky.colors.ground, k0.ground, k1.ground, t);
  mix(sky.colors.sun, k0.sun, k1.sun, t);
  sky.syncColors();

  mix(lights.sun.color, k0.sun, k1.sun, t);
  lights.sun.intensity = k0.sunIntensity + (k1.sunIntensity - k0.sunIntensity) * t;
  lights.sun.intensity *= smoothstep(-6, 2, elevDeg) * 0.85 + 0.15;
  mix(lights.hemi.color, k0.hemiSky, k1.hemiSky, t);
  mix(lights.hemi.groundColor, k0.hemiGround, k1.hemiGround, t);
  lights.hemi.intensity = k0.hemiIntensity + (k1.hemiIntensity - k0.hemiIntensity) * t;
}
