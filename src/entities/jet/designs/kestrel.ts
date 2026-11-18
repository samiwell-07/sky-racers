import type { JetDesign } from '../jetDesigns';

export const kestrel: JetDesign = {
  fuselage: {
    profile: [
      [0.78, -6.85], [0.91, -5.7], [1.01, -3.8], [1.09, -1.6],
      [1.12, 0.6], [1.03, 2.45], [0.86, 4.15], [0.66, 5.5], [0.43, 6.8],
    ],
    width: 1.18, height: 0.88,
  },
  radome: [[0.43, 6.7], [0.43, 6.8], [0.32, 7.52], [0.17, 8.19], [0, 8.75]],
  canopy: { y: 0.64, z: -4.1, width: 0.54, height: 0.64, length: 1.75 },
  canards: {
    outline: [[-0.64, -1.18], [0.34, -1.12], [2.91, 0.28], [2.76, 0.88], [-0.64, 0.68]],
    x: 0.8, y: 0.31, z: -4.12,
  },
  intakes: [
    { x: -1.16, y: -0.22, z: -1.54, width: 0.86, height: 0.94, length: 2.7 },
    { x: 1.16, y: -0.22, z: -1.54, width: 0.86, height: 0.94, length: 2.7 },
  ],
  wing: [[0.3, -2.63], [1.42, -1.98], [6.68, 3.93], [6.68, 4.53], [0.3, 5.96]],
  controls: {
    aileron: { x: 5.01, span: 2.48, chord: 0.68 },
    flap: { x: 2.56, span: 1.78, chord: 0.94 },
  },
  // Keep the aft pitch surfaces inboard, tucked behind the delta's trailing edge.
  stabilizer: {
    outline: [[-0.58, -0.5], [0.54, -0.63], [1.12, -0.66], [0.93, 0.09], [-0.58, 0.6]],
    x: 0.86, y: -0.1, z: 6.36,
  },
  fins: [{
    outline: [[1.82, -0.13], [3.41, 0.98], [5.06, 3.23], [5.96, 3.23], [6.68, -0.13]],
    x: 0, y: 0.31, cant: 0,
  }],
  engines: [{ x: 0, y: -0.02, z: 7.05, radius: 0.76, length: 1.86 }],
  stores: false,
};
