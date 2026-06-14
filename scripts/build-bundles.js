#!/usr/bin/env node
/**
 * build-bundles.js — markdown source of truth → cohort surface JSON.
 *
 * Phase 1 implementation per docs/SHAPE-ROTATOR-OS-SPEC.md §4.4 §6:
 * reads cohort-data/{teams,people,clusters,dependencies}/*.md, applies the surface-
 * fields whitelist from cohort-data/schema.yml, writes
 * apps/os/src/cohort-surface.json and apps/web/cohort-surface.json. The depth side (encrypted
 * raw markdown bytes per §3.1) lands once swf-node bundle handling is
 * in place.
 *
 * Usage:
 *   node scripts/build-bundles.js                  one-shot build
 *   node scripts/build-bundles.js --check          fail if surface is stale
 *
 * No external deps beyond js-yaml. No watch mode in this iteration —
 * re-run after editing markdown.
 */

const fs   = require("node:fs");
const path = require("node:path");
const vm   = require("node:vm");
const yaml = require("js-yaml");
const {
  publicArticleBlockedNames,
  publicArticleCandidateFromReadout,
} = require("./lib/public-article-policy.cjs");

const REPO_ROOT  = path.resolve(__dirname, "..");
const COHORT_DIR = path.join(REPO_ROOT, "cohort-data");
const OS_SURFACE_PATH = path.join(REPO_ROOT, "apps", "os", "src", "cohort-surface.json");
const WEB_SURFACE_PATH = path.join(REPO_ROOT, "apps", "web", "cohort-surface.json");
const OUT_PATHS = [
  OS_SURFACE_PATH,
  WEB_SURFACE_PATH,
];
const PRIMARY_OUT_PATH = OUT_PATHS[0];

function readSchema() {
  const p = path.join(COHORT_DIR, "schema.yml");
  if (!fs.existsSync(p)) throw new Error(`schema.yml not found at ${p}`);
  return yaml.load(fs.readFileSync(p, "utf8"));
}

// Parse a single markdown file with YAML frontmatter. Returns
// { frontmatter, body } — frontmatter is null if the file has no
// frontmatter block.
function parseMarkdown(file) {
  const raw = fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m) return { frontmatter: null, body: raw };
  let frontmatter;
  try { frontmatter = yaml.load(m[1]); }
  catch (e) { throw new Error(`bad YAML in ${file}: ${e.message}`); }
  return { frontmatter, body: m[2] };
}

// Pick whitelisted keys from an object (no nested support — we use
// the whole `links` object as one entry, which is what the surface
// schema expects).
function pickSurface(obj, whitelist) {
  const out = {};
  for (const k of whitelist) {
    if (Object.prototype.hasOwnProperty.call(obj || {}, k)) {
      out[k] = obj[k];
    }
  }
  return out;
}

function extractPublicPersonBio(body) {
  const raw = String(body || "").trim();
  if (!raw) return "";
  const lines = raw.split("\n");
  const start = lines.findIndex(line => /^##\s+(about|bio)\s*$/i.test(line.trim()));
  if (start < 0) return raw;
  const end = lines.findIndex((line, index) => index > start && /^##\s+/.test(line.trim()));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
}

function loadDir(dir, recordType, surfaceFields) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".md"));
  const records = [];
  for (const f of files) {
    const fp = path.join(dir, f);
    const { frontmatter, body } = parseMarkdown(fp);
    if (!frontmatter) {
      console.warn(`[build-bundles] skipping ${fp} — no frontmatter`);
      continue;
    }
    if (frontmatter.record_type !== recordType) {
      console.warn(`[build-bundles] skipping ${fp} — record_type mismatch (got ${frontmatter.record_type}, expected ${recordType})`);
      continue;
    }
    if (!frontmatter.record_id) {
      console.warn(`[build-bundles] skipping ${fp} — no record_id`);
      continue;
    }
    const surface = pickSurface(frontmatter, surfaceFields);
    if (recordType === "person") {
      const bio = extractPublicPersonBio(body);
      if (bio) surface.bio_md = bio;
    }
    records.push(surface);
  }
  // Stable order by record_id.
  records.sort((a, b) => String(a.record_id).localeCompare(String(b.record_id)));
  return records;
}

// Program-page loader. Unlike entity records, program pages carry their full
// markdown body in the bundle so the app can render them offline-first. Body
// is the raw markdown AFTER the frontmatter block — the renderer does the
// light markdown→HTML pass.
function loadProgramDir(dir, surfaceFields) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".md"));
  const records = [];
  for (const f of files) {
    const fp = path.join(dir, f);
    const { frontmatter, body } = parseMarkdown(fp);
    if (!frontmatter) {
      console.warn(`[build-bundles] skipping ${fp} — no frontmatter`);
      continue;
    }
    if (frontmatter.record_type !== "program_page") {
      console.warn(`[build-bundles] skipping ${fp} — record_type mismatch (got ${frontmatter.record_type}, expected program_page)`);
      continue;
    }
    if (!frontmatter.record_id) {
      console.warn(`[build-bundles] skipping ${fp} — no record_id`);
      continue;
    }
    const surface = pickSurface(frontmatter, surfaceFields);
    surface.body_md = (body || "").trim();
    records.push(surface);
  }
  // Stable order by frontmatter `order` (numeric, ascending), then record_id.
  records.sort((a, b) => {
    const ao = Number.isFinite(a.order) ? a.order : 1e9;
    const bo = Number.isFinite(b.order) ? b.order : 1e9;
    if (ao !== bo) return ao - bo;
    return String(a.record_id).localeCompare(String(b.record_id));
  });
  return records;
}

function githubBlobUrl(relPath) {
  return `https://github.com/dmarzzz/shape-rotator-os/blob/main/${String(relPath || "").replace(/\\/g, "/")}`;
}

function recordSourceUrl(recordType, recordId) {
  const folder = recordType === "person" ? "people"
    : recordType === "team" ? "teams"
    : recordType === "ask" ? "asks"
    : recordType === "event" ? "events"
    : recordType === "cluster" ? "clusters"
    : recordType === "dependency" ? "dependencies"
    : `${recordType || "record"}s`;
  return githubBlobUrl(`cohort-data/${folder}/${recordId}.md`);
}

function firstLine(value) {
  return String(value || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0] || "";
}

function compactText(value, max = 180) {
  const s = String(value || "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1).trim()}…` : s;
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter(v => v != null && String(v).trim() !== "");
  return value == null || String(value).trim() === "" ? [] : [value];
}

function labelize(value) {
  return String(value || "not declared").replace(/[-_]+/g, " ");
}

const RECORD_KEYWORD_STOPWORDS = new Set([
  "and", "are", "for", "from", "into", "that", "the", "this", "with",
  "team", "teams", "user", "users", "app", "apps", "build", "building",
  "product", "project", "private", "public", "agent", "agents", "data",
]);

function keywordTokens(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(token => token.length >= 4 && !RECORD_KEYWORD_STOPWORDS.has(token));
}

function recordKeywords(record = {}) {
  const values = [
    record.record_id,
    String(record.record_id || "").replace(/[-_]+/g, " "),
    record.name,
    record.focus,
    record.now,
    record.domain,
    record.working_style,
    asArray(record.skill_areas).join(" "),
    asArray(record.success_dimensions).join(" "),
    asArray(record.go_to_them_for).join(" "),
    asArray(record.recurring_themes).join(" "),
    asArray(record.prior_work).join(" "),
  ];
  return Array.from(new Set(values.flatMap(keywordTokens))).slice(0, 40);
}

function textIncludesAny(text, aliases) {
  const hay = String(text || "").toLowerCase();
  return aliases.some(alias => alias && hay.includes(String(alias).toLowerCase()));
}

function isoDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const s = String(value || "");
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : "";
}

const MONTH_NUM = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

function monthDayToIso(month, day, year = 2026) {
  const n = MONTH_NUM[String(month || "").toLowerCase()];
  const d = Number(day);
  if (!n || !Number.isFinite(d)) return "";
  return `${year}-${String(n).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseMonthDay(text) {
  const m = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})\b/i.exec(String(text || ""));
  return m ? monthDayToIso(m[1], m[2]) : "";
}

function addDays(iso, days) {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return "";
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function loadCalendarTranscriptMatches() {
  const p = path.join(REPO_ROOT, "apps", "os", "src", "content", "context", "calendar-transcript-matches.js");
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, "utf8")
    .replace(/export\s+const\s+CALENDAR_TRANSCRIPT_MATCHES\s*=/, "module.exports =");
  const sandbox = { module: { exports: [] }, exports: {} };
  try {
    vm.runInNewContext(raw, sandbox, { filename: p, timeout: 1000 });
    return Array.isArray(sandbox.module.exports) ? sandbox.module.exports : [];
  } catch (e) {
    console.warn(`[build-bundles] transcript match load failed: ${e.message}`);
    return [];
  }
}

// Evaluate one calendar-matched transcript source against a record's
// aliases. Bundled sources scan the transcript text on disk; held-private
// sources (raw transcripts removed from the public repo per the content
// policy) use the mention snapshot baked into calendar-transcript-matches.js
// when the file left the repo, keyed by record_id.
function transcriptSourceHit(match, source, aliases, recordId) {
  const relPath = source.path;
  const heldPrivately = !relPath && source.held === "private-vault";
  let text = "";
  if (relPath) {
    const fp = path.join(REPO_ROOT, relPath);
    if (!fs.existsSync(fp)) return null;
    text = fs.readFileSync(fp, "utf8");
  } else if (!heldPrivately) {
    return null;
  }
  const sourceText = `${source.label || ""} ${relPath || ""} ${match.section || ""}`;
  const textDirect = heldPrivately
    ? (source.mentions_direct || []).includes(recordId)
    : textIncludesAny(text, aliases.direct);
  const directHit = textDirect || textIncludesAny(sourceText, aliases.direct);
  const textAny = heldPrivately
    ? (source.mentions_any || []).includes(recordId)
    : textIncludesAny(text, aliases.any);
  const anyHit = directHit || textAny || textIncludesAny(sourceText, aliases.any);
  if (!anyHit) return null;
  const baseLabel = source.label || (relPath ? path.basename(relPath) : "transcript");
  return {
    directHit,
    sourceNamed: textIncludesAny(sourceText, aliases.direct),
    heldPrivately,
    detail: compactText(`${match.section || "session"} · ${baseLabel}${heldPrivately ? " · held privately" : ""}`, 150),
    href: relPath ? githubBlobUrl(relPath) : "",
    dedupKey: relPath ? githubBlobUrl(relPath) : `vault:${source.vault_id || baseLabel}`,
    vaultId: heldPrivately ? String(source.vault_id || "") : "",
  };
}

function personAliases(person, team) {
  const aliases = new Set();
  const add = (v) => {
    const s = String(v || "").trim();
    if (s.length >= 3) aliases.add(s.toLowerCase());
  };
  add(person.record_id);
  add(String(person.record_id || "").replace(/[-_]+/g, " "));
  add(person.name);
  for (const part of String(person.name || "").split(/\s+/)) {
    if (part.length >= 4) add(part);
  }
  for (const v of Object.values(person.links || {})) add(v);
  const direct = Array.from(aliases);
  if (team) {
    add(team.record_id);
    add(team.name);
  }
  return { direct, any: Array.from(aliases) };
}

function teamAliases(team, members = []) {
  const directAliases = new Set();
  const memberAliases = new Set();
  const add = (set, v) => {
    const s = String(v || "").trim();
    if (s.length >= 3) set.add(s.toLowerCase());
  };
  add(directAliases, team.record_id);
  add(directAliases, String(team.record_id || "").replace(/[-_]+/g, " "));
  add(directAliases, team.name);
  for (const v of Object.values(team.links || {})) add(directAliases, v);
  for (const member of members) {
    add(memberAliases, member.record_id);
    add(memberAliases, String(member.record_id || "").replace(/[-_]+/g, " "));
    add(memberAliases, member.name);
  }
  return {
    direct: Array.from(directAliases),
    any: Array.from(new Set([...directAliases, ...memberAliases])),
  };
}

function calendarBlocks(calendar) {
  const blocks = [];
  const tabs = calendar?.tabs && typeof calendar.tabs === "object" ? calendar.tabs : {};
  for (const [tab, rows] of Object.entries(tabs)) {
    if (!Array.isArray(rows) || !rows.length) continue;
    const header = rows[0] || [];
    for (const row of rows.slice(1)) {
      if (!Array.isArray(row)) continue;
      const rowStart = parseMonthDay(row[1] || "");
      for (let i = 0; i < row.length; i++) {
        const text = String(row[i] || "").trim();
        if (!text) continue;
        const headerLabel = String(header[i] || "");
        const dayOffset = i >= 2 && i <= 8 ? i - 2 : 0;
        const inferredDate = parseMonthDay(text) || (rowStart ? addDays(rowStart, dayOffset) : "");
        blocks.push({
          date: inferredDate,
          title: firstLine(text) || headerLabel || tab,
          detail: compactText(text),
          tab,
          column: headerLabel,
        });
      }
    }
  }
  return blocks;
}

function sortTimeline(items) {
  return items
    .filter(item => item && (item.title || item.detail))
    .sort((a, b) => {
      const ad = a.date || "9999-99-99";
      const bd = b.date || "9999-99-99";
      if (ad !== bd) return ad.localeCompare(bd);
      return String(a.type || "").localeCompare(String(b.type || ""));
    });
}

function latestWeek(weeks) {
  const values = asArray(weeks).map(isoDate).filter(Boolean).sort();
  return values.length ? values[values.length - 1] : "";
}

function weekSortValue(value) {
  return isoDate(value) || "0000-00-00";
}

function compareWeekDesc(a, b) {
  return weekSortValue(b?.week_start || b).localeCompare(weekSortValue(a?.week_start || a));
}

function evidenceTimelineItems(transcriptEvidence, kind, recordId) {
  const key = kind === "team" ? "team_id" : "person_id";
  const rows = Array.isArray(transcriptEvidence?.[kind === "team" ? "teams" : "people"])
    ? transcriptEvidence[kind === "team" ? "teams" : "people"]
    : [];
  const view = rows.find(item => String(item?.[key] || "") === String(recordId || ""));
  if (!view) return [];
  const claims = asArray(view.top_claims).slice(0, 6);
  return claims.map((claim) => ({
    date: latestWeek(view.weeks),
    type: "transcript evidence",
    title: labelize(claim.claim_type || "evidence claim"),
    detail: compactText(claim.text || "", 230),
    source: [claim.evidence_level, claim.confidence, "reviewed evidence card"].filter(Boolean).join(" · "),
    evidence_card_id: claim.source_artifact_id || "",
    sharing_boundary: view.sharing_boundary?.max_surface || "cohort",
  }));
}

const CLAIM_SIGNAL_PRIORITY = {
  action_item: 100,
  ask: 94,
  collaboration_edge: 88,
  product_signal: 80,
  decision: 72,
  risk: 64,
  market_signal: 56,
  claim: 36,
};

function claimSignalScore(claim, index = 0, context = {}) {
  const type = claim?.claim_type || "claim";
  const base = CLAIM_SIGNAL_PRIORITY[type] || CLAIM_SIGNAL_PRIORITY.claim;
  const confidence = claim?.confidence === "high" ? 8 : claim?.confidence === "medium" ? 4 : 0;
  const kind = context.kind || "team";
  const recordId = String(context.recordId || "");
  const peerIds = kind === "person" ? asArray(claim?.people) : asArray(claim?.teams);
  const hasRecord = recordId && peerIds.includes(recordId);
  const breadthPenalty = Math.max(0, peerIds.length - 1) * (kind === "person" ? 7 : 9);
  const roomPenalty = Math.max(0, asArray(claim?.teams).length + asArray(claim?.people).length - 8) * 2;
  const specificity = peerIds.length <= 1 ? 36 : peerIds.length <= 2 ? 20 : peerIds.length <= 4 ? 6 : -14;
  const text = String(claim?.text || "").toLowerCase();
  const overlapCount = asArray(context.keywords)
    .filter(token => token && text.includes(token))
    .slice(0, 6).length;
  const keywordOverlap = overlapCount * 7;
  const lexicalPenalty = overlapCount === 0 && peerIds.length > 4
    ? 90
    : overlapCount === 0 && peerIds.length > 2
      ? 38
      : 0;
  const broadAskPenalty = type === "ask" && peerIds.length > 4 ? 42 : 0;
  return base + confidence + specificity + keywordOverlap + (hasRecord ? 6 : 0) - breadthPenalty - roomPenalty - lexicalPenalty - broadAskPenalty - index;
}

function signalLabel(type) {
  const labels = {
    action_item: "next move",
    ask: "needs",
    collaboration_edge: "connect",
    product_signal: "product signal",
    decision: "decision",
    risk: "risk",
    market_signal: "market signal",
    claim: "evidence",
  };
  return labels[type] || labels.claim;
}

function pickSignalClaim(view, context = {}) {
  return asArray(view?.top_claims)
    .map((claim, index) => ({ claim, score: claimSignalScore(claim, index, context) }))
    .sort((a, b) => b.score - a.score)[0]?.claim || null;
}

function signalSpecificity(claim, kind) {
  const peers = kind === "person" ? asArray(claim?.people) : asArray(claim?.teams);
  if (peers.length <= 1) return "record-specific";
  if (peers.length <= 4) return "small-group";
  return "shared-session";
}

function compactSignalText(text, max = 138) {
  return compactText(String(text || "").replace(/\s+/g, " "), max);
}

function buildCardSignal(view, kind, record) {
  const id = kind === "team" ? view?.team_id : view?.person_id;
  const claim = pickSignalClaim(view, {
    kind,
    recordId: id,
    keywords: recordKeywords(record),
  });
  if (!id || !claim) return null;
  const sourceCardIds = Array.from(new Set([
    claim.source_artifact_id,
    ...asArray(view.evidence_card_ids),
  ].filter(Boolean)));
  return {
    record_id: id,
    record_kind: kind,
    signal_type: claim.claim_type || "claim",
    label: signalLabel(claim.claim_type),
    text: compactSignalText(claim.text),
    detail_text: compactSignalText(claim.text, 280),
    specificity: signalSpecificity(claim, kind),
    review_status: "generated",
    promotion_state: "needs-review",
    confidence: claim.confidence || view.confidence || "low",
    evidence_level: claim.evidence_level || "inferred",
    evidence_card_count: asArray(view.evidence_card_ids).length,
    claim_count: view.claim_count || asArray(view.top_claims).length,
    source_card: claim.source_artifact_id || "",
    source_card_ids: sourceCardIds.slice(0, 8),
    claim_id: claim.claim_id || "",
    week: latestWeek(view.weeks),
    themes: asArray(view.themes).slice(0, 3),
    teams: asArray(claim.teams).filter(team => team !== id).slice(0, 4),
    people: asArray(claim.people).filter(person => person !== id).slice(0, 4),
    sharing_boundary: view.sharing_boundary || { max_surface: "cohort", raw_allowed: false },
  };
}

function buildCardSignals(evidence, records = {}) {
  const teamById = new Map(asArray(records.teams).map(record => [record.record_id, record]));
  const personById = new Map(asArray(records.people).map(record => [record.record_id, record]));
  const teamSignals = asArray(evidence?.teams)
    .map(view => buildCardSignal(view, "team", teamById.get(view?.team_id)))
    .filter(Boolean)
    .sort((a, b) => String(a.record_id).localeCompare(String(b.record_id)));
  const personSignals = asArray(evidence?.people)
    .map(view => buildCardSignal(view, "person", personById.get(view?.person_id)))
    .filter(Boolean)
    .sort((a, b) => String(a.record_id).localeCompare(String(b.record_id)));
  return {
    teams: teamSignals,
    people: personSignals,
  };
}

function claimsForNote(claims, types, limit = 4) {
  const typeSet = new Set(types);
  return asArray(claims)
    .filter(claim => typeSet.has(claim.claim_type || "claim"))
    .map((claim, index) => ({ claim, score: claimSignalScore(claim, index) }))
    .sort((a, b) => b.score - a.score)
    .map(item => ({
      claim_type: item.claim.claim_type || "claim",
      label: signalLabel(item.claim.claim_type),
      text: compactSignalText(item.claim.text, 220),
      confidence: item.claim.confidence || "low",
      evidence_level: item.claim.evidence_level || "inferred",
      source_card: item.claim.source_artifact_id || "",
      source_card_ids: asArray(item.claim.source_artifact_id).slice(0, 1),
      teams: asArray(item.claim.teams).slice(0, 8),
      people: asArray(item.claim.people).slice(0, 8),
    }))
    .slice(0, limit);
}

function fieldNoteMarkdown(note) {
  const sourceIds = asArray(note.source_card_ids);
  const lines = [
    `# ${note.title}`,
    "",
    "## the 60-second version",
    "",
    note.summary,
    "",
  ];
  for (const section of note.sections) {
    if (!asArray(section.claims).length) continue;
    lines.push(`## ${section.title}`, "");
    for (const claim of section.claims) {
      lines.push(`- **${claim.label}.** ${claim.text}`);
    }
    lines.push("");
  }
  lines.push(
    "## provenance",
    "",
    `Generated from ${note.evidence_card_count} generated transcript evidence card(s) for the week of ${note.week_start}. Claims are paraphrased and cohort-internal unless separately promoted. Source dialogue is not shown here.`,
    sourceIds.length ? `Source cards: ${sourceIds.join(", ")}` : "",
    "",
  );
  return lines.join("\n").trim();
}

function buildFieldNotes(weeklyViews) {
  return asArray(weeklyViews).map((week) => {
    const topClaims = asArray(week.top_claims);
    const sections = [
      { title: "what moved", claims: claimsForNote(topClaims, ["action_item", "product_signal", "decision"], 5) },
      { title: "asks and edges", claims: claimsForNote(topClaims, ["ask", "collaboration_edge"], 5) },
      { title: "risks to watch", claims: claimsForNote(topClaims, ["risk", "market_signal"], 4) },
    ].filter(section => section.claims.length);
    const note = {
      note_id: `cohort-field-note:${week.week_start || "undated"}`,
      note_kind: "cohort_field_note",
      week_start: week.week_start || "undated",
      title: `Cohort field note: week of ${week.week_start || "undated"}`,
      summary: `The transcript evidence for this week spans ${week.evidence_card_count || asArray(week.evidence_card_ids).length} source card(s), ${week.claim_count || topClaims.length} inferred claim(s), ${asArray(week.teams).length} team(s), and ${asArray(week.themes).length} recurring theme(s).`,
      evidence_card_count: week.evidence_card_count || asArray(week.evidence_card_ids).length,
      claim_count: week.claim_count || topClaims.length,
      source_card_ids: asArray(week.evidence_card_ids).slice(0, 24),
      teams: asArray(week.teams).slice(0, 16),
      people: asArray(week.people).slice(0, 16),
      themes: asArray(week.themes).slice(0, 10),
      confidence: week.confidence || "low",
      sharing_boundary: week.sharing_boundary || { max_surface: "cohort", raw_allowed: false },
      review_status: "generated",
      promotion_state: "needs-review",
      sections,
    };
    return { ...note, markdown: fieldNoteMarkdown(note) };
  });
}

function qaForSessionNote(items, limit = 4) {
  return asArray(items).slice(0, limit).map(item => ({
    question: compactSignalText(item.question, 180),
    answer: compactSignalText(item.answer, 220),
    confidence: item.confidence || "low",
    evidence_level: item.evidence_level || "inferred",
    source_card_ids: asArray(item.source_artifact_id || item.source).slice(0, 1),
    teams: asArray(item.teams).slice(0, 8),
    people: asArray(item.people).slice(0, 8),
  }));
}

function sessionNoteMarkdown(note) {
  const lines = [
    `# ${note.title}`,
    "",
    "## the 60-second version",
    "",
    note.summary,
    "",
  ];
  for (const section of note.sections) {
    if (!asArray(section.claims).length && !asArray(section.qa).length) continue;
    lines.push(`## ${section.title}`, "");
    for (const claim of asArray(section.claims)) {
      lines.push(`- **${claim.label}.** ${claim.text}`);
    }
    for (const qa of asArray(section.qa)) {
      lines.push(`- **Q.** ${qa.question}`);
      if (qa.answer) lines.push(`  **A.** ${qa.answer}`);
    }
    lines.push("");
  }
  if (asArray(note.teams).length || asArray(note.people).length) {
    lines.push("## implicated records", "");
    if (asArray(note.teams).length) lines.push(`Teams: ${asArray(note.teams).join(", ")}`);
    if (asArray(note.people).length) lines.push(`People: ${asArray(note.people).join(", ")}`);
    lines.push("");
  }
  lines.push(
    "## provenance",
    "",
    `Generated from ${asArray(note.source_card_ids).join(", ") || note.note_id}. Review status: ${note.review_status}. Promotion state: ${note.promotion_state}. Raw transcript text is hidden.`,
    "",
  );
  return lines.join("\n").trim();
}

function buildSessionNotes(evidenceCards) {
  return asArray(evidenceCards)
    .filter(card => card?.artifact_kind === "transcript_evidence_card")
    .map((card) => {
      const claims = asArray(card.claims);
      const sections = [
        { title: "what changed", claims: claimsForNote(claims, ["action_item", "product_signal", "decision", "market_signal", "claim"], 5) },
        { title: "asks and risks", claims: claimsForNote(claims, ["ask", "risk", "collaboration_edge"], 5) },
        { title: "questions from the room", qa: qaForSessionNote(card.qa, 5) },
      ].filter(section => asArray(section.claims).length || asArray(section.qa).length);
      const note = {
        note_id: `cohort-session-note:${card.record_id || card.artifact_id}`,
        note_kind: "cohort_session_note",
        session_id: card.record_id || "",
        title: card.title || `Session note: ${card.record_id || card.artifact_id}`,
        summary: card.summary || `Generated from ${claims.length} transcript evidence claim(s).`,
        date: isoDate(card.date),
        week_start: card.week_start || "undated",
        session_kind: card.session_kind || "",
        evidence_card_count: 1,
        claim_count: claims.length,
        question_count: asArray(card.qa).length,
        source_card_ids: asArray(card.artifact_id).slice(0, 1),
        source: card.source || "",
        teams: asArray(card.teams).slice(0, 16),
        people: asArray(card.people).slice(0, 16),
        themes: asArray(card.themes).slice(0, 10),
        confidence: card.confidence || "low",
        review_status: card.review_status || "generated",
        promotion_state: card.surface_recommendation || "review_for_cohort",
        sharing_boundary: card.sharing_boundary || { max_surface: "cohort", raw_allowed: false },
        sections,
        references: asArray(card.references).slice(0, 6),
      };
      return { ...note, markdown: sessionNoteMarkdown(note) };
    })
    .sort((a, b) => {
      const ad = weekSortValue(a.date || a.week_start);
      const bd = weekSortValue(b.date || b.week_start);
      if (ad !== bd) return bd.localeCompare(ad);
      return String(a.note_id).localeCompare(String(b.note_id));
    });
}

function countBy(values) {
  const out = {};
  for (const value of values) {
    const key = String(value || "unknown");
    out[key] = (out[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => a[0].localeCompare(b[0])));
}

function signalInventoryClaim(claim, card) {
  return {
    signal_id: claim.claim_id || `${card.artifact_id}:claim`,
    signal_kind: "claim",
    signal_type: claim.claim_type || "claim",
    label: signalLabel(claim.claim_type),
    text: compactSignalText(claim.text, 320),
    source_card_id: card.artifact_id || "",
    session_id: card.record_id || card.vault_id || "",
    session_title: card.title || "",
    date: isoDate(card.date),
    week_start: card.week_start || "undated",
    confidence: claim.confidence || card.confidence || "low",
    evidence_level: claim.evidence_level || "inferred",
    review_status: card.review_status || "generated",
    promotion_state: card.surface_recommendation || "review_for_cohort",
    sharing_boundary: card.sharing_boundary || { max_surface: "cohort", raw_allowed: false },
    teams: asArray(claim.teams || card.teams).slice(0, 24),
    people: asArray(claim.people || card.people).slice(0, 24),
    themes: asArray(card.themes).slice(0, 10),
  };
}

function signalInventoryQuestion(item, card) {
  return {
    signal_id: item.qa_id || `${card.artifact_id}:qa`,
    signal_kind: "qa",
    signal_type: "question",
    label: "question",
    text: compactSignalText(item.question, 260),
    answer: compactSignalText(item.answer, 320),
    source_card_id: card.artifact_id || "",
    session_id: card.record_id || card.vault_id || "",
    session_title: card.title || "",
    date: isoDate(card.date),
    week_start: card.week_start || "undated",
    confidence: item.confidence || card.confidence || "low",
    evidence_level: item.evidence_level || "inferred",
    review_status: card.review_status || "generated",
    promotion_state: card.surface_recommendation || "review_for_cohort",
    sharing_boundary: card.sharing_boundary || { max_surface: "cohort", raw_allowed: false },
    teams: asArray(item.teams || card.teams).slice(0, 24),
    people: asArray(item.people || card.people).slice(0, 24),
    themes: asArray(card.themes).slice(0, 10),
  };
}

function buildSignalInventory(evidenceCards) {
  const sources = asArray(evidenceCards)
    .filter(card => card?.artifact_kind === "transcript_evidence_card")
    .map((card) => {
      const claimSignals = asArray(card.claims).map(claim => signalInventoryClaim(claim, card));
      const qaSignals = asArray(card.qa).map(item => signalInventoryQuestion(item, card));
      const signals = [...claimSignals, ...qaSignals];
      return {
        source_card_id: card.artifact_id || "",
        session_id: card.record_id || card.vault_id || "",
        title: card.title || card.record_id || card.artifact_id || "transcript evidence",
        summary: card.summary || "",
        date: isoDate(card.date),
        week_start: card.week_start || "undated",
        session_kind: card.session_kind || "",
        consent: card.consent || "unknown",
        confidence: card.confidence || "low",
        review_status: card.review_status || "generated",
        promotion_state: card.surface_recommendation || "review_for_cohort",
        sharing_boundary: card.sharing_boundary || { max_surface: "cohort", raw_allowed: false },
        claim_signal_count: claimSignals.length,
        qa_signal_count: qaSignals.length,
        total_signal_count: signals.length,
        signal_type_counts: countBy(claimSignals.map(signal => signal.signal_type)),
        teams: asArray(card.teams).slice(0, 24),
        people: asArray(card.people).slice(0, 24),
        themes: asArray(card.themes).slice(0, 10),
        signals,
      };
    })
    .sort((a, b) => {
      const ad = weekSortValue(a.date || a.week_start);
      const bd = weekSortValue(b.date || b.week_start);
      if (ad !== bd) return bd.localeCompare(ad);
      return String(a.source_card_id).localeCompare(String(b.source_card_id));
    });
  const allSignals = sources.flatMap(source => source.signals);
  const claimSignals = allSignals.filter(signal => signal.signal_kind === "claim");
  const qaSignals = allSignals.filter(signal => signal.signal_kind === "qa");
  return {
    schema_version: 1,
    source_card_count: sources.length,
    total_signal_count: allSignals.length,
    claim_signal_count: claimSignals.length,
    qa_signal_count: qaSignals.length,
    signal_type_counts: countBy(claimSignals.map(signal => signal.signal_type)),
    review_status_counts: countBy(sources.map(source => source.review_status)),
    coverage: {
      sources_without_claims: sources.filter(source => source.claim_signal_count === 0).map(source => source.source_card_id),
      sources_without_questions: sources.filter(source => source.qa_signal_count === 0).map(source => source.source_card_id),
      min_signals_per_source: sources.length ? Math.min(...sources.map(source => source.total_signal_count)) : 0,
      max_signals_per_source: sources.length ? Math.max(...sources.map(source => source.total_signal_count)) : 0,
    },
    sources,
  };
}

function buildIntelDataContract({ cardSignals, fieldNotes, sessionNotes, signalInventory, teams, people, sourceTranscriptCount = 0 }) {
  return {
    card_signal_inputs: [
      "record_id",
      "transcript_evidence.top_claims[].claim_type",
      "transcript_evidence.top_claims[].text",
      "transcript_evidence.top_claims[].confidence",
      "transcript_evidence.sharing_boundary",
      "transcript_evidence.evidence_card_ids",
    ],
    field_note_inputs: [
      "weekly evidence_card_count",
      "weekly claim_count",
      "weekly teams",
      "weekly themes",
      "weekly top_claims by type",
      "weekly source_card_ids",
    ],
    session_note_inputs: [
      "transcript evidence card title/summary",
      "transcript evidence card claims",
      "transcript evidence card Q&A",
      "transcript evidence card teams/people/themes",
      "transcript evidence card sharing boundary",
    ],
    signal_inventory_inputs: [
      "every transcript evidence card claim",
      "every transcript evidence card Q&A item",
      "source card id, review status, confidence, sharing boundary",
      "teams, people, themes attached to each signal",
    ],
    quality: {
      source_transcript_count: sourceTranscriptCount,
      total_signal_count: signalInventory.total_signal_count || 0,
      claim_signal_count: signalInventory.claim_signal_count || 0,
      qa_signal_count: signalInventory.qa_signal_count || 0,
      team_signal_count: cardSignals.teams.length,
      person_signal_count: cardSignals.people.length,
      field_note_count: fieldNotes.length,
      session_note_count: sessionNotes.length,
      missing_session_note_count: Math.max(0, sourceTranscriptCount - sessionNotes.length),
      sources_without_claims: asArray(signalInventory.coverage?.sources_without_claims).length,
      sources_without_questions: asArray(signalInventory.coverage?.sources_without_questions).length,
      missing_team_signal_count: Math.max(0, asArray(teams).length - cardSignals.teams.length),
      missing_person_signal_count: Math.max(0, asArray(people).length - cardSignals.people.length),
    },
    promotion_rule: "Generated evidence can guide internal cards and field notes; high-salience or public surfaces still need review before promotion.",
  };
}

function buildCohortIntel({ transcriptEvidence, transcriptEvidenceCards = [], sessionInsights, teams = [], people = [] }) {
  const evidence = transcriptEvidence && typeof transcriptEvidence === "object" ? transcriptEvidence : {};
  const weekly = asArray(evidence.weekly)
    .slice()
    .sort(compareWeekDesc)
    .slice(0, 8)
    .map((week) => ({
      week_start: week.week_start,
      evidence_card_ids: asArray(week.evidence_card_ids).slice(0, 24),
      evidence_card_count: asArray(week.evidence_card_ids).length,
      claim_count: week.claim_count || asArray(week.top_claims).length,
      teams: asArray(week.teams).slice(0, 12),
      people: asArray(week.people).slice(0, 12),
      themes: asArray(week.themes).slice(0, 8),
      top_claims: asArray(week.top_claims).slice(0, 8),
      confidence: week.confidence || "low",
      sharing_boundary: week.sharing_boundary || { max_surface: "cohort", raw_allowed: false },
      source_note: week.source_note || "Compiled from reviewed transcript evidence cards, not raw transcript blobs.",
    }));
  const teamViews = asArray(evidence.teams)
    .slice()
    .sort((a, b) => (b.claim_count || 0) - (a.claim_count || 0))
    .slice(0, 16)
    .map((team) => ({
      team_id: team.team_id,
      claim_count: team.claim_count || asArray(team.top_claims).length,
      evidence_card_count: asArray(team.evidence_card_ids).length,
      themes: asArray(team.themes).slice(0, 8),
      top_claims: asArray(team.top_claims).slice(0, 6),
      confidence: team.confidence || "low",
      sharing_boundary: team.sharing_boundary || { max_surface: "cohort", raw_allowed: false },
    }));
  const personViews = asArray(evidence.people)
    .slice()
    .sort((a, b) => (b.claim_count || 0) - (a.claim_count || 0))
    .slice(0, 16)
    .map((person) => ({
      person_id: person.person_id,
      claim_count: person.claim_count || asArray(person.top_claims).length,
      evidence_card_count: asArray(person.evidence_card_ids).length,
      themes: asArray(person.themes).slice(0, 8),
      top_claims: asArray(person.top_claims).slice(0, 6),
      confidence: person.confidence || "low",
      sharing_boundary: person.sharing_boundary || { max_surface: "cohort", raw_allowed: false },
    }));
  const publicReady = asArray(sessionInsights).filter(item => item.consent === "public-cleared");
  const blockedNames = publicArticleBlockedNames({ teams, people });
  const cardSignals = buildCardSignals(evidence, { teams, people });
  const fieldNotes = buildFieldNotes(weekly);
  const sessionNotes = buildSessionNotes(transcriptEvidenceCards);
  const signalInventory = buildSignalInventory(transcriptEvidenceCards);
  return {
    schema_version: 1,
    source: "cohort-data/artifacts/transcript-evidence/generated/views.json",
    generated_from: "reviewed transcript evidence cards",
    raw_allowed: false,
    weekly,
    teams: teamViews,
    people: personViews,
    card_signals: cardSignals,
    field_notes: fieldNotes,
    session_notes: sessionNotes,
    signal_inventory: signalInventory,
    data_contract: buildIntelDataContract({
      cardSignals,
      fieldNotes,
      sessionNotes,
      signalInventory,
      teams,
      people,
      sourceTranscriptCount: Number(evidence.source_artifact_count || transcriptEvidenceCards.length || 0),
    }),
    context_public_candidates: publicReady.map(item => publicArticleCandidateFromReadout(item, { blockedNames })),
    context_policy_note: publicReady.length
      ? "Public-cleared transcript readouts may become Context articles after editorial pass."
      : "No transcript readout is public-cleared yet; Context should use existing articles and cohort-internal evidence only.",
  };
}

function buildPersonTimeline({ people, teams, asks, events, calendar, transcriptEvidence }) {
  const teamById = new Map(teams.map(t => [t.record_id, t]));
  const calBlocks = calendarBlocks(calendar);
  const transcriptMatches = loadCalendarTranscriptMatches();
  const timeline = {};

  for (const person of people) {
    const team = person.team ? teamById.get(person.team) : null;
    const aliases = personAliases(person, team);
    const items = [];
    const start = isoDate(person.dates_start);
    const end = isoDate(person.dates_end);

    if (start || end) {
      items.push({
        date: start || end,
        type: "onboarding",
        title: "cohort window",
        detail: `${start || "open"} to ${end || "open"}`,
        href: "/calendar",
        source: "calendar",
      });
    }

    for (const absence of Array.isArray(person.absences) ? person.absences : []) {
      const a = isoDate(absence?.start);
      const b = isoDate(absence?.end);
      items.push({
        date: a || b || start,
        type: "availability",
        title: "availability note",
        detail: `${a || "open"} to ${b || "open"}${absence?.note ? ` — ${absence.note}` : ""}`,
        href: "/availability",
        source: "person record",
      });
    }

    for (const [field, title] of [
      ["now", "current work"],
      ["weekly_intention", "weekly intention"],
      ["seeking", "seeking"],
      ["offering", "offering"],
      ["contribute_interests", "can contribute"],
    ]) {
      const values = Array.isArray(person[field]) ? person[field] : (person[field] ? [person[field]] : []);
      for (const value of values.slice(0, 3)) {
        items.push({
          date: start,
          type: "profile",
          title,
          detail: compactText(value),
          href: recordSourceUrl("person", person.record_id),
          source: "person record",
        });
      }
    }

    if (team) {
      for (const [field, title] of [
        ["now", "team current work"],
        ["seeking", "team seeking"],
        ["offering", "team offering"],
      ]) {
        const values = Array.isArray(team[field]) ? team[field] : (team[field] ? [team[field]] : []);
        for (const value of values.slice(0, field === "now" ? 1 : 2)) {
          items.push({
            date: start,
            type: "team",
            title,
            detail: compactText(value),
            href: `#${encodeURIComponent(team.record_id)}`,
            source: team.name || team.record_id,
          });
        }
      }
    }

    for (const ask of asks) {
      const author = String(ask.author || "").toLowerCase();
      const personAuthored = author === String(person.record_id || "").toLowerCase();
      const teamAuthored = team && author === String(team.record_id || "").toLowerCase();
      if (!personAuthored && !teamAuthored) continue;
      items.push({
        date: isoDate(ask.posted_at) || start,
        type: "ask",
        title: compactText(`${teamAuthored ? "team " : ""}${ask.verb || "ask"} ${ask.topic || ""}`, 96),
        detail: ask.status ? `status: ${ask.status}` : "",
        href: recordSourceUrl("ask", ask.record_id),
        source: teamAuthored ? (team.name || team.record_id) : "ask",
      });
    }

    for (const event of events) {
      const text = `${event.title || ""} ${event.subtitle || ""}`;
      const isRelevant = textIncludesAny(text, aliases.any)
        || (/\bonboarding\b/i.test(text) && start && isoDate(event.range_start || event.date) <= start);
      if (!isRelevant) continue;
      items.push({
        date: isoDate(event.date || event.range_start) || start,
        type: "event",
        title: event.title || "program event",
        detail: compactText(event.subtitle || ""),
        href: recordSourceUrl("event", event.record_id),
        source: "event",
      });
    }

    const calendarItems = [];
    for (const block of calBlocks) {
      if (!textIncludesAny(`${block.title} ${block.detail}`, aliases.any)) continue;
      calendarItems.push({
        date: block.date || start,
        type: /\bonboarding\b/i.test(`${block.title} ${block.detail}`) ? "onboarding" : "calendar",
        title: compactText(block.title, 96),
        detail: compactText(block.detail, 170),
        href: "/calendar",
        source: block.column || block.tab,
      });
    }
    items.push(...calendarItems.slice(0, 8));

    const transcriptItems = [];
    for (const match of transcriptMatches) {
      for (const source of Array.isArray(match.sources) ? match.sources : []) {
        const hit = transcriptSourceHit(match, source, aliases, person.record_id);
        if (!hit) continue;
        transcriptItems.push({
          _priority: hit.sourceNamed ? 3 : (hit.directHit ? 2 : 1),
          _dedup: hit.dedupKey,
          date: match.date || start,
          type: "transcript",
          title: hit.sourceNamed ? "speaker/source transcript" : (hit.directHit ? "mentioned in transcript" : "team context in transcript"),
          detail: hit.detail,
          ...(hit.href ? { href: hit.href } : { vault_id: hit.vaultId }),
          source: source.role === "notes" ? "notes" : "transcript",
        });
      }
    }
    transcriptItems.sort((a, b) => {
      if (a._priority !== b._priority) return b._priority - a._priority;
      // newest first within each tier so the slice cap below keeps recent
      // sessions (e.g. weekly standups) instead of filling with the oldest
      return String(b.date || "").localeCompare(String(a.date || ""));
    });
    const seenTranscriptSources = new Set();
    const uniqueTranscriptItems = transcriptItems.filter(item => {
      const key = item._dedup || item.href || `${item.date || ""}|${item.title || ""}|${item.detail || ""}`;
      if (seenTranscriptSources.has(key)) return false;
      seenTranscriptSources.add(key);
      return true;
    });
    items.push(...uniqueTranscriptItems.slice(0, 6).map(({ _priority, _dedup, ...item }) => item));
    items.push(...evidenceTimelineItems(transcriptEvidence, "person", person.record_id));

    timeline[person.record_id] = sortTimeline(items).slice(0, 28);
  }

  return timeline;
}

function buildTeamTimeline({ teams, people, asks, events, calendar, githubProgressArtifacts = [], transcriptEvidence }) {
  const peopleByTeam = new Map();
  for (const person of people) {
    const teamIds = [person.team, ...asArray(person.secondary_teams)].filter(Boolean);
    for (const teamId of teamIds) {
      if (!peopleByTeam.has(teamId)) peopleByTeam.set(teamId, []);
      peopleByTeam.get(teamId).push(person);
    }
  }
  const calBlocks = calendarBlocks(calendar);
  const transcriptMatches = loadCalendarTranscriptMatches();
  const timeline = {};
  const githubArtifactsByTeam = new Map();
  for (const artifact of githubProgressArtifacts) {
    const teamId = String(artifact.record_id || "").trim();
    if (!teamId) continue;
    if (!githubArtifactsByTeam.has(teamId)) githubArtifactsByTeam.set(teamId, []);
    githubArtifactsByTeam.get(teamId).push(artifact);
  }

  for (const team of teams) {
    const members = peopleByTeam.get(team.record_id) || [];
    const memberById = new Map(members.map(member => [String(member.record_id || "").toLowerCase(), member]));
    const aliases = teamAliases(team, members);
    const items = [];

    for (const [field, title, type, limit] of [
      ["now", "current work", "profile", 1],
      ["weekly_goals", "weekly goals", "profile", 2],
      ["monthly_milestones", "milestones", "profile", 2],
      ["graduation_target", "graduation target", "profile", 1],
      ["seeking", "seeking", "ask", 3],
      ["offering", "offering", "offer", 3],
      ["traction", "traction", "evidence", 1],
      ["prior_shipping", "prior shipping", "evidence", 3],
      ["paper_basis", "research basis", "evidence", 2],
    ]) {
      const values = Array.isArray(team[field]) ? team[field] : (team[field] ? [team[field]] : []);
      for (const value of values.slice(0, limit)) {
        items.push({
          date: "",
          type,
          title,
          detail: compactText(value),
          href: recordSourceUrl("team", team.record_id),
          source: "team record",
        });
      }
    }

    for (const ask of asks) {
      const author = String(ask.author || "").toLowerCase();
      const teamAuthored = author === String(team.record_id || "").toLowerCase();
      const member = memberById.get(author);
      if (!teamAuthored && !member) continue;
      items.push({
        date: isoDate(ask.posted_at),
        type: "ask",
        title: compactText(`${member ? `${member.name || member.record_id}: ` : ""}${ask.verb || "ask"} ${ask.topic || ""}`, 96),
        detail: ask.status ? `status: ${ask.status}` : "",
        href: recordSourceUrl("ask", ask.record_id),
        source: teamAuthored ? (team.name || team.record_id) : (member.name || member.record_id),
      });
    }

    for (const event of events) {
      const text = `${event.title || ""} ${event.subtitle || ""}`;
      if (!textIncludesAny(text, aliases.any)) continue;
      items.push({
        date: isoDate(event.date || event.range_start),
        type: "event",
        title: event.title || "program event",
        detail: compactText(event.subtitle || ""),
        href: recordSourceUrl("event", event.record_id),
        source: "event",
      });
    }

    const calendarItems = [];
    for (const block of calBlocks) {
      if (!textIncludesAny(`${block.title} ${block.detail}`, aliases.any)) continue;
      const calendarTitle = /[a-z]/i.test(String(block.title || ""))
        ? block.title
        : "calendar mention";
      calendarItems.push({
        date: block.date,
        type: /\bonboarding\b/i.test(`${block.title} ${block.detail}`) ? "onboarding" : "calendar",
        title: compactText(calendarTitle, 96),
        detail: compactText(block.detail, 170),
        href: "/calendar",
        source: block.column || block.tab,
      });
    }
    items.push(...calendarItems.slice(0, 8));

    const transcriptItems = [];
    for (const match of transcriptMatches) {
      for (const source of Array.isArray(match.sources) ? match.sources : []) {
        const hit = transcriptSourceHit(match, source, aliases, team.record_id);
        if (!hit) continue;
        transcriptItems.push({
          _priority: hit.sourceNamed ? 3 : (hit.directHit ? 2 : 1),
          _dedup: hit.dedupKey,
          date: match.date,
          type: "transcript",
          title: hit.sourceNamed ? "team source transcript" : (hit.directHit ? "team mentioned in transcript" : "member context in transcript"),
          detail: hit.detail,
          ...(hit.href ? { href: hit.href } : { vault_id: hit.vaultId }),
          source: source.role === "notes" ? "notes" : "transcript",
        });
      }
    }
    transcriptItems.sort((a, b) => {
      if (a._priority !== b._priority) return b._priority - a._priority;
      // newest first within each tier so the slice cap below keeps recent
      // sessions (e.g. weekly standups) instead of filling with the oldest
      return String(b.date || "").localeCompare(String(a.date || ""));
    });
    const seenTranscriptSources = new Set();
    const uniqueTranscriptItems = transcriptItems.filter(item => {
      const key = item._dedup || item.href || `${item.date || ""}|${item.title || ""}|${item.detail || ""}`;
      if (seenTranscriptSources.has(key)) return false;
      seenTranscriptSources.add(key);
      return true;
    });
    items.push(...uniqueTranscriptItems.slice(0, 6).map(({ _priority, _dedup, ...item }) => item));
    items.push(...evidenceTimelineItems(transcriptEvidence, "team", team.record_id));

    for (const artifact of githubArtifactsByTeam.get(team.record_id) || []) {
      const repo = artifact.source_repo || artifact.evidence?.repo || "github repo";
      const count = artifact.evidence?.commit_count;
      const title = artifact.title || `${repo}${Number.isFinite(count) ? `: ${count} commit${count === 1 ? "" : "s"}` : ""}`;
      items.push({
        date: isoDate(artifact.date || artifact.week_start),
        type: "github progress",
        title: compactText(title, 110),
        detail: compactText(artifact.summary || artifact.detail || "", 220),
        href: artifact.source_url || artifact.evidence?.url || "",
        source: "github distillation",
      });
    }

    timeline[team.record_id] = sortTimeline(items).slice(0, 28);
  }

  return timeline;
}

function loadJsonArray(file, label) {
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(parsed)) return parsed;
    console.warn(`[build-bundles] ${label} should be an array; got ${typeof parsed}`);
  } catch (e) {
    console.warn(`[build-bundles] ${label} present but unreadable: ${e.message}`);
  }
  return [];
}

function loadJsonObject(file, label) {
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    console.warn(`[build-bundles] ${label} should be an object; got ${Array.isArray(parsed) ? "array" : typeof parsed}`);
  } catch (e) {
    console.warn(`[build-bundles] ${label} present but unreadable: ${e.message}`);
  }
  return null;
}

function loadTranscriptEvidenceCards() {
  const root = path.join(COHORT_DIR, "artifacts", "transcript-evidence", "generated");
  const manifest = loadJsonObject(path.join(root, "manifest.json"), "transcript-evidence/generated/manifest.json");
  const artifacts = asArray(manifest?.artifacts);
  const cards = [];
  for (const artifact of artifacts) {
    if (!artifact?.file) continue;
    const file = path.join(root, artifact.file);
    const card = loadJsonObject(file, `transcript-evidence/generated/${artifact.file}`);
    if (!card) continue;
    cards.push(card);
  }
  return cards.sort((a, b) => {
    const ad = weekSortValue(a.date || a.week_start);
    const bd = weekSortValue(b.date || b.week_start);
    if (ad !== bd) return bd.localeCompare(ad);
    return String(a.artifact_id || "").localeCompare(String(b.artifact_id || ""));
  });
}

function listJsonFilesRecursive(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listJsonFilesRecursive(full));
    } else if (entry.isFile() && entry.name.endsWith(".json") && entry.name !== "manifest.json") {
      out.push(full);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function loadGithubProgressArtifacts() {
  const root = path.join(COHORT_DIR, "artifacts", "github-progress");
  const files = listJsonFilesRecursive(root);
  const out = [];
  for (const file of files) {
    let artifact;
    try {
      artifact = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      console.warn(`[build-bundles] github progress artifact unreadable ${file}: ${e.message}`);
      continue;
    }
    if (artifact?.artifact_kind !== "github_progress_weekly_summary") continue;
    if (artifact?.review_status !== "reviewed") continue;
    if (artifact?.record_type !== "team" || !artifact?.record_id) {
      console.warn(`[build-bundles] github progress artifact missing team record_id: ${file}`);
      continue;
    }
    out.push(artifact);
  }
  return out.sort((a, b) => {
    const ad = isoDate(a.date || a.week_start);
    const bd = isoDate(b.date || b.week_start);
    if (ad !== bd) return ad.localeCompare(bd);
    return String(a.artifact_id || "").localeCompare(String(b.artifact_id || ""));
  });
}

function transcriptDistillationAppVisible(artifact) {
  if (!artifact || typeof artifact !== "object") return false;
  if (artifact.tier === "T2") {
    return artifact.review_status === "reviewed" || artifact.review_status === "published";
  }
  if (artifact.tier === "T3") {
    return artifact.review_status === "published" && artifact.approval_state === "approved";
  }
  return false;
}

function sanitizeTranscriptDistillationsForApp(manifest) {
  const base = manifest && typeof manifest === "object" ? manifest : {};
  const artifacts = Array.isArray(base.artifacts)
    ? base.artifacts.filter(transcriptDistillationAppVisible)
    : [];
  return {
    schema_version: base.schema_version || 1,
    generated_at: base.generated_at || null,
    source: base.source || "supabase.derived_artifacts",
    default_export_policy: "app-visible only: T2 reviewed/published and T3 published+approved",
    source_default_export_policy: base.default_export_policy || null,
    source_artifact_count: Number(base.artifact_count || 0),
    source_operator_review_count: Number(base.operator_review_count || 0),
    artifact_count: artifacts.length,
    cohort_count: artifacts.filter((item) => item.surface === "cohort").length,
    public_count: artifacts.filter((item) => item.surface === "public").length,
    operator_review_count: 0,
    artifacts,
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function emptyTranscriptEvidence(source) {
  return {
    schema_version: source?.schema_version || 1,
    source_artifact_count: 0,
    weekly: [],
    teams: [],
    people: [],
    graph: {
      nodes: [],
      edges: [],
    },
    generated_at: source?.generated_at || null,
    public_web_policy: "cohort-only transcript evidence is excluded from the public static bundle",
  };
}

function publicTranscriptDistillations(source) {
  const base = source && typeof source === "object" ? source : {};
  const artifacts = asArray(base.artifacts)
    .filter((artifact) => artifact.surface === "public")
    .filter(transcriptDistillationAppVisible);
  return {
    schema_version: base.schema_version || 1,
    generated_at: base.generated_at || null,
    source: base.source || "supabase.derived_artifacts",
    default_export_policy: "public web only: T3 published+approved",
    artifact_count: artifacts.length,
    cohort_count: 0,
    public_count: artifacts.length,
    operator_review_count: 0,
    artifacts,
  };
}

function stripTranscriptEvidenceTimeline(timeline) {
  const out = {};
  for (const [recordId, items] of Object.entries(timeline || {})) {
    out[recordId] = asArray(items).filter((item) => item.type !== "transcript evidence");
  }
  return out;
}

function privateTranscriptSource(value) {
  const text = String(value || "");
  return /\bprivate-vault:/i.test(text)
    || /\btranscript-evidence:/i.test(text)
    || /\bdrive:\/\//i.test(text);
}

function publicSafeConstellationCue(item) {
  if (!item || typeof item !== "object") return false;
  return !privateTranscriptSource(item.source)
    && !privateTranscriptSource(item.source_artifact_id)
    && !privateTranscriptSource(item.vault_id)
    && !privateTranscriptSource(item.provenance?.source)
    && !privateTranscriptSource(item.provenance?.source_artifact_id);
}

function publicWebSurface(surface) {
  const out = cloneJson(surface);
  const publicSessionInsights = asArray(out.session_insights)
    .filter((item) => item.consent === "public-cleared");
  out.session_insights = publicSessionInsights;
  out.constellation_cues = asArray(out.constellation_cues).filter(publicSafeConstellationCue);
  out.transcript_evidence = emptyTranscriptEvidence(surface.transcript_evidence);
  out.transcript_distillations = publicTranscriptDistillations(surface.transcript_distillations);
  out.cohort_intel = buildCohortIntel({
    transcriptEvidence: out.transcript_evidence,
    sessionInsights: publicSessionInsights,
    teams: out.teams,
    people: out.people,
  });
  out.cohort_intel.context_policy_note = out.transcript_distillations.public_count
    ? "Public-approved transcript distillations may be used for Context."
    : "No transcript readout is public-cleared yet; public Context should use existing articles only.";
  out.person_timeline = stripTranscriptEvidenceTimeline(out.person_timeline);
  out.team_timeline = stripTranscriptEvidenceTimeline(out.team_timeline);
  out.surface_visibility = "public-web";
  return out;
}

function surfaceForOutputPath(outPath, built) {
  return path.resolve(outPath) === path.resolve(WEB_SURFACE_PATH)
    ? publicWebSurface(built)
    : built;
}

function build() {
  const schema = readSchema();
  if (!schema || schema.schema_version !== 1) {
    throw new Error(`unsupported schema_version in cohort-data/schema.yml`);
  }

  const teams    = loadDir(path.join(COHORT_DIR, "teams"),    "team",    schema.teams?.surface_fields    || []);
  const people   = loadDir(path.join(COHORT_DIR, "people"),   "person",  schema.people?.surface_fields   || []);
  const clusters = loadDir(path.join(COHORT_DIR, "clusters"), "cluster", schema.clusters?.surface_fields || []);
  const dependencies = loadDir(path.join(COHORT_DIR, "dependencies"), "dependency", schema.dependencies?.surface_fields || []);
  const program      = loadProgramDir(path.join(COHORT_DIR, "program"),      schema.program?.surface_fields  || []);
  const events       = loadDir(path.join(COHORT_DIR, "events"),   "event",   schema.events?.surface_fields   || []);
  const asks         = loadDir(path.join(COHORT_DIR, "asks"),     "ask",     schema.asks?.surface_fields     || []);

  // Calendar snapshot. cohort-data/calendar.json is the bot-managed mirror
  // of the live Phala upstream (see scripts/sync-calendar.js + the
  // calendar-sync workflow). Bundled into the surface so the app has an
  // offline fallback — at runtime the renderer tries the live URL first and
  // only uses this snapshot when offline/upstream-down, surfacing a
  // "may be stale" banner.
  const calPath = path.join(COHORT_DIR, "calendar.json");
  let calendar = null;
  if (fs.existsSync(calPath)) {
    try { calendar = JSON.parse(fs.readFileSync(calPath, "utf8")); }
    catch (e) { console.warn(`[build-bundles] calendar.json present but unreadable: ${e.message}`); }
  }

  // Public transcript-derived context for constellation inspectors. These cues
  // do not create graph edges; they are source snippets shown after a selected
  // team/line/ecosystem so the renderer does not own transcript facts as code.
  const constellation_cues = loadJsonArray(path.join(COHORT_DIR, "constellation-cues.json"), "constellation-cues.json");

  // Distilled per-session readouts hardcoded from private-vault transcripts
  // via scripts/ingest-session-readouts.mjs. Public-safe by construction —
  // the raw transcript never enters the repo; vault_id joins back to the
  // held-private timeline anchors in calendar-transcript-matches.js.
  const session_insights = loadJsonArray(path.join(COHORT_DIR, "session-insights.json"), "session-insights.json");
  const transcript_evidence = loadJsonObject(
    path.join(COHORT_DIR, "artifacts", "transcript-evidence", "generated", "views.json"),
    "transcript-evidence/generated/views.json",
  );
  const transcript_evidence_cards = loadTranscriptEvidenceCards();
  const transcript_distillations = sanitizeTranscriptDistillationsForApp(loadJsonObject(
    path.join(COHORT_DIR, "artifacts", "transcript-distillations", "generated", "manifest.json"),
    "transcript-distillations/generated/manifest.json",
  ));
  const cohort_intel = buildCohortIntel({
    transcriptEvidence: transcript_evidence,
    transcriptEvidenceCards: transcript_evidence_cards,
    sessionInsights: session_insights,
    teams,
    people,
  });
  const github_progress_artifacts = loadGithubProgressArtifacts();

  // Cohort-wide controlled vocab + UI configuration the renderer needs at
  // boot. Shipped alongside records so the atlas / constellation / asks UIs
  // have a stable filter set even when offline.
  const cohort_vocab = schema.cohort_vocab || {};

  const out = {
    schema_version: 1,
    _comment: "Generated by scripts/build-bundles.js — do not edit by hand. Source of truth is cohort-data/. See docs/SHAPE-ROTATOR-OS-SPEC.md §4.4.",
    _generated_at: new Date().toISOString(),
    teams,
    people,
    clusters,
    dependencies,
    program,
    events,
    asks,
    calendar,
    person_timeline: buildPersonTimeline({ people, teams, asks, events, calendar, transcriptEvidence: transcript_evidence }),
    team_timeline: buildTeamTimeline({ teams, people, asks, events, calendar, githubProgressArtifacts: github_progress_artifacts, transcriptEvidence: transcript_evidence }),
    cohort_vocab,
    constellation_cues,
    session_insights,
    transcript_evidence,
    transcript_distillations,
    cohort_intel,
  };
  return out;
}

function fmt(j) {
  return JSON.stringify(j, null, 2) + "\n";
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");

  let built;
  try { built = build(); }
  catch (e) { console.error("[build-bundles]", e.message); process.exit(2); }

  if (check) {
    for (const outPath of OUT_PATHS) {
      if (!fs.existsSync(outPath)) {
        console.error(`[build-bundles] --check: ${outPath} does not exist`);
        process.exit(3);
      }
      const current = fs.readFileSync(outPath, "utf8");
      // Compare structurally (ignoring _generated_at) so re-running on
      // the same content doesn't trip --check.
      const a = { ...JSON.parse(current), _generated_at: null };
      const b = { ...surfaceForOutputPath(outPath, built), _generated_at: null };
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        console.error(`[build-bundles] --check: ${outPath} is stale; run \`npm run build:cohort\` and commit`);
        process.exit(4);
      }
    }
    console.log(`[build-bundles] --check: surface JSON is up to date`);
    return;
  }

  for (const outPath of OUT_PATHS) {
    const json = fmt(surfaceForOutputPath(outPath, built));
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, json);
  }
  const calTabs = built.calendar?.tabs ? Object.keys(built.calendar.tabs).length : 0;
  const evidenceViews = built.transcript_evidence
    ? `${built.transcript_evidence.weekly?.length || 0} weekly/${built.transcript_evidence.teams?.length || 0} team/${built.transcript_evidence.people?.length || 0} person`
    : "none";
  console.log(`[build-bundles] wrote ${OUT_PATHS.length} surface JSON files, primary=${PRIMARY_OUT_PATH} (${built.teams.length} teams, ${built.people.length} people, ${built.clusters.length} clusters, ${built.dependencies.length} dependencies, ${built.program.length} program pages, ${built.events.length} events, ${built.asks.length} asks, ${built.constellation_cues.length} constellation cues, ${built.session_insights.length} session insights, transcript evidence=${evidenceViews}, transcript distillations=${built.transcript_distillations.artifact_count}, cohort intel=${built.cohort_intel.weekly.length} weeks, ${built.calendar ? `calendar=${calTabs} tabs` : "no calendar"})`);
}

main();
