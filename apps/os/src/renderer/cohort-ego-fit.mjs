// Egocentric "where a team sits" fit math — the single source of truth for the
// per-company overlap (Venn) inspector. Extracted from alchemy.js so the circle
// geometry (how close each space sits to the focal) and the spelled-out per-circle
// "why it sits there at ~%" breakdown read from ONE computation and can never
// disagree. Pure + deterministic: given (team, ctx) it returns the same result,
// so it is unit-tested in cohort-ego-fit.test.mjs.
//
// The fit signal is an ESTIMATE, derived from DECLARED skill_areas overlap — not a
// measured number. Callers surface it as "~%" and label its basis honestly.

const FALLBACK_AFF = 0.65; // no skills / no scorable pool → treat as an even, unscored member
const AFF_FLOOR = 0.3;     // every member is still a member; a peripheral one scores ~0.3
const AFF_SPAN = 0.7;      // a prototypical team scores ~1.0

function lowerList(value) {
  return (Array.isArray(value) ? value : []).map((s) => String(s).toLowerCase());
}

// Words from a space's label that are specific enough to count as part of its
// shared vocabulary (>3 chars, alnum-split). "Attestation / TEE" → ["attestation"].
export function egoLabelWords(label) {
  return String(label || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3);
}

// The space's shared skill pool: every OTHER member's declared skills, plus the
// label's own vocabulary. `selfId` is excluded so a team is never scored against
// its own skills.
export function egoSpacePool(space, teamById, selfId) {
  const pool = new Set();
  for (const id of (space?.allTeams || [])) {
    if (id === selfId) continue;
    for (const s of lowerList(teamById?.get?.(id)?.skill_areas)) pool.add(s);
  }
  for (const w of egoLabelWords(space?.label)) pool.add(w);
  return pool;
}

// Affinity of `memberId` to one `space`: the share of that member's declared
// skills the rest of the space also works in. Returns the score plus the trace
// (which skills matched, how big the pool was) so callers can explain the number.
export function egoAffinity(memberId, space, teamById) {
  const mine = lowerList(teamById?.get?.(memberId)?.skill_areas);
  if (!mine.length) {
    return { aff: FALLBACK_AFF, hits: 0, matched: [], poolSize: null, mineLen: 0, fallback: true, reason: "no-skills" };
  }
  const pool = egoSpacePool(space, teamById, memberId);
  if (!pool.size) {
    return { aff: FALLBACK_AFF, hits: 0, matched: [], poolSize: 0, mineLen: mine.length, fallback: true, reason: "empty-pool" };
  }
  let hits = 0;
  const matchedSet = new Set();
  for (const s of mine) {
    if (pool.has(s)) { hits++; matchedSet.add(s); }
  }
  return {
    aff: AFF_FLOOR + AFF_SPAN * (hits / mine.length),
    hits,
    matched: [...matchedSet],
    poolSize: pool.size,
    mineLen: mine.length,
    fallback: false,
    reason: "fit",
  };
}

// The spaces (clusters) a team belongs to, in cluster declaration order — the
// FIRST is the team's primary / home neighbourhood, matching how the map packs it.
export function egoSpaces(team, ctx) {
  const clusters = Array.isArray(ctx?.clusters) ? ctx.clusters : [];
  const rid = team?.record_id;
  return clusters
    .filter((c) => Array.isArray(c.teams) && c.teams.includes(rid))
    .map((c) => ({
      id: c.record_id || c.name,
      label: c.label || c.name || c.record_id,
      allTeams: c.teams || [],
      members: c.teams.filter((id) => id !== rid),
    }));
}

// Split a weight vector into integer percents summing to exactly 100 (largest
// remainder). Deterministic: ties resolve by original index order.
export function largestRemainderPct(weights) {
  const sum = weights.reduce((s, a) => s + a, 0) || 1;
  const pct = weights.map((a) => Math.floor((a / sum) * 100));
  const rem = 100 - pct.reduce((s, p) => s + p, 0);
  const byFrac = weights
    .map((a, i) => ({ i, frac: (a / sum) * 100 - Math.floor((a / sum) * 100) }))
    .sort((x, y) => y.frac - x.frac || x.i - y.i);
  for (let k = 0; k < rem && byFrac.length; k++) pct[byFrac[k % byFrac.length].i]++;
  return pct;
}

// The full per-space fit for a focal team: each space it sits in, the focal's
// affinity to it, and the focal's ~% focus split across its spaces (estimated
// from the same affinity, so the geometry and the printed % always agree).
export function egoSpaceFits(team, ctx) {
  const teamById = ctx?.teamById;
  const rid = team?.record_id;
  const spaces = egoSpaces(team, ctx);
  const N = spaces.length;
  const fit = spaces.map((sp) =>
    N === 1
      ? { aff: 1, hits: 0, matched: [], poolSize: null, mineLen: lowerList(teamById?.get?.(rid)?.skill_areas).length, fallback: false, reason: "single" }
      : egoAffinity(rid, sp, teamById)
  );
  const focalAff = fit.map((f) => f.aff);
  const pct = N === 1 ? [100] : largestRemainderPct(focalAff);
  return {
    N,
    spaces: spaces.map((sp, i) => ({ ...sp, ...fit[i], focalAff: focalAff[i], pct: pct[i] })),
  };
}
