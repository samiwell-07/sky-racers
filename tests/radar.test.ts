import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import {
  RADAR_RANGES,
  altitudeCue,
  circleToRadar,
  clampToRadius,
  headingFromDirection,
  headingFromQuaternion,
  nextRadarRange,
  rangeLabel,
  relativeBearing,
  snapRadarRange,
  worldToRadar,
  zoneStatus,
} from '../src/ui/radar/radarMath';
import { RadarContactList, addGateContacts, addMissileContacts, gateContacts, selfFromPose } from '../src/ui/radar/radarProviders';
import { validateSettings } from '../src/settings/Settings';

const pt = () => ({ x: 0, y: 0 });
/** World point `dist` m along heading `h` from (sx, sz). */
const along = (sx: number, sz: number, h: number, dist: number) => ({ x: sx - Math.sin(h) * dist, z: sz - Math.cos(h) * dist });

describe('worldToRadar (heading-up)', () => {
  it('maps ahead to up, right to right and behind to down at heading 0', () => {
    const up = worldToRadar(0, 0, 0, 0, -100, 1, pt());
    expect(up.x).toBeCloseTo(0);
    expect(up.y).toBeCloseTo(-100);
    const right = worldToRadar(0, 0, 0, 100, 0, 1, pt());
    expect(right.x).toBeCloseTo(100);
    expect(right.y).toBeCloseTo(0);
    const behind = worldToRadar(0, 0, 0, 0, 100, 1, pt());
    expect(behind.x).toBeCloseTo(0);
    expect(behind.y).toBeCloseTo(100);
  });

  it('keeps whatever is ahead straight up for any heading and position', () => {
    for (const h of [0.3, 1.7, -2.4, Math.PI]) {
      const t = along(500, -200, h, 1000);
      const p = worldToRadar(500, -200, h, t.x, t.z, 0.1, pt());
      expect(p.x).toBeCloseTo(0);
      expect(p.y).toBeCloseTo(-100);
    }
  });

  it('rotates the world with the heading', () => {
    // Heading +90° (rotation about +Y) flies toward -X: -X is ahead, -Z is now on the right.
    const h = Math.PI / 2;
    const ahead = worldToRadar(0, 0, h, -100, 0, 1, pt());
    expect(ahead.x).toBeCloseTo(0);
    expect(ahead.y).toBeCloseTo(-100);
    const right = worldToRadar(0, 0, h, 0, -100, 1, pt());
    expect(right.x).toBeCloseTo(100);
    expect(right.y).toBeCloseTo(0);
  });

  it('scales by pixels per metre', () => {
    const p = worldToRadar(10, 10, 0, 10, -990, 94 / 1000, pt());
    expect(p.y).toBeCloseTo(-94);
  });
});

describe('radar helpers', () => {
  it('clamps points beyond the radius onto the rim, keeping the direction', () => {
    const p = { x: 300, y: -400 };
    expect(clampToRadius(p, 50)).toBe(true);
    expect(p.x).toBeCloseTo(30);
    expect(p.y).toBeCloseTo(-40);
    const q = { x: 10, y: 10 };
    expect(clampToRadius(q, 50)).toBe(false);
    expect(q).toEqual({ x: 10, y: 10 });
  });

  it('converts the zone circle to radar pixels', () => {
    const c = circleToRadar(0, 1000, 0, 0, 0, 3000, 0.01, { x: 0, y: 0, r: 0 });
    expect(c.x).toBeCloseTo(0);
    expect(c.y).toBeCloseTo(-10);
    expect(c.r).toBeCloseTo(30);
  });

  it('classifies the player inside / near / outside the zone', () => {
    expect(zoneStatus(0, 0, 0, 0, 3000)).toBe('inside');
    expect(zoneStatus(2700, 0, 0, 0, 3000)).toBe('near');
    expect(zoneStatus(0, 3200, 0, 0, 3000)).toBe('outside');
  });

  it('rotates contact arrows relative to the player heading', () => {
    expect(relativeBearing(1, 1)).toBeCloseTo(0);
    // A contact turned 90° left of us (heading +π/2) points left: -π/2 clockwise.
    expect(relativeBearing(Math.PI / 2, 0)).toBeCloseTo(-Math.PI / 2);
    expect(relativeBearing(-3, 3)).toBeCloseTo(6 - Math.PI * 2);
  });

  it('gives altitude cues beyond 150 m', () => {
    expect(altitudeCue(200)).toBe(1);
    expect(altitudeCue(-151)).toBe(-1);
    expect(altitudeCue(100)).toBe(0);
  });

  it('cycles and snaps zoom levels', () => {
    expect(RADAR_RANGES).toEqual([2000, 5000, 10000, 20000]);
    expect(nextRadarRange(2000)).toBe(5000);
    expect(nextRadarRange(20000)).toBe(2000);
    expect(snapRadarRange(7000)).toBe(5000);
    expect(snapRadarRange(1e9)).toBe(20000);
    expect(rangeLabel(5000)).toBe('5 km');
  });

  it('derives headings from quaternions and directions (0 = toward -Z)', () => {
    for (const h of [0, 0.8, -2, 3]) {
      const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), h);
      expect(headingFromQuaternion(q)).toBeCloseTo(Math.atan2(Math.sin(h), Math.cos(h)));
      const f = new Vector3(0, 0, -1).applyQuaternion(q);
      expect(headingFromDirection(f.x, f.z)).toBeCloseTo(Math.atan2(Math.sin(h), Math.cos(h)));
    }
  });
});

describe('radar providers', () => {
  const gates = [0, 1, 2, 3].map((i) => ({ center: new Vector3(i * 100, 50, -i * 1000), normal: new Vector3(0, 0, -1) }));

  it('marks the next gate and the following ones', () => {
    const c = gateContacts(gates, 1, 2);
    expect(c.map((g) => g.kind)).toEqual(['nextGate', 'gate']);
    expect(c[0]).toMatchObject({ x: 100, z: -1000 });
    expect(c[0]!.heading).toBeCloseTo(0);
  });

  it('wraps on loops and stops at the end otherwise', () => {
    expect(gateContacts(gates, 3, 3).length).toBe(1);
    expect(gateContacts(gates, 3, 3, true).map((g) => g.x)).toEqual([300, 0, 100]);
    expect(gateContacts(gates, 4, 3)).toEqual([]);
  });

  it('recycles contact objects between frames', () => {
    const list = new RadarContactList();
    addGateContacts(list, gates, 0, 4);
    const first = list.items[0];
    list.clear();
    addMissileContacts(list, [{ position: new Vector3(1, 2, 3), targetId: 'me' }, { position: new Vector3(), targetId: 'other' }], 'me');
    expect(list.items[0]).toBe(first);
    expect(list.items.map((c) => c.kind)).toEqual(['incomingMissile', 'missile']);
    expect(list.items[0]!.heading).toBeUndefined();
  });

  it('builds the self state from a pose', () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.5);
    expect(selfFromPose(new Vector3(1, 2, 3), q, { x: 0, y: 0, z: 0, heading: 0 })).toMatchObject({ x: 1, y: 2, z: 3, heading: expect.closeTo(0.5) });
  });
});

describe('radar settings', () => {
  it('defaults and validates showRadar / radarRange', () => {
    expect(validateSettings({}).values).toMatchObject({ showRadar: true, radarRange: 5000 });
    expect(validateSettings({ radarRange: 9000, showRadar: false }).values).toMatchObject({ showRadar: false, radarRange: 10000 });
    expect(validateSettings({ radarRange: 'far' }).values.radarRange).toBe(5000);
  });
});
