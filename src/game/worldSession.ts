import { LANDMARKS, SPAWN_CONFIG } from '../config/worldConfig';
import type { WorldGenerator } from '../world/gen/WorldGenerator';
import type { PropsOptions } from '../world/props/PropsManager';

/** Pose for spawnAt(): position, heading (rotation about +Y, 0 = toward -Z), speed, on the ground. */
export interface SpawnPose {
  x: number;
  y: number;
  z: number;
  heading: number;
  speed: number;
  onGround: boolean;
}

/**
 * Props for a world: the Classic Canyon keeps its valley landmarks (power lines, arches) and runway
 * clear zone; seeded worlds pass the world (PropsManager clears their airfield itself).
 */
export function propsOptionsFor(world: WorldGenerator): PropsOptions {
  const r = world.airfield;
  const clearZones = [{ x: r.x, z: r.z, halfWidth: 140, halfLength: r.halfLength + 300, heading: 0 }];
  if (world.classicValleyCenterX) {
    return {
      seed: world.config.seed,
      heightAt: (x, z) => world.heightAt(x, z),
      valleyCenterX: world.classicValleyCenterX,
      powerLineZ: [...LANDMARKS.powerLineZ],
      archZ: [...LANDMARKS.archZ],
      clearZones,
    };
  }
  return { seed: world.config.seed, heightAt: (x, z) => world.heightAt(x, z), world };
}

/**
 * Free-flight spawn on any world. Multiplayer slots spread over the runway (2 columns, 60 m rows)
 * or behind the air start. Runway along Z, takeoff toward -Z (RunwayRect convention).
 * @param surfaceAt ground / water surface height
 * @param gearHeight jet origin height above the runway with the gear down
 */
export function freeSpawnPose(
  world: WorldGenerator,
  slot: number,
  onRunway: boolean,
  surfaceAt: (x: number, z: number) => number,
  gearHeight: number,
): SpawnPose {
  const dx = slot === 0 ? 0 : (slot % 2 === 1 ? -1 : 1) * 14;
  const back = Math.ceil(slot / 2) * 60;
  if (onRunway) {
    const r = world.airfield;
    return { x: r.x + dx, y: r.height + gearHeight, z: r.z + r.halfLength - 80 - back, heading: 0, speed: 0, onGround: true };
  }
  // In the air, heading along the air start (Classic: straight down the runway axis toward the canyon).
  const s = world.airSpawn;
  const fx = -Math.sin(s.heading);
  const fz = -Math.cos(s.heading);
  const cx = s.x - fx * back * 2;
  const cz = s.z - fz * back * 2;
  return {
    x: cx + Math.cos(s.heading) * dx * 3,
    y: surfaceAt(cx, cz) + SPAWN_CONFIG.heightAboveGround,
    z: cz - Math.sin(s.heading) * dx * 3,
    heading: s.heading,
    speed: SPAWN_CONFIG.speed,
    onGround: false,
  };
}

export interface MenuCameraPose {
  position: [number, number, number];
  target: [number, number, number];
}

const ORBIT_RADIUS = 1100;
const ORBIT_SAMPLES = 48;
const ORBIT_CLEARANCE = 220;

/**
 * Main-menu flyover on any world. Classic: the original run down the canyon. Other worlds: a slow
 * orbit around the air start at one height that clears every sampled point of the circle.
 * @param orbitHeight cached result of menuOrbitHeight(world, surfaceAt) (non-Classic worlds)
 */
export function menuCameraPose(world: WorldGenerator, time: number, surfaceAt: (x: number, z: number) => number, orbitHeight: number): MenuCameraPose {
  const center = world.classicValleyCenterX;
  if (center) {
    const z = 1500 - time * 40;
    const x = center(z);
    const lz = z - 400;
    const lx = center(lz);
    return { position: [x + Math.sin(time * 0.1) * 60, surfaceAt(x, z) + 90, z], target: [lx, surfaceAt(lx, lz) + 40, lz] };
  }
  const s = world.airSpawn;
  const a = time * 0.05;
  return {
    position: [s.x + Math.sin(a) * ORBIT_RADIUS, orbitHeight, s.z + Math.cos(a) * ORBIT_RADIUS],
    target: [s.x, surfaceAt(s.x, s.z) + 60, s.z],
  };
}

/** Safe constant flyover height for menuCameraPose's orbit (above the highest sampled ground of the circle). */
export function menuOrbitHeight(world: WorldGenerator, surfaceAt: (x: number, z: number) => number): number {
  const s = world.airSpawn;
  let top = surfaceAt(s.x, s.z);
  for (let i = 0; i < ORBIT_SAMPLES; i++) {
    const a = (i / ORBIT_SAMPLES) * Math.PI * 2;
    for (const r of [ORBIT_RADIUS * 0.85, ORBIT_RADIUS, ORBIT_RADIUS * 1.15]) top = Math.max(top, surfaceAt(s.x + Math.sin(a) * r, s.z + Math.cos(a) * r));
  }
  return top + ORBIT_CLEARANCE;
}
