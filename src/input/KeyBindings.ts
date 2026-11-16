import { KEY_BINDINGS, type InputAction } from '../config/controlsConfig';

export type BindingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const STORAGE_KEY = 'sfr.keybindings';

function allActions(): InputAction[] {
  return Object.keys(KEY_BINDINGS) as InputAction[];
}

function defaultStorage(): BindingStorage | null {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    return ls ?? null;
  } catch {
    return null;
  }
}

/** Mutable, persisted keyboard bindings layered over the defaults in KEY_BINDINGS. */
export class KeyBindings {
  private readonly storage: BindingStorage | null;
  private bindings = new Map<InputAction, string[]>();
  private readonly listeners = new Set<() => void>();

  constructor(storage?: BindingStorage | null) {
    this.storage = storage === undefined ? defaultStorage() : storage;
    this.loadDefaults();
    this.load();
  }

  get(action: InputAction): readonly string[] {
    return this.bindings.get(action) ?? [];
  }

  set(action: InputAction, codes: string[]): void {
    this.bindings.set(action, [...new Set(codes)]);
    this.commit();
  }

  /** Replace (or append, if slot is past the end) one key slot; the code is removed from every other binding. */
  rebind(action: InputAction, slot: number, code: string): void {
    for (const [other, codes] of this.bindings) {
      if (other !== action) this.bindings.set(other, codes.filter((c) => c !== code));
    }
    const codes = [...(this.bindings.get(action) ?? [])];
    const index = Math.max(0, Math.floor(slot));
    if (index < codes.length) codes[index] = code;
    else codes.push(code);
    this.bindings.set(action, codes.filter((c, i) => c !== code || i === codes.indexOf(code)));
    this.commit();
  }

  resetDefaults(): void {
    this.loadDefaults();
    try {
      this.storage?.removeItem(STORAGE_KEY);
    } catch {
      // storage unavailable (e.g. privacy mode); bindings still apply for this session
    }
    this.emit();
  }

  actionsFor(code: string): InputAction[] {
    const result: InputAction[] = [];
    for (const [action, codes] of this.bindings) if (codes.includes(code)) result.push(action);
    return result;
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private loadDefaults(): void {
    this.bindings = new Map(allActions().map((a) => [a, [...KEY_BINDINGS[a]]]));
  }

  private load(): void {
    let raw: string | null = null;
    try {
      raw = this.storage?.getItem(STORAGE_KEY) ?? null;
    } catch {
      return;
    }
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const record = parsed as Record<string, unknown>;
    for (const action of allActions()) {
      const value = record[action];
      if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
        this.bindings.set(action, [...new Set(value as string[])]);
      }
    }
  }

  private commit(): void {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(this.bindings)));
    } catch {
      // ignore persistence failures
    }
    this.emit();
  }

  private emit(): void {
    for (const cb of [...this.listeners]) cb();
  }
}

const SPECIAL_LABELS: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  ShiftLeft: 'L-Shift',
  ShiftRight: 'R-Shift',
  ControlLeft: 'L-Ctrl',
  ControlRight: 'R-Ctrl',
  AltLeft: 'L-Alt',
  AltRight: 'R-Alt',
  MetaLeft: 'L-Meta',
  MetaRight: 'R-Meta',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: 'Space',
  Enter: 'Enter',
  Escape: 'Esc',
  Backspace: 'Backspace',
  Tab: 'Tab',
  CapsLock: 'Caps',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Delete: 'Del',
  Insert: 'Ins',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num -',
  NumpadMultiply: 'Num *',
  NumpadDivide: 'Num /',
  NumpadDecimal: 'Num .',
  NumpadEnter: 'Num Enter',
};

/** Short human-readable label for a KeyboardEvent.code. */
export function keyLabel(code: string): string {
  const special = SPECIAL_LABELS[code];
  if (special !== undefined) return special;
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  m = /^Digit(\d)$/.exec(code);
  if (m) return m[1];
  m = /^Numpad(\d)$/.exec(code);
  if (m) return `Num ${m[1]}`;
  return code;
}
