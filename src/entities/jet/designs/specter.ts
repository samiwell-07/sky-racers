import type { JetDesign } from '../jetDesigns';

export const specter: JetDesign = {
  fuselage: {
    profile: [
      [1.01, -8.16], [1.13, -7.05], [1.19, -4.7], [1.16, -2.05],
      [1.02, 0.65], [0.83, 2.45], [0.69, 3.95], [0.56, 5.55], [0.39, 7.12],
    ],
    width: 1.48,
    height: 0.81,
  },
  radome: [[0.39, 7.0], [0.39, 7.12], [0.3, 8.22], [0.18, 9.35], [0.07, 10.12], [0, 10.48]],
  // The short inboard glove turns aft before the main panel sweeps sharply toward the cockpit.
  wing: [
    [0.32, -0.65], [1.72, 1.82], [6.36, -4.1], [6.68, -4.32],
    [6.73, -3.2], [6.28, -2.24], [1.65, 5.48], [0.32, 5.64],
  ],
  stabilizer: {
    outline: [[-0.8, -1.08], [0.58, -1.26], [3.04, 0.26], [2.91, 0.92], [1.52, 1.43], [-0.8, 0.75]],
    x: 1.13, y: -0.08, z: 7.26,
  },
  fins: [{
    outline: [[2.55, -0.16], [4.74, 0.9], [6.34, 3.48], [7.28, 3.48], [8.14, 0.28], [8.1, -0.16]],
    x: 0, y: 0.32, cant: 0,
  }],
  engines: [
    { x: -0.77, y: -0.07, z: 8.13, radius: 0.69, length: 2.54 },
    { x: 0.77, y: -0.07, z: 8.13, radius: 0.69, length: 2.54 },
  ],
  canopy: { y: 0.45, z: -4.16, width: 0.47, height: 0.55, length: 2.06 },
  intakes: [
    { x: -1.23, y: -0.24, z: -0.21, width: 0.93, height: 0.84, length: 4.65 },
    { x: 1.23, y: -0.24, z: -0.21, width: 0.93, height: 0.84, length: 4.65 },
  ],
  controls: {
    aileron: { x: 5.07, span: 2.04, chord: 0.54 },
    flap: { x: 2.83, span: 1.74, chord: 0.79 },
  },
  stores: false,
};
