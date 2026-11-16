import { describe, expect, it } from 'vitest';
import { avoid, formatTurnCue, gateSequence, nextTurnCue, placeIndicator, trackRect, type IndicatorBox, type ScreenSpec } from '../src/ui/navMath';

const W = 1000;
const H = 600;
const box: IndicatorBox = { w: 100, h: 40, anchorY: 10 };
const screen = (obstacles: ScreenSpec['obstacles'] = []): ScreenSpec => ({ width: W, height: H, safe: { left: 10, top: 10, right: W - 10, bottom: H - 10 }, obstacles });
// 90° vertical FOV: sy = 1, sx = 1 / aspect.
const sy = 1;
const sx = H / W;
const track = trackRect(screen().safe, box);

describe('placeIndicator', () => {
  it('marks a gate in view at its projected position', () => {
    const p = placeIndicator({ x: 0, y: 0, z: -500 }, sx, sy, screen(), box);
    expect(p).toEqual({ kind: 'onscreen', x: W / 2, y: H / 2 });
    const q = placeIndicator({ x: 100, y: 50, z: -500 }, sx, sy, screen(), box);
    expect(q.kind).toBe('onscreen');
    expect(q.x).toBeCloseTo(W / 2 + (sx * 0.2 * W) / 2);
    expect(q.y).toBeCloseTo(H / 2 - (0.1 * H) / 2);
  });

  it('clamps an off-screen gate to the edge it lies beyond, pointing at it', () => {
    const p = placeIndicator({ x: 2000, y: 0, z: -100 }, sx, sy, screen(), box);
    expect(p.kind).toBe('edge');
    expect(p.x).toBeCloseTo(track.right);
    expect(p.y).toBeCloseTo(H / 2);
    if (p.kind === 'edge') expect(p.angle).toBeCloseTo(0);
    const up = placeIndicator({ x: 0, y: 900, z: -100 }, sx, sy, screen(), box);
    expect(up.kind).toBe('edge');
    expect(up.y).toBeCloseTo(track.top);
    if (up.kind === 'edge') expect(up.angle).toBeCloseTo(-Math.PI / 2);
  });

  it('pins a gate behind the camera to the bottom edge on the side to turn to, never mirrored', () => {
    const left = placeIndicator({ x: -50, y: 300, z: 400 }, sx, sy, screen(), box);
    expect(left).toMatchObject({ kind: 'behind', side: -1 });
    expect(left.y).toBeCloseTo(track.bottom);
    expect(left.x).toBeLessThan(W / 2);
    const right = placeIndicator({ x: 50, y: -300, z: 10 }, sx, sy, screen(), box);
    expect(right).toMatchObject({ kind: 'behind', side: 1 });
    expect(right.y).toBeCloseTo(track.bottom);
    expect(right.x).toBeGreaterThan(W / 2);
  });

  it('keeps the indicator off HUD panels', () => {
    const racePanel = { left: W - 250, top: 0, right: W, bottom: 400 };
    const p = placeIndicator({ x: 2000, y: 0, z: -100 }, sx, sy, screen([racePanel]), box);
    expect(p.kind).toBe('edge');
    const b = { left: p.x - box.w / 2, top: p.y - box.anchorY, right: p.x + box.w / 2, bottom: p.y - box.anchorY + box.h };
    expect(b.top >= racePanel.bottom || b.right <= racePanel.left).toBe(true);
    // A visible gate hidden under the instruments is shown as an edge arrow instead.
    const instruments = { left: 0, top: 300, right: 400, bottom: H };
    expect(placeIndicator({ x: -150, y: -100, z: -500 }, sx, sy, screen([instruments]), box).kind).toBe('edge');
  });

  it('slides to the nearest free spot along the edge', () => {
    const q = avoid({ x: track.right, y: 300 }, track, box, [{ left: 800, top: 250, right: W, bottom: 350 }]);
    expect(q.x).toBe(track.right);
    expect(Math.abs(q.y - 300)).toBeLessThanOrEqual(70);
  });
});

describe('gateSequence', () => {
  it('wraps to the first gate of the next lap on a loop', () => {
    expect(gateSequence(10, 9, 1, 2, true)).toEqual({ next: 9, after: 0, prev: 8, final: false, lapWrap: true });
    expect(gateSequence(10, 0, 2, 2, true)).toMatchObject({ next: 0, prev: 9, after: 1 });
    expect(gateSequence(10, 0, 1, 2, true).prev).toBeNull();
  });

  it('flags the final gate of the race', () => {
    expect(gateSequence(10, 9, 2, 2, true)).toMatchObject({ next: 9, after: null, final: true, lapWrap: false });
    expect(gateSequence(10, 9, 1, 1, false)).toMatchObject({ after: null, final: true });
    expect(gateSequence(10, 4, 1, 1, false)).toMatchObject({ after: 5, final: false });
  });
});

describe('nextTurnCue', () => {
  const o = { x: 0, y: 0, z: 0 };
  const g = { x: 0, y: 0, z: -100 };
  it('reads left, right, climb and descent from the following segment', () => {
    const right = nextTurnCue(o, g, { x: 100, y: 0, z: -200 });
    expect(right.kind).toBe('right');
    expect(right.turn).toBeCloseTo(45);
    expect(formatTurnCue(right)).toBe('NEXT RIGHT 45° ▶');
    expect(nextTurnCue(o, g, { x: -100, y: 0, z: -100 })).toMatchObject({ kind: 'left', turn: -90 });
    expect(nextTurnCue(o, g, { x: 0, y: 30, z: -200 }).kind).toBe('climb');
    expect(nextTurnCue(o, g, { x: 0, y: -30, z: -200 }).kind).toBe('descend');
    expect(nextTurnCue(o, g, { x: 2, y: 0, z: -200 }).kind).toBe('straight');
  });
});
