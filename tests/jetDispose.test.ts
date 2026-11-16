import { Group, Material, Mesh, type Object3D, type Texture } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFlightConfig } from '../src/config/flightConfig';
import { Jet } from '../src/entities/jet/Jet';
import { JET_CATALOG } from '../src/entities/jet/jetCatalog';
import { AIRacer } from '../src/game/AIRacer';
import { PuppetJet } from '../src/game/PuppetJet';

interface Disposable {
  dispose(): void;
  addEventListener(type: 'dispose', listener: () => void): void;
}

/** Every geometry, material and texture used under `root`. */
function resourcesOf(root: Object3D, extraMaterials: readonly Material[] = []): Set<Disposable> {
  const set = new Set<Disposable>();
  const addMaterial = (m: Material): void => {
    set.add(m as unknown as Disposable);
    for (const v of Object.values(m)) if ((v as Texture | null)?.isTexture) set.add(v as Disposable);
  };
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (mesh.geometry) set.add(mesh.geometry as unknown as Disposable);
    if (mesh.material) for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) addMaterial(m);
  });
  extraMaterials.forEach(addMaterial);
  return set;
}

/** Counts live resources: registered when created, released on their 'dispose' event (counted once). */
class ResourceLedger {
  readonly live = new Set<Disposable>();
  readonly disposeCalls = new Map<Disposable, number>();
  private readonly seen = new Set<Disposable>();

  track(resources: Iterable<Disposable>): void {
    for (const r of resources) {
      if (this.seen.has(r)) continue;
      this.seen.add(r);
      this.live.add(r);
      r.addEventListener('dispose', () => {
        this.live.delete(r);
        this.disposeCalls.set(r, (this.disposeCalls.get(r) ?? 0) + 1);
      });
    }
  }
}

const def = JET_CATALOG[0]!;
const newJet = (loadGltf = false): Jet => new Jet(def, createFlightConfig(def.flight), loadGltf);

beforeAll(() => {
  // Minimal 2D canvas so the camo and nav-light glow CanvasTextures exist in Node.
  const ctx: unknown = new Proxy(function () {}, { get: () => ctx, apply: () => ctx, set: () => true });
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) });
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('jet resource ownership', { timeout: 60_000 }, () => {
  it('Jet.dispose frees everything it owns once, but not the shared glow texture / sprite geometry', () => {
    const parent = new Group();
    const jet = newJet();
    parent.add(jet.object);
    const ledger = new ResourceLedger();
    const owned = resourcesOf(jet.object, jet.parts.materials);
    ledger.track(owned);
    expect([...owned].some((r) => (r as unknown as Texture).isTexture)).toBe(true);

    jet.dispose();
    jet.dispose();
    expect(jet.object.parent).toBeNull();
    const shared = [...ledger.live];
    // The nav-light glow texture and three's shared sprite quad.
    expect(shared).toHaveLength(2);
    for (const calls of ledger.disposeCalls.values()) expect(calls).toBe(1);

    // Another jet still alive keeps working resources (nothing it uses was disposed).
    const other = newJet();
    const otherLedger = new ResourceLedger();
    otherLedger.track(resourcesOf(other.object, other.parts.materials));
    const third = newJet();
    third.dispose();
    expect(otherLedger.disposeCalls.size).toBe(0);
    other.dispose();
  });

  it('PuppetJet frees its see-through clones and the jet; AIRacer frees its jet', () => {
    const parent = new Group();
    const ledger = new ResourceLedger();
    const ghost = new PuppetJet(def, parent, 0.35);
    ledger.track(resourcesOf(ghost.jet.object, ghost.jet.parts.materials));
    const ai = new AIRacer('AI', def, 0.8, 5, 1, 1, parent);
    ledger.track(resourcesOf(ai.jet.object, ai.jet.parts.materials));
    expect(parent.children).toHaveLength(2);

    ghost.dispose(parent);
    ghost.dispose(parent);
    ai.dispose(parent);
    ai.dispose(parent);
    expect(parent.children).toHaveLength(0);
    expect(ledger.live.size).toBe(2);
    for (const calls of ledger.disposeCalls.values()) expect(calls).toBe(1);
  });

  it('PuppetJet frees both the jet-owned originals and its clones', () => {
    const spy = vi.spyOn(Material.prototype, 'dispose');
    const plain = newJet();
    plain.dispose();
    const owned = new Set(spy.mock.contexts).size;
    spy.mockClear();
    const ghost = new PuppetJet(def, new Group(), 0.35);
    const clones = new Set<Material>();
    ghost.jet.object.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh) for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) clones.add(m);
    });
    ghost.dispose();
    expect(new Set(spy.mock.contexts).size).toBe(owned + clones.size);
    spy.mockRestore();
  });

  it('repeated create / dispose cycles return to the same baseline (no growth)', () => {
    const parent = new Group();
    const ledger = new ResourceLedger();
    const cycle = (): void => {
      const jets = [newJet(), newJet()];
      const ghost = new PuppetJet(JET_CATALOG[1 % JET_CATALOG.length]!, parent, 0.35);
      const ai = new AIRacer('AI', def, 0.8, 5, 1, 1, parent);
      for (const j of jets) ledger.track(resourcesOf(j.object, j.parts.materials));
      ledger.track(resourcesOf(ghost.jet.object, ghost.jet.parts.materials));
      ledger.track(resourcesOf(ai.jet.object, ai.jet.parts.materials));
      jets.forEach((j) => j.dispose());
      ghost.dispose();
      ai.dispose();
    };
    const baseline: number[] = [];
    for (let k = 0; k < 10; k++) {
      cycle();
      baseline.push(ledger.live.size);
    }
    expect(new Set(baseline)).toEqual(new Set([2]));
    expect(parent.children).toHaveLength(0);
  });
});

describe('late glTF loads', () => {
  function stubModelLoad(): { release: () => void; scene: Group } {
    const scene = new Group();
    scene.add(new Mesh());
    let release!: () => void;
    const loaded = new Promise<void>((r) => (release = r));
    vi.stubGlobal('fetch', async () => ({ ok: true, headers: new Map([['content-type', 'model/gltf-binary']]) }));
    vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockImplementation(async () => {
      await loaded;
      return { scene } as never;
    });
    return { release, scene };
  }
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('attaches the model to a live jet and frees it with the jet', async () => {
    const { release, scene } = stubModelLoad();
    const jet = newJet(true);
    release();
    await settle();
    expect(scene.parent).toBe(jet.object);
    expect(jet.parts.root.visible).toBe(false);
    const ledger = new ResourceLedger();
    ledger.track(resourcesOf(scene));
    jet.dispose();
    expect(ledger.live.size).toBe(0);
  });

  it('drops (and frees) a model that finishes loading after the jet was disposed', async () => {
    const { release, scene } = stubModelLoad();
    const ledger = new ResourceLedger();
    ledger.track(resourcesOf(scene));
    const jet = newJet(true);
    await settle();
    jet.dispose();
    release();
    await settle();
    expect(scene.parent).toBeNull();
    expect(jet.object.children).not.toContain(scene);
    expect(ledger.live.size).toBe(0);
  });
});
