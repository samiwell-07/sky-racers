import {
  ACESFilmicToneMapping, Box3, BoxGeometry, Color, DirectionalLight, Fog,
  Group, HemisphereLight, Mesh, MeshStandardMaterial, PCFShadowMap,
  PerspectiveCamera, Scene, SRGBColorSpace, Vector3, WebGLRenderer,
  type BufferGeometry, type Object3D,
} from 'three';
import { tryLoadGltfJet } from '../entities/jet/gltfJet';
import { JET_CATALOG } from '../entities/jet/jetCatalog';
import { FACTORY_APPEARANCE, loadJetAppearance, sameJetAppearance, type JetAppearance } from '../entities/jet/jetAppearance';
import { buildJetModel, type JetParts } from '../entities/jet/JetModel';
import { disposeObject3D } from '../entities/jet/disposeObject';
import { bayX, HANGAR_SPACING, HangarTour } from './HangarTour';

const FRAME_INTERVAL = 1000 / 30;
const MAX_PIXEL_RATIO = 1.5;

interface ParkedJet {
  holder: Group;
  parts: JetParts;
  appearance: JetAppearance;
  abort: AbortController;
  custom?: Object3D;
}

/** Menu-owned presentation: one reusable renderer, no flight simulation or flight camera. */
export class HangarPreview {
  readonly canvas = document.createElement('canvas');
  private renderer: WebGLRenderer | null = null;
  private failed = false;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(48, 16 / 9, 0.3, 400);
  private readonly tour = new HangarTour(JET_CATALOG.length);
  private readonly environment = new Group();
  private readonly models = new Group();
  private readonly bays: ParkedJet[] = [];
  private readonly highlights: MeshStandardMaterial[] = [];
  private readonly keyLight = new DirectionalLight('#fff0d6', 3.2);
  private raf = 0;
  private lastFrame = 0;
  private dirty = true;
  private selected = 0;
  private readonly resizeObserver: ResizeObserver | null;
  private readonly motion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

  constructor() {
    this.canvas.className = 'hangar-canvas';
    this.canvas.setAttribute('role', 'img');
    this.scene.background = new Color('#101d2d');
    this.scene.fog = new Fog('#101d2d', 85, 240);
    this.scene.add(new HemisphereLight('#c3e6ff', '#475365', 2.1));
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(1024, 1024);
    this.keyLight.shadow.camera.left = -23;
    this.keyLight.shadow.camera.right = 23;
    this.keyLight.shadow.camera.top = 24;
    this.keyLight.shadow.camera.bottom = -24;
    this.keyLight.shadow.normalBias = 0.07;
    this.scene.add(this.keyLight, this.keyLight.target, this.environment, this.models);
    this.resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.resize()) : null;
  }

  get available(): boolean { return !this.failed; }

  get memory(): { geometries: number; textures: number; programs: number } {
    const r = this.renderer;
    return { geometries: r?.info.memory.geometries ?? 0, textures: r?.info.memory.textures ?? 0, programs: r?.info.programs?.length ?? 0 };
  }

  attach(container: HTMLElement, initialIndex = 0): void {
    if (!this.ensureRenderer()) return;
    container.appendChild(this.canvas);
    this.scene.add(this.environment);
    this.buildEnvironment();
    JET_CATALOG.forEach((jet, i) => this.buildBay(i, loadJetAppearance(jet.id)));
    this.selected = initialIndex;
    this.resize();
    this.tour.enter(initialIndex, this.camera.aspect, this.reducedMotion);
    this.select(initialIndex);
    this.resizeObserver?.observe(this.canvas);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.motion?.addEventListener('change', this.onMotion);
    this.start();
  }

  detach(): void {
    this.stop();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.motion?.removeEventListener('change', this.onMotion);
    this.resizeObserver?.unobserve(this.canvas);
    for (const bay of this.bays) this.disposeBay(bay);
    this.bays.length = 0;
    disposeObject3D(this.environment);
    this.environment.clear();
    this.highlights.length = 0;
    this.canvas.remove();
    this.renderer?.renderLists.dispose();
  }

  select(index: number): void {
    this.selected = index;
    const def = JET_CATALOG[index]!;
    this.canvas.setAttribute('aria-label', `Hangar ${Math.floor(index / 2) + 1}, bay ${index % 2 + 1}: ${def.name}`);
    this.highlights.forEach((mat, i) => {
      mat.color.set(i === index ? '#f5c578' : '#396474');
      mat.emissive.set(i === index ? '#bf7624' : '#163343');
      mat.emissiveIntensity = i === index ? 1.2 : 0.5;
    });
    this.keyLight.position.set(bayX(index) - 8, 19, 10);
    this.keyLight.target.position.set(bayX(index), 0, 0);
    this.tour.select(index, this.reducedMotion);
    this.dirty = true;
  }

  private get reducedMotion(): boolean { return this.motion?.matches ?? false; }

  previewAppearance(index: number, appearance: JetAppearance): void {
    const bay = this.bays[index];
    if (!bay || sameJetAppearance(bay.appearance, appearance)) return;
    this.disposeBay(bay);
    this.buildBay(index, appearance);
    this.dirty = true;
  }

  private disposeBay({ abort, parts, custom, holder }: ParkedJet): void {
    abort.abort();
    holder.removeFromParent();
    if (custom) disposeObject3D(custom);
    const geometries = new Set<BufferGeometry>();
    parts.root.traverse((object) => {
      const mesh = object as Mesh;
      if (mesh.isMesh) geometries.add(mesh.geometry);
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of parts.materials) material.dispose();
    for (const texture of parts.textures) texture.dispose();
  }

  private buildBay(index: number, appearance: JetAppearance): void {
    const def = JET_CATALOG[index]!;
    const holder = new Group();
    holder.position.x = bayX(index);
    const parts = buildJetModel(def.paint, def.id, appearance);
    parts.root.rotation.y = Math.PI;
    holder.add(parts.root);
    this.ground(parts.root);
    this.models.add(holder);
    const bay: ParkedJet = { holder, parts, appearance: { ...appearance }, abort: new AbortController() };
    this.bays[index] = bay;
    // GLBs have their own baked materials and cannot represent a pilot's paint choices.
    if (!sameJetAppearance(appearance, FACTORY_APPEARANCE)) return;
    const { signal } = bay.abort;
    void tryLoadGltfJet(def.id, parts.root, holder, signal).then((custom) => {
      if (!custom) return;
      if (signal.aborted) {
        disposeObject3D(custom);
        return;
      }
      bay.custom = custom;
      custom.rotation.y += Math.PI;
      this.ground(custom);
      this.dirty = true;
    });
  }

  private ground(model: Object3D): void {
    model.updateWorldMatrix(true, true);
    const bounds = new Box3().setFromObject(model);
    const center = bounds.getCenter(new Vector3());
    const parentX = model.parent?.position.x ?? 0;
    model.position.x -= center.x - parentX;
    model.position.z -= center.z;
    model.position.y -= bounds.min.y - 0.06;
    model.updateMatrixWorld(true);
  }

  private buildEnvironment(): void {
    const concrete = new MeshStandardMaterial({ color: '#33434c', roughness: 0.82, metalness: 0.15 });
    const wall = new MeshStandardMaterial({ color: '#26394b', roughness: 0.7, metalness: 0.55 });
    const steel = new MeshStandardMaterial({ color: '#536777', roughness: 0.5, metalness: 0.8 });
    const lamp = new MeshStandardMaterial({ color: '#b5e7ff', emissive: '#8dd8ff', emissiveIntensity: 2 });
    const crate = new MeshStandardMaterial({ color: '#5d6252', roughness: 0.9 });
    const unit = new BoxGeometry(1, 1, 1);
    const box = (x: number, y: number, z: number, w: number, h: number, d: number, material: MeshStandardMaterial): Mesh => {
      const mesh = new Mesh(unit, material);
      mesh.position.set(x, y, z);
      mesh.scale.set(w, h, d);
      mesh.receiveShadow = true;
      this.environment.add(mesh);
      return mesh;
    };
    box(78, -0.3, 15, 225, 0.5, 112, concrete);
    for (let hangar = 0; hangar < 3; hangar++) {
      const x = hangar * HANGAR_SPACING + 13.5;
      box(x, 11, -18, 60, 22, 1, wall);
      box(x, 22, 7, 60, 0.7, 50, wall);
      // Side openings align with the inspection aisle (z=19..33).
      for (const side of [-30, 30]) {
        box(x + side, 11, -1, 0.7, 22, 34, wall);
        box(x + side, 18, 26, 0.7, 8, 20, wall);
        box(x + side, 11, 34, 0.7, 22, 2, steel);
      }
      for (const offset of [-28, 0, 28]) {
        box(x + offset, 11, -16.8, 0.8, 22, 0.8, steel);
        box(x + offset, 21, 7, 0.8, 0.8, 48, steel);
        box(x + offset, 11, 31, 0.8, 22, 0.8, steel);
      }
      for (let stripe = -14; stripe < 20; stripe += 3) box(x, 14 + (stripe % 2), stripe, 56, 0.12, 0.12, steel);
      for (const offset of [-13.5, 13.5]) {
        const bx = x + offset;
        box(bx, 20.4, 0, 13, 0.15, 1.3, lamp);
        box(bx, 20.4, 13, 13, 0.15, 1.3, lamp);
        const marking = new MeshStandardMaterial({ color: '#396474', emissive: '#163343', emissiveIntensity: 0.5 });
        this.highlights.push(marking);
        for (const dx of [-11, 11]) box(bx + dx, 0.015, 0, 0.15, 0.05, 29, marking);
        box(bx, 0.015, 14.5, 22, 0.05, 0.2, marking);
        box(bx, 0.015, -14.5, 22, 0.05, 0.2, marking);
        box(bx, 0.025, -10, 0.12, 0.05, 7, marking);
      }
      // Small service equipment stays behind the aircraft and clear of the aisle.
      box(x + 24, 0.8, -14, 3, 1.6, 2, crate);
      box(x + 20, 0.6, -14, 2, 1.2, 2, steel);
      // Raised entrance door and its rails frame the forward entry move.
      box(x, 20, 32, 58, 4, 0.7, steel);
    }
    for (let x = -12; x < 174; x += 6) box(x, 0.03, 21, 2.5, 0.04, 0.1, lamp);
    for (const x of [45.5, 109.5]) {
      box(x, 14, 26, 4, 0.5, 18, steel);
    }
  }

  private ensureRenderer(): boolean {
    if (this.renderer) return true;
    if (this.failed) return false;
    try {
      const r = new WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'low-power', stencil: false });
      r.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
      r.outputColorSpace = SRGBColorSpace;
      r.toneMapping = ACESFilmicToneMapping;
      r.shadowMap.enabled = true;
      r.shadowMap.type = PCFShadowMap;
      this.renderer = r;
      return true;
    } catch (error) {
      console.error('Hangar renderer could not be initialized', error);
      this.failed = true;
      return false;
    }
  }

  private resize(): void {
    if (!this.renderer) return;
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.tour.resize(this.camera.aspect, this.reducedMotion);
    this.camera.fov = this.tour.fieldOfView;
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

  private readonly onMotion = (): void => {
    this.tour.select(this.selected, this.reducedMotion);
    this.dirty = true;
  };

  private readonly frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const elapsed = now - this.lastFrame;
    if (this.lastFrame && elapsed < FRAME_INTERVAL) return;
    const dt = this.lastFrame ? Math.min(0.1, elapsed / 1000) : 0;
    this.lastFrame = now;
    this.dirty = this.tour.update(dt) || this.dirty;
    if (!this.dirty || !this.renderer) return;
    this.camera.position.copy(this.tour.position);
    this.camera.lookAt(this.tour.target);
    this.renderer.render(this.scene, this.camera);
    this.dirty = false;
  };
}
