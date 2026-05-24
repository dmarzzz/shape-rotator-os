import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { fbm3 } from './noise.js';

// Sculpt a unit-sphere direction into something organic. Pure displacement
// field driven by fbm + a few directional biases. Static — runs once at
// geometry init. Shader does all visible motion.
export function sculptDirection(x, y, z, seed = 0) {
  const grain =
    fbm3(x * 2.3 + 1.1 + seed, y * 1.9 - 0.7 + seed, z * 2.5 + 0.2, 3) * 0.16 - 0.08;
  const sweep = 1 - Math.abs(y) * 0.6;
  const lobe = Math.exp(-(y - 0.18) * (y - 0.18) * 5.0) * 0.05;
  const belly = Math.exp(-(y + 0.22) * (y + 0.22) * 5.5) * 0.04;

  const len = Math.sqrt(x * x + y * y + z * z) || 1;
  const nx = x / len, ny = y / len, nz = z / len;

  const r = 1 + grain * sweep + lobe + belly;
  return new THREE.Vector3(nx * r, ny * r, nz * r);
}

// Main flesh — dense, smooth, watertight after merge.
export function createBlobGeometry({ segments = 64, seed = 0 } = {}) {
  const sphere = new THREE.SphereGeometry(1, segments, segments);
  sphere.deleteAttribute('uv');
  sphere.deleteAttribute('normal');

  const position = sphere.getAttribute('position');
  const v = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    v.set(position.getX(i), position.getY(i), position.getZ(i));
    const sculpted = sculptDirection(v.x, v.y, v.z, seed);
    position.setXYZ(i, sculpted.x, sculpted.y, sculpted.z);
  }

  const geo = mergeVertices(sphere);
  sphere.dispose();
  geo.computeVertexNormals();
  return geo;
}

// Coarse wireframe — low-detail icosahedron sculpted the same way. Rendered
// as wireframe material so each triangle edge is visible as a thin line
// crawling over the surface.
export function createWireframeGeometry({ detail = 3, seed = 0 } = {}) {
  const ico = new THREE.IcosahedronGeometry(1, detail);
  const position = ico.getAttribute('position');
  const v = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    v.set(position.getX(i), position.getY(i), position.getZ(i));
    const sculpted = sculptDirection(v.x, v.y, v.z, seed);
    position.setXYZ(i, sculpted.x, sculpted.y, sculpted.z);
  }
  const geo = mergeVertices(ico);
  ico.dispose();
  geo.computeVertexNormals();
  return geo;
}

// Dust — particles orbiting *outside* the sculpted body. Every dot sits in
// the [1.05, 1.30] radial band so none of them intersect the flesh; combined
// with depthTest:false on the material, this gives the blob a complete dot
// halo regardless of viewing angle (no occluded back-side cloud).
export function createDustGeometry({ detail = 4, seed = 0 } = {}) {
  const ico = new THREE.IcosahedronGeometry(1, detail);
  const position = ico.getAttribute('position');
  const v = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    v.set(position.getX(i), position.getY(i), position.getZ(i));
    const sculpted = sculptDirection(v.x, v.y, v.z, seed);
    position.setXYZ(i, sculpted.x, sculpted.y, sculpted.z);
  }
  const geo = mergeVertices(ico);
  ico.dispose();
  geo.computeVertexNormals();

  // Push each particle outward into an orbital shell. Direction = sculpted
  // surface normal-ish (we use position as direction since it's a unit-ish
  // sphere lattice). Radial offset is randomized so the cloud has thickness.
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const len = Math.sqrt(x * x + y * y + z * z) || 1;
    const r = 1.06 + Math.random() * 0.28;  // [1.06, 1.34] orbital band
    const k = r / len;
    pos.setXYZ(i, x * k, y * k, z * k);
  }
  pos.needsUpdate = true;

  return geo;
}

// Structure-line system — port of the site's structureLines (ribs + bands +
// braces) simplified for our scope. Returns a BufferGeometry of line
// segments wrapping the sculpted surface.
function buildArcPoint(azimuth, polar, tilt = 0, yaw = 0, seed = 0) {
  const radius = Math.cos(polar);
  const x = Math.cos(azimuth) * radius;
  const z = Math.sin(azimuth) * radius;
  const y = Math.sin(polar);
  let p = new THREE.Vector3(x, y, z);
  if (tilt !== 0) p.applyAxisAngle(new THREE.Vector3(1, 0, 0), tilt);
  if (yaw !== 0) p.applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  return sculptDirection(p.x, p.y, p.z, seed);
}

export function createStructureLineGeometry({
  ribs = 5,
  bands = 4,
  segments = 32,
  seed = 0,
  scale = 1.005,
} = {}) {
  const totalSegs = (ribs + bands) * segments;
  const vertexCount = totalSegs * 2;
  const positions = new Float32Array(vertexCount * 3);
  let vi = 0;

  function writeSeg(a, b) {
    positions[vi * 3]     = a.x * scale;
    positions[vi * 3 + 1] = a.y * scale;
    positions[vi * 3 + 2] = a.z * scale;
    vi++;
    positions[vi * 3]     = b.x * scale;
    positions[vi * 3 + 1] = b.y * scale;
    positions[vi * 3 + 2] = b.z * scale;
    vi++;
  }

  // Ribs — arcs along meridians, spread across azimuth.
  for (let ribIndex = 0; ribIndex < ribs; ribIndex++) {
    const t = ribs === 1 ? 0.5 : ribIndex / (ribs - 1);
    const azimuth = THREE.MathUtils.lerp(-1.18, 1.18, t);
    const tilt = THREE.MathUtils.lerp(-0.16, 0.12, t);
    for (let segIndex = 0; segIndex < segments; segIndex++) {
      const tA = segIndex / segments;
      const tB = (segIndex + 1) / segments;
      const polarA = THREE.MathUtils.lerp(-1.2, 1.08, tA);
      const polarB = THREE.MathUtils.lerp(-1.2, 1.08, tB);
      writeSeg(
        buildArcPoint(azimuth, polarA, tilt, 0, seed),
        buildArcPoint(azimuth, polarB, tilt, 0, seed),
      );
    }
  }

  // Bands — horizontal rings at varying latitudes.
  for (let bandIndex = 0; bandIndex < bands; bandIndex++) {
    const t = bands === 1 ? 0.5 : bandIndex / (bands - 1);
    const polar = THREE.MathUtils.lerp(-0.44, 0.46, t);
    const yaw = THREE.MathUtils.lerp(-0.28, 0.22, t);
    for (let segIndex = 0; segIndex < segments; segIndex++) {
      const aA = THREE.MathUtils.lerp(-2.25, 2.05, segIndex / segments);
      const aB = THREE.MathUtils.lerp(-2.25, 2.05, (segIndex + 1) / segments);
      writeSeg(
        buildArcPoint(aA, polar, 0, yaw, seed),
        buildArcPoint(aB, polar, 0, yaw, seed),
      );
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.computeBoundingSphere();
  return geo;
}
