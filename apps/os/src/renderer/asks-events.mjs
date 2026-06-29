// asks-events.mjs — asks ON the append-only cohort_events spine. DOM-free + pure +
// node-testable (no network, no clock): the renderer emits ask actions as events
// (cohort-emit.mjs emitAsk*) and reads them back through app_cohort_feed; THIS module
// owns the two pure halves of that round-trip:
//
//   buildAskEventValue(action, ask) — the bounded jsonb payload for one ask action
//     (post / edit / claim / join / done / cancel). Sibling of cohort-emit's other
//     value builders; kept here so the shape is tested headless.
//
//   reduceAsks(askEvents, baseAsks) — fold the appended action rows into the current
//     ask list. The spine never UPDATEs a row (anon is INSERT-only); a claim/join/done
//     is a NEW row folded over the original `post` (by record_id), oldest-first. The
//     committed markdown asks (cohort-data/asks/*.md) are the baseline so legacy asks
//     survive and can still be claimed/joined via events.
//
// An ask event: { record_id: askId, actor: who-did-it, event_type:'ask',
//                 value:{ action, ... }, created_at }.

// The ask fields an event may carry (post seeds them; edit overlays a subset). Kept
// narrow so a stray key can't bloat the row or land arbitrary data on an ask.
export const ASK_EVENT_FIELDS = Object.freeze([
  "intent", "verb", "topic", "skill_areas",
  "starts_at", "expires_at", "location", "contact", "capacity",
  "author", "posted_at", "body",
]);

export const ASK_ACTIONS = Object.freeze(["post", "edit", "claim", "join", "done", "cancel"]);

const BODY_MAX = 2000;     // keep the whole value comfortably under the 7000-byte cap
const STR_MAX = 280;
const TAGS_MAX = 12;

function str(value, max = STR_MAX) {
  if (value == null) return "";
  const s = String(value).trim();
  return s.length > max ? s.slice(0, max) : s;
}

function tagList(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  const out = [];
  for (const v of raw) {
    const s = str(v, 64).toLowerCase();
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= TAGS_MAX) break;
  }
  return out;
}

// Build the bounded value payload for one ask action. Only whitelisted, trimmed
// fields are kept; `post`/`edit` carry ask fields, the lifecycle actions carry just
// what they change. `action` is always present so the reducer can dispatch.
export function buildAskEventValue(action, ask = {}) {
  const act = ASK_ACTIONS.includes(action) ? action : "post";
  const value = { action: act };
  if (act === "claim") {
    const by = str(ask.claimed_by || ask.actor || ask.author, 128);
    if (by) value.claimed_by = by;
    return value;
  }
  if (act === "join") {
    const who = str(ask.joined_by_one || ask.actor || ask.author, 128);
    if (who) value.joined_by = [who];
    return value;
  }
  if (act === "done" || act === "cancel") {
    return value;
  }
  // post / edit — copy the whitelisted ask fields that are present.
  for (const key of ASK_EVENT_FIELDS) {
    if (ask[key] == null) continue;
    if (key === "skill_areas") {
      const tags = tagList(ask.skill_areas);
      if (tags.length) value.skill_areas = tags;
    } else if (key === "body") {
      const body = str(ask.body, BODY_MAX);
      if (body) value.body = body;
    } else {
      const s = str(ask[key], key === "topic" ? 600 : 280);
      if (s) value[key] = s;
    }
  }
  return value;
}

// ── reduction ────────────────────────────────────────────────────────────────
function cmpEvents(a, b) {
  const at = String(a?.created_at || "");
  const bt = String(b?.created_at || "");
  if (at !== bt) return at < bt ? -1 : 1;          // oldest-first
  return String(a?.id || "").localeCompare(String(b?.id || ""));
}

function uniqPush(list, value) {
  const v = String(value || "").trim();
  if (v && !list.includes(v)) list.push(v);
}

function applyPostFields(state, value) {
  for (const key of ASK_EVENT_FIELDS) {
    if (value[key] == null) continue;
    if (key === "skill_areas") state.skill_areas = tagList(value.skill_areas);
    else state[key] = value[key];
  }
}

// Fold one ask's events (any order) over an optional baseline into a current ask.
// Returns null if there's nothing to build (a mutation with no `post` and no base —
// e.g. the original post aged out of the 60-day feed window).
export function reduceAskGroup(events, base = null) {
  const ordered = (Array.isArray(events) ? events.filter(Boolean) : []).slice().sort(cmpEvents);
  let state = base ? { ...base, joined_by: Array.isArray(base.joined_by) ? base.joined_by.slice() : [] } : null;
  let lastEventAt = base?.posted_at ? String(base.posted_at) : "";

  for (const ev of ordered) {
    const value = ev && ev.value && typeof ev.value === "object" ? ev.value : {};
    const action = ASK_ACTIONS.includes(value.action) ? value.action : "post";
    if (!state) {
      if (action !== "post") continue;             // orphan mutation — cannot rebuild
      state = { record_type: "ask", status: "open", joined_by: [] };
    }
    if (ev.record_id) state.record_id = String(ev.record_id);
    if (action === "post") {
      applyPostFields(state, value);
      if (!state.status) state.status = "open";
      if (!state.posted_at) state.posted_at = String(value.posted_at || ev.created_at || "");
      if (!state.author && ev.actor) state.author = String(ev.actor);
      const intent = String(state.intent || value.intent || "").toLowerCase();
      if (intent === "come_join" && state.author) uniqPush(state.joined_by, state.author);
    } else if (action === "edit") {
      applyPostFields(state, value);
    } else if (action === "claim") {
      state.status = "claimed";
      state.claimed_by = String(value.claimed_by || ev.actor || "");
    } else if (action === "join") {
      const who = Array.isArray(value.joined_by) ? value.joined_by : [];
      for (const w of who) uniqPush(state.joined_by, w);
      if (ev.actor) uniqPush(state.joined_by, ev.actor);
    } else if (action === "done") {
      state.status = "done";
      if (!state.claimed_by && ev.actor) state.claimed_by = String(ev.actor);
    } else if (action === "cancel") {
      state.status = "cancelled";
    }
    const at = String(ev.created_at || "");
    if (at > lastEventAt) lastEventAt = at;
  }

  if (!state) return null;
  if (!state.record_type) state.record_type = "ask";
  if (!state.status) state.status = "open";
  if (!Array.isArray(state.joined_by)) state.joined_by = [];
  state._lastEventAt = lastEventAt || state.posted_at || "";
  return state;
}

// Reduce all ask events over the committed markdown baseline into the current ask
// list. baseAsks keep their place even with zero events; event groups create new
// asks (post) or mutate baseline/posted ones (claim/join/done/edit/cancel).
export function reduceAsks(askEvents, baseAsks = []) {
  const groups = new Map();
  for (const ev of Array.isArray(askEvents) ? askEvents : []) {
    if (!ev || ev.event_type !== "ask" || !ev.record_id) continue;
    const id = String(ev.record_id);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(ev);
  }
  const baseById = new Map();
  for (const a of Array.isArray(baseAsks) ? baseAsks : []) {
    if (a && a.record_id) baseById.set(String(a.record_id), a);
  }

  const out = [];
  const seen = new Set();
  // Asks that have events (new posts + mutated baselines), folded over any baseline.
  for (const [id, evs] of groups) {
    const reduced = reduceAskGroup(evs, baseById.get(id) || null);
    if (reduced) { out.push(reduced); seen.add(id); }
  }
  // Baseline asks with no events pass through untouched.
  for (const a of Array.isArray(baseAsks) ? baseAsks : []) {
    const id = a && a.record_id ? String(a.record_id) : "";
    if (!id || seen.has(id)) continue;
    out.push({ ...a, _lastEventAt: a.posted_at ? String(a.posted_at) : "" });
  }
  return out;
}
