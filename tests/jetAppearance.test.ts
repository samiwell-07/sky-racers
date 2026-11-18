import { ClampToEdgeWrapping, DataTexture, Mesh, MeshStandardMaterial } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { disposeObject3D } from '../src/entities/jet/disposeObject';
import { FACTORY_APPEARANCE, loadJetAppearance, onJetAppearanceSaved, parseJetAppearance, sameJetAppearance, saveJetAppearance, type JetAppearance } from '../src/entities/jet/jetAppearance';
import { buildJetModel } from '../src/entities/jet/JetModel';

const custom: JetAppearance = { wrap: 'woodland', finish: 'gloss', canopy: 'blue', raceNumber: '07' };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('saved jet appearance', () => {
  it('round-trips per jet, preserving leading zeros, and recovers from corrupt or blocked storage', () => {
    const data = new Map<string, string>();
    const saved = vi.fn();
    const unsubscribe = onJetAppearanceSaved(saved);
    vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v) });
    expect(saveJetAppearance('falcon', custom)).toBe(true);
    expect(saveJetAppearance('viper', { ...custom, raceNumber: '1' })).toBe(true);
    expect(sameJetAppearance(loadJetAppearance('falcon'), custom)).toBe(true);
    expect(sameJetAppearance(loadJetAppearance('viper'), custom)).toBe(false);
    expect(loadJetAppearance('raptor')).toEqual(FACTORY_APPEARANCE);
    expect(saveJetAppearance('falcon', { ...custom, raceNumber: 'foo' })).toBe(false);
    expect(loadJetAppearance('falcon')).toEqual(custom);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('localStorage', { getItem: () => '{', setItem: () => { throw new Error('quota'); } });
    expect(loadJetAppearance('viper')).toEqual(FACTORY_APPEARANCE);
    expect(saveJetAppearance('viper', custom)).toBe(false);
    expect(saved).toHaveBeenCalledTimes(2);
    unsubscribe();
    vi.stubGlobal('localStorage', { setItem: () => {} });
    expect(saveJetAppearance('falcon', custom)).toBe(true);
    expect(saved).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid fields without coercion or truncation', () => {
    for (const raceNumber of ['１２', '3\n', '-3', '100', 3, null]) {
      expect(parseJetAppearance({ ...custom, raceNumber })).toBeNull();
    }
    for (const patch of [{ wrap: 'other' }, { finish: 'chrome' }, { canopy: 'pink' }]) {
      expect(parseJetAppearance({ ...custom, ...patch })).toBeNull();
    }
  });
});

describe('headless livery', () => {
  it('uses four distinct surface patterns, independently of paint color', () => {
    const patterns = new Set<string>();
    for (const wrap of ['factory', 'woodland', 'splinter', 'tactical'] as const) {
      const { root } = buildJetModel(undefined, 'falcon', { ...custom, wrap });
      try {
        const { material } = root.getObjectByName('wing-right') as Mesh;
        const map = (material as MeshStandardMaterial).map as DataTexture;
        const { data } = map.image;
        if (!data) throw new Error('Missing headless wrap pixels');
        // Compare spatial patterns, not their palettes: mark every texel matching the first.
        const mask = [];
        for (let i = 0; i < data.length; i += 4) mask.push(Number(data[i] === data[0]));
        expect(mask).toContain(0);
        patterns.add(mask.join(''));
      } finally { disposeObject3D(root); }
    }
    expect(patterns.size).toBe(4);
  });

  it('changes paint roughness and glass, and uses an owned, untiled two-sided fin marking', () => {
    const stock = buildJetModel();
    const parts = buildJetModel(undefined, 'falcon', custom);
    const materialOf = (mesh: Mesh) => mesh.material as MeshStandardMaterial;
    expect(materialOf(parts.canopy).color.getHex()).not.toBe(materialOf(stock.canopy).color.getHex());
    const wing = (p: typeof parts) => materialOf(p.root.getObjectByName('wing-right') as Mesh);
    expect(wing(parts).roughness).toBeLessThan(wing(stock).roughness);
    expect(stock.root.getObjectByName('race-number-left')).toBeUndefined();
    const face = parts.root.getObjectByName('race-number-left') as Mesh;
    const number = materialOf(face).map!;
    expect(face.parent!.name).toBe('fin-0');
    expect(face.rotation.y).toBe(-Math.PI / 2);
    expect(parts.root.getObjectByName('race-number-right')!.rotation.y).toBe(Math.PI / 2);
    expect(number).not.toBe(wing(parts).map);
    expect([number.wrapS, number.wrapT]).toEqual([ClampToEdgeWrapping, ClampToEdgeWrapping]);
    expect(parts.textures).toContain(number);
    expect(parts.materials).toContain(face.material);
    const spies = [number, face.geometry, materialOf(face)].map(resource => vi.spyOn(resource, 'dispose'));
    disposeObject3D(stock.root);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    disposeObject3D(parts.root);
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  });
});
