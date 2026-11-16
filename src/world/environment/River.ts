import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  Mesh,
  MeshStandardMaterial,
  NoColorSpace,
  RepeatWrapping,
  Vector2,
  type Vector3,
} from 'three';
import type { TerrainConfig } from '../../config/worldConfig';
import { mulberry32 } from '../../utils/random';
import { valleyCenterX } from '../terrain/HeightField';
import { tileableValueNoise } from '../terrain/terrainTextures';

function rippleNormalMap(size = 256): CanvasTexture {
  const h = tileableValueNoise(size, 16, mulberry32(77));
  const h2 = tileableValueNoise(size, 64, mulberry32(78));
  const at = (x: number, y: number): number => {
    const i = ((y + size) % size) * size + ((x + size) % size);
    return h[i]! * 0.6 + h2[i]! * 0.4;
  };
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (at(x - 1, y) - at(x + 1, y)) * 4;
      const ny = (at(x, y - 1) - at(x, y + 1)) * 4;
      const len = Math.hypot(nx, ny, 1);
      const i = (y * size + x) * 4;
      img.data[i] = ((nx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.colorSpace = NoColorSpace;
  return tex;
}

/**
 * River surface: a ribbon following the valley centerline, rebuilt around the player as they
 * move. Water level is constant; where the ground rises above it, the ribbon is simply hidden.
 */
export class River {
  readonly mesh: Mesh<BufferGeometry, MeshStandardMaterial>;
  private centerZ = Number.NaN;
  private readonly normal: CanvasTexture;

  constructor(private readonly cfg: TerrainConfig, private readonly halfLength = 5000, private readonly step = 12) {
    this.normal = rippleNormalMap();
    const material = new MeshStandardMaterial({
      color: new Color('#3d6f7d'),
      roughness: 0.12,
      metalness: 0.35,
      transparent: true,
      opacity: 0.86,
      normalMap: this.normal,
      normalScale: new Vector2(0.6, 0.6),
    });
    this.mesh = new Mesh(new BufferGeometry(), material);
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 1;
  }

  update(cameraPosition: Vector3, time: number): void {
    this.normal.offset.set(time * 0.02, time * 0.05);
    if (Math.abs(cameraPosition.z - this.centerZ) < 1000) return;
    this.centerZ = Math.round(cameraPosition.z / 500) * 500;
    this.rebuild();
  }

  private rebuild(): void {
    const halfWidth = this.cfg.riverHalfWidth + 14;
    const rows = Math.floor((this.halfLength * 2) / this.step) + 1;
    const positions = new Float32Array(rows * 2 * 3);
    const uvs = new Float32Array(rows * 2 * 2);
    const y = this.cfg.waterLevel;
    for (let r = 0; r < rows; r++) {
      const z = this.centerZ - this.halfLength + r * this.step;
      const cx = valleyCenterX(z);
      for (let s = 0; s < 2; s++) {
        const v = r * 2 + s;
        const x = cx + (s === 0 ? -halfWidth : halfWidth);
        positions.set([x, y, z], v * 3);
        uvs.set([x / 30, z / 30], v * 2);
      }
    }
    const indices: number[] = [];
    for (let r = 0; r < rows - 1; r++) {
      const a = r * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(positions, 3));
    geo.setAttribute('uv', new BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    this.mesh.geometry.dispose();
    this.mesh.geometry = geo;
  }
}
