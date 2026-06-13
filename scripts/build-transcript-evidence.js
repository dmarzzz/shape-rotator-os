#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  artifactFileName,
  buildEvidenceBundle,
  listEntityIdsFromFiles,
  stableJson,
} = require("./lib/transcript-evidence.cjs");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_INPUT = path.join(ROOT, "cohort-data", "session-insights.json");
const DEFAULT_OUT_DIR = path.join(ROOT, "cohort-data", "artifacts", "transcript-evidence", "generated");

function parseArgs(argv) {
  const options = {
    input: DEFAULT_INPUT,
    outDir: DEFAULT_OUT_DIR,
    check: false,
    stdout: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") {
      options.input = path.resolve(argv[++index]);
    } else if (arg === "--out-dir") {
      options.outDir = path.resolve(argv[++index]);
    } else if (arg === "--check") {
      options.check = true;
    } else if (arg === "--stdout") {
      options.stdout = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function usage() {
  return [
    "Usage: node scripts/build-transcript-evidence.js [--check] [--stdout] [--input path] [--out-dir path]",
    "",
    "Compiles reviewed transcript readouts into generated evidence cards, role views, and a manifest.",
    "",
    "  --check     fail if generated files differ from the current output directory",
    "  --stdout    print the generated bundle instead of writing files",
  ].join("\n");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function listMarkdownFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((file) => file.endsWith(".md"));
}

function buildExpectedFiles(bundle) {
  const files = new Map();
  for (const card of bundle.cards) {
    files.set(artifactFileName(card), stableJson(card));
  }
  files.set("views.json", stableJson(bundle.views));
  files.set("manifest.json", stableJson(bundle.manifest));
  return files;
}

function generatedAtForRun(options) {
  if (options.check) {
    const manifestPath = path.join(options.outDir, "manifest.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = readJson(manifestPath);
      if (manifest.generated_at) return manifest.generated_at;
    }
  }
  return new Date().toISOString();
}

function writeFiles(outDir, files) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const [file, contents] of files) {
    fs.writeFileSync(path.join(outDir, file), contents);
  }
}

function checkFiles(outDir, files) {
  const mismatches = [];
  for (const [file, expected] of files) {
    const target = path.join(outDir, file);
    if (!fs.existsSync(target)) {
      mismatches.push(`${file} is missing`);
      continue;
    }
    const actual = fs.readFileSync(target, "utf8");
    if (actual !== expected) {
      mismatches.push(`${file} is stale`);
    }
  }

  const expectedNames = new Set(files.keys());
  const actualJsonFiles = fs.existsSync(outDir)
    ? fs.readdirSync(outDir).filter((file) => file.endsWith(".json"))
    : [];
  for (const file of actualJsonFiles) {
    if (!expectedNames.has(file)) {
      mismatches.push(`${file} is no longer generated`);
    }
  }

  if (mismatches.length > 0) {
    throw new Error(`Transcript evidence artifacts are not current:\n${mismatches.join("\n")}`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const readouts = readJson(options.input);
  const teamIds = listEntityIdsFromFiles(listMarkdownFiles(path.join(ROOT, "cohort-data", "teams")));
  const personIds = listEntityIdsFromFiles(listMarkdownFiles(path.join(ROOT, "cohort-data", "people")));
  const bundle = buildEvidenceBundle(readouts, {
    teamIds,
    personIds,
    generatedAt: generatedAtForRun(options),
  });

  if (options.stdout) {
    process.stdout.write(stableJson(bundle));
    return;
  }

  const files = buildExpectedFiles(bundle);
  if (options.check) {
    checkFiles(options.outDir, files);
    console.log(`Transcript evidence artifacts are current (${bundle.cards.length} cards).`);
    return;
  }

  writeFiles(options.outDir, files);
  console.log(`Wrote ${bundle.cards.length} transcript evidence cards to ${path.relative(ROOT, options.outDir)}`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
