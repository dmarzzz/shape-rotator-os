#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { loadEnvFile } = require("./lib/env-file.cjs");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PLAN_PATH = path.join(ROOT, "cohort-data", ".private", "transcript-vault", "transcript-vault-import-plan.json");
const DEFAULT_CACHE_ROOT = path.join(ROOT, "cohort-data", ".private", "transcript-audit-sources");
const DEFAULT_OUT_PATH = path.join(ROOT, "cohort-data", ".private", "transcript-vault", "transcript-label-audit.json");
const DEFAULT_SUMMARY_OUT = path.join(ROOT, "cohort-data", ".private", "transcript-vault", "transcript-label-audit-summary.md");
const COHORT_START = "2026-05-18";
const COHORT_END = "2026-07-25";

const MONTHS = new Map([
  ["jan", "01"],
  ["january", "01"],
  ["feb", "02"],
  ["february", "02"],
  ["mar", "03"],
  ["march", "03"],
  ["apr", "04"],
  ["april", "04"],
  ["may", "05"],
  ["jun", "06"],
  ["june", "06"],
  ["jul", "07"],
  ["july", "07"],
  ["aug", "08"],
  ["august", "08"],
  ["sep", "09"],
  ["sept", "09"],
  ["september", "09"],
  ["oct", "10"],
  ["october", "10"],
  ["nov", "11"],
  ["november", "11"],
  ["dec", "12"],
  ["december", "12"],
]);

const STOPWORDS = new Set([
  "and",
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
  "part",
  "private",
  "public",
  "room",
  "session",
  "the",
  "transcript",
  "txt",
  "with",
]);

const TYPE_PATTERNS = {
  weekly_standup: [
    /\bwdydlw\b/i,
    /\bwhat did you do last week\b/i,
    /\bstandup\b/i,
    /\bstatus update\b/i,
    /\blast week\b/i,
  ],
  office_hours: [
    /\boffice hours?\b/i,
    /\bfeedback\b/i,
    /\bcheckpoint\b/i,
    /\bcheck[- ]?in\b/i,
    /\bpmf\b/i,
    /\bproduct market fit\b/i,
    /\bmarket validation\b/i,
    /\bcoaching\b/i,
    /\bsupport\b/i,
  ],
  private_1on1: [
    /\bprivate[_ -]?1on1\b/i,
    /\b1[: -]?on[: -]?1\b/i,
    /\bone[- ]on[- ]one\b/i,
    /\bfundraising\b/i,
    /\bfunding\b/i,
    /\bdata[- ]?room\b/i,
    /\bcohort ops\b/i,
    /\bstrategy\b/i,
    /\bprivate feedback\b/i,
  ],
  salon: [
    /\bsalon\b/i,
    /\bfounder'?s? journey\b/i,
    /\bguest\b/i,
    /\bhosted by\b/i,
    /\blecture\b/i,
    /\btopic[- ]led\b/i,
    /\bdinner\b/i,
    /\bdesign thinking\b/i,
    /\bagentic organizations\b/i,
  ],
  rd_jam: [
    /\brd[_ -]?jam\b/i,
    /\br&d\b/i,
    /\bjam\b/i,
    /\bbrainstorm\b/i,
    /\bwhiteboard(?:ing)?\b/i,
    /\bhackathon\b/i,
    /\bworkshop\b/i,
    /\bclinic\b/i,
    /\bhangout\b/i,
    /\bprototype\b/i,
    /\bpipeline\b/i,
    /\bjourney\b/i,
  ],
  demo_presentation: [
    /\bdemo\b/i,
    /\bpresentation\b/i,
    /\bproject intros?\b/i,
    /\bshowcase\b/i,
    /\bintro\b/i,
  ],
  user_interview: [
    /\buser interviews?\b/i,
    /\bicp\b/i,
    /\bideal customer\b/i,
    /\bcustomer research\b/i,
    /\binterview\b/i,
    /\bprivate inference\b/i,
  ],
  planning_strategy: [
    /\bplanning\b/i,
    /\bstrategy\b/i,
    /\bgovernance\b/i,
    /\bops planning\b/i,
    /\bfundraising\b/i,
    /\bdata[- ]?room\b/i,
  ],
};

function usage() {
  return [
    "Usage:",
    "  node scripts/audit-transcript-labels.mjs [--env-file .env.calendar.local] [--fetch] [--refresh]",
    "    [--plan transcript-vault-import-plan.json] [--cache-root DIR] [--out audit.json] [--summary-out summary.md]",
    "",
    "Fetches transcript text into ignored private storage and emits a metadata-only label/order audit.",
    "Raw transcript text is never written to stdout or the audit summary.",
  ].join("\n");
}

function arg(name, argv = process.argv.slice(2)) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

function hasFlag(name, argv = process.argv.slice(2)) {
  return argv.includes(name);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value.endsWith("\n") ? value : `${value}\n`);
}

function safeFileName(value, fallback = "transcript.txt") {
  const base = path.basename(String(value || fallback))
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
  return base || fallback;
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
  return [...new Set((values || []).filter(Boolean))];
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function localRelativePath(file) {
  const dir = safeFileName(file.vault_id || file.drive_file_id || "unknown-source", "unknown-source");
  const name = safeFileName(file.preferred_drive_name || file.original_name || "transcript.txt");
  return path.join("drive", dir, name);
}

function assertInsideRoot(filePath, rootPath) {
  const root = path.resolve(rootPath);
  const target = path.resolve(filePath);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("resolved transcript path escapes transcript audit root");
  }
}

async function refreshGoogleAccessToken({
  clientId,
  clientSecret,
  refreshToken,
  fetchImpl = fetch,
} = {}) {
  if (!clientId || !clientSecret || !refreshToken) return null;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`Google OAuth token refresh failed: ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data?.access_token || null;
}

async function resolveGoogleAccessToken({
  accessToken,
  clientId,
  clientSecret,
  refreshToken,
  fetchImpl = fetch,
} = {}) {
  if (refreshToken && clientId && clientSecret) {
    const refreshed = await refreshGoogleAccessToken({ clientId, clientSecret, refreshToken, fetchImpl });
    if (refreshed) return refreshed;
  }
  return accessToken || null;
}

async function driveJson(url, accessToken, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`Google Drive request failed: ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data;
}

function driveMetadataUrl(fileId) {
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("fields", "id,name,mimeType,size,createdTime,modifiedTime,md5Checksum");
  url.searchParams.set("supportsAllDrives", "true");
  return url;
}

function driveContentUrl(metadata) {
  const fileId = metadata?.id;
  if (!fileId) throw new Error("Drive metadata missing id");
  if (metadata.mimeType === "application/vnd.google-apps.document") {
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export`);
    url.searchParams.set("mimeType", "text/plain");
    return url;
  }
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");
  return url;
}

async function fetchDriveFile(fileId, accessToken, { fetchImpl = fetch } = {}) {
  const metadata = await driveJson(driveMetadataUrl(fileId), accessToken, { fetchImpl });
  const response = await fetchImpl(driveContentUrl(metadata), {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    const detail = bytes.toString("utf8").slice(0, 500);
    const error = new Error(`Google Drive download failed: ${response.status}`);
    error.status = response.status;
    error.body = detail;
    throw error;
  }
  return {
    metadata,
    buffer: bytes,
    mime_type: metadata.mimeType === "application/vnd.google-apps.document"
      ? "text/plain"
      : (metadata.mimeType || response.headers.get("content-type") || "application/octet-stream"),
  };
}

function titleTokensForFile(file) {
  const withoutExt = String(file.preferred_drive_name || file.original_name || "")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/^\d{4}-\d{2}-\d{2}[_ -]+/i, "")
    .replace(/_\d{4}-\d{2}-\d{2}$/i, "")
    .replace(/^(weekly_standup|office_hours|private_1on1|salon|rd_jam|demo_presentation|user_interview|planning_strategy)[_-]+/i, "")
    .replace(/\bpart[-_ ]?\d+\s*(?:of|-)\s*\d+\b/gi, "");
  return unique(tokenize(withoutExt));
}

function tokenHitPct(tokens, normalizedText) {
  const relevant = unique(tokens).filter((token) => token.length >= 3);
  if (!relevant.length) return 0;
  const hits = relevant.filter((token) => normalizedText.includes(token));
  return Math.round((hits.length / relevant.length) * 100);
}

function countRegexHits(patterns, text) {
  let count = 0;
  for (const pattern of patterns) {
    if (pattern.test(text)) count += 1;
  }
  return count;
}

function typeScoresForText(file, text) {
  const haystack = `${file.original_name || ""}\n${file.preferred_drive_name || ""}\n${text || ""}`;
  const scores = Object.entries(TYPE_PATTERNS).map(([type, patterns]) => {
    let score = countRegexHits(patterns, haystack);
    if (String(file.preferred_drive_name || file.original_name || "").startsWith(`${type}_`)) score += 4;
    if (file.inferred_session_type === type) score += 1;
    return { type, score };
  }).sort((a, b) => b.score - a.score || a.type.localeCompare(b.type));
  return scores;
}

function speakerStats(text) {
  const speakers = new Set();
  let speakerLines = 0;
  const regex = /^\s*([A-Z][A-Za-z0-9 ._'()-]{1,48}):\s+\S/gm;
  let match = null;
  while ((match = regex.exec(text || ""))) {
    speakerLines += 1;
    speakers.add(match[1].trim());
  }
  return {
    speaker_line_count: speakerLines,
    distinct_speaker_count: speakers.size,
  };
}

function timestampCount(text) {
  const matches = String(text || "").match(/(?:^|\n)\s*(?:\[\s*)?\d{1,2}:\d{2}(?::\d{2})?(?:\s*\])?\s+/g);
  return matches ? matches.length : 0;
}

function normalizeMonthDate(month, day, year = "2026") {
  const monthNumber = MONTHS.get(String(month || "").toLowerCase());
  const dayNumber = Number(day);
  if (!monthNumber || !Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > 31) return null;
  return `${year}-${monthNumber}-${String(dayNumber).padStart(2, "0")}`;
}

function dateMentions(text) {
  const mentions = new Set();
  const sample = String(text || "").slice(0, 6000);
  for (const match of sample.matchAll(/\b(2026-\d{2}-\d{2})\b/g)) {
    mentions.add(match[1]);
  }
  for (const match of sample.matchAll(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+([0-3]?\d)(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/gi)) {
    const normalized = normalizeMonthDate(match[1], match[2], match[3] || "2026");
    if (normalized) mentions.add(normalized);
  }
  return [...mentions].sort();
}

function isWithinCohort(date) {
  return Boolean(date && date >= COHORT_START && date <= COHORT_END);
}

function parsePartInfo(name) {
  const match = String(name || "").match(/\bpart[-_ ]?(\d+)[-_ ]*(?:of|-)[-_ ]*(\d+)(?!\d)/i);
  if (!match) return null;
  return {
    part: Number(match[1]),
    total: Number(match[2]),
  };
}

function multipartKey(file) {
  return String(file.preferred_drive_name || file.original_name || "")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/\bpart[-_ ]?\d+[-_ ]*(?:of|-)[-_ ]*\d+(?!\d)/gi, "part")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function reviewNotesForItem({ file, text, contentStatus, typeScores, titleHitPct, dateHits, partInfo }) {
  const notes = [];
  const topType = typeScores[0] || { type: null, score: 0 };
  const runnerUp = typeScores[1] || { type: null, score: 0 };
  const candidateDate = file.calendar_match?.candidate?.date || null;

  if (contentStatus !== "available") notes.push("content_not_available");
  if (file.calendar_match?.status === "date_conflict_title_candidate") notes.push("calendar_date_conflict");
  if (file.calendar_match?.status === "unknown_date") notes.push("unknown_date");
  if (file.calendar_match?.status === "title_only_candidate") notes.push("title_only_calendar_candidate");
  if (file.calendar_match?.status === "date_only") notes.push("calendar_date_only");
  if (file.inferred_date && !isWithinCohort(file.inferred_date) && candidateDate && isWithinCohort(candidateDate)) {
    notes.push("filename_date_outside_cohort_but_title_matches_cohort_calendar");
  }
  if (dateHits.length && file.inferred_date && !dateHits.includes(file.inferred_date)) {
    notes.push("content_date_mentions_do_not_include_inferred_date");
  }
  if (topType.score >= 6 && topType.type !== file.inferred_session_type && topType.score >= runnerUp.score + 2) {
    notes.push("content_type_signal_conflicts_with_label");
  }
  if (titleHitPct < 35 && text) notes.push("low_title_token_presence_in_transcript");
  if (partInfo && (!Number.isInteger(partInfo.part) || !Number.isInteger(partInfo.total) || partInfo.part < 1 || partInfo.part > partInfo.total)) {
    notes.push("invalid_multipart_numbering");
  }
  return unique(notes);
}

async function buildAudit(plan, {
  cacheRoot = DEFAULT_CACHE_ROOT,
  fetchEnabled = false,
  refresh = false,
  accessToken,
  clientId,
  clientSecret,
  refreshToken,
  fetchImpl = fetch,
} = {}) {
  const generatedAt = new Date().toISOString();
  const root = path.resolve(cacheRoot);
  const token = fetchEnabled
    ? await resolveGoogleAccessToken({ accessToken, clientId, clientSecret, refreshToken, fetchImpl })
    : null;
  if (fetchEnabled && !token) throw new Error("Google access token or OAuth refresh credentials are required");

  const items = [];
  for (const file of plan.files || []) {
    if (!file.preferred_drive_name || !file.inferred_session_type) continue;
    const localRelative = localRelativePath(file);
    const localPath = path.join(root, localRelative);
    assertInsideRoot(localPath, root);
    let contentStatus = fs.existsSync(localPath) ? "cached" : "missing";
    let fetchStatus = refresh ? "refresh_requested" : "not_requested";
    let driveMetadata = null;
    let sourceHash = null;

    if (fetchEnabled && file.drive_file_id && (refresh || !fs.existsSync(localPath))) {
      try {
        const fetched = await fetchDriveFile(file.drive_file_id, token, { fetchImpl });
        fs.mkdirSync(path.dirname(localPath), { recursive: true });
        fs.writeFileSync(localPath, fetched.buffer);
        driveMetadata = {
          name: fetched.metadata?.name || null,
          mime_type: fetched.metadata?.mimeType || null,
          created_time: fetched.metadata?.createdTime || null,
          modified_time: fetched.metadata?.modifiedTime || null,
          size_bytes: fetched.buffer.length,
        };
        sourceHash = `sha256:${sha256(fetched.buffer)}`;
        contentStatus = "available";
        fetchStatus = "fetched";
      } catch (error) {
        contentStatus = fs.existsSync(localPath) ? "cached_after_fetch_error" : "fetch_failed";
        fetchStatus = "failed";
        driveMetadata = {
          error: error?.body?.error_description
            || error?.body?.error?.message
            || error?.message
            || String(error),
        };
      }
    }

    const text = fs.existsSync(localPath) ? fs.readFileSync(localPath, "utf8") : "";
    if (text && contentStatus === "cached") contentStatus = "available";
    const normalizedText = normalizeText(text);
    const titleTokens = titleTokensForFile(file);
    const titleHit = tokenHitPct(titleTokens, normalizedText);
    const typeScores = typeScoresForText(file, text);
    const dateHits = dateMentions(text);
    const partInfo = parsePartInfo(file.preferred_drive_name || file.original_name);
    const notes = reviewNotesForItem({
      file,
      text,
      contentStatus,
      typeScores,
      titleHitPct: titleHit,
      dateHits,
      partInfo,
    });
    const speaker = speakerStats(text);
    const wordCount = text ? tokenize(text).length : 0;
    const currentSortKey = [
      file.inferred_date || "unknown",
      file.inferred_session_type || "unknown",
      file.preferred_drive_name || file.original_name || "",
    ].join("|");
    const recommendedDate = file.inferred_date && !isWithinCohort(file.inferred_date) && isWithinCohort(file.calendar_match?.candidate?.date)
      ? file.calendar_match.candidate.date
      : file.inferred_date || null;
    const recommendedSortKey = [
      recommendedDate || "unknown",
      file.inferred_session_type || "unknown",
      file.preferred_drive_name || file.original_name || "",
    ].join("|");

    items.push({
      drive_file_id: file.drive_file_id,
      original_name: file.original_name,
      preferred_drive_name: file.preferred_drive_name,
      inferred_date: file.inferred_date || null,
      recommended_date: recommendedDate,
      inferred_session_type: file.inferred_session_type,
      drive_route: file.drive_route?.path || null,
      calendar_status: file.calendar_match?.status || null,
      calendar_candidate_date: file.calendar_match?.candidate?.date || null,
      calendar_candidate_score: file.calendar_match?.candidate?.score || null,
      type_confidence_pct: file.type_confidence_pct,
      group_confidence_pct: file.group_confidence_pct,
      understanding_confidence_pct: file.understanding_confidence_pct,
      content_status: contentStatus,
      fetch_status: fetchStatus,
      local_relative_path: text ? localRelative.replace(/\\/g, "/") : null,
      drive_metadata: driveMetadata,
      source_hash: sourceHash,
      content_shape: {
        word_count: wordCount,
        timestamp_count: timestampCount(text),
        ...speaker,
      },
      title_token_hit_pct: titleHit,
      date_mentions: dateHits,
      type_scores: typeScores.slice(0, 4),
      top_content_type: typeScores[0]?.score > 0 ? typeScores[0].type : null,
      top_content_type_score: typeScores[0]?.score || 0,
      multipart: partInfo,
      multipart_key: partInfo ? multipartKey(file) : null,
      current_sort_key: currentSortKey,
      recommended_sort_key: recommendedSortKey,
      review_notes: notes,
      audit_status: notes.some((note) => /conflict|unknown|failed|outside|invalid/i.test(note))
        ? "needs_review"
        : notes.length
          ? "low_confidence"
          : "ok",
    });
  }

  const multipartGroups = [];
  const byPartKey = new Map();
  for (const item of items.filter((entry) => entry.multipart)) {
    const list = byPartKey.get(item.multipart_key) || [];
    list.push(item);
    byPartKey.set(item.multipart_key, list);
  }
  for (const [key, group] of byPartKey.entries()) {
    const expectedTotal = Math.max(...group.map((item) => item.multipart.total || 0));
    const parts = group.map((item) => item.multipart.part).sort((a, b) => a - b);
    const missing = [];
    for (let index = 1; index <= expectedTotal; index += 1) {
      if (!parts.includes(index)) missing.push(index);
    }
    multipartGroups.push({
      key,
      expected_total: expectedTotal,
      parts,
      missing,
      ordered_names: group
        .slice()
        .sort((a, b) => a.multipart.part - b.multipart.part)
        .map((item) => item.preferred_drive_name),
      status: missing.length ? "needs_review" : "ok",
    });
  }

  const counts = {
    files_audited: items.length,
    content_available: items.filter((item) => item.content_status === "available").length,
    fetch_failed: items.filter((item) => item.fetch_status === "failed").length,
    needs_review: items.filter((item) => item.audit_status === "needs_review").length,
    low_confidence: items.filter((item) => item.audit_status === "low_confidence").length,
    ok: items.filter((item) => item.audit_status === "ok").length,
    suspected_date_corrections: items.filter((item) => item.review_notes.includes("filename_date_outside_cohort_but_title_matches_cohort_calendar")).length,
    content_type_conflicts: items.filter((item) => item.review_notes.includes("content_type_signal_conflicts_with_label")).length,
    multipart_groups: multipartGroups.length,
    multipart_groups_with_gaps: multipartGroups.filter((group) => group.status !== "ok").length,
  };

  return {
    generated_at: generatedAt,
    plan_generated_at: plan.generated_at || null,
    cache_root: root,
    raw_text_policy: "Raw transcript text is cached only under cache_root and is not included in this audit JSON or summary.",
    counts,
    items,
    multipart_groups: multipartGroups,
  };
}

function renderSummary(audit) {
  const lines = [
    "# Transcript Label Audit Summary",
    "",
    `Generated: ${audit.generated_at}`,
    "",
    "Raw transcript text is not included here. Cached text, when fetched, lives only under the private audit cache root.",
    "",
    "## Counts",
    "",
    `- Files audited: ${audit.counts.files_audited}`,
    `- Content available: ${audit.counts.content_available}`,
    `- Fetch failed: ${audit.counts.fetch_failed}`,
    `- OK: ${audit.counts.ok}`,
    `- Low confidence: ${audit.counts.low_confidence}`,
    `- Needs review: ${audit.counts.needs_review}`,
    `- Suspected date corrections: ${audit.counts.suspected_date_corrections}`,
    `- Content type conflicts: ${audit.counts.content_type_conflicts}`,
    `- Multipart groups: ${audit.counts.multipart_groups}`,
    `- Multipart groups with gaps: ${audit.counts.multipart_groups_with_gaps}`,
    "",
    "## Review Items",
    "",
    "| Status | File | Current | Recommended | Label | Type top | Title hit | Notes |",
    "| --- | --- | --- | --- | --- | --- | ---: | --- |",
  ];

  const reviewItems = audit.items
    .filter((item) => item.audit_status !== "ok")
    .sort((a, b) => {
      const rank = { needs_review: 0, low_confidence: 1, ok: 2 };
      return (rank[a.audit_status] ?? 9) - (rank[b.audit_status] ?? 9)
        || String(a.recommended_date || a.inferred_date || "").localeCompare(String(b.recommended_date || b.inferred_date || ""))
        || String(a.preferred_drive_name).localeCompare(String(b.preferred_drive_name));
    });

  for (const item of reviewItems) {
    lines.push([
      item.audit_status,
      item.preferred_drive_name || item.original_name || "",
      item.inferred_date || "unknown",
      item.recommended_date || "unknown",
      item.inferred_session_type || "",
      item.top_content_type ? `${item.top_content_type} (${item.top_content_type_score})` : "",
      `${item.title_token_hit_pct}%`,
      item.review_notes.join(", "),
    ].map((cell) => String(cell).replaceAll("|", "\\|")).join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }

  if (!reviewItems.length) lines.push("| ok | No review items |  |  |  |  |  |  |");

  lines.push("", "## Multipart Groups", "", "| Status | Group | Parts | Missing |", "| --- | --- | --- | --- |");
  for (const group of audit.multipart_groups) {
    lines.push(`| ${group.status} | ${group.key.replaceAll("|", "\\|")} | ${group.parts.join(", ")} / ${group.expected_total} | ${group.missing.join(", ")} |`);
  }
  if (!audit.multipart_groups.length) lines.push("| ok | No multipart groups |  |  |");

  return lines.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag("--help", argv)) {
    console.log(usage());
    return;
  }

  const envFile = arg("--env-file", argv);
  if (envFile) loadEnvFile(envFile, { cwd: ROOT });

  const planPath = path.resolve(arg("--plan", argv) || DEFAULT_PLAN_PATH);
  const cacheRoot = path.resolve(arg("--cache-root", argv) || DEFAULT_CACHE_ROOT);
  const outPath = path.resolve(arg("--out", argv) || DEFAULT_OUT_PATH);
  const summaryOut = path.resolve(arg("--summary-out", argv) || DEFAULT_SUMMARY_OUT);
  const audit = await buildAudit(readJson(planPath), {
    cacheRoot,
    fetchEnabled: hasFlag("--fetch", argv),
    refresh: hasFlag("--refresh", argv),
    accessToken: arg("--access-token", argv) || process.env.GOOGLE_ACCESS_TOKEN || process.env.GOOGLE_CALENDAR_ACCESS_TOKEN,
    clientId: arg("--client-id", argv) || process.env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: arg("--client-secret", argv) || process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    refreshToken: arg("--refresh-token", argv) || process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
  });

  writeJson(outPath, audit);
  writeText(summaryOut, renderSummary(audit));
  console.log(`audited ${audit.counts.files_audited} transcripts (${audit.counts.content_available} content available, ${audit.counts.needs_review} needs review)`);
  console.log(`wrote ${path.relative(ROOT, outPath)}`);
  console.log(`wrote ${path.relative(ROOT, summaryOut)}`);
  if (audit.counts.fetch_failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.message || String(error));
    process.exit(1);
  });
}

export {
  buildAudit,
  renderSummary,
  titleTokensForFile,
  typeScoresForText,
};
