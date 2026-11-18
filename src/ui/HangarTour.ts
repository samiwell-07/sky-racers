import { Vector3 } from 'three';

export const BAY_SPACING = 27;
export const HANGAR_SPACING = 64;

export function bayX(index: number): number {
  return Math.floor(index / 2) * HANGAR_SPACING + (index % 2) * BAY_SPACING;
}

/** The inspection aisle runs through aligned openings in all three buildings. */
export class HangarTour {
  readonly position = new Vector3();
  readonly target = new Vector3();
  private readonly destination = new Vector3();
  private readonly lookDestination = new Vector3();
  private readonly start = new Vector3();
  private readonly lookStart = new Vector3();
  private elapsed = 0;
  private duration = 0;
  private entering = false;
  private index = 0;
  private entryIndex = 0;
  private aspect = 16 / 9;

  constructor(private readonly count: number) {}

  enter(index: number, aspect: number, reducedMotion: boolean): void {
    this.index = Math.max(0, Math.min(this.count - 1, index));
    this.entryIndex = this.index;
    this.aspect = Math.max(0.25, aspect);
    this.setDestination();
    this.position.set(this.destination.x, 6, 62);
    this.target.copy(this.lookDestination);
    this.entering = true;
    this.begin(reducedMotion ? 0 : 2.2);
  }

  select(index: number, reducedMotion: boolean): void {
    this.index = Math.max(0, Math.min(this.count - 1, index));
    // Let entry finish before moving along the interior aisle.
    if (this.entering && this.elapsed < this.duration && !reducedMotion) return;
    this.setDestination();
    this.entering = false;
    this.begin(reducedMotion ? 0 : Math.max(0.65, this.position.distanceTo(this.destination) / 32));
  }

  resize(aspect: number, reducedMotion: boolean): void {
    this.aspect = Math.max(0.25, aspect);
    if (reducedMotion) this.select(this.index, true);
  }

  update(dt: number): boolean {
    if (this.elapsed >= this.duration) return false;
    this.elapsed = Math.min(this.duration, this.elapsed + Math.max(0, dt));
    const t = this.elapsed / this.duration;
    const eased = t * t * (3 - 2 * t);
    this.position.lerpVectors(this.start, this.destination, eased);
    this.target.lerpVectors(this.lookStart, this.lookDestination, eased);
    if (this.entering && t === 1) {
      this.entering = false;
      if (this.index !== this.entryIndex) this.select(this.index, false);
    }
    return true;
  }

  private setDestination(): void {
    // Keep portrait framing inside the aisle rather than pushing the camera through a wall.
    this.destination.set(bayX(this.index) + 7, 7, 26);
    this.lookDestination.set(bayX(this.index), 2.5, 0);
  }

  get fieldOfView(): number {
    return Math.min(95, Math.max(48, 2 * Math.atan(Math.tan(24 * Math.PI / 180) / this.aspect) * 180 / Math.PI));
  }

  private begin(duration: number): void {
    this.start.copy(this.position);
    this.lookStart.copy(this.target);
    this.elapsed = 0;
    this.duration = duration;
    if (duration === 0) {
      this.position.copy(this.destination);
      this.target.copy(this.lookDestination);
      this.entering = false;
    }
  }
}
