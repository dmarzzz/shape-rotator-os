// Direct port of pressureMaterial.ts from N0V3LT0K3NS/shapeRotatorSite.
// Shader strings are byte-identical — the rim + contour + depth-wash work
// is the visual signature; do not edit GLSL without taste review.

export function makePressureUniforms(THREE, {
  rimColor = '#FFE6D4',
  contourColor = '#D4826A',
  rimStrength = 0.16,
  contourStrength = 0.08,
  contourFrequency = 9.5,
  contourDrift = 0.8,
} = {}) {
  return {
    uTime: { value: 0 },
    uRimColor: { value: new THREE.Color(rimColor) },
    uContourColor: { value: new THREE.Color(contourColor) },
    uRimStrength: { value: rimStrength },
    uContourStrength: { value: contourStrength },
    uContourFrequency: { value: contourFrequency },
    uContourDrift: { value: contourDrift },
  };
}

export function enhancePressureMaterial(material, uniforms) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uRimColor = uniforms.uRimColor;
    shader.uniforms.uContourColor = uniforms.uContourColor;
    shader.uniforms.uRimStrength = uniforms.uRimStrength;
    shader.uniforms.uContourStrength = uniforms.uContourStrength;
    shader.uniforms.uContourFrequency = uniforms.uContourFrequency;
    shader.uniforms.uContourDrift = uniforms.uContourDrift;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vPressureWorldPosition;
varying vec3 vPressureWorldNormal;
`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
// Vertex shader only computes world-space position + normal for the fresnel
// + contour passes below.
vec4 pressureWorldPosition = modelMatrix * vec4(transformed, 1.0);
vPressureWorldPosition = pressureWorldPosition.xyz;
vPressureWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uTime;
uniform vec3 uRimColor;
uniform vec3 uContourColor;
uniform float uRimStrength;
uniform float uContourStrength;
uniform float uContourFrequency;
uniform float uContourDrift;
varying vec3 vPressureWorldPosition;
varying vec3 vPressureWorldNormal;
`,
      )
      .replace(
        '#include <dithering_fragment>',
        `
vec3 pressureViewDir = normalize(cameraPosition - vPressureWorldPosition);
vec3 pressureNormal = normalize(vPressureWorldNormal);
float fresnel = pow(1.0 - max(dot(pressureNormal, pressureViewDir), 0.0), 2.35);

float contourPhase =
  vPressureWorldPosition.y * uContourFrequency +
  sin(vPressureWorldPosition.x * (uContourFrequency * 0.62) + uTime * 0.18) * (1.15 + uContourDrift) +
  sin(vPressureWorldPosition.z * (uContourFrequency * 0.48) - uTime * 0.11) * (0.9 + uContourDrift * 0.6);
float contourWave = 0.5 + 0.5 * sin(contourPhase);
float contourMask = smoothstep(0.8, 0.96, contourWave) * (0.14 + fresnel * 0.62);
float bodyFalloff = 1.0 - pow(max(dot(pressureNormal, pressureViewDir), 0.0), 0.33);
float innerWrap = pow(1.0 - max(dot(pressureNormal, pressureViewDir), 0.0), 1.35);
float depthWash = smoothstep(0.18, 0.88, contourWave * 0.58 + bodyFalloff * 0.42) * (1.0 - fresnel * 0.32);

gl_FragColor.rgb += uRimColor * fresnel * uRimStrength;
gl_FragColor.rgb += uContourColor * contourMask * uContourStrength;
gl_FragColor.rgb += mix(uContourColor, uRimColor, 0.28) * bodyFalloff * (0.016 + contourWave * 0.012) * uContourStrength;
gl_FragColor.rgb += mix(uContourColor, uRimColor, 0.2) * depthWash * innerWrap * (0.24 + contourWave * 0.18) * (uContourStrength * 0.7 + uRimStrength * 0.3);

#include <dithering_fragment>
`,
      );

    material.userData.pressureShader = shader;
  };

  material.customProgramCacheKey = () => 'pressure-material-v2';
  material.needsUpdate = true;
}
