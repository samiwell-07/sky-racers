import { describe, expect, it } from 'vitest';
import { SnapshotBuffer, type Snapshot } from '../src/net/SnapshotBuffer';

const SQRT1_2 = Math.SQRT1_2;

function snap(time: number, x: number, quaternion: Snapshot['quaternion'] = [0, 0, 0, 1]): Snapshot {
  return { time, position: [x, 0, 0], quaternion, velocity: [x * 2, 0, -x], throttle: x / 100, afterburner: x >= 50 };
}

describe('SnapshotBuffer', () => {
  it('returns null when empty', () => {
    expect(new SnapshotBuffer().sample(1000)).toBeNull();
  });

  it('interpolates position and slerps rotation at now - delay', () => {
    const buf = new SnapshotBuffer({ delayMs: 100 });
    buf.push(snap(0, 0, [0, 0, 0, 1]));
    buf.push(snap(100, 100, [0, SQRT1_2, 0, SQRT1_2])); // 90° about Y
    const s = buf.sample(150)!; // render time 50 → halfway
    expect(s.position[0]).toBeCloseTo(50);
    expect(s.throttle).toBeCloseTo(0.5);
    expect(s.velocity[0]).toBeCloseTo(100);
    expect(s.velocity[2]).toBeCloseTo(-50);
    const half = Math.sin(Math.PI / 8);
    expect(s.quaternion[1]).toBeCloseTo(half);
    expect(s.quaternion[3]).toBeCloseTo(Math.cos(Math.PI / 8));
  });

  it('holds the oldest snapshot before the buffer start', () => {
    const buf = new SnapshotBuffer({ delayMs: 120 });
    buf.push(snap(1000, 10));
    buf.push(snap(1050, 20));
    expect(buf.sample(1000)!.position[0]).toBe(10);
  });

  it('extrapolates past the newest snapshot only up to the cap', () => {
    const buf = new SnapshotBuffer({ delayMs: 0, maxExtrapolationMs: 50 });
    buf.push(snap(0, 0));
    buf.push(snap(100, 100));
    expect(buf.sample(130)!.position[0]).toBeCloseTo(130);
    expect(buf.sample(1000)!.position[0]).toBeCloseTo(150);
    expect(buf.sample(1000)!.velocity[0]).toBeCloseTo(200); // newest velocity, not extrapolated
  });

  it('handles out-of-order snapshots', () => {
    const buf = new SnapshotBuffer({ delayMs: 0 });
    buf.push(snap(0, 0));
    buf.push(snap(200, 200));
    buf.push(snap(100, 100));
    expect(buf.sample(150)!.position[0]).toBeCloseTo(150);
  });

  it('drops entries older than maxAge but keeps two', () => {
    const buf = new SnapshotBuffer({ maxAgeMs: 500 });
    for (let t = 0; t <= 2000; t += 50) buf.push(snap(t, t / 100));
    expect(buf.size).toBeLessThanOrEqual(12);
    expect(buf.size).toBeGreaterThanOrEqual(2);

    const sparse = new SnapshotBuffer({ maxAgeMs: 100 });
    sparse.push(snap(0, 0));
    sparse.push(snap(5000, 1));
    expect(sparse.size).toBe(2);
  });
});
