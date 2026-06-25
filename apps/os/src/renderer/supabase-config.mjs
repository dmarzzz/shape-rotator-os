// supabase-config.mjs — the shared Supabase connection config + key resolution.
//
// Extracted from supabase-evidence.mjs so the anon read/write primitives
// (supabase-anon-write.mjs) can resolve the URL + keys from a tiny LEAF module
// instead of importing the whole evidence-cards module — which would otherwise
// form an import cycle (anon-write needs readSupabaseConfig; the evidence readers
// in supabase-evidence need fetchAnon from anon-write). supabase-evidence
// re-exports everything here so existing importers keep working unchanged.

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

// Resolve the Supabase URL + anon key + cohort key from the same config the
// calendar-ingress form persists (localStorage key srfg:calendar_ingress_config),
// falling back to the published project URL and the baked anon key.
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

// Persist a cohort key into the SAME config blob readSupabaseConfig() consults
// (srfg:calendar_ingress_config → supabaseCohortKey), so a dev / provisioned run
// can light up the GATED cohort reads (distilled transcripts + named T2 evidence)
// on this machine without an env var or a packaged build-time bake. Merges into the
// existing config so any calendar / url / anon settings survive; pass an empty
// string to clear the override (the reader then falls back to the baked key, if any,
// else anon). Soft channel: the key lands in this machine's localStorage only —
// never committed, never sent anywhere but Supabase. Returns true on success.
export function persistCohortKeyOverride(rawKey, storage = globalThis.localStorage) {
  if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
    return false;
  }
  const key = String(rawKey || "").trim();
  try {
    let cfg = {};
    const raw = storage.getItem(DEFAULT_CALENDAR_CONFIG_KEY);
    if (raw) {
      try { cfg = JSON.parse(raw) || {}; } catch { cfg = {}; }
    }
    // Immutable merge — never mutate the parsed config in place.
    const next = { ...cfg };
    if (key) next.supabaseCohortKey = key;
    else delete next.supabaseCohortKey;
    storage.setItem(DEFAULT_CALENDAR_CONFIG_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}
