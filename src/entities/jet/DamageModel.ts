/**
 * Airframe health. Scrapes and obstacle hits reduce it; damage degrades handling and adds drag.
 * At zero health the jet is destroyed.
 */
export class DamageModel {
  health = 1;

  reset(): void {
    this.health = 1;
  }

  /** @returns true if this hit destroyed the jet. */
  apply(amount: number): boolean {
    this.health = Math.max(0, this.health - amount);
    return this.health <= 0;
  }

  /** Repairs (pickup gate); a destroyed jet stays destroyed. */
  heal(amount: number): void {
    if (this.health > 0) this.health = Math.min(1, this.health + amount);
  }

  get destroyed(): boolean {
    return this.health <= 0;
  }

  get rollFactor(): number {
    return 0.5 + 0.5 * this.health;
  }

  get pitchFactor(): number {
    return 0.7 + 0.3 * this.health;
  }

  get liftFactor(): number {
    return 0.85 + 0.15 * this.health;
  }

  get thrustFactor(): number {
    return 0.8 + 0.2 * this.health;
  }

  get dragPenalty(): number {
    return (1 - this.health) * 0.5;
  }
}
