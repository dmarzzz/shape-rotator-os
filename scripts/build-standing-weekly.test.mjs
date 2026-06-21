import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStandingWeeklyArtifact,
  fetchStandingWeeklyRows,
  readStandingWeeklyConfig,
  standingWeeklyUrl,
} from "./build-standing-weekly.mjs";

test("standing weekly build falls back to the published public Supabase config", () => {
  const cfg = readStandingWeeklyConfig({});

  assert.equal(cfg.url, "https://txjntzwksiluvqcpccpc.supabase.co");
  assert.match(cfg.key, /^eyJ/);
});

test("standing weekly build lets environment override the public defaults", () => {
  assert.deepEqual(readStandingWeeklyConfig({
    SUPABASE_URL: "https://custom.supabase.co/",
    SUPABASE_ANON_KEY: "anon-override",
  }), {
    url: "https://custom.supabase.co",
    key: "anon-override",
  });
});

test("standing weekly fetch sends the anon key as both apikey and bearer", async () => {
  const rows = await fetchStandingWeeklyRows({
    url: "https://custom.supabase.co",
    key: "anon-key",
    fetchImpl: async (url, init) => {
      assert.equal(url, standingWeeklyUrl("https://custom.supabase.co"));
      assert.match(url, /\/rest\/v1\/public_team_standing_weekly\?/);
      assert.equal(init.headers.apikey, "anon-key");
      assert.equal(init.headers.authorization, "Bearer anon-key");
      return { ok: true, json: async () => [{ record_id: "team-a", program_week: 4, stage: 3, confidence: 0.8 }] };
    },
  });

  assert.equal(rows.length, 1);
});

test("standing weekly artifact groups team rows and labels weeks", () => {
  const artifact = buildStandingWeeklyArtifact([
    { record_id: "team-a", program_week: 1, stage: 2, confidence: 0.7, target_stage: null, target_source: null },
    { record_id: "team-a", program_week: 4, stage: 3, confidence: 0.9, target_stage: 4, target_source: "declared" },
  ]);

  assert.deepEqual(artifact.weeks, [
    { program_week: 1, label: "Week 1" },
    { program_week: 4, label: "Latest" },
  ]);
  assert.deepEqual(artifact.byTeam["team-a"], {
    target_stage: 4,
    target_source: "declared",
    weeks: {
      1: { stage: 2, confidence: 0.7 },
      4: { stage: 3, confidence: 0.9 },
    },
  });
});

test("standing weekly artifact labels the highest observed week as latest", () => {
  const artifact = buildStandingWeeklyArtifact([
    { record_id: "team-a", program_week: 0, stage: 0 },
    { record_id: "team-a", program_week: 1, stage: 1 },
    { record_id: "team-a", program_week: 2, stage: 2 },
  ]);

  assert.deepEqual(artifact.weeks.map((week) => week.label), ["Program start", "Week 1", "Latest"]);
});

test("standing weekly artifact skips malformed rows", () => {
  const artifact = buildStandingWeeklyArtifact([
    null,
    { record_id: null, program_week: 0, stage: 0 },
    { record_id: "team-a", program_week: "bad", stage: 1 },
    { record_id: "team-a", program_week: 1, stage: 2, confidence: "Low" },
  ]);

  assert.deepEqual(artifact.weeks, [{ program_week: 1, label: "Latest" }]);
  assert.deepEqual(Object.keys(artifact.byTeam), ["team-a"]);
});
