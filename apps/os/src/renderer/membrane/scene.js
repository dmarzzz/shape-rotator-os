import * as THREE from 'three';
import { RoomEnvironment } from '../../vendor/three-jsm/environments/RoomEnvironment.js';
import { EffectComposer } from '../../vendor/three-jsm/postprocessing/EffectComposer.js';
import { RenderPass } from '../../vendor/three-jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../../vendor/three-jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../../vendor/three-jsm/postprocessing/OutputPass.js';
import { createBlob, BLOB_IDS } from './blob.js';
import { createStarField } from './starfield.js';

// Vanta cosmic — true-black background, stars via CSS. Lighting kept warm
// so the blobs read as small celestial bodies against deep space.
const KEY_LIGHT_COLOR = 0xffe2c2;
const FILL_LIGHT_COLOR = 0xb8c4d6;
const HEMI_SKY = 0xffe2c2;
const HEMI_GROUND = 0x3a2a22;          // darker ground tone for true-black bg
const AMBIENT_COLOR = 0x2a2530;
const AMBIENT_INTENSITY = 0.20;

// Slots defined as OFFSETS FROM THE RIGHT/BOTTOM EDGE in world units.
// resize() converts these to actual world positions using the camera
// frustum so the cluster always sits a fixed distance from the corner
// regardless of window aspect ratio (no more clipping on narrow windows).
export const SLOT_OFFSETS = {
  throne:  { right: 0.70, bottom: 0.55, scale: 0.42 },
  home_a:  { right: 1.50, bottom: 1.25, scale: 0.13 },
  home_b:  { right: 1.00, bottom: 1.55, scale: 0.13 },
  home_c:  { right: 0.40, bottom: 1.40, scale: 0.13 },
};

const INITIAL_THRONE = 'self';
const INITIAL_HOMES = { cohort: 'home_a', events: 'home_b', asks: 'home_c' };

const SWAP_DURATION_MS = 900;

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function createMembraneScene(canvas, opts = {}) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  // Lighting: single dominant key + back-rim for silhouette. No spec accent
  // (caused patchy multi-highlights). The back-rim is what gives a jewel
  // its glowing edge against the void — classic gemstone photography move.
  const keyLight = new THREE.DirectionalLight(KEY_LIGHT_COLOR, 2.6);
  keyLight.position.set(-3.5, 4.2, 2.8);
  scene.add(keyLight);

  // Back rim — silhouettes the blob from behind. Warm so it reinforces the
  // ember atmosphere rather than competing with it.
  const backRim = new THREE.DirectionalLight(0xffb070, 1.2);
  backRim.position.set(2.0, 0.5, -3.0);
  scene.add(backRim);

  const ambient = new THREE.AmbientLight(AMBIENT_COLOR, 0.14);
  scene.add(ambient);

  const cameraZ = 4.8;
  const fov = 38;
  const camera = new THREE.PerspectiveCamera(fov, 1, 0.1, 100);
  camera.position.set(0, 0, cameraZ);
  camera.lookAt(0, 0, 0);

  // Post-processing — bloom on bright pixels (specular highlights, halo,
  // dust at full brightness) so the blob reads as jewel-luminous instead
  // of "3D demo." Threshold means body color doesn't bloom; only the
  // intentionally-bright bits do.
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.45, 0.62);
  bloomPass.threshold = 0.62;
  bloomPass.strength = 0.55;
  bloomPass.radius = 0.45;
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());

  // Resolved slot world positions — updated on every resize so blobs stay
  // glued to the corner relative to the visible frustum.
  const resolvedSlots = {
    throne:  { x: 0, y: 0, scale: SLOT_OFFSETS.throne.scale },
    home_a:  { x: 0, y: 0, scale: SLOT_OFFSETS.home_a.scale },
    home_b:  { x: 0, y: 0, scale: SLOT_OFFSETS.home_b.scale },
    home_c:  { x: 0, y: 0, scale: SLOT_OFFSETS.home_c.scale },
  };

  function recomputeSlots() {
    const halfH = Math.tan((fov * Math.PI / 180) / 2) * cameraZ;
    const halfW = halfH * camera.aspect;
    for (const name of Object.keys(SLOT_OFFSETS)) {
      const off = SLOT_OFFSETS[name];
      resolvedSlots[name].x = halfW - off.right;
      resolvedSlots[name].y = -halfH + off.bottom;
      resolvedSlots[name].scale = off.scale;
    }
  }

  const blobs = {};
  const blobBySlot = {};
  const slotByBlob = {};
  BLOB_IDS.forEach((id, idx) => {
    const blob = createBlob(THREE, id);
    blobs[id] = blob;
    const slotName = id === INITIAL_THRONE ? 'throne' : INITIAL_HOMES[id];
    blob.currentSlot = slotName;
    blob.rotationPhase = (idx * Math.PI * 0.6) + Math.random() * 0.4;
    blob.spinRate = 0.06 + Math.random() * 0.03;
    blob.setActive(slotName === 'throne');
    scene.add(blob.group);
    blobBySlot[slotName] = id;
    slotByBlob[id] = slotName;
  });

  const tweens = [];

  function tweenBlobToSlot(blobId, toSlot) {
    const blob = blobs[blobId];
    if (!blob) return;
    const fromPos = blob.group.position.clone();
    const fromScale = blob.group.scale.x;
    const now = performance.now();
    for (let i = tweens.length - 1; i >= 0; i--) {
      if (tweens[i].blobId === blobId) tweens.splice(i, 1);
    }
    // Target is captured by slot NAME so resize() can re-point it mid-tween.
    tweens.push({
      blobId, fromPos, toSlot, fromScale,
      startMs: now, endMs: now + SWAP_DURATION_MS,
    });
    blob.currentSlot = toSlot;
    slotByBlob[blobId] = toSlot;
  }

  function wiggleThrone() {
    const id = blobBySlot['throne'];
    if (!id) return;
    blobs[id].wiggleStart = performance.now();
  }

  function setActiveBlob(id) {
    if (!blobs[id]) return;
    if (slotByBlob[id] === 'throne') {
      wiggleThrone();
      return;
    }
    const currentThroneId = blobBySlot['throne'];
    if (currentThroneId === id) return;

    const vacatedSlot = slotByBlob[id];
    if (currentThroneId) {
      tweenBlobToSlot(currentThroneId, vacatedSlot);
      blobBySlot[vacatedSlot] = currentThroneId;
      blobs[currentThroneId].setActive(false);
    }
    tweenBlobToSlot(id, 'throne');
    blobBySlot['throne'] = id;
    blobs[id].setActive(true);
  }

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const clickTargets = BLOB_IDS.map((id) => blobs[id].mesh);

  function pickBlobAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(clickTargets, false);
    if (hits.length === 0) return null;
    return { id: BLOB_IDS.find((id) => blobs[id].mesh === hits[0].object), point: hits[0].point };
  }

  function handlePointerDown(ev) {
    const hit = pickBlobAt(ev.clientX, ev.clientY);
    if (!hit?.id) return;
    if (hit.id === blobBySlot['throne']) {
      // Click on the throne → a quick scale-bounce for feedback.
      wiggleThrone();
      return;
    }
    // Click on satellite → swap it into the throne.
    setActiveBlob(hit.id);
    if (opts.onActiveChange) opts.onActiveChange(hit.id);
  }

  let hoveredId = null;
  function handlePointerMove(ev) {
    const hit = pickBlobAt(ev.clientX, ev.clientY);
    const hitId = hit?.id || null;
    canvas.style.cursor = hitId ? 'pointer' : 'default';
    if (hitId === hoveredId) return;
    if (hoveredId && blobs[hoveredId]) blobs[hoveredId].setHovered(false);
    hoveredId = hitId;
    if (hoveredId && blobs[hoveredId]) blobs[hoveredId].setHovered(true);
  }

  canvas.addEventListener('pointerdown', handlePointerDown);
  canvas.addEventListener('pointermove', handlePointerMove);

  // 3D star field — point cloud + nebula mist flowing toward camera.
  // (Regressed out of scene.js in a prior merge while starfield.js
  // survived; re-wired here.)
  const starField = createStarField({ scene, camera });

  const startMs = performance.now();
  let lastTickSeconds = 0;
  let running = true;
  let rafId = null;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(2, rect.width);
    const h = Math.max(2, rect.height);
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    recomputeSlots();
    // Snap non-tweening blobs to their current slot's new world position.
    for (const id of BLOB_IDS) {
      const blob = blobs[id];
      if (!blob) continue;
      const isTweening = tweens.some((t) => t.blobId === id);
      if (isTweening) continue;
      const slot = resolvedSlots[blob.currentSlot];
      if (!slot) continue;
      blob.group.position.set(slot.x, slot.y, 0);
      blob.group.scale.setScalar(slot.scale);
    }
  }

  function tickTweens(nowMs) {
    if (tweens.length === 0) return;
    for (let i = tweens.length - 1; i >= 0; i--) {
      const t = tweens[i];
      const blob = blobs[t.blobId];
      if (!blob) { tweens.splice(i, 1); continue; }
      const target = resolvedSlots[t.toSlot];
      if (!target) { tweens.splice(i, 1); continue; }
      const raw = (nowMs - t.startMs) / (t.endMs - t.startMs);
      const clamped = Math.max(0, Math.min(1, raw));
      const eased = easeInOutCubic(clamped);
      blob.group.position.x = t.fromPos.x + (target.x - t.fromPos.x) * eased;
      blob.group.position.y = t.fromPos.y + (target.y - t.fromPos.y) * eased;
      const s = t.fromScale + (target.scale - t.fromScale) * eased;
      blob.group.scale.setScalar(s);
      if (clamped >= 1) tweens.splice(i, 1);
    }
  }

  function tickMotion(time, nowMs) {
    for (const id of BLOB_IDS) {
      const blob = blobs[id];
      if (!blob) continue;
      const isThrone = blob.currentSlot === 'throne';
      blob.group.rotation.y = (time * blob.spinRate) + blob.rotationPhase;
      blob.group.rotation.x = Math.sin(time * 0.13 + blob.rotationPhase) * 0.05;
      blob.group.rotation.z = Math.sin(time * 0.09 - blob.rotationPhase) * 0.04;

      const hasTween = tweens.some((t) => t.blobId === id);
      if (!hasTween) {
        const slotName = blob.currentSlot;
        const baseScale = resolvedSlots[slotName]?.scale ?? 1;
        let s = baseScale;
        if (isThrone) {
          s = baseScale * (1 + Math.sin(time * 0.6) * 0.018);
        }
        if (blob.wiggleStart) {
          const dt = (nowMs - blob.wiggleStart) / 400;
          if (dt < 1) {
            s *= 1 + Math.sin(dt * Math.PI * 3) * 0.04 * (1 - dt);
          } else {
            blob.wiggleStart = null;
          }
        }
        blob.group.scale.setScalar(s);
      }
    }
  }

  // Barely-there camera sway. A slow Lissajous on x/y plus a gentle dolly on
  // z makes the parallax between star strata felt even when the user is idle
  // — the depth cue that motion alone provides. Amplitudes are a few
  // hundredths of a world unit so it never reads as movement, only as life.
  // Periods are mutually irrational-ish so the path never visibly repeats.
  const SWAY = {
    ax: 0.045, ay: 0.030, az: 0.025,   // amplitudes (world units)
    fx: 0.037, fy: 0.053, fz: 0.021,   // frequencies (Hz-ish)
  };

  function tick() {
    if (!running) return;
    const nowMs = performance.now();
    const time = (nowMs - startMs) / 1000;
    const dt = lastTickSeconds === 0 ? 0.016 : time - lastTickSeconds;
    lastTickSeconds = time;
    tickTweens(nowMs);
    tickMotion(time, nowMs);
    for (const id of BLOB_IDS) {
      blobs[id].tick(time);
    }

    // Idle camera sway around the base position. Re-look at origin so the
    // blobs stay anchored while the starfield parallax shifts behind them.
    const sx = Math.sin(time * SWAY.fx * Math.PI * 2) * SWAY.ax;
    const sy = Math.cos(time * SWAY.fy * Math.PI * 2) * SWAY.ay;
    const sz = Math.sin(time * SWAY.fz * Math.PI * 2) * SWAY.az;
    camera.position.set(sx, sy, cameraZ + sz);
    camera.lookAt(0, 0, 0);

    // Stars flow toward camera — forward drift through space.
    starField.tick(dt);
    composer.render();
    rafId = requestAnimationFrame(tick);
  }

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  resize();
  // Initial blob placement at their slot positions.
  for (const id of BLOB_IDS) {
    const blob = blobs[id];
    const slot = resolvedSlots[blob.currentSlot];
    blob.group.position.set(slot.x, slot.y, 0);
    blob.group.scale.setScalar(slot.scale);
  }
  tick();

  return {
    scene,
    camera,
    renderer,
    blobs,
    setActiveBlob,
    getActiveBlobId: () => blobBySlot['throne'],
    slotFor(id) { return slotByBlob[id]; },
    destroy() {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('pointermove', handlePointerMove);
      for (const id of BLOB_IDS) blobs[id].dispose();
      starField.dispose();
      pmrem.dispose();
      composer.dispose?.();
      renderer.dispose();
    },
  };
}
