// prompt.js — pure prompt construction for the hermes brain.
//
// No DOM, no window, no module state: every input is passed in, so this is the
// single, unit-testable home for how cohort-public data + the user's scanned
// shape become a grounded prompt. The renderer (app.js) owns UI state and the
// public-vs-private (locality) decision and passes the result in here.

// Keep the projected grounding well within a model's context. The cohort surface
// grows over time; without a bound the model would silently see truncated JSON
// and answer confidently wrong. Far above today's ~24KB projection, so current
// behaviour is unchanged — this only engages as the cohort scales.
const CONTEXT_CHAR_BUDGET = 60000;

// Project the cohort-public surface to the fields the connector needs, bounded
// so a growing cohort can't overflow context silently. If over budget, trim the
// people list and annotate the truncation so the model (and the reader) know the
// grounding was narrowed rather than guessing at a cut-off tail.
export function buildContext(cohort) {
  if (!cohort) return "(no cohort data loaded)";
  const people = (cohort.people || []).map((p) => ({
    name: p.name, team: p.team, role: p.role,
    skills: p.skills, skill_areas: p.skill_areas,
    offering: p.offering, seeking: p.seeking,
    now: p.now, weekly_intention: p.weekly_intention,
  }));
  const teams = (cohort.teams || []).map((t) => ({
    name: t.name, focus: t.focus, skill_areas: t.skill_areas,
    seeking: t.seeking, offering: t.offering,
  }));
  let json = JSON.stringify({ people, teams }, null, 0);
  if (json.length > CONTEXT_CHAR_BUDGET) {
    let kept = people.length;
    while (kept > 1 && JSON.stringify({ people: people.slice(0, kept), teams }, null, 0).length > CONTEXT_CHAR_BUDGET) {
      kept -= Math.max(1, Math.floor(kept / 10));
    }
    json = JSON.stringify({
      people: people.slice(0, Math.max(1, kept)),
      teams,
      _note: `showing ${Math.max(1, kept)} of ${people.length} members — ask a more specific question to narrow the search`,
    }, null, 0);
  }
  return json;
}

// Format a scanned shape for the prompt → { text, hasPrivate }. Public GitHub is
// always safe; the private Codex section is added only when includePrivate (a
// local backend). hasPrivate reports whether private content was ACTUALLY
// emitted, so the caller can tag dataMode honestly and the engine gate enforces.
export function buildShapeGrounding(s, includePrivate) {
  if (!s) return { text: "", hasPrivate: false };
  const g = s.github || {}, c = s.codex || {};
  const lines = [];
  if (g.ok) {
    lines.push(`GitHub (public): ${g.name || g.login}${g.company ? " · " + g.company : ""}${g.bio ? " — " + String(g.bio).replace(/\s+/g, " ").trim() : ""}`);
    if (g.languages && g.languages.length) lines.push(`Languages: ${g.languages.slice(0, 6).map((l) => `${l.lang}(${l.repos})`).join(", ")}`);
    if (g.recent_repos && g.recent_repos.length) lines.push(`Recent repos: ${g.recent_repos.slice(0, 10).map((r) => `${r.name}${r.lang ? "/" + r.lang : ""}`).join(", ")}`);
  }
  let hasPrivate = false;
  if (includePrivate && c.ok && c.total_sessions) {
    hasPrivate = true;
    lines.push(`Local work focus (private — Codex ${c.date_range.first}→${c.date_range.last}, ${c.total_sessions} sessions / ${c.project_count} projects):`);
    lines.push(c.top_projects.slice(0, 10).map((p) => `${p.project} (${p.sessions})`).join(", "));
  }
  return { text: lines.join("\n"), hasPrivate };
}

// Build the grounded connector prompt → { prompt, dataMode }. includePrivate is
// the caller's locality decision; dataMode reflects what the prompt actually
// contains so the engine's data-mode gate is a real backstop.
export function buildPrompt({ question, cohort, shape, includePrivate }) {
  const parts = [
    "You are a connector for the Shape Rotator cohort — you help members FIND the right people and understand how to ENGAGE them. You have read-only access to the cohort's public profile data (names, teams, skills, what they're working on, what they're seeking, what they offer).",
    "",
    "When the question is about finding people or teams (who can help with X, who's working on Y, who to talk to about Z, who to pair with), name the specific members or teams and, for EACH one, give: WHAT TO GO TO THEM FOR (grounded in a short quote from their profile) and a good CONVERSATION OPENER. For other questions, cite specific members or teams by name and quote short snippets when useful.",
    "",
    "You only surface who and why — never draft an outreach message, offer to contact anyone, or imply you can reach them; the member reaches out themselves. If the data doesn't contain an answer, say so plainly — don't invent participants.",
  ];
  const sg = buildShapeGrounding(shape, includePrivate);
  if (sg.text) {
    parts.push(
      "",
      "The person asking is the OS user — the following is THEIR OWN shape (you are their assistant). Use it to answer questions about their work, focus, strengths, or trajectory:",
      "<user_shape>", sg.text, "</user_shape>",
    );
  }
  parts.push("", "<cohort_data>", buildContext(cohort), "</cohort_data>", "", `User question: ${question}`);
  return { prompt: parts.join("\n"), dataMode: sg.hasPrivate ? "private_distilled" : "public" };
}

// Prompt that asks the engine to distill the user's own shape into a structured
// shape_rotator_mapping (JSON only).
export function buildSynthesisPrompt(grounding) {
  return [
    "You are defining the OS user's professional \"shape\" from their OWN work data below. Be concrete and base every claim on the data; do not invent.",
    "Respond with ONLY a JSON object — no prose, no markdown fences — with exactly these keys:",
    '{"headline": "one-line shape summary", "current_focus": "what they are working on now", "likely_roles": ["..."], "strengths": ["..."], "what_to_go_to_them_for": ["..."], "conversation_affordances": ["good things to talk to them about"], "trajectory": "how their focus is shifting over time", "confidence": "low|medium|high"}',
    "Keep each array to 3-5 short items. If something isn't supported by the data, use an empty array or \"unknown\".",
    "",
    "<shape_data>",
    grounding,
    "</shape_data>",
  ].join("\n");
}

// Pull a JSON object out of an engine reply (tolerates ``` fences / surrounding
// prose). Returns the parsed object or null.
export function parseShapeJson(text) {
  if (!text) return null;
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}
