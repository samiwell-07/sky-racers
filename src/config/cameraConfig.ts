export interface CameraConfig {
  chaseDistance: number;
  chaseHeight: number;
  /** Degrees the chase camera looks down toward the jet. */
  chaseLookDown: number;
  /** Position follow stiffness (1/s). */
  chasePositionStiffness: number;
  /** Rotation follow stiffness (1/s). Lower = more lag, more sense of motion. */
  chaseRotationStiffness: number;
  chaseFov: number;
  cockpitFov: number;
  /** Extra FOV added at full speed for a sense of speed. */
  speedFovBoost: number;
}

export const DEFAULT_CAMERA_CONFIG: Readonly<CameraConfig> = Object.freeze({
  chaseDistance: 22,
  chaseHeight: 5,
  chaseLookDown: 6,
  chasePositionStiffness: 25,
  chaseRotationStiffness: 7,
  chaseFov: 68,
  cockpitFov: 78,
  speedFovBoost: 8,
});

export const createCameraConfig = (): CameraConfig => ({ ...DEFAULT_CAMERA_CONFIG });
