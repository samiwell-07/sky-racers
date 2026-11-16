import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { JET_COLLISION_POINTS } from '../src/entities/jet/Jet';
import { segmentPassesRing, type RingShape } from '../src/world/rings/ringMath';

// 30 m wide x 20 m tall opening with a 1 m frame, flown toward -Z.
const gate: RingShape = { center: new Vector3(0, 20, 0), normal: new Vector3(0, 0, -1), width: 30, height: 20, frame: 1 };

describe('holographic gate math', () => {
  it('counts a forward pass through the opening or the frame', () => {
    expect(segmentPassesRing(new Vector3(0, 20, 1), new Vector3(0, 20, -1), gate)).toBe(true);
    expect(segmentPassesRing(new Vector3(14, 29, 1), new Vector3(14, 29, -1), gate)).toBe(true);
    expect(segmentPassesRing(new Vector3(15.8, 20, 1), new Vector3(15.8, 20, -1), gate)).toBe(true);
  });

  it('ignores passes outside the rectangle or in the wrong direction', () => {
    expect(segmentPassesRing(new Vector3(16.5, 20, 1), new Vector3(16.5, 20, -1), gate)).toBe(false);
    expect(segmentPassesRing(new Vector3(0, 31.5, 1), new Vector3(0, 31.5, -1), gate)).toBe(false);
    expect(segmentPassesRing(new Vector3(0, 20, -1), new Vector3(0, 20, 1), gate)).toBe(false);
  });

  it('counts when only a wingtip touches the gate', () => {
    // Jet center 20 m to the right of the gate center: only the left wing and tail tips reach the frame.
    const q = new Quaternion();
    const at = (z: number): Vector3[] =>
      JET_COLLISION_POINTS.map((p) => p.clone().applyQuaternion(q).add(new Vector3(20, 20, z)));
    let centerPassed = false;
    let anyPartPassed = false;
    for (let z = 15; z > -15; z--) {
      centerPassed ||= segmentPassesRing(new Vector3(20, 20, z), new Vector3(20, 20, z - 1), gate);
      const before = at(z);
      const after = at(z - 1);
      anyPartPassed ||= before.some((p, i) => segmentPassesRing(p, after[i]!, gate));
    }
    expect(centerPassed).toBe(false);
    expect(anyPartPassed).toBe(true);
  });
});
