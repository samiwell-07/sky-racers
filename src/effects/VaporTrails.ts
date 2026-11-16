import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Vector3,
} from 'three';

const EMIT_INTERVAL = 0.03; // s
const LIFETIME = 1.2; // s
const HALF_WIDTH = 0.3; // m
const MAX_ALPHA = 0.55;
const HEAD_FADE = 3; // number of points over which the ribbon fades in at the wingtip

const tmpTangent = new Vector3();
const tmpToCam = new Vector3();
const tmpSide = new Vector3();
const p = new Vector3();
const prev = new Vector3();
const next = new Vector3();

/** One camera-facing ribbon backed by a ring buffer of samples. */
class Ribbon {
  readonly mesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  private readonly px: Float32Array;
  private readonly age: Float32Array;
  private readonly strength: Float32Array;
  private start = 0;
  private count = 0;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly posAttr: BufferAttribute;
  private readonly colAttr: BufferAttribute;
  private readonly head = new Vector3();
  private readonly cap: number;

  constructor(maxPoints: number, material: MeshBasicMaterial) {
    this.cap = maxPoints;
    this.px = new Float32Array(maxPoints * 3);
    this.age = new Float32Array(maxPoints);
    this.strength = new Float32Array(maxPoints);
    const verts = (maxPoints + 1) * 2;
    this.positions = new Float32Array(verts * 3);
    this.colors = new Float32Array(verts * 4);
    const indices = new Uint32Array(maxPoints * 6);
    for (let i = 0; i < maxPoints; i++) {
      const a = i * 2;
      indices.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6);
    }
    const geo = new BufferGeometry();
    this.posAttr = new BufferAttribute(this.positions, 3);
    this.colAttr = new BufferAttribute(this.colors, 4);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', this.colAttr);
    geo.setIndex(new BufferAttribute(indices, 1));
    geo.setDrawRange(0, 0);
    this.mesh = new Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }

  get lastStrength(): number {
    return this.count > 0 ? this.strength[(this.start + this.count - 1) % this.cap] : 0;
  }

  push(p: Vector3, strength: number): void {
    if (this.count === this.cap) {
      this.start = (this.start + 1) % this.cap;
      this.count--;
    }
    const i = (this.start + this.count) % this.cap;
    this.px[i * 3] = p.x;
    this.px[i * 3 + 1] = p.y;
    this.px[i * 3 + 2] = p.z;
    this.age[i] = 0;
    this.strength[i] = strength;
    this.count++;
  }

  setHead(p: Vector3): void {
    this.head.copy(p);
  }

  age_(dt: number): void {
    for (let k = 0; k < this.count; k++) this.age[(this.start + k) % this.cap] += dt;
    while (this.count > 0 && this.age[this.start] >= LIFETIME) {
      this.start = (this.start + 1) % this.cap;
      this.count--;
    }
  }

  clear(): void {
    this.start = 0;
    this.count = 0;
    this.mesh.geometry.setDrawRange(0, 0);
  }

  private pointAt(k: number, out: Vector3): Vector3 {
    if (k >= this.count) return out.copy(this.head);
    const i = ((this.start + k) % this.cap) * 3;
    return out.set(this.px[i], this.px[i + 1], this.px[i + 2]);
  }

  rebuild(cameraPosition: Vector3): void {
    const n = this.count + 1; // stored samples + live head at the wingtip
    if (this.count === 0) {
      this.mesh.geometry.setDrawRange(0, 0);
      return;
    }
    for (let k = 0; k < n; k++) {
      this.pointAt(k, p);
      this.pointAt(Math.max(0, k - 1), prev);
      this.pointAt(Math.min(n - 1, k + 1), next);
      tmpTangent.subVectors(next, prev);
      tmpToCam.subVectors(cameraPosition, p);
      tmpSide.crossVectors(tmpTangent, tmpToCam);
      const len = tmpSide.length();
      if (len > 1e-6) tmpSide.multiplyScalar(HALF_WIDTH / len);
      else tmpSide.set(0, 0, 0);

      let alpha: number;
      if (k < this.count) {
        const idx = (this.start + k) % this.cap;
        const life = 1 - this.age[idx] / LIFETIME;
        const fromHead = n - 1 - k;
        alpha = this.strength[idx] * life * life * Math.min(1, fromHead / HEAD_FADE);
      } else {
        alpha = 0;
      }
      // The oldest point fades to zero so the tail end is soft.
      if (k === 0) alpha = 0;
      alpha *= MAX_ALPHA;

      const v = k * 2;
      this.positions[v * 3] = p.x + tmpSide.x;
      this.positions[v * 3 + 1] = p.y + tmpSide.y;
      this.positions[v * 3 + 2] = p.z + tmpSide.z;
      this.positions[v * 3 + 3] = p.x - tmpSide.x;
      this.positions[v * 3 + 4] = p.y - tmpSide.y;
      this.positions[v * 3 + 5] = p.z - tmpSide.z;
      for (let s = 0; s < 2; s++) {
        const c = (v + s) * 4;
        this.colors[c] = 1;
        this.colors[c + 1] = 1;
        this.colors[c + 2] = 1;
        this.colors[c + 3] = alpha;
      }
    }
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, (n - 1) * 6);
  }
}

/** Wingtip condensation ribbons that billboard toward the camera and fade with age. */
export class VaporTrails {
  readonly object: Object3D = new Object3D();
  private readonly ribbons: [Ribbon, Ribbon];
  private readonly material: MeshBasicMaterial;
  private timer = 0;

  constructor(maxPoints = 64) {
    const cap = Math.max(4, Math.ceil(Math.max(maxPoints, LIFETIME / EMIT_INTERVAL + 4)));
    this.material = new MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      fog: true,
    });
    this.ribbons = [new Ribbon(cap, this.material), new Ribbon(cap, this.material)];
    this.object.name = 'VaporTrails';
    this.object.frustumCulled = false;
    this.object.add(this.ribbons[0].mesh, this.ribbons[1].mesh);
  }

  update(dt: number, leftTip: Vector3, rightTip: Vector3, intensity: number, cameraPosition: Vector3): void {
    const k = Number.isFinite(intensity) ? Math.min(1, Math.max(0, intensity)) : 0;
    const tips = [leftTip, rightTip];
    for (const r of this.ribbons) r.age_(dt);

    this.timer += dt;
    const emit = this.timer >= EMIT_INTERVAL;
    if (emit) this.timer %= EMIT_INTERVAL;

    this.ribbons.forEach((r, i) => {
      const tip = tips[i];
      if (emit) {
        if (k > 0) {
          // Start a fresh segment with a zero-strength point so it doesn't bridge to an old one.
          if (r.lastStrength === 0) r.push(tip, 0);
          r.push(tip, k);
        } else if (r.lastStrength > 0) {
          r.push(tip, 0); // end cap
        }
      }
      r.setHead(tip);
      r.rebuild(cameraPosition);
    });
  }

  reset(): void {
    this.timer = 0;
    for (const r of this.ribbons) r.clear();
  }
}
