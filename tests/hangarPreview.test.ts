import { Box3, BufferGeometry, Group, Material, Mesh, MeshStandardMaterial, BoxGeometry, Vector3 } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HangarPreview } from '../src/ui/HangarPreview';
import { tryLoadGltfJet } from '../src/entities/jet/gltfJet';
import { FACTORY_APPEARANCE, saveJetAppearance } from '../src/entities/jet/jetAppearance';
import { JET_CATALOG } from '../src/entities/jet/jetCatalog';
import { buildJetModel } from '../src/entities/jet/JetModel';

const rendererState = vi.hoisted(() => ({ fail: false }));

vi.mock('three', async (original) => {
  const actual = await original<typeof import('three')>();
  return {
    ...actual,
    WebGLRenderer: class {
      constructor() {
        if (rendererState.fail) throw new Error('WebGL unavailable');
      }
      shadowMap = {};
      renderLists = { dispose: vi.fn() };
      setPixelRatio = vi.fn();
      setSize = vi.fn();
      render = vi.fn();
    },
  };
});
vi.mock('../src/entities/jet/gltfJet', () => ({ tryLoadGltfJet: vi.fn(async () => null) }));
vi.mock('../src/entities/jet/JetModel', { spy: true });

class Canvas extends EventTarget {
  className = '';
  clientWidth = 1280;
  clientHeight = 800;
  width = 1280;
  height = 800;
  setAttribute = vi.fn();
  remove = vi.fn();
  getContext(): null { return null; }
}

beforeEach(() => {
  rendererState.fail = false;
  const doc = Object.assign(new EventTarget(), { hidden: false, createElement: () => new Canvas() });
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.mocked(tryLoadGltfJet).mockResolvedValue(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(tryLoadGltfJet).mockClear();
  vi.mocked(buildJetModel).mockClear();
});

describe('hangar model ownership', () => {
  it('loads each saved look, repaints only the draft bay and rejects a late factory GLB', async () => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v) });
    const custom = { ...FACTORY_APPEARANCE, raceNumber: '08' };
    const repaint = { ...FACTORY_APPEARANCE, finish: 'gloss' as const };
    const [factory, saved] = [JET_CATALOG[0]!, JET_CATALOG[1]!];
    expect(saveJetAppearance(saved.id, custom)).toBe(true);
    let release!: (model: Group) => void;
    vi.mocked(tryLoadGltfJet).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const preview = new HangarPreview();
    preview.attach({ appendChild: vi.fn() } as unknown as HTMLElement, 0);
    expect(vi.mocked(buildJetModel).mock.calls.map(([, id, a]) => [id, a])).toEqual(
      JET_CATALOG.map(j => [j.id, j.id === saved.id ? custom : FACTORY_APPEARANCE]));
    const loaderCalls = vi.mocked(tryLoadGltfJet).mock.calls;
    expect(loaderCalls.map(([id]) => id)).not.toContain(saved.id);
    const [,, oldHolder, oldSignal] = loaderCalls[0]!;
    vi.mocked(buildJetModel).mockClear();
    preview.previewAppearance(0, repaint);
    preview.previewAppearance(0, { ...repaint });
    expect(buildJetModel).toHaveBeenCalledExactlyOnceWith(factory.paint, factory.id, repaint);
    expect(oldSignal?.aborted).toBe(true);
    expect(oldHolder.parent).toBeNull();
    expect(loaderCalls).toHaveLength(JET_CATALOG.length - 1);
    const late = new Group();
    const mesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    late.add(mesh);
    oldHolder.add(late);
    const dispose = vi.spyOn(mesh.geometry, 'dispose');
    release(late);
    await Promise.resolve();
    expect(dispose).toHaveBeenCalledOnce();
    expect(late.parent).toBeNull();
    preview.previewAppearance(0, FACTORY_APPEARANCE);
    expect(loaderCalls.at(-1)?.[0]).toBe(factory.id);
    preview.detach();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('reports WebGL initialization failure without loading aircraft or attaching a broken canvas', () => {
    rendererState.fail = true;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const preview = new HangarPreview();
    const container = { appendChild: vi.fn() };
    preview.attach(container as unknown as HTMLElement);
    expect(container.appendChild).not.toHaveBeenCalled();
    expect(tryLoadGltfJet).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('Hangar renderer could not be initialized', expect.any(Error));
    expect(preview.available).toBe(false);
    preview.detach();
  });

  it('creates all five aircraft only once per visit and releases every owned resource once', () => {
    const geometries = vi.spyOn(BufferGeometry.prototype, 'dispose');
    const materials = vi.spyOn(Material.prototype, 'dispose');
    const preview = new HangarPreview();
    const container = { appendChild: vi.fn() } as unknown as HTMLElement;
    const counts: number[] = [];
    for (let visit = 0; visit < 3; visit++) {
      preview.attach(container, 0);
      for (let i = 0; i < 5; i++) preview.select(i);
      expect(tryLoadGltfJet).toHaveBeenCalledTimes((visit + 1) * 5);
      const before = geometries.mock.calls.length;
      preview.detach();
      counts.push(geometries.mock.calls.length - before);
      const after = geometries.mock.calls.length;
      preview.detach();
      expect(geometries.mock.calls.length).toBe(after);
    }
    expect(counts[0]).toBeGreaterThan(100);
    expect(new Set(counts).size).toBe(1);
    expect(new Set(geometries.mock.contexts).size).toBe(geometries.mock.calls.length);
    expect(new Set(materials.mock.contexts).size).toBe(materials.mock.calls.length);
  });

  it('frees a custom asset resolving after exit and does not retain it for the next visit', async () => {
    let release!: (model: Group) => void;
    vi.mocked(tryLoadGltfJet).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const preview = new HangarPreview();
    const container = { appendChild: vi.fn() } as unknown as HTMLElement;
    preview.attach(container);
    const model = new Group();
    const geometry = new BoxGeometry();
    const material = new MeshStandardMaterial();
    model.add(new Mesh(geometry, material));
    const disposedGeometry = vi.spyOn(geometry, 'dispose');
    const disposedMaterial = vi.spyOn(material, 'dispose');
    preview.detach();
    release(model);
    await Promise.resolve();
    expect(disposedGeometry).toHaveBeenCalledOnce();
    expect(disposedMaterial).toHaveBeenCalledOnce();
    expect(model.parent).toBeNull();
    preview.attach(container);
    preview.detach();
    expect(disposedGeometry).toHaveBeenCalledOnce();
  });

  it('centers and grounds an offset custom model in its own bay and disposes it on exit', async () => {
    const model = new Group();
    const mesh = new Mesh(new BoxGeometry(3, 4, 20), new MeshStandardMaterial());
    mesh.position.set(17, 9, 4);
    model.add(mesh);
    vi.mocked(tryLoadGltfJet).mockImplementation(async (_id, procedural, parent) => {
      if (parent.position.x !== 64) return null;
      procedural.visible = false;
      parent.add(model);
      return model;
    });
    const preview = new HangarPreview();
    preview.attach({ appendChild: vi.fn() } as unknown as HTMLElement, 2);
    await Promise.resolve();
    const bounds = new Box3().setFromObject(model);
    const center = bounds.getCenter(new Vector3());
    expect(center.x).toBeCloseTo(64);
    expect(center.z).toBeCloseTo(0);
    expect(bounds.min.y).toBeCloseTo(0.06);
    const dispose = vi.spyOn(mesh.geometry, 'dispose');
    preview.detach();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
