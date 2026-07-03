#!/usr/bin/env node
import process from "node:process";
import { loadEnvFile } from "./lib/env-file.cjs";
import {
  formatPackagedCohortKeyInspection,
  inspectPackagedCohortKey,
  projectRefFromSupabaseUrl,
} from "./lib/packaged-cohort-key.mjs";

const argv = process.argv.slice(2);
const argval = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};

const envFile = argval("--env-file");
if (envFile) loadEnvFile(envFile);

const expectedRef = argval(
  "--expected-ref",
  process.env.SUPABASE_PROJECT_REF || projectRefFromSupabaseUrl(process.env.SUPABASE_URL || ""),
);
const minDays = Number(argval("--min-days", "30"));
const nowArg = argval("--now");
const now = nowArg ? new Date(nowArg) : new Date();
const result = inspectPackagedCohortKey({
  filePath: argval("--file") || undefined,
  expectedRef,
  minDays: Number.isFinite(minDays) ? minDays : 30,
  now: Number.isNaN(now.getTime()) ? new Date() : now,
});

if (argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  process.stdout.write(formatPackagedCohortKeyInspection(result));
}

const allowEmpty = argv.includes("--allow-empty") && result.status === "empty";
process.exit(result.ready || allowEmpty ? 0 : 1);
