import type { ClearZone } from './propsPlacement';
import type { PackedCell } from './propsPacking';
import type { WorldSpec } from '../gen/WorldGenerator';

/** Messages between PropsManager and the props worker. Only plain data: functions can't be posted. */

export const PROPS_CELL_SIZE = 400;

export interface PropsWorkerInit {
  type: 'init';
  generation: number;
  seed: number;
  /**
   * Seeded worlds: the worker rebuilds the world with createWorld(world) and uses seededPlacement().
   * Absent: the Classic valley (HeightField(TERRAIN_CONFIG), powerLineZ, archZ).
   */
  world?: WorldSpec;
  powerLineZ: number[];
  archZ: number[];
  clearZones: ClearZone[];
  density: number;
}

/** Replaces the worker's queue: cells as flat (i, j) pairs, nearest first. */
export interface PropsWorkerRequest {
  type: 'request';
  generation: number;
  cells: number[];
}

export type PropsWorkerMessage = PropsWorkerInit | PropsWorkerRequest;

export interface PropsWorkerResult {
  generation: number;
  cell: PackedCell;
}
