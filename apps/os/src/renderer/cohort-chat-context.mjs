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

function items(v) {
  if (Array.isArray(v)) return v.filter((x) => x != null);
  if (v == null || v === "") return [];
  return [v];
}

const SEARCH_FIELDS = Object.freeze([
  "name", "record_id", "focus", "description", "about", "bio", "domain", "now", "role", "team", "geo",
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

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function firstText(...values) {
  for (const value of values) {
    const s = shortText(value, 500);
    if (s) return s;
  }
  return "";
}

function countBy(values = []) {
  const out = {};
  for (const value of values) {
    const key = String(value || "unknown");
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function formatCounts(counts, max = 5) {
  return Object.entries(counts || {})
    .filter(([, count]) => count)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([key, count]) => `${key}:${count}`)
    .join(", ");
}

function evidenceDate(c) {
  const cj = object(c && c.content_json);
  return String(cj.week_start || c?.week_start || cj.date || c?.created_at || "").slice(0, 10);
}

function evidenceConfidence(c) {
  if (!c || c.confidence == null || c.confidence === "") return "";
  const n = Number(c.confidence);
  if (Number.isFinite(n)) return n <= 1 ? n.toFixed(2) : String(Math.round(n));
  return String(c.confidence);
}

function evidenceStrength(c) {
  const level = String(c?.evidence_level || "").toLowerCase();
  const confidence = Number(c?.confidence);
  const levelScore = level === "reviewed" || level === "observed" || level === "grounded" ? 3
    : level === "inferred" || level === "aggregate" ? 2
      : level === "weak" ? 0
        : 1;
  return levelScore + (Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0);
}

function evidenceRank(c, qset) {
  const text = evidenceText(c);
  const queryScore = qset.size ? [...qset].filter((t) => text.includes(t)).length * 10 : 0;
  const date = evidenceDate(c).replaceAll("-", "");
  const recency = /^\d{8}$/.test(date) ? Number(date) / 100000000 : 0;
  return queryScore + evidenceStrength(c) + recency;
}

function nestedClaimTexts(cj) {
  const candidates = [
    ...items(cj.claims),
    ...items(cj.top_claims),
    ...items(cj.questions),
    ...items(cj.qa),
  ];
  return candidates
    .map((item) => {
      if (typeof item === "string" || typeof item === "number") return String(item);
      if (item && typeof item === "object") {
        return item.text || item.claim_text || item.answer || item.question || item.summary || "";
      }
      return "";
    })
    .map((s) => shortText(s, 160))
    .filter(Boolean);
}

// Full team block — the high-value fields + its precomputed connections.
export function teamBlock(t) {
  const lines = [`### ${t.name || t.record_id} (team, id:${t.record_id})`];
  if (t.focus) lines.push(`focus: ${t.focus}`);
  if (t.now) lines.push(`now: ${t.now}`);
  if (t.domain || t.geo || t.membership) {
    lines.push(`profile: ${[
      t.domain && `domain ${t.domain}`,
      t.geo && `geo ${t.geo}`,
      t.membership && `membership ${t.membership}`,
    ].filter(Boolean).join("; ")}`);
  }
  const description = firstText(t.about, t.description, t.bio, t.bio_md);
  if (description) lines.push(`description: ${shortText(description)}`);
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
    firstText(p.bio, p.description, p.bio_md) ? `bio: ${shortText(firstText(p.bio, p.description, p.bio_md), 180)}` : "",
    list(p.prior_work).slice(0, 2).length ? `prior: ${list(p.prior_work).slice(0, 2).join(", ")}` : "",
    list(p.seeking).slice(0, 2).length ? `seeking: ${list(p.seeking).slice(0, 2).join("; ")}` : "",
    list(p.offering).slice(0, 2).length ? `offering: ${list(p.offering).slice(0, 2).join("; ")}` : "",
    list(p.best_contexts).slice(0, 2).length ? `best contexts: ${list(p.best_contexts).slice(0, 2).join("; ")}` : "",
    p.working_style ? `working style: ${shortText(p.working_style, 160)}` : "",
    linkBits.length ? linkBits.join("; ") : "",
  ].filter(Boolean);
  return bits.length ? `${base} | ${bits.join(" | ")}` : base;
}

function teamLine(t) {
  const seeking = list(t.seeking).slice(0, 2).join("; ");
  const j = object(t.journey);
  const quality = j.evidence_quality ? `evidence ${j.evidence_quality}/5` : "";
  const bottleneck = j.primary_bottleneck ? `bottleneck: ${j.primary_bottleneck}` : "";
  return `- ${t.name || t.record_id} (id:${t.record_id})${t.focus ? ` — ${t.focus}` : ""}${t.now ? ` · now: ${shortText(t.now, 100)}` : ""}${[quality, bottleneck].filter(Boolean).length ? ` · ${[quality, bottleneck].filter(Boolean).join("; ")}` : ""}${seeking ? ` · seeking: ${seeking}` : ""}`;
}

function evidenceCardLine(c) {
  const cj = object(c && c.content_json);
  const text = firstText(c?.claim_text, cj.claim_text, c?.summary, cj.summary, c?.title);
  if (!text) return null;
  const wk = evidenceDate(c);
  const teams = list(cj.teams).slice(0, 4).join(", ");
  const people = list(cj.people).slice(0, 3).join(", ");
  const themes = list(cj.themes || cj.topic_tags || cj.topics).slice(0, 3).join(", ");
  const claims = nestedClaimTexts(cj).slice(0, 2).join(" / ");
  const meta = [
    c?.surface_tier && `tier ${c.surface_tier}`,
    c?.claim_type && `type ${c.claim_type}`,
    c?.evidence_level && `level ${c.evidence_level}`,
    evidenceConfidence(c) && `confidence ${evidenceConfidence(c)}`,
    c?.attribution_scope && `scope ${c.attribution_scope}`,
  ].filter(Boolean).join("; ");
  const bits = [
    `- ${wk ? `[${wk}] ` : ""}${shortText(text, 260)}`,
    teams && `teams: ${teams}`,
    people && `people: ${people}`,
    themes && `themes: ${themes}`,
    claims && `claims: ${claims}`,
    meta && `meta: ${meta}`,
  ].filter(Boolean);
  return bits.join(" | ");
}

const PIVOT_CUE_RE = /\b(pivot|pivoted|reposition(?:ed|ing)?|reframe(?:d|s|ing)?|shift(?:ed|ing)?|switch(?:ed|ing)?|changed|narrow(?:ed|ing)?|broaden(?:ed|ing)?|wedge|contested|moved from|from\s+.{3,80}\s+to\s+.{3,80}|testing|experiment(?:ing)?|invalidated?)\b/i;
const STRONG_OBSERVED_TYPES = new Set(["github progress", "transcript", "ask", "evidence"]);

function timelineDate(item) {
  return String(item?.date || item?.week_start || "").slice(0, 10);
}

function isoWeekStart(dateText) {
  const s = String(dateText || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - day + 1);
  return d.toISOString().slice(0, 10);
}

function timelineFor(map, id) {
  const value = object(map)[id];
  return Array.isArray(value) ? value : [];
}

function timelineItemText(item, max = 160) {
  const type = String(item?.type || "item").trim();
  const title = shortText(item?.title || "", 72);
  const detail = shortText(item?.detail || item?.summary || "", max);
  return shortText([type && `${type}: ${title || "activity"}`, detail].filter(Boolean).join(" - "), max);
}

function isObservedTimelineItem(item) {
  const type = String(item?.type || "").toLowerCase();
  if (!timelineDate(item)) return false;
  if (type === "profile" || type === "team" || type === "availability" || type === "onboarding") return false;
  return true;
}

function uniqueBits(values, limit = 4) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const bit = shortText(value, 180);
    const key = bit.toLowerCase();
    if (!bit || seen.has(key)) continue;
    seen.add(key);
    out.push(bit);
    if (out.length >= limit) break;
  }
  return out;
}

function recordDeclarationBits(record, kind) {
  const r = object(record);
  if (kind === "team") {
    const j = object(r.journey);
    return uniqueBits([
      r.now && `now: ${r.now}`,
      ...list(r.weekly_goals).map((goal) => `weekly goal: ${goal}`),
      j.primary_bottleneck && `bottleneck: ${j.primary_bottleneck}`,
      j.next_milestone && `next: ${j.next_milestone}`,
      r.traction && `traction: ${r.traction}`,
    ], 5);
  }
  return uniqueBits([
    r.now && `now: ${r.now}`,
    r.weekly_intention && `weekly intention: ${r.weekly_intention}`,
    ...list(r.seeking).slice(0, 2).map((value) => `seeking: ${value}`),
    ...list(r.offering).slice(0, 2).map((value) => `offering: ${value}`),
  ], 5);
}

function timelineDeclarationBits(timeline) {
  return uniqueBits(timeline
    .filter((item) => {
      const type = String(item?.type || "").toLowerCase();
      const title = String(item?.title || "").toLowerCase();
      const source = String(item?.source || "").toLowerCase();
      if (type === "profile") return true;
      if (type === "team" && /current work|weekly|seeking|offering/.test(title)) return true;
      return source.includes("record") && /current work|weekly|goal|milestone|seeking|offering|traction|shipping/.test(title);
    })
    .map((item) => `${item.title || item.type}: ${item.detail || ""}`), 5);
}

function weeklyObservedRows(timeline, limitWeeks = 3) {
  const byWeek = new Map();
  for (const item of timeline.filter(isObservedTimelineItem)) {
    const week = isoWeekStart(timelineDate(item));
    if (!week) continue;
    if (!byWeek.has(week)) byWeek.set(week, []);
    byWeek.get(week).push(item);
  }
  return [...byWeek.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, limitWeeks)
    .map(([week, entries]) => {
      const summaries = entries
        .sort((a, b) => timelineDate(b).localeCompare(timelineDate(a)))
        .slice(0, 2)
        .map((item) => timelineItemText(item, 145));
      return `${week}: ${summaries.join(" / ")}`;
    });
}

function pivotCues(declarations, timeline) {
  return uniqueBits([
    ...declarations,
    ...timeline.map((item) => timelineItemText(item, 170)),
  ].filter((text) => PIVOT_CUE_RE.test(String(text || ""))), 2);
}

function trajectoryGaps(record, kind, declarations, observedRows, timeline) {
  const gaps = [];
  const declarationText = declarations.join(" ").toLowerCase();
  if (kind === "team" && !list(record?.weekly_goals).length && !/\bweekly goals?\b/.test(declarationText)) gaps.push("weekly_goals missing");
  if (kind === "person" && !shortText(record?.weekly_intention || "") && !/\bweekly intention\b/.test(declarationText)) gaps.push("weekly_intention missing");
  if (declarations.length && !observedRows.length) gaps.push("no dated follow-up activity in bundled timeline");
  if (!declarations.length && observedRows.length) gaps.push("activity exists without a clear current declaration");
  const strongObserved = timeline.some((item) => isObservedTimelineItem(item) && STRONG_OBSERVED_TYPES.has(String(item?.type || "").toLowerCase()));
  if (observedRows.length && !strongObserved) gaps.push("only weak event/calendar mentions; no transcript/GitHub/ask evidence");
  return gaps.slice(0, 3);
}

function trajectoryRecordLine(record, timeline, kind) {
  const id = String(record?.record_id || "");
  const name = record?.name || id;
  const declarations = uniqueBits([
    ...recordDeclarationBits(record, kind),
    ...timelineDeclarationBits(timeline),
  ], 5);
  const observedRows = weeklyObservedRows(timeline);
  const cues = pivotCues(declarations, timeline);
  const gaps = trajectoryGaps(record, kind, declarations, observedRows, timeline);
  const bits = [
    `declared: ${declarations.join("; ") || "none loaded"}`,
    `observed by week: ${observedRows.join(" | ") || "none dated"}`,
    cues.length ? `pivot cues: ${cues.join(" / ")}` : "",
    gaps.length ? `gaps: ${gaps.join("; ")}` : "",
  ].filter(Boolean);
  return `- ${name} (${kind}${id ? `, id:${id}` : ""}): ${bits.join(" | ")}`;
}

function weeklyTrajectoryBlock(s, { topTeamIds = new Set(), topPeopleIds = new Set(), focusId = "" } = {}) {
  const teamTimeline = object(s.team_timeline);
  const personTimeline = object(s.person_timeline);
  if (!Object.keys(teamTimeline).length && !Object.keys(personTimeline).length) return "";

  const teams = Array.isArray(s.teams) ? s.teams : [];
  const people = Array.isArray(s.people) ? s.people : [];
  const teamById = new Map(teams.map((team) => [String(team.record_id || ""), team]));
  const personById = new Map(people.map((person) => [String(person.record_id || ""), person]));
  const teamIds = uniqueBits([focusId, ...topTeamIds].filter(Boolean).map(String), 6);
  const personIds = uniqueBits([...topPeopleIds].filter(Boolean).map(String), 5);

  const lines = [
    "\n## Weekly say/did trajectory",
    'Use as a gap/pivot checklist: "declared" comes from current profile/team records; "observed" comes from dated timeline activity already in the cohort surface. Never infer a pivot from silence; name missing follow-up as a gap.',
  ];
  for (const id of teamIds) {
    const team = teamById.get(id);
    if (team) lines.push(trajectoryRecordLine(team, timelineFor(teamTimeline, id), "team"));
  }
  for (const id of personIds) {
    const person = personById.get(id);
    if (person) lines.push(trajectoryRecordLine(person, timelineFor(personTimeline, id), "person"));
  }
  return lines.length > 2 ? lines.join("\n") : "";
}

function projectProgressLine(row) {
  const coverage = object(row.coverage);
  const name = row.project_name || row.project_id;
  const bits = [
    `priority ${row.intervention_priority || "unknown"}`,
    `trajectory ${row.trajectory || "unknown"}`,
    `latest ${row.latest_week_start || "none"}`,
    `quality ${row.current_evidence_quality || "none"}`,
    `declared ${row.declared_bottleneck || row.declared_bottleneck_category || "not declared"}`,
    `observed ${row.observed_bottleneck || "no evidence"}`,
    `specific signals ${coverage.project_specific_signal_count ?? 0}/${coverage.signal_count ?? 0}`,
  ];
  if (row.operator_question) bits.push(`operator question: ${shortText(row.operator_question, 220)}`);
  if (row.recommended_next_check) bits.push(`next check: ${shortText(row.recommended_next_check, 220)}`);
  return `- ${name}: ${bits.join("; ")}`;
}

function projectSnapshotLine(snapshot) {
  const observed = object(snapshot.observed_state);
  const declared = object(snapshot.declared_state);
  const drift = object(snapshot.drift);
  const evidence = object(snapshot.evidence);
  const claim = Array.isArray(observed.top_observed_claims) ? observed.top_observed_claims[0] : null;
  const name = snapshot.project_name || snapshot.project_id;
  const bits = [
    `week ${snapshot.week_start || "undated"}`,
    `quality ${observed.evidence_quality || "unknown"}`,
    `declared ${declared.bottleneck || declared.bottleneck_category || "not declared"}`,
    `observed ${observed.inferred_bottleneck || "insufficient evidence"}`,
    `drift ${drift.status || "unknown"}`,
    `specific signals ${evidence.project_specific_signal_count ?? 0}/${evidence.signal_count ?? 0}`,
  ];
  if (observed.evidence_summary) bits.push(shortText(observed.evidence_summary, 180));
  if (claim) bits.push(`top claim: ${shortText(claim.text || claim.claim_text || "", 180)}`);
  if (drift.reason) bits.push(`reason: ${shortText(drift.reason, 220)}`);
  return `- ${name}: ${bits.join("; ")}`;
}

function relevantProjectRows(rows, teamIds, limit = 6) {
  const ids = new Set([...teamIds].map(String).filter(Boolean));
  const list = Array.isArray(rows) ? rows : [];
  const picked = ids.size ? list.filter((row) => ids.has(String(row.project_id || ""))) : list;
  return picked.slice(0, limit);
}

function dataQualityBlock(s, { focusId = "", topTeamIds = new Set() } = {}) {
  const cards = Array.isArray(s.transcript_evidence_cards) ? s.transcript_evidence_cards : [];
  const intel = object(s.cohort_intel);
  const transcriptEvidence = object(s.transcript_evidence);
  const contract = object(intel.data_contract);
  const quality = object(contract.quality);
  const snapshotQuality = object(intel.project_week_snapshot_quality);
  const rollupQuality = object(intel.project_progress_rollup_quality);
  const lines = ["## Data quality and coverage"];
  lines.push(`surface freshness: ${s._generated_at || s._storedAt || "unknown"}${s._source ? ` (${s._source})` : ""}`);
  lines.push(`loaded evidence cards: ${cards.length}${cards.length ? `; tiers ${formatCounts(countBy(cards.map((c) => c.surface_tier || c.source || "unknown"))) || "unknown"}; levels ${formatCounts(countBy(cards.map((c) => c.evidence_level || "unknown"))) || "unknown"}` : ""}`);
  if (transcriptEvidence.source_artifact_count != null) {
    lines.push(`transcript evidence export: ${transcriptEvidence.source_artifact_count || 0} source artifact(s); policy: ${transcriptEvidence.public_web_policy || transcriptEvidence.generated_from || "cohort/private boundary applies"}`);
  }
  if (Object.keys(quality).length) {
    lines.push(`signal inventory: ${quality.total_signal_count || 0} total; claims ${quality.claim_signal_count || 0}; q&a ${quality.qa_signal_count || 0}; team signals ${quality.team_signal_count || 0}; person signals ${quality.person_signal_count || 0}; source transcripts ${quality.source_transcript_count || 0}`);
    const gaps = [
      quality.missing_team_signal_count ? `${quality.missing_team_signal_count} team(s) without transcript-derived signals` : "",
      quality.missing_person_signal_count ? `${quality.missing_person_signal_count} person record(s) without transcript-derived signals` : "",
      quality.sources_without_claims ? `${quality.sources_without_claims} source(s) without claims` : "",
      quality.sources_without_questions ? `${quality.sources_without_questions} source(s) without q&a` : "",
    ].filter(Boolean);
    if (gaps.length) lines.push(`coverage gaps: ${gaps.join("; ")}`);
  }
  lines.push(`project-week snapshots: ${snapshotQuality.snapshot_count || 0} snapshot(s), ${snapshotQuality.project_count || 0} project(s), ${snapshotQuality.weak_snapshot_count || 0} weak, ${snapshotQuality.insufficient_snapshot_count || 0} insufficient`);
  lines.push(`project trajectory rollups: ${rollupQuality.rollup_count || 0} project(s), ${rollupQuality.coverage_gap_count || 0} coverage gap(s), ${rollupQuality.no_evidence_count || 0} with no evidence, ${rollupQuality.undated_evidence_project_count || 0} undated`);
  if (!cards.length && !(quality.total_signal_count || snapshotQuality.snapshot_count || rollupQuality.rollup_count)) {
    lines.push("guidance: no live transcript-derived signal is loaded in this surface. Answer from declared profiles, links, connections, recent activity, and releases; do not imply this week is transcript-verified.");
  } else {
    lines.push("guidance: distinguish declared profile fields from transcript-derived or inferred evidence. If coverage is weak, name the missing source instead of smoothing it over.");
  }

  const relevantIds = new Set(topTeamIds);
  if (focusId) relevantIds.add(focusId);
  const rollups = relevantProjectRows(intel.project_progress_rollups, relevantIds, 5);
  if (rollups.length) {
    lines.push("\n## Project trajectory rows");
    lines.push(rollups.map(projectProgressLine).join("\n"));
  } else if (focusId) {
    lines.push(`focused project trajectory: no project-week rollup is loaded for ${focusId}; ask for a concrete project-level update before changing PMF/evidence descriptions.`);
  }
  const snapshots = relevantProjectRows(intel.project_week_snapshots, relevantIds, 4);
  if (snapshots.length) {
    lines.push("\n## Project-week evidence snapshots");
    lines.push(snapshots.map(projectSnapshotLine).join("\n"));
  }
  return lines.join("\n");
}

// Build the grounded context block, retrieval-ranked against the question and
// bounded to ~maxChars. Returns a string.
export function buildCohortContext(surface, { question = "", maxChars = 22000, fullTeams = 8, fullPeople = 6, focus = null } = {}) {
  const s = surface || {};
  const teams = Array.isArray(s.teams) ? s.teams : [];
  const people = Array.isArray(s.people) ? s.people : [];
  const qset = qTokens(question);
  const wantsPeopleTrajectory = /\b(people|person|persons|member|members|founder|founders|intention|intentions)\b/i.test(String(question || ""));
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
    ...(wantsPeopleTrajectory ? rankedPeople.slice(0, fullPeople).map((x) => x.p) : []),
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
  parts.push(dataQualityBlock(s, { focusId, topTeamIds }));

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

  const trajectory = weeklyTrajectoryBlock(s, { focusId, topTeamIds, topPeopleIds });
  if (trajectory) parts.push(trajectory);

  // Recent distilled session insights ("what's happening" substrate).
  const cards = Array.isArray(s.transcript_evidence_cards) ? s.transcript_evidence_cards : [];
  if (cards.length) {
    const ranked = cards
      .map((c) => ({ c, score: evidenceRank(c, qset) }))
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
  if (/\b(what'?s happening|what is happening|progress|status|what did|ship|shipped|shipping|new|recent|week by week|weekly|pivot|pivots|declared|declaration|declarations|gaps?)\b/.test(q)) return "status_lookup";
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
  "Use the data-quality block as an explicit reliability signal: distinguish declared profile fields, live transcript-derived evidence, inferred attribution, GitHub/release activity, and coverage gaps.",
  "When describing a project, prefer this shape: what it is, who it serves, what it is doing now, strongest evidence, current bottleneck/gap, and next useful check. Skip generic praise unless the context names the evidence.",
  "When asked who to connect with / who to talk to, use each team's `seeking`/`offering` and its `suggested connections`, and explain the specific reason for each suggestion (the need met, the shared problem, the dependency).",
  "When asked what's happening or how something is progressing, ground it in the distilled session insights, recent activity, and each team's progress (stage / bottleneck / next milestone).",
  "When the weekly say/did trajectory block appears, use it to compare what people or teams declared against dated observed activity. It is a gap checklist: surface missing weekly intentions/goals, thin follow-up evidence, and possible pivot cues; do not claim a pivot unless the context names the change and some supporting activity.",
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
  '- propose_profile_update — a PERSON: {"subject_record_id":<person_id>,"fields":{"comm_style"?,"contribute_interests"?[],"now"?,"weekly_intention"?,"availability_pref"?,"skills"?[],"skill_areas"?[],"seeking"?[],"offering"?[],"go_to_them_for"?[],"recurring_themes"?[],"working_style"?,"best_contexts"?[],"prior_work"?[],"geo"?,"links"?:{"github"?,"repo"?}},"rationale"}',
  '- submit_private_contact — PRIVATE contact capture: {"subject_record_id":<person_id>,"email"?:"name@example.com","telegram"?:"@handle","display_name"?,"note"?}   Use ONLY when the member explicitly provides email and/or Telegram details in this conversation. NEVER put email or Telegram in propose_profile_update; contact details are private operational data and do not appear in public cohort surfaces. If contact details are missing, emit one `ask` for email/Telegram.',
  '- propose_profile_update — the FOCUSED TEAM/project: {"subject_record_id":<the focused team id>,"fields":{"journey"?:{"stage"?:1-8,"evidence_quality"?:1-5,"market_upside"?:1-5,"primary_bottleneck"?,"company_type"?,"confidence"?:"Low|Medium|High","icp"?,"problem"?,"solution"?,"evidence_notes"?,"next_milestone"?},"traction"?,"prior_shipping"?[],"success_dimensions"?[]},"rationale"}   (journey = the shape-rotation evidence; traction/shipping = team–product-fit. Propose a team update ONLY for the focused project below, only when the evidence is relevant to that project, and only grounded in real work.)',
  '- propose_connection — {"from_record_id","to_record_id","reason"}',
  '- file_contest — {"subject_record_id","contest_kind","note"}  (contest_kind ∈ stale_declaration | off_github_work | wrong_attribution | context_missing)',
  '- request_scan — {"sources":["sessions","github"]}   (reads the member\'s OWN recent GitHub + local AI/Codex work, under a consent gate, to collect relevant evidence for THIS WEEK — use this instead of guessing their work)',
  '- ask — {"question"}   (ONE clarifying question when you need it before proposing)',
  '- note — {"text"}',
  "Rules: propose a field only when the context supports it; be conservative and truthful; prefer one `ask` over guessing. If the member is just chatting or asking a question, DON'T emit actions — just answer normally. Never write promotional award copy; write compact evidence notes.",
  "When updating member information, handle contact gaps explicitly: propose `links.github` through `propose_profile_update`; capture email/Telegram only with `submit_private_contact`; ask for those details if the member has not supplied them. Do NOT use `request_scan`, local sessions, Telegram chats, DMs, or message history to discover private contact details.",
  "For low-coverage data, prefer a `note` or `ask` that names the missing evidence over a confident profile update. A useful description can include gaps; it should not hide them.",
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
