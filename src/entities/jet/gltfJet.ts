import { Box3, Vector3, type Group, type Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { disposeObject3D } from './disposeObject';

const TARGET_LENGTH = 20;

/**
 * Optional custom 3D model: if `public/assets/models/<jetId>.glb` (or `jet.glb`) exists, it
 * replaces the procedural airframe. The model is assumed to face +Z (glTF convention) and is
 * turned to face -Z and scaled to ~20 m long. Procedural moving parts are hidden with it.
 *
 * Resolves to the attached model (owned by the caller from then on), or null. If `signal` is
 * aborted before the load completes (the jet was disposed or replaced), nothing is attached and
 * the loaded scene's resources are freed.
 */
export async function tryLoadGltfJet(jetId: string, procedural: Group, parent: Object3D, signal?: AbortSignal): Promise<Object3D | null> {
  for (const name of [jetId, 'jet']) {
    if (signal?.aborted) return null;
    const url = `${import.meta.env.BASE_URL}assets/models/${name}.glb`;
    try {
      const head = await fetch(url, { method: 'HEAD', signal });
      const type = head.headers.get('content-type') ?? '';
      // Vite's dev server answers unknown paths with index.html, so check the type too.
      if (!head.ok || type.includes('text/html')) continue;
      const gltf = await new GLTFLoader().loadAsync(url);
      const model = gltf.scene;
      if (signal?.aborted) {
        disposeObject3D(model);
        return null;
      }
      model.rotation.y = Math.PI;
      const size = new Box3().setFromObject(model).getSize(new Vector3());
      model.scale.setScalar(TARGET_LENGTH / Math.max(size.z, size.x, 1e-3));
      model.traverse((o) => {
        o.castShadow = true;
        o.receiveShadow = true;
      });
      procedural.visible = false;
      parent.add(model);
      return model;
    } catch {
      // Missing or invalid file (or aborted): keep the procedural jet.
    }
  }
  return null;
}
