// gh-user.js — auto-populate cohort person records from GitHub.
//
// When a person record has `links.github` set but their other surface
// fields are empty (name, geo, links.website, links.x), we fetch
// https://api.github.com/users/<handle> in the background and stamp
// the missing values onto the in-memory record. The .md on disk is
// unchanged — this is purely renderer-side enrichment, so a "PR your
// github handle" gets you 80% of a populated profile for free.
//
// Constraints:
//   - Unauthenticated GitHub API: 60 req/hr per IP. Cache aggressively.
//   - CSP already allows api.github.com (see index.html).
//   - Avatars are already handled separately in identity.js via the
//     `github.com/<handle>.png` redirect; this module is for the
//     text fields only.

const CACHE_KEY = "srfg:gh_user_cache_v1";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;   // 24 hours
// 404s + rate-limit errors get a SHORTER TTL so a typo doesn't wedge
// us for 24h, and a rate-limit window (1hr) is enough to recover.
const CACHE_NEG_TTL_MS = 60 * 60 * 1000;    // 1 hour

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return (obj && typeof obj === "object") ? obj : {};
  } catch { return {}; }
}
function saveCache(map) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(map || {})); } catch {}
}
function readCached(handle) {
  const cache = loadCache();
  const entry = cache[handle.toLowerCase()];
  if (!entry) return undefined;
  const ttl = entry.ok ? CACHE_TTL_MS : CACHE_NEG_TTL_MS;
  if (Date.now() - entry.fetched_at > ttl) return undefined;
  return entry;
}
function writeCached(handle, entry) {
  const cache = loadCache();
  cache[handle.toLowerCase()] = { ...entry, fetched_at: Date.now() };
  saveCache(cache);
}

// ── single fetch ────────────────────────────────────────────────────
//
// Returns `{ ok: true, data: {name, bio, location, blog,
// twitter_username} }` on hit, `{ ok: false }` on 404 / network /
// rate-limit. Cached result short-circuits the network call entirely.

// Normalize handles: cohort .md files have stored `links.github` in a
// few shapes — bare username ("amiller"), URL ("https://github.com/
// amiller"), or with a leading @ ("@amiller"). Strip everything down
// to the bare username before hitting the API.
function normalizeHandle(raw) {
  if (!raw) return "";
  let s = String(raw).trim();
  s = s.replace(/^@+/, "");
  // Pull the last path segment out of a URL-ish value.
  const m = s.match(/github\.com\/([^/?#]+)/i);
  if (m) s = m[1];
  // Strip any trailing path/query/fragment that snuck through.
  s = s.split(/[/?#]/)[0];
  return s;
}

async function fetchOne(handle) {
  handle = normalizeHandle(handle);
  if (!handle) return { ok: false, status: 0, error: "empty handle" };
  const cached = readCached(handle);
  if (cached !== undefined) return cached;
  try {
    const r = await fetch(
      `https://api.github.com/users/${encodeURIComponent(handle)}`,
      { headers: { Accept: "application/vnd.github+json" } }
    );
    if (r.status === 200) {
      const raw = await r.json();
      const data = {
        name: raw.name || null,
        bio: raw.bio || null,
        location: raw.location || null,
        blog: raw.blog || null,
        twitter_username: raw.twitter_username || null,
      };
      const entry = { ok: true, data };
      writeCached(handle, entry);
      return entry;
    }
    // 404 / 403-ratelimit / other → cache the miss so we don't hammer.
    const entry = { ok: false, status: r.status };
    writeCached(handle, entry);
    return entry;
  } catch (e) {
    const entry = { ok: false, status: 0, error: e?.message || String(e) };
    writeCached(handle, entry);
    return entry;
  }
}

// ── batch enrichment ────────────────────────────────────────────────
//
// `enrichPeople(people)` mutates each person record in-place: empty
// frontmatter fields are filled from cached GitHub data. The actual
// network fetches are scheduled on a background pump with jitter so
// a cohort of ~50 doesn't burst-call the API on cold cache.
//
// `onUpdate` is fired whenever a record is mutated so the caller can
// trigger a re-render. Debounce it on the caller side.

const _inflight = new Set();   // handles currently being fetched

function applyToRecord(person, entry) {
  if (!entry?.ok) return false;
  const d = entry.data || {};
  let touched = false;
  const setIfEmpty = (path, value) => {
    if (value == null || value === "") return;
    const segs = path.split(".");
    let cur = person;
    for (let i = 0; i < segs.length - 1; i++) {
      if (cur[segs[i]] == null) cur[segs[i]] = {};
      cur = cur[segs[i]];
    }
    const k = segs[segs.length - 1];
    const existing = cur[k];
    if (existing == null || existing === "") {
      cur[k] = value;
      touched = true;
    }
  };
  setIfEmpty("name", d.name);
  setIfEmpty("geo", d.location);
  setIfEmpty("links.website", d.blog ? normalizeUrl(d.blog) : null);
  setIfEmpty("links.x", d.twitter_username);
  return touched;
}

// GitHub's `blog` field can be either a bare domain ("dmarz.xyz") or
// a full URL ("https://dmarz.xyz"). Keep the raw value — alchemy.js
// already wraps these for display.
function normalizeUrl(s) {
  if (!s) return null;
  return String(s).trim();
}

export function enrichPeople(people, { onUpdate } = {}) {
  if (!Array.isArray(people)) return;
  // First pass: apply any cached entries synchronously so the first
  // paint after cohort-load already has the data we know.
  let touchedAny = false;
  for (const p of people) {
    const handle = normalizeHandle(p?.links?.github);
    if (!handle) continue;
    const cached = readCached(handle);
    if (cached) {
      if (applyToRecord(p, cached)) touchedAny = true;
    }
  }
  if (touchedAny && typeof onUpdate === "function") onUpdate();

  // Second pass: schedule network fetches for handles we don't have
  // cached. Sequential with 250ms jitter so a cold cache + 50 people
  // takes ~12s in the background but doesn't burst-fire the API.
  const todo = people
    .map(p => normalizeHandle(p?.links?.github))
    .filter(h => h && !_inflight.has(h) && readCached(h) === undefined);
  if (todo.length === 0) return;

  (async () => {
    for (const handle of todo) {
      _inflight.add(handle);
      const entry = await fetchOne(handle);
      _inflight.delete(handle);
      // Find the record again (handle in record may be unnormalized;
      // compare via normalizeHandle so URL/@-prefixed variants match).
      const person = people.find(p => normalizeHandle(p?.links?.github) === handle);
      if (person && applyToRecord(person, entry)) {
        if (typeof onUpdate === "function") onUpdate();
      }
      // Light backoff — even at 50 people, 250ms × 50 = 12.5s. Worst
      // case GitHub 60/hr unauth rate-limit budget is 1 req/min, so
      // we're well under that.
      await new Promise(r => setTimeout(r, 250));
    }
  })();
}

// Public helper for the editor / skill / debug commands: clear the
// cache for a specific handle (or everything) so the next render
// re-fetches fresh data.
export function clearGithubUserCache(handle) {
  if (!handle) {
    try { localStorage.removeItem(CACHE_KEY); } catch {}
    return;
  }
  const cache = loadCache();
  delete cache[handle.toLowerCase()];
  saveCache(cache);
}
