import { falcon } from './designs/falcon';
import { kestrel } from './designs/kestrel';
import { raptor } from './designs/raptor';
import { specter } from './designs/specter';
import { viper } from './designs/viper';

export type Outline = Array<[number, number]>;

export interface JetDesign {
  /** Radius/forward coordinate, ascending from aft to nose; scaled after alignment along -Z. */
  fuselage: { profile: Outline; width: number; height: number };
  /** Same coordinates and scaling as the fuselage, with an overlapping seam. */
  radome: Outline;
  /** Right wing in global x/z coordinates, including its buried root. */
  wing: Outline;
  /** Right pivot and local x/z outline; mirrored for the left stabilizer. */
  stabilizer: { outline: Outline; x: number; y: number; z: number };
  /** Global aft z/local height outline, pivot x/y, and rotation about Z. */
  fins: Array<{ outline: Outline; x: number; y: number; cant: number }>;
  /** Housing/nozzle centers; each aft exit is at z + length / 2. */
  engines: Array<{ x: number; y: number; z: number; radius: number; length: number }>;
  /** Ellipsoid half axes; the lower half intersects the upper fuselage. */
  canopy: { y: number; z: number; width: number; height: number; length: number };
  intakes: Array<{ x: number; y: number; z: number; width: number; height: number; length: number }>;
  /** Right pivot and local x/z outline, mirrored for the left foreplane. */
  canards?: { outline: Outline; x: number; y: number; z: number };
  /** Positive span centers; the builder follows the wing's trailing edge. */
  controls: { aileron: { x: number; span: number; chord: number }; flap: { x: number; span: number; chord: number } };
  stores: boolean;
}

export const JET_DESIGNS: Readonly<Record<string, JetDesign>> = { falcon, viper, raptor, kestrel, specter };

export function getJetDesign(id: string): JetDesign {
  return Object.hasOwn(JET_DESIGNS, id) ? JET_DESIGNS[id]! : falcon;
}
