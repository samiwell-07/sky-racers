/**
 * World seeds, Minecraft-style: any text the player types becomes a 32-bit seed. A plain integer
 * (e.g. "12345" or "-7") is used as-is (wrapped to unsigned 32 bits); any other text is hashed.
 * Leading/trailing spaces are ignored; empty text means "pick a random seed".
 */
export function seedFromText(text: string): number {
  const t = text.trim();
  if (/^-?\d{1,10}$/.test(t)) {
    const n = Number(t);
    if (Number.isSafeInteger(n) && n >= -2147483648 && n <= 4294967295) return n >>> 0;
  }
  // FNV-1a over UTF-16 code units, then a murmur3 finalizer to spread close strings apart.
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** A random seed as display text (a positive integer, so it can be shared and typed back). */
export function randomSeedText(random: () => number = Math.random): string {
  return String(Math.floor(random() * 4294967296) >>> 0);
}

/** Derives an independent sub-seed (e.g. one per feature layer) from a world seed. */
export function subSeed(seed: number, salt: number): number {
  let h = Math.imul((seed ^ Math.imul(salt, 0x9e3779b9)) >>> 0, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
