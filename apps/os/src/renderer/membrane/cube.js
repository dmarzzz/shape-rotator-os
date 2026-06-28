import * as THREE from 'three';
import { ConvexGeometry } from '../../vendor/three-jsm/geometries/ConvexGeometry.js';

// Domain identity — the four navigable surfaces. Survives the blob era:
// the cube is one object that TINTS toward the active domain's colors
// instead of four separate orbs swapping slots.
export const BLOB_IDS = ['self', 'cohort', 'events', 'asks'];

// The shape is a clickable die: click to grow it a face, right-click to
// shrink. 6 = a d6 cube → 20 = a d20 icosahedron. The canonical Platonic
// dice (d6/d8/d12/d20) render as the REAL solid; the in-between counts are
// convex hulls of Fibonacci-sphere points so every click visibly adds a
// facet on the way up.
export const MIN_FACES = 6;
export const MAX_FACES = 20;
// The shapes the die may become, in cycle order. Removed counts
// (9/10/11/13/14/15/16/17/18/19) are simply absent here, so spinning skips them.
export const ALLOWED_FACES = [6, 7, 8, 12, 20];
export const TARGET_R = 1.45; // bounding-sphere radius every shape is scaled to

// Human-readable names per face count — shown on screen so shapes can be
// referenced by name. Dice tags for the Platonic ones.
export const SHAPE_NAMES = {
  6:  { name: 'cube', tag: 'd6' },
  7:  { name: 'pentagonal prism' },
  8:  { name: 'octahedron', tag: 'd8' },
  9:  { name: 'heptagonal prism' },
  10: { name: 'pentagonal bipyramid' },
  11: { name: 'enneagonal prism' },
  12: { name: 'dodecahedron', tag: 'd12' },
  13: { name: 'hendecagonal prism' },
  14: { name: 'heptagonal bipyramid' },
  15: { name: 'tridecagonal prism' },
  16: { name: 'octagonal bipyramid' },
  17: { name: 'pentadecagonal prism' },
  18: { name: 'enneagonal bipyramid' },
  19: { name: 'heptadecagonal prism' },
  20: { name: 'icosahedron', tag: 'd20' },
};

// A ring of k vertices evenly spaced around a regular k-gon at height z.
function polygonRing(k, radius, z) {
  const pts = [];
  for (let i = 0; i < k; i++) {
    const a = (i / k) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, z));
  }
  return pts;
}

// Regular k-gonal prism: two aligned k-gon rings → k square sides + 2 caps
// = k + 2 faces. Height ≈ diameter so it reads balanced, not drum-flat.
function prismPoints(k) {
  return [...polygonRing(k, 1, 1), ...polygonRing(k, 1, -1)];
}

// Regular k-gonal bipyramid: a k-gon equator + two apexes → 2k triangular
// faces (a symmetric "diamond"). Apex slightly past the radius for a clean,
// not-too-spiky proportion.
function bipyramidPoints(k) {
  return [
    ...polygonRing(k, 1, 0),
    new THREE.Vector3(0, 0, 1.15),
    new THREE.Vector3(0, 0, -1.15),
  ];
}

// Scale a geometry so its bounding sphere matches TARGET_R — keeps the
// on-screen size steady as the shape morphs (a round d20 would otherwise
// read larger than a corner-heavy cube).
function normalizeGeo(geo) {
  geo.computeBoundingSphere();
  const r = geo.boundingSphere ? geo.boundingSphere.radius : 1;
  if (r > 0) geo.scale(TARGET_R / r, TARGET_R / r, TARGET_R / r);
  return geo;
}

// Every face count maps to a proper, symmetric solid (no lopsided hulls):
// the real Platonic dice at 6/8/12/20, a regular bipyramid for the even
// gaps (2k faces) and a regular prism for the odd gaps (k+2 faces).
function geometryForFaces(n) {
  let geo;
  switch (n) {
    case 6:  geo = new THREE.BoxGeometry(1, 1, 1); break;       // d6 cube
    case 8:  geo = new THREE.OctahedronGeometry(1); break;      // d8
    case 12: geo = new THREE.DodecahedronGeometry(1); break;    // d12
    case 20: geo = new THREE.IcosahedronGeometry(1); break;     // d20
    default:
      geo = (n % 2 === 0)
        ? new ConvexGeometry(bipyramidPoints(n / 2))            // 10,14,16,18
        : new ConvexGeometry(prismPoints(n - 2));               // 7,9,11,13,15,17,19
  }
  return normalizeGeo(geo);
}

export const BLOB_PROFILES = {
  self:   { label: 'self',   sub: 'your shape',        rimColor: '#FFE6D4', baseColor: '#c43914' },
  cohort: { label: 'cohort', sub: 'the constellation', rimColor: '#D4E0FF', baseColor: '#3850a8' },
  events: { label: 'events', sub: 'who is here when',  rimColor: '#D4F0E2', baseColor: '#2a7a60' },
  asks:   { label: 'asks',   sub: 'asks and plans',    rimColor: '#FFE9B8', baseColor: '#d49a1a' },
};

// ─── psychedelic cube shader ─────────────────────────────────────────────
// Unlit + texture-free: all motion is trig-warped interference bands fed
// through a cosine palette, so the whole surface costs a handful of sin()
// calls per fragment. The fresnel rim is the only intentionally-bright
// term — it's what the UnrealBloom pass picks up.

const CUBE_VERT = /* glsl */ `
  varying vec3 vPos;
  varying vec3 vNormal;
  varying vec3 vLocalN;
  varying vec3 vView;
  void main() {
    vPos = position;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    // uniform scale only — mat3(modelMatrix) is a valid normal transform
    vNormal = normalize(mat3(modelMatrix) * normal);
    // Object-space normal — compared against the hovered face's normal so
    // the highlight sticks to one physical face as the cube tumbles.
    vLocalN = normal;
    vView = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const CUBE_FRAG = /* glsl */ `
  varying vec3 vPos;
  varying vec3 vNormal;
  varying vec3 vLocalN;
  varying vec3 vView;
  uniform float uTime;
  uniform vec3 uAccent;   // active domain rim color — drives the fresnel glow
  uniform vec3 uBase;     // active domain body color — anchors the palette
  uniform float uGlow;    // hover lift 0..1
  uniform vec3 uHoverN;   // object-space normal of the face under the cursor
  uniform vec3 uGlowColor;// bright hover-glow color (rim pastel, bright in both themes)
  uniform float uEnergy;  // rotation speed 0..1 — faster spin = brighter

  // IQ cosine palette — the psychedelia generator.
  vec3 pal(float t) {
    return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67)));
  }

  void main() {
    vec3 p = vPos * 2.6;
    float t = uTime;

    // Two-stage trig domain warp → liquid interference patterns that never
    // visibly loop. Cheaper than any noise texture and fully resolution-free.
    vec3 q = p + 0.6 * vec3(
      sin(p.y * 2.1 + t * 0.50),
      sin(p.z * 1.7 - t * 0.42),
      sin(p.x * 1.9 + t * 0.36));
    vec3 r = q + 0.9 * vec3(
      sin(q.z * 1.3 - t * 0.31),
      sin(q.x * 1.5 + t * 0.27),
      sin(q.y * 1.1 - t * 0.23));

    float band  = sin(r.x * 1.8 + r.y * 1.4 + r.z * 1.6);
    float swirl = sin(length(r) * 3.0 - t * 0.8 + band * 1.6);

    float hue = 0.16 * band + 0.13 * swirl + 0.05 * t;
    vec3 psyche = pal(hue);
    // Anchor toward the domain body color so switching domains reads as a
    // mood change, not a different object.
    psyche = mix(psyche, uBase, 0.42);
    // Oversaturate past the ACES wash — deep dye, not pastel.
    psyche = clamp(mix(vec3(dot(psyche, vec3(0.333))), psyche, 1.45), 0.0, 1.0);

    float lum = 0.30 + 0.26 * (0.5 + 0.5 * swirl) + 0.12 * (0.5 + 0.5 * band);
    vec3 col = psyche * lum;

    // Fresnel rim in the domain accent — the bloom feed. Tight exponent +
    // modest gain: enough to glow through bloom, not enough to white out
    // a corner-on face.
    float fres = pow(1.0 - max(dot(normalize(vNormal), normalize(vView)), 0.0), 3.0);
    col += uAccent * fres * 0.55;

    // Faint travelling shimmer — futurist hint, kept under the bloom threshold.
    col += psyche * 0.04 * sin(vPos.y * 26.0 - t * 2.2);

    // Spin energy lifts the whole surface above the bloom threshold, so the
    // faster it tumbles the more it blazes; at rest it sits at default.
    col *= 1.0 + uEnergy * 0.85;
    col += uAccent * fres * uEnergy * 0.4;

    // Hover glow — lights ONLY the face under the cursor and BLOOMS it. Each
    // flat face has a constant object-space normal, so matching this fragment's
    // normal against the hovered face's normal isolates a single facet (the
    // boundary is hard at the edges where the normal jumps). The emissive uses
    // uGlowColor (the BRIGHT rim pastel in both themes) at a strong HDR gain so the
    // hovered face crosses the UnrealBloom threshold and the pass throws a real
    // colored halo — not just a brighter facet. uGlow eases it in/out. Applied
    // AFTER the spin energy so it reads the same still or spinning. Gains scaled
    // to 0.7× of the original (1.12 → 0.784, 0.12 → 0.084) to soften the halo.
    float fmask = smoothstep(0.9, 0.999, dot(normalize(vLocalN), uHoverN));
    col += uGlowColor * fmask * uGlow * 0.784;
    col *= 1.0 + fmask * uGlow * 0.084;

    gl_FragColor = vec4(col, 0.94);
  }
`;

// Color-eased uniforms: setDomain() moves TARGETS; tick() lerps the live
// values so a domain switch sweeps across the cube instead of stepping
// (a hard step on the accent would also spike the bloom pass).
const COLOR_EASE = 0.07;
const GLOW_EASE = 0.12;

// ─── smooth shape morphing ───────────────────────────────────────────────
// The body is NOT the target polyhedron itself — it's a fixed-topology
// icosphere whose every vertex is pushed radially out onto the target
// solid's surface. Because the topology never changes, we can tween each
// vertex's radius frame-by-frame, so growing/shrinking a face flows like a
// living cell reshaping rather than snapping. The crisp glowing edge-lines
// (which DO have to be rebuilt per shape) fade out for the morph and fade
// back in once it settles, leaving the naked deforming blob mid-transition.
const BODY_DETAIL = 4;          // icosphere subdivisions → 15360 verts (crisp corners)
const MORPH_SEC = 0.52;         // transition duration (1.2× faster than 0.62)
const WOBBLE_AMP = 0.05;        // peak organic jiggle (fraction of radius)
const WOBBLE_SPEED = 3.0;       // jiggle churn rate
const LINE_FADE_EASE = 0.16;    // edge-line opacity ease toward target
const EDGE_BASE = 0.42;
const INNER_BASE = 0.30;

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function createPsyCube({ isLight = false, initialFaces = null } = {}) {
  const profile = BLOB_PROFILES.self;
  // On white the light cream rim/edges vanish — drive the accent (fresnel rim +
  // glowing edge lines) from the darker domain baseColor in light mode so the
  // wireframe and rim read with contrast. The psychedelic body is unchanged.
  const accentFor = (p) => new THREE.Color(isLight ? p.baseColor : p.rimColor);
  const uniforms = {
    uTime:   { value: 0 },
    uAccent: { value: accentFor(profile) },
    uBase:   { value: new THREE.Color(profile.baseColor) },
    uGlow:   { value: 0 },
    uHoverN: { value: new THREE.Vector3(0, 0, 0) },
    // Hover glow always uses the BRIGHT rim pastel (regardless of theme) so the
    // hovered face can cross the bloom threshold and actually halo on white.
    uGlowColor: { value: new THREE.Color(profile.rimColor) },
    uEnergy: { value: 0 },
  };
  const accentTarget = uniforms.uAccent.value.clone();
  const baseTarget = uniforms.uBase.value.clone();
  const glowColorTarget = uniforms.uGlowColor.value.clone();
  let glowTarget = 0;
  let energyTarget = 0;

  // The shapes the die cycles through, in order. Spinning steps along this
  // list (wrapping); counts not listed here are skipped entirely.
  let faceIndex = ALLOWED_FACES.length - 1; // boots as the d20 (last entry)
  if (initialFaces != null) {
    const i = ALLOWED_FACES.indexOf(initialFaces);
    if (i >= 0) faceIndex = i;   // restore a remembered shape (persists across membrane re-mounts)
  }
  let faces = ALLOWED_FACES[faceIndex];

  const bodyMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: CUBE_VERT,
    fragmentShader: CUBE_FRAG,
    transparent: true,
  });
  // Glowing edges — additive so they bloom into light-lines.
  const edgeMat = new THREE.LineBasicMaterial({
    color: accentFor(profile),
    transparent: true,
    opacity: EDGE_BASE,
    blending: isLight ? THREE.NormalBlending : THREE.AdditiveBlending,
    depthWrite: false,
  });
  // Inner counter-rotating wireframe — the tesseract/hyperspace cue that
  // makes the rotation hypnotic. Mirrors the body shape, scaled down.
  const innerMat = new THREE.LineBasicMaterial({
    color: accentFor(profile),
    transparent: true,
    opacity: INNER_BASE,
    blending: isLight ? THREE.NormalBlending : THREE.AdditiveBlending,
    depthWrite: false,
  });

  // Body = icosphere we deform. Its (unit) vertex directions never change;
  // only the per-vertex radius does.
  const bodyGeo = new THREE.IcosahedronGeometry(1, BODY_DETAIL);
  const posAttr = bodyGeo.getAttribute('position');
  const N = posAttr.count;
  const dirs = new Float32Array(posAttr.array); // unit directions
  const curR = new Float32Array(N);
  const fromR = new Float32Array(N);
  const toR = new Float32Array(N);

  // Scratch vectors for plane extraction (allocate once).
  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
  const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3();
  const _n = new THREE.Vector3(), _cen = new THREE.Vector3();

  // Fill `out[i]` with the distance from the origin to the target solid's
  // surface along base-vertex i's direction — i.e. project the sphere onto
  // the convex polyhedron. Radius = min over faces of (planeDist / cosθ).
  function radialFieldInto(geo, out) {
    const pos = geo.getAttribute('position');
    const idx = geo.getIndex();
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    const planes = []; // flat [nx,ny,nz,d, …]
    for (let t = 0; t < triCount; t++) {
      const ia = idx ? idx.getX(t * 3)     : t * 3;
      const ib = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const ic = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      _a.fromBufferAttribute(pos, ia);
      _b.fromBufferAttribute(pos, ib);
      _c.fromBufferAttribute(pos, ic);
      _e1.subVectors(_b, _a);
      _e2.subVectors(_c, _a);
      _n.crossVectors(_e1, _e2);
      if (_n.lengthSq() < 1e-12) continue;
      _n.normalize();
      _cen.copy(_a).add(_b).add(_c).multiplyScalar(1 / 3);
      if (_n.dot(_cen) < 0) _n.negate(); // outward (solid is origin-centered)
      planes.push(_n.x, _n.y, _n.z, _n.dot(_a));
    }
    const P = planes.length / 4;
    for (let i = 0; i < N; i++) {
      const dx = dirs[i * 3], dy = dirs[i * 3 + 1], dz = dirs[i * 3 + 2];
      let r = Infinity;
      for (let p = 0; p < P; p++) {
        const denom = dx * planes[p * 4] + dy * planes[p * 4 + 1] + dz * planes[p * 4 + 2];
        if (denom > 1e-6) {
          const tt = planes[p * 4 + 3] / denom;
          if (tt < r) r = tt;
        }
      }
      out[i] = (r === Infinity || r <= 0) ? TARGET_R : r;
    }
  }

  // Write curR (plus optional organic wobble) into the body positions.
  function applyRadius(wob, clock) {
    const arr = posAttr.array;
    for (let i = 0; i < N; i++) {
      const x = dirs[i * 3], y = dirs[i * 3 + 1], z = dirs[i * 3 + 2];
      let rr = curR[i];
      if (wob > 0) {
        const nz = Math.sin(x * 3.1 + clock)
                 + Math.sin(y * 2.7 - clock * 1.1) * 0.8
                 + Math.sin(z * 3.5 + clock * 0.7) * 0.6;
        rr *= 1 + wob * nz * 0.42;
      }
      arr[i * 3] = x * rr;
      arr[i * 3 + 1] = y * rr;
      arr[i * 3 + 2] = z * rr;
    }
    posAttr.needsUpdate = true;
  }

  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.renderOrder = 1;

  // Edge-line geometries — rebuilt per settled shape from the true solid.
  let edgeSrcGeo = geometryForFaces(faces);
  let edgeGeo = new THREE.EdgesGeometry(edgeSrcGeo);
  let innerSrcGeo = edgeSrcGeo.clone().scale(0.56, 0.56, 0.56);
  let innerEdgeGeo = new THREE.EdgesGeometry(innerSrcGeo);

  const edges = new THREE.LineSegments(edgeGeo, edgeMat);
  edges.renderOrder = 2;
  const inner = new THREE.LineSegments(innerEdgeGeo, innerMat);
  inner.renderOrder = 3;

  // Seed the morph icosphere at the starting solid, but SHOW the real solid
  // at rest — its flat per-face normals let the unlit shader reveal crisp
  // facets (a smooth icosphere just reads as a blob). The icosphere is only
  // swapped in for the duration of a morph, where the soft rounding + wobble
  // is exactly the organic look we want.
  radialFieldInto(edgeSrcGeo, curR);
  applyRadius(0, 0);
  body.geometry = edgeSrcGeo;

  // Morph state.
  let morphing = false;
  let morphT = 0;
  let pendingGeo = null; // target solid whose edges we'll show at settle
  let prevTime = -1;
  let lineFade = 1, lineFadeTarget = 1;

  function rebuildEdges(geo) {
    const ne = new THREE.EdgesGeometry(geo);
    const nis = geo.clone().scale(0.56, 0.56, 0.56);
    const nie = new THREE.EdgesGeometry(nis);
    edges.geometry = ne;
    inner.geometry = nie;
    edgeGeo.dispose();
    innerEdgeGeo.dispose();
    innerSrcGeo.dispose();
    edgeSrcGeo.dispose();
    edgeGeo = ne;
    innerEdgeGeo = nie;
    innerSrcGeo = nis;
    edgeSrcGeo = geo;
  }

  const group = new THREE.Group();
  group.add(body);
  group.add(edges);
  group.add(inner);

  return {
    group,
    mesh: body, // raycast target
    getFaces: () => faces,
    // Step to the next allowed shape (±delta along ALLOWED_FACES, wrapping).
    // Returns the new face count. Kicks off a smooth morph.
    cycleFaces(delta) {
      const L = ALLOWED_FACES.length;
      const nextIndex = ((faceIndex + delta) % L + L) % L;
      if (nextIndex === faceIndex) return null;
      faceIndex = nextIndex;
      faces = ALLOWED_FACES[faceIndex];
      const geo = geometryForFaces(faces);
      fromR.set(curR);
      radialFieldInto(geo, toR);
      morphing = true;
      morphT = 0;
      // Hide the crisp edge-lines for the whole morph. Snap to 0 instantly
      // (not eased) so the OLD shape's lines don't linger/lag over the
      // reshaping body; they fade back in on the new shape once it settles.
      lineFadeTarget = 0;
      lineFade = 0;
      if (pendingGeo) pendingGeo.dispose();
      pendingGeo = geo;
      // Hand the body to the deforming icosphere for the transition.
      body.geometry = bodyGeo;
      applyRadius(0, 0);
      return faces;
    },
    setDomain(id) {
      const p = BLOB_PROFILES[id];
      if (!p) return;
      accentTarget.copy(accentFor(p));
      baseTarget.set(p.baseColor);
      glowColorTarget.set(p.rimColor); // hover glow stays the bright rim, both themes
    },
    setHovered(isHovered, faceNormal) {
      glowTarget = isHovered ? 1 : 0;
      // Lock in which face to light. Keep the last normal on un-hover so the
      // highlight fades out on the same facet instead of flickering elsewhere.
      if (isHovered && faceNormal) {
        uniforms.uHoverN.value.copy(faceNormal).normalize();
      }
    },
    // 0 = idle/default brightness, 1 = full spin-blaze. Driven by the
    // scene from the cube's measured angular speed.
    setEnergy(v) {
      energyTarget = Math.max(0, Math.min(1, v));
    },
    tick(time) {
      const dt = prevTime < 0 ? 0.016 : Math.max(0, Math.min(0.05, time - prevTime));
      prevTime = time;

      uniforms.uTime.value = time;
      uniforms.uAccent.value.lerp(accentTarget, COLOR_EASE);
      uniforms.uBase.value.lerp(baseTarget, COLOR_EASE);
      uniforms.uGlowColor.value.lerp(glowColorTarget, COLOR_EASE);
      uniforms.uGlow.value += (glowTarget - uniforms.uGlow.value) * GLOW_EASE;
      // Energy eases up fast (snappy response to a flick) but coasts down
      // slowly, so the blaze trails the motion instead of cutting out.
      const energyEase = energyTarget > uniforms.uEnergy.value ? 0.25 : 0.06;
      uniforms.uEnergy.value += (energyTarget - uniforms.uEnergy.value) * energyEase;
      edgeMat.color.lerp(accentTarget, COLOR_EASE);
      innerMat.color.lerp(accentTarget, COLOR_EASE);

      if (morphing) {
        morphT = Math.min(1, morphT + dt / MORPH_SEC);
        const e = easeInOutCubic(morphT);
        for (let i = 0; i < N; i++) curR[i] = fromR[i] + (toR[i] - fromR[i]) * e;
        // Wobble swells in then out over the morph — a cell pinching shape.
        applyRadius(WOBBLE_AMP * Math.sin(Math.PI * morphT), time * WOBBLE_SPEED);
        if (morphT >= 1) {
          morphing = false;
          rebuildEdges(pendingGeo); // pendingGeo becomes edgeSrcGeo
          pendingGeo = null;
          body.geometry = edgeSrcGeo; // back to the crisp solid at rest
          lineFadeTarget = 1; // bring the crisp lines back on the new shape
        }
      }

      lineFade += (lineFadeTarget - lineFade) * LINE_FADE_EASE;
      edgeMat.opacity = (EDGE_BASE + uniforms.uGlow.value * 0.25 + uniforms.uEnergy.value * 0.4) * lineFade;
      innerMat.opacity = (INNER_BASE + uniforms.uEnergy.value * 0.3) * lineFade;

      // Counter-rotation against the group's tumble (scene.js drives that).
      inner.rotation.x = -time * 0.21;
      inner.rotation.y = -time * 0.34;
      inner.rotation.z = time * 0.13;
    },
    dispose() {
      bodyGeo.dispose();
      edgeGeo.dispose();
      innerEdgeGeo.dispose();
      innerSrcGeo.dispose();
      edgeSrcGeo.dispose();
      if (pendingGeo) pendingGeo.dispose();
      bodyMat.dispose();
      edgeMat.dispose();
      innerMat.dispose();
    },
  };
}
