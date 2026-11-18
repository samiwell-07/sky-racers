import { describe, expect, it } from 'vitest';
import { KEY_BINDINGS } from '../src/config/controlsConfig';
import { KeyBindings, keyLabel } from '../src/input/KeyBindings';
import { DEFAULT_PAD_BINDINGS, PadBindings } from '../src/input/PadBindings';

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

describe('PadBindings', () => {
  it('rebinding steals the button from another action, persists, and resets to defaults', () => {
    const storage = memoryStorage();
    const pb = new PadBindings(storage);
    expect(pb.get('fireGun')).toBe(DEFAULT_PAD_BINDINGS.fireGun);
    pb.rebind('fireGun', DEFAULT_PAD_BINDINGS.airbrake);
    expect(pb.get('fireGun')).toBe(DEFAULT_PAD_BINDINGS.airbrake);
    expect(pb.get('airbrake')).toBeNull();
    expect(pb.isCustom('fireGun')).toBe(true);
    expect(pb.hint('airbrake')).toBeNull();
    expect(pb.hint('fireGun')).toBe('A');
    expect(pb.hint('pitchUp')).toBe('left stick ↕');

    const reloaded = new PadBindings(storage);
    expect(reloaded.get('fireGun')).toBe(0);
    expect(reloaded.get('airbrake')).toBeNull();
    reloaded.resetDefaults();
    expect(reloaded.get('airbrake')).toBe(DEFAULT_PAD_BINDINGS.airbrake);
    expect(storage.data.has('sfr.padbindings')).toBe(false);
  });

  it('ignores invalid stored buttons', () => {
    const pb = new PadBindings(memoryStorage({ 'sfr.padbindings': JSON.stringify({ pause: -3, respawn: 'x', fireGun: 11 }) }));
    expect(pb.get('pause')).toBe(DEFAULT_PAD_BINDINGS.pause);
    expect(pb.get('respawn')).toBe(DEFAULT_PAD_BINDINGS.respawn);
    expect(pb.get('fireGun')).toBe(11);
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
