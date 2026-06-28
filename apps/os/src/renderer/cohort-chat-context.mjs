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

const STOP = new Set(["the","and","for","with","that","this","from","into","your","you","our","are","who","what","how","should","talk","about","which","whom","can","does","whats","what's","is","of","to","in","on","a","an","i","me","my","we","they"]);

export function qTokens(text) {
  const out = new Set();
  for (const w of String(text || "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3 && w !== "ai" && w !== "tee" && w !== "rl") continue;
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

function searchText(r) {
  return [
    r.name, r.record_id, r.focus, r.domain, r.now, r.role, r.team,
    ...list(r.seeking), ...list(r.offering), ...list(r.skill_areas),
    ...list(r.go_to_them_for), ...list(r.best_contexts), ...list(r.recurring_themes),
    r.journey && r.journey.problem, r.journey && r.journey.solution,
  ].filter(Boolean).join(" ").toLowerCase();
}

function scoreRecord(r, qset) {
  if (!qset.size) return 0;
  const text = searchText(r);
  let s = 0;
  for (const t of qset) if (text.includes(t)) s++;
  return s;
}

// Full team block — the high-value fields + its precomputed connections.
export function teamBlock(t) {
  const lines = [`### ${t.name || t.record_id} (team, id:${t.record_id})`];
  if (t.focus) lines.push(`focus: ${t.focus}`);
  if (t.now) lines.push(`now: ${t.now}`);
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
export function buildCohortContext(surface, { question = "", maxChars = 22000, fullTeams = 8, fullPeople = 6 } = {}) {
  const s = surface || {};
  const teams = Array.isArray(s.teams) ? s.teams : [];
  const people = Array.isArray(s.people) ? s.people : [];
  const qset = qTokens(question);

  const rankedTeams = teams.map((t) => ({ t, score: scoreRecord(t, qset) })).sort((a, b) => b.score - a.score);
  const rankedPeople = people.map((p) => ({ p, score: scoreRecord(p, qset) })).sort((a, b) => b.score - a.score);

  // When the question matches nothing specific, still lead with a useful sample.
  const topTeams = rankedTeams.slice(0, fullTeams).map((x) => x.t);
  const topTeamIds = new Set(topTeams.map((t) => t.record_id));
  const restTeams = teams.filter((t) => !topTeamIds.has(t.record_id));
  const topPeople = rankedPeople.filter((x) => x.score > 0).slice(0, fullPeople).map((x) => x.p);
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
    parts.push(topPeople.map(personLine).join("\n"));
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
  return (c.claim_text || (c.content_json && (c.content_json.summary || c.content_json.claim_text)) || c.title || "").toLowerCase();
}

const SYSTEM = [
  "You are the Shape Rotator cohort assistant, embedded in the cohort's desktop app.",
  "Answer the member's question using ONLY the cohort context provided below. Do not invent teams, people, facts, or links.",
  "Be concrete and concise. Refer to teams and people by name. When you don't have enough grounded information, say so plainly.",
  "When asked who to connect with / who to talk to, use each team's `seeking`/`offering` and its `suggested connections`, and explain the specific reason for each suggestion (the need met, the shared problem, the dependency).",
  "When asked what's happening or how something is progressing, ground it in the distilled session insights, recent activity, and each team's progress (stage / bottleneck / next milestone).",
  "The cohort's central lens is its two awards: Best Shape Rotation (a substantiated pivot toward product–market fit — a team that changed shape in response to real feedback and can SHOW it) and Best Team–Product Fit (the right team for this problem, evidenced by how they work, what they ship, and how they take feedback). When you help a member reflect on or refresh their own work, help make THAT evidence legible — the pivot and what triggered it, what they shipped, the team's fit for the problem — never inflate it past what the grounded work supports.",
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
  '- propose_profile_update — the FOCUSED TEAM/project: {"subject_record_id":<the focused team id>,"fields":{"journey"?:{"stage"?:1-8,"evidence_quality"?:1-5,"market_upside"?:1-5,"primary_bottleneck"?,"company_type"?,"confidence"?:"Low|Medium|High","icp"?,"problem"?,"solution"?,"evidence_notes"?,"next_milestone"?},"traction"?,"prior_shipping"?[],"success_dimensions"?[]},"rationale"}   (journey = the shape-rotation evidence; traction/shipping = team–product-fit. Propose a team update ONLY for the focused project below, and only grounded in real work.)',
  '- propose_connection — {"from_record_id","to_record_id","reason"}',
  '- file_contest — {"subject_record_id","contest_kind","note"}  (contest_kind ∈ stale_declaration | off_github_work | wrong_attribution | context_missing)',
  '- request_scan — {"sources":["sessions","github"]}   (reads the member\'s OWN recent GitHub + local AI/Codex work, under a consent gate, to refresh THIS WEEK\'S profile — use this instead of guessing their work)',
  '- ask — {"question"}   (ONE clarifying question when you need it before proposing)',
  '- note — {"text"}',
  "Rules: propose a field only when the context supports it; be conservative and truthful; prefer one `ask` over guessing. If the member is just chatting or asking a question, DON'T emit actions — just answer normally.",
  "When refreshing a member's OWN profile, prefer `request_scan` to ground in their real recent work rather than guessing, and look specifically for award-relevant signal: their shape-rotation (a pivot and the feedback that drove it, with evidence) and their team–product-fit (what they ship, how they work and take feedback). Capture what you find in the fields it supports; raise anything you can't yet ground as a single `ask`.",
].join("\n");

// Assemble the final prompt piped to the local CLI: system framing + grounded
// context + prior turns + the new question. `history` is [{role, content}].
// `agent:true` appends the ACTION_CONTRACT so the model may propose structured
// changes; `toolResults` injects the output of a prior tool step (e.g. a scan
// digest) for the next loop iteration.
export function buildChatPrompt({ surface, history = [], question, maxChars = 22000, agent = false, toolResults = "", focus = null } = {}) {
  const context = buildCohortContext(surface, { question, maxChars });
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
