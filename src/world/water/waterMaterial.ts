import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Box3,
  Color,
  Mesh,
  MeshStandardMaterial,
  NoColorSpace,
  RepeatWrapping,
  Sphere,
  Vector2,
  Vector3,
} from 'three';
import { mulberry32 } from '../../utils/random';
import { tileableValueNoise } from '../terrain/terrainTextures';
import { SHALLOW_WATER_COLOR, type WaterArrays } from './waterArrays';

/** Tileable ripple normal map (two octaves of value noise). Needs a DOM canvas. */
export function rippleNormalMap(size = 256): CanvasTexture {
  const h = tileableValueNoise(size, 16, mulberry32(77));
  const h2 = tileableValueNoise(size, 64, mulberry32(78));
  const at = (x: number, y: number): number => {
    const i = ((y + size) % size) * size + ((x + size) % size);
    return h[i]! * 0.6 + h2[i]! * 0.4;
  };
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (at(x - 1, y) - at(x + 1, y)) * 4;
      const ny = (at(x, y - 1) - at(x, y + 1)) * 4;
      const len = Math.hypot(nx, ny, 1);
      const i = (y * size + x) * 4;
      img.data[i] = ((nx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.colorSpace = NoColorSpace;
  return tex;
}

/** Animates a ripple normal map (shared by the chunk water and the Classic River). */
export function animateRipples(tex: CanvasTexture, time: number): void {
  tex.offset.set(time * 0.02, time * 0.05);
}

let material: MeshStandardMaterial | null = null;
let ripples: CanvasTexture | null = null;

/** The one material shared by every chunk water mesh (tint comes from the vertex colors). */
export function getWaterMaterial(): MeshStandardMaterial {
  if (material) return material;
  // No canvas in Node (tests): plain water without ripples.
  if (typeof document !== 'undefined') ripples = rippleNormalMap();
  material = new MeshStandardMaterial({
    color: new Color(1, 1, 1),
    vertexColors: true,
    roughness: 0.12,
    metalness: 0.35,
    transparent: true,
    opacity: 0.86,
    normalMap: ripples,
    normalScale: new Vector2(0.6, 0.6),
  });
  return material;
}

/** Ripple animation of the shared material; `time` in seconds. */
export function updateWaterMaterial(time: number): void {
  if (ripples) animateRipples(ripples, time);
}

/** Water mesh in world space (identity transform) with the shared material; null if empty. */
export function buildWaterMesh(data: WaterArrays): Mesh<BufferGeometry, MeshStandardMaterial> | null {
  const count = data.positions.length / 3;
  if (count === 0 || data.indices.length === 0) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
  const normals = new Float32Array(count * 3);
  for (let v = 0; v < count; v++) normals[v * 3 + 1] = 1;
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new BufferAttribute(data.uvs, 2));
  let colors = data.colors;
  if (!colors || colors.length !== count * 3) {
    colors = new Float32Array(count * 3);
    for (let v = 0; v < count; v++) colors.set(SHALLOW_WATER_COLOR, v * 3);
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setIndex(new BufferAttribute(data.indices, 1));

  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  const p = data.positions;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i]! < minX) minX = p[i]!;
    if (p[i]! > maxX) maxX = p[i]!;
    if (p[i + 2]! < minZ) minZ = p[i + 2]!;
    if (p[i + 2]! > maxZ) maxZ = p[i + 2]!;
  }
  geometry.boundingBox = new Box3(new Vector3(minX, data.minY, minZ), new Vector3(maxX, data.maxY, maxZ));
  geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new Sphere());

  const mesh = new Mesh(geometry, getWaterMaterial());
  mesh.name = 'water';
  mesh.receiveShadow = true;
  mesh.renderOrder = 1;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}
