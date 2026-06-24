// publish-releases-to-supabase.mjs
//
// Publishes the membrane "what's new" release feed to the public_releases_feed
// row in Supabase, so the OS + web apps read it LIVE instead of waiting on a git
// PR merging into protected main. Runs in the github-releases-sync workflow with
// the service-role key (server-side only — never shipped to a client). Mirrors
// publish-calendar-grid-to-supabase.mjs; the read side is
// apps/os/src/renderer/supabase-releases.mjs.
//
// Backfill: unlike the committed cohort-surface.json bundle — which caps
// releases per project (PER_PROJECT_RELEASE_LIMIT = 12 in build-bundles.js) to
// keep the committed file byte-stable — this LIVE payload carries the FULL
// in-window release history per project. The committed cap silently dropped a
// project's older releases (e.g. shape-rotator-os's entire 0.1.x/0.2.x May
// history), leaving visible gaps; the live feed is the complete program log the
// membrane intends.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import yaml from "js-yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COHORT_DIR = path.join(ROOT, "cohort-data");
const ARTIFACTS_DIR = path.join(COHORT_DIR, "artifacts", "github-releases", "generated");
const SURFACE_PATH = path.join(ROOT, "apps", "os", "src", "cohort-surface.json");
const ROW_ID = "current";

// High per-project cap: scripts/check-github-releases.mjs already bounds each
// artifact (gh release list --limit 100), so this effectively means "every
// in-window release" while still guarding a pathological repo.
const PER_PROJECT_RELEASE_LIMIT = 100;
// Generous global backstop — the live feed is the complete program log, so this
// only guards against pathological growth, not a "top N" display limit. The
// renderer further caps at its own FEED_MAX (200).
const FEED_MAX = 600;

function isoDate(value) {
  if (value == null || value === "") return "";
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
  return d.toISOString().slice(0, 10);
}

// Lower bound for the feed window — read from timeline.yml so it tracks the
// canonical cohort config (mirrors build-bundles.js readProgramStart). Clips
// pre-program history (e.g. a dependency's months of pre-cohort alphas).
export function readProgramStart() {
  try {
    const cfg = yaml.load(fs.readFileSync(path.join(COHORT_DIR, "timeline.yml"), "utf8")) || {};
    return isoDate(cfg.program_start) || "2026-05-18";
  } catch {
    return "2026-05-18";
  }
}

// Pure: flatten github_release_list artifacts into newest-first feed items,
// FULL history per project clipped to the program window. Mirrors
// releaseFeedItems() in build-bundles.js but without the low per-project cap.
// Each item is { date, kind:"release", label, meta, nav } — the exact shape the
// renderer's membrane feed already consumes from `github_releases`/`whats_new`.
export function buildReleaseItems(artifacts, teams, { since, perProjectLimit = PER_PROJECT_RELEASE_LIMIT } = {}) {
  const nameById = new Map((teams || []).map((t) => [String(t.record_id || ""), t.name || t.record_id]));
  const out = [];
  for (const artifact of (Array.isArray(artifacts) ? artifacts : [])) {
    if (artifact?.artifact_kind !== "github_release_list") continue;
    const teamId = String(artifact.record_id || "").trim();
    const project = nameById.get(teamId) || teamId;
    const nav = { mode: "shapes", recordId: teamId };
    const recent = (Array.isArray(artifact.releases) ? artifact.releases : [])
      .filter((r) => !since || isoDate(r.published_at) >= since)
      .sort((a, b) => String(b.published_at || "").localeCompare(String(a.published_at || "")))
      .slice(0, perProjectLimit);
    for (const release of recent) {
      const date = isoDate(release.published_at);
      const label = String(release.name || release.tag_name || "").trim();
      if (!date || !label) continue;
      out.push({ date, kind: "release", label, meta: project, nav });
    }
  }
  return out.sort((x, y) => String(y.date).localeCompare(String(x.date)));
}

// Combine backfilled releases with the non-release items already in the
// committed surface's whats_new (commit digests / asks / events), newest-first,
// capped. Releases are the only kind we recompute here — the others ride along
// unchanged from the deterministic build.
export function buildWhatsNew(releaseItems, baseWhatsNew, { max = FEED_MAX, perProject = 4 } = {}) {
  const others = (Array.isArray(baseWhatsNew) ? baseWhatsNew : []).filter((it) => it && it.kind !== "release");
  // Cap releases per project in the FEED so one prolific repo (e.g. the OS app's
  // full backfilled history) can't flood it; the complete history still ships in
  // github_releases. `others` (commits/asks/events) rides through from the
  // committed surface, which is already per-project capped in build-bundles.js.
  const perProj = new Map();
  const cappedReleases = [];
  for (const it of (Array.isArray(releaseItems) ? releaseItems : [])
    .slice()
    .sort((x, y) => String(y.date).localeCompare(String(x.date)))) {
    const key = String(it.meta || "");
    const n = perProj.get(key) || 0;
    if (n >= perProject) continue;
    perProj.set(key, n + 1);
    cappedReleases.push(it);
  }
  return [...cappedReleases, ...others]
    .sort((x, y) => String(y.date).localeCompare(String(x.date)))
    .slice(0, max);
}

// Pure + deterministic (pass `now`) so it is unit-testable without a live
// Supabase. Builds the PostgREST upsert request for the single feed row.
export function buildUpsertRequest({ url, payload, rowId = ROW_ID, source = "github-releases-sync", now }) {
  const base = String(url || "").replace(/\/+$/, "");
  if (!base) throw new Error("SUPABASE_URL is required");
  if (!payload || typeof payload !== "object"
      || !Array.isArray(payload.whats_new) || !Array.isArray(payload.github_releases)) {
    throw new Error("payload must be an object with whats_new[] and github_releases[]");
  }
  return {
    url: `${base}/rest/v1/public_releases_feed?on_conflict=id`,
    body: {
      id: rowId,
      payload,
      source,
      // Bump on every upsert (the column default only fires on INSERT).
      updated_at: now || new Date().toISOString(),
    },
  };
}

function readArtifacts(dir = ARTIFACTS_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "manifest.json")
    .map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); }
      catch (e) { console.warn(`[publish-releases] unreadable artifact ${f}: ${e.message}`); return null; }
    })
    .filter(Boolean);
}

function readSurface(file = SURFACE_PATH) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return { teams: [], whats_new: [] }; }
}

// Build the payload from the committed inputs (artifacts + freshly-built
// surface) without any network. Exposed for tests.
export function buildReleasesPayload({ artifacts, surface, since } = {}) {
  const sfc = surface || readSurface();
  const arts = artifacts || readArtifacts();
  const window = since || readProgramStart();
  const releaseItems = buildReleaseItems(arts, sfc.teams || [], { since: window });
  const whats_new = buildWhatsNew(releaseItems, sfc.whats_new || []);
  return { whats_new, github_releases: releaseItems };
}

// Upsert the feed. Resolves { skipped:true } when Supabase env is absent (local
// dev / unconfigured) so the workflow never hard-fails on the publish step;
// throws only on a real HTTP error so CI surfaces a misconfiguration.
export async function publishReleasesFeed({
  url = process.env.SUPABASE_URL,
  key = process.env.SUPABASE_SERVICE_ROLE_KEY,
  artifacts,
  surface,
  since,
  fetchImpl = globalThis.fetch,
  now,
} = {}) {
  if (!url || !key) {
    return { skipped: true, reason: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set" };
  }
  const payload = buildReleasesPayload({ artifacts, surface, since });
  const { url: reqUrl, body } = buildUpsertRequest({ url, payload, now });
  const res = await fetchImpl(reqUrl, {
    method: "POST",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      // merge-duplicates = upsert on the id PK; minimal = don't echo the row.
      prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Supabase upsert failed: ${res.status} ${text}`.trim());
  }
  return {
    skipped: false,
    status: res.status,
    releases: payload.github_releases.length,
    whats_new: payload.whats_new.length,
  };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  publishReleasesFeed()
    .then((r) => {
      console.log(
        r.skipped
          ? `[publish-releases] skipped — ${r.reason}`
          : `[publish-releases] published ${r.releases} releases / ${r.whats_new} feed items to public_releases_feed (HTTP ${r.status})`,
      );
    })
    .catch((e) => {
      console.error(`[publish-releases] ${e.message}`);
      process.exit(1);
    });
}
