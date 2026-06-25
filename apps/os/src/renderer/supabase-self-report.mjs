// supabase-self-report.mjs — the RECEIVE side of "Your Mirror".
//
// WRITE: saveSelfReportUpdate appends ONE member-approved profile delta to the
// os_profile_updates inbox (anon column-scoped INSERT, write-only — sibling of
// supabase-contest.mjs). The delta is re-whitelisted here (sanitizeDelta) so only
// self-declared fields ever leave the machine; the DB CHECK re-asserts the same set.
// The row lands as `status='pending'` for an operator/Engine to approve + promote.
//
// READ: fetchApprovedProfileUpdates reads the app_profile_updates view (APPROVED
// rows only) so the app can overlay accepted deltas onto the rendered profile with
// no PR (see cohort-source.js applyProfileUpdateOverlay) — the os_spheres pattern,
// but gated to approved rows because profile text isn't anon-mutable.

import { readSupabaseConfig } from "./supabase-evidence.mjs";
import { sanitizeDelta } from "./self-report-synth.mjs";

const WRITE_TABLE = "os_profile_updates";
const READ_VIEW = "app_profile_updates";

// Append one member-approved delta. Always resolves (never throws):
// { ok:true } | { ok:false, error }.
export async function saveSelfReportUpdate(
  recordId,
  delta,
  { question = "", answer = "", sourceKinds = [], appVersion = null, platform = null, allowedSkillAreas } = {},
  { storage, fetchImpl, config } = {},
) {
  const doFetch = fetchImpl || globalThis.fetch;
  const id = String(recordId == null ? "" : recordId).trim();
  if (!id || id.length > 128) return { ok: false, error: "bad_record_id" };
  // Re-whitelist client-side (defense in depth alongside the DB CHECK).
  const clean = sanitizeDelta(delta, { allowedSkillAreas });
  if (!clean || !Object.keys(clean).length) return { ok: false, error: "empty_delta" };

  const body = {
    record_id: id,
    delta: clean,
    question: question ? String(question).slice(0, 400) : null,
    answer: answer ? String(answer).slice(0, 2000) : null,
    source_kinds: Array.isArray(sourceKinds) ? sourceKinds.slice(0, 8).map(String) : [],
    app_version: appVersion ? String(appVersion).slice(0, 64) : null,
    platform: platform ? String(platform).slice(0, 64) : null,
  };
  const { url, anonKey } = config || readSupabaseConfig(storage);
  if (!url || !anonKey || typeof doFetch !== "function") return { ok: false, error: "unconfigured" };
  try {
    const res = await doFetch(`${url}/rest/v1/${WRITE_TABLE}`, {
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
    return res && res.ok ? { ok: true } : { ok: false, error: `HTTP ${res ? res.status : "no response"}` };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// Read APPROVED deltas (newest per record_id). Returns { updates, source }.
// source: "supabase" on a clean read, "none" otherwise (so an outage keeps the
// committed baseline rather than blanking overlays).
export async function fetchApprovedProfileUpdates({ storage, fetchImpl, config } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const { url, anonKey } = config || readSupabaseConfig(storage);
  if (!url || !anonKey || typeof doFetch !== "function") return { updates: {}, source: "none" };
  let res;
  try {
    res = await doFetch(
      `${url}/rest/v1/${READ_VIEW}?select=record_id,delta,created_at&order=created_at.asc`,
      { headers: { apikey: anonKey, authorization: `Bearer ${anonKey}` }, cache: "no-store" },
    );
  } catch {
    return { updates: {}, source: "none" };
  }
  if (!res || !res.ok) return { updates: {}, source: "none" };
  let rows;
  try { rows = await res.json(); } catch { return { updates: {}, source: "none" }; }
  const updates = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = row && row.record_id ? String(row.record_id) : "";
    if (!id || !row.delta || typeof row.delta !== "object") continue;
    updates[id] = row.delta; // asc order ⇒ newest wins
  }
  return { updates, source: "supabase" };
}
