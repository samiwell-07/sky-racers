import { PerspectiveCamera } from 'three';
import type { CameraConfig } from '../config/cameraConfig';
import { clamp, dampFactor } from '../utils/math';
import type { CameraController, CameraTarget } from './CameraController';
import { ChaseCamera } from './ChaseCamera';
import { CockpitCamera } from './CockpitCamera';

export type CameraMode = 'chase' | 'cockpit';

/** Owns the single render camera and switches between chase and cockpit views. */
export class CameraManager {
  readonly camera: PerspectiveCamera;
  mode: CameraMode = 'chase';
  private readonly controllers: Record<CameraMode, CameraController>;

  constructor(private readonly config: CameraConfig, groundHeight: (x: number, z: number) => number) {
    this.camera = new PerspectiveCamera(config.chaseFov, 1, 0.1, 14000);
    this.controllers = {
      chase: new ChaseCamera(config, groundHeight),
      cockpit: new CockpitCamera(),
    };
  }

  toggle(target: CameraTarget): CameraMode {
    this.mode = this.mode === 'chase' ? 'cockpit' : 'chase';
    this.controllers[this.mode].snap(target);
    return this.mode;
  }

  snap(target: CameraTarget): void {
    this.controllers[this.mode].snap(target);
  }

  update(target: CameraTarget, dt: number): void {
    this.controllers[this.mode].update(this.camera, target, dt);
    const base = this.mode === 'chase' ? this.config.chaseFov : this.config.cockpitFov;
    const fov = base + this.config.speedFovBoost * clamp((target.speed - 100) / 150, 0, 1);
    this.camera.fov += (fov - this.camera.fov) * dampFactor(3, dt);
    this.camera.updateProjectionMatrix();
  }

  /** Small random shake (e.g. on crash). */
  shake(amount: number): void {
    this.camera.position.x += (Math.random() - 0.5) * amount;
    this.camera.position.y += (Math.random() - 0.5) * amount;
    this.camera.position.z += (Math.random() - 0.5) * amount;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
