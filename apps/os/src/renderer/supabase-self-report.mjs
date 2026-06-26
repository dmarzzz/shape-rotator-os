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

import { postAnonRow, getAnonRows } from "./supabase-anon-write.mjs";
import { sanitizeDelta } from "./self-report-synth.mjs";

const WRITE_TABLE = "os_profile_updates";
const READ_VIEW = "app_profile_updates";
// Bound the approved-read so it can't grow unboundedly as approved rows
// accumulate. Approved profile updates are operator-gated + low-volume, so the
// newest few hundred always cover the current-per-record value; we still dedup
// to newest-per-record below, so the cap only trims ancient superseded rows.
const APPROVED_READ_LIMIT = 500;

// Append one member-approved delta. Always resolves (never throws):
// { ok:true } | { ok:false, error }.
export async function saveSelfReportUpdate(
  recordId,
  delta,
  { question = "", answer = "", sourceKinds = [], appVersion = null, platform = null, allowedSkillAreas } = {},
  opts = {},
) {
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
  return postAnonRow(WRITE_TABLE, body, opts);
}

// Read APPROVED deltas (newest per record_id). Returns { updates, source }.
// source: "supabase" on a clean read, "none" otherwise (so an outage keeps the
// committed baseline rather than blanking overlays).
export async function fetchApprovedProfileUpdates(opts = {}) {
  // Route through the shared anon-read primitive, bounded by APPROVED_READ_LIMIT
  // so the approved-overlay read can't grow unboundedly as approved rows pile up.
  const { rows, source } = await getAnonRows(
    `${READ_VIEW}?select=record_id,delta,created_at&order=created_at.desc&limit=${APPROVED_READ_LIMIT}`,
    opts,
  );
  if (source !== "supabase") return { updates: {}, source: "none" };
  const updates = {};
  const newestAt = {};
  for (const row of rows) {
    const id = row && row.record_id ? String(row.record_id) : "";
    if (!id || !row.delta || typeof row.delta !== "object") continue;
    // Keep newest-per-record by created_at — order-independent, so the result is
    // correct whether the response came back asc, desc, or capped by the limit.
    const at = Date.parse(row.created_at || "") || 0;
    if (!(id in updates) || at >= newestAt[id]) { updates[id] = row.delta; newestAt[id] = at; }
  }
  return { updates, source };
}
