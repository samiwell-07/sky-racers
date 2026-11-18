import type { TerrainConfig } from '../../config/worldConfig';
import type { WorldGenerator } from '../gen/WorldGenerator';

/**
 * Water surface vertex data for one terrain chunk (pure: no DOM or Three.js, runs in the terrain
 * worker). Positions and uvs are in world space; all buffers are transferable.
 */
export interface WaterArrays {
  positions: Float32Array;
  /** World-space ripple texture coordinates (x / RIPPLE_UV_SIZE, z / RIPPLE_UV_SIZE). */
  uvs: Float32Array;
  indices: Uint32Array;
  minY: number;
  maxY: number;
  /** Linear RGB vertex tint (shallow river green-blue to deep ocean blue, from the water depth). */
  colors?: Float32Array;
}

/** World meters per repeat of the ripple normal map. */
export const RIPPLE_UV_SIZE = 30;

/** Depths (m) where the tint goes from the shallow to the deep color. */
const SHALLOW_DEPTH = 3;
const DEEP_DEPTH = 35;
/** Cells per side when the whole chunk is open water at one level. */
const OPEN_WATER_CELLS = 4;
/** Max level spread (m) for the open-water fast path. */
const FLAT_TOLERANCE = 0.05;

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const hexToLinear = (hex: number): [number, number, number] => [
  srgbToLinear(((hex >> 16) & 255) / 255),
  srgbToLinear(((hex >> 8) & 255) / 255),
  srgbToLinear((hex & 255) / 255),
];
/** Same tint as the Classic River (#3d6f7d) for shallow water, deeper blue for the ocean. */
export const SHALLOW_WATER_COLOR = hexToLinear(0x3d6f7d);
export const DEEP_WATER_COLOR = hexToLinear(0x1b4766);

function depthTint(depth: number, out: Float32Array, o: number): void {
  let t = (depth - SHALLOW_DEPTH) / (DEEP_DEPTH - SHALLOW_DEPTH);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  t = t * t * (3 - 2 * t);
  for (let c = 0; c < 3; c++) out[o + c] = SHALLOW_WATER_COLOR[c]! + (DEEP_WATER_COLOR[c]! - SHALLOW_WATER_COLOR[c]!) * t;
}

/**
 * Water mesh data for chunk (cx, cz) at `lod`, on the same grid as computeChunkArrays
 * (cell = chunkSize / chunkSegments * 2^lod). Returns null when no grid vertex of the chunk has
 * water above the ground. Every grid cell with a wet corner is emitted; dry corners take the level
 * of their wet neighbours so the surface runs into the shore (the terrain hides what is below it).
 */
export function computeWaterArrays(cx: number, cz: number, lod: number, cfg: TerrainConfig, world: WorldGenerator): WaterArrays | null {
  const cellSize = cfg.chunkSize / cfg.chunkSegments;
  const step = 1 << lod;
  const segs = Math.max(1, cfg.chunkSegments >> lod);
  const n = segs + 1;
  const baseI = cx * cfg.chunkSegments;
  const baseJ = cz * cfg.chunkSegments;
  // Grid with a one-vertex border ring (index (i + 1, j + 1) = chunk vertex (i, j)) so shore
  // extension sees the neighbours across the chunk edge and matches the adjacent chunk.
  const m = n + 2;
  const level = new Float64Array(m * m).fill(-Infinity);
  const ground = new Float64Array(m * m).fill(Number.NaN);
  const wet = new Uint8Array(m * m);
  const xAt = (i: number): number => (baseI + (i - 1) * step) * cellSize;
  const zAt = (j: number): number => (baseJ + (j - 1) * step) * cellSize;

  const sample = (k: number, x: number, z: number): boolean => {
    const w = world.waterLevelAt(x, z);
    if (!(w > -Infinity)) return false;
    level[k] = w;
    const g = world.heightAt(x, z);
    ground[k] = g;
    if (w > g) wet[k] = 1;
    return wet[k] === 1;
  };

  // Interior first: most land chunks stop here without touching the ground height.
  let anyWet = false;
  let allWet = true;
  let minLevel = Infinity;
  let maxLevel = -Infinity;
  for (let j = 1; j <= n; j++) {
    const z = zAt(j);
    for (let i = 1; i <= n; i++) {
      const k = j * m + i;
      if (sample(k, xAt(i), z)) {
        anyWet = true;
        if (level[k]! < minLevel) minLevel = level[k]!;
        if (level[k]! > maxLevel) maxLevel = level[k]!;
      } else allWet = false;
    }
  }
  if (!anyWet) return null;

  if (allWet && maxLevel - minLevel <= FLAT_TOLERANCE) return openWater(n, m, segs, level, ground, xAt, zAt);

  for (let j = 0; j < m; j++) {
    const edgeRow = j === 0 || j === m - 1;
    for (let i = 0; i < m; i++) if (edgeRow || i === 0 || i === m - 1) sample(j * m + i, xAt(i), zAt(j));
  }

  // Mark the vertices used by cells with at least one wet corner.
  const used = new Int32Array(m * m).fill(-1);
  let vertCount = 0;
  let cellCount = 0;
  for (let j = 1; j < n; j++) {
    for (let i = 1; i < n; i++) {
      const a = j * m + i;
      if (!(wet[a] || wet[a + 1] || wet[a + m] || wet[a + m + 1])) continue;
      cellCount++;
      for (const k of [a, a + 1, a + m, a + m + 1]) if (used[k] === -1) used[k] = vertCount++;
    }
  }

  const positions = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const colors = new Float32Array(vertCount * 3);
  let minY = Infinity;
  let maxY = -Infinity;
  for (let j = 1; j <= n; j++) {
    for (let i = 1; i <= n; i++) {
      const k = j * m + i;
      const v = used[k]!;
      if (v < 0) continue;
      const x = xAt(i);
      const z = zAt(j);
      const y = vertexLevel(k, m, level, wet);
      let g = ground[k]!;
      if (Number.isNaN(g)) g = world.heightAt(x, z);
      positions[v * 3] = x;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = z;
      uvs[v * 2] = x / RIPPLE_UV_SIZE;
      uvs[v * 2 + 1] = z / RIPPLE_UV_SIZE;
      depthTint(y - g, colors, v * 3);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  const indices = new Uint32Array(cellCount * 6);
  let o = 0;
  for (let j = 1; j < n; j++) {
    for (let i = 1; i < n; i++) {
      const a = j * m + i;
      if (!(wet[a] || wet[a + 1] || wet[a + m] || wet[a + m + 1])) continue;
      const va = used[a]!;
      const vb = used[a + 1]!;
      const vc = used[a + m]!;
      const vd = used[a + m + 1]!;
      // Same winding and diagonal as the terrain chunks (faces +Y).
      indices[o++] = va;
      indices[o++] = vc;
      indices[o++] = vb;
      indices[o++] = vb;
      indices[o++] = vc;
      indices[o++] = vd;
    }
  }
  return { positions, uvs, indices, minY, maxY, colors };
}

/**
 * Surface height at a grid vertex: its own level when wet (or when the level is known under a dry
 * bank), else the mean level of its wet neighbours (the shore extension).
 */
function vertexLevel(k: number, m: number, level: Float64Array, wet: Uint8Array): number {
  if (wet[k] || level[k]! > -Infinity) return level[k]!;
  let sum = 0;
  let count = 0;
  for (let dj = -m; dj <= m; dj += m) {
    for (let di = -1; di <= 1; di++) {
      const q = k + dj + di;
      if (wet[q]) {
        sum += level[q]!;
        count++;
      }
    }
  }
  return count > 0 ? sum / count : 0;
}

/** Whole chunk under water at one level: a coarse grid is enough (flat surface, tint per vertex). */
function openWater(
  n: number,
  m: number,
  segs: number,
  level: Float64Array,
  ground: Float64Array,
  xAt: (i: number) => number,
  zAt: (j: number) => number,
): WaterArrays {
  const cells = Math.min(segs, OPEN_WATER_CELLS);
  const stride = segs / cells;
  const cn = cells + 1;
  const positions = new Float32Array(cn * cn * 3);
  const uvs = new Float32Array(cn * cn * 2);
  const colors = new Float32Array(cn * cn * 3);
  let minY = Infinity;
  let maxY = -Infinity;
  for (let cj = 0; cj < cn; cj++) {
    for (let ci = 0; ci < cn; ci++) {
      const i = 1 + Math.min(n - 1, Math.round(ci * stride));
      const j = 1 + Math.min(n - 1, Math.round(cj * stride));
      const k = j * m + i;
      const v = cj * cn + ci;
      const x = xAt(i);
      const z = zAt(j);
      const y = level[k]!;
      positions[v * 3] = x;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = z;
      uvs[v * 2] = x / RIPPLE_UV_SIZE;
      uvs[v * 2 + 1] = z / RIPPLE_UV_SIZE;
      depthTint(y - ground[k]!, colors, v * 3);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const indices = new Uint32Array(cells * cells * 6);
  let o = 0;
  for (let cj = 0; cj < cells; cj++) {
    for (let ci = 0; ci < cells; ci++) {
      const a = cj * cn + ci;
      indices.set([a, a + cn, a + 1, a + 1, a + cn, a + cn + 1], o);
      o += 6;
    }
  }
  return { positions, uvs, indices, minY, maxY, colors };
}
