import { Vector3, type PerspectiveCamera } from 'three';
import type { CameraController, CameraTarget } from './CameraController';

/** First-person view from the pilot's seat, rigidly attached to the jet. */
export class CockpitCamera implements CameraController {
  static readonly EYE = new Vector3(0, 1.6, -4.6);

  snap(): void {}

  update(camera: PerspectiveCamera, target: CameraTarget): void {
    camera.up.set(0, 1, 0);
    camera.quaternion.copy(target.quaternion);
    camera.position.copy(CockpitCamera.EYE).applyQuaternion(target.quaternion).add(target.position);
  }
}
