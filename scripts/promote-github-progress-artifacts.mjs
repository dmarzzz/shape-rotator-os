#!/usr/bin/env node
/**
 * Promote reviewed GitHub progress artifacts into the app-facing artifact set.
 *
 * This script is the human review boundary for API-free GitHub progress checks.
 * The generator may create many public commit-metadata candidates, but those
 * candidates must not affect Shape Rotator OS until an operator explicitly
 * promotes selected weekly team summaries.
 *
 * Promotion rules:
 * 1. Never edit generated artifacts in place. Promotion writes reviewed copies.
 * 2. By default, only github_progress_weekly_summary artifacts can be promoted.
 * 3. By default, only team-level artifacts can be promoted. Do not create
 *    person-level claims from commit metadata here.
 * 4. Refuse hold/operator_only recommendations unless --force is supplied.
 * 5. Refuse already-reviewed/non-generated source artifacts unless --force is
 *    supplied, so re-runs are intentional.
 * 6. High-volume or mixed-signal artifacts can still be promoted, but only by
 *    explicit artifact id/file selection and reviewer note.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_GENERATED_DIR = path.join(REPO_ROOT, "cohort-data", "artifacts", "github-progress", "generated");
const DEFAULT_REVIEWED_DIR = path.join(REPO_ROOT, "cohort-data", "artifacts", "github-progress", "reviewed");
const WEEKLY_KIND = "github_progress_weekly_summary";
const BLOCKED_RECOMMENDATIONS = new Set(["hold", "operator_only"]);

function rel(file) {
  return path.relative(REPO_ROOT, file).replace(/\\/g, "/");
}

function parseArgs(argv) {
  const out = {
    artifactIds: [],
    files: [],
    sourceDir: DEFAULT_GENERATED_DIR,
    reviewedDir: DEFAULT_REVIEWED_DIR,
    reviewer: "operator",
    note: "",
    recommendation: "",
    recordId: "",
    limit: Infinity,
    list: false,
    dryRun: false,
    force: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[++i];
    };

    if (arg === "--artifact-id") out.artifactIds.push(next());
    else if (arg === "--file") out.files.push(path.resolve(REPO_ROOT, next()));
    else if (arg === "--source-dir") out.sourceDir = path.resolve(REPO_ROOT, next());
    else if (arg === "--reviewed-dir") out.reviewedDir = path.resolve(REPO_ROOT, next());
    else if (arg === "--reviewer") out.reviewer = next();
    else if (arg === "--note") out.note = next();
    else if (arg === "--recommendation") out.recommendation = next();
    else if (arg === "--record-id") out.recordId = next();
    else if (arg === "--limit") out.limit = Math.max(1, Number(next()) || 1);
    else if (arg === "--list") out.list = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--force") out.force = true;
    else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return out;
}

function usage() {
  console.log([
    "Usage: node scripts/promote-github-progress-artifacts.mjs [options]",
    "",
    "List generated candidates:",
    "  node scripts/promote-github-progress-artifacts.mjs --list",
    "  node scripts/promote-github-progress-artifacts.mjs --list --recommendation promote_candidate",
    "",
    "Promote selected candidates:",
    "  node scripts/promote-github-progress-artifacts.mjs --artifact-id github-progress:dealproof:kkoci-dealproof:2026-06-08 --reviewer operator --note \"clear weekly product movement\"",
    "",
    "Options:",
    "  --artifact-id id        Generated artifact id to promote; repeatable",
    "  --file path             Generated artifact file to promote; repeatable",
    "  --source-dir path       Generated artifact dir; defaults to cohort-data/artifacts/github-progress/generated",
    "  --reviewed-dir path     Reviewed artifact dir; defaults to cohort-data/artifacts/github-progress/reviewed",
    "  --reviewer name         Reviewer label recorded in reviewed artifact",
    "  --note text             Reviewer note recorded in reviewed artifact",
    "  --recommendation value  Filter --list output by surface_recommendation",
    "  --record-id id          Filter --list output by team record_id",
    "  --limit N               Limit --list output",
    "  --dry-run               Validate and print writes without writing files",
    "  --force                 Override promotion refusals; use sparingly",
  ].join("\n"));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function listJsonFilesRecursive(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsonFilesRecursive(full));
    else if (entry.isFile() && entry.name.endsWith(".json") && entry.name !== "manifest.json") out.push(full);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function loadArtifacts(sourceDir) {
  return listJsonFilesRecursive(sourceDir)
    .map((file) => ({ file, artifact: readJson(file) }))
    .sort((a, b) => String(a.artifact.artifact_id || "").localeCompare(String(b.artifact.artifact_id || "")));
}

function summarizeArtifact(entry) {
  const artifact = entry.artifact;
  const evidence = artifact.evidence || {};
  return [
    artifact.surface_recommendation || "unknown",
    artifact.artifact_id || rel(entry.file),
    artifact.record_id || "",
    artifact.source_repo || "",
    artifact.week_start || artifact.date || "",
    `human=${evidence.human_commit_count ?? ""}`,
    `bot=${evidence.bot_commit_count ?? ""}`,
    `admin=${evidence.admin_commit_count ?? ""}`,
    `useful=${evidence.useful_commit_count ?? ""}`,
    artifact.summary || artifact.title || "",
  ].join(" | ");
}

function filterList(entries, opts) {
  let out = entries;
  if (opts.recommendation) {
    out = out.filter((entry) => entry.artifact?.surface_recommendation === opts.recommendation);
  }
  if (opts.recordId) {
    out = out.filter((entry) => entry.artifact?.record_id === opts.recordId);
  }
  return out.slice(0, opts.limit);
}

function selectForPromotion(entries, opts) {
  const selected = [];
  const byId = new Map(entries.map((entry) => [entry.artifact?.artifact_id, entry]));
  const byFile = new Map(entries.map((entry) => [path.resolve(entry.file), entry]));

  for (const id of opts.artifactIds) {
    const entry = byId.get(id);
    if (!entry) throw new Error(`artifact id not found in ${rel(opts.sourceDir)}: ${id}`);
    selected.push(entry);
  }

  for (const file of opts.files) {
    const entry = byFile.get(path.resolve(file)) || { file, artifact: readJson(file) };
    selected.push(entry);
  }

  const seen = new Set();
  return selected.filter((entry) => {
    const key = entry.artifact?.artifact_id || path.resolve(entry.file);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validatePromotion(entry, opts) {
  const artifact = entry.artifact;
  const errors = [];

  if (!artifact || typeof artifact !== "object") {
    errors.push("artifact is not a JSON object");
    return errors;
  }

  if (artifact.artifact_kind !== WEEKLY_KIND) {
    errors.push(`artifact_kind is ${artifact.artifact_kind || "missing"}, expected ${WEEKLY_KIND}`);
  }
  if (artifact.record_type !== "team" || !artifact.record_id) {
    errors.push("artifact must be a team-level record with record_id");
  }
  if (artifact.review_status !== "generated") {
    errors.push(`review_status is ${artifact.review_status || "missing"}, expected generated`);
  }
  if (BLOCKED_RECOMMENDATIONS.has(artifact.surface_recommendation)) {
    errors.push(`surface_recommendation ${artifact.surface_recommendation} is blocked by default`);
  }

  return opts.force ? [] : errors;
}

function promote(entry, opts, now) {
  const artifact = entry.artifact;
  const reviewed = {
    ...artifact,
    review_status: "reviewed",
    reviewed_at: now,
    reviewed_by: opts.reviewer,
    review_note: opts.note || "Promoted after operator review.",
    promotion_source_file: rel(entry.file),
    promotion_rules_version: 1,
  };
  return reviewed;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const entries = loadArtifacts(opts.sourceDir);

  if (opts.list) {
    for (const entry of filterList(entries, opts)) {
      console.log(summarizeArtifact(entry));
    }
    return;
  }

  if (!opts.artifactIds.length && !opts.files.length) {
    usage();
    throw new Error("provide --artifact-id or --file, or use --list");
  }

  const selected = selectForPromotion(entries, opts);
  if (!selected.length) throw new Error("no artifacts selected");

  const now = new Date().toISOString();
  const writes = [];
  for (const entry of selected) {
    const errors = validatePromotion(entry, opts);
    if (errors.length) {
      throw new Error(`${entry.artifact?.artifact_id || rel(entry.file)} not promotable:\n- ${errors.join("\n- ")}`);
    }
    const reviewed = promote(entry, opts, now);
    writes.push({
      artifact: reviewed,
      outFile: path.join(opts.reviewedDir, path.basename(entry.file)),
    });
  }

  for (const write of writes) {
    if (!opts.dryRun) writeJson(write.outFile, write.artifact);
    console.log(`${opts.dryRun ? "would promote" : "promoted"} ${write.artifact.artifact_id} -> ${rel(write.outFile)}`);
  }
}

try {
  main();
} catch (err) {
  console.error(`[promote-github-progress] ${err.message}`);
  process.exit(1);
}
