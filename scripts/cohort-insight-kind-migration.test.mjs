// Drift guard for the cohort_insight_cards.kind CHECK whitelist.
//
// The schema is co-owned with the private transcript-engine repo and the live
// DB has drifted, so each kind migration re-DROPs and re-ADDs the full CHECK
// list. That makes it easy to silently *narrow* the whitelist — which is what
// happened once: a migration rebuilt the list without `collaboration_edge`,
// even though 20260620000000 had added it and this repo still emits it
// (cohort-insight-engine.cjs → publish-cohort-insights-supabase.mjs upsert).
// Result: the next publish would hit a CHECK violation and the ADD CONSTRAINT
// itself would fail on any existing row of that kind.
//
// Invariant pinned here: the LATEST kind migration's whitelist must be a
// superset of every prior kind migration's whitelist (a kind is never orphaned),
// and must include the kinds this repo writes into cohort_insight_cards.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(here, "..", "supabase", "migrations");

// Extract the kind set from every `... cohort_insight_cards_kind_check ... kind in (...)`
// definition in a SQL file (DROP + ADD both mention the name; the ADD carries
// the list). Returns the union of kinds declared in that file, or null if the
// file doesn't define the constraint.
function kindWhitelist(sql) {
  const re = /cohort_insight_cards_kind_check[\s\S]*?kind\s+in\s*\(([^)]*)\)/gi;
  const kinds = new Set();
  let m, matched = false;
  while ((m = re.exec(sql)) !== null) {
    for (const tok of m[1].match(/'[a-z_]+'/g) || []) {
      kinds.add(tok.slice(1, -1));
      matched = true;
    }
  }
  return matched ? kinds : null;
}

// Every migration file that defines the kind whitelist, sorted by filename
// (timestamp-prefixed → chronological). The last one is the effective whitelist.
const kindMigrations = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => ({ file: f, kinds: kindWhitelist(readFileSync(resolve(MIGRATIONS, f), "utf8")) }))
  .filter((x) => x.kinds);

test("there is at least one kind-defining migration", () => {
  assert.ok(kindMigrations.length >= 2, "expected the original + incremental kind migrations");
});

test("the latest kind whitelist never narrows a prior one (no orphaned kinds)", () => {
  const latest = kindMigrations[kindMigrations.length - 1];
  for (const prior of kindMigrations.slice(0, -1)) {
    const dropped = [...prior.kinds].filter((k) => !latest.kinds.has(k));
    assert.deepEqual(
      dropped,
      [],
      `${latest.file} drops kind(s) [${dropped.join(", ")}] that ${prior.file} allowed — ` +
        `a re-ADD CONSTRAINT would reject existing rows / future upserts of those kinds`,
    );
  }
});

test("the latest whitelist includes the kinds this repo writes to cohort_insight_cards", () => {
  const latest = kindMigrations[kindMigrations.length - 1].kinds;
  // The snapshot producer (cohort-snapshot-cards.mjs) emits these card rows, and
  // the insight engine still emits collaboration_edge.
  for (const k of ["connection_edge", "card_attribution", "cluster_summary", "collaboration_edge"]) {
    assert.ok(latest.has(k), `latest kind whitelist is missing '${k}' (a kind this repo upserts)`);
  }
});
