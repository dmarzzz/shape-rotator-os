#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Google Calendar system identifiers (shared "group", subscribed "import", and
// room/equipment "resource" calendars) are email-shaped — `<id>@group.calendar.
// google.com` — but they are calendar IDs, not personal email addresses, so they
// are not PII. The `$` anchor is load-bearing: it prevents a real address smuggled
// as `victim@group.calendar.google.com.attacker.com` from being silently allowed.
const CALENDAR_SYSTEM_ID = /@(?:group|import|resource)\.calendar\.google\.com$/i;

const SENSITIVE_PATTERNS = [
  {
    label: "email address",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
    allow: CALENDAR_SYSTEM_ID,
  },
  { label: "private vault pointer", pattern: /\bprivate-vault:/i },
  { label: "Drive source ref", pattern: /\bdrive:\/\//i },
  { label: "source artifact id field", pattern: /"source_artifact_id"\s*:/i },
  { label: "storage ref field", pattern: /"storage_ref"\s*:/i },
  { label: "raw transcript marker", pattern: /\braw[-_ ]?transcript\b/i },
  { label: "source artifacts table marker", pattern: /\bsource_artifacts\b/i },
  { label: "processing jobs table marker", pattern: /\bprocessing_jobs\b/i },
  { label: "local user path", pattern: /\b[A-Z]:\\Users\\|\/Users\//i },
  // A parenthesized H:MM:SS is a transcript/recording timecode (e.g. an
  // attributed quote "… — Tina, Apr 27 (01:47:57)"). Schedule times in these
  // surfaces are H:MM ranges ("16:00 - 19:00") with no seconds, so requiring
  // the seconds component inside parentheses avoids matching them.
  { label: "transcript timecode", pattern: /\([0-9]{1,2}:[0-9]{2}:[0-9]{2}\)/ },
];

const DEFAULT_TARGETS = [
  // The committed, app-shipped surface. This is the bundle that rides inside
  // the published Electron app, so it is the primary thing that must stay free
  // of private transcript markers — historically it was NOT scanned.
  "apps/os/src/cohort-surface.json",
  "apps/web/cohort-surface.json",
  "apps/web/calendar.json",
  "cohort-data/artifacts/public-transcript-articles/generated/manifest.json",
  "cohort-data/artifacts/public-transcript-articles/generated",
  // Defensive: distilled per-session inputs live outside the public repo
  // (cohort-data/.private/, gitignored). If any get re-committed at their old
  // canonical paths these targets catch it. listFiles() tolerates absence.
  "cohort-data/session-insights.json",
  "cohort-data/constellation-cues.json",
  "cohort-data/session-readouts",
];

function listFiles(target) {
  if (!fs.existsSync(target)) return [];
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  const out = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile() && /\.(json|md|html|txt)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

function lineForIndex(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

// Returns the first match that is NOT cleared by `allow`. When an allowlist is
// present we must iterate every match (not just the first) so a real leak later
// in the text is not masked by an allowlisted match earlier in the text.
function firstReportableMatch(text, { pattern, allow }) {
  if (!allow) return pattern.exec(text);
  const global = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
  for (const match of text.matchAll(global)) {
    if (!allow.test(match[0])) return match;
  }
  return null;
}

function scanText(text, file = "<memory>", patterns = SENSITIVE_PATTERNS) {
  const findings = [];
  for (const entry of patterns) {
    const match = firstReportableMatch(text, entry);
    if (!match) continue;
    findings.push({
      file,
      line: lineForIndex(text, match.index),
      label: entry.label,
      excerpt: match[0].slice(0, 120),
    });
  }
  return findings;
}

function scanPublicSurfaces({
  root = ROOT,
  targets = DEFAULT_TARGETS,
  patterns = SENSITIVE_PATTERNS,
} = {}) {
  const files = Array.from(new Set(
    targets.flatMap((target) => listFiles(path.resolve(root, target))),
  )).sort((a, b) => a.localeCompare(b));
  const findings = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    findings.push(...scanText(text, path.relative(root, file).replace(/\\/g, "/"), patterns));
  }
  return { files, findings };
}

function parseArgs(argv) {
  const out = { root: ROOT, targets: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") out.root = path.resolve(argv[++index]);
    else if (arg === "--target") out.targets.push(argv[++index]);
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function usage() {
  return [
    "Usage: node scripts/transcript-surface-leak-scan.mjs [--root DIR] [--target PATH ...]",
    "",
    "Scans generated app/public transcript surfaces for private transcript markers.",
  ].join("\n");
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = scanPublicSurfaces({
    root: options.root,
    targets: options.targets.length ? options.targets : DEFAULT_TARGETS,
  });
  if (result.findings.length) {
    console.error(JSON.stringify({
      ok: false,
      scanned_files: result.files.length,
      findings: result.findings,
    }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({
    ok: true,
    scanned_files: result.files.length,
    findings: [],
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export {
  DEFAULT_TARGETS,
  SENSITIVE_PATTERNS,
  scanPublicSurfaces,
  scanText,
};
