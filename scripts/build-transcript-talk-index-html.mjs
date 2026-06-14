#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PLAN_PATH = path.join(ROOT, "cohort-data", ".private", "transcript-vault", "transcript-vault-import-plan.json");
const DEFAULT_AUDIT_PATH = path.join(ROOT, "cohort-data", ".private", "transcript-vault", "drive-artifact-audit.json");
const DEFAULT_OUT_PATH = path.join(ROOT, "docs", "INFORMATION_INDEX.html");

const TYPE_META = {
  weekly_standup: { label: "Weekly standup", icon: "👤" },
  office_hours: { label: "Office hours", icon: "🧑‍💻" },
  private_1on1: { label: "Private 1:1", icon: "🔒" },
  salon: { label: "Salon", icon: "💬" },
  rd_jam: { label: "R&D / jam", icon: "🧪" },
  demo_presentation: { label: "Demo / presentation", icon: "🎬" },
  user_interview: { label: "User interview", icon: "🎙️" },
  planning_strategy: { label: "Planning / strategy", icon: "🧭" },
};

const ROUTE_ORDER = [
  "raw_transcripts/weekly_standup",
  "raw_transcripts/office_hours",
  "raw_transcripts/salon",
  "raw_transcripts/rd_jam",
  "raw_transcripts/demo_presentation",
  "raw_transcripts/user_interview",
  "do_not_publish/private_1on1",
  "do_not_publish/planning_strategy",
  "needs_calendar_match",
];

const ROUTE_META = {
  "raw_transcripts/weekly_standup": {
    label: "Weekly standups",
    icon: "👤",
    note: "Individual status sources. Distill only aggregate signal.",
  },
  "raw_transcripts/office_hours": {
    label: "Office hours",
    icon: "🧑‍💻",
    note: "Project support, product feedback, PMF/checkpoint, or implementation help for a team/product.",
  },
  "raw_transcripts/salon": {
    label: "Salons",
    icon: "💬",
    note: "Topic-led rooms. Public only after speaker and editorial clearance.",
  },
  "raw_transcripts/rd_jam": {
    label: "R&D / jams",
    icon: "🧪",
    note: "Open-ended whiteboarding, prototype/architecture/workflow exploration. If it is support or feedback for one team, reclassify as office hours.",
  },
  "raw_transcripts/demo_presentation": {
    label: "Demos / presentations",
    icon: "🎬",
    note: "Presenter-owned material. Public requires presenter approval.",
  },
  "raw_transcripts/user_interview": {
    label: "User interviews",
    icon: "🎙️",
    note: "External-subject research. Only aggregate insight travels.",
  },
  "do_not_publish/private_1on1": {
    label: "Private 1:1 / do not publish",
    icon: "🔒",
    note: "Private coaching or sensitive material. Core/private only.",
  },
  "do_not_publish/planning_strategy": {
    label: "Planning / strategy",
    icon: "🧭",
    note: "Coordinator governance and strategy. Stops at core.",
  },
  needs_calendar_match: {
    label: "Needs calendar match",
    icon: "🔎",
    note: "Unresolved title/date/session evidence. Review before routing.",
  },
};

const CALENDAR_META = {
  matched: {
    label: "Matched",
    icon: "✅",
    className: "ok",
    short: "Calendar confirmed.",
  },
  date_only: {
    label: "Date only",
    icon: "📅",
    className: "hold",
    short: "Date fits; title/session still needs a human check.",
  },
  title_only_candidate: {
    label: "Title candidate",
    icon: "🔎",
    className: "hold",
    short: "Likely title candidate; date is not confirmed.",
  },
  date_conflict_title_candidate: {
    label: "Date conflict",
    icon: "⚠️",
    className: "review",
    short: "Likely title candidate, but filename date conflicts.",
  },
  unknown_date: {
    label: "Unknown date",
    icon: "❓",
    className: "review",
    short: "No reliable date found.",
  },
  no_calendar_block: {
    label: "No block",
    icon: "❓",
    className: "review",
    short: "No matching calendar block found.",
  },
  unknown: {
    label: "Unknown",
    icon: "❓",
    className: "review",
    short: "Calendar state is unresolved.",
  },
};

const SOURCE_ORDER = ["google_meet", "gemini_notes", "otter", "manual_drive", "ambiguous", "unknown"];

const SOURCE_META = {
  google_meet: {
    label: "Google Meet",
    icon: "🎥",
    className: "source-meet",
    short: "Meet transcript artifact.",
  },
  gemini_notes: {
    label: "Gemini notes",
    icon: "✨",
    className: "source-gemini",
    short: "Gemini smart notes artifact.",
  },
  otter: {
    label: "Otter",
    icon: "🎙️",
    className: "source-otter",
    short: "Otter transcript or summary export.",
  },
  manual_drive: {
    label: "Manual Drive",
    icon: "📄",
    className: "source-drive",
    short: "Drive file with no Meet/Otter marker.",
  },
  ambiguous: {
    label: "Ambiguous",
    icon: "❔",
    className: "source-ambiguous",
    short: "Conflicting source markers.",
  },
  unknown: {
    label: "Unknown",
    icon: "❓",
    className: "source-unknown",
    short: "No source system metadata.",
  },
};

const TYPE_BOUNDARIES = [
  {
    icon: "👤",
    signal: "Recurring WDYDLW, status update, individual progress, or coordinator check-in by person",
    classifyAs: "weekly_standup",
    notAs: "office_hours",
  },
  {
    icon: "🧑‍💻",
    signal: "Project support, product feedback, roadmap critique, milestone review, or implementation help",
    classifyAs: "office_hours",
    notAs: "rd_jam",
  },
  {
    icon: "🧪",
    signal: "Open-ended whiteboarding, architecture exploration, product/technical hypothesis testing, or idea-stage workshop",
    classifyAs: "rd_jam",
    notAs: "office_hours",
  },
  {
    icon: "💬",
    signal: "Topic-led discussion, speaker-led room, or salon-style session not centered on one team's operating work",
    classifyAs: "salon",
    notAs: "office_hours",
  },
  {
    icon: "🎬",
    signal: "Prepared project/product demo, presentation, intro, showcase, or presenter-owned material",
    classifyAs: "demo_presentation",
    notAs: "salon",
  },
  {
    icon: "🎙️",
    signal: "External customer/user/ICP subject whose participation is research evidence",
    classifyAs: "user_interview",
    notAs: "office_hours",
  },
  {
    icon: "🔒",
    signal: "Private coaching, sensitive feedback, governance, fundraising, internal planning, or coordinator strategy",
    classifyAs: "private_1on1 / planning_strategy",
    notAs: "office_hours",
  },
];

const TYPE_KEYWORDS = {
  weekly_standup: ["weekly", "standup", "status", "wdydlw"],
  office_hours: ["office hours", "feedback", "checkpoint", "check-in", "check in", "coaching", "support"],
  private_1on1: ["private_1on1", "1on1", "1:1", "1-1", "private", "coaching"],
  salon: ["salon", "speaker", "lecture", "topic", "guest"],
  rd_jam: ["rd_jam", "r&d", "jam", "whiteboarding", "brainstorm", "workshop", "hangout", "hackathon"],
  demo_presentation: ["demo", "presentation", "project intro", "project intros", "showcase"],
  user_interview: ["user interview", "user_interview", "icp", "customer", "research"],
  planning_strategy: ["planning", "strategy", "governance", "ops", "fundraising", "data room"],
};

const REVIEW_REASONS = {
  ambiguous_session_type: "Ambiguous session type",
  calendar_date_only: "Date-only calendar match",
  calendar_unknown_date: "Unknown date",
  calendar_title_only_candidate: "Title-only calendar candidate",
  calendar_date_conflict_title_candidate: "Calendar date conflict",
  no_calendar_block: "No calendar block",
  planning_strategy_stops_at_core: "Planning/strategy stops at core",
  private_1on1_do_not_publish: "Private 1:1",
  routed_to_needs_calendar_match: "Needs calendar match",
  visibility_not_labeled_in_filename: "Visibility not labeled in filename",
};

function usage() {
  return [
    "Usage:",
    "  node scripts/build-transcript-talk-index-html.mjs [--plan import-plan.json] [--out docs/INFORMATION_INDEX.html]",
    "",
    "Builds a metadata-only transcript/talk catalog HTML from the private vault import plan.",
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

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value.endsWith("\n") ? value : `${value}\n`);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[char]));
}

function slugId(value) {
  return String(value || "section")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "section";
}

function titleCaseSlug(value) {
  return String(value || "session")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => {
      if (/^(ai|ip|pmf|sql|ic3|b2b|r&d)$/i.test(part)) return part.toUpperCase();
      return `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
}

function typeMeta(sessionType) {
  return TYPE_META[sessionType] || { label: titleCaseSlug(sessionType || "unknown"), icon: "🧾" };
}

function routeMeta(route) {
  return ROUTE_META[route] || {
    label: titleCaseSlug(route),
    icon: "🗂️",
    note: "Drive route from the import plan.",
  };
}

function calendarMeta(status) {
  return CALENDAR_META[status] || {
    label: titleCaseSlug(status || "unknown"),
    icon: "❓",
    className: "review",
    short: "Calendar state is unresolved.",
  };
}

function reviewMeta(file) {
  if (!file.needs_manual_review) {
    return {
      label: "Ready",
      icon: "✅",
      className: "ok",
      short: "No manual hold.",
    };
  }
  if ((file.manual_review_reasons || []).includes("planning_strategy_stops_at_core")) {
    return {
      label: "Core/private",
      icon: "🔒",
      className: "review",
      short: "Stops at coordinator/core review.",
    };
  }
  return {
    label: "Review",
    icon: "⚠️",
    className: "hold",
    short: "Manual check needed.",
  };
}

function routeScopeMeta(route) {
  if (String(route).startsWith("do_not_publish")) {
    return {
      label: "Core/private",
      icon: "🔒",
      className: "review",
      short: "Do not publish.",
    };
  }
  if (route === "needs_calendar_match") {
    return {
      label: "Unresolved route",
      icon: "🔎",
      className: "hold",
      short: "Route after calendar check.",
    };
  }
  return {
    label: "Raw source",
    icon: "🧾",
    className: "neutral",
    short: "Vault metadata only.",
  };
}

function sourceDetailLabel(sourceKind) {
  switch (sourceKind) {
    case "meet_transcript":
      return "Meet transcript";
    case "meet_smart_notes":
      return "Gemini smart notes";
    case "otter_transcript":
      return "Otter transcript";
    case "otter_summary":
      return "Otter summary";
    case "otter_slide":
      return "Otter slide capture";
    case "drive_doc":
      return "Drive doc";
    default:
      return titleCaseSlug(sourceKind || "metadata only");
  }
}

function sourceKeyForInfo(info) {
  const sourceSystem = String(info?.source_system || info?.sourceSystem || info?.provider || "").toLowerCase();
  const sourceKind = String(info?.source_kind || info?.sourceKind || info?.kind || "").toLowerCase();
  if (sourceKind === "meet_smart_notes") return "gemini_notes";
  if (sourceKind.startsWith("meet_") || ["google_meet", "gmeet", "meet"].includes(sourceSystem)) return "google_meet";
  if (sourceKind.startsWith("otter_") || sourceSystem === "otter") return "otter";
  if (sourceSystem === "ambiguous") return "ambiguous";
  if (sourceSystem === "drive" || sourceSystem === "manual" || sourceKind === "drive_doc") return "manual_drive";
  return "unknown";
}

function sourceAuditByDriveId(sourceAudit) {
  const byId = new Map();
  const add = (item) => {
    if (!item || typeof item !== "object") return;
    const storageRef = item.storage_ref || item.storageRef || "";
    const id = item.drive_file_id
      || item.driveFileId
      || item.file_id
      || item.fileId
      || item.id
      || (String(storageRef).startsWith("drive://") ? String(storageRef).slice("drive://".length) : null);
    if (!id) return;
    const existing = byId.get(id);
    const existingKey = sourceKeyForInfo(existing);
    const nextKey = sourceKeyForInfo(item);
    if (!existing || (existingKey === "unknown" && nextKey !== "unknown")) {
      byId.set(id, item);
    }
  };
  const collections = [
    sourceAudit?.files,
    sourceAudit?.audit?.files,
    sourceAudit?.audit?.deepest_files,
    sourceAudit?.matchedFiles,
    sourceAudit?.unmatchedFiles,
    sourceAudit?.captureArtifacts,
    sourceAudit?.sourceArtifacts,
  ];
  for (const collection of collections) {
    if (Array.isArray(collection)) collection.forEach(add);
  }
  for (const manifest of sourceAudit?.manifests || []) {
    add(manifest);
    for (const artifact of manifest?.manifest?.artifacts || []) add(artifact);
  }
  return byId;
}

function sourceMetaForFile(file, auditById = new Map()) {
  const auditInfo = auditById.get(file.drive_file_id);
  const manifestInfo = file.source_artifact_manifest || {};
  const planInfo = {
    source_system: file.source_system,
    source_kind: file.source_kind || manifestInfo.source_kind,
    provider: file.source_provider || file.provider || manifestInfo.source_provider,
  };
  const info = auditInfo && sourceKeyForInfo(auditInfo) !== "manual_drive"
    ? auditInfo
    : planInfo;
  const key = sourceKeyForInfo(info);
  const meta = SOURCE_META[key] || SOURCE_META.unknown;
  const sourceKind = info?.source_kind || info?.sourceKind || info?.kind || planInfo.source_kind || "";
  return {
    key,
    label: meta.label,
    icon: meta.icon,
    className: meta.className,
    short: meta.short,
    detail: sourceDetailLabel(sourceKind),
    confidence: info?.confidence || info?.source_confidence || file.source_confidence || "low",
  };
}

function includesAny(value, needles) {
  const text = String(value || "").toLowerCase();
  return needles.some((needle) => text.includes(String(needle).toLowerCase()));
}

function confidenceLevel(percent) {
  if (percent >= 85) return { label: "High", className: "ok", icon: "✅" };
  if (percent >= 70) return { label: "Medium", className: "hold", icon: "📊" };
  return { label: "Review", className: "review", icon: "⚠️" };
}

function typeConfidenceForFile(file) {
  const storedPercent = Number(file.type_confidence_pct ?? file.classification_confidence?.type_pct);
  if (Number.isFinite(storedPercent) && storedPercent > 0) {
    const evidence = file.classification_confidence?.basis?.type || [];
    return {
      percent: Math.max(0, Math.min(100, Math.round(storedPercent))),
      ...confidenceLevel(storedPercent),
      evidence: Array.isArray(evidence) ? evidence.slice(0, 4) : [],
    };
  }

  const type = file.inferred_session_type || "unknown";
  const typeLabel = typeMeta(type).label;
  const sourceName = `${file.original_name || ""} ${file.canonical_name || ""} ${file.preferred_drive_name || ""}`;
  const originalName = `${file.original_name || ""} ${file.canonical_name || ""}`;
  const keywords = TYPE_KEYWORDS[type] || [];
  const calendarStatus = file.calendar_match?.status || "unknown";
  const calendarScore = Number(file.calendar_match?.score || 0);
  const matchedTokens = file.calendar_match?.matched_tokens || [];
  const reviewReasons = (file.manual_review_reasons || [])
    .filter((reason) => reason !== "visibility_not_labeled_in_filename");
  let score = 58;
  const evidence = [];

  if (new RegExp(`(^|[^a-z0-9])${type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(sourceName)) {
    score += 22;
    evidence.push("type prefix/name marker");
  } else if (includesAny(originalName, keywords)) {
    score += 14;
    evidence.push(`${typeLabel.toLowerCase()} keyword`);
  } else {
    score -= 8;
    evidence.push("type inferred from weak title cues");
  }

  if (file.drive_route?.path && String(file.drive_route.path).includes(type)) {
    score += 8;
    evidence.push("route agrees");
  }

  if (calendarStatus === "matched") {
    score += 16;
    evidence.push("calendar matched");
  } else if (calendarStatus === "date_only") {
    score -= 10;
    evidence.push("date only");
  } else if (calendarStatus === "title_only_candidate") {
    score -= 8;
    evidence.push("title-only candidate");
  } else if (calendarStatus === "date_conflict_title_candidate") {
    score -= 20;
    evidence.push("date conflict");
  } else if (calendarStatus === "unknown_date" || calendarStatus === "no_calendar_block") {
    score -= 16;
    evidence.push("calendar unresolved");
  }

  if (calendarScore >= 55) {
    score += 6;
    evidence.push("strong calendar token score");
  } else if (calendarScore >= 40) {
    score += 3;
    evidence.push("moderate calendar token score");
  }
  if (matchedTokens.length >= 2) score += 3;

  if (!reviewReasons.length) {
    score += 5;
    evidence.push("no type hold");
  }
  if (reviewReasons.some((reason) => /ambiguous|conflict|unknown|title_only|date_only|missing/i.test(reason))) {
    score -= 6;
  }
  if (needsTypeBoundaryCheck(file)) {
    score -= 8;
    evidence.push("R&D/office-hours boundary check");
  }
  if (type === "private_1on1" && includesAny(originalName, ["private_1on1", "1on1", "1:1", "private"])) {
    score += 8;
  }

  const percent = Math.max(35, Math.min(96, Math.round(score)));
  return {
    percent,
    ...confidenceLevel(percent),
    evidence: [...new Set(evidence)].slice(0, 4),
  };
}

function storedConfidenceForFile(file, key) {
  const directKey = `${key}_confidence_pct`;
  const assessmentKey = key === "type" ? "type_pct" : key === "group" ? "group_pct" : "understanding_pct";
  const percent = Number(file[directKey] ?? file.classification_confidence?.[assessmentKey]);
  if (!Number.isFinite(percent) || percent <= 0) return null;
  const evidence = file.classification_confidence?.basis?.[key] || [];
  return {
    percent: Math.max(0, Math.min(100, Math.round(percent))),
    ...confidenceLevel(percent),
    evidence: Array.isArray(evidence) ? evidence.slice(0, 4) : [],
  };
}

function reasonLabel(reason) {
  return REVIEW_REASONS[reason] || titleCaseSlug(reason);
}

function needsTypeBoundaryCheck(file) {
  return file.inferred_session_type === "rd_jam" && file.calendar_match?.status !== "matched";
}

function displayReviewReasons(file) {
  const reasons = (file.manual_review_reasons || [])
    .filter((reason) => reason !== "visibility_not_labeled_in_filename")
    .map(reasonLabel);
  if (needsTypeBoundaryCheck(file)) {
    reasons.push("Type boundary check: R&D/jam vs office-hours support");
  }
  return reasons;
}

function parsePreferredName(name, sessionType) {
  const withoutExt = String(name || "").replace(/\.[a-z0-9]+$/i, "");
  const dateMatch = withoutExt.match(/_(\d{4}-\d{2}-\d{2})$/);
  const date = dateMatch?.[1] || null;
  const prefix = `${sessionType || ""}_`;
  const middle = date
    ? withoutExt.slice(0, -(`_${date}`).length)
    : withoutExt;
  const project = middle.startsWith(prefix) ? middle.slice(prefix.length) : middle.replace(/^[a-z0-9_]+_/, "");
  return {
    date,
    project_slug: project || "session",
    project_label: titleCaseSlug(project || "session"),
  };
}

function talkLine(file) {
  const parsed = parsePreferredName(file.preferred_drive_name, file.inferred_session_type);
  const label = typeMeta(file.inferred_session_type).label;
  switch (file.inferred_session_type) {
    case "weekly_standup":
      return `${label} for ${parsed.project_label}.`;
    case "office_hours":
      return `${label} session for ${parsed.project_label}.`;
    case "salon":
      return `${label} on ${parsed.project_label}.`;
    case "rd_jam":
      return `${label} around ${parsed.project_label}.`;
    case "demo_presentation":
      return `${label} for ${parsed.project_label}.`;
    case "user_interview":
      return `${label} source for ${parsed.project_label}.`;
    case "private_1on1":
      return `${label} source for ${parsed.project_label}; held in the private do-not-publish route.`;
    case "planning_strategy":
      return `${label} source for ${parsed.project_label}; held for core/private review.`;
    default:
      return `${label} source for ${parsed.project_label}.`;
  }
}

function calendarLine(file) {
  const match = file.calendar_match || {};
  const status = match.status || "unknown";
  if (status === "matched") {
    const confidence = match.confidence ? ` / ${match.confidence}` : "";
    const tokens = (match.matched_tokens || []).slice(0, 5).join(", ");
    return `Calendar confirmed${confidence}${tokens ? `; matched tokens: ${tokens}` : ""}.`;
  }
  return calendarMeta(status).short;
}

function routeRank(route) {
  const index = ROUTE_ORDER.indexOf(route);
  return index === -1 ? 999 : index;
}

function normalizeFiles(plan, { sourceAudit = null } = {}) {
  const auditById = sourceAuditByDriveId(sourceAudit);
  return (plan.files || [])
    .filter((file) => file.preferred_drive_name && file.inferred_session_type)
    .map((file) => {
      const parsed = parsePreferredName(file.preferred_drive_name, file.inferred_session_type);
      return {
        ...file,
        parsed,
        route: file.drive_route?.path || "needs_calendar_match",
        line: talkLine(file),
        calendar_line: calendarLine(file),
        source: sourceMetaForFile(file, auditById),
        type_confidence: typeConfidenceForFile(file),
      };
    })
    .sort((a, b) => {
      const byRoute = routeRank(a.route) - routeRank(b.route);
      if (byRoute) return byRoute;
      return String(a.inferred_date || "").localeCompare(String(b.inferred_date || ""))
        || String(a.preferred_drive_name).localeCompare(String(b.preferred_drive_name));
    });
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item) || "none";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function statusChip(meta) {
  return `<span class="chip ${escapeHtml(meta.className || "neutral")}"><span class="emoji" aria-hidden="true">${escapeHtml(meta.icon)}</span>${escapeHtml(meta.label)}</span>`;
}

function reviewKey(file) {
  const review = reviewMeta(file);
  return review.label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

function groupStats(files) {
  return {
    matched: files.filter((file) => file.calendar_match?.status === "matched").length,
    review: files.filter((file) => file.needs_manual_review).length,
  };
}

function renderRouteOptions(groups) {
  return groups.map(([route, files]) => {
    const meta = routeMeta(route);
    return `<option value="${escapeHtml(route)}">${escapeHtml(meta.icon)} ${escapeHtml(meta.label)} (${files.length})</option>`;
  }).join("");
}

function renderCalendarOptions(statusCounts) {
  const order = ["matched", "date_only", "title_only_candidate", "date_conflict_title_candidate", "unknown_date", "no_calendar_block", "unknown"];
  return order
    .filter((status) => statusCounts[status])
    .map((status) => {
      const meta = calendarMeta(status);
      return `<option value="${escapeHtml(status)}">${escapeHtml(meta.icon)} ${escapeHtml(meta.label)} (${statusCounts[status]})</option>`;
    })
    .join("");
}

function renderReviewOptions(files) {
  const counts = countBy(files, reviewKey);
  const labels = new Map();
  for (const file of files) labels.set(reviewKey(file), reviewMeta(file));
  return [...labels.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, meta]) => `<option value="${escapeHtml(key)}">${escapeHtml(meta.icon)} ${escapeHtml(meta.label)} (${counts[key]})</option>`)
    .join("");
}

function renderSourceOptions(files) {
  const counts = countBy(files, (file) => file.source?.key || "unknown");
  return SOURCE_ORDER
    .filter((key) => counts[key])
    .map((key) => {
      const meta = SOURCE_META[key] || SOURCE_META.unknown;
      return `<option value="${escapeHtml(key)}">${escapeHtml(meta.icon)} ${escapeHtml(meta.label)} (${counts[key]})</option>`;
    })
    .join("");
}

function renderRouteNav(groups) {
  return groups.map(([route, files]) => {
    const meta = routeMeta(route);
    return `
    <a href="#${slugId(route)}">
      <span class="nav-title"><span class="emoji" aria-hidden="true">${escapeHtml(meta.icon)}</span>${escapeHtml(meta.label)}</span>
      <code>${escapeHtml(route)}</code>
      <b>${files.length}</b>
    </a>
  `;
  }).join("");
}

function renderTypeBoundaries() {
  return TYPE_BOUNDARIES.map((boundary) => {
    const classify = boundary.classifyAs.split(" / ").map((type) => {
      const meta = typeMeta(type);
      return `<code>${escapeHtml(meta.label === titleCaseSlug(type) ? type : type)}</code>`;
    }).join(" ");
    return `
      <div class="boundary-card">
        <div class="boundary-signal"><span class="emoji" aria-hidden="true">${escapeHtml(boundary.icon)}</span>${escapeHtml(boundary.signal)}</div>
        <div class="boundary-decision"><span>Use ${classify}</span><span>not <code>${escapeHtml(boundary.notAs)}</code></span></div>
      </div>
    `;
  }).join("");
}

function confidenceMetric(label, confidence) {
  if (!confidence) return "";
  return `<span class="confidence-metric ${escapeHtml(confidence.className)}"><b>${escapeHtml(String(confidence.percent))}%</b>${escapeHtml(label)}</span>`;
}

function confidenceSummary({ type, group, understanding } = {}) {
  return `
    <span class="confidence-strip" aria-label="Classification confidence">
      ${confidenceMetric("type", type)}
      ${confidenceMetric("group", group)}
      ${confidenceMetric("meaning", understanding)}
    </span>
  `;
}

function renderFileRow(file) {
  const status = file.calendar_match?.status || "unknown";
  const type = typeMeta(file.inferred_session_type);
  const calendar = calendarMeta(status);
  const review = reviewMeta(file);
  const scope = routeScopeMeta(file.route);
  const source = file.source || SOURCE_META.unknown;
  const confidence = file.type_confidence || typeConfidenceForFile(file);
  const excerpt = file.calendar_match?.block_excerpt || "";
  const reasons = displayReviewReasons(file);
  return `
    <article class="talk-row" id="${slugId(file.preferred_drive_name)}">
      <div class="talk-main">
        <div class="talk-kicker">
          <span><span class="emoji" aria-hidden="true">${escapeHtml(type.icon)}</span>${escapeHtml(type.label)}</span>
          <span>${escapeHtml(file.inferred_date || file.parsed.date || "unknown date")}</span>
        </div>
        <h3>${escapeHtml(file.parsed.project_label)}</h3>
        <p>${escapeHtml(file.line)}</p>
        <code>${escapeHtml(file.preferred_drive_name)}</code>
      </div>
      <div class="talk-state">
        <div class="chip-row" aria-label="Source status">
          ${statusChip(source)}
          ${statusChip({ label: `${confidence.percent}% type`, icon: confidence.icon, className: confidence.className })}
          ${statusChip(calendar)}
          ${statusChip(review)}
        </div>
        ${confidenceSummary({ type: confidence })}
        <p class="state-note">${escapeHtml(file.calendar_line)}</p>
        <p class="evidence-line">${escapeHtml(confidence.evidence.join("; ") || confidence.label.toLowerCase())} · ${escapeHtml(scope.short)}</p>
        ${excerpt ? `<details><summary><span class="emoji" aria-hidden="true">📅</span> evidence</summary><p>${escapeHtml(excerpt)}</p></details>` : ""}
        ${reasons.length ? `<small><span class="emoji" aria-hidden="true">⚠️</span> ${escapeHtml(reasons.join("; "))}</small>` : ""}
      </div>
    </article>
  `;
}

function renderGroup([route, files]) {
  const meta = routeMeta(route);
  const stats = groupStats(files);
  return `
    <section id="${slugId(route)}" class="route-section">
      <div class="section-head">
        <div>
          <div class="kicker">Drive route</div>
          <h2 class="route-title"><span class="emoji" aria-hidden="true">${escapeHtml(meta.icon)}</span>${escapeHtml(meta.label)}</h2>
          <p class="route-summary">${escapeHtml(meta.note)}</p>
        </div>
        <div class="route-meta">
          <code>${escapeHtml(route)}</code>
          <div class="route-stats" aria-label="Route counts">
            <span><b>${files.length}</b> source${files.length === 1 ? "" : "s"}</span>
            <span><b>${stats.matched}</b> matched</span>
            <span><b>${stats.review}</b> review</span>
          </div>
        </div>
      </div>
      <div class="talk-list">
        ${files.map(renderFileRow).join("")}
      </div>
    </section>
  `;
}

function renderTableRow(file) {
  const status = file.calendar_match?.status || "unknown";
  const type = typeMeta(file.inferred_session_type);
  const route = routeMeta(file.route);
  const calendar = calendarMeta(status);
  const review = reviewMeta(file);
  const source = file.source || SOURCE_META.unknown;
  const confidence = file.type_confidence || typeConfidenceForFile(file);
  const key = reviewKey(file);
  const date = file.inferred_date || file.parsed.date || "";
  const reasons = displayReviewReasons(file);
  const searchable = [
    date,
    type.label,
    `${confidence.percent}% type confidence`,
    ...confidence.evidence,
    file.parsed.project_label,
    file.line,
    file.route,
    route.label,
    source.label,
    source.detail,
    calendar.label,
    review.label,
    ...reasons,
    file.preferred_drive_name,
  ].join(" ").toLowerCase();
  return `
    <tr
      data-date="${escapeHtml(date)}"
      data-type="${escapeHtml(type.label)}"
      data-confidence="${escapeHtml(String(confidence.percent).padStart(3, "0"))}"
      data-talk="${escapeHtml(file.parsed.project_label)}"
      data-route="${escapeHtml(file.route)}"
      data-source="${escapeHtml(source.key || "unknown")}"
      data-calendar="${escapeHtml(status)}"
      data-review="${escapeHtml(key)}"
      data-filename="${escapeHtml(file.preferred_drive_name)}"
      data-search="${escapeHtml(searchable)}"
    >
      <td data-label="Date"><span class="mono-cell">${escapeHtml(date || "unknown")}</span></td>
      <td data-label="Type"><span class="table-type"><span class="emoji" aria-hidden="true">${escapeHtml(type.icon)}</span>${escapeHtml(type.label)}</span>${confidenceSummary({ type: confidence })}<small>${escapeHtml(confidence.evidence.join("; ") || confidence.label)}</small></td>
      <td data-label="Source">${statusChip(source)}<small>${escapeHtml(source.detail)}</small></td>
      <td data-label="Talk"><b>${escapeHtml(file.parsed.project_label)}</b><small>${escapeHtml(file.line)}</small></td>
      <td data-label="Route"><code>${escapeHtml(file.route)}</code></td>
      <td data-label="Calendar">${statusChip(calendar)}</td>
      <td data-label="Review">${statusChip(review)}${reasons.length ? `<small>${escapeHtml(reasons.join("; "))}</small>` : ""}</td>
      <td data-label="Filename"><code>${escapeHtml(file.preferred_drive_name)}</code></td>
    </tr>
  `;
}

function renderCatalogConsole({ files, groups, statusCounts }) {
  return `
    <section class="catalog-console" aria-label="Catalog views">
      <div class="view-head">
        <div>
          <div class="kicker">Catalog view</div>
          <h2>Browse by route or inspect as a table.</h2>
        </div>
        <div class="view-switch" role="group" aria-label="Choose catalog view">
          <button type="button" class="view-button" data-view="route" aria-pressed="true"><span class="emoji" aria-hidden="true">🗂️</span> Route view</button>
          <button type="button" class="view-button" data-view="table" aria-pressed="false"><span class="emoji" aria-hidden="true">📊</span> Table view</button>
        </div>
      </div>
      <div class="boundary-note" aria-label="Transcript type classification boundaries">
        <div class="boundary-title">
          <b><span class="emoji" aria-hidden="true">🧭</span> Type boundary</b>
          <span>Calendar event first. If the signal fits two rows, use the stricter/private route until reviewed.</span>
        </div>
        <div class="boundary-grid">
          ${renderTypeBoundaries()}
        </div>
      </div>

      <div class="table-panel" id="table-view" data-view-panel="table" hidden>
        <div class="table-tools" aria-label="Table filters">
          <label>
            <span>Search</span>
            <input type="search" data-filter="search" placeholder="Talk, source, type, route, filename">
          </label>
          <label>
            <span>Sort</span>
            <select data-sort-select>
              <option value="date">Date</option>
              <option value="type">Type</option>
              <option value="confidence">Type confidence</option>
              <option value="source">Source</option>
              <option value="talk">Talk</option>
              <option value="route">Route</option>
              <option value="calendar">Calendar</option>
              <option value="review">Review</option>
              <option value="filename">Filename</option>
            </select>
          </label>
          <label>
            <span>Route</span>
            <select data-filter="route">
              <option value="">All routes</option>
              ${renderRouteOptions(groups)}
            </select>
          </label>
          <label>
            <span>Source</span>
            <select data-filter="source">
              <option value="">All sources</option>
              ${renderSourceOptions(files)}
            </select>
          </label>
          <label>
            <span>Calendar</span>
            <select data-filter="calendar">
              <option value="">All calendar states</option>
              ${renderCalendarOptions(statusCounts)}
            </select>
          </label>
          <label>
            <span>Review</span>
            <select data-filter="review">
              <option value="">All review states</option>
              ${renderReviewOptions(files)}
            </select>
          </label>
          <button type="button" class="clear-button" data-clear-filters>Clear</button>
        </div>
        <div class="table-status" aria-live="polite"><b data-row-count>${files.length}</b> of ${files.length} sources shown</div>
        <div class="table-wrap">
          <table class="source-table">
            <colgroup>
              <col class="col-date">
              <col class="col-type">
              <col class="col-source">
              <col class="col-talk">
              <col class="col-route">
              <col class="col-calendar">
              <col class="col-review">
              <col class="col-filename">
            </colgroup>
            <thead>
              <tr>
                <th scope="col" aria-sort="ascending"><button type="button" data-sort="date">Date</button></th>
                <th scope="col"><button type="button" data-sort="type">Type</button></th>
                <th scope="col"><button type="button" data-sort="source">Source</button></th>
                <th scope="col"><button type="button" data-sort="talk">Talk</button></th>
                <th scope="col"><button type="button" data-sort="route">Route</button></th>
                <th scope="col"><button type="button" data-sort="calendar">Calendar</button></th>
                <th scope="col"><button type="button" data-sort="review">Review</button></th>
                <th scope="col"><button type="button" data-sort="filename">Filename</button></th>
              </tr>
            </thead>
            <tbody data-table-body>
              ${files.map(renderTableRow).join("")}
            </tbody>
          </table>
          <p class="empty-table" data-empty-table hidden>No transcript sources match those filters.</p>
        </div>
      </div>
    </section>
  `;
}

export function renderTranscriptTalkIndex(plan, { generatedAt = new Date().toISOString(), sourceAudit = null } = {}) {
  const files = normalizeFiles(plan, { sourceAudit });
  const byRoute = new Map();
  for (const file of files) {
    if (!byRoute.has(file.route)) byRoute.set(file.route, []);
    byRoute.get(file.route).push(file);
  }
  const groups = [...byRoute.entries()].sort(([a], [b]) => routeRank(a) - routeRank(b) || a.localeCompare(b));
  const statusCounts = countBy(files, (file) => file.calendar_match?.status || "unknown");
  const reviewCount = files.filter((file) => file.needs_manual_review).length;
  const matchedCount = statusCounts.matched || 0;
  const dateOnlyCount = statusCounts.date_only || 0;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Shape Rotator Transcript Index</title>
  <style>
    :root {
      color-scheme: light;
      --ink: oklch(20% 0.025 58);
      --muted: oklch(47% 0.026 64);
      --paper: oklch(96% 0.018 78);
      --line: oklch(80% 0.038 72);
      --copper: oklch(55% 0.118 47);
      --olive: oklch(48% 0.074 125);
      --blue: oklch(43% 0.083 236);
      --plum: oklch(41% 0.079 332);
      --red: oklch(47% 0.12 31);
      --mono: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      --sans: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --serif: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
      --shadow: 0 16px 48px oklch(23% 0.04 58 / 0.1);
    }

    * { box-sizing: border-box; }
    html { scrollbar-gutter: stable; scroll-behavior: smooth; }
    body {
      margin: 0;
      min-width: 320px;
      overflow-x: clip;
      color: var(--ink);
      font-family: var(--sans);
      line-height: 1.42;
      background:
        linear-gradient(90deg, oklch(91% 0.028 75 / 0.75) 1px, transparent 1px),
        linear-gradient(0deg, oklch(91% 0.028 75 / 0.75) 1px, transparent 1px),
        var(--paper);
      background-size: 28px 28px;
    }

    a { color: inherit; text-decoration-color: color-mix(in oklch, var(--copper), transparent 45%); text-underline-offset: 0.2em; }
    a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible { outline: 3px solid color-mix(in oklch, var(--blue), white 18%); outline-offset: 3px; border-radius: 6px; }
    button, input, select { font: inherit; color: inherit; }
    button { cursor: pointer; }
    code {
      max-width: 100%;
      font-family: var(--mono);
      font-size: 0.82rem;
      color: oklch(24% 0.04 60);
      background: oklch(91% 0.026 80);
      border: 1px solid color-mix(in oklch, var(--line), white 18%);
      border-radius: 6px;
      padding: 0.08rem 0.3rem;
      white-space: normal;
      overflow-wrap: anywhere;
    }
    .emoji {
      display: inline-block;
      font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;
      line-height: 1;
      transform: translateY(0.03em);
    }

    .page { width: min(1220px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 72px; }
    .shell { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 28px; align-items: start; }
    main { min-width: 0; }
    .rail { position: sticky; top: 20px; border-left: 3px solid var(--copper); padding: 8px 0 10px 16px; }
    .rail strong { display: block; margin-bottom: 12px; font-size: 0.72rem; letter-spacing: 0.1em; text-transform: uppercase; }
    .rail a { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 10px; padding: 8px 0; text-decoration: none; border-bottom: 1px solid color-mix(in oklch, var(--line), transparent 55%); }
    .rail .nav-title { display: inline-flex; align-items: center; gap: 7px; min-width: 0; font-size: 0.86rem; }
    .rail a code { grid-column: 1 / -1; font-size: 0.68rem; padding: 0; border: 0; background: transparent; color: var(--muted); }
    .rail a b { font-family: var(--mono); font-size: 0.76rem; color: var(--copper); }

    .hero {
      min-height: min(560px, 82svh);
      display: grid;
      align-content: center;
      gap: 24px;
      padding: 28px 0 52px;
      border-bottom: 1px solid var(--line);
    }
    .kicker { font-family: var(--mono); font-size: 0.72rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--copper); overflow-wrap: anywhere; }
    h1, h2, h3 { margin: 0; letter-spacing: 0; text-wrap: balance; }
    h1 { max-width: 900px; font-family: var(--serif); font-size: clamp(3rem, 7vw, 6rem); line-height: 0.94; }
    h2 { font-family: var(--serif); font-size: clamp(2rem, 4vw, 3.35rem); line-height: 1; }
    h3 { font-size: 1.02rem; line-height: 1.16; }
    p { margin: 0; color: var(--muted); text-wrap: pretty; }
    .lede { max-width: 760px; font-size: clamp(1.04rem, 1.8vw, 1.32rem); color: oklch(32% 0.035 63); }

    .summary-strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
    .summary-card {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: oklch(98% 0.012 80);
      box-shadow: var(--shadow);
      padding: 13px 14px;
      min-height: 100px;
    }
    .summary-label { display: flex; align-items: center; gap: 7px; font-family: var(--mono); font-size: 0.72rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }
    .summary-card b { display: block; margin-top: 8px; font-family: var(--serif); font-size: 2.35rem; line-height: 0.95; }

    .links { display: flex; flex-wrap: wrap; gap: 8px; }
    .links a { display: inline-flex; min-height: 34px; align-items: center; border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; background: oklch(98% 0.012 80); text-decoration: none; font-size: 0.84rem; }

    section { padding: 72px 0 0; }
    .catalog-console {
      padding-top: 28px;
      min-width: 0;
    }
    .view-head {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 16px;
      align-items: end;
      padding: 14px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: oklch(98% 0.012 80);
      box-shadow: var(--shadow);
    }
    .view-head h2 { font-size: clamp(1.6rem, 2.7vw, 2.5rem); }
    .view-switch {
      display: inline-grid;
      grid-template-columns: repeat(2, minmax(112px, 1fr));
      gap: 4px;
      padding: 4px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: oklch(94% 0.018 80);
    }
    .view-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      min-height: 34px;
      border: 0;
      border-radius: 8px;
      padding: 6px 10px;
      background: transparent;
      color: var(--muted);
      font-size: 0.84rem;
    }
    .view-button[aria-pressed="true"] {
      color: var(--ink);
      background: oklch(99% 0.01 80);
      box-shadow: 0 1px 8px oklch(24% 0.03 60 / 0.12);
    }
    .boundary-note {
      margin-top: 8px;
      border: 1px solid color-mix(in oklch, var(--plum), white 56%);
      border-radius: 8px;
      overflow: clip;
      background: color-mix(in oklch, var(--plum), white 94%);
    }
    .boundary-title {
      display: grid;
      grid-template-columns: minmax(170px, 0.34fr) minmax(0, 1fr);
      gap: 0;
      border-bottom: 1px solid color-mix(in oklch, var(--plum), white 66%);
    }
    .boundary-title > * {
      padding: 9px 11px;
      border-right: 1px solid color-mix(in oklch, var(--plum), white 66%);
      font-size: 0.82rem;
    }
    .boundary-title > *:last-child { border-right: 0; }
    .boundary-title b {
      display: flex;
      align-items: center;
      gap: 7px;
      color: var(--plum);
      font-family: var(--mono);
      font-size: 0.72rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .boundary-title span { color: oklch(31% 0.036 62); }
    .boundary-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 1px;
      background: color-mix(in oklch, var(--plum), white 72%);
    }
    .boundary-card {
      display: grid;
      gap: 7px;
      min-width: 0;
      padding: 10px 11px;
      background: color-mix(in oklch, var(--plum), white 94%);
    }
    .boundary-signal {
      display: inline-flex;
      align-items: flex-start;
      gap: 7px;
      font-size: 0.8rem;
      color: oklch(31% 0.036 62);
      line-height: 1.32;
    }
    .boundary-decision {
      display: flex;
      flex-wrap: wrap;
      gap: 5px 8px;
      align-items: center;
      font-size: 0.74rem;
      color: var(--muted);
    }
    [data-view-panel][hidden] { display: none; }
    .table-panel {
      margin-top: 10px;
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: oklch(98% 0.012 80);
      overflow: clip;
    }
    .table-tools {
      display: grid;
      grid-template-columns: minmax(260px, 1.4fr) repeat(5, minmax(124px, 0.7fr)) auto;
      gap: 7px;
      align-items: end;
      padding: 10px;
      border-bottom: 1px solid var(--line);
      background: color-mix(in oklch, var(--paper), white 50%);
    }
    .table-tools label {
      display: grid;
      gap: 5px;
      min-width: 0;
    }
    .table-tools label span {
      font-family: var(--mono);
      font-size: 0.68rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--copper);
    }
    .table-tools input,
    .table-tools select {
      width: 100%;
      min-height: 34px;
      border: 1px solid color-mix(in oklch, var(--line), white 16%);
      border-radius: 8px;
      padding: 6px 9px;
      background: oklch(99% 0.01 80);
      font-size: 0.84rem;
    }
    .clear-button {
      min-height: 34px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 6px 10px;
      background: oklch(99% 0.01 80);
      font-size: 0.84rem;
    }
    .table-status {
      padding: 9px 12px;
      border-bottom: 1px solid var(--line);
      font-family: var(--mono);
      font-size: 0.74rem;
      color: var(--muted);
    }
    .table-status b { color: var(--ink); }
    .table-wrap {
      width: 100%;
      min-width: 0;
      overflow-x: auto;
    }
    .source-table {
      width: 100%;
      min-width: 1260px;
      border-collapse: collapse;
      font-size: 0.8rem;
      table-layout: fixed;
    }
    .source-table .col-date { width: 92px; }
    .source-table .col-type { width: 190px; }
    .source-table .col-source { width: 134px; }
    .source-table .col-talk { width: 250px; }
    .source-table .col-route { width: 180px; }
    .source-table .col-calendar { width: 122px; }
    .source-table .col-review { width: 148px; }
    .source-table .col-filename { width: 144px; }
    .source-table th,
    .source-table td {
      padding: 8px 9px;
      border-bottom: 1px solid color-mix(in oklch, var(--line), transparent 28%);
      text-align: left;
      vertical-align: top;
    }
    .source-table th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: oklch(94% 0.018 80);
      font-family: var(--mono);
      font-size: 0.68rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .source-table th button {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 0;
      padding: 0;
      background: transparent;
      color: var(--copper);
      font: inherit;
      text-transform: inherit;
      letter-spacing: inherit;
    }
    .source-table th[aria-sort="ascending"] button::after { content: "↑"; color: var(--muted); }
    .source-table th[aria-sort="descending"] button::after { content: "↓"; color: var(--muted); }
    .source-table td small {
      display: block;
      margin-top: 3px;
      color: var(--muted);
      line-height: 1.28;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .source-table td b {
      display: block;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .source-table td code {
      display: block;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .source-table .chip { min-height: 22px; padding: 2px 7px; }
    .mono-cell { font-family: var(--mono); color: var(--copper); }
    .table-type { display: inline-flex; align-items: center; gap: 6px; font-weight: 650; }
    .confidence-strip {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 4px;
    }
    .confidence-metric {
      display: inline-flex;
      align-items: baseline;
      gap: 4px;
      min-height: 20px;
      padding: 2px 6px;
      border: 1px solid color-mix(in oklch, var(--line), white 14%);
      border-radius: 6px;
      font-family: var(--mono);
      font-size: 0.66rem;
      color: var(--muted);
      background: oklch(97% 0.012 80);
    }
    .confidence-metric b { color: var(--ink); font-size: 0.72rem; }
    .confidence-metric.ok { border-color: color-mix(in oklch, var(--olive), white 58%); color: var(--olive); background: color-mix(in oklch, var(--olive), white 93%); }
    .confidence-metric.hold { border-color: color-mix(in oklch, var(--plum), white 60%); color: var(--plum); background: color-mix(in oklch, var(--plum), white 94%); }
    .confidence-metric.review { border-color: color-mix(in oklch, var(--red), white 62%); color: var(--red); background: color-mix(in oklch, var(--red), white 94%); }
    .empty-table {
      padding: 18px;
      font-size: 0.9rem;
    }
    .section-head { display: grid; grid-template-columns: minmax(0, 1fr) minmax(180px, 0.42fr); gap: 28px; align-items: end; margin-bottom: 16px; }
    .route-title { display: flex; align-items: baseline; gap: 10px; }
    .route-summary { max-width: 700px; margin-top: 10px; }
    .route-meta { display: grid; gap: 8px; justify-items: start; }
    .route-stats { display: flex; flex-wrap: wrap; gap: 6px; }
    .route-stats span {
      display: inline-flex;
      align-items: baseline;
      gap: 4px;
      min-height: 26px;
      padding: 3px 8px;
      border: 1px solid color-mix(in oklch, var(--line), white 16%);
      border-radius: 999px;
      font-family: var(--mono);
      font-size: 0.72rem;
      color: var(--muted);
      background: oklch(98% 0.012 80);
    }
    .route-stats b { color: var(--ink); }
    .talk-list { display: grid; gap: 8px; }
    .talk-row {
      display: grid;
      grid-template-columns: minmax(0, 1.05fr) minmax(240px, 0.62fr);
      gap: 0;
      border: 1px solid var(--line);
      border-radius: 10px;
      overflow: clip;
      background: oklch(98% 0.012 80);
    }
    .talk-main, .talk-state { padding: 13px; min-width: 0; }
    .talk-main { display: grid; gap: 7px; border-right: 1px solid var(--line); }
    .talk-kicker { display: flex; flex-wrap: wrap; gap: 6px 10px; font-family: var(--mono); font-size: 0.72rem; color: var(--copper); text-transform: uppercase; letter-spacing: 0.08em; }
    .talk-kicker span { display: inline-flex; align-items: center; gap: 6px; }
    .talk-state { display: grid; gap: 7px; align-content: start; }
    .chip-row { display: flex; flex-wrap: wrap; gap: 5px; align-items: flex-start; }
    .chip {
      display: inline-flex;
      width: fit-content;
      align-items: center;
      gap: 6px;
      min-height: 24px;
      padding: 3px 8px;
      border: 1px solid var(--line);
      border-radius: 999px;
      font-family: var(--mono);
      font-size: 0.72rem;
      background: oklch(96% 0.015 80);
      white-space: nowrap;
    }
    .chip.ok { color: var(--olive); border-color: color-mix(in oklch, var(--olive), white 58%); background: color-mix(in oklch, var(--olive), white 91%); }
    .chip.hold { color: var(--plum); border-color: color-mix(in oklch, var(--plum), white 58%); background: color-mix(in oklch, var(--plum), white 92%); }
    .chip.review { color: var(--red); border-color: color-mix(in oklch, var(--red), white 60%); background: color-mix(in oklch, var(--red), white 92%); }
    .chip.neutral { color: var(--blue); border-color: color-mix(in oklch, var(--blue), white 62%); background: color-mix(in oklch, var(--blue), white 93%); }
    .chip.source-meet { color: var(--blue); border-color: color-mix(in oklch, var(--blue), white 58%); background: color-mix(in oklch, var(--blue), white 91%); }
    .chip.source-gemini { color: var(--plum); border-color: color-mix(in oklch, var(--plum), white 58%); background: color-mix(in oklch, var(--plum), white 92%); }
    .chip.source-otter { color: var(--olive); border-color: color-mix(in oklch, var(--olive), white 58%); background: color-mix(in oklch, var(--olive), white 91%); }
    .chip.source-drive, .chip.source-unknown { color: var(--muted); border-color: color-mix(in oklch, var(--line), white 16%); background: oklch(96% 0.015 80); }
    .chip.source-ambiguous { color: var(--red); border-color: color-mix(in oklch, var(--red), white 60%); background: color-mix(in oklch, var(--red), white 92%); }
    .talk-state p, .talk-state small, details p { font-size: 0.8rem; }
    .state-note { color: oklch(34% 0.032 62); }
    .evidence-line { color: var(--muted); font-family: var(--mono); font-size: 0.7rem; line-height: 1.3; }
    .talk-state small { display: flex; gap: 7px; color: var(--muted); overflow-wrap: anywhere; }
    details { border-top: 1px solid color-mix(in oklch, var(--line), transparent 30%); padding-top: 8px; }
    summary { cursor: pointer; width: fit-content; color: var(--ink); font-size: 0.82rem; }
    summary .emoji { margin-right: 5px; }
    details p { margin-top: 8px; }
    footer { margin-top: 80px; padding-top: 20px; border-top: 1px solid var(--line); color: var(--muted); font-size: 0.82rem; }

    @media (max-width: 900px) {
      .shell { grid-template-columns: 1fr; }
      .rail { position: static; display: flex; flex-wrap: wrap; gap: 8px; border-left: 0; border-top: 3px solid var(--copper); padding: 12px 0 0; }
      .rail strong { flex-basis: 100%; margin-bottom: 2px; }
      .rail a {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: 32px;
        border: 1px solid var(--line);
        border-radius: 999px;
        padding: 5px 9px;
        background: oklch(98% 0.012 80);
      }
      .rail a code { display: none; }
      .rail a b { color: var(--ink); }
      .view-head { grid-template-columns: 1fr; align-items: start; }
      .view-switch { width: 100%; }
      .boundary-title { grid-template-columns: 1fr; }
      .boundary-title > * {
        border-right: 0;
        border-bottom: 1px solid color-mix(in oklch, var(--plum), white 66%);
      }
      .boundary-title > *:last-child { border-bottom: 0; }
      .boundary-grid { grid-template-columns: 1fr; }
      .table-tools { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .clear-button { width: fit-content; }
      .summary-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .section-head, .talk-row { grid-template-columns: 1fr; }
      .talk-main { border-right: 0; border-bottom: 1px solid var(--line); }
    }

    @media (max-width: 560px) {
      .page { width: min(100% - 20px, 1220px); }
      .hero { min-height: auto; padding-top: 18px; }
      .view-switch { grid-template-columns: 1fr; }
      .table-tools { grid-template-columns: 1fr; }
      .table-wrap { overflow-x: visible; }
      .source-table {
        display: block;
        min-width: 0;
      }
      .source-table thead { display: none; }
      .source-table tbody {
        display: grid;
        gap: 8px;
        padding: 8px;
      }
      .source-table tr {
        display: grid;
        border: 1px solid color-mix(in oklch, var(--line), white 14%);
        border-radius: 10px;
        overflow: clip;
        background: oklch(99% 0.01 80);
      }
      .source-table tr[hidden] { display: none; }
      .source-table td {
        display: grid;
        grid-template-columns: 78px minmax(0, 1fr);
        gap: 10px;
        padding: 7px 9px;
        border-bottom: 1px solid color-mix(in oklch, var(--line), transparent 35%);
      }
      .source-table td[data-label="Route"],
      .source-table td[data-label="Filename"] {
        display: none;
      }
      .source-table td small {
        display: none;
      }
      .source-table td:last-child { border-bottom: 0; }
      .source-table td::before {
        content: attr(data-label);
        font-family: var(--mono);
        font-size: 0.66rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--copper);
      }
      .source-table .chip { white-space: normal; }
      .summary-strip { grid-template-columns: 1fr; }
      section { padding-top: 56px; }
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="shell">
      <nav class="rail" aria-label="Drive route menu">
        <strong>Drive route menu</strong>
        ${renderRouteNav(groups)}
      </nav>
      <main>
        <header class="hero">
          <div>
            <div class="kicker">Shape Rotator OS / transcript source index / generated ${escapeHtml(generatedAt.slice(0, 10))}</div>
            <h1>What talks do we have?</h1>
          </div>
          <p class="lede">A metadata-only catalog of transcript sources in the Drive vault, grouped by current Drive route. Each row gives the talk line, canonical filename, and whether it confidently matches a calendar event.</p>
          <div class="summary-strip" aria-label="Transcript catalog summary">
            <article class="summary-card"><span class="summary-label"><span class="emoji" aria-hidden="true">🗂️</span> Sources</span><b>${files.length}</b><p>Metadata rows from the private vault import plan.</p></article>
            <article class="summary-card"><span class="summary-label"><span class="emoji" aria-hidden="true">✅</span> Matched</span><b>${matchedCount}</b><p>Title/date match to a calendar block.</p></article>
            <article class="summary-card"><span class="summary-label"><span class="emoji" aria-hidden="true">📅</span> Date only</span><b>${dateOnlyCount}</b><p>Date aligns; session title needs confirmation.</p></article>
            <article class="summary-card"><span class="summary-label"><span class="emoji" aria-hidden="true">⚠️</span> Review</span><b>${reviewCount}</b><p>Held for calendar, routing, or privacy review.</p></article>
          </div>
          <div class="links" aria-label="Related documents">
            <a href="README.md">Docs hub</a>
            <a href="INFORMATION_RULES.html">Storage and naming rules</a>
            <a href="INFORMATION_RULES.md">Rules markdown source</a>
            <a href="transcript-calendar-coverage-index.md">Calendar coverage index</a>
          </div>
        </header>

        ${renderCatalogConsole({ files, groups, statusCounts })}

        <div id="route-view" data-view-panel="route">
          ${groups.map(renderGroup).join("")}
        </div>

        <footer>
          Built from <code>cohort-data/.private/transcript-vault/transcript-vault-import-plan.json</code>. This page uses metadata only and does not include raw transcript text.
        </footer>
      </main>
    </div>
  </div>
  <script>
    (() => {
      const viewButtons = [...document.querySelectorAll("[data-view]")];
      const panels = [...document.querySelectorAll("[data-view-panel]")];
      const rows = [...document.querySelectorAll("[data-table-body] tr")];
      const body = document.querySelector("[data-table-body]");
      const count = document.querySelector("[data-row-count]");
      const empty = document.querySelector("[data-empty-table]");
      const filters = {
        search: document.querySelector('[data-filter="search"]'),
        route: document.querySelector('[data-filter="route"]'),
        source: document.querySelector('[data-filter="source"]'),
        calendar: document.querySelector('[data-filter="calendar"]'),
        review: document.querySelector('[data-filter="review"]'),
      };
      const sortSelect = document.querySelector("[data-sort-select]");
      const sortButtons = [...document.querySelectorAll("[data-sort]")];
      let sortKey = "date";
      let sortDir = "asc";

      function setView(view) {
        viewButtons.forEach((button) => button.setAttribute("aria-pressed", button.dataset.view === view ? "true" : "false"));
        panels.forEach((panel) => {
          panel.hidden = panel.dataset.viewPanel !== view;
        });
      }

      function valueFor(row, key) {
        return (row.dataset[key] || "").toLowerCase();
      }

      function compareRows(a, b) {
        const av = valueFor(a, sortKey);
        const bv = valueFor(b, sortKey);
        if (!av && bv) return 1;
        if (av && !bv) return -1;
        const result = av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" });
        return sortDir === "asc" ? result : -result;
      }

      function updateSortState() {
        sortButtons.forEach((button) => {
          const th = button.closest("th");
          if (!th) return;
          if (button.dataset.sort === sortKey) th.setAttribute("aria-sort", sortDir === "asc" ? "ascending" : "descending");
          else th.removeAttribute("aria-sort");
        });
        if (sortSelect && sortSelect.value !== sortKey) sortSelect.value = sortKey;
      }

      function applyFilters() {
        const query = (filters.search?.value || "").trim().toLowerCase();
        const route = filters.route?.value || "";
        const source = filters.source?.value || "";
        const calendar = filters.calendar?.value || "";
        const review = filters.review?.value || "";
        const visible = [];

        rows.forEach((row) => {
          const matches = (!query || row.dataset.search.includes(query))
            && (!route || row.dataset.route === route)
            && (!source || row.dataset.source === source)
            && (!calendar || row.dataset.calendar === calendar)
            && (!review || row.dataset.review === review);
          row.hidden = !matches;
          if (matches) visible.push(row);
        });

        visible.sort(compareRows).forEach((row) => body.appendChild(row));
        if (count) count.textContent = String(visible.length);
        if (empty) empty.hidden = visible.length > 0;
        updateSortState();
      }

      viewButtons.forEach((button) => {
        button.addEventListener("click", () => {
          const update = () => setView(button.dataset.view);
          if (document.startViewTransition) document.startViewTransition(update);
          else update();
        });
      });
      document.querySelectorAll(".rail a").forEach((link) => {
        link.addEventListener("click", () => setView("route"));
      });

      Object.values(filters).forEach((control) => control?.addEventListener("input", applyFilters));
      sortSelect?.addEventListener("change", () => {
        sortKey = sortSelect.value;
        sortDir = "asc";
        applyFilters();
      });
      document.querySelector("[data-clear-filters]")?.addEventListener("click", () => {
        Object.values(filters).forEach((control) => {
          if (control) control.value = "";
        });
        applyFilters();
      });

      sortButtons.forEach((button) => {
        button.addEventListener("click", () => {
          const nextKey = button.dataset.sort;
          if (sortKey === nextKey) sortDir = sortDir === "asc" ? "desc" : "asc";
          else {
            sortKey = nextKey;
            sortDir = "asc";
          }
          applyFilters();
        });
      });

      setView("route");
      applyFilters();
    })();
  </script>
</body>
</html>`;
}

function main(argv = process.argv.slice(2)) {
  if (hasFlag("--help", argv)) {
    console.log(usage());
    return;
  }
  const planPath = path.resolve(arg("--plan", argv) || DEFAULT_PLAN_PATH);
  const auditPath = path.resolve(arg("--source-audit", argv) || DEFAULT_AUDIT_PATH);
  const outPath = path.resolve(arg("--out", argv) || DEFAULT_OUT_PATH);
  const plan = readJson(planPath);
  const sourceAudit = fs.existsSync(auditPath) ? readJson(auditPath) : null;
  const html = renderTranscriptTalkIndex(plan, { sourceAudit });
  writeText(outPath, html);
  console.log(`wrote ${path.relative(ROOT, outPath)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
