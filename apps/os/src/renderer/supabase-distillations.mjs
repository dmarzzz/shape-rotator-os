// supabase-distillations.mjs — the READ side for distilled transcript readouts.
//
// Reads the cohort's per-session DISTILLED readouts LIVE from Supabase so the
// "transcripts" tab can show the cleaned, paraphrased distillations alongside the
// user's local raw vault — without a repo rebuild or a committed bundle.
//
// Privacy posture (see the engine migration 20260618170000_cohort_app_distillation_
// reader.sql): the readouts live in public.derived_artifacts and are exposed to the
// distributed app via the GATED cohort_app_transcript_distillations view, read with
// the same role=cohort_app JWT that reads the T2 evidence cards. That view keeps the
// distillation safety filters (paraphrased source_transform, publishable artifact_
// kind, reviewed/published T2 only), so raw transcripts can never flow through it.
// Like the cohort evidence reader, this NEVER reads with anon — no cohort key means
// the reader no-ops (the public web / un-provisioned build shows local raw only).

import { readSupabaseConfig } from "./supabase-evidence.mjs";

// Columns the gated distillation view exposes (must match the migration's select
// list). content_md is the distilled readout body; content_json carries the
// session metadata (title/date/themes/teams) the tab renders.
const DISTILLATION_COLUMNS = [
  "id", "artifact_kind", "surface_tier", "confidence", "content_json", "content_md", "created_at",
].join(",");

export function cohortDistillationsUrl(baseUrl) {
  const url = new URL(`${baseUrl}/rest/v1/cohort_app_transcript_distillations`);
  url.searchParams.set("select", DISTILLATION_COLUMNS);
  url.searchParams.set("order", "created_at.desc");
  return url.toString();
}

function clean(value) {
  return value == null ? "" : String(value).trim();
}

function firstString(obj, keys) {
  for (const k of keys) {
    const v = obj && obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function stringList(value) {
  return Array.isArray(value) ? value.map((v) => clean(v)).filter(Boolean) : [];
}

// The engine puts the session title in the FIRST markdown heading of the readout
// body — content_json carries routing/policy metadata, not a title field.
function firstHeading(md) {
  const m = String(md || "").match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : "";
}

// Shape a derived_artifacts row into the distilled-transcript record the
// transcripts tab renders. The engine nests the synthesis under
// content_json.distillation (themes/summary[]/action_items/open_questions) with
// routing metadata (session_type, policy_*) at the top level; this is defensive
// about that (and older flat shapes) so an entry is always identifiable.
export function normalizeDistillation(row) {
  if (!row || typeof row !== "object") return null;
  const id = clean(row.id);
  if (!id) return null;
  const cj = (row.content_json && typeof row.content_json === "object") ? row.content_json : {};
  const dist = (cj.distillation && typeof cj.distillation === "object") ? cj.distillation : {};
  const body = clean(row.content_md);
  const conf = typeof row.confidence === "number" ? row.confidence : Number(row.confidence);
  const sessionType = firstString(cj, ["session_type", "session_kind"]);
  // summary is an array of bullets in the distillation shape, or a single string.
  const summaryRaw = dist.summary != null ? dist.summary : (cj.summary != null ? cj.summary : cj.one_liner);
  const summary = Array.isArray(summaryRaw) ? clean(summaryRaw[0]) : clean(summaryRaw);
  const themes = (Array.isArray(dist.themes) && dist.themes.length) ? dist.themes : cj.themes;
  return {
    id,
    kind: clean(row.artifact_kind) || "readout",
    surface_tier: clean(row.surface_tier) || "T2",
    // Prefer an explicit title field; else the body's first heading; else the session type.
    title: firstString(cj, ["title", "session_title", "heading", "name"])
      || firstHeading(body)
      || (sessionType ? sessionType.replace(/_/g, " ") : ""),
    session_type: sessionType,
    date: firstString(cj, ["date", "session_date"]) || row.created_at || null,
    week_start: firstString(cj, ["week_start"]),
    summary,
    themes: stringList(themes),
    teams: stringList((Array.isArray(dist.teams) && dist.teams.length) ? dist.teams : cj.teams),
    people: stringList((Array.isArray(dist.people) && dist.people.length) ? dist.people : cj.people),
    body_md: body,
    confidence: Number.isFinite(conf) ? conf : null,
    created_at: row.created_at || null,
    source: "supabase-cohort",
  };
}

// Fetch the GATED cohort distilled readouts with the cohort key. No-ops (returns
// source:"unconfigured") when no cohort key is set — the public web bundle and
// un-provisioned builds, which then show only the local raw vault. Always resolves
// (never throws) so a Supabase outage degrades to "no distilled transcripts".
export async function fetchCohortDistillations({ storage, fetchImpl, config } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const { url, anonKey, cohortKey } = config || readSupabaseConfig(storage);
  if (!url || !anonKey || !cohortKey || typeof doFetch !== "function") {
    return { artifacts: [], source: "unconfigured" };
  }
  let res;
  try {
    // Same gateway discipline as the evidence reader: apikey MUST be the anon key
    // (Kong validates it before PostgREST), the cohort_app role rides in Bearer.
    res = await doFetch(cohortDistillationsUrl(url), {
      headers: { apikey: anonKey, authorization: `Bearer ${cohortKey}`, accept: "application/json" },
      cache: "no-store",
    });
  } catch (error) {
    return { artifacts: [], source: "error", error: String(error && error.message ? error.message : error) };
  }
  if (!res || !res.ok) return { artifacts: [], source: "error", error: `HTTP ${res ? res.status : "no response"}` };
  let rows;
  try { rows = await res.json(); } catch { return { artifacts: [], source: "error", error: "invalid JSON from Supabase" }; }
  const artifacts = Array.isArray(rows) ? rows.map(normalizeDistillation).filter(Boolean) : [];
  return { artifacts, source: "supabase-cohort" };
}
