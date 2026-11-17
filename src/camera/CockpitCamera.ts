import { Vector3, type PerspectiveCamera } from 'three';
import type { CameraController, CameraTarget } from './CameraController';
import { getJetDesign } from '../entities/jet/jetDesigns';

export function cockpitEyeFor(modelId: string): Vector3 {
  const { canopy } = getJetDesign(modelId);
  return new Vector3(0, canopy.y + canopy.height * 0.55, canopy.z);
}

/** First-person view from the pilot's seat, rigidly attached to the jet. */
export class CockpitCamera implements CameraController {
  static readonly EYE = cockpitEyeFor('falcon');

  snap(): void {}

  update(camera: PerspectiveCamera, target: CameraTarget): void {
    camera.up.set(0, 1, 0);
    camera.quaternion.copy(target.quaternion);
    camera.position.copy(target.cockpitEye ?? CockpitCamera.EYE).applyQuaternion(target.quaternion).add(target.position);
  }
}
