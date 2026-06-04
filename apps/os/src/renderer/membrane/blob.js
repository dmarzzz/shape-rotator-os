import * as THREE from 'three';
import {
  createBlobGeometry,
  createWireframeGeometry,
  createDustGeometry,
  createStructureLineGeometry,
} from './geometry.js';
import { makePressureUniforms, enhancePressureMaterial } from './pressureMaterial.js';

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
    // Was a second oxide-red (#d4451a/#8a1f08) — indistinguishable from
    // self. Moved to warm amber/gold so the 4 blobs read as 4 distinct
    // hues: self=oxide-red, cohort=lapis-blue, events=jade-green,
    // asks=amber-gold. Keeps the "hot / energetic / bubbling" feel the
    // candy-ember intended without colliding with self.
    rimColor: '#FFE9B8',
    contourColor: '#FFC24A',
    baseColor: '#d49a1a',       // warm amber
    emissiveColor: '#7a5408',   // gold ember
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
  // Ramp target for the additive halo (see setActive + tick). Seeded to
  // the material's initial opacity so an inactive blob doesn't ease on boot.
  let haloTargetOpacity = haloMaterial.opacity;

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
      // Ease the additive halo toward its target opacity instead of
      // letting setActive() step it. The halo is an additive backface
      // shell that the UnrealBloom pass amplifies; a 0.04→0.22 instant
      // jump during a scale-up swap blew out to a full-screen white
      // flash. ~12%/frame critically-damped lerp resolves in ~250ms,
      // under the bloom threshold the whole way.
      if (Math.abs(haloMaterial.opacity - haloTargetOpacity) > 0.001) {
        haloMaterial.opacity += (haloTargetOpacity - haloMaterial.opacity) * 0.12;
      }
    },
    setData(d) {
      data = { ...data, ...(d || {}) };
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
      // NOTE: the halo opacity is RAMPED (not stepped) — see tick(). A
      // hard jump on the additive shell mid-swap blew out to full-screen
      // white through the bloom pass. The non-additive materials below
      // can step instantly; they don't feed the bloom blowout.
      haloTargetOpacity         = isActive ? 0.22  : 0.04;
      wireMaterial.opacity      = isActive ? 0.04  : 0.01;
      structureMaterial.opacity = isActive ? 0.10  : 0.025;
      dustMaterial.opacity      = isActive ? 0.42  : 0.08;
      coreMaterial.opacity      = isActive ? 0.92  : 0.55;
      material.opacity          = isActive ? 0.97  : 0.65;
    },
    setHovered(isHovered) {
      // Use the ramp TARGET, not the live opacity — during a swap the
      // live value is mid-ease and would misclassify the active blob.
      const isActive = haloTargetOpacity > 0.15;
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
