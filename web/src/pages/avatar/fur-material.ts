import * as THREE from 'three'

const FUR_PARTS = new Set(['head', 'body', 'ear_l', 'ear_r', 'paw_l', 'paw_r', 'foot_l', 'foot_r', 'tail'])

/** Local-space fibres need no UVs or external textures and follow every gesture. */
function addShortFur(material: THREE.MeshStandardMaterial) {
  if (material.userData.otterShortFur) return
  material.userData.otterShortFur = true
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = `varying vec3 vFurPosition;\n${shader.vertexShader}`
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\nvFurPosition = position;',
    )
    shader.fragmentShader = `
      varying vec3 vFurPosition;
      float furHash(vec3 p) {
        p = fract(p * 0.3183099 + vec3(0.13, 0.17, 0.19));
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }
      float furNoise(vec3 p) {
        vec3 i = floor(p);
        vec3 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(mix(furHash(i), furHash(i + vec3(1,0,0)), f.x),
              mix(furHash(i + vec3(0,1,0)), furHash(i + vec3(1,1,0)), f.x), f.y),
          mix(mix(furHash(i + vec3(0,0,1)), furHash(i + vec3(1,0,1)), f.x),
              mix(furHash(i + vec3(0,1,1)), furHash(i + vec3(1,1,1)), f.x), f.y),
          f.z
        );
      }
      ${shader.fragmentShader}
    `
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
       float furBroad = furNoise(vFurPosition * 6.0);
       float furFine = furNoise(vFurPosition * vec3(85.0, 22.0, 85.0));
       float furStrand = smoothstep(0.34, 0.76, furFine);
       float furRim = pow(1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition))), 3.0);
       diffuseColor.rgb *= 0.92 + furBroad * 0.11 + furStrand * 0.08;
       diffuseColor.rgb += vec3(0.020, 0.027, 0.030) * furRim;`,
    )
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_begin>',
      `#include <normal_fragment_begin>
       // Screen-space micro-normal variation gives a velvet nap, not spikes.
       normal = normalize(normal + vec3(dFdx(furFine), dFdy(furFine), 0.0) * 0.035);`,
    )
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>
       roughnessFactor = clamp(roughnessFactor + (furFine - 0.5) * 0.16, 0.72, 1.0);`,
    )
  }
  material.customProgramCacheKey = () => 'otter-short-fur-v1'
}

/** Keep eyes lively, not glossy beads; fur stays muted rather than shaggy. */
export function tuneAvatarMaterial(node: THREE.Mesh) {
  const materials = Array.isArray(node.material) ? node.material : [node.material]
  for (const material of materials) {
    if (!(material instanceof THREE.MeshStandardMaterial)) continue
    if (node.name.startsWith('eye_dark')) {
      material.roughness = 0.30
      material.envMapIntensity = 0.72
    } else {
      material.envMapIntensity = 0.3
      if (FUR_PARTS.has(node.name)) addShortFur(material)
    }
  }
}
