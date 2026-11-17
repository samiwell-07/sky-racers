import {
  ACESFilmicToneMapping,
  Box3,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  PerspectiveCamera,
  SRGBColorSpace,
  Scene,
  Texture,
  Vector3,
  WebGLRenderer,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three';
import { tryLoadGltfJet } from '../entities/jet/gltfJet';
import type { JetDefinition } from '../entities/jet/jetCatalog';
import { buildJetModel } from '../entities/jet/JetModel';

const FRAME_INTERVAL = 1000 / 30;
const MAX_PIXEL_RATIO = 1.5;

/** Disposes every geometry, material and texture under an object (preview-owned only). */
function disposeTree(root: Object3D): void {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    geometries.add(m.geometry);
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) materials.add(mat);
  });
  for (const g of geometries) g.dispose();
  for (const mat of materials) {
    for (const v of Object.values(mat)) if (v instanceof Texture) v.dispose();
    mat.dispose();
  }
}

/**
 * Small rotating 3D preview of a jet for the hangar screen. One WebGL renderer on its own small
 * canvas, created once and reused; renders at most ~30 fps and only while attached and the page
 * is visible. Models are disposed when the jet changes or the preview is detached.
 */
export class HangarPreview {
  readonly canvas: HTMLCanvasElement;
  private renderer: WebGLRenderer | null = null;
  private failed = false;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(28, 16 / 9, 1, 300);
  private model: Group | null = null;
  private jetId = '';
  private generation = 0;
  private raf = 0;
  private lastFrame = 0;
  private angle = 0.6;
  private dirty = true;
  private readonly resizeObserver: ResizeObserver | null;
  private readonly reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'hangar-canvas';
    this.canvas.setAttribute('role', 'img');
    this.scene.add(new HemisphereLight('#dfeeff', '#3a4a3c', 1.6));
    const sun = new DirectionalLight('#fff4e0', 2.4);
    sun.position.set(30, 40, 20);
    const rim = new DirectionalLight('#9fc8ff', 1.1);
    rim.position.set(-30, 10, -30);
    this.scene.add(sun, rim);
    this.camera.position.set(0, 8, 33);
    this.camera.lookAt(0, 0, 0);
    this.resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.resize()) : null;
  }

  /** WebGL works for the preview (false shows a text-only hangar). */
  get available(): boolean {
    return !this.failed;
  }

  /** GPU resource counts of the preview renderer (for leak checks). */
  get memory(): { geometries: number; textures: number; programs: number } {
    const r = this.renderer;
    return { geometries: r?.info.memory.geometries ?? 0, textures: r?.info.memory.textures ?? 0, programs: r?.info.programs?.length ?? 0 };
  }

  /** Puts the canvas into a container and starts rendering. */
  attach(container: HTMLElement): void {
    if (!this.ensureRenderer()) return;
    container.appendChild(this.canvas);
    this.resizeObserver?.observe(this.canvas);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.resize();
    this.start();
  }

  /** Stops rendering, frees the model and removes the canvas (the renderer is kept for reuse). */
  detach(): void {
    this.stop();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.resizeObserver?.unobserve(this.canvas);
    this.clearModel();
    this.jetId = '';
    this.canvas.remove();
    // Drop the last frame's GPU state references (render lists) while the screen is closed.
    this.renderer?.renderLists.dispose();
  }

  setJet(def: JetDefinition): void {
    this.canvas.setAttribute('aria-label', `3D preview of the ${def.name}`);
    if (def.id === this.jetId || this.failed) return;
    this.clearModel();
    this.jetId = def.id;
    const gen = ++this.generation;
    const holder = new Group();
    const parts = buildJetModel(def.paint, def.id);
    holder.add(parts.root);
    // Center the airframe so it spins around its middle.
    const box = new Box3().setFromObject(parts.root);
    const c = box.getCenter(new Vector3());
    parts.root.position.sub(c);
    this.model = holder;
    this.scene.add(holder);
    this.dirty = true;
    // Optional custom model (same rule as in flight); the procedural jet stays if it is missing.
    void tryLoadGltfJet(def.id, parts.root, parts.root.parent!).then((loaded) => {
      if (gen !== this.generation) disposeTree(holder);
      else if (loaded) this.dirty = true;
    });
  }

  private clearModel(): void {
    this.generation++;
    if (!this.model) return;
    this.scene.remove(this.model);
    disposeTree(this.model);
    this.model = null;
  }

  private ensureRenderer(): boolean {
    if (this.renderer) return true;
    if (this.failed) return false;
    try {
      const r = new WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, powerPreference: 'low-power', stencil: false });
      r.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
      r.outputColorSpace = SRGBColorSpace;
      r.toneMapping = ACESFilmicToneMapping;
      r.setClearColor(0x000000, 0);
      this.renderer = r;
      return true;
    } catch {
      this.failed = true;
      return false;
    }
  }

  private resize(): void {
    const r = this.renderer;
    if (!r) return;
    const w = Math.max(1, Math.round(this.canvas.clientWidth));
    const h = Math.max(1, Math.round(this.canvas.clientHeight));
    r.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    r.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Keep the whole jet in view on narrow (tall) canvases.
    this.camera.position.setLength(this.camera.aspect < 1.3 ? 34 * (1.3 / this.camera.aspect) ** 0.8 : 34);
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  private start(): void {
    if (this.raf || document.hidden) return;
    this.lastFrame = 0;
    this.raf = requestAnimationFrame(this.frame);
  }

  private stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private readonly onVisibility = (): void => {
    if (document.hidden) this.stop();
    else this.start();
  };

  private readonly frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const elapsed = now - this.lastFrame;
    if (this.lastFrame && elapsed < FRAME_INTERVAL) return;
    const dt = this.lastFrame ? Math.min(0.1, elapsed / 1000) : 0;
    this.lastFrame = now;
    if (!this.reducedMotion) {
      this.angle += dt * 0.45;
      this.dirty = true;
    }
    if (!this.dirty || !this.model || !this.renderer) return;
    this.model.rotation.y = this.angle;
    this.renderer.render(this.scene, this.camera);
    this.dirty = false;
  };
}
