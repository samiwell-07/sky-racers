import { describe, expect, it, vi } from 'vitest';
import { Color, Matrix4, Quaternion, Vector3 } from 'three';
import type { InstancedMesh } from 'three';
import type { Object3D } from 'three';
import { TERRAIN_CONFIG } from '../src/config/worldConfig';
import { createHeightFunction, valleyCenterX } from '../src/world/terrain/HeightField';
import { PROPS_MIN_VISIBLE_RADIUS, PropsManager } from '../src/world/props/PropsManager';
import type { PropsOptions } from '../src/world/props/PropsManager';
import {
  archOpeningTop,
  collideCell,
  distanceToCenterline,
  generateArch,
  generateCell,
  generatePowerLine,
} from '../src/world/props/propsPlacement';
import type { CellData, PlacementOptions } from '../src/world/props/propsPlacement';
import { collidePackedCell, packCell } from '../src/world/props/propsPacking';
import type { PropsWorkerMessage, PropsWorkerRequest, PropsWorkerResult } from '../src/world/props/propsWorkerProtocol';

const heightAt = createHeightFunction(TERRAIN_CONFIG);
const CELL = 400;
const POWER_Z = 1800;
const ARCH_Z = 3000;

const placement: PlacementOptions = { seed: 7, heightAt, valleyCenterX, powerLineZ: [POWER_Z], archZ: [ARCH_Z] };
const managerOptions: PropsOptions = { seed: 7, heightAt, valleyCenterX, powerLineZ: [POWER_Z], archZ: [ARCH_Z] };

/** Cells covering the valley for z in [800, 3600). */
function valleyCells(): CellData[] {
  const cells: CellData[] = [];
  for (let j = 2; j < 9; j++) {
    const cx = valleyCenterX((j + 0.5) * CELL);
    const i0 = Math.floor((cx - 700) / CELL);
    for (let i = i0; i <= i0 + 3; i++) cells.push(generateCell(i, j, CELL, placement));
  }
  return cells;
}

describe('props placement', () => {
  const cells = valleyCells();

  it('is deterministic', () => {
    const a = generateCell(1, 5, CELL, { ...placement });
    const b = generateCell(1, 5, CELL, { ...placement });
    expect(a).toEqual(b);
    expect(a.trees.length + a.rocks.length).toBeGreaterThan(0);
  });

  it('keeps a ±55 m flight corridor around the valley centerline', () => {
    let count = 0;
    for (const cell of cells) {
      for (const o of [...cell.trees, ...cell.rocks, ...cell.buildings]) {
        count++;
        expect(Math.abs(o.x - valleyCenterX(o.z))).toBeGreaterThanOrEqual(55);
        expect(distanceToCenterline(valleyCenterX, o.x, o.z)).toBeGreaterThanOrEqual(55);
      }
    }
    expect(count).toBeGreaterThan(100);
  });

  it('keeps trees off high snow and leaves the power line clear of the floor', () => {
    for (const cell of cells) for (const t of cell.trees) expect(t.y).toBeLessThan(431);
    for (const z of [POWER_Z, -2500, 600, 4200, 7000]) {
      const line = generatePowerLine(z, placement);
      expect(line.lowestCableY - line.floorY).toBeGreaterThanOrEqual(69.9);
      expect(line.lowestCableY - line.floorY).toBeLessThan(110);
    }
  });

  it('makes the arch opening at least 70 m wide and 45 m high', () => {
    const arch = generateArch(ARCH_Z, placement);
    expect(archOpeningTop(arch, 35) - arch.floorY).toBeGreaterThanOrEqual(45);
    expect(archOpeningTop(arch, -35) - arch.floorY).toBeGreaterThanOrEqual(45);
  });
});

describe('PropsManager.collide', () => {
  const props = new PropsManager(managerOptions);

  it('detects a point inside a generated tree, without building meshes', () => {
    const tree = valleyCells().flatMap((c) => c.trees)[0]!;
    expect(tree).toBeDefined();
    const inside = new Vector3(tree.x, tree.y + tree.height * 0.4, tree.z);
    expect(props.collide([inside])).toBe('tree');
    expect(props.collide([new Vector3(tree.x, tree.y + tree.height + 20, tree.z)])).toBeNull();
  });

  it('detects a point near a power cable', () => {
    const line = generatePowerLine(POWER_Z, placement);
    const [x, y, z] = line.cables[0]![16]!;
    expect(props.collide([new Vector3(x, y + 1, z)])).toBe('powerline');
    expect(props.collide([new Vector3(x, y - 20, z)])).toBeNull();
  });

  it('lets the player fly through the middle of an arch but not into its stone', () => {
    const arch = generateArch(ARCH_Z, placement);
    expect(props.collide([new Vector3(arch.x, arch.floorY + 30, arch.z)])).toBeNull();
    expect(props.collide([new Vector3(arch.x, arch.deckY - 2, arch.z)])).toBe('arch');
  });
});

describe('packed cells', () => {
  it('collide exactly like the unpacked cell', () => {
    let hits = 0;
    for (const cell of valleyCells().slice(0, 12)) {
      const packed = packCell(cell);
      for (const o of [...cell.trees, ...cell.rocks, ...cell.buildings]) {
        for (const [dx, dy, dz] of [[0, 1, 0], [0, 4, 0], [1.5, 2, -1], [3, 6, 2], [0, 30, 0], [-6, 1, 5]] as const) {
          const expected = collideCell(cell, o.x + dx, o.y + dy, o.z + dz);
          expect(collidePackedCell(packed, o.x + dx, o.y + dy, o.z + dz)).toBe(expected);
          if (expected) hits++;
        }
      }
    }
    expect(hits).toBeGreaterThan(100);
  });

  it('matches the Three.js instance transforms and colors', () => {
    let cell: CellData | undefined;
    for (let k = 0; k < 400 && !cell; k++) {
      const c = generateCell((k % 20) - 10, Math.floor(k / 20) - 10, CELL, placement);
      if (c.buildings.length > 0 && c.trees.length > 0) cell = c;
    }
    expect(cell).toBeDefined();
    const packed = packCell(cell!);
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const color = new Color();
    const expectClose = (actual: ArrayLike<number>, offset: number, expected: ArrayLike<number>): void => {
      for (let k = 0; k < expected.length; k++) expect(actual[offset + k]).toBeCloseTo(expected[k]!, 3);
    };
    const tree = cell!.trees[0]!;
    const w = tree.height * tree.widthScale;
    m.compose(new Vector3(tree.x, tree.y, tree.z), q.setFromAxisAngle(up, tree.rotation), new Vector3(w, tree.height, w));
    expectClose(packed.instances[tree.kind].matrices, 0, m.elements);
    expectClose(packed.instances[tree.kind].colors, 0, tree.tint);
    const b = cell!.buildings[0]!;
    m.compose(new Vector3(b.x, b.y + b.wallHeight, b.z), q.setFromAxisAngle(up, b.heading), new Vector3(b.width, b.roofHeight, b.depth));
    expectClose(packed.instances.roof.matrices, 0, m.elements);
    color.setHex(b.wallColor);
    expectClose(packed.instances.walls.colors, 0, [color.r, color.g, color.b]);
  });
});

describe('PropsManager streaming', { timeout: 60_000 }, () => {
  const cellMeshes = (props: PropsManager): Object3D[] => props.group.children.filter((c) => c.name.startsWith('props-cell-'));
  /** A clock that never advances: every update drains its whole queue (no wall-clock dependence). */
  const frozenClock = (): number => 0;

  it('generates cells synchronously when there is no Worker', () => {
    const props = new PropsManager({ ...managerOptions, quality: 'low', clock: frozenClock });
    props.update(new Vector3(valleyCenterX(2000), 120, 2000));
    expect(cellMeshes(props).length).toBeGreaterThan(0);
    props.dispose();
  });

  it('spreads mesh building over updates by the frame budget, and always makes progress', () => {
    let now = 0;
    // Every clock read advances 1 ms: the 2 ms budget allows only a couple of builds per update.
    const props = new PropsManager({ ...managerOptions, quality: 'low', clock: () => now++ });
    const camera = new Vector3(valleyCenterX(2000), 120, 2000);
    props.update(camera);
    const first = cellMeshes(props).length;
    expect(first).toBeGreaterThanOrEqual(1);
    expect(first).toBeLessThanOrEqual(3);
    let previous = first;
    let updates = 1;
    for (; updates < 500; updates++) {
      props.update(camera);
      const count = cellMeshes(props).length;
      if (count === previous) break;
      previous = count;
    }
    const all = new PropsManager({ ...managerOptions, quality: 'low', clock: frozenClock });
    all.update(camera);
    expect(previous).toBe(cellMeshes(all).length);
    expect(updates).toBeGreaterThan(5);
    props.dispose();
    all.dispose();
  });

  it('streams cells from the worker and still collides with cells it has not delivered', () => {
    class FakeWorker {
      static last: FakeWorker;
      readonly messages: PropsWorkerMessage[] = [];
      onmessage: ((e: MessageEvent<PropsWorkerResult>) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      constructor() {
        FakeWorker.last = this;
      }
      postMessage(msg: PropsWorkerMessage): void {
        this.messages.push(msg);
      }
      terminate(): void {}
    }
    vi.stubGlobal('Worker', FakeWorker);
    try {
      const props = new PropsManager({ ...managerOptions, clock: frozenClock });
      const worker = FakeWorker.last;
      expect(worker.messages[0]!.type).toBe('init');

      const tree = valleyCells().flatMap((c) => c.trees)[0]!;
      const camera = new Vector3(tree.x, tree.y + 150, tree.z);
      props.update(camera);
      const request = worker.messages.at(-1) as PropsWorkerRequest;
      expect(request.type).toBe('request');
      expect(request.cells.slice(0, 2)).toEqual([Math.floor(tree.x / CELL), Math.floor(tree.z / CELL)]);
      expect(cellMeshes(props)).toHaveLength(0);

      expect(props.collide([new Vector3(tree.x, tree.y + tree.height * 0.4, tree.z)])).toBe('tree');

      const [i, j] = request.cells.slice(2, 4) as [number, number];
      worker.onmessage!({ data: { generation: 0, cell: packCell(generateCell(i, j, CELL, placement)) } } as MessageEvent<PropsWorkerResult>);
      const sent = worker.messages.length;
      props.update(camera);
      props.update(camera.clone().setZ(camera.z - 30));
      expect(worker.messages.length).toBe(sent);
      expect(cellMeshes(props).map((c) => c.name)).toContain(`props-cell-${i},${j}`);

      props.update(camera.clone().setZ(camera.z - 80));
      expect(worker.messages.length).toBe(sent + 1);
      props.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
describe('graphics-independent collision world', { timeout: 60_000 }, () => {
  const QUALITIES = ['low', 'medium', 'high'] as const;
  /** Probe points over the valley floor, its forested edges and the landmarks, from 0 to 40 m above the ground. */
  function probes(): Vector3[] {
    const pts: Vector3[] = [];
    for (let z = 900; z < 3500; z += 7) {
      const cx = valleyCenterX(z);
      for (let off = -330; off <= 330; off += 11) {
        const x = cx + off;
        const g = heightAt(x, z);
        for (const h of [1, 4, 9, 16, 40]) pts.push(new Vector3(x, g + h, z));
      }
    }
    return pts;
  }
  const pts = probes();
  const outcomes = (props: PropsManager): Array<string | null> => pts.map((p) => props.collide([p]));

  it('gives identical collisions, AI obstacle tops and hazard bands at low, medium and high quality', () => {
    const results = QUALITIES.map((quality) => {
      const props = new PropsManager({ ...managerOptions, quality, clock: () => 0 });
      // Stream meshes first, so quality-dependent rendering can't leak into collision.
      props.update(new Vector3(valleyCenterX(2000), 150, 2000));
      const bands: number[] = [];
      const tops = pts.filter((_, k) => k % 25 === 0).map((p) => props.obstacleTop(p.x, p.z, 11));
      const hazards = pts.filter((_, k) => k % 25 === 0).map((p) => props.hazardBands(p.x, p.z, 11, bands) && bands.slice(0, 2).join());
      const hits = outcomes(props);
      props.dispose();
      return { hits, tops, hazards };
    });
    const counts = new Map<string, number>();
    for (const h of results[0]!.hits) if (h) counts.set(h, (counts.get(h) ?? 0) + 1);
    expect(counts.get('tree') ?? 0).toBeGreaterThan(50);
    expect(counts.get('powerline') ?? 0).toBeGreaterThan(0);
    expect(counts.get('arch') ?? 0).toBeGreaterThan(0);
    for (const r of results.slice(1)) expect(r).toEqual(results[0]);
  });

  it('keeps collisions identical when the quality changes at runtime', () => {
    const props = new PropsManager({ ...managerOptions, quality: 'high', clock: () => 0 });
    const camera = new Vector3(valleyCenterX(2000), 150, 2000);
    props.update(camera);
    const before = outcomes(props);
    for (const q of ['low', 'medium', 'high', 'low'] as const) {
      props.setQuality(q);
      props.update(camera);
      expect(outcomes(props)).toEqual(before);
    }
    props.dispose();
  });

  it('does not depend on whether or in which order the worker delivers cells', () => {
    class SilentWorker {
      static last: SilentWorker;
      onmessage: ((e: MessageEvent<PropsWorkerResult>) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      readonly requests: number[][] = [];
      constructor() {
        SilentWorker.last = this;
      }
      postMessage(msg: PropsWorkerMessage): void {
        if (msg.type === 'request') this.requests.push(msg.cells);
      }
      terminate(): void {}
    }
    const reference = new PropsManager({ ...managerOptions, useWorker: false });
    const expected = outcomes(reference);
    reference.dispose();
    vi.stubGlobal('Worker', SilentWorker);
    try {
      const camera = new Vector3(valleyCenterX(2000), 150, 2000);
      // Never delivered: everything is generated on demand.
      const silent = new PropsManager({ ...managerOptions, clock: () => 0 });
      silent.update(camera);
      expect(outcomes(silent)).toEqual(expected);
      silent.dispose();
      // Delivered in reverse order, as the worker would generate them.
      const reversed = new PropsManager({ ...managerOptions, clock: () => 0 });
      reversed.update(camera);
      const cells = SilentWorker.last.requests[0]!;
      for (let k = cells.length - 2; k >= 0; k -= 2) {
        const cell = packCell(generateCell(cells[k]!, cells[k + 1]!, CELL, placement));
        SilentWorker.last.onmessage!({ data: { generation: 0, cell } } as MessageEvent<PropsWorkerResult>);
      }
      reversed.update(camera);
      expect(outcomes(reversed)).toEqual(expected);
      reversed.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('draws every collidable obstacle within PROPS_MIN_VISIBLE_RADIUS at low quality, with cheaper meshes', () => {
    const camera = new Vector3(valleyCenterX(2000), 150, 2000);
    const low = new PropsManager({ ...managerOptions, quality: 'low', clock: () => 0 });
    const high = new PropsManager({ ...managerOptions, quality: 'high', clock: () => 0 });
    for (let k = 0; k < 8; k++) {
      low.update(camera);
      high.update(camera);
    }
    const drawn = new Map(low.group.children.map((c) => [c.name, c]));
    let checked = 0;
    const r = PROPS_MIN_VISIBLE_RADIUS;
    for (let j = Math.floor((camera.z - r) / CELL); j <= Math.floor((camera.z + r) / CELL); j++) {
      for (let i = Math.floor((camera.x - r) / CELL); i <= Math.floor((camera.x + r) / CELL); i++) {
        const cell = generateCell(i, j, CELL, placement);
        // Obstacles of this cell inside the radius must be drawn, all of them (full collision density).
        const near = [...cell.trees, ...cell.rocks, ...cell.buildings].some((o) => Math.hypot(o.x - camera.x, o.z - camera.z) <= r);
        if (!near) continue;
        const group = drawn.get(`props-cell-${i},${j}`);
        expect(group, `cell ${i},${j}`).toBeDefined();
        const instances = group!.children.reduce((n, m) => n + (m.name === 'roof' ? 0 : (m as InstancedMesh).count), 0);
        expect(instances).toBe(cell.trees.length + cell.rocks.length + cell.buildings.length);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
    for (const name of ['powerline-1800', 'arch-3000']) expect(drawn.has(name), name).toBe(true);
    const treeGeometry = (props: PropsManager) =>
      (props.group.children.flatMap((c) => c.children).find((m) => m.name === 'conifer') as InstancedMesh).geometry;
    expect(treeGeometry(low).getAttribute('position').count).toBeLessThan(treeGeometry(high).getAttribute('position').count);
    low.dispose();
    high.dispose();
  });
});
