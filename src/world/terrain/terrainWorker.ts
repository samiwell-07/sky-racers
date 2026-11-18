/// <reference lib="webworker" />
import { createWorld } from '../gen/createWorld';
import type { WorldSpec } from '../gen/WorldGenerator';
import { chunkTransferables, computeChunkArrays } from './chunkMeshData';

export interface ChunkRequest {
  key: string;
  cx: number;
  cz: number;
  lod: number;
  /** Streamer generation (bumped on every world switch); echoed back so stale results are dropped. */
  gen: number;
  /** World to build: rebuilt here from the spec alone (cached per world key). */
  spec: WorldSpec;
}

/** Builds terrain chunk vertex data (ground + water) off the main thread. */
self.onmessage = (e: MessageEvent<ChunkRequest>) => {
  const { key, cx, cz, lod, gen, spec } = e.data;
  const world = createWorld(spec);
  const data = computeChunkArrays(cx, cz, lod, world.config, world);
  (self as unknown as Worker).postMessage({ key, cx, cz, lod, gen, ...data }, chunkTransferables(data));
};
