import { collideBuildingAt, collideRockAt, collideTreeAt } from './propsPlacement';
import type { CellData, ObstacleKind } from './propsPlacement';

/**
 * Typed-array form of a cell: collision records plus ready-to-upload instance matrices/colors.
 * Built in the props worker (or synchronously) and posted to the main thread with transferables.
 */

/** x, y, z, height, widthScale, kind (0 = conifer, 1 = broadleaf). */
export const TREE_STRIDE = 6;
/** x, y, z, radius, squash. */
export const ROCK_STRIDE = 5;
/** x, y, z, width, depth, wallHeight, roofHeight, heading. */
export const BUILDING_STRIDE = 8;

export const PROP_MESH_KINDS = ['conifer', 'broadleaf', 'rock', 'walls', 'roof'] as const;
export type PropMeshKind = (typeof PROP_MESH_KINDS)[number];

export interface InstanceArrays {
  /** 16 floats (column-major Matrix4) per instance. */
  matrices: Float32Array<ArrayBuffer>;
  /** Linear RGB per instance. */
  colors: Float32Array<ArrayBuffer>;
}

export interface PackedCell {
  cellX: number;
  cellZ: number;
  /** Highest point of any obstacle (-Infinity when empty). */
  maxTop: number;
  /** Horizontal extent of all obstacles, including their collision reach. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Collision records sorted by z (see the strides); the reach is the largest per-record xz extent. */
  trees: Float64Array<ArrayBuffer>;
  treeReach: number;
  rocks: Float64Array<ArrayBuffer>;
  rockReach: number;
  buildings: Float64Array<ArrayBuffer>;
  instances: Record<PropMeshKind, InstanceArrays>;
}

function srgbToLinear(c: number): number {
  return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}

/** Same result as Matrix4.compose(position, quaternion about +Y, scale). */
function writeMatrix(
  out: Float32Array, k: number,
  x: number, y: number, z: number, rotation: number, sx: number, sy: number, sz: number,
): void {
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  const o = k * 16;
  out[o] = c * sx;
  out[o + 1] = 0;
  out[o + 2] = -s * sx;
  out[o + 3] = 0;
  out[o + 4] = 0;
  out[o + 5] = sy;
  out[o + 6] = 0;
  out[o + 7] = 0;
  out[o + 8] = s * sz;
  out[o + 9] = 0;
  out[o + 10] = c * sz;
  out[o + 11] = 0;
  out[o + 12] = x;
  out[o + 13] = y;
  out[o + 14] = z;
  out[o + 15] = 1;
}

function writeColor(out: Float32Array, k: number, r: number, g: number, b: number): void {
  out[k * 3] = r;
  out[k * 3 + 1] = g;
  out[k * 3 + 2] = b;
}

function writeHexColor(out: Float32Array, k: number, hex: number): void {
  writeColor(out, k, srgbToLinear(((hex >> 16) & 255) / 255), srgbToLinear(((hex >> 8) & 255) / 255), srgbToLinear((hex & 255) / 255));
}

function instanceArrays(count: number): InstanceArrays {
  return { matrices: new Float32Array(count * 16), colors: new Float32Array(count * 3) };
}

export function packCell(cell: CellData): PackedCell {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  const grow = (x: number, z: number, reach: number): void => {
    minX = Math.min(minX, x - reach);
    maxX = Math.max(maxX, x + reach);
    minZ = Math.min(minZ, z - reach);
    maxZ = Math.max(maxZ, z + reach);
  };

  let coniferCount = 0;
  for (const t of cell.trees) if (t.kind === 'conifer') coniferCount++;
  const conifer = instanceArrays(coniferCount);
  const broadleaf = instanceArrays(cell.trees.length - coniferCount);
  const trees = new Float64Array(cell.trees.length * TREE_STRIDE);
  let treeReach = 0;
  sortedByZ(cell.trees).forEach((t, k) => {
    const o = k * TREE_STRIDE;
    trees[o] = t.x;
    trees[o + 1] = t.y;
    trees[o + 2] = t.z;
    trees[o + 3] = t.height;
    trees[o + 4] = t.widthScale;
    trees[o + 5] = t.kind === 'conifer' ? 0 : 1;
    treeReach = Math.max(treeReach, t.height * t.widthScale * 0.4);
  });
  let ci = 0;
  let bi = 0;
  for (const t of cell.trees) {
    grow(t.x, t.z, t.height * t.widthScale * 0.4);
    const target = t.kind === 'conifer' ? conifer : broadleaf;
    const idx = t.kind === 'conifer' ? ci++ : bi++;
    const w = t.height * t.widthScale;
    writeMatrix(target.matrices, idx, t.x, t.y, t.z, t.rotation, w, t.height, w);
    writeColor(target.colors, idx, t.tint[0], t.tint[1], t.tint[2]);
  }

  const rock = instanceArrays(cell.rocks.length);
  const rocks = new Float64Array(cell.rocks.length * ROCK_STRIDE);
  let rockReach = 0;
  sortedByZ(cell.rocks).forEach((r, k) => {
    const o = k * ROCK_STRIDE;
    rocks[o] = r.x;
    rocks[o + 1] = r.y;
    rocks[o + 2] = r.z;
    rocks[o + 3] = r.radius;
    rocks[o + 4] = r.squash;
    rockReach = Math.max(rockReach, r.radius);
  });
  cell.rocks.forEach((r, k) => {
    grow(r.x, r.z, r.radius);
    writeMatrix(rock.matrices, k, r.x, r.y, r.z, r.rotation, r.radius, r.radius * r.squash, r.radius);
    const g = 0.52 * r.shade;
    writeColor(rock.colors, k, g, g * 0.98, g * 0.94);
  });

  const walls = instanceArrays(cell.buildings.length);
  const roof = instanceArrays(cell.buildings.length);
  const buildings = new Float64Array(cell.buildings.length * BUILDING_STRIDE);
  cell.buildings.forEach((b, k) => {
    const o = k * BUILDING_STRIDE;
    buildings[o] = b.x;
    buildings[o + 1] = b.y;
    buildings[o + 2] = b.z;
    buildings[o + 3] = b.width;
    buildings[o + 4] = b.depth;
    buildings[o + 5] = b.wallHeight;
    buildings[o + 6] = b.roofHeight;
    buildings[o + 7] = b.heading;
    grow(b.x, b.z, 25);
    writeMatrix(walls.matrices, k, b.x, b.y, b.z, b.heading, b.width, b.wallHeight, b.depth);
    writeHexColor(walls.colors, k, b.wallColor);
    writeMatrix(roof.matrices, k, b.x, b.y + b.wallHeight, b.z, b.heading, b.width, b.roofHeight, b.depth);
    writeHexColor(roof.colors, k, b.roofColor);
  });

  return {
    cellX: cell.cellX,
    cellZ: cell.cellZ,
    maxTop: cell.maxTop,
    minX,
    maxX,
    minZ,
    maxZ,
    trees,
    treeReach,
    rocks,
    rockReach,
    buildings,
    instances: { conifer, broadleaf, rock, walls, roof },
  };
}

/** Buffers to transfer when posting a packed cell. */
export function packedCellTransferables(cell: PackedCell): ArrayBuffer[] {
  const out: ArrayBuffer[] = [cell.trees.buffer, cell.rocks.buffer, cell.buildings.buffer];
  for (const kind of PROP_MESH_KINDS) out.push(cell.instances[kind].matrices.buffer, cell.instances[kind].colors.buffer);
  return out;
}

function sortedByZ<T extends { z: number }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => a.z - b.z);
}

/** First record (of `stride` floats, sorted by z at offset 2) with z >= minZ, as a float offset. */
function lowerBoundZ(data: Float64Array, stride: number, minZ: number): number {
  let lo = 0;
  let hi = data.length / stride;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (data[mid * stride + 2]! < minZ) lo = mid + 1;
    else hi = mid;
  }
  return lo * stride;
}

/** Same result as collideCell() on the unpacked cell, with bounds early-outs and no allocations. */
export function collidePackedCell(cell: PackedCell, x: number, y: number, z: number): ObstacleKind | null {
  if (y > cell.maxTop + 1 || x < cell.minX || x > cell.maxX || z < cell.minZ || z > cell.maxZ) return null;
  const trees = cell.trees;
  const treeMaxZ = z + cell.treeReach;
  for (let o = lowerBoundZ(trees, TREE_STRIDE, z - cell.treeReach); o < trees.length && trees[o + 2]! <= treeMaxZ; o += TREE_STRIDE) {
    const reach = trees[o + 3]! * trees[o + 4]! * 0.4;
    if (Math.abs(x - trees[o]!) > reach || Math.abs(z - trees[o + 2]!) > reach) continue;
    if (collideTreeAt(trees[o + 5]!, trees[o]!, trees[o + 1]!, trees[o + 2]!, trees[o + 3]!, trees[o + 4]!, x, y, z)) return 'tree';
  }
  const rocks = cell.rocks;
  const rockMaxZ = z + cell.rockReach;
  for (let o = lowerBoundZ(rocks, ROCK_STRIDE, z - cell.rockReach); o < rocks.length && rocks[o + 2]! <= rockMaxZ; o += ROCK_STRIDE) {
    const r = rocks[o + 3]!;
    if (Math.abs(x - rocks[o]!) > r || Math.abs(z - rocks[o + 2]!) > r) continue;
    if (collideRockAt(rocks[o]!, rocks[o + 1]!, rocks[o + 2]!, r, rocks[o + 4]!, x, y, z)) return 'rock';
  }
  const b = cell.buildings;
  for (let o = 0; o < b.length; o += BUILDING_STRIDE) {
    if (Math.abs(x - b[o]!) > 25 || Math.abs(z - b[o + 2]!) > 25) continue;
    if (collideBuildingAt(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!, b[o + 4]!, b[o + 5]!, b[o + 6]!, b[o + 7]!, x, y, z)) return 'building';
  }
  return null;
}
