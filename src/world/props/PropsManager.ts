import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  ExtrudeGeometry,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  OctahedronGeometry,
  Quaternion,
  Shape,
  SphereGeometry,
  Vector3,
} from 'three';
import type { Material, Object3D } from 'three';
import {
  BROADLEAF_SHAPE,
  CABLE_DROP,
  CABLE_HIT_RADIUS,
  CABLE_OFFSETS,
  CONIFER_SHAPE,
  PIER_HALF,
  PYLON_ARM_HALF,
  PYLON_BASE_HALF,
  archOpeningTop,
  bridgeDeckBand,
  bridgeSpanOf,
  collideArch,
  collideBridge,
  collidePowerLine,
  generateCell,
  getFeatures,
  seededPlacement,
} from './propsPlacement';
import type {
  ArchData,
  ClearZone,
  Features,
  ObstacleKind,
  PlacementOptions,
  PlacementWorld,
  PowerLineData,
  PylonData,
} from './propsPlacement';
import { BUILDING_STRIDE, ROCK_STRIDE, TREE_STRIDE, collidePackedCell, packCell } from './propsPacking';
import type { PackedCell, PropMeshKind } from './propsPacking';
import { PROPS_CELL_SIZE } from './propsWorkerProtocol';
import type { PropsWorkerInit, PropsWorkerRequest, PropsWorkerResult } from './propsWorkerProtocol';
import type { BridgeSite, WorldSpec } from '../gen/WorldGenerator';
import { DECK_THICKNESS, PARAPET_HEIGHT } from '../gen/settlements/types';
import type { BridgeSpan } from '../gen/settlements/types';

export type { ObstacleKind } from './propsPlacement';

export type PropsQuality = 'low' | 'medium' | 'high';

/** The world queries props need (a WorldGenerator satisfies it). */
export type PropsWorld = PlacementWorld & {
  heightAt(x: number, z: number): number;
  /** Lets the worker rebuild the world with createWorld(spec); without it seeded props are generated on the main thread. */
  readonly spec?: WorldSpec;
  readonly classicValleyCenterX?: (z: number) => number;
};

export interface PropsOptions {
  seed: number;
  /** Ground height (for seeded worlds it must be world.heightAt). */
  heightAt: (x: number, z: number) => number;
  /** Classic valley centerline (defaults to world.classicValleyCenterX for the Classic world). */
  valleyCenterX?: (z: number) => number;
  /** z positions where a power line crosses the valley (pylons on both rims, cables ≥ ~70 m above the floor). Classic only. */
  powerLineZ?: number[];
  /** z positions of stone arch bridges spanning the valley (opening ≥ 70 m wide, ≥ 45 m high above the floor). Classic only. */
  archZ?: number[];
  /**
   * The world. A seeded world (spec.kind !== 'classic') gets settlement-aware props: no trees on
   * roads, water, streets or the airfield, city buildings and road bridges (with collision).
   * The Classic world (or none) keeps the Classic valley props exactly.
   */
  world?: PropsWorld;
  /** Rectangles kept clear of trees/rocks/buildings (runway etc.). Heading follows Three.js rotation.y; length runs along local Z. */
  clearZones?: Array<{ x: number; z: number; halfWidth: number; halfLength: number; heading: number }>;
  /** Visual quality only (render radius and mesh detail): the collision world is the same at every quality. */
  quality?: PropsQuality;
  /** Clock (ms) for the per-frame build budget; tests inject a fake one. Default performance.now. */
  clock?: () => number;
  /**
   * Generate cells in a Web Worker (default: true when Worker exists). Classic: the worker rebuilds the
   * height function as HeightField(TERRAIN_CONFIG).getHeightAt, so heightAt must match it; pass false
   * otherwise. Seeded: the worker rebuilds the world from world.spec (no worker without a spec).
   */
  useWorker?: boolean;
}

function seededWorldOf(o: PropsOptions): PropsWorld | null {
  return o.world && o.world.spec?.kind !== 'classic' ? o.world : null;
}

const CELL_SIZE = PROPS_CELL_SIZE;
/** Main-thread time per frame for building cell meshes (and generating cells without a worker). */
const FRAME_BUDGET_MS = 2;
/** The wanted-cell set is only recomputed after the camera moved this far. */
const RECENTER_DISTANCE = 50;
/** Generated cells farther than radius + this are dropped from the cache. */
const CACHE_MARGIN = 3 * CELL_SIZE;
const FEATURES_PER_UPDATE = 1;
/** Margin used to also check neighbouring cells for obstacles overlapping a cell border (building half diagonals reach 25 m). */
const COLLISION_REACH = 26;
/** Largest horizontal reach of a cell obstacle past its position (buildings use 25 m). */
const OBSTACLE_REACH = 32;
/** Resolution (m) of the per-cell obstacle-top grid used by AI hazard queries. */
const TOP_GRID_STEP = 16;
const TOP_GRID_SIZE = Math.ceil((CELL_SIZE + 2 * OBSTACLE_REACH) / TOP_GRID_STEP);

/**
 * Collision density: the collidable world is generated at this one density from the seed and the
 * placement rules, independent of graphics quality (quality only changes what is drawn and how).
 */
export const COLLISION_DENSITY = 1;
/**
 * Every collidable obstacle within this distance of the camera is drawn at every quality
 * (the lowest render radius minus the recenter slack).
 */
export const PROPS_MIN_VISIBLE_RADIUS = 1200;
/** Cells are generated (worker) this far from the camera at every quality, so collision/AI data is ready early. */
const DATA_RADIUS = 2500;
/** Cells used for collision / AI queries in the last this many updates are kept in the cache. */
const TOUCH_KEEP_UPDATES = 600;

const QUALITY: Record<PropsQuality, { radius: number; lowDetail: boolean }> = {
  low: { radius: PROPS_MIN_VISIBLE_RADIUS + RECENTER_DISTANCE + 50, lowDetail: true },
  medium: { radius: 1800, lowDetail: false },
  high: { radius: 2500, lowDetail: false },
};

const UP = new Vector3(0, 1, 0);
const NO_BRIDGES: readonly BridgeSite[] = [];

interface ColoredPart {
  geometry: BufferGeometry;
  color: Color;
}

/** Merges geometries into one non-indexed geometry with flat normals and per-vertex colors. */
function mergeColored(parts: ColoredPart[]): BufferGeometry {
  const flat = parts.map((p) => ({ g: p.geometry.index ? p.geometry.toNonIndexed() : p.geometry, color: p.color }));
  const total = flat.reduce((n, p) => n + p.g.getAttribute('position').count, 0);
  const positions = new Float32Array(total * 3);
  const colors = new Float32Array(total * 3);
  let offset = 0;
  for (const { g, color } of flat) {
    const pos = g.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const k = (offset + i) * 3;
      positions[k] = pos.getX(i);
      positions[k + 1] = pos.getY(i);
      positions[k + 2] = pos.getZ(i);
      colors[k] = color.r;
      colors[k + 1] = color.g;
      colors[k + 2] = color.b;
    }
    offset += pos.count;
  }
  for (const p of parts) p.geometry.dispose();
  for (const p of flat) p.g.dispose();
  const merged = new BufferGeometry();
  merged.setAttribute('position', new BufferAttribute(positions, 3));
  merged.setAttribute('color', new BufferAttribute(colors, 3));
  merged.computeVertexNormals();
  return merged;
}

/** Box faces in the beam frame (x = across, y = along the beam, z = across), 4 corners each, CCW from outside. */
const BOX_FACES: ReadonlyArray<ReadonlyArray<readonly [number, number, number]>> = [
  [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]],
  [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]],
  [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]],
  [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]],
  [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]],
  [[-1, -1, -1], [-1, 1, -1], [1, 1, -1], [1, -1, -1]],
];
const _q = new Quaternion();
const _u = new Vector3();
const _v = new Vector3();
const _dir = new Vector3();

/**
 * Box beams of square section written straight into flat arrays (same triangles as a rotated
 * BoxGeometry per beam, without allocating and merging hundreds of geometries).
 */
class BeamWriter {
  private readonly positions: number[] = [];
  private readonly colors: number[] = [];

  add(a: Vector3, b: Vector3, thickness: number, color: Color): void {
    _dir.subVectors(b, a);
    const len = _dir.length();
    _q.setFromUnitVectors(UP, _dir.normalize());
    _u.set(1, 0, 0).applyQuaternion(_q);
    _v.set(0, 0, 1).applyQuaternion(_q);
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const mz = (a.z + b.z) / 2;
    const ht = thickness / 2;
    const hl = len / 2;
    const pos = this.positions;
    const col = this.colors;
    for (const face of BOX_FACES) {
      for (const k of [0, 1, 2, 0, 2, 3]) {
        const [sx, sy, sz] = face[k]!;
        const lx = sx * ht;
        const ly = sy * hl;
        const lz = sz * ht;
        pos.push(
          mx + _u.x * lx + _dir.x * ly + _v.x * lz,
          my + _u.y * lx + _dir.y * ly + _v.y * lz,
          mz + _u.z * lx + _dir.z * ly + _v.z * lz,
        );
        col.push(color.r, color.g, color.b);
      }
    }
  }

  build(): BufferGeometry {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(this.positions), 3));
    geo.setAttribute('color', new BufferAttribute(new Float32Array(this.colors), 3));
    geo.computeVertexNormals();
    return geo;
  }
}

/** Lattice pylon in its local frame (base at origin, crossarm along local X). */
function buildPylonGeometry(height: number): BufferGeometry {
  const steel = new Color('#8b9096');
  const beams = new BeamWriter();
  const add = (a: Vector3, b: Vector3, t: number): void => beams.add(a, b, t, steel);
  const topHalf = 1.3;
  const corner = (sx: number, sz: number, h: number): Vector3 => {
    const w = PYLON_BASE_HALF + (topHalf - PYLON_BASE_HALF) * (h / height);
    return new Vector3(sx * w, h, sz * w);
  };
  const corners: Array<[number, number]> = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
  for (const [sx, sz] of corners) add(corner(sx, sz, 0), corner(sx, sz, height), 0.55);
  const levels = Math.max(3, Math.round(height / 10));
  for (let l = 0; l < levels; l++) {
    const h0 = (height * l) / levels;
    const h1 = (height * (l + 1)) / levels;
    for (let k = 0; k < 4; k++) {
      const [ax, az] = corners[k]!;
      const [bx, bz] = corners[(k + 1) % 4]!;
      add(corner(ax, az, h0), corner(bx, bz, h1), 0.25);
      add(corner(bx, bz, h0), corner(ax, az, h1), 0.25);
      add(corner(ax, az, h1), corner(bx, bz, h1), 0.3);
    }
  }
  const armY = height - CABLE_DROP + 1.2;
  add(new Vector3(-PYLON_ARM_HALF, armY, 0), new Vector3(PYLON_ARM_HALF, armY, 0), 0.7);
  add(new Vector3(-topHalf, armY - 4, 0), new Vector3(-PYLON_ARM_HALF * 0.8, armY, 0), 0.3);
  add(new Vector3(topHalf, armY - 4, 0), new Vector3(PYLON_ARM_HALF * 0.8, armY, 0), 0.3);
  const insulator = new Color('#d8d2c4');
  for (const off of CABLE_OFFSETS) beams.add(new Vector3(off, armY, 0), new Vector3(off, height - CABLE_DROP, 0), 0.35, insulator);
  return beams.build();
}
/**
 * Tube along a curve (same layout and winding as TubeGeometry, without its arc-length
 * reparametrization and Frenet frames, which are slow and unnecessary for nearly straight cables).
 */
function buildTubeGeometry(curve: CatmullRomCurve3, segments: number, radius: number, radial: number): BufferGeometry {
  const rings = segments + 1;
  const positions = new Float32Array(rings * (radial + 1) * 3);
  const normals = new Float32Array(positions.length);
  const points: Vector3[] = [];
  for (let i = 0; i < rings; i++) points.push(curve.getPoint(i / segments));
  const t = new Vector3();
  const n = new Vector3();
  const b = new Vector3();
  let o = 0;
  for (let i = 0; i < rings; i++) {
    t.subVectors(points[Math.min(i + 1, segments)]!, points[Math.max(i - 1, 0)]!).normalize();
    n.crossVectors(t, UP);
    if (n.lengthSq() < 1e-8) n.set(1, 0, 0);
    n.normalize();
    b.crossVectors(t, n);
    const p = points[i]!;
    for (let j = 0; j <= radial; j++) {
      const v = (j / radial) * Math.PI * 2;
      const sin = Math.sin(v);
      const cos = -Math.cos(v);
      const nx = cos * n.x + sin * b.x;
      const ny = cos * n.y + sin * b.y;
      const nz = cos * n.z + sin * b.z;
      normals[o] = nx;
      normals[o + 1] = ny;
      normals[o + 2] = nz;
      positions[o] = p.x + radius * nx;
      positions[o + 1] = p.y + radius * ny;
      positions[o + 2] = p.z + radius * nz;
      o += 3;
    }
  }
  const index: number[] = [];
  for (let i = 1; i < rings; i++) {
    for (let j = 1; j <= radial; j++) {
      const a = (radial + 1) * (i - 1) + (j - 1);
      const c = (radial + 1) * i + j;
      const bi = (radial + 1) * i + (j - 1);
      const d = (radial + 1) * (i - 1) + j;
      index.push(a, bi, d, bi, c, d);
    }
  }
  const geo = new BufferGeometry();
  geo.setIndex(index);
  geo.setAttribute('position', new BufferAttribute(positions, 3));
  geo.setAttribute('normal', new BufferAttribute(normals, 3));
  return geo;
}

function buildArchGeometry(arch: ArchData): BufferGeometry {
  const shape = new Shape();
  const segments = 40;
  shape.moveTo(arch.uLeft, arch.bottomY);
  shape.lineTo(-arch.openHalfWidth, arch.bottomY);
  for (let i = 1; i < segments; i++) {
    const u = -arch.openHalfWidth + (2 * arch.openHalfWidth * i) / segments;
    shape.lineTo(u, archOpeningTop(arch, u));
  }
  shape.lineTo(arch.openHalfWidth, arch.bottomY);
  shape.lineTo(arch.uRight, arch.bottomY);
  shape.lineTo(arch.uRight, arch.deckY);
  shape.lineTo(arch.uLeft, arch.deckY);
  shape.closePath();
  const geo = new ExtrudeGeometry(shape, { depth: arch.halfDepth * 2, bevelEnabled: false, curveSegments: 1 });
  geo.translate(0, 0, -arch.halfDepth);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Hexahedra (deck slabs, parapets, piers) written into flat arrays. Corners come in pairs along a
 * segment a→b: lateral offsets [w0, w1] across it and heights [y0, y1] at each end. Each triangle
 * is wound to face away from the solid's centroid, so normals are right whatever the corner order.
 */
class SlabWriter {
  private readonly positions: number[] = [];
  private readonly colors: number[] = [];

  add(
    ax: number, az: number, bx: number, bz: number, w0: number, w1: number,
    ya0: number, ya1: number, yb0: number, yb1: number, color: Color,
  ): void {
    const len = Math.hypot(bx - ax, bz - az) || 1;
    const lx = -(bz - az) / len;
    const lz = (bx - ax) / len;
    const c: Array<[number, number, number]> = [];
    for (const [px, pz, y0, y1] of [[ax, az, ya0, ya1], [bx, bz, yb0, yb1]] as const) {
      for (const w of [w0, w1]) {
        c.push([px + lx * w, y0, pz + lz * w], [px + lx * w, y1, pz + lz * w]);
      }
    }
    // c index = end * 4 + side * 2 + top.
    const faces = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [1, 3, 7, 5], [0, 4, 6, 2]];
    let mx = 0;
    let my = 0;
    let mz = 0;
    for (const p of c) {
      mx += p[0] / 8;
      my += p[1] / 8;
      mz += p[2] / 8;
    }
    for (const f of faces) {
      for (const tri of [[f[0]!, f[1]!, f[2]!], [f[0]!, f[2]!, f[3]!]]) {
        const p0 = c[tri[0]!]!;
        const p1 = c[tri[1]!]!;
        const p2 = c[tri[2]!]!;
        _u.set(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
        _v.set(p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]);
        _u.cross(_v);
        const out = _u.x * ((p0[0] + p1[0] + p2[0]) / 3 - mx) + _u.y * ((p0[1] + p1[1] + p2[1]) / 3 - my) + _u.z * ((p0[2] + p1[2] + p2[2]) / 3 - mz);
        const order = out >= 0 ? [p0, p1, p2] : [p0, p2, p1];
        for (const p of order) {
          this.positions.push(p[0], p[1], p[2]);
          this.colors.push(color.r, color.g, color.b);
        }
      }
    }
  }

  build(): BufferGeometry {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(this.positions), 3));
    geo.setAttribute('color', new BufferAttribute(new Float32Array(this.colors), 3));
    geo.computeVertexNormals();
    return geo;
  }
}

const CONCRETE = new Color('#b3aea4');
const ASPHALT = new Color('#3b3c3e');
const PIER_COLOR = new Color('#9f9a90');

/** Road bridge: a concrete slab, asphalt and parapets per deck piece, plus square piers. */
function buildBridgeGeometry(span: BridgeSpan): BufferGeometry {
  const w = new SlabWriter();
  for (const p of span.pieces) {
    const hw = p.halfWidth;
    w.add(p.ax, p.az, p.bx, p.bz, -hw - 1, hw + 1, p.ay - DECK_THICKNESS, p.ay - 0.05, p.by - DECK_THICKNESS, p.by - 0.05, CONCRETE);
    w.add(p.ax, p.az, p.bx, p.bz, -hw, hw, p.ay - 0.05, p.ay + 0.05, p.by - 0.05, p.by + 0.05, ASPHALT);
    for (const [w0, w1] of [[-hw - 1, -hw - 0.6], [hw + 0.6, hw + 1]] as const) {
      w.add(p.ax, p.az, p.bx, p.bz, w0, w1, p.ay - 0.05, p.ay + PARAPET_HEIGHT, p.by - 0.05, p.by + PARAPET_HEIGHT, CONCRETE);
    }
  }
  const dx = Math.sin(span.heading) * PIER_HALF;
  const dz = Math.cos(span.heading) * PIER_HALF;
  for (const q of span.piers) {
    w.add(q.x - dx, q.z - dz, q.x + dx, q.z + dz, -PIER_HALF, PIER_HALF, q.bottomY, q.topY, q.bottomY, q.topY, PIER_COLOR);
  }
  return w.build();
}

/** Flat-roofed city buildings: the instance color is the facade, with a grid of dark windows. */
function createTowerMaterial(): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ color: '#ffffff', roughness: 0.75, metalness: 0.05 });
  const decl = '#include <common>\nvarying vec3 vTowerLocal;\nvarying vec3 vTowerNormal;';
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <common>', decl).replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
#ifdef USE_INSTANCING
  vTowerLocal = position * vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
#else
  vTowerLocal = position;
#endif
  vTowerNormal = normal;`,
    );
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', decl).replace(
      '#include <color_fragment>',
      `#include <color_fragment>
  if (abs(vTowerNormal.y) < 0.5) {
    float h = abs(vTowerNormal.x) > 0.5 ? vTowerLocal.z : vTowerLocal.x;
    vec2 g = fract(vec2(h / 3.2, vTowerLocal.y / 3.6));
    float win = step(0.2, g.x) * step(g.x, 0.8) * step(0.3, g.y) * step(g.y, 0.85) * step(4.0, vTowerLocal.y);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.07, 0.1, 0.14), win * 0.8);
  }`,
    );
  };
  m.customProgramCacheKey = () => 'props-tower-windows-v1';
  return m;
}

interface SharedResources {
  conifer: BufferGeometry;
  broadleaf: BufferGeometry;
  /** Cheaper tree shapes (same silhouette and size) for low quality. */
  coniferLow: BufferGeometry;
  broadleafLow: BufferGeometry;
  rock: BufferGeometry;
  walls: BufferGeometry;
  roof: BufferGeometry;
  marker: BufferGeometry;
  treeMaterial: MeshStandardMaterial;
  rockMaterial: MeshStandardMaterial;
  wallMaterial: MeshStandardMaterial;
  roofMaterial: MeshStandardMaterial;
  steelMaterial: MeshStandardMaterial;
  cableMaterial: MeshStandardMaterial;
  markerMaterial: MeshStandardMaterial;
  stoneMaterial: MeshStandardMaterial;
  towerMaterial: MeshStandardMaterial;
  concreteMaterial: MeshStandardMaterial;
}

function createResources(): SharedResources {
  const trunk = new Color('#5a4030');
  const conifer = mergeColored([
    {
      geometry: new CylinderGeometry(0.03, CONIFER_SHAPE.trunkRadius, CONIFER_SHAPE.trunkTop, 5).translate(0, CONIFER_SHAPE.trunkTop / 2, 0),
      color: trunk,
    },
    {
      geometry: new ConeGeometry(CONIFER_SHAPE.crownRadius, 0.55, 7).translate(0, CONIFER_SHAPE.crownBase + 0.275, 0),
      color: new Color('#2f5a2e'),
    },
    { geometry: new ConeGeometry(0.22, 0.55, 7).translate(0, 0.45 + 0.275, 0), color: new Color('#355f33') },
  ]);
  const broadleaf = mergeColored([
    {
      geometry: new CylinderGeometry(0.04, BROADLEAF_SHAPE.trunkRadius, BROADLEAF_SHAPE.trunkTop, 5).translate(0, BROADLEAF_SHAPE.trunkTop / 2, 0),
      color: trunk,
    },
    {
      geometry: new IcosahedronGeometry(BROADLEAF_SHAPE.crownRadius, 0).translate(0, BROADLEAF_SHAPE.crownCenter, 0),
      color: new Color('#4f7a34'),
    },
  ]);
  const coniferLow = mergeColored([
    {
      geometry: new CylinderGeometry(0.03, CONIFER_SHAPE.trunkRadius, CONIFER_SHAPE.trunkTop, 3).translate(0, CONIFER_SHAPE.trunkTop / 2, 0),
      color: trunk,
    },
    {
      geometry: new ConeGeometry(CONIFER_SHAPE.crownRadius, 1 - CONIFER_SHAPE.crownBase, 5).translate(0, (1 + CONIFER_SHAPE.crownBase) / 2, 0),
      color: new Color('#325d30'),
    },
  ]);
  const broadleafLow = mergeColored([
    {
      geometry: new CylinderGeometry(0.04, BROADLEAF_SHAPE.trunkRadius, BROADLEAF_SHAPE.trunkTop, 3).translate(0, BROADLEAF_SHAPE.trunkTop / 2, 0),
      color: trunk,
    },
    {
      geometry: new OctahedronGeometry(BROADLEAF_SHAPE.crownRadius, 0).translate(0, BROADLEAF_SHAPE.crownCenter, 0),
      color: new Color('#4f7a34'),
    },
  ]);
  const roofShape = new Shape();
  roofShape.moveTo(-0.55, 0);
  roofShape.lineTo(0.55, 0);
  roofShape.lineTo(0, 1);
  roofShape.closePath();
  const roof = new ExtrudeGeometry(roofShape, { depth: 1.08, bevelEnabled: false }).translate(0, 0, -0.54);
  roof.computeVertexNormals();
  const std = (params: ConstructorParameters<typeof MeshStandardMaterial>[0]): MeshStandardMaterial =>
    new MeshStandardMaterial({ roughness: 0.9, metalness: 0, ...params });
  return {
    conifer,
    broadleaf,
    coniferLow,
    broadleafLow,
    rock: new DodecahedronGeometry(1, 0),
    walls: new BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
    roof,
    marker: new SphereGeometry(1.3, 10, 8),
    treeMaterial: std({ vertexColors: true, flatShading: true }),
    rockMaterial: std({ color: '#ffffff', flatShading: true }),
    wallMaterial: std({ color: '#ffffff' }),
    roofMaterial: std({ color: '#ffffff', roughness: 0.8 }),
    steelMaterial: std({ vertexColors: true, roughness: 0.6, metalness: 0.3 }),
    cableMaterial: std({ color: '#2b2b2e', roughness: 0.5, metalness: 0.4 }),
    markerMaterial: std({ color: '#ff6a1a', roughness: 0.6 }),
    stoneMaterial: std({ color: '#9a948a', roughness: 0.95, flatShading: true }),
    towerMaterial: createTowerMaterial(),
    concreteMaterial: std({ vertexColors: true, roughness: 0.92 }),
  };
}

interface BuiltCell {
  cellX: number;
  cellZ: number;
  group: Group;
}

interface BuiltFeature {
  object: Object3D;
  geometries: BufferGeometry[];
}

/**
 * Streams trees, rocks, farm buildings, power lines and stone arch bridges around the camera.
 * Cells are generated in a Web Worker when available (synchronously otherwise) and turned into
 * instanced meshes under a per-frame time budget. Placement is pure and deterministic per cell,
 * so collision works even where meshes aren't built (or generated by the worker) yet.
 * The collidable world is generated at COLLISION_DENSITY whatever the graphics quality; quality only
 * changes the render radius (never below PROPS_MIN_VISIBLE_RADIUS) and the tree mesh detail.
 */
export class PropsManager {
  readonly group = new Group();
  private readonly res = createResources();
  private placement: PlacementOptions;
  private features: Features;
  private quality: PropsQuality;
  /** Generated cells by cellKey(), from the worker or generated synchronously. */
  private readonly cache = new Map<number, PackedCell>();
  private readonly cells = new Map<number, BuiltCell>();
  private readonly featureObjects = new Map<string, BuiltFeature>();
  /** Generated cells waiting for their meshes, nearest first. */
  private buildQueue: number[] = [];
  private buildIndex = 0;
  private readonly queued = new Set<number>();
  /** Without a worker: wanted cells still to generate, nearest first. */
  private syncQueue: number[] = [];
  private syncIndex = 0;
  private worker: Worker | null = null;
  /** Bumped when the placement changes, so stale worker results are dropped. */
  private generation = 0;
  /** Camera position the wanted-cell set was computed for. */
  private centerX = NaN;
  private centerZ = NaN;
  private dirty = true;
  private featuresPending = true;
  private readonly nearCells: PackedCell[] = [];
  private disposed = false;
  private readonly clock: () => number;
  /** Update counter, and the last update in which each cached cell was used by a collision/AI query. */
  private updateCount = 0;
  private readonly touched = new Map<number, number>();
  /** Seeded world (road bridges, settlements), or null for the Classic valley. */
  private bridgeWorld: PropsWorld | null;
  /** Road bridges near the last recenter (streamed like power lines / arches). */
  private nearBridges: readonly BridgeSite[] = [];
  private readonly builtBridges = new Map<string, BridgeSpan>();
  private readonly band: [number, number] = [0, 0];

  constructor(private options: PropsOptions) {
    this.group.name = 'props';
    this.quality = options.quality ?? 'high';
    this.clock = options.clock ?? (() => performance.now());
    this.placement = this.makePlacement();
    this.features = getFeatures(this.placement);
    this.bridgeWorld = seededWorldOf(options);
    if (this.wantsWorker()) this.startWorker();
  }

  get currentQuality(): PropsQuality {
    return this.quality;
  }

  /**
   * Switches to another world (or seed / clear zones): drops every cell, feature and cached
   * obstacle and regenerates around the camera on the next update. quality and clock are kept.
   */
  setWorld(options: PropsOptions): void {
    if (this.disposed) return;
    for (const key of [...this.cells.keys()]) this.removeCell(key);
    for (const key of [...this.featureObjects.keys()]) this.removeFeature(key);
    this.cache.clear();
    this.touched.clear();
    this.buildQueue = [];
    this.buildIndex = 0;
    this.queued.clear();
    this.syncQueue = [];
    this.syncIndex = 0;
    this.nearBridges = [];
    this.generation++;
    this.options = { ...options, quality: this.quality, clock: this.clock };
    this.placement = this.makePlacement();
    this.features = getFeatures(this.placement);
    this.bridgeWorld = seededWorldOf(this.options);
    if (!this.wantsWorker()) this.stopWorker();
    else if (this.worker) this.postInit();
    else this.startWorker();
    this.centerX = NaN;
    this.centerZ = NaN;
    this.dirty = true;
    this.featuresPending = true;
  }

  private wantsWorker(): boolean {
    const o = this.options;
    if (!(o.useWorker ?? typeof Worker !== 'undefined')) return false;
    const seeded = seededWorldOf(o);
    return !seeded || seeded.spec !== undefined;
  }

  /** Changes only what is drawn (render radius, mesh detail); the collision world stays identical. */
  setQuality(q: PropsQuality): void {
    if (q === this.quality) return;
    const detailChanged = QUALITY[q].lowDetail !== QUALITY[this.quality].lowDetail;
    this.quality = q;
    this.dirty = true;
    if (!detailChanged) return;
    for (const cell of this.cells.values()) {
      for (const child of cell.group.children) {
        const mesh = child as InstancedMesh;
        const geometry = this.meshGeometry(mesh.name as PropMeshKind);
        if (mesh.geometry === geometry) continue;
        mesh.geometry = geometry;
        mesh.computeBoundingSphere();
      }
    }
  }

  update(cameraPosition: Vector3): void {
    if (this.disposed) return;
    const start = this.clock();
    this.updateCount++;
    const dx = cameraPosition.x - this.centerX;
    const dz = cameraPosition.z - this.centerZ;
    // NaN (first call) fails the comparison too.
    if (this.dirty || !(dx * dx + dz * dz <= RECENTER_DISTANCE * RECENTER_DISTANCE)) {
      this.recenter(cameraPosition.x, cameraPosition.z);
    }
    if (this.featuresPending) this.streamFeatures();
    this.drainQueues(start);
  }

  collide(points: readonly Vector3[]): ObstacleKind | null {
    const n = points.length;
    if (n === 0) return null;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let k = 0; k < n; k++) {
      const p = points[k]!;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    const near = this.nearCells;
    near.length = 0;
    const i0 = Math.floor((minX - COLLISION_REACH) / CELL_SIZE);
    const i1 = Math.floor((maxX + COLLISION_REACH) / CELL_SIZE);
    const j0 = Math.floor((minZ - COLLISION_REACH) / CELL_SIZE);
    const j1 = Math.floor((maxZ + COLLISION_REACH) / CELL_SIZE);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        // Generated synchronously (and cached) if the worker hasn't delivered it yet.
        const cell = this.getCell(i, j);
        if (minY > cell.maxTop + 1 || maxX < cell.minX || minX > cell.maxX || maxZ < cell.minZ || minZ > cell.maxZ) continue;
        near.push(cell);
      }
    }
    const { powerLines, arches } = this.features;
    const bridges = this.bridgeWorld
      ? this.bridgeWorld.bridgesNear((minX + maxX) / 2, (minZ + maxZ) / 2, Math.hypot(maxX - minX, maxZ - minZ) / 2 + 2)
      : NO_BRIDGES;
    let result: ObstacleKind | null = null;
    for (let k = 0; k < n && !result; k++) {
      const p = points[k]!;
      for (let c = 0; c < near.length && !result; c++) result = collidePackedCell(near[c]!, p.x, p.y, p.z);
      for (let l = 0; l < powerLines.length && !result; l++) if (collidePowerLine(powerLines[l]!, p.x, p.y, p.z)) result = 'powerline';
      for (let a = 0; a < arches.length && !result; a++) if (collideArch(arches[a]!, p.x, p.y, p.z)) result = 'arch';
      // Road bridges report 'arch' too ("You hit the bridge").
      for (let b = 0; b < bridges.length && !result; b++) if (collideBridge(bridges[b]!, p.x, p.y, p.z)) result = 'arch';
    }
    near.length = 0;
    return result;
  }

  /**
   * Highest top (m) of the solid obstacles (trees, rocks, buildings, pylons) within about `radius`
   * of (x, z), or -Infinity. A cheap conservative query for AI path planning (coarse grid per cell).
   */
  obstacleTop(x: number, z: number, radius: number): number {
    let top = -Infinity;
    const i0 = Math.floor((x - radius - OBSTACLE_REACH) / CELL_SIZE);
    const i1 = Math.floor((x + radius + OBSTACLE_REACH) / CELL_SIZE);
    const j0 = Math.floor((z - radius - OBSTACLE_REACH) / CELL_SIZE);
    const j1 = Math.floor((z + radius + OBSTACLE_REACH) / CELL_SIZE);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cell = this.getCell(i, j);
        if (cell.maxTop <= top || x + radius < cell.minX || x - radius > cell.maxX || z + radius < cell.minZ || z - radius > cell.maxZ) continue;
        const grid = topGrid(cell);
        const ox = cell.cellX * CELL_SIZE - OBSTACLE_REACH;
        const oz = cell.cellZ * CELL_SIZE - OBSTACLE_REACH;
        const gx0 = Math.max(0, Math.floor((x - radius - ox) / TOP_GRID_STEP));
        const gx1 = Math.min(TOP_GRID_SIZE - 1, Math.floor((x + radius - ox) / TOP_GRID_STEP));
        const gz0 = Math.max(0, Math.floor((z - radius - oz) / TOP_GRID_STEP));
        const gz1 = Math.min(TOP_GRID_SIZE - 1, Math.floor((z + radius - oz) / TOP_GRID_STEP));
        for (let gz = gz0; gz <= gz1; gz++) {
          for (let gx = gx0; gx <= gx1; gx++) {
            const v = grid[gz * TOP_GRID_SIZE + gx]!;
            if (v > top) top = v;
          }
        }
      }
    }
    const reach = radius + PYLON_ARM_HALF + 1;
    for (const line of this.features.powerLines) {
      for (const p of line.pylons) {
        if (Math.abs(x - p.x) <= reach && Math.abs(z - p.z) <= reach) top = Math.max(top, p.y + p.height);
      }
    }
    if (this.bridgeWorld) {
      const pierReach = radius + PIER_HALF * Math.SQRT2;
      for (const site of this.bridgeWorld.bridgesNear(x, z, radius + 1)) {
        for (const p of bridgeSpanOf(site).piers) {
          if (Math.abs(x - p.x) <= pierReach && Math.abs(z - p.z) <= pierReach) top = Math.max(top, p.topY);
        }
      }
    }
    return top;
  }

  /**
   * Elevated hazards a jet can pass under or over at (x, z) within `radius`: power cables, the
   * stone of arch bridges and road bridge decks. Writes [bottom, top] pairs into `out` and returns the number of bands.
   */
  hazardBands(x: number, z: number, radius: number, out: number[]): number {
    let n = 0;
    if (this.bridgeWorld) {
      for (const site of this.bridgeWorld.bridgesNear(x, z, radius + 1)) {
        if (!bridgeDeckBand(site, x, z, radius, this.band)) continue;
        out[n * 2] = this.band[0];
        out[n * 2 + 1] = this.band[1];
        n++;
      }
    }
    for (const line of this.features.powerLines) {
      const b = line.bounds;
      if (x < b.minX - radius || x > b.maxX + radius || z < b.minZ - radius || z > b.maxZ + radius) continue;
      let lo = Infinity;
      let hi = -Infinity;
      const reach2 = (radius + CABLE_HIT_RADIUS) ** 2;
      for (const cable of line.cables) {
        for (let k = 0; k < cable.length - 1; k++) {
          const a = cable[k]!;
          const c = cable[k + 1]!;
          const sx = c[0] - a[0];
          const sz = c[2] - a[2];
          const l2 = sx * sx + sz * sz;
          const t = l2 > 0 ? Math.min(1, Math.max(0, ((x - a[0]) * sx + (z - a[2]) * sz) / l2)) : 0;
          const dx = a[0] + sx * t - x;
          const dz = a[2] + sz * t - z;
          if (dx * dx + dz * dz > reach2) continue;
          lo = Math.min(lo, a[1], c[1]);
          hi = Math.max(hi, a[1], c[1]);
        }
      }
      if (lo <= hi) {
        out[n * 2] = lo - CABLE_HIT_RADIUS;
        out[n * 2 + 1] = hi + CABLE_HIT_RADIUS;
        n++;
      }
    }
    for (const arch of this.features.arches) {
      const dx = x - arch.x;
      const dz = z - arch.z;
      const c = Math.cos(arch.heading);
      const s = Math.sin(arch.heading);
      const u = dx * c - dz * s;
      const w = dx * s + dz * c;
      if (Math.abs(w) > arch.halfDepth + radius || u < arch.uLeft - radius || u > arch.uRight + radius) continue;
      const inOpening = u - radius > -arch.openHalfWidth && u + radius < arch.openHalfWidth;
      // The intrados is highest at the middle, so its lowest point over [u - r, u + r] is at an end.
      out[n * 2] = inOpening ? Math.min(archOpeningTop(arch, u - radius), archOpeningTop(arch, u + radius)) : arch.bottomY;
      out[n * 2 + 1] = arch.deckY;
      n++;
    }
    return n;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopWorker();
    for (const key of [...this.cells.keys()]) this.removeCell(key);
    for (const key of [...this.featureObjects.keys()]) this.removeFeature(key);
    this.cache.clear();
    this.touched.clear();
    this.buildQueue = [];
    this.queued.clear();
    this.syncQueue = [];
    for (const value of Object.values(this.res) as Array<BufferGeometry | Material>) value.dispose();
    this.group.removeFromParent();
  }

  private makePlacement(): PlacementOptions {
    const o = this.options;
    const zones: ClearZone[] | undefined = o.clearZones;
    const seeded = seededWorldOf(o);
    if (seeded) return seededPlacement(o.seed, seeded, zones, COLLISION_DENSITY);
    return {
      seed: o.seed,
      heightAt: o.heightAt,
      valleyCenterX: o.valleyCenterX ?? o.world?.classicValleyCenterX,
      powerLineZ: o.powerLineZ,
      archZ: o.archZ,
      clearZones: zones,
      density: COLLISION_DENSITY,
    };
  }

  private startWorker(): void {
    try {
      this.worker = new Worker(new URL('./propsWorker.ts', import.meta.url), { type: 'module' });
    } catch (err) {
      console.warn('Props worker unavailable; generating props on the main thread.', err);
      this.worker = null;
      return;
    }
    this.worker.onmessage = (e: MessageEvent<PropsWorkerResult>): void => this.onWorkerResult(e.data);
    this.worker.onerror = (e: ErrorEvent): void => {
      console.warn('Props worker failed; generating props on the main thread.', e.message);
      this.stopWorker();
      this.dirty = true;
    };
    this.postInit();
  }

  private stopWorker(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  private postInit(): void {
    if (!this.worker) return;
    const o = this.options;
    const seeded = seededWorldOf(o);
    const msg: PropsWorkerInit = {
      type: 'init',
      generation: this.generation,
      seed: o.seed,
      world: seeded?.spec,
      powerLineZ: [...(o.powerLineZ ?? [])],
      archZ: [...(o.archZ ?? [])],
      clearZones: (o.clearZones ?? []).map((z) => ({ x: z.x, z: z.z, halfWidth: z.halfWidth, halfLength: z.halfLength, heading: z.heading })),
      density: COLLISION_DENSITY,
    };
    this.worker.postMessage(msg);
  }

  private onWorkerResult(result: PropsWorkerResult): void {
    if (this.disposed || result.generation !== this.generation) return;
    const { cell } = result;
    const key = cellKey(cell.cellX, cell.cellZ);
    if (!this.cache.has(key)) this.cache.set(key, cell);
    this.enqueueIfWanted(key, cell.cellX, cell.cellZ);
  }

  /** Recomputes the wanted cells around (cx, cz): drops far meshes and cache entries, queues builds and generation. */
  private recenter(cx: number, cz: number): void {
    this.dirty = false;
    this.centerX = cx;
    this.centerZ = cz;
    const { radius } = QUALITY[this.quality];
    // With a worker, cells are generated out to DATA_RADIUS at every quality (collision/AI data ready
    // early, off the main thread); without one only the drawn cells are generated ahead of time.
    const dataRadius = this.worker ? Math.max(radius, DATA_RADIUS) : radius;

    for (const [key, cell] of this.cells) {
      if (cellDistance(cell.cellX, cell.cellZ, cx, cz) > radius + CELL_SIZE) this.removeCell(key);
    }
    for (const [key, cell] of this.cache) {
      if (this.cells.has(key) || cellDistance(cell.cellX, cell.cellZ, cx, cz) <= dataRadius + CACHE_MARGIN) continue;
      // Cells recently used by collision / AI queries (racers away from the camera) stay cached.
      if (this.updateCount - (this.touched.get(key) ?? -Infinity) < TOUCH_KEEP_UPDATES) continue;
      this.cache.delete(key);
      this.touched.delete(key);
    }

    const wanted: Array<{ key: number; i: number; j: number; d: number }> = [];
    const i0 = Math.floor((cx - dataRadius) / CELL_SIZE);
    const i1 = Math.floor((cx + dataRadius) / CELL_SIZE);
    const j0 = Math.floor((cz - dataRadius) / CELL_SIZE);
    const j1 = Math.floor((cz + dataRadius) / CELL_SIZE);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d = cellNearestDistance(i, j, cx, cz);
        const key = cellKey(i, j);
        if (d <= dataRadius && !this.cells.has(key)) wanted.push({ key, i, j, d });
      }
    }
    wanted.sort((a, b) => a.d - b.d);

    this.buildQueue = [];
    this.buildIndex = 0;
    this.queued.clear();
    const missingCells: number[] = [];
    const missingKeys: number[] = [];
    for (const w of wanted) {
      if (this.cache.has(w.key)) {
        if (w.d <= radius) {
          this.buildQueue.push(w.key);
          this.queued.add(w.key);
        }
      } else {
        missingCells.push(w.i, w.j);
        missingKeys.push(w.key);
      }
    }
    if (this.worker) {
      const msg: PropsWorkerRequest = { type: 'request', generation: this.generation, cells: missingCells };
      this.worker.postMessage(msg);
      this.syncQueue = [];
    } else {
      this.syncQueue = missingKeys;
    }
    this.syncIndex = 0;
    this.nearBridges = this.bridgeWorld ? this.bridgeWorld.bridgesNear(cx, cz, radius + 600) : NO_BRIDGES;
    this.featuresPending = true;
  }

  private enqueueIfWanted(key: number, i: number, j: number): void {
    if (this.cells.has(key) || this.queued.has(key)) return;
    if (!(cellNearestDistance(i, j, this.centerX, this.centerZ) <= QUALITY[this.quality].radius)) return;
    this.buildQueue.push(key);
    this.queued.add(key);
  }

  /** Builds queued meshes (and, without a worker, generates cells) until the frame budget is used. */
  private drainQueues(start: number): void {
    const keepRadius = QUALITY[this.quality].radius + CELL_SIZE;
    // At least one item per update, so progress never depends on how fast the clock runs.
    let first = true;
    while (first || this.clock() - start < FRAME_BUDGET_MS) {
      first = false;
      if (this.buildIndex < this.buildQueue.length) {
        const key = this.buildQueue[this.buildIndex++]!;
        this.queued.delete(key);
        const cell = this.cache.get(key);
        if (!cell || this.cells.has(key)) continue;
        if (cellDistance(cell.cellX, cell.cellZ, this.centerX, this.centerZ) > keepRadius) continue;
        this.buildCell(key, cell);
        continue;
      }
      if (this.syncIndex < this.syncQueue.length) {
        const key = this.syncQueue[this.syncIndex++]!;
        if (!this.cells.has(key)) this.buildCell(key, this.getCell(keyX(key), keyZ(key)));
        continue;
      }
      break;
    }
    if (this.buildIndex >= this.buildQueue.length && this.buildQueue.length > 0) {
      this.buildQueue = [];
      this.buildIndex = 0;
    }
  }

  private getCell(i: number, j: number): PackedCell {
    const key = cellKey(i, j);
    let cell = this.cache.get(key);
    if (!cell) {
      cell = packCell(generateCell(i, j, CELL_SIZE, this.placement));
      this.cache.set(key, cell);
      if (!Number.isNaN(this.centerX)) this.enqueueIfWanted(key, i, j);
    }
    this.touched.set(key, this.updateCount);
    return cell;
  }

  private meshGeometry(kind: PropMeshKind): BufferGeometry {
    const r = this.res;
    const low = QUALITY[this.quality].lowDetail;
    switch (kind) {
      case 'conifer':
        return low ? r.coniferLow : r.conifer;
      case 'broadleaf':
        return low ? r.broadleafLow : r.broadleaf;
      case 'rock':
        return r.rock;
      case 'walls':
        return r.walls;
      case 'roof':
        return r.roof;
      case 'tower':
        return r.walls;
    }
  }

  private buildCell(key: number, data: PackedCell): void {
    const group = new Group();
    group.name = `props-cell-${data.cellX},${data.cellZ}`;
    const r = this.res;
    const parts: ReadonlyArray<readonly [PropMeshKind, MeshStandardMaterial]> = [
      ['conifer', r.treeMaterial],
      ['broadleaf', r.treeMaterial],
      ['rock', r.rockMaterial],
      ['walls', r.wallMaterial],
      ['roof', r.roofMaterial],
      ['tower', r.towerMaterial],
    ];
    for (const [kind, material] of parts) {
      const { matrices, colors } = data.instances[kind];
      const count = colors.length / 3;
      if (count === 0) continue;
      // Uses the packed arrays directly: no per-instance work on the main thread.
      const mesh = new InstancedMesh(this.meshGeometry(kind), material, 0);
      mesh.name = kind;
      mesh.instanceMatrix = new InstancedBufferAttribute(matrices, 16);
      mesh.instanceColor = new InstancedBufferAttribute(colors, 3);
      mesh.count = count;
      mesh.computeBoundingSphere();
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    this.group.add(group);
    this.cells.set(key, { cellX: data.cellX, cellZ: data.cellZ, group });
  }

  private removeCell(key: number): void {
    const cell = this.cells.get(key);
    if (!cell) return;
    for (const child of cell.group.children) (child as InstancedMesh).dispose();
    cell.group.removeFromParent();
    this.cells.delete(key);
  }

  /** Builds at most one power line / arch per frame; stays pending until a pass builds nothing. */
  private streamFeatures(): void {
    const { radius } = QUALITY[this.quality];
    const cx = this.centerX;
    const cz = this.centerZ;
    let featureBudget = FEATURES_PER_UPDATE;
    this.features.powerLines.forEach((line, idx) => {
      const [p0, p1] = line.pylons;
      const d = Math.hypot((p0.x + p1.x) / 2 - cx, (p0.z + p1.z) / 2 - cz);
      featureBudget = this.streamFeature(`p${idx}`, d, radius, featureBudget, () => this.buildPowerLine(line));
    });
    this.features.arches.forEach((arch, idx) => {
      const d = Math.hypot(arch.x - cx, arch.z - cz);
      featureBudget = this.streamFeature(`a${idx}`, d, radius, featureBudget, () => this.buildArch(arch));
    });
    for (const site of this.nearBridges) {
      const span = bridgeSpanOf(site);
      const key = `b:${span.key}`;
      const d = Math.max(0, Math.hypot(span.x - cx, span.z - cz) - span.halfSpan);
      featureBudget = this.streamFeature(key, d, radius, featureBudget, () => this.buildBridge(key, span));
    }
    for (const [key, span] of this.builtBridges) {
      if (Math.hypot(span.x - cx, span.z - cz) - span.halfSpan > radius + 1000) this.removeFeature(key);
    }
    this.featuresPending = featureBudget < FEATURES_PER_UPDATE;
  }
  private streamFeature(key: string, distance: number, radius: number, budget: number, build: () => BuiltFeature): number {
    const built = this.featureObjects.has(key);
    if (!built && budget > 0 && distance <= radius + 600) {
      const feature = build();
      feature.object.traverse((o) => {
        o.castShadow = false;
        o.receiveShadow = true;
      });
      this.group.add(feature.object);
      this.featureObjects.set(key, feature);
      return budget - 1;
    }
    if (built && distance > radius + 1000) this.removeFeature(key);
    return budget;
  }

  private removeFeature(key: string): void {
    const feature = this.featureObjects.get(key);
    if (!feature) return;
    for (const g of feature.geometries) g.dispose();
    feature.object.removeFromParent();
    this.featureObjects.delete(key);
    this.builtBridges.delete(key);
  }

  private buildBridge(key: string, span: BridgeSpan): BuiltFeature {
    const geo = buildBridgeGeometry(span);
    const mesh = new Mesh(geo, this.res.concreteMaterial);
    mesh.name = `bridge-${span.key}`;
    this.builtBridges.set(key, span);
    return { object: mesh, geometries: [geo] };
  }

  private buildPowerLine(line: PowerLineData): BuiltFeature {
    const group = new Group();
    group.name = `powerline-${line.z}`;
    const geometries: BufferGeometry[] = [];
    const addPylon = (p: PylonData): void => {
      const geo = buildPylonGeometry(p.height);
      geometries.push(geo);
      const mesh = new Mesh(geo, this.res.steelMaterial);
      mesh.position.set(p.x, p.y, p.z);
      mesh.rotation.y = p.heading;
      group.add(mesh);
    };
    addPylon(line.pylons[0]);
    addPylon(line.pylons[1]);
    line.cables.forEach((cable, idx) => {
      const curve = new CatmullRomCurve3(cable.map(([x, y, z]) => new Vector3(x, y, z)));
      const geo = buildTubeGeometry(curve, 64, 0.22, 5);
      geometries.push(geo);
      group.add(new Mesh(geo, this.res.cableMaterial));
      if (idx === 1) {
        for (const t of [0.3, 0.5, 0.7]) {
          const marker = new Mesh(this.res.marker, this.res.markerMaterial);
          marker.position.copy(curve.getPointAt(t));
          group.add(marker);
        }
      }
    });
    return { object: group, geometries };
  }

  private buildArch(arch: ArchData): BuiltFeature {
    const geo = buildArchGeometry(arch);
    const mesh = new Mesh(geo, this.res.stoneMaterial);
    mesh.name = `arch-${arch.z}`;
    mesh.position.set(arch.x, 0, arch.z);
    mesh.rotation.y = arch.heading;
    return { object: mesh, geometries: [geo] };
  }
}

/** Numeric key for cell (i, j); indices stay within ±32768 (±13,000 km). */
function cellKey(i: number, j: number): number {
  return (i + 32768) * 65536 + (j + 32768);
}

function keyX(key: number): number {
  return Math.floor(key / 65536) - 32768;
}

function keyZ(key: number): number {
  return (key % 65536) - 32768;
}

function cellDistance(i: number, j: number, x: number, z: number): number {
  return Math.hypot((i + 0.5) * CELL_SIZE - x, (j + 0.5) * CELL_SIZE - z);
}

/** Distance from (x, z) to the nearest point of cell (i, j) (0 inside it). */
function cellNearestDistance(i: number, j: number, x: number, z: number): number {
  const x0 = i * CELL_SIZE;
  const z0 = j * CELL_SIZE;
  const dx = x < x0 ? x0 - x : x > x0 + CELL_SIZE ? x - x0 - CELL_SIZE : 0;
  const dz = z < z0 ? z0 - z : z > z0 + CELL_SIZE ? z - z0 - CELL_SIZE : 0;
  return Math.hypot(dx, dz);
}

const topGrids = new WeakMap<PackedCell, Float32Array>();
/**
 * Highest obstacle top per TOP_GRID_STEP square, covering the cell plus OBSTACLE_REACH on each side;
 * every obstacle is rasterized over the squares its horizontal reach touches.
 */
function topGrid(cell: PackedCell): Float32Array {
  let grid = topGrids.get(cell);
  if (grid) return grid;
  grid = new Float32Array(TOP_GRID_SIZE * TOP_GRID_SIZE).fill(-Infinity);
  const ox = cell.cellX * CELL_SIZE - OBSTACLE_REACH;
  const oz = cell.cellZ * CELL_SIZE - OBSTACLE_REACH;
  const g = grid;
  const stamp = (x: number, z: number, reach: number, top: number): void => {
    const gx0 = Math.max(0, Math.floor((x - reach - ox) / TOP_GRID_STEP));
    const gx1 = Math.min(TOP_GRID_SIZE - 1, Math.floor((x + reach - ox) / TOP_GRID_STEP));
    const gz0 = Math.max(0, Math.floor((z - reach - oz) / TOP_GRID_STEP));
    const gz1 = Math.min(TOP_GRID_SIZE - 1, Math.floor((z + reach - oz) / TOP_GRID_STEP));
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const k = gz * TOP_GRID_SIZE + gx;
        if (top > g[k]!) g[k] = top;
      }
    }
  };
  const t = cell.trees;
  for (let o = 0; o < t.length; o += TREE_STRIDE) stamp(t[o]!, t[o + 2]!, t[o + 3]! * t[o + 4]! * 0.4, t[o + 1]! + t[o + 3]!);
  const r = cell.rocks;
  for (let o = 0; o < r.length; o += ROCK_STRIDE) stamp(r[o]!, r[o + 2]!, r[o + 3]!, r[o + 1]! + r[o + 3]! * r[o + 4]!);
  const b = cell.buildings;
  for (let o = 0; o < b.length; o += BUILDING_STRIDE) {
    stamp(b[o]!, b[o + 2]!, Math.hypot(b[o + 3]!, b[o + 4]!) / 2, b[o + 1]! + b[o + 5]! + b[o + 6]!);
  }
  topGrids.set(cell, grid);
  return grid;
}
