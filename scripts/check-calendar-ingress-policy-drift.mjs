import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function extractConstObject(source, constName) {
  const marker = `export const ${constName} =`;
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Missing ${constName}`);

  const start = source.indexOf("{", markerIndex);
  if (start < 0) throw new Error(`Missing object literal for ${constName}`);

  let depth = 0;
  let quote = "";
  let escaping = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }

    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }

  throw new Error(`Unclosed object literal for ${constName}`);
}

function readTsPolicy(relativePath) {
  const source = fs.readFileSync(path.join(root, relativePath), "utf8");
  const literal = extractConstObject(source, "DEFAULT_ROUTING_POLICY");
  return Function(`"use strict"; return (${literal});`)();
}

function normalizePolicy(policy) {
  return {
    schema_version: policy.schema_version,
    policy_key: policy.policy_key,
    version: policy.version,
    title: policy.title,
    calendar_event_defaults: policy.calendar_event_defaults,
    tiers: policy.tiers,
    session_types: Object.fromEntries(
      Object.entries(policy.session_types || {}).map(([key, value]) => [
        key,
        {
          label: value.label,
          description: value.description,
          max_tier: value.max_tier,
          cohort_mode: value.cohort_mode,
          public_allowed: value.public_allowed,
          default_auto_transcript: value.default_auto_transcript,
          required_public_approvals: value.required_public_approvals || [],
          notes: value.notes,
        },
      ]),
    ),
  };
}

function sortForJson(value) {
  if (Array.isArray(value)) return value.map(sortForJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortForJson(value[key])]),
  );
}

function stableJson(value) {
  return JSON.stringify(sortForJson(value), null, 2);
}

function diffSummary(expected, actual) {
  const expectedTypes = Object.keys(expected.session_types || {});
  const actualTypes = Object.keys(actual.session_types || {});
  const missing = expectedTypes.filter((key) => !actualTypes.includes(key));
  const extra = actualTypes.filter((key) => !expectedTypes.includes(key));
  const changed = expectedTypes.filter((key) => {
    if (!actual.session_types?.[key]) return false;
    return stableJson(expected.session_types[key]) !== stableJson(actual.session_types[key]);
  });
  const topLevel = ["schema_version", "policy_key", "version", "calendar_event_defaults", "tiers"]
    .filter((key) => stableJson(expected[key]) !== stableJson(actual[key]));
  return { missing, extra, changed, topLevel };
}

const canonical = normalizePolicy(readJson("cohort-data/policies/transcript-routing-policy.json"));
const web = normalizePolicy((await import(pathToFileURL(path.join(root, "apps/web/scripts/calendar-ingress-client.mjs")).href)).DEFAULT_ROUTING_POLICY);
const os = normalizePolicy((await import(pathToFileURL(path.join(root, "apps/os/src/renderer/calendar-ingress.mjs")).href)).DEFAULT_ROUTING_POLICY);
const supabase = normalizePolicy(readTsPolicy("supabase/functions/_shared/calendar.ts"));

const surfaces = [
  ["web", web],
  ["electron", os],
  ["supabase", supabase],
];

let failed = false;
for (const [label, policy] of surfaces) {
  if (stableJson(policy) === stableJson(canonical)) continue;
  failed = true;
  const summary = diffSummary(canonical, policy);
  console.error(`${label} calendar ingress policy drifted from cohort-data/policies/transcript-routing-policy.json`);
  if (summary.topLevel.length) console.error(`  top-level fields: ${summary.topLevel.join(", ")}`);
  if (summary.missing.length) console.error(`  missing session types: ${summary.missing.join(", ")}`);
  if (summary.extra.length) console.error(`  extra session types: ${summary.extra.join(", ")}`);
  if (summary.changed.length) console.error(`  changed session types: ${summary.changed.join(", ")}`);
}

if (failed) process.exit(1);
console.log("Calendar ingress runtime policies match the canonical transcript-routing policy.");
