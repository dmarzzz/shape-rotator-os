// Shareable deep-links — sros://xxxxx
// ---------------------------------------------------------------------------
// Two forms of the same 5-character base36 code:
//   • sros://xxxxx              — the OS protocol the app registers + receives.
//   • https://<WEB_BASE>xxxxx   — the human-shareable link. Chat/email/notes
//       apps only auto-linkify http(s), never custom schemes, so the copy
//       action emits this https link. A tiny redirect page at WEB_BASE bounces
//       the browser into sros://xxxxx (see apps/web/s.html).
// Either way the code never leaks a page title or content.
//
// A code is hash5(canonicalKey): a deterministic hash of a STABLE identifier —
// a view's internal structural id, or a record's `record_id` slug — NEVER its
// display name / content. That is the durability guarantee: renaming a page or
// rewriting its card does not change its link, because we only ever hash the
// stable key (see cohort-data/*.md frontmatter `record_id`, which is decoupled
// from `name`).
//
//   ⚠ FROZEN WIRE FORMAT ⚠
//   `hash5` and the canonical-key strings below are a wire format. Once shipped
//   they must NOT change — altering either reassigns every code and silently
//   breaks links people have already shared. To rename an internal view id,
//   add an entry to VIEW_ALIASES (old canonical key → current key) instead, so
//   historical codes keep resolving.
//
// Pairs with main.js (sros:// protocol registration + open-url/second-instance)
// and boot.js (applyDeepLink / copyShareLink / buildLinkIndex). The renderer
// applies an incoming link by routing the parsed snapshot through the existing
// navApplyLocation() path.

export const DEEPLINK_SCHEME = "sros";

// Base for the human-shareable https link. The redirect page lives at
// `<WEB_BASE><code>` and bounces into `sros://<code>`. Must point at a host that
// actually serves apps/web/s.html (see that file). Keep the trailing slash.
export const WEB_BASE = "https://os-web.shaperotator.xyz/s/";

// ── the fixed view universe ────────────────────────────────────────────────
// Mirrors boot.js (TOP_TABS / APPS_VIEWS / NET_SUBS) and alchemy.js
// (ALCHEMY_MODES / constellation lenses / context views). Keep in sync; the
// uniqueness assert in buildLinkIndex() flags any future clash.
const TABS         = ["alchemy", "apps", "network", "links", "matrix"];
const APPS_VIEWS   = ["atlas", "easel"];                 // "" → apps grid
const NET_SUBS     = ["network", "metrics"];
const ALCH_MODES   = ["membrane", "shapes", "constellation", "calendar", "mirror", "profile", "program", "asks", "context", "activity"];
const CONST_LENSES = ["map", "ring", "journey", "stack", "targets", "collab"];
const CTX_VIEWS    = ["articles", "raw", "evidence"];

// Append-only: old canonical view key → current canonical view key. Lets a
// historical code keep resolving if we ever rename an internal view id. Empty
// at launch.
const VIEW_ALIASES = {
  "alchemy/activity": "alchemy/context/activity",
  "alchemy/asks": "alchemy/context/activity",
  "alchemy/context/asks": "alchemy/context/activity",
  "alchemy/onboarding": "alchemy/program/onboarding",
  "alchemy/constellation/shipped": "alchemy/mirror",
  "alchemy/intel": "alchemy/context/evidence",
  "alchemy/context/intel": "alchemy/context/evidence",
  "alchemy/context/signals": "alchemy/context/evidence",
  "alchemy/context/data": "alchemy/context/evidence",
  "alchemy/context/cards": "alchemy/context/evidence",
  "alchemy/context/transcript": "alchemy/context/raw",
  "alchemy/context/transcripts": "alchemy/context/raw",
};

const RADIX = 36;
const CODE_LEN = 5;
const CODE_SPACE = Math.pow(RADIX, CODE_LEN); // 36^5 = 60,466,176

// cyrb53 → fold into the 5-char base36 code space. Deterministic across
// machines and runs. Frozen (see header).
function hash5(str) {
  const s = String(str);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0); // 53-bit unsigned
  return (n % CODE_SPACE).toString(RADIX).padStart(CODE_LEN, "0");
}

function canonicalContextView(raw) {
  const v = String(raw || "").toLowerCase();
  if (v === "article") return "articles";
  if (v === "transcript" || v === "transcripts") return "raw";
  if (v === "card" || v === "cards" || v === "intel" || v === "signals" || v === "data") return "evidence";
  if (v === "ask" || v === "asks" || v === "activity") return "activity";
  return CTX_VIEWS.includes(v) ? v : "";
}

// Snapshot (from boot.js navSnapshot) → canonical view string. Structural ids
// only; record selection is handled separately. `program` usually collapses
// to the mode level; onboarding is the stable synthetic Program subview.
function canonicalView(snap) {
  const s = snap || {};
  const tab = TABS.includes(s.tab) ? s.tab : "alchemy";
  if (tab === "apps") {
    return "apps/" + (APPS_VIEWS.includes(s.appsView) ? s.appsView : "grid");
  }
  if (tab === "network") {
    return "network/" + (NET_SUBS.includes(s.netSub) ? s.netSub : "network");
  }
  if (tab === "alchemy") {
    if (s.alchMode === "onboarding") return "alchemy/program/onboarding";
    const mode = ALCH_MODES.includes(s.alchMode) ? s.alchMode : "membrane";
    if (mode === "asks" || mode === "activity") return "alchemy/context/activity";
    if (mode === "constellation" && String(s.constMode || "").toLowerCase() === "shipped") {
      return "alchemy/mirror";
    }
    if (mode === "constellation") {
      return "alchemy/constellation" + (CONST_LENSES.includes(s.constMode) ? "/" + s.constMode : "");
    }
    if (mode === "context") {
      const ctxView = canonicalContextView(s.ctxView);
      return "alchemy/context" + (ctxView ? "/" + ctxView : "");
    }
    if (mode === "program" && String(s.programPage || "").toLowerCase() === "onboarding") {
      return "alchemy/program/onboarding";
    }
    return "alchemy/" + mode;
  }
  return tab; // links, matrix
}

// Every distinct view-state + the snapshot navApplyLocation() needs to restore
// it. canonicalView(snap) is guaranteed to return one of these keys, so a code
// produced by serializeLocation always resolves in parseLocation.
function enumerateViews() {
  const out = [];
  const push = (key, snap) => out.push({ key, snap });

  for (const mode of ["membrane", "shapes", "calendar", "mirror", "profile", "program"]) {
    push("alchemy/" + mode, { tab: "alchemy", alchMode: mode });
  }
  push("alchemy/program/onboarding", { tab: "alchemy", alchMode: "program", programPage: "onboarding" });
  push("alchemy/constellation", { tab: "alchemy", alchMode: "constellation" });
  for (const lens of CONST_LENSES) push("alchemy/constellation/" + lens, { tab: "alchemy", alchMode: "constellation", constMode: lens });
  push("alchemy/context", { tab: "alchemy", alchMode: "context" });
  for (const v of CTX_VIEWS) push("alchemy/context/" + v, { tab: "alchemy", alchMode: "context", ctxView: v });
  push("alchemy/context/activity", { tab: "alchemy", alchMode: "activity" });

  push("apps/grid", { tab: "apps", appsView: "" });
  for (const a of APPS_VIEWS) push("apps/" + a, { tab: "apps", appsView: a });

  for (const sub of NET_SUBS) push("network/" + sub, { tab: "network", netSub: sub });

  push("links", { tab: "links" });
  push("matrix", { tab: "matrix" });
  return out;
}

// code → snapshot. Rebuilt by buildLinkIndex when records load.
let _reverse = new Map();

// Build/refresh the reverse index. Views are added first and asserted unique
// (the no-duplicate guarantee for the fixed set). Records are hashed from their
// record_id; on the rare hash collision the first target wins and we warn.
export function buildLinkIndex(recordIds) {
  const next = new Map();
  const views = enumerateViews();

  const viewCodes = new Set();
  for (const { key, snap } of views) {
    const code = hash5("v:" + key);
    if (viewCodes.has(code)) {
      console.error(`[share-link] view code collision for "${key}" (${code}) — change its canonical key`);
      continue; // keep the first view (matches the record branch); don't silently overwrite
    }
    viewCodes.add(code);
    next.set(code, snap);
  }
  for (const [oldKey, curKey] of Object.entries(VIEW_ALIASES)) {
    const cur = views.find((v) => v.key === curKey);
    if (cur) next.set(hash5("v:" + oldKey), cur.snap);
  }

  let recordCount = 0;
  for (const id of recordIds || []) {
    const rid = id && String(id).trim();
    if (!rid) continue;
    const code = hash5("r:" + rid);
    if (next.has(code)) {
      console.warn(`[share-link] code collision: record "${rid}" (${code}) clashes with an existing target — keeping the first`);
      continue;
    }
    next.set(code, { tab: "alchemy", alchMode: "shapes", recordId: rid });
    recordCount++;
  }

  _reverse = next;
  return { views: views.length, records: recordCount, total: _reverse.size };
}

// Snapshot → human-shareable https link. A record selection encodes the record;
// otherwise the view-state. Pure (does not depend on the index).
export function serializeLocation(snap) {
  const s = snap || {};
  const code = s.recordId
    ? hash5("r:" + String(s.recordId))
    : hash5("v:" + canonicalView(s));
  return WEB_BASE + code;
}

// Pull the 5-char code out of either form: sros://xxxxx (what the OS delivers)
// or https://<host>/s/xxxxx (the shareable link, if pasted directly). Returns
// the raw code string or null.
function extractCode(url) {
  if (typeof url !== "string") return null;
  const t = url.trim();
  const lc = t.toLowerCase();
  if (lc.startsWith(DEEPLINK_SCHEME + "://")) {
    return t.slice((DEEPLINK_SCHEME + "://").length).split(/[/?#]/)[0];
  }
  if (lc.startsWith("http://") || lc.startsWith("https://")) {
    const m = t.match(/\/s\/([0-9a-z]{5})(?:[/?#]|$)/i);
    if (m) return m[1];
  }
  return null;
}

// Link → snapshot | null. Accepts both forms; tolerates trailing slash / query
// / case. Unknown, malformed, or foreign links return null (caller no-ops).
export function parseLocation(url) {
  const raw = extractCode(url);
  if (!raw) return null;
  const code = raw.trim().toLowerCase();
  if (!/^[0-9a-z]{5}$/.test(code)) return null;
  const target = _reverse.get(code);
  return target ? { ...target } : null;
}
