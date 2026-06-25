// feed-rank.mjs — the on-device "for you" re-rank of the cohort activity feed.
//
// docs/two-way-contribution-layer.md "The activity feed": the backend is one global
// stream (app_cohort_feed); the viewer's app re-ranks it using its OWN profile, and
// NONE of those signals leave the device. Pure + deterministic + node-testable: the
// caller injects `now`, `lastSeen`, and an `authorMeta` map built from the local
// cohort index — this module never reads the network, localStorage, or the clock
// except through `opts.now`.
//
// Signals (the design doc's four): affinity (a connection / shared team / shared
// skill-area boosts), recency (newer wins, half-life decay), weight (a shipped or
// transcript outranks a one-word tweak), and unseen (anything since last visit is
// marked "new"). The viewer's OWN events peel into a separate "your activity" rail.

const WEIGHT_SCORE = Object.freeze({ loud: 3, medium: 1.5, quiet: 0.5 });

function ts(ev) {
  const t = Date.parse(ev && ev.created_at ? ev.created_at : "");
  return Number.isFinite(t) ? t : 0;
}

// Is this event the viewer's own? Prefer the actor (who did it); fall back to the
// subject when the event carries no actor (an unclaimed self-write).
function isOwn(ev, myId) {
  if (!myId) return false;
  return ev.actor ? ev.actor === myId : ev.record_id === myId;
}

// Does the event's payload mention one of the viewer's interest tags? Checks the
// changed field, and any string/array leaves of `value` (skill_areas, tags, …).
function mentionsInterest(ev, interestSet) {
  if (!interestSet.size) return false;
  if (ev.field && interestSet.has(String(ev.field).toLowerCase())) return true;
  const v = ev.value || {};
  for (const key of Object.keys(v)) {
    const leaf = v[key];
    if (typeof leaf === "string" && interestSet.has(leaf.toLowerCase())) return true;
    if (Array.isArray(leaf)) {
      for (const item of leaf) {
        if (typeof item === "string" && interestSet.has(item.toLowerCase())) return true;
      }
    }
  }
  return false;
}

// Re-rank a feed for one viewer. Returns:
//   { feed:  [...non-own events, scored + _score + _isNew, best first],
//     mine:  [...the viewer's own events, newest first],
//     newCount: number of unseen events in `feed` }
//
// viewer: { recordId, team, skillAreas:[], connectionIds:[] }
// opts:   { now, lastSeen, halfLifeHours, authorMeta:{ recordId:{team,skillAreas} }, interestTags:[] }
export function rankFeed(events, viewer = {}, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const lastSeen = Number.isFinite(opts.lastSeen) ? opts.lastSeen : 0;
  const halfLife = Number.isFinite(opts.halfLifeHours) && opts.halfLifeHours > 0 ? opts.halfLifeHours : 36;
  const authorMeta = opts.authorMeta && typeof opts.authorMeta === "object" ? opts.authorMeta : {};
  const interestSet = new Set((opts.interestTags || []).map((s) => String(s).toLowerCase()));

  const myId = viewer.recordId || "";
  const myTeam = viewer.team || "";
  const mySkills = new Set((viewer.skillAreas || []).map((s) => String(s).toLowerCase()));
  const conns = new Set((viewer.connectionIds || []).map(String));

  const mine = [];
  const scored = [];

  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev !== "object" || !ev.record_id) continue;
    if (isOwn(ev, myId)) { mine.push(ev); continue; }

    const eventTs = ts(ev);
    const ageHours = Math.max(0, (now - eventTs) / 3600000);
    const recency = Math.pow(0.5, ageHours / halfLife); // 1 at age 0 → 0.5 per half-life
    const weightScore = WEIGHT_SCORE[ev.weight] != null ? WEIGHT_SCORE[ev.weight] : 1;

    let affinity = 0;
    const actor = ev.actor || "";
    if (actor && conns.has(actor)) affinity += 5;            // a direct connection
    const meta = authorMeta[actor] || {};
    if (myTeam && meta.team && meta.team === myTeam) affinity += 3; // same team
    if (mySkills.size && Array.isArray(meta.skillAreas)) {   // shared skill-areas (≤3)
      const overlap = meta.skillAreas.filter((s) => mySkills.has(String(s).toLowerCase())).length;
      affinity += Math.min(overlap, 3);
    }
    if (mentionsInterest(ev, interestSet)) affinity += 2;    // an agent-set interest tag

    const score = (1 + affinity) * weightScore * recency;
    scored.push({ ...ev, _score: score, _isNew: eventTs > lastSeen });
  }

  scored.sort((a, b) => (b._score - a._score) || (ts(b) - ts(a)));
  mine.sort((a, b) => ts(b) - ts(a));
  return { feed: scored, mine, newCount: scored.filter((e) => e._isNew).length };
}
