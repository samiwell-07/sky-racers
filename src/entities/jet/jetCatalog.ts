import type { FlightConfig } from '../../config/flightConfig';

export interface JetPaint {
  base: string;
  dark: string;
  light: string;
  marking: string;
}

export interface JetDefinition {
  id: string;
  name: string;
  description: string;
  /** Overrides on top of DEFAULT_FLIGHT_CONFIG. */
  flight: Partial<FlightConfig>;
  paint: JetPaint;
  /** 1-5 ratings shown in the menu. */
  stats: { speed: number; agility: number; acceleration: number };
}

export const JET_CATALOG: readonly JetDefinition[] = [
  {
    id: 'falcon',
    name: 'F-90 Falcon',
    description: 'Balanced air-superiority fighter. Good at everything.',
    flight: {},
    paint: { base: '#7b8288', dark: '#5c6369', light: '#959ca1', marking: '#30353a' },
    stats: { speed: 3, agility: 3, acceleration: 3 },
  },
  {
    id: 'viper',
    name: 'V-7 Viper',
    description: 'Light and twitchy: fastest roll and pitch, lower top speed.',
    flight: { maxRollRate: 4.4, maxPitchRate: 1.5, maxThrust: 27, liftCoefficient: 0.0018, dragCoefficient: 0.00066, rateResponse: 8 },
    paint: { base: '#6f7a5a', dark: '#4e5740', light: '#8c946e', marking: '#2c3024' },
    stats: { speed: 2, agility: 5, acceleration: 3 },
  },
  {
    id: 'raptor',
    name: 'R-22 Raptor',
    description: 'Heavy interceptor: huge thrust and top speed, slower to roll.',
    flight: { maxThrust: 37, dragCoefficient: 0.00057, maxRollRate: 2.5, maxPitchRate: 1.0, maxG: 8, throttleRate: 0.8 },
    paint: { base: '#596470', dark: '#3e4650', light: '#7b8794', marking: '#1f242a' },
    stats: { speed: 5, agility: 2, acceleration: 5 },
  },
];

export function getJetDefinition(id: string): JetDefinition {
  return JET_CATALOG.find((j) => j.id === id) ?? JET_CATALOG[0]!;
}
