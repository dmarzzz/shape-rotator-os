// cohort-emit.mjs — the renderer's emit doors into the cohort_events spine.
//
// One place that resolves the cross-cutting bits — who the actor is (the claimed
// identity), the claim-token hash, coarse app context, and the member's emit_policy
// (the agent-override seam) — so the call sites in alchemy.js / self-report.js stay
// one-liners. Every emit is fire-and-forget and never throws: a contribution that
// fails to record must never break the action the member actually took (saving a
// profile, filing a contest, applying a self-report).
//
// IMPORTANT (v0 scope): a profile_edit emits a feed/provenance SIGNAL of a change
// the member made through the normal save path — the field NAMES that changed, not
// their values. Values flow through the existing reversible/gated channels (see the
// cohort_events migration's v0 scope note). The spine is the timeline, not a
// profile-value overwrite channel.

import { appendCohortEvent, defaultWeightFor } from "./supabase-cohort-events.mjs";
import { getClaimTokenHash } from "./claim-token.mjs";
import { getPrefs, shouldEmit } from "./cohort-prefs.mjs";

const IDENTITY_LS_KEY = "srwk:identity_v1";
const META_KEYS = new Set(["record_id", "record_type", "schema_version"]);
const WEIGHT_RANK = { loud: 3, medium: 2, quiet: 1 };

// Read the claimed record_id straight from localStorage (no heavy identity.js
// import) so this glue module stays light.
function myRecordId() {
  try {
    const raw = globalThis.localStorage?.getItem(IDENTITY_LS_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && v.record_id ? String(v.record_id) : null;
  } catch {
    return null;
  }
}

async function appContext() {
  try {
    const info = await globalThis.window?.api?.getAppInfo?.();
    if (info && typeof info === "object") {
      return { appVersion: info.version || null, platform: info.platform || null };
    }
  } catch { /* nullable columns — a miss is harmless */ }
  return { appVersion: null, platform: null };
}

// The loudest-weight changed field leads the feed line (drives the row's weight).
function leadField(fields) {
  let best = null;
  let bestRank = -1;
  for (const f of fields) {
    const rank = WEIGHT_RANK[defaultWeightFor("profile_edit", f)] || 0;
    if (rank > bestRank) { bestRank = rank; best = f; }
  }
  return best;
}

// Which surface fields actually changed (names only — never the values).
function changedFields(baseline = {}, draft = {}) {
  const keys = new Set([...Object.keys(baseline || {}), ...Object.keys(draft || {})]);
  const out = [];
  for (const k of keys) {
    if (META_KEYS.has(k)) continue;
    let a;
    let b;
    try { a = JSON.stringify(baseline?.[k] ?? null); } catch { a = ""; }
    try { b = JSON.stringify(draft?.[k] ?? null); } catch { b = ""; }
    if (a !== b) out.push(k);
  }
  return out;
}

async function emit(eventType, { recordId, field = null, value = {}, weight = null } = {}) {
  try {
    const subject = recordId || myRecordId();
    if (!subject) return;
    const w = weight || defaultWeightFor(eventType, field);
    // The override seam doing real work: respect the member's emit_policy
    // (e.g. "loud_only" suppresses cosmetic broadcasts; "none" goes silent).
    if (!shouldEmit(w, getPrefs())) return;
    const { appVersion, platform } = await appContext();
    await appendCohortEvent({
      recordId: subject,
      actor: myRecordId(),
      eventType,
      field,
      value,
      weight: w,
      claimTokenHash: getClaimTokenHash(),
      appVersion,
      platform,
    });
  } catch { /* a contribution that fails to record must never break the action */ }
}

// A member saved their profile: emit one feed line naming the changed fields,
// weighted by the loudest among them (a changed focus is loud; a typo is quiet).
export function emitProfileEdit(recordId, baseline, draft) {
  const fields = changedFields(baseline, draft);
  if (!fields.length) return;
  void emit("profile_edit", { recordId, field: leadField(fields), value: { fields } });
}

// An AI self-report refresh was applied: one loud "refreshed from recent work" line.
export function emitSelfReport(recordId, fields = []) {
  const list = Array.isArray(fields) ? fields.filter(Boolean).map(String).slice(0, 12) : [];
  void emit("self_report", { recordId, value: { fields: list }, weight: "loud" });
}

// A member contested a public claim: a loud feed event (the durable rebuttal still
// lands in public_card_contests; this is the "contest is a loud feed event" line).
export function emitContest({ subjectId, contestKind, cardKind = null, cardId = null } = {}) {
  if (!subjectId || !contestKind) return;
  void emit("contest", {
    recordId: subjectId,
    value: { contest_kind: contestKind, card_kind: cardKind, card_id: cardId },
    weight: "loud",
  });
}

// A provenance-stamped transcript was contributed. with_whom quietly builds the
// connection/contribution graph.
export function emitTranscript({ recordId, title = "", withWhom = [] } = {}) {
  void emit("transcript", {
    recordId,
    value: {
      title: String(title || "").slice(0, 200),
      with_whom: (Array.isArray(withWhom) ? withWhom : []).slice(0, 20).map(String),
    },
    weight: "loud",
  });
}
