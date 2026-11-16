import {
  AdditiveBlending,
  Color,
  ConeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
} from 'three';
import type { JetParts } from './JetModel';

interface Flame {
  outer: Mesh<ConeGeometry, MeshBasicMaterial>;
  core: Mesh<ConeGeometry, MeshBasicMaterial>;
}

const DRY_COLOR = new Color('#ff8a3d');
const AB_COLOR = new Color('#ffb066');
const CORE_COLOR = new Color('#9fc4ff');

/** Exhaust flames whose length, brightness and flicker follow the throttle. */
export class Afterburner {
  readonly group = new Group();
  private readonly flames: Flame[] = [];
  /** Materials created here (meshes may have had theirs swapped, e.g. by PuppetJet). */
  private readonly materials: MeshBasicMaterial[] = [];
  private level = 0;

  constructor(nozzles: JetParts['nozzles']) {
    for (const n of nozzles) {
      // Cone tip points +Y by default; rotate so it points backward (+Z) with its base at the nozzle.
      const outerGeo = new ConeGeometry(n.radius * 0.95, 1, 16, 1, true);
      outerGeo.rotateX(Math.PI / 2);
      outerGeo.translate(0, 0, 0.5);
      const coreGeo = new ConeGeometry(n.radius * 0.55, 1, 12, 1, true);
      coreGeo.rotateX(Math.PI / 2);
      coreGeo.translate(0, 0, 0.5);
      const mat = (color: Color): MeshBasicMaterial =>
        new MeshBasicMaterial({ color, transparent: true, blending: AdditiveBlending, depthWrite: false, fog: false });
      const outer = new Mesh(outerGeo, mat(DRY_COLOR));
      const core = new Mesh(coreGeo, mat(CORE_COLOR));
      this.materials.push(outer.material, core.material);
      for (const m of [outer, core]) {
        m.position.set(n.x, n.y, n.z);
        m.renderOrder = 10;
        this.group.add(m);
      }
      this.flames.push({ outer, core });
    }
  }

  /** Frees the flame geometries and the materials it created (idempotent). */
  dispose(): void {
    for (const f of this.flames) {
      f.outer.geometry.dispose();
      f.core.geometry.dispose();
    }
    for (const m of this.materials) m.dispose();
    this.flames.length = 0;
    this.materials.length = 0;
    this.group.removeFromParent();
  }

  /**
   * @param throttle 0..1
   * @param afterburner true when throttle is in the afterburner range
   */
  update(throttle: number, afterburner: boolean, time: number, dt: number): void {
    // Dry thrust is nearly invisible; the flame grows near full military power and lights up in afterburner.
    const target = afterburner ? 1 : Math.max(0, throttle - 0.6) * 0.5;
    this.level += (target - this.level) * Math.min(1, dt * 8);
    const visible = this.level > 0.03;
    this.group.visible = visible;
    if (!visible) return;

    this.flames.forEach((f, i) => {
      const flicker = 1 + Math.sin(time * 60 + i * 2.1) * 0.06 + Math.sin(time * 37 + i) * 0.05;
      const len = (0.6 + this.level * 5.5) * flicker;
      f.outer.scale.set(1, 1, len);
      f.core.scale.set(1, 1, len * 0.6);
      f.outer.material.color.copy(DRY_COLOR).lerp(AB_COLOR, this.level);
      f.outer.material.opacity = 0.25 + this.level * 0.55;
      f.core.material.opacity = 0.2 + this.level * 0.7;
    });
  }
}
