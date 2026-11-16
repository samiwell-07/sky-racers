import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Points,
  PointsMaterial,
  SRGBColorSpace,
} from 'three';
import type { Texture, Vector3 } from 'three';

const MAX_AGL = 25; // m
const MIN_SPEED = 80; // m/s
const FULL_SPEED = 180; // m/s
const MAX_RATE = 260; // particles per second at full strength
const MAX_ALPHA = 0.5;
const DUST_R = 0.72;
const DUST_G = 0.62;
const DUST_B = 0.48;

function makeSprite(): Texture | null {
  if (typeof document === 'undefined') return null;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/** Dust/spray kicked up from the ground when the jet streaks past at very low altitude. */
export class DustKicker {
  readonly object: Points<BufferGeometry, PointsMaterial>;
  private readonly max: number;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly vel: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly shade: Float32Array;
  private readonly posAttr: BufferAttribute;
  private readonly colAttr: BufferAttribute;
  private next = 0;
  private accumulator = 0;
  private alive = 0;

  constructor(maxParticles = 600) {
    this.max = Math.max(1, Math.floor(maxParticles));
    this.positions = new Float32Array(this.max * 3);
    this.colors = new Float32Array(this.max * 4);
    this.vel = new Float32Array(this.max * 3);
    this.age = new Float32Array(this.max).fill(1);
    this.life = new Float32Array(this.max).fill(1);
    this.shade = new Float32Array(this.max).fill(1);
    const geo = new BufferGeometry();
    this.posAttr = new BufferAttribute(this.positions, 3);
    this.colAttr = new BufferAttribute(this.colors, 4);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', this.colAttr);
    const material = new PointsMaterial({
      size: 7,
      sizeAttenuation: true,
      map: makeSprite(),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this.object = new Points(geo, material);
    this.object.frustumCulled = false;
    this.object.name = 'DustKicker';
  }

  update(
    dt: number,
    jetPosition: Vector3,
    velocity: Vector3,
    agl: number,
    groundHeight: (x: number, z: number) => number,
  ): void {
    if (!(dt > 0)) return;
    const step = Math.min(dt, 0.1);
    const speed = velocity.length();
    const low = Math.max(0, 1 - Math.max(0, agl) / MAX_AGL);
    const fast = Math.min(1, Math.max(0, (speed - MIN_SPEED) / (FULL_SPEED - MIN_SPEED)));
    const strength = low * low * fast;

    if (strength > 0) {
      this.accumulator += MAX_RATE * strength * step;
      const hx = speed > 1e-3 ? velocity.x / speed : 0;
      const hz = speed > 1e-3 ? velocity.z / speed : 0;
      while (this.accumulator >= 1) {
        this.accumulator -= 1;
        this.spawn(jetPosition, velocity, hx, hz, strength, groundHeight);
      }
    } else {
      this.accumulator = 0;
    }

    if (this.alive === 0) return;
    let alive = 0;
    const drag = Math.exp(-step * 1.6);
    for (let i = 0; i < this.max; i++) {
      const a = this.age[i];
      const l = this.life[i];
      const c = i * 4;
      if (a >= l) {
        this.colors[c + 3] = 0;
        continue;
      }
      const na = a + step;
      this.age[i] = na;
      const p = i * 3;
      this.vel[p] *= drag;
      this.vel[p + 1] = this.vel[p + 1] * drag + 0.6 * step; // warm air keeps it rising slowly
      this.vel[p + 2] *= drag;
      this.positions[p] += this.vel[p] * step;
      this.positions[p + 1] += this.vel[p + 1] * step;
      this.positions[p + 2] += this.vel[p + 2] * step;
      const t = na / l;
      if (t >= 1) {
        this.colors[c + 3] = 0;
        continue;
      }
      alive++;
      // Quick fade-in, long fade-out.
      const fade = Math.min(1, t * 8) * (1 - t) * (1 - t);
      this.colors[c + 3] = fade * MAX_ALPHA * this.shade[i];
    }
    this.alive = alive;
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
  }

  private spawn(
    jet: Vector3,
    velocity: Vector3,
    hx: number,
    hz: number,
    strength: number,
    groundHeight: (x: number, z: number) => number,
  ): void {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    const back = Math.random() * 0.12; // seconds of travel behind the jet
    const lateral = (Math.random() - 0.5) * 14;
    const x = jet.x - velocity.x * back - hz * lateral;
    const z = jet.z - velocity.z * back + hx * lateral;
    const gy = groundHeight(x, z);
    const p = i * 3;
    this.positions[p] = x;
    this.positions[p + 1] = (Number.isFinite(gy) ? gy : 0) + 0.3;
    this.positions[p + 2] = z;
    // Dragged along by the jet wash, pushed outward and lofted upward.
    const outward = 4 + Math.random() * 10;
    const side = lateral >= 0 ? 1 : -1;
    this.vel[p] = velocity.x * 0.12 * strength - hz * side * outward + (Math.random() - 0.5) * 4;
    this.vel[p + 1] = 3 + Math.random() * 9 * strength;
    this.vel[p + 2] = velocity.z * 0.12 * strength + hx * side * outward + (Math.random() - 0.5) * 4;
    this.age[i] = 0;
    this.life[i] = 1.4 + Math.random() * 1.6;
    const shade = 0.8 + Math.random() * 0.3;
    this.shade[i] = 0.6 + Math.random() * 0.4;
    const c = i * 4;
    this.colors[c] = Math.min(1, DUST_R * shade);
    this.colors[c + 1] = Math.min(1, DUST_G * shade);
    this.colors[c + 2] = Math.min(1, DUST_B * shade);
    this.colors[c + 3] = 0;
    this.alive++;
  }

  reset(): void {
    this.age.fill(1);
    this.life.fill(1);
    for (let i = 0; i < this.max; i++) this.colors[i * 4 + 3] = 0;
    this.accumulator = 0;
    this.alive = 0;
    this.next = 0;
    this.colAttr.needsUpdate = true;
  }
}
