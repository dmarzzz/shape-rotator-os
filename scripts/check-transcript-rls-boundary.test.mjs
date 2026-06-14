import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateRole,
  runTranscriptRlsBoundaryCheck,
} from "./check-transcript-rls-boundary.mjs";

test("RLS matrix fails when a member can read private transcript rows", () => {
  const result = evaluateRole("member", [
    { table: "source_artifacts", ok: true, status: 200, row_count: 1 },
    { table: "app_transcript_distillations", ok: true, status: 200, row_count: 1 },
  ]);

  assert.equal(result.status, "fail");
  assert.match(result.failures[0], /member can read source_artifacts/);
});

test("RLS matrix warns when member private-table checks have no seed rows", () => {
  const result = evaluateRole("member", [
    { table: "source_artifacts", ok: true, status: 200, row_count: 0 },
    { table: "app_transcript_distillations", ok: true, status: 200, row_count: 1 },
  ]);

  assert.equal(result.status, "warn");
  assert.match(result.warnings[0], /not proven/);
});

test("RLS checker queries app views and private tables for supplied role tokens", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return Response.json([]);
  };

  const result = await runTranscriptRlsBoundaryCheck({
    supabaseUrl: "https://project.supabase.co",
    anonKey: "anon",
    orgId: "org_1",
    tokens: { member: "member-token" },
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(result.roles[0].status, "warn");
  assert.ok(calls.some((call) => call.url.includes("/source_artifacts")));
  assert.ok(calls.some((call) => call.url.includes("/app_transcript_distillations")));
  assert.ok(calls.every((call) => call.options.headers.authorization === "Bearer member-token"));
});
