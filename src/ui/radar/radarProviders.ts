import type { RadarContact, RadarContactKind } from './types';
import { headingFromDirection, headingFromQuaternion } from './radarMath';

/**
 * Helpers that turn game state into RadarContacts without depending on Game.ts. They append to a
 * RadarContactList, which recycles its contact objects so building a frame allocates nothing once warm.
 *
 * Typical use per frame:
 *   list.clear();
 *   addGateContacts(list, course.gates, progress.nextGate, 4, course.def.loop);
 *   addJetContact(list, 'ai', ai.jet.position, ai.jet.orientation, ai.name);
 *   radar.update({ self: selfFromJet(jet.position, jet.orientation, self), contacts: list.items, zone });
 */

interface XYZ {
  x: number;
  y: number;
  z: number;
}
interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export class RadarContactList {
  private readonly pool: RadarContact[] = [];
  private readonly list: RadarContact[] = [];

  /** The contacts added since the last clear() (pass as RadarFrame.contacts). */
  get items(): readonly RadarContact[] {
    return this.list;
  }

  get length(): number {
    return this.list.length;
  }

  clear(): void {
    this.list.length = 0;
  }

  add(kind: RadarContactKind, x: number, y: number, z: number, heading?: number, label?: string): RadarContact {
    const n = this.list.length;
    let c = this.pool[n];
    if (!c) {
      c = { kind, x, y, z };
      this.pool.push(c);
    }
    c.kind = kind;
    c.x = x;
    c.y = y;
    c.z = z;
    c.heading = heading;
    c.label = label;
    this.list.push(c);
    return c;
  }
}

/** Fills `out` (reused) with the radar self state of a jet. */
export function selfFromPose(position: XYZ, orientation: Quat, out: { x: number; y: number; z: number; heading: number }): { x: number; y: number; z: number; heading: number } {
  out.x = position.x;
  out.y = position.y;
  out.z = position.z;
  out.heading = headingFromQuaternion(orientation);
  return out;
}

/** A jet (enemy, other player, AI racer or ghost) drawn as an arrow along its orientation. */
export function addJetContact(list: RadarContactList, kind: 'enemy' | 'player' | 'ai' | 'ghost', position: XYZ, orientation: Quat, label?: string): RadarContact {
  return list.add(kind, position.x, position.y, position.z, headingFromQuaternion(orientation), label);
}

/** Race gates: the next one as 'nextGate', then up to `count - 1` following gates as 'gate'. */
export function addGateContacts(
  list: RadarContactList,
  gates: readonly { center: XYZ; normal?: XYZ }[],
  nextIndex: number,
  count = gates.length,
  loop = false,
): void {
  const n = gates.length;
  if (n === 0 || nextIndex < 0 || (!loop && nextIndex >= n)) return;
  const shown = Math.min(count, n);
  for (let k = 0; k < shown; k++) {
    let i = nextIndex + k;
    if (i >= n) {
      if (!loop) break;
      i %= n;
    }
    const g = gates[i]!;
    const heading = g.normal ? headingFromDirection(g.normal.x, g.normal.z) : undefined;
    list.add(k === 0 ? 'nextGate' : 'gate', g.center.x, g.center.y, g.center.z, heading);
  }
}

/** Convenience wrapper returning a fresh array (allocates; fine for setup or tests). */
export function gateContacts(gates: readonly { center: XYZ; normal?: XYZ }[], nextIndex: number, count = gates.length, loop = false): RadarContact[] {
  const list = new RadarContactList();
  addGateContacts(list, gates, nextIndex, count, loop);
  return [...list.items];
}

/** Missiles: those tracking the local player become 'incomingMissile' (flashing on the radar). */
export function addMissileContacts(list: RadarContactList, missiles: Iterable<{ position: XYZ; targetId?: string | null }>, selfId: string | null): void {
  for (const m of missiles) {
    const incoming = selfId !== null && m.targetId === selfId;
    list.add(incoming ? 'incomingMissile' : 'missile', m.position.x, m.position.y, m.position.z);
  }
}

export function addFlareContacts(list: RadarContactList, flares: Iterable<XYZ>): void {
  for (const f of flares) list.add('flare', f.x, f.y, f.z);
}

/** A runway (default: along Z, takeoff toward -Z, like RunwayRect / WorldGenerator.airfield). */
export function addAirfieldContact(list: RadarContactList, runway: { x: number; z: number; height?: number }, heading = 0, label?: string): RadarContact {
  return list.add('airfield', runway.x, runway.height ?? 0, runway.z, heading, label);
}
