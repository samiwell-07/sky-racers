import { Box3, FrontSide, Mesh, Raycaster, Vector3, type BufferGeometry, type Object3D } from 'three';
import { describe, expect, it } from 'vitest';
import { createFlightConfig } from '../src/config/flightConfig';
import { disposeObject3D } from '../src/entities/jet/disposeObject';
import { Jet } from '../src/entities/jet/Jet';
import { JET_CATALOG } from '../src/entities/jet/jetCatalog';
import { getJetDesign } from '../src/entities/jet/jetDesigns';
import { buildJetModel, GEAR_HEIGHT } from '../src/entities/jet/JetModel';

function meshesOf(root: Object3D): Mesh[] {
  const meshes: Mesh[] = [];
  root.traverse((object) => {
    if (object instanceof Mesh) meshes.push(object);
  });
  return meshes;
}

function opaqueMeshes(root: Object3D): Mesh[] {
  return meshesOf(root).filter((mesh) =>
    (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).every((material) => !material.transparent),
  );
}

function openEdges(geometry: BufferGeometry): number {
  const positions = geometry.getAttribute('position');
  const vertexKeys = Array.from({ length: positions.count }, (_, i) =>
    [positions.getX(i), positions.getY(i), positions.getZ(i)].map((value) => Math.round(value * 100_000)).join(','),
  );
  const indices = geometry.getIndex();
  const edges = new Map<string, number>();
  const count = indices?.count ?? positions.count;
  for (let i = 0; i < count; i += 3) {
    const triangle = [0, 1, 2].map((offset) => vertexKeys[indices ? indices.getX(i + offset) : i + offset]!);
    // Sphere and lathe pole triangles collapse after welding their coincident vertices.
    if (new Set(triangle).size < 3) continue;
    for (let side = 0; side < 3; side++) {
      const key = [triangle[side]!, triangle[(side + 1) % 3]!].sort().join('|');
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  return [...edges.values()].filter((count) => count !== 2).length;
}

const ray = new Raycaster();
const down = new Vector3(0, -1, 0);

function topSilhouette(root: Object3D): Set<number> {
  const meshes = opaqueMeshes(root).filter((mesh) => /^(wing|aileron|flap)-(left|right)$/.test(mesh.name));
  const result = new Set<number>();
  let pixel = 0;
  for (let z = -10.5; z <= 9.5; z += 0.35) {
    for (let x = -6.75; x <= 6.75; x += 0.35) {
      ray.set(new Vector3(x, 10, z), down);
      if (ray.intersectObjects(meshes, false).length) result.add(pixel);
      pixel++;
    }
  }
  return result;
}

describe('procedural aircraft geometry', { timeout: 20_000 }, () => {
  it.each(JET_CATALOG)('$id has sealed airframe shells, backed openings, and a solid cockpit', (definition) => {
    const parts = buildJetModel(definition.paint, definition.id);
    parts.root.updateMatrixWorld(true);
    try {
      const solids = opaqueMeshes(parts.root);
      for (const mesh of solids) {
        // A recessed disk can be open at its rim; the enclosing engine housing is tested separately.
        if (mesh.geometry.type === 'CircleGeometry') continue;
        expect(openEdges(mesh.geometry), `${definition.id}: ${mesh.name || mesh.geometry.type}`).toBe(0);
      }
      const fuselage = parts.root.getObjectByName('fuselage');
      expect(fuselage).toBeInstanceOf(Mesh);
      if (!(fuselage instanceof Mesh)) throw new Error('Missing fuselage mesh');
      expect(Array.isArray(fuselage.material)).toBe(false);
      if (Array.isArray(fuselage.material)) throw new Error('Unexpected fuselage material array');
      expect(fuselage.material.side).toBe(FrontSide);

      for (const [origin, direction] of [
        [new Vector3(0, 0, -15), new Vector3(0, 0, 1)],
        [new Vector3(0, 0, 15), new Vector3(0, 0, -1)],
        [new Vector3(0, 10, parts.canopy.position.z), down],
        ...parts.nozzles.map((nozzle) => [
          new Vector3(nozzle.x, nozzle.y, nozzle.z + 2),
          new Vector3(0, 0, -1),
        ]),
      ]) {
        ray.set(origin!, direction!);
        expect(ray.intersectObjects(solids, false).length, `${definition.id}: opaque backing`).toBeGreaterThan(0);
      }
    } finally {
      disposeObject3D(parts.root);
    }
  });

  it.each(JET_CATALOG)('$id has no daylight between its wing roots and fuselage', (definition) => {
    const parts = buildJetModel(definition.paint, definition.id);
    parts.root.updateMatrixWorld(true);
    try {
      const solids = opaqueMeshes(parts.root);
      const wing = getJetDesign(definition.id).wing;
      const rootX = Math.min(...wing.map((point) => point[0]));
      const rootPoints = wing.filter((point) => point[0] === rootX);
      const minZ = Math.min(...rootPoints.map((point) => point[1]));
      const maxZ = Math.max(...rootPoints.map((point) => point[1]));
      for (let z = minZ + 0.15; z < maxZ - 0.15; z += 0.3) {
        const crossings: number[] = [];
        for (let i = 0; i < wing.length; i++) {
          const [ax, az] = wing[i]!;
          const [bx, bz] = wing[(i + 1) % wing.length]!;
          if ((az <= z && bz > z) || (bz <= z && az > z)) {
            crossings.push(ax + (bx - ax) * (z - az) / (bz - az));
          }
        }
        crossings.sort((a, b) => a - b);
        // A forward-swept wing can cross this station twice; only its inner interval is the root.
        const outer = crossings[1]!;
        for (let x = 0; x < outer - 0.05; x += 0.15) {
          for (const side of [-1, 1]) {
            ray.set(new Vector3(x * side, 10, z), down);
            expect(ray.intersectObjects(solids, false).length, `${definition.id}: wing root (${x * side}, ${z})`).toBeGreaterThan(0);
          }
        }
      }
    } finally {
      disposeObject3D(parts.root);
    }
  });

  it.each(JET_CATALOG)('$id keeps its sloped wing hinges closed while controls move', (definition) => {
    const parts = buildJetModel(definition.paint, definition.id);
    const design = getJetDesign(definition.id);
    try {
      const solids = opaqueMeshes(parts.root);
      for (const [groups, control] of [
        [[parts.aileronLeft, parts.aileronRight], design.controls.aileron],
        [[parts.flapLeft, parts.flapRight], design.controls.flap],
      ] as const) {
        for (const group of groups) {
          const side = group === parts.aileronLeft || group === parts.flapLeft ? -1 : 1;
          for (const angle of [-0.45, 0, 0.45]) {
            group.rotation.x = angle;
            parts.root.updateMatrixWorld(true);
            for (const fraction of [-0.4, 0, 0.4]) {
              const x = control.x + fraction * control.span;
              const crossings: number[] = [];
              for (let i = 0; i < design.wing.length; i++) {
                const [ax, az] = design.wing[i]!;
                const [bx, bz] = design.wing[(i + 1) % design.wing.length]!;
                if ((ax <= x && bx > x) || (bx <= x && ax > x)) {
                  crossings.push(az + (bz - az) * (x - ax) / (bx - ax));
                }
              }
              const hingeZ = Math.max(...crossings) - control.chord;
              for (const offset of [-0.02, 0.02]) {
                ray.set(new Vector3(x * side, 10, hingeZ + offset), down);
                expect(ray.intersectObjects(solids, false).length, `${definition.id}: hinge ${x}, ${angle}`).toBeGreaterThan(0);
              }
            }
          }
        }
      }
    } finally {
      disposeObject3D(parts.root);
    }
  });

  it('gives every catalog entry a visibly distinct wing silhouette even with identical paint', () => {
    const silhouettes = JET_CATALOG.map((definition) => {
      const parts = buildJetModel(JET_CATALOG[0]!.paint, definition.id);
      parts.root.updateMatrixWorld(true);
      try {
        return { id: definition.id, pixels: topSilhouette(parts.root) };
      } finally {
        disposeObject3D(parts.root);
      }
    });
    for (let i = 0; i < silhouettes.length; i++) {
      for (let j = i + 1; j < silhouettes.length; j++) {
        const a = silhouettes[i]!;
        const b = silhouettes[j]!;
        const union = new Set([...a.pixels, ...b.pixels]);
        const difference = [...union].filter((pixel) => a.pixels.has(pixel) !== b.pixels.has(pixel)).length;
        expect(difference / union.size, `${a.id} vs ${b.id}`).toBeGreaterThan(0.05);
      }
    }
  });

  it.each(JET_CATALOG)('$id wires the selected model and attachments within the existing flight envelope', (definition) => {
    const jet = new Jet(definition, createFlightConfig(definition.flight), false);
    try {
      jet.parts.root.updateMatrixWorld(true);
      const bounds = new Box3().setFromObject(jet.parts.root);
      expect(bounds.min.y).toBeCloseTo(-GEAR_HEIGHT, 4);
      expect(bounds.min.x).toBeGreaterThanOrEqual(-6.9);
      expect(bounds.max.x).toBeLessThanOrEqual(6.9);
      expect(bounds.min.z).toBeGreaterThanOrEqual(-10.6);
      expect(bounds.max.z).toBeLessThanOrEqual(9.7);
      expect(bounds.max.y).toBeLessThanOrEqual(4);
      expect(jet.parts.nozzles).toHaveLength(getJetDesign(definition.id).engines.length);
      expect(jet.parts.navigationLights.tails).toHaveLength(getJetDesign(definition.id).fins.length);
      expect(jet.lights.group.children).toHaveLength(2 * jet.parts.navigationLights.wings.length + jet.parts.navigationLights.tails.length + 3);
    } finally {
      jet.dispose();
    }
  });
});
