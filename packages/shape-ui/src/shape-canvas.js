// shape-canvas.js — WebGL2 renderer for the cohort shapes.
//
// Each visible shape gets its own <canvas> + WebGL2 context running a
// single shared fragment shader. The fragment shader draws a different
// signed-distance-field (SDF) per shape family and modulates colour by
// hash-of-record-id, so every team gets a unique-but-stable palette.
//
// Browsers cap active WebGL contexts (~16). To stay safe:
//   - mountShape returns a controller with .destroy() that loses the
//     context; alchemy.js calls this on every canvas re-render.
//   - We attach an IntersectionObserver per canvas that pauses the
//     animation loop when the shape scrolls offscreen. The context
//     stays alive (cheap), but rAF stops (saves GPU).
//
// API extension hooks (so we can add detail as the program evolves):
//   - opts.progress (0..1)        — drives shape complexity / inner detail
//   - opts.intensity (0..1)       — modulates glow + accent strength
//   - opts.rotationPhase (0..1)   — for mid-rotation morph between shapes
// Currently each defaults to a sane base; the shader already accepts the
// uniforms so future updates just need to pass them in.

const VERT_SRC = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform float u_time;
uniform float u_family;        // 0=torus→cylinder · 1=scaffold→cube · 2=hex→hex-prism · 5=prism→octahedron
uniform float u_kind;          // 0=team · 1=project (stitched rim) · 2=person (sphere medallion)
uniform float u_hue;           // 0..1 primary hue, hash-derived
uniform float u_hue2;          // 0..1 accent hue, hash-derived
uniform float u_phase;         // 0..1 per-team motion + composition offset
uniform float u_progress;      // reserved (unused — kept for controller API parity)
uniform float u_intensity;     // reserved
uniform float u_rotationPhase; // reserved
uniform float u_aspect;
uniform float u_scale;         // 1.0 = base size; >1 enlarges the whole shape
uniform float u_manual;        // 1 = use u_rot (drag-to-spin); 0 = auto-tumble
uniform mat3  u_rot;           // caller-supplied orientation when u_manual=1

// ── palette ─────────────────────────────────────────────────────────────
// iquilezles cosine palette — a full-saturation rainbow. The kaleidoscope
// surface and the iridescent rim both ride this so every "alive" element
// drifts through one coherent spectrum. https://iquilezles.org/articles/palettes/
vec3 iqPal(float t){ return 0.5 + 0.5*cos(6.28318*(vec3(1.0)*t + vec3(0.00,0.33,0.67))); }
vec3 rainbow(float h){ return iqPal(h); }

// Charcoal shape interior — stays constant on either theme so the additive
// colour layers read vivid (matches the old 2D shapes' K_CANVAS).
const vec3 K_CANVAS = vec3(0.137, 0.121, 0.125);

// ── 3D rotation ─────────────────────────────────────────────────────────
mat3 rotY(float a){ float s=sin(a), c=cos(a); return mat3(c,0.0,s, 0.0,1.0,0.0, -s,0.0,c); }
mat3 rotX(float a){ float s=sin(a), c=cos(a); return mat3(1.0,0.0,0.0, 0.0,c,-s, 0.0,s,c); }

// ── 3D SDFs (negative inside) ───────────────────────────────────────────
// One solid per family, sized so each silhouette still reads as the 2D
// family it replaces and matched to the membrane's shape language:
// TORUS→cylinder · SCAFFOLD→cube · HEX→hexagonal prism · PLATE→pyramid ·
// MERIDIAN→half cylinder · PRISM→octahedron · person→sphere.
float sdSphere(vec3 p, float r){ return length(p) - r; }
float sdBox(vec3 p, vec3 b){ vec3 q = abs(p) - b; return length(max(q,0.0)) + min(max(q.x,max(q.y,q.z)),0.0); }
float sdCylinder(vec3 p, float r, float h){ vec2 d = abs(vec2(length(p.xz), p.y)) - vec2(r,h); return min(max(d.x,d.y),0.0) + length(max(d,0.0)); }
float sdHexPrism(vec3 p, vec2 h){
  const vec3 k = vec3(-0.8660254, 0.5, 0.57735);
  p = abs(p);
  p.xy -= 2.0*min(dot(k.xy, p.xy), 0.0)*k.xy;
  vec2 d = vec2(length(p.xy - vec2(clamp(p.x, -k.z*h.x, k.z*h.x), h.x))*sign(p.y - h.x), p.z - h.y);
  return min(max(d.x,d.y),0.0) + length(max(d,0.0));
}
float sdOcta(vec3 p, float s){ p = abs(p); return (p.x + p.y + p.z - s)*0.57735027; }
// PLATE — regular tetrahedron (a 4-faced pyramid). Four half-space planes.
float sdTetra(vec3 p, float s){
  float d = max(max(-p.x-p.y-p.z, p.x+p.y-p.z), max(-p.x+p.y+p.z, p.x-p.y+p.z));
  return (d - s)*0.57735027;
}
// MERIDIAN — half a cylinder: the round cylinder sliced through its axis (keep z >= 0).
float sdHalfCylinder(vec3 p, float r, float h){ return max(sdCylinder(p, r, h), -p.z); }

// Outer solid per family. PERSON (kind 2) is always a sphere medallion,
// regardless of family — individuals don't carry the shape vocabulary.
float mapFam(vec3 p, int fam, int kind){
  if (kind == 2) return sdSphere(p, 0.62);            // PERSON — sphere
  if (fam == 0)  return sdCylinder(p, 0.5, 0.52);     // TORUS — cylinder
  if (fam == 1)  return sdBox(p, vec3(0.46));         // SCAFFOLD — cube
  if (fam == 2)  return sdHexPrism(p, vec2(0.52,0.5));// HEX — hexagonal prism
  if (fam == 3)  return sdTetra(p, 0.95);            // PLATE — pyramid (tetrahedron)
  if (fam == 4)  return sdHalfCylinder(p, 0.5, 0.52);// MERIDIAN — half cylinder
  return sdOcta(p, 0.78);                             // PRISM (fam 5) — octahedron
}

// Rotated field + its gradient. R is orthonormal, so M = transpose(R) maps a
// world point into object space; the gradient of mapFam(M*p) is the WORLD
// normal (used for lighting), and M*world == object normal (triplanar).
float mapR(vec3 p, mat3 M, int fam, int kind){ return mapFam(M*p, fam, kind); }
vec3 calcNormal(vec3 p, mat3 M, int fam, int kind){
  vec2 e = vec2(0.0012, 0.0);
  return normalize(vec3(
    mapR(p+e.xyy, M, fam, kind) - mapR(p-e.xyy, M, fam, kind),
    mapR(p+e.yxy, M, fam, kind) - mapR(p-e.yxy, M, fam, kind),
    mapR(p+e.yyx, M, fam, kind) - mapR(p-e.yyx, M, fam, kind)));
}

// ── kishimisu kaleidoscope, wrapped onto the 3D surface ─────────────────
// The same iterative space-fold the old 2D shapes used, now evaluated on the
// object-space hit point via triplanar projection so the fractal churns
// across the solid and rotates with it instead of facing the camera.
vec3 fractal2D(vec2 fp0, float t, float hue){
  vec2 fp = fp0;
  vec3 col = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    fp = fract(fp*1.5) - 0.5;
    float d = length(fp)*exp(-length(fp0));
    vec3  c = iqPal(length(fp0)*1.2 + float(i)*0.55 + hue);
    d = abs(sin(d*8.0 + t*1.6)/8.0);
    d = pow(0.01/d, 1.2);
    col += c*d;
  }
  return col*0.92;
}
vec3 kaleido(vec3 op, vec3 no, float t, float hue){
  vec3 w = pow(abs(no), vec3(4.0));
  w /= (w.x + w.y + w.z + 1e-5);
  float s = 1.7;
  return fractal2D(op.yz*s, t, hue)*w.x
       + fractal2D(op.xz*s, t, hue)*w.y
       + fractal2D(op.xy*s, t, hue)*w.z;
}

void main(){
  vec2 uv = (v_uv*2.0 - 1.0) / u_scale;   // u_scale > 1 enlarges the shape
  uv.x *= u_aspect;

  int fam  = int(u_family + 0.5);
  int kind = int(u_kind + 0.5);
  float t  = u_time + u_phase*6.2831;

  // Rotation: u_manual>0.5 → caller-driven orientation (drag-to-spin on the
  // detail page); otherwise the slow auto-tumble that echoes the membrane.
  mat3 R;
  if (u_manual > 0.5) { R = u_rot; }
  else { R = rotY(t*0.26) * rotX(0.42 + sin(t*0.13)*0.20); }
  mat3 M = transpose(R);                  // world → object (R orthonormal)

  vec3 ro = vec3(0.0, 0.0, 3.0);
  vec3 rd = normalize(vec3(uv, -2.5));

  // Sphere-trace the rotated solid. Convex shapes converge quickly.
  float tt = 0.0; bool hit = false; vec3 p = ro;
  for (int i = 0; i < 64; i++) {
    p = ro + rd*tt;
    float d = mapR(p, M, fam, kind);
    if (d < 0.0015) { hit = true; break; }
    tt += d;
    if (tt > 5.0) break;
  }
  // Outside the solid stays fully transparent so the shape floats directly
  // on the card background (no box), exactly like the old silhouette pass.
  if (!hit) discard;

  vec3 n  = calcNormal(p, M, fam, kind);  // world-space normal (lighting)
  vec3 op = M*p;                          // object-space hit point (texture)
  vec3 no = M*n;                          // object-space normal (triplanar weights)

  vec3  viewDir  = -rd;
  vec3  lightDir = normalize(vec3(0.5, 0.7, 0.5));
  float diff = clamp(dot(n, lightDir), 0.0, 1.0);
  float amb  = 0.35 + 0.25*n.y;
  vec3  hlf  = normalize(lightDir + viewDir);
  float spec = pow(clamp(dot(n, hlf), 0.0, 1.0), 40.0);
  float fres = pow(1.0 - clamp(dot(n, viewDir), 0.0, 1.0), 3.0);

  // Kaleidoscope albedo, lit for depth.
  vec3 kal = kaleido(op, no, t, u_hue + t*0.18);
  vec3 col = K_CANVAS*0.4;
  col += kal*1.05;
  col *= (amb + 0.85*diff);

  // ── iridescent rim — fresnel band in the rainbow palette, echoing both the
  // old card rim and the membrane's bloom rim. PROJECT (kind 1) gets a
  // STITCHED rim (24 dashes around the screen angle) so it still reads as the
  // dashed/blueprint project treatment; TEAM + PERSON keep it solid.
  float rimMask = 1.0;
  if (kind == 1) {
    float ang = atan(uv.y, uv.x);
    rimMask = step(0.55, fract(ang/6.28318 * 24.0));
  }
  vec3 rimC = rainbow(u_hue + t*0.18 + u_phase);
  col += rimC * fres * 0.95 * rimMask;
  col += rainbow(u_hue2 + t*0.05) * fres * 0.40 * rimMask;
  col += vec3(1.0) * spec * 0.55;

  // Subtle film grain so the body doesn't read as flat digital.
  col += (fract(sin(dot(v_uv, vec2(12.9898, 78.233)))*43758.5453) - 0.5) * 0.018;

  outColor = vec4(col, 1.0);
}
`;

// ── shared GL program (per <canvas> we still need a fresh context, but
// the shader source is reused so compile cost is amortised by the GPU).

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shape-ui shader compile failed: ${log}`);
  }
  return sh;
}

function buildProgram(gl) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`shape-ui program link failed: ${log}`);
  }
  // Fullscreen quad (two triangles).
  const verts = new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "a_pos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  return {
    prog,
    uniforms: {
      time:          gl.getUniformLocation(prog, "u_time"),
      family:        gl.getUniformLocation(prog, "u_family"),
      kind:          gl.getUniformLocation(prog, "u_kind"),
      hue:           gl.getUniformLocation(prog, "u_hue"),
      hue2:          gl.getUniformLocation(prog, "u_hue2"),
      phase:         gl.getUniformLocation(prog, "u_phase"),
      progress:      gl.getUniformLocation(prog, "u_progress"),
      intensity:     gl.getUniformLocation(prog, "u_intensity"),
      rotationPhase: gl.getUniformLocation(prog, "u_rotationPhase"),
      aspect:        gl.getUniformLocation(prog, "u_aspect"),
      scale:         gl.getUniformLocation(prog, "u_scale"),
    },
  };
}

// ── hash helpers ────────────────────────────────────────────────────────
// FNV-1a over the record_id (or any string). Returns three numbers in
// [0,1) — primary hue, accent hue, animation phase — so two teams with
// different ids get visually distinct shapes deterministically.
export function hashColors(seed) {
  let h = 2166136261 >>> 0;
  const s = String(seed || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  // Pull three independent 8-bit slices.
  const a =  h         & 0xff;
  const b = (h >>> 8)  & 0xff;
  const c = (h >>> 16) & 0xff;
  return {
    hue:   a / 255,
    hue2: (a / 255 + 0.33 + (b / 255) * 0.34) % 1, // analogous-to-complementary offset
    phase: c / 255,
  };
}

// ── public mount API ────────────────────────────────────────────────────
// canvas: an HTMLCanvasElement already in the DOM.
// opts.family:  0..5
// opts.seed:    string (e.g. record_id) — drives colour + phase
// opts.size:    optional CSS px (square); defaults to canvas.clientWidth
// opts.progress / .intensity / .rotationPhase: optional 0..1 reserved
// returns { destroy(), update(opts), pause(), resume() }
export function mountShape(canvas, opts = {}) {
  const gl = canvas.getContext("webgl2", { antialias: true, alpha: false, premultipliedAlpha: false });
  if (!gl) {
    return { destroy() {}, update() {}, pause() {}, resume() {} };
  }
  let prog;
  try { prog = buildProgram(gl); }
  catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[shape-ui]", e.message);
    return { destroy() {}, update() {}, pause() {}, resume() {} };
  }

  const colors = hashColors(opts.seed);
  let family        = Number(opts.family) || 0;
  let progress      = opts.progress      != null ? +opts.progress      : 0.25;
  let intensity     = opts.intensity     != null ? +opts.intensity     : 0.6;
  let rotationPhase = opts.rotationPhase != null ? +opts.rotationPhase : 0;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  function resize() {
    const cssW = canvas.clientWidth  || 120;
    const cssH = canvas.clientHeight || 120;
    canvas.width  = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  resize();
  const ro = (typeof ResizeObserver !== "undefined") ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(canvas);

  let raf = 0;
  let running = true;
  let started = performance.now();
  function frame(now) {
    if (!running) { raf = 0; return; }
    const t = (now - started) / 1000;
    gl.useProgram(prog.prog);
    gl.uniform1f(prog.uniforms.time, t);
    gl.uniform1f(prog.uniforms.family, family);
    gl.uniform1f(prog.uniforms.hue, colors.hue);
    gl.uniform1f(prog.uniforms.hue2, colors.hue2);
    gl.uniform1f(prog.uniforms.phase, colors.phase);
    gl.uniform1f(prog.uniforms.progress, progress);
    gl.uniform1f(prog.uniforms.intensity, intensity);
    gl.uniform1f(prog.uniforms.rotationPhase, rotationPhase);
    gl.uniform1f(prog.uniforms.aspect, canvas.width / canvas.height);
    gl.uniform1f(prog.uniforms.scale, opts.scale != null ? +opts.scale : 1.0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    raf = requestAnimationFrame(frame);
  }
  function pause() { if (!running) return; running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }
  function resume() { if (running) return; running = true; started = performance.now(); raf = requestAnimationFrame(frame); }

  // Pause when the canvas isn't visible to keep the GPU calm.
  let io = null;
  if (typeof IntersectionObserver !== "undefined") {
    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) resume();
        else pause();
      }
    });
    io.observe(canvas);
  }

  raf = requestAnimationFrame(frame);

  return {
    destroy() {
      pause();
      if (ro) try { ro.disconnect(); } catch {}
      if (io) try { io.disconnect(); } catch {}
      // Free the WebGL context proactively so we don't bump the per-page cap.
      const lose = gl.getExtension("WEBGL_lose_context");
      if (lose) try { lose.loseContext(); } catch {}
    },
    update(next = {}) {
      if (next.family       != null) family        = Number(next.family) || 0;
      if (next.progress     != null) progress      = +next.progress;
      if (next.intensity    != null) intensity     = +next.intensity;
      if (next.rotationPhase != null) rotationPhase = +next.rotationPhase;
    },
    pause,
    resume,
  };
}

// ── shared overlay (one GL context, N shapes) ───────────────────────────
// Browsers cap us to ~16 active WebGL contexts. We mount ONE canvas
// at position:fixed covering the full viewport, and draw every visible
// shape into that single context via gl.viewport + gl.scissor. Each
// per-card `<canvas data-shape-fam>` is a no-context layout placeholder.
//
// position:fixed (rather than absolute inside the alchemy host) is
// deliberate: the host scrolls internally, so an absolute-positioned
// overlay would scroll WITH the content and only cover the first
// viewport-height of scroll — anything past row 1 would be clipped.
// Fixed-positioning sidesteps that entirely; getBoundingClientRect
// gives viewport-relative coords on every frame, which is exactly
// what the fixed overlay's coordinate system uses.
//
// The overlay element only paints inside each placeholder's rect
// (via scissor); the rest of the canvas is transparent + has
// pointer-events:none so it's invisible over UI chrome. The overlay
// is auto-hidden on non-alchemy tabs via the `.alchemy-only` class
// (relies on the existing tab visibility CSS in styles.css).
export function mountShapesIn(container) {
  if (!container) return [];
  // Single overlay shared across the whole document — re-uses the same
  // canvas element across renders so we don't churn GL contexts.
  let overlay = document.querySelector("body > canvas.alch-shape-overlay");
  if (!overlay) {
    overlay = document.createElement("canvas");
    overlay.className = "alch-shape-overlay alchemy-only";
    // z-index sits above the tab content (#network-view / #atlas-view /
    // alchemy host all use z:3) but BELOW the blank-tab cover (z:5),
    // the tab bar (z:6) and any modals (z:99+). pointer-events:none so
    // the canvas is invisible to mouse hits — clicks fall through to
    // the cards underneath.
    overlay.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:4;";
    document.body.appendChild(overlay);
  } else {
    overlay.style.zIndex = "4";  // re-mounts inherit the corrected stacking
  }
  const ctrl = mountSharedOverlay(overlay);
  return [ctrl];
}

function mountSharedOverlay(overlay) {
  const gl = overlay.getContext("webgl2", { antialias: true, alpha: true, premultipliedAlpha: false });
  if (!gl) return { destroy() {} };
  let prog;
  try { prog = buildProgram(gl); }
  catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[shape-ui]", e.message);
    return { destroy() {} };
  }
  gl.enable(gl.SCISSOR_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  function resize() {
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    overlay.width  = Math.max(1, Math.round(cssW * dpr));
    overlay.height = Math.max(1, Math.round(cssH * dpr));
  }
  resize();
  window.addEventListener("resize", resize);

  let raf = 0;
  let running = true;
  let started = performance.now();

  // Per-frame DOM query — cheap for tens of shapes, and re-querying
  // catches DOM mutations without needing a MutationObserver.
  //
  // CLIP CHAIN: the fixed overlay opted out of normal DOM clipping, so a
  // shape scrolled past its host's edge kept painting — over sticky bars
  // and tab chrome. Each placeholder's scrolling ancestors (computed
  // overflow other than visible) are cached per element; per frame the
  // draw rect is intersected with their rects, re-imposing exactly the
  // clipping the placeholder itself gets from the DOM. Sticky chrome that
  // floats over the content marks itself with data-shape-occluder and
  // clips the covered edge.
  const _clipChains = new WeakMap();
  function clipChainFor(el) {
    let chain = _clipChains.get(el);
    if (chain) return chain;
    chain = [];
    let node = el.parentElement;
    while (node && node !== document.documentElement && node !== document.body) {
      const cs = getComputedStyle(node);
      if (cs.overflowX !== "visible" || cs.overflowY !== "visible") chain.push(node);
      node = node.parentElement;
    }
    _clipChains.set(el, chain);
    return chain;
  }
  function placeholderList() {
    const out = [];
    for (const el of document.querySelectorAll("canvas[data-shape-fam]")) {
      if (el === overlay) continue;
      // data-shape-kind: "team" | "project" | "person" → 0|1|2 uniform
      const kindStr = el.dataset.shapeKind || "team";
      const kind = kindStr === "person" ? 2 : kindStr === "project" ? 1 : 0;
      out.push({
        el,
        family: Number(el.dataset.shapeFam) || 0,
        kind,
        scale: Number(el.dataset.shapeScale) || 1,
        colors: hashColors(el.dataset.shapeSeed || ""),
        clips: clipChainFor(el),
      });
    }
    return out;
  }

  function frame(now) {
    if (!running) { raf = 0; return; }
    const t = (now - started) / 1000;
    gl.viewport(0, 0, overlay.width, overlay.height);
    gl.scissor(0, 0, overlay.width, overlay.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(prog.prog);

    // One rect read per clip/occluder element per frame, shared across
    // placeholders (the whole grid shares the same scroll host).
    const rectCache = new Map();
    const rectOf = (el) => {
      let r = rectCache.get(el);
      if (!r) { r = el.getBoundingClientRect(); rectCache.set(el, r); }
      return r;
    };
    const occluders = document.querySelectorAll("[data-shape-occluder]");

    for (const p of placeholderList()) {
      if (!p.el.isConnected) continue;
      // Don't draw if the placeholder is hidden via display:none (the
      // ancestors' getBoundingClientRect comes back zero).
      const r = p.el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      // Visible region = placeholder rect ∩ every scrolling ancestor —
      // the same clip the DOM applies to the placeholder itself.
      let cL = r.left, cT = r.top, cR = r.right, cB = r.bottom;
      for (const clipEl of p.clips) {
        const cr = rectOf(clipEl);
        if (cr.left   > cL) cL = cr.left;
        if (cr.top    > cT) cT = cr.top;
        if (cr.right  < cR) cR = cr.right;
        if (cr.bottom < cB) cB = cr.bottom;
      }
      // Sticky chrome (data-shape-occluder) floats over the content; clip
      // the covered edge so the shape passes UNDER the glass, not over it.
      const edgeSnapPx = 6;
      for (const o of occluders) {
        if (!o.isConnected) continue;
        const or = rectOf(o);
        if (or.right <= cL || or.left >= cR || or.bottom <= cT || or.top >= cB) continue;
        const coversTopEdge = or.top <= cT + edgeSnapPx;
        const coversBottomEdge = or.bottom >= cB - edgeSnapPx;
        if (coversTopEdge && or.bottom >= cB) { cT = cB; break; }  // fully covered
        if (coversTopEdge) cT = or.bottom;                         // covers top edge
        else if (coversBottomEdge) cB = or.top;                    // covers bottom edge
        // mid-rect occluders can't be one scissor rect — leave those alone
      }
      if (cR - cL < 1 || cB - cT < 1) continue;
      // viewport coord system is bottom-left origin in CSS pixels; the
      // overlay covers the whole window so getBoundingClientRect (which
      // is also viewport-relative) maps 1:1. The VIEWPORT keeps the full
      // placeholder rect (it defines the shader's coordinate frame); the
      // SCISSOR shrinks to the visible region so clipped pixels never land.
      const x  = Math.round(r.left * dpr);
      const yT = Math.round(r.top  * dpr);
      const w  = Math.max(1, Math.round(r.width  * dpr));
      const h  = Math.max(1, Math.round(r.height * dpr));
      const yB = overlay.height - yT - h;
      const sx  = Math.round(cL * dpr);
      const syT = Math.round(cT * dpr);
      const sw  = Math.max(1, Math.round((cR - cL) * dpr));
      const sh  = Math.max(1, Math.round((cB - cT) * dpr));
      const syB = overlay.height - syT - sh;
      // Cull rects whose visible region falls entirely outside the window.
      if (sx + sw < 0 || syB + sh < 0 || sx >= overlay.width || syB >= overlay.height) continue;
      gl.viewport(x, yB, w, h);
      gl.scissor(sx, syB, sw, sh);
      gl.uniform1f(prog.uniforms.time, t);
      gl.uniform1f(prog.uniforms.family, p.family);
      gl.uniform1f(prog.uniforms.kind, p.kind);
      gl.uniform1f(prog.uniforms.hue, p.colors.hue);
      gl.uniform1f(prog.uniforms.hue2, p.colors.hue2);
      gl.uniform1f(prog.uniforms.phase, p.colors.phase);
      gl.uniform1f(prog.uniforms.progress, 0.25);
      gl.uniform1f(prog.uniforms.intensity, 0.6);
      gl.uniform1f(prog.uniforms.rotationPhase, 0);
      gl.uniform1f(prog.uniforms.aspect, w / h);
      gl.uniform1f(prog.uniforms.scale, p.scale);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    raf = requestAnimationFrame(frame);
  }
  function pause() { if (!running) return; running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }
  function resume() { if (running) return; running = true; started = performance.now(); raf = requestAnimationFrame(frame); }

  raf = requestAnimationFrame(frame);

  return {
    destroy() {
      pause();
      window.removeEventListener("resize", resize);
      const lose = gl.getExtension("WEBGL_lose_context");
      if (lose) try { lose.loseContext(); } catch {}
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    },
    pause,
    resume,
  };
}
