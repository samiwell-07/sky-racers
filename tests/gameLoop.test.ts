import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameLoop } from '../src/core/GameLoop';

afterEach(() => vi.unstubAllGlobals());

describe('GameLoop', () => {
  it('does not catch up the time spent while the page was hidden', () => {
    let frame: FrameRequestCallback | null = null;
    let clock = 1000;
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('document', doc);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => ((frame = cb), 1));
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    vi.stubGlobal('performance', { now: () => clock });

    let steps = 0;
    const frameDts: number[] = [];
    const loop = new GameLoop(() => steps++, (_a, dt) => frameDts.push(dt), 1 / 128, 0.1);
    loop.start();
    frame!(1062.5);
    expect(steps).toBe(8);

    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    clock = 60_000;
    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    steps = 0;
    frame!(60_015.625);
    expect(frameDts.at(-1)).toBeCloseTo(0.015625);
    expect(steps).toBe(2);
    loop.stop();
  });
});
