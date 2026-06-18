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

import {
  DEFAULT_SUPABASE_URL,
  DEFAULT_CALENDAR_CONFIG_KEY,
  // Vendored operator client. Keep these shared Supabase defaults packaged with
  // apps/os; the public web bundle must not import the operator workflow client.
} from "../vendor/calendar-ingress-client.mjs";

// The Supabase ANON key is safe to embed in a client — it is designed to ship
// publicly, and RLS (not key secrecy) is the security boundary. It grants only
// what the `anon` role is granted: SELECT on the public_transcript_evidence_cards
// view (published, approved, person-anonymized T3 cards). It CANNOT read raw
// transcripts, cohort-internal cards, or any other table, and cannot write.
// Baked here so the live T3 read works on every install; a per-deployment key in
// the calendar-ingress config still overrides it. (NOT a secret — service-role /
// OAuth / worker tokens stay in env + Supabase Vault, never in git.)
export const DEFAULT_PUBLIC_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR4am50endrc2lsdXZxY3BjY3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEzNzA1NzEsImV4cCI6MjA5Njk0NjU3MX0.XjXEUnw3jq1E7PwIOvhr7a3OpO2lyZv6S_Hn3JqogBA";

// The COHORT key is a JWT bearing role=cohort_app (see the engine migration
// 20260618000000_cohort_app_evidence_reader.sql). It reads the GATED T2 cohort
// evidence view (cohort_app_transcript_evidence_cards) — content NOT exposed to
// anon / the public web. Unlike the anon key, this is NOT baked into the public
// source: it is empty here and supplied per-build (injected into the distributed
// app) or via the calendar-ingress config (supabaseCohortKey). When empty — i.e.
// the public web bundle or an un-provisioned build — the cohort reader no-ops and
// the app falls back to the anon T3 read. SOFT gate: a key in a distributed binary
// is extractable, so this is "off the public web", not a hard boundary; revoke by
// dropping the cohort_app grant/role server-side.
// Resolve the build-baked cohort key. In the packaged renderer it arrives over
// the preload bridge (window.api.cohortKey, baked from SRFG_COHORT_KEY at build
// time); in Node (build scripts / tests) it comes from the env. Empty => the
// cohort reader no-ops and the app falls back to the anon T3 read (public web /
// un-provisioned build). Args are injectable so the resolution is unit-testable.
export function resolveDefaultCohortKey({ bridge, env } = {}) {
  const fromBridge = bridge !== undefined
    ? bridge
    : (typeof globalThis !== "undefined" && globalThis.api && typeof globalThis.api.cohortKey === "string"
        ? globalThis.api.cohortKey
        : "");
  if (fromBridge) return String(fromBridge).trim();
  const fromEnv = env !== undefined
    ? env
    : (typeof process !== "undefined" && process.env ? process.env.SRFG_COHORT_KEY : "");
  return String(fromEnv || "").trim();
}
export const DEFAULT_COHORT_KEY = resolveDefaultCohortKey();

// Columns the anon view exposes (must match the migration's select list).
const PUBLIC_CARD_COLUMNS = [
  "id", "claim_type", "title", "claim_text", "summary",
  "evidence_level", "confidence", "attribution_scope", "content_json", "created_at",
].join(",");

// Resolve the Supabase URL + anon key from the same config the calendar-ingress
// form persists (localStorage key srfg:calendar_ingress_config), falling back to
// the published project URL and the (blank-by-default) baked anon key.
export function readSupabaseConfig(storage = globalThis.localStorage) {
  let cfg = {};
  try {
    const raw = storage && storage.getItem ? storage.getItem(DEFAULT_CALENDAR_CONFIG_KEY) : null;
    if (raw) cfg = JSON.parse(raw) || {};
  } catch {
    cfg = {};
  }
  const url = String(cfg.supabaseUrl || DEFAULT_SUPABASE_URL || "").replace(/\/+$/, "");
  const anonKey = String(cfg.supabaseAnonKey || DEFAULT_PUBLIC_ANON_KEY || "").trim();
  const cohortKey = String(cfg.supabaseCohortKey || DEFAULT_COHORT_KEY || "").trim();
  return { url, anonKey, cohortKey };
}

// Columns the GATED cohort (T2) view exposes — includes surface_tier + the full
// content_json (date/week_start/teams) the cohort views key off. No org/session.
const COHORT_CARD_COLUMNS = [
  "id", "claim_type", "title", "claim_text", "summary", "evidence_level",
  "confidence", "attribution_scope", "surface_tier", "content_json", "created_at", "reviewed_at",
].join(",");

export function cohortEvidenceCardsUrl(baseUrl) {
  const url = new URL(`${baseUrl}/rest/v1/cohort_app_transcript_evidence_cards`);
  url.searchParams.set("select", COHORT_CARD_COLUMNS);
  url.searchParams.set("order", "created_at.desc");
  return url.toString();
}

// Fetch the GATED T2 cohort evidence using the cohort key. No-ops (returns
// source:"unconfigured") when no cohort key is set — the public web bundle and
// un-provisioned builds, which then fall back to the anon T3 read. Always resolves.
export async function fetchCohortEvidenceCards({ storage, fetchImpl, config } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const { url, cohortKey } = config || readSupabaseConfig(storage);
  if (!url || !cohortKey || typeof doFetch !== "function") {
    return { cards: [], source: "unconfigured" };
  }
  let res;
  try {
    res = await doFetch(cohortEvidenceCardsUrl(url), {
      headers: { apikey: cohortKey, authorization: `Bearer ${cohortKey}`, accept: "application/json" },
      cache: "no-store",
    });
  } catch (error) {
    return { cards: [], source: "error", error: String(error && error.message ? error.message : error) };
  }
  if (!res || !res.ok) return { cards: [], source: "error", error: `HTTP ${res ? res.status : "no response"}` };
  let rows;
  try { rows = await res.json(); } catch { return { cards: [], source: "error", error: "invalid JSON from Supabase" }; }
  const cards = Array.isArray(rows) ? rows.map(normalizeCard).filter(Boolean).map((c) => ({ ...c, surface_tier: "T2", source: "supabase-cohort" })) : [];
  return { cards, source: "supabase-cohort" };
}

export function publicEvidenceCardsUrl(baseUrl) {
  const url = new URL(`${baseUrl}/rest/v1/public_transcript_evidence_cards`);
  url.searchParams.set("select", PUBLIC_CARD_COLUMNS);
  url.searchParams.set("order", "created_at.desc");
  return url.toString();
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
export async function fetchPublicEvidenceCards({ storage, fetchImpl, config } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const { url, anonKey } = config || readSupabaseConfig(storage);
  if (!url || !anonKey || typeof doFetch !== "function") {
    return { cards: [], source: "unconfigured" };
  }
  let res;
  try {
    res = await doFetch(publicEvidenceCardsUrl(url), {
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${anonKey}`,
        accept: "application/json",
      },
      cache: "no-store",
    });
  } catch (error) {
    return { cards: [], source: "error", error: String(error && error.message ? error.message : error) };
  }
  if (!res || !res.ok) {
    return { cards: [], source: "error", error: `HTTP ${res ? res.status : "no response"}` };
  }
  let rows;
  try {
    rows = await res.json();
  } catch {
    return { cards: [], source: "error", error: "invalid JSON from Supabase" };
  }
  const cards = Array.isArray(rows) ? rows.map(normalizeCard).filter(Boolean) : [];
  return { cards, source: "supabase" };
}
