// supabase-transcript-routing.mjs — the READ side for per-person transcript
// RELEVANCE routing ("which distilled transcripts are relevant to me, and why").
//
// Reads the gated cohort_app_transcript_routing view LIVE from Supabase with the
// same role=cohort_app JWT the distillation + evidence readers use. The engine
// (scripts/build-transcript-routing.mjs) scores each (person, transcript) pair and
// publishes reviewed rows; this view exposes only reviewed/published rows, no
// org/provenance columns. The "for you" filter happens ON-DEVICE — the renderer
// keeps only rows whose record_id matches the viewing member's identity, mirroring
// the cohort_events re-rank posture. No cohort key (public web / un-provisioned
// build) or a Supabase outage no-ops to source:"unconfigured" and an empty list.

import { readSupabaseConfig } from "./supabase-evidence.mjs";
import { fetchAnon } from "./supabase-anon-write.mjs";

// Columns the gated routing view exposes (must match the migration's select list).
const ROUTING_COLUMNS = [
  "record_id", "session_title", "session_type", "score", "basis", "reason", "generated_at",
].join(",");

// Highest-relevance first — the tab shows a ranked "for you" list.
const ROUTING_PATH = `cohort_app_transcript_routing?select=${ROUTING_COLUMNS}&order=score.desc`;

export function cohortTranscriptRoutingUrl(baseUrl) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}/rest/v1/${ROUTING_PATH}`;
}

function clean(value) {
  return value == null ? "" : String(value).trim();
}

// Shape a transcript_routing row into the record the routing tab renders.
export function normalizeRoutingRow(row) {
  if (!row || typeof row !== "object") return null;
  const record_id = clean(row.record_id);
  const session_title = clean(row.session_title);
  if (!record_id || !session_title) return null;
  const score = typeof row.score === "number" ? row.score : Number(row.score);
  return {
    record_id,
    session_title,
    session_type: clean(row.session_type),
    score: Number.isFinite(score) ? score : null,
    basis: clean(row.basis),
    reason: clean(row.reason),
    generated_at: row.generated_at || null,
    source: "supabase-cohort",
  };
}

// The ranked relevant transcripts for one member (the on-device "for you" filter).
// Rows already arrive score.desc; re-sort defensively so callers can pass any set.
export function relevantTranscriptsFor(rows, recordId) {
  const id = clean(recordId);
  if (!id || !Array.isArray(rows)) return [];
  return rows
    .filter((r) => r && clean(r.record_id) === id)
    .slice()
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
}

// Fetch the GATED per-person routing rows with the cohort key. No-ops (returns
// source:"unconfigured") when no cohort key is set. Always resolves (never throws)
// so a Supabase outage degrades to "no routing".
export async function fetchCohortTranscriptRouting(opts = {}) {
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const { url, anonKey, cohortKey } = opts.config || readSupabaseConfig(opts.storage);
  if (!url || !anonKey || !cohortKey || typeof doFetch !== "function") {
    return { rows: [], source: "unconfigured" };
  }
  // Same gateway discipline as the distillation reader: apikey is the anon key,
  // the cohort_app role rides in Bearer via fetchAnon's bearer override.
  const { rows, source, error } = await fetchAnon(ROUTING_PATH, { ...opts, bearer: cohortKey });
  if (source !== "supabase") return { rows: [], source, error };
  const normalized = rows.map(normalizeRoutingRow).filter(Boolean);
  return { rows: normalized, source: "supabase-cohort" };
}
