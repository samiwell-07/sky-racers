import './radar.css';
import type { RadarContact, RadarFrame } from './types';
import {
  DEFAULT_RADAR_RANGE,
  altitudeCue,
  circleToRadar,
  clampToRadius,
  nextRadarRange,
  rangeLabel,
  relativeBearing,
  snapRadarRange,
  worldToRadar,
  zoneStatus,
  type RadarCircle,
  type RadarPoint,
  type ZoneStatus,
} from './radarMath';

/** CSS size of the radar (px, before the HUD scale). */
const SIZE = 200;
const CENTER = SIZE / 2;
/** Drawing radius: the range ring sits just inside the bezel. */
const RADIUS = CENTER - 6;
const MIN_FRAME_MS = 1000 / 30;

const COLORS = {
  ring: 'rgba(184, 255, 207, 0.28)',
  ringOuter: 'rgba(184, 255, 207, 0.45)',
  self: '#e9fff1',
  enemy: '#ff4a3d',
  player: '#5aa9ff',
  ai: '#ff9a2e',
  ghost: 'rgba(255, 255, 255, 0.45)',
  gate: '#3fd8e6',
  nextGate: '#8ff6ff',
  missile: '#ffffff',
  incoming: '#ff2a2a',
  flare: '#ffd84a',
  airfield: '#c9d6cf',
  zone: 'rgba(255, 196, 74, 0.8)',
  zoneOut: 'rgba(255, 60, 50, 0.95)',
  zoneTint: 'rgba(255, 40, 30, 0.18)',
  zoneTintOut: 'rgba(255, 40, 30, 0.38)',
  label: 'rgba(233, 255, 241, 0.85)',
  north: 'rgba(184, 255, 207, 0.7)',
} as const;

/** Contacts that stay on the rim as a chevron when beyond the range. */
const CLAMPED: ReadonlySet<RadarContact['kind']> = new Set(['enemy', 'player', 'nextGate', 'incomingMissile', 'pickup']);

/**
 * Round heading-up HUD radar: the player's arrow fixed in the centre pointing up, the world rotating
 * around it. Feed it a RadarFrame every frame; it redraws at most ~30 times per second.
 */
export class Radar {
  readonly root: HTMLDivElement;
  /** Called after cycleRange() / setRange() changes the zoom (e.g. to save it in the settings). */
  onRangeChange: ((meters: number) => void) | null = null;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly rangeEl: HTMLSpanElement;
  private range = DEFAULT_RADAR_RANGE;
  private visible = true;
  private scale = 1;
  private pixelRatio = 0;
  private lastDraw = -Infinity;
  private zoneState: ZoneStatus = 'inside';
  private missileWarn = false;
  private readonly p: RadarPoint = { x: 0, y: 0 };
  private readonly circle: RadarCircle = { x: 0, y: 0, r: 0 };

  constructor(container: HTMLElement, opts: { range?: number; visible?: boolean; scale?: number } = {}) {
    this.root = document.createElement('div');
    this.root.className = 'hud-radar';
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.rangeEl = document.createElement('span');
    this.rangeEl.className = 'hud-radar-range';
    this.root.append(this.canvas, this.rangeEl);
    container.appendChild(this.root);
    this.range = snapRadarRange(opts.range ?? DEFAULT_RADAR_RANGE);
    this.rangeEl.textContent = rangeLabel(this.range);
    this.setScale(opts.scale ?? 1);
    this.setVisible(opts.visible ?? true);
  }

  get rangeMeters(): number {
    return this.range;
  }

  /** Next zoom level (2 → 5 → 10 → 20 km → 2 km); returns the new range in metres. */
  cycleRange(): number {
    this.setRange(nextRadarRange(this.range));
    return this.range;
  }

  setRange(meters: number): void {
    const r = snapRadarRange(meters);
    if (r === this.range) return;
    this.range = r;
    this.rangeEl.textContent = rangeLabel(r);
    this.lastDraw = -Infinity;
    this.onRangeChange?.(r);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.classList.toggle('hidden', !visible);
    this.lastDraw = -Infinity;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /**
   * HUD scale (0.75 - 1.5). The CSS already zooms by var(--hud-scale); this keeps the canvas
   * backing store sharp at that size.
   */
  setScale(scale: number): void {
    this.scale = Number.isFinite(scale) && scale > 0 ? scale : 1;
    this.pixelRatio = 0;
    this.lastDraw = -Infinity;
  }

  /** Draws the frame (throttled to ~30 Hz). `now` in ms, defaults to performance.now(). */
  update(frame: RadarFrame, now = performance.now()): void {
    if (!this.visible || !this.ctx) return;
    if (now - this.lastDraw < MIN_FRAME_MS) return;
    this.lastDraw = now;
    this.syncResolution();
    this.draw(this.ctx, frame, now);
  }

  dispose(): void {
    this.root.remove();
    this.onRangeChange = null;
  }

  private syncResolution(): void {
    const dpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
    const k = Math.min(4, dpr * this.scale);
    if (k === this.pixelRatio) return;
    this.pixelRatio = k;
    this.canvas.width = Math.round(SIZE * k);
    this.canvas.height = Math.round(SIZE * k);
  }

  private setFlags(zone: ZoneStatus, missile: boolean): void {
    if (zone !== this.zoneState) {
      this.zoneState = zone;
      this.root.classList.toggle('zone-out', zone === 'outside');
      this.root.classList.toggle('zone-near', zone === 'near');
    }
    if (missile !== this.missileWarn) {
      this.missileWarn = missile;
      this.root.classList.toggle('missile', missile);
    }
  }

  private draw(ctx: CanvasRenderingContext2D, frame: RadarFrame, now: number): void {
    const k = this.pixelRatio;
    const { self, contacts, zone } = frame;
    const ppm = RADIUS / this.range;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.save();
    ctx.translate(CENTER, CENTER);
    ctx.beginPath();
    ctx.arc(0, 0, RADIUS + 4, 0, Math.PI * 2);
    ctx.clip();

    let zoneState: ZoneStatus = 'inside';
    if (zone) {
      zoneState = zoneStatus(self.x, self.z, zone.cx, zone.cz, zone.radius);
      this.drawZone(ctx, self, zone.cx, zone.cz, zone.radius, ppm, zoneState);
    }
    this.drawGrid(ctx, self.heading);

    let missile = false;
    // Background symbols first so jets and missiles stay readable on top.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < contacts.length; i++) {
        const c = contacts[i]!;
        const background = c.kind === 'gate' || c.kind === 'airfield' || c.kind === 'flare' || c.kind === 'ghost';
        if (background !== (pass === 0)) continue;
        if (c.kind === 'incomingMissile') missile = true;
        this.drawContact(ctx, c, self, ppm, now);
      }
    }
    drawSelf(ctx);
    ctx.restore();
    this.setFlags(zoneState, missile);
  }

  private drawZone(ctx: CanvasRenderingContext2D, self: RadarFrame['self'], cx: number, cz: number, radius: number, ppm: number, state: ZoneStatus): void {
    const c = circleToRadar(self.x, self.z, self.heading, cx, cz, radius, ppm, this.circle);
    // Tint everything outside the zone red (even-odd: radar disk minus the zone disk).
    ctx.beginPath();
    ctx.arc(0, 0, RADIUS + 4, 0, Math.PI * 2);
    ctx.moveTo(c.x + c.r, c.y);
    ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
    ctx.fillStyle = state === 'outside' ? COLORS.zoneTintOut : COLORS.zoneTint;
    ctx.fill('evenodd');
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
    ctx.strokeStyle = state === 'inside' ? COLORS.zone : COLORS.zoneOut;
    ctx.lineWidth = state === 'inside' ? 1.5 : 2.5;
    ctx.stroke();
  }

  private drawGrid(ctx: CanvasRenderingContext2D, heading: number): void {
    ctx.strokeStyle = COLORS.ring;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, RADIUS / 2, 0, Math.PI * 2);
    ctx.moveTo(0, -RADIUS);
    ctx.lineTo(0, RADIUS);
    ctx.moveTo(-RADIUS, 0);
    ctx.lineTo(RADIUS, 0);
    ctx.stroke();
    ctx.strokeStyle = COLORS.ringOuter;
    ctx.beginPath();
    ctx.arc(0, 0, RADIUS, 0, Math.PI * 2);
    ctx.stroke();
    // North (-Z) marker on the rim.
    const p = worldToRadar(0, 0, heading, 0, -1, RADIUS - 9, this.p);
    ctx.fillStyle = COLORS.north;
    ctx.font = 'bold 10px Consolas, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', p.x, p.y);
  }

  private drawContact(ctx: CanvasRenderingContext2D, c: RadarContact, self: RadarFrame['self'], ppm: number, now: number): void {
    const p = worldToRadar(self.x, self.z, self.heading, c.x, c.z, ppm, this.p);
    const d2 = p.x * p.x + p.y * p.y;
    if (d2 > RADIUS * RADIUS) {
      if (!CLAMPED.has(c.kind)) return;
      clampToRadius(p, RADIUS - 5);
      const blink = c.kind === 'incomingMissile' ? flash(now) : 1;
      drawChevron(ctx, p.x, p.y, c.color ?? colorOf(c.kind), blink);
      return;
    }
    const rot = c.heading === undefined ? 0 : relativeBearing(c.heading, self.heading);
    switch (c.kind) {
      case 'enemy':
      case 'player':
      case 'ai':
      case 'ghost': {
        const size = c.kind === 'ghost' ? 4.5 : c.kind === 'enemy' ? 6.5 : 5.5;
        drawArrow(ctx, p.x, p.y, rot, size, colorOf(c.kind));
        if (c.kind !== 'ghost') drawAltitudeCue(ctx, p.x + size + 3, p.y, altitudeCue(c.y - self.y), colorOf(c.kind));
        if (c.label && c.kind === 'player') drawLabel(ctx, c.label, p.x, p.y + size + 7);
        break;
      }
      case 'gate':
      case 'nextGate': {
        const next = c.kind === 'nextGate';
        ctx.globalAlpha = next ? 0.6 + 0.4 * Math.sin(now * 0.008) : 0.75;
        drawBar(ctx, p.x, p.y, rot, next ? 7 : 4.5, next ? 3 : 2, colorOf(c.kind));
        ctx.globalAlpha = 1;
        break;
      }
      case 'missile':
        drawDot(ctx, p.x, p.y, 1.8, COLORS.missile);
        break;
      case 'incomingMissile':
        ctx.globalAlpha = flash(now);
        drawDot(ctx, p.x, p.y, 3, COLORS.incoming);
        ctx.globalAlpha = 1;
        break;
      case 'flare':
        drawDot(ctx, p.x, p.y, 1.1, COLORS.flare);
        break;
      case 'pickup':
        drawDot(ctx, p.x, p.y, 3.5, c.color ?? colorOf(c.kind));
        break;
      case 'airfield':
        drawRunway(ctx, p.x, p.y, rot, Math.max(5, Math.min(16, 1500 * ppm)));
        if (c.label) drawLabel(ctx, c.label, p.x, p.y + 12);
        break;
    }
  }
}

function colorOf(kind: RadarContact['kind']): string {
  switch (kind) {
    case 'enemy': return COLORS.enemy;
    case 'player': return COLORS.player;
    case 'ai': return COLORS.ai;
    case 'ghost': return COLORS.ghost;
    case 'gate': return COLORS.gate;
    case 'nextGate': return COLORS.nextGate;
    case 'missile': return COLORS.missile;
    case 'incomingMissile': return COLORS.incoming;
    case 'flare': return COLORS.flare;
    case 'pickup': return '#ffffff';
    case 'airfield': return COLORS.airfield;
  }
}

/** 1 / 0.25 square wave at ~3.3 Hz. */
function flash(now: number): number {
  return Math.floor(now / 150) % 2 === 0 ? 1 : 0.25;
}

function drawSelf(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath();
  ctx.moveTo(0, -8);
  ctx.lineTo(6, 6);
  ctx.lineTo(0, 3);
  ctx.lineTo(-6, 6);
  ctx.closePath();
  ctx.fillStyle = COLORS.self;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();
}

function drawArrow(ctx: CanvasRenderingContext2D, x: number, y: number, rot: number, s: number, color: string): void {
  const c = Math.cos(rot) * s;
  const sn = Math.sin(rot) * s;
  // Up-pointing arrow (local units of s), rotated clockwise by `rot`: (lx, ly) → (lx·c − ly·sn, lx·sn + ly·c).
  ctx.beginPath();
  ctx.moveTo(x + sn, y - c);
  ctx.lineTo(x + 0.75 * c - 0.8 * sn, y + 0.75 * sn + 0.8 * c);
  ctx.lineTo(x - 0.3 * sn, y + 0.3 * c);
  ctx.lineTo(x - 0.75 * c - 0.8 * sn, y - 0.75 * sn + 0.8 * c);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function drawBar(ctx: CanvasRenderingContext2D, x: number, y: number, rot: number, halfLen: number, width: number, color: string): void {
  // Gates are drawn across the flight direction.
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  ctx.beginPath();
  ctx.moveTo(x - c * halfLen, y - s * halfLen);
  ctx.lineTo(x + c * halfLen, y + s * halfLen);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.lineCap = 'butt';
}

function drawRunway(ctx: CanvasRenderingContext2D, x: number, y: number, rot: number, halfLen: number): void {
  // Runway along its heading (up when rot = 0), with a centre-line gap.
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const ux = s * halfLen;
  const uy = -c * halfLen;
  ctx.beginPath();
  ctx.moveTo(x - ux, y - uy);
  ctx.lineTo(x + ux, y + uy);
  ctx.strokeStyle = COLORS.airfield;
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - ux * 0.7, y - uy * 0.7);
  ctx.lineTo(x + ux * 0.7, y + uy * 0.7);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawDot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

/** Small chevron on the rim pointing outward, toward an off-range contact. */
function drawChevron(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, alpha: number): void {
  const len = Math.hypot(x, y) || 1;
  const ox = x / len;
  const oy = y / len;
  const s = 5;
  ctx.beginPath();
  ctx.moveTo(x - ox * s - oy * s, y - oy * s + ox * s);
  ctx.lineTo(x, y);
  ctx.lineTo(x - ox * s + oy * s, y - oy * s - ox * s);
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** ▲ above / ▼ below the player (cue = 1 / -1). */
function drawAltitudeCue(ctx: CanvasRenderingContext2D, x: number, y: number, cue: -1 | 0 | 1, color: string): void {
  if (cue === 0) return;
  const s = 3;
  ctx.beginPath();
  ctx.moveTo(x, y - cue * s);
  ctx.lineTo(x + s, y + cue * s);
  ctx.lineTo(x - s, y + cue * s);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.font = '9px Consolas, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = COLORS.label;
  ctx.fillText(text.length > 10 ? text.slice(0, 10) : text, x, y);
}
