import { browserStorage, tryGetItem, tryParseJson, trySetItem } from '../../settings/safeStorage';

export interface JetAppearance {
  wrap: 'factory' | 'tactical' | 'woodland' | 'splinter';
  finish: 'matte' | 'gloss';
  raceNumber: string;
  canopy: 'factory' | 'smoke' | 'amber' | 'blue';
}

export const FACTORY_APPEARANCE: Readonly<JetAppearance> = Object.freeze({
  wrap: 'factory', finish: 'matte', raceNumber: '', canopy: 'factory',
});

export function parseJetAppearance(value: unknown): JetAppearance | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { wrap, finish, raceNumber, canopy } = value as Record<string, unknown>;
  if (wrap !== 'factory' && wrap !== 'tactical' && wrap !== 'woodland' && wrap !== 'splinter') return null;
  if (finish !== 'matte' && finish !== 'gloss') return null;
  if (canopy !== 'factory' && canopy !== 'smoke' && canopy !== 'amber' && canopy !== 'blue') return null;
  if (typeof raceNumber !== 'string' || raceNumber.length > 2 || /[^0-9]/.test(raceNumber)) return null;
  return { wrap, finish, raceNumber, canopy };
}

export function sameJetAppearance(a: JetAppearance, b: JetAppearance): boolean {
  return a.wrap === b.wrap && a.finish === b.finish && a.raceNumber === b.raceNumber && a.canopy === b.canopy;
}

const key = (id: string): string => `skyflight.jetAppearance.v1.${id}`;
const listeners = new Set<() => void>();

export function onJetAppearanceSaved(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function loadJetAppearance(id: string): JetAppearance {
  const raw = tryGetItem(browserStorage(), key(id));
  return (raw === null ? null : parseJetAppearance(tryParseJson(raw, 'jet appearance'))) ?? { ...FACTORY_APPEARANCE };
}

export function saveJetAppearance(id: string, appearance: JetAppearance): boolean {
  const parsed = parseJetAppearance(appearance);
  if (!parsed || !trySetItem(browserStorage(), key(id), JSON.stringify(parsed)).ok) return false;
  for (const listener of listeners) {
    try { listener(); } catch (error) { console.warn('Jet appearance listener failed:', error); }
  }
  return true;
}
