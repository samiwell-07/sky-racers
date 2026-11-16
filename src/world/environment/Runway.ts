import { CanvasTexture, Mesh, MeshStandardMaterial, PlaneGeometry, RepeatWrapping, SRGBColorSpace } from 'three';
import type { RunwayRect } from '../terrain/HeightField';

function runwayTexture(): CanvasTexture {
  const w = 128;
  const h = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#3b3d40';
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 4000; i++) {
    ctx.fillStyle = `rgba(${Math.random() < 0.5 ? '255,255,255' : '0,0,0'},0.05)`;
    ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
  }
  ctx.fillStyle = '#e8e8e2';
  ctx.fillRect(4, 0, 3, h); // edge lines
  ctx.fillRect(w - 7, 0, 3, h);
  for (let y = 60; y < h - 60; y += 48) ctx.fillRect(w / 2 - 2, y, 4, 26); // centerline dashes
  for (const y of [8, h - 40]) for (let x = 14; x < w - 14; x += 12) ctx.fillRect(x, y, 6, 32); // thresholds
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  return tex;
}

/** Asphalt runway strip with markings, laid on the flattened airfield. */
export function createRunwayMesh(rect: RunwayRect): Mesh {
  const geo = new PlaneGeometry(rect.halfWidth * 2, rect.halfLength * 2);
  geo.rotateX(-Math.PI / 2);
  const mesh = new Mesh(geo, new MeshStandardMaterial({ map: runwayTexture(), roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2 }));
  mesh.position.set(rect.x, rect.height + 0.05, rect.z);
  mesh.receiveShadow = true;
  return mesh;
}
