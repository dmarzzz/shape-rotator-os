// supabase-cohort-events.mjs — the read/write door into the cohort_events spine
// (the "two-way contribution layer"). Sibling of supabase-self-report / contest /
// feedback; shares their write-only POST + recent-view read via supabase-anon-write.
//
// WRITE: appendCohortEvent appends ONE event ("a member added something") — a
// profile_edit, transcript, contest, self_report, connection, or prefs. The row is
// anon write-only; the renderer re-renders the feed optimistically and the durable
// record is read back from app_cohort_feed on the next refresh tick.
//
// READ: fetchCohortFeed reads the recent app_cohort_feed slice (claim hash stripped,
// superseded events collapsed) for the activity feed. The "for you" re-rank
// (feed-rank.mjs) runs on-device after this read — no viewer signal leaves the box.

import { clampField, postAnonRow, getAnonRows } from "./supabase-anon-write.mjs";

const EVENTS_TABLE = "cohort_events";
const FEED_VIEW = "app_cohort_feed";

// The v0 event vocabulary — kept in sync with the cohort_events CHECK constraint.
export const COHORT_EVENT_TYPES = Object.freeze([
  "profile_edit", // a member changed one of their own surface fields
  "transcript",   // a provenance-stamped transcript upload
  "contest",      // a push-back on a public claim (also lands in public_card_contests)
  "self_report",  // an AI self-report refresh applied (a batch)
  "connection",   // a named collaboration (e.g. a transcript's with_whom)
  "prefs",        // the agent-override seam: feed/broadcast preferences
]);

export const COHORT_EVENT_WEIGHTS = Object.freeze(["loud", "medium", "quiet"]);

// The noise line (docs/two-way-contribution-layer.md "Default event weights").
// loud → its own feed line; medium → a feed line; quiet → rolled up ("tidied
// profile"), and prefs is config so it never shows in the feed at all.
const LOUD_PROFILE_FIELDS = new Set(["now", "weekly_intention", "prior_work"]); // shipped / focus / intention
const MEDIUM_PROFILE_FIELDS = new Set(["skills", "skill_areas", "seeking", "offering"]);

export function defaultWeightFor(eventType, field = null) {
  switch (eventType) {
    case "transcript":
    case "contest":
    case "self_report":
      return "loud";
    case "connection":
      return "medium";
    case "prefs":
      return "quiet";
    case "profile_edit":
      if (field && LOUD_PROFILE_FIELDS.has(field)) return "loud";
      if (field && MEDIUM_PROFILE_FIELDS.has(field)) return "medium";
      return "quiet"; // cosmetic / typo tweak
    default:
      return "medium";
  }
}

// A plain-object guard: the value column is `jsonb` constrained to an object.
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

// Append one event. Always resolves (never throws): { ok:true } | { ok:false, error }.
// `value` is bounded client-side (defense in depth alongside the DB size CHECK).
export async function appendCohortEvent(
  {
    recordId,
    actor = null,
    eventType,
    field = null,
    value = {},
    weight = null,
    claimTokenHash = null,
    appVersion = null,
    platform = null,
  } = {},
  opts = {},
) {
  const id = clampField(recordId, 128);
  if (!id) return { ok: false, error: "no_record_id" };
  if (!COHORT_EVENT_TYPES.includes(eventType)) return { ok: false, error: "bad_event_type" };
  const cleanField = clampField(field, 128);
  const resolvedWeight = COHORT_EVENT_WEIGHTS.includes(weight)
    ? weight
    : defaultWeightFor(eventType, cleanField);
  // Bound the payload by its UTF-8 BYTE size (the DB cap is pg_column_size <= 8000
  // bytes, not chars): if it would overflow, drop to {} rather than let the row be
  // rejected server-side. The 7000-byte threshold leaves headroom for jsonb overhead.
  let payload = asObject(value);
  try {
    if (new TextEncoder().encode(JSON.stringify(payload)).length > 7000) payload = {};
  } catch {
    payload = {};
  }
  // NOTE: `supersedes` is intentionally NOT sent — it isn't in the anon column grant
  // (revert is operator/service_role-only; see the migration). Including it would
  // make every anon write fail with "permission denied for column supersedes".
  const body = {
    record_id: id,
    actor: clampField(actor, 128),
    event_type: eventType,
    field: cleanField,
    value: payload,
    weight: resolvedWeight,
    claim_token_hash: clampField(claimTokenHash, 128),
    app_version: clampField(appVersion, 64),
    platform: clampField(platform, 64),
  };
  return postAnonRow(EVENTS_TABLE, body, opts);
}

// Normalize one feed row to a stable shape the renderer + re-rank can rely on.
function normalizeEvent(row) {
  if (!row || typeof row !== "object") return null;
  const recordId = row.record_id ? String(row.record_id) : "";
  if (!recordId) return null;
  const eventType = COHORT_EVENT_TYPES.includes(row.event_type) ? row.event_type : null;
  if (!eventType) return null;
  return {
    id: row.id ? String(row.id) : "",
    record_id: recordId,
    actor: row.actor ? String(row.actor) : null,
    event_type: eventType,
    field: row.field ? String(row.field) : null,
    value: asObject(row.value),
    weight: COHORT_EVENT_WEIGHTS.includes(row.weight) ? row.weight : "medium",
    supersedes: row.supersedes ? String(row.supersedes) : null,
    created_at: row.created_at ? String(row.created_at) : null,
  };
}

// Read the recent feed slice (newest-first). Returns { events, source }: source is
// "supabase" on a clean read, "none" otherwise (so an outage keeps the committed
// baseline rather than blanking the feed). `prefs` events are excluded from the
// feed here — they are config, not contributions.
export async function fetchCohortFeed(opts = {}) {
  const select = "id,record_id,actor,event_type,field,value,weight,supersedes,created_at";
  const { rows, source } = await getAnonRows(
    `${FEED_VIEW}?select=${select}&order=created_at.desc&limit=500`,
    opts,
  );
  if (source !== "supabase") return { events: [], source };
  const events = [];
  for (const row of rows) {
    const ev = normalizeEvent(row);
    if (ev && ev.event_type !== "prefs") events.push(ev);
  }
  return { events, source };
}
