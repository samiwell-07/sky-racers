import {
  BoxGeometry,
  CanvasTexture,
  CircleGeometry,
  CylinderGeometry,
  ConeGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  LatheGeometry,
  Mesh,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  Shape,
  SphereGeometry,
  Vector2,
  type BufferGeometry,
  type Material,
  type Texture,
} from 'three';
import { mulberry32 } from '../../utils/random';
import { JET_CATALOG, type JetPaint } from './jetCatalog';

/** Two-tone military camouflage drawn on a canvas. */
function createCamoTexture(paint: JetPaint): CanvasTexture | null {
  if (typeof document === 'undefined') return null; // headless (tests)
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const random = mulberry32(7);
  ctx.fillStyle = paint.base;
  ctx.fillRect(0, 0, size, size);
  const blotch = (color: string, count: number, minR: number, maxR: number): void => {
    ctx.fillStyle = color;
    for (let b = 0; b < count; b++) {
      const cx = random() * size;
      const cy = random() * size;
      const r = minR + random() * (maxR - minR);
      ctx.beginPath();
      for (let a = 0; a <= 12; a++) {
        const ang = (a / 12) * Math.PI * 2;
        const rr = r * (0.6 + random() * 0.6);
        // Draw each blotch 9 times (wrapped) so the texture tiles seamlessly.
        const px = cx + Math.cos(ang) * rr * 1.6;
        const py = cy + Math.sin(ang) * rr;
        if (a === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      for (const ox of [-size, 0, size]) {
        for (const oy of [-size, 0, size]) {
          ctx.save();
          ctx.translate(ox, oy);
          ctx.fill();
          ctx.restore();
        }
      }
    }
  };
  blotch(paint.dark, 14, 30, 70);
  blotch(paint.light, 8, 20, 45);
  // Panel lines.
  ctx.strokeStyle = 'rgba(40,45,50,0.35)';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 8; i++) {
    const p = (i / 8) * size;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
  }
  const tex = new CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/** Extrudes a flat outline (x = span, y = position along the body) into a thin horizontal panel. */
function flatPanel(points: Array<[number, number]>, thickness: number): BufferGeometry {
  const shape = new Shape(points.map(([x, y]) => new Vector2(x, y)));
  const geo = new ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
  geo.rotateX(Math.PI / 2); // shape y -> world z, extrusion -> world -y
  geo.translate(0, thickness / 2, 0);
  return geo;
}

/** Same as flatPanel but mirrored to the left side (x -> -x). */
function mirrored(points: Array<[number, number]>): Array<[number, number]> {
  return points.map(([x, y]) => [-x, y]);
}

export interface JetParts {
  root: Group;
  stabilizerLeft: Group;
  stabilizerRight: Group;
  aileronLeft: Group;
  aileronRight: Group;
  flapLeft: Group;
  flapRight: Group;
  airbrake: Group;
  /** Gear leg pivots (rotate to retract) and the whole gear group. */
  gearLegs: Group[];
  /** Local positions of the engine exhausts (for the afterburner). */
  nozzles: Array<{ x: number; y: number; z: number; radius: number }>;
  canopy: Mesh;
  /** Materials and textures owned by this model (freed by Jet.dispose). */
  materials: Material[];
  textures: Texture[];
}

/** Height of the bottom of the wheels below the jet origin (gear down). */
export const GEAR_HEIGHT = 2.25;

/**
 * Builds a twin-engine, twin-tail air-superiority fighter from primitives.
 * Local frame: nose toward -Z, up = +Y, right wing = +X. Length ~20 m, span ~13 m.
 */
export function buildJetModel(paint: JetPaint = JET_CATALOG[0]!.paint): JetParts {
  const camo = createCamoTexture(paint);
  const bodyMat = new MeshStandardMaterial({ map: camo, metalness: 0.35, roughness: 0.55 });
  const wingCamo = camo?.clone() ?? null;
  wingCamo?.repeat.set(0.15, 0.15);
  const wingMat = new MeshStandardMaterial({ map: wingCamo, metalness: 0.35, roughness: 0.6 });
  const darkMat = new MeshStandardMaterial({ color: '#2b2f33', metalness: 0.5, roughness: 0.5 });
  const radomeMat = new MeshStandardMaterial({ color: '#4a5056', metalness: 0.2, roughness: 0.7 });
  const nozzleMat = new MeshStandardMaterial({ color: '#3a3836', metalness: 0.9, roughness: 0.35, side: DoubleSide });
  const glassMat = new MeshStandardMaterial({ color: '#4a3c1c', metalness: 0.95, roughness: 0.08, transparent: true, opacity: 0.88 });
  const missileMat = new MeshStandardMaterial({ color: '#d9dcdc', metalness: 0.2, roughness: 0.5 });
  const markMat = new MeshStandardMaterial({ color: paint.marking, roughness: 0.8 });
  const materials: Material[] = [bodyMat, wingMat, darkMat, radomeMat, nozzleMat, glassMat, missileMat, markMat];

  const root = new Group();
  root.name = 'jet';
  const add = (geo: BufferGeometry, mat: Material, parent: Group = root): Mesh => {
    const m = new Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  const alongBody = (geo: BufferGeometry): BufferGeometry => geo.rotateX(-Math.PI / 2); // +Y -> -Z

  // Fuselage: lathe profile (radius, position along the body; + = forward), flattened into a blended body.
  const fuselageProfile = [
    [0.45, 8.2], [0.62, 7.2], [0.82, 5.8], [0.98, 4.2], [1.08, 2.0], [1.12, 0], [1.1, -3],
    [1.04, -5.5], [0.95, -7.2], [0.88, -8.0],
  ].map(([r, y]) => new Vector2(r, y)).reverse();
  const fuselage = alongBody(new LatheGeometry(fuselageProfile, 28));
  fuselage.scale(1.3, 0.8, 1);
  add(fuselage, bodyMat);

  const radomeProfile = [[0.001, 10.4], [0.18, 10.0], [0.34, 9.2], [0.45, 8.2]]
    .map(([r, y]) => new Vector2(r, y)).reverse();
  const radome = alongBody(new LatheGeometry(radomeProfile, 28));
  radome.scale(1.3, 0.8, 1);
  add(radome, radomeMat);

  // Spine behind the canopy.
  const spine = new Mesh(new BoxGeometry(0.9, 0.5, 6.5), bodyMat);
  spine.position.set(0, 0.68, 0.2);
  spine.castShadow = true;
  root.add(spine);

  // Canopy (gold-tinted glass).
  const canopyGeo = new SphereGeometry(1, 28, 16);
  canopyGeo.scale(0.56, 0.52, 2.0);
  const canopy = add(canopyGeo, glassMat);
  canopy.position.set(0, 0.68, -4.4);
  canopy.castShadow = false;

  // Air intakes on both sides, with dark openings.
  for (const side of [-1, 1]) {
    const intake = add(new BoxGeometry(0.8, 1.0, 4.2), bodyMat);
    intake.position.set(side * 1.35, -0.3, -0.6);
    const mouth = add(new BoxGeometry(0.66, 0.84, 0.05), darkMat);
    mouth.position.set(side * 1.35, -0.3, -2.72);
  }

  // Main wings with leading-edge root extensions (LERX).
  const wing: Array<[number, number]> = [[0.9, -5.6], [1.7, -2.6], [6.4, 3.1], [6.6, 4.4], [1.1, 5.0]];
  add(flatPanel(wing, 0.2), wingMat);
  add(flatPanel(mirrored(wing), 0.2), wingMat);

  // All-moving horizontal stabilizers (stabilators) on pivots so they can be animated.
  const stabOutline: Array<[number, number]> = [[0, -1.0], [3.0, 0.9], [3.1, 1.6], [0, 1.9]];
  const makeStabilizer = (side: number): Group => {
    const pivot = new Group();
    pivot.position.set(side * 1.25, -0.05, 7.0);
    add(flatPanel(side > 0 ? stabOutline : mirrored(stabOutline), 0.14), wingMat, pivot);
    root.add(pivot);
    return pivot;
  };
  const stabilizerRight = makeStabilizer(1);
  const stabilizerLeft = makeStabilizer(-1);

  // Twin vertical tails, canted outward.
  const finShape = new Shape([new Vector2(4.2, 0), new Vector2(6.9, 3.5), new Vector2(7.9, 3.5), new Vector2(8.1, 0)]);
  for (const side of [-1, 1]) {
    const finGeo = new ExtrudeGeometry(finShape, { depth: 0.14, bevelEnabled: false });
    finGeo.rotateY(-Math.PI / 2); // shape x -> world z, extrusion -> world -x
    finGeo.translate(0.07, 0, 0);
    const fin = add(finGeo, wingMat);
    fin.position.set(side * 1.0, 0.45, 0);
    fin.rotation.z = -side * 0.35;
    // Squadron marking stripe near the fin top.
    const stripe = add(new BoxGeometry(0.16, 0.35, 1.1), markMat, root);
    stripe.position.set(side * (1.0 + Math.sin(0.35) * 2.8), 0.45 + Math.cos(0.35) * 2.8, 7.2);
    stripe.rotation.z = -side * 0.35;
  }

  // Twin engine nozzles.
  const nozzles: JetParts['nozzles'] = [];
  for (const side of [-1, 1]) {
    const x = side * 0.58;
    const nozzle = add(alongBody(new CylinderGeometry(0.62, 0.52, 1.6, 20, 1, true)), nozzleMat);
    nozzle.position.set(x, -0.05, 8.6);
    const inner = new Mesh(new CircleGeometry(0.5, 20), darkMat);
    inner.position.set(x, -0.05, 8.5);
    root.add(inner);
    nozzles.push({ x, y: -0.05, z: 9.35, radius: 0.5 });
  }

  // Weapons: wingtip and under-wing missiles on pylons.
  const missile = (x: number, y: number, z: number, length: number): void => {
    const body = add(alongBody(new CylinderGeometry(0.11, 0.11, length, 10)), missileMat);
    body.position.set(x, y, z);
    const nose = add(alongBody(new ConeGeometry(0.11, 0.45, 10)), missileMat);
    nose.position.set(x, y, z - length / 2 - 0.22);
    const fins = add(new BoxGeometry(0.5, 0.03, 0.35), darkMat);
    fins.position.set(x, y, z + length / 2 - 0.2);
    const fins2 = add(new BoxGeometry(0.03, 0.5, 0.35), darkMat);
    fins2.position.set(x, y, z + length / 2 - 0.2);
  };
  for (const side of [-1, 1]) {
    missile(side * 6.55, 0.0, 3.2, 3.0);
    const pylon = add(new BoxGeometry(0.12, 0.35, 1.6), darkMat);
    pylon.position.set(side * 3.8, -0.25, 2.4);
    missile(side * 3.8, -0.52, 2.2, 3.6);
  }

  // Control surfaces hinged on the wing trailing edge: ailerons outboard, flaps inboard.
  const trailingEdgeZ = (x: number): number => 5.0 - (Math.abs(x) - 1.1) * (0.6 / 5.5);
  const controlSurface = (xCenter: number, span: number, chord: number): Group => {
    const pivot = new Group();
    pivot.position.set(xCenter, 0, trailingEdgeZ(xCenter));
    const half = span / 2;
    add(flatPanel([[-half, 0], [half, 0], [half, chord], [-half, chord]], 0.12), wingMat, pivot);
    root.add(pivot);
    return pivot;
  };
  const aileronRight = controlSurface(4.9, 2.6, 0.9);
  const aileronLeft = controlSurface(-4.9, 2.6, 0.9);
  const flapRight = controlSurface(2.55, 2.4, 1.0);
  const flapLeft = controlSurface(-2.55, 2.4, 1.0);

  // Speed brake on the spine behind the canopy, hinged at its front edge.
  const airbrake = new Group();
  airbrake.position.set(0, 0.95, -1.6);
  const brakePanel = add(new BoxGeometry(1.0, 0.06, 2.0), bodyMat, airbrake);
  brakePanel.position.set(0, 0, 1.0);
  root.add(airbrake);

  // Landing gear: nose leg + two main legs. Each leg pivots forward into the body to retract.
  const gearMat = new MeshStandardMaterial({ color: '#c9ccce', metalness: 0.6, roughness: 0.4 });
  const tireMat = new MeshStandardMaterial({ color: '#1c1c1c', roughness: 0.9 });
  const gearLegs: Group[] = [];
  const gearLeg = (x: number, y: number, z: number, wheelRadius: number): void => {
    const pivot = new Group();
    pivot.position.set(x, y, z);
    const legLength = GEAR_HEIGHT + y - wheelRadius;
    const leg = add(new CylinderGeometry(0.08, 0.1, legLength, 8), gearMat, pivot);
    leg.position.y = -legLength / 2;
    const wheelGeo = new CylinderGeometry(wheelRadius, wheelRadius, 0.28, 16);
    wheelGeo.rotateZ(Math.PI / 2);
    const wheel = add(wheelGeo, tireMat, pivot);
    wheel.position.y = -legLength;
    root.add(pivot);
    gearLegs.push(pivot);
  };
  gearLeg(0, -0.7, -6.2, 0.35);
  gearLeg(-1.45, -0.75, 1.6, 0.45);
  gearLeg(1.45, -0.75, 1.6, 0.45);

  return {
    root,
    stabilizerLeft,
    stabilizerRight,
    aileronLeft,
    aileronRight,
    flapLeft,
    flapRight,
    airbrake,
    gearLegs,
    nozzles,
    canopy,
    materials: [...materials, gearMat, tireMat],
    textures: [camo, wingCamo].filter((t): t is CanvasTexture => t !== null),
  };
}
