import * as THREE from 'three';

// 3D point-cloud star field that flows toward the camera. Each star is a
// particle in world space; per-frame we translate them along +z (toward
// camera) and wrap any that pass through the near plane back to the far
// end with a new random x/y. The result is a continuous, seamless flow of
// stars streaming past the viewer = forward motion through space.
//
// DEPTH MODEL
// -----------
// Flatness came from every star living in one Z-band, drifting at one rate,
// shaded the same. We now build the field as THREE parallax strata (near /
// mid / far). Each stratum occupies its own depth slab, drifts at its own
// rate (near fastest, far slowest), and carries its own size/brightness
// budget. On top of that the vertex shader derives a normalized depth and
// uses it to (a) shrink + dim distant stars, (b) shift their color cooler &
// desaturated (aerial perspective), and (c) sink them into the void with an
// exponential fog term. The camera also sways on a tiny Lissajous in
// scene.js so the parallax between strata is felt even when idle.
//
// Wrap is invisible because the vertex shader fades opacity to zero within
// the near fade band before the camera — stars are already gone by the time
// their z resets, and into pure black at the far edge via the fog term.

// Total stars, distributed across the three strata by the weights below.
// Bumped modestly for density now that depth-grading hides the far ones.
const STAR_COUNT = 2200;
const STAR_SPREAD_X = 24;  // ±x range; wider so edges always have stars
const STAR_SPREAD_Y = 17;  // ±y range

// Parallax strata. `near` plane is where a star wraps (just in front of the
// slab); `far` is the back of the slab. depth = far - near for that layer.
// `drift` multiplies the base speed so nearer layers stream by faster — the
// core parallax cue. `size`/`bright` bias the layer's particle budget.
// The far layer is intentionally dense, tiny and dim: a deep dust haze that
// the eye reads as "distance," not as individual stars.
const STRATA = [
  // name    weight  near   far   drift  size   bright
  { name: 'far',  weight: 0.46, near: 18.0, far: 52.0, drift: 0.34, size: 0.72, bright: 0.58 },
  { name: 'mid',  weight: 0.34, near:  8.0, far: 30.0, drift: 0.66, size: 1.0,  bright: 0.85 },
  { name: 'near', weight: 0.20, near:  1.6, far: 16.0, drift: 1.18, size: 1.55, bright: 1.15 },
];

// Deepest point any star reaches — drives the shared fog normalization so all
// strata sink into the same void at the same world distance.
const MAX_DEPTH = Math.max(...STRATA.map((s) => s.far));

// Ember-warm palette. The void is true black; the atmosphere is warm. We keep
// a painterly spread (gold / amber / coral / a little rose, plus a cool-ash
// minority for contrast) but the shader pushes everything cooler & grayer with
// distance, so saturation only lives up close — no rainbow demo at depth.
const STAR_PALETTE = [
  { w: 0.30, color: [1.00, 0.97, 0.90] }, // warm white
  { w: 0.22, color: [1.00, 0.85, 0.55] }, // gold
  { w: 0.18, color: [1.00, 0.72, 0.45] }, // amber
  { w: 0.12, color: [1.00, 0.60, 0.42] }, // coral
  { w: 0.08, color: [1.00, 0.52, 0.50] }, // soft rose-ember
  { w: 0.06, color: [0.80, 0.84, 0.96] }, // cool ash (minority, for contrast)
  { w: 0.04, color: [0.66, 0.76, 0.95] }, // deeper cool blue (rare)
];

function pickStarColor() {
  let r = Math.random();
  for (const entry of STAR_PALETTE) {
    r -= entry.w;
    if (r <= 0) return entry.color;
  }
  return STAR_PALETTE[0].color;
}

// Nebula / galactic-plane palette — warm ember band. Same family as the stars
// but a touch deeper so the cloud reads as glowing dust, not gray fog.
const MIST_PALETTE = [
  [1.00, 0.58, 0.34], // ember orange
  [1.00, 0.70, 0.42], // amber
  [1.00, 0.46, 0.30], // deep coral
  [0.95, 0.78, 0.52], // dim gold
  [0.62, 0.50, 0.62], // dusty mauve (cool-ish bridge tone)
];

function pickMistColor() {
  return MIST_PALETTE[Math.floor(Math.random() * MIST_PALETTE.length)];
}

// ---------------------------------------------------------------------------
// STAR SHADERS
// ---------------------------------------------------------------------------
// uMaxDepth normalizes the view-space distance into dn (0 = at camera, 1 = at
// the deepest slab) so all strata share one fog/grading curve. uNearFade and
// uFarFade are the wrap-out / wrap-in planes for the stratum this material is
// bound to, used to fade particles to zero exactly where they recycle. The
// vertex shader does ALL the depth grading (size, brightness, color, fog) so
// the three strata stay visually unified despite different slab geometry.
const VERTEX_SHADER = /* glsl */`
  uniform float uPxRatio;
  uniform float uSizeBase;
  uniform float uMaxDepth;
  uniform float uFogDensity;
  uniform float uNearFade;   // stratum wrap distance: stars fade out below this
  uniform float uFarFade;    // stratum back plane: stars fade in below this
  attribute float aSize;
  attribute vec3 aColor;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPos;
    float dist = -mvPos.z;

    // Normalized view distance, shared across strata for cohesive grading.
    float dn = clamp(dist / uMaxDepth, 0.0, 1.0);

    // Size: perspective 1/dist, then bias smaller with depth so far stars are
    // pinpricks even if their slab math would keep them larger.
    float depthSizeBias = mix(1.0, 0.35, dn);
    gl_PointSize = clamp(uSizeBase * aSize * depthSizeBias / dist, 0.5, 16.0) * uPxRatio;

    // Brightness falls off with depth (aerial perspective). Combined with the
    // exponential fog below this gives a strong near/far luminance separation.
    float depthBright = mix(1.15, 0.30, dn);

    // Exponential fog — far stars sink toward zero, dissolving into black.
    float fog = exp(-uFogDensity * dist);

    // Near fade hides the wrap-out: a star is fully transparent by the time it
    // reaches this stratum's wrap distance (uNearFade), ramping in over the
    // 3.5 units beyond it. Far fade hides the wrap-in: stars ramp up over the
    // last few units before the slab's back plane, so a freshly-spawned star
    // is invisible at the moment it appears.
    float nearFade = smoothstep(uNearFade, uNearFade + 3.5, dist);
    float farFade  = 1.0 - smoothstep(uFarFade - 4.0, uFarFade, dist);

    vAlpha = nearFade * farFade * fog * depthBright * aSize;

    // Color grading: shift distant stars cooler + desaturated toward an ashen
    // void tone, so warm saturation only survives up close.
    vec3 ash = vec3(0.62, 0.66, 0.78);
    float lum = dot(aColor, vec3(0.299, 0.587, 0.114));
    vec3 desat = mix(aColor, vec3(lum), dn * 0.55);
    vColor = mix(desat, desat * ash, dn * 0.65);
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

// ---------------------------------------------------------------------------
// NEBULA / GALACTIC-PLANE MIST
// ---------------------------------------------------------------------------
// Fewer, much larger soft particles that bloom additively into a warm ember
// cloud band behind the stars. They are biased toward a diagonal galactic
// plane (a soft Y band that tilts with X) so the haze reads as a structured
// plane receding into depth rather than a uniform fog — another depth cue.
const MIST_COUNT = 120;
const MIST_NEAR = 6.0;
const MIST_FAR = 50.0;            // sits across the deep half of the field
const MIST_DEPTH = MIST_FAR - MIST_NEAR;
const MIST_SPREAD_X = 26;
const MIST_BAND_HALF = 6.5;       // vertical half-thickness of the plane band
const MIST_BAND_TILT = 0.22;      // band centerline rises with +x

function mistBandY() {
  const x = (Math.random() - 0.5) * 2 * MIST_SPREAD_X;
  // Center the band on a gently tilted line, scatter within the band, and let
  // a few escape above/below so the edge isn't a hard ruler line.
  const center = x * MIST_BAND_TILT;
  const spread = (Math.random() - 0.5) * 2 * MIST_BAND_HALF;
  const escape = (Math.random() < 0.18) ? (Math.random() - 0.5) * 10.0 : 0.0;
  return { x, y: center + spread + escape };
}

const MIST_VERTEX_SHADER = /* glsl */`
  uniform float uPxRatio;
  uniform float uSizeBase;
  uniform float uMaxDepth;
  uniform float uFogDensity;
  attribute float aSize;
  attribute vec3 aColor;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPos;
    float dist = -mvPos.z;
    float dn = clamp(dist / uMaxDepth, 0.0, 1.0);

    gl_PointSize = clamp(uSizeBase * aSize / dist, 24.0, 200.0) * uPxRatio;

    float fog = exp(-uFogDensity * dist);
    float farFade  = smoothstep(0.0, 6.0, dist);
    float nearFade = 1.0 - smoothstep(uMaxDepth - 5.0, uMaxDepth, dist);
    // Clouds are dimmest up close (they'd wash the orbs) and in the deep
    // distance (fog), brightest in the mid-band: a luminous receding plane.
    float band = smoothstep(0.0, 0.35, dn) * (1.0 - smoothstep(0.6, 1.0, dn));
    vAlpha = farFade * nearFade * fog * (0.35 + band * 0.65);

    // Desaturate the deep clouds slightly so they melt into the void.
    float lum = dot(aColor, vec3(0.299, 0.587, 0.114));
    vColor = mix(aColor, vec3(lum) * vec3(0.7, 0.66, 0.7), dn * 0.5);
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
    float cloud = pow(disc, 2.2) * 0.16;
    gl_FragColor = vec4(vColor, cloud * vAlpha);
  }
`;

function createMistLayer({ scene, camera }) {
  const positions = new Float32Array(MIST_COUNT * 3);
  const sizes = new Float32Array(MIST_COUNT);
  const colors = new Float32Array(MIST_COUNT * 3);
  const cameraZ = camera.position.z;
  const wrapFar = cameraZ - MIST_FAR;
  for (let i = 0; i < MIST_COUNT; i++) {
    const { x, y } = mistBandY();
    positions[i * 3]     = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = wrapFar + Math.random() * MIST_DEPTH;
    sizes[i] = 0.9 + Math.random() * 1.6;
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
      uSizeBase: { value: 360.0 },
      uMaxDepth: { value: MAX_DEPTH },
      uFogDensity: { value: 0.055 },
    },
    vertexShader: MIST_VERTEX_SHADER,
    fragmentShader: MIST_FRAGMENT_SHADER,
  });
  const points = new THREE.Points(geometry, material);
  points.renderOrder = -12;            // behind stars
  points.frustumCulled = false;
  scene.add(points);
  return {
    points, material, geometry,
    tick(deltaSeconds, speed) {
      const pos = geometry.attributes.position.array;
      const colorAttr = geometry.attributes.aColor.array;
      const dt = Math.min(deltaSeconds, 0.05);
      // Mist drifts at 45% of star speed — the deepest, slowest parallax layer.
      const advance = speed * dt * 0.45;
      const camZ = camera.position.z;
      const wrapNearLocal = camZ - MIST_NEAR;
      const wrapFarLocal = camZ - MIST_FAR;
      let colorsDirty = false;
      for (let i = 0; i < MIST_COUNT; i++) {
        const zi = i * 3 + 2;
        pos[zi] += advance;
        if (pos[zi] > wrapNearLocal) {
          const { x, y } = mistBandY();
          pos[i * 3]     = x;
          pos[i * 3 + 1] = y;
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

// One parallax stratum of stars. Returns a tickable slab; the parent star
// field owns the shared shader/material and just delegates wrapping here so
// each layer drifts at its own rate and wraps within its own depth slab.
function createStratum({ scene, camera, material, spec, count }) {
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const colors = new Float32Array(count * 3);

  const cameraZ = camera.position.z;
  const slabFar = cameraZ - spec.far;   // world-z of back of slab
  const slabDepth = spec.far - spec.near;

  function reroll(i, atFar) {
    positions[i * 3]     = (Math.random() - 0.5) * 2 * STAR_SPREAD_X;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 2 * STAR_SPREAD_Y;
    positions[i * 3 + 2] = atFar
      ? slabFar
      : slabFar + Math.random() * slabDepth;
    // Per-layer size + brightness budget. ~18% of each layer are "feature"
    // stars (a touch bigger) so there's twinkle hierarchy within a stratum.
    const big = Math.random() < 0.18;
    const baseSize = big ? (1.0 + Math.random() * 0.8) : (0.5 + Math.random() * 0.5);
    sizes[i] = baseSize * spec.size * spec.bright;
    const c = pickStarColor();
    colors[i * 3]     = c[0];
    colors[i * 3 + 1] = c[1];
    colors[i * 3 + 2] = c[2];
  }

  for (let i = 0; i < count; i++) reroll(i, false);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));

  // Each stratum gets its own material clone so it can carry its own
  // uNearFade (where this layer wraps). Uniforms must be re-supplied on a
  // clone — ShaderMaterial.clone() shares the uniforms definition shallowly,
  // so we set a fresh object to avoid cross-layer bleed.
  const mat = material.clone();
  mat.uniforms = THREE.UniformsUtils.clone(material.uniforms);
  mat.uniforms.uNearFade.value = spec.near;
  mat.uniforms.uFarFade.value = spec.far;

  const points = new THREE.Points(geometry, mat);
  points.renderOrder = -10;
  points.frustumCulled = false;
  scene.add(points);

  return {
    points, geometry, material: mat,
    tick(deltaSeconds, speed) {
      const pos = geometry.attributes.position.array;
      const colorAttr = geometry.attributes.aColor.array;
      const dt = Math.min(deltaSeconds, 0.05);
      const advance = speed * dt * spec.drift; // per-layer parallax rate
      const camZ = camera.position.z;
      const wrapNearLocal = camZ - spec.near;
      const wrapFarLocal = camZ - spec.far;
      let colorsDirty = false;
      for (let i = 0; i < count; i++) {
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
      geometry.dispose();
      mat.dispose();
      scene.remove(points);
    },
  };
}

export function createStarField({ scene, camera }) {
  const mist = createMistLayer({ scene, camera });

  // Shared star material — all strata draw with the same shader so depth
  // grading is uniform; the slab geometry differs per layer.
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uPxRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
      uSizeBase: { value: 90.0 },
      uMaxDepth: { value: MAX_DEPTH },
      uFogDensity: { value: 0.052 },
      uNearFade: { value: STRATA[0].near }, // overridden per stratum on clone
      uFarFade: { value: STRATA[0].far },   // overridden per stratum on clone
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
  });

  // Build the strata, distributing STAR_COUNT by weight.
  const strata = STRATA.map((spec, idx) => {
    const isLast = idx === STRATA.length - 1;
    const count = isLast
      ? STAR_COUNT - STRATA.slice(0, idx).reduce((acc, s) => acc + Math.round(STAR_COUNT * s.weight), 0)
      : Math.round(STAR_COUNT * spec.weight);
    return createStratum({ scene, camera, material, spec, count: Math.max(1, count) });
  });

  // A single representative Points (the near stratum) is exposed as `.points`
  // to preserve the prior contract for any caller that inspected it.
  const primaryPoints = strata[strata.length - 1].points;

  return {
    points: primaryPoints,
    material,
    // Speed in world units per second. 0.14 = very slow contemplative drift.
    // Each stratum scales this by its own `drift` so near stars stream past
    // faster than far ones, revealing depth through motion parallax.
    tick(deltaSeconds, speed = 0.14) {
      mist.tick(deltaSeconds, speed);
      for (const s of strata) s.tick(deltaSeconds, speed);
    },
    dispose() {
      mist.dispose();
      for (const s of strata) s.dispose();
      material.dispose();
    },
  };
}
