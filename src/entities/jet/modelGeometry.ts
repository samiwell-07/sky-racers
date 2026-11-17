import { BufferGeometry, ExtrudeGeometry, Float32BufferAttribute, Shape, Vector2 } from 'three';
import type { Outline } from './jetDesigns';

/**
 * A capped body of revolution in the aircraft frame. Single vertices at the poles
 * avoid the degenerate triangles left by adding zero-radius rings to a lathe.
 * Profiles may fold back on themselves to form a solid, backed recess.
 */
export function closedBody(profile: Outline, segments = 28, boxy = false): BufferGeometry {
  const first = profile[0]!;
  const last = profile[profile.length - 1]!;
  const capped: Outline = [
    ...(first[0] > 0 ? [[0, first[1]] as [number, number]] : []),
    ...profile,
    ...(last[0] > 0 ? [[0, last[1]] as [number, number]] : []),
  ];
  const positions: number[] = [];
  const uv: number[] = [];
  const indices: number[] = [];
  const rings: number[][] = [];
  const distances = [0];
  for (let i = 1; i < capped.length; i++) {
    distances.push(distances[i - 1]! + Math.hypot(
      capped[i]![0] - capped[i - 1]![0], capped[i]![1] - capped[i - 1]![1],
    ));
  }
  const length = distances[distances.length - 1]!;
  capped.forEach(([radius, forward], i) => {
    const ring: number[] = [];
    for (let j = 0; j < (radius === 0 ? 1 : segments + 1); j++) {
      const angle = (j % segments) / segments * Math.PI * 2;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      ring.push(positions.length / 3);
      positions.push(
        radius * (boxy ? Math.sign(c) * Math.sqrt(Math.abs(c)) : c),
        radius * (boxy ? Math.sign(s) * Math.sqrt(Math.abs(s)) : s),
        -forward,
      );
      uv.push(j / segments, distances[i]! / length);
    }
    rings.push(ring);
  });
  for (let i = 0; i < rings.length - 1; i++) {
    const a = rings[i]!;
    const b = rings[i + 1]!;
    for (let j = 0; j < segments; j++) {
      const next = j + 1;
      if (a.length === 1) {
        indices.push(a[0]!, b[j]!, b[next]!);
      } else if (b.length === 1) {
        indices.push(a[j]!, b[0]!, a[next]!);
      } else {
        indices.push(a[j]!, b[j]!, a[next]!, a[next]!, b[j]!, b[next]!);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const normals = geometry.getAttribute('normal');
  for (const ring of rings) {
    if (ring.length === 1) continue;
    const firstVertex = ring[0]!;
    const lastVertex = ring[segments]!;
    const x = normals.getX(firstVertex) + normals.getX(lastVertex);
    const y = normals.getY(firstVertex) + normals.getY(lastVertex);
    const z = normals.getZ(firstVertex) + normals.getZ(lastVertex);
    const magnitude = Math.hypot(x, y, z);
    normals.setXYZ(firstVertex, x / magnitude, y / magnitude, z / magnitude);
    normals.setXYZ(lastVertex, x / magnitude, y / magnitude, z / magnitude);
  }
  return geometry;
}

/** Closed, thin horizontal solid, with no collinear edges that could create cap T-junctions. */
export function flatPanel(outline: Outline, thickness: number): BufferGeometry {
  const points = outline.filter(([x, z], i) => {
    const a = outline[(i + outline.length - 1) % outline.length]!;
    const b = outline[(i + 1) % outline.length]!;
    return Math.abs((x - a[0]) * (b[1] - z) - (z - a[1]) * (b[0] - x)) > 1e-8;
  });
  const shape = new Shape(points.map(([x, z]) => new Vector2(x, z)));
  const geometry = new ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, steps: 1 });
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, thickness / 2, 0);
  return geometry;
}

export function mirrored(outline: Outline): Outline {
  return outline.map(([x, z]) => [-x, z]);
}

export function wingEdge(outline: Outline, x: number, trailing: boolean): number {
  const intersections: number[] = [];
  outline.forEach(([ax, az], i) => {
    const [bx, bz] = outline[(i + 1) % outline.length]!;
    if (x < Math.min(ax, bx) - 1e-7 || x > Math.max(ax, bx) + 1e-7) return;
    if (Math.abs(bx - ax) < 1e-7) intersections.push(az, bz);
    else intersections.push(az + (bz - az) * (x - ax) / (bx - ax));
  });
  return trailing ? Math.max(...intersections) : Math.min(...intersections);
}

export interface WingControl {
  x: number;
  span: number;
  chord: number;
}

/** Trim the fixed wing to its real control hinge, leaving a small overlap with the hinge barrel. */
export function fixedWing(outline: Outline, controls: WingControl[]): Outline {
  const result: Outline = [];
  outline.forEach((a, i) => {
    const b = outline[(i + 1) % outline.length]!;
    result.push(a);
    const middleX = (a[0] + b[0]) / 2;
    if (Math.abs(b[0] - a[0]) < 1e-7
      || Math.abs(wingEdge(outline, middleX, true) - (a[1] + b[1]) / 2) > 1e-6) return;
    const direction = Math.sign(b[0] - a[0]);
    const cuts = controls.filter((control) =>
      control.x - control.span / 2 >= Math.min(a[0], b[0]) - 1e-7
      && control.x + control.span / 2 <= Math.max(a[0], b[0]) + 1e-7,
    ).sort((left, right) => direction * (left.x - right.x));
    for (const control of cuts) {
      const enter = control.x - direction * control.span / 2;
      const leave = control.x + direction * control.span / 2;
      const enterZ = wingEdge(outline, enter, true);
      const leaveZ = wingEdge(outline, leave, true);
      result.push(
        [enter, enterZ], [enter, enterZ - control.chord + 0.025],
        [leave, leaveZ - control.chord + 0.025], [leave, leaveZ],
      );
    }
  });
  return result;
}
