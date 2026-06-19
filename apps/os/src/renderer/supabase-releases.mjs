// supabase-releases.mjs — the READ side of the live membrane "what's new" feed.
//
// Reads the release feed LIVE from Supabase (the public_releases_feed row
// published by the github-releases-sync workflow), so a new release reaches the
// membrane within the hour without waiting on a git PR merging into protected
// main. Mirrors calendar-supabase.mjs: an anon SELECT of a curated PUBLIC
// projection (never a gated base table), with the bundled cohort-surface.json
// as the offline / first-paint fallback.
//
// The payload holds { whats_new, github_releases } — the same feed-item arrays
// the app already built into the committed surface, just carrying the FULL
// in-window release history instead of the byte-stable committed cap. An anon
// read here exposes nothing the membrane feed didn't already show. RLS grants
// anon only SELECT on this one row.

import { readSupabaseConfig } from "./supabase-evidence.mjs";

// PostgREST URL for the single public feed row.
export function publicReleasesFeedUrl(baseUrl) {
  const url = new URL(`${baseUrl}/rest/v1/public_releases_feed`);
  url.searchParams.set("select", "payload,source,updated_at");
  url.searchParams.set("id", "eq.current");
  url.searchParams.set("limit", "1");
  return url.toString();
}

// Only pass through well-formed feed items so a malformed row can't poison the
// renderer. Each item must carry a date + label; everything else is optional.
function sanitizeItems(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((it) => it && typeof it === "object"
    && typeof it.date === "string" && it.date
    && typeof it.label === "string" && it.label);
}

// Validate the row's payload is the shape the renderer expects
// ({ whats_new: [...], github_releases: [...] }). Returns null when neither list
// has usable items so callers fall back to the committed bundle.
export function normalizeReleasesPayload(row) {
  if (!row || typeof row !== "object") return null;
  const payload = row.payload;
  if (!payload || typeof payload !== "object") return null;
  const whatsNew = sanitizeItems(payload.whats_new);
  const githubReleases = sanitizeItems(payload.github_releases);
  if (!whatsNew.length && !githubReleases.length) return null;
  return { whatsNew, githubReleases };
}

// Fetch the live release feed. Always resolves (never throws) so a Supabase
// outage degrades to the committed bundle. Returns { whatsNew, githubReleases,
// source }: source is "supabase" on success, "unconfigured" with no anon key,
// "empty" when the row is missing/malformed, or "error" with an `error` string.
export async function fetchReleasesFeed({ storage, fetchImpl, config } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const { url, anonKey } = config || readSupabaseConfig(storage);
  if (!url || !anonKey || typeof doFetch !== "function") {
    return { whatsNew: [], githubReleases: [], source: "unconfigured" };
  }
  let res;
  try {
    res = await doFetch(publicReleasesFeedUrl(url), {
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${anonKey}`,
        accept: "application/json",
      },
      cache: "no-store",
    });
  } catch (error) {
    return { whatsNew: [], githubReleases: [], source: "error", error: String(error && error.message ? error.message : error) };
  }
  if (!res || !res.ok) {
    return { whatsNew: [], githubReleases: [], source: "error", error: `HTTP ${res ? res.status : "no response"}` };
  }
  let rows;
  try {
    rows = await res.json();
  } catch {
    return { whatsNew: [], githubReleases: [], source: "error", error: "invalid JSON from Supabase" };
  }
  const payload = normalizeReleasesPayload(Array.isArray(rows) ? rows[0] : rows);
  if (!payload) return { whatsNew: [], githubReleases: [], source: "empty" };
  return { whatsNew: payload.whatsNew, githubReleases: payload.githubReleases, source: "supabase" };
}
