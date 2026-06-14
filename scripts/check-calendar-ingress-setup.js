#!/usr/bin/env node
const path = require("node:path");
const {
  buildSetupReport,
  mergeEnv,
  renderSetupReport,
} = require("./lib/calendar-ingress-setup.cjs");

function usage() {
  return [
    "Usage:",
    "  node scripts/check-calendar-ingress-setup.js [--env-file .env.local] [--json] [--allow-missing]",
    "",
    "Checks local calendar-ingress files plus required credential names.",
    "Secret values are never printed.",
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
  const envFile = arg("--env-file");
  const env = mergeEnv({ envFile });
  const report = buildSetupReport({
    repoRoot: path.resolve(__dirname, ".."),
    env,
  });
  if (process.argv.includes("--json")) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(renderSetupReport(report) + "\n");
  }
  if (!report.ok && !process.argv.includes("--allow-missing")) process.exit(1);
}

main();
