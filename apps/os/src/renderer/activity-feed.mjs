// activity-feed.mjs — the view-model behind the cohort activity feed (the visible
// surface of the two-way contribution layer). Pure + node-testable: it takes the
// cohort surface + the viewer's identity and returns a ranked view-model. The DOM
// rendering lives in alchemy.js (renderActivityMode), which owns escaping; this
// module owns the LOGIC (filter → rank → roll up) so it can be tested headless.
//
// "Ship global first": prefs.feed_mode "global" is raw recency; "for_you" is the
// on-device re-rank (feed-rank.mjs) using the viewer's own profile — no signal
// leaves the device. Quiet edits (cosmetic tweaks) are rolled up into one
// "tidied profile" count rather than given their own lines.

import { rankFeed, isOwn, scoreAsk } from "./feed-rank.mjs";
import { filterByPrefs, DEFAULT_PREFS } from "./cohort-prefs.mjs";

const LAST_SEEN_LS_KEY = "srwk:activity_last_seen_v1";

function store(storage) {
  if (storage) return storage;
  try { return globalThis.localStorage || null; } catch { return null; }
}

export function getLastSeen(storage) {
  try {
    const raw = store(storage)?.getItem(LAST_SEEN_LS_KEY);
    const n = raw ? Number(raw) : 0;
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}

export function markSeen(when, storage) {
  try { store(storage)?.setItem(LAST_SEEN_LS_KEY, String(Number.isFinite(when) ? when : Date.now())); } catch { /* ignore */ }
}

// Build { recordId: {team, skillAreas, name} } from the surface's people so the
// re-rank can resolve an author's team / skill-areas locally (never over the wire).
export function buildAuthorMeta(surface = {}) {
  const meta = {};
  for (const p of Array.isArray(surface.people) ? surface.people : []) {
    if (!p || !p.record_id) continue;
    meta[p.record_id] = {
      team: p.team || p.team_id || null,
      skillAreas: Array.isArray(p.skill_areas) ? p.skill_areas : [],
      name: p.name || p.display_name || p.record_id,
    };
  }
  return meta;
}

// Build the viewer signal bundle from the claimed identity + surface. connectionIds
// are derived from the viewer's OWN past connection/transcript events (who they've
// worked with) — self-contained, no dependency on the heavy connection graph.
export function buildViewer(surface = {}, identity = null) {
  const recordId = identity && identity.record_id ? String(identity.record_id) : "";
  const me = (Array.isArray(surface.people) ? surface.people : []).find((p) => p && p.record_id === recordId) || {};
  const conns = new Set();
  for (const ev of Array.isArray(surface.cohort_events) ? surface.cohort_events : []) {
    if (!ev || ev.actor !== recordId) continue;
    const withWhom = ev.value && Array.isArray(ev.value.with_whom) ? ev.value.with_whom : [];
    for (const w of withWhom) if (w) conns.add(String(w));
  }
  return {
    recordId,
    team: me.team || me.team_id || "",
    skillAreas: Array.isArray(me.skill_areas) ? me.skill_areas : [],
    connectionIds: [...conns],
    name: me.name || me.display_name || recordId,
  };
}

// The view-model. notable (loud+medium) events are ranked; quiet edits are rolled
// up into a count; the viewer's own events peel into `mine`.
export function buildFeedView(events, viewer = {}, prefs = DEFAULT_PREFS, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const lastSeen = Number.isFinite(opts.lastSeen) ? opts.lastSeen : 0;
  const filtered = filterByPrefs(events, prefs);
  const myId = viewer.recordId || "";

  const others = [];
  const mine = [];
  let quietCount = 0;
  for (const ev of filtered) {
    if (!ev || !ev.record_id) continue;
    if (isOwn(ev, myId)) { mine.push(ev); continue; }
    if (ev.weight === "quiet") { quietCount += 1; continue; }
    others.push(ev);
  }

  let items;
  if (prefs.feed_mode === "global") {
    items = others
      .slice()
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
      .map((ev) => ({ ...ev, _isNew: (Date.parse(ev.created_at || "") || 0) > lastSeen }));
  } else {
    const ranked = rankFeed(others, viewer, {
      now, lastSeen, authorMeta: opts.authorMeta || {}, interestTags: prefs.interest_tags || [],
    });
    items = ranked.feed;
  }

  mine.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  const newCount = items.filter((e) => e._isNew).length;
  return { items, mine, quietCount, newCount, mode: prefs.feed_mode || "for_you" };
}

// Normalize one ask (already run through asksWithStatus, so it carries _expired) into
// a feed item that scoreAsk + the renderer understand. created_at is the ask's most
// recent activity (_lastEventAt: a fresh claim/join resurfaces it); a done/expired/
// cancelled ask is _closed (folded into the bottom disclosure, not the live stream).
export function normalizeAskFeedItem(ask) {
  if (!ask || !ask.record_id) return null;
  const status = String(ask.status || "open").toLowerCase();
  const closed = !!ask._expired || status === "done" || status === "cancelled";
  const skillAreas = Array.isArray(ask.skill_areas) ? ask.skill_areas.map((s) => String(s).toLowerCase()) : [];
  return {
    _feedKind: "ask",
    _ask: ask,
    record_id: String(ask.record_id),
    actor: ask.author ? String(ask.author) : null,
    created_at: ask._lastEventAt || ask.posted_at || "",
    weight: closed ? "quiet" : "loud",
    _open: !closed && status === "open",
    _closed: closed,
    _skillAreas: skillAreas,
  };
}

// The blended view-model: asks and cohort updates in ONE ranked stream. Events split
// the usual way (own → mine, quiet → rollup); live asks are scored on the same scale
// (scoreAsk) and merged; closed asks peel into `closed` for the bottom disclosure.
// `prefs.feed_mode` flips personalization for the WHOLE feed: "for_you" applies viewer
// affinity (skill-matched asks + connections rise), "global"/everyone is weight×recency.
// `asks` must already be run through asks.js `asksWithStatus` (so each carries _expired
// + sorted) — that lives in a .js module the bundler loads but node can't import, so the
// caller statuses them and this stays pure + node-testable.
export function buildBlendedFeed({ events, asks, viewer = {}, prefs = DEFAULT_PREFS, opts = {} } = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const lastSeen = Number.isFinite(opts.lastSeen) ? opts.lastSeen : 0;
  const authorMeta = opts.authorMeta || {};
  const interestTags = prefs.interest_tags || [];
  const personalize = (prefs.feed_mode || "for_you") === "for_you";
  const myId = viewer.recordId || "";

  const filtered = filterByPrefs(events, prefs);
  const others = [];
  const mine = [];
  let quietCount = 0;
  for (const ev of filtered) {
    if (!ev || !ev.record_id) continue;
    if (isOwn(ev, myId)) { mine.push(ev); continue; }
    if (ev.weight === "quiet") { quietCount += 1; continue; }
    others.push(ev);
  }
  const rankedEvents = rankFeed(others, viewer, { now, lastSeen, authorMeta, interestTags, personalize })
    .feed.map((ev) => ({ ...ev, _feedKind: "event" }));

  const statused = Array.isArray(asks) ? asks : [];
  const liveItems = [];
  const closed = [];
  for (const ask of statused) {
    const item = normalizeAskFeedItem(ask);
    if (!item) continue;
    if (item._closed) { closed.push(ask); continue; }
    item._score = scoreAsk(item, viewer, { now, lastSeen, authorMeta, interestTags, personalize });
    item._isNew = (Date.parse(item.created_at || "") || 0) > lastSeen;
    liveItems.push(item);
  }

  const items = [...rankedEvents, ...liveItems].sort((a, b) =>
    (b._score - a._score) || ((Date.parse(b.created_at || "") || 0) - (Date.parse(a.created_at || "") || 0)));

  mine.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  const newCount = items.filter((e) => e._isNew).length;
  return { items, mine, quietCount, closed, newCount, mode: prefs.feed_mode || "for_you" };
}

// Map a surface field key to a human phrase for the feed label. Module-private —
// only feedItemLabel uses it (and feedItemLabel's tests cover the phrasing).
function humanField(field) {
  switch (field) {
    case "now": return "their focus";
    case "weekly_intention": return "their weekly intention";
    case "prior_work": return "shipped work";
    case "skills": return "their skills";
    case "skill_areas": return "their skill areas";
    case "seeking": return "what they're seeking";
    case "offering": return "what they're offering";
    default: return "their profile";
  }
}

// A human label for one feed event. nameOf(recordId) resolves a display name.
// Returns plain text (the caller escapes). Pure.
export function feedItemLabel(ev, nameOf = (id) => id) {
  if (!ev) return "";
  const who = nameOf(ev.actor || ev.record_id) || ev.actor || ev.record_id || "someone";
  switch (ev.event_type) {
    case "profile_edit": {
      const fields = Array.isArray(ev.value && ev.value.fields) ? ev.value.fields : [];
      const extra = fields.length > 1 ? ` +${fields.length - 1} more` : "";
      return `${who} updated ${humanField(ev.field)}${extra}`;
    }
    case "self_report":
      if (ev.value && ev.value.mode === "current_state_refresh") {
        if (Array.isArray(ev.value.team_fields) && ev.value.team_fields.length) {
          return `${who} refreshed where they are now and queued project evidence`;
        }
        return `${who} refreshed where they are now from recent work`;
      }
      return `${who} refreshed their profile from recent work`;
    case "transcript": {
      const title = ev.value && ev.value.title ? `: “${ev.value.title}”` : "";
      return `${who} shared a transcript${title}`;
    }
    case "contest":
      return `${who} contested a claim`;
    case "connection": {
      const withWhom = ev.value && Array.isArray(ev.value.with_whom) ? ev.value.with_whom : [];
      const others = withWhom.map((id) => nameOf(id) || id).filter(Boolean);
      return others.length ? `${who} connected with ${others.join(", ")}` : `${who} logged a connection`;
    }
    default:
      return `${who} contributed`;
  }
}
