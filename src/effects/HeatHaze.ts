import {
  AdditiveBlending,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
} from 'three';
import type { Object3D } from 'three';

const LENGTH = 7; // m behind the nozzle

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uStrength;
  varying vec2 vUv;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }

  void main() {
    // vUv.y: 0 at nozzle, 1 at the far end; vUv.x across the plume.
    float along = vUv.y;
    float across = abs(vUv.x - 0.5) * 2.0;
    vec2 q = vec2(vUv.x * 4.0, along * 6.0 - uTime * 9.0);
    float n = noise(q) * 0.6 + noise(q * 2.3 + vec2(uTime * 1.7, 0.0)) * 0.4;
    float shimmer = smoothstep(0.45, 0.9, n);
    float edge = 1.0 - smoothstep(0.35, 1.0, across);
    float fade = smoothstep(0.0, 0.08, along) * (1.0 - smoothstep(0.35, 1.0, along));
    float a = shimmer * edge * fade * uStrength;
    gl_FragColor = vec4(vec3(1.0, 0.93, 0.85) * a, a);
  }
`;

/**
 * Subtle shimmering heat exhaust behind the nozzles. Add `object` as a child of the jet
 * group; geometry is in jet-local coordinates (exhaust flows toward +Z).
 */
export class HeatHaze {
  readonly object: Object3D;
  private readonly material: ShaderMaterial;
  private readonly geometries: BufferGeometry[] = [];
  private disposed = false;

  constructor(nozzles: Array<{ x: number; y: number; z: number; radius: number }>) {
    const group = new Group();
    group.name = 'HeatHaze';
    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: { uTime: { value: 0 }, uStrength: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      fog: false,
    });

    for (const n of nozzles) {
      const geo = HeatHaze.plumeGeometry(n.radius);
      this.geometries.push(geo);
      // Two crossed planes so the plume reads from any viewing angle.
      for (let k = 0; k < 2; k++) {
        const mesh = new Mesh(geo, this.material);
        mesh.position.set(n.x, n.y, n.z);
        mesh.rotation.z = k * (Math.PI / 2);
        mesh.renderOrder = 11;
        mesh.frustumCulled = false;
        group.add(mesh);
      }
    }
    group.visible = false;
    this.object = group;
  }

  /** A plane extending along +Z that widens from 2r at the nozzle to ~4r at the far end. */
  private static plumeGeometry(radius: number): BufferGeometry {
    const geo = new PlaneGeometry(1, 1, 1, 8);
    // Plane lies in XY; map Y (-0.5..0.5) to Z (0..LENGTH) and taper X with distance.
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const t = pos.getY(i) + 0.5;
      const width = radius * 2 * (1 + t * 1.2);
      pos.setXYZ(i, pos.getX(i) * width, 0, t * LENGTH);
      uv.setXY(i, uv.getX(i), t);
    }
    pos.needsUpdate = true;
    geo.computeBoundingSphere();
    return geo;
  }

  /** Frees the plume geometries and the shader material (idempotent). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const g of this.geometries) g.dispose();
    this.geometries.length = 0;
    this.material.dispose();
    this.object.removeFromParent();
  }

  /** @param throttle 0..1 (afterburner may push it slightly above 1). */
  update(time: number, throttle: number): void {
    const t = Number.isFinite(throttle) ? Math.min(1.2, Math.max(0, throttle)) : 0;
    const strength = 0.03 + t * 0.07;
    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uStrength.value = strength;
    this.object.visible = t > 0.05;
  }
}
