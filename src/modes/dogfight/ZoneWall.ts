import { AdditiveBlending, CylinderGeometry, DoubleSide, Mesh, ShaderMaterial, Vector2, Vector3 } from 'three';
import type { DogfightZone } from './zone';

/** The wall fades in within this distance (m) and stays fully visible outside the zone. */
const FADE_DISTANCE = 600;
const BOTTOM = -300;

const vertexShader = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const fragmentShader = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uPlayer;
uniform vec2 uCenter;
uniform float uRadius;
uniform float uFade;
uniform float uTime;
varying vec3 vWorld;

float gridLine(float v, float spacing) {
  float d = abs(fract(v / spacing - 0.5) - 0.5) * spacing;
  float w = fwidth(v) * 1.5 + 0.8;
  return 1.0 - smoothstep(0.0, w, d);
}

void main() {
  // Only the part of the wall around the player shows, so the 6 km ring doesn't fill the sky.
  float near = 1.0 - smoothstep(250.0, 1800.0, distance(vWorld, uPlayer));
  float arc = atan(vWorld.z - uCenter.y, vWorld.x - uCenter.x) * uRadius;
  float grid = max(gridLine(arc, 60.0), gridLine(vWorld.y + uTime * 12.0, 60.0));
  float alpha = uFade * near * (0.1 + 0.55 * grid);
  if (alpha < 0.003) discard;
  gl_FragColor = vec4(uColor, alpha);
}
`;

/**
 * Translucent cylinder on the combat-zone boundary with a scrolling grid, faded in as the player
 * gets within FADE_DISTANCE of it. One mesh; add `mesh` to the scene, call update() every frame.
 */
export class ZoneWall {
  readonly mesh: Mesh<CylinderGeometry, ShaderMaterial>;
  private time = 0;

  constructor(readonly zone: DogfightZone) {
    const height = zone.ceiling - BOTTOM;
    const geometry = new CylinderGeometry(zone.radius, zone.radius, height, 160, 1, true);
    const material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uColor: { value: new Vector3(1, 0.32, 0.18) },
        uPlayer: { value: new Vector3() },
        uCenter: { value: new Vector2(zone.cx, zone.cz) },
        uRadius: { value: zone.radius },
        uFade: { value: 0 },
        uTime: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
    });
    this.mesh = new Mesh(geometry, material);
    this.mesh.name = 'dogfight-zone-wall';
    this.mesh.position.set(zone.cx, BOTTOM + height / 2, zone.cz);
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
  }

  /** 0..1 visibility for a player at `wallDistance` m inside the wall (negative = outside). */
  static fadeFor(wallDistance: number): number {
    const t = Math.min(1, Math.max(0, 1 - wallDistance / FADE_DISTANCE));
    return t * t * (3 - 2 * t);
  }

  update(dt: number, player: Vector3): void {
    this.time += dt;
    const wallDistance = this.zone.radius - Math.hypot(player.x - this.zone.cx, player.z - this.zone.cz);
    const fade = ZoneWall.fadeFor(wallDistance);
    const u = this.mesh.material.uniforms;
    u.uFade.value = fade;
    u.uTime.value = this.time % 1000;
    (u.uPlayer.value as Vector3).copy(player);
    this.mesh.visible = fade > 0.001;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
