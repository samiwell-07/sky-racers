export interface TerrainConfig {
  seed: number;
  /** Size of one streamed terrain chunk (m). Must be a multiple of the base cell size. */
  chunkSize: number;
  /** Grid cells per chunk side at full detail (LOD 0). Cell size = chunkSize / chunkSegments. */
  chunkSegments: number;
  /** Distance (m) up to which each LOD level is used; LOD n halves the resolution of LOD n-1. */
  lodDistances: number[];
  baseHeight: number;
  hillHeight: number;
  mountainHeight: number;
  /** Valley floor height above zero. */
  valleyFloorHeight: number;
  /** Half width of the flat valley floor. */
  valleyHalfWidth: number;
  /** Horizontal width of the valley walls. */
  valleyWallWidth: number;
  /** Extra height of the ridges lining the valley. */
  valleyRimBoost: number;
  /** River running down the middle of the valley. */
  riverHalfWidth: number;
  riverDepth: number;
  /** Water surface height. */
  waterLevel: number;
  /** Meters covered by one repeat of the ground textures. */
  detailTextureScale: number;
}

export const TERRAIN_CONFIG: Readonly<TerrainConfig> = Object.freeze({
  seed: 1337,
  chunkSize: 1000,
  chunkSegments: 64,
  lodDistances: [1600, 3600, 7500],
  baseHeight: 30,
  hillHeight: 90,
  mountainHeight: 220,
  valleyFloorHeight: 20,
  valleyHalfWidth: 90,
  valleyWallWidth: 170,
  valleyRimBoost: 140,
  riverHalfWidth: 22,
  riverDepth: 7,
  waterLevel: 17,
  detailTextureScale: 24,
});

export interface RunwayConfig {
  /** Runway center Z. */
  z: number;
  /** The runway's axis (along Z) lines up with the canyon centerline at this Z, so takeoffs and starts head straight in. */
  alignZ: number;
  length: number;
  width: number;
  /** Flattened runway height. */
  height: number;
  /** Width of the terrain blend around the runway (m). */
  blend: number;
}

/** Airfield at the valley entrance, flying toward -Z on takeoff. */
export const RUNWAY_CONFIG: Readonly<RunwayConfig> = Object.freeze({
  z: 4500,
  alignZ: 2600,
  length: 1800,
  width: 50,
  height: 24,
  blend: 260,
});

export interface GateConfig {
  /** Opening width as a multiple of the jet's wingspan. */
  widthToSpan: number;
  /** Opening height as a multiple of the jet's height. */
  heightToJetHeight: number;
  /** Visual thickness of the glowing hologram frame (m). */
  frame: number;
  /** Gap between the ground and the bottom of the frame (m). Small on purpose: this is a low-level game. */
  groundClearance: number;
}

/** Jet bounding size, from the model in entities/jet/JetModel.ts (wingtip to wingtip, belly to fin tips). */
export const JET_SIZE = Object.freeze({ span: 13.2, height: 4.6 });

export const GATE_CONFIG: Readonly<GateConfig> = Object.freeze({
  widthToSpan: 5, // 66 m
  heightToJetHeight: 12, // 55.2 m
  frame: 0.9,
  groundClearance: 3,
});

/** Valley landmarks shared by the props (obstacles) and the courses. */
export const LANDMARKS = Object.freeze({
  archZ: [1250, -1450, -4300],
  powerLineZ: [2150, -350, -2700],
});

export interface SpawnConfig {
  z: number;
  heightAboveGround: number;
  speed: number;
  throttle: number;
  /** Seconds before respawn after a crash. */
  respawnDelay: number;
}

export const SPAWN_CONFIG: Readonly<SpawnConfig> = Object.freeze({
  z: 3150,
  heightAboveGround: 140,
  speed: 150,
  throttle: 0.55,
  respawnDelay: 2.5,
});

/**
 * Seeded (infinite, Minecraft-style) worlds: sea level and the scales of the big features. Sizes in
 * meters; "scale" = wavelength of the noise. Tuned for jets at 150-250 m/s: biomes change every few km.
 */
export const SEEDED_TERRAIN = Object.freeze({
  seaLevel: 0,
  /** Continents / oceans. */
  continentScale: 26000,
  /** Continentalness above which there is land (lower = more land; ~70% land). */
  landThreshold: -0.17,
  /** How far river / lake water rises above sea level far inland (m); kept low so rivers barely slope. */
  inlandRise: 80,
  /** Plains / hills / mountain regions. */
  regionScale: 18000,
  hillScale: 2600,
  ridgeScale: 4200,
  /** Highest ridged peaks above the surrounding land (m). */
  mountainHeight: 1000,
  /** Distance between the river valleys (~half the scale). */
  riverScale: 16000,
  lakeScale: 5200,
  /** Domain warp that bends coasts and rivers. */
  warpScale: 9000,
  warpAmount: 1400,
  snowLine: 700,
});
