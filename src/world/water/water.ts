import type { BufferGeometry, Material, Mesh } from 'three';
import type { TerrainConfig } from '../../config/worldConfig';
import type { WorldGenerator } from '../gen/WorldGenerator';
import { computeWaterArrays as computeArrays, type WaterArrays } from './waterArrays';
import { buildWaterMesh, updateWaterMaterial } from './waterMaterial';

/**
 * Water is built per terrain chunk so oceans, rivers and lakes work in an infinite world:
 * - computeWaterArrays() runs in the terrain worker next to computeChunkArrays() (pure, no Three.js;
 *   the worker may import it from ./waterArrays directly to keep Three.js out of its bundle) and
 *   returns null when the chunk has no water;
 * - TerrainChunk calls createWaterMesh() and adds the mesh next to the terrain mesh. On dispose,
 *   dispose only the geometry (disposeWaterMesh): the material is shared by every chunk.
 */
export type { WaterArrays };

/**
 * Water arrays for chunk (cx, cz) at `lod` (same grid as computeChunkArrays), or null when no grid
 * vertex has water above the ground. Transfer positions/uvs/indices/colors buffers to the main thread.
 */
export function computeWaterArrays(cx: number, cz: number, lod: number, cfg: TerrainConfig, world: WorldGenerator): WaterArrays | null {
  return computeArrays(cx, cz, lod, cfg, world);
}

/** World-space water mesh (shared material, renderOrder 1, static matrix), or null if empty. */
export function createWaterMesh(data: WaterArrays): Mesh<BufferGeometry, Material> | null {
  return buildWaterMesh(data);
}

/** Frees a chunk water mesh's geometry (never the shared material). */
export function disposeWaterMesh(mesh: Mesh<BufferGeometry, Material>): void {
  mesh.removeFromParent();
  mesh.geometry.dispose();
}

/** Per-frame animation of the shared water material (ripples); `time` in seconds. */
export function updateWater(time: number): void {
  updateWaterMaterial(time);
}
