// supabase-anon-write.mjs — the shared anon write/read primitives behind every
// client-side Supabase box (os_feedback, public_card_contests, os_profile_updates,
// and the new cohort_events spine).
//
// Each of those tables is anon WRITE-ONLY: a column-scoped INSERT grant + an
// INSERT-only RLS policy lets the shipped public anon key append ONE row and
// nothing else (it cannot read the table back, update/delete, or touch any other
// table). The security boundary is RLS, not key secrecy. Read-back, where it
// exists, goes through a separate `security_barrier` view (approved-/recent-only)
// that the anon key may SELECT.
//
// Before this module each box re-implemented the same POST boilerplate + clampField.
// Consolidating them keeps the four siblings byte-identical in their wire shape
// (headers, `Prefer: return=minimal`, never-throw contract) and means a new door
// into Supabase is a one-liner, not another copy.

import { readSupabaseConfig } from "./supabase-config.mjs";

// Trim + bound a small field; null (not "") when empty so the column stays NULL
// rather than storing an empty string. The single definition every box shares.
export function clampField(value, max = 64) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

// POST one row to an anon write-only table. Always resolves (never throws):
// { ok: true } on success, or { ok: false, error } so the UI can keep an
// optimistic chip and let the member retry. `Prefer: return=minimal` keeps the
// response body empty so PostgREST does NOT need a SELECT policy to satisfy the
// request (anon is write-only on these tables).
export async function postAnonRow(table, body, { storage, fetchImpl, config } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const { url, anonKey } = config || readSupabaseConfig(storage);
  if (!url || !anonKey || typeof doFetch !== "function" || !table) {
    return { ok: false, error: "unconfigured" };
  }
  let res;
  try {
    res = await doFetch(`${url}/rest/v1/${table}`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${anonKey}`,
        "content-type": "application/json",
        prefer: "return=minimal",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
  if (!res || !res.ok) {
    return { ok: false, error: `HTTP ${res ? res.status : "no response"}` };
  }
  return { ok: true };
}

// GET rows from an anon-readable view (a recent-/approved-only `security_barrier`
// view, never a raw write-only table). `pathWithQuery` is the view + PostgREST
// query, e.g. "app_cohort_feed?select=*&order=created_at.desc&limit=500".
//
// fetchAnon is the granular primitive every anon reader shares. Returns
// { rows, source, error } where source is:
//   "supabase"     — clean read (rows may be empty)
//   "unconfigured" — no url/anonKey/fetch/path (a no-op, never reached the network)
//   "error"        — network throw, non-ok HTTP, or invalid JSON (error string set)
// so a reader keeps its committed/cached baseline on any non-"supabase" result and
// can phrase the failure. Never throws. `bearer` overrides the Authorization token
// (the gated cohort_app readers pass the cohort JWT; default is the anon key);
// `accept` overrides the Accept header (default application/json; pass null to omit).
export async function fetchAnon(pathWithQuery, { storage, fetchImpl, config, bearer, accept } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const { url, anonKey } = config || readSupabaseConfig(storage);
  if (!url || !anonKey || typeof doFetch !== "function" || !pathWithQuery) {
    return { rows: [], source: "unconfigured", error: null };
  }
  const headers = {
    apikey: anonKey,
    authorization: `Bearer ${bearer || anonKey}`,
    ...(accept !== null ? { accept: accept || "application/json" } : {}),
  };
  let res;
  try {
    res = await doFetch(`${url}/rest/v1/${pathWithQuery}`, { headers, cache: "no-store" });
  } catch (err) {
    return { rows: [], source: "error", error: String(err && err.message ? err.message : err) };
  }
  if (!res || !res.ok) {
    return { rows: [], source: "error", error: `HTTP ${res ? res.status : "no response"}` };
  }
  let rows;
  try { rows = await res.json(); } catch { return { rows: [], source: "error", error: "invalid JSON from Supabase" }; }
  return { rows: Array.isArray(rows) ? rows : [], source: "supabase", error: null };
}

// Thin back-compat wrapper: the original 2-value contract { rows, source } with
// source "supabase"|"none" (collapsing unconfigured/error → none, dropping the
// error string). Used by fetchCohortFeed + fetchApprovedProfileUpdates.
export async function getAnonRows(pathWithQuery, opts = {}) {
  const r = await fetchAnon(pathWithQuery, opts);
  return { rows: r.rows, source: r.source === "supabase" ? "supabase" : "none" };
}
