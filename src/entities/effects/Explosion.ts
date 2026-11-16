import {
  AdditiveBlending,
  BoxGeometry,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  Vector3,
} from 'three';

interface Debris {
  mesh: Mesh;
  velocity: Vector3;
  spin: Vector3;
}

interface Blob {
  mesh: Mesh<SphereGeometry, MeshBasicMaterial>;
  offset: Vector3;
  delay: number;
  size: number;
}

const DURATION = 2.2;
const FIRE_TIME = 1.0;
const HOT = new Color('#fff2b0');
const COOL = new Color('#ff5a1a');

/** Fireball blobs + smoke + flying debris, reused for every crash. */
export class Explosion {
  readonly group = new Group();
  private readonly blobs: Blob[] = [];
  private readonly smoke: Mesh<SphereGeometry, MeshStandardMaterial>;
  private readonly debris: Debris[] = [];
  private readonly origin = new Vector3();
  private age = DURATION;

  constructor() {
    const sphere = new SphereGeometry(1, 20, 14);
    for (let i = 0; i < 7; i++) {
      const mesh = new Mesh(
        sphere,
        new MeshBasicMaterial({ color: HOT.clone(), transparent: true, blending: AdditiveBlending, depthWrite: false }),
      );
      this.blobs.push({ mesh, offset: new Vector3(), delay: 0, size: 1 });
      this.group.add(mesh);
    }
    this.smoke = new Mesh(
      sphere,
      new MeshStandardMaterial({ color: '#2d2a28', transparent: true, depthWrite: false, roughness: 1 }),
    );
    this.group.add(this.smoke);
    const debrisMat = new MeshStandardMaterial({ color: '#4c5257', roughness: 0.7 });
    for (let i = 0; i < 16; i++) {
      const mesh = new Mesh(new BoxGeometry(0.6 + Math.random(), 0.2, 0.5 + Math.random()), debrisMat);
      mesh.castShadow = true;
      this.debris.push({ mesh, velocity: new Vector3(), spin: new Vector3() });
      this.group.add(mesh);
    }
    this.group.visible = false;
  }

  get active(): boolean {
    return this.age < DURATION;
  }

  trigger(position: Vector3, velocity: Vector3): void {
    this.age = 0;
    this.group.visible = true;
    this.origin.copy(position);
    this.smoke.position.copy(position);
    this.blobs.forEach((b, i) => {
      b.offset.set(Math.random() - 0.5, Math.random() * 0.6, Math.random() - 0.5).multiplyScalar(i === 0 ? 0 : 14);
      b.delay = i === 0 ? 0 : Math.random() * 0.3;
      b.size = i === 0 ? 16 : 7 + Math.random() * 8;
    });
    for (const d of this.debris) {
      d.mesh.position.copy(position);
      d.velocity
        .set(Math.random() - 0.5, Math.random() * 0.8 + 0.2, Math.random() - 0.5)
        .multiplyScalar(60)
        .addScaledVector(velocity, 0.25);
      d.spin.set(Math.random() * 10, Math.random() * 10, Math.random() * 10);
    }
  }

  update(dt: number, groundHeight: (x: number, z: number) => number): void {
    if (!this.active) {
      this.group.visible = false;
      return;
    }
    this.age += dt;
    const t = Math.min(this.age / DURATION, 1);

    for (const b of this.blobs) {
      const ft = (this.age - b.delay) / FIRE_TIME;
      b.mesh.visible = ft > 0 && ft < 1;
      if (!b.mesh.visible) continue;
      b.mesh.position.copy(this.origin).addScaledVector(b.offset, 0.5 + ft);
      b.mesh.scale.setScalar(b.size * (0.3 + Math.sqrt(ft)));
      b.mesh.material.color.copy(HOT).lerp(COOL, Math.min(1, ft * 1.6));
      b.mesh.material.opacity = (1 - ft) * 0.85;
    }

    this.smoke.scale.setScalar(6 + t * 30);
    this.smoke.position.y += dt * 8;
    this.smoke.material.opacity = Math.sin(Math.PI * Math.min(t * 1.3, 1)) * 0.75;

    for (const d of this.debris) {
      d.velocity.y -= 9.81 * dt;
      d.mesh.position.addScaledVector(d.velocity, dt);
      const ground = groundHeight(d.mesh.position.x, d.mesh.position.z);
      if (d.mesh.position.y < ground) {
        d.mesh.position.y = ground;
        d.velocity.multiplyScalar(0.3);
        d.velocity.y = Math.abs(d.velocity.y) * 0.3;
      }
      d.mesh.rotation.x += d.spin.x * dt;
      d.mesh.rotation.y += d.spin.y * dt;
      d.mesh.rotation.z += d.spin.z * dt;
    }
  }
}
