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
  sanitizePublicArticleText,
} = require("./lib/public-article-policy.cjs");

const REPO_ROOT  = path.resolve(__dirname, "..");
const COHORT_DIR = path.join(REPO_ROOT, "cohort-data");
const OS_SURFACE_PATH = path.join(REPO_ROOT, "apps", "os", "src", "cohort-surface.json");
const WEB_SURFACE_PATH = path.join(REPO_ROOT, "apps", "web", "cohort-surface.json");
const OUT_PATHS = [
  OS_SURFACE_PATH,
  WEB_SURFACE_PATH,
];
// The web copy is generated for local/static serving and intentionally
// gitignored. CI should require only the committed OS surface.
const CHECK_PATHS = [
  OS_SURFACE_PATH,
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

function buildCohortIntel({ transcriptEvidence, sessionInsights, teams = [], people = [] }) {
  const evidence = transcriptEvidence && typeof transcriptEvidence === "object" ? transcriptEvidence : {};
  const weekly = asArray(evidence.weekly)
    .slice()
    .sort((a, b) => String(b.week_start || "").localeCompare(String(a.week_start || "")))
    .slice(0, 8)
    .map((week) => ({
      week_start: week.week_start,
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
  return {
    schema_version: 1,
    source: "cohort-data/artifacts/transcript-evidence/generated/views.json",
    generated_from: "reviewed transcript evidence cards",
    raw_allowed: false,
    weekly,
    teams: teamViews,
    people: personViews,
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

// "What's new" feed, generated at build time and bundled into the surface so
// the membrane's left-edge feed reads full immediately (independent of the
// live team_timeline refresh from main). Mixes the visible kinds, newest-first:
//   - release : real GitHub releases (prereleases included) from releaseItems
//   - commit  : ONE weekly summary per project per week ("N commits") from the
//               github_progress artifacts — a digest, not individual commits
//   - event   : program calendar events  ·  ask : posted asks
// Goal is a complete log of the program: items run from `since` (program start)
// onward, with no upper date bound (upcoming events show too) and only a high
// safety cap (FEED_MAX). Transcripts are intentionally NOT emitted — the
// renderer hides them (they dead-end with no deep-link), so they would only
// burn feed slots; re-add the loop here once that surface lands. Each item is
// {date, kind, label, meta, nav}. Dates go through isoDate() because js-yaml
// parses ISO frontmatter timestamps (events/asks) into Date objects — a plain
// String(date).slice(0,10) yields "Mon May 18" and silently drops them.
function buildWhatsNew({ teams, releaseItems, githubProgressArtifacts, asks, events, since }) {
  const nameById = new Map((teams || []).map((t) => [String(t.record_id || ""), t.name || t.record_id]));
  // Keep a sane year window AND clip to the program start so pre-event history
  // never leaks in once the cap is high.
  const inWindow = (d) => {
    const t = Date.parse(d);
    if (!Number.isFinite(t)) return false;
    const y = new Date(t).getUTCFullYear();
    if (y < 2025 || y > 2027) return false;
    return !since || String(d) >= since;
  };
  const out = [];

  for (const item of (Array.isArray(releaseItems) ? releaseItems : [])) {
    if (!inWindow(item.date)) continue;
    out.push(item);
  }
  // Weekly commit activity — one digest item per project per week (the feed
  // shows "150 commits", not the individual subjects; the per-project timeline
  // still carries the detail via buildTeamTimeline).
  for (const a of (githubProgressArtifacts || [])) {
    const date = isoDate(a.date || a.week_start);
    if (!inWindow(date)) continue;
    const teamId = String(a.record_id || "").trim();
    const project = nameById.get(teamId) || teamId;
    const count = Number(a.evidence?.commit_count || 0);
    const label = count ? `${count} commit${count === 1 ? "" : "s"}` : "new commits";
    out.push({ date, kind: "commit", label, meta: project, nav: { mode: "shapes", recordId: teamId } });
  }
  for (const a of (asks || [])) {
    const date = isoDate(a.posted_at);
    if (!inWindow(date)) continue;
    out.push({ date, kind: "ask", label: a.topic || a.verb || "ask", meta: `${a.verb || "ask"} · ask`, nav: { mode: "asks" } });
  }
  for (const e of (events || [])) {
    const date = isoDate(e.date || e.range_start || e.starts_at);
    if (!inWindow(date)) continue;
    out.push({ date, kind: "event", label: e.title || e.name || "program event", meta: e.subtitle ? `${e.subtitle} · event` : "event", nav: { mode: "calendar" } });
  }

  return out.sort((x, y) => String(y.date).localeCompare(String(x.date))).slice(0, FEED_MAX);
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
  // Keep one artifact per (team, week), preferring a reviewed copy over a
  // generated one. The "what's new" feed surfaces every project's weekly
  // GitHub activity (including shape-rotator-os), so we no longer gate on
  // review_status — but a reviewed copy still wins when both exist.
  const byKey = new Map();
  for (const file of files) {
    let artifact;
    try {
      artifact = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      console.warn(`[build-bundles] github progress artifact unreadable ${file}: ${e.message}`);
      continue;
    }
    if (artifact?.artifact_kind !== "github_progress_weekly_summary") continue;
    if (artifact?.record_type !== "team" || !artifact?.record_id) {
      console.warn(`[build-bundles] github progress artifact missing team record_id: ${file}`);
      continue;
    }
    const key = `${artifact.record_id}|${isoDate(artifact.date || artifact.week_start)}`;
    const existing = byKey.get(key);
    if (!existing || (existing.review_status !== "reviewed" && artifact.review_status === "reviewed")) {
      byKey.set(key, artifact);
    }
  }
  const out = [...byKey.values()];
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

function publicTranscriptDistillations(source, blockedNames = []) {
  const base = source && typeof source === "object" ? source : {};
  // S5-4b: redact cohort names from the public distillation surface, the same way
  // the public ARTICLE path does. A published T3 distillation must be no-name by
  // default on the public web bundle — not shipped verbatim like before.
  const clean = (value) => sanitizePublicArticleText(value, blockedNames);
  const artifacts = asArray(base.artifacts)
    .filter((artifact) => artifact.surface === "public")
    .filter(transcriptDistillationAppVisible)
    .map((artifact) => {
      const out = { ...artifact };
      if (typeof artifact.session_title === "string") out.session_title = clean(artifact.session_title);
      if (Array.isArray(artifact.summary)) out.summary = artifact.summary.map(clean);
      if (Array.isArray(artifact.themes)) out.themes = artifact.themes.map(clean);
      if (Array.isArray(artifact.action_items)) out.action_items = artifact.action_items.map(clean);
      if (Array.isArray(artifact.open_questions)) out.open_questions = artifact.open_questions.map(clean);
      if (typeof artifact.content_md === "string") out.content_md = clean(artifact.content_md);
      return out;
    });
  return {
    schema_version: base.schema_version || 1,
    generated_at: base.generated_at || null,
    source: base.source || "supabase.derived_artifacts",
    default_export_policy: "public web only: T3 published+approved, no-name redacted",
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

// Cap per project so one prolific upstream repo (e.g. elizaOS/eliza, 100+
// releases) can't crowd out everyone else within the global feed cap.
const PER_PROJECT_RELEASE_LIMIT = 12;

// Global feed length. The feed is meant to be a complete log of the program
// (every kind, every week from program start), so this is a high safety
// backstop against pathological growth — not a "top N" display limit.
const FEED_MAX = 200;

// Program start (lower bound for the feed window). Read from timeline.yml so it
// tracks the canonical cohort config; falls back to the known kickoff date.
function readProgramStart() {
  try {
    const cfg = yaml.load(fs.readFileSync(path.join(COHORT_DIR, "timeline.yml"), "utf8")) || {};
    return isoDate(cfg.program_start) || "2026-05-18";
  } catch {
    return "2026-05-18";
  }
}

// github_release_list artifacts (scripts/check-github-releases.mjs). One per
// repo; carries the published releases the membrane feed surfaces. Read-only
// here — the GitHub API call lives in the generator, never in this build.
function loadGithubReleaseArtifacts() {
  const root = path.join(COHORT_DIR, "artifacts", "github-releases");
  const files = listJsonFilesRecursive(root);
  const out = [];
  for (const file of files) {
    let artifact;
    try {
      artifact = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      console.warn(`[build-bundles] github release artifact unreadable ${file}: ${e.message}`);
      continue;
    }
    if (artifact?.artifact_kind !== "github_release_list") continue;
    if (artifact?.record_type !== "team" || !artifact?.record_id) {
      console.warn(`[build-bundles] github release artifact missing team record_id: ${file}`);
      continue;
    }
    out.push(artifact);
  }
  return out.sort((a, b) => String(a.artifact_id || "").localeCompare(String(b.artifact_id || "")));
}

// Flatten release artifacts into "what's new" feed items, newest-first per
// project and capped at PER_PROJECT_RELEASE_LIMIT. Each published release
// becomes a kind:"release" item {date, kind, label, meta, nav}. `since` clips
// to the program window so pre-event history (e.g. elizaOS's months of alphas)
// doesn't reappear once the global feed cap is lifted.
function releaseFeedItems(releaseArtifacts, teams, since) {
  const nameById = new Map((teams || []).map((t) => [String(t.record_id || ""), t.name || t.record_id]));
  const out = [];
  for (const artifact of (releaseArtifacts || [])) {
    const teamId = String(artifact.record_id || "").trim();
    const project = nameById.get(teamId) || teamId;
    const nav = { mode: "shapes", recordId: teamId };
    const recent = (Array.isArray(artifact.releases) ? artifact.releases : [])
      .filter((r) => !since || isoDate(r.published_at) >= since)
      .sort((a, b) => String(b.published_at || "").localeCompare(String(a.published_at || "")))
      .slice(0, PER_PROJECT_RELEASE_LIMIT);
    for (const release of recent) {
      const date = isoDate(release.published_at);
      const label = String(release.name || release.tag_name || "").trim();
      if (!date || !label) continue;
      out.push({ date, kind: "release", label, meta: project, nav });
    }
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
  out.transcript_distillations = publicTranscriptDistillations(
    surface.transcript_distillations,
    publicArticleBlockedNames({ teams: surface.teams, people: surface.people }),
  );
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
  const transcript_distillations = sanitizeTranscriptDistillationsForApp(loadJsonObject(
    path.join(COHORT_DIR, "artifacts", "transcript-distillations", "generated", "manifest.json"),
    "transcript-distillations/generated/manifest.json",
  ));
  const cohort_intel = buildCohortIntel({
    transcriptEvidence: transcript_evidence,
    sessionInsights: session_insights,
    teams,
    people,
  });
  const github_progress_artifacts = loadGithubProgressArtifacts();
  const github_release_artifacts = loadGithubReleaseArtifacts();
  const program_start = readProgramStart();
  const release_feed_items = releaseFeedItems(github_release_artifacts, teams, program_start);

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
    whats_new: buildWhatsNew({ teams, releaseItems: release_feed_items, githubProgressArtifacts: github_progress_artifacts, asks, events, since: program_start }),
    // Normalized release feed items, also exposed standalone so the renderer's
    // runtime fallback (alchemy.js buildWhatsNewFeed) can rebuild the feed
    // without re-deriving releases.
    github_releases: release_feed_items,
  };
  return out;
}

function fmt(j) {
  return JSON.stringify(j, null, 2) + "\n";
}

function surfaceForComparison(surface) {
  return { ...surface, _generated_at: null };
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");

  let built;
  try { built = build(); }
  catch (e) { console.error("[build-bundles]", e.message); process.exit(2); }

  if (check) {
    for (const outPath of CHECK_PATHS) {
      if (!fs.existsSync(outPath)) {
        console.error(`[build-bundles] --check: ${outPath} does not exist`);
        process.exit(3);
      }
      const current = fs.readFileSync(outPath, "utf8");
      // Compare structurally (ignoring _generated_at) so re-running on
      // the same content doesn't trip --check.
      const a = surfaceForComparison(JSON.parse(current));
      const b = surfaceForComparison(surfaceForOutputPath(outPath, built));
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        console.error(`[build-bundles] --check: ${outPath} is stale; run \`npm run build:cohort\` and commit`);
        process.exit(4);
      }
    }
    console.log(`[build-bundles] --check: surface JSON is up to date`);
    return;
  }

  for (const outPath of OUT_PATHS) {
    const surface = surfaceForOutputPath(outPath, built);
    const json = fmt(surface);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    // Skip the write when the on-disk surface already matches (ignoring
    // _generated_at) so re-running on unchanged content leaves files untouched.
    if (fs.existsSync(outPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(outPath, "utf8"));
        if (JSON.stringify(surfaceForComparison(parsed)) === JSON.stringify(surfaceForComparison(surface))) {
          console.log(`[build-bundles] up to date; leaving ${outPath} untouched`);
          continue;
        }
      } catch {
        // Fall through and rewrite malformed output.
      }
    }
    fs.writeFileSync(outPath, json);
  }
  const calTabs = built.calendar?.tabs ? Object.keys(built.calendar.tabs).length : 0;
  const evidenceViews = built.transcript_evidence
    ? `${built.transcript_evidence.weekly?.length || 0} weekly/${built.transcript_evidence.teams?.length || 0} team/${built.transcript_evidence.people?.length || 0} person`
    : "none";
  console.log(`[build-bundles] wrote ${OUT_PATHS.length} surface JSON files, primary=${PRIMARY_OUT_PATH} (${built.teams.length} teams, ${built.people.length} people, ${built.clusters.length} clusters, ${built.dependencies.length} dependencies, ${built.program.length} program pages, ${built.events.length} events, ${built.asks.length} asks, ${built.constellation_cues.length} constellation cues, ${built.session_insights.length} session insights, transcript evidence=${evidenceViews}, transcript distillations=${built.transcript_distillations.artifact_count}, cohort intel=${built.cohort_intel.weekly.length} weeks, ${built.calendar ? `calendar=${calTabs} tabs` : "no calendar"})`);
}

main();
