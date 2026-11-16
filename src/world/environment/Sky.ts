import { BackSide, Color, Fog, Mesh, ShaderMaterial, SphereGeometry, Vector3, type Scene } from 'three';

export interface SkyColors {
  zenith: Color;
  horizon: Color;
  ground: Color;
  sun: Color;
}

/** Gradient sky dome with a sun disc that follows the camera, plus distance fog matching the horizon color. */
export class Sky {
  readonly mesh: Mesh<SphereGeometry, ShaderMaterial>;
  readonly fog: Fog;
  readonly colors: SkyColors = {
    zenith: new Color('#3f78c4'),
    horizon: new Color('#c4d8ea'),
    ground: new Color('#9fb3c4'),
    sun: new Color('#fff4e0'),
  };
  readonly sunDirection = new Vector3(-0.45, 0.75, 0.5).normalize();

  constructor(private readonly scene: Scene, fogNear = 900, fogFar = 6500) {
    const material = new ShaderMaterial({
      side: BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        zenith: { value: this.colors.zenith },
        horizon: { value: this.colors.horizon },
        ground: { value: this.colors.ground },
        sunColor: { value: this.colors.sun },
        sunDir: { value: this.sunDirection },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 zenith;
        uniform vec3 horizon;
        uniform vec3 ground;
        uniform vec3 sunColor;
        uniform vec3 sunDir;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 col = h > 0.0
            ? mix(horizon, zenith, pow(smoothstep(0.0, 0.6, h), 0.7))
            : mix(horizon, ground, smoothstep(0.0, -0.2, h));
          float s = max(dot(d, normalize(sunDir)), 0.0);
          col += sunColor * (pow(s, 900.0) * 6.0 + pow(s, 12.0) * 0.25);
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new Mesh(new SphereGeometry(10000, 32, 16), material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
    scene.add(this.mesh);
    this.fog = new Fog(this.colors.horizon.clone(), fogNear, fogFar);
    scene.fog = this.fog;
    scene.background = this.colors.horizon;
  }

  /** Push color changes (made on `colors`) to the fog and background. */
  syncColors(): void {
    this.fog.color.copy(this.colors.horizon);
    this.scene.background = this.colors.horizon;
  }

  setFogRange(near: number, far: number): void {
    this.fog.near = near;
    this.fog.far = far;
  }

  update(cameraPosition: Vector3): void {
    this.mesh.position.copy(cameraPosition);
  }
}
