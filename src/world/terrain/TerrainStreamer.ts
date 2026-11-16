import { Group, type Material, type Vector3 } from 'three';
import { computeChunkArrays, type ChunkArrays } from './chunkMeshData';
import type { HeightField } from './HeightField';
import { TerrainChunk } from './TerrainChunk';

interface Wanted {
  cx: number;
  cz: number;
  lod: number;
  dist: number;
}

type ChunkResult = ChunkArrays & { key: string; cx: number; cz: number; lod: number };

/** Chunks this close to the camera are built synchronously if missing (e.g. right after a spawn). */
const SYNC_DISTANCE = 450;
/** Re-evaluate which chunks are needed only after the camera moved this far (m). */
const REPLAN_DISTANCE = 60;
/** Main-thread time budget per frame for adding finished chunks to the scene (ms). */
const FRAME_BUDGET_MS = 3;

/**
 * Streams terrain chunks around the camera: full detail nearby, coarser further away, nothing
 * beyond the last LOD distance (hidden by fog). Vertex data is generated in Web Workers so the
 * main thread never stalls; Node (tests) falls back to synchronous generation.
 */
export class TerrainStreamer {
  readonly group = new Group();
  private readonly chunks = new Map<string, TerrainChunk>();
  private lodDistances: number[];
  private readonly workers: Worker[] = [];
  private readonly busy: boolean[] = [];
  /** key -> lod requested and not yet received. */
  private readonly inFlight = new Map<string, number>();
  private readonly ready: ChunkResult[] = [];
  private queue: Array<[string, Wanted]> = [];
  private wanted = new Map<string, Wanted>();
  private lastPlanX = Number.NaN;
  private lastPlanZ = Number.NaN;

  constructor(
    private readonly heightField: HeightField,
    private material: Material,
  ) {
    this.group.name = 'terrain';
    this.lodDistances = [...heightField.config.lodDistances];
    if (typeof Worker !== 'undefined') {
      const count = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 2));
      for (let i = 0; i < count; i++) {
        const w = new Worker(new URL('./terrainWorker.ts', import.meta.url), { type: 'module' });
        w.onmessage = (e: MessageEvent<ChunkResult>) => {
          this.busy[i] = false;
          this.ready.push(e.data);
          this.pump();
        };
        this.workers.push(w);
        this.busy.push(false);
      }
    }
  }

  /** Scale view distance (graphics quality). */
  setDetail(viewScale: number): void {
    this.lodDistances = this.heightField.config.lodDistances.map((d) => d * viewScale);
    this.lastPlanX = Number.NaN;
  }

  /** Replace the material of every chunk (graphics quality change). */
  setMaterial(material: Material): void {
    this.material = material;
    for (const chunk of this.chunks.values()) chunk.mesh.material = material;
  }

  get viewDistance(): number {
    return this.lodDistances[this.lodDistances.length - 1]!;
  }

  get chunkCount(): number {
    return this.chunks.size;
  }

  /** @param force build every missing nearby chunk now (first frame / teleport). */
  update(center: Vector3, force = false): void {
    if (force || !(Math.hypot(center.x - this.lastPlanX, center.z - this.lastPlanZ) < REPLAN_DISTANCE)) {
      this.plan(center);
      this.buildNearbySync();
    }
    this.integrateReady();
    if (this.workers.length === 0) this.buildSyncBudgeted();
  }

  private plan(center: Vector3): void {
    this.lastPlanX = center.x;
    this.lastPlanZ = center.z;
    const size = this.heightField.config.chunkSize;
    const maxDist = this.viewDistance;
    const ccx = Math.floor(center.x / size);
    const ccz = Math.floor(center.z / size);
    const r = Math.ceil(maxDist / size) + 1;
    const wanted = new Map<string, Wanted>();
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const cx = ccx + dx;
        const cz = ccz + dz;
        // Distance from the camera to the nearest point of the chunk.
        const nx = Math.max(cx * size, Math.min(center.x, (cx + 1) * size));
        const nz = Math.max(cz * size, Math.min(center.z, (cz + 1) * size));
        const dist = Math.hypot(nx - center.x, nz - center.z);
        const lod = this.lodDistances.findIndex((d) => dist <= d);
        if (lod >= 0) wanted.set(`${cx},${cz}`, { cx, cz, lod, dist });
      }
    }
    this.wanted = wanted;

    // Drop chunks that left the view; keep chunks with the wrong LOD until their replacement arrives.
    for (const [key, chunk] of this.chunks) {
      if (!wanted.has(key)) this.removeChunk(key, chunk);
    }
    this.queue = [...wanted.entries()]
      .filter(([key, w]) => this.chunks.get(key)?.lod !== w.lod && this.inFlight.get(key) !== w.lod)
      .sort((a, b) => a[1].dist - b[1].dist);
    this.pump();
  }

  /** Hand queued chunks to idle workers. */
  private pump(): void {
    for (let i = 0; i < this.workers.length && this.queue.length > 0; i++) {
      if (this.busy[i]) continue;
      const [key, w] = this.queue.shift()!;
      this.busy[i] = true;
      this.inFlight.set(key, w.lod);
      this.workers[i]!.postMessage({ key, cx: w.cx, cz: w.cz, lod: w.lod });
    }
  }

  private integrateReady(): void {
    const start = performance.now();
    while (this.ready.length > 0 && performance.now() - start < FRAME_BUDGET_MS) {
      const r = this.ready.shift()!;
      if (this.inFlight.get(r.key) === r.lod) this.inFlight.delete(r.key);
      const w = this.wanted.get(r.key);
      if (!w || w.lod !== r.lod) continue; // no longer needed at this LOD
      this.addChunk(r.key, r, r);
    }
  }

  /** The ground right around the camera must exist immediately (spawns, respawns). */
  private buildNearbySync(): void {
    for (const [key, w] of this.wanted) {
      if (w.dist > SYNC_DISTANCE || this.chunks.get(key)?.lod === w.lod) continue;
      this.addChunk(key, w, computeChunkArrays(w.cx, w.cz, w.lod, this.heightField.config, this.heightField.heightFn));
      this.queue = this.queue.filter(([k]) => k !== key);
    }
  }

  /** Fallback without workers: build a few chunks per frame. */
  private buildSyncBudgeted(): void {
    const start = performance.now();
    while (this.queue.length > 0 && performance.now() - start < FRAME_BUDGET_MS) {
      const [key, w] = this.queue.shift()!;
      this.addChunk(key, w, computeChunkArrays(w.cx, w.cz, w.lod, this.heightField.config, this.heightField.heightFn));
    }
  }

  private addChunk(key: string, w: { cx: number; cz: number; lod: number }, data: ChunkArrays): void {
    const old = this.chunks.get(key);
    const chunk = new TerrainChunk(w.cx, w.cz, w.lod, this.heightField.config, data, this.material);
    this.group.add(chunk.mesh);
    this.chunks.set(key, chunk);
    if (old) this.removeChunk(key, old, false);
  }

  private removeChunk(key: string, chunk: TerrainChunk, forget = true): void {
    this.group.remove(chunk.mesh);
    chunk.dispose();
    if (forget) this.chunks.delete(key);
  }

  /** Builds every wanted chunk synchronously (tests / tools). */
  buildAll(center: Vector3): void {
    this.plan(center);
    for (const [key, w] of this.queue) {
      this.addChunk(key, w, computeChunkArrays(w.cx, w.cz, w.lod, this.heightField.config, this.heightField.heightFn));
    }
    this.queue = [];
  }
}
