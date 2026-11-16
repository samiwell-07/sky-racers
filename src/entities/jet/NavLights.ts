import { AdditiveBlending, CanvasTexture, Color, Group, Sprite, SpriteMaterial, type Texture } from 'three';

let glowTexture: Texture | null = null;
function getGlowTexture(): Texture | null {
  if (glowTexture || typeof document === 'undefined') return glowTexture;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.2, 'rgba(255,255,255,0.8)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.15)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  glowTexture = new CanvasTexture(canvas);
  return glowTexture;
}

type Blink = 'steady' | 'strobe' | 'beacon';

interface Lamp {
  sprite: Sprite;
  blink: Blink;
  size: number;
  phase: number;
}

/**
 * Aircraft position LEDs (no light is cast, they only show where the jet's parts are):
 * red left / green right wingtips, white tail LEDs, white wingtip strobes (double flash),
 * red blinking beacons on the belly and spine, and a small blinking white nose LED.
 * They are cheap additive sprites, so they cost almost nothing to draw.
 */
export class NavLights {
  readonly group = new Group();
  private readonly lamps: Lamp[] = [];
  on = true;

  constructor() {
    const add = (x: number, y: number, z: number, color: string, blink: Blink, size: number, phase = 0): void => {
      const sprite = new Sprite(
        new SpriteMaterial({ map: getGlowTexture(), color: new Color(color), blending: AdditiveBlending, depthWrite: false, fog: false, transparent: true }),
      );
      sprite.position.set(x, y, z);
      sprite.renderOrder = 11;
      this.group.add(sprite);
      this.lamps.push({ sprite, blink, size, phase });
    };
    add(-6.75, 0.05, 4.1, '#ff2a2a', 'steady', 1.6); // left nav (red)
    add(6.75, 0.05, 4.1, '#2aff5a', 'steady', 1.6); // right nav (green)
    add(-2.25, 3.75, 7.6, '#ffffff', 'steady', 1.1); // tail lights
    add(2.25, 3.75, 7.6, '#ffffff', 'steady', 1.1);
    add(-6.75, 0.05, 4.4, '#ffffff', 'strobe', 4.5); // wingtip strobes
    add(6.75, 0.05, 4.4, '#ffffff', 'strobe', 4.5, 0.05);
    add(0, -0.95, 0.5, '#ff3020', 'beacon', 2.6); // belly beacon
    add(0, 1.15, 1.5, '#ff3020', 'beacon', 2.2, 0.5); // spine beacon
    add(0, -0.35, -9.9, '#ffffff', 'beacon', 0.9, 0.25); // nose LED
  }

  toggle(): boolean {
    this.on = !this.on;
    return this.on;
  }

  /** Frees the per-lamp materials. The glow texture and the sprite geometry are shared and stay. */
  dispose(): void {
    for (const l of this.lamps) l.sprite.material.dispose();
    this.lamps.length = 0;
    this.group.clear();
    this.group.removeFromParent();
  }

  update(time: number): void {
    for (const l of this.lamps) {
      let k = 1;
      if (l.blink === 'strobe') {
        // Double flash every 1.2 s.
        const t = (time + l.phase) % 1.2;
        k = t < 0.05 || (t > 0.15 && t < 0.2) ? 1 : 0;
      } else if (l.blink === 'beacon') {
        const t = (time + l.phase) % 1.0;
        k = Math.max(0, Math.sin((t / 1.0) * Math.PI * 2)) ** 3;
      }
      k *= this.on ? 1 : 0;
      l.sprite.visible = k > 0.01;
      l.sprite.scale.setScalar(l.size * (0.6 + 0.4 * k));
      l.sprite.material.opacity = k;
    }
  }
}
