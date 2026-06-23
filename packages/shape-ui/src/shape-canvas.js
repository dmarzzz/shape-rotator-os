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
uniform vec3  u_bg;            // custom orb CANVAS/background colour (rgb 0..1), full strength
uniform float u_bg_on;         // 1 = replace the dark canvas with u_bg; 0 = default charcoal
uniform float u_bg_mix;        // Orb Core "amount" — how far the orb tints toward u_bg (0..1)
uniform float u_warp;          // 0..1 "Fracture Field" — swirls the fractal lattice each fold
uniform float u_iters;         // 0..1 "Strata" — number of fractal layers (1..6; default 0.3 → 3)
uniform float u_sharp;         // 0..1 "Filament" — line sharpness/thickness (default 0.333 → 1.2)
uniform float u_blend;         // custom-shader EMA factor (output alpha); 1.0 = no smoothing

// ── palette ─────────────────────────────────────────────────────────────
// iquilezles cosine palette — a full-saturation rainbow. The kaleidoscope
// surface and the iridescent rim both ride this so every "alive" element
// drifts through one coherent spectrum. https://iquilezles.org/articles/palettes/
vec3 iqPal(float t){ return 0.5 + 0.5*cos(6.28318*(vec3(1.0)*t + vec3(0.00,0.33,0.67))); }
vec3 rainbow(float h){ return iqPal(h); }

// ── bounded builtins available to user-authored shader expressions ──────────
// (referenced by the safe DSL; the standard shader ignores them. fbm's loop is
//  FIXED so a user calling it can't change its cost.)
vec3 pal(float x){ return iqPal(x); }
vec3 hsv(vec3 c){ vec3 k=vec3(1.0,0.6666667,0.3333333); vec3 q=abs(fract(c.xxx+k)*6.0-3.0); return c.z*mix(vec3(1.0), clamp(q-1.0,0.0,1.0), c.y); }
float _hash21(vec2 q){ return fract(sin(dot(q, vec2(127.1,311.7)))*43758.5453123); }
float noise(vec2 q){ vec2 ip=floor(q), f=fract(q); f=f*f*(3.0-2.0*f);
  float a=_hash21(ip), b=_hash21(ip+vec2(1.0,0.0)), c=_hash21(ip+vec2(0.0,1.0)), d=_hash21(ip+vec2(1.0,1.0));
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y); }
float fbm(vec2 q){ float s=0.0, a=0.5; for(int i=0;i<4;i++){ s+=a*noise(q); q*=2.02; a*=0.5; } return s; }

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
  // u_warp ("Vortex") applies multi-octave domain-warp TURBULENCE to the fold
  // space — layered sine octaves churn/billow the lattice into chaotic, organic
  // distortion (not a smooth spin). 0 = none.
  // u_iters ("Strata") = fractal layer count (1..6); u_sharp ("Filament") = line
  // sharpness via the falloff exponent. Defaults (0.3 / 0.333) reproduce the
  // original 3 layers / 1.2 exponent so uncustomized orbs are unchanged.
  int n = int(clamp(floor(u_iters*5.0 + 1.5), 1.0, 6.0));
  float sharpExp = mix(0.7, 2.2, u_sharp);
  for (int i = 0; i < 6; i++) {
    if (i >= n) break;
    // Multi-octave turbulence: displace the fold coords by layered sine octaves.
    vec2 turb = sin(fp.yx * 2.5 + t * 0.25)
              + 0.5  * sin(fp.yx * 5.7 - t * 0.18)
              + 0.25 * sin(fp.yx * 11.3 + 2.1);
    fp += u_warp * 0.35 * turb;
    fp = fract(fp*1.5) - 0.5;
    float d = length(fp)*exp(-length(fp0));
    vec3  c = iqPal(length(fp0)*1.2 + float(i)*0.55 + hue);
    d = abs(sin(d*8.0 + t*1.6)/8.0);
    d = pow(0.01/d, sharpExp);
    col += c*d;
  }
  return col*0.92;
}
vec3 kaleido(vec3 op, vec3 no, float t, float hue){
  vec3 w = pow(abs(no), vec3(4.0));
  w /= (w.x + w.y + w.z + 1e-5);
  // u_progress dials kaleidoscope density ("recursion depth"), widened for a
  // dramatic range. Piecewise so the default 0.25 still yields 1.7 (the original
  // value → un-customized shapes unchanged); →0 coarsens hard, →1 packs dense.
  float s = (u_progress < 0.25)
    ? mix(0.6, 1.7, u_progress / 0.25)
    : mix(1.7, 6.0, (u_progress - 0.25) / 0.75);
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
  // Outside the solid stays fully transparent so the orb floats directly on the
  // page / card background — there is NEVER a box or fill behind it.
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
  // u_bg (when u_bg_on) REPLACES the orb's dark canvas/background colour at FULL
  // strength, so the whole orb body reads as that colour and the kaleidoscope
  // rides on top. Default keeps the original near-black charcoal (K_CANVAS*0.4)
  // so uncustomized orbs are unchanged. (Multiplying the chosen colour by 0.4 was
  // the bug — it made it a faint highlight instead of the actual background.)
  vec3 col = (u_bg_on > 0.5) ? u_bg : K_CANVAS*0.4;
  col += kal*1.05;
  col *= (amb + 0.85*diff);
  // Orb Core "presence": pull the WHOLE orb toward the chosen colour so the hue
  // pervades the entire surface (shadowed areas too, not just the lit top). The
  // weight is 0 when no core is set, so uncustomized orbs are unchanged. Raise the
  // 0.45 for an even stronger tint.
  col = mix(col, u_bg, u_bg_on * u_bg_mix);

  // ── iridescent rim — fresnel band in the rainbow palette, echoing both the
  // old card rim and the membrane's bloom rim. PROJECT (kind 1) gets a
  // STITCHED rim (24 dashes around the screen angle) so it still reads as the
  // dashed/blueprint project treatment; TEAM + PERSON keep it solid.
  float rimMask = 1.0;
  if (kind == 1) {
    float ang = atan(uv.y, uv.x);
    rimMask = step(0.55, fract(ang/6.28318 * 24.0));
  }
  // u_intensity dials the rim + spec "luminous flux". Normalised so the
  // default 0.6 maps to 1.0 (the original look); >0.6 blooms brighter, →0
  // mattes the rim out entirely.
  float glow = u_intensity / 0.6;
  vec3 rimC = rainbow(u_hue + t*0.18 + u_phase);
  col += rimC * fres * 0.95 * rimMask * glow;
  col += rainbow(u_hue2 + t*0.05) * fres * 0.40 * rimMask * glow;
  col += vec3(1.0) * spec * 0.55 * glow;

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

// Build a fragment for a validated user expression. The standard pipeline runs
// unchanged and produces `col` (the kaleidoscope, lit + rimmed); we expose that as
// the DSL input `base`, then make the expression the FINAL colour. So the default
// expression `base` reproduces the standard orb EXACTLY, and a user edits out from
// there (base*…, base+…) or ignores it for a fully custom look — overriding the
// whole surface, not just a tint. `expr` is already AST-validated + re-emitted by
// shader-dsl.compileUserExpr on the viewer; even a stray non-expression can't
// inject (it just fails to compile → the caller falls back). Friendly aliases
// expose the dial uniforms under the names the DSL allows (p/n/uv/t already exist
// in main's scope).
function userFragSrc(expr) {
  return FRAG_SRC.replace(
    "outColor = vec4(col, 1.0);",
    "vec3 base=col; float hue=u_hue; float warp=u_warp; float density=u_progress; float layers=u_iters; float sharp=u_sharp; float PI=3.14159265;\n  outColor = vec4(" + expr + ", u_blend);"
  );
}

// The actual kaleidoscope, written as an EDITABLE GLSL function — this is what the
// "custom shader" editor shows by default, so a person can read/tweak the real code
// (the fold loop, turbulence, palette) rather than an opaque token. The dials arrive
// as named params (hue/warp/density/layers/sharp). Returns the orb's albedo; the
// orb's geometry + lighting + rim are applied around it by the template.
export const DEFAULT_SURFACE_GLSL =
`// p = surface point · n = surface normal · uv = screen · t = seconds
// hue/warp/density/layers/sharp = your dials (0..1) · pal()/hsv()/noise()/fbm() available
vec3 surface(vec3 p, vec3 n, vec2 uv, float t,
             float hue, float warp, float density, float layers, float sharp) {
  // Triplanar weights — blend the 2D fractal across the 3 axis planes.
  vec3 w = pow(abs(n), vec3(4.0));
  w /= (w.x + w.y + w.z + 1e-5);

  // density (Lattice) sets the fold scale; layers (Strata) the layer count;
  // sharp (Filament) the line sharpness; warp (Vortex) the turbulence.
  float s = (density < 0.25) ? mix(0.6, 1.7, density / 0.25)
                             : mix(1.7, 6.0, (density - 0.25) / 0.75);
  int nLayers = int(clamp(floor(layers * 5.0 + 1.5), 1.0, 6.0));
  float sharpExp = mix(0.7, 2.2, sharp);

  vec3 col = vec3(0.0);
  for (int axis = 0; axis < 3; axis++) {
    vec2 fp0 = (axis == 0) ? p.yz * s : (axis == 1) ? p.xz * s : p.xy * s;
    float wgt = (axis == 0) ? w.x : (axis == 1) ? w.y : w.z;
    vec2 fp = fp0;
    for (int i = 0; i < 6; i++) {
      if (i >= nLayers) break;
      // multi-octave turbulence churns the fold space (Vortex)
      vec2 turb = sin(fp.yx * 2.5 + t * 0.25)
                + 0.5  * sin(fp.yx * 5.7 - t * 0.18)
                + 0.25 * sin(fp.yx * 11.3 + 2.1);
      fp += warp * 0.35 * turb;
      fp = fract(fp * 1.5) - 0.5;                 // the kaleidoscope fold
      float d = length(fp) * exp(-length(fp0));
      vec3  c = pal(length(fp0) * 1.2 + float(i) * 0.55 + hue + t * 0.18);
      d = abs(sin(d * 8.0 + t * 1.6) / 8.0);
      d = pow(0.01 / d, sharpExp);
      col += c * d * wgt;
    }
  }
  return col * 0.92;
}`;

// Max characters a user shader may be (cheap DoS bound on compile cost + program
// size; the DB CHECK is a higher backstop). Keep in sync with the editor.
export const MAX_GLSL_LEN = 4000;
// Per-pixel loop-cost caps — these keep a single frame BOUNDED so no shader can
// hang/TDR the GPU: each loop's literal bound, the product of NESTED loop bounds
// (worst-case iterations at one pixel), and the total loop count.
const MAX_LOOP_BOUND = 256;
const MAX_LOOP_PRODUCT = 1024;
const MAX_LOOP_COUNT = 6;

// Static safety screen for raw user GLSL. Returns a human reason string if the
// source is rejected, or null if allowed. Goal: NO shader can hang/crash the GPU.
//  - length cap (bounds compile cost + unrolled program size);
//  - while/do BANNED — the only truly unbounded loops;
//  - preprocessor / gl_* / textures BANNED;
//  - every `for` must be CANONICAL — `for (i = …; i < LITERAL; …) { … }` with a
//    literal bound ≤ MAX_LOOP_BOUND, the NESTED product of bounds ≤ MAX_LOOP_PRODUCT
//    (per-pixel iterations bounded regardless of nesting), ≤ MAX_LOOP_COUNT loops.
// Anything it can't VERIFY as cheap (variable bounds, `for(;;)`, braceless bodies,
// function-call bounds) is REJECTED — fail-safe. Runs on every viewer at render.
function glslGuardReason(src) {
  if (src.length > MAX_GLSL_LEN) return `too long (max ${MAX_GLSL_LEN} chars)`;
  // Strip comments so keywords/braces inside them don't trip the scan.
  const code = src.replace(/\/\/[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  if (/\bwhile\b/.test(code))     return "'while' loops aren't allowed";
  if (/\bdo\b/.test(code))        return "'do' loops aren't allowed";
  if (/#/.test(code))             return "the preprocessor (#) isn't allowed";
  if (/\bgl_[A-Za-z]/.test(code)) return "gl_* builtins aren't allowed";
  if (/\btexture\w*\s*\(|\b(sampler|texelFetch|imageLoad|imageStore)\b/.test(code)) return "textures aren't allowed";
  // Validate every `for` and bound the nested loop product via the brace structure.
  let i = 0, loops = 0, pending = 0, product = 1;   // pending = bound awaiting its '{'
  const open = [];                                  // per open brace: for-bound, or 0
  const n = code.length;
  while (i < n) {
    if (code[i] === "f" && /^for\b/.test(code.slice(i, i + 4))) {
      const hm = /^for\s*\(([^)]*)\)\s*/.exec(code.slice(i));
      if (!hm) return "malformed for-loop";
      if (++loops > MAX_LOOP_COUNT) return `too many loops (max ${MAX_LOOP_COUNT})`;
      const cond = (hm[1].split(";")[1] || "").trim();
      const cm = /^[A-Za-z_]\w*\s*(<=?)\s*(\d+)$/.exec(cond);
      if (!cm) return "each loop must be  for (i = 0; i < N; i++)  with a number N";
      const bound = (+cm[2]) + (cm[1] === "<=" ? 1 : 0);
      if (bound > MAX_LOOP_BOUND) return `loop bound too large (max ${MAX_LOOP_BOUND})`;
      i += hm[0].length;
      if (code[i] !== "{") return "a loop body must use { }";
      pending = Math.max(1, bound);
      continue;
    }
    const c = code[i++];
    if (c === "{") {
      open.push(pending);
      if (pending) {
        product *= pending;
        if (product > MAX_LOOP_PRODUCT) return `loops too expensive (≈ ${product}× per pixel; max ${MAX_LOOP_PRODUCT})`;
      }
      pending = 0;
    } else if (c === "}") {
      const b = open.pop();
      if (b) product = Math.round(product / b);
    }
  }
  return null;
}

// Splice an editable user surface() function into the orb: define it before main()
// and call it for the albedo (replacing the built-in kaleidoscope). The orb's
// geometry, lighting and rim stay; only the surface colour comes from user code.
// Compiled in isolation by the caller — any compile/link error falls back to the
// standard shader, so a typo never breaks the orb. NOTE: this is RAW GLSL, but the
// caller reaches it via shaderGLSL, which runs glslGuardReason() (the cost-sandbox:
// bans while/do + preprocessor/gl_*/textures, bounds for-loop iterations) before
// every compile and falls back on rejection. That bound holds on EVERY viewer, so a
// saved shader renders cohort-wide, not just on the author's machine.
function userFragGLSL(glsl) {
  return FRAG_SRC
    .replace("void main(){", glsl + "\n\nvoid main(){")
    .replace(
      "vec3 kal = kaleido(op, no, t, u_hue + t*0.18);",
      "vec3 kal = surface(op, no, uv, t, u_hue, u_warp, u_progress, u_iters, u_sharp);"
    )
    .replace("outColor = vec4(col, 1.0);", "outColor = vec4(col, u_blend);");
}

function buildProgram(gl, fragSrc) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc || FRAG_SRC);
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
      bg:            gl.getUniformLocation(prog, "u_bg"),
      bgOn:          gl.getUniformLocation(prog, "u_bg_on"),
      bgMix:         gl.getUniformLocation(prog, "u_bg_mix"),
      warp:          gl.getUniformLocation(prog, "u_warp"),
      iters:         gl.getUniformLocation(prog, "u_iters"),
      sharp:         gl.getUniformLocation(prog, "u_sharp"),
      blend:         gl.getUniformLocation(prog, "u_blend"),
      aspect:        gl.getUniformLocation(prog, "u_aspect"),
      scale:         gl.getUniformLocation(prog, "u_scale"),
      manual:        gl.getUniformLocation(prog, "u_manual"),
      rot:           gl.getUniformLocation(prog, "u_rot"),
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

// ── per-shape customization helpers ──────────────────────────────────────
// Any shape can override its hash-derived look via data-shape-* attributes /
// mount opts. sphereAttrs() builds the attribute string the card + detail
// renderers stamp onto each placeholder; the overlay + mountShape read them
// back. Every dial is clamped to [0,1]; absent dials fall back so an
// un-customized shape renders exactly as before.
function clamp01(n) { return n < 0 ? 0 : n > 1 ? 1 : n; }

// "#rrggbb" → [r,g,b] in 0..1, or null if not a valid hex colour.
function hexToRgb(hex) {
  if (typeof hex !== "string") return null;
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// Parse an optional numeric data-attr to [0,1], or return the fallback.
export function numAttr(value, fallback) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? clamp01(n) : fallback;
}

// The Time dial → an animation-SPEED multiplier. The dial is a raw 0..1 slider
// whose centre (0.5) is the default; each half of the track covers one side so
// the default sits dead-centre and maps to 1× (the original speed):
//   0 → 0× (frozen) · 0.5 → 1× · 1 → 1.5×
// Anything non-finite falls back to 0.5 (→ 1×), so un-customized orbs are unchanged.
function timeMult(s) {
  let x = Number(s);
  if (!Number.isFinite(x)) x = 0.5;
  x = clamp01(x);
  return x <= 0.5 ? x * 2 : 0.5 + x;
}

// "team" | "project" | "person" (or a 0|1|2 number) → the u_kind uniform value.
export function kindToNum(kind) {
  return kind === "person" || kind === 2 ? 2
       : kind === "project" || kind === 1 ? 1
       : 0;
}

// Build the data-shape-* override attribute string from a saved sphere
// { hue, hue2, phase, intensity, complexity }. complexity → data-shape-progress
// (the shader's density uniform). Omits any dial that isn't a finite number so
// partial records fall back per-dial. Values are plain clamped floats.
export function sphereAttrs(sphere) {
  if (!sphere || typeof sphere !== "object") return "";
  // Editable dial columns → shader attrs. The phase column drives "Fracture Field"
  // (warp, NOT u_phase); hue2 → "Strata" (iters); intensity → "Filament" (sharp).
  // u_phase + u_hue2 stay hash-derived and u_intensity (rim glow) is fixed in the
  // overlay/mountShape regardless of these column values.
  const map = [
    ["hue",        "data-shape-hue"],
    ["complexity", "data-shape-progress"],
    ["phase",      "data-shape-warp"],
    ["hue2",       "data-shape-iters"],
    ["intensity",  "data-shape-sharp"],
  ];
  const parts = [];
  for (const [key, attr] of map) {
    const n = Number(sphere[key]);
    if (Number.isFinite(n)) parts.push(`${attr}="${clamp01(n)}"`);
  }
  // Optional background colour (hex). hexToRgb validates the format.
  if (hexToRgb(sphere.bg)) parts.push(`data-shape-bg="${sphere.bg.trim().toLowerCase()}"`);
  // Orb Core amount (0..1) — emitted only when present so absent records use the default.
  if (Number.isFinite(Number(sphere.bg_mix))) parts.push(`data-shape-bgmix="${clamp01(Number(sphere.bg_mix))}"`);
  // Time dial (0..1 speed slider) — emitted only when present; absent → 0.5 (1×).
  if (Number.isFinite(Number(sphere.time_scale))) parts.push(`data-shape-timescale="${clamp01(Number(sphere.time_scale))}"`);
  return parts.join(" ");
}

// ── public mount API ────────────────────────────────────────────────────
// canvas: an HTMLCanvasElement already in the DOM.
// opts.family:  0..5
// opts.seed:    string (e.g. record_id) — drives colour + phase
// opts.size:    optional CSS px (square); defaults to canvas.clientWidth
// opts.progress / .intensity / .rotationPhase: optional 0..1 reserved
// returns { destroy(), update(opts), pause(), resume() }
export function mountShape(canvas, opts = {}) {
  // A validated user shader expression (opts.shaderExpr, produced by shader-dsl on
  // the viewer) replaces the procedural albedo. Belt-and-suspenders: ignore
  // anything that isn't a bare expression. Any compile/link failure (incl. a type
  // mismatch) falls back to the standard shader — a bad shader can never break us.
  const _expr = (typeof opts.shaderExpr === "string" && opts.shaderExpr && !/[;{}#]/.test(opts.shaderExpr)) ? opts.shaderExpr : null;
  // opts.shaderGLSL: an editable raw-GLSL surface() function (the kaleidoscope
  // editor). Spliced into the orb + compiled in isolation; on any failure we fall
  // back to the standard shader (a typo never breaks the orb). glslGuardReason()
  // blocks the constructs that could hang the GPU before a compile error is caught
  // (length, while/do, preprocessor, gl_*, textures); real bounding for SHARED
  // shaders is the cost-sandbox (separate). opts.onStatus(ok, log) reports the
  // result so the editor can show why a shader was rejected.
  const _rawGlsl = (!_expr && typeof opts.shaderGLSL === "string" && opts.shaderGLSL.trim()) ? opts.shaderGLSL : null;
  const _glslReason = _rawGlsl ? glslGuardReason(_rawGlsl) : null;   // null = allowed
  const _glsl = (_rawGlsl && !_glslReason) ? _rawGlsl : null;
  const onStatus = typeof opts.onStatus === "function" ? opts.onStatus : null;
  // FLICKER GUARD: a custom shader can change colour arbitrarily fast over time
  // (t*99, sin(t*big), …) — a strobe risk, especially since shaders are shared. We
  // can't cap that in the maths, so custom orbs are temporally smoothed: each frame
  // blends only a fraction of the new colour over the kept previous frame (an EMA),
  // capping how fast the displayed colour can change. preserveDrawingBuffer keeps
  // last frame; the sphere silhouette is a constant circle so there are no trails.
  // opts.smooth forces the persistent-smoothed context even for a standard orb —
  // the editor uses it so it can HOT-SWAP the shader program on every edit
  // (update({shaderGLSL})) instead of re-creating the canvas/GL context (which
  // flashes the compositor). The EMA buffer then morphs old→new colour in place.
  const SMOOTH = !!(_expr || _glsl || opts.smooth);
  const SMOOTH_TAU = 0.25;   // seconds — bigger = smoother/safer, more motion softening
  // alpha:true + per-frame clear-to-transparent so the discarded region outside
  // the orb shows the page/card behind it (never a black or coloured box).
  const gl = canvas.getContext("webgl2", { antialias: true, alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: SMOOTH });
  if (!gl) {
    return { destroy() {}, update() {}, pause() {}, resume() {} };
  }
  const _custom = _glsl ? userFragGLSL(_glsl) : _expr ? userFragSrc(_expr) : null;
  // A guard-rejected shader never compiles — report why, then render standard.
  if (_glslReason && onStatus) onStatus(false, _glslReason);
  let prog;
  try { prog = buildProgram(gl, _custom || FRAG_SRC); if (onStatus && _custom) onStatus(true, ""); }
  catch (e) {
    if (onStatus && _custom) onStatus(false, String(e && e.message ? e.message : e));
    try { prog = _custom ? buildProgram(gl, FRAG_SRC) : null; } catch {}
    if (!prog) {
      // eslint-disable-next-line no-console
      console.warn("[shape-ui]", e.message);
      return { destroy() {}, update() {}, pause() {}, resume() {} };
    }
  }
  // Blend the opaque orb over a transparent clear so nothing shows behind it.
  gl.enable(gl.BLEND);
  // SMOOTH path: RGB does an EMA toward the new colour (factor = the shader's
  // alpha, u_blend), while alpha accumulates to 1 so the orb stays opaque — hence
  // blendFuncSeparate. Standard path keeps the plain over-blend.
  if (SMOOTH) gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);
  let _needClear = true;   // SMOOTH: clear only on the first frame + after a resize
  let _emaMs = 0;

  const colors = hashColors(opts.seed);
  let family        = Number(opts.family) || 0;
  let kind          = kindToNum(opts.kind);
  // hue/hue2/phase default to the hash-derived colours but can be overridden
  // (the profile-page live preview drives them via update()).
  let hue           = opts.hue   != null ? +opts.hue   : colors.hue;
  let hue2          = opts.hue2  != null ? +opts.hue2  : colors.hue2;
  let phase         = opts.phase != null ? +opts.phase : colors.phase;
  let progress      = opts.progress      != null ? +opts.progress      : 0.25;
  let intensity     = 0.3;                  // fixed glow ("Luminous Flux" removed)
  let rotationPhase = opts.rotationPhase != null ? +opts.rotationPhase : 0;
  let warp          = opts.warp != null ? +opts.warp : 0;
  let iters         = opts.iters != null ? +opts.iters : 0.3;     // Strata (→ 3 layers)
  let sharp         = opts.sharp != null ? +opts.sharp : 0.3333;  // Filament (→ 1.2 exponent)
  let bg            = hexToRgb(opts.bg);   // orb canvas colour or null (transparent)
  let bgMix         = opts.bgMix != null ? +opts.bgMix : 0.45;   // Orb Core amount (0..1)
  let timeScale     = opts.timeScale != null ? +opts.timeScale : 0.5;  // Time dial (raw 0..1; 0.5 → 1×)
  const animate     = opts.animate !== false;  // false → render one still frame (no spin)

  // ── optional drag-to-spin (editor preview), mirroring the detail-page die:
  // drag to rotate (x→yaw, y→pitch), release flings easing back to a slow idle
  // tumble, click stops it. Orientation is a quaternion fed to u_rot (u_manual=1).
  const draggable = !!opts.draggable;
  const ROT_PER_PX = 0.0055, DRAG_CLICK_PX = 4, FLING_MAX = 5.0, IDLE_RETURN_TAU = 2.5;
  const IDLE_SPIN = { x: 0.10, y: 0.24 };
  const drag = {
    quat: [0, 0, 0, 1], vel: { x: IDLE_SPIN.x, y: IDLE_SPIN.y },
    stopped: false, dragging: false, moved: false,
    downX: 0, downY: 0, lastX: 0, lastY: 0, lastMoveMs: 0, mat: new Float32Array(9),
  };
  let _lastFrameMs = 0;
  function qMul(a, b) {
    const ax=a[0],ay=a[1],az=a[2],aw=a[3], bx=b[0],by=b[1],bz=b[2],bw=b[3];
    return [aw*bx+ax*bw+ay*bz-az*by, aw*by-ax*bz+ay*bw+az*bx, aw*bz+ax*by-ay*bx+az*bw, aw*bw-ax*bx-ay*by-az*bz];
  }
  function qAxis(x, y, z, a) { const h=a*0.5, s=Math.sin(h); return [x*s, y*s, z*s, Math.cos(h)]; }
  function qNorm(q) { const l=Math.hypot(q[0],q[1],q[2],q[3])||1; return [q[0]/l,q[1]/l,q[2]/l,q[3]/l]; }
  function quatToMat3(q, o) {
    const x=q[0],y=q[1],z=q[2],w=q[3];
    const xx=x*x,yy=y*y,zz=z*z,xy=x*y,xz=x*z,yz=y*z,wx=w*x,wy=w*y,wz=w*z;
    o[0]=1-2*(yy+zz); o[1]=2*(xy+wz); o[2]=2*(xz-wy);
    o[3]=2*(xy-wz); o[4]=1-2*(xx+zz); o[5]=2*(yz+wx);
    o[6]=2*(xz+wy); o[7]=2*(yz-wx); o[8]=1-2*(xx+yy);
    return o;
  }
  function spinBy(yaw, pitch) {
    drag.quat = qMul(qAxis(0,1,0,yaw), drag.quat);
    drag.quat = qMul(qAxis(1,0,0,pitch), drag.quat);
    drag.quat = qNorm(drag.quat);
  }
  function onDown(ev) {
    drag.dragging = true; drag.moved = false;
    drag.downX = drag.lastX = ev.clientX; drag.downY = drag.lastY = ev.clientY;
    drag.lastMoveMs = performance.now();
    try { canvas.setPointerCapture(ev.pointerId); } catch {}
    canvas.style.cursor = "grabbing";
    ev.preventDefault(); ev.stopPropagation();
  }
  function onMove(ev) {
    if (!drag.dragging) return;
    const dx = ev.clientX - drag.lastX, dy = ev.clientY - drag.lastY;
    drag.lastX = ev.clientX; drag.lastY = ev.clientY;
    if (!drag.moved && Math.abs(ev.clientX - drag.downX) + Math.abs(ev.clientY - drag.downY) > DRAG_CLICK_PX) {
      drag.moved = true; drag.stopped = false;
    }
    if (!drag.moved) return;
    spinBy(dx * ROT_PER_PX, dy * ROT_PER_PX);
    const nowMs = performance.now();
    const dt = Math.max(8, nowMs - drag.lastMoveMs) / 1000;
    drag.lastMoveMs = nowMs;
    drag.vel.y += (dx * ROT_PER_PX / dt - drag.vel.y) * 0.35;
    drag.vel.x += (dy * ROT_PER_PX / dt - drag.vel.x) * 0.35;
    const sp = Math.hypot(drag.vel.x, drag.vel.y);
    if (sp > FLING_MAX) { const k = FLING_MAX / sp; drag.vel.x *= k; drag.vel.y *= k; }
  }
  function onUp(ev) {
    if (!drag.dragging) return;
    drag.dragging = false;
    try { canvas.releasePointerCapture(ev.pointerId); } catch {}
    canvas.style.cursor = "grab";
    if (drag.moved) { if (performance.now() - drag.lastMoveMs > 80) { drag.vel.x = 0; drag.vel.y = 0; } return; }
    drag.vel.x = 0; drag.vel.y = 0; drag.stopped = true;
  }
  if (draggable) {
    drag.quat = qNorm(qMul(qAxis(0,1,0,0.5), qAxis(1,0,0,0.42)));  // start at a 3/4 view
    canvas.style.cursor = "grab"; canvas.style.touchAction = "none";
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
  }

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  function resize() {
    const cssW = canvas.clientWidth  || 120;
    const cssH = canvas.clientHeight || 120;
    canvas.width  = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    gl.viewport(0, 0, canvas.width, canvas.height);
    _needClear = true;   // resizing resets the kept buffer → clear before re-accumulating
    if (!animate) requestAnimationFrame(frame);  // static: redraw the single frame at the new size
  }
  resize();
  const ro = (typeof ResizeObserver !== "undefined") ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(canvas);

  let raf = 0;
  let running = true;
  // Animation clock: accumulate real dt × the Time-dial speed multiplier rather
  // than reading absolute elapsed time, so dragging the Time slider speeds up /
  // freezes the orb smoothly (a plain u_time×scale would jump the phase mid-drag).
  // timeScale 0.5 (the default) → 1×, so this matches the old elapsed clock.
  let animClock = 0, _clockMs = 0;
  function frame(now) {
    if (!running) { raf = 0; return; }
    const _dtClock = _clockMs ? Math.min(0.1, (now - _clockMs) / 1000) : 0;
    _clockMs = now;
    animClock += _dtClock * timeMult(timeScale);
    const t = animClock;
    if (draggable) {
      const dtFrame = _lastFrameMs ? Math.min(0.05, (now - _lastFrameMs) / 1000) : 0.016;
      _lastFrameMs = now;
      if (!drag.dragging) {  // idle tumble / fling easing back to the slow idle
        spinBy(drag.vel.y * dtFrame, drag.vel.x * dtFrame);
        const k = 1 - Math.exp(-dtFrame / IDLE_RETURN_TAU);
        drag.vel.x += ((drag.stopped ? 0 : IDLE_SPIN.x) - drag.vel.x) * k;
        drag.vel.y += ((drag.stopped ? 0 : IDLE_SPIN.y) - drag.vel.y) * k;
      }
    }
    // SMOOTH: keep the previous frame (EMA accumulation) — clear only the first
    // frame / after a resize. Standard orbs clear every frame as before.
    const cleared = (!SMOOTH || _needClear);
    if (cleared) { gl.clear(gl.COLOR_BUFFER_BIT); _needClear = false; }
    // EMA factor: fraction of the NEW colour mixed in this frame. The FIRST frame
    // after a clear is drawn fully opaque (blendK=1) so the orb never fades in from
    // transparent — which would let the page show THROUGH the orb (a white blink);
    // smoothing (1 - e^(-dt/τ)) then applies from the next frame on. 1.0 also = no
    // smoothing for standard orbs + static custom orbs (which can't flicker).
    let blendK = 1.0;
    if (SMOOTH && animate && !cleared) {
      const dtE = _emaMs ? Math.min(0.1, (now - _emaMs) / 1000) : 0.016;
      _emaMs = now;
      blendK = 1 - Math.exp(-dtE / SMOOTH_TAU);
    } else if (SMOOTH && animate) {
      _emaMs = now;   // first/cleared frame: seed the clock, draw opaque
    }
    gl.useProgram(prog.prog);
    gl.uniform1f(prog.uniforms.blend, blendK);
    gl.uniform1f(prog.uniforms.time, t);
    gl.uniform1f(prog.uniforms.family, family);
    gl.uniform1f(prog.uniforms.kind, kind);
    gl.uniform1f(prog.uniforms.hue, hue);
    gl.uniform1f(prog.uniforms.hue2, hue2);
    gl.uniform1f(prog.uniforms.phase, phase);
    gl.uniform1f(prog.uniforms.progress, progress);
    gl.uniform1f(prog.uniforms.intensity, intensity);
    gl.uniform1f(prog.uniforms.rotationPhase, rotationPhase);
    gl.uniform1f(prog.uniforms.warp, warp);
    gl.uniform1f(prog.uniforms.iters, iters);
    gl.uniform1f(prog.uniforms.sharp, sharp);
    if (bg) { gl.uniform3fv(prog.uniforms.bg, bg); gl.uniform1f(prog.uniforms.bgOn, 1); }
    else gl.uniform1f(prog.uniforms.bgOn, 0);
    gl.uniform1f(prog.uniforms.bgMix, bgMix);
    gl.uniform1f(prog.uniforms.aspect, canvas.width / canvas.height);
    gl.uniform1f(prog.uniforms.scale, opts.scale != null ? +opts.scale : 1.0);
    if (draggable) { gl.uniform1f(prog.uniforms.manual, 1); quatToMat3(drag.quat, drag.mat); gl.uniformMatrix3fv(prog.uniforms.rot, false, drag.mat); }
    else gl.uniform1f(prog.uniforms.manual, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    if (animate) raf = requestAnimationFrame(frame); else raf = 0;
  }
  function pause() { if (!running) return; running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }
  function resume() { if (running) return; running = true; _clockMs = 0; raf = requestAnimationFrame(frame); }

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

  // Rebuild the program for a new raw-GLSL surface (the editor's live edit). Runs
  // the guard, compiles in isolation, and on success swaps `prog` on the SAME
  // context — NO canvas/context churn, so nothing flashes; the preserved buffer
  // EMA-morphs from the old shader to the new. On failure it keeps the current
  // program (reports via onStatus). "" / null returns to the standard orb.
  function swapShaderGLSL(glsl) {
    const g = (typeof glsl === "string" && glsl.trim()) ? glsl : null;
    const reason = g ? glslGuardReason(g) : null;
    if (reason) { if (onStatus) onStatus(false, reason); return; }
    let np;
    try { np = buildProgram(gl, g ? userFragGLSL(g) : FRAG_SRC); }
    catch (e) { if (onStatus && g) onStatus(false, String(e && e.message ? e.message : e)); return; }
    if (onStatus && g) onStatus(true, "");
    const old = prog; prog = np;
    try { if (old && old.prog && old.prog !== np.prog) gl.deleteProgram(old.prog); } catch {}
  }

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
      if (next.kind         != null) kind          = kindToNum(next.kind);
      if (next.hue          != null) hue           = +next.hue;
      if (next.hue2         != null) hue2          = +next.hue2;
      if (next.phase        != null) phase         = +next.phase;
      if (next.progress     != null) progress      = +next.progress;
      if (next.warp         != null) warp          = +next.warp;
      if (next.iters        != null) iters         = +next.iters;
      if (next.sharp        != null) sharp         = +next.sharp;
      if (next.rotationPhase != null) rotationPhase = +next.rotationPhase;
      if (next.bg            !== undefined) bg      = hexToRgb(next.bg);
      if (next.bgMix         != null) bgMix         = +next.bgMix;
      if (next.timeScale     != null) timeScale     = +next.timeScale;   // Time dial (live scrub)
      // Live shader edit: hot-swap the program in place (no remount → no flash).
      if ("shaderGLSL" in next) swapShaderGLSL(next.shaderGLSL);
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
      // Optional per-shape overrides (data-shape-hue/-hue2/-phase/-intensity/
      // -progress) from sphereAttrs(); absent dials fall back to the hash colour
      // and the formerly-fixed 0.6 / 0.25, so an un-customized shape is unchanged.
      const base = hashColors(el.dataset.shapeSeed || "");
      out.push({
        el,
        family: Number(el.dataset.shapeFam) || 0,
        kind,
        scale: Number(el.dataset.shapeScale) || 1,
        colors: {
          hue:   numAttr(el.dataset.shapeHue, base.hue),  // editable (Spectral Phase)
          hue2:  base.hue2,                                // hash accent (no dial)
          phase: base.phase,                               // hash motion phase (no dial)
        },
        warp:      numAttr(el.dataset.shapeWarp,     0),      // Fracture Field — default 0 (none)
        iters:     numAttr(el.dataset.shapeIters,    0.3),    // Strata — default 0.3 → 3 layers
        sharp:     numAttr(el.dataset.shapeSharp,    0.3333), // Filament — default 0.333 → 1.2 exponent
        intensity: 0.3,                                       // fixed rim glow (Luminous Flux removed)
        progress:  numAttr(el.dataset.shapeProgress, 0.25),  // editable (Recursion Depth)
        bg: hexToRgb(el.dataset.shapeBg),                    // orb canvas colour or null
        bgMix: numAttr(el.dataset.shapeBgmix, 0.45),         // Orb Core amount (0..1)
        timeScale: numAttr(el.dataset.shapeTimescale, 0.5),  // Time dial (0..1; 0.5 → 1×)
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
      // Per-shape speed: scale the shared clock by the Time dial. In the overlay
      // a card's timeScale is static for its lifetime (a save rebuilds the card),
      // so a plain multiply can't jump; default 0.5 → 1× → tp === t (unchanged).
      gl.uniform1f(prog.uniforms.time, t * timeMult(p.timeScale));
      gl.uniform1f(prog.uniforms.family, p.family);
      gl.uniform1f(prog.uniforms.kind, p.kind);
      gl.uniform1f(prog.uniforms.hue, p.colors.hue);
      gl.uniform1f(prog.uniforms.hue2, p.colors.hue2);
      gl.uniform1f(prog.uniforms.phase, p.colors.phase);
      gl.uniform1f(prog.uniforms.progress, p.progress);
      gl.uniform1f(prog.uniforms.intensity, p.intensity);
      gl.uniform1f(prog.uniforms.rotationPhase, 0);
      gl.uniform1f(prog.uniforms.warp, p.warp);
      gl.uniform1f(prog.uniforms.iters, p.iters);
      gl.uniform1f(prog.uniforms.sharp, p.sharp);
      if (p.bg) { gl.uniform3fv(prog.uniforms.bg, p.bg); gl.uniform1f(prog.uniforms.bgOn, 1); }
      else gl.uniform1f(prog.uniforms.bgOn, 0);
      gl.uniform1f(prog.uniforms.bgMix, p.bgMix);
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
