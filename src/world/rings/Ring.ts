import {
  AdditiveBlending,
  BoxGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { RingShape } from './ringMath';

export type RingStatus = 'upcoming' | 'next' | 'passed';

const STATUS_COLORS: Record<RingStatus, Color> = {
  upcoming: new Color('#4fd8ff'),
  next: new Color('#ffc21a'),
  passed: new Color('#35d96a'),
};

/** Overall brightness per status: the next gate stands out, passed gates fade away. */
const STATUS_INTENSITY: Record<RingStatus, number> = { upcoming: 0.55, next: 1, passed: 0.15 };

const hologramMaterial = (): ShaderMaterial =>
  new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    uniforms: {
      color: { value: new Color() },
      intensity: { value: 1 },
      time: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 color;
      uniform float intensity;
      uniform float time;
      varying vec2 vUv;
      void main() {
        // Moving horizontal scan lines + brighter edges, like a projected hologram.
        float scan = 0.5 + 0.5 * sin(vUv.y * 90.0 - time * 6.0);
        float edge = max(abs(vUv.x - 0.5), abs(vUv.y - 0.5)) * 2.0;
        float glow = mix(0.04, 0.22, pow(edge, 4.0)) + scan * 0.05;
        gl_FragColor = vec4(color * glow * intensity, 1.0);
      }`,
  });

/**
 * Holographic rectangular gate showing where to fly. It is not solid: flying through the
 * opening counts as a pass, touching the frame does nothing.
 */
export class Ring {
  readonly group = new Group();
  readonly shape: RingShape;
  private readonly frameMaterial: MeshBasicMaterial;
  private readonly fieldMaterial: ShaderMaterial;
  private readonly beacon: Mesh<CylinderGeometry, MeshBasicMaterial>;
  status: RingStatus = 'upcoming';

  constructor(center: Vector3, normal: Vector3, width: number, height: number, frame: number) {
    const n = new Vector3(normal.x, 0, normal.z).normalize();
    this.shape = { center: center.clone(), normal: n, width, height, frame };
    this.frameMaterial = new MeshBasicMaterial({
      transparent: true,
      opacity: 0.9,
      blending: AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    this.fieldMaterial = hologramMaterial();

    // Thin glowing frame bars in the gate's local XY plane (local +Z = normal after lookAt).
    const t = frame;
    const bars: Array<[number, number, number, number]> = [
      [width + 2 * t, t, 0, height / 2 + t / 2],
      [width + 2 * t, t, 0, -height / 2 - t / 2],
      [t, height, -width / 2 - t / 2, 0],
      [t, height, width / 2 + t / 2, 0],
    ];
    for (const [w, h, x, y] of bars) {
      const bar = new Mesh(new BoxGeometry(w, h, t * 0.3), this.frameMaterial);
      bar.position.set(x, y, 0);
      bar.renderOrder = 5;
      this.group.add(bar);
    }
    const field = new Mesh(new PlaneGeometry(width, height), this.fieldMaterial);
    field.renderOrder = 4;
    this.group.add(field);

    this.group.position.copy(center);
    this.group.lookAt(center.clone().add(n));

    // Light pillar above the next gate, to spot it from far away.
    const beaconHeight = 600;
    const beaconGeo = new CylinderGeometry(1.5, 1.5, beaconHeight, 12, 1, true);
    beaconGeo.translate(0, beaconHeight / 2 + height / 2 + t, 0);
    this.beacon = new Mesh(
      beaconGeo,
      new MeshBasicMaterial({ color: STATUS_COLORS.next, transparent: true, opacity: 0.35, blending: AdditiveBlending, depthWrite: false }),
    );
    this.beacon.position.copy(center);
    this.beacon.visible = false;
  }

  get beaconMesh(): Mesh {
    return this.beacon;
  }

  setStatus(status: RingStatus): void {
    this.status = status;
    const color = STATUS_COLORS[status];
    this.frameMaterial.color.copy(color).multiplyScalar(STATUS_INTENSITY[status]);
    this.fieldMaterial.uniforms.color!.value.copy(color);
    this.fieldMaterial.uniforms.intensity!.value = STATUS_INTENSITY[status];
    this.beacon.visible = status === 'next';
  }

  animate(time: number): void {
    this.fieldMaterial.uniforms.time!.value = time;
    if (this.status === 'next') {
      const pulse = 0.75 + Math.sin(time * 6) * 0.25;
      this.frameMaterial.color.copy(STATUS_COLORS.next).multiplyScalar(pulse);
    }
  }

  dispose(): void {
    this.group.traverse((o) => (o as Mesh).geometry?.dispose());
    this.beacon.geometry.dispose();
    this.frameMaterial.dispose();
    this.fieldMaterial.dispose();
    this.beacon.material.dispose();
  }
}
