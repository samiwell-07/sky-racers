import {
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type Camera,
} from 'three';
import { mulberry32 } from '../../utils/random';

function cloudTexture(): CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const random = mulberry32(99);
  for (let i = 0; i < 28; i++) {
    const x = size * (0.2 + random() * 0.6);
    const y = size * (0.35 + random() * 0.35);
    const r = size * (0.08 + random() * 0.16);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

interface CloudInstance {
  offset: Vector3;
  scale: number;
}

const _m = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();

/**
 * Billboard cumulus clouds in a large tile that wraps around the camera, so there are always
 * clouds in view. Coverage (0..1) controls how many are visible; they drift with the wind.
 */
export class Clouds {
  readonly mesh: InstancedMesh;
  private readonly clouds: CloudInstance[] = [];
  private readonly drift = new Vector3();
  private coverage = 0.4;
  private readonly tile = 16000;

  constructor(count = 140, private readonly altitude = 900) {
    const material = new MeshBasicMaterial({ map: cloudTexture(), transparent: true, depthWrite: false, color: new Color('#ffffff') });
    this.mesh = new InstancedMesh(new PlaneGeometry(1, 0.55), material, count);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    const random = mulberry32(1234);
    for (let i = 0; i < count; i++) {
      this.clouds.push({
        offset: new Vector3(random() * this.tile, random() * 350, random() * this.tile),
        scale: 500 + random() * 900,
      });
    }
  }

  setCoverage(c: number): void {
    this.coverage = c;
  }

  /** Upper bound on drawn clouds (graphics quality): big transparent sprites cost GPU fill rate. */
  maxVisible = Infinity;

  /** Tint clouds for the time of day. */
  setColor(color: Color): void {
    (this.mesh.material as MeshBasicMaterial).color.copy(color);
  }

  update(camera: Camera, wind: Vector3, dt: number): void {
    this.drift.addScaledVector(wind, dt);
    const visible = Math.min(Math.round(this.clouds.length * this.coverage), this.maxVisible);
    this.mesh.count = visible;
    _q.copy(camera.quaternion);
    const half = this.tile / 2;
    for (let i = 0; i < visible; i++) {
      const c = this.clouds[i]!;
      // Wrap each cloud into the tile centered on the camera.
      const x = wrap(c.offset.x + this.drift.x - camera.position.x, this.tile) - half + camera.position.x;
      const z = wrap(c.offset.z + this.drift.z - camera.position.z, this.tile) - half + camera.position.z;
      _p.set(x, this.altitude + c.offset.y, z);
      _s.set(c.scale, c.scale, 1);
      this.mesh.setMatrixAt(i, _m.compose(_p, _q, _s));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

function wrap(v: number, size: number): number {
  return ((v % size) + size) % size;
}
