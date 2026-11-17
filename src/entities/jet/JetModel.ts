import {
  BoxGeometry,
  CanvasTexture,
  CylinderGeometry,
  ConeGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  SphereGeometry,
  type BufferGeometry,
  type Material,
  type Object3D,
  type Texture,
} from 'three';
import { mulberry32 } from '../../utils/random';
import { JET_CATALOG, type JetPaint } from './jetCatalog';
import { getJetDesign, type Outline } from './jetDesigns';
import { closedBody, fixedWing, flatPanel, mirrored, wingEdge, type WingControl } from './modelGeometry';

/** Two-tone military camouflage drawn on a canvas. */
function createCamoTexture(paint: JetPaint): CanvasTexture | null {
  if (typeof document === 'undefined') return null; // headless (tests)
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
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
  /** Local aft exhaust lips (positive Z), shared by afterburner and heat haze. */
  nozzles: Array<{ x: number; y: number; z: number; radius: number }>;
  /** Local surface positions, derived from this airframe rather than a shared silhouette. */
  navigationLights: {
    wings: Array<{ x: number; y: number; z: number }>;
    tails: Array<{ x: number; y: number; z: number }>;
  };
  canopy: Mesh;
  /** Materials and textures owned by this model (freed by Jet.dispose). */
  materials: Material[];
  textures: Texture[];
}

/** Height of the bottom of the wheels below the jet origin (gear down). */
export const GEAR_HEIGHT = 2.25;

/**
 * Builds an ID-specific airframe from closed solids with embedded roots and backed recesses.
 * Local frame: nose toward -Z, up = +Y, right wing = +X. Length ~20 m, span ~13 m.
 */
export function buildJetModel(paint: JetPaint = JET_CATALOG[0]!.paint, modelId = 'falcon'): JetParts {
  const design = getJetDesign(modelId);
  const camo = createCamoTexture(paint);
  const bodyMat = new MeshStandardMaterial({ color: camo ? '#ffffff' : paint.base, map: camo, metalness: 0.35, roughness: 0.55 });
  const wingCamo = camo?.clone() ?? null;
  wingCamo?.repeat.set(0.15, 0.15);
  const wingMat = new MeshStandardMaterial({ color: wingCamo ? '#ffffff' : paint.base, map: wingCamo, metalness: 0.35, roughness: 0.6 });
  const darkMat = new MeshStandardMaterial({ color: '#2b2f33', metalness: 0.5, roughness: 0.5 });
  const radomeMat = new MeshStandardMaterial({ color: '#4a5056', metalness: 0.2, roughness: 0.7 });
  const nozzleMat = new MeshStandardMaterial({ color: '#494744', metalness: 0.85, roughness: 0.4 });
  const recessMat = new MeshStandardMaterial({ color: '#10151a', metalness: 0.2, roughness: 0.88 });
  const glassMat = new MeshStandardMaterial({ color: '#4a3c1c', metalness: 0.95, roughness: 0.08, transparent: true, opacity: 0.88 });
  const missileMat = new MeshStandardMaterial({ color: '#d9dcdc', metalness: 0.2, roughness: 0.5 });
  const markMat = new MeshStandardMaterial({ color: paint.marking, roughness: 0.8 });
  const materials: Material[] = [bodyMat, wingMat, darkMat, radomeMat, nozzleMat, recessMat, glassMat, missileMat, markMat];

  const root = new Group();
  root.name = 'jet';
  const add = (name: string, geo: BufferGeometry, mat: Material, parent: Object3D = root): Mesh => {
    const m = new Mesh(geo, mat);
    m.name = name;
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  const alongBody = (geo: BufferGeometry): BufferGeometry => geo.rotateX(-Math.PI / 2); // +Y -> -Z

  const fuselage = closedBody(design.fuselage.profile);
  fuselage.scale(design.fuselage.width, design.fuselage.height, 1);
  add('fuselage', fuselage, bodyMat);
  const radome = closedBody(design.radome);
  radome.scale(design.fuselage.width, design.fuselage.height, 1);
  add('radome', radome, radomeMat);

  const hullRadius = (z: number): number => {
    const profile = design.fuselage.profile;
    for (let i = 1; i < profile.length; i++) {
      const a = profile[i - 1]!;
      const b = profile[i]!;
      if (-z >= a[1] && -z <= b[1]) return a[0] + (b[0] - a[0]) * (-z - a[1]) / (b[1] - a[1]);
    }
    return profile[0]![0];
  };
  const ellipsoid = (name: string, width: number, height: number, length: number, mat: Material): Mesh => {
    const geometry = new SphereGeometry(1, 24, 12);
    geometry.scale(width, height, length);
    return add(name, geometry, mat);
  };
  const spineY = hullRadius(0.1) * design.fuselage.height * 0.86;
  const spine = ellipsoid('dorsal-spine', design.canopy.width * 0.8, 0.23, 3.5, bodyMat);
  spine.position.set(0, spineY, 0.1);

  // An opaque inner shell prevents the transparent canopy from exposing an empty airframe.
  const cockpit = ellipsoid('cockpit', design.canopy.width * 0.95, design.canopy.height * 0.89, design.canopy.length * 0.97, darkMat);
  cockpit.position.set(0, design.canopy.y - 0.018, design.canopy.z);
  const canopy = ellipsoid('canopy', design.canopy.width, design.canopy.height, design.canopy.length, glassMat);
  canopy.position.set(0, design.canopy.y, design.canopy.z);
  canopy.castShadow = false;

  design.intakes.forEach((intake, i) => {
    const front = intake.z - intake.length / 2;
    const back = intake.z + intake.length / 2;
    const housing = closedBody([
      [0.82, -back], [1, -front - 0.28], [1, -front],
      [0.82, -front], [0.76, -front - 0.25], [0, -front - 0.25],
    ], 24, true);
    housing.scale(intake.width / 2, intake.height / 2, 1);
    const mesh = add(`intake-${i}`, housing, bodyMat);
    mesh.position.set(intake.x, intake.y, 0);
    const backing = closedBody([[0.755, -front - 0.255], [0.755, -front - 0.235]], 24, true);
    backing.scale(intake.width / 2, intake.height / 2, 1);
    add(`intake-back-${i}`, backing, recessMat).position.set(intake.x, intake.y, 0);
  });

  const controls = [design.controls.aileron, design.controls.flap];
  const wing = fixedWing(design.wing, controls);
  add('wing-right', flatPanel(wing, 0.2), wingMat);
  add('wing-left', flatPanel(mirrored(wing), 0.2), wingMat);

  // The buried spindle remains inside both the fuselage and the moving stabilator at full deflection.
  const makeStabilizer = (side: number): Group => {
    const name = side > 0 ? 'right' : 'left';
    const stab = design.stabilizer;
    const pivot = new Group();
    pivot.name = `stabilizer-pivot-${name}`;
    pivot.position.set(side * stab.x, stab.y, stab.z);
    add(`stabilizer-${name}`, flatPanel(side > 0 ? stab.outline : mirrored(stab.outline), 0.16), wingMat, pivot);
    root.add(pivot);
    const spindleLength = stab.x + 0.3;
    const spindle = new CylinderGeometry(0.15, 0.15, spindleLength, 12);
    spindle.rotateZ(Math.PI / 2);
    add(`stabilizer-spindle-${name}`, spindle, bodyMat).position.set(side * spindleLength / 2, stab.y, stab.z);
    const shoulder = ellipsoid(`stabilizer-root-${name}`, 0.38, 0.22, 0.62, bodyMat);
    shoulder.position.set(side * (stab.x - 0.15), stab.y, stab.z);
    return pivot;
  };
  const stabilizerRight = makeStabilizer(1);
  const stabilizerLeft = makeStabilizer(-1);

  const navigationLights: JetParts['navigationLights'] = { wings: [], tails: [] };
  const tipX = Math.max(...design.wing.map(([x]) => x)) - 0.04;
  const tipZ = (wingEdge(design.wing, tipX, false) + wingEdge(design.wing, tipX, true)) / 2;
  for (const side of [-1, 1]) navigationLights.wings.push({ x: side * tipX, y: 0.1, z: tipZ });
  design.fins.forEach((tail, i) => {
    // Horizontal panel axes (span, chord, thickness) -> (aft, height, transverse thickness).
    const geometry = flatPanel(tail.outline, 0.14);
    geometry.rotateX(-Math.PI / 2);
    geometry.rotateY(-Math.PI / 2);
    const fin = add(`fin-${i}`, geometry, wingMat);
    fin.position.set(tail.x, tail.y, 0);
    fin.rotation.z = tail.cant;
    const top = Math.max(...tail.outline.map(([, y]) => y));
    const topPoints = tail.outline.filter(([, y]) => y === top);
    const topZ = topPoints.reduce((sum, [z]) => sum + z, 0) / topPoints.length;
    navigationLights.tails.push({
      x: tail.x - Math.sin(tail.cant) * top,
      y: tail.y + Math.cos(tail.cant) * top,
      z: topZ,
    });
    const markingHeight = top * 0.81;
    const verticalOutline: Outline = tail.outline.map(([z, y]) => [y, z]);
    const front = wingEdge(verticalOutline, markingHeight, false);
    const back = wingEdge(verticalOutline, markingHeight, true);
    const stripe = add(`fin-marking-${i}`, new BoxGeometry(0.15, 0.18, (back - front) * 0.65), markMat, fin);
    stripe.position.set(0, markingHeight, (front + back) / 2);
  });

  if (design.canards) {
    const canards = design.canards;
    for (const side of [-1, 1]) {
      const panel = add(`canard-${side > 0 ? 'right' : 'left'}`, flatPanel(side > 0 ? canards.outline : mirrored(canards.outline), 0.14), wingMat);
      panel.position.set(side * canards.x, canards.y, canards.z);
    }
  }

  // Each nozzle is one closed solid: front cap, outer shroud, lip, recessed wall and back plate.
  const nozzles: JetParts['nozzles'] = [];
  design.engines.forEach((engine, i) => {
    const front = engine.z - engine.length / 2;
    const rear = engine.z + engine.length / 2;
    const throat = engine.radius * 0.73;
    const geometry = closedBody([
      [0, -(rear - 0.28)], [throat, -(rear - 0.28)],
      [engine.radius * 0.8, -rear], [engine.radius * 0.96, -rear],
      [engine.radius, -(rear - 0.2)], [engine.radius * 1.06, -front],
    ], 24);
    add(`engine-${i}`, geometry, nozzleMat).position.set(engine.x, engine.y, 0);
    const back = add(`exhaust-back-${i}`, alongBody(new CylinderGeometry(throat, throat, 0.035, 24)), recessMat);
    back.position.set(engine.x, engine.y, rear - 0.265);
    nozzles.push({ x: engine.x, y: engine.y, z: rear, radius: engine.radius * 0.78 });
  });

  const missile = (name: string, x: number, y: number, z: number, length: number): void => {
    const body = add(`${name}-body`, alongBody(new CylinderGeometry(0.11, 0.11, length, 10)), missileMat);
    body.position.set(x, y, z);
    const nose = add(`${name}-nose`, alongBody(new ConeGeometry(0.11, 0.45, 10)), missileMat);
    nose.position.set(x, y, z - length / 2 - 0.215);
    const fins = add(`${name}-fins-horizontal`, new BoxGeometry(0.42, 0.03, 0.35), darkMat);
    fins.position.set(x, y, z + length / 2 - 0.2);
    const fins2 = add(`${name}-fins-vertical`, new BoxGeometry(0.03, 0.42, 0.35), darkMat);
    fins2.position.set(x, y, z + length / 2 - 0.2);
  };
  if (design.stores) {
    const storeX = tipX * 0.57;
    const storeZ = (wingEdge(design.wing, storeX, false) + wingEdge(design.wing, storeX, true)) / 2;
    for (const side of [-1, 1]) {
      const name = side > 0 ? 'right' : 'left';
      const pylon = add(`pylon-${name}`, new BoxGeometry(0.14, 0.5, 1.2), darkMat);
      pylon.position.set(side * storeX, -0.28, storeZ);
      missile(`store-${name}`, side * storeX, -0.57, storeZ, 3.4);
    }
  }

  // A static carrier aligns local X with the sloping hinge; Jet's rotation.x animation stays unchanged.
  const controlSurface = (name: string, side: number, control: WingControl): Group => {
    const lo = control.x - control.span / 2;
    const hi = control.x + control.span / 2;
    const zLo = wingEdge(design.wing, lo, true);
    const zHi = wingEdge(design.wing, hi, true);
    const centerZ = (zLo + zHi) / 2 - control.chord;
    const angle = -Math.atan2(side * (zHi - zLo), control.span);
    const carrier = new Group();
    carrier.name = `${name}-mount`;
    carrier.position.set(side * control.x, 0, centerZ);
    carrier.rotation.y = angle;
    root.add(carrier);
    const pivot = new Group();
    pivot.name = `${name}-pivot`;
    carrier.add(pivot);
    // A small overlap at the side cuts also avoids sub-pixel cracks after mirrored transforms.
    const sideOverlap = 0.012;
    const slope = (zHi - zLo) / control.span;
    const leadingLo = lo - sideOverlap;
    const leadingHi = hi + sideOverlap;
    const trailingLo = zLo - slope * sideOverlap;
    const trailingHi = zHi + slope * sideOverlap;
    const outline: Outline = [
      [leadingLo, trailingLo - control.chord - 0.045], [leadingHi, trailingHi - control.chord - 0.045],
      [leadingHi, trailingHi], [leadingLo, trailingLo],
    ];
    const localOutline: Outline = outline.map(([x, z]) => {
      const dx = side * (x - control.x);
      const dz = z - centerZ;
      return [Math.cos(angle) * dx - Math.sin(angle) * dz, Math.sin(angle) * dx + Math.cos(angle) * dz];
    });
    add(name, flatPanel(localOutline, 0.14), wingMat, pivot);
    const barrel = new CylinderGeometry(0.105, 0.105, Math.hypot(control.span, zHi - zLo) + 0.12, 12);
    barrel.rotateZ(Math.PI / 2);
    add(`${name}-hinge`, barrel, bodyMat, carrier);
    return pivot;
  };
  const aileronRight = controlSurface('aileron-right', 1, design.controls.aileron);
  const aileronLeft = controlSurface('aileron-left', -1, design.controls.aileron);
  const flapRight = controlSurface('flap-right', 1, design.controls.flap);
  const flapLeft = controlSurface('flap-left', -1, design.controls.flap);

  // Speed brake on the spine behind the canopy, hinged at its front edge.
  const airbrake = new Group();
  airbrake.name = 'airbrake-pivot';
  airbrake.position.set(0, spineY + 0.18, -1.6);
  const brakePanel = add('airbrake', new BoxGeometry(design.canopy.width * 1.2, 0.06, 1.85), bodyMat, airbrake);
  brakePanel.position.set(0, 0, 0.89);
  root.add(airbrake);
  const brakeHinge = new CylinderGeometry(0.075, 0.075, design.canopy.width * 1.25, 12);
  brakeHinge.rotateZ(Math.PI / 2);
  add('airbrake-hinge', brakeHinge, bodyMat).position.copy(airbrake.position);

  // Landing gear: nose leg + two main legs. Each leg pivots forward into the body to retract.
  const gearMat = new MeshStandardMaterial({ color: '#c9ccce', metalness: 0.6, roughness: 0.4 });
  const tireMat = new MeshStandardMaterial({ color: '#1c1c1c', roughness: 0.9 });
  const gearLegs: Group[] = [];
  const gearLeg = (name: string, x: number, y: number, z: number, wheelRadius: number): void => {
    const pivot = new Group();
    pivot.name = `gear-pivot-${name}`;
    pivot.position.set(x, y, z);
    const legLength = GEAR_HEIGHT + y - wheelRadius;
    const leg = add(`gear-strut-${name}`, new CylinderGeometry(0.08, 0.1, legLength, 8), gearMat, pivot);
    leg.position.y = -legLength / 2;
    const wheelGeo = new CylinderGeometry(wheelRadius, wheelRadius, 0.28, 16);
    wheelGeo.rotateZ(Math.PI / 2);
    const wheel = add(`gear-wheel-${name}`, wheelGeo, tireMat, pivot);
    wheel.position.y = -legLength;
    root.add(pivot);
    gearLegs.push(pivot);
  };
  const gearX = Math.min(1.35, design.fuselage.width * 0.73);
  gearLeg('nose', 0, -0.35, -5.7, 0.35);
  gearLeg('left', -gearX, -0.45, 1.6, 0.45);
  gearLeg('right', gearX, -0.45, 1.6, 0.45);

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
    navigationLights,
    canopy,
    materials: [...materials, gearMat, tireMat],
    textures: [camo, wingCamo].filter((t): t is CanvasTexture => t !== null),
  };
}
