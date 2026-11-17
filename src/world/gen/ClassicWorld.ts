import { LANDMARKS, RUNWAY_CONFIG, SPAWN_CONFIG, TERRAIN_CONFIG, type TerrainConfig } from '../../config/worldConfig';
import { smoothstep } from '../../utils/math';
import { createHeightFunction, distanceToRunway, runwayRect, valleyCenterX, valleyDirection, type RunwayRect } from '../terrain/HeightField';
import {
  CLASSIC_WORLD,
  type Biome,
  type BridgeSite,
  type CitySite,
  type RoadSegment,
  type SpawnPoint,
  type SurfaceSample,
  type WorldGenerator,
  type WorldSpec,
} from './WorldGenerator';

const NO_CITIES: readonly CitySite[] = Object.freeze([]);
const NO_ROADS: readonly RoadSegment[] = Object.freeze([]);

/** Stone arches of propsPlacement.generateArch (approximate: opening 80 m, deck 84 m above the floor). */
const ARCH_OPEN_HALF = 80;
const ARCH_DECK_ABOVE_FLOOR = 84;
const ARCH_SPRING_DROP = 6;
const ARCH_HALF_SPAN = 300;

/**
 * The original hand-made canyon as a WorldGenerator. Heights come straight from
 * createHeightFunction(config): bit-identical to before, so courses, records and ghosts still match.
 */
export class ClassicWorld implements WorldGenerator {
  readonly spec: WorldSpec = CLASSIC_WORLD;
  readonly airfield: RunwayRect;
  readonly airSpawn: SpawnPoint;
  readonly classicValleyCenterX = valleyCenterX;
  /** Final ground height (the classic height function itself, no wrapper). */
  readonly heightAt: (x: number, z: number) => number;
  private bridges: BridgeSite[] | null = null;

  /** @param heightFn override for tests (flat ground...); water, airfield and props stay classic. */
  constructor(
    readonly config: TerrainConfig = TERRAIN_CONFIG,
    heightFn: (x: number, z: number) => number = createHeightFunction(config),
  ) {
    this.heightAt = heightFn;
    this.airfield = runwayRect(RUNWAY_CONFIG);
    this.airSpawn = { x: this.airfield.x, z: SPAWN_CONFIG.z, heading: 0 };
  }

  /** The river along the canyon (except under the runway approach); no other water. */
  waterLevelAt(x: number, z: number): number {
    const c = this.config;
    return Math.abs(x - valleyCenterX(z)) < c.riverHalfWidth + 12 && distanceToRunway(x, z, this.airfield, 25) > 40 ? c.waterLevel : -Infinity;
  }

  biomeAt(x: number, z: number): Biome {
    if (this.waterLevelAt(x, z) > -Infinity) return 'river';
    const dx = Math.abs(x - valleyCenterX(z));
    if (dx < this.config.valleyHalfWidth + this.config.valleyWallWidth) return 'valley';
    const h = this.heightAt(x, z);
    if (h > 700) return 'snow';
    if (h > 320) return 'mountains';
    return h < 60 ? 'plains' : 'hills';
  }

  /** Classic keeps its original look: the splat material draws its own river banks. */
  surfaceAt(_x: number, _z: number, out: SurfaceSample): SurfaceSample {
    out.paved = 0;
    out.sand = 0;
    return out;
  }

  canyonFactor(x: number, z: number): number {
    return 1 - smoothstep(150, 400, Math.abs(x - valleyCenterX(z)));
  }

  citiesNear(): readonly CitySite[] {
    return NO_CITIES;
  }

  roadsNear(): readonly RoadSegment[] {
    return NO_ROADS;
  }

  bridgesNear(x: number, z: number, radius: number): readonly BridgeSite[] {
    return this.archSites().filter((b) => Math.hypot(b.x - x, b.z - z) <= radius + b.halfSpan);
  }

  /** LANDMARKS.archZ stone arches spanning the canyon, perpendicular to the valley. */
  private archSites(): BridgeSite[] {
    if (!this.bridges) {
      this.bridges = LANDMARKS.archZ.map((z) => {
        const x = valleyCenterX(z);
        const [dx, dz] = valleyDirection(z);
        const floorY = this.heightAt(x, z);
        return {
          x,
          z,
          heading: Math.atan2(-dx, -dz),
          halfSpan: ARCH_HALF_SPAN,
          bottomY: floorY - ARCH_SPRING_DROP,
          deckY: floorY + ARCH_DECK_ABOVE_FLOOR,
          openHalfWidth: ARCH_OPEN_HALF,
        };
      });
    }
    return this.bridges;
  }
}
