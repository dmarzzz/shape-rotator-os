#!/usr/bin/env node
// Unified surface leak scanner. Replaces the two former scanners:
//   --transcripts  scan generated app/public bundles for private transcript markers
//                  (was transcript-surface-leak-scan.mjs / transcripts:surface:scan)
//   --web          scan the static public web app for operator/admin leaks
//                  (was web-public-surface-leak-scan.mjs / web:surface:scan)
//   --all          run both (default)
// Patterns + per-mode config live in lib/surface-leak-patterns.mjs. Fail-closed:
// any finding exits non-zero. Neither mode is wired into CI — these are manual /
// pre-release audits backing the commit-time privacy guard.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MODES, scanText } from "./lib/surface-leak-patterns.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function listFiles(target, { extensions, filterExplicitFile }) {
  if (!fs.existsSync(target)) return [];
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (filterExplicitFile && !extensions.test(target)) return [];
    return [target];
  }
  const out = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, { extensions, filterExplicitFile }));
    else if (entry.isFile() && extensions.test(entry.name)) out.push(full);
  }
  return out;
}

// Scan one mode's surfaces. Returns { files, findings } identical in shape to the
// two original scanners (findings: { file, line, label, excerpt }).
export function scanSurface({ root = ROOT, mode, targets } = {}) {
  const cfg = MODES[mode];
  if (!cfg) throw new Error(`unknown scan mode: ${mode}`);
  const useTargets = targets && targets.length ? targets : cfg.targets;
  const files = Array.from(new Set(
    useTargets.flatMap((target) => listFiles(path.resolve(root, target), cfg)),
  )).sort((a, b) => a.localeCompare(b));
  const findings = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    findings.push(...scanText(text, path.relative(root, file).replace(/\\/g, "/"), cfg.patterns));
  }
  return { files, findings };
}

// Back-compat convenience wrappers — preserve the two original module APIs so the
// migrated tests (and any ad hoc importer) keep working unchanged.
export function scanTranscriptSurfaces({ root = ROOT, targets } = {}) {
  return scanSurface({ root, mode: "transcript", targets });
}
export function scanWebSurfaces({ root = ROOT, targets } = {}) {
  return scanSurface({ root, mode: "web", targets });
}
export function scanTranscriptText(text, file = "<memory>") {
  return scanText(text, file, MODES.transcript.patterns);
}
export function scanWebText(text, file = "<memory>") {
  return scanText(text, file, MODES.web.patterns);
}

export { MODES, scanText } from "./lib/surface-leak-patterns.mjs";

function parseArgs(argv) {
  const out = { root: ROOT, modes: [], targets: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") out.root = path.resolve(argv[++index]);
    else if (arg === "--target") out.targets.push(argv[++index]);
    else if (arg === "--transcripts" || arg === "--transcript") out.modes.push("transcript");
    else if (arg === "--web") out.modes.push("web");
    else if (arg === "--all") out.modes.push("transcript", "web");
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function usage() {
  return [
    "Usage: node scripts/surface-leak-scan.mjs [--transcripts|--web|--all] [--root DIR] [--target PATH ...]",
    "",
    "Scans public-facing surfaces for private/operator leaks. Default mode: --all.",
    "  --transcripts  generated app/public transcript surfaces",
    "  --web          static public web app (operator/admin leaks)",
    "  --target PATH  override default targets (single mode only); repeatable",
  ].join("\n");
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  const modes = options.modes.length ? Array.from(new Set(options.modes)) : ["transcript", "web"];
  if (options.targets.length && modes.length !== 1) {
    throw new Error("--target can only be used with a single mode (--transcripts or --web)");
  }
  const scannedFiles = new Set();
  const findings = [];
  for (const mode of modes) {
    const result = scanSurface({ root: options.root, mode, targets: options.targets });
    result.files.forEach((file) => scannedFiles.add(file));
    findings.push(...result.findings.map((finding) => ({ mode, ...finding })));
  }
  const ok = findings.length === 0;
  const payload = { ok, modes, scanned_files: scannedFiles.size, findings: ok ? [] : findings };
  if (ok) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.error(JSON.stringify(payload, null, 2));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
