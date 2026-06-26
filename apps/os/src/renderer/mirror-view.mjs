// mirror-view.mjs — the pure view-model behind the Mirror's subject switcher
// (you · browse · compare). The DOM render lives in alchemy.js (renderSayDidShipped);
// this owns the LOGIC — which subject is shown, self vs other, the compare pair —
// so it is node-testable. say/did/shipped cards are keyed by TEAM subject today
// (cohortInsightSubjectMap), so "a person's mirror" is their team's mirror.

export const MIRROR_MODES = Object.freeze(["self", "browse", "compare"]);

export function normalizeMirrorMode(mode) {
  return MIRROR_MODES.includes(mode) ? mode : "self";
}

// The teams that actually have a say/did/shipped card, as { teamId, name },
// sorted by name — the browsable / comparable subjects. `hasCard(teamId)` is the
// membership test (e.g. cohortInsightSubjectMap("say_did_shipped").has).
export function browsableSubjects(teams, hasCard) {
  const has = typeof hasCard === "function" ? hasCard : () => false;
  return (Array.isArray(teams) ? teams : [])
    .filter((t) => t && t.record_id && has(String(t.record_id)))
    .map((t) => ({ teamId: String(t.record_id), name: String(t.name || t.record_id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function isSelfSubject(teamId, selfTeamId) {
  return !!teamId && !!selfTeamId && String(teamId) === String(selfTeamId);
}

// "your mirror" for the self subject; "<name>’s mirror" for anyone else.
export function subjectEyebrow(teamId, selfTeamId, name) {
  return isSelfSubject(teamId, selfTeamId) ? "your mirror" : `${name || teamId}’s mirror`;
}

// The focused subject in browse mode: the requested one if valid, else the first
// non-self subject (so "browse" opens on someone else by default), else self,
// else the first subject. Returns null when there are no subjects.
export function resolveFocus({ focusId, selfTeamId, subjects = [] } = {}) {
  const ids = new Set(subjects.map((s) => s.teamId));
  if (focusId && ids.has(String(focusId))) return String(focusId);
  const other = subjects.find((s) => !isSelfSubject(s.teamId, selfTeamId));
  if (other) return other.teamId;
  if (selfTeamId && ids.has(String(selfTeamId))) return String(selfTeamId);
  return subjects.length ? subjects[0].teamId : null;
}

// The compare pair {a, b}: A defaults to self (else the first subject); B defaults
// to the first subject that isn't A. Both are validated against the subject set.
// Either may be null when there aren't enough subjects.
export function resolveComparePair({ selfTeamId, aId, bId, subjects = [] } = {}) {
  const ids = new Set(subjects.map((s) => s.teamId));
  let a = null;
  if (aId && ids.has(String(aId))) a = String(aId);
  else if (selfTeamId && ids.has(String(selfTeamId))) a = String(selfTeamId);
  else a = subjects.length ? subjects[0].teamId : null;

  let b = null;
  if (bId && ids.has(String(bId)) && String(bId) !== a) b = String(bId);
  if (!b) b = (subjects.find((s) => s.teamId !== a) || {}).teamId || null;
  return { a, b };
}

// The full view-model for a render tick. opts: { mode, focusId, compareA, compareB,
// selfTeamId, teams, hasCard }.
export function mirrorViewModel(opts = {}) {
  const mode = normalizeMirrorMode(opts.mode);
  const selfTeamId = opts.selfTeamId ? String(opts.selfTeamId) : "";
  const subjects = browsableSubjects(opts.teams, opts.hasCard);
  const out = { mode, selfTeamId, subjects };
  if (mode === "browse") {
    out.focus = resolveFocus({ focusId: opts.focusId, selfTeamId, subjects });
  } else if (mode === "compare") {
    out.compare = resolveComparePair({ selfTeamId, aId: opts.compareA, bId: opts.compareB, subjects });
  }
  return out;
}
