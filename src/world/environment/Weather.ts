import { Vector3 } from 'three';
import type { FlightModel } from '../../physics/FlightModel';
import { smoothstep } from '../../utils/math';
import { valleyCenterX } from '../terrain/HeightField';

export interface WeatherSettings {
  /** Wind speed (m/s). */
  windSpeed: number;
  /** Direction the wind blows TOWARD, degrees (0 = -Z / north, 90 = +X / east). */
  windDirection: number;
  /** 0..1 */
  turbulence: number;
}

/** 0..1 enclosure of a spot (WorldGenerator.canyonFactor). */
export type CanyonFactorFn = (x: number, z: number) => number;

/** Classic world: inside the canyon around the valley centerline. */
export const classicCanyonFactor: CanyonFactorFn = (x, z) => 1 - smoothstep(150, 400, Math.abs(x - valleyCenterX(z)));

/**
 * Wind and turbulence. Turbulence is strongest low in a canyon (rotor and gusts off the walls)
 * and fades with altitude above the ground.
 */
export class Weather {
  readonly wind = new Vector3();
  private time = 0;

  constructor(public settings: WeatherSettings, private canyonFactor: CanyonFactorFn = classicCanyonFactor) {
    this.updateWind();
  }

  /** Switch worlds: pass the new world's canyonFactor (e.g. `(x, z) => world.canyonFactor(x, z)`). */
  setCanyonFactor(fn: CanyonFactorFn): void {
    this.canyonFactor = fn;
  }

  updateWind(): void {
    const a = (this.settings.windDirection * Math.PI) / 180;
    this.wind.set(Math.sin(a), 0, -Math.cos(a)).multiplyScalar(this.settings.windSpeed);
  }

  /** Intensity 0..1 of the turbulence at a position. */
  turbulenceAt(position: Vector3, agl: number): number {
    const inCanyon = this.canyonFactor(position.x, position.z);
    const low = 1 - smoothstep(30, 250, agl);
    return this.settings.turbulence * (0.25 + 0.75 * Math.max(inCanyon * low, low * 0.5));
  }

  /** Advance the weather clock once per physics step. */
  tick(dt: number): void {
    this.time += dt;
    this.updateWind();
  }

  /** Applies wind and turbulence to a flight model (phase decorrelates multiple jets). */
  apply(model: FlightModel, agl: number, phase = 0): void {
    const t = this.time + phase;
    const k = this.turbulenceAt(model.state.position, agl);
    model.wind.copy(this.wind);
    const g = (a: number, b: number, c: number): number => Math.sin(t * a + phase) * 0.6 + Math.sin(t * b + 1.7) * 0.3 + Math.sin(t * c + 4.1) * 0.1;
    model.gust.set(g(1.3, 3.7, 9.1) * 2.5, g(1.9, 5.3, 11.7) * 4, g(1.1, 4.3, 8.3) * 2.5).multiplyScalar(k);
    model.turbulenceRates.pitch = g(2.3, 6.1, 13.3) * 0.05 * k;
    model.turbulenceRates.roll = g(2.9, 7.7, 15.1) * 0.1 * k;
  }
}
