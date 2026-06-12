#!/usr/bin/env node
/**
 * build-bundles.js — markdown source of truth → cohort surface JSON.
 *
 * Phase 1 implementation per docs/SHAPE-ROTATOR-OS-SPEC.md §4.4 §6:
 * reads cohort-data/{teams,people,clusters,dependencies}/*.md, applies the surface-
 * fields whitelist from cohort-data/schema.yml, writes
 * apps/os/src/cohort-surface.json. The depth side (encrypted
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

const REPO_ROOT  = path.resolve(__dirname, "..");
const COHORT_DIR = path.join(REPO_ROOT, "cohort-data");
const OUT_PATH   = path.join(REPO_ROOT, "apps", "os", "src", "cohort-surface.json");

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

function buildPersonTimeline({ people, teams, asks, events, calendar }) {
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

    timeline[person.record_id] = sortTimeline(items).slice(0, 28);
  }

  return timeline;
}

function buildTeamTimeline({ teams, people, asks, events, calendar, githubProgressArtifacts = [] }) {
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
    person_timeline: buildPersonTimeline({ people, teams, asks, events, calendar }),
    team_timeline: buildTeamTimeline({ teams, people, asks, events, calendar, githubProgressArtifacts: github_progress_artifacts }),
    cohort_vocab,
    constellation_cues,
    session_insights,
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

  const json = fmt(built);

  if (check) {
    if (!fs.existsSync(OUT_PATH)) {
      console.error(`[build-bundles] --check: ${OUT_PATH} does not exist`);
      process.exit(3);
    }
    const current = fs.readFileSync(OUT_PATH, "utf8");
    // Compare structurally (ignoring _generated_at) so re-running on
    // the same content doesn't trip --check.
    const a = surfaceForComparison(JSON.parse(current));
    const b = surfaceForComparison(built);
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      console.error(`[build-bundles] --check: ${OUT_PATH} is stale; run \`npm run build:cohort\` and commit`);
      process.exit(4);
    }
    console.log(`[build-bundles] --check: surface JSON is up to date`);
    return;
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  if (fs.existsSync(OUT_PATH)) {
    const current = fs.readFileSync(OUT_PATH, "utf8");
    try {
      const parsed = JSON.parse(current);
      if (JSON.stringify(surfaceForComparison(parsed)) === JSON.stringify(surfaceForComparison(built))) {
        console.log(`[build-bundles] up to date; leaving ${OUT_PATH} untouched`);
        return;
      }
    } catch {
      // Fall through and rewrite malformed output.
    }
  }
  fs.writeFileSync(OUT_PATH, json);
  const calTabs = built.calendar?.tabs ? Object.keys(built.calendar.tabs).length : 0;
  console.log(`[build-bundles] wrote ${OUT_PATH} (${built.teams.length} teams, ${built.people.length} people, ${built.clusters.length} clusters, ${built.dependencies.length} dependencies, ${built.program.length} program pages, ${built.events.length} events, ${built.asks.length} asks, ${built.constellation_cues.length} constellation cues, ${built.session_insights.length} session insights, ${built.calendar ? `calendar=${calTabs} tabs` : "no calendar"})`);
}

main();
