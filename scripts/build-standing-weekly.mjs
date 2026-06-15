#!/usr/bin/env node
// Regenerate apps/os/src/cohort-standing-weekly.json from the Supabase
// `team_standing_weekly` table (public-read). Run after the weekly stage/
// confidence reads are updated — self-reported or derived from evidence_cards —
// so the standing/targets goal views move week-to-week with real data:
//
//   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=<anon> \
//     node scripts/build-standing-weekly.mjs
//
// The artifact is the build OUTPUT; Supabase is the source of truth.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const URL_BASE = process.env.SUPABASE_URL || "https://txjntzwksiluvqcpccpc.supabase.co";
const KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
if (!KEY) {
  console.error("[standing-weekly] set SUPABASE_ANON_KEY (the table is public-read).");
  process.exit(1);
}

const WEEK_LABELS = { 0: "Program start", 1: "Week 1", 2: "Week 2", 3: "Week 3", 4: "Latest" };

const res = await fetch(
  `${URL_BASE}/rest/v1/team_standing_weekly?select=record_id,program_week,stage,confidence,target_stage&order=record_id,program_week`,
  { headers: { apikey: KEY, authorization: `Bearer ${KEY}` } }
);
if (!res.ok) {
  console.error("[standing-weekly] fetch failed:", res.status, await res.text());
  process.exit(1);
}
const rows = await res.json();

const weeksSet = new Set();
const byTeam = {};
for (const r of rows) {
  weeksSet.add(Number(r.program_week));
  const t = byTeam[r.record_id] || (byTeam[r.record_id] = { target_stage: r.target_stage, weeks: {} });
  if (r.target_stage != null) t.target_stage = r.target_stage;
  t.weeks[r.program_week] = { stage: r.stage, confidence: r.confidence };
}
const weeks = [...weeksSet].sort((a, b) => a - b).map((pw) => ({ program_week: pw, label: WEEK_LABELS[pw] || `Week ${pw}` }));

const artifact = { schema_version: 1, generated: "supabase", source: "team_standing_weekly", weeks, byTeam };
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "os", "src", "cohort-standing-weekly.json");
writeFileSync(out, JSON.stringify(artifact, null, 2) + "\n");
console.log(`[standing-weekly] wrote ${Object.keys(byTeam).length} teams × ${weeks.length} weeks → ${out}`);
