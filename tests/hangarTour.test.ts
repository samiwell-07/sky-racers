import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { bayX, HangarTour } from '../src/ui/HangarTour';

function settle(tour: HangarTour, dt = 1 / 60): void {
  for (let i = 0; i < 1200 && tour.update(dt); i++);
}

describe('hangar camera travel', () => {
  it('enters forward through the selected building entrance before inspecting the aircraft', () => {
    const tour = new HangarTour(5);
    tour.enter(2, 16 / 9, false);
    expect(tour.position.z).toBeGreaterThan(35);
    const initialX = tour.position.x;
    let previousZ = tour.position.z;
    for (let i = 0; i < 150; i++) {
      tour.update(1 / 60);
      expect(tour.position.x).toBe(initialX);
      expect(tour.position.z).toBeLessThanOrEqual(previousZ);
      previousZ = tour.position.z;
    }
    expect(tour.target.x).toBe(bayX(2));
    expect(tour.position.z).toBe(26);
  });

  it('moves continuously along the connecting aisle through both hangar boundaries', () => {
    const tour = new HangarTour(5);
    tour.enter(0, 16 / 9, true);
    for (let index = 1; index < 5; index++) {
      const before = tour.position.clone();
      tour.select(index, false);
      expect(tour.position.equals(before)).toBe(true);
      let previous = before;
      for (let frame = 0; frame < 180; frame++) {
        tour.update(1 / 60);
        expect(tour.position.z).toBe(26);
        expect(tour.position.x).toBeGreaterThanOrEqual(previous.x);
        expect(tour.position.distanceTo(previous)).toBeLessThan(1);
        previous = tour.position.clone();
      }
      expect(tour.target.x).toBe(bayX(index));
    }
    tour.select(999, true);
    expect(tour.target.x).toBe(bayX(4));
    tour.select(-1, true);
    expect(tour.target.x).toBe(bayX(0));
  });

  it('retargets from the current pose without jumps or a queued intermediate destination', () => {
    const tour = new HangarTour(5);
    tour.enter(0, 1, true);
    tour.select(4, false);
    tour.update(0.3);
    const before = tour.position.clone();
    tour.select(1, false);
    expect(tour.position.equals(before)).toBe(true);
    settle(tour);
    expect(tour.target.x).toBe(bayX(1));
  });

  it('defers lateral navigation until entry is complete and honors reduced motion immediately', () => {
    const tour = new HangarTour(5);
    tour.enter(0, 1, false);
    tour.update(0.5);
    const x = tour.position.x;
    tour.select(4, false);
    tour.update(0.5);
    expect(tour.position.x).toBe(x);
    settle(tour);
    expect(tour.target.x).toBe(bayX(4));
    tour.select(0, true);
    expect(tour.position.equals(new Vector3(7, 7, 26))).toBe(true);
    expect(tour.update(1)).toBe(false);
  });

  it('is frame-rate independent and widens portrait framing without leaving the aisle', () => {
    const sample = (dt: number): HangarTour => {
      const tour = new HangarTour(5);
      tour.enter(0, 16 / 9, true);
      tour.select(3, false);
      for (let t = 0; t < 0.9 - dt / 2; t += dt) tour.update(dt);
      return tour;
    };
    const fast = sample(1 / 120);
    const slow = sample(1 / 30);
    expect(fast.position.distanceTo(slow.position)).toBeLessThan(1e-8);
    const before = fast.position.clone();
    const landscapeFov = fast.fieldOfView;
    fast.resize(0.5, false);
    expect(fast.fieldOfView).toBeGreaterThan(landscapeFov);
    expect(fast.position.equals(before)).toBe(true);
  });
});
