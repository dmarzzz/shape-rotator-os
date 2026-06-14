#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const {
  mergeEnv,
  renderDeployPlan,
} = require("./lib/calendar-ingress-setup.cjs");

function usage() {
  return [
    "Usage:",
    "  node scripts/prepare-calendar-ingress-deploy-plan.js [--env-file .env.calendar.local] [--out deploy-plan.md]",
    "",
    "Generates a secret-safe deployment runbook for calendar ingress.",
  ].join("\n");
}

function arg(name) {
  const idx = process.argv.indexOf(name);
  return idx === -1 ? null : process.argv[idx + 1];
}

function main() {
  if (process.argv.includes("--help")) {
    console.log(usage());
    return;
  }
  const envFile = arg("--env-file") || ".env.calendar.local";
  const env = mergeEnv({ envFile: fs.existsSync(path.resolve(envFile)) ? envFile : null });
  const markdown = renderDeployPlan({
    env,
    envFile,
    projectRef: arg("--project-ref") || env.SUPABASE_PROJECT_REF,
  });
  const out = arg("--out");
  if (out && out !== "-") {
    fs.writeFileSync(path.resolve(out), markdown + "\n");
  } else {
    process.stdout.write(markdown + "\n");
  }
}

main();
