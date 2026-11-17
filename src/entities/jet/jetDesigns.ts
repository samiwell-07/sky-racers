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

export const JET_DESIGNS: Readonly<Record<string, JetDesign>> = {
  falcon: {
    fuselage: {
      profile: [
        [1.01, -8.05], [1.06, -6.5], [1.12, -3.0], [1.14, 0],
        [1.08, 2.2], [0.96, 4.4], [0.79, 6.0], [0.61, 7.25], [0.44, 8.2],
      ],
      width: 1.3,
      height: 0.82,
    },
    radome: [[0.44, 8.05], [0.44, 8.2], [0.31, 9.2], [0.15, 10.0], [0, 10.4]],
    wing: [[0.4, -5.7], [1.8, -2.7], [6.4, 2.8], [6.6, 4.15], [0.4, 4.85]],
    stabilizer: {
      outline: [[-0.7, -1.15], [0.4, -0.85], [3.25, 0.65], [3.3, 1.35], [-0.7, 0.7]],
      x: 1.05, y: -0.02, z: 7.15,
    },
    fins: [
      { outline: [[4.5, -0.12], [6.65, 3.45], [7.6, 3.45], [8.05, -0.12]], x: -0.83, y: 0.3, cant: 0.32 },
      { outline: [[4.5, -0.12], [6.65, 3.45], [7.6, 3.45], [8.05, -0.12]], x: 0.83, y: 0.3, cant: -0.32 },
    ],
    engines: [
      { x: -0.64, y: -0.05, z: 8.35, radius: 0.61, length: 2.0 },
      { x: 0.64, y: -0.05, z: 8.35, radius: 0.61, length: 2.0 },
    ],
    canopy: { y: 0.58, z: -4.2, width: 0.55, height: 0.58, length: 1.9 },
    intakes: [
      { x: -1.3, y: -0.27, z: -0.65, width: 0.8, height: 0.95, length: 3.7 },
      { x: 1.3, y: -0.27, z: -0.65, width: 0.8, height: 0.95, length: 3.7 },
    ],
    controls: { aileron: { x: 4.8, span: 2.6, chord: 0.7 }, flap: { x: 2.45, span: 1.5, chord: 0.85 } },
    stores: true,
  },
  viper: {
    fuselage: {
      profile: [
        [0.96, -8.05], [1.04, -6.7], [1.08, -3.2], [1.06, 0],
        [0.96, 2.4], [0.81, 4.8], [0.62, 6.6], [0.42, 8.2],
      ],
      width: 1.08,
      height: 0.78,
    },
    radome: [[0.42, 8.05], [0.42, 8.2], [0.27, 9.15], [0.12, 9.85], [0, 10.15]],
    wing: [[0.35, -4.7], [1.35, -2.0], [6.45, 1.4], [6.45, 2.8], [5.75, 3.8], [0.35, 4.2]],
    stabilizer: {
      outline: [[-0.75, -1.0], [0.35, -0.9], [3.3, 0.1], [3.3, 0.85], [2.65, 1.55], [-0.75, 0.75]],
      x: 0.95, y: -0.04, z: 7.05,
    },
    fins: [
      { outline: [[3.8, -0.12], [6.05, 3.4], [7.0, 3.4], [7.95, -0.12]], x: 0, y: 0.29, cant: 0 },
    ],
    engines: [{ x: 0, y: -0.04, z: 8.28, radius: 0.79, length: 2.15 }],
    canopy: { y: 0.51, z: -4.3, width: 0.48, height: 0.58, length: 1.8 },
    intakes: [{ x: 0, y: -0.7, z: -1.6, width: 1.18, height: 0.65, length: 3.1 }],
    controls: { aileron: { x: 4.6, span: 2.2, chord: 0.6 }, flap: { x: 2.45, span: 1.6, chord: 0.75 } },
    stores: true,
  },
  raptor: {
    fuselage: {
      profile: [
        [1.04, -8.1], [1.16, -6.2], [1.24, -2.5], [1.24, 0.7],
        [1.12, 3.1], [0.89, 5.0], [0.66, 6.7], [0.43, 8.2],
      ],
      width: 1.6,
      height: 0.83,
    },
    radome: [[0.43, 8.05], [0.43, 8.2], [0.29, 9.2], [0.12, 10.0], [0, 10.3]],
    wing: [[0.4, -4.15], [1.75, -3.8], [6.6, 1.05], [6.6, 1.75], [3.1, 4.95], [0.4, 5.2]],
    stabilizer: {
      outline: [[-0.85, -1.4], [0.65, -1.25], [3.15, 0.55], [2.2, 1.85], [-0.85, 0.75]],
      x: 1.1, y: -0.03, z: 7.0,
    },
    fins: [
      { outline: [[4.05, -0.12], [5.8, 3.35], [6.75, 3.35], [8.1, -0.12]], x: -1.12, y: 0.34, cant: 0.48 },
      { outline: [[4.05, -0.12], [5.8, 3.35], [6.75, 3.35], [8.1, -0.12]], x: 1.12, y: 0.34, cant: -0.48 },
    ],
    engines: [
      { x: -0.85, y: -0.08, z: 8.35, radius: 0.71, length: 2.1 },
      { x: 0.85, y: -0.08, z: 8.35, radius: 0.71, length: 2.1 },
    ],
    canopy: { y: 0.59, z: -4.05, width: 0.65, height: 0.58, length: 2.15 },
    intakes: [
      { x: -1.62, y: -0.23, z: -1.1, width: 1.0, height: 1.05, length: 4.3 },
      { x: 1.62, y: -0.23, z: -1.1, width: 1.0, height: 1.05, length: 4.3 },
    ],
    controls: { aileron: { x: 4.9, span: 2.4, chord: 0.55 }, flap: { x: 2.6, span: 0.9, chord: 0.85 } },
    stores: false,
  },
  kestrel: {
    fuselage: {
      profile: [
        [0.94, -8.0], [1.02, -6.0], [1.1, -2.8], [1.09, 0.9],
        [0.99, 3.2], [0.85, 4.9], [0.65, 6.7], [0.41, 8.2],
      ],
      width: 1.22,
      height: 0.82,
    },
    radome: [[0.41, 8.05], [0.41, 8.2], [0.26, 9.15], [0.11, 9.9], [0, 10.2]],
    wing: [[0.35, -3.3], [1.35, -3.0], [6.6, 4.35], [6.3, 4.9], [0.35, 5.25]],
    stabilizer: {
      outline: [[-0.75, -0.7], [0.5, -0.55], [2.25, 0.65], [1.95, 1.15], [-0.75, 0.6]],
      x: 0.9, y: -0.03, z: 7.25,
    },
    fins: [
      { outline: [[4.4, -0.12], [6.05, 3.25], [6.8, 3.25], [8.0, -0.12]], x: 0, y: 0.31, cant: 0 },
    ],
    engines: [{ x: 0, y: -0.04, z: 8.3, radius: 0.84, length: 2.1 }],
    canopy: { y: 0.53, z: -4.45, width: 0.5, height: 0.56, length: 1.75 },
    intakes: [
      { x: -0.98, y: -0.36, z: -1.8, width: 0.66, height: 0.85, length: 2.5 },
      { x: 0.98, y: -0.36, z: -1.8, width: 0.66, height: 0.85, length: 2.5 },
    ],
    canards: {
      outline: [[-0.7, -0.8], [0.45, -0.65], [2.65, 0.5], [2.5, 1.05], [-0.7, 0.7]],
      x: 0.85, y: 0.08, z: -4.75,
    },
    controls: { aileron: { x: 4.8, span: 2.7, chord: 0.55 }, flap: { x: 2.4, span: 1.5, chord: 0.85 } },
    stores: false,
  },
  specter: {
    fuselage: {
      profile: [
        [1.02, -8.05], [1.14, -5.8], [1.17, -2.0], [1.08, 1.5],
        [0.94, 3.8], [0.76, 5.4], [0.59, 6.9], [0.41, 8.2],
      ],
      width: 1.45,
      height: 0.79,
    },
    radome: [[0.41, 8.05], [0.41, 8.2], [0.27, 9.2], [0.12, 10.0], [0, 10.35]],
    wing: [[0.4, 0.15], [1.65, 1.25], [6.6, -2.35], [6.6, -0.65], [5.85, 0.3], [1.55, 4.75], [0.4, 4.8]],
    stabilizer: {
      outline: [[-0.85, -1.2], [0.5, -0.95], [3.25, -0.35], [3.25, 0.45], [1.5, 1.65], [-0.85, 0.7]],
      x: 1.0, y: -0.03, z: 7.1,
    },
    fins: [
      { outline: [[4.8, -0.12], [6.35, 3.25], [7.25, 3.25], [8.05, -0.12]], x: 0, y: 0.32, cant: 0 },
    ],
    engines: [
      { x: -0.7, y: -0.05, z: 8.35, radius: 0.65, length: 2.0 },
      { x: 0.7, y: -0.05, z: 8.35, radius: 0.65, length: 2.0 },
    ],
    canopy: { y: 0.51, z: -4.45, width: 0.52, height: 0.56, length: 1.95 },
    intakes: [
      { x: -1.35, y: -0.28, z: -1.8, width: 0.86, height: 0.95, length: 3.8 },
      { x: 1.35, y: -0.28, z: -1.8, width: 0.86, height: 0.95, length: 3.8 },
    ],
    controls: { aileron: { x: 4.65, span: 2.2, chord: 0.55 }, flap: { x: 2.65, span: 1.35, chord: 0.75 } },
    stores: false,
  },
};

export function getJetDesign(id: string): JetDesign {
  return Object.hasOwn(JET_DESIGNS, id) ? JET_DESIGNS[id]! : JET_DESIGNS.falcon!;
}
