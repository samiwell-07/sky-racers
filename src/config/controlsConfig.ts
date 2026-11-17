/** Default keyboard bindings, using physical key codes (KeyboardEvent.code) so they work on any layout. Rebindable in Settings. */
export const KEY_BINDINGS = {
  pitchDown: ['KeyW'],
  pitchUp: ['KeyS'],
  rollLeft: ['KeyA'],
  rollRight: ['KeyD'],
  throttleUp: ['ArrowUp', 'ShiftLeft', 'ShiftRight'],
  throttleDown: ['ArrowDown', 'ControlLeft', 'ControlRight'],
  airbrake: ['KeyB'],
  toggleGear: ['KeyG'],
  toggleLights: ['KeyL'],
  toggleCamera: ['KeyC'],
  respawn: ['KeyR'],
  pause: ['KeyP', 'Escape'],
  toggleHelp: ['KeyH'],
  fullscreen: ['KeyF'],
  fireGun: ['Space'],
  fireMissile: ['KeyQ'],
  releaseFlares: ['KeyE'],
  radarZoom: ['KeyZ'],
} as const satisfies Record<string, readonly string[]>;

export type InputAction = keyof typeof KEY_BINDINGS;

export const ACTION_LABELS: Record<InputAction, string> = {
  pitchDown: 'Nose down',
  pitchUp: 'Nose up',
  rollLeft: 'Roll left',
  rollRight: 'Roll right',
  throttleUp: 'Throttle up',
  throttleDown: 'Throttle down',
  airbrake: 'Airbrake (hold)',
  toggleGear: 'Landing gear',
  toggleLights: 'Jet lights on / off',
  toggleCamera: 'Chase / cockpit camera',
  respawn: 'Respawn / restart',
  pause: 'Pause menu',
  toggleHelp: 'Show / hide help',
  fullscreen: 'Fullscreen',
  fireGun: 'Fire gun (hold)',
  fireMissile: 'Fire missile (hold to wait for lock)',
  releaseFlares: 'Release flares',
  radarZoom: 'Radar zoom',
};

export interface ControlsConfig {
  /** Flip pitch so W = nose up (airplane-game style instead of flight-stick style). */
  invertPitch: boolean;
}

export const DEFAULT_CONTROLS_CONFIG: Readonly<ControlsConfig> = Object.freeze({
  invertPitch: false,
});
