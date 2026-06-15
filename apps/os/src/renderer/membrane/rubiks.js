import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import Cube from './cube-solver.js';

// ─── Flashbots Rubik's cube — membrane easter-egg module ────────────────────
// A self-contained port of the standalone interactive cube (rubiks-cube-web),
// rendered to its OWN canvas overlaid on the membrane stage. It keeps its own
// renderer/scene/camera/lights/environment/selective-bloom pipeline EXACTLY as
// the standalone, because the brand-accurate plastic colours and the gated
// feature glows were tuned against NeutralToneMapping + two-pass layer-selective
// bloom — the membrane's ACES/threshold-bloom scene can't reproduce them.
//
// Differences from the standalone: no page DOM (loader/buttons removed), sizes
// to the given canvas, runs only while enabled (so it costs nothing when the
// die is showing a normal shape), gains a slow idle camera-orbit so it tumbles
// "like the other shapes", and a sustained-fast background-spin fires
// onCycleAway() — the gesture that returns the morph to the regular shapes.

// Uncompressed GLB (built by rubiks-cube-web/decompress-glb.cjs). It is NOT
// Draco-compressed on purpose: the OS app's CSP forbids the blob-URL worker
// that three's DRACOLoader needs, so the model must load worker-free.
const GLB_URL = new URL('./rubiks_cube.glb', import.meta.url).href;

export function createRubiksApp(canvas, { onCycleAway, onSequencing, matchSize } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;   // vivid, brand-accurate colors
  renderer.toneMappingExposure = 1.0;
  renderer.setClearColor(0x000000, 0);

  function sizeOf() {
    const r = canvas.getBoundingClientRect();
    return { w: Math.max(2, Math.round(r.width)), h: Math.max(2, Math.round(r.height)) };
  }
  let { w: VW, h: VH } = sizeOf();
  renderer.setSize(VW, VH, false);

  const scene = new THREE.Scene();   // transparent — the membrane backdrop shows through
  // When matchSize is given, use the membrane die's exact fov + look-at distance
  // so the cube renders at the same on-screen size as the shape it replaces.
  const FOV = matchSize?.fov ?? 42;
  const FRAME_DIST = matchSize?.distance ?? null;
  const camera = new THREE.PerspectiveCamera(FOV, VW / VH, 0.1, 100);
  camera.position.set(4.6, 4.0, 6.2);   // 3/4 view (shows three faces); fitCamera() normalizes the distance

  // Image-based lighting for the glossy plastic + a key light for definition.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  const key = new THREE.DirectionalLight(0xffffff, 1.1); key.position.set(5, 8, 6); scene.add(key);
  const fill = new THREE.DirectionalLight(0x88aaff, 0.4); fill.position.set(-6, -2, -4); scene.add(fill);
  scene.add(new THREE.AmbientLight(0xffffff, 0.2));

  // SELECTIVE bloom: ONLY meshes on the bloom layer (bolt, X, eyes) glow.
  const BLOOM_LAYER = 1;
  const bloomLayer = new THREE.Layers(); bloomLayer.set(BLOOM_LAYER);
  const darkMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const matCache = new Map();
  const renderScene = new RenderPass(scene, camera);
  const bloom = new UnrealBloomPass(new THREE.Vector2(VW, VH), 0.85, 0.4, 0.0);
  const bloomComposer = new EffectComposer(renderer);
  bloomComposer.renderToScreen = false;
  bloomComposer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  bloomComposer.setSize(VW, VH);
  bloomComposer.addPass(renderScene);
  bloomComposer.addPass(bloom);
  const mixPass = new ShaderPass(new THREE.ShaderMaterial({
    uniforms: { baseTexture: { value: null }, bloomTexture: { value: bloomComposer.renderTarget2.texture } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform sampler2D baseTexture; uniform sampler2D bloomTexture; varying vec2 vUv; void main(){ gl_FragColor = texture2D(baseTexture, vUv) + texture2D(bloomTexture, vUv); }'
  }), 'baseTexture');
  mixPass.needsSwap = true;
  const finalComposer = new EffectComposer(renderer);
  finalComposer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  finalComposer.setSize(VW, VH);
  finalComposer.addPass(renderScene);
  finalComposer.addPass(mixPass);
  finalComposer.addPass(new OutputPass());
  // Final dither — the bloom's smooth radial falloff posterises into concentric
  // "bands" when written to the 8-bit canvas over near-black. A sub-LSB
  // triangular-noise dither (applied last, in display-encoded space) breaks the
  // banding without visibly graining the image.
  const ditherPass = new ShaderPass(new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: null } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform sampler2D tDiffuse; varying vec2 vUv;
      float hash(vec2 p){ p = fract(p * vec2(443.897, 441.423)); p += dot(p, p + 19.19); return fract(p.x * p.y); }
      void main(){
        vec4 c = texture2D(tDiffuse, vUv);
        // triangular PDF in [-1,1] LSB → smooth gradients dissolve the bands
        float d = (hash(gl_FragCoord.xy) + hash(gl_FragCoord.xy + 17.0) - 1.0) / 255.0;
        gl_FragColor = vec4(c.rgb + d, c.a);
      }`,
  }), 'tDiffuse');
  finalComposer.addPass(ditherPass);

  function render() {
    // Glow-only pass: hide non-glowing meshes; blank the BASE colour of glowing
    // meshes so only their emissive blooms (solid colour stays in the final pass).
    scene.traverse(o => {
      if (!o.isMesh) return;
      if (!bloomLayer.test(o.layers)) { matCache.set(o.uuid, o.material); o.material = darkMat; }
      else { o.userData._baseHex = o.material.color.getHex(); o.material.color.setHex(0x000000); }
    });
    // Drop the environment for the glow pass: with a black albedo the glowing
    // meshes still pick up a SPECULAR reflection of scene.environment, which
    // blooms independently of emissive — so a feature would keep glowing faintly
    // even when its glow is gated off (e.g. the X with the back face unsolved).
    // Nulling it here makes the bloom pass capture ONLY emissive (the gated glow).
    const env = scene.environment; scene.environment = null;
    bloomComposer.render();
    scene.environment = env;
    scene.traverse(o => {
      if (!o.isMesh) return;
      if (matCache.has(o.uuid)) { o.material = matCache.get(o.uuid); matCache.delete(o.uuid); }
      else if (o.userData._baseHex !== undefined) { o.material.color.setHex(o.userData._baseHex); o.userData._baseHex = undefined; }
    });
    finalComposer.render();
  }

  // TrackballControls so the cube can be spun freely in any direction. The cube
  // stays at IDENTITY (the camera orbits) so the lighting is fixed relative to the
  // cube — the tuned face colours stay stable — and the layer-turn drag math works
  // in world == cube-local space.
  const controls = new TrackballControls(camera, canvas);
  controls.rotateSpeed = 3.5;
  controls.zoomSpeed = 1.2;
  controls.noPan = true;
  controls.staticMoving = true;
  controls.minDistance = 4;
  controls.maxDistance = 16;
  controls.target.set(0, 0, 0);
  controls.enabled = false;   // off until the easter egg is revealed
  if (matchSize) controls.noZoom = true;   // size-matched to the die; rotate only

  // ─── state ───────────────────────────────────────────────────────────
  const CUBE_SIZE = 3.4;
  const TURN_MS = 280;
  const cube = new THREE.Group();
  scene.add(cube);

  let cubies = [];
  let cell = 1;
  const axisMin = new THREE.Vector3();
  let cubeRadius = 3;
  let busy = false;
  const raycaster = new THREE.Raycaster();

  // ─── load model ──────────────────────────────────────────────────────
  let ready = false;
  const loader = new GLTFLoader();
  const readyPromise = new Promise((resolve) => {
    loader.load(GLB_URL, (gltf) => {
      buildCube(gltf.scene); ready = true;
      // If the model finishes loading AFTER a reveal (cold load), seed the reveal
      // spin now so the cube is already tumbling the instant it first appears.
      if (enabled) { orbitVel = REVEAL_SPIN; spinArmed = false; }
      resolve(true);
    }, undefined, (err) => {
      console.error('[rubiks] failed to load model', err); resolve(false);
    });
  });

  function buildCube(root) {
    let parent = root;
    while (parent.children.length === 1 && parent.children[0].children.length) parent = parent.children[0];
    const nodes = parent.children.slice();
    for (const n of nodes) cube.attach(n);

    cube.updateMatrixWorld(true);
    const box0 = new THREE.Box3().setFromObject(cube);
    const s = CUBE_SIZE / (box0.getSize(new THREE.Vector3()).length() / Math.sqrt(3));
    const pivotW = new THREE.Vector3();
    nodes.forEach(n => { const wv = new THREE.Vector3(); n.getWorldPosition(wv); pivotW.add(wv); });
    pivotW.multiplyScalar(1 / nodes.length);
    const norm = new THREE.Matrix4().makeScale(s, s, s)
      .multiply(new THREE.Matrix4().makeTranslation(-pivotW.x, -pivotW.y, -pivotW.z));

    const holders = [];
    for (const n of nodes) {
      n.updateWorldMatrix(true, true);
      const holder = new THREE.Group();
      n.traverse(o => {
        if (!o.isMesh) return;
        const g = o.geometry.clone();
        g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(norm, o.matrixWorld));
        const mesh = new THREE.Mesh(g, o.material);
        mesh.frustumCulled = true;
        holder.add(mesh);
      });
      cube.add(holder);
      holders.push(holder);
    }
    nodes.forEach(n => cube.remove(n));
    cube.updateMatrixWorld(true);

    const centers = holders.map(h => new THREE.Box3().setFromObject(h).getCenter(new THREE.Vector3()));
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    centers.forEach(c => { min.min(c); max.max(c); });
    axisMin.copy(min);
    cell = (max.x - min.x) / 2 || 1;

    cubies = holders.map((h, i) => {
      const grid = worldToGrid(centers[i]);
      const home = { pos: h.position.clone(), quat: h.quaternion.clone(), grid: grid.clone() };
      h.userData = { grid, home };
      return { obj: h, get grid() { return h.userData.grid; } };
    });

    cubies.forEach(c => {
      c.obj.traverse(o => {
        if (!o.isMesh) return;
        const name = o.material.name;
        let emissive = null, intensity = 0;
        if (name === 'Gul') { emissive = 0xe9ff00; intensity = 2.4; }           // lightning bolt -> yellow
        else if (name === 'Bla') { emissive = 0x30d2f8; intensity = 2.2; }      // eyes -> blue
        else if (name === 'Vit_X') {
          // Plain matte white here. The back-face "X" glow is added per-triangle
          // in applyMaterialFixes() so ONLY the −Z face of each back cubie glows —
          // the white shell also wraps the cubies' sides/front, which must NOT.
          o.material = o.material.clone();
          o.material.color.set(0xe7e7e7); o.material.emissive.set(0x000000);
          o.material.metalness = 0; o.material.roughness = 0.5;
        }
        else if (!name) { o.material.color.set(0x2b2b2d); o.material.metalness = 0; o.material.roughness = 0.6; o.material.emissive.set(0x000000); }

        if (emissive !== null) {
          o.material = o.material.clone();
          o.material.emissive.setHex(emissive);
          o.material.emissiveIntensity = intensity;
          o.material.toneMapped = true;
          o.layers.enable(BLOOM_LAYER);
        }
      });
    });

    cubeRadius = new THREE.Box3().setFromObject(cube).getBoundingSphere(new THREE.Sphere()).radius;
    controls.minDistance = cubeRadius * 1.05;
    controls.maxDistance = cubeRadius * 12;
    fitCamera();

    applyMaterialFixes();
    setupGlowGroups();

    // Match the die's on-screen size: scale the 3×3 body edge (3 × cell, since
    // contiguous cubies fill their cells) to the die's cube edge. Uniform scale
    // on the group is safe for the layer-turn math (pivots at the origin).
    if (matchSize) {
      const bodyEdge = 3 * cell;
      cube.scale.setScalar(matchSize.edge / bodyEdge);
      cube.updateMatrixWorld(true);
      cubeRadius = new THREE.Box3().setFromObject(cube).getBoundingSphere(new THREE.Sphere()).radius;
      fitCamera();
    }
  }

  function fitCamera() {
    // Fixed look-at distance when size-matched to the die; otherwise frame to fit
    // the cube (accounting for the narrower of the two fovs on portrait screens).
    let dist;
    if (FRAME_DIST != null) {
      dist = FRAME_DIST;
    } else {
      const vfov = THREE.MathUtils.degToRad(camera.fov);
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
      const fov = Math.min(vfov, hfov);
      dist = (cubeRadius / Math.sin(fov / 2)) * 1.12;
    }
    const dir = new THREE.Vector3().subVectors(camera.position, controls.target);
    if (dir.lengthSq() === 0) dir.set(0.6, 0.5, 0.85);
    dir.normalize();
    camera.position.copy(controls.target).addScaledVector(dir, dist);
    camera.updateProjectionMatrix();
    controls.update();
  }

  function worldToGrid(centerWorld) {
    const local = centerWorld.clone();
    const g = (v, mn) => Math.round((v - mn) / cell) - 1;
    return new THREE.Vector3(g(local.x, axisMin.x), g(local.y, axisMin.y), g(local.z, axisMin.z));
  }

  // ─── per-face material corrections ─────────────────────────────────────
  const NORMAL_FIX_CUBIES = [
    [-1, -1, -1], [0, -1, -1], [-1, 1, -1], [0, 1, -1], [1, -1, -1],
  ];

  function splitMeshByTriangle(mesh, predicate, matTrue, glow) {
    const geo = mesh.geometry;
    const pos = geo.attributes.position, nor = geo.attributes.normal;
    if (!pos || !nor) return false;
    const index = geo.index ? geo.index.array : null;
    const triCount = index ? index.length / 3 : pos.count / 3;
    const vi = (t, k) => index ? index[t * 3 + k] : t * 3 + k;
    const trueIdx = [], falseIdx = [];
    const n = new THREE.Vector3(), c = new THREE.Vector3();
    for (let t = 0; t < triCount; t++) {
      const a = vi(t, 0), b = vi(t, 1), d = vi(t, 2);
      n.set((nor.getX(a) + nor.getX(b) + nor.getX(d)) / 3, (nor.getY(a) + nor.getY(b) + nor.getY(d)) / 3, (nor.getZ(a) + nor.getZ(b) + nor.getZ(d)) / 3);
      c.set((pos.getX(a) + pos.getX(b) + pos.getX(d)) / 3, (pos.getY(a) + pos.getY(b) + pos.getY(d)) / 3, (pos.getZ(a) + pos.getZ(b) + pos.getZ(d)) / 3);
      (predicate(n, c) ? trueIdx : falseIdx).push(a, b, d);
    }
    if (!trueIdx.length) return false;
    const make = (arr, material, isGlow) => {
      const g = geo.clone(); g.setIndex(arr); g.clearGroups();
      const m = new THREE.Mesh(g, material);
      m.position.copy(mesh.position); m.quaternion.copy(mesh.quaternion); m.scale.copy(mesh.scale);
      m.raycast = mesh.raycast;
      if (isGlow) m.layers.enable(BLOOM_LAYER);
      return m;
    };
    const parent = mesh.parent;
    parent.add(make(trueIdx, matTrue, glow));
    if (falseIdx.length) parent.add(make(falseIdx, mesh.material, false));
    parent.remove(mesh);
    return true;
  }

  function applyMaterialFixes() {
    cube.updateMatrixWorld(true);

    const FLIP_MATS = new Set(['morkgra', 'Ljusgra', 'Vit']);
    for (const grid of NORMAL_FIX_CUBIES) {
      const c = cubies.find(cc => cc.grid.x === grid[0] && cc.grid.y === grid[1] && cc.grid.z === grid[2]);
      if (!c) continue;
      c.obj.traverse(o => {
        if (!o.isMesh || !o.geometry || !o.material || !FLIP_MATS.has(o.material.name)) return;
        const pos = o.geometry.attributes.position, nor = o.geometry.attributes.normal;
        if (!pos || !nor) return;
        const a = nor.array; let changed = false;
        for (let i = 0; i < pos.count; i++) {
          const j = i * 3;
          if (a[j] * pos.array[j] + a[j + 1] * pos.array[j + 1] + a[j + 2] * pos.array[j + 2] < 0) {
            a[j] *= -1; a[j + 1] *= -1; a[j + 2] *= -1; changed = true;
          }
        }
        if (changed) nor.needsUpdate = true;
      });
    }

    const cubieAt = (x, y, z) => cubies.find(c => c.grid.x === x && c.grid.y === y && c.grid.z === z);

    // (1b) The flat white "X" (Vit_X) is deliberately NOT in FLIP_MATS above, but
    // it suffers the SAME inverted-normal defect on several back cubies — so the X
    // paint shades a DIFFERENT colour there than on the correctly-normaled cubies
    // ("some X parts white, others gray" when unsolved, because an inward normal
    // samples the environment from the wrong side). Correct it the same way: flip
    // any inward-pointing normal (dot(normal, position) < 0) to outward, on every
    // back cubie, BEFORE the split so the glow + matte sub-meshes inherit it.
    for (const c of cubies) {
      if (c.grid.z !== -1) continue;
      c.obj.traverse(o => {
        if (!o.isMesh || !o.geometry || !o.material || o.material.name !== 'Vit_X') return;
        const pos = o.geometry.attributes.position, nor = o.geometry.attributes.normal;
        if (!pos || !nor) return;
        const a = nor.array; let changed = false;
        for (let i = 0; i < pos.count; i++) {
          const j = i * 3;
          if (a[j] * pos.array[j] + a[j + 1] * pos.array[j + 1] + a[j + 2] * pos.array[j + 2] < 0) {
            a[j] *= -1; a[j + 1] *= -1; a[j + 2] *= -1; changed = true;
          }
        }
        if (changed) nor.needsUpdate = true;
      });
    }

    // (2) Back-face "X" glow — ONLY the visible OUTER back wall of each back
    // cubie's white X stroke glows. The model's white X meshes are full extruded
    // shells (an outer wall + an inner wall ~0.07 apart, plus side walls) that
    // also wrap onto the cubies' side/front faces; glowing a whole shell lit
    // white well beyond the X, and that stray white kept glowing whenever the
    // back face was assembled. We must therefore glow just one thin wall.
    //
    // Pick that wall by POSITION (the most-negative-Z / outermost wall), NOT by
    // normal direction: several back cubies ship with inverted normals (a model
    // defect — see NORMAL_FIX_CUBIES), so a normal test (nz<-0.5) lands on the
    // INNER wall there, leaving the visible outer wall matte — which then
    // depth-occludes the glow from rear views (one corner reads dim). The extra
    // |n.z|>0.5 keeps the X stroke's SIDE walls (|n.z|≈0) from glowing.
    for (const c of cubies) {
      if (c.grid.z !== -1) continue;            // the X lives on the back face only
      const shells = [];
      c.obj.traverse(o => { if (o.isMesh && o.material && o.material.name === 'Vit_X') shells.push(o); });
      for (const o of shells) {
        const pos = o.geometry.attributes.position;
        let minZ = Infinity;
        for (let i = 0; i < pos.count; i++) { const z = pos.getZ(i); if (z < minZ) minZ = z; }
        const zCut = minZ + 0.035;              // < the ~0.07 wall gap, so the inner wall is excluded
        const glowMat = o.material.clone();
        glowMat.color.setHex(0x000000);
        glowMat.emissive.setHex(0xffffff);
        glowMat.emissiveIntensity = 1.6;
        glowMat.toneMapped = true;
        splitMeshByTriangle(o, (n, cen) => Math.abs(n.z) > 0.5 && cen.z < zCut, glowMat, true);
      }
    }

    const c38 = cubieAt(0, 1, -1);
    if (c38) c38.obj.traverse(o => {
      if (o.isMesh && o.material && o.material.name === 'Rod') o.geometry.computeVertexNormals();
    });

    const cBolt = cubieAt(0, 1, 1);
    if (cBolt) {
      let gul = null, vit = null;
      cBolt.obj.traverse(o => { if (o.isMesh && o.material) { if (o.material.name === 'Gul') gul = o; if (o.material.name === 'Vit') vit = o; } });
      if (gul && vit) {
        gul.geometry.computeBoundingBox();
        const gb = gul.geometry.boundingBox.clone(); gb.expandByScalar(0.06);
        const yellowMat = vit.material.clone();
        yellowMat.color.setHex(0x000000); yellowMat.emissive.setHex(0xe9ff00); yellowMat.emissiveIntensity = 2.4; yellowMat.toneMapped = true; yellowMat.side = THREE.DoubleSide;
        splitMeshByTriangle(vit, (n, c) => gb.containsPoint(c) && n.z < 0.85 && n.y < 0.85, yellowMat, true);
      }
    }
  }

  // ─── glow gating + fade ────────────────────────────────────────────────
  const glowGroups = [];

  function cubieSolved(c) {
    const g = c.obj.userData.grid, h = c.obj.userData.home.grid;
    if (g.x !== h.x || g.y !== h.y || g.z !== h.z) return false;
    // A centre piece (only one exposed face) reads as solved at its home slot
    // regardless of its in-plane spin — a facelet solve leaves that spin
    // arbitrary and it doesn't change whether the face looks solved. Corners and
    // edges still must match orientation.
    const exposed = (h.x !== 0 ? 1 : 0) + (h.y !== 0 ? 1 : 0) + (h.z !== 0 ? 1 : 0);
    if (exposed <= 1) return true;
    return Math.abs(c.obj.quaternion.dot(c.obj.userData.home.quat)) > 0.99;
  }

  function applyGlow(grp) { for (const m of grp.meshes) m.material.emissiveIntensity = m.userData.fullGlow * grp.factor; }

  function setupGlowGroups() {
    const front = [], back = [], eyes = [];
    cubies.forEach(c => {
      const h = c.obj.userData.home.grid;
      if (h.z === 1) front.push(c);
      if (h.z === -1) back.push(c);
      if (h.z === 1 && h.y === 0) eyes.push(c);
    });
    const buckets = { bolt: [], eyes: [], X: [] };
    const baseColor = { eyes: 0x30d2f8, bolt: 0xe9ff00, X: 0xe7e7e7 };
    const glowScale = { bolt: 0.5, eyes: 0.28, X: 0.25 };
    cube.traverse(o => {
      if (!o.isMesh || !o.material || !(o.material.emissiveIntensity > 0) || !bloomLayer.test(o.layers)) return;
      const e = o.material.emissive;
      const grp = (e.b > 0.5 && e.r < 0.4) ? 'eyes' : (e.b < 0.4 ? 'bolt' : 'X');
      o.material.color.setHex(baseColor[grp]);
      o.userData.fullGlow = o.material.emissiveIntensity * glowScale[grp];
      buckets[grp].push(o);
    });
    glowGroups.length = 0;
    // Bolt + eyes keep a faint always-on glow (floor), like the X, at reduced
    // intensity — they ramp to full once their face is solved.
    glowGroups.push({ meshes: buckets.bolt, gate: front, factor: 0, floor: 0.15 });
    glowGroups.push({ meshes: buckets.eyes, gate: eyes, factor: 0, floor: 0.15 });
    // The X keeps a constant 30% glow even when unsolved — a faint uniform
    // emissive wash that masks the back cubies' inconsistent paint shading
    // (model normal defect). It still ramps to full (100%) once the X is solved.
    glowGroups.push({ meshes: buckets.X, gate: back, factor: 0, floor: 0.3 });
    for (const grp of glowGroups) { grp.factor = grp.gate.every(cubieSolved) ? 1 : grp.floor; applyGlow(grp); }
  }

  function updateGlows(dt) {
    const step = dt / 1000;
    for (const grp of glowGroups) {
      const target = grp.gate.every(cubieSolved) ? 1 : grp.floor;
      if (grp.factor === target) continue;
      grp.factor = target > grp.factor ? Math.min(target, grp.factor + step) : Math.max(target, grp.factor - step);
      applyGlow(grp);
    }
  }

  // ─── turning a layer ───────────────────────────────────────────────────
  const AXES = ['x', 'y', 'z'];
  const moveHistory = [];
  let sequencing = false;
  function recordMove(axisIdx, level, turns) { moveHistory.push({ axisIdx, level, turns }); }
  function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function layerCubies(axisIdx, level) {
    const k = AXES[axisIdx];
    return cubies.filter(c => c.grid[k] === level);
  }

  function rotateLayer(axisIdx, level, turns, ms = TURN_MS, record = true) {
    return new Promise(resolve => {
      const members = layerCubies(axisIdx, level);
      const pivot = new THREE.Group();
      cube.add(pivot);
      members.forEach(c => pivot.attach(c.obj));
      const axisName = AXES[axisIdx];
      const target = turns * Math.PI / 2;
      const t0 = performance.now();
      busy = true;
      const step = (now) => {
        const t = Math.min(1, (now - t0) / ms);
        const e = easeInOut(t);
        pivot.rotation[axisName] = target * e;
        render();
        if (t < 1) { requestAnimationFrame(step); }
        else { finalizeLayer(pivot, members, axisIdx, turns); if (record && turns) recordMove(axisIdx, level, turns); busy = false; resolve(); }
      };
      requestAnimationFrame(step);
    });
  }

  function finalizeLayer(pivot, members, axisIdx, turns) {
    members.forEach(c => {
      cube.attach(c.obj);
      c.obj.quaternion.normalize();
      c.obj.userData.grid = rotateGrid(c.obj.userData.grid, axisIdx, turns);
    });
    cube.remove(pivot);
  }

  function rotateGrid(g, ax, turns) {
    let x = g.x, y = g.y, z = g.z;
    const n = ((turns % 4) + 4) % 4;
    for (let i = 0; i < n; i++) {
      if (ax === 0)      { const ny = -z, nz = y;  y = ny; z = nz; }
      else if (ax === 1) { const nx = z,  nz = -x; x = nx; z = nz; }
      else               { const nx = -y, ny = x;  x = nx; y = ny; }
    }
    return new THREE.Vector3(x, y, z);
  }

  // ─── drag-to-turn interaction ──────────────────────────────────────────
  const pointer = new THREE.Vector2();
  let drag = null;
  let orbiting = false;   // user is dragging empty space (TrackballControls orbits the camera)
  let orbitStopped = false;   // click anywhere to freeze the idle tumble (like the die); click again / drag to resume
  let downX = 0, downY = 0;   // pointer-down position, for click (freeze) vs drag/flick detection

  function ndc(ev) {
    const r = canvas.getBoundingClientRect();
    pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    return pointer;
  }
  function toScreen(v3) {
    const v = v3.clone().project(camera);
    return new THREE.Vector2(v.x, v.y);
  }

  function onPointerDown(ev) {
    if (!enabled || busy || sequencing || !cubies.length) return;
    downX = ev.clientX; downY = ev.clientY;   // remember for click (freeze) vs flick (exit) on release
    raycaster.setFromCamera(ndc(ev), camera);
    const hits = raycaster.intersectObjects(cube.children, true);
    if (!hits.length) { orbiting = true; recentCamSpeed = 0; return; }   // empty space -> TrackballControls orbits the camera

    const hit = hits[0];
    let node = hit.object; while (node.parent && node.parent !== cube) node = node.parent;
    const rec = cubies.find(c => c.obj === node);
    if (!rec) { orbiting = true; recentCamSpeed = 0; return; }

    const g = [rec.grid.x, rec.grid.y, rec.grid.z];
    const exposed = [0, 1, 2].filter(a => Math.abs(g[a]) === 1);
    if (!exposed.length) return;
    const hp = [hit.point.x, hit.point.y, hit.point.z];
    let faceAxis = exposed[0], bestOut = -Infinity;
    for (const a of exposed) { const out = hp[a] * Math.sign(g[a]); if (out > bestOut) { bestOut = out; faceAxis = a; } }

    const cands = [0, 1, 2].filter(a => a !== faceAxis).map(a => {
      const axisVec = new THREE.Vector3(); axisVec.setComponent(a, 1);
      const r = hit.point.clone();
      const tangent = axisVec.clone().cross(r);
      const p0 = toScreen(hit.point);
      const p1 = toScreen(hit.point.clone().addScaledVector(tangent, 0.01));
      const dir = p1.sub(p0);
      dir.x *= canvas.clientWidth; dir.y *= -canvas.clientHeight;
      return { axis: a, pxPerRad: dir.clone().multiplyScalar(1 / 0.01) };
    });

    controls.enabled = false;
    ev.stopImmediatePropagation();   // claim this gesture for a layer turn so TrackballControls never starts
    drag = { rec, faceAxis, cands, startX: ev.clientX, startY: ev.clientY, committed: false, pivot: null, axisName: '', members: [], angle: 0, pxPerRad: null };
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
  }

  function onPointerMove(ev) {
    if (!drag) return;
    const dx = ev.clientX - drag.startX, dy = ev.clientY - drag.startY;

    if (!drag.committed) {
      if (Math.hypot(dx, dy) < 7) return;
      const v = new THREE.Vector2(dx, dy);
      let best = null, bestScore = -Infinity;
      for (const c of drag.cands) {
        const score = Math.abs(v.dot(c.pxPerRad)) / c.pxPerRad.length();
        if (score > bestScore) { bestScore = score; best = c; }
      }
      const axisIdx = best.axis;
      const level = drag.rec.grid[AXES[axisIdx]];
      drag.axisIdx = axisIdx;
      drag.level = level;
      drag.axisName = AXES[axisIdx];
      drag.pxPerRad = best.pxPerRad;
      drag.members = layerCubies(axisIdx, level);
      drag.pivot = new THREE.Group(); cube.add(drag.pivot);
      drag.members.forEach(c => drag.pivot.attach(c.obj));
      drag.committed = true;
    }

    const proj = (dx * drag.pxPerRad.x + dy * drag.pxPerRad.y) / drag.pxPerRad.length();
    let angle = proj / drag.pxPerRad.length();
    angle = Math.max(-Math.PI * 0.75, Math.min(Math.PI * 0.75, angle));
    drag.angle = angle;
    drag.pivot.rotation[drag.axisName] = angle;
  }

  function onPointerUp(ev) {
    orbiting = false;
    const moved = Math.hypot(ev.clientX - downX, ev.clientY - downY);
    if (!drag) {
      // Gesture on empty space (started off the cube): a plain click (barely
      // moved) freezes / unfreezes the tumble; a slow manual orbit resumes the
      // idle drift on release. Spinning does NOT exit the cube — the only way
      // out is to leave the membrane page and come back (which resets it).
      if (moved <= 6) orbitStopped = !orbitStopped;
      else orbitStopped = false;
      return;
    }
    try { canvas.releasePointerCapture(ev.pointerId); } catch (e) {}
    const d = drag; drag = null;
    controls.enabled = enabled;
    // A tap on the cube (no layer-turn committed) freezes / unfreezes the tumble.
    if (!d.committed) { orbitStopped = !orbitStopped; return; }

    let turns = Math.round(d.angle / (Math.PI / 2));
    if (turns === 0 && Math.abs(d.angle) > Math.PI / 12) turns = Math.sign(d.angle);
    const remaining = turns * (Math.PI / 2) - d.angle;
    const t0 = performance.now();
    const ms = Math.max(90, Math.abs(remaining) / (Math.PI / 2) * TURN_MS);
    busy = true;
    const start = d.angle;
    const step = (now) => {
      const t = Math.min(1, (now - t0) / ms);
      const e = easeInOut(t);
      d.pivot.rotation[d.axisName] = start + remaining * e;
      render();
      if (t < 1) requestAnimationFrame(step);
      else { finalizeLayer(d.pivot, d.members, d.axisIdx, turns); if (turns) recordMove(d.axisIdx, d.level, turns); busy = false; }
    };
    requestAnimationFrame(step);
  }

  canvas.addEventListener('pointerdown', onPointerDown, true);
  canvas.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);

  // ─── scramble / reset ──────────────────────────────────────────────────
  function setSequencing(on) { sequencing = on; onSequencing?.(on); }

  async function scramble(n = 20) {
    if (!ready || busy || sequencing) return;
    setSequencing(true);
    let lastAxis = -1;
    for (let i = 0; i < n; i++) {
      let a; do { a = Math.floor(Math.random() * 3); } while (a === lastAxis);
      lastAxis = a;
      // Outer faces only (no middle slice): keeps the centres fixed so the
      // two-phase solver always returns a clean, minimal solve on reset.
      const level = Math.random() < 0.5 ? -1 : 1;
      const turns = Math.random() < 0.5 ? 1 : -1;
      await rotateLayer(a, level, turns, 200);
    }
    setSequencing(false);
  }

  // ─── optimal solve (Kociemba two-phase, via cube-solver.js) ──────────────
  // Reset no longer replays the move history (which crawls move-by-move through
  // a long session). Instead we read the cube's ACTUAL state into a standard
  // facelet string, hand it to the two-phase solver (≤ ~22 moves for any state),
  // and animate that. The cube↔solver geometry was pinned down + verified
  // exhaustively offline: solved state and all 18 face turns reproduce cubejs's
  // facelet strings exactly, and thousands of random scrambles round-trip to a
  // colour-solved cube. (See the layout/mapping below.)
  //
  // Standard Kociemba facelet layout: for each face (read in U R F D L B order,
  // 9 stickers row-major) the (x,y,z) grid cell that carries that sticker.
  const SOLVE_LAYOUT = {
    U: [[-1,1,-1],[0,1,-1],[1,1,-1],[-1,1,0],[0,1,0],[1,1,0],[-1,1,1],[0,1,1],[1,1,1]],
    R: [[1,1,1],[1,1,0],[1,1,-1],[1,0,1],[1,0,0],[1,0,-1],[1,-1,1],[1,-1,0],[1,-1,-1]],
    F: [[-1,1,1],[0,1,1],[1,1,1],[-1,0,1],[0,0,1],[1,0,1],[-1,-1,1],[0,-1,1],[1,-1,1]],
    D: [[-1,-1,1],[0,-1,1],[1,-1,1],[-1,-1,0],[0,-1,0],[1,-1,0],[-1,-1,-1],[0,-1,-1],[1,-1,-1]],
    L: [[-1,1,-1],[-1,1,0],[-1,1,1],[-1,0,-1],[-1,0,0],[-1,0,1],[-1,-1,-1],[-1,-1,0],[-1,-1,1]],
    B: [[1,1,-1],[0,1,-1],[-1,1,-1],[1,0,-1],[0,0,-1],[-1,0,-1],[1,-1,-1],[0,-1,-1],[-1,-1,-1]],
  };
  const SOLVE_FACE_ORDER = ['U', 'R', 'F', 'D', 'L', 'B'];
  // (gridCell|outwardFaceLetter) → index 0..53 in the facelet string.
  const solvePosIndex = {};
  SOLVE_FACE_ORDER.forEach((f, fi) => SOLVE_LAYOUT[f].forEach((g, gi) => {
    solvePosIndex[`${g[0]},${g[1]},${g[2]}|${f}`] = fi * 9 + gi;
  }));
  // World axis (x=±R/L, y=±U/D, z=±F/B) → face letter.
  const faceLetterOf = (x, y, z) =>
    x === 1 ? 'R' : x === -1 ? 'L' : y === 1 ? 'U' : y === -1 ? 'D' : z === 1 ? 'F' : 'B';
  // cubejs solution token → app layer turn. Verified: cubejs U/R/F = the layer
  // turned −1 about +axis, D/L/B = +1; "2" = half turn, "'" = the opposite.
  const SOLVE_C2A = {
    U: { axisIdx: 1, level: 1, b: -1 }, D: { axisIdx: 1, level: -1, b: 1 },
    R: { axisIdx: 0, level: 1, b: -1 }, L: { axisIdx: 0, level: -1, b: 1 },
    F: { axisIdx: 2, level: 1, b: -1 }, B: { axisIdx: 2, level: -1, b: 1 },
  };
  function tokenToApp(tok) {
    const m = SOLVE_C2A[tok[0]];
    const turns = tok[1] === undefined ? m.b : tok[1] === '2' ? 2 : -m.b;
    return { axisIdx: m.axisIdx, level: m.level, turns };
  }

  const _solveQDelta = new THREE.Quaternion();
  const _solveQHomeInv = new THREE.Quaternion();
  const _solveDir = new THREE.Vector3();

  // Read the live cubies (current grid + orientation vs. home) into a 54-char
  // facelet string. Returns null if the layout can't be resolved (then reset
  // just snaps). A face turn never moves a centre piece off its face, so the
  // string's centres stay put — the solver gets a standard, solvable cube.
  function extractFacelets() {
    const out = new Array(54).fill(null);
    for (const c of cubies) {
      const o = c.obj;
      const hg = o.userData.home.grid;
      const g = o.userData.grid;
      _solveQHomeInv.copy(o.userData.home.quat).invert();
      _solveQDelta.copy(o.quaternion).multiply(_solveQHomeInv);
      const gx = Math.round(g.x), gy = Math.round(g.y), gz = Math.round(g.z);
      const hv = [Math.round(hg.x), Math.round(hg.y), Math.round(hg.z)];
      for (let ax = 0; ax < 3; ax++) {
        const sign = hv[ax];
        if (sign === 0) continue;                       // not an outward sticker
        const color = faceLetterOf(ax === 0 ? sign : 0, ax === 1 ? sign : 0, ax === 2 ? sign : 0);
        _solveDir.set(ax === 0 ? sign : 0, ax === 1 ? sign : 0, ax === 2 ? sign : 0)
          .applyQuaternion(_solveQDelta);
        const cur = faceLetterOf(Math.round(_solveDir.x), Math.round(_solveDir.y), Math.round(_solveDir.z));
        const idx = solvePosIndex[`${gx},${gy},${gz}|${cur}`];
        if (idx === undefined) return null;
        out[idx] = color;
      }
    }
    return out.includes(null) ? null : out.join('');
  }

  // Build the heavy two-phase pruning tables once, lazily (first reset only).
  let solverReady = false;
  function ensureSolver() {
    if (solverReady) return;
    Cube.initSolver();
    solverReady = true;
  }

  async function reset() {
    if (!ready || busy || sequencing) return;
    setSequencing(true);
    let solution = null;
    try {
      ensureSolver();
      const facelets = extractFacelets();
      if (facelets) solution = Cube.fromString(facelets).solve();
    } catch (e) {
      console.warn('[rubiks] solve failed; snapping to solved', e);
    }
    if (solution) {
      for (const tok of solution.split(/\s+/).filter(Boolean)) {
        const m = tokenToApp(tok);
        await rotateLayer(m.axisIdx, m.level, m.turns, 200, false);
      }
      // Done — leave the cube exactly where the solution finished. It's solved;
      // we intentionally do NOT snap it back to a home/front-facing orientation
      // (that reorientation looked bad and isn't needed — a solved cube is enough).
    } else {
      // Solver unavailable/failed — fall back to snapping straight to solved so
      // the cube is never left scrambled.
      cubies.forEach(c => {
        c.obj.position.copy(c.obj.userData.home.pos);
        c.obj.quaternion.copy(c.obj.userData.home.quat);
        c.obj.userData.grid = c.obj.userData.home.grid.clone();
      });
    }
    moveHistory.length = 0;
    setSequencing(false);
  }

  // ─── render loop (continuous while enabled) ────────────────────────────
  // Slow idle camera-orbit so the cube tumbles "like the other shapes" when
  // untouched; a sustained-fast background spin fires onCycleAway() — the gesture
  // that morphs the membrane die back to the regular shapes. The cube itself
  // stays at identity (the camera moves), so face colours stay stable.
  const IDLE_ORBIT = 0.16;          // rad/s — gentle resting drift
  const REVEAL_SPIN = 5.4;          // rad/s — fast multi-axis tumble as the cube fades in...
  const SPIN_SETTLE_TAU = 1.5;      // s — ...eases back to IDLE_ORBIT (stays fast through the whole transition)
  let orbitVel = IDLE_ORBIT;        // live orbit speed (seeded to REVEAL_SPIN on reveal, decays to idle)
  const SPIN_TRIGGER = 2.5;         // rad/s — a deliberate whip of the background
  const SPIN_SUSTAIN = 0.5;         // s above trigger before it fires
  const SPIN_REARM = 1.0;           // rad/s — must drop below to re-arm
  const EXIT_FLICK_SPEED = 3.0;     // rad/s — a fast flick-and-release on empty space exits to the shapes
  let recentCamSpeed = 0;           // decaying peak of camera-orbit speed, sampled for the flick gesture
  let spinArmed = true;
  let fastTime = 0;
  const _camDir = new THREE.Vector3();
  const _prevCamDir = new THREE.Vector3();
  const _yawAxis = new THREE.Vector3(0, 1, 0);
  // Tilted axis for the reveal tumble (yaw + pitch + roll). The live spin axis
  // blends from this toward pure yaw as the orbit settles → multi-axis while
  // fast, calm yaw-only when idle (idle stays yaw so it can't gimbal over a pole).
  const _revealAxis = new THREE.Vector3(0.55, 1, 0.4).normalize();
  const _spinAxis = new THREE.Vector3();

  let enabled = false;
  let rafId = null;
  let lastFrame = 0;

  function orbitCameraIdle(dt) {
    // Blend the spin axis from the tilted reveal tumble toward pure yaw as the
    // orbit eases down to idle (multi-axis while fast, calm yaw when resting).
    const k = Math.min(1, Math.max(0, (orbitVel - IDLE_ORBIT) / (REVEAL_SPIN - IDLE_ORBIT)));
    _spinAxis.copy(_yawAxis).lerp(_revealAxis, k).normalize();
    const offset = _camDir.subVectors(camera.position, controls.target);
    offset.applyAxisAngle(_spinAxis, orbitVel * dt);
    camera.position.copy(controls.target).add(offset);
    // Ease the reveal spin-up back down to the gentle idle drift.
    orbitVel += (IDLE_ORBIT - orbitVel) * (1 - Math.exp(-dt / SPIN_SETTLE_TAU));
  }

  function frame() {
    if (!enabled) return;
    rafId = requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(100, now - lastFrame); lastFrame = now;
    const dts = dt / 1000;

    // Keep the idle tumble going even while solving/scrambling (sequencing) or
    // mid layer-turn (busy) — those animate the cubies, not the camera, so the
    // slow camera orbit is independent. Only an active user drag, a manual
    // orbit, or an explicit click-to-stop pauses it.
    if (!drag && !orbiting && !orbitStopped) orbitCameraIdle(dts);
    controls.update();

    // (Spin-to-exit removed: the cube is left until the user navigates away and
    // comes back, which resets it. No camera-speed gesture is measured here.)

    updateGlows(dt);
    render();
  }

  function setEnabled(on) {
    if (on === enabled) return;
    enabled = on;
    controls.enabled = on && !drag;
    if (on) {
      resize();
      spinArmed = false; fastTime = 0; recentCamSpeed = 0;   // disarm exit until the fast reveal spin settles
      orbitStopped = false;       // always tumble on reveal
      orbitVel = REVEAL_SPIN;     // start fast + multi-axis so it never reads as frozen as it fades in
      _prevCamDir.set(0, 0, 0);
      lastFrame = performance.now();
      if (!rafId) rafId = requestAnimationFrame(frame);
      // Build the heavy solver tables now (deferred, off the reveal) so the
      // first Reset solves while still tumbling instead of freezing ~1s to
      // build them. The one blocking ~1s lands here, during idle viewing.
      if (!solverReady) {
        (window.requestIdleCallback || ((f) => setTimeout(f, 1200)))(() => { try { ensureSolver(); } catch (e) {} });
      }
    } else {
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    }
  }

  function resize() {
    const sz = sizeOf();
    VW = sz.w; VH = sz.h;
    camera.aspect = VW / VH;
    renderer.setSize(VW, VH, false);
    bloomComposer.setSize(VW, VH);
    finalComposer.setSize(VW, VH);
    controls.handleResize();
    if (cubies.length) fitCamera(); else camera.updateProjectionMatrix();
  }

  const resizeObserver = new ResizeObserver(() => { if (enabled) resize(); });
  resizeObserver.observe(canvas);

  return {
    ready: readyPromise,
    setEnabled,
    scramble,
    reset,
    isReady: () => ready,
    dispose() {
      setEnabled(false);
      resizeObserver.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown, true);
      canvas.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      controls.dispose?.();
      pmrem.dispose?.();
      bloomComposer.dispose?.();
      finalComposer.dispose?.();
      renderer.dispose();
    },
  };
}
