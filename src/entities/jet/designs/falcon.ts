import type { JetDesign, Outline } from '../jetDesigns';

const fin: Outline = [
  [3.95, -0.18], [5.45, 0.78], [6.38, 3.27],
  [7.46, 3.27], [7.84, 2.92], [8.04, -0.18],
];

export const falcon: JetDesign = {
  fuselage: {
    profile: [
      [0.98, -8.12], [1.12, -6.94], [1.21, -4.4], [1.24, -1.6],
      [1.16, 1.65], [0.96, 3.95], [0.77, 5.52], [0.59, 6.85], [0.43, 7.72],
    ],
    width: 1.43, height: 0.8,
  },
  radome: [[0.43, 7.62], [0.43, 7.72], [0.33, 8.53], [0.2, 9.32], [0.08, 9.91], [0, 10.22]],
  // Long shoulder strakes break into a wider, shallower sweep on the outer panels.
  wing: [
    [0.46, -6.48], [1.54, -4.88], [2.67, -1.44], [3.12, -1.52],
    [6.54, 0.93], [6.54, 2.35], [6.02, 2.76], [3.57, 3.6], [0.46, 5.36],
  ],
  stabilizer: {
    outline: [[-0.8, -1.37], [0.68, -1.0], [3.57, 0.22], [3.4, 1.04], [2.79, 1.42], [-0.8, 0.82]],
    x: 1.12, y: -0.15, z: 7.17,
  },
  fins: [
    { outline: fin, x: -0.96, y: 0.35, cant: 0.21 },
    { outline: fin, x: 0.96, y: 0.35, cant: -0.21 },
  ],
  engines: [
    { x: -0.74, y: -0.08, z: 8.15, radius: 0.69, length: 2.48 },
    { x: 0.74, y: -0.08, z: 8.15, radius: 0.69, length: 2.48 },
  ],
  canopy: { y: 0.63, z: -4.83, width: 0.56, height: 0.64, length: 2.25 },
  intakes: [
    { x: -1.46, y: -0.26, z: -0.99, width: 0.94, height: 1.08, length: 4.42 },
    { x: 1.46, y: -0.26, z: -0.99, width: 0.94, height: 1.08, length: 4.42 },
  ],
  controls: {
    aileron: { x: 4.83, span: 2.12, chord: 0.62 },
    flap: { x: 2.52, span: 1.76, chord: 0.88 },
  },
  stores: true,
};
