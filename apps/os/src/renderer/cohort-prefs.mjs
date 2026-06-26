// cohort-prefs.mjs — the agent-override seam (design now, fill later).
//
// docs/two-way-contribution-layer.md "The agent-override seam": every default is
// overridable, and the override surface is the member's own AI agent. The trick is
// that a customization is itself just MORE events on the same spine — each knob
// change is a `prefs` cohort_event — so "the agent changes it later" needs no new
// system, and every customization is timelined + revertible. The read functions
// resolve `prefs ?? default`.
//
// At v0 the knobs are local-authoritative (the "for you" re-rank must stay on
// device — no viewer signal leaves the box) and we ECHO each change as a `prefs`
// event for the durable/portable timeline. Nothing fills the knobs from a chat
// agent yet; this module exposes them and the resolver so that wiring is additive.

import { appendCohortEvent } from "./supabase-cohort-events.mjs";

const PREFS_LS_KEY = "srwk:cohort_prefs_v1";

// The knobs the base layer must expose (even though nothing fills them yet).
export const DEFAULT_PREFS = Object.freeze({
  muted_authors: [],       // record_ids whose events are hidden from my feed
  muted_event_types: [],   // event_types I never want to see
  interest_tags: [],       // tags/skill-areas that boost an event in my re-rank
  emit_policy: "all",      // what I broadcast: "all" | "loud_only" | "none"
  feed_mode: "for_you",    // "global" (raw recency) | "for_you" (on-device re-rank)
});

const EMIT_POLICIES = new Set(["all", "loud_only", "none"]);
const FEED_MODES = new Set(["global", "for_you"]);

function store(storage) {
  if (storage) return storage;
  try { return globalThis.localStorage || null; } catch { return null; }
}

function asStringArray(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string" && v) : [];
}

// The single prefs schema/coercion — one source of truth for getPrefs (after
// parse) and setPrefs (after merge), so a new knob is added in one place.
function normalizePrefs(obj) {
  const p = obj && typeof obj === "object" ? obj : {};
  return {
    muted_authors: asStringArray(p.muted_authors),
    muted_event_types: asStringArray(p.muted_event_types),
    interest_tags: asStringArray(p.interest_tags),
    emit_policy: EMIT_POLICIES.has(p.emit_policy) ? p.emit_policy : DEFAULT_PREFS.emit_policy,
    feed_mode: FEED_MODES.has(p.feed_mode) ? p.feed_mode : DEFAULT_PREFS.feed_mode,
  };
}

// Read the merged prefs (stored over defaults). Always returns a complete,
// well-typed object — a corrupt/missing store falls back to DEFAULT_PREFS.
export function getPrefs(storage) {
  const ls = store(storage);
  let raw = null;
  try { raw = ls && ls.getItem(PREFS_LS_KEY); } catch { raw = null; }
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
  return normalizePrefs(parsed);
}

// Persist a partial update (merged over current) and echo a `prefs` event so the
// change is timelined + portable. The echo is fire-and-forget; the local store is
// authoritative for on-device ranking. Returns the new merged prefs.
//
// NOTE (v0): the only in-app caller — the for-you/everyone toggle — passes
// { emit: false } and no actor, so the `prefs`-event echo is a DORMANT write path.
// It goes live when the member's agent (the deferred chat seam) sets a pref with
// the member's actor id; until then no `prefs` event is ever written.
export function setPrefs(patch, { storage, actor = null, claimTokenHash = null, emit = true } = {}) {
  const ls = store(storage);
  const clean = normalizePrefs({ ...getPrefs(storage), ...(patch && typeof patch === "object" ? patch : {}) });
  try { ls && ls.setItem(PREFS_LS_KEY, JSON.stringify(clean)); } catch { /* private mode */ }
  if (emit && actor) {
    appendCohortEvent({
      recordId: actor, actor, eventType: "prefs", value: clean, weight: "quiet", claimTokenHash,
    }).catch(() => {});
  }
  return clean;
}

// Drop events the viewer has muted (by author or by type). Pure — apply BEFORE
// ranking so muted authors never reach the re-rank.
export function filterByPrefs(events, prefs = DEFAULT_PREFS) {
  const mutedAuthors = new Set(prefs.muted_authors || []);
  const mutedTypes = new Set(prefs.muted_event_types || []);
  return (Array.isArray(events) ? events : []).filter((ev) => {
    if (!ev) return false;
    if (ev.actor && mutedAuthors.has(ev.actor)) return false;
    if (mutedAuthors.has(ev.record_id)) return false;
    if (mutedTypes.has(ev.event_type)) return false;
    return true;
  });
}

// Should the member broadcast THIS event, given their emit_policy? The override
// seam doing real work at v0: a member (or their agent) can choose to stop
// broadcasting quiet edits, or go silent entirely, without losing the local change.
export function shouldEmit(weight, prefs = DEFAULT_PREFS) {
  const policy = prefs.emit_policy || "all";
  if (policy === "none") return false;
  if (policy === "loud_only") return weight === "loud";
  return true;
}
