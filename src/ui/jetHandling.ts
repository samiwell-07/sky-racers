import { DEFAULT_FLIGHT_CONFIG, createFlightConfig, type FlightConfig } from '../config/flightConfig';
import type { JetDefinition } from '../entities/jet/jetCatalog';

export interface HandlingTrait {
  id: 'topSpeed' | 'acceleration' | 'turn' | 'stability';
  label: string;
  /** Ratio to the standard airframe (DEFAULT_FLIGHT_CONFIG); 1 = same. */
  ratio: number;
  /** 0..1 bar fill, 0.5 = standard. */
  bar: number;
  /** Plain-language comparison ("Higher", "Similar"...). */
  verdict: string;
}

const ratioOf = (c: FlightConfig): Record<HandlingTrait['id'], number> => {
  const d = DEFAULT_FLIGHT_CONFIG;
  const roll = c.maxRollRate / d.maxRollRate;
  const pitch = c.maxPitchRate / d.maxPitchRate;
  const response = c.rateResponse / d.rateResponse;
  return {
    // Level-flight terminal speed scales with sqrt(thrust / drag).
    topSpeed: Math.sqrt((c.maxThrust / c.dragCoefficient) / (d.maxThrust / d.dragCoefficient)),
    // Mostly thrust, with a little from how quickly the throttle spools up.
    acceleration: (c.maxThrust / d.maxThrust) * Math.pow(c.throttleRate / d.throttleRate, 0.15),
    turn: Math.cbrt(roll * pitch * response),
    // Steadier with more weathervane stability and calmer (lower) commanded rates.
    stability: (c.directionalStability / d.directionalStability) / Math.sqrt(roll * pitch),
  };
};

function verdict(ratio: number): string {
  if (ratio >= 1.25) return 'Much higher';
  if (ratio >= 1.06) return 'Higher';
  if (ratio > 1 / 1.06) return 'Similar';
  if (ratio > 1 / 1.25) return 'Lower';
  return 'Much lower';
}

const LABELS: Record<HandlingTrait['id'], string> = {
  topSpeed: 'Top speed',
  acceleration: 'Acceleration',
  turn: 'Turn response',
  stability: 'Stability',
};

/**
 * Relative handling tendencies of a jet, derived from its flight-model overrides compared with
 * the standard airframe. These are tendencies, not measured performance figures.
 */
export function jetHandling(def: Pick<JetDefinition, 'flight'>): HandlingTrait[] {
  const r = ratioOf(createFlightConfig(def.flight));
  return (Object.keys(LABELS) as Array<HandlingTrait['id']>).map((id) => ({
    id,
    label: LABELS[id],
    ratio: r[id],
    bar: Math.min(0.96, Math.max(0.04, 0.5 + Math.log2(r[id]) * 0.9)),
    verdict: verdict(r[id]),
  }));
}
