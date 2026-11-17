import { describe, expect, it } from 'vitest';
import { KEY_BINDINGS } from '../src/config/controlsConfig';
import { KeyBindings, keyLabel } from '../src/input/KeyBindings';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe('KeyBindings', () => {
  it('starts from defaults and persists changes across instances', () => {
    const storage = memoryStorage();
    const kb = new KeyBindings(storage);
    expect(kb.get('pitchDown')).toEqual(KEY_BINDINGS.pitchDown);
    kb.set('pitchDown', ['KeyI']);
    expect(new KeyBindings(storage).get('pitchDown')).toEqual(['KeyI']);
  });

  it('rebind replaces a slot, appends past the end and steals the code from other actions', () => {
    const kb = new KeyBindings(memoryStorage());
    let changes = 0;
    kb.onChange(() => changes++);
    kb.rebind('pitchUp', 0, 'KeyW');
    expect(kb.get('pitchUp')).toEqual(['KeyW']);
    expect(kb.get('pitchDown')).toEqual([]);
    expect(kb.actionsFor('KeyW')).toEqual(['pitchUp']);
    kb.rebind('pitchUp', 5, 'ArrowUp');
    expect(kb.get('pitchUp')).toEqual(['KeyW', 'ArrowUp']);
    expect(kb.get('throttleUp')).toEqual(['ShiftLeft', 'ShiftRight']);
    expect(changes).toBe(2);
  });

  it('ignores unknown actions and falls back to defaults on corrupt JSON', () => {
    const kb = new KeyBindings(
      memoryStorage({ 'sfr.keybindings': JSON.stringify({ bogus: ['KeyJ'], respawn: ['KeyT'] }) }),
    );
    expect(kb.get('respawn')).toEqual(['KeyT']);
    expect(kb.actionsFor('KeyJ')).toEqual([]);
    expect(kb.get('pause')).toEqual(KEY_BINDINGS.pause);

    const corrupt = new KeyBindings(memoryStorage({ 'sfr.keybindings': '{not json' }));
    expect(corrupt.get('respawn')).toEqual(KEY_BINDINGS.respawn);
  });

  it('resetDefaults restores defaults and clears storage', () => {
    const storage = memoryStorage();
    const kb = new KeyBindings(storage);
    kb.set('pause', ['KeyQ']);
    kb.resetDefaults();
    expect(kb.get('pause')).toEqual(KEY_BINDINGS.pause);
    expect(storage.data.has('sfr.keybindings')).toBe(false);
  });

  it('works without storage', () => {
    const kb = new KeyBindings(null);
    kb.set('pause', ['KeyQ']);
    expect(kb.get('pause')).toEqual(['KeyQ']);
  });
});

describe('keyLabel', () => {
  it('formats common codes', () => {
    expect(keyLabel('KeyW')).toBe('W');
    expect(keyLabel('ArrowUp')).toBe('↑');
    expect(keyLabel('ShiftLeft')).toBe('L-Shift');
    expect(keyLabel('ControlLeft')).toBe('L-Ctrl');
    expect(keyLabel('Digit1')).toBe('1');
    expect(keyLabel('Backquote')).toBe('`');
    expect(keyLabel('Space')).toBe('Space');
    expect(keyLabel('F1')).toBe('F1');
  });
});
