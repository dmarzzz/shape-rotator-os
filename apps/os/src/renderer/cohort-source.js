// cohort-source.js — the SOLE entry point for cohort data into the
// Shape Rotator OS. Per docs/SHAPE-ROTATOR-OS-SPEC.md §4.5.
//
// Phase 5 (current): reads cohort-data/*.md DIRECTLY from GitHub `main`
// and builds the surface object in-browser. Mirrors what
// scripts/build-bundles.js does in Node — same parse, same whitelist,
// same shape. The advantage: a PR that adds a cohort-data/asks/foo.md
// (or any record) propagates on the next refresh tick without anyone
// running `npm run build:cohort`. The bundled cohort-surface.json file
// stays around as a pure offline fallback.
//
// Phase 4 (retired): used to fetch the baked apps/os/src/cohort-
// surface.json from main, which required a build step on every merge.
//
// Phase 2 sync (new): when the bundled swf-node is reachable, we layer
// its /sync/manifest records on top of the cohort-data/*.md baseline.
// Sync records WIN (they're the live LWW view; cohort-data/*.md is the
// seed). Refresh tick switches from 5 minutes (github-only) to 30 seconds
// when sync is live so a profile edit on a peer machine shows up within
// one sync cycle instead of within five minutes.
//
// A lightweight polling refresh keeps long-running sessions fresh:
// every REFRESH_MS we re-fetch and, if anything changed, notify
// subscribers so the views can re-render.

import yaml from "js-yaml";
import { getManifest, getRecord } from "./sync-client.js";

const GH_REPO     = "dmarzzz/shape-rotator-os";
const GH_BRANCH   = "main";
const GH_RAW_BASE = `https://raw.githubusercontent.com/${GH_REPO}/${GH_BRANCH}`;
const GH_TREE_API = `https://api.github.com/repos/${GH_REPO}/git/trees/${GH_BRANCH}?recursive=1`;
const GH_COMMITS_API = `https://api.github.com/repos/${GH_REPO}/commits`;
// Renderer tick cadence for the swf-node sync overlay. swf-node is on
// localhost and carries the live signal — keep this at 30s so a peer's
// edit shows up within one tick.
const SYNC_REFRESH_MS = 30 * 1000;
// Renderer tick cadence when swf-node is unreachable — we fall back to
// the GH baseline alone, so this is also how often we re-pull from GH.
// In this mode there's no live channel, so we still want to look at
// github periodically (just not in the 5-min hot loop we used to run).
const REFRESH_MS  = 60 * 60 * 1000;
// Minimum gap between two api.github.com tree/raw fetches. P2P sync
// carries fresh records between peers in seconds; GitHub only needs to
// be re-pulled rarely (new cohort members, schema bumps, calendar bundle
// changes). The unauthenticated GH API budget is 60 req/hr per IP, so
// at one tree fetch + ~50 commit lookups per refresh, more than one
// per hour from a single LAN saturates the bucket fast.
const GH_BASELINE_MIN_GAP_MS = 60 * 60 * 1000;

// Cohort-data directory → record_type → output list key. Mirrors
// scripts/build-bundles.js so the in-browser build matches the bundled
// fixture's shape exactly. Program pages are special-cased below.
const RECORD_DIRS = [
  { prefix: "cohort-data/teams/",    record_type: "team",    list_key: "teams" },
  { prefix: "cohort-data/people/",   record_type: "person",  list_key: "people" },
  { prefix: "cohort-data/clusters/", record_type: "cluster", list_key: "clusters" },
  { prefix: "cohort-data/dependencies/", record_type: "dependency", list_key: "dependencies" },
  { prefix: "cohort-data/events/",   record_type: "event",   list_key: "events" },
  { prefix: "cohort-data/asks/",     record_type: "ask",     list_key: "asks" },
];
const PROGRAM_PREFIX = "cohort-data/program/";

let _cache = null;            // grouped by record_type (baseline merged with sync overlay)
// The GH-only baseline result, kept separately so sync-overlay refresh
// ticks can re-merge without paying for a new tree+raw fetch every time.
// Refreshed at most once per GH_BASELINE_MIN_GAP_MS, or immediately on
// refreshCohortFromGithub().
let _baseline = null;
let _baselineFetchedAt = 0;
let _refreshTimer = null;
let _bgRefreshInFlight = null; // promise of any active background refresh
const _subscribers = new Set();
// Separate channel for sync lifecycle. Subscribers receive
// "syncing" when a background refresh starts and "idle" when it ends —
// independent of whether data actually changed. The UI uses this to
// paint the small Notion-style "syncing cohort" chip at the bottom.
const _syncSubscribers = new Set();
let _syncState = "idle";
function _emitSyncState(next) {
  if (next === _syncState) return;
  _syncState = next;
  for (const cb of _syncSubscribers) {
    try { cb(next); } catch {}
  }
}
export function subscribeToSyncState(cb) {
  _syncSubscribers.add(cb);
  // Replay current state so the subscriber paints correctly on mount.
  try { cb(_syncState); } catch {}
  return () => _syncSubscribers.delete(cb);
}
export function getSyncState() { return _syncState; }

// Persisted snapshot of the last-resolved cohort surface. Hydrating from
// this on getCohortSurface() first call means alchemy mount renders
// IMMEDIATELY with last-seen data — no GitHub fetch, no manifest poll,
// no GH-commit-ts API calls block boot. The background refresh that
// fires right after will replace the snapshot when it lands and
// notify subscribers so views repaint with fresh data.
// Bumped to v3 in v0.2.7: the v2 snapshot can carry a stale May-22
// calendar bundle, so users may see outdated week-2 agenda copy even after
// the shipped fixture and live calendar source have moved forward.
const SURFACE_LS_KEY = "srfg:cohort_surface_v3";
// Surface snapshots can grow to ~200KB (50 people × ~3KB each plus other
// kinds). localStorage is bounded at ~5MB per origin so this fits, but
// we still guard against quota errors on write — a write failure just
// means the next boot re-fetches, which is the pre-cache behavior.
function _readSurfaceLs() {
  try {
    const raw = localStorage.getItem(SURFACE_LS_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object") return null;
    return normalize(v);
  } catch { return null; }
}
function _writeSurfaceLs(surface) {
  if (!surface) return;
  // Strip non-essential carry-throughs that aren't useful on the next
  // boot's first paint (_sig is rebuilt from content; _baselineShas
  // would be stale anyway once the next tree fetch lands).
  try {
    const payload = {
      teams: surface.teams || [],
      people: surface.people || [],
      clusters: surface.clusters || [],
      dependencies: surface.dependencies || [],
      program: surface.program || [],
      events: surface.events || [],
      asks: surface.asks || [],
      cohort_vocab: surface.cohort_vocab || {},
      calendar: surface.calendar || null,
      constellation_cues: surface.constellation_cues || [],
    };
    localStorage.setItem(SURFACE_LS_KEY, JSON.stringify(payload));
  } catch {
    // QuotaExceededError or similar — fall through; next boot just re-fetches.
  }
}

function emptyShape() {
  return { teams: [], people: [], clusters: [], dependencies: [], program: [], events: [], asks: [], cohort_vocab: {}, calendar: null, constellation_cues: [] };
}

// Drop records that repeat a record_id (keeps the first), so a duplicate in
// the source data can't desync the views — e.g. the map keys by record_id and
// would render N-1 nodes while a raw-array view rendered N, and provenance
// lists would double-count. Warns loudly so the data bug stays visible.
function dedupById(list, kind) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  const dups = [];
  for (const rec of list) {
    const id = rec && rec.record_id;
    if (id && seen.has(id)) { dups.push(id); continue; }
    if (id) seen.add(id);
    out.push(rec);
  }
  if (dups.length) console.warn(`[cohort] dropped ${dups.length} duplicate ${kind} record_id(s): ${dups.join(", ")}`);
  return out;
}

function normalize(data) {
  return {
    teams:        dedupById(data?.teams, "team"),
    people:       dedupById(data?.people, "person"),
    clusters:     dedupById(data?.clusters, "cluster"),
    dependencies: dedupById(data?.dependencies, "dependency"),
    program:      Array.isArray(data?.program)  ? data.program  : [],
    events:       Array.isArray(data?.events)   ? data.events   : [],
    asks:         Array.isArray(data?.asks)     ? data.asks     : [],
    cohort_vocab: (data?.cohort_vocab && typeof data.cohort_vocab === "object") ? data.cohort_vocab : {},
    constellation_cues: Array.isArray(data?.constellation_cues) ? data.constellation_cues : [],
    // Pre-baked calendar bundle from the GH `cohort-data/program/calendar.json`
    // path or the fixture's `calendar` field. The renderer's `loadCalendar()`
    // tries the live Phala URL first and falls back to this. Previously this
    // field was dropped here, so on every fresh boot the calendar tab
    // rendered against `data=null` until the Phala fetch resolved (and went
    // blank entirely if that fetch failed or was slow). Pass it through.
    calendar:     (data?.calendar && typeof data.calendar === "object") ? data.calendar : null,
  };
}

// In-browser equivalent of scripts/build-bundles.js: enumerate the
// cohort-data/ tree, fetch each markdown record, parse its frontmatter,
// apply the schema whitelist, return the surface object.
//
// Also stamps a non-enumerable-but-exported `_baselineShas` map onto the
// returned shape: { listKey: { record_id: { path, sha } } }. This is the
// raw input to the GitHub-commit-ts tiebreaker in mergeSyncOverBaseline.
async function loadFromGithub() {
  const treeRes = await fetch(`${GH_TREE_API}&ts=${Date.now()}`, { cache: "no-store" });
  if (!treeRes.ok) throw new Error(`github tree fetch failed: HTTP ${treeRes.status}`);
  const tree = await treeRes.json();
  if (tree.truncated) {
    console.warn("[cohort-source] tree response truncated — cohort-data may have grown past the API page size");
  }
  // path → blob sha (per file in the tree). We carry this through merge
  // so the GH-commit-ts cache can key on (path, blob_sha) and skip the
  // commits-API fetch whenever a file's blob hasn't changed.
  const shaByPath = new Map();
  for (const e of (tree.tree || [])) {
    if (e && e.type === "blob" && typeof e.path === "string" && typeof e.sha === "string") {
      shaByPath.set(e.path, e.sha);
    }
  }
  const paths = Array.from(shaByPath.keys());

  const schemaText = await fetchRaw("cohort-data/schema.yml");
  const schema = yaml.load(schemaText);
  if (!schema || schema.schema_version !== 1) {
    throw new Error("unsupported schema_version in cohort-data/schema.yml");
  }

  const out = { schema_version: 1 };
  // listKey → record_id → { path, sha } for downstream GH-commit-ts merge.
  const baselineShas = {};

  await Promise.all(RECORD_DIRS.map(async (spec) => {
    const files = paths.filter(p => p.startsWith(spec.prefix) && p.endsWith(".md"));
    const whitelist = schema[spec.list_key]?.surface_fields || [];
    const records = await Promise.all(files.map(p => loadRecord(p, spec.record_type, whitelist)));
    const filtered = records.filter(Boolean);
    out[spec.list_key] = filtered;
    // Build the record_id → { path, sha } map. Keyed off filtered records
    // so we only carry shas for entries that actually made it through the
    // schema-whitelist step (i.e. the same records the merge step sees).
    const idMap = {};
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (!rec) continue;
      const path = files[i];
      const sha = shaByPath.get(path);
      if (path && sha && rec.record_id) {
        idMap[rec.record_id] = { path, sha };
      }
    }
    baselineShas[spec.list_key] = idMap;
  }));

  // Program pages get the markdown body included alongside frontmatter
  // so the renderer can display the long-form copy offline.
  const progFiles = paths.filter(p => p.startsWith(PROGRAM_PREFIX) && p.endsWith(".md"));
  const progWhitelist = schema.program?.surface_fields || [];
  const progRecords = await Promise.all(progFiles.map(p => loadProgramRecord(p, progWhitelist)));
  out.program = progRecords.filter(Boolean).sort((a, b) => {
    const ao = Number.isFinite(a.order) ? a.order : 1e9;
    const bo = Number.isFinite(b.order) ? b.order : 1e9;
    if (ao !== bo) return ao - bo;
    return String(a.record_id).localeCompare(String(b.record_id));
  });

  out.cohort_vocab = schema.cohort_vocab || {};

  // Calendar bundle — the renderer's loadCalendar() tries the live Phala
  // URL first; this is the fallback when that's unreachable, and what we
  // render against on the very first paint before the live fetch resolves.
  // Best-effort: a missing/malformed file just leaves out.calendar = null
  // so the calendar tab falls back to the live URL only.
  try {
    const calRaw = await fetchRaw("cohort-data/calendar.json");
    const calJson = JSON.parse(calRaw);
    if (calJson && typeof calJson === "object" && calJson.tabs) {
      out.calendar = calJson;
    }
  } catch (e) {
    console.warn("[cohort-source] calendar.json fetch/parse failed:", e?.message || e);
  }

  try {
    const cueRaw = await fetchRaw("cohort-data/constellation-cues.json");
    const cues = JSON.parse(cueRaw);
    out.constellation_cues = Array.isArray(cues) ? cues : [];
  } catch (e) {
    console.warn("[cohort-source] constellation-cues.json fetch/parse failed:", e?.message || e);
    out.constellation_cues = [];
  }

  const normalized = normalize(out);
  // Attach the sha map. Not part of the schema-shaped surface so callers
  // that iterate `normalized` lists stay unaffected.
  normalized._baselineShas = baselineShas;
  return normalized;
}

// `?ts=` busts both the HTTP cache and any CDN/Electron caching so we
// always see the latest commit on `main`.
async function fetchRaw(repoPath) {
  const r = await fetch(`${GH_RAW_BASE}/${repoPath}?ts=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`raw fetch ${repoPath}: HTTP ${r.status}`);
  return r.text();
}

function parseMarkdown(text) {
  const normalized = String(text || "").replace(/\r\n?/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!m) return { frontmatter: null, body: normalized };
  try { return { frontmatter: yaml.load(m[1]), body: m[2] }; }
  catch { return { frontmatter: null, body: normalized }; }
}

function pickSurface(obj, whitelist) {
  const out = {};
  for (const k of whitelist) {
    if (Object.prototype.hasOwnProperty.call(obj || {}, k)) out[k] = obj[k];
  }
  return out;
}

async function loadRecord(repoPath, expectedType, whitelist) {
  try {
    const text = await fetchRaw(repoPath);
    const { frontmatter } = parseMarkdown(text);
    if (!frontmatter) return null;
    if (frontmatter.record_type !== expectedType) return null;
    if (!frontmatter.record_id) return null;
    return pickSurface(frontmatter, whitelist);
  } catch (e) {
    console.warn(`[cohort-source] skip ${repoPath}:`, e?.message || e);
    return null;
  }
}

async function loadProgramRecord(repoPath, whitelist) {
  try {
    const text = await fetchRaw(repoPath);
    const { frontmatter, body } = parseMarkdown(text);
    if (!frontmatter) return null;
    if (frontmatter.record_type !== "program_page") return null;
    if (!frontmatter.record_id) return null;
    const s = pickSurface(frontmatter, whitelist);
    s.body_md = (body || "").trim();
    return s;
  } catch (e) {
    console.warn(`[cohort-source] skip program ${repoPath}:`, e?.message || e);
    return null;
  }
}

async function loadFromFixture() {
  const url = new URL("../cohort-surface.json", import.meta.url);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`cohort-surface fixture failed: HTTP ${r.status}`);
  return normalize(await r.json());
}

// ─── GitHub commit-ts cache (tiebreaker support) ─────────────────────
//
// Mirrors gh-user.js: aggressive localStorage cache keyed by
// (path, blob_sha) → { ok, ts_ms, fetched_at }. The blob SHA comes from
// the tree fetch in loadFromGithub() — when it changes, someone
// committed and we re-fetch the commit timestamp. When it doesn't
// change, we re-use the cached value indefinitely (subject to a 24h
// positive TTL backstop in case cache state drifts).
//
// Negative cache (404 / rate-limited): 1h. Long enough to not hammer
// the API for a missing path; short enough that the next refresh tick
// after a rate-limit window re-attempts.
//
// FAIL OPEN: on any error or cache miss without a network resolution,
// callers treat the absence of a ts as "no comparison possible" → sync
// wins. This preserves current behavior when GH API is unreachable.
const GH_COMMIT_TS_CACHE_KEY = "srfg:gh_commit_ts_cache_v1";
const GH_COMMIT_TS_TTL_MS     = 24 * 60 * 60 * 1000;  // 24h positive
const GH_COMMIT_TS_NEG_TTL_MS = 60 * 60 * 1000;       // 1h negative
const GH_COMMIT_TS_FETCH_JITTER_MS = 250;             // mirror gh-user.js politeness budget

function _loadCommitTsCache() {
  try {
    const raw = localStorage.getItem(GH_COMMIT_TS_CACHE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return (obj && typeof obj === "object") ? obj : {};
  } catch { return {}; }
}
function _saveCommitTsCache(map) {
  try { localStorage.setItem(GH_COMMIT_TS_CACHE_KEY, JSON.stringify(map || {})); } catch {}
}
function _commitTsCacheKey(path, sha) { return `${path}|${sha}`; }

function _readCommitTsCached(path, sha) {
  if (!path || !sha) return undefined;
  const cache = _loadCommitTsCache();
  const entry = cache[_commitTsCacheKey(path, sha)];
  if (!entry) return undefined;
  const ttl = entry.ok ? GH_COMMIT_TS_TTL_MS : GH_COMMIT_TS_NEG_TTL_MS;
  if (Date.now() - (entry.fetched_at || 0) > ttl) return undefined;
  return entry;
}
function _writeCommitTsCached(path, sha, entry) {
  if (!path || !sha) return;
  const cache = _loadCommitTsCache();
  cache[_commitTsCacheKey(path, sha)] = { ...entry, fetched_at: Date.now() };
  _saveCommitTsCache(cache);
}

// One-shot warn-on-404 latch so we don't spam the console if a record
// somehow lives in the tree but the commits API returns nothing.
const _warnedMissingCommit = new Set();

/**
 * Returns the GitHub commit timestamp (ms-epoch) for the most-recent
 * commit that touched `path` on main. Cached aggressively by
 * (path, blob_sha) — when the blob's SHA hasn't changed there's been
 * no commit that touched it, so the cached ts is still valid.
 *
 * Returns null on any failure (404, rate-limit, network, malformed
 * response). Callers MUST fail open: a null result means "no comparison
 * possible" → keep the existing sync-wins behavior.
 */
async function fetchGhCommitTsMs(path, blobSha) {
  if (!path || !blobSha) return null;
  const cached = _readCommitTsCached(path, blobSha);
  if (cached !== undefined) return cached.ok ? (cached.ts_ms || null) : null;
  try {
    const url = `${GH_COMMITS_API}?path=${encodeURIComponent(path)}&per_page=1&sha=${GH_BRANCH}`;
    const r = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
    if (r.status === 200) {
      const arr = await r.json();
      const iso = Array.isArray(arr) && arr[0]?.commit?.committer?.date;
      const ts = iso ? Date.parse(iso) : NaN;
      if (Number.isFinite(ts)) {
        _writeCommitTsCached(path, blobSha, { ok: true, ts_ms: ts });
        return ts;
      }
      // Empty list / malformed → negative-cache so we don't retry hard.
      if (!_warnedMissingCommit.has(path)) {
        _warnedMissingCommit.add(path);
        console.warn(`[cohort-source] no commit info for ${path} (empty/malformed response) — sync wins by default`);
      }
      _writeCommitTsCached(path, blobSha, { ok: false, status: r.status });
      return null;
    }
    _writeCommitTsCached(path, blobSha, { ok: false, status: r.status });
    return null;
  } catch (e) {
    _writeCommitTsCached(path, blobSha, { ok: false, status: 0, error: e?.message || String(e) });
    return null;
  }
}

// ─── swf-node overlay ────────────────────────────────────────────────
//
// When the local swf-node is reachable, fetch its /sync/manifest and
// pull each record's newest envelope. The envelope's `content` is the
// LWW view of that record's surface fields; we merge it OVER the
// cohort-data/*.md baseline (sync wins) keyed by record_id.
//
// Phase 2 ships one envelope kind: `person`. As future kinds (team,
// project, etc.) come online they slot in here on their list_key.
// `kind: "person"` from the manifest lands in `out.people`; on an
// unknown kind we just skip the envelope and log once.
const SYNC_KIND_TO_LIST_KEY = {
  person: "people",
  // place: "events",  team: "teams",  cluster: "clusters" — TBD Phase 3+
};

async function loadSyncOverlay() {
  const m = await getManifest();
  if (!m.ok) return null;
  const records = m.manifest?.records || {};
  const ids = Object.keys(records);
  if (ids.length === 0) return { kind: "empty", byList: {}, tsByList: {} };
  // Pull the newest envelope for each record. Sequential rather than
  // Promise.all so we don't slam a freshly-booted swf-node with 50
  // simultaneous requests — the daemon is single-threaded SQLite.
  const byList = {};
  // listKey → record_id → wall_ts_ms (the envelope's LWW timestamp; we
  // fall back to the manifest's latest_wall_ts_ms if the envelope
  // doesn't echo it). Used by the GitHub-commit-ts tiebreaker.
  const tsByList = {};
  for (const recordId of ids) {
    const meta = records[recordId];
    const listKey = SYNC_KIND_TO_LIST_KEY[meta?.kind];
    if (!listKey) continue;     // unknown kind → ignore (spec §4.4 step would warn)
    const r = await getRecord(recordId);
    if (!r.ok || !r.envelopes?.length) continue;
    const env = r.envelopes[0];
    const content = env?.content;
    if (!content || typeof content !== "object") continue;
    // Ensure record_id + record_type stamps survive merge so downstream
    // code (cards, identity matching) keeps working. The envelope's
    // record_id is canonical; the content might not echo it.
    const merged = {
      ...content,
      record_id: recordId,
      record_type: content.record_type || meta.kind,
    };
    (byList[listKey] = byList[listKey] || []).push(merged);
    const envTs = Number.isFinite(env?.wall_ts_ms) ? env.wall_ts_ms
                : Number.isFinite(meta?.latest_wall_ts_ms) ? meta.latest_wall_ts_ms
                : null;
    if (envTs !== null) {
      (tsByList[listKey] = tsByList[listKey] || {})[recordId] = envTs;
    }
  }
  return { kind: "ok", byList, tsByList };
}

// Merge sync records onto a baseline-grouped surface object. Records
// matched by record_id are REPLACED by the sync version; un-matched sync
// records are appended (so a cohort member who joined post-cohort-data
// shows up immediately). Records present in baseline but not in sync
// are left untouched — sync is additive over the cohort-data/*.md seed.
//
// Tiebreaker (Phase 5+): for each record where BOTH baseline (GitHub)
// and sync (swf-node) have a copy, compare timestamps:
//
//   - GH commit ts (when the cohort-data/*.md file was last committed
//     on main) > sync envelope wall_ts_ms → baseline wins (GH edit was
//     newer than whatever the sync overlay knows about).
//   - Otherwise → sync wins (preserves the original Phase 2 behavior).
//
// Failure modes (fetchGhCommitTsMs returns null) FAIL OPEN: sync wins.
// We never let a flaky GH-API call swallow a sync-authored edit; the
// worst that happens is the rare "GH edit beats older sync overlay"
// case stays unresolved until the next refresh tick.
async function mergeSyncOverBaseline(baseline, overlay) {
  if (!overlay || !overlay.byList) return baseline;
  const out = { ...baseline };
  const baselineShas = baseline?._baselineShas || {};
  const tsByList = overlay.tsByList || {};
  for (const [listKey, syncRecs] of Object.entries(overlay.byList)) {
    const base = Array.isArray(out[listKey]) ? out[listKey] : [];
    const byId = new Map();
    for (const r of base) {
      if (r && r.record_id) byId.set(r.record_id, r);
    }
    const idShas = baselineShas[listKey] || {};
    const idTs   = tsByList[listKey] || {};
    // Sequential with 250ms jitter between actual network calls so a
    // cold cache + 50 cohort members doesn't burst the GH commits API
    // (mirrors gh-user.js's pacing). Cache hits short-circuit the wait.
    let firstNetCall = true;
    for (const r of syncRecs) {
      if (!r.record_id) continue;
      const baseRec = byId.get(r.record_id);
      if (!baseRec) {
        // No baseline record — record was created via sync (new cohort
        // member who joined via the app). Sync wins, no comparison.
        byId.set(r.record_id, r);
        continue;
      }
      const shaInfo = idShas[r.record_id];
      const syncTs  = idTs[r.record_id];
      // No GH path/sha or no sync ts → fall back to current behavior
      // (sync wins). This keeps GH-API flakes from breaking the merge.
      if (!shaInfo || !Number.isFinite(syncTs)) {
        byId.set(r.record_id, r);
        continue;
      }
      // Only pay the 250ms tax when we'd actually hit the network — a
      // cached result is effectively synchronous.
      const cachedHit = _readCommitTsCached(shaInfo.path, shaInfo.sha);
      if (cachedHit === undefined) {
        if (!firstNetCall) {
          await new Promise(res => setTimeout(res, GH_COMMIT_TS_FETCH_JITTER_MS));
        }
        firstNetCall = false;
      }
      const ghTs = await fetchGhCommitTsMs(shaInfo.path, shaInfo.sha);
      if (Number.isFinite(ghTs) && ghTs > syncTs) {
        // GH commit is newer than the sync envelope — baseline wins.
        // Leave byId as-is (baseRec already there).
        continue;
      }
      // GH ts older or missing → sync wins (default).
      byId.set(r.record_id, r);
    }
    out[listKey] = Array.from(byId.values());
  }
  return out;
}

// Cheap change signature: counts + sorted record_ids per bucket. Used
// by the refresh loop to skip re-render when GitHub returned identical
// data (the usual case between merges).
function signatureOf(grouped) {
  const sig = (arr) => arr.map(r => r.record_id).sort().join("|");
  // Program-page edits are full-body markdown swaps, not record_id churn —
  // hash a coarse fingerprint of (id + body length) so a content-only change
  // still trips the refresh notifier.
  const progSig = (arr) => arr.map(r => `${r.record_id}:${(r.body_md || "").length}`).sort().join("|");
  // Asks churn fast (5-day expiry) — include status in the signature so the
  // wall re-renders on claim/close.
  const askSig = (arr) => arr.map(r => `${r.record_id}:${r.status || "open"}`).sort().join("|");
  // Events are updated by date/title edits — include both in the signature
  // so a date-shift on an existing record_id trips the refresh.
  const eventSig = (arr) => arr.map(r => `${r.record_id}:${r.date || ""}:${r.range_start || ""}:${r.range_end || ""}:${r.title || ""}`).sort().join("|");
  // People + teams can flip between sync and GH baseline content via the
  // GitHub-commit-ts tiebreaker (Phase 5+) without the record_id set
  // changing. Mix a coarse content fingerprint (name + a couple of
  // free-text fields + length-ish proxies) into the signature so a
  // tiebreaker-driven content swap correctly fires the refresh notifier.
  const personSig = (arr) => arr.map(r =>
    `${r.record_id}:${r.name || ""}:${(r.now || "").length}:${r.role || ""}:${r.team || ""}`
  ).sort().join("|");
  const teamSig = (arr) => arr.map(r =>
    `${r.record_id}:${r.name || ""}:${(r.now || "").length}:${(r.weekly_goals || "").length}`
  ).sort().join("|");
  const depSig = (arr) => arr.map(r =>
    `${r.record_id}:${r.source || ""}:${r.target || ""}:${r.relation || ""}:${r.status || ""}:${(r.reason || "").length}:${(r.next_action || "").length}`
  ).sort().join("|");
  const cueSig = (arr) => arr.map(c =>
    `${(c?.label || "").length}:${(c?.source || "").length}:${(c?.excerpt || "").length}`
  ).sort().join("|");
  return `${grouped.teams.length}:${teamSig(grouped.teams)}#${grouped.people.length}:${personSig(grouped.people)}#${grouped.clusters.length}:${sig(grouped.clusters)}#${grouped.dependencies.length}:${depSig(grouped.dependencies)}#${grouped.program.length}:${progSig(grouped.program)}#${grouped.events.length}:${eventSig(grouped.events)}#${grouped.asks.length}:${askSig(grouped.asks)}#${(grouped.constellation_cues || []).length}:${cueSig(grouped.constellation_cues || [])}`;
}

// Dev preview override. Setting `localStorage.setItem("srfg:cohort_source", "local")`
// in DevTools then reloading forces the app to read the bundled fixture
// (apps/os/src/cohort-surface.json) instead of GitHub main.
// Use this to preview a cohort-data PR locally before it merges. Clear with
// `localStorage.removeItem("srfg:cohort_source")` + reload to return to main.
function devPreferLocal() {
  try { return localStorage.getItem("srfg:cohort_source") === "local"; } catch { return false; }
}

/**
 * Returns latest cohort.surface records grouped by type. Tries
 * GitHub `main` first; falls back to the bundled fixture on any
 * error so the app stays usable offline. Honors the localStorage
 * `srfg:cohort_source` dev override.
 *
 * Phase 2 sync: when the bundled swf-node is reachable, its
 * /sync/manifest records are merged OVER the github/fixture baseline.
 * The merged result is what callers see. The `_source` field reads
 * `github+sync`, `fixture+sync`, or just the underlying source when
 * sync is unreachable.
 */
export async function getCohortSurface() {
  // Return any in-memory cache immediately. Repeat callers within a
  // session never re-pay for the resolve.
  if (_cache) return _cache;

  // Hydrate from localStorage if we have a snapshot from a prior session.
  // This is the fast path — boot returns control to alchemy.mount within
  // a millisecond instead of waiting on GitHub. Background refresh below
  // replaces the snapshot when fresh data arrives and notifies subscribers.
  const lsSnapshot = _readSurfaceLs();
  if (lsSnapshot && !devPreferLocal()) {
    _cache = lsSnapshot;
    _cache._source = "ls-cache";
    _cache._sig = signatureOf(_cache);
    _cache._syncAvailable = false; // updated when the background refresh resolves
    _startBackgroundRefresh();
    scheduleRefresh();
    return _cache;
  }

  // No snapshot yet (first launch, or LS evicted). Fall back to the
  // synchronous fixture as the initial paint, then start the background
  // refresh. The bundled fixture is small + bundled-in, so reading it
  // synchronously is acceptable; it's better than handing back an empty
  // shape that flashes nothing before the network resolves.
  try {
    _cache = await loadFromFixture();
    _cache._source = "fixture-bootstrap";
    _cache._sig = signatureOf(_cache);
    _cache._syncAvailable = false;
  } catch (e) {
    // Last-resort empty shape if even the bundled fixture isn't readable —
    // alchemy will render placeholders instead of crashing.
    console.warn("[cohort-source] bundled fixture unavailable on first boot:", e?.message || e);
    _cache = normalize(emptyShape());
    _cache._source = "empty-bootstrap";
    _cache._sig = signatureOf(_cache);
    _cache._syncAvailable = false;
  }
  _startBackgroundRefresh();
  scheduleRefresh();
  return _cache;
}

// Background refresh runs the resolve path without blocking any caller.
// Two distinct workloads stacked behind one entry point:
//
//   1. swf-node /sync/* poll — every tick. Pure localhost, free.
//   2. GitHub tree + raw + commit-ts fetches — at most once per
//      GH_BASELINE_MIN_GAP_MS (default 1h). Gated to protect the
//      60 req/hr unauthenticated GH API budget on shared-IP LANs.
//      forceGithub=true (from refreshCohortFromGithub()) bypasses
//      the gate so a user-initiated resync always pulls.
//
// When the refresh lands it overwrites _cache, persists to localStorage,
// and fires subscribers so views re-render. Re-entrant: a concurrent call
// re-uses the same promise instead of stacking redundant network work.
function _startBackgroundRefresh({ forceGithub = false } = {}) {
  if (_bgRefreshInFlight) return _bgRefreshInFlight;
  _emitSyncState("syncing");
  _bgRefreshInFlight = (async () => {
    try {
      const now = Date.now();
      const baselineStale = !_baseline || (now - _baselineFetchedAt) >= GH_BASELINE_MIN_GAP_MS;
      const shouldFetchGh = forceGithub || baselineStale;

      let baseline = _baseline;
      if (devPreferLocal()) {
        try {
          baseline = await loadFromFixture();
          baseline._source = "fixture-forced";
          _baseline = baseline;
          _baselineFetchedAt = now;
          console.log("[cohort-source] DEV override active — reading bundled fixture. Clear with localStorage.removeItem('srfg:cohort_source') + reload.");
        } catch (e) {
          console.warn("[cohort-source] forced fixture unreadable; falling through to github:", e?.message || e);
          baseline = null;
        }
      } else if (shouldFetchGh) {
        try {
          baseline = await loadFromGithub();
          baseline._source = "github";
          _baseline = baseline;
          _baselineFetchedAt = now;
        } catch (e) {
          console.warn("[cohort-source] github unreachable; reusing prior baseline:", e?.message || e);
          // Keep the prior baseline if we have one; otherwise fall through
          // to the bundled fixture so first-launch isn't blank.
          if (!baseline && (!_cache || _cache._source === "empty-bootstrap")) {
            try {
              baseline = await loadFromFixture();
              baseline._source = "fixture";
            } catch { baseline = null; }
          }
        }
      }
      if (!baseline) return; // nothing to merge against

      const merged = await applySyncOverlayCached(baseline);
      merged._sig = signatureOf(merged);
      // Did anything actually change? If not, no subscriber notify.
      const prevSig = _cache?._sig;
      _cache = merged;
      _writeSurfaceLs(_cache);
      if (prevSig !== merged._sig) {
        for (const cb of _subscribers) {
          try { cb({ type: "refresh" }); } catch {}
        }
      }
    } finally {
      _bgRefreshInFlight = null;
      _emitSyncState("idle");
    }
  })();
  return _bgRefreshInFlight;
}

/**
 * Force an immediate GitHub baseline re-pull, bypassing the
 * GH_BASELINE_MIN_GAP_MS throttle. Wired to the "resync from GitHub"
 * action in the identity modal so a user can pull fresh cohort-data
 * after a PR merges without waiting for the next hourly tick.
 *
 * Returns the same promise as the underlying background refresh;
 * resolves when the merge + LS persist completes.
 */
export function refreshCohortFromGithub() {
  return _startBackgroundRefresh({ forceGithub: true });
}

// Apply the swf-node overlay to a baseline cache. Stamps `_source` so
// the UI can show "live · syncing" vs "baseline only." If sync is
// unreachable, returns the baseline untouched (the github PR fallback
// keeps the app usable).
async function applySyncOverlayCached(baseline) {
  let overlay = null;
  try { overlay = await loadSyncOverlay(); }
  catch (e) { overlay = null; }
  if (!overlay) {
    baseline._syncAvailable = false;
    return baseline;
  }
  const merged = await mergeSyncOverBaseline(baseline, overlay);
  merged._source = `${baseline._source || "baseline"}+sync`;
  // Carry the baseline sha map forward so refresh ticks can re-merge
  // without losing the GH-commit-ts tiebreaker inputs.
  if (baseline._baselineShas) merged._baselineShas = baseline._baselineShas;
  merged._sig = signatureOf(merged);
  merged._syncAvailable = true;
  return merged;
}

// External helper for components that need to know "is the live sync
// view active?" — the alchemy profile editor reads this to decide
// whether to route a submit through swf-node or fall back to github PR.
export function isSyncAvailable() {
  return !!_cache?._syncAvailable;
}

function scheduleRefresh() {
  if (_refreshTimer) return;
  // Use the faster cadence when sync is live so a peer's profile edit
  // shows up within one sync tick instead of waiting on the github poll.
  // The fallback is still gh-only when swf-node is unreachable.
  const interval = _cache?._syncAvailable ? SYNC_REFRESH_MS : REFRESH_MS;
  _refreshTimer = setInterval(refreshTick, interval);
}

async function refreshTick() {
  // Polled refresh delegates to the same background path used on first
  // boot, so we don't have two slightly-different resolve paths to keep
  // in sync. The LS write + subscriber notify happens inside
  // _startBackgroundRefresh; we only handle sync-availability cadence
  // switching here.
  const prevSyncAvail = !!_cache?._syncAvailable;
  await _startBackgroundRefresh();
  const nextSyncAvail = !!_cache?._syncAvailable;
  if (prevSyncAvail !== nextSyncAvail) {
    if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
    scheduleRefresh();
  }
}

/**
 * Subscribers fire when a polled refresh detects a changed cohort on
 * GitHub. The callback receives a generic `{ type: "refresh" }` —
 * consumers should re-fetch via getCohortSurface() and re-render.
 */
export function subscribeToCohortChanges(cb) {
  if (typeof cb !== "function") return () => {};
  _subscribers.add(cb);
  return () => _subscribers.delete(cb);
}

// Internal — for tests / dev tools to force-refresh the cache.
export function _resetCohortSource() {
  _cache = null;
  _baseline = null;
  _baselineFetchedAt = 0;
  _bgRefreshInFlight = null;
  _subscribers.clear();
  if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
  try { localStorage.removeItem(SURFACE_LS_KEY); } catch {}
}
