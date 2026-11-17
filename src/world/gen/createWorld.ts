import { ClassicWorld } from './ClassicWorld';
import { SeededWorld } from './SeededWorld';
import { worldKey, type WorldGenerator, type WorldSpec } from './WorldGenerator';

/** Few worlds are alive at once (current + maybe the previous session's): keep the cache small. */
const MAX_CACHED = 4;
const cache = new Map<string, WorldGenerator>();

/** The world for a spec, cached per worldKey (same spec = same instance, in every thread). */
export function createWorld(spec: WorldSpec): WorldGenerator {
  const key = worldKey(spec);
  let world = cache.get(key);
  if (world) {
    cache.delete(key);
  } else {
    world = spec.kind === 'classic' ? new ClassicWorld() : new SeededWorld(spec.seed);
    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
  }
  cache.set(key, world);
  return world;
}
