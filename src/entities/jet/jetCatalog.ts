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
    description: 'Balanced swept-wing fighter with twin fins and twin engines.',
    flight: {},
    paint: { base: '#7b8288', dark: '#5c6369', light: '#959ca1', marking: '#30353a' },
    stats: { speed: 3, agility: 3, acceleration: 3 },
  },
  {
    id: 'viper',
    name: 'V-7 Viper',
    description: 'Light single-engine, single-fin fighter with clipped swept wings and agile handling.',
    flight: { maxRollRate: 4.4, maxPitchRate: 1.5, maxThrust: 27, liftCoefficient: 0.0018, dragCoefficient: 0.00066, rateResponse: 8 },
    paint: { base: '#6f7a5a', dark: '#4e5740', light: '#8c946e', marking: '#2c3024' },
    stats: { speed: 2, agility: 5, acceleration: 3 },
  },
  {
    id: 'raptor',
    name: 'R-22 Raptor',
    description: 'Broad diamond-wing interceptor with twin engines and canted twin fins: fast, heavy handling.',
    flight: { maxThrust: 37, dragCoefficient: 0.00057, maxRollRate: 2.5, maxPitchRate: 1.0, maxG: 8, throttleRate: 0.8 },
    paint: { base: '#596470', dark: '#3e4650', light: '#7b8794', marking: '#1f242a' },
    stats: { speed: 5, agility: 2, acceleration: 5 },
  },
  {
    id: 'kestrel',
    name: 'K-31 Kestrel',
    description: 'Canard-delta technical racer: strong low-speed lift and responsive controls, but modest speed and acceleration.',
    flight: {
      maxThrust: 24, throttleRate: 0.55, dragCoefficient: 0.00076,
      liftCoefficient: 0.002, maxRollRate: 3.9, maxPitchRate: 1.45, rateResponse: 7.3,
      minControlSpeed: 25, fullControlSpeed: 90, stallWarningSpeed: 65, directionalStability: 3.6,
    },
    paint: { base: '#71818c', dark: '#4d5c68', light: '#a0afb6', marking: '#233945' },
    stats: { speed: 1, agility: 4, acceleration: 2 },
  },
  {
    id: 'specter',
    name: 'S-12 Specter',
    description: 'Forward-swept pursuit fighter: strong speed and acceleration with moderate agility, below the Raptor in outright pace.',
    flight: {
      maxThrust: 33, throttleRate: 0.7, dragCoefficient: 0.00059,
      maxRollRate: 3.5, maxPitchRate: 1.28, rateResponse: 6.5, directionalStability: 3.15,
    },
    paint: { base: '#696b7e', dark: '#454759', light: '#9295a7', marking: '#272938' },
    stats: { speed: 4, agility: 3, acceleration: 4 },
  },
];

export function getJetDefinition(id: string): JetDefinition {
  return JET_CATALOG.find((j) => j.id === id) ?? JET_CATALOG[0]!;
}
