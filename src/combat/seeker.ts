import { Vector3 } from 'three';
import { WEAPON_RULES, type Combatant } from './types';
import { forwardOf, offBoresight } from './math';

type MissileRules = typeof WEAPON_RULES.missile;

/** An afterburning target is a hotter IR source: the seeker locks it this much faster. */
export const AFTERBURNER_LOCK_SPEEDUP = 1.5;

const _fwd = new Vector3();

/** Closest live enemy inside the seeker cone (around the jet's nose) and lock range, or null. */
export function selectSeekerTarget(
  self: Combatant,
  others: readonly Combatant[],
  rules: MissileRules = WEAPON_RULES.missile,
): Combatant | null {
  const fwd = forwardOf(self.orientation, _fwd);
  let best: Combatant | null = null;
  let bestDist = Infinity;
  for (const c of others) {
    if (c.id === self.id || !c.alive) continue;
    const d = c.position.distanceTo(self.position);
    if (d > rules.lockRange || d >= bestDist) continue;
    if (offBoresight(self.position, fwd, c.position) > rules.seekerHalfAngle) continue;
    best = c;
    bestDist = d;
  }
  return best;
}

/** IR seeker lock: builds over lockTime while the same target stays in the cone, resets otherwise. */
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
    const target = active && self.alive ? selectSeekerTarget(self, others, this.rules) : null;
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
