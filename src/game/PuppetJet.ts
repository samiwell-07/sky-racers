import { Mesh, type Material, type Object3D, type Quaternion, type Vector3 } from 'three';
import { createFlightConfig } from '../config/flightConfig';
import { Jet } from '../entities/jet/Jet';
import type { JetDefinition } from '../entities/jet/jetCatalog';

/**
 * A see-through, visual-only jet (ghost replays and remote players).
 * Owns its Jet and the see-through material clones it swaps in (the jet's originals stay owned by the jet).
 */
export class PuppetJet {
  readonly jet: Jet;
  private readonly clones: Material[] = [];

  constructor(definition: JetDefinition, parent: Object3D, opacity = 1) {
    this.jet = new Jet(definition, createFlightConfig(definition.flight), false);
    if (opacity < 1) {
      this.jet.object.traverse((o) => {
        const mesh = o as Mesh;
        if (!mesh.isMesh) return;
        const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((m: Material) => {
          const c = m.clone();
          c.transparent = true;
          c.opacity = Math.min(c.opacity, opacity);
          c.depthWrite = false;
          this.clones.push(c);
          return c;
        });
        mesh.material = Array.isArray(mesh.material) ? mats : mats[0]!;
        mesh.castShadow = false;
      });
    }
    parent.add(this.jet.object);
  }

  set(position: Vector3, quaternion: Quaternion, throttle: number, time: number, dt: number): void {
    const s = this.jet.flight.state;
    s.position.copy(position);
    s.orientation.copy(quaternion);
    s.throttle = throttle;
    this.jet.flight.telemetry.afterburner = throttle >= this.jet.flight.config.afterburnerThreshold;
    // alpha = 1 places the model exactly on the current state.
    this.jet.render(1, time, dt);
  }

  set visible(v: boolean) {
    this.jet.object.visible = v;
  }

  /** Removes the puppet and frees its resources (safe to call more than once). */
  dispose(_parent?: Object3D): void {
    for (const c of this.clones) c.dispose();
    this.clones.length = 0;
    this.jet.dispose();
  }
}
