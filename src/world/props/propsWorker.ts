import { TERRAIN_CONFIG } from '../../config/worldConfig';
import { HeightField, valleyCenterX } from '../terrain/HeightField';
import { generateCell, seededPlacement } from './propsPlacement';
import { createWorld } from '../gen/createWorld';
import type { PlacementOptions } from './propsPlacement';
import { packCell, packedCellTransferables } from './propsPacking';
import { PROPS_CELL_SIZE } from './propsWorkerProtocol';
import type { PropsWorkerMessage, PropsWorkerResult } from './propsWorkerProtocol';

/**
 * Generates prop cells off the main thread. The height function is rebuilt here: the game's
 * PropsOptions.heightAt is HeightField(TERRAIN_CONFIG).getHeightAt, so the result is identical.
 * Seeded worlds are rebuilt from their WorldSpec with createWorld() (deterministic per spec).
 */

const heightField = new HeightField(TERRAIN_CONFIG);
const heightAt = (x: number, z: number): number => heightField.getHeightAt(x, z);
/** Yield to the message loop this often so a new request can replace a stale queue. */
const SLICE_MS = 8;

let placement: PlacementOptions | null = null;
let generation = -1;
let queue: number[] = [];
let next = 0;
let scheduled = false;

self.onmessage = (e: MessageEvent<PropsWorkerMessage>): void => {
  const msg = e.data;
  if (msg.type === 'init') {
    generation = msg.generation;
    placement =
      msg.world && msg.world.kind === 'seeded'
        ? seededPlacement(msg.seed, createWorld(msg.world), msg.clearZones, msg.density)
        : {
            seed: msg.seed,
            heightAt,
            valleyCenterX,
            powerLineZ: msg.powerLineZ,
            archZ: msg.archZ,
            clearZones: msg.clearZones,
            density: msg.density,
          };
    queue = [];
    next = 0;
    return;
  }
  if (msg.generation !== generation) return;
  queue = msg.cells;
  next = 0;
  schedule();
};

function schedule(): void {
  if (scheduled || next >= queue.length) return;
  scheduled = true;
  setTimeout(pump, 0);
}

function pump(): void {
  scheduled = false;
  const start = performance.now();
  while (placement && next + 1 < queue.length) {
    const i = queue[next++]!;
    const j = queue[next++]!;
    const cell = packCell(generateCell(i, j, PROPS_CELL_SIZE, placement));
    const result: PropsWorkerResult = { generation, cell };
    self.postMessage(result, { transfer: packedCellTransferables(cell) });
    if (performance.now() - start > SLICE_MS) break;
  }
  schedule();
}
