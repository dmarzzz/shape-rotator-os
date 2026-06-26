import { test } from "node:test";
import assert from "node:assert/strict";
import { publicTeamStandingWeeklyUrl, normalizeStandingRows, fetchStandingWeekly } from "./standing-supabase.mjs";

const ROWS = [
  { record_id: "abra", program_week: 0, stage: 0, confidence: "Low", target_stage: null, target_source: "derived" },
  { record_id: "abra", program_week: 1, stage: 2, confidence: "Low", target_stage: 6, target_source: "declared" },
  { record_id: "beta", program_week: 0, stage: 1, confidence: "Medium", target_stage: null, target_source: null },
  { record_id: "beta", program_week: 1, stage: 3, confidence: "High", target_stage: null, target_source: null },
];

test("publicTeamStandingWeeklyUrl targets the public view", () => {
  const u = publicTeamStandingWeeklyUrl("https://x.supabase.co");
  assert.ok(u.startsWith("https://x.supabase.co/rest/v1/public_team_standing_weekly?"));
  assert.match(u, /select=record_id,program_week,stage,confidence,target_stage,target_source/);
  assert.match(u, /order=record_id,program_week/);
});

test("normalizeStandingRows groups by team and labels weeks (lowest=start, highest=Latest)", () => {
  const out = normalizeStandingRows(ROWS);
  assert.deepEqual(out.weeks, [
    { program_week: 0, label: "Program start" },
    { program_week: 1, label: "Latest" },
  ]);
  assert.equal(out.byTeam.abra.target_stage, 6); // declared target carried through
  assert.equal(out.byTeam.abra.target_source, "declared");
  assert.deepEqual(out.byTeam.abra.weeks[0], { stage: 0, confidence: "Low" });
  assert.deepEqual(out.byTeam.beta.weeks[1], { stage: 3, confidence: "High" });
  assert.equal(out.byTeam.beta.target_stage, null);
});

test("normalizeStandingRows labels a mid week by number when 3+ weeks", () => {
  const rows = [0, 1, 2].map((pw) => ({ record_id: "abra", program_week: pw, stage: pw }));
  const out = normalizeStandingRows(rows);
  assert.deepEqual(out.weeks.map((w) => w.label), ["Program start", "Week 1", "Latest"]);
});

test("normalizeStandingRows guards empty / junk input", () => {
  assert.equal(normalizeStandingRows([]), null);
  assert.equal(normalizeStandingRows(null), null);
  assert.equal(normalizeStandingRows([{ record_id: null }]), null);
});

const cfg = { url: "https://x.supabase.co", anonKey: "anon" };
const okFetch = (rows) => async () => ({ ok: true, status: 200, json: async () => rows });

test("fetchStandingWeekly returns supabase data on success", async () => {
  const r = await fetchStandingWeekly({ config: cfg, fetchImpl: okFetch(ROWS) });
  assert.equal(r.source, "supabase");
  assert.equal(r.data.byTeam.abra.weeks[1].stage, 2);
});

test("fetchStandingWeekly degrades without config", async () => {
  const r = await fetchStandingWeekly({ config: { url: "", anonKey: "" }, fetchImpl: okFetch(ROWS) });
  assert.equal(r.source, "unconfigured");
  assert.equal(r.data, null);
});

test("fetchStandingWeekly maps a non-ok response to error", async () => {
  const r = await fetchStandingWeekly({ config: cfg, fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.equal(r.source, "error");
  assert.match(r.error, /503/);
});

test("fetchStandingWeekly returns empty when there are no rows", async () => {
  const r = await fetchStandingWeekly({ config: cfg, fetchImpl: okFetch([]) });
  assert.equal(r.source, "empty");
});

test("fetchStandingWeekly never throws on a fetch failure", async () => {
  const r = await fetchStandingWeekly({ config: cfg, fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(r.source, "error");
  assert.match(r.error, /offline/);
});
