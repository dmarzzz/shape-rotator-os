// cohort-chat-context.mjs — turns the loaded cohort surface into a compact,
// grounded prompt for the local AI CLI behind the "chat with the cohort" panel.
//
// The surface is large (~2MB) and most local models have a modest context
// window, so this does lightweight keyword RETRIEVAL: records (teams/people)
// and evidence cards that overlap the question are expanded in full; the rest
// are summarized to one line. Everything is grounded — the model is told to
// answer ONLY from this context and to cite names — so "who's doing what",
// "what's happening", and "who should I talk to for X" are all answerable from
// the same pack (the connection edges from the daily routine ride along on each
// team as `connections`). Pure + deterministic ⇒ unit-tested.

const STOP = new Set(["the","and","for","with","that","this","from","into","your","you","our","are","who","what","how","should","talk","about","which","whom","can","does","whats","what's","is","of","to","in","on","a","an","i","me","my","we","they","please"]);

export function qTokens(text) {
  const out = new Set();
  for (const w of String(text || "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3 && w !== "ai" && w !== "tee" && w !== "rl" && w !== "os") continue;
    if (STOP.has(w)) continue;
    out.add(w);
  }
  return out;
}

function list(v) {
  if (Array.isArray(v)) return v.filter((x) => x != null).map(String);
  if (v == null || v === "") return [];
  return [String(v)];
}

const SEARCH_FIELDS = Object.freeze([
  "name", "record_id", "focus", "domain", "now", "role", "team", "geo",
  "seeking", "offering", "skill_areas", "go_to_them_for", "best_contexts",
  "recurring_themes", "working_style", "contribute_interests", "weekly_intention",
  "prior_work", "bio_md", "links", "traction", "prior_shipping",
  "success_dimensions", "dependencies", "journey", "connections",
]);

function collectText(value, out = [], depth = 0) {
  if (value == null || depth > 4) return out;
  if (typeof value === "string" || typeof value === "number") {
    const s = String(value).trim();
    if (s) out.push(s);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, out, depth + 1);
    return out;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) collectText(item, out, depth + 1);
  }
  return out;
}

function searchText(r) {
  const out = [];
  for (const key of SEARCH_FIELDS) collectText(r && r[key], out);
  return out.join(" ").toLowerCase();
}

function wordSet(text) {
  return new Set(String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

function scoreRecord(r, qset) {
  if (!qset.size) return 0;
  const text = searchText(r);
  const words = wordSet(text);
  const identity = `${r.name || ""} ${r.record_id || ""}`.toLowerCase();
  let s = 0;
  for (const t of qset) {
    if (words.has(t)) s += 3;
    else if (text.includes(t)) s += 1;
    if (identity.includes(t)) s += 3;
  }
  return s;
}

function shortText(value, max = 360) {
  const s = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "..." : s;
}

// Full team block — the high-value fields + its precomputed connections.
export function teamBlock(t) {
  const lines = [`### ${t.name || t.record_id} (team, id:${t.record_id})`];
  if (t.focus) lines.push(`focus: ${t.focus}`);
  if (t.now) lines.push(`now: ${t.now}`);
  const links = t.links && typeof t.links === "object" ? t.links : {};
  const linkBits = [links.repo && `repo: ${links.repo}`, links.github && `github: ${links.github}`, links.website && `website: ${links.website}`].filter(Boolean);
  if (linkBits.length) lines.push(`links: ${linkBits.join("; ")}`);
  if (t.traction) lines.push(`traction: ${shortText(t.traction)}`);
  if (list(t.prior_shipping).length) lines.push(`prior shipping: ${list(t.prior_shipping).slice(0, 4).join("; ")}`);
  if (list(t.success_dimensions).length) lines.push(`success dimensions: ${list(t.success_dimensions).join(", ")}`);
  if (list(t.dependencies).length) lines.push(`dependencies: ${list(t.dependencies).join(", ")}`);
  const seeking = list(t.seeking);
  const offering = list(t.offering);
  if (seeking.length) lines.push(`seeking: ${seeking.join("; ")}`);
  if (offering.length) lines.push(`offering: ${offering.join("; ")}`);
  if (list(t.skill_areas).length) lines.push(`skills: ${list(t.skill_areas).join(", ")}`);
  const j = t.journey || {};
  const jbits = [];
  if (j.stage != null) jbits.push(`stage ${j.stage}`);
  if (j.primary_bottleneck) jbits.push(`bottleneck: ${j.primary_bottleneck}`);
  if (j.next_milestone) jbits.push(`next: ${j.next_milestone}`);
  if (jbits.length) lines.push(`progress: ${jbits.join(" · ")}`);
  if (j.icp) lines.push(`journey icp: ${shortText(j.icp)}`);
  if (j.problem) lines.push(`journey problem: ${shortText(j.problem)}`);
  if (j.solution) lines.push(`journey solution: ${shortText(j.solution)}`);
  if (j.evidence_notes) lines.push(`journey evidence: ${shortText(j.evidence_notes)}`);
  const conns = Array.isArray(t.connections) ? t.connections.slice(0, 5) : [];
  if (conns.length) {
    lines.push("suggested connections:");
    for (const c of conns) lines.push(`  - ${c.toName || c.to}: ${c.reason || c.kind || ""}`.trimEnd());
  }
  return lines.join("\n");
}

function personLine(p) {
  const goto = list(p.go_to_them_for).slice(0, 3).join(", ");
  const skills = list(p.skill_areas).slice(0, 4).join(", ");
  return `- ${p.name || p.record_id} (${p.team || "—"})${p.now ? ` — now: ${p.now}` : ""}${goto ? ` · go to them for: ${goto}` : ""}${skills ? ` · skills: ${skills}` : ""}`;
}

function personDetailLine(p) {
  const base = personLine(p);
  const links = p.links && typeof p.links === "object" ? p.links : {};
  const linkBits = [links.github && `github: ${links.github}`, links.repo && `repo: ${links.repo}`, links.website && `website: ${links.website}`].filter(Boolean);
  const bits = [
    list(p.prior_work).slice(0, 2).length ? `prior: ${list(p.prior_work).slice(0, 2).join(", ")}` : "",
    list(p.seeking).slice(0, 2).length ? `seeking: ${list(p.seeking).slice(0, 2).join("; ")}` : "",
    list(p.offering).slice(0, 2).length ? `offering: ${list(p.offering).slice(0, 2).join("; ")}` : "",
    linkBits.length ? linkBits.join("; ") : "",
  ].filter(Boolean);
  return bits.length ? `${base} | ${bits.join(" | ")}` : base;
}

function teamLine(t) {
  const seeking = list(t.seeking).slice(0, 2).join("; ");
  return `- ${t.name || t.record_id} (id:${t.record_id})${t.focus ? ` — ${t.focus}` : ""}${seeking ? ` · seeking: ${seeking}` : ""}`;
}

function evidenceCardLine(c) {
  const text = c.claim_text || (c.content_json && (c.content_json.summary || c.content_json.claim_text)) || c.title || "";
  const wk = (c.content_json && c.content_json.week_start) || c.week_start || "";
  return text ? `- ${wk ? `[${wk}] ` : ""}${String(text).slice(0, 220)}` : null;
}

// Build the grounded context block, retrieval-ranked against the question and
// bounded to ~maxChars. Returns a string.
export function buildCohortContext(surface, { question = "", maxChars = 22000, fullTeams = 8, fullPeople = 6, focus = null } = {}) {
  const s = surface || {};
  const teams = Array.isArray(s.teams) ? s.teams : [];
  const people = Array.isArray(s.people) ? s.people : [];
  const qset = qTokens(question);
  const focusId = focus && focus.teamId ? String(focus.teamId) : "";
  const focusedTeam = focusId ? teams.find((t) => String(t.record_id) === focusId) : null;

  const rankedTeams = teams.map((t) => ({ t, score: scoreRecord(t, qset) })).sort((a, b) => b.score - a.score);
  const rankedPeople = people.map((p) => ({ p, score: scoreRecord(p, qset) })).sort((a, b) => b.score - a.score);

  // When a project focus was resolved by the app, always include it in full
  // detail. Retrieval still ranks the rest of the pack around the member's words.
  const scoredTeams = rankedTeams.filter((x) => x.score > 0).map((x) => x.t);
  const sampleTeams = rankedTeams.slice(0, fullTeams).map((x) => x.t);
  let topTeams = (scoredTeams.length ? scoredTeams : sampleTeams).slice(0, fullTeams);
  if (focusedTeam) {
    topTeams = [focusedTeam, ...topTeams.filter((t) => String(t.record_id) !== focusId)].slice(0, fullTeams);
  }
  const topTeamIds = new Set(topTeams.map((t) => t.record_id));
  const restTeams = teams.filter((t) => !topTeamIds.has(t.record_id));
  const focusPeople = focusId ? people.filter((p) => String(p.team || "") === focusId) : [];
  const topPeopleSeed = [
    ...rankedPeople.filter((x) => x.score > 0).map((x) => x.p),
    ...focusPeople,
  ];
  const seenPeople = new Set();
  const topPeople = [];
  for (const p of topPeopleSeed) {
    const id = p && p.record_id ? String(p.record_id) : "";
    if (!id || seenPeople.has(id)) continue;
    seenPeople.add(id);
    topPeople.push(p);
    if (topPeople.length >= fullPeople) break;
  }
  const topPeopleIds = new Set(topPeople.map((p) => p.record_id));

  const parts = [];
  parts.push(`COHORT: ${teams.length} teams, ${people.length} people. Program: Shape Rotator accelerator.`);

  parts.push("\n## Most relevant teams (full detail)");
  for (const t of topTeams) parts.push(teamBlock(t));

  if (restTeams.length) {
    parts.push("\n## Other teams (one-line)");
    parts.push(restTeams.map(teamLine).join("\n"));
  }

  if (topPeople.length) {
    parts.push("\n## Most relevant people");
    parts.push(topPeople.map(personDetailLine).join("\n"));
  }

  // Recent distilled session insights ("what's happening" substrate).
  const cards = Array.isArray(s.transcript_evidence_cards) ? s.transcript_evidence_cards : [];
  if (cards.length) {
    const ranked = cards
      .map((c) => ({ c, score: qset.size ? [...qset].filter((t) => evidenceText(c).includes(t)).length : 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 14)
      .map((x) => evidenceCardLine(x.c))
      .filter(Boolean);
    if (ranked.length) {
      parts.push("\n## Recent distilled session insights");
      parts.push(ranked.join("\n"));
    }
  }

  // Recent activity feed ("what's new").
  const wn = Array.isArray(s.whats_new) ? s.whats_new.slice(0, 12) : [];
  if (wn.length) {
    parts.push("\n## Recent activity (what's new)");
    parts.push(wn.map((w) => `- [${w.date || ""}] ${w.label || ""}${w.meta ? ` (${w.meta})` : ""}`).join("\n"));
  }

  // People one-line roster (only the rest, compact) if budget allows.
  const restPeople = people.filter((p) => !topPeopleIds.has(p.record_id));
  if (restPeople.length) {
    parts.push("\n## Cohort roster (people, one-line)");
    parts.push(restPeople.map((p) => `- ${p.name || p.record_id} (${p.team || "—"})${list(p.go_to_them_for).length ? ` · ${list(p.go_to_them_for).slice(0, 2).join(", ")}` : ""}`).join("\n"));
  }

  let ctx = parts.join("\n");
  if (ctx.length > maxChars) ctx = ctx.slice(0, maxChars) + "\n…[context truncated]";
  return ctx;
}

function evidenceText(c) {
  return collectText(c).join(" ").toLowerCase();
}

export function classifyChatIntent(question = "") {
  const q = String(question || "").toLowerCase();
  if (/\b(connect|connection|intro|introduce|meet|talk to|who should|who can help)\b/.test(q)) return "connection";
  const asksToChange = /\b(update|refresh|save|store|scan)\b/.test(q);
  const asksProfileRefresh = /\b(profile|cohort thing)\b/.test(q)
    && /\b(github|this week|weekly|recent work|work)\b/.test(q);
  if ((asksToChange || asksProfileRefresh)
    && /\b(my|me|i|profile|github|work|project|team|cohort|week|shape|os)\b/.test(q)) {
    return "refresh_update";
  }
  if (/\b(what'?s happening|what is happening|progress|status|what did|ship|shipped|shipping|new|recent)\b/.test(q)) return "status_lookup";
  return "answer";
}

export function needsProjectConfirmation(route, focusResolution) {
  return route === "refresh_update"
    && focusResolution
    && focusResolution.reason === "default-primary"
    && Array.isArray(focusResolution.candidates)
    && focusResolution.candidates.length > 1;
}

function routingBlock({ route, focus, focusResolution } = {}) {
  const lines = [`intent: ${route || "answer"}`];
  if (focusResolution) {
    lines.push(`focus_reason: ${focusResolution.reason || "unknown"}`);
    if (Array.isArray(focusResolution.candidates) && focusResolution.candidates.length) {
      lines.push(`member_projects: ${focusResolution.candidates.map((t) => `${t.name || t.record_id} (${t.record_id})`).join("; ")}`);
    }
  }
  if (focus && focus.teamId) {
    lines.push(`active_project: ${focus.teamName} (${focus.teamId})`);
    if (Array.isArray(focus.repos) && focus.repos.length) lines.push(`active_project_repos: ${focus.repos.join(", ")}`);
  }
  if (needsProjectConfirmation(route, focusResolution)) {
    lines.push("instruction: Before proposing a scan or profile/project update, ask which project to use. Do not emit request_scan or propose_profile_update until the member names one of their projects.");
  } else if (route === "refresh_update") {
    lines.push("instruction: For this-week/profile refreshes, prefer request_scan over guessing. If GitHub is named, request the github source; if local sessions are needed, request sessions too. Treat scans as evidence collection, not pitching: keep only project-relevant signal, mark missing evidence plainly, and propose updates only after grounded tool results or clear context.");
  } else if (route === "connection") {
    lines.push("instruction: Answer with specific people/teams and reasons. Emit a connection action only if the member asks to save/propose it.");
  }
  return `\n===== ROUTING =====\n${lines.join("\n")}\n===== END ROUTING =====`;
}

const SYSTEM = [
  "You are the Shape Rotator cohort assistant, embedded in the cohort's desktop app.",
  "Answer the member's question using ONLY the cohort context provided below. Do not invent teams, people, facts, or links.",
  "Be concrete and concise. Refer to teams and people by name. When you don't have enough grounded information, say so plainly.",
  "When asked who to connect with / who to talk to, use each team's `seeking`/`offering` and its `suggested connections`, and explain the specific reason for each suggestion (the need met, the shared problem, the dependency).",
  "When asked what's happening or how something is progressing, ground it in the distilled session insights, recent activity, and each team's progress (stage / bottleneck / next milestone).",
  "The cohort's central lens is its two awards: Best Shape Rotation (a substantiated pivot toward product–market fit — a team that changed shape in response to real feedback and can SHOW it) and Best Team–Product Fit (the right team for this problem, evidenced by how they work, what they ship, and how they take feedback). Treat award help as an evidence dossier, not a pitch deck: identify supported evidence, missing evidence, and unrelated/out-of-scope signal; make the pivot, trigger, shipping, and team-fit evidence legible only when the grounded work supports it.",
].join("\n");

// The action contract — appended only in agent mode (buildChatPrompt({agent:true})).
// The model may PROPOSE structured changes; the app whitelists, sanitizes, and
// shows them for human approval (cohort-chat-actions.mjs parses this). It never
// applies anything itself, so the framing is strictly "propose, never claim done".
export const ACTION_CONTRACT = [
  "",
  "## Proposing changes (optional)",
  "When the member asks you to CHANGE or CONTRIBUTE something — update a profile, suggest a connection, flag a card as wrong, or refresh their profile from their own recent work — you MAY propose it as a structured action. You only ever PROPOSE: a human reviews and approves every action before anything is saved. NEVER say you have already changed, saved, or updated anything.",
  "Emit actions as exactly ONE json block at the very end, after any reply text:",
  "```json",
  '{"actions":[ {"action":"<verb>", ...args} ]}',
  "```",
  "Verbs (use real record_id values from the cohort context above — never invent people):",
  '- propose_profile_update — a PERSON: {"subject_record_id":<person_id>,"fields":{"now"?,"weekly_intention"?,"skills"?[],"skill_areas"?[],"seeking"?[],"offering"?[],"prior_work"?[],"geo"?,"links"?:{"github"?,"repo"?}},"rationale"}',
  '- propose_profile_update — the FOCUSED TEAM/project: {"subject_record_id":<the focused team id>,"fields":{"journey"?:{"stage"?:1-8,"evidence_quality"?:1-5,"market_upside"?:1-5,"primary_bottleneck"?,"company_type"?,"confidence"?:"Low|Medium|High","icp"?,"problem"?,"solution"?,"evidence_notes"?,"next_milestone"?},"traction"?,"prior_shipping"?[],"success_dimensions"?[]},"rationale"}   (journey = the shape-rotation evidence; traction/shipping = team–product-fit. Propose a team update ONLY for the focused project below, only when the evidence is relevant to that project, and only grounded in real work.)',
  '- propose_connection — {"from_record_id","to_record_id","reason"}',
  '- file_contest — {"subject_record_id","contest_kind","note"}  (contest_kind ∈ stale_declaration | off_github_work | wrong_attribution | context_missing)',
  '- request_scan — {"sources":["sessions","github"]}   (reads the member\'s OWN recent GitHub + local AI/Codex work, under a consent gate, to collect relevant evidence for THIS WEEK — use this instead of guessing their work)',
  '- ask — {"question"}   (ONE clarifying question when you need it before proposing)',
  '- note — {"text"}',
  "Rules: propose a field only when the context supports it; be conservative and truthful; prefer one `ask` over guessing. If the member is just chatting or asking a question, DON'T emit actions — just answer normally. Never write promotional award copy; write compact evidence notes.",
  "When refreshing a member's OWN profile or focused project, prefer `request_scan` to ground in their real recent work rather than guessing, and look specifically for award-relevant signal: their shape-rotation (a pivot and the feedback that drove it, with evidence) and their team–product-fit (what they ship, how they work and take feedback). Keep only signal relevant to the active project; call out gaps or missing proof instead of filling them with a pitch. Capture what you find in the fields it supports; raise anything you can't yet ground as a single `ask`.",
].join("\n");

// Assemble the final prompt piped to the local CLI: system framing + grounded
// context + prior turns + the new question. `history` is [{role, content}].
// `agent:true` appends the ACTION_CONTRACT so the model may propose structured
// changes; `toolResults` injects the output of a prior tool step (e.g. a scan
// digest) for the next loop iteration.
export function buildChatPrompt({ surface, history = [], question, maxChars = 22000, agent = false, toolResults = "", focus = null, focusResolution = null, route = null } = {}) {
  const activeRoute = route || classifyChatIntent(question);
  const context = buildCohortContext(surface, { question, maxChars, focus });
  const convo = (Array.isArray(history) ? history : [])
    .filter((m) => m && m.content)
    .slice(-6)
    .map((m) => `${m.role === "assistant" ? "Assistant" : "Member"}: ${m.content}`)
    .join("\n");
  // The FOCUS is chosen by the MEMBER (an explicit pick or the project they named),
  // never by the model — so the model can't widen what it reads or writes. Scopes
  // the answer + any team proposal to the one project in hand.
  const focusBlock = focus && focus.teamId
    ? `\n===== FOCUS — the member's current project =====\nThe member is working on ${focus.teamName} (${focus.teamId}). Scope your answer and ANY proposals to THIS project: propose journey/traction/shipping updates only for ${focus.teamId}, and don't pull in their unrelated work. If they clearly mean a different project, ask before proposing.\n===== END FOCUS =====`
    : "";
  return [
    SYSTEM,
    agent ? ACTION_CONTRACT : "",
    routingBlock({ route: activeRoute, focus, focusResolution }),
    focusBlock,
    "\n===== COHORT CONTEXT =====",
    context,
    "===== END CONTEXT =====",
    toolResults ? `\n===== TOOL RESULTS (read-only signal you requested) =====\n${String(toolResults).slice(0, 12000)}\n===== END TOOL RESULTS =====` : "",
    convo ? `\nConversation so far:\n${convo}` : "",
    `\nMember: ${question}`,
    "Assistant:",
  ].filter(Boolean).join("\n");
}
