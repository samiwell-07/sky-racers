import { Color, DataTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, SRGBColorSpace } from 'three';
import type { JetAppearance } from './jetAppearance';
import type { JetPaint } from './jetCatalog';

function raster(width: number, height: number, pixel: (x: number, y: number) => number): DataTexture {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const rgb = pixel(x, y);
      const i = 4 * (width * y + x);
      rgba[i] = rgb >> 16;
      rgba[i + 1] = rgb >> 8;
      rgba[i + 2] = rgb;
      rgba[i + 3] = 255;
    }
  }
  const texture = new DataTexture(rgba, width, height);
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.needsUpdate = true;
  return texture;
}

export function wrapTexture(paint: JetPaint, wrap: JetAppearance['wrap']): DataTexture {
  const size = 128;
  const factory = [paint.base, paint.dark, paint.light].map(css => new Color(css).getHex());
  const tau = Math.PI * 2;
  const texture = raster(size, size, (x, y) => {
    const u = x / size, v = y / size;
    switch (wrap) {
      case 'tactical': { // Stepped digital patches
        const col = Math.floor(u * 16), row = Math.floor(v * 16);
        const band = (col + 2 * row + Math.floor(col / 4)) % 10;
        return band < 3 ? 0x374652 : band < 5 ? 0x738591 : 0x515e69;
      }
      case 'splinter': { // Interlocking angular shards on a skewed grid
        const s = (u * 3 + v * 2) % 1, t = (v * 3 + u) % 1;
        return s + t < 0.8 ? 0x394751 : s - t > 0.18 ? 0xc3cdd0 : 0x7d929a;
      }
      case 'woodland': {
        const wave = Math.sin(tau * (u * 2 + v) + 1.6 * Math.sin(tau * v * 3)) + 0.7 * Math.cos(tau * (v * 2 - u));
        return wave > 0.65 ? 0x393e28 : wave < -0.5 ? 0x69543c : 0x637448;
      }
      case 'factory': {
        const cloud = Math.cos(tau * (3 * u - 2 * v)) + Math.sin(tau * 3 * v + Math.cos(tau * 2 * u));
        return factory[cloud > 0.8 ? 1 : cloud < -1 ? 2 : 0]!;
      }
    }
  });
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  return texture;
}

// Each row is a three-bit mask. Fixed glyphs keep the placard legible without fonts or canvas.
const DIGITS = [
  [7, 5, 5, 5, 7], [2, 6, 2, 2, 7], [7, 1, 7, 4, 7], [7, 1, 7, 1, 7], [5, 5, 7, 1, 1],
  [7, 4, 7, 1, 7], [7, 4, 7, 5, 7], [7, 1, 2, 2, 2], [7, 5, 7, 5, 7], [7, 5, 7, 1, 7],
];

export function numberTexture(number: string): DataTexture {
  return raster(4 * number.length + 1, 7, (x, y) => {
    const glyph = Math.floor((x - 1) / 4), col = (x - 1) % 4;
    const row = 5 - y; // DataTexture's first row is at v=0 (bottom).
    const ink = glyph >= 0 && glyph < number.length && col < 3 && row >= 0 && row < 5
      && (DIGITS[Number(number[glyph])]![row]! & (4 >> col));
    return ink ? 0xffffff : 0x192028;
  });
}
