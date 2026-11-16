import { Quaternion, Vector3, type PerspectiveCamera } from 'three';
import type { CameraConfig } from '../config/cameraConfig';
import { DEG2RAD, dampFactor } from '../utils/math';
import type { CameraController, CameraTarget } from './CameraController';

const _offset = new Vector3();
const _desired = new Vector3();
const _look = new Vector3();

/** Third-person camera behind the jet. It rolls with the jet but lags slightly for a sense of motion. */
export class ChaseCamera implements CameraController {
  private readonly smoothQuat = new Quaternion();
  private readonly position = new Vector3();

  constructor(
    private readonly config: CameraConfig,
    private readonly groundHeight: (x: number, z: number) => number,
  ) {}

  snap(target: CameraTarget): void {
    this.smoothQuat.copy(target.quaternion);
    this.position.copy(this.desiredPosition(target, _desired));
  }

  update(camera: PerspectiveCamera, target: CameraTarget, dt: number): void {
    const c = this.config;
    this.smoothQuat.slerp(target.quaternion, dampFactor(c.chaseRotationStiffness, dt));
    this.position.lerp(this.desiredPosition(target, _desired), dampFactor(c.chasePositionStiffness, dt));

    const minY = this.groundHeight(this.position.x, this.position.z) + 2;
    if (this.position.y < minY) this.position.y = minY;

    camera.position.copy(this.position);
    camera.up.set(0, 1, 0).applyQuaternion(this.smoothQuat);
    // Look past the jet so it sits slightly below the screen center.
    const lookAhead = c.chaseDistance * Math.tan(c.chaseLookDown * DEG2RAD) * 4;
    _look.set(0, 0, -lookAhead).applyQuaternion(this.smoothQuat).add(target.position);
    camera.lookAt(_look);
  }

  private desiredPosition(target: CameraTarget, out: Vector3): Vector3 {
    _offset.set(0, this.config.chaseHeight, this.config.chaseDistance).applyQuaternion(this.smoothQuat);
    return out.copy(target.position).add(_offset);
  }
}
