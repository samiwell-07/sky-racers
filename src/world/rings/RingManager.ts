import { Group } from 'three';
import { Ring } from './Ring';
import type { RingShape } from './ringMath';

/** Displays a course's holographic gates and highlights the player's next one. */
export class RingManager {
  readonly group = new Group();
  readonly rings: Ring[] = [];

  setGates(gates: readonly RingShape[]): void {
    this.clear();
    for (const g of gates) {
      const ring = new Ring(g.center, g.normal, g.width, g.height, g.frame);
      this.rings.push(ring);
      this.group.add(ring.group, ring.beaconMesh);
    }
    this.showProgress(0);
  }

  clear(): void {
    for (const r of this.rings) r.dispose();
    this.rings.length = 0;
    this.group.clear();
  }

  /** Gates before `nextIndex` are passed, `nextIndex` is next, the rest upcoming. -1 = all upcoming. */
  showProgress(nextIndex: number): void {
    this.rings.forEach((r, i) => r.setStatus(nextIndex < 0 ? 'upcoming' : i < nextIndex ? 'passed' : i === nextIndex ? 'next' : 'upcoming'));
  }

  animate(time: number): void {
    for (const r of this.rings) r.animate(time);
  }
}
