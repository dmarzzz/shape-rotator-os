#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import engine from "./lib/cohort-insight-engine.cjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = path.join(ROOT, "cohort-data", "artifacts", "cohort-insights", "generated", "manifest.json");

function fmt(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function stripGeneratedAt(value) {
  if (!value || typeof value !== "object") return value;
  return { ...value, generated_at: null };
}

function parseArgs(argv) {
  const opts = {
    check: false,
    out: DEFAULT_OUT,
    generatedAt: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") opts.check = true;
    else if (arg === "--out") {
      index += 1;
      opts.out = path.resolve(argv[index] || opts.out);
    } else if (arg === "--generated-at") {
      index += 1;
      opts.generatedAt = argv[index] || null;
    } else if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function help() {
  console.log([
    "Usage:",
    "  node scripts/build-cohort-insights.mjs",
    "  node scripts/build-cohort-insights.mjs --check",
    "",
    "Builds deterministic app-safe cohort insight cards from public cohort records",
    "and public GitHub artifacts. Rotation remains a gated contract until reviewed",
    "semantic-distance evidence exists.",
  ].join("\n"));
}

function build({ generatedAt = null } = {}) {
  const inputs = engine.loadCohortInsightInputs({ root: ROOT });
  return engine.buildCohortInsightBundle({
    ...inputs,
    generatedAt,
  });
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    help();
    return;
  }

  const bundle = build({ generatedAt: opts.generatedAt });
  const next = fmt(bundle);
  if (opts.check) {
    if (!fs.existsSync(opts.out)) {
      console.error(`[build-cohort-insights] --check: ${opts.out} does not exist`);
      process.exit(3);
    }
    const current = JSON.parse(fs.readFileSync(opts.out, "utf8"));
    if (JSON.stringify(stripGeneratedAt(current)) !== JSON.stringify(stripGeneratedAt(bundle))) {
      console.error(`[build-cohort-insights] --check: ${opts.out} is stale; run npm run build:cohort-insights`);
      process.exit(4);
    }
    console.log("[build-cohort-insights] --check: cohort insight bundle is up to date");
    return;
  }

  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  if (fs.existsSync(opts.out)) {
    try {
      const current = JSON.parse(fs.readFileSync(opts.out, "utf8"));
      if (JSON.stringify(stripGeneratedAt(current)) === JSON.stringify(stripGeneratedAt(bundle))) {
        console.log(`[build-cohort-insights] up to date; leaving ${opts.out} untouched`);
        return;
      }
    } catch {
      // Fall through and rewrite malformed output.
    }
  }
  fs.writeFileSync(opts.out, next);
  console.log(`[build-cohort-insights] wrote ${opts.out} (${bundle.quality.card_count} cards: ${bundle.quality.kind_counts.say_did_shipped} say/did/shipped, ${bundle.quality.kind_counts.latent_overlap} latent overlaps, ${bundle.quality.kind_counts.award} award scaffolds)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error?.message || String(error));
    process.exit(1);
  }
}

export {
  build,
  main,
};
