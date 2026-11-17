import { BufferAttribute, BufferGeometry, type CanvasTexture, Color, Mesh, MeshStandardMaterial, Vector2, type Vector3 } from 'three';
import type { TerrainConfig } from '../../config/worldConfig';
import { valleyCenterX } from '../terrain/HeightField';
import { animateRipples, rippleNormalMap } from '../water/waterMaterial';

/**
 * River surface: a ribbon following the valley centerline, rebuilt around the player as they
 * move. Water level is constant; where the ground rises above it, the ribbon is simply hidden.
 * Classic world only. Redundant once the chunk water (../water/water.ts) is built from the Classic
 * world's waterLevelAt, which covers the same band: remove it then.
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
    animateRipples(this.normal, time);
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
