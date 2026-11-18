import { Quaternion, Vector3 } from 'three';
import { WEAPON_RULES, type Combatant } from './types';

type MissileRules = typeof WEAPON_RULES.missile;

/** An afterburning target is a hotter IR source: the seeker locks it this much faster. */
export const AFTERBURNER_LOCK_SPEEDUP = 1.5;

const _local = new Vector3();
const _inv = new Quaternion();

/** True when `c` is a live enemy within lock range and inside the square lock box around the nose. */
export function inLockBox(self: Combatant, c: Combatant, rules: MissileRules = WEAPON_RULES.missile): boolean {
  if (c.id === self.id || !c.alive) return false;
  const local = _local.subVectors(c.position, self.position);
  if (local.length() > rules.lockRange) return false;
  local.applyQuaternion(_inv.copy(self.orientation).invert());
  const ahead = -local.z;
  if (ahead <= 1e-6) return false;
  const t = Math.tan(rules.lockBoxHalfAngle);
  return Math.abs(local.x) <= ahead * t && Math.abs(local.y) <= ahead * t;
}

/** Closest live enemy inside the lock box and lock range, or null. */
export function selectSeekerTarget(
  self: Combatant,
  others: readonly Combatant[],
  rules: MissileRules = WEAPON_RULES.missile,
): Combatant | null {
  let best: Combatant | null = null;
  let bestDist = Infinity;
  for (const c of others) {
    const d = c.position.distanceTo(self.position);
    if (d >= bestDist || !inLockBox(self, c, rules)) continue;
    best = c;
    bestDist = d;
  }
  return best;
}

/** IR seeker lock: builds over lockTime while the same target stays in the lock box, resets otherwise. */
export class SeekerLock {
  targetId: string | null = null;
  /** 0..1; 1 = locked. */
  progress = 0;

  constructor(private readonly rules: MissileRules = WEAPON_RULES.missile) {}

  get locked(): boolean {
    return this.targetId !== null && this.progress >= 1;
  }

  reset(): void {
    this.targetId = null;
    this.progress = 0;
  }

  update(dt: number, self: Combatant, others: readonly Combatant[], active = true): void {
    if (!active || !self.alive) {
      this.reset();
      return;
    }
    // Keep the current target while it stays in the box; it must not leave it during the lock.
    const current = this.targetId !== null ? others.find((c) => c.id === this.targetId) : undefined;
    const target = current && inLockBox(self, current, this.rules) ? current : selectSeekerTarget(self, others, this.rules);
    if (!target) {
      this.reset();
      return;
    }
    if (target.id !== this.targetId) {
      this.targetId = target.id;
      this.progress = 0;
    }
    const rate = (target.afterburner ? AFTERBURNER_LOCK_SPEEDUP : 1) / this.rules.lockTime;
    this.progress = Math.min(1, this.progress + rate * dt);
  }
}
