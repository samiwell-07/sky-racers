/** Minimal key/value storage (localStorage or a test double). `key`/`length` enable listing. */
export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem' | 'key' | 'length'>>;

export type SaveResult = { ok: true } | { ok: false; error: string };

/** The browser's localStorage, or null when it is missing or access is blocked (e.g. privacy settings). */
export function browserStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** A short, player-readable reason for a storage failure. */
export function describeStorageError(e: unknown): string {
  const name = (e as { name?: unknown } | null)?.name;
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return 'browser storage is full';
  if (name === 'SecurityError') return 'browser storage access is blocked';
  return e instanceof Error && e.message ? e.message : 'browser storage is unavailable';
}

/** Writes a value; never throws. */
export function trySetItem(storage: KeyValueStorage | null, key: string, value: string): SaveResult {
  if (!storage) return { ok: false, error: 'browser storage is unavailable' };
  try {
    storage.setItem(key, value);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: describeStorageError(e) };
  }
}

/** Reads a value; returns null (and warns) if storage access throws. */
export function tryGetItem(storage: KeyValueStorage | null, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch (e) {
    console.warn(`Could not read "${key}": ${describeStorageError(e)}`);
    return null;
  }
}

/** Parses JSON; returns undefined (and warns) for malformed data instead of throwing. */
export function tryParseJson(raw: string, what: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    console.warn(`Ignoring malformed ${what} (not valid JSON).`);
    return undefined;
  }
}

/** All keys starting with `prefix` (empty if the storage cannot be listed). */
export function listKeys(storage: KeyValueStorage | null, prefix: string): string[] {
  const out: string[] = [];
  if (!storage || typeof storage.key !== 'function' || typeof storage.length !== 'number') return out;
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k !== null && k.startsWith(prefix)) out.push(k);
    }
  } catch {
    // Listing blocked: nothing to show.
  }
  return out;
}

export const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
