import { BufferAttribute, BufferGeometry, Mesh, Object3D, Sphere, Box3, Vector3, type Material } from 'three';
import type { TerrainConfig } from '../../config/worldConfig';
import { createWaterMesh, disposeWaterMesh } from '../water/water';
import { chunkIndices, type ChunkArrays } from './chunkMeshData';

const indexAttributes = new Map<number, BufferAttribute>();

/**
 * One square of streamed terrain at a given level of detail, built from precomputed vertex data:
 * the ground mesh and, where the chunk has water, a water mesh. Add `object` (both) to the scene.
 */
export class TerrainChunk {
  readonly object = new Object3D();
  readonly mesh: Mesh;
  readonly water: Mesh<BufferGeometry, Material> | null;

  constructor(
    readonly cx: number,
    readonly cz: number,
    readonly lod: number,
    cfg: TerrainConfig,
    data: ChunkArrays,
    material: Material,
  ) {
    const segs = cfg.chunkSegments >> lod;
    let index = indexAttributes.get(segs);
    if (!index) {
      index = new BufferAttribute(chunkIndices(segs), 1);
      indexAttributes.set(segs, index);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(data.normals, 3));
    geometry.setAttribute('uv', new BufferAttribute(data.uvs, 2));
    geometry.setAttribute('surface', new BufferAttribute(data.surface, 2));
    // All chunks of the same LOD share one index buffer.
    geometry.setIndex(index);
    const size = cfg.chunkSize;
    geometry.boundingBox = new Box3(new Vector3(cx * size, data.minY, cz * size), new Vector3((cx + 1) * size, data.maxY, (cz + 1) * size));
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new Sphere());
    this.mesh = new Mesh(geometry, material);
    this.mesh.receiveShadow = true;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    this.object.name = `terrain-${cx},${cz}`;
    this.object.matrixAutoUpdate = false;
    this.object.add(this.mesh);

    this.water = data.water ? createWaterMesh(data.water) : null;
    if (this.water) {
      this.water.matrixAutoUpdate = false;
      this.water.updateMatrix();
      this.object.add(this.water);
    }
  }

  dispose(): void {
    // Detach the shared index first: disposing a geometry frees its index buffer on the GPU.
    this.mesh.geometry.setIndex(null);
    this.mesh.geometry.dispose();
    // Keeps the water material shared by every chunk alive.
    if (this.water) disposeWaterMesh(this.water);
  }
}
