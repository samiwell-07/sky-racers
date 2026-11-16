/**
 * All tunable flight parameters. Units are SI (meters, seconds, radians) and forces are
 * expressed as accelerations (per unit of mass) to keep tuning intuitive.
 */
export interface FlightConfig {
  gravity: number;
  /** Acceleration at 100% throttle (m/s²). */
  maxThrust: number;
  /** How fast the throttle lever moves (fraction per second). */
  throttleRate: number;
  /** Throttle above which the afterburner visual kicks in. */
  afterburnerThreshold: number;

  /** Lift acceleration = liftCoefficient * speed² * CL. */
  liftCoefficient: number;
  /** CL at zero angle of attack (wing camber). */
  cl0: number;
  /** CL gained per radian of angle of attack. */
  clAlpha: number;
  /** Angle of attack (rad) where the wing stalls. */
  stallAngle: number;
  /** Fraction of max lift kept when deep in the stall. */
  postStallLift: number;

  /** Parasitic drag: acceleration = dragCoefficient * speed². */
  dragCoefficient: number;
  /** Induced drag: acceleration = inducedDrag * CL² * speed² (bleeds energy in hard turns). */
  inducedDrag: number;
  /** Damps sideways sliding (1/s). */
  sideForce: number;

  /** Max pitch rate commanded by the stick (rad/s). */
  maxPitchRate: number;
  /** Max roll rate commanded by the stick (rad/s). */
  maxRollRate: number;
  /** How quickly the jet reaches the commanded rate (1/s). */
  rateResponse: number;
  /** Below this speed the controls lose authority (m/s). */
  minControlSpeed: number;
  /** Above this speed the controls have full authority (m/s). */
  fullControlSpeed: number;
  /** Control authority left at very low speed (0..1). */
  minControlAuthority: number;

  /** Passive yaw: how strongly the nose aligns with the flight path (1/s). Not a player control. */
  directionalStability: number;
  /** How hard the nose drops once stalled (1/s). */
  stallPitchDown: number;

  /** Fly-by-wire: prevents the stick from pulling past the stall angle. */
  alphaLimiter: boolean;
  /** Structural G limit for lift. */
  maxG: number;
  /** Speed under which the stall warning is shown (m/s). */
  stallWarningSpeed: number;
}

export const DEFAULT_FLIGHT_CONFIG: Readonly<FlightConfig> = Object.freeze({
  gravity: 9.81,
  maxThrust: 30,
  throttleRate: 0.6,
  afterburnerThreshold: 0.85,

  liftCoefficient: 0.0016,
  cl0: 0.25,
  clAlpha: 4.5,
  stallAngle: 0.3,
  postStallLift: 0.35,

  dragCoefficient: 0.00062,
  inducedDrag: 0.0004,
  sideForce: 2.5,

  maxPitchRate: 1.2,
  maxRollRate: 3.2,
  rateResponse: 6,
  minControlSpeed: 30,
  fullControlSpeed: 110,
  minControlAuthority: 0.15,

  directionalStability: 3,
  stallPitchDown: 4,

  alphaLimiter: true,
  maxG: 9,
  stallWarningSpeed: 75,
});

export const createFlightConfig = (overrides: Partial<FlightConfig> = {}): FlightConfig => ({
  ...DEFAULT_FLIGHT_CONFIG,
  ...overrides,
});
