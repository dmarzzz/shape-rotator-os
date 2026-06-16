#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { collectIcsEvents } = require("./build-ics.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CALENDAR_PATH = path.join(ROOT, "cohort-data", "calendar.json");
const DEFAULT_IMPORT_PLAN_PATH = path.join(ROOT, "cohort-data", ".private", "transcript-vault", "transcript-vault-import-plan.json");
const DEFAULT_SESSION_MAP_PATH = path.join(ROOT, "cohort-data", ".private", "transcript-vault", "transcript-session-map.json");
const DEFAULT_SUPABASE_PLAN_PATH = path.join(ROOT, "cohort-data", ".private", "transcript-vault", "transcript-supabase-plan.json");
const DEFAULT_FETCH_MANIFEST_PATH = path.join(ROOT, "cohort-data", ".private", "transcript-vault", "transcript-drive-fetch-manifest.json");
const DEFAULT_DRIVE_OPERATIONS_PATH = path.join(ROOT, "cohort-data", ".private", "transcript-vault", "drive-operations-plan.json");
const DEFAULT_DRIVE_APPLY_RESULT_PATH = path.join(ROOT, "cohort-data", ".private", "transcript-vault", "drive-operations-apply-result.json");
const DEFAULT_READOUT_DIR = path.join(ROOT, "cohort-data", "session-readouts");
const DEFAULT_PUBLIC_OUT = path.join(ROOT, "docs", "transcript-calendar-coverage-index.md");
const DEFAULT_PRIVATE_OUT = path.join(ROOT, "cohort-data", ".private", "transcript-vault", "transcript-calendar-coverage-audit.md");
const DEFAULT_JSON_OUT = path.join(ROOT, "cohort-data", ".private", "transcript-vault", "transcript-calendar-coverage-audit.json");
function localDateString(date = new Date()) {
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 10);
}

const DEFAULT_AUDIT_DATE = localDateString();

const STOPWORDS = new Set([
  "about",
  "after",
  "agent",
  "agents",
  "and",
  "are",
  "auditorium",
  "build",
  "center",
  "cohort",
  "copy",
  "day",
  "demo",
  "doc",
  "docs",
  "file",
  "for",
  "from",
  "google",
  "group",
  "hours",
  "into",
  "jam",
  "jun",
  "may",
  "meet",
  "meeting",
  "notes",
  "office",
  "part",
  "presentation",
  "private",
  "project",
  "public",
  "room",
  "salon",
  "session",
  "shape",
  "the",
  "transcript",
  "txt",
  "with",
]);

const TRANSCRIPT_METADATA_CORRECTIONS = {
  "1hadEvWnIGsmFhaWnoGFFLLx5ypghRNuW": {
    preferred_drive_name: "salon_shape-rotator-project-map-guests_2026-05-22.txt",
    session_type: "salon",
    drive_route: "raw_transcripts/salon",
    derived_route: "operator_review_exports/salon",
    calendar_status: "manual_correction",
    calendar_confidence: "operator_verified",
    candidate_date: "2026-05-22",
    needs_manual_review: false,
    manual_review_reasons: [],
    link_status: "safe_link",
    preferred_name_verified: true,
    drive_apply_action: "updated",
    drive_apply_verified: true,
    manual_correction: "Corrected from office_hours to salon after live Drive move.",
  },
};

const EVENT_LINK_OVERRIDES = [
  {
    date: "2026-05-22",
    title: "Introduce Tina + interactive recap / Project Mappings",
    transcript_drive_file_ids: ["1hadEvWnIGsmFhaWnoGFFLLx5ypghRNuW"],
    readout_vault_ids: ["shape-rotator-project-map-guests-2026-05-22"],
  },
];

function usage() {
  return [
    "Usage:",
    "  node scripts/audit-transcript-calendar-coverage.mjs [--audit-date YYYY-MM-DD] [--public-out docs/transcript-calendar-coverage-index.md] [--private-out cohort-data/.private/transcript-vault/transcript-calendar-coverage-audit.md]",
    "",
    "Builds a safe calendar/session transcript coverage index from calendar.json and transcript vault metadata.",
    "It never reads raw transcript text.",
  ].join("\n");
}

function arg(name, argv = process.argv.slice(2)) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

function hasFlag(name, argv = process.argv.slice(2)) {
  return argv.includes(name);
}

function readJson(filePath, fallback = null) {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) return fallback;
  return JSON.parse(fs.readFileSync(absPath, "utf8"));
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value.endsWith("\n") ? value : `${value}\n`);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
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

function tokens(value) {
  const baseTokens = normalizeText(value)
    .split(" ")
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token) && !/^\d+$/.test(token));
  return unique(baseTokens.flatMap(tokenVariants));
}

function tokenVariants(token) {
  const variants = [token];
  if (token.endsWith("ies") && token.length > 4) variants.push(`${token.slice(0, -3)}y`);
  if (token.endsWith("s") && token.length > 4) variants.push(token.slice(0, -1));
  if (token.endsWith("pping") && token.length > 6) variants.push(token.slice(0, -4));
  if (token.endsWith("ing") && token.length > 5) variants.push(token.slice(0, -3));
  if (token.endsWith("ed") && token.length > 5) variants.push(token.slice(0, -2));
  return unique(variants).filter((item) => item.length >= 3 && !STOPWORDS.has(item));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function slug(value) {
  return normalizeText(value).replace(/\s+/g, "-").replace(/^-|-$/g, "") || "session";
}

function escapeMd(value) {
  return String(value ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replace(/\r?\n/g, "<br>");
}

function dateOfEvent(event) {
  return event.date.toISOString().slice(0, 10);
}

function formatMinutes(minutes) {
  if (!Number.isFinite(minutes)) return "";
  const normalized = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

function eventTimeLabel(event) {
  if (event.timeKind !== "timed") return "all day";
  return `${formatMinutes(event.startMinutes)}-${formatMinutes(event.endMinutes)}`;
}

function eventTitle(event) {
  return String(event.summary || "").replace(/\s+/g, " ").trim();
}

function eventText(event) {
  return [event.summary, event.description].filter(Boolean).join(" ");
}

function firstLine(value) {
  return String(value || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items || []) {
    const key = keyFn(item) || "none";
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function scoreText(left, right) {
  const leftTokens = unique(tokens(left));
  const rightTokens = new Set(tokens(right));
  const matchedTokens = leftTokens.filter((token) => rightTokens.has(token));
  const denominator = Math.max(1, Math.min(leftTokens.length, 8));
  const ratio = matchedTokens.length / denominator;
  return {
    score: Math.round(matchedTokens.length * 12 + ratio * 40),
    matched_tokens: matchedTokens,
  };
}

function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const out = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!field) continue;
    let value = field[2].trim();
    value = value.replace(/^"(.*)"$/, "$1");
    out[field[1]] = value;
  }
  return out;
}

function readReadouts(readoutDir = DEFAULT_READOUT_DIR) {
  if (!fs.existsSync(readoutDir)) return [];
  return fs.readdirSync(readoutDir)
    .filter((name) => /\.md$/i.test(name))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const relPath = path.relative(ROOT, path.join(readoutDir, name)).replaceAll(path.sep, "/");
      const text = fs.readFileSync(path.join(readoutDir, name), "utf8");
      const frontmatter = parseFrontmatter(text);
      const h1 = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() || null;
      const date = frontmatter.date || /(\d{4}-\d{2}-\d{2})/.exec(name)?.[1] || null;
      return {
        file: relPath,
        filename: name,
        date,
        title: frontmatter.title || h1 || name.replace(/\.md$/i, ""),
        vault_id: frontmatter.vault_id || null,
        source: frontmatter.source || null,
        kind: frontmatter.kind || null,
        consent: frontmatter.consent || null,
      };
    });
}

function readCalendarEvents(calendar) {
  return collectIcsEvents(calendar)
    .map((event, index) => {
      const date = dateOfEvent(event);
      const title = eventTitle(event);
      const eventId = `${date}-${event.timeKind === "timed" ? String(event.startMinutes).padStart(4, "0") : "allday"}-${slug(title)}-${index + 1}`;
      return {
        event_id: eventId,
        date,
        time: eventTimeLabel(event),
        time_kind: event.timeKind || "all_day",
        start_minutes: Number.isFinite(event.startMinutes) ? event.startMinutes : null,
        end_minutes: Number.isFinite(event.endMinutes) ? event.endMinutes : null,
        title,
        description: event.description || "",
        first_line: firstLine(event.description || title),
        category: event.category || null,
      };
    })
    .sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      const aStart = Number.isFinite(a.start_minutes) ? a.start_minutes : -1;
      const bStart = Number.isFinite(b.start_minutes) ? b.start_minutes : -1;
      if (aStart !== bStart) return aStart - bStart;
      return a.title.localeCompare(b.title);
    });
}

function classifyExpectation(event, auditDate) {
  if (event.date > auditDate) return "future";
  const text = normalizeText([event.title, event.description].join(" "));

  if (/\b(tea on roof|muse dinner|low key dinner|community dinner|kickoff dinner|welcome dinner|sorting hat dinner|yoga|memorial day|convent|reception|sculpture garden|hackathon due|all day night build|ship something used|hacking begins)\b/.test(text)) {
    return "not_expected";
  }
  if (/\b(no shape rotator programming|protected build time|out for the day|catering)\b/.test(text)) {
    return "not_expected";
  }
  if (/\b(office hours|1on1|one on one|pmf check|check point|checkpoint|private inference)\b/.test(text)) {
    return "expected_private";
  }
  if (/\b(project intros|tutorial|lecture|founder|founders|pmf|workshop|clinic|salon|onboarding|user interviews|flashnet|wdydlw|agentic organizations|sreeram|eigenlabs|info markets|product review|demo review|team led sessions|open jams|pitch practice|vc intros|final demo|go to market|legal|policy|fundraising|tee technical|attestation)\b/.test(text)) {
    return "expected";
  }
  if (event.time_kind === "timed") return "optional";
  return "not_expected";
}

function titleIssues(event) {
  const title = event.title || "";
  const text = [event.title, event.description].join(" ");
  const issues = [];
  if (/reigstration/i.test(text)) issues.push({ issue: "typo", detail: "reigstration -> registration" });
  if (/Check Point/i.test(title)) issues.push({ issue: "style", detail: "Prefer Checkpoint" });
  if (/Introduce Tina,\s*$/i.test(title)) issues.push({ issue: "incomplete_title", detail: "Calendar summary ends at a comma; use full recap title." });
  if (/^\.\s/.test(title)) issues.push({ issue: "leading_punctuation", detail: "Remove leading punctuation from title." });
  if (/\.\.\.$/.test(title)) issues.push({ issue: "long_title", detail: "Title exceeds ICS summary length; shorten source title and keep details in description." });
  if (/^Project Intros$/i.test(title)) issues.push({ issue: "generic_title", detail: "Add theme or participating teams." });
  return issues;
}

function driveApplyResultsByFile(driveApplyResult) {
  const out = new Map();
  if (!driveApplyResult?.apply) return out;
  for (const item of driveApplyResult.files || []) {
    if (item?.drive_file_id) out.set(item.drive_file_id, item);
  }
  return out;
}

function matchesEventOverride(override, event) {
  return override?.date === event.date && override?.title === event.title;
}

function eventLinkOverride(event) {
  return EVENT_LINK_OVERRIDES.find((override) => matchesEventOverride(override, event)) || null;
}

function transcriptEventOverride(transcript) {
  return EVENT_LINK_OVERRIDES.find((override) => (
    (override.transcript_drive_file_ids || []).includes(transcript.drive_file_id)
      || (override.transcript_preferred_drive_names || []).includes(transcript.preferred_drive_name)
  )) || null;
}

function readoutEventOverride(readout) {
  return EVENT_LINK_OVERRIDES.find((override) => (
    (override.readout_vault_ids || []).includes(readout.vault_id)
      || (override.readout_files || []).includes(readout.file)
  )) || null;
}

function appendManualTranscriptMatches(event, transcriptMatches, transcripts) {
  const override = eventLinkOverride(event);
  if (!override) return transcriptMatches;
  const out = [...transcriptMatches];
  const seen = new Set(out.map((item) => item.transcript.drive_file_id || item.transcript.preferred_drive_name));
  for (const driveFileId of override.transcript_drive_file_ids || []) {
    const transcript = transcripts.find((item) => item.drive_file_id === driveFileId);
    if (!transcript || seen.has(transcript.drive_file_id)) continue;
    out.unshift({
      transcript,
      score: 999,
      matched_tokens: ["manual-correction"],
    });
    seen.add(transcript.drive_file_id);
  }
  for (const preferredName of override.transcript_preferred_drive_names || []) {
    const transcript = transcripts.find((item) => item.preferred_drive_name === preferredName);
    if (!transcript || seen.has(transcript.preferred_drive_name)) continue;
    out.unshift({
      transcript,
      score: 999,
      matched_tokens: ["manual-correction"],
    });
    seen.add(transcript.preferred_drive_name);
  }
  return out;
}

function appendManualReadoutMatches(event, readoutMatches, readouts) {
  const override = eventLinkOverride(event);
  if (!override) return readoutMatches;
  const out = [...readoutMatches];
  const seen = new Set(out.map((item) => item.readout.vault_id || item.readout.file));
  for (const vaultId of override.readout_vault_ids || []) {
    const readout = readouts.find((item) => item.vault_id === vaultId);
    if (!readout || seen.has(readout.vault_id)) continue;
    out.unshift({
      readout,
      score: 999,
      matched_tokens: ["manual-correction"],
    });
    seen.add(readout.vault_id);
  }
  for (const file of override.readout_files || []) {
    const readout = readouts.find((item) => item.file === file);
    if (!readout || seen.has(readout.file)) continue;
    out.unshift({
      readout,
      score: 999,
      matched_tokens: ["manual-correction"],
    });
    seen.add(readout.file);
  }
  return out;
}

function buildTranscriptRows(importPlan, sessionMap, supabasePlan, fetchManifest, driveApplyResult) {
  const safeNames = new Set((sessionMap?.safe_links || []).map((item) => item.preferred_drive_name).filter(Boolean));
  const reviewNames = new Set((sessionMap?.review_links || []).map((item) => item.preferred_drive_name).filter(Boolean));
  const readyRefs = new Set((supabasePlan?.sourceArtifacts || []).map((item) => item.storage_ref).filter(Boolean));
  const fetchedRefs = new Set((fetchManifest?.items || []).filter((item) => item.status === "fetched").map((item) => item.source_storage_ref).filter(Boolean));
  const driveApplyByFile = driveApplyResultsByFile(driveApplyResult);

  return (importPlan?.files || [])
    .filter((file) => file.inferred_session_type)
    .map((file) => {
      const storageRef = file.source_artifact_manifest?.storage_ref || (file.drive_file_id ? `drive://${file.drive_file_id}` : null);
      const driveApply = driveApplyByFile.get(file.drive_file_id);
      const driveApplyVerified = !!driveApply && ["updated", "unchanged"].includes(driveApply.action);
      const linkStatus = safeNames.has(file.preferred_drive_name)
        ? "safe_link"
        : reviewNames.has(file.preferred_drive_name)
          ? "review_link"
          : file.needs_manual_review
            ? "manual_review"
            : "unlinked";
      const row = {
        drive_file_id: file.drive_file_id || null,
        preferred_drive_name: file.preferred_drive_name || null,
        original_name: file.canonical_name || file.original_name || null,
        vault_id: file.vault_id || null,
        date: file.inferred_date || null,
        session_type: file.inferred_session_type || null,
        max_tier: file.routing?.max_tier || null,
        cohort_mode: file.routing?.cohort_mode || null,
        public_allowed: !!file.routing?.public_allowed,
        calendar_status: file.calendar_match?.status || null,
        calendar_confidence: file.calendar_match?.confidence || null,
        candidate_date: file.calendar_match?.candidate?.date || null,
        preferred_name_matches_source_inventory: !!file.preferred_name_matches,
        preferred_name_verified: !!file.preferred_name_matches || driveApplyVerified,
        drive_apply_action: driveApply?.action || null,
        drive_apply_verified: driveApplyVerified,
        drive_route: file.drive_route?.path || null,
        derived_route: file.drive_route?.derived_path || null,
        needs_manual_review: !!file.needs_manual_review,
        manual_review_reasons: file.manual_review_reasons || [],
        link_status: linkStatus,
        source_system: file.source_system || null,
        source_kind: file.source_artifact_manifest?.source_kind || null,
        raw_available_to_server: !!file.source_artifact_manifest?.raw_available_to_server,
        source_artifact_ready: storageRef ? readyRefs.has(storageRef) : false,
        fetched_private_source: storageRef ? fetchedRefs.has(storageRef) : false,
        storage_ref: storageRef,
      };
      const correction = TRANSCRIPT_METADATA_CORRECTIONS[file.drive_file_id];
      return correction ? { ...row, ...correction } : row;
    })
    .sort((a, b) => {
      const dateCompare = String(a.date || "9999-99-99").localeCompare(String(b.date || "9999-99-99"));
      if (dateCompare) return dateCompare;
      return String(a.preferred_drive_name || "").localeCompare(String(b.preferred_drive_name || ""));
    });
}

function transcriptNamingIssues(transcript) {
  const issues = [];
  if (!transcript.preferred_name_verified) issues.push("rename_to_preferred");
  if (transcript.needs_manual_review) issues.push(...transcript.manual_review_reasons);
  if (transcript.raw_available_to_server) issues.push("raw_available_to_server_must_be_false");
  if (!transcript.date) issues.push("missing_date");
  return unique(issues);
}

function publicEvidenceLabel(transcript) {
  if (!transcript) return "";
  if (["private_1on1", "planning_strategy"].includes(transcript.session_type)) {
    return `private vault candidate (${transcript.session_type})`;
  }
  return transcript.preferred_drive_name || transcript.vault_id || "private vault source";
}

function transcriptSearchText(transcript) {
  return [
    transcript.preferred_drive_name,
    transcript.original_name,
    transcript.vault_id,
    transcript.session_type,
    transcript.manual_review_reasons.join(" "),
  ].filter(Boolean).join(" ");
}

function readoutSearchText(readout) {
  return [
    readout.filename,
    readout.title,
    readout.vault_id,
    readout.kind,
    readout.source,
  ].filter(Boolean).join(" ");
}

function matchTranscriptsForEvent(event, transcripts) {
  const text = [event.title, event.description].join(" ");
  return transcripts
    .filter((transcript) => {
      const override = transcriptEventOverride(transcript);
      return !override || matchesEventOverride(override, event);
    })
    .filter((transcript) => {
      if (transcript.date === event.date) return true;
      if (transcript.candidate_date === event.date) return true;
      return !transcript.date && !transcript.candidate_date;
    })
    .map((transcript) => ({ transcript, ...scoreText(transcriptSearchText(transcript), text) }))
    .filter((item) => {
      if (item.transcript.date === event.date && item.score >= 16) return true;
      if (item.transcript.candidate_date === event.date && item.score >= 36) return true;
      if (!item.transcript.date && !item.transcript.candidate_date && item.score >= 36) return true;
      return false;
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.transcript.link_status !== b.transcript.link_status) {
        return a.transcript.link_status.localeCompare(b.transcript.link_status);
      }
      return String(a.transcript.preferred_drive_name || "").localeCompare(String(b.transcript.preferred_drive_name || ""));
    });
}

function matchReadoutsForEvent(event, readouts) {
  const text = [event.title, event.description].join(" ");
  return readouts
    .filter((readout) => {
      const override = readoutEventOverride(readout);
      return !override || matchesEventOverride(override, event);
    })
    .filter((readout) => readout.date === event.date || !readout.date)
    .map((readout) => ({ readout, ...scoreText(readoutSearchText(readout), text) }))
    .filter((item) => item.score >= 16)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.readout.filename.localeCompare(b.readout.filename);
    });
}

function eventCoverageStatus({ expectation, transcriptMatches, readoutMatches }) {
  const ready = transcriptMatches.filter((item) => item.transcript.link_status === "safe_link" || item.transcript.source_artifact_ready);
  const review = transcriptMatches.filter((item) => item.transcript.link_status !== "safe_link" && !item.transcript.source_artifact_ready);
  if (expectation === "future") return "future";
  if (ready.length) return expectation === "not_expected" ? "covered_not_required" : "covered";
  if (readoutMatches.length) return "derived_readout";
  if (review.length) return "candidate_needs_review";
  if (expectation === "not_expected") return "not_expected";
  if (expectation === "optional") return "optional_missing";
  return "missing";
}

function eventNextAction(row) {
  switch (row.coverage_status) {
    case "covered":
      return "No transcript action; continue review/publish flow if needed.";
    case "covered_not_required":
      return "Transcript exists for a non-required block; keep policy boundary explicit before surfacing.";
    case "derived_readout":
      return "Source readout exists; verify raw source link if full source coverage is required.";
    case "candidate_needs_review":
      return "Review session/date match and policy route before queueing processing.";
    case "missing":
      return "Find source transcript/recording or mark explicitly unavailable.";
    case "optional_missing":
      return "No action unless this block needs searchable cohort memory.";
    case "not_expected":
      return "No transcript expected.";
    case "future":
      return "Future session; check after it happens.";
    default:
      return "";
  }
}

function buildCoverageRows({ events, transcripts, readouts, auditDate }) {
  return events.map((event) => {
    const expectation = classifyExpectation(event, auditDate);
    const transcriptMatches = appendManualTranscriptMatches(
      event,
      matchTranscriptsForEvent(event, transcripts),
      transcripts,
    );
    const readoutMatches = appendManualReadoutMatches(
      event,
      matchReadoutsForEvent(event, readouts),
      readouts,
    );
    const coverageStatus = eventCoverageStatus({ expectation, transcriptMatches, readoutMatches });
    const row = {
      ...event,
      expectation,
      coverage_status: coverageStatus,
      transcript_matches: transcriptMatches.map((item) => ({
        preferred_drive_name: item.transcript.preferred_drive_name,
        session_type: item.transcript.session_type,
        link_status: item.transcript.link_status,
        calendar_status: item.transcript.calendar_status,
        needs_manual_review: item.transcript.needs_manual_review,
        source_artifact_ready: item.transcript.source_artifact_ready,
        fetched_private_source: item.transcript.fetched_private_source,
        score: item.score,
        matched_tokens: item.matched_tokens,
      })),
      readout_matches: readoutMatches.map((item) => ({
        file: item.readout.file,
        title: item.readout.title,
        vault_id: item.readout.vault_id,
        score: item.score,
        matched_tokens: item.matched_tokens,
      })),
      title_issues: titleIssues(event),
    };
    row.next_action = eventNextAction(row);
    return row;
  });
}

function coverageEvidence(row, { privateMode = false } = {}) {
  const parts = [];
  for (const item of row.transcript_matches.slice(0, 3)) {
    if (privateMode) {
      parts.push(`${item.preferred_drive_name || "private source"} (${item.link_status}, ${item.calendar_status})`);
    } else {
      const fakeTranscript = {
        preferred_drive_name: item.preferred_drive_name,
        session_type: item.session_type,
        vault_id: null,
      };
      parts.push(`${publicEvidenceLabel(fakeTranscript)} (${item.link_status})`);
    }
  }
  for (const item of row.readout_matches.slice(0, 2)) {
    parts.push(privateMode ? `${item.file} (${item.vault_id || "readout"})` : item.file);
  }
  return parts.join("<br>");
}

function renderCoverageTable(rows, { privateMode = false } = {}) {
  const lines = [
    "| Date | Time | Calendar title | Expectation | Coverage | Evidence | Next action |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    // Public docs never expose the title or evidence of expected_private sessions.
    const withhold = !privateMode && row.expectation === "expected_private";
    const title = withhold ? "(private — title withheld)" : row.title;
    const evidence = withhold ? "(private — withheld)" : coverageEvidence(row, { privateMode });
    lines.push(`| ${row.date} | ${escapeMd(row.time)} | ${escapeMd(title)} | ${row.expectation} | ${row.coverage_status} | ${escapeMd(evidence)} | ${escapeMd(row.next_action)} |`);
  }
  return lines.join("\n");
}

function renderTitleIssues(rows, { privateMode = false } = {}) {
  // Public docs omit expected_private events from the title audit entirely.
  const issues = rows.flatMap((row) =>
    !privateMode && row.expectation === "expected_private"
      ? []
      : row.title_issues.map((issue) => ({ row, ...issue })));
  const lines = [
    "| Date | Time | Calendar title | Issue | Detail |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const item of issues) {
    lines.push(`| ${item.row.date} | ${escapeMd(item.row.time)} | ${escapeMd(item.row.title)} | ${escapeMd(item.issue)} | ${escapeMd(item.detail)} |`);
  }
  if (!issues.length) lines.push("|  |  |  | none | No title issues detected by the audit heuristics. |");
  return lines.join("\n");
}

function renderTranscriptNamingAudit(transcripts) {
  const lines = [
    "| Date | Type | Preferred name | Current/source name | Calendar status | Link status | Drive verify | Route | Issues |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const transcript of transcripts) {
    const issues = transcriptNamingIssues(transcript);
    const driveVerify = transcript.drive_apply_verified ? transcript.drive_apply_action : "";
    lines.push(`| ${transcript.date || ""} | ${transcript.session_type || ""} | ${escapeMd(transcript.preferred_drive_name || "")} | ${escapeMd(transcript.original_name || "")} | ${transcript.calendar_status || ""} | ${transcript.link_status || ""} | ${driveVerify} | ${escapeMd(transcript.drive_route || "")} | ${escapeMd(issues.join(", "))} |`);
  }
  return lines.join("\n");
}

function renderPublicDoc({ generatedAt, auditDate, calendar, importPlan, sessionMap, supabasePlan, fetchManifest, driveOperationsPlan, driveApplyResult, rows, transcripts, readouts }) {
  const coverageCounts = countBy(rows, (row) => row.coverage_status);
  const expectationCounts = countBy(rows, (row) => row.expectation);
  const pastTranscriptExpected = rows.filter((row) => ["expected", "expected_private"].includes(row.expectation));
  const missingRequired = pastTranscriptExpected.filter((row) => row.coverage_status === "missing");
  const reviewRequired = rows.filter((row) => row.coverage_status === "candidate_needs_review");
  const titleIssueCount = rows.reduce((sum, row) => sum + row.title_issues.length, 0);
  const namingIssues = transcripts.filter((item) => transcriptNamingIssues(item).length);
  const driveApplyVerifiedCount = transcripts.filter((item) => item.drive_apply_verified).length;
  const manualCorrectionCount = transcripts.filter((item) => item.manual_correction).length;

  const lines = [
    "# Transcript Calendar Coverage Index",
    "",
    `Generated: ${generatedAt}`,
    `Audit date: ${auditDate}`,
    `Calendar source refresh: ${calendar?.last_refresh || "unknown"}`,
    "",
    "Related: [Docs hub](README.md) · [Information rules](INFORMATION_RULES.html)",
    "",
    "This index lists every expanded calendar block from `cohort-data/calendar.json` and records whether a transcript source, reviewed readout, or candidate source exists. It uses metadata only; it does not read or publish raw transcript text.",
    "",
    "The detailed transcript filename/original-name queue is private at `cohort-data/.private/transcript-vault/transcript-calendar-coverage-audit.md` because some source titles disclose private coaching, fundraising, or strategy context.",
    "",
    "## Summary",
    "",
    `- Calendar blocks indexed: ${rows.length}`,
    `- Past/current transcript-expected blocks: ${pastTranscriptExpected.length}`,
    `- Missing transcript-expected blocks: ${missingRequired.length}`,
    `- Blocks with candidates needing review: ${reviewRequired.length}`,
    `- Transcript vault refs audited: ${transcripts.length}`,
    `- Source artifacts ready for worker queue: ${(supabasePlan?.sourceArtifacts || []).length}`,
    `- Private sources fetched locally: ${(fetchManifest?.items || []).filter((item) => item.status === "fetched").length}`,
    `- Safe Drive names/routes verified: ${driveApplyVerifiedCount}`,
    `- Manual reviewed Drive corrections applied: ${manualCorrectionCount}`,
    `- Reviewed session readouts found: ${readouts.length}`,
    `- Transcript naming/metadata issue rows: ${namingIssues.length}`,
    `- Calendar title issue rows: ${titleIssueCount}`,
    "",
    "## Coverage Counts",
    "",
    "| Status | Count |",
    "| --- | ---: |",
  ];
  for (const [status, count] of Object.entries(coverageCounts)) lines.push(`| ${status} | ${count} |`);

  lines.push("", "## Expectation Counts", "", "| Expectation | Count |", "| --- | ---: |");
  for (const [status, count] of Object.entries(expectationCounts)) lines.push(`| ${status} | ${count} |`);

  lines.push(
    "",
    "## Transcript Source Audit Counts",
    "",
    `- Vault import plan generated: ${importPlan?.generated_at || "unknown"}`,
    `- Session map generated: ${sessionMap?.generated_at || "unknown"}`,
    `- Vault files in import plan: ${importPlan?.counts?.total_files ?? "unknown"}`,
    `- Transcript files in import plan: ${importPlan?.counts?.transcript_files ?? "unknown"}`,
    `- Calendar matched transcript files: ${importPlan?.counts?.matched ?? "unknown"}`,
    `- Date-only transcript files: ${importPlan?.counts?.date_only ?? "unknown"}`,
    `- Title-only transcript candidates: ${importPlan?.counts?.title_only_candidate ?? "unknown"}`,
    `- Date-conflict transcript candidates: ${importPlan?.counts?.date_conflict_title_candidate ?? "unknown"}`,
    `- Unknown-date transcript files: ${importPlan?.counts?.unknown_date ?? "unknown"}`,
    `- Transcript refs needing manual review: ${importPlan?.counts?.needs_manual_review ?? "unknown"}`,
    `- Safe session links: ${sessionMap?.counts?.safe_links ?? "unknown"}`,
    `- Review session links: ${sessionMap?.counts?.review_links ?? "unknown"}`,
    `- Rename recommended by import plan: ${importPlan?.counts?.rename_recommended ?? "unknown"}`,
    `- Drive rename actions planned: ${driveOperationsPlan?.counts?.rename_actions ?? "unknown"}`,
    `- Drive move actions planned: ${driveOperationsPlan?.counts?.move_actions ?? "unknown"}`,
    `- Drive file operations safe to apply: ${driveOperationsPlan?.counts?.safe_file_operations ?? "unknown"}`,
    `- Drive file operations held for review: ${driveOperationsPlan?.counts?.review_file_operations ?? "unknown"}`,
    `- Last safe Drive apply: ${driveApplyResult?.apply ? `${driveApplyResult.counts?.files_updated || 0} updated, ${driveApplyResult.counts?.files_unchanged || 0} unchanged` : "not recorded"}`,
    "",
    "## Missing Required Sessions",
    "",
  );
  const missingRows = missingRequired.length ? missingRequired : [];
  lines.push(renderCoverageTable(missingRows));

  lines.push("", "## Candidate Sessions Needing Review", "");
  lines.push(renderCoverageTable(reviewRequired));

  lines.push("", "## Calendar Title Audit", "");
  lines.push(renderTitleIssues(rows));

  lines.push("", "## Complete Calendar Coverage", "");
  lines.push(renderCoverageTable(rows));

  lines.push(
    "",
    "## Operating Notes",
    "",
    "- `covered` means a private transcript/source artifact is linked strongly enough to process or already queued in the source-artifact plan.",
    "- `derived_readout` means a reviewed readout exists, but the current source-link plan does not prove a ready raw source artifact for this exact calendar block.",
    "- `candidate_needs_review` means metadata found a plausible transcript, but title/date/session matching or policy routing still needs human review.",
    "- `missing` means the session is past/current, transcript-expected, and no current source/readout/candidate proves coverage.",
    "- `future` means the calendar block occurs after the audit date and should be checked after it happens.",
    "- `not_expected` covers tea, dinners, social blocks, hackathon build time, holidays, and other blocks where transcript capture is not expected by default.",
    "- `Safe Drive names/routes verified` means the safe rename/move set was checked against live Google Drive. `Transcript naming/metadata issue rows` can still include verified files when their calendar/session metadata needs review.",
    "- The audit does not mutate Google Drive. Use the private Drive operations plan for reviewed renames/moves; apply only after confirming held-review rows.",
  );

  return lines.join("\n");
}

function renderPrivateDoc({ generatedAt, auditDate, calendar, importPlan, sessionMap, supabasePlan, fetchManifest, driveOperationsPlan, driveApplyResult, rows, transcripts, readouts }) {
  const manualCorrectionCount = transcripts.filter((item) => item.manual_correction).length;
  const lines = [
    "# Private Transcript Calendar Coverage Audit",
    "",
    `Generated: ${generatedAt}`,
    `Audit date: ${auditDate}`,
    `Calendar source refresh: ${calendar?.last_refresh || "unknown"}`,
    "",
    "This private audit includes original/source names and preferred private vault names. It still excludes raw transcript text.",
    "",
    "## Counts",
    "",
    `- Calendar blocks indexed: ${rows.length}`,
    `- Transcript refs audited: ${transcripts.length}`,
    `- Readouts found: ${readouts.length}`,
    `- Vault files in import plan: ${importPlan?.counts?.total_files ?? "unknown"}`,
    `- Transcript files in import plan: ${importPlan?.counts?.transcript_files ?? "unknown"}`,
    `- Safe session links: ${sessionMap?.counts?.safe_links ?? "unknown"}`,
    `- Review session links: ${sessionMap?.counts?.review_links ?? "unknown"}`,
    `- Ready source artifacts: ${(supabasePlan?.sourceArtifacts || []).length}`,
    `- Fetched private sources: ${(fetchManifest?.items || []).filter((item) => item.status === "fetched").length}`,
    `- Safe Drive names/routes verified: ${transcripts.filter((item) => item.drive_apply_verified).length}`,
    `- Manual reviewed Drive corrections applied: ${manualCorrectionCount}`,
    `- Drive rename actions planned: ${driveOperationsPlan?.counts?.rename_actions ?? "unknown"}`,
    `- Drive move actions planned: ${driveOperationsPlan?.counts?.move_actions ?? "unknown"}`,
    `- Drive file operations safe to apply: ${driveOperationsPlan?.counts?.safe_file_operations ?? "unknown"}`,
    `- Drive file operations held for review: ${driveOperationsPlan?.counts?.review_file_operations ?? "unknown"}`,
    `- Last safe Drive apply: ${driveApplyResult?.apply ? `${driveApplyResult.counts?.files_updated || 0} updated, ${driveApplyResult.counts?.files_unchanged || 0} unchanged` : "not recorded"}`,
    "",
    "## Complete Calendar Coverage",
    "",
    renderCoverageTable(rows, { privateMode: true }),
    "",
    "## Transcript Naming And Metadata Audit",
    "",
    renderTranscriptNamingAudit(transcripts),
    "",
    "## Calendar Title Audit",
    "",
    renderTitleIssues(rows, { privateMode: true }),
  ];
  return lines.join("\n");
}

export function buildTranscriptCalendarCoverageAudit({
  calendar,
  importPlan,
  sessionMap,
  supabasePlan,
  fetchManifest,
  driveOperationsPlan,
  driveApplyResult,
  readouts,
  auditDate = DEFAULT_AUDIT_DATE,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!calendar) throw new Error("calendar is required");
  const events = readCalendarEvents(calendar);
  const transcripts = buildTranscriptRows(importPlan, sessionMap, supabasePlan, fetchManifest, driveApplyResult);
  const coverageRows = buildCoverageRows({ events, transcripts, readouts, auditDate });
  return {
    generated_at: generatedAt,
    audit_date: auditDate,
    sources: {
      calendar_last_refresh: calendar.last_refresh || null,
      transcript_import_plan_generated_at: importPlan?.generated_at || null,
      transcript_session_map_generated_at: sessionMap?.generated_at || null,
      transcript_supabase_plan_generated_at: supabasePlan?.generated_at || null,
      transcript_drive_fetch_generated_at: fetchManifest?.generated_at || null,
      drive_operations_plan_generated_at: driveOperationsPlan?.generated_at || null,
      drive_operations_apply_recorded: driveApplyResult?.apply ? true : false,
    },
    counts: {
      calendar_blocks: coverageRows.length,
      coverage_status: countBy(coverageRows, (row) => row.coverage_status),
      expectations: countBy(coverageRows, (row) => row.expectation),
      transcript_refs: transcripts.length,
      readouts: readouts.length,
      naming_issue_rows: transcripts.filter((item) => transcriptNamingIssues(item).length).length,
      calendar_title_issue_rows: coverageRows.filter((row) => row.title_issues.length).length,
      manual_drive_corrections: transcripts.filter((item) => item.manual_correction).length,
    },
    calendar_coverage: coverageRows,
    transcript_inventory: transcripts,
    readout_inventory: readouts,
  };
}

function main() {
  const argv = process.argv.slice(2);
  if (hasFlag("--help", argv)) {
    console.log(usage());
    return;
  }

  const auditDate = arg("--audit-date", argv) || DEFAULT_AUDIT_DATE;
  const calendar = readJson(arg("--calendar", argv) || DEFAULT_CALENDAR_PATH);
  const importPlan = readJson(arg("--import-plan", argv) || DEFAULT_IMPORT_PLAN_PATH, {});
  const sessionMap = readJson(arg("--session-map", argv) || DEFAULT_SESSION_MAP_PATH, {});
  const supabasePlan = readJson(arg("--supabase-plan", argv) || DEFAULT_SUPABASE_PLAN_PATH, {});
  const fetchManifest = readJson(arg("--fetch-manifest", argv) || DEFAULT_FETCH_MANIFEST_PATH, {});
  const driveOperationsPlan = readJson(arg("--drive-operations", argv) || DEFAULT_DRIVE_OPERATIONS_PATH, {});
  const driveApplyResult = readJson(arg("--drive-apply-result", argv) || DEFAULT_DRIVE_APPLY_RESULT_PATH, {});
  const readouts = readReadouts(path.resolve(arg("--readouts", argv) || DEFAULT_READOUT_DIR));

  const generatedAt = new Date().toISOString();
  const audit = buildTranscriptCalendarCoverageAudit({
    calendar,
    importPlan,
    sessionMap,
    supabasePlan,
    fetchManifest,
    driveOperationsPlan,
    driveApplyResult,
    readouts,
    auditDate,
    generatedAt,
  });

  const publicOut = path.resolve(arg("--public-out", argv) || DEFAULT_PUBLIC_OUT);
  const privateOut = path.resolve(arg("--private-out", argv) || DEFAULT_PRIVATE_OUT);
  const jsonOut = path.resolve(arg("--json-out", argv) || DEFAULT_JSON_OUT);

  writeText(publicOut, renderPublicDoc({
    generatedAt,
    auditDate,
    calendar,
    importPlan,
    sessionMap,
    supabasePlan,
    fetchManifest,
    driveOperationsPlan,
    driveApplyResult,
    rows: audit.calendar_coverage,
    transcripts: audit.transcript_inventory,
    readouts,
  }));
  writeText(privateOut, renderPrivateDoc({
    generatedAt,
    auditDate,
    calendar,
    importPlan,
    sessionMap,
    supabasePlan,
    fetchManifest,
    driveOperationsPlan,
    driveApplyResult,
    rows: audit.calendar_coverage,
    transcripts: audit.transcript_inventory,
    readouts,
  }));
  writeJson(jsonOut, audit);

  console.log(`wrote ${path.relative(ROOT, publicOut)}`);
  console.log(`wrote ${path.relative(ROOT, privateOut)}`);
  console.log(`wrote ${path.relative(ROOT, jsonOut)}`);
  console.log(`calendar blocks: ${audit.counts.calendar_blocks}`);
  console.log(`missing expected: ${audit.calendar_coverage.filter((row) => row.coverage_status === "missing").length}`);
  console.log(`candidate review: ${audit.calendar_coverage.filter((row) => row.coverage_status === "candidate_needs_review").length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
