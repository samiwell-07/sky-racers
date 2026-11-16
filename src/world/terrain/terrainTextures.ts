import { CanvasTexture, RepeatWrapping, SRGBColorSpace, NoColorSpace, type Texture } from 'three';
import { mulberry32 } from '../../utils/random';

/** Tileable value noise: random lattice with wrap-around, smoothly interpolated. */
export function tileableValueNoise(size: number, cells: number, random: () => number): Float32Array {
  const grid = new Float32Array(cells * cells);
  for (let i = 0; i < grid.length; i++) grid[i] = random();
  const out = new Float32Array(size * size);
  const step = size / cells;
  for (let y = 0; y < size; y++) {
    const gy = y / step;
    const y0 = Math.floor(gy) % cells;
    const y1 = (y0 + 1) % cells;
    let ty = gy - Math.floor(gy);
    ty = ty * ty * (3 - 2 * ty);
    for (let x = 0; x < size; x++) {
      const gx = x / step;
      const x0 = Math.floor(gx) % cells;
      const x1 = (x0 + 1) % cells;
      let tx = gx - Math.floor(gx);
      tx = tx * tx * (3 - 2 * tx);
      const a = grid[y0 * cells + x0]! + (grid[y0 * cells + x1]! - grid[y0 * cells + x0]!) * tx;
      const b = grid[y1 * cells + x0]! + (grid[y1 * cells + x1]! - grid[y1 * cells + x0]!) * tx;
      out[y * size + x] = a + (b - a) * ty;
    }
  }
  return out;
}

function fractal(size: number, seed: number, octaves: Array<[cells: number, weight: number]>): Float32Array {
  const random = mulberry32(seed);
  const out = new Float32Array(size * size);
  let total = 0;
  for (const [cells, weight] of octaves) {
    const layer = tileableValueNoise(size, cells, random);
    for (let i = 0; i < out.length; i++) out[i]! += layer[i]! * weight;
    total += weight;
  }
  for (let i = 0; i < out.length; i++) out[i]! /= total;
  return out;
}

function toTexture(size: number, fill: (i: number, data: Uint8ClampedArray) => void, srgb: boolean, anisotropy: number): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) fill(i, image.data);
  ctx.putImageData(image, 0, 0);
  const tex = new CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  tex.anisotropy = anisotropy;
  return tex;
}

function colorTexture(
  size: number,
  seed: number,
  octaves: Array<[number, number]>,
  dark: [number, number, number],
  light: [number, number, number],
  contrast: number,
  anisotropy: number,
  speckle = 0,
): Texture {
  const n = fractal(size, seed, octaves);
  const random = mulberry32(seed + 1);
  return toTexture(size, (i, d) => {
    let t = Math.min(1, Math.max(0, 0.5 + (n[i]! - 0.5) * contrast));
    if (speckle > 0 && random() < speckle) t *= 0.6;
    d[i * 4] = dark[0] + (light[0] - dark[0]) * t;
    d[i * 4 + 1] = dark[1] + (light[1] - dark[1]) * t;
    d[i * 4 + 2] = dark[2] + (light[2] - dark[2]) * t;
    d[i * 4 + 3] = 255;
  }, true, anisotropy);
}

export interface TerrainTextureSet {
  grass: Texture;
  rock: Texture;
  dirt: Texture;
  snow: Texture;
  normal: Texture;
}

/** Procedural, seamless ground textures for the splat-mapped terrain material. */
export function createTerrainTextures(anisotropy: number, size = 512): TerrainTextureSet {
  const grass = colorTexture(size, 11, [[8, 0.25], [32, 0.3], [128, 0.25], [256, 0.2]], [62, 92, 38], [128, 150, 70], 1.8, anisotropy, 0.05);
  const rock = colorTexture(size, 23, [[4, 0.35], [16, 0.3], [64, 0.2], [256, 0.15]], [92, 86, 80], [176, 168, 156], 2.2, anisotropy);
  const dirt = colorTexture(size, 37, [[8, 0.3], [32, 0.3], [128, 0.4]], [110, 90, 62], [170, 146, 108], 1.6, anisotropy, 0.08);
  const snow = colorTexture(size, 41, [[4, 0.4], [32, 0.4], [128, 0.2]], [210, 218, 230], [250, 252, 255], 1.2, anisotropy);

  // Normal map from a bumpy height field (tileable, central differences with wrap).
  const h = fractal(size, 53, [[16, 0.3], [64, 0.35], [256, 0.35]]);
  const at = (x: number, y: number): number => h[((y + size) % size) * size + ((x + size) % size)]!;
  const strength = 6;
  const normal = toTexture(size, (i, d) => {
    const x = i % size;
    const y = Math.floor(i / size);
    const nx = (at(x - 1, y) - at(x + 1, y)) * strength;
    const ny = (at(x, y - 1) - at(x, y + 1)) * strength;
    const len = Math.hypot(nx, ny, 1);
    d[i * 4] = ((nx / len) * 0.5 + 0.5) * 255;
    d[i * 4 + 1] = ((ny / len) * 0.5 + 0.5) * 255;
    d[i * 4 + 2] = ((1 / len) * 0.5 + 0.5) * 255;
    d[i * 4 + 3] = 255;
  }, false, anisotropy);

  return { grass, rock, dirt, snow, normal };
}
