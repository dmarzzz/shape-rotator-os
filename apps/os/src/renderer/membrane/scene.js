import * as THREE from 'three';
import { EffectComposer } from '../../vendor/three-jsm/postprocessing/EffectComposer.js';
import { RenderPass } from '../../vendor/three-jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../../vendor/three-jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../../vendor/three-jsm/postprocessing/OutputPass.js';
import { createPsyCube, BLOB_IDS, ALLOWED_FACES } from './cube.js';
import { createStarField } from './starfield.js';
import { getTheme } from '../theme.js';

// The cube is the centerpiece — it sits at the world origin (the camera's
// look-at point), dead center of the stage at every aspect ratio.
export const CUBE_SCALE = 0.42;

// Camera framing — exported so the easter-egg Rubik's cube can match the die's
// exact on-screen size (same fov + look-at distance → identical apparent size).
export const MEMBRANE_FOV = 38;
export const MEMBRANE_CAMERA_Z = 4.8;

export function createMembraneScene(canvas, opts = {}) {
  // Theme read once at mount. The toggle lives on the profile page, so
  // switching it leaves membrane mode (destroying this scene) and returning
  // remounts it — there's no live theme change while the scene is alive.
  const isLight = (opts.theme ?? getTheme()) === 'light';

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
  // No lights, no PMREM environment — the cube shader is unlit and the
  // starfield is additive points. (The blob cluster needed both; dropping
  // them cuts init cost and per-frame uniform uploads.)

  const cameraZ = MEMBRANE_CAMERA_Z;
  const fov = MEMBRANE_FOV;
  const camera = new THREE.PerspectiveCamera(fov, 1, 0.1, 100);
  camera.position.set(0, 0, cameraZ);
  camera.lookAt(0, 0, 0);

  // Post-processing — bloom on bright pixels (the cube's fresnel rim +
  // additive edge lines + stars at full brightness). Threshold means the
  // psychedelic body color doesn't bloom; only the intentional glow does.
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.45, 0.62);
  // Light mode: raise the threshold + drop strength so the vivid body and its
  // dark wireframe don't bloom into a milky wash over the white page. Dark mode
  // keeps the original cosmic glow.
  bloomPass.threshold = isLight ? 0.80 : 0.62;
  bloomPass.strength = isLight ? 0.24 : 0.44;
  bloomPass.radius = isLight ? 0.40 : 0.45;
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());

  const cube = createPsyCube({ isLight, initialFaces: opts.initialFaces });
  scene.add(cube.group);

  let activeId = 'self';
  let wiggleStart = null;

  function setActiveBlob(id) {
    if (!BLOB_IDS.includes(id)) return;
    activeId = id;
    cube.setDomain(id);
    wiggleStart = performance.now();
  }

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  // Nearest ray hit on the cube, or null. Carries the .face (with its
  // object-space normal) so the hover highlight can target one facet.
  function cubeIntersect(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObject(cube.mesh, false);
    return hits.length > 0 ? hits[0] : null;
  }

  function cubeHitAt(clientX, clientY) {
    return cubeIntersect(clientX, clientY) !== null;
  }

  // ─── drag-to-rotate ──────────────────────────────────────────────────
  // The cube is grabbable: drag anywhere on the canvas to spin it (screen
  // x → world yaw, screen y → world pitch, premultiplied so it always
  // tracks the screen no matter the cube's current orientation). Release
  // mid-swipe and it keeps the fling momentum, then eases back into the
  // slow idle tumble. A sub-threshold press still reads as a CLICK: on the
  // cube it morphs the die a face (left +1, right −1, d6↔d20); on the void
  // it toggles the panel.
  const ROT_PER_PX = 0.0055;          // rad of rotation per px of drag
  const DRAG_CLICK_PX = 4;            // movement under this = a click
  const FLING_MAX = 5.0;              // rad/s cap on release momentum
  const IDLE_RETURN_TAU = 2.5;        // s — momentum eases to idle tumble
  const IDLE_SPIN = new THREE.Vector3(0.12, 0.21, 0.05); // rad/s tumble
  const _ZERO = new THREE.Vector3(0, 0, 0);

  const spinVel = IDLE_SPIN.clone();  // current angular velocity (rad/s)
  const _dq = new THREE.Quaternion();
  const _axis = new THREE.Vector3();

  // Click the cube → it eases to a dead stop and stays there; dragging it
  // resumes motion (and the idle tumble afterward).
  let stopped = false;

  // Speed → brightness. We read the cube's ACTUAL per-frame rotation (so
  // both drag and fling count, and holding still reads as slow), then map
  // speed-above-idle into a 0..1 energy the shader turns into glow.
  const IDLE_SPEED = IDLE_SPIN.length();   // baseline tumble = "default"
  const ENERGY_SPAN = 3.0;                 // rad/s above idle → full blaze
  const _prevQuat = new THREE.Quaternion().copy(cube.group.quaternion);

  // Spin fast enough and the die morphs to the next shape. A hysteresis
  // latch means one change per fast burst (it must slow back down before it
  // can fire again), so you can land on a specific shape.
  const SHAPE_TRIGGER_SPEED = 2.5;  // rad/s — a deliberate whip
  const SHAPE_REARM_SPEED = 1.0;    // rad/s — must drop below this to re-arm
  const SHAPE_SUSTAIN_SEC = 0.5;    // must stay fast this long before it morphs
  let shapeArmed = true;
  let fastTime = 0;                 // seconds spent above the trigger speed

  // Easter egg: once every regular shape has been cycled through, the NEXT
  // fast-spin doesn't wrap back to the first shape — it reveals the Flashbots
  // Rubik's cube (rendered by an overlaid module; this scene just gates when).
  // Booting shows the last shape (d20), so showing all of them needs
  // ALLOWED_FACES.length - 1 more morphs; the morph after that triggers reveal.
  let morphsSinceCube = 0;
  let rubiksMode = false;           // the cube is showing; suppress die morphs

  function rotateBy(yawRad, pitchRad) {
    _dq.setFromAxisAngle(_axis.set(0, 1, 0), yawRad);
    cube.group.quaternion.premultiply(_dq);
    _dq.setFromAxisAngle(_axis.set(1, 0, 0), pitchRad);
    cube.group.quaternion.premultiply(_dq);
  }

  let dragging = false;
  let dragMoved = false;
  let downOnCube = false;
  let downButton = 0;
  let downX = 0, downY = 0;
  let lastX = 0, lastY = 0;
  let lastMoveMs = 0;
  let hovered = false;

  function handlePointerDown(ev) {
    dragging = true;
    dragMoved = false;
    downOnCube = cubeHitAt(ev.clientX, ev.clientY);
    downButton = ev.button;
    downX = lastX = ev.clientX;
    downY = lastY = ev.clientY;
    lastMoveMs = performance.now();
    canvas.setPointerCapture?.(ev.pointerId);
    canvas.style.cursor = 'grabbing';
  }

  function handlePointerMove(ev) {
    if (!dragging) {
      const hit = cubeIntersect(ev.clientX, ev.clientY);
      canvas.style.cursor = hit ? 'grab' : 'default';
      if (hit) {
        // Update every move so crossing from one face to the next re-targets
        // the highlight to the facet actually under the cursor.
        hovered = true;
        cube.setHovered(true, hit.face ? hit.face.normal : null);
      } else if (hovered) {
        hovered = false;
        cube.setHovered(false);
      }
      return;
    }
    const dx = ev.clientX - lastX;
    const dy = ev.clientY - lastY;
    lastX = ev.clientX;
    lastY = ev.clientY;
    if (!dragMoved
        && Math.abs(ev.clientX - downX) + Math.abs(ev.clientY - downY) > DRAG_CLICK_PX) {
      dragMoved = true;
      stopped = false; // dragging it brings it back to life
    }
    if (!dragMoved) return;
    rotateBy(dx * ROT_PER_PX, dy * ROT_PER_PX);
    // Track fling velocity from the instantaneous pointer speed (smoothed
    // so one jittery event doesn't dominate the release momentum).
    const nowMs = performance.now();
    const dtMove = Math.max(8, nowMs - lastMoveMs) / 1000;
    lastMoveMs = nowMs;
    spinVel.y += (dx * ROT_PER_PX / dtMove - spinVel.y) * 0.35;
    spinVel.x += (dy * ROT_PER_PX / dtMove - spinVel.x) * 0.35;
    spinVel.clampLength(0, FLING_MAX);
  }

  function handlePointerUp(ev) {
    if (!dragging) return;
    dragging = false;
    canvas.releasePointerCapture?.(ev.pointerId);
    canvas.style.cursor = downOnCube || cubeHitAt(ev.clientX, ev.clientY) ? 'grab' : 'default';
    if (dragMoved) {
      // Held still at the end of a drag → no fling, it just stays put.
      if (performance.now() - lastMoveMs > 80) spinVel.set(0, 0, spinVel.z);
      return;
    }
    // No movement → a click. On the cube: stop it dead instantly (clicking
    // an already-stopped cube does nothing). On the void: toggle the panel.
    if (downOnCube) {
      spinVel.set(0, 0, 0);
      stopped = true;
    } else if (opts.onEmptyClick) {
      opts.onEmptyClick();
    }
  }

  // Swallow the OS context menu on the canvas (right-click is unused).
  function handleContextMenu(ev) { ev.preventDefault(); }

  canvas.addEventListener('pointerdown', handlePointerDown);
  canvas.addEventListener('pointermove', handlePointerMove);
  canvas.addEventListener('pointerup', handlePointerUp);
  canvas.addEventListener('pointercancel', handlePointerUp);
  canvas.addEventListener('contextmenu', handleContextMenu);

  // 3D star field — point cloud + nebula mist flowing toward camera.
  const starField = createStarField({ scene, camera, isLight });

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
  }

  // Integrate the angular velocity. While the user drags, pointermove
  // applies rotation directly; afterwards this carries the fling momentum
  // and eases it back toward the slow idle tumble (mutually irrational-ish
  // axis rates so the resting spin never visibly repeats).
  function tickMotion(time, nowMs, dt) {
    if (!dragging) {
      rotateBy(spinVel.y * dt, spinVel.x * dt);
      _dq.setFromAxisAngle(_axis.set(0, 0, 1), spinVel.z * dt);
      cube.group.quaternion.premultiply(_dq);
      // While stopped, hold at zero (click zeroed it instantly). Otherwise
      // fling momentum eases back into the slow idle tumble.
      const target = stopped ? _ZERO : IDLE_SPIN;
      spinVel.lerp(target, 1 - Math.exp(-dt / IDLE_RETURN_TAU));
    }

    let s = CUBE_SCALE * (1 + Math.sin(time * 0.6) * 0.018);
    if (wiggleStart) {
      const dt = (nowMs - wiggleStart) / 400;
      if (dt < 1) {
        s *= 1 + Math.sin(dt * Math.PI * 3) * 0.04 * (1 - dt);
      } else {
        wiggleStart = null;
      }
    }
    cube.group.scale.setScalar(s);
  }

  // Barely-there camera sway. A slow Lissajous on x/y plus a gentle dolly on
  // z makes the parallax between star strata felt even when the user is idle.
  // Amplitudes are a few hundredths of a world unit so it never reads as
  // movement, only as life. Periods are mutually irrational-ish so the path
  // never visibly repeats.
  const SWAY = {
    ax: 0.045, ay: 0.030, az: 0.025,   // amplitudes (world units)
    fx: 0.037, fy: 0.053, fz: 0.021,   // frequencies (Hz-ish)
  };

  function tick() {
    if (!running) return;
    const nowMs = performance.now();
    const time = (nowMs - startMs) / 1000;
    // Clamp dt so a throttled/backgrounded frame can't blow up the physics
    // (a huge dt would rotate wildly and instantly decay the spin momentum).
    const dt = lastTickSeconds === 0 ? 0.016 : Math.min(0.05, time - lastTickSeconds);
    lastTickSeconds = time;
    tickMotion(time, nowMs, dt);

    // Measure the cube's actual rotation this frame → speed → brightness.
    // Captures drag, fling, and idle alike; holding still reads as slow.
    const speed = cube.group.quaternion.angleTo(_prevQuat) / Math.max(dt, 1e-4);
    _prevQuat.copy(cube.group.quaternion);
    cube.setEnergy((speed - IDLE_SPEED) / ENERGY_SPAN);

    // Sustained fast spin morphs the die to the next shape: it must stay
    // above the trigger speed for SHAPE_SUSTAIN_SEC, then fires once (one
    // per fast burst — it must slow back down past the re-arm speed before
    // it can fire again). Uses the angular VELOCITY, frame-rate independent.
    // While the Rubik's cube is revealed it owns its own spin gesture (the
    // overlaid module fires onCycleAway), so the die morph is suppressed here.
    const spinSpeed = rubiksMode ? 0 : spinVel.length();
    fastTime = spinSpeed > SHAPE_TRIGGER_SPEED ? fastTime + dt : 0;
    if (shapeArmed && fastTime >= SHAPE_SUSTAIN_SEC) {
      if (morphsSinceCube >= ALLOWED_FACES.length - 1) {
        // Every shape has been seen — reveal the easter-egg cube instead of
        // wrapping. Hide the die mesh but keep this canvas rendering: the
        // starfield stays on screen, showing through behind the Rubik's overlay.
        rubiksMode = true;
        cube.group.visible = false;
        shapeArmed = false;
        fastTime = 0;
        opts.onRubiksReveal?.();
      } else {
        const newCount = cube.cycleFaces(-1);
        wiggleStart = nowMs;
        if (newCount != null) {
          morphsSinceCube += 1;
          if (opts.onFacesChange) opts.onFacesChange(newCount);
        }
        shapeArmed = false;
        fastTime = 0;
      }
    } else if (!shapeArmed && spinSpeed < SHAPE_REARM_SPEED) {
      shapeArmed = true;
    }

    cube.tick(time);

    // Idle camera sway around the base position. Re-look at origin so the
    // cube stays anchored while the starfield parallax shifts behind it.
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
  cube.group.scale.setScalar(CUBE_SCALE);
  tick();

  return {
    scene,
    camera,
    renderer,
    setActiveBlob,
    getActiveBlobId: () => activeId,
    getFaces: () => cube.getFaces(),
    // Called when the user spins the revealed Rubik's cube away: the die
    // resumes the regular cycle, morphing one step on into the next shape.
    resumeFromRubiks() {
      if (!rubiksMode) return;
      rubiksMode = false;
      cube.group.visible = true;   // die mesh returns as the cube is dismissed
      morphsSinceCube = 0;
      shapeArmed = false;
      fastTime = 0;
      const newCount = cube.cycleFaces(-1);
      wiggleStart = performance.now();
      if (newCount != null && opts.onFacesChange) opts.onFacesChange(newCount);
    },
    destroy() {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('pointermove', handlePointerMove);
      canvas.removeEventListener('pointerup', handlePointerUp);
      canvas.removeEventListener('pointercancel', handlePointerUp);
      canvas.removeEventListener('contextmenu', handleContextMenu);
      cube.dispose();
      starField.dispose();
      composer.dispose?.();
      renderer.dispose();
    },
  };
}
