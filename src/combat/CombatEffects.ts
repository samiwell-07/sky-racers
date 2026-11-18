import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  NormalBlending,
  PerspectiveCamera,
  Points,
  ShaderMaterial,
  SphereGeometry,
  MeshBasicMaterial,
  Vector3,
  type Blending,
  type Camera,
} from 'three';
import { WEAPON_RULES } from './types';
import type { CombatEvent, WeaponSystem } from './WeaponSystem';

const VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
uniform float uScale;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vAlpha = aAlpha;
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(aSize * uScale / max(-mv.z, 0.1), 1.0, 256.0);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = smoothstep(1.0, 0.2, d);
  if (a * vAlpha < 0.004) discard;
  gl_FragColor = vec4(vColor, a * vAlpha);
}`;

/** CPU-simulated billboard particles (one draw call): smoke, sparks, fireballs, flash. */
class ParticleSystem {
  readonly points: Points<BufferGeometry, ShaderMaterial>;
  private count = 0;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly color: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly s0: Float32Array;
  private readonly s1: Float32Array;
  private readonly a0: Float32Array;
  private readonly drag: Float32Array;
  private readonly rise: Float32Array;

  constructor(
    private readonly capacity: number,
    blending: Blending,
  ) {
    const f = (n: number) => new Float32Array(capacity * n);
    this.pos = f(3);
    this.vel = f(3);
    this.color = f(3);
    this.size = f(1);
    this.alpha = f(1);
    this.age = f(1);
    this.life = f(1);
    this.s0 = f(1);
    this.s1 = f(1);
    this.a0 = f(1);
    this.drag = f(1);
    this.rise = f(1);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(this.pos, 3));
    geo.setAttribute('aColor', new BufferAttribute(this.color, 3));
    geo.setAttribute('aSize', new BufferAttribute(this.size, 1));
    geo.setAttribute('aAlpha', new BufferAttribute(this.alpha, 1));
    geo.setDrawRange(0, 0);
    const mat = new ShaderMaterial({
      uniforms: { uScale: { value: 600 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending,
    });
    this.points = new Points(geo, mat);
    this.points.frustumCulled = false;
  }

  set scale(v: number) {
    this.points.material.uniforms.uScale!.value = v;
  }

  get active(): number {
    return this.count;
  }

  emit(
    p: Vector3,
    v: Vector3 | null,
    life: number,
    size0: number,
    size1: number,
    alpha: number,
    rgb: readonly [number, number, number],
    drag = 0,
    rise = 0,
  ): void {
    let i = this.count;
    if (i >= this.capacity) i = Math.floor(Math.random() * this.capacity); // overwrite a random one
    else this.count++;
    this.pos.set([p.x, p.y, p.z], i * 3);
    this.vel.set(v ? [v.x, v.y, v.z] : [0, 0, 0], i * 3);
    this.color.set(rgb, i * 3);
    this.age[i] = 0;
    this.life[i] = life;
    this.s0[i] = size0;
    this.s1[i] = size1;
    this.a0[i] = alpha;
    this.drag[i] = drag;
    this.rise[i] = rise;
    this.size[i] = size0;
    this.alpha[i] = alpha;
  }

  update(dt: number): void {
    let i = 0;
    while (i < this.count) {
      this.age[i]! += dt;
      if (this.age[i]! >= this.life[i]!) {
        this.moveLast(i);
        continue;
      }
      const t = this.age[i]! / this.life[i]!;
      const k = Math.exp(-this.drag[i]! * dt);
      for (let c = 0; c < 3; c++) {
        const j = i * 3 + c;
        this.vel[j]! *= k;
        this.pos[j]! += this.vel[j]! * dt;
      }
      this.pos[i * 3 + 1]! += this.rise[i]! * dt;
      this.size[i] = this.s0[i]! + (this.s1[i]! - this.s0[i]!) * Math.sqrt(t);
      this.alpha[i] = this.a0[i]! * (1 - t) * (1 - t);
      i++;
    }
    this.flush();
  }

  /** Upload the current particles to the GPU buffers. */
  flush(): void {
    const geo = this.points.geometry;
    geo.setDrawRange(0, this.count);
    for (const name of ['position', 'aColor', 'aSize', 'aAlpha']) (geo.getAttribute(name) as BufferAttribute).needsUpdate = true;
  }

  clear(): void {
    this.count = 0;
    this.points.geometry.setDrawRange(0, 0);
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.points.material.dispose();
  }

  private moveLast(i: number): void {
    const last = --this.count;
    if (i === last) return;
    for (const [arr, n] of [
      [this.pos, 3],
      [this.vel, 3],
      [this.color, 3],
      [this.size, 1],
      [this.alpha, 1],
      [this.age, 1],
      [this.life, 1],
      [this.s0, 1],
      [this.s1, 1],
      [this.a0, 1],
      [this.drag, 1],
      [this.rise, 1],
    ] as const) {
      arr.copyWithin(i * n, last * n, last * n + n);
    }
  }
}

interface MissileVisual {
  readonly group: Group;
  readonly flame: Mesh;
}

export interface CombatEffectsOptions {
  maxRounds?: number;
  maxMissiles?: number;
  maxParticles?: number;
}

const OWN_TRACER: readonly [number, number, number] = [1, 0.85, 0.45];
const REMOTE_TRACER: readonly [number, number, number] = [1, 0.4, 0.22];
const FIRE: readonly [number, number, number] = [1, 0.62, 0.25];
const FLASH: readonly [number, number, number] = [1, 0.85, 0.55];
const FLARE: readonly [number, number, number] = [1, 0.93, 0.8];
const SMOKE: readonly [number, number, number] = [0.78, 0.78, 0.76];
const DARK_SMOKE: readonly [number, number, number] = [0.25, 0.23, 0.22];
const DUST: readonly [number, number, number] = [0.55, 0.5, 0.42];
/** Tracer streak length as seconds of round travel. */
const TRACER_SECONDS = 0.025;
const TRAIL_SPACING = 7;
/** Life of a sprite redrawn every frame (flare glare, muzzle flash): gone at the next update. */
const FRAME_SPRITE = 1e-4;

const _a = new Vector3();
const _b = new Vector3();
const _v = new Vector3();

/**
 * Renders every projectile of a WeaponSystem as independent scene objects (never attached to a jet):
 * pooled additive tracer streaks, missile bodies with motor glow and smoke trails, burning flares
 * with smoke, muzzle flashes, sparks and explosions. Add `group` to the scene; call update() every
 * render frame and handleEvents() with the WeaponSystem's events.
 */
export class CombatEffects {
  readonly group = new Group();
  private readonly tracers: LineSegments<BufferGeometry, LineBasicMaterial>;
  private readonly tracerPos: Float32Array;
  private readonly tracerColor: Float32Array;
  private readonly maxRounds: number;
  private readonly maxMissiles: number;
  private readonly missiles: MissileVisual[] = [];
  private readonly missileGeo: CylinderGeometry;
  private readonly flameGeo: SphereGeometry;
  private readonly missileMat: MeshStandardMaterial;
  private readonly flameMat: MeshBasicMaterial;
  private readonly smoke: ParticleSystem;
  private readonly glow: ParticleSystem;
  private readonly lastTrail = new Map<string, Vector3>();
  private disposed = false;

  constructor(options: CombatEffectsOptions = {}) {
    this.maxRounds = options.maxRounds ?? 256;
    this.maxMissiles = options.maxMissiles ?? 16;
    const maxParticles = options.maxParticles ?? 3000;
    this.group.name = 'combat-effects';

    this.tracerPos = new Float32Array(this.maxRounds * 6);
    this.tracerColor = new Float32Array(this.maxRounds * 6);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(this.tracerPos, 3));
    geo.setAttribute('color', new BufferAttribute(this.tracerColor, 3));
    geo.setDrawRange(0, 0);
    this.tracers = new LineSegments(
      geo,
      new LineBasicMaterial({ vertexColors: true, transparent: true, blending: AdditiveBlending, depthWrite: false }),
    );
    this.tracers.frustumCulled = false;
    this.group.add(this.tracers);

    // Missile body along +Z (Object3D.lookAt points +Z at the target).
    this.missileGeo = new CylinderGeometry(0.13, 0.13, 3, 8).rotateX(Math.PI / 2);
    this.flameGeo = new SphereGeometry(1, 10, 8);
    this.missileMat = new MeshStandardMaterial({ color: '#d9dcdf', roughness: 0.5, metalness: 0.3 });
    this.flameMat = new MeshBasicMaterial({ color: '#ffd38a', transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false });

    this.smoke = new ParticleSystem(maxParticles, NormalBlending);
    this.glow = new ParticleSystem(Math.ceil(maxParticles / 2), AdditiveBlending);
    this.group.add(this.smoke.points, this.glow.points);
  }

  /** Activity counters (tests / debug overlay). */
  get stats(): { tracers: number; missiles: number; smoke: number; glow: number } {
    return {
      tracers: this.tracers.geometry.drawRange.count / 2,
      missiles: this.missiles.filter((m) => m.group.visible).length,
      smoke: this.smoke.active,
      glow: this.glow.active,
    };
  }

  /**
   * Sync with the weapons' state and advance the particles. `viewportHeight` (px) keeps particle
   * sizes in world metres for a perspective camera.
   */
  update(dt: number, weapons: WeaponSystem, camera?: Camera, viewportHeight = 900): void {
    if (this.disposed) return;
    if (camera instanceof PerspectiveCamera) {
      const scale = viewportHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
      this.smoke.scale = scale;
      this.glow.scale = scale;
    }
    // Age first so one-frame sprites emitted below are drawn exactly once.
    this.smoke.update(dt);
    this.glow.update(dt);
    this.syncTracers(weapons);
    this.syncMissiles(weapons);
    this.syncFlares(weapons);
    if (weapons.muzzleFlashAge < 0.03) this.glow.emit(weapons.muzzlePosition, null, FRAME_SPRITE, 3, 3, 0.9, FLASH);
    this.smoke.flush();
    this.glow.flush();
  }

  handleEvents(events: readonly CombatEvent[]): void {
    if (this.disposed) return;
    for (const e of events) {
      switch (e.type) {
        case 'explosion':
          this.explode(e.position, e.hit ? 1.4 : 1);
          break;
        case 'gunImpact':
          this.smoke.emit(e.position, _v.set(0, 4, 0), 1.2, 2, 7, 0.55, DUST, 1.5, 1);
          this.glow.emit(e.position, null, 0.12, 2, 1, 0.8, FIRE);
          break;
        case 'hit':
          for (let i = 0; i < (e.cause === 'gun' ? 3 : 0); i++) {
            this.glow.emit(e.position, randomDir(_v).multiplyScalar(40), 0.25, 1.5, 0.5, 1, FLASH, 3);
          }
          break;
        case 'gunFired':
          if (!e.local) this.glow.emit(e.position, null, 0.06, 2.5, 3.5, 0.9, FLASH);
          break;
        default:
          break;
      }
    }
  }

  /** Fireball, sparks and a smoke cloud (missile detonation). */
  explode(position: Vector3, scale = 1): void {
    if (this.disposed) return;
    this.glow.emit(position, null, 0.35, 14 * scale, 26 * scale, 1, FLASH);
    for (let i = 0; i < 10; i++) {
      this.glow.emit(position, randomDir(_v).multiplyScalar(25 * scale), 0.6 + Math.random() * 0.3, 7 * scale, 16 * scale, 0.85, FIRE, 2);
    }
    for (let i = 0; i < 12; i++) {
      this.glow.emit(position, randomDir(_v).multiplyScalar(120), 0.5, 1.2, 0.4, 1, FLASH, 1);
    }
    for (let i = 0; i < 10; i++) {
      this.smoke.emit(position, randomDir(_v).multiplyScalar(12 * scale), 3 + Math.random(), 8 * scale, 26 * scale, 0.7, DARK_SMOKE, 0.8, 3);
    }
  }

  /** Hide everything (mode exit / respawn of the scene). */
  clear(): void {
    this.tracers.geometry.setDrawRange(0, 0);
    for (const m of this.missiles) m.group.visible = false;
    this.smoke.clear();
    this.glow.clear();
    this.lastTrail.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    this.tracers.geometry.dispose();
    this.tracers.material.dispose();
    this.missileGeo.dispose();
    this.flameGeo.dispose();
    this.missileMat.dispose();
    this.flameMat.dispose();
    this.smoke.dispose();
    this.glow.dispose();
    this.group.clear();
    this.missiles.length = 0;
    this.lastTrail.clear();
  }

  private syncTracers(weapons: WeaponSystem): void {
    let n = 0;
    for (const r of weapons.rounds) {
      if (!r.alive || n >= this.maxRounds) continue;
      const head = r.position;
      const tail = _a.copy(head).addScaledVector(r.velocity, -TRACER_SECONDS);
      this.tracerPos.set([tail.x, tail.y, tail.z, head.x, head.y, head.z], n * 6);
      const c = r.remote ? REMOTE_TRACER : OWN_TRACER;
      // Tail dim, head bright.
      this.tracerColor.set([c[0] * 0.25, c[1] * 0.25, c[2] * 0.25, c[0], c[1], c[2]], n * 6);
      n++;
    }
    const geo = this.tracers.geometry;
    geo.setDrawRange(0, n * 2);
    (geo.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (geo.getAttribute('color') as BufferAttribute).needsUpdate = true;
  }

  private syncMissiles(weapons: WeaponSystem): void {
    const burn = WEAPON_RULES.missile.burnTime;
    const list: Array<{ id: string; position: Vector3; velocity: Vector3; burning: boolean }> = [];
    for (const m of weapons.missiles) if (m.alive) list.push({ id: m.id, position: m.position, velocity: m.velocity, burning: m.burning });
    for (const m of weapons.remoteMissiles) list.push({ id: m.id, position: m.position, velocity: m.velocity, burning: m.age < burn });

    const seen = new Set<string>();
    for (let i = 0; i < Math.max(list.length, this.missiles.length); i++) {
      const m = list[i];
      if (!m || i >= this.maxMissiles) {
        if (this.missiles[i]) this.missiles[i]!.group.visible = false;
        continue;
      }
      const vis = this.missiles[i] ?? this.createMissile();
      vis.group.visible = true;
      vis.group.position.copy(m.position);
      vis.group.lookAt(_a.copy(m.position).add(m.velocity));
      vis.flame.visible = m.burning;
      vis.flame.scale.set(0.35, 0.35, 1.4 + Math.random() * 0.6);
      seen.add(m.id);
      this.emitTrail(m.id, m.position, m.burning);
    }
    for (const id of [...this.lastTrail.keys()]) if (!seen.has(id)) this.lastTrail.delete(id);
  }

  private emitTrail(id: string, position: Vector3, burning: boolean): void {
    const last = this.lastTrail.get(id);
    if (!last) {
      this.lastTrail.set(id, position.clone());
      return;
    }
    const dist = last.distanceTo(position);
    const steps = Math.min(8, Math.floor(dist / TRAIL_SPACING));
    if (steps === 0) return;
    for (let s = 1; s <= steps; s++) {
      const p = _b.lerpVectors(last, position, s / steps);
      if (burning) this.smoke.emit(p, null, 2.6, 1.4, 7, 0.55, SMOKE, 0, 0.6);
      else this.smoke.emit(p, null, 1.2, 1, 4, 0.25, SMOKE, 0, 0.3);
    }
    last.copy(position);
  }

  private syncFlares(weapons: WeaponSystem): void {
    for (const f of weapons.flares) {
      if (!f.alive) continue;
      const k = f.intensity;
      this.glow.emit(f.position, null, FRAME_SPRITE, 4 + 5 * k, 4 + 5 * k, 0.6 + 0.4 * k, FLARE);
      if (Math.random() < 0.5) this.smoke.emit(f.position, null, 1.6, 1.2, 5, 0.35 * k, SMOKE, 0, 0.5);
    }
  }

  private createMissile(): MissileVisual {
    const group = new Group();
    const body = new Mesh(this.missileGeo, this.missileMat);
    const flame = new Mesh(this.flameGeo, this.flameMat);
    flame.position.z = -2;
    group.add(body, flame);
    this.group.add(group);
    const vis = { group, flame };
    this.missiles.push(vis);
    return vis;
  }
}

function randomDir(out: Vector3): Vector3 {
  const u = Math.random() * 2 - 1;
  const phi = Math.random() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  return out.set(s * Math.cos(phi), u, s * Math.sin(phi)).multiplyScalar(0.4 + Math.random() * 0.6);
}
