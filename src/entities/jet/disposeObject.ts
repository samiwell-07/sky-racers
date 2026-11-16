import type { BufferGeometry, Material, Mesh, Object3D, Texture } from 'three';

/**
 * Frees every geometry, material and texture used by meshes under `root` (for objects that own
 * all of them, such as a loaded glTF scene), and detaches `root` from its parent.
 */
export function disposeObject3D(root: Object3D): void {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    if (!mesh.material) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      materials.add(m);
      for (const value of Object.values(m)) if ((value as Texture | null)?.isTexture) textures.add(value as Texture);
    }
  });
  for (const g of geometries) g.dispose();
  for (const m of materials) m.dispose();
  for (const t of textures) t.dispose();
  root.removeFromParent();
}
