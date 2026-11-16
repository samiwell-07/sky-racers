import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../src/audio/AudioEngine';
import {
  JET_TIMBRES,
  approach,
  assignVoices,
  channelGains,
  closingSpeed,
  distanceGain,
  dopplerRatio,
  duckGain,
  getJetTimbre,
  selectNearest,
  sliderToGain,
  stereoPan,
} from '../src/audio/audioMath';

const src = (key: string, x: number) => ({ key, position: { x, y: 0, z: 0 } });
const O = { x: 0, y: 0, z: 0 };

describe('jet timbres', () => {
  it('viper is higher-pitched and raptor deeper/heavier than falcon', () => {
    const { falcon, viper, raptor } = JET_TIMBRES;
    expect(viper!.whineBase).toBeGreaterThan(falcon!.whineBase);
    expect(raptor!.whineBase).toBeLessThan(falcon!.whineBase);
    expect(raptor!.roarGain).toBeGreaterThan(falcon!.roarGain);
    expect(raptor!.abCutoff).toBeLessThan(falcon!.abCutoff);
    expect(viper!.roarGain).toBeLessThan(falcon!.roarGain);
  });
  it('unknown jets fall back to falcon', () => {
    expect(getJetTimbre('nope')).toBe(JET_TIMBRES.falcon);
  });
});

describe('mixer', () => {
  it('master 0 or a channel at 0 silences it; others unaffected', () => {
    const c = channelGains({ master: 1, engine: 0, effects: 1, warnings: 1 }, 0);
    expect(c.engine).toBe(0);
    expect(c.effects).toBe(1);
    expect(c.warnings).toBe(1);
    expect(channelGains({ master: 0, engine: 1, effects: 1, warnings: 1 }, 0).master).toBe(0);
  });
  it('slider mapping is monotonic and clamped', () => {
    expect(sliderToGain(-1)).toBe(0);
    expect(sliderToGain(2)).toBe(1);
    expect(sliderToGain(0.5)).toBeLessThan(sliderToGain(0.6));
    expect(sliderToGain(NaN)).toBe(0);
  });
  it('warnings duck engine and effects but never themselves', () => {
    const c = channelGains({ master: 1, engine: 1, effects: 1, warnings: 1 }, 1);
    expect(c.engine).toBeCloseTo(duckGain(1, 1));
    expect(c.engine).toBeLessThan(0.6);
    expect(c.engine).toBeGreaterThan(0.2);
    expect(c.effects).toBe(c.engine);
    expect(c.warnings).toBe(1);
    expect(duckGain(0.5, 1)).toBeGreaterThan(duckGain(1, 1));
  });
  it('a muted warnings channel does not duck', () => {
    expect(duckGain(1, 0)).toBe(1);
  });
});

describe('approach', () => {
  it('is frame-rate independent and does not jump', () => {
    let a = 0;
    for (let i = 0; i < 10; i++) a = approach(a, 1, 0.01, 0.2);
    expect(approach(0, 1, 0.1, 0.2)).toBeCloseTo(a, 10);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(0.5);
    expect(approach(0.3, 1, 0, 0.2)).toBe(0.3);
  });
});

describe('flyby helpers', () => {
  it('selects the nearest N within range, nearest first', () => {
    const s = [src('a', 500), src('b', 50), src('c', 2000), src('d', 100), src('e', 300)];
    expect(selectNearest(s, O, 3, 900).map((x) => x.key)).toEqual(['b', 'd', 'e']);
    expect(selectNearest([src('far', 5000)], O, 3, 900)).toEqual([]);
  });
  it('keeps voices stable, reuses released slots, never grows', () => {
    let slots: (string | null)[] = [null, null, null];
    slots = assignVoices(slots, ['a', 'b']);
    expect(slots).toEqual(['a', 'b', null]);
    slots = assignVoices(slots, ['c', 'b', 'd', 'e']);
    expect(slots).toEqual(['c', 'b', 'd']);
    slots = assignVoices(slots, []);
    expect(slots).toEqual([null, null, null]);
  });
  it('attenuates with distance and is silent beyond max', () => {
    expect(distanceGain(10)).toBe(1);
    expect(distanceGain(200)).toBeLessThan(distanceGain(100));
    expect(distanceGain(900)).toBe(0);
    expect(distanceGain(899)).toBeLessThan(0.01);
  });
  it('raises pitch when approaching, lowers when receding, bounded', () => {
    const closing = closingSpeed({ x: 100, y: 0, z: 0 }, { x: -150, y: 0, z: 0 }, O, O);
    expect(closing).toBeCloseTo(150);
    expect(dopplerRatio(closing)).toBeGreaterThan(1);
    expect(dopplerRatio(-150)).toBeLessThan(1);
    expect(dopplerRatio(1e6)).toBeLessThanOrEqual(1.6);
    expect(dopplerRatio(-1e6)).toBeGreaterThanOrEqual(0.6);
  });
  it('pans toward the side of the source', () => {
    const right = { x: 1, y: 0, z: 0 };
    expect(stereoPan({ x: 50, y: 0, z: 0 }, O, right)).toBeGreaterThan(0.5);
    expect(stereoPan({ x: -50, y: 0, z: 0 }, O, right)).toBeLessThan(-0.5);
    expect(stereoPan({ x: 0, y: 0, z: -50 }, O, right)).toBeCloseTo(0);
  });
});

describe('AudioEngine in Node', () => {
  it('is a no-op without Web Audio', () => {
    const a = new AudioEngine();
    a.resume();
    a.setMixer({ master: 0, engine: 1, effects: 1, warnings: 1 });
    a.setJet('raptor');
    a.update({ throttle: 1, afterburner: true, speed: 200, gLoad: 1, stallWarning: true, pullUp: true, agl: 10 }, 0.016);
    a.updateFlybys([{ key: 'ai:0', position: O, velocity: null, throttle: 1, jetId: 'viper' }], { position: O, right: { x: 1, y: 0, z: 0 }, velocity: O });
    a.playCrash();
    expect(a.stats).toEqual({ voices: 0, activeVoices: 0, oneShots: 0, tracked: 0 });
    a.dispose();
  });
});
