import { MeshStandardMaterial, Vector2, type Texture } from 'three';
import type { TerrainConfig } from '../../config/worldConfig';
import { createTerrainTextures } from './terrainTextures';

/**
 * Splat-mapped terrain material: grass, dirt, rock and snow textures blended in the shader by
 * height, slope and a large-scale variation noise, plus a tiling normal map. Rock uses
 * triplanar projection so cliffs are not stretched.
 */
export function createTerrainMaterial(cfg: TerrainConfig, anisotropy: number, simple = false): MeshStandardMaterial {
  const tex = createTerrainTextures(anisotropy);
  const material = new MeshStandardMaterial({
    map: tex.grass,
    normalMap: simple ? null : tex.normal,
    normalScale: new Vector2(0.8, 0.8),
    roughness: 0.95,
    metalness: 0,
  });
  const uniforms: Record<string, { value: Texture | number }> = {
    tRock: { value: tex.rock },
    tDirt: { value: tex.dirt },
    tSnow: { value: tex.snow },
    uScale: { value: 1 / cfg.detailTextureScale },
    uWater: { value: cfg.waterLevel },
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTerrainPos;\nvarying vec3 vTerrainNormal;')
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvTerrainPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvTerrainNormal = normalize(mat3(modelMatrix) * objectNormal);',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D tRock;
        uniform sampler2D tDirt;
        uniform sampler2D tSnow;
        uniform float uScale;
        uniform float uWater;
        varying vec3 vTerrainPos;
        varying vec3 vTerrainNormal;
        float terrainHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float terrainNoise(vec2 p) {
          vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(terrainHash(i), terrainHash(i + vec2(1, 0)), f.x), mix(terrainHash(i + vec2(0, 1)), terrainHash(i + vec2(1, 1)), f.x), f.y);
        }`,
      )
      .replace(
        '#include <map_fragment>',
        `{
          vec3 p = vTerrainPos;
          vec3 n = normalize(vTerrainNormal);
          float slope = 1.0 - n.y;
          float macro = terrainNoise(p.xz / 600.0) * 0.6 + terrainNoise(p.xz / 150.0) * 0.4;
          vec2 uv = p.xz * uScale;
          // Two scales of the grass texture break up visible tiling.
          #ifdef TERRAIN_SIMPLE
          vec3 grass = texture2D(map, uv).rgb;
          #else
          vec3 grass = mix(texture2D(map, uv).rgb, texture2D(map, uv * 0.137).rgb, 0.35);
          #endif
          grass *= mix(0.85, 1.12, macro);
          vec3 dirt = texture2D(tDirt, uv * 0.8).rgb;
          #ifdef TERRAIN_SIMPLE
          vec3 rock = texture2D(tRock, (p.xz + p.y * n.xz) * uScale * 0.5).rgb;
          #else
          vec3 bw = pow(abs(n), vec3(4.0)); bw /= (bw.x + bw.y + bw.z);
          vec3 rock = texture2D(tRock, p.zy * uScale * 0.5).rgb * bw.x
                    + texture2D(tRock, p.xz * uScale * 0.5).rgb * bw.y
                    + texture2D(tRock, p.xy * uScale * 0.5).rgb * bw.z;
          #endif
          vec3 snow = texture2D(tSnow, uv * 0.5).rgb;

          vec3 col = mix(grass, dirt, smoothstep(0.55, 0.8, macro) * 0.7);
          // Lowland plains are drier and more golden; uplands turn into darker alpine meadow.
          col *= mix(vec3(1.08, 1.04, 0.86), vec3(1.0), smoothstep(30.0, 90.0, p.y));
          col = mix(col, col * vec3(0.8, 0.88, 0.8), smoothstep(320.0, 480.0, p.y));
          // Wet sand / gravel along the river banks.
          col = mix(col, dirt * 0.8, 1.0 - smoothstep(uWater + 0.5, uWater + 3.5, p.y));
          // Bare rock on steep slopes, and scree above the tree line.
          float rockiness = max(smoothstep(0.16, 0.32, slope + (macro - 0.5) * 0.12), smoothstep(520.0, 640.0, p.y + macro * 80.0) * 0.85);
          col = mix(col, rock, rockiness);
          float snowAmount = smoothstep(650.0, 760.0, p.y + macro * 90.0) * (1.0 - smoothstep(0.35, 0.6, slope));
          col = mix(col, snow, snowAmount);
          diffuseColor.rgb *= col;
        }`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        // Normal map sampled in world XZ (the mesh UVs are world-space too).
        '#include <normal_fragment_maps>',
      );
  };
  if (simple) material.defines = { TERRAIN_SIMPLE: '' };
  material.customProgramCacheKey = () => (simple ? 'terrain-splat-simple' : 'terrain-splat-v1');
  return material;
}
