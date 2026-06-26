// cohort-chat-focus.mjs — the scan/edit FOCUS: the one project a member is working
// on. The github scan is scoped to it and a team write targets it, so a refresh never
// grabs data unrelated to the project in hand. The focus is chosen by the MEMBER (an
// explicit pick, or the project they named in chat) — never by the model — so the
// model can't widen what gets read. Pure + testable.
//
// A focus = {
//   teamId, teamName,        // the project's team record — the write subject
//   repos: ["owner/repo"],   // the only repos a github scan may read (lowercased)
// }
//
// resolveChatFocus order: explicit pick → named-in-chat → sole/primary team → none.

import { normalizeGithubRepo } from "./cohort-chat-actions.mjs";

const TOKEN_STOP = new Set([
  "the", "a", "an", "and", "or", "of", "for", "to", "on", "in", "with", "team",
  "project", "app", "os", "io", "xyz", "com", "my", "our", "we", "i", "working",
  "work", "build", "building", "stuff", "thing", "things",
]);

// Lowercase word tokens ≥3 chars, minus cohort-ubiquitous filler. Used to match a
// team the member named and to keep session reads on-topic.
export function tokenize(text) {
  return String(text == null ? "" : text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !TOKEN_STOP.has(t));
}

// "owner/repo" (lowercased) or "" — reuses the validated, URL/.git-aware repo parser
// from the action contract so there is ONE normalizer at the repo-scope security
// boundary (strict github-username owner). Lowercased for the allowlist + cache key.
export function normalizeRepo(raw) {
  const r = normalizeGithubRepo(raw);
  return r ? r.toLowerCase() : "";
}

// The member's candidate projects = primary `team` + `secondary_teams`, resolved to
// team records present in the surface (primary first, de-duped).
export function memberTeams(surface, identity) {
  const people = (surface && Array.isArray(surface.people)) ? surface.people : [];
  const teams = (surface && Array.isArray(surface.teams)) ? surface.teams : [];
  const byId = new Map(teams.map((t) => [String(t.record_id), t]));
  const me = identity && identity.record_id
    ? people.find((p) => p && p.record_id === identity.record_id) : null;
  if (!me) return [];
  const ids = [];
  if (me.team) ids.push(String(me.team));
  for (const s of Array.isArray(me.secondary_teams) ? me.secondary_teams : []) ids.push(String(s));
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    if (seen.has(id) || !byId.has(id)) continue;
    seen.add(id);
    out.push(byId.get(id));
  }
  return out;
}

// Did the member NAME one of their teams in free text ("I'm working on TeeSQL")?
// Returns the best-matching team record (by shared name/id tokens) or null.
export function matchTeamText(text, teams) {
  const toks = new Set(tokenize(text));
  if (!toks.size) return null;
  let best = null;
  let bestScore = 0;
  for (const t of Array.isArray(teams) ? teams : []) {
    const nameToks = tokenize(`${t.name || ""} ${t.record_id || ""}`);
    let score = 0;
    for (const nt of nameToks) if (toks.has(nt)) score += 1;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return bestScore > 0 ? best : null;
}

function dedupe(list) { return [...new Set(list.filter(Boolean))]; }

// Build the focus object for a chosen team (the project in hand). `person` adds the
// member's own repo so their commits to the project are in scope too.
export function focusForTeam(team, { person } = {}) {
  if (!team || !team.record_id) return null;
  const tl = (team.links && typeof team.links === "object") ? team.links : {};
  const pl = (person && person.links && typeof person.links === "object") ? person.links : {};
  const repos = dedupe([tl.repo, tl.github, pl.repo].map(normalizeRepo));
  return {
    teamId: String(team.record_id),
    teamName: String(team.name || team.record_id),
    repos,
  };
}

// Resolve the active focus. Returns { focus, candidates, reason } so the UI can offer
// a picker (candidates) and the caller can ASK the member when it's ambiguous
// (reason === "default-primary" with >1 candidate, or "no-team").
export function resolveChatFocus({ surface, identity, selectedTeamId = "", mentioned = "" } = {}) {
  const teams = memberTeams(surface, identity);
  const people = (surface && Array.isArray(surface.people)) ? surface.people : [];
  const person = identity && identity.record_id
    ? people.find((p) => p && p.record_id === identity.record_id) : null;
  const pick = (t, reason) => ({ focus: focusForTeam(t, { person }), candidates: teams, reason });
  if (!teams.length) return { focus: null, candidates: [], reason: "no-team" };
  if (selectedTeamId) {
    const t = teams.find((x) => String(x.record_id) === String(selectedTeamId));
    if (t) return pick(t, "selected");
  }
  if (mentioned) {
    const t = matchTeamText(mentioned, teams);
    if (t) return pick(t, "named");
  }
  if (teams.length === 1) return pick(teams[0], "only-team");
  return pick(teams[0], "default-primary");
}
