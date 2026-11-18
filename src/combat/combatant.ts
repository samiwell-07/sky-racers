import type { Quaternion, Vector3 } from 'three';
import type { Combatant } from './types';

/** The parts of a Jet a Combatant needs (structural, so combat never imports the jet model). */
export interface JetLike {
  readonly flight: {
    readonly state: { readonly position: Vector3; readonly velocity: Vector3; readonly orientation: Quaternion };
    readonly telemetry: { readonly afterburner: boolean };
  };
  readonly damage: { readonly destroyed: boolean };
}

/** Live (non-copying) Combatant view of the local jet: read it after the physics step. */
export function combatantFromJet(id: string, jet: JetLike, isAlive: () => boolean = () => !jet.damage.destroyed): Combatant {
  return {
    id,
    get position() {
      return jet.flight.state.position;
    },
    get velocity() {
      return jet.flight.state.velocity;
    },
    get orientation() {
      return jet.flight.state.orientation;
    },
    get afterburner() {
      return jet.flight.telemetry.afterburner;
    },
    get alive() {
      return isAlive();
    },
  };
}
