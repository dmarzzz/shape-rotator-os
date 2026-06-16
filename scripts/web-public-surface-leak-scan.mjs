#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const WEB_PUBLIC_LEAK_PATTERNS = [
  { label: "calendar ingress operator asset", pattern: /\bcalendar-ingress(?:-client)?\b/i },
  { label: "calendar operator UI copy", pattern: /\boperator (?:controls|setup|queue|workers)\b/i },
  { label: "calendar operator runbook command", pattern: /\b(?:admin ACL check|calendar:acl:google|calendar:sync:google|artifacts:drive)\b/i },
  { label: "browser credential prompt", pattern: /\b(?:Supabase anon key|signed-in access token|access token \(not saved\)|calendar connection ID)\b/i },
  { label: "calendar admin endpoint or table", pattern: /\b(?:private_invite_contacts|event_requests|processing_jobs|approval_gates|create-calendar-event|review-transcript-artifact|ingest-artifacts)\b/i },
  { label: "private source marker", pattern: /\braw[-_ ]?transcripts?\b|drive:\/\/|["']?(?:source_artifact_id|storage_ref)["']?\s*:|\.(?:source_artifact_id|storage_ref)\b/i },
  { label: "local user path", pattern: /\b[A-Z]:\\Users\\|\/Users\//i },
];

const DEFAULT_TARGETS = [
  "apps/web",
];

const TEXT_EXTENSIONS = /\.(css|html|js|json|md|markdown|mjs|txt|xml)$/i;

function listFiles(target) {
  if (!fs.existsSync(target)) return [];
  const stat = fs.statSync(target);
  if (stat.isFile()) return TEXT_EXTENSIONS.test(target) ? [target] : [];
  const out = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile() && TEXT_EXTENSIONS.test(entry.name)) out.push(full);
  }
  return out;
}

function lineForIndex(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function scanText(text, file = "<memory>", patterns = WEB_PUBLIC_LEAK_PATTERNS) {
  const findings = [];
  for (const { label, pattern } of patterns) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (!match) continue;
    findings.push({
      file,
      line: lineForIndex(text, match.index),
      label,
      excerpt: match[0].slice(0, 120),
    });
  }
  return findings;
}

function scanWebPublicSurface({
  root = ROOT,
  targets = DEFAULT_TARGETS,
  patterns = WEB_PUBLIC_LEAK_PATTERNS,
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
    "Usage: node scripts/web-public-surface-leak-scan.mjs [--root DIR] [--target PATH ...]",
    "",
    "Scans the static public web app for operator/admin calendar surface leaks.",
  ].join("\n");
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = scanWebPublicSurface({
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
  WEB_PUBLIC_LEAK_PATTERNS,
  scanText,
  scanWebPublicSurface,
};
