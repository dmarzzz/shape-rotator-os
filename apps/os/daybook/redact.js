'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Deterministic redaction scrubber — Invariant I1 + I5.
//
// This is the ONLY place redaction actually happens. It is plain, synchronous
// CODE that runs on the actual outgoing BYTES — never an instruction handed to
// a model. (reflect.js keeps its prompt "HARD SAFETY RULES" only as
// defense-in-depth; the guarantee lives here.) Pure and side-effect-free: no
// fs, no network, no electron, no child_process, no project imports. Imported
// by transcripts.js, reflect.js, and link.js.
//
// It runs at every egress hop (the digest before `claude -p`, the generated
// post after, and the device-link raw path) over the same definitions.
//
// What it does: detects known secret shapes (sk-…, sk-ant-…, ghp_/gho_/ghs_…,
// AWS AKIA…, JWTs, .env-style KEY=value lines, high-entropy tokens), the
// user's always-hide terms, and client-name → "a client" abstractions; masks
// every CONFIDENT match with grey ▮ blocks (or, for client terms, the
// abstraction string); and returns one Finding per match plus a `suspect`
// flag.
//
// Best-effort, said plainly: detection has a false-negative rate. This module
// does NOT and MUST NOT claim completeness. High-entropy / unclassifiable
// secret-shaped content is reported as LOW confidence so callers can render it
// as a "suggested" chip and, when gating a whole unit (collectToday), fail
// CLOSED — HELD out of the digest, surfaced, never silently sent (I5).
// ─────────────────────────────────────────────────────────────────────────

// The single neutral masking glyph the design spec specifies (--mask grey
// blocks, NOT red). All block masks are built from this; the renderer renders
// findings.maskedAs and never reconstructs a mask itself.
const BLOCK = '▮';

// ── MASK ───────────────────────────────────────────────────────────────────
// Builds the visible replacement string for a match. Secret-shaped types keep
// a short recognizable prefix then grey blocks; client abstractions are NOT
// block-masked (handled by the caller passing the abstraction's `to`).
const MASK = {
  token(type, original) {
    const s = String(original == null ? '' : original);
    if (type === 'apiKey') {
      // Keep up to the first 3 chars of the original prefix, then blocks:
      // 'sk-live-…' -> 'sk-▮▮▮▮▮▮', 'ghp_…' -> 'ghp▮▮▮▮▮▮'.
      const prefix = s.slice(0, 3);
      return prefix + BLOCK.repeat(6);
    }
    // Everything else (aws, jwt, envKv, entropy, userTerm) gets a generic
    // block run. Client abstractions never reach here — see redact().
    return BLOCK.repeat(4);
  },
};

// ── entropy helper ───────────────────────────────────────────────────────
// Shannon entropy in bits/char of a string. Used to separate a genuine
// high-entropy token (random key material) from ordinary words/identifiers
// that happen to be long.
function shannonEntropy(s) {
  if (!s) return 0;
  const counts = Object.create(null);
  for (const ch of s) counts[ch] = (counts[ch] || 0) + 1;
  const n = s.length;
  let h = 0;
  for (const k in counts) {
    const p = counts[k] / n;
    h -= p * Math.log2(p);
  }
  return h;
}

// Collect all non-overlapping regex matches as { match, index } records.
function scanRegex(s, re) {
  const out = [];
  // Ensure a fresh, global regex so lastIndex bookkeeping is safe.
  const rx = re.global ? re : new RegExp(re.source, re.flags + 'g');
  rx.lastIndex = 0;
  let m;
  while ((m = rx.exec(s)) !== null) {
    out.push({ match: m[0], index: m.index });
    if (m.index === rx.lastIndex) rx.lastIndex++; // guard against zero-width
  }
  return out;
}

// Escape a user-supplied string for safe use inside a RegExp.
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── DETECTORS ──────────────────────────────────────────────────────────────
// Ordered, read-only detector table. reflect.js's defense-in-depth and the
// tests reference these SAME definitions. Order matters: earlier (more
// specific, higher-confidence) detectors win when matches overlap. The two
// rules-driven detectors (userTerm, client) are folded in dynamically inside
// redact() since they depend on the caller's rules; their definitions appear
// here as static entries with an empty test() so the table documents the full
// type order: apiKey, aws, jwt, envKv, hexSecret, privateKey, entropy,
// userTerm, client.

const DETECTORS = [
  {
    type: 'apiKey',
    label: 'looks like an API key',
    confidence: 'high',
    test(s) {
      const out = [];
      // OpenAI-style (sk-…, sk-ant-…, sk-proj-…) — long enough to be a real key.
      out.push(...scanRegex(s, /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g));
      // GitHub tokens: ghp_, gho_, ghs_, ghu_, ghr_ (PATs/OAuth); github_pat_.
      out.push(...scanRegex(s, /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g));
      out.push(...scanRegex(s, /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g));
      // Slack: bot/user/app/refresh tokens (xoxb-/xoxp-/xoxa-/xoxr-/xoxs-) and
      // app-level tokens (xapp-). They embed hyphens, so allow them in the body.
      out.push(...scanRegex(s, /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g));
      out.push(...scanRegex(s, /\bxapp-[A-Za-z0-9-]{10,}\b/g));
      // Stripe: secret/restricted live+test keys and webhook signing secrets.
      out.push(...scanRegex(s, /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g));
      out.push(...scanRegex(s, /\bwhsec_[A-Za-z0-9]{16,}\b/g));
      // Google API key.
      out.push(...scanRegex(s, /\bAIza[0-9A-Za-z_-]{35}\b/g));
      // GitLab personal access token.
      out.push(...scanRegex(s, /\bglpat-[A-Za-z0-9_-]{20,}\b/g));
      // npm automation token.
      out.push(...scanRegex(s, /\bnpm_[A-Za-z0-9]{36}\b/g));
      return out;
    },
  },
  {
    type: 'aws',
    label: 'looks like an AWS key',
    confidence: 'high',
    test(s) {
      const out = [];
      // AWS access key id: AKIA + 16 uppercase alnum.
      out.push(...scanRegex(s, /\bAKIA[0-9A-Z]{16}\b/g));
      // AWS secret access key: 40-char base64-ish run, typically introduced
      // by an aws_secret… assignment. Match the 40-char token there.
      out.push(...scanRegex(s, /\baws_secret_access_key\s*[=:]\s*["']?([A-Za-z0-9/+]{40})["']?/gi).map((r) => {
        // Narrow the match to the 40-char secret itself for a tight mask.
        const idx = r.match.search(/[A-Za-z0-9/+]{40}\b/);
        if (idx >= 0) return { match: r.match.slice(idx, idx + 40), index: r.index + idx };
        return r;
      }));
      return out;
    },
  },
  {
    type: 'jwt',
    label: 'looks like a JWT',
    confidence: 'high',
    test(s) {
      // Three dot-separated base64url segments; header segment starts "eyJ".
      return scanRegex(s, /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g);
    },
  },
  {
    type: 'envKv',
    label: 'looks like a .env secret',
    confidence: 'high',
    test(s) {
      // .env-style KEY=value lines: UPPER_SNAKE key, then a value. We mask the
      // VALUE only (the key name is itself informative and not a secret), so
      // narrow each line match down to its value run.
      const lines = scanRegex(s, /^[A-Z][A-Z0-9_]{2,}\s*=\s*\S+/gm);
      const out = [];
      for (const r of lines) {
        const eq = r.match.indexOf('=');
        // Value = everything after '=' with surrounding whitespace trimmed.
        const rawVal = r.match.slice(eq + 1);
        const lead = rawVal.length - rawVal.replace(/^\s+/, '').length;
        const val = rawVal.slice(lead).replace(/["']/g, '');
        if (!val) continue;
        const valIdx = r.index + eq + 1 + lead;
        // Strip enclosing quotes from the matched span if present.
        const m = r.match.slice(eq + 1 + lead).match(/^["']?(\S+?)["']?$/);
        const matched = m ? m[1] : val;
        const offset = r.match.slice(eq + 1 + lead).indexOf(matched);
        out.push({ match: matched, index: valIdx + (offset > 0 ? offset : 0) });
      }
      // Case-insensitive secret-KEY heuristic: a key NAME that reads like a
      // credential (password/secret/token/api_key/pwd), in any case, assigned a
      // value — covers `db_password = secret123`, quoted multi-word values, and
      // mixed-case keys the UPPER_SNAKE rule above misses. We mask the full
      // value run to end-of-line (or the closing quote for a quoted value), so
      // a multi-word quoted secret is masked in its entirety. The key + sep are
      // a non-captured prefix so the value's offset within the match is exact.
      // Two value branches: a quoted span (runs to the matching close quote, may
      // contain spaces) OR a bare token (runs to whitespace/end). Group 1 is the
      // quoted value's inner text; group 2 is the bare value.
      const SECRET_KEY = /(?:^|[\s,;{])(?:[\w.-]*?(?:pass(?:word)?|secret|token|api[_-]?key|pwd|access[_-]?key)[\w.-]*)\s*[=:]\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,;}"'][^\s,;}\r\n]*))/gim;
      for (const r of scanRegex(s, SECRET_KEY)) {
        const local = r.match.match(new RegExp(SECRET_KEY.source, 'i'));
        if (!local) continue;
        // Quoted (dq/sq) value's inner text, else the bare value token.
        const quoted = local[1] != null ? local[1] : (local[2] != null ? local[2] : null);
        const valueText = quoted != null ? quoted : (local[3] || '');
        if (!valueText) continue;
        // Locate the value's exact start within the matched run: after the
        // separator, then the value text (which for a quoted value sits right
        // after the opening quote — indexOf finds the inner text directly).
        const sepIdx = r.match.search(/[=:]/);
        if (sepIdx < 0) continue;
        const afterSep = r.match.slice(sepIdx + 1);
        const valIdxInAfter = afterSep.indexOf(valueText);
        if (valIdxInAfter < 0) continue;
        out.push({ match: valueText, index: r.index + sepIdx + 1 + valIdxInAfter });
      }
      return out;
    },
  },
  {
    type: 'hexSecret',
    label: 'looks like a hex secret',
    confidence: 'high',
    test(s) {
      const out = [];
      // Pure-hex secret material (MD5/SHA/hex API keys) sits at ~3.6-3.95
      // bits/char — just UNDER the entropy detector's strict >=4.0 floor — so it
      // would otherwise ship verbatim AND never flip `suspect`. A >=32-char run
      // of [0-9a-fA-F] that carries BOTH a digit and an a-f letter is a
      // high-confidence secret shape (a real hex key mixes both; pure-decimal
      // ids and pure-alpha words are excluded by that requirement).
      for (const r of scanRegex(s, /\b[0-9a-fA-F]{32,}\b/g)) {
        const tok = r.match;
        if (!/[0-9]/.test(tok)) continue; // pure a-f letters: not key material
        if (!/[a-fA-F]/.test(tok)) continue; // pure decimal id: not a hex secret
        out.push(r);
      }
      return out;
    },
  },
  {
    type: 'privateKey',
    label: 'looks like a private key',
    confidence: 'high',
    test(s) {
      // A whole PEM private-key block: BEGIN…END, including the base64 body, so
      // the key material is collapsed to a single mask rather than leaking the
      // body while only the header matched.
      return scanRegex(s, /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g);
    },
  },
  {
    type: 'entropy',
    label: 'high-entropy token',
    confidence: 'low',
    test(s) {
      const out = [];
      // Candidate runs: >=20 chars of base64/hex-ish alphabet. The gate below is
      // deliberately TIGHT — an over-broad entropy match flips `suspect`, which
      // HELDs the WHOLE session (fail-closed, I5), so an ordinary long camelCase
      // identifier or file path used to spuriously hold an otherwise-clean day.
      // We only treat a run as secret-shaped when it carries a genuine random
      // signal and is NOT an ordinary identifier/path. The alphabet keeps '/'
      // and '+' so slash-containing base64 secrets and bare 40-char AWS secret
      // keys are CANDIDATES (they were previously dropped outright).
      for (const r of scanRegex(s, /\b[A-Za-z0-9/+_-]{20,}\b/g)) {
        const tok = r.match;
        // Skip filesystem-path-shaped runs only: a run that starts with '/' or
        // '~' or ends in a known file extension reads as a path, not key
        // material. We no longer drop EVERY run containing '/', so a base64 or
        // AWS secret with embedded '/'/'+' stays a candidate.
        if (/^[/~]/.test(tok)) continue;
        if (/\.(?:js|ts|jsx|tsx|json|md|txt|py|go|rs|java|c|h|cpp|sh|yml|yaml|html|css|png|jpg|jpeg|gif|svg|lock|toml|cfg|env|log)$/i.test(tok)) continue;
        // Require a mixed-class signal: both letters AND digits in the run.
        // Pure-alpha camelCase identifiers and pure-numeric ids no longer trip.
        const hasLetter = /[A-Za-z]/.test(tok);
        const hasDigit = /[0-9]/.test(tok);
        if (!(hasLetter && hasDigit)) continue;
        // Skip dictionary-shaped camelCase / snake identifiers: a run made only
        // of letter-led word segments joined by case boundaries, '_' or '-',
        // with at most a trailing numeric suffix, reads as code, not key
        // material (e.g. getUserByIdV2, my_function_name_2). A real token mixes
        // digits THROUGH the run, so we exclude only the suffix-digit shape.
        // The separator is mandatory ([_-], not [_-]?): each inter-separator
        // letter run then groups exactly one way, which keeps the matched
        // language identical while removing the nested-quantifier ambiguity.
        // With the optional separator a long mixed token forced catastrophic
        // backtracking here (ReDoS) — measured ~1.8s at 53 chars, super-linear.
        const identifierShaped = /^[A-Za-z]+([_-][A-Za-z]+)*[0-9]{0,3}$/.test(tok);
        if (identifierShaped) continue;
        // Raise the entropy floor: genuine random key material sits well above
        // ordinary mixed tokens. 4.0 bits/char keeps real keys, drops prose.
        if (shannonEntropy(tok) >= 4.0) out.push(r);
      }
      return out;
    },
  },
  // userTerm and client are rules-driven; their tests are built per-call in
  // redact() from `rules`. Present here to document the frozen type order.
  {
    type: 'userTerm',
    label: 'your always-hide term',
    confidence: 'high',
    test() { return []; },
  },
  {
    type: 'client',
    label: 'client name',
    confidence: 'high',
    test() { return []; },
  },
];

// Make the exported table read-only (best effort; still a real array for
// callers that iterate it).
Object.freeze(DETECTORS);
for (const d of DETECTORS) Object.freeze(d);

// Build the per-call detector list: the static high-/low-confidence shape
// detectors followed by the rules-driven userTerm and client detectors with
// real tests bound to `rules`.
function detectorsFor(rules) {
  const hide = Array.isArray(rules && rules.hide) ? rules.hide : [];
  const abstractions = Array.isArray(rules && rules.abstractions) ? rules.abstractions : [];

  const userTerm = {
    type: 'userTerm',
    label: 'your always-hide term',
    confidence: 'high',
    test(s) {
      const out = [];
      for (const term of hide) {
        const t = String(term == null ? '' : term).trim();
        if (!t) continue;
        // Word-boundary-ish match: prefer \b when the term is wordy, else an
        // exact substring scan. Case-insensitive.
        const wordy = /^[\w][\w .-]*[\w]$|^[\w]$/.test(t);
        const re = wordy
          ? new RegExp('(?<![\\w])' + escapeRe(t) + '(?![\\w])', 'gi')
          : new RegExp(escapeRe(t), 'gi');
        out.push(...scanRegex(s, re));
      }
      return out;
    },
  };

  const client = {
    type: 'client',
    label: 'client name',
    confidence: 'high',
    test(s) {
      const out = [];
      for (const a of abstractions) {
        const from = String((a && a.from) == null ? '' : a.from).trim();
        if (!from) continue;
        const wordy = /^[\w][\w .-]*[\w]$|^[\w]$/.test(from);
        const re = wordy
          ? new RegExp('(?<![\\w])' + escapeRe(from) + '(?![\\w])', 'gi')
          : new RegExp(escapeRe(from), 'gi');
        for (const r of scanRegex(s, re)) {
          // Carry the abstraction's `to` so redact() can substitute it.
          out.push(Object.assign({}, r, { to: String((a && a.to) == null ? '' : a.to) }));
        }
      }
      return out;
    },
  };

  // All static (shape) detectors in declared order, then the rules-driven
  // userTerm + client detectors bound above. Deriving the static list (rather
  // than hardcoding indices) keeps this correct as detectors are added/removed.
  const staticDetectors = DETECTORS.filter((d) => d.type !== 'userTerm' && d.type !== 'client');
  return [...staticDetectors, userTerm, client];
}

// Stable, deterministic short id for a finding (no Date.now / randomness):
// 'f-' + short hash of type+original+index. Same input → same id within a
// pass, which is what redaction:reveal relies on.
function findingId(type, original, index) {
  const str = String(type) + ' ' + String(original) + ' ' + String(index);
  // FNV-1a 32-bit.
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return 'f-' + h.toString(16).padStart(6, '0').slice(-6);
}

// ── redact ───────────────────────────────────────────────────────────────
// Pure deterministic pass over one string. Never throws on any input.
function redact(text, rules, options) {
  const src = typeof text === 'string' ? text : (text == null ? '' : String(text));
  const source = (options && typeof options.source === 'string') ? options.source : '';

  if (!src) return { masked: '', findings: [], suspect: false };

  const detectors = detectorsFor(rules);

  // The set of client-abstraction outputs ("to" strings). A by-design feature
  // is that redact() runs MULTIPLE times over the same text (digest scrub #1,
  // post scrub #2, and the final post-handler re-scrub). Client substitutions
  // emit VERBATIM text (not glyphs), so the all-glyph idempotency guard below
  // does not protect them: a second pass would otherwise re-detect the
  // substituted output (e.g. {from:'client', to:'a client'} turning 'a client'
  // into 'a ▮▮▮▮', or growing 'client'→'client partner'→'client partner
  // partner'). We therefore skip any candidate span whose matched text exactly
  // equals an abstraction's `to` value, making the substitution a true no-op on
  // subsequent passes. Compared case-insensitively to mirror how the client and
  // userTerm detectors match.
  const abstractionOutputs = new Set();
  const absList = Array.isArray(rules && rules.abstractions) ? rules.abstractions : [];
  for (const a of absList) {
    const to = String((a && a.to) == null ? '' : a.to).trim();
    if (to) abstractionOutputs.add(to.toLowerCase());
  }
  // Byte ranges in `src` already occupied by an abstraction output, so neither
  // a re-detecting client `from`-match (e.g. 'client' inside an existing
  // 'a client') nor a secret-shape detector can re-substitute inside them on a
  // later pass. Collected case-insensitively over each distinct `to` string.
  const protectedRanges = [];
  for (const a of absList) {
    const to = String((a && a.to) == null ? '' : a.to);
    if (!to.trim()) continue;
    for (const r of scanRegex(typeof text === 'string' ? text : (text == null ? '' : String(text)),
        new RegExp(escapeRe(to), 'gi'))) {
      protectedRanges.push({ start: r.index, end: r.index + r.match.length });
    }
  }
  const inProtectedRange = (start, end) => {
    for (const pr of protectedRanges) { if (start < pr.end && pr.start < end) return true; }
    return false;
  };

  // Gather every candidate match across all detectors as raw spans, tagged
  // with their detector so we can resolve overlaps by detector precedence.
  const spans = [];
  for (let d = 0; d < detectors.length; d++) {
    const det = detectors[d];
    let hits;
    try { hits = det.test(src) || []; } catch { hits = []; }
    for (const h of hits) {
      const matchStr = String(h.match == null ? '' : h.match);
      if (!matchStr) continue;
      // Idempotency: skip content that is already entirely mask glyphs, so a
      // re-scrub of masked output (e.g. reflect.js scrub #1 -> scrub #2 over an
      // already-redacted digest) produces no new findings and never re-masks a
      // mask. Only client substitutions (which emit verbatim text, not glyphs)
      // are unaffected.
      if (matchStr.indexOf(BLOCK) >= 0 && matchStr.replace(new RegExp(BLOCK, 'g'), '') === '') continue;
      const index = typeof h.index === 'number' ? h.index : src.indexOf(matchStr);
      if (index < 0) continue;
      // Idempotency for client abstractions: a re-scrub must not re-substitute
      // inside text an earlier pass already produced. Skip any candidate (a
      // client `from` re-matched inside an existing 'a client', a different
      // rule, or a secret-shape detector) that overlaps a byte range already
      // occupied by an abstraction output. This makes the multi-pass design
      // (digest scrub #1, post scrub #2, post-handler re-scrub) a true no-op on
      // already-substituted client text instead of corrupting/growing it.
      if (abstractionOutputs.size && inProtectedRange(index, index + matchStr.length)) continue;
      spans.push({
        order: d,
        type: det.type,
        confidence: det.confidence,
        label: det.label,
        start: index,
        end: index + matchStr.length,
        original: matchStr,
        to: h.to, // present only for client
      });
    }
  }

  // Resolve overlaps: earlier detector order wins; for equal order, the longer
  // match wins, then earliest start. We keep a non-overlapping set so a single
  // byte range is masked once with the most specific detector.
  spans.sort((a, b) => (a.start - b.start) || (a.order - b.order) || (b.end - a.end));
  const chosen = [];
  for (const sp of spans) {
    let conflict = false;
    for (const c of chosen) {
      if (sp.start < c.end && c.start < sp.end) { // overlap
        // Keep whichever has lower detector order; if same, longer; this set
        // is already ordered by start so the existing `c` generally wins.
        if (sp.order < c.order || (sp.order === c.order && (sp.end - sp.start) > (c.end - c.start))) {
          // The new span is more specific — but to keep things simple and
          // deterministic we only replace if it fully covers c.
          if (sp.start <= c.start && sp.end >= c.end) {
            c._replaced = true;
            continue;
          }
        }
        conflict = true;
        break;
      }
    }
    if (!conflict) chosen.push(sp);
  }
  const finalSpans = chosen.filter((c) => !c._replaced).sort((a, b) => a.start - b.start);

  // Build masked output left-to-right and emit one Finding per chosen span.
  let masked = '';
  let cursor = 0;
  const findings = [];
  let suspect = false;

  for (const sp of finalSpans) {
    if (sp.start < cursor) continue; // safety: skip any residual overlap
    masked += src.slice(cursor, sp.start);

    let maskedAs;
    if (sp.type === 'client') {
      // Client abstractions substitute the `to` string verbatim — NOT blocked.
      maskedAs = sp.to != null ? String(sp.to) : 'a client';
    } else {
      maskedAs = MASK.token(sp.type, sp.original);
    }

    masked += maskedAs;
    cursor = sp.end;

    findings.push({
      id: findingId(sp.type, sp.original, sp.start),
      type: sp.type,
      source,
      original: sp.original,
      maskedAs,
      confidence: sp.confidence,
    });

    // I5: a low-confidence secret-shaped match (entropy / unknown) the detector
    // could not classify with auto-mask confidence makes the whole unit
    // suspect, so a caller gating collectToday can fail closed / HELD.
    if (sp.confidence === 'low' && (sp.type === 'entropy' || sp.type === 'unknown')) {
      suspect = true;
    }
  }
  masked += src.slice(cursor);

  return { masked, findings, suspect };
}

module.exports = {
  redact,
  DETECTORS,
  MASK,
};
