import { Vector3, type PerspectiveCamera } from 'three';
import type { RingShape } from '../world/rings/ringMath';
import { formatTurnCue, gateSequence, nextTurnCue, placeIndicator, type IndicatorBox, type Rect } from './navMath';

export interface NavTarget {
  gates: readonly RingShape[];
  gateIndex: number;
  lap: number;
  laps: number;
  loop: boolean;
  /** The aircraft position (distances and the first gate's approach are measured from it). */
  position: Vector3;
}

/** HUD elements the indicator must never cover (only visible ones count). */
const OBSTACLES = '.hud-instruments, .hud-top, .hud-warn, .hud-center, .hud-message.visible, .hud-bottom-right, .hud-help, .race-panel, .race-center';

const ICONS = {
  onscreen: '<svg viewBox="0 0 24 24"><path d="M2 8V2h6M16 2h6v6M22 16v6h-6M8 22H2v-6"/></svg>',
  edge: '<svg viewBox="0 0 24 24"><path class="fill" d="M22 12 6 3l4 9-4 9z"/></svg>',
  behind: '<svg viewBox="0 0 24 24"><path d="M17 21V9a5 5 0 0 0-10 0v6"/><path class="fill" d="m2 13 5 7 5-7z"/></svg>',
};

/** Active-gate marker: on the gate when visible, else an arrow clamped to a free screen edge. */
export class GateNavigator {
  readonly root: HTMLDivElement;
  private readonly inner: HTMLDivElement;
  private readonly icon: HTMLDivElement;
  private readonly label: HTMLDivElement;
  private readonly cue: HTMLDivElement;
  private readonly view = new Vector3();
  private obstacles: Rect[] = [];
  private box: IndicatorBox = { w: 160, h: 64, anchorY: 14 };
  private measureTimer = 0;
  private kind = '';
  private side = 0;
  private visible = false;
  private scale = 1;

  constructor(private readonly container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud-nav';
    this.root.innerHTML = '<div class="hud-nav-inner"><div class="hud-nav-icon"></div><div class="hud-nav-label"></div><div class="hud-nav-cue"></div></div>';
    this.inner = this.root.querySelector('.hud-nav-inner')!;
    this.icon = this.root.querySelector('.hud-nav-icon')!;
    this.label = this.root.querySelector('.hud-nav-label')!;
    this.cue = this.root.querySelector('.hud-nav-cue')!;
    this.root.style.display = 'none';
  }

  setScale(scale: number): void {
    this.scale = scale;
    this.measureTimer = 0;
  }

  /** Call every frame after the camera moved; `target` null hides the indicator. */
  update(camera: PerspectiveCamera, target: NavTarget | null, dt: number): void {
    if (!target || target.gates.length === 0) {
      this.setVisible(false);
      return;
    }
    const { gates, position } = target;
    const seq = gateSequence(gates.length, target.gateIndex, target.lap, target.laps, target.loop);
    const gate = gates[seq.next]!;

    const dist = gate.center.distanceTo(position);
    const distText = dist >= 1000 ? `${(dist / 1000).toFixed(1)} km` : `${Math.round(dist / 10) * 10} m`;
    const name = seq.final ? 'FINISH' : `GATE ${seq.next + 1}/${gates.length}`;
    let cue = '';
    if (seq.after !== null) {
      const from = seq.prev !== null ? gates[seq.prev]!.center : position;
      cue = formatTurnCue(nextTurnCue(from, gate.center, gates[seq.after]!.center));
      if (seq.lapWrap) cue = `LAP ${target.lap + 1} · ${cue}`;
    } else cue = 'LAST GATE';

    this.setVisible(true);
    const W = this.container.clientWidth || window.innerWidth;
    const H = this.container.clientHeight || window.innerHeight;
    this.measureTimer -= dt;
    if (this.measureTimer <= 0) {
      this.measure();
      this.measureTimer = 0.25;
    }
    camera.updateMatrixWorld();
    this.view.copy(gate.center).applyMatrix4(camera.matrixWorldInverse);
    const e = camera.projectionMatrix.elements;
    const m = 12 * this.scale;
    const p = placeIndicator(this.view, e[0]!, e[5]!, { width: W, height: H, safe: { left: m, top: m, right: W - m, bottom: H - m }, obstacles: this.obstacles }, this.box);

    const side = p.kind === 'behind' ? p.side : 0;
    if (p.kind !== this.kind || side !== this.side) {
      this.kind = p.kind;
      this.side = side;
      this.root.dataset.kind = p.kind;
      this.root.classList.toggle('right', side > 0);
      this.icon.innerHTML = ICONS[p.kind];
    }
    setText(this.label, p.kind === 'behind' ? `BEHIND · TURN ${p.side < 0 ? 'LEFT' : 'RIGHT'} · ${distText}` : `${name} · ${distText}`);
    setText(this.cue, p.kind === 'behind' ? name : cue);
    this.icon.style.transform = p.kind === 'edge' ? `rotate(${p.angle.toFixed(3)}rad)` : '';
    this.root.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
  }

  private setVisible(v: boolean): void {
    if (v === this.visible) return;
    this.visible = v;
    this.root.style.display = v ? '' : 'none';
    this.measureTimer = 0;
  }

  private measure(): void {
    // The inner box is centered horizontally on the anchor, with the icon's center on it.
    const r = this.inner.getBoundingClientRect();
    const icon = this.icon.getBoundingClientRect();
    if (r.width > 0) this.box = { w: r.width + 8, h: r.height, anchorY: icon.top - r.top + icon.height / 2 };
    this.obstacles = [];
    this.container.querySelectorAll<HTMLElement>(OBSTACLES).forEach((el) => {
      const b = el.getBoundingClientRect();
      if (b.width > 0 && b.height > 0) this.obstacles.push({ left: b.left - 4, top: b.top - 4, right: b.right + 4, bottom: b.bottom + 4 });
    });
  }
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}
