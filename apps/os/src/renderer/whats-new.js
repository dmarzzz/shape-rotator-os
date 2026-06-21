// whats-new.js — unread state for the operating-system rail.
//
// Philosophy mirrors atlas.js's "PR C" snapshot diff: keep a per-page
// fingerprint of the cohort content the user has SEEN; a page whose
// current content carries records that aren't in that seen set is
// "unread". Indication is a numbered circle in the rail gutter left of
// the page icon — the count of new/changed records — which clears once
// the page is actually viewed.
//
// Mechanics:
//   - MODE_SOURCES maps each rail mode to the cohort-surface lists it
//     renders. Modes that don't render cohort records (membrane,
//     profile, intel, onboarding) carry no unread state. Calendar and
//     context don't appear here either — their pages render content
//     that isn't a surface record list (the phala calendar grid, the
//     vault article index), so they use the generic fingerprint
//     channel below (see calendarFingerprints / contextVaultFingerprints
//     in alchemy.js).
//   - A record's fingerprint is `record_id:fnv1a(stable-json)`. For
//     people we strip the fields gh-user.js enrichment writes in place
//     (name / geo / links.website / links.x) so a background GitHub
//     enrichment can't masquerade as new content.
//   - Unread = the current fingerprint set contains an entry the seen
//     set doesn't (additions and edits). Deletions alone never light
//     up — there's nothing new to look at.
//   - First sighting of a mode (nothing stored) primes silently: store
//     the current set, show nothing. Same "no comparison point" rule
//     the atlas applies when lastSeenAt is 0.
//
// Storage: localStorage srwk:whatsnew:seen_v2 → { [mode]: ["id:hash"] }
// (v1 baselines were poisoned by the Date-vs-ISO-string hashing bug below —
// the key bump re-primes everything silently instead of flooding badges.)

const LS_KEY = "srwk:whatsnew:seen_v2";

const MODE_SOURCES = {
  shapes:   ["teams", "people", "clusters"],
  asks:     ["asks"],
  program:  ["program"],
};

function fnv1a(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// Deterministic JSON: keys sorted recursively, underscore-prefixed keys
// (build/runtime carry-throughs like _sig) and undefined values skipped —
// so fixture, in-browser GH build, and sync overlay hash identically
// when the content is the same.
function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  // js-yaml (live GitHub load) parses ISO dates into Date objects, while
  // the fixture/localStorage forms of the SAME record carry ISO strings.
  // A Date has no enumerable keys, so without this branch it serialized
  // as "{}" — making every record with dates_* / absences hash different
  // between the two shapes, which lit the cohort badge on every source
  // flip (each launch/update). JSON.stringify(Date) yields the quoted
  // ISO string, identical to the serialized form.
  if (v instanceof Date) return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v).filter(k => !k.startsWith("_") && v[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}

function fingerprintRecord(listKey, r) {
  let v = r;
  if (listKey === "people") {
    const links = { ...(r.links || {}) };
    delete links.website;
    delete links.x;
    v = { ...r, links };
    delete v.name;
    delete v.geo;
  }
  return `${r.record_id}:${fnv1a(stableStringify(v))}`;
}

// Current fingerprint set for a mode, or null when the mode is unmapped
// or the surface is unavailable. Mapped empty modes return [] so the
// first later record is counted as unread instead of silently becoming
// the new baseline.
function setForMode(mode, surface) {
  const lists = MODE_SOURCES[mode];
  if (!lists || !surface) return null;
  const out = [];
  for (const key of lists) {
    for (const r of (surface[key] || [])) {
      if (r && r.record_id) out.push(fingerprintRecord(key, r));
    }
  }
  return out.sort();
}

function loadSeen() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return (v && typeof v === "object") ? v : {};
  } catch { return {}; }
}
function saveSeen(seen) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(seen)); } catch {}
}

/**
 * Per-mode count of records newer than what the user has seen — only
 * modes with new content appear ({ mode: count }).
 * Side effect: primes the baseline for any mode seen for the first time.
 */
export function unreadCounts(surface) {
  const seen = loadSeen();
  const out = {};
  let primed = false;
  for (const mode of Object.keys(MODE_SOURCES)) {
    const cur = setForMode(mode, surface);
    if (!cur) continue;
    const prev = seen[mode];
    if (!Array.isArray(prev)) {
      seen[mode] = cur;
      primed = true;
      continue;
    }
    const prevSet = new Set(prev);
    const n = cur.filter(fp => !prevSet.has(fp)).length;
    if (n > 0) out[mode] = n;
  }
  if (primed) saveSeen(seen);
  return out;
}

/** The user is looking at `mode` right now — its current content is seen. */
export function markModeSeen(mode, surface) {
  const cur = setForMode(mode, surface);
  if (!cur) return;
  const seen = loadSeen();
  const prev = Array.isArray(seen[mode]) ? seen[mode] : null;
  if (prev && prev.length === cur.length && prev.join("|") === cur.join("|")) return;
  seen[mode] = cur;
  saveSeen(seen);
}

// ── generic fingerprint channels ─────────────────────────────────────
// For content that doesn't live on the cohort surface (e.g. the context
// vault's article index). Callers build fingerprints with
// fingerprintItems() and use the same prime-silently / unread / seen
// semantics as the surface modes above.

/** `id:hash` fingerprints for an arbitrary list of records. */
export function fingerprintItems(items) {
  const out = [];
  for (const r of (items || [])) {
    const id = r?.record_id || r?.id;
    if (id) out.push(`${id}:${fnv1a(stableStringify(r))}`);
  }
  return out.sort();
}

/** Count of entries in `fps` the user hasn't seen for `mode`. Primes silently on first sight. */
export function unreadCountForFingerprints(mode, fps) {
  if (!Array.isArray(fps) || !fps.length) return 0;
  const cur = [...fps].sort();
  const seen = loadSeen();
  if (!Array.isArray(seen[mode])) {
    seen[mode] = cur;
    saveSeen(seen);
    return 0;
  }
  const prevSet = new Set(seen[mode]);
  return cur.filter(fp => !prevSet.has(fp)).length;
}

/** The user is looking at `mode` right now — its current content is seen. */
export function markFingerprintsSeen(mode, fps) {
  if (!Array.isArray(fps) || !fps.length) return;
  const cur = [...fps].sort();
  const seen = loadSeen();
  const prev = Array.isArray(seen[mode]) ? seen[mode] : null;
  if (prev && prev.length === cur.length && prev.join("|") === cur.join("|")) return;
  seen[mode] = cur;
  saveSeen(seen);
}
