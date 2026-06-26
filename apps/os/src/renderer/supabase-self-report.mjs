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
import { sanitizeProfileFields, sanitizeTeamFields } from "./cohort-chat-actions.mjs";

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
  { question = "", answer = "", sourceKinds = [], appVersion = null, platform = null, allowedSkillAreas, proposerClaimHash = null } = {},
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
    // A self-report is BY DEFINITION the member editing their own record, so the
    // proposer is the subject ⇒ is_self=true ⇒ the auto-approve trigger applies it
    // immediately (no operator gate). The claim hash rides along for audit.
    proposer_record_id: id,
    proposer_claim_hash: proposerClaimHash ? String(proposerClaimHash).slice(0, 128) : null,
  };
  return postAnonRow(WRITE_TABLE, body, opts);
}

// Append one AGENT proposal to the inbox — the write door behind the cohort chat's
// propose_profile_update action. Same pending/operator-approved model as
// saveSelfReportUpdate, with two differences: (1) the delta may carry the extended
// agent whitelist (the 7 self fields + geo + links{github,repo}) — sanitized here
// with sanitizeProfileFields and re-asserted by the DB CHECK; and (2) it carries
// PROVENANCE — proposer_record_id + proposer_claim_hash — so a proposal about
// ANOTHER member (is_self computed false server-side) is checkable before approval.
// Until the provenance migration is applied these columns/fields fail server-side
// and postAnonRow returns { ok:false } (never throws) — safe degradation.
export async function saveProfileProposal(
  subjectRecordId,
  delta,
  { proposerRecordId = null, proposerClaimHash = null, rationale = "", sourceKinds = [], appVersion = null, platform = null, allowedSkillAreas, subjectType = "person" } = {},
  opts = {},
) {
  const id = String(subjectRecordId == null ? "" : subjectRecordId).trim();
  if (!id || id.length > 128) return { ok: false, error: "bad_record_id" };
  // Re-whitelist by subject type (defense in depth): a TEAM proposal carries the
  // award-evidence fields (journey/traction/shipping), a PERSON the personal ones.
  // A team proposal is never is_self, so it lands pending the operator/daily review.
  const isTeam = subjectType === "team";
  const clean = isTeam ? sanitizeTeamFields(delta) : sanitizeProfileFields(delta, { allowedSkillAreas });
  if (!clean || !Object.keys(clean).length) return { ok: false, error: "empty_delta" };

  const body = {
    record_id: id,
    // record_type is sent ONLY for a team proposal. The os_profile_updates anon INSERT
    // grant is column-scoped and does NOT include record_type yet, so a person proposal
    // must keep the exact granted column set it always had (else PostgREST 400s the whole
    // row). The Engine migration that adds + grants record_type also widens the team
    // whitelist — until it lands, team rows fail server-side by design (staged), but
    // person proposals keep working exactly as before.
    ...(isTeam ? { record_type: "team" } : {}),
    delta: clean,
    question: null,
    answer: rationale ? String(rationale).slice(0, 2000) : null,
    source_kinds: Array.isArray(sourceKinds) ? sourceKinds.slice(0, 8).map(String) : [],
    app_version: appVersion ? String(appVersion).slice(0, 64) : null,
    platform: platform ? String(platform).slice(0, 64) : null,
    proposer_record_id: proposerRecordId ? String(proposerRecordId).slice(0, 128) : null,
    proposer_claim_hash: proposerClaimHash ? String(proposerClaimHash).slice(0, 128) : null,
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
