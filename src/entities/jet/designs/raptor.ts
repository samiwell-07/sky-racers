import type { JetDesign } from '../jetDesigns';

const fin: JetDesign['fins'][number]['outline'] = [
  [3.7, -0.18], [4.85, 0.62], [6.25, 2.45], [7.28, 2.3], [8.02, -0.18],
];

export const raptor: JetDesign = {
  fuselage: {
    profile: [
      [0.98, -8.16], [1.13, -7.25], [1.22, -4.8], [1.27, -1.6],
      [1.26, 1.65], [1.15, 3.75], [0.82, 5.35], [0.53, 7.12], [0.37, 8.28],
    ],
    width: 1.79, height: 0.72,
  },
  radome: [[0.38, 8.15], [0.37, 8.28], [0.24, 9.18], [0.09, 10.02], [0, 10.42]],
  wing: [
    [0.34, -6.55], [1.46, -5.15], [2.26, -3.32], [2.92, -3.08],
    [6.7, 0.74], [6.56, 1.58], [3.55, 5.55], [1.77, 5.96], [0.34, 5.82],
  ],
  stabilizer: {
    outline: [[-0.8, -1.2], [0.9, -1.57], [3.25, 0.82], [2.15, 2.12], [-0.8, 1.07]],
    x: 1.35, y: -0.04, z: 7.12,
  },
  fins: [
    { outline: fin, x: -1.38, y: 0.31, cant: 0.54 },
    { outline: fin, x: 1.38, y: 0.31, cant: -0.54 },
  ],
  engines: [
    { x: -0.94, y: -0.06, z: 8.22, radius: 0.73, length: 2.46 },
    { x: 0.94, y: -0.06, z: 8.22, radius: 0.73, length: 2.46 },
  ],
  canopy: { y: 0.54, z: -4.84, width: 0.58, height: 0.51, length: 1.92 },
  intakes: [
    { x: -1.68, y: -0.25, z: -1.31, width: 1.08, height: 0.82, length: 4.65 },
    { x: 1.68, y: -0.25, z: -1.31, width: 1.08, height: 0.82, length: 4.65 },
  ],
  controls: {
    aileron: { x: 5.13, span: 2.36, chord: 0.62 },
    flap: { x: 2.76, span: 1.24, chord: 0.78 },
  },
  stores: false,
};
