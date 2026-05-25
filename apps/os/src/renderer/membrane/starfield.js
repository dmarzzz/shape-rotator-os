import * as THREE from 'three';

// 3D point-cloud star field that flows toward the camera. Each star is a
// particle in world space; per-frame we translate them along +z (toward
// camera) and wrap any that pass through the near plane back to the far
// end with a new random x/y. The result is a continuous, seamless flow of
// stars streaming past the viewer = forward motion through space.
//
// Wrap is invisible because the vertex shader fades opacity to zero within
// the last 2.5 world units before the camera — stars are already gone by
// the time their z resets.

const STAR_COUNT = 1600;
const STAR_DEPTH = 38;     // span of z distribution (world units)
const STAR_SPREAD_X = 22;  // ±x range; wider so edges always have stars
const STAR_SPREAD_Y = 16;  // ±y range

// Rainbow-mist palette — pushed toward color (white minority) for the
// cosmic-dust nebula feel. Per-star color attribute makes the field read
// as iridescent painterly haze rather than discrete star points.
const STAR_PALETTE = [
  { w: 0.22, color: [1.00, 0.98, 0.93] }, // soft white-warm
  { w: 0.16, color: [1.00, 0.86, 0.52] }, // gold
  { w: 0.14, color: [0.74, 0.84, 1.00] }, // pale blue
  { w: 0.13, color: [1.00, 0.72, 0.42] }, // amber
  { w: 0.12, color: [0.92, 0.74, 1.00] }, // violet
  { w: 0.10, color: [1.00, 0.58, 0.44] }, // coral
  { w: 0.07, color: [0.58, 0.78, 1.00] }, // deeper blue
  { w: 0.06, color: [0.70, 1.00, 0.86] }, // mint-aqua
];

function pickStarColor() {
  let r = Math.random();
  for (const entry of STAR_PALETTE) {
    r -= entry.w;
    if (r <= 0) return entry.color;
  }
  return STAR_PALETTE[0].color;
}

// Mist palette — same hues but saturated for the bigger soft "nebula puff"
// layer. Each mist particle is large (60-160px) and very transparent,
// blooming together additively into colored cloud bands.
const MIST_PALETTE = [
  [1.00, 0.62, 0.42], // coral
  [1.00, 0.78, 0.46], // amber
  [0.94, 0.66, 1.00], // violet
  [0.66, 0.82, 1.00], // blue
  [0.70, 1.00, 0.88], // mint
  [1.00, 0.88, 0.56], // gold
  [1.00, 0.52, 0.66], // rose
];

function pickMistColor() {
  return MIST_PALETTE[Math.floor(Math.random() * MIST_PALETTE.length)];
}

const VERTEX_SHADER = /* glsl */`
  uniform float uPxRatio;
  uniform float uSizeBase;
  attribute float aSize;
  attribute vec3 aColor;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPos;
    float dist = -mvPos.z;
    gl_PointSize = clamp(uSizeBase * aSize / dist, 0.6, 14.0) * uPxRatio;
    float farFade = smoothstep(0.0, 4.0, dist);
    float nearFade = smoothstep(${(STAR_DEPTH).toFixed(1)}, ${(STAR_DEPTH - 6).toFixed(1)}, dist);
    vAlpha = farFade * nearFade * aSize;
    vColor = aColor;
  }
`;

const FRAGMENT_SHADER = /* glsl */`
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec2 c = gl_PointCoord - vec2(0.5);
    float r = length(c);
    float disc = smoothstep(0.5, 0.05, r);
    float core = pow(disc, 1.6);
    gl_FragColor = vec4(vColor, core * vAlpha);
  }
`;

// Second layer for the "mist" — fewer, much larger soft particles that
// blend additively into colored nebula puffs behind the stars.
const MIST_COUNT = 90;
const MIST_DEPTH = 32;
const MIST_SPREAD_X = 20;
const MIST_SPREAD_Y = 14;

const MIST_VERTEX_SHADER = /* glsl */`
  uniform float uPxRatio;
  uniform float uSizeBase;
  attribute float aSize;
  attribute vec3 aColor;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPos;
    float dist = -mvPos.z;
    gl_PointSize = clamp(uSizeBase * aSize / dist, 30.0, 160.0) * uPxRatio;
    float farFade  = smoothstep(0.0, 5.0, dist);
    float nearFade = smoothstep(${(MIST_DEPTH).toFixed(1)}, ${(MIST_DEPTH - 8).toFixed(1)}, dist);
    vAlpha = farFade * nearFade;
    vColor = aColor;
  }
`;

const MIST_FRAGMENT_SHADER = /* glsl */`
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec2 c = gl_PointCoord - vec2(0.5);
    float r = length(c);
    // Very soft falloff — almost gaussian — for cloud-like puffs.
    float disc = smoothstep(0.5, 0.0, r);
    float cloud = pow(disc, 2.2) * 0.18;
    gl_FragColor = vec4(vColor, cloud * vAlpha);
  }
`;

function createMistLayer({ scene, camera }) {
  const positions = new Float32Array(MIST_COUNT * 3);
  const sizes = new Float32Array(MIST_COUNT);
  const colors = new Float32Array(MIST_COUNT * 3);
  const cameraZ = camera.position.z;
  const wrapFar = cameraZ - MIST_DEPTH;
  for (let i = 0; i < MIST_COUNT; i++) {
    positions[i * 3]     = (Math.random() - 0.5) * 2 * MIST_SPREAD_X;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 2 * MIST_SPREAD_Y;
    positions[i * 3 + 2] = wrapFar + Math.random() * MIST_DEPTH;
    sizes[i] = 0.8 + Math.random() * 1.5;
    const c = pickMistColor();
    colors[i * 3] = c[0]; colors[i * 3 + 1] = c[1]; colors[i * 3 + 2] = c[2];
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uPxRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
      uSizeBase: { value: 320.0 },
    },
    vertexShader: MIST_VERTEX_SHADER,
    fragmentShader: MIST_FRAGMENT_SHADER,
  });
  const points = new THREE.Points(geometry, material);
  points.renderOrder = -11;            // behind stars
  points.frustumCulled = false;
  scene.add(points);
  return {
    points, material, geometry,
    tick(deltaSeconds, speed) {
      const pos = geometry.attributes.position.array;
      const colorAttr = geometry.attributes.aColor.array;
      const dt = Math.min(deltaSeconds, 0.05);
      // Mist drifts at 60% of star speed — feels like deeper layer.
      const advance = speed * dt * 0.6;
      const camZ = camera.position.z;
      const wrapNearLocal = camZ - 0.4;
      const wrapFarLocal = camZ - MIST_DEPTH;
      let colorsDirty = false;
      for (let i = 0; i < MIST_COUNT; i++) {
        const zi = i * 3 + 2;
        pos[zi] += advance;
        if (pos[zi] > wrapNearLocal) {
          pos[i * 3]     = (Math.random() - 0.5) * 2 * MIST_SPREAD_X;
          pos[i * 3 + 1] = (Math.random() - 0.5) * 2 * MIST_SPREAD_Y;
          pos[zi] = wrapFarLocal;
          const c = pickMistColor();
          colorAttr[i * 3] = c[0]; colorAttr[i * 3 + 1] = c[1]; colorAttr[i * 3 + 2] = c[2];
          colorsDirty = true;
        }
      }
      geometry.attributes.position.needsUpdate = true;
      if (colorsDirty) geometry.attributes.aColor.needsUpdate = true;
    },
    dispose() {
      geometry.dispose(); material.dispose(); scene.remove(points);
    },
  };
}

export function createStarField({ scene, camera }) {
  const positions = new Float32Array(STAR_COUNT * 3);
  const sizes = new Float32Array(STAR_COUNT);
  const colors = new Float32Array(STAR_COUNT * 3);

  const cameraZ = camera.position.z;
  const wrapFar = cameraZ - STAR_DEPTH;

  for (let i = 0; i < STAR_COUNT; i++) {
    positions[i * 3]     = (Math.random() - 0.5) * 2 * STAR_SPREAD_X;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 2 * STAR_SPREAD_Y;
    positions[i * 3 + 2] = wrapFar + Math.random() * STAR_DEPTH;
    sizes[i] = Math.random() < 0.18
      ? 1.0 + Math.random() * 0.8
      : 0.55 + Math.random() * 0.5;
    const c = pickStarColor();
    colors[i * 3]     = c[0];
    colors[i * 3 + 1] = c[1];
    colors[i * 3 + 2] = c[2];
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));

  const mist = createMistLayer({ scene, camera });

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uPxRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
      uSizeBase: { value: 90.0 },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
  });

  const points = new THREE.Points(geometry, material);
  points.renderOrder = -10;          // always render first, behind blobs
  points.frustumCulled = false;      // we manage visibility via shader
  scene.add(points);

  return {
    points,
    material,
    // Speed in world units per second. 0.14 = very slow contemplative
    // drift — stars take ~4.5 minutes to traverse the full STAR_DEPTH.
    tick(deltaSeconds, speed = 0.14) {
      // Drift the mist layer at the same base speed (it scales itself
      // internally to feel like a deeper layer).
      mist.tick(deltaSeconds, speed);
      const pos = geometry.attributes.position.array;
      const dt = Math.min(deltaSeconds, 0.05); // clamp to handle tab-switch hiccups
      const advance = speed * dt;
      const camZ = camera.position.z;
      const wrapNearLocal = camZ - 0.4;
      const wrapFarLocal = camZ - STAR_DEPTH;
      // When a star wraps, also re-roll its color so the field keeps
      // distributing the palette evenly over time rather than draining
      // toward whatever colors lived in the back of the queue.
      const colorAttr = geometry.attributes.aColor.array;
      let colorsDirty = false;
      for (let i = 0; i < STAR_COUNT; i++) {
        const zi = i * 3 + 2;
        pos[zi] += advance;
        if (pos[zi] > wrapNearLocal) {
          pos[i * 3]     = (Math.random() - 0.5) * 2 * STAR_SPREAD_X;
          pos[i * 3 + 1] = (Math.random() - 0.5) * 2 * STAR_SPREAD_Y;
          pos[zi] = wrapFarLocal;
          const c = pickStarColor();
          colorAttr[i * 3]     = c[0];
          colorAttr[i * 3 + 1] = c[1];
          colorAttr[i * 3 + 2] = c[2];
          colorsDirty = true;
        }
      }
      geometry.attributes.position.needsUpdate = true;
      if (colorsDirty) geometry.attributes.aColor.needsUpdate = true;
    },
    dispose() {
      mist.dispose();
      geometry.dispose();
      material.dispose();
      scene.remove(points);
    },
  };
}
