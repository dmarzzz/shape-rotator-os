#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CALENDAR_PATH = path.join(ROOT, "cohort-data", "calendar.json");
const DEFAULT_POLICY_PATH = path.join(ROOT, "cohort-data", "policies", "transcript-routing-policy.json");
const DEFAULT_OUT_DIR = path.join(ROOT, "cohort-data", ".private", "transcript-vault");
const PRIMARY_TAB = "May 18 Start";
const DEFAULT_YEAR = 2026;
const COHORT_START_DATE = "2026-05-18";
const COHORT_END_DATE = "2026-07-25";
const DAY_COLUMNS = [
  { index: 2, offset: 0 },
  { index: 3, offset: 1 },
  { index: 4, offset: 2 },
  { index: 5, offset: 3 },
  { index: 6, offset: 4 },
  { index: 7, offset: 5 },
  { index: 8, offset: 6 },
];

const MONTHS = new Map([
  ["jan", 0],
  ["january", 0],
  ["feb", 1],
  ["february", 1],
  ["mar", 2],
  ["march", 2],
  ["apr", 3],
  ["april", 3],
  ["may", 4],
  ["jun", 5],
  ["june", 5],
  ["jul", 6],
  ["july", 6],
  ["aug", 7],
  ["august", 7],
  ["sep", 8],
  ["sept", 8],
  ["september", 8],
  ["oct", 9],
  ["october", 9],
  ["nov", 10],
  ["november", 10],
  ["dec", 11],
  ["december", 11],
]);

const STOPWORDS = new Set([
  "and",
  "app",
  "copy",
  "doc",
  "docs",
  "file",
  "for",
  "from",
  "google",
  "group",
  "jan",
  "jun",
  "may",
  "meet",
  "meeting",
  "notes",
  "of",
  "part",
  "private",
  "public",
  "room",
  "the",
  "transcript",
  "txt",
  "with",
]);

const DEFAULT_TYPE_SLUGS = {
  weekly_standup: "weekly_standup",
  office_hours: "office_hours",
  private_1on1: "private_1on1",
  salon: "salon",
  rd_jam: "rd_jam",
  demo_presentation: "demo_presentation",
  user_interview: "user_interview",
  planning_strategy: "planning_strategy",
};

const SESSION_TYPE_TOKENS = {
  weekly_standup: ["weekly", "standup", "status", "wdydlw"],
  office_hours: ["office", "hours", "feedback", "checkpoint", "check", "coaching"],
  private_1on1: ["1on1", "private", "feedback", "checkpoint", "check", "coaching"],
  salon: ["salon", "lecture", "speaker", "founder", "guest", "topic"],
  rd_jam: ["rd", "jam", "whiteboarding", "brainstorm", "workshop", "hangout", "clinic"],
  demo_presentation: ["demo", "presentation", "project", "intro", "intros"],
  user_interview: ["user", "interview", "interviews", "icp", "customer", "research"],
  planning_strategy: ["planning", "strategy", "governance", "ops", "fundraising", "data", "room"],
};

const SOURCE_CONFIDENCE_PCT = {
  high: 92,
  moderate: 76,
  medium: 76,
  low: 52,
  none: 0,
  unknown: 35,
};

function usage() {
  return [
    "Usage:",
    "  node scripts/prepare-transcript-vault-import.mjs --files vault-files.json [--out import-plan.json] [--manifest-out manual-manifest.json] [--summary-out import-summary.md]",
    "",
    "The input may be JSON { rows: [{ drive_file_id, name, url }] }, a JSON array, or copied Drive links.",
    "Outputs are intended for cohort-data/.private/ because they contain private Drive IDs.",
  ].join("\n");
}

function arg(name, argv = process.argv.slice(2)) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

function hasFlag(name, argv = process.argv.slice(2)) {
  return argv.includes(name);
}

function readText(filePath) {
  if (filePath === "-") return fs.readFileSync(0, "utf8");
  return fs.readFileSync(path.resolve(filePath), "utf8");
}

function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value.endsWith("\n") ? value : `${value}\n`);
}

function isoDate(year, monthIndex, day) {
  const date = new Date(Date.UTC(year, monthIndex, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== monthIndex ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value) {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token) && !/^\d+$/.test(token));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function isWithinCohortDate(date) {
  return Boolean(date && date >= COHORT_START_DATE && date <= COHORT_END_DATE);
}

function clampPercent(value, min = 0, max = 100) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function confidencePctForLabel(label) {
  return SOURCE_CONFIDENCE_PCT[String(label || "").toLowerCase()] ?? SOURCE_CONFIDENCE_PCT.unknown;
}

function confidenceLabelForPct(percent) {
  if (percent >= 85) return "high";
  if (percent >= 70) return "moderate";
  if (percent > 0) return "low";
  return "none";
}

function calendarConfidencePct(match = {}) {
  const score = Number(match.score || 0);
  switch (match.status) {
    case "matched":
      return clampPercent((match.confidence === "high" ? 82 : 70) + Math.min(14, Math.floor(score / 6)), 70, 96);
    case "date_only":
      return clampPercent(48 + Math.min(12, Math.floor(score / 5)), 45, 62);
    case "title_only_candidate":
      return clampPercent(45 + Math.min(12, Math.floor(score / 6)), 42, 58);
    case "date_conflict_title_candidate":
      return 35;
    case "no_calendar_block":
      return 25;
    case "unknown_date":
      return 20;
    default:
      return 20;
  }
}

function sourceConfidencePct(sourceInfo = {}) {
  return confidencePctForLabel(sourceInfo.confidence);
}

function hasTypeMarker(name, sessionType) {
  if (!sessionType) return false;
  const escaped = String(sessionType).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(String(name || ""));
}

function includesAnyToken(value, tokens) {
  const normalized = normalizeText(value);
  return (tokens || []).some((token) => normalized.includes(normalizeText(token)));
}

function importantReviewReasons(reasons = []) {
  return (reasons || []).filter((reason) => ![
    "drive_copy_prefix_stripped_in_manifest",
    "visibility_not_labeled_in_filename",
  ].includes(reason));
}

export function confidenceAssessmentForFile({
  file,
  sessionType,
  driveRoute,
  calendarMatch,
  sourceInfo,
  manualReviewReasons = [],
  visibility,
} = {}) {
  if (!sessionType) {
    return {
      schema_version: 1,
      type_pct: 0,
      group_pct: 0,
      understanding_pct: 0,
      calendar_pct: calendarConfidencePct(calendarMatch),
      source_pct: sourceConfidencePct(sourceInfo),
      label: "none",
      basis: {
        type: ["non-transcript/index source"],
        group: ["no transcript route"],
        understanding: ["no transcript understanding produced"],
      },
    };
  }

  const sourceName = `${file?.original_name || ""} ${file?.canonical_name || ""}`;
  const typeTokens = SESSION_TYPE_TOKENS[sessionType] || [];
  const reviewReasons = importantReviewReasons(manualReviewReasons);
  const typeBasis = [];
  const groupBasis = [];
  const understandingBasis = [];

  let typeScore = 55;
  if (hasTypeMarker(`${sourceName} ${file?.preferred_drive_name || ""}`, sessionType)) {
    typeScore += 22;
    typeBasis.push("explicit type marker");
  } else if (includesAnyToken(sourceName, typeTokens)) {
    typeScore += 14;
    typeBasis.push("type keyword match");
  } else {
    typeScore -= 6;
    typeBasis.push("weak title cues");
  }

  if (driveRoute?.path && String(driveRoute.path).includes(sessionType)) {
    typeScore += 8;
    typeBasis.push("route agrees with type");
  }

  const calendarPct = calendarConfidencePct(calendarMatch);
  if (calendarMatch?.status === "matched") {
    typeScore += 16;
    typeBasis.push("calendar matched");
  } else if (calendarMatch?.status === "date_only") {
    typeScore -= 8;
    typeBasis.push("date-only calendar match");
  } else if (calendarMatch?.status === "title_only_candidate") {
    typeScore -= 6;
    typeBasis.push("title-only calendar candidate");
  } else if (calendarMatch?.status === "date_conflict_title_candidate") {
    typeScore -= 20;
    typeBasis.push("calendar date conflict");
  } else if (["unknown_date", "no_calendar_block"].includes(calendarMatch?.status)) {
    typeScore -= 16;
    typeBasis.push("calendar unresolved");
  }

  const calendarScore = Number(calendarMatch?.score || 0);
  if (calendarScore >= 55) {
    typeScore += 6;
    typeBasis.push("strong calendar token score");
  } else if (calendarScore >= 40) {
    typeScore += 3;
    typeBasis.push("moderate calendar token score");
  }

  if (!reviewReasons.length) {
    typeScore += 5;
    typeBasis.push("no manual type hold");
  } else if (reviewReasons.some((reason) => /ambiguous|conflict|unknown|title_only|date_only|missing/i.test(reason))) {
    typeScore -= 6;
    typeBasis.push("manual review reason present");
  }

  const typePct = clampPercent(typeScore, 35, 96);

  let groupScore = Math.round(typePct * 0.72) + 12;
  if (driveRoute?.path && String(driveRoute.path).includes(sessionType)) {
    groupScore += 10;
    groupBasis.push("Drive route matches inferred type");
  } else if (driveRoute?.path === "needs_calendar_match") {
    groupScore -= 18;
    groupBasis.push("held for calendar route");
  } else {
    groupScore -= 4;
    groupBasis.push("route/type agreement is indirect");
  }
  if (
    ["private_1on1", "planning_strategy"].includes(sessionType)
    && String(driveRoute?.path || "").startsWith("do_not_publish")
  ) {
    groupScore += 8;
    groupBasis.push("restrictive private route selected");
  }
  if (calendarMatch?.status === "matched") groupScore += 8;
  else groupScore -= 6;
  if (visibility === "public" && String(driveRoute?.path || "").startsWith("do_not_publish")) {
    groupScore -= 12;
    groupBasis.push("public label conflicts with private route");
  }
  if (reviewReasons.length) groupScore -= 7;
  const groupPct = clampPercent(groupScore, 30, 97);

  const sourcePct = sourceConfidencePct(sourceInfo);
  let understandingScore = Math.round((typePct * 0.35) + (groupPct * 0.25) + (calendarPct * 0.25) + (sourcePct * 0.15));
  understandingBasis.push(`${calendarPct}% calendar confidence`);
  understandingBasis.push(`${sourcePct}% source-system confidence`);
  if (reviewReasons.length) {
    understandingScore -= 8;
    understandingBasis.push("manual review still required");
  }
  if (sourceInfo?.source_system === "ambiguous") {
    understandingScore -= 6;
    understandingBasis.push("ambiguous source-system markers");
  }
  const understandingPct = clampPercent(understandingScore, 25, 96);

  return {
    schema_version: 1,
    type_pct: typePct,
    group_pct: groupPct,
    understanding_pct: understandingPct,
    calendar_pct: calendarPct,
    source_pct: sourcePct,
    label: confidenceLabelForPct(understandingPct),
    basis: {
      type: unique(typeBasis).slice(0, 5),
      group: unique(groupBasis).slice(0, 5),
      understanding: unique(understandingBasis).slice(0, 5),
    },
  };
}

function averagePct(items, key) {
  const values = (items || [])
    .map((item) => Number(item?.[key]))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!values.length) return 0;
  return clampPercent(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function excerpt(value, maxLength = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3).trim()}...`;
}

export function stripCopyPrefix(name) {
  return String(name || "").replace(/^Copy of\s+/i, "").trim();
}

export function vaultIdForName(name) {
  const base = stripCopyPrefix(name)
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/^~+/, "")
    .replace(/1\s*-\s*1/g, "1on1")
    .replace(/1\s*:\s*1/g, "1on1");
  const slug = normalizeText(base)
    .replace(/\b20\d{2}\b/g, "")
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/g, "")
    .split(" ")
    .filter((token) => token && !STOPWORDS.has(token))
    .join("-");
  return slug || "transcript-vault-file";
}

function sourceExtension(name) {
  const ext = path.extname(String(name || "")).toLowerCase();
  if (/^\.[a-z0-9]{1,10}$/.test(ext)) return ext;
  return ".txt";
}

function removeDateWords(value) {
  return String(value || "")
    .replace(/(?:^|[^0-9])~?\d{4}[-_]\d{2}[-_]\d{2}(?!\d)/g, " ")
    .replace(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+[0-3]?\d(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b/gi, " ")
    .replace(/\b\d{4}\b/g, " ");
}

function slugPart(value, fallback = "session") {
  const slug = tokenize(value).join("-");
  return slug || fallback;
}

function projectNameFromFileName(name, sessionType) {
  const withoutExt = stripCopyPrefix(name).replace(/\.[a-z0-9]+$/i, "");
  const withoutDates = removeDateWords(withoutExt);
  const typeTokens = new Set(SESSION_TYPE_TOKENS[sessionType] || []);
  const tokens = tokenize(withoutDates)
    .filter((token) => !typeTokens.has(token))
    .filter((token) => !/^20\d{2}$/.test(token));
  const partMatch = /part\s*[-_ ]?(\d+)\s*[-_ ]*(?:of|\/)\s*[-_ ]*(\d+)/i.exec(withoutDates);
  if (partMatch) {
    tokens.push(`part-${Number(partMatch[1])}-of-${Number(partMatch[2])}`);
  }
  return tokens.join("-");
}

export function canonicalTranscriptName({
  name,
  sessionType,
  date,
  projectName,
  policy,
  extension,
} = {}) {
  const typeSlug = policy?.transcript_naming?.type_slugs?.[sessionType]
    || DEFAULT_TYPE_SLUGS[sessionType]
    || sessionType
    || "unknown";
  const inferredProjectSlug = projectNameFromFileName(name, sessionType);
  const projectSlug = projectName ? slugPart(projectName, "session") : (inferredProjectSlug || "session");
  const dateSlug = date || "unknown-date";
  const ext = extension === false ? "" : (extension || sourceExtension(name));
  return `${typeSlug}_${projectSlug}_${dateSlug}${ext}`;
}

export function driveRouteForSessionType(policy, sessionType) {
  const routes = policy?.drive_vault?.folder_routes || {};
  return routes[sessionType] || routes.unknown || {
    path: "needs_calendar_match",
    derived_path: "needs_calendar_match",
    access_note: "Hold until type, date, and audience are reviewed.",
  };
}

function preferredNameMatches(originalName, preferredName) {
  const originalBase = stripCopyPrefix(originalName)
    .replace(/\.[a-z0-9]+$/i, "")
    .toLowerCase();
  const preferredBase = String(preferredName || "")
    .replace(/\.[a-z0-9]+$/i, "")
    .toLowerCase();
  return originalBase === preferredBase;
}

export function inferDateFromName(name, { defaultYear = DEFAULT_YEAR } = {}) {
  const canonicalName = stripCopyPrefix(name);
  if (/\bunknown-date\b/i.test(canonicalName)) {
    return { date: null, confidence: "none", source: "unknown-date-marker" };
  }

  const iso = /(?:^|[^0-9])~?(\d{4})[-_](\d{2})[-_](\d{2})(?!\d)/.exec(canonicalName);
  if (iso) {
    const date = isoDate(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return date
      ? { date, confidence: "high", source: "iso-filename" }
      : { date: null, confidence: "none", source: "invalid-iso-filename" };
  }

  const monthDay = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+([0-3]?\d)(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i.exec(canonicalName);
  if (!monthDay) return { date: null, confidence: "none", source: "none" };
  const monthIndex = MONTHS.get(monthDay[1].toLowerCase());
  const year = monthDay[3] ? Number(monthDay[3]) : defaultYear;
  const date = isoDate(year, monthIndex, Number(monthDay[2]));
  return date
    ? { date, confidence: monthDay[3] ? "high" : "medium", source: "month-day-filename" }
    : { date: null, confidence: "none", source: "invalid-month-day-filename" };
}

function parseWeekStart(row) {
  const dateCell = String(row?.[1] || "");
  const match = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+([0-3]?\d)/i.exec(dateCell);
  if (!match) return null;
  const monthIndex = MONTHS.get(match[1].toLowerCase());
  return new Date(Date.UTC(DEFAULT_YEAR, monthIndex, Number(match[2])));
}

function addDays(date, offset) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + offset);
  return next;
}

export function calendarBlocksByDate(calendar, { primaryTab = PRIMARY_TAB } = {}) {
  const rows = calendar?.tabs?.[primaryTab] || [];
  const byDate = new Map();
  for (const row of rows.slice(2)) {
    const weekStart = parseWeekStart(row);
    if (!weekStart) continue;
    for (const day of DAY_COLUMNS) {
      const text = String(row[day.index] || "").trim();
      if (!text) continue;
      const date = addDays(weekStart, day.offset).toISOString().slice(0, 10);
      const blocks = byDate.get(date) || [];
      blocks.push(text);
      byDate.set(date, blocks);
    }
  }
  return byDate;
}

function scoreCalendarBlock(nameTokens, blockText) {
  const blockTokens = new Set(tokenize(blockText));
  const hits = nameTokens.filter((token) => blockTokens.has(token));
  const ratio = hits.length / Math.max(1, Math.min(nameTokens.length, 8));
  return {
    score: Math.round(hits.length * 12 + ratio * 40),
    hits: unique(hits),
  };
}

function bestTitleMatch(nameTokens, blocksByDate) {
  let best = null;
  for (const [date, blocks] of blocksByDate.entries()) {
    for (const block of blocks) {
      const score = scoreCalendarBlock(nameTokens, block);
      if (!best || score.score > best.score) {
        best = { date, score: score.score, matched_tokens: score.hits, block_excerpt: excerpt(block) };
      }
    }
  }
  return best;
}

function titleTokensFromName(name) {
  return unique(tokenize(stripCopyPrefix(name).replace(/\.[a-z0-9]+$/i, "")));
}

export function matchCalendarForFile(file, blocksByDate) {
  const nameTokens = titleTokensFromName(file.canonical_name || file.name);
  const dateInfo = inferDateFromName(file.canonical_name || file.name);
  const titleCandidate = nameTokens.length ? bestTitleMatch(nameTokens, blocksByDate) : null;
  const titleCandidateStrong = titleCandidate && titleCandidate.score >= 42;

  if (
    dateInfo.date
    && !isWithinCohortDate(dateInfo.date)
    && titleCandidateStrong
    && isWithinCohortDate(titleCandidate.date)
  ) {
    return {
      status: "matched",
      confidence: titleCandidate.score >= 55 ? "high" : "moderate",
      inferred_date: titleCandidate.date,
      date_source: "calendar-title-correction",
      original_inferred_date: dateInfo.date,
      original_date_source: dateInfo.source,
      date_correction: {
        from: dateInfo.date,
        to: titleCandidate.date,
        reason: "filename_date_outside_cohort_but_title_matches_calendar",
      },
      candidate: titleCandidate,
      ...titleCandidate,
    };
  }

  if (dateInfo.date) {
    const blocks = blocksByDate.get(dateInfo.date) || [];
    let bestOnDate = null;
    for (const block of blocks) {
      const score = scoreCalendarBlock(nameTokens, block);
      if (!bestOnDate || score.score > bestOnDate.score) {
        bestOnDate = {
          date: dateInfo.date,
          score: score.score,
          matched_tokens: score.hits,
          block_excerpt: excerpt(block),
        };
      }
    }
    if (bestOnDate && bestOnDate.score >= 30) {
      return {
        status: "matched",
        confidence: bestOnDate.score >= 55 ? "high" : "moderate",
        inferred_date: dateInfo.date,
        date_source: dateInfo.source,
        ...bestOnDate,
      };
    }
    if (blocks.length) {
      return {
        status: "date_only",
        confidence: "low",
        inferred_date: dateInfo.date,
        date_source: dateInfo.source,
        candidate: titleCandidateStrong ? titleCandidate : null,
        block_excerpt: excerpt(blocks[0]),
        matched_tokens: bestOnDate?.matched_tokens || [],
        score: bestOnDate?.score || 0,
      };
    }
    return {
      status: titleCandidateStrong ? "date_conflict_title_candidate" : "no_calendar_block",
      confidence: titleCandidateStrong ? "low" : "none",
      inferred_date: dateInfo.date,
      date_source: dateInfo.source,
      candidate: titleCandidateStrong ? titleCandidate : null,
      matched_tokens: [],
      score: 0,
    };
  }

  return {
    status: titleCandidateStrong ? "title_only_candidate" : "unknown_date",
    confidence: titleCandidateStrong ? "low" : "none",
    inferred_date: null,
    date_source: dateInfo.source,
    candidate: titleCandidateStrong ? titleCandidate : null,
    matched_tokens: titleCandidateStrong ? titleCandidate.matched_tokens : [],
    score: titleCandidateStrong ? titleCandidate.score : 0,
  };
}

// Coordinator/host names that mark a named coaching/feedback/strategy session as a
// private 1:1. Resolved at runtime so the names are NOT hardcoded in this public repo:
// from TRANSCRIPT_PRIVATE_HOSTS (comma-separated), or — when that is unset — a
// gitignored private file. Returns [] only when neither source is configured.
function resolvePrivateHosts() {
  const fromEnv = (process.env.TRANSCRIPT_PRIVATE_HOSTS || "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (fromEnv.length) return fromEnv;
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(ROOT, "cohort-data", ".private", "transcript-routing-hosts.json"), "utf8"),
    );
    return (Array.isArray(parsed) ? parsed : parsed.private_hosts || [])
      .map((host) => String(host).trim().toLowerCase())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function inferSessionType(name) {
  const normalized = normalizeText(stripCopyPrefix(name));
  if (normalized.includes("transcript index") || normalized.includes("public private map")) return null;
  if (/\b(wdydlw|what did you do|weekly status|standup|retro)\b/.test(normalized)) return "weekly_standup";
  if (/\b(1on1|1 1|one on one|one to one)\b/.test(normalized)) return "private_1on1";
  const privateHosts = resolvePrivateHosts();
  if (
    privateHosts.length
    && new RegExp(`\\b(${privateHosts.join("|")})\\b`).test(normalized)
    && /\b(private|feedback|coaching|positioning|checkpoint|check in|office hours|drop in|funding|fundraising|data room|strategy|ops)\b/.test(normalized)
  ) {
    return "private_1on1";
  }
  if (/\b(funding|fundraising|data room|data-room|ops planning|strategy|governance)\b/.test(normalized)) {
    return "planning_strategy";
  }
  if (/\b(icp|ideal customer|user interview|user interviews|research private inference)\b/.test(normalized)) {
    return "user_interview";
  }
  if (/\b(project intro|project intros|demo|presentation)\b/.test(normalized)) return "demo_presentation";
  if (/\b(salon|lecture|founder|agentic organizations|design thinking|info markets|tutorial|guest|dinner|sorting hat|community dinner|cohort dinner)\b/.test(normalized)) {
    return "salon";
  }
  if (/\b(office hours|office-hours|1on1|1 1|feedback|checkpoint|check in|check-in|drop in|drop-in|pmf|positioning|validation|coaching)\b/.test(normalized)) {
    return "office_hours";
  }
  if (/\b(hackathon|jam|whiteboard|whiteboarding|brainstorm|workflow|pipeline|journey|hangout|flashnet|anarchy|clinic|workshop)\b/.test(normalized)) {
    return "rd_jam";
  }
  return "office_hours";
}

function inferVisibility(name) {
  const normalized = normalizeText(stripCopyPrefix(name));
  if (/\b(public private map|transcript index)\b/.test(normalized)) return "index";
  if (/\b(do not publish|private|fundraising|data room|data-room|ops planning|1on1|1 1|1-1|strategy)\b/.test(normalized)) {
    return "private";
  }
  if (/\bpublic\b/.test(normalized)) return "public";
  return "unlabeled_private_default";
}

function mimeTypeForName(name) {
  if (/\.md$/i.test(name)) return "text/markdown";
  if (/\.txt$/i.test(name)) return "text/plain";
  return "application/octet-stream";
}

function driveUrlForId(id, fallbackUrl) {
  return fallbackUrl || `https://drive.google.com/file/d/${id}/view`;
}

function metadataText(file) {
  return [
    file?.original_name,
    file?.canonical_name,
    file?.drive_url,
    file?.web_view_link,
    file?.web_content_link,
    file?.description,
    file?.mime_type,
    file?.provider,
    file?.source_provider,
    file?.source_system,
    file?.source_kind,
    file?.export_source,
    file?.relative_path,
    ...(Array.isArray(file?.parents) ? file.parents : []),
  ].filter(Boolean).join(" ");
}

function inferOtterSourceKind(file) {
  const explicit = String(file?.source_kind || "").toLowerCase();
  if (["otter_transcript", "otter_summary", "otter_slide"].includes(explicit)) return explicit;
  const normalized = normalizeText(metadataText(file));
  if (/\b(slide|slides|screenshot|screenshots|screen capture|screen captures|image|images)\b/.test(normalized)) return "otter_slide";
  if (/\b(summary|summaries|notes|recap)\b/.test(normalized)) return "otter_summary";
  return "otter_transcript";
}

function inferMeetSourceKind(file) {
  const explicit = String(file?.source_kind || "").toLowerCase();
  if (["meet_transcript", "meet_smart_notes"].includes(explicit)) return explicit;
  const normalized = normalizeText(metadataText(file));
  if (/\b(smart notes|smartnotes|gemini|meeting notes|summary|recap|action items)\b/.test(normalized)) {
    return "meet_smart_notes";
  }
  return "meet_transcript";
}

export function inferTranscriptSourceSystem(file = {}) {
  const raw = metadataText(file);
  const normalized = normalizeText(raw);
  const provider = String(file.provider || file.source_provider || file.source_system || "").toLowerCase();
  const sourceKind = String(file.source_kind || "").toLowerCase();
  const signals = [];

  if (provider === "otter" || sourceKind.startsWith("otter_")) signals.push("explicit_otter_source");
  if (/\botter\b|otter\.ai|otter_ai/.test(raw.toLowerCase()) || /\botter\b/.test(normalized)) {
    signals.push("otter_metadata_marker");
  }

  if (["google_meet", "gmeet", "meet"].includes(provider) || sourceKind.startsWith("meet_")) {
    signals.push("explicit_google_meet_source");
  }
  if (
    /\bgoogle meet\b|\bgmeet\b|meet\.google\.com|conferenceRecords|conference_records/i.test(raw)
    || /\b(gemini|smart notes|smartnotes)\b/.test(normalized)
  ) {
    signals.push("google_meet_metadata_marker");
  }

  const hasOtter = signals.some((signal) => signal.includes("otter"));
  const hasMeet = signals.some((signal) => signal.includes("google_meet"));
  if (hasOtter && !hasMeet) {
    const confidence = signals.includes("explicit_otter_source") ? "high" : "moderate";
    return {
      source_system: "otter",
      provider: "otter",
      source_kind: inferOtterSourceKind(file),
      confidence,
      confidence_pct: confidencePctForLabel(confidence),
      signals: unique(signals),
    };
  }
  if (hasMeet && !hasOtter) {
    const confidence = signals.includes("explicit_google_meet_source") ? "high" : "moderate";
    return {
      source_system: "google_meet",
      provider: "google_meet",
      source_kind: inferMeetSourceKind(file),
      confidence,
      confidence_pct: confidencePctForLabel(confidence),
      signals: unique(signals),
    };
  }
  if (hasOtter && hasMeet) {
    return {
      source_system: "ambiguous",
      provider: "manual",
      source_kind: "drive_doc",
      confidence: "low",
      confidence_pct: confidencePctForLabel("low"),
      signals: unique(signals),
    };
  }
  return {
    source_system: "drive",
    provider: "manual",
    source_kind: "drive_doc",
    confidence: "low",
    confidence_pct: confidencePctForLabel("low"),
    signals: [],
  };
}

export function parseVaultFileInput(input) {
  if (Array.isArray(input)) return input;
  if (input && typeof input === "object") return input.rows || input.files || input.items || [];
  const text = String(input || "");
  try {
    return parseVaultFileInput(JSON.parse(text));
  } catch {
    // Fall through to copied-link parsing.
  }

  const rows = [];
  let pendingName = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const url = /(https?:\/\/\S+)/.exec(line)?.[1] || null;
    const id = /(?:\/d\/|id=|\/file\/d\/)([A-Za-z0-9_-]{10,})/.exec(line)?.[1] || null;
    if (!url || !id) {
      pendingName = line;
      continue;
    }
    const name = line.replace(url, "").trim() || pendingName || null;
    rows.push({ drive_file_id: id, name, url });
    pendingName = null;
  }
  return rows;
}

function normalizeInputFile(row, index) {
  const driveFileId = row.drive_file_id || row.driveFileId || row.id || row.file_id || row.fileId;
  if (!driveFileId) throw new Error(`vault file ${index} is missing drive_file_id`);
  const originalName = row.name || row.title || row.original_name || row.originalName || `drive-file-${index + 1}`;
  const canonicalName = stripCopyPrefix(originalName);
  return {
    drive_file_id: driveFileId,
    drive_url: driveUrlForId(driveFileId, row.url || row.webViewLink || row.web_view_link),
    original_name: originalName,
    canonical_name: canonicalName,
    vault_id: vaultIdForName(canonicalName),
    mime_type: row.mime_type || row.mimeType || mimeTypeForName(canonicalName),
    description: row.description || null,
    web_view_link: row.web_view_link || row.webViewLink || null,
    web_content_link: row.web_content_link || row.webContentLink || null,
    provider: row.provider || null,
    source_provider: row.source_provider || row.sourceProvider || null,
    source_system: row.source_system || row.sourceSystem || null,
    source_kind: row.source_kind || row.sourceKind || row.kind || null,
    export_source: row.export_source || row.exportSource || null,
    relative_path: row.relative_path || row.relativePath || row.path || null,
    parents: Array.isArray(row.parents) ? row.parents : [],
  };
}

function routingForSessionType(policy, sessionType) {
  if (!sessionType) return null;
  const sessionPolicy = policy?.session_types?.[sessionType] || {};
  return {
    policy_key: policy?.policy_key || "transcript-routing",
    policy_version: policy?.version || null,
    source_tier: "T0",
    session_type: sessionType,
    max_tier: sessionPolicy.max_tier || "T1",
    cohort_mode: sessionPolicy.cohort_mode || "review_required",
    public_allowed: !!sessionPolicy.public_allowed,
    raw_allowed_to_server: false,
    default_auto_transcript: !!sessionPolicy.default_auto_transcript,
    required_public_approvals: sessionPolicy.required_public_approvals || [],
  };
}

function reviewReasons({ file, sessionType, visibility, routing, calendarMatch }) {
  const reasons = [];
  if (!sessionType) reasons.push("index_or_non_transcript");
  if (/^Copy of /i.test(file.original_name)) reasons.push("drive_copy_prefix_stripped_in_manifest");
  if (visibility === "unlabeled_private_default") reasons.push("visibility_not_labeled_in_filename");
  if (visibility === "public" && routing && !routing.public_allowed) reasons.push("public_label_exceeds_policy_for_inferred_session_type");
  if (sessionType === "planning_strategy") reasons.push("planning_strategy_stops_at_core");
  if (calendarMatch.status !== "matched") reasons.push(`calendar_${calendarMatch.status}`);
  if (calendarMatch.status === "date_conflict_title_candidate") reasons.push("filename_date_conflicts_with_title_match");
  if (calendarMatch.status === "title_only_candidate") reasons.push("date_missing_title_match_needs_confirmation");
  return reasons;
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item) || "none";
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export function buildTranscriptVaultImportPlan({
  files,
  calendar,
  policy,
  generatedAt = new Date().toISOString(),
  sharedDriveId = null,
  rawFolderId = null,
  rawFolderUrl = rawFolderId ? `https://drive.google.com/drive/folders/${rawFolderId}` : null,
} = {}) {
  if (!Array.isArray(files)) throw new Error("files must be an array");
  const blocksByDate = calendarBlocksByDate(calendar || {});
  const normalizedFiles = files.map(normalizeInputFile);

  const plannedFiles = normalizedFiles.map((file) => {
    const sessionType = inferSessionType(file.canonical_name);
    const visibility = inferVisibility(file.canonical_name);
    const routing = routingForSessionType(policy, sessionType);
    const calendarMatch = matchCalendarForFile(file, blocksByDate);
    const sourceInfo = inferTranscriptSourceSystem(file);
    const preferred_drive_name = sessionType
      ? canonicalTranscriptName({
          name: file.canonical_name,
          sessionType,
          date: calendarMatch.inferred_date,
          policy,
        })
      : null;
    const drive_route = driveRouteForSessionType(policy, sessionType || "unknown");
    const manualReviewReasons = reviewReasons({
      file,
      sessionType,
      visibility,
      routing,
      calendarMatch,
    });
    const confidence = confidenceAssessmentForFile({
      file: { ...file, preferred_drive_name },
      sessionType,
      visibility,
      routing,
      driveRoute: drive_route,
      calendarMatch,
      sourceInfo,
      manualReviewReasons,
    });
    const calendarMatchWithConfidence = {
      ...calendarMatch,
      confidence_pct: confidence.calendar_pct,
    };
    const sourceArtifact = sessionType
      ? {
          kind: sourceInfo.source_kind,
          source_kind: sourceInfo.source_kind,
          source_tier: "T0",
          storage_mode: "external_ref",
          storage_ref: `drive://${file.drive_file_id}`,
          url: file.drive_url,
          mime_type: file.mime_type,
          raw_available_to_server: false,
          source_system: sourceInfo.source_system,
          source_provider: sourceInfo.provider,
          source_confidence: sourceInfo.confidence,
          source_confidence_pct: confidence.source_pct,
          source_signals: sourceInfo.signals,
          inferred_session_type: sessionType,
          inferred_date: calendarMatch.inferred_date,
          target_drive_route: drive_route.path,
          type_confidence_pct: confidence.type_pct,
          group_confidence_pct: confidence.group_pct,
          understanding_confidence_pct: confidence.understanding_pct,
          confidence_assessment: confidence,
        }
      : null;

    return {
      ...file,
      inferred_date: calendarMatch.inferred_date,
      inferred_session_type: sessionType,
      visibility,
      routing,
      preferred_name_pattern: policy?.transcript_naming?.preferred_pattern || "type_project_name_date",
      preferred_drive_name,
      preferred_name_matches: preferred_drive_name
        ? preferredNameMatches(file.original_name, preferred_drive_name)
        : false,
      drive_route,
      calendar_match: calendarMatchWithConfidence,
      source_system: sourceInfo.source_system,
      source_provider: sourceInfo.provider,
      source_confidence: sourceInfo.confidence,
      source_confidence_pct: confidence.source_pct,
      source_signals: sourceInfo.signals,
      type_confidence_pct: confidence.type_pct,
      group_confidence_pct: confidence.group_pct,
      understanding_confidence_pct: confidence.understanding_pct,
      classification_confidence: confidence,
      source_artifact_manifest: sourceArtifact,
      manual_review_reasons: manualReviewReasons,
      needs_manual_review: manualReviewReasons.some((reason) => ![
        "drive_copy_prefix_stripped_in_manifest",
        "visibility_not_labeled_in_filename",
      ].includes(reason)),
    };
  });

  const sourceArtifacts = plannedFiles
    .map((file) => file.source_artifact_manifest)
    .filter(Boolean);
  const counts = {
    total_files: plannedFiles.length,
    transcript_files: sourceArtifacts.length,
    index_files: plannedFiles.filter((file) => !file.inferred_session_type).length,
    matched: plannedFiles.filter((file) => file.calendar_match.status === "matched").length,
    date_only: plannedFiles.filter((file) => file.calendar_match.status === "date_only").length,
    title_only_candidate: plannedFiles.filter((file) => file.calendar_match.status === "title_only_candidate").length,
    date_conflict_title_candidate: plannedFiles.filter((file) => file.calendar_match.status === "date_conflict_title_candidate").length,
    no_calendar_block: plannedFiles.filter((file) => file.calendar_match.status === "no_calendar_block").length,
    unknown_date: plannedFiles.filter((file) => file.calendar_match.status === "unknown_date").length,
    needs_manual_review: plannedFiles.filter((file) => file.needs_manual_review).length,
    public_labeled: plannedFiles.filter((file) => file.visibility === "public").length,
    private_labeled: plannedFiles.filter((file) => file.visibility === "private").length,
    unlabeled_private_default: plannedFiles.filter((file) => file.visibility === "unlabeled_private_default").length,
    by_session_type: countBy(plannedFiles, (file) => file.inferred_session_type || "index"),
    by_max_tier: countBy(plannedFiles, (file) => file.routing?.max_tier || "none"),
    by_calendar_status: countBy(plannedFiles, (file) => file.calendar_match.status),
    by_drive_route: countBy(plannedFiles, (file) => file.drive_route?.path || "none"),
    by_source_system: countBy(plannedFiles, (file) => file.source_system || "none"),
    by_source_kind: countBy(sourceArtifacts, (artifact) => artifact.source_kind || "none"),
    rename_recommended: plannedFiles.filter((file) => file.preferred_drive_name && !file.preferred_name_matches).length,
    confidence_summary: {
      avg_type_confidence_pct: averagePct(plannedFiles, "type_confidence_pct"),
      avg_group_confidence_pct: averagePct(plannedFiles, "group_confidence_pct"),
      avg_understanding_confidence_pct: averagePct(plannedFiles, "understanding_confidence_pct"),
      type_below_70: plannedFiles.filter((file) => Number(file.type_confidence_pct || 0) > 0 && Number(file.type_confidence_pct) < 70).length,
      group_below_70: plannedFiles.filter((file) => Number(file.group_confidence_pct || 0) > 0 && Number(file.group_confidence_pct) < 70).length,
      understanding_below_70: plannedFiles.filter((file) => Number(file.understanding_confidence_pct || 0) > 0 && Number(file.understanding_confidence_pct) < 70).length,
    },
  };

  return {
    generated_at: generatedAt,
    source_drive: {
      shared_drive_id: sharedDriveId,
      raw_folder_id: rawFolderId,
      raw_folder_url: rawFolderUrl,
    },
    policy: {
      policy_key: policy?.policy_key || "transcript-routing",
      version: policy?.version || null,
    },
    naming: {
      preferred_pattern: policy?.transcript_naming?.preferred_pattern || "type_project_name_date",
      example: policy?.transcript_naming?.example || "office_hours_conclave_2026-06-08.txt",
    },
    drive_permissions: {
      shared_drive_name: policy?.drive_vault?.shared_drive_name || "Shape Rotator Transcript Vault",
      admin_role: policy?.drive_vault?.admin_role || "manager",
      admins: policy?.drive_vault?.admins || [],
      root_folders: policy?.drive_vault?.root_folders || {},
    },
    counts,
    files: plannedFiles,
    manual_artifact_manifest: {
      storage_mode: "external_ref",
      source_tier: "T0",
      raw_available_to_server: false,
      artifacts: sourceArtifacts,
    },
  };
}

export function renderMarkdownSummary(plan) {
  const lines = [
    "# Transcript Vault Import Summary",
    "",
    `Generated: ${plan.generated_at}`,
    "",
    "Raw transcript text is not included here. Drive files are represented as external T0 refs.",
    "",
    "## Counts",
    "",
    `- Files in vault inventory: ${plan.counts.total_files}`,
    `- Transcript refs prepared: ${plan.counts.transcript_files}`,
    `- Calendar matched: ${plan.counts.matched}`,
    `- Needs manual review: ${plan.counts.needs_manual_review}`,
    `- Public-labeled files: ${plan.counts.public_labeled}`,
    `- Private-labeled files: ${plan.counts.private_labeled}`,
    `- Unlabeled files defaulted private: ${plan.counts.unlabeled_private_default}`,
    `- Rename recommended: ${plan.counts.rename_recommended}`,
    `- Avg type confidence: ${plan.counts.confidence_summary?.avg_type_confidence_pct || 0}%`,
    `- Avg group confidence: ${plan.counts.confidence_summary?.avg_group_confidence_pct || 0}%`,
    `- Avg understanding confidence: ${plan.counts.confidence_summary?.avg_understanding_confidence_pct || 0}%`,
    "",
    "## Calendar Status",
    "",
  ];
  for (const [status, count] of Object.entries(plan.counts.by_calendar_status)) {
    lines.push(`- ${status}: ${count}`);
  }
  lines.push("", "## Drive Routes", "");
  for (const [route, count] of Object.entries(plan.counts.by_drive_route || {})) {
    lines.push(`- ${route}: ${count}`);
  }
  lines.push("", "## Source Systems", "");
  for (const [sourceSystem, count] of Object.entries(plan.counts.by_source_system || {})) {
    lines.push(`- ${sourceSystem}: ${count}`);
  }
  lines.push("", "## Drive Admins", "");
  for (const admin of plan.drive_permissions?.admins || []) {
    lines.push(`- ${admin.name}: ${admin.email}`);
  }
  lines.push("", "## Manual Review Queue", "");
  lines.push("| Date | Type | Type % | Group % | Understanding % | Calendar | File | Preferred name | Drive route | Reasons |");
  lines.push("| --- | --- | ---: | ---: | ---: | --- | --- | --- | --- | --- |");
  for (const file of plan.files.filter((item) => item.needs_manual_review)) {
    lines.push(
      `| ${file.inferred_date || ""} | ${file.inferred_session_type || "index"} | ${file.type_confidence_pct || 0}% | ${file.group_confidence_pct || 0}% | ${file.understanding_confidence_pct || 0}% | ${file.calendar_match.status} | ${file.canonical_name.replaceAll("|", "\\|")} | ${(file.preferred_drive_name || "").replaceAll("|", "\\|")} | ${(file.drive_route?.path || "").replaceAll("|", "\\|")} | ${file.manual_review_reasons.join(", ").replaceAll("|", "\\|")} |`,
    );
  }
  return lines.join("\n");
}

function main() {
  const argv = process.argv.slice(2);
  if (hasFlag("--help", argv)) {
    console.log(usage());
    return;
  }
  const filesPath = arg("--files", argv);
  if (!filesPath) {
    console.error(usage());
    process.exit(2);
  }
  const outPath = path.resolve(arg("--out", argv) || path.join(DEFAULT_OUT_DIR, "transcript-vault-import-plan.json"));
  const manifestOutPath = arg("--manifest-out", argv)
    ? path.resolve(arg("--manifest-out", argv))
    : path.join(path.dirname(outPath), "manual-drive-artifacts-manifest.json");
  const summaryOutPath = arg("--summary-out", argv)
    ? path.resolve(arg("--summary-out", argv))
    : path.join(path.dirname(outPath), "transcript-vault-import-summary.md");

  const fileInput = readText(filesPath);
  const files = parseVaultFileInput(fileInput);
  const calendar = readJson(arg("--calendar", argv) || DEFAULT_CALENDAR_PATH);
  const policy = readJson(arg("--policy", argv) || DEFAULT_POLICY_PATH);
  const plan = buildTranscriptVaultImportPlan({
    files,
    calendar,
    policy,
    sharedDriveId: arg("--shared-drive-id", argv),
    rawFolderId: arg("--raw-folder-id", argv),
    rawFolderUrl: arg("--raw-folder-url", argv),
  });

  writeJson(outPath, plan);
  writeJson(manifestOutPath, plan.manual_artifact_manifest);
  writeText(summaryOutPath, renderMarkdownSummary(plan));
  console.log(`prepared transcript vault import (${plan.counts.total_files} files, ${plan.counts.matched} matched, ${plan.counts.needs_manual_review} review)`);
  console.log(`wrote ${path.relative(ROOT, outPath)}`);
  console.log(`wrote ${path.relative(ROOT, manifestOutPath)}`);
  console.log(`wrote ${path.relative(ROOT, summaryOutPath)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
