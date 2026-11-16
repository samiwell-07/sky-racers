import { DirectionalLight, HemisphereLight, Vector3, type Scene } from 'three';

/** Sun + sky light. The sun's shadow box follows the jet so its shadow is sharp on the ground. */
export class Lights {
  readonly sun: DirectionalLight;
  readonly hemi: HemisphereLight;
  readonly sunDirection = new Vector3(-0.45, 0.75, 0.5).normalize();

  constructor(scene: Scene, shadowMapSize = 2048) {
    this.hemi = new HemisphereLight('#d6e6ff', '#8a8468', 1.6);
    scene.add(this.hemi);

    this.sun = new DirectionalLight('#fff4e0', 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -45;
    cam.right = cam.top = 45;
    cam.near = 1;
    cam.far = 1200;
    cam.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.05;
    scene.add(this.sun, this.sun.target);
  }

  setShadowMapSize(size: number): void {
    if (this.sun.shadow.mapSize.x === size) return;
    this.sun.shadow.mapSize.set(size, size);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
  }

  /** Keep the shadow camera centered on the point of interest (the jet). */
  follow(target: Vector3): void {
    this.sun.target.position.copy(target);
    this.sun.position.copy(target).addScaledVector(this.sunDirection, 600);
  }
}
