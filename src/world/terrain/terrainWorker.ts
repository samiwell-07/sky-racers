/// <reference lib="webworker" />
import { TERRAIN_CONFIG } from '../../config/worldConfig';
import { computeChunkArrays } from './chunkMeshData';
import { createHeightFunction } from './HeightField';

export interface ChunkRequest {
  key: string;
  cx: number;
  cz: number;
  lod: number;
}

/** Builds terrain chunk vertex data off the main thread. */
const heightFn = createHeightFunction(TERRAIN_CONFIG);

self.onmessage = (e: MessageEvent<ChunkRequest>) => {
  const { key, cx, cz, lod } = e.data;
  const data = computeChunkArrays(cx, cz, lod, TERRAIN_CONFIG, heightFn);
  (self as unknown as Worker).postMessage({ key, cx, cz, lod, ...data }, [data.positions.buffer, data.normals.buffer, data.uvs.buffer]);
};
