import {
  CanvasTexture,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Sprite,
  SpriteMaterial,
  TorusGeometry,
  Vector3,
} from 'three';
import { mulberry32 } from '../../utils/random';
import { closestApproach } from '../../combat/math';
import type { DogfightZone } from './zone';

export type PickupKind = 'health' | 'missile' | 'flare';

/** Reward range of each gate kind (rolled per gate, in `step`s), and its colour. */
export const PICKUP_REWARDS: Readonly<Record<PickupKind, { min: number; max: number; step: number; color: string }>> = {
  health: { min: 0.15, max: 0.25, step: 0.05, color: '#2bff5a' },
  missile: { min: 1, max: 3, step: 1, color: '#ff2a2a' },
  flare: { min: 6, max: 14, step: 2, color: '#2a8cff' },
};

/** Text shown over a gate, e.g. "+20% HEALTH", "+2 MISSILES". */
export function pickupLabel(kind: PickupKind, amount: number): string {
  if (kind === 'health') return `+${Math.round(amount * 100)}% HEALTH`;
  if (kind === 'missile') return `+${amount} MISSILE${amount === 1 ? '' : 'S'}`;
  return `+${amount} FLARE${amount === 1 ? '' : 'S'}`;
}

export const PICKUP_RULES = {
  /** Gates on the map at once. */
  maxGates: 2,
  /** Ring radius (m): flying within it of the centre takes the gate. */
  radius: 35,
  /** Seconds before a taken gate is replaced by a new one. */
  respawnDelay: 6,
  /** Height above the ground (m). */
  minAgl: 200,
  maxAgl: 700,
  /** Gates stay this far inside the zone (fraction of its radius). */
  zoneFraction: 0.75,
} as const;

const KINDS: readonly PickupKind[] = ['health', 'missile', 'flare'];

export interface PickupGate {
  readonly id: number;
  readonly kind: PickupKind;
  /** Reward of this gate (health fraction, missiles or flares). */
  readonly amount: number;
  readonly label: string;
  readonly position: Vector3;
  /** Yaw (rad) of the ring's facing. */
  readonly yaw: number;
}

/**
 * The dogfight's pickup gates: at most maxGates at once, placed at random (seeded) inside the zone.
 * Fly through one to get its reward; a new gate replaces it after respawnDelay.
 */
export class PickupField {
  readonly gates: PickupGate[] = [];
  private readonly rng: () => number;
  private pending: number[] = [];
  private nextId = 1;
  private readonly prev = new Vector3();
  private hasPrev = false;

  constructor(
    private readonly zone: DogfightZone,
    private readonly surfaceHeight: (x: number, z: number) => number,
    seed: number,
  ) {
    this.rng = mulberry32(seed ^ 0x9e3779b9);
    for (let i = 0; i < PICKUP_RULES.maxGates; i++) this.gates.push(this.spawn());
  }

  /** Every fixed step with the local jet's position; returns the gates taken during the step. */
  update(dt: number, position: Vector3, alive: boolean): PickupGate[] {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      this.pending[i]! -= dt;
      if (this.pending[i]! <= 0) {
        this.pending.splice(i, 1);
        this.gates.push(this.spawn());
      }
    }
    const taken: PickupGate[] = [];
    if (alive && this.hasPrev) {
      for (let i = this.gates.length - 1; i >= 0; i--) {
        const g = this.gates[i]!;
        if (closestApproach(this.prev, position, g.position, g.position).distance > PICKUP_RULES.radius) continue;
        this.gates.splice(i, 1);
        this.pending.push(PICKUP_RULES.respawnDelay);
        taken.push(g);
      }
    }
    this.prev.copy(position);
    this.hasPrev = alive;
    return taken;
  }

  private spawn(): PickupGate {
    const r = PICKUP_RULES;
    const a = this.rng() * Math.PI * 2;
    const d = Math.sqrt(this.rng()) * this.zone.radius * r.zoneFraction;
    const x = this.zone.cx + Math.cos(a) * d;
    const z = this.zone.cz + Math.sin(a) * d;
    const ground = this.surfaceHeight(x, z);
    const y = Math.min(this.zone.ceiling - 150, ground + r.minAgl + this.rng() * (r.maxAgl - r.minAgl));
    const kind = KINDS[Math.floor(this.rng() * KINDS.length)] ?? 'health';
    const rw = PICKUP_REWARDS[kind];
    const steps = Math.round((rw.max - rw.min) / rw.step);
    const amount = Math.round((rw.min + Math.floor(this.rng() * (steps + 1)) * rw.step) * 100) / 100;
    return {
      id: this.nextId++,
      kind,
      amount,
      label: pickupLabel(kind, amount),
      position: new Vector3(x, Math.max(y, ground + r.minAgl), z),
      yaw: this.rng() * Math.PI,
    };
  }
}

function labelTexture(text: string, color: string): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.font = 'bold 72px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 10;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(text, 256, 64);
  ctx.fillStyle = color;
  ctx.fillText(text, 256, 64);
  return new CanvasTexture(canvas);
}

function iconTexture(kind: PickupKind, color: string): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.lineWidth = 8;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  if (kind === 'health') {
    ctx.moveTo(128, 214);
    ctx.bezierCurveTo(40, 150, 20, 100, 44, 66);
    ctx.bezierCurveTo(70, 30, 120, 40, 128, 84);
    ctx.bezierCurveTo(136, 40, 186, 30, 212, 66);
    ctx.bezierCurveTo(236, 100, 216, 150, 128, 214);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
  } else if (kind === 'missile') {
    // Nose up: body, ogive nose and tail fins.
    ctx.moveTo(128, 20);
    ctx.quadraticCurveTo(152, 44, 150, 76);
    ctx.lineTo(150, 176);
    ctx.lineTo(190, 222);
    ctx.lineTo(150, 214);
    ctx.lineTo(150, 230);
    ctx.lineTo(106, 230);
    ctx.lineTo(106, 214);
    ctx.lineTo(66, 222);
    ctx.lineTo(106, 176);
    ctx.lineTo(106, 76);
    ctx.quadraticCurveTo(104, 44, 128, 20);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(106, 120);
    ctx.lineTo(80, 150);
    ctx.lineTo(106, 150);
    ctx.moveTo(150, 120);
    ctx.lineTo(176, 150);
    ctx.lineTo(150, 150);
    ctx.stroke();
    ctx.fill();
  } else {
    // Flare: a bright burst with a falling smoke trail.
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const r = i % 2 === 0 ? 70 : 32;
      const x = 128 + Math.cos(a) * r;
      const y = 100 + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
    ctx.beginPath();
    ctx.arc(128, 100, 22, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.fillStyle = color;
    for (const [x, y, r] of [[118, 182, 14], [138, 210, 11], [124, 236, 8]] as const) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fill();
    }
  }
  return new CanvasTexture(canvas);
}

/** Rings + icons + floating labels of the PickupField; add `group` to the scene and call sync() every frame. */
export class PickupGatesView {
  readonly group = new Group();
  private readonly meshes = new Map<number, Group>();
  private readonly ring = new TorusGeometry(PICKUP_RULES.radius, 3, 12, 48);
  private readonly materials = new Map<PickupKind, { ring: MeshBasicMaterial; icon: SpriteMaterial }>();
  private readonly labels = new Map<string, SpriteMaterial>();
  private time = 0;

  constructor() {
    this.group.name = 'dogfight-pickups';
    for (const k of KINDS) {
      const { color } = PICKUP_REWARDS[k];
      this.materials.set(k, {
        ring: new MeshBasicMaterial({ color, side: DoubleSide, transparent: true, opacity: 0.9 }),
        icon: new SpriteMaterial({ map: iconTexture(k, color), transparent: true }),
      });
    }
  }

  private labelMaterial(g: PickupGate): SpriteMaterial {
    let m = this.labels.get(g.label);
    if (!m) {
      m = new SpriteMaterial({ map: labelTexture(g.label, PICKUP_REWARDS[g.kind].color), depthTest: false, transparent: true });
      this.labels.set(g.label, m);
    }
    return m;
  }

  sync(dt: number, gates: readonly PickupGate[]): void {
    this.time += dt;
    const live = new Set(gates.map((g) => g.id));
    for (const [id, obj] of this.meshes) {
      if (live.has(id)) continue;
      obj.removeFromParent();
      this.meshes.delete(id);
    }
    for (const g of gates) {
      let obj = this.meshes.get(g.id);
      if (!obj) {
        const m = this.materials.get(g.kind)!;
        obj = new Group();
        const ring = new Mesh(this.ring, m.ring);
        ring.rotation.y = g.yaw;
        const label = new Sprite(this.labelMaterial(g));
        label.scale.set(120, 30, 1);
        label.position.y = PICKUP_RULES.radius + 30;
        label.renderOrder = 10;
        const icon = new Sprite(m.icon);
        icon.scale.setScalar(PICKUP_RULES.radius * 1.2);
        obj.add(ring, label, icon);
        obj.position.copy(g.position);
        this.group.add(obj);
        this.meshes.set(g.id, obj);
      }
      obj.children[0]!.rotation.y = g.yaw + this.time * 0.6;
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    this.ring.dispose();
    for (const m of this.materials.values()) {
      m.ring.dispose();
      m.icon.map?.dispose();
      m.icon.dispose();
    }
    for (const m of this.labels.values()) {
      m.map?.dispose();
      m.dispose();
    }
  }
}
