import { Quaternion } from 'three';

export type Vec3Tuple = [number, number, number];
export type QuatTuple = [number, number, number, number];

export interface Snapshot {
  time: number;
  position: Vec3Tuple;
  quaternion: QuatTuple;
  throttle: number;
  afterburner: boolean;
}

export interface SnapshotBufferOptions {
  /** Render this many ms behind the latest receive time. */
  delayMs?: number;
  /** Max ms to extrapolate past the newest snapshot. */
  maxExtrapolationMs?: number;
  /** Drop snapshots older than this relative to the newest. */
  maxAgeMs?: number;
  maxEntries?: number;
}

const qa = new Quaternion();
const qb = new Quaternion();

function createSnapshot(): Snapshot {
  return { time: 0, position: [0, 0, 0], quaternion: [0, 0, 0, 1], throttle: 0, afterburner: false };
}

function copyInto(out: Snapshot, s: Snapshot): Snapshot {
  out.time = s.time;
  out.position[0] = s.position[0];
  out.position[1] = s.position[1];
  out.position[2] = s.position[2];
  out.quaternion[0] = s.quaternion[0];
  out.quaternion[1] = s.quaternion[1];
  out.quaternion[2] = s.quaternion[2];
  out.quaternion[3] = s.quaternion[3];
  out.throttle = s.throttle;
  out.afterburner = s.afterburner;
  return out;
}

export class SnapshotBuffer {
  readonly delayMs: number;
  readonly maxExtrapolationMs: number;
  readonly maxAgeMs: number;
  readonly maxEntries: number;
  private readonly entries: Snapshot[] = [];

  constructor(options: SnapshotBufferOptions = {}) {
    this.delayMs = options.delayMs ?? 120;
    this.maxExtrapolationMs = options.maxExtrapolationMs ?? 150;
    this.maxAgeMs = options.maxAgeMs ?? 1000;
    this.maxEntries = options.maxEntries ?? 64;
  }

  get size(): number {
    return this.entries.length;
  }

  get latest(): Snapshot | undefined {
    return this.entries[this.entries.length - 1];
  }

  clear(): void {
    this.entries.length = 0;
  }

  push(s: Snapshot): void {
    const snap = copyInto(createSnapshot(), s);
    const last = this.latest;
    if (last && snap.time < last.time) {
      // Out-of-order: insert sorted.
      let i = this.entries.length - 1;
      while (i >= 0 && this.entries[i].time > snap.time) i--;
      this.entries.splice(i + 1, 0, snap);
    } else {
      this.entries.push(snap);
    }
    this.prune();
  }

  private prune(): void {
    const newest = this.latest;
    if (!newest) return;
    const cutoff = newest.time - this.maxAgeMs;
    let drop = 0;
    // Keep at least two entries for interpolation.
    while (drop < this.entries.length - 2 && this.entries[drop + 1].time <= cutoff) drop++;
    if (this.entries.length - drop > this.maxEntries) drop = this.entries.length - this.maxEntries;
    if (drop > 0) this.entries.splice(0, drop);
  }

  /** Interpolated snapshot for `now` (already includes the interpolation delay). */
  sample(now: number, out: Snapshot = createSnapshot()): Snapshot | null {
    const n = this.entries.length;
    if (n === 0) return null;
    const renderTime = now - this.delayMs;
    const first = this.entries[0];
    if (n === 1 || renderTime <= first.time) {
      copyInto(out, first);
      out.time = renderTime;
      return out;
    }

    let a: Snapshot;
    let b: Snapshot;
    const last = this.entries[n - 1];
    let target = renderTime;
    if (renderTime >= last.time) {
      a = this.entries[n - 2];
      b = last;
      target = Math.min(renderTime, last.time + this.maxExtrapolationMs);
    } else {
      let i = n - 2;
      while (i > 0 && this.entries[i].time > renderTime) i--;
      a = this.entries[i];
      b = this.entries[i + 1];
    }

    const span = b.time - a.time;
    const t = span > 0 ? (target - a.time) / span : 1;
    for (let k = 0; k < 3; k++) out.position[k] = a.position[k] + (b.position[k] - a.position[k]) * t;
    qa.fromArray(a.quaternion);
    qb.fromArray(b.quaternion);
    if (t <= 1) {
      qa.slerp(qb, Math.max(0, t));
    } else {
      // Extrapolate rotation: keep the newest orientation (safer than over-rotating).
      qa.copy(qb);
    }
    qa.normalize();
    out.quaternion[0] = qa.x;
    out.quaternion[1] = qa.y;
    out.quaternion[2] = qa.z;
    out.quaternion[3] = qa.w;
    const tc = Math.min(1, Math.max(0, t));
    out.throttle = a.throttle + (b.throttle - a.throttle) * tc;
    out.afterburner = tc < 0.5 ? a.afterburner : b.afterburner;
    out.time = renderTime;
    return out;
  }
}
