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
import { fetchPublicEvidenceCards, fetchCohortEvidenceCards, COHORT_APP_READER_ENABLED, fetchCohortInsightCards } from "./supabase-evidence.mjs";
import { evidenceDependencyRecords, insightCollaborationDependencyRecords, collaborationContributionDependencyRecords, attributeInsightCards, dedupeDependencyEdges, connectionEdgesFromInsightCards, frozenAttributionFromInsightCards } from "./cohort-evidence-index.mjs";
import { fetchCohortArticles } from "./supabase-articles.mjs";
import { fetchCohortDistillations } from "./supabase-distillations.mjs";
import { fetchAllSpheres } from "./supabase-sphere.mjs";
import { fetchApprovedProfileUpdates } from "./supabase-self-report.mjs";
import { fetchCohortFeed } from "./supabase-cohort-events.mjs";
import { reduceAsks } from "./asks-events.mjs";
import { sanitizeDelta } from "./self-report-synth.mjs";
import { sanitizeProfileFields, sanitizeTeamFields } from "./cohort-chat-actions.mjs";
import { fetchReleasesFeed } from "./supabase-releases.mjs";
import { fetchConnections, connectionsByRecord } from "./supabase-connections.mjs";

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
// Timestamp of the last GitHub baseline *attempt* (success OR failure). The
// throttle gates on this — not on last success — so a network error / 403
// rate-limit doesn't re-fire the full tree+raw+commit fetch on every 30s sync
// tick (which would deepen the very rate-limit hole the gap is meant to avoid).
let _baselineLastAttemptAt = 0;
let _refreshTimer = null;
let _refreshVisibilityBound = false;
let _refreshVisibilityTarget = null;
let _refreshVisibilityHandler = null;
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
// Bumped to v5 in 2026-06: v4 snapshots may carry source-owned fields hydrated
// from a stale generated surface. Record fields now come from live markdown;
// generated surfaces only provide timeline maps or full offline fixtures.
const SURFACE_LS_KEY = "srfg:cohort_surface_v5";
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
    const surface = normalize(v);
    if (typeof v._source === "string") surface._storedSource = v._source;
    if (typeof v._saved_at === "string") surface._storedAt = v._saved_at;
    return surface;
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
      calendar_google_events: surface.calendar_google_events || {},
      constellation_cues: surface.constellation_cues || [],
      session_insights: surface.session_insights || [],
      transcript_evidence_cards: surface.transcript_evidence_cards || [],
      cohort_articles: surface.cohort_articles || [],
      whats_new: surface.whats_new || [],
      github_releases: surface.github_releases || [],
      transcript_evidence: surface.transcript_evidence || {},
      transcript_distillations: surface.transcript_distillations || {},
      cohort_intel: surface.cohort_intel || {},
      cohort_insights: surface.cohort_insights || {},
      person_timeline: surface.person_timeline || {},
      team_timeline: surface.team_timeline || {},
      person_spheres: surface.person_spheres || {},
      _generated_at: surface._generated_at || null,
      _source: surface._source || surface._storedSource || null,
      _saved_at: new Date().toISOString(),
    };
    localStorage.setItem(SURFACE_LS_KEY, JSON.stringify(payload));
  } catch {
    // QuotaExceededError or similar — fall through; next boot just re-fetches.
  }
}

function emptyShape() {
  return {
    teams: [],
    people: [],
    clusters: [],
    dependencies: [],
    program: [],
    events: [],
    asks: [],
    cohort_vocab: {},
    calendar: null,
    calendar_google_events: {},
    constellation_cues: [],
    session_insights: [],
    transcript_evidence_cards: [],
    cohort_articles: [],
    whats_new: [],
    github_releases: [],
    transcript_evidence: {},
    transcript_distillations: {},
    cohort_intel: {},
    cohort_insights: {},
    person_timeline: {},
    team_timeline: {},
    person_spheres: {},
  };
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

function timelineMap(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function objectMap(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalize(data) {
  const out = {
    teams:        dedupById(data?.teams, "team"),
    people:       dedupById(data?.people, "person"),
    clusters:     dedupById(data?.clusters, "cluster"),
    dependencies: dedupById(data?.dependencies, "dependency"),
    program:      Array.isArray(data?.program)  ? data.program  : [],
    events:       Array.isArray(data?.events)   ? data.events   : [],
    asks:         Array.isArray(data?.asks)     ? data.asks     : [],
    cohort_vocab: (data?.cohort_vocab && typeof data.cohort_vocab === "object") ? data.cohort_vocab : {},
    constellation_cues: Array.isArray(data?.constellation_cues) ? data.constellation_cues : [],
    // Distilled session readouts (public-safe, hardcoded via
    // scripts/ingest-session-readouts.mjs). Not rendered yet — passed
    // through so a future insights surface needs no data-plane change.
    session_insights: Array.isArray(data?.session_insights) ? data.session_insights : [],
    // Distilled transcript evidence cards read LIVE from Supabase at runtime
    // (the public, person-anonymized T3 layer). Empty in the committed bundle
    // by design — populated by the Supabase overlay in the background refresh
    // (see applyEvidenceOverlay). Passed through here so an LS-cached set
    // survives a reboot's first paint.
    transcript_evidence_cards: Array.isArray(data?.transcript_evidence_cards) ? data.transcript_evidence_cards : [],
    cohort_articles: Array.isArray(data?.cohort_articles) ? data.cohort_articles : [],
    // Build-time "what's new" feed (membrane left edge). Bundled in the
    // surface so the feed reads full without depending on the live
    // team_timeline refresh from main.
    whats_new: Array.isArray(data?.whats_new) ? data.whats_new : [],
    github_releases: Array.isArray(data?.github_releases) ? data.github_releases : [],
    transcript_evidence: objectMap(data?.transcript_evidence),
    transcript_distillations: objectMap(data?.transcript_distillations),
    cohort_intel: objectMap(data?.cohort_intel),
    cohort_insights: objectMap(data?.cohort_insights),
    person_timeline: timelineMap(data?.person_timeline),
    team_timeline: timelineMap(data?.team_timeline),
    // Per-person sphere customization read LIVE from Supabase (os_spheres) by
    // applySphereOverlay. Empty in the committed bundle; passed through here so
    // an LS-cached set survives a reboot's first paint (like evidence cards).
    person_spheres: objectMap(data?.person_spheres),
    // Pre-baked calendar bundle from the GH `cohort-data/program/calendar.json`
    // path or the fixture's `calendar` field. The renderer's `loadCalendar()`
    // tries the live Phala URL first and falls back to this. Previously this
    // field was dropped here, so on every fresh boot the calendar tab
    // rendered against `data=null` until the Phala fetch resolved (and went
    // blank entirely if that fetch failed or was slow). Pass it through.
    calendar:     (data?.calendar && typeof data.calendar === "object") ? data.calendar : null,
    calendar_google_events: objectMap(data?.calendar_google_events),
  };
  // Derive GitHub-attested cross-team collaboration edges from the committed
  // cohort_insights bundle into dependency records so the relationship / ecosystem
  // map + collab model render them natively (no view code). Bundle-sourced, so this
  // runs on EVERY surface (fixture / ls-cache / github) and the edges show on first
  // paint — unlike the transcript session-observed edges, which only land after the
  // async Supabase overlay. Idempotent: prior-derived records are stripped and
  // re-derived from current insights, so an LS snapshot never compounds them.
  // Precedence is declared > github-observed > transcript-observed: declared deps are
  // never restated, and the github edges sit ahead of the transcript edges so
  // constellationDependencyEdges' per-pair dedupe keeps the harder commit evidence.
  const declaredDeps = out.dependencies.filter((d) => {
    const id = String((d && d.record_id) || "");
    // Strip ALL three derived-edge families so a persisted LS snapshot never bakes a
    // stale one into declaredDeps: gh-collab-edge: (re-derived below from insights),
    // evidence-edge: (kept as transcriptEdges from the snapshot), and collab-edge:
    // (re-derived LIVE by applyCollaborationEdges each tick — it skips already-present
    // ids, so a leaked declared copy would otherwise never refresh or revert).
    return !id.startsWith("gh-collab-edge:")
      && !id.startsWith("evidence-edge:")
      && !id.startsWith("collab-edge:");
  });
  const transcriptEdges = out.dependencies.filter((d) => String((d && d.record_id) || "").startsWith("evidence-edge:"));
  const githubEdges = insightCollaborationDependencyRecords(out.cohort_insights, declaredDeps);
  out.dependencies = [...declaredDeps, ...githubEdges, ...transcriptEdges];
  if (typeof data?._generated_at === "string") out._generated_at = data._generated_at;
  return out;
}

function mergeGeneratedSurfaceExtras(out, generated) {
  if (!out || !generated || typeof generated !== "object") return;
  if (Array.isArray(generated.whats_new) && generated.whats_new.length) out.whats_new = generated.whats_new;
  if (Array.isArray(generated.github_releases) && generated.github_releases.length) out.github_releases = generated.github_releases;
  for (const field of ["transcript_evidence", "transcript_distillations", "cohort_intel", "cohort_insights"]) {
    const value = objectMap(generated[field]);
    if (Object.keys(value).length) out[field] = value;
  }
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
    const filtered = records
      .filter(Boolean)
      .sort((a, b) => String(a.record_id).localeCompare(String(b.record_id)));
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

  // Per-session distilled transcript content (constellation cues + session
  // insights) is gated cohort-internal material and no longer published to the
  // public repo, so there is nothing to fetch here. These resolve empty until
  // the app reads reviewed distillations at runtime from the gated Supabase
  // view (the rail applyEvidenceOverlay already uses for T3 evidence cards).
  out.constellation_cues = [];
  out.session_insights = [];

  // Generated read models that do not fully live in cohort-data/*.md. The live
  // markdown builder above cannot reconstruct Git-derived per-record timelines,
  // so hydrate those maps from the generated surface bundle on main. If GitHub
  // is unreachable, fall back to the packaged fixture.
  try {
    const surfaceRaw = await fetchRaw("apps/os/src/cohort-surface.json");
    const generated = JSON.parse(surfaceRaw);
    const personTimeline = timelineMap(generated?.person_timeline);
    const teamTimeline = timelineMap(generated?.team_timeline);
    if (!Object.keys(personTimeline).length && !Object.keys(teamTimeline).length) {
      throw new Error("generated surface did not include timeline maps");
    }
    out.person_timeline = personTimeline;
    out.team_timeline = teamTimeline;
    // The "what's new" feed is build-time generated. Prefer main's copy once
    // it carries one; otherwise keep the bundled fixture's (full) feed so the
    // membrane reads full even before the rebuilt surface ships to main.
    mergeGeneratedSurfaceExtras(out, generated);
    if (!Array.isArray(out.whats_new) || !out.whats_new.length) {
      const fixture = await loadFromFixture();
      mergeGeneratedSurfaceExtras(out, fixture);
      out.whats_new = Array.isArray(out.whats_new) ? out.whats_new : [];
    }
  } catch (e) {
    try {
      const fixture = await loadFromFixture();
      out.person_timeline = timelineMap(fixture?.person_timeline);
      out.team_timeline = timelineMap(fixture?.team_timeline);
      mergeGeneratedSurfaceExtras(out, fixture);
      out.whats_new = Array.isArray(out.whats_new) ? out.whats_new : [];
    } catch {
      console.warn("[cohort-source] generated timeline maps unavailable:", e?.message || e);
    }
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

function extractPublicPersonBio(body) {
  const raw = String(body || "").trim();
  if (!raw) return "";
  const lines = raw.split("\n");
  const start = lines.findIndex(line => /^##\s+(about|bio)\s*$/i.test(line.trim()));
  if (start < 0) return raw;
  const end = lines.findIndex((line, index) => index > start && /^##\s+/.test(line.trim()));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
}

async function loadRecord(repoPath, expectedType, whitelist) {
  try {
    const text = await fetchRaw(repoPath);
    const { frontmatter, body } = parseMarkdown(text);
    if (!frontmatter) return null;
    if (frontmatter.record_type !== expectedType) return null;
    if (!frontmatter.record_id) return null;
    const surface = pickSurface(frontmatter, whitelist);
    if (expectedType === "person") {
      const bio = extractPublicPersonBio(body);
      if (bio) surface.bio_md = bio;
    }
    return surface;
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
// Apply the live Supabase evidence overlay on top of a merged surface.
// Builds carrying a cohort key (the distributed app) read the GATED T2 cohort
// evidence (cohort_app_transcript_evidence_cards) AND the anon T3 public set, and
// merge them (T2 ∪ T3, deduped). Builds with no cohort key (the public web bundle)
// read only the anon T3 public set. On a Supabase outage — or no key at all — the
// surface keeps whatever cards it already carries, so the app degrades gracefully.
async function applyEvidenceOverlay(surface) {
  try {
    // The gated T2 cohort read is ENABLED (see COHORT_APP_READER_ENABLED): when a
    // cohort key is configured the named/cohort-internal T2 cards load live; with no
    // key it no-ops gracefully and we serve T2 from the committed bundle + the anon T3
    // read. The 3rd read pulls gated cohort-insight cards (collaboration_contribution)
    // for the live clique-edge path. All reads run in parallel and never throw.
    const [cohort, pub, insight] = await Promise.all([
      COHORT_APP_READER_ENABLED ? fetchCohortEvidenceCards() : Promise.resolve({ cards: [], source: "disabled" }),
      fetchPublicEvidenceCards(),
      fetchCohortInsightCards(),
    ]);
    const gotCohort = cohort.source === "supabase-cohort";
    const gotPublic = pub.source === "supabase";
    if (gotCohort || gotPublic) {
      const seen = new Set();
      const merged = [];
      for (const card of [...(gotCohort ? cohort.cards : []), ...(gotPublic ? pub.cards : [])]) {
        if (card && card.id && !seen.has(card.id)) { seen.add(card.id); merged.push(card); }
      }
      // Re-attach a best-effort team to the anonymized public insight cards
      // (claim_type "insight", no declared content_json.teams) by matching their
      // text to each team's distinctive vocabulary. Without this the live cards —
      // the real distilled session content — feed NONE of the per-team views.
      // Inferred teams are tagged teams_basis:"inferred"; declared cards untouched.
      // Prefer the FROZEN attribution snapshot (card_attribution cohort-insight
      // cards from the daily local-AI routine) when present, so the inference is
      // read, not recomputed every refresh; fall back to the live match otherwise.
      const frozenAttr = (insight && insight.source === "supabase-cohort" && Array.isArray(insight.cards))
        ? frozenAttributionFromInsightCards(insight.cards) : null;
      const attributed = attributeInsightCards(merged, Array.isArray(surface.teams) ? surface.teams : [], { frozen: frozenAttr });
      surface.transcript_evidence_cards = attributed;
      surface._evidenceSource = gotCohort ? (gotPublic ? "supabase-cohort+public" : "supabase-cohort") : "supabase-live";

      // Shape collaboration-edge evidence into dependency records so the relationship
      // map renders them NATIVELY (no view code) — deduped vs the declared deps the
      // surface already carries, provenance-tagged (status=session_observed). Additive
      // + idempotent (skip any evidence-edge id already present on re-overlay).
      const baseDeps = Array.isArray(surface.dependencies) ? surface.dependencies : [];
      const edgeRecords = evidenceDependencyRecords(attributed, baseDeps);
      if (edgeRecords.length) {
        const have = new Set(baseDeps.map((d) => d && d.record_id).filter(Boolean));
        surface.dependencies = [...baseDeps, ...edgeRecords.filter((r) => !have.has(r.record_id))];
      }
    }
    // GATED cohort-insight cards (collaboration_contribution) — kept independent of the
    // evidence read above so collaboration edges light up even if only the insight view
    // returned. No cards (no key / outage) ⇒ surface keeps whatever it already carries.
    if (insight && insight.source === "supabase-cohort" && Array.isArray(insight.cards)) {
      surface._cohortInsightCards = insight.cards;
      // Fold the frozen connection-edge snapshot (connection_edge cohort-insight
      // cards) onto records as `record.connections` — the per-team "who to talk
      // to" inspector source. This is the cohort-insight-card CONSOLIDATION of the
      // standalone connections overlay: one stream, one publish path. Absent ⇒
      // records simply carry no connections and the block hides itself.
      const nameById = new Map();
      for (const r of [...(surface.teams || []), ...(surface.people || [])]) {
        if (r && r.record_id) nameById.set(r.record_id, r.name || r.record_id);
      }
      const connByRecord = connectionEdgesFromInsightCards(insight.cards, nameById);
      if (connByRecord.size) {
        for (const r of [...(surface.teams || []), ...(surface.people || [])]) {
          if (r && r.record_id && connByRecord.has(r.record_id)) r.connections = connByRecord.get(r.record_id);
        }
        surface._connectionSource = "cohort-insight-cards";
      }
    }
    applyCollaborationEdges(surface);
    // All three derived collaboration-edge sources (evidence-edge / gh-collab-edge
    // / collab-edge) are now folded in alongside declared deps; collapse same-pair
    // duplicates so one collaboration renders as ONE edge, not up to three.
    surface.dependencies = dedupeDependencyEdges(surface.dependencies);
  } catch {
    // keep whatever the surface already carries
  }
  return surface;
}

// Inject GitHub collaboration-contribution edges into the dependency set so the
// ecosystem/relationship map + collab board render them natively (cohort-relations.js
// → constellationDependencyEdges). Reads the gated cohort-insight cards
// (surface._cohortInsightCards, from the Supabase view); teams that co-contributed to
// the same repo become contributed_to edges. Additive + idempotent; no cards ⇒ no-op.
function applyCollaborationEdges(surface) {
  const cards = surface && surface._cohortInsightCards;
  if (!Array.isArray(cards) || !cards.length) return surface;
  const baseDeps = Array.isArray(surface.dependencies) ? surface.dependencies : [];
  const records = collaborationContributionDependencyRecords(cards, baseDeps);
  if (records.length) {
    const have = new Set(baseDeps.map((d) => d && d.record_id).filter(Boolean));
    surface.dependencies = [...baseDeps, ...records.filter((r) => !have.has(r.record_id))];
  }
  return surface;
}

async function applyArticleOverlay(surface) {
  try {
    const { articles, source } = await fetchCohortArticles();
    if (source === "supabase-app" || source === "supabase-public") {
      surface.cohort_articles = articles;
      surface._articleSource = source;
    }
  } catch {
    // keep whatever the surface already carries
  }
  return surface;
}

// Apply the live Supabase distilled-readout overlay. A build carrying a cohort key
// (the distributed app) reads the GATED cohort distillations (the role-gated
// cohort_app_transcript_distillations view) and hangs them on
// surface.transcript_distillations.artifacts so the transcripts tab can show the
// cleaned readouts next to the local raw vault. No cohort key (public web /
// un-provisioned build) or a Supabase outage leaves whatever the surface carries —
// the bundle ships only distillation counts (artifacts stripped), so the tab stays
// raw-only until a cohort key is provisioned.
async function applyDistillationOverlay(surface) {
  // The cohort_app distillation view is live (see COHORT_APP_READER_ENABLED). With a
  // cohort key the distilled readouts load into the transcripts tab; with no key the
  // fetch no-ops and the tab serves the local raw vault only. Never throws.
  if (!COHORT_APP_READER_ENABLED) return surface;
  try {
    const { artifacts, source } = await fetchCohortDistillations();
    if (source === "supabase-cohort") {
      const existing = (surface.transcript_distillations && typeof surface.transcript_distillations === "object")
        ? surface.transcript_distillations : {};
      surface.transcript_distillations = { ...existing, artifacts, live_count: artifacts.length };
      surface._distillationSource = source;
    }
  } catch {
    // keep whatever the surface already carries
  }
  return surface;
}

// Apply the live Supabase per-person sphere overlay. Each customized person has
// a row in os_spheres (record_id → five visual dials); we fold the whole map
// onto the surface as `person_spheres` so the card/detail renderers can emit
// the override as data-shape-* attributes. On a Supabase outage — or before the
// table exists — the surface keeps whatever it already carries (LS-cached or
// empty), and spheres just fall back to their hash-derived defaults.
async function applySphereOverlay(surface) {
  try {
    const { spheres, source } = await fetchAllSpheres();
    if (source === "supabase") {
      surface.person_spheres = spheres;
      surface._sphereSource = "supabase-live";
    }
  } catch {
    // keep whatever the surface already carries
  }
  return surface;
}

// Apply the live Supabase profile-update overlay: APPROVED self-report deltas
// ("Your Mirror") read from the app_profile_updates view, merged onto matching
// person/team records so the rendered surface "updates off it" with no PR. Unlike
// the sphere overlay (a side map read at render), profile FIELDS merge into the
// record object itself because card/detail/editor renderers read those fields
// directly. Approved-only by design (the raw inbox is anon write-only); on a
// Supabase outage the surface keeps its committed/synced baseline.
async function applyProfileUpdateOverlay(surface) {
  try {
    const { updates, teamUpdates, source } = await fetchApprovedProfileUpdates();
    if (source !== "supabase") return surface;
    const people = Array.isArray(surface.people) ? surface.people : [];
    const teams = Array.isArray(surface.teams) ? surface.teams : [];
    let touched = false;
    // CLONE, never mutate: the baseline person objects are shared/persisted, so
    // mutating them would bake an approved delta in permanently (un-revertible if
    // the row is later un-approved, and masking newer markdown/sync edits). Build
    // NEW objects each tick so the overlay is derived-not-accumulated. Re-whitelist
    // the row (sanitizeProfileFields: self-report fields + geo + links{github,repo})
    // so the read path holds the same "only whitelisted fields move" invariant as
    // the write — never trust a key that lands in the view.
    surface.people = people.map((person) => {
      const delta = person && person.record_id ? updates[person.record_id] : null;
      if (!delta || typeof delta !== "object") return person;
      const clean = sanitizeProfileFields(delta);
      if (!Object.keys(clean).length) return person;
      touched = true;
      const merged = { ...person, ...clean };
      // `links` is nested: deep-merge so an approved github/repo update keeps the
      // member's other links (x / website / linkedin / demo / deck) intact.
      if (clean.links) merged.links = { ...(person.links || {}), ...clean.links };
      return merged;
    });
    surface.teams = teams.map((team) => {
      const delta = team && team.record_id ? teamUpdates?.[team.record_id] : null;
      if (!delta || typeof delta !== "object") return team;
      const clean = sanitizeTeamFields(delta);
      if (!Object.keys(clean).length) return team;
      touched = true;
      const merged = { ...team, ...clean };
      if (clean.journey) merged.journey = { ...(team.journey || {}), ...clean.journey };
      return merged;
    });
    // Approved self-reports intentionally win over the markdown/sync baseline (they
    // are the latest member-approved value, operator-gated). Because we re-derive
    // from the baseline each tick, dropping the approved row reverts cleanly.
    if (touched) surface._profileUpdateSource = "supabase-live";
  } catch {
    // keep whatever the surface already carries
  }
  return surface;
}

// Apply the live Supabase cohort-events overlay: the "two-way contribution layer"
// activity feed. Reads the recent app_cohort_feed slice (claim hash stripped,
// superseded events collapsed) and folds it onto the surface as `cohort_events`
// for the activity panel + the on-device "for you" re-rank (feed-rank.mjs).
//
// Unlike applyProfileUpdateOverlay, this DOES NOT mutate person FIELD VALUES — the
// spine is the timeline/feed/provenance, not a profile-value channel. Field values
// keep flowing through the existing reversible/operator-gated paths (see the v0
// scope note in the cohort_events migration). A `profile_edit` event is a feed
// signal of a change a member made through the normal save path, not the value.
// On a Supabase outage — or before the table exists — the surface keeps whatever
// it already carries (an LS-cached set, or empty), so the feed degrades gracefully.
async function applyCohortEventsOverlay(surface) {
  try {
    const { events, source } = await fetchCohortFeed();
    if (source === "supabase") {
      // Asks now ride the same spine (event_type 'ask'). Split them out: ask events
      // fold into the ask BOARD (asks-events.reduceAsks, over the committed markdown
      // asks as the baseline) rather than rendering as generic "contributed" feed
      // lines; everything else stays the activity feed. reduceAsks is idempotent, so
      // reducing over an already-reduced baseline on a cache-derived refresh is safe.
      const askEvents = [];
      const otherEvents = [];
      for (const ev of events) {
        if (ev && ev.event_type === "ask") askEvents.push(ev);
        else otherEvents.push(ev);
      }
      surface.cohort_events = otherEvents;
      surface.asks = reduceAsks(askEvents, Array.isArray(surface.asks) ? surface.asks : []);
      surface._cohortEventsSource = "supabase-live";
      surface._asksSource = askEvents.length ? "supabase-live" : (surface._asksSource || "baseline");
    }
  } catch {
    // keep whatever the surface already carries
  }
  return surface;
}

// Apply the live Supabase release-feed overlay. The membrane "what's new" feed
// (whats_new + github_releases) is published to public_releases_feed by the
// github-releases-sync workflow, so a new release shows up live — no git PR into
// protected main required (which is what previously froze the feed). This is the
// SAME live-source / committed-fallback split the calendar uses. On a Supabase
// outage — or before the table exists — the surface keeps whatever it already
// carries (the committed bundle's whats_new, or an LS-cached set), so the feed
// degrades gracefully instead of going stale-forever. We only overwrite when the
// live row actually carries items, so an empty/missing row never blanks a feed
// the committed bundle could still render.
async function applyReleaseOverlay(surface) {
  try {
    const { whatsNew, githubReleases, source } = await fetchReleasesFeed();
    if (source === "supabase") {
      if (Array.isArray(whatsNew) && whatsNew.length) surface.whats_new = whatsNew;
      if (Array.isArray(githubReleases) && githubReleases.length) surface.github_releases = githubReleases;
      surface._releaseSource = "supabase-live";
    }
  } catch {
    // keep whatever the surface already carries
  }
  return surface;
}

// Apply the precomputed cohort connection graph onto the surface. The daily
// connection routine publishes ranked, reasoned "who should talk to whom" edges
// to public_cohort_connections; we read that row LIVE and hang the per-record
// adjacency on each team/person as `record.connections` so detail pages can show
// a "who to talk to" block and cohort chat can ground its answers in the same
// edges. The APP never calls an LLM here — it only reads precomputed edges.
//
// Live row wins; on a Supabase outage — or before the table exists — we fall
// back to the committed `surface.cohort_connections` bundle (offline / first
// paint), and if neither has edges every record just carries connections:[] and
// the "who to talk to" block hides itself. Never throws.
async function applyConnectionsOverlay(surface) {
  try {
    let edges = [];
    let source = "";
    const live = await fetchConnections();
    if (live.source === "supabase" && Array.isArray(live.edges) && live.edges.length) {
      edges = live.edges;
      source = "supabase-live";
    } else if (surface.cohort_connections && Array.isArray(surface.cohort_connections.edges)) {
      edges = surface.cohort_connections.edges;
      source = surface._connectionSource || "bundle";
    }
    const teams = Array.isArray(surface.teams) ? surface.teams : [];
    const people = Array.isArray(surface.people) ? surface.people : [];
    const nameById = new Map();
    for (const r of [...teams, ...people]) {
      if (r && r.record_id) nameById.set(r.record_id, r.name || r.record_id);
    }
    const byRecord = connectionsByRecord(edges, nameById);
    for (const r of [...teams, ...people]) {
      if (r && r.record_id) r.connections = byRecord.get(r.record_id) || [];
    }
    if (source) surface._connectionSource = source;
  } catch {
    // keep whatever the surface already carries
  }
  return surface;
}

function signatureOf(grouped) {
  const hash = (value) => {
    const s = String(value ?? "");
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  };
  const fp = (...parts) => hash(parts.map(p => String(p ?? "")).join("\0"));
  const recordSig = (arr) => arr.map(r => `${r?.record_id || ""}:${fp(JSON.stringify(r || {}))}`).sort().join("|");
  const arraySig = (arr) => arr.map(r => fp(JSON.stringify(r || {}))).sort().join("|");
  // Program-page edits are full-body markdown swaps, not record_id churn —
  // hash the content so even same-length text edits trip the refresh notifier.
  // Use full public-record fingerprints for entity lists. Many rendered
  // insights are driven by fields other than record_id (cluster teams, legacy
  // dependencies, seek/offer chips, journey fields), so coarse signatures can
  // leave an updated cache on screen with no subscriber re-render.
  const personSig = recordSig;
  const teamSig = recordSig;
  const clusterSig = recordSig;
  const depSig = recordSig;
  const progSig = recordSig;
  const askSig = recordSig;
  const eventSig = recordSig;
  const cueSig = arraySig;
  const insightSig = arraySig;
  const objectSig = (value) => fp(JSON.stringify(value || {}));
  const timelineSig = (map) => Object.entries(map || {})
    .map(([id, items]) => `${id}:${Array.isArray(items) ? items.length : 0}:${fp(JSON.stringify(items || []))}`)
    .sort()
    .join("|");
  return `${grouped.teams.length}:${teamSig(grouped.teams)}#${grouped.people.length}:${personSig(grouped.people)}#${grouped.clusters.length}:${clusterSig(grouped.clusters)}#${grouped.dependencies.length}:${depSig(grouped.dependencies)}#${grouped.program.length}:${progSig(grouped.program)}#${grouped.events.length}:${eventSig(grouped.events)}#${grouped.asks.length}:${askSig(grouped.asks)}#${(grouped.constellation_cues || []).length}:${cueSig(grouped.constellation_cues || [])}#si:${(grouped.session_insights || []).length}:${insightSig(grouped.session_insights || [])}#wn:${(grouped.whats_new || []).length}:${arraySig(grouped.whats_new || [])}#gr:${(grouped.github_releases || []).length}:${arraySig(grouped.github_releases || [])}#tec:${(grouped.transcript_evidence_cards || []).length}:${arraySig(grouped.transcript_evidence_cards || [])}#ca:${(grouped.cohort_articles || []).length}:${arraySig(grouped.cohort_articles || [])}#te:${objectSig(grouped.transcript_evidence)}#td:${objectSig(grouped.transcript_distillations)}#ci:${objectSig(grouped.cohort_intel)}#ins:${objectSig(grouped.cohort_insights)}#pt:${timelineSig(grouped.person_timeline)}#tt:${timelineSig(grouped.team_timeline)}#ps:${objectSig(grouped.person_spheres)}#ce:${(grouped.cohort_events || []).length}:${arraySig(grouped.cohort_events || [])}`;
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
      // Gate on the last ATTEMPT, not the last success: when GitHub is
      // erroring/rate-limited we never advanced _baselineFetchedAt, so a stale
      // baseline (or a null one on first launch) re-fired the fetch every tick.
      // A manual resync (forceGithub) still bypasses both throttles.
      const attemptThrottled = (now - _baselineLastAttemptAt) < GH_BASELINE_MIN_GAP_MS;
      const shouldFetchGh = forceGithub || (baselineStale && !attemptThrottled);

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
        // Stamp the attempt up-front so a throw below still counts as a try and
        // backs off for GH_BASELINE_MIN_GAP_MS instead of retrying next tick.
        _baselineLastAttemptAt = now;
        try {
          baseline = await loadFromGithub();
          baseline._source = "github";
          _baseline = baseline;
          _baselineFetchedAt = now;
        } catch (e) {
          console.warn("[cohort-source] github unreachable; reusing prior baseline:", e?.message || e);
          // Keep a prior GitHub baseline if we have one; otherwise fall
          // through to the bundled fixture so first-launch or old fixture
          // snapshots don't stay stale forever while GitHub is blocked.
          if (!baseline) {
            try {
              const fixture = await loadFromFixture();
              const cacheSource = String(_cache?._storedSource || _cache?._source || "");
              const cacheWasGithub = cacheSource.includes("github");
              const cacheGenerated = Date.parse(_cache?._generated_at || "");
              const fixtureGenerated = Date.parse(fixture?._generated_at || "");
              const fixtureIsNewer = Number.isFinite(fixtureGenerated)
                && (!Number.isFinite(cacheGenerated) || fixtureGenerated > cacheGenerated);
              if (!_cache || _cache._source === "empty-bootstrap" || (!cacheWasGithub && (!Number.isFinite(cacheGenerated) || fixtureIsNewer))) {
                baseline = fixture;
                baseline._source = "fixture";
              }
            } catch { baseline = null; }
          }
        }
      }
      if (!baseline && _cache) {
        baseline = normalize(_cache);
        baseline._source = _cache._source || "cache";
      }
      if (!baseline) return; // nothing to merge against

      const merged = await applySyncOverlayCached(baseline);
      await applyEvidenceOverlay(merged);
      await applyArticleOverlay(merged);
      await applyDistillationOverlay(merged);
      await applySphereOverlay(merged);
      await applyProfileUpdateOverlay(merged);
      await applyCohortEventsOverlay(merged);
      await applyReleaseOverlay(merged);
      await applyConnectionsOverlay(merged);
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

function refreshIntervalMs() {
  return _cache?._syncAvailable ? SYNC_REFRESH_MS : REFRESH_MS;
}

function isDocumentHidden() {
  return typeof document !== "undefined" && document.hidden;
}

function runRefreshTickIfVisible() {
  if (isDocumentHidden()) return;
  refreshTick().catch((err) => {
    console.warn("[cohort-source] refresh tick failed:", err?.message || err);
  });
}

function bindRefreshVisibilityWake() {
  if (_refreshVisibilityBound) return;
  if (typeof document === "undefined" || !document.addEventListener) return;
  _refreshVisibilityTarget = document;
  _refreshVisibilityHandler = () => {
    if (!_refreshTimer || isDocumentHidden()) return;
    runRefreshTickIfVisible();
  };
  _refreshVisibilityBound = true;
  _refreshVisibilityTarget.addEventListener("visibilitychange", _refreshVisibilityHandler);
}

function rescheduleRefreshTimerIfNeeded(prevSyncAvailable) {
  const nextSyncAvailable = !!_cache?._syncAvailable;
  if (prevSyncAvailable === nextSyncAvailable) return;
  if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
  scheduleRefresh();
}

function scheduleRefresh() {
  if (_refreshTimer) return;
  // Use the faster cadence when sync is live so a peer's profile edit
  // shows up within one sync tick instead of waiting on the github poll.
  // The fallback is still gh-only when swf-node is unreachable.
  const interval = refreshIntervalMs();
  _refreshTimer = setInterval(runRefreshTickIfVisible, interval);
  bindRefreshVisibilityWake();
}

async function refreshTick() {
  // Polled refresh delegates to the same background path used on first
  // boot, so we don't have two slightly-different resolve paths to keep
  // in sync. The LS write + subscriber notify happens inside
  // _startBackgroundRefresh; we only handle sync-availability cadence
  // switching here.
  const prevSyncAvailable = !!_cache?._syncAvailable;
  await _startBackgroundRefresh();
  rescheduleRefreshTimerIfNeeded(prevSyncAvailable);
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
  _baselineLastAttemptAt = 0;
  _bgRefreshInFlight = null;
  _subscribers.clear();
  if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
  if (_refreshVisibilityTarget && _refreshVisibilityHandler) {
    try { _refreshVisibilityTarget.removeEventListener("visibilitychange", _refreshVisibilityHandler); } catch {}
  }
  _refreshVisibilityTarget = null;
  _refreshVisibilityHandler = null;
  _refreshVisibilityBound = false;
  try { localStorage.removeItem(SURFACE_LS_KEY); } catch {}
}
