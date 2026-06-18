// shader-dsl.mjs — the SECURITY BOUNDARY for user-authored sphere shaders.
//
// Users may type a single restricted expression that becomes the orb's albedo.
// This module turns that UNTRUSTED text into safe GLSL — or rejects it. It runs
// on EVERY viewer at render time (the stored text is untrusted: the shipped anon
// key can POST any string to os_spheres.shader_src, bypassing the editor), so it
// is the only thing standing between arbitrary input and the GL compiler.
//
// Safe by construction:
//   - ONE expression — no statements, assignments, blocks, loops, preprocessor,
//     comparisons, or control flow. So no infinite loops and no injection.
//   - Character allowlist at the tokenizer: only identifiers, number literals and
//     `+ - * / ( ) , .` + whitespace. Everything else (`; { } [ ] = # % & | ^ ! < >
//     ? : " ' \\` backtick, etc.) is rejected outright.
//   - Identifier allowlist: every name must be a known INPUT or FUNC. Unknown
//     names (gl_*, discard, texture, uniform, keywords, …) are rejected.
//   - Cost caps: source length, AST node count, nesting depth, literal magnitude.
//     There are NO user loops; the bounded builtins (fbm) have FIXED internal loop
//     counts in the template. ⇒ per-pixel cost is bounded ⇒ no GPU DoS.
//   - The GLSL is RE-EMITTED from the validated AST (never echoed), then the caller
//     wraps it `vec3(<glsl>)` and compiles in isolation, falling back to the
//     standard shader on any compile failure.
//
// Pure: no DOM, no GL, no I/O — fully unit-testable (see shader-dsl.test.mjs).

// Inputs the template makes available to the expression (real GLSL vars/consts).
export const SHADER_INPUTS = new Set([
  "base",     // vec3 — the STANDARD orb colour (the kaleidoscope, lit + rimmed),
              //        computed by the normal pipeline. Build on it (base*…,
              //        base+…) or ignore it for a fully custom look.
  "p",        // vec3 — surface point
  "n",        // vec3 — surface normal
  "uv",       // vec2 — screen uv (−1..1)
  "t",        // float — time (seconds)
  "hue",      // float — the Chroma dial (0..1)
  "warp",     // float — the Vortex dial (0..1)
  "density",  // float — the Lattice dial (0..1)
  "layers",   // float — the Strata dial (0..1)
  "sharp",    // float — the Filament dial (0..1)
  "PI",       // float constant
]);

// Allowed functions → [minArgs, maxArgs]. Constructors take a count range; the GL
// compiler validates the actual component types (an invalid combo just fails to
// compile → safe fallback). Builtins noise/fbm/pal/hsv are defined in the template
// with FIXED internal cost.
export const SHADER_FUNCS = {
  sin: [1, 1], cos: [1, 1], tan: [1, 1], abs: [1, 1], floor: [1, 1], fract: [1, 1],
  exp: [1, 1], log: [1, 1], sqrt: [1, 1], radians: [1, 1], normalize: [1, 1], length: [1, 1],
  sign: [1, 1],
  min: [2, 2], max: [2, 2], mod: [2, 2], pow: [2, 2], dot: [2, 2], step: [2, 2], distance: [2, 2],
  clamp: [3, 3], mix: [3, 3], smoothstep: [3, 3],
  vec2: [1, 2], vec3: [1, 3], vec4: [1, 4],
  noise: [1, 1], fbm: [1, 1], pal: [1, 1], hsv: [1, 1],
};

export const MAX_SRC_LEN = 1500;
export const MAX_NODES = 256;
export const MAX_DEPTH = 32;
const MAX_LITERAL = 1e6;
const SWIZZLE_RE = /^[xyzwrgbastpq]{1,4}$/;

// Helpful one-liner of what's available, for the editor's hint.
export const SHADER_HELP =
  "inputs: p n uv t hue warp density layers sharp PI · funcs: sin cos abs floor fract mix clamp " +
  "step smoothstep min max mod pow dot length normalize sqrt exp log sign distance radians vec2 vec3 vec4 " +
  "noise(v2) fbm(v2) pal(f) hsv(v3) · one expression, e.g.  pal(length(p)*3.0 + t*0.1) * (0.6 + 0.4*fbm(p.xy*4.0))";

// Default code shown in the editor when a person has no custom shader yet. It is
// literally `base` — the STANDARD orb (the animated kaleidoscope, lit + rimmed) —
// so the default preview matches the real orb exactly, and a person edits OUT from
// there: `base * pal(t*0.1)`, `base + 0.3*fbm(p.xy*4.0)`, `mix(base, hsv(vec3(hue,
// 0.8, 1.0)), uv.x)`, or drop `base` entirely for a fully custom look. (The
// kaleidoscope itself is an iterative fractal that can't be written as a single
// DSL expression — hence exposing it as the `base` input.)
export const SHADER_DEFAULT = "base";

// Per-input one-line docs for the editor help panel (name → what it is). Same set
// as SHADER_INPUTS, with human descriptions in display order (base first — it's
// the most useful starting point).
export const SHADER_INPUT_DOCS = [
  ["base", "the standard orb colour — build on it or ignore it"],
  ["p", "surface point on the orb (vec3)"],
  ["n", "surface normal (vec3) — use it for lighting"],
  ["uv", "screen position, −1..1 (vec2)"],
  ["t", "time in seconds (float)"],
  ["hue", "your Chroma dial, 0..1"],
  ["warp", "your Vortex dial, 0..1"],
  ["density", "your Lattice dial, 0..1"],
  ["layers", "your Strata dial, 0..1"],
  ["sharp", "your Filament dial, 0..1"],
  ["PI", "3.14159…"],
];

// Function names available to an expression, grouped for the editor help panel.
// Mirrors SHADER_FUNCS (constructors + bounded builtins + scalar/vector math).
export const SHADER_FUNC_GROUPS = [
  ["colour", ["pal", "hsv"]],
  ["noise", ["noise", "fbm"]],
  ["vectors", ["vec2", "vec3", "vec4", "length", "dot", "normalize", "distance"]],
  ["math", ["sin", "cos", "tan", "abs", "floor", "fract", "mod", "pow", "sqrt", "exp", "log", "sign", "radians", "min", "max", "clamp", "mix", "step", "smoothstep"]],
];

class DslError extends Error {}

// ── tokenizer ────────────────────────────────────────────────────────────
function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") { i++; continue; }
    // number: 123  1.5  .5  1e3  1.5E-2  (a leading '.' starts a number)
    if ((c >= "0" && c <= "9") || (c === "." && src[i + 1] >= "0" && src[i + 1] <= "9")) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new DslError("bad number");
      const v = parseFloat(m[0]);
      if (!Number.isFinite(v) || Math.abs(v) > MAX_LITERAL) throw new DslError(`number out of range: ${m[0]}`);
      toks.push({ t: "num", v, raw: m[0] });
      i += m[0].length;
      continue;
    }
    // identifier
    if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_") {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      toks.push({ t: "id", v: m[0] });
      i += m[0].length;
      continue;
    }
    // punctuation (the ONLY allowed symbols)
    if (c === "+" || c === "-" || c === "*" || c === "(" || c === ")" || c === "," || c === ".") {
      toks.push({ t: "punc", v: c }); i++; continue;
    }
    if (c === "/") {
      if (src[i + 1] === "/" || src[i + 1] === "*") throw new DslError("comments are not allowed");
      toks.push({ t: "punc", v: c }); i++; continue;
    }
    throw new DslError(`illegal character: ${JSON.stringify(c)}`);
  }
  return toks;
}

// ── parser (recursive descent) → AST, with allowlist + cost checks ─────────
function parse(toks) {
  let pos = 0;
  let nodes = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];
  const expect = (v) => { const tk = next(); if (!tk || tk.v !== v) throw new DslError(`expected '${v}'`); return tk; };
  const bump = (depth) => {
    if (++nodes > MAX_NODES) throw new DslError("expression too complex (node cap)");
    if (depth > MAX_DEPTH) throw new DslError("expression nested too deep");
  };

  function parseExpr(depth) { return parseAdd(depth); }

  function parseAdd(depth) {
    let l = parseMul(depth);
    while (peek() && peek().t === "punc" && (peek().v === "+" || peek().v === "-")) {
      const op = next().v; bump(depth);
      l = { type: "binop", op, l, r: parseMul(depth + 1) };
    }
    return l;
  }
  function parseMul(depth) {
    let l = parseUnary(depth);
    while (peek() && peek().t === "punc" && (peek().v === "*" || peek().v === "/")) {
      const op = next().v; bump(depth);
      l = { type: "binop", op, l, r: parseUnary(depth + 1) };
    }
    return l;
  }
  function parseUnary(depth) {
    if (peek() && peek().t === "punc" && (peek().v === "-" || peek().v === "+")) {
      const op = next().v; bump(depth);
      return { type: "unop", op, e: parseUnary(depth + 1) };
    }
    return parsePostfix(depth);
  }
  function parsePostfix(depth) {
    let e = parsePrimary(depth);
    while (peek() && peek().t === "punc" && peek().v === ".") {
      next();
      const sw = next();
      if (!sw || sw.t !== "id" || !SWIZZLE_RE.test(sw.v)) throw new DslError("invalid swizzle after '.'");
      bump(depth);
      e = { type: "swiz", e, sw: sw.v };
    }
    return e;
  }
  function parsePrimary(depth) {
    bump(depth);
    const tk = next();
    if (!tk) throw new DslError("unexpected end of expression");
    if (tk.t === "num") return { type: "num", v: tk.v };
    if (tk.t === "punc" && tk.v === "(") {
      const e = parseExpr(depth + 1);
      expect(")");
      return e;
    }
    if (tk.t === "id") {
      // function call?
      if (peek() && peek().t === "punc" && peek().v === "(") {
        next(); // consume '('
        const args = [];
        if (!(peek() && peek().t === "punc" && peek().v === ")")) {
          args.push(parseExpr(depth + 1));
          while (peek() && peek().t === "punc" && peek().v === ",") { next(); args.push(parseExpr(depth + 1)); }
        }
        expect(")");
        const spec = SHADER_FUNCS[tk.v];
        if (!spec) throw new DslError(`unknown function: ${tk.v}`);
        if (args.length < spec[0] || args.length > spec[1]) {
          throw new DslError(`${tk.v}() takes ${spec[0] === spec[1] ? spec[0] : spec[0] + "–" + spec[1]} args, got ${args.length}`);
        }
        return { type: "call", name: tk.v, args };
      }
      // bare identifier → must be a known input/constant
      if (!SHADER_INPUTS.has(tk.v)) throw new DslError(`unknown name: ${tk.v}`);
      return { type: "input", name: tk.v };
    }
    throw new DslError(`unexpected token: ${tk.v}`);
  }

  const ast = parseExpr(1);
  if (pos !== toks.length) throw new DslError(`unexpected trailing input near '${toks[pos].v}'`);
  return ast;
}

// ── emit GLSL from the validated AST (regenerated, never echoed) ───────────
function numLit(v) {
  // Always emit a float literal (avoid GLSL ES int/float pitfalls like 1/2).
  if (!Number.isFinite(v)) throw new DslError("non-finite literal");
  let s = (Object.is(v, -0) ? 0 : v).toString();
  if (s.includes("e") || s.includes("E")) return `float(${s})`;
  if (!s.includes(".")) s += ".0";
  return s;
}
function emit(node) {
  switch (node.type) {
    case "num":   return numLit(node.v);
    case "input": return node.name;
    case "call":  return `${node.name}(${node.args.map(emit).join(", ")})`;
    case "binop": return `(${emit(node.l)} ${node.op} ${emit(node.r)})`;
    case "unop":  return `(${node.op}${emit(node.e)})`;
    case "swiz":  return `(${emit(node.e)}).${node.sw}`;
    default:      throw new DslError("internal: bad node");
  }
}

// Validate + compile an untrusted expression. Returns { glsl } on success or
// { error } (a short human-readable reason) on any rejection. NEVER throws.
export function compileUserExpr(src) {
  try {
    const text = String(src == null ? "" : src);
    if (!text.trim()) return { error: "empty" };
    if (text.length > MAX_SRC_LEN) return { error: `too long (max ${MAX_SRC_LEN} chars)` };
    const toks = tokenize(text);
    if (!toks.length) return { error: "empty" };
    const ast = parse(toks);
    return { glsl: emit(ast) };
  } catch (e) {
    return { error: (e && e.message) ? String(e.message) : "invalid expression" };
  }
}

// ── editor syntax highlighting (cosmetic, NOT the validator) ───────────────
// A forgiving tokenizer that classifies each run of text for colour and returns
// HTML (escaped — the result is injected as innerHTML behind the textarea). It
// NEVER throws and never affects security: compileUserExpr remains the only gate.
// Classes: cm-num cm-fn cm-input cm-swizzle cm-punct cm-unknown cm-error.
const HL_ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const hlEsc = (s) => s.replace(/[&<>]/g, (c) => HL_ESC[c]);

export function highlightExpr(src) {
  const text = String(src == null ? "" : src);
  const n = text.length;
  let out = "";
  let i = 0;
  let prevSig = "";   // last non-space char — lets us spot a swizzle after '.'
  while (i < n) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") {
      out += hlEsc(c); i++; continue;   // preserve whitespace (incl. newlines) verbatim
    }
    // number
    if ((c >= "0" && c <= "9") || (c === "." && text[i + 1] >= "0" && text[i + 1] <= "9")) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(i));
      const raw = m ? m[0] : c;
      out += `<span class="cm-num">${hlEsc(raw)}</span>`;
      i += raw.length; prevSig = raw[raw.length - 1]; continue;
    }
    // identifier
    if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_") {
      const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i))[0];
      i += id.length;
      let j = i; while (j < n && /\s/.test(text[j])) j++;
      const isCall = text[j] === "(";
      let cls;
      if (prevSig === ".") cls = "cm-swizzle";
      else if (isCall) cls = SHADER_FUNCS[id] ? "cm-fn" : "cm-unknown";
      else cls = SHADER_INPUTS.has(id) ? "cm-input" : "cm-unknown";
      out += `<span class="${cls}">${hlEsc(id)}</span>`;
      prevSig = id[id.length - 1]; continue;
    }
    // allowed punctuation
    if (c === "+" || c === "-" || c === "*" || c === "/" || c === "(" || c === ")" || c === "," || c === ".") {
      out += `<span class="cm-punct">${hlEsc(c)}</span>`;
      i++; prevSig = c; continue;
    }
    // anything else → illegal (shown in the error colour)
    out += `<span class="cm-error">${hlEsc(c)}</span>`;
    i++; prevSig = c;
  }
  return out;
}

// GLSL syntax highlighter for the raw-shader editor (cosmetic; the GL compiler is
// the real gate). Forgiving, HTML-escaping, never throws. Classes add cm-keyword /
// cm-type / cm-comment on top of the shared ones.
const GLSL_KEYWORDS = new Set(["for", "if", "else", "return", "break", "continue", "const", "in", "out", "inout", "void", "struct", "discard", "true", "false", "do", "while", "precision", "uniform", "varying", "attribute"]);
const GLSL_TYPES = new Set(["float", "int", "bool", "vec2", "vec3", "vec4", "mat2", "mat3", "mat4", "ivec2", "ivec3", "ivec4", "bvec2", "bvec3", "bvec4", "sampler2D"]);
const GLSL_BUILTINS = new Set(["radians", "degrees", "sin", "cos", "tan", "asin", "acos", "atan", "pow", "exp", "log", "exp2", "log2", "sqrt", "inversesqrt", "abs", "sign", "floor", "ceil", "fract", "mod", "min", "max", "clamp", "mix", "step", "smoothstep", "length", "distance", "dot", "cross", "normalize", "reflect", "refract", "pal", "hsv", "noise", "fbm", "iqPal", "rainbow", "kaleido"]);

export function highlightGLSL(src) {
  const text = String(src == null ? "" : src);
  const n = text.length;
  let out = "";
  let i = 0;
  let prevSig = "";
  while (i < n) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") { out += hlEsc(c); i++; continue; }
    // comments
    if (c === "/" && text[i + 1] === "/") { let j = i; while (j < n && text[j] !== "\n") j++; out += `<span class="cm-comment">${hlEsc(text.slice(i, j))}</span>`; i = j; continue; }
    if (c === "/" && text[i + 1] === "*") { let j = i + 2; while (j < n && !(text[j] === "*" && text[j + 1] === "/")) j++; j = Math.min(n, j + 2); out += `<span class="cm-comment">${hlEsc(text.slice(i, j))}</span>`; i = j; prevSig = "/"; continue; }
    // number
    if ((c >= "0" && c <= "9") || (c === "." && text[i + 1] >= "0" && text[i + 1] <= "9")) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(i));
      const raw = m ? m[0] : c;
      out += `<span class="cm-num">${hlEsc(raw)}</span>`; i += raw.length; prevSig = raw[raw.length - 1]; continue;
    }
    // identifier
    if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_") {
      const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i))[0];
      i += id.length;
      let j = i; while (j < n && /\s/.test(text[j])) j++;
      const isCall = text[j] === "(";
      let cls;
      if (prevSig === ".") cls = "cm-swizzle";
      else if (GLSL_TYPES.has(id)) cls = "cm-type";
      else if (GLSL_KEYWORDS.has(id)) cls = "cm-keyword";
      else if (isCall && GLSL_BUILTINS.has(id)) cls = "cm-fn";
      else cls = "cm-unknown";
      out += `<span class="${cls}">${hlEsc(id)}</span>`; prevSig = id[id.length - 1]; continue;
    }
    // punctuation (GLSL allows far more than the DSL; none is an "error" here)
    out += `<span class="cm-punct">${hlEsc(c)}</span>`; i++; prevSig = c;
  }
  return out;
}
