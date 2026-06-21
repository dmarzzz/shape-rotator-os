#!/usr/bin/env node
// Mint a long-lived role=cohort_app JWT and write it to the gitignored baked-key
// file (apps/os/build-resources/cohort-app-key.json) so packaged builds + local
// verification pick it up. The JWT is a distributable READ-ONLY key (it only reads
// the gated cohort views — see docs/COHORT_KEY_BUILD_INJECT.md); the signing SECRET
// stays in your gitignored env and is NEVER written to a tracked file or printed.
//
// Usage:
//   node scripts/mint-cohort-key.mjs --env-file .env.calendar.local [--years 5] [--print]
//
// Requires SUPABASE_JWT_SECRET in the env (Supabase dashboard → Settings → API → JWT
// Secret). SUPABASE_URL or SUPABASE_PROJECT_REF supplies the `ref` claim when present.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "./lib/env-file.cjs";
import { mintCohortJwt, decodeJwtPayload } from "./lib/cohort-key.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const argval = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};

const envFile = argval("--env-file");
if (envFile) loadEnvFile(envFile, { cwd: ROOT });
const years = Number(argval("--years", "5"));
const printOnly = argv.includes("--print");

const secret = process.env.SUPABASE_JWT_SECRET || "";
if (!secret) {
  console.error("SUPABASE_JWT_SECRET is required to mint the cohort key.");
  console.error("Add it to your gitignored env (e.g. .env.calendar.local):");
  console.error("  Supabase dashboard → project → Settings → API → JWT Secret");
  process.exit(2);
}

const url = process.env.SUPABASE_URL || "";
const ref = process.env.SUPABASE_PROJECT_REF || (url.match(/https?:\/\/([a-z0-9]+)\.supabase/i) || [])[1] || "";
const expSeconds = Number.isFinite(years) && years > 0 ? Math.round(years * 365.25 * 24 * 3600) : undefined;
const jwt = mintCohortJwt({ secret, ref, expSeconds });
const exp = decodeJwtPayload(jwt)?.exp;
const expDate = exp ? new Date(exp * 1000).toISOString().slice(0, 10) : "?";

if (printOnly) {
  process.stdout.write(jwt + "\n");
  process.stderr.write(`# role=cohort_app · ref=${ref || "(none)"} · exp ${expDate}\n`);
  process.exit(0);
}

const outFile = path.join(ROOT, "apps", "os", "build-resources", "cohort-app-key.json");
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify({ cohortKey: jwt }, null, 2) + "\n", { mode: 0o600 });
console.log(`✓ minted role=cohort_app key → ${path.relative(ROOT, outFile)} (gitignored)`);
console.log(`  ref=${ref || "(none)"} · exp ${expDate} (${years}y)`);
console.log(`  verify:  node scripts/verify-cohort-key.mjs --env-file ${envFile || ".env.calendar.local"}`);
console.log(`  release: export SRFG_COHORT_KEY="$(node scripts/mint-cohort-key.mjs --env-file ${envFile || ".env.calendar.local"} --print 2>/dev/null)" then dist:*`);
