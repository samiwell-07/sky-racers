import { ACTION_LABELS, KEY_BINDINGS, type InputAction } from '../config/controlsConfig';
import type { InputManager } from '../input/InputManager';
import { keyLabel, type KeyBindings } from '../input/KeyBindings';
import type { GameSettings, GraphicsQuality, SettingsStore } from '../settings/Settings';
import { button, checkbox, h, select, slider } from './dom';

type Tab = 'graphics' | 'audio' | 'controls' | 'world';

/** Settings screen with tabs: graphics, audio, controls (sensitivity + key remapping), world (time, weather). */
export class SettingsPanel {
  private tab: Tab = 'graphics';

  constructor(
    private readonly store: SettingsStore,
    private readonly bindings: KeyBindings,
    private readonly input: InputManager,
  ) {}

  /** `lockWorld`: in a multiplayer lobby the world/weather belong to the lobby (its host edits them), so no World tab. */
  render(onBack: () => void, lockWorld = false): HTMLElement {
    const tabs: Tab[] = lockWorld ? ['graphics', 'audio', 'controls'] : ['graphics', 'audio', 'controls', 'world'];
    if (!tabs.includes(this.tab)) this.tab = 'graphics';
    const panel = h('div', { class: 'menu-panel' });
    const draw = (): void => {
      panel.replaceChildren(
        h('h2', {}, 'Settings'),
        h(
          'div',
          { class: 'menu-tabs' },
          ...tabs.map((t) =>
            button(t[0]!.toUpperCase() + t.slice(1), () => {
              this.tab = t;
              draw();
            }, `small ${this.tab === t ? 'selected' : ''}`),
          ),
        ),
        this.content(draw),
        h('div', { class: 'menu-row' }, button('Back', onBack, 'primary'), button('Reset all to defaults', () => {
          this.store.reset();
          this.bindings.resetDefaults();
          draw();
        })),
      );
    };
    draw();
    return panel;
  }

  private content(redraw: () => void): HTMLElement {
    const s = this.store.values;
    const set = <K extends keyof GameSettings>(k: K) => (v: GameSettings[K]): void => this.store.set(k, v);
    const box = h('div', { class: 'menu-col' });
    switch (this.tab) {
      case 'graphics':
        box.append(
          select<GraphicsQuality>('Quality', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], () => s.graphics, set('graphics')),
          h('p', { class: 'menu-sub' }, 'Quality changes resolution, shadows, view distance, clouds and the number of trees. Resolution also adapts automatically to keep the game smooth. Anti-aliasing (High only) applies after reloading the page.'),
                    h('h3', {}, 'HUD'),
                    select<GameSettings['hudLayout']>('Instruments', [['detailed', 'Detailed'], ['compact', 'Compact']], () => s.hudLayout, set('hudLayout')),
                    slider('HUD scale', 0.75, 1.5, 0.05, () => s.hudScale, set('hudScale'), (v) => `${Math.round(v * 100)}%`),
                    h('p', { class: 'menu-sub' }, 'Compact shows speed, height above ground, throttle, health and gear/brake. Warnings, gate guidance and the race clock always stay. The HUD shrinks automatically in small windows.'),
          h('h3', {}, 'Radar'),
          checkbox('Show radar', () => s.showRadar, set('showRadar')),
          select<string>('Radar range', [['2000', '2 km'], ['5000', '5 km'], ['10000', '10 km'], ['20000', '20 km']], () => String(s.radarRange), (v) => this.store.set('radarRange', Number(v))),
          h('p', { class: 'menu-sub' }, 'Heading-up radar in every flying mode: gates, other jets, missiles and the dogfight zone. The radar zoom key cycles the range in flight.'),
        );
        break;
      case 'audio':
        box.append(
          slider('Master volume', 0, 1, 0.05, () => s.masterVolume, set('masterVolume'), (v) => `${Math.round(v * 100)}%`),
          slider('Engine', 0, 1, 0.05, () => s.engineVolume, set('engineVolume'), (v) => `${Math.round(v * 100)}%`),
          slider('Effects', 0, 1, 0.05, () => s.effectsVolume, set('effectsVolume'), (v) => `${Math.round(v * 100)}%`),
          slider('Warnings', 0, 1, 0.05, () => s.warningsVolume, set('warningsVolume'), (v) => `${Math.round(v * 100)}%`),
          h('p', { class: 'menu-sub' }, 'Engine is your own jet. Effects covers gates, crashes, countdown and other aircraft flying past. Warnings (stall, pull up) briefly turn the engine and effects down so they stay clear.'),
        );
        break;
      case 'controls':
        box.append(
          slider('Stick sensitivity', 0.3, 1.5, 0.05, () => s.stickSensitivity, set('stickSensitivity'), (v) => v.toFixed(2)),
          checkbox('Invert pitch (W = nose up)', () => s.invertPitch, set('invertPitch')),
          checkbox('Mouse flight (click to lock)', () => s.mouseFlight, set('mouseFlight')),
          slider('Mouse sensitivity', 0.2, 3, 0.1, () => s.mouseSensitivity, set('mouseSensitivity'), (v) => v.toFixed(1)),
          slider('Gamepad dead zone', 0, 0.4, 0.01, () => s.gamepadDeadZone, set('gamepadDeadZone'), (v) => v.toFixed(2)),
          slider('Gamepad curve (expo)', 0, 1, 0.05, () => s.gamepadExpo, set('gamepadExpo'), (v) => v.toFixed(2)),
          this.throttleSection(),
          h('h3', {}, 'Keyboard'),
          ...(Object.keys(KEY_BINDINGS) as InputAction[]).map((a) => this.keyRow(a, redraw)),
        );
        break;
      case 'world':
        box.append(
          slider('Time of day', 0, 24, 0.25, () => s.timeOfDay, set('timeOfDay'), (v) => `${Math.floor(v)}:${String(Math.round((v % 1) * 60)).padStart(2, '0')}`),
          slider('Clouds', 0, 1, 0.05, () => s.cloudCoverage, set('cloudCoverage'), (v) => `${Math.round(v * 100)}%`),
          slider('Wind speed', 0, 25, 1, () => s.windSpeed, set('windSpeed'), (v) => `${v} m/s`),
          slider('Wind direction', 0, 359, 1, () => s.windDirection, set('windDirection'), (v) => `${v}°`),
          slider('Turbulence', 0, 1, 0.05, () => s.turbulence, set('turbulence'), (v) => `${Math.round(v * 100)}%`),
        );
        break;
    }
    return box;
  }

  /** HOTAS throttle lever: mode, axis, inversion, live indicator and two-step calibration. */
  private throttleSection(): HTMLElement {
    const s = this.store.values;
    const live = h('span', { class: 'menu-value', 'aria-live': 'off' }, '—');
    const status = h('span', { class: 'menu-sub' });
    const actions = h('span', {});
    const fmt = (v: number): string => (v >= 0 ? '+' : '') + v.toFixed(2);

    let captured: number | null = null;
    const idle = (): void => {
      captured = null;
      actions.replaceChildren(
        button('Calibrate', () => step(), 'small'),
        ' ',
        button('Reset calibration', () => {
          this.store.set('throttleMin', -1);
          this.store.set('throttleMax', 1);
          this.store.set('throttleInvert', false);
          invertBox.checked = false;
          status.textContent = 'Calibration reset to the full axis range.';
        }, 'small'),
      );
    };
    const step = (): void => {
      if (captured === null) {
        status.textContent = 'Move the lever to IDLE (fully back), then press Capture.';
        actions.replaceChildren(button('Capture idle', capture, 'small'), ' ', button('Cancel', cancel, 'small'));
      } else {
        status.textContent = 'Now move the lever to FULL throttle (fully forward), then press Capture.';
        actions.replaceChildren(button('Capture full', capture, 'small'), ' ', button('Cancel', cancel, 'small'));
      }
    };
    const capture = (): void => {
      const raw = this.input.throttleLeverRaw;
      if (raw === null) {
        status.textContent = `No controller axis ${s.throttleAxis} detected – connect the throttle and move it or press one of its buttons.`;
        return;
      }
      if (captured === null) {
        captured = raw;
        step();
        return;
      }
      if (Math.abs(raw - captured) < 0.05) {
        status.textContent = 'The lever barely moved – check the selected axis and try again.';
        return;
      }
      this.store.set('throttleMin', captured);
      this.store.set('throttleMax', raw);
      // The captured direction already defines idle and full.
      this.store.set('throttleInvert', false);
      invertBox.checked = false;
      status.textContent = `Calibrated: idle ${fmt(captured)}, full ${fmt(raw)}.`;
      idle();
    };
    const cancel = (): void => {
      status.textContent = '';
      idle();
    };

    const invertField = checkbox('Reverse throttle lever', () => s.throttleInvert, (v) => this.store.set('throttleInvert', v));
    const invertBox = invertField.querySelector('input')!;
    const axisOptions = Array.from({ length: 8 }, (_, i): [string, string] => [String(i), `Axis ${i}`]);

    const section = h(
      'div',
      { class: 'menu-col' },
      h('h3', {}, 'Throttle (HOTAS)'),
      select<'rate' | 'lever'>(
        'Throttle mode',
        [['rate', 'Rate – keys / triggers / wheel'], ['lever', 'Lever – physical throttle axis']],
        () => s.throttleMode,
        (v) => this.store.set('throttleMode', v),
      ),
      select('Throttle axis', axisOptions, () => String(s.throttleAxis), (v) => this.store.set('throttleAxis', Number(v))),
      invertField,
      h('label', { class: 'menu-field' }, h('span', {}, 'Lever input'), live),
      h('div', { class: 'menu-row' }, actions),
      status,
      h('p', { class: 'menu-sub' }, 'Lever mode makes the lever the only throttle control. If it disconnects, the current throttle is kept and the keyboard / trigger throttle takes over.'),
    );
    idle();

    // Live raw / mapped readout while the panel is on screen; stops once it is removed.
    let attached = false;
    let frames = 0;
    const tick = (): void => {
      if (section.isConnected) attached = true;
      else if (attached || ++frames > 120) return;
      const raw = this.input.throttleLeverRaw;
      const mapped = this.input.throttleLever;
      live.textContent = raw === null || mapped === null ? 'No axis detected' : `raw ${fmt(raw)} → ${Math.round(mapped * 100)}%`;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return section;
  }

  private keyRow(action: InputAction, redraw: () => void): HTMLElement {
    const keys = this.bindings.get(action);
    const capture = (slot: number) => (): void => {
      this.input.cancelKeyCapture();
      const previous = [...status.childNodes];
      status.textContent = 'Press a key…';
      this.input.captureCancelled = () => status.replaceChildren(...previous);
      this.input.captureNextKey = (code) => {
        if (!status.isConnected) return;
        if (code !== 'Escape') this.bindings.rebind(action, slot, code);
        redraw();
      };
    };
    const status = h('span', {}, ...keys.map((k) => h('kbd', {}, keyLabel(k))));
    return h(
      'div',
      { class: 'keybind-row' },
      h('span', {}, ACTION_LABELS[action]),
      status,
      h('span', {}, button('Change', capture(0), 'small'), ' ', button('+ Add', capture(keys.length), 'small')),
    );
  }
}
