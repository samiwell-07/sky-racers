import { describe, expect, it } from 'vitest';
import { getJetDefinition } from '../src/entities/jet/jetCatalog';
import { jetHandling } from '../src/ui/jetHandling';

const trait = (id: string, t: string) => jetHandling(getJetDefinition(id)).find((h) => h.id === t)!;

describe('jetHandling', () => {
  it('rates the standard airframe as the middle of every bar', () => {
    for (const h of jetHandling({ flight: {} })) {
      expect(h.ratio).toBeCloseTo(1);
      expect(h.bar).toBeCloseTo(0.5);
      expect(h.verdict).toBe('Similar');
    }
  });

  it('follows the catalog overrides: Raptor is faster and steadier, Viper turns quicker', () => {
    expect(trait('raptor', 'topSpeed').ratio).toBeGreaterThan(trait('viper', 'topSpeed').ratio);
    expect(trait('raptor', 'acceleration').bar).toBeGreaterThan(0.5);
    expect(trait('viper', 'turn').ratio).toBeGreaterThan(trait('falcon', 'turn').ratio);
    expect(trait('raptor', 'turn').ratio).toBeLessThan(1);
    expect(trait('raptor', 'stability').ratio).toBeGreaterThan(trait('viper', 'stability').ratio);
  });

  it('keeps extreme values inside the bar', () => {
    const h = jetHandling({ flight: { maxThrust: 300, maxRollRate: 0.01 } });
    for (const t of h) {
      expect(t.bar).toBeGreaterThanOrEqual(0.04);
      expect(t.bar).toBeLessThanOrEqual(0.96);
    }
  });
});
