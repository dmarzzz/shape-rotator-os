import * as THREE from 'three';
import {
  createBlobGeometry,
  createWireframeGeometry,
  createDustGeometry,
  createStructureLineGeometry,
} from './geometry.js';
import { makePressureUniforms, enhancePressureMaterial } from './pressureMaterial.js';
import { fbm3 } from './noise.js';

// Per-blob identity. Each blob has a home slot, a tonic note for the M4
// sound system, and a color signature. Material treatment is shared with
// the shaperotator.xyz site — multi-layer specimen with glass flesh,
// wireframe overlay, structure-arc lines, dust particles, inner core glow.
export const BLOB_IDS = ['self', 'cohort', 'events', 'asks'];

// Each blob's body is a saturated candy/wax tone (baseColor) that the
// glass-y material wraps. emissiveColor adds the inner-glow tint that gives
// the body its juicy candy quality under the key light. rim/contour drive
// the pressure shader's fresnel + drifting bands.
// Jewel-saturated body tones — gemstone photography rather than pastel.
// Each blob = a polished cabochon in its color family.
export const BLOB_PROFILES = {
  self: {
    label: 'self',
    sub: 'your shape',
    rimColor: '#FFE6D4',
    contourColor: '#FFB48A',
    baseColor: '#c43914',       // deeper warm oxide
    emissiveColor: '#7a1c08',
    rimStrength: 0.26,
    contourStrength: 0.10,
    contourFrequency: 9.2,
    contourDrift: 0.8,
    tonicHz: 73.42,
    seed: 11,
  },
  cohort: {
    label: 'cohort',
    sub: 'the constellation',
    rimColor: '#D4E0FF',
    contourColor: '#7AA0E0',
    baseColor: '#3850a8',       // saturated lapis
    emissiveColor: '#1f2c5c',
    rimStrength: 0.28,
    contourStrength: 0.085,
    contourFrequency: 8.4,
    contourDrift: 1.1,
    tonicHz: 97.99,
    seed: 23,
  },
  events: {
    label: 'events',
    sub: 'who is here when',
    rimColor: '#D4F0E2',
    contourColor: '#5DAA8C',
    baseColor: '#2a7a60',       // saturated jade
    emissiveColor: '#143a2c',
    rimStrength: 0.26,
    contourStrength: 0.09,
    contourFrequency: 10.1,
    contourDrift: 0.6,
    tonicHz: 110.00,
    seed: 37,
  },
  asks: {
    label: 'asks',
    sub: 'open pairings',
    rimColor: '#FFD2B0',
    contourColor: '#FF7F4A',
    baseColor: '#d4451a',       // bright candy ember
    emissiveColor: '#8a1f08',
    rimStrength: 0.30,
    contourStrength: 0.12,
    contourFrequency: 11.5,
    contourDrift: 1.4,
    tonicHz: 92.50,
    seed: 53,
  },
};

// Shared geometries cached by seed so all 4 blobs don't recompute identical
// sphere-noise loops at init. Each blob gets a unique seed → unique cache.
const _cache = {
  flesh: new Map(),
  wire: new Map(),
  dust: new Map(),
  structure: new Map(),
};

function getCached(map, key, builder) {
  if (!map.has(key)) map.set(key, builder());
  return map.get(key);
}

export function createBlob(THREEref, id) {
  const profile = BLOB_PROFILES[id];
  if (!profile) throw new Error(`unknown blob id: ${id}`);

  const seed = profile.seed;
  const fleshGeo     = getCached(_cache.flesh,     seed, () => createBlobGeometry({ segments: 64, seed }));
  const wireGeo      = getCached(_cache.wire,      seed, () => createWireframeGeometry({ detail: 3, seed }));
  const dustGeo      = getCached(_cache.dust,      seed, () => createDustGeometry({ detail: 4, seed }));
  const structureGeo = getCached(_cache.structure, seed, () => createStructureLineGeometry({ ribs: 5, bands: 4, segments: 32, seed }));

  // ─── 1. Inner core — emissive smaller mesh in the body's hue. Provides
  //       the glow the glass-y outer flesh refracts. Tighter color match
  //       to baseColor so it doesn't read as a separate object.
  const coreMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color(profile.emissiveColor || profile.baseColor),
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
  });
  const core = new THREE.Mesh(fleshGeo, coreMaterial);
  core.scale.setScalar(0.78);
  core.renderOrder = 0;

  // ─── 2. Main flesh — WET glass. Roughness near zero, clearcoat maxed,
  //       low clearcoat roughness → the giant bright wet highlight on top
  //       that defines the site's juicy quality. Emissive adds the inner
  //       candy/wax warmth visible even on the unlit side.
  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(profile.baseColor),
    roughness: 0.06,
    metalness: 0.0,
    clearcoat: 1.0,
    clearcoatRoughness: 0.05,
    sheen: 0.4,
    sheenColor: new THREE.Color(profile.rimColor),
    sheenRoughness: 0.4,
    transmission: 0.10,
    thickness: 1.2,
    ior: 1.32,
    iridescence: 0.55,
    iridescenceIOR: 1.4,
    iridescenceThicknessRange: [180, 540],
    emissive: new THREE.Color(profile.emissiveColor || profile.baseColor),
    emissiveIntensity: 0.32,
    specularIntensity: 1.0,
    specularColor: new THREE.Color('#ffffff'),
    envMapIntensity: 1.4,
    transparent: true,
    opacity: 0.97,
  });

  const uniforms = makePressureUniforms(THREEref || THREE, {
    rimColor: profile.rimColor,
    contourColor: profile.contourColor,
    rimStrength: profile.rimStrength,
    contourStrength: profile.contourStrength,
    contourFrequency: profile.contourFrequency,
    contourDrift: profile.contourDrift,
  });
  enhancePressureMaterial(material, uniforms);

  const mesh = new THREE.Mesh(fleshGeo, material);
  mesh.renderOrder = 1;

  // ─── 3. Wireframe overlay — near-invisible. Was breaking the glass
  //       illusion by reading as "wire mesh" at small throne scale.
  const wireMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color(profile.rimColor),
    wireframe: true,
    transparent: true,
    opacity: 0.03,
    depthWrite: false,
  });
  const wire = new THREE.Mesh(wireGeo, wireMaterial);
  wire.scale.setScalar(1.008);
  wire.renderOrder = 2;

  // ─── 4. Structure lines — minimal. A hint of skeleton, not scaffolding.
  const structureMaterial = new THREE.LineBasicMaterial({
    color: new THREE.Color(profile.rimColor),
    transparent: true,
    opacity: 0.08,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const structure = new THREE.LineSegments(structureGeo, structureMaterial);
  structure.renderOrder = 2;

  // ─── 5. Dust — sparser orbital halo. Was reading as noise/speckle.
  //       Drop count via size + opacity so what's there reads as deliberate.
  const dustMaterial = new THREE.PointsMaterial({
    color: new THREE.Color(profile.rimColor),
    size: 0.011,
    transparent: true,
    opacity: 0.32,
    sizeAttenuation: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
  });
  const dust = new THREE.Points(dustGeo, dustMaterial);
  dust.renderOrder = 999;

  // ─── 6. Halo — backface additive shell. Outer rim glow against pure void.
  const haloMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color(profile.rimColor),
    transparent: true,
    opacity: 0.14,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const halo = new THREE.Mesh(fleshGeo, haloMaterial);
  halo.scale.setScalar(1.06);
  halo.renderOrder = 4;

  const group = new THREE.Group();
  group.add(core);
  group.add(mesh);
  group.add(wire);
  group.add(structure);
  group.add(dust);
  group.add(halo);

  // Domain data → shader uniforms. Same modulator as before.
  let data = {};
  const baseRimStrength = profile.rimStrength;
  const baseContourStrength = profile.contourStrength;
  const baseContourFrequency = profile.contourFrequency;
  const baseContourDrift = profile.contourDrift;

  function modulate(time) {
    if (id === 'self') {
      const edges = Math.max(0, Math.min(20, Number(data.edgeCount) || 0));
      uniforms.uContourFrequency.value = baseContourFrequency + edges * 0.14;
      uniforms.uContourStrength.value  = baseContourStrength  + edges * 0.005;
    } else if (id === 'cohort') {
      const peers = Math.max(0, Math.min(30, Number(data.peerCount) || 0));
      uniforms.uContourDrift.value    = baseContourDrift    + peers * 0.04;
      uniforms.uContourStrength.value = baseContourStrength + peers * 0.003;
      uniforms.uRimStrength.value     = baseRimStrength + (data.online === 'live' ? 0.04 : 0);
    } else if (id === 'events') {
      const inMs = Number(data.nextEventInMs);
      const proximity = Number.isFinite(inMs) ? Math.max(0, 1 - inMs / (60 * 60 * 1000)) : 0;
      const pulseHz = 0.05 + proximity * 0.25;
      const pulseAmp = 0.6 + proximity * 0.9;
      uniforms.uContourFrequency.value = baseContourFrequency + Math.sin(time * pulseHz * Math.PI * 2) * pulseAmp;
      uniforms.uContourStrength.value  = baseContourStrength + proximity * 0.08;
    } else if (id === 'asks') {
      const asks = Math.max(0, Math.min(10, Number(data.openAskCount) || 0));
      uniforms.uContourStrength.value = baseContourStrength + asks * 0.012;
      uniforms.uContourDrift.value    = baseContourDrift    + asks * 0.06;
      const mine = Math.max(0, Math.min(5, Number(data.myAskCount) || 0));
      uniforms.uRimStrength.value     = baseRimStrength + (mine > 0 ? (mine / 5) * 0.06 : 0);
    }
  }

  // CPU vertex-ripple state. Throne blob has this enabled so its surface
  // organically deforms every frame. Also handles tap impulses — clicks
  // on the surface radiate a damped wave outward from impact point.
  let rippling = false;
  let originalPositions = null;
  let vertexDirections = null;
  // Active tap impulses. Each: { dir: [dx,dy,dz] unit vector pointing at
  // impact, startTime, lifetime, strength }
  const tapImpulses = [];
  const TAP_LIFETIME = 1.6;          // seconds — full decay window
  const TAP_DEFAULT_STRENGTH = 0.085; // peak displacement at impact point

  function ensureRippleData() {
    if (originalPositions) return;
    const pos = mesh.geometry.attributes.position;
    originalPositions = new Float32Array(pos.array);
    vertexDirections = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const len = Math.sqrt(x * x + y * y + z * z) || 1;
      vertexDirections[i * 3]     = x / len;
      vertexDirections[i * 3 + 1] = y / len;
      vertexDirections[i * 3 + 2] = z / len;
    }
  }

  function triggerTapImpulse(worldPoint, strength = TAP_DEFAULT_STRENGTH) {
    // Convert world point → blob-local direction (normalized). Site uses
    // angular distance from this direction for the radial falloff.
    ensureRippleData();
    const local = group.worldToLocal(worldPoint.clone());
    const len = Math.sqrt(local.x * local.x + local.y * local.y + local.z * local.z) || 1;
    tapImpulses.push({
      dx: local.x / len,
      dy: local.y / len,
      dz: local.z / len,
      startTime: performance.now() / 1000,
      strength,
    });
  }

  function rippleVertices(time) {
    if (!originalPositions) return;
    const pos = mesh.geometry.attributes.position;
    const arr = pos.array;
    const drift = uniforms.uContourDrift.value;
    const ampScale = 0.7 + drift * 0.35;
    const count = pos.count;

    // Cull expired tap impulses + precompute per-impulse decay/osc.
    const liveImpulses = [];
    for (const imp of tapImpulses) {
      const age = time - imp.startTime;
      if (age >= TAP_LIFETIME) continue;
      const lifeRatio = age / TAP_LIFETIME;
      const decay = (1 - lifeRatio) * (1 - lifeRatio);
      const osc = Math.sin(age * 22) * Math.exp(-age * 3);
      liveImpulses.push({ imp, decayOsc: decay * osc });
    }
    tapImpulses.length = 0;
    for (const x of liveImpulses) tapImpulses.push(x.imp);

    const MAX_ANG = 0.75 * Math.PI;

    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      const ox = originalPositions[i3];
      const oy = originalPositions[i3 + 1];
      const oz = originalPositions[i3 + 2];
      const dx = vertexDirections[i3];
      const dy = vertexDirections[i3 + 1];
      const dz = vertexDirections[i3 + 2];

      // Continuous breathing (noise + sin terms). Bumped amplitude so it
      // reads more clearly than the previous 3% version.
      const n = fbm3(
        dx * 2.0 + time * 0.18,
        dy * 2.0 - time * 0.13,
        dz * 2.0 + time * 0.21,
        2,
      ) - 0.5;
      let ripple = n * 0.060
        + Math.sin(time * 0.42 + dy * 3.5) * 0.014
        + Math.sin(time * 0.57 + dx * 2.8 + dz * 1.7) * 0.011;

      // Tap impulses — radial damped oscillation from each impact point.
      for (const { imp, decayOsc } of liveImpulses) {
        const cosAng = dx * imp.dx + dy * imp.dy + dz * imp.dz;
        const cc = cosAng > 1 ? 1 : (cosAng < -1 ? -1 : cosAng);
        const angDist = Math.acos(cc);
        if (angDist >= MAX_ANG) continue;
        const f = 1 - angDist / MAX_ANG;
        const falloff = f * f;
        ripple += imp.strength * decayOsc * falloff;
      }

      const amp = ripple * ampScale;
      arr[i3]     = ox + dx * amp;
      arr[i3 + 1] = oy + dy * amp;
      arr[i3 + 2] = oz + dz * amp;
    }
    pos.needsUpdate = true;
  }

  function resetVertices() {
    if (!originalPositions) return;
    const pos = mesh.geometry.attributes.position;
    pos.array.set(originalPositions);
    pos.needsUpdate = true;
  }

  return {
    id,
    profile,
    group,
    mesh,
    halo,
    material,
    uniforms,
    tick(time) {
      uniforms.uTime.value = time;
      modulate(time);
      if (rippling) rippleVertices(time);
    },
    setData(d) {
      data = { ...data, ...(d || {}) };
    },
    enableRipple(on) {
      if (on === rippling) return;
      rippling = !!on;
      if (rippling) ensureRippleData();
      else {
        tapImpulses.length = 0;
        resetVertices();
      }
    },
    triggerTap(worldPoint, strength) {
      triggerTapImpulse(worldPoint, strength);
    },
    setRimColor(hex) {
      uniforms.uRimColor.value.set(hex);
      haloMaterial.color.set(hex);
      wireMaterial.color.set(hex);
      structureMaterial.color.set(hex);
      dustMaterial.color.set(hex);
    },
    setContourColor(hex) {
      uniforms.uContourColor.value.set(hex);
    },
    setActive(isActive) {
      // Active blob = full jewel presence. Halo glows (will bloom in post).
      // Wireframe + structure stay minimal so flesh dominates.
      haloMaterial.opacity      = isActive ? 0.22  : 0.04;
      wireMaterial.opacity      = isActive ? 0.04  : 0.01;
      structureMaterial.opacity = isActive ? 0.10  : 0.025;
      dustMaterial.opacity      = isActive ? 0.42  : 0.08;
      coreMaterial.opacity      = isActive ? 0.92  : 0.55;
      material.opacity          = isActive ? 0.97  : 0.65;
    },
    setHovered(isHovered) {
      const isActive = haloMaterial.opacity > 0.15;
      if (isActive) return;
      const lift = isHovered ? 1 : 0;
      haloMaterial.opacity      = 0.04 + 0.14 * lift;
      wireMaterial.opacity      = 0.01 + 0.025 * lift;
      structureMaterial.opacity = 0.025 + 0.06 * lift;
      dustMaterial.opacity      = 0.08 + 0.28 * lift;
      coreMaterial.opacity      = 0.55 + 0.30 * lift;
      material.opacity          = 0.65 + 0.25 * lift;
    },
    dispose() {
      material.dispose();
      haloMaterial.dispose();
      coreMaterial.dispose();
      wireMaterial.dispose();
      structureMaterial.dispose();
      dustMaterial.dispose();
    },
  };
}
