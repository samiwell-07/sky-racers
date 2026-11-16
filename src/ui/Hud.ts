import { ACTION_LABELS, type InputAction } from '../config/controlsConfig';
import { keyLabel, type KeyBindings } from '../input/KeyBindings';
import type { GameSettings } from '../settings/Settings';
import { GateNavigator } from './GateNavigator';
import './hud.css';

export type GamePhase = 'ready' | 'flying' | 'paused' | 'crashed';
export type HudLayout = GameSettings['hudLayout'];

/** Window size (px) at which the HUD fits at 100%; smaller windows cap the HUD scale. */
const HUD_FIT_WIDTH = 760;
const HUD_FIT_HEIGHT = 440;

export interface HudData {
  phase: GamePhase;
  speed: number;
  altitude: number;
  agl: number;
  verticalSpeed: number;
  heading: number;
  throttle: number;
  afterburner: boolean;
  gLoad: number;
  aoa: number;
  stallWarning: boolean;
  pullUp: boolean;
  ringsPassed: number;
  ringsTotal: number;
  nextRingDistance: number | null;
  flightTime: number;
  cameraMode: string;
  respawnIn: number;
  health: number;
  gearDown: boolean;
  airbrake: boolean;
  /** Free flight shows the practice gates; races use the race panel instead. */
  showRings: boolean;
}

const HELP_ACTIONS: InputAction[] = [
  'pitchDown', 'pitchUp', 'rollLeft', 'rollRight', 'throttleUp', 'throttleDown', 'airbrake', 'toggleGear', 'toggleLights',
  'toggleCamera', 'respawn', 'pause', 'toggleHelp', 'fullscreen',
];
export const formatTime = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
};

/** DOM overlay showing flight instruments, warnings, ring progress and help. */
export class Hud {
  /** Active-gate indicator; fed every frame by the game. */
  readonly nav: GateNavigator;
  private readonly root: HTMLDivElement;
  private readonly el: Record<string, HTMLElement> = {};
  private messageTimer = 0;
  private layout: HudLayout = 'detailed';
  private userScale = 1;

  constructor(container: HTMLElement, private readonly bindings: KeyBindings) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="hud-instruments" data-el="instruments">
        <div class="hud-panel hud-left">
          <div class="hud-rows">
            <div class="hud-row"><span>SPD</span><b data-el="speed">0</b><i>km/h</i></div>
            <div class="hud-row hud-detail"><span>ALT</span><b data-el="altitude">0</b><i>m</i></div>
            <div class="hud-row"><span>AGL</span><b data-el="agl">0</b><i>m</i></div>
            <div class="hud-row hud-detail"><span>V/S</span><b data-el="vs">0</b><i>m/s</i></div>
            <div class="hud-row hud-detail"><span>HDG</span><b data-el="heading">000</b><i>°</i></div>
            <div class="hud-row hud-detail"><span>G</span><b data-el="g">1.0</b><i></i></div>
            <div class="hud-row hud-detail"><span>AoA</span><b data-el="aoa">0</b><i>°</i></div>
            <div class="hud-row"><span>HP</span><b data-el="health">100</b><i>%</i></div>
          </div>
          <div class="hud-flags"><span data-el="gear">GEAR</span> <span data-el="brake">BRAKE</span></div>
        </div>
        <div class="hud-throttle">
          <div class="hud-throttle-bar"><div data-el="throttleFill"></div></div>
          <div class="hud-throttle-label"><b data-el="throttle">0</b>%<div data-el="ab" class="hud-ab">AB</div></div>
        </div>
      </div>
      <div class="hud-panel hud-top" data-el="top">
        <div>RINGS <b data-el="rings">0/0</b></div>
        <div data-el="nextRing"></div>
        <div>TIME <b data-el="time">0:00.0</b></div>
      </div>
      <div class="hud-warnings">
        <div data-el="pullUp" class="hud-warn hud-pullup">PULL UP</div>
        <div data-el="stall" class="hud-warn hud-stall">STALL</div>
      </div>
      <div data-el="center" class="hud-center"></div>
      <div data-el="message" class="hud-message"></div>
      <div class="hud-bottom-right"><span data-el="camera">CHASE</span> · <kbd>H</kbd> help</div>
      <div data-el="help" class="hud-help hidden">
        <h2>Controls</h2>
        <p>No rudder: bank and pull to turn. Fly low through the gates.</p>
        <table data-el="helpTable"></table>
      </div>`;
    this.root.querySelectorAll<HTMLElement>('[data-el]').forEach((e) => (this.el[e.dataset.el!] = e));
    this.nav = new GateNavigator(container);
    this.root.appendChild(this.nav.root);
    container.appendChild(this.root);
    window.addEventListener('resize', () => this.applyScale());
    this.applyScale();
  }

  /** Instrument set and HUD scale (0.75 - 1.5); the scale shrinks automatically when the window is too small. */
  setLayout(layout: HudLayout, scale: number): void {
    this.layout = layout;
    this.userScale = Math.min(1.5, Math.max(0.75, Number.isFinite(scale) ? scale : 1));
    this.root.classList.toggle('compact', layout === 'compact');
    this.applyScale();
  }

  private applyScale(): void {
    const fit = Math.min(window.innerWidth / HUD_FIT_WIDTH, window.innerHeight / HUD_FIT_HEIGHT);
    const scale = Math.min(this.userScale, Math.max(0.5, fit));
    document.documentElement.style.setProperty('--hud-scale', scale.toFixed(3));
    this.nav.setScale(scale);
    // Short windows: wrap the instrument rows into two columns instead of running into the top panels.
    const rowsHeight = (this.layout === 'compact' ? 3 : 8) * 22.5 * scale;
    this.root.classList.toggle('wrap', rowsHeight > window.innerHeight * 0.4);
  }

  get helpVisible(): boolean {
    return !this.el.help!.classList.contains('hidden');
  }

  setHelpVisible(visible: boolean): void {
    if (visible) {
      this.el.helpTable!.innerHTML = HELP_ACTIONS.map(
        (a) => `<tr><td>${this.bindings.get(a).map((c) => `<kbd>${keyLabel(c)}</kbd>`).join(' ')}</td><td>${ACTION_LABELS[a]}</td></tr>`,
      ).join('');
    }
    this.el.help!.classList.toggle('hidden', !visible);
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none';
  }


  showMessage(text: string, seconds = 2.5): void {
    this.el.message!.textContent = text;
    this.el.message!.classList.add('visible');
    this.messageTimer = seconds;
  }

  update(d: HudData, dt: number): void {
    const e = this.el;
    e.speed!.textContent = Math.round(d.speed * 3.6).toString();
    e.altitude!.textContent = Math.round(d.altitude).toString();
    e.agl!.textContent = Math.max(0, Math.round(d.agl)).toString();
    e.agl!.classList.toggle('low', d.agl < 30);
    e.vs!.textContent = (d.verticalSpeed >= 0 ? '+' : '') + d.verticalSpeed.toFixed(0);
    e.heading!.textContent = Math.round(((d.heading % 360) + 360) % 360).toString().padStart(3, '0');
    e.g!.textContent = d.gLoad.toFixed(1);
    e.aoa!.textContent = d.aoa.toFixed(1);
    e.throttle!.textContent = Math.round(d.throttle * 100).toString();
    e.throttleFill!.style.height = `${d.throttle * 100}%`;
    e.throttleFill!.classList.toggle('ab', d.afterburner);
    e.ab!.classList.toggle('visible', d.afterburner);
    e.rings!.textContent = `${d.ringsPassed}/${d.ringsTotal}`;
    e.nextRing!.textContent = d.nextRingDistance !== null ? `NEXT ${Math.round(d.nextRingDistance)} m` : 'ALL CLEAR';
    e.time!.textContent = formatTime(d.flightTime);
    e.camera!.textContent = d.cameraMode.toUpperCase();
    e.top!.style.display = d.showRings ? '' : 'none';
    e.health!.textContent = Math.round(d.health * 100).toString();
    e.health!.classList.toggle('low', d.health < 0.5);
    e.gear!.classList.toggle('on', d.gearDown);
    e.brake!.classList.toggle('on', d.airbrake);

    const flying = d.phase === 'flying';
    e.pullUp!.classList.toggle('visible', flying && d.pullUp);
    e.stall!.classList.toggle('visible', flying && d.stallWarning);

    let center = '';
    if (d.phase === 'paused') center = 'PAUSED';
    else if (d.phase === 'crashed') center = `CRASHED<small>Respawn in ${d.respawnIn.toFixed(1)} s</small>`;
    if (e.center!.innerHTML !== center) e.center!.innerHTML = center;

    if (this.messageTimer > 0) {
      this.messageTimer -= dt;
      if (this.messageTimer <= 0) e.message!.classList.remove('visible');
    }
  }
}
