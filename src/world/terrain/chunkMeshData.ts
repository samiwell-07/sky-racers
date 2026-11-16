import type { TerrainConfig } from '../../config/worldConfig';

export interface ChunkArrays {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  minY: number;
  maxY: number;
}

/**
 * Vertex data for one terrain chunk at a given LOD. Pure (no Three.js objects), so it can run in a
 * Web Worker. Vertices sit on the global grid (LOD 0 = HeightField cells), so neighbouring chunks
 * share edges; normals come from neighbouring grid heights so they match across borders.
 * A skirt ring hanging below the border hides cracks between chunks of different LODs.
 */
export function computeChunkArrays(
  cx: number,
  cz: number,
  lod: number,
  cfg: TerrainConfig,
  heightFn: (x: number, z: number) => number,
): ChunkArrays {
  const cellSize = cfg.chunkSize / cfg.chunkSegments;
  const step = 1 << lod;
  const segs = cfg.chunkSegments / step;
  const n = segs + 1;
  const cell = cellSize * step;
  const baseI = cx * cfg.chunkSegments;
  const baseJ = cz * cfg.chunkSegments;

  // Heights with a one-vertex border ring for the normals.
  const m = n + 2;
  const h = new Float32Array(m * m);
  let minY = Infinity;
  let maxY = -Infinity;
  for (let j = 0; j < m; j++) {
    const z = (baseJ + (j - 1) * step) * cellSize;
    for (let i = 0; i < m; i++) {
      const v = heightFn((baseI + (i - 1) * step) * cellSize, z);
      h[j * m + i] = v;
      if (i > 0 && i < m - 1 && j > 0 && j < m - 1) {
        if (v < minY) minY = v;
        if (v > maxY) maxY = v;
      }
    }
  }

  const skirtDepth = 6 + lod * 14;
  const borderCount = segs * 4;
  const vertCount = n * n + borderCount;
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const uvScale = 1 / cfg.detailTextureScale;

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const v = j * n + i;
      const k = (j + 1) * m + (i + 1);
      const x = (baseI + i * step) * cellSize;
      const z = (baseJ + j * step) * cellSize;
      const hx = h[k - 1]! - h[k + 1]!;
      const hz = h[k - m]! - h[k + m]!;
      const ny = 2 * cell;
      const len = Math.hypot(hx, ny, hz);
      positions[v * 3] = x;
      positions[v * 3 + 1] = h[k]!;
      positions[v * 3 + 2] = z;
      normals[v * 3] = hx / len;
      normals[v * 3 + 1] = ny / len;
      normals[v * 3 + 2] = hz / len;
      uvs[v * 2] = x * uvScale;
      uvs[v * 2 + 1] = z * uvScale;
    }
  }

  const border = borderRing(segs);
  const skirtStart = n * n;
  for (let k = 0; k < border.length; k++) {
    const src = border[k]!;
    const dst = skirtStart + k;
    positions[dst * 3] = positions[src * 3]!;
    positions[dst * 3 + 1] = positions[src * 3 + 1]! - skirtDepth;
    positions[dst * 3 + 2] = positions[src * 3 + 2]!;
    normals[dst * 3] = normals[src * 3]!;
    normals[dst * 3 + 1] = normals[src * 3 + 1]!;
    normals[dst * 3 + 2] = normals[src * 3 + 2]!;
    uvs[dst * 2] = uvs[src * 2]!;
    uvs[dst * 2 + 1] = uvs[src * 2 + 1]!;
  }
  return { positions, normals, uvs, minY: minY - skirtDepth, maxY };
}

/** Border vertices, counter-clockwise seen from above. */
function borderRing(segs: number): number[] {
  const n = segs + 1;
  const border: number[] = [];
  for (let i = 0; i < segs; i++) border.push(i);
  for (let j = 0; j < segs; j++) border.push(j * n + segs);
  for (let i = segs; i > 0; i--) border.push(segs * n + i);
  for (let j = segs; j > 0; j--) border.push(j * n);
  return border;
}

const indexCache = new Map<number, Uint16Array | Uint32Array>();

/** Triangle indices for a chunk with `segs` cells per side (identical for every chunk of that LOD). */
export function chunkIndices(segs: number): Uint16Array | Uint32Array {
  let cached = indexCache.get(segs);
  if (cached) return cached;
  const n = segs + 1;
  const indices: number[] = [];
  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < segs; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      // Same diagonal as HeightField.getHeightAt: (i+1, j) -> (i, j+1).
      indices.push(a, c, b, b, c, d);
    }
  }
  const border = borderRing(segs);
  const skirtStart = n * n;
  for (let k = 0; k < border.length; k++) {
    const top0 = border[k]!;
    const top1 = border[(k + 1) % border.length]!;
    const bot0 = skirtStart + k;
    const bot1 = skirtStart + ((k + 1) % border.length);
    // Both windings so the skirt is visible from any side.
    indices.push(top0, bot0, top1, top1, bot0, bot1, top0, top1, bot0, top1, bot1, bot0);
  }
  const vertCount = n * n + border.length;
  cached = vertCount > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
  indexCache.set(segs, cached);
  return cached;
}
