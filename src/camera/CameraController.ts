import type { PerspectiveCamera, Quaternion, Vector3 } from 'three';

export interface CameraTarget {
  position: Vector3;
  quaternion: Quaternion;
  speed: number;
  cockpitEye?: Vector3;
}

export interface CameraController {
  /** Snap to the target without smoothing (after a respawn or camera switch). */
  snap(target: CameraTarget): void;
  update(camera: PerspectiveCamera, target: CameraTarget, dt: number): void;
}
