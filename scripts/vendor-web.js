#!/usr/bin/env node
/**
 * Regenerate static web vendored assets without shell-specific rm/cp calls.
 *
 * Vercel runs this from Linux, but local release checks often run on Windows.
 * Keep it pure Node so `npm run vendor:web` behaves the same everywhere.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");

function rel(absPath) {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join("/");
}

function ensureExists(absPath, label) {
  if (!fs.existsSync(absPath)) {
    throw new Error(`${label} is missing: ${rel(absPath)}`);
  }
}

function copyFile(from, to) {
  ensureExists(from, "source file");
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log(`[vendor-web] copied ${rel(from)} -> ${rel(to)}`);
}

function main() {
  const buildIcs = spawnSync(process.execPath, [path.join(__dirname, "build-ics.js")], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (buildIcs.status !== 0) {
    process.exit(buildIcs.status || 1);
  }

  const shapeUiSource = path.join(REPO_ROOT, "packages", "shape-ui");
  const shapeUiTarget = path.join(REPO_ROOT, "apps", "web", "shape-ui");
  ensureExists(shapeUiSource, "shape-ui package");
  fs.rmSync(shapeUiTarget, { recursive: true, force: true });
  fs.cpSync(shapeUiSource, shapeUiTarget, { recursive: true });
  console.log(`[vendor-web] copied ${rel(shapeUiSource)} -> ${rel(shapeUiTarget)}`);

  copyFile(
    path.join(REPO_ROOT, "apps", "os", "src", "cohort-surface.json"),
    path.join(REPO_ROOT, "apps", "web", "cohort-surface.json"),
  );
  copyFile(
    path.join(REPO_ROOT, "cohort-data", "calendar.json"),
    path.join(REPO_ROOT, "apps", "web", "calendar.json"),
  );
  copyFile(
    path.join(REPO_ROOT, "cohort-data", "calendar.ics"),
    path.join(REPO_ROOT, "apps", "web", "calendar.ics"),
  );
}

try {
  main();
} catch (err) {
  console.error(`[vendor-web] failed: ${err && err.message ? err.message : err}`);
  process.exit(1);
}
