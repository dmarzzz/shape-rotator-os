// supabase-evidence.js — the READ side of the transcript pipeline.
//
// Reads distilled transcript evidence cards LIVE from Supabase at runtime, so
// the app reflects what the distillation engine uploads without a repo rebuild
// or a committed bundle. Per the privacy posture decided 2026-06-14
// (supabase/migrations/20260614040900_public_anon_transcript_evidence_view.sql):
//
//   - PUBLIC, person-anonymized T3 cards are exposed to `anon` via the
//     public_transcript_evidence_cards view (the only thing this module reads).
//   - Named / cohort-internal cards stay gated behind app_transcript_evidence_cards
//     (authenticated org members only) — a member-auth roadmap item. When app
//     login lands, an authed reader drops in alongside this one (same shape).
//
// The view already enforces every T3 gate (published + approved + anonymous +
// generalized_no_named_insights) and the boundary trigger guarantees no raw
// transcript / email / Drive-vault / provenance markers, so an anon SELECT here
// cannot leak private content.

// The Supabase connection config + key resolution moved to supabase-config.mjs (a
// leaf module the anon read/write primitives depend on without an import cycle).
// Re-exported here so existing importers of these from supabase-evidence keep
// working unchanged.
import {
  readSupabaseConfig,
  persistCohortKeyOverride,
  resolveDefaultCohortKey,
  DEFAULT_PUBLIC_ANON_KEY,
  DEFAULT_COHORT_KEY,
} from "./supabase-config.mjs";
export {
  readSupabaseConfig,
  persistCohortKeyOverride,
  resolveDefaultCohortKey,
  DEFAULT_PUBLIC_ANON_KEY,
  DEFAULT_COHORT_KEY,
};
import { fetchAnon } from "./supabase-anon-write.mjs";

// ENABLED — the gated T2 cohort reader is live. Its backing migration is deployed
// and the view (cohort_app_transcript_evidence_cards) exists (verified against the
// cohort DB 2026-06-20: an unauthenticated read returns 401, not 404 — the view is
// present, gated by the cohort_app role). With a cohort key present the app reads
// named / cohort-internal T2 cards live; with NO key (the public web bundle or an
// un-provisioned build) fetchCohortEvidenceCards no-ops and the app falls back to the
// anon T3 read + committed bundle. Every failure path is graceful (try/catch, returns
// source:"error"/"unconfigured"), so enabling this can only ADD the named tier when a
// key is configured — it never breaks the public / un-provisioned path. (This reverses
// the temporary 00a7a828 disable, whose "the migration does not exist yet" premise was
// outdated — the migration had already shipped.)
export const COHORT_APP_READER_ENABLED = true;

// Columns the anon view exposes (must match the migration's select list).
const PUBLIC_CARD_COLUMNS = [
  "id", "claim_type", "title", "claim_text", "summary",
  "evidence_level", "confidence", "attribution_scope", "content_json", "created_at",
].join(",");

// Columns the GATED cohort (T2) view exposes — includes surface_tier + the full
// content_json (date/week_start/teams) the cohort views key off. No org/session.
const COHORT_CARD_COLUMNS = [
  "id", "claim_type", "title", "claim_text", "summary", "evidence_level",
  "confidence", "attribution_scope", "surface_tier", "content_json", "created_at", "reviewed_at",
].join(",");

const COHORT_EVIDENCE_PATH = `cohort_app_transcript_evidence_cards?select=${COHORT_CARD_COLUMNS}&order=created_at.desc`;

export function cohortEvidenceCardsUrl(baseUrl) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}/rest/v1/${COHORT_EVIDENCE_PATH}`;
}

// Fetch the GATED T2 cohort evidence using the cohort key. No-ops (returns
// source:"unconfigured") when no cohort key is set — the public web bundle and
// un-provisioned builds, which then fall back to the anon T3 read. Always resolves.
// Kong validates apikey=anon before PostgREST; the cohort_app role rides in the
// Bearer token (fetchAnon's bearer override) for SET ROLE.
export async function fetchCohortEvidenceCards(opts = {}) {
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const { url, anonKey, cohortKey } = opts.config || readSupabaseConfig(opts.storage);
  if (!url || !anonKey || !cohortKey || typeof doFetch !== "function") {
    return { cards: [], source: "unconfigured" };
  }
  const { rows, source, error } = await fetchAnon(COHORT_EVIDENCE_PATH, { ...opts, bearer: cohortKey });
  if (source !== "supabase") return { cards: [], source, error };
  const cards = rows.map(normalizeCard).filter(Boolean).map((c) => ({ ...c, surface_tier: "T2", source: "supabase-cohort" }));
  return { cards, source: "supabase-cohort" };
}

// Columns the gated cohort-insight view exposes (must match the engine migration's
// select list for cohort_app_cohort_insight_cards).
const COHORT_INSIGHT_COLUMNS = [
  "id", "kind", "subject_type", "subject_ids", "title", "claim_text", "summary",
  "evidence_level", "confidence", "surface_tier", "source_refs", "content_json",
  "generated_at", "created_at", "reviewed_at",
].join(",");

const COHORT_INSIGHT_PATH = `cohort_app_cohort_insight_cards?select=${COHORT_INSIGHT_COLUMNS}&order=generated_at.desc`;

export function cohortInsightCardsUrl(baseUrl) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}/rest/v1/${COHORT_INSIGHT_PATH}`;
}

// Fetch GATED cohort-tier insight cards (collaboration_contribution, project_narrative)
// with the cohort key — the runtime source for the engine-produced collaboration edges
// (the engine generates + reviews these and publishes them to Supabase; the OS only
// renders). No-ops (source:"unconfigured") without a cohort key. Always resolves; a
// Supabase outage degrades to "no collaboration edges".
export async function fetchCohortInsightCards(opts = {}) {
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const { url, anonKey, cohortKey } = opts.config || readSupabaseConfig(opts.storage);
  if (!url || !anonKey || !cohortKey || typeof doFetch !== "function") {
    return { cards: [], source: "unconfigured" };
  }
  const { rows, source, error } = await fetchAnon(COHORT_INSIGHT_PATH, { ...opts, bearer: cohortKey });
  if (source !== "supabase") return { cards: [], source, error };
  const cards = rows.filter((r) => r && r.id).map((r) => ({
    id: String(r.id),
    kind: String(r.kind || ""),
    subject_type: String(r.subject_type || ""),
    subject_ids: Array.isArray(r.subject_ids) ? r.subject_ids : [],
    title: String(r.title || ""),
    claim_text: String(r.claim_text || ""),
    summary: r.summary == null ? null : String(r.summary),
    evidence_level: String(r.evidence_level || ""),
    confidence: String(r.confidence || ""),
    source_refs: Array.isArray(r.source_refs) ? r.source_refs : [],
    content_json: (r.content_json && typeof r.content_json === "object") ? r.content_json : {},
  }));
  return { cards, source: "supabase-cohort" };
}

const PUBLIC_EVIDENCE_PATH = `public_transcript_evidence_cards?select=${PUBLIC_CARD_COLUMNS}&order=created_at.desc`;

export function publicEvidenceCardsUrl(baseUrl) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}/rest/v1/${PUBLIC_EVIDENCE_PATH}`;
}

function normalizeCard(row) {
  if (!row || typeof row !== "object") return null;
  const id = row.id == null ? "" : String(row.id);
  if (!id) return null;
  const conf = typeof row.confidence === "number" ? row.confidence : Number(row.confidence);
  return {
    id,
    claim_type: String(row.claim_type || "insight"),
    title: String(row.title || ""),
    claim_text: String(row.claim_text || ""),
    summary: row.summary == null ? null : String(row.summary),
    evidence_level: String(row.evidence_level || "inferred"),
    confidence: Number.isFinite(conf) ? conf : null,
    attribution_scope: String(row.attribution_scope || ""),
    content_json: (row.content_json && typeof row.content_json === "object") ? row.content_json : {},
    created_at: row.created_at || null,
    surface_tier: "T3",
    source: "supabase-live",
  };
}

// Fetch the public T3 evidence cards. Always resolves (never throws) so a
// Supabase outage degrades to "no live cards", leaving whatever the committed
// bundle carries. Returns { cards, source }: source is "supabase" on success,
// "unconfigured" when no anon key is set, or "error" with an `error` string.
export async function fetchPublicEvidenceCards(opts = {}) {
  const { rows, source, error } = await fetchAnon(PUBLIC_EVIDENCE_PATH, opts);
  if (source === "unconfigured") return { cards: [], source: "unconfigured" };
  if (source === "error") return { cards: [], source: "error", error };
  const cards = rows.map(normalizeCard).filter(Boolean);
  return { cards, source: "supabase" };
}
