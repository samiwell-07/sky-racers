import type { JetDesign } from '../jetDesigns';

export const viper: JetDesign = {
  fuselage: {
    profile: [
      [0.72, -6.75], [0.86, -5.8], [0.94, -3.2], [1.01, -0.8],
      [1, 1.4], [0.91, 3.3], [0.74, 4.7], [0.5, 6.05], [0.49, 6.25],
    ],
    width: 1.03, height: 0.85,
  },
  radome: [[0.49, 6.15], [0.49, 6.25], [0.4, 6.85], [0.22, 7.7], [0.08, 8.15], [0, 8.35]],
  canopy: { y: 0.64, z: -3.85, width: 0.62, height: 0.76, length: 1.55 },
  intakes: [{ x: 0, y: -0.73, z: -1.65, width: 1.35, height: 0.76, length: 3.35 }],
  engines: [{ x: 0, y: -0.03, z: 6.85, radius: 0.68, length: 1.65 }],

  // Long root strakes turn sharply into short outer panels with squared-off tips.
  wing: [[0.25, -5.05], [0.96, -3.55], [1.52, -1.42], [5.18, 0.4],
    [5.18, 2.08], [4.87, 2.46], [1.25, 2.93], [0.25, 3.58]],
  controls: {
    flap: { x: 2.08, span: 1.35, chord: 0.68 },
    aileron: { x: 3.88, span: 1.7, chord: 0.52 },
  },
  stabilizer: {
    outline: [[-0.58, -1.32], [0.24, -1.05], [2.26, 0.32],
      [2.19, 1.02], [1.79, 1.3], [-0.58, 0.65]],
    x: 0.76, y: -0.15, z: 5.79,
  },
  fins: [{
    outline: [[2.28, -0.1], [4.16, 0.94], [5.47, 3.05],
      [6.36, 3.05], [6.48, 1.22], [6.78, -0.1]],
    x: 0, y: 0.32, cant: 0,
  }],
  stores: false,
};
