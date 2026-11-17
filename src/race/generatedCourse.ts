import { worldKey, type WorldSpec } from '../world/gen/WorldGenerator';

/** SHARED CONTRACT (phase 0): generated race courses (implemented in ./CourseGenerator.ts). */

export type RaceDifficulty = 'easy' | 'medium' | 'hard';
export type RaceLayout = 'sprint' | 'loop';

export const RACE_DIFFICULTIES: readonly RaceDifficulty[] = ['easy', 'medium', 'hard'];

export interface CourseRequest {
  world: WorldSpec;
  difficulty: RaceDifficulty;
  layout: RaceLayout;
}

/** Version of the generator; part of generated course ids so records reset when the generator changes. */
export const COURSE_GENERATOR_VERSION = 1;

/** Stable id: `gen:<worldKey>:<layout>:<difficulty>:v<version>` (records/ghosts are keyed on it). */
export function generatedCourseId(req: CourseRequest): string {
  return `gen:${worldKey(req.world)}:${req.layout}:${req.difficulty}:v${COURSE_GENERATOR_VERSION}`;
}

export function parseGeneratedCourseId(id: string): CourseRequest | null {
  const m = /^gen:(classic|s\d{1,10}):(sprint|loop):(easy|medium|hard):v(\d+)$/.exec(id);
  if (!m) return null;
  const key = m[1]!;
  const world: WorldSpec = key === 'classic' ? { kind: 'classic' } : { kind: 'seeded', seed: Number(key.slice(1)) >>> 0 };
  return { world, layout: m[2] as RaceLayout, difficulty: m[3] as RaceDifficulty };
}
