import test from "node:test";
import assert from "node:assert/strict";
import {
  appendCohortEvent, fetchCohortFeed, defaultWeightFor,
  COHORT_EVENT_TYPES, COHORT_EVENT_WEIGHTS,
} from "./supabase-cohort-events.mjs";

const CONFIG = { url: "https://db.example", anonKey: "anon123" };

test("defaultWeightFor follows the noise line", () => {
  assert.equal(defaultWeightFor("transcript"), "loud");
  assert.equal(defaultWeightFor("contest"), "loud");
  assert.equal(defaultWeightFor("self_report"), "loud");
  assert.equal(defaultWeightFor("connection"), "medium");
  assert.equal(defaultWeightFor("ask"), "loud");
  assert.equal(defaultWeightFor("prefs"), "quiet");
  assert.equal(defaultWeightFor("profile_edit", "weekly_intention"), "loud");
  assert.equal(defaultWeightFor("profile_edit", "now"), "loud");
  assert.equal(defaultWeightFor("profile_edit", "skills"), "medium");
  assert.equal(defaultWeightFor("profile_edit", "seeking"), "medium");
  assert.equal(defaultWeightFor("profile_edit", "pronouns"), "quiet"); // cosmetic
  assert.equal(defaultWeightFor("profile_edit", null), "quiet");
});

test("the vocab constants match the migration CHECK sets", () => {
  assert.deepEqual([...COHORT_EVENT_TYPES].sort(),
    ["ask", "connection", "contest", "prefs", "profile_edit", "self_report", "transcript"]);
  assert.deepEqual([...COHORT_EVENT_WEIGHTS].sort(), ["loud", "medium", "quiet"]);
});

test("appendCohortEvent validates record_id and event_type before any fetch", async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true }; };
  assert.deepEqual(await appendCohortEvent({ eventType: "profile_edit" }, { config: CONFIG, fetchImpl }),
    { ok: false, error: "no_record_id" });
  assert.deepEqual(await appendCohortEvent({ recordId: "p1", eventType: "nope" }, { config: CONFIG, fetchImpl }),
    { ok: false, error: "bad_event_type" });
  assert.equal(called, false);
});

test("appendCohortEvent posts a normalized body with resolved weight", async () => {
  let body = null;
  const fetchImpl = async (_url, init) => { body = JSON.parse(init.body); return { ok: true }; };
  const res = await appendCohortEvent(
    { recordId: "p1", actor: "p1", eventType: "profile_edit", field: "weekly_intention",
      value: { fields: ["weekly_intention"] }, claimTokenHash: "deadbeef" },
    { config: CONFIG, fetchImpl },
  );
  assert.deepEqual(res, { ok: true });
  assert.equal(body.record_id, "p1");
  assert.equal(body.actor, "p1");
  assert.equal(body.event_type, "profile_edit");
  assert.equal(body.field, "weekly_intention");
  assert.equal(body.weight, "loud"); // resolved from the field
  assert.equal(body.claim_token_hash, "deadbeef");
  assert.deepEqual(body.value, { fields: ["weekly_intention"] });
});

test("appendCohortEvent honors an explicit valid weight and drops an oversized payload", async () => {
  let body = null;
  const fetchImpl = async (_u, init) => { body = JSON.parse(init.body); return { ok: true }; };
  await appendCohortEvent(
    { recordId: "p1", eventType: "transcript", weight: "quiet", value: { big: "x".repeat(9000) } },
    { config: CONFIG, fetchImpl },
  );
  assert.equal(body.weight, "quiet");
  assert.deepEqual(body.value, {}); // overflow dropped to {}
  // A non-object value also normalizes to {}.
  await appendCohortEvent({ recordId: "p1", eventType: "transcript", value: [1, 2] }, { config: CONFIG, fetchImpl });
  assert.deepEqual(body.value, {});
});

test("fetchCohortFeed maps rows, drops prefs + malformed, and survives an outage", async () => {
  const rows = [
    { id: "1", record_id: "p1", actor: "p1", event_type: "transcript", value: { t: 1 }, weight: "loud", created_at: "2026-06-25T00:00:00Z" },
    { id: "2", record_id: "p2", event_type: "prefs", value: { feed_mode: "global" }, weight: "quiet", created_at: "2026-06-25T01:00:00Z" },
    { id: "3", record_id: "", event_type: "contest", value: {} }, // malformed: no record_id
    { id: "4", record_id: "p3", event_type: "weird", value: {} },  // malformed: bad type
  ];
  const ok = await fetchCohortFeed({ config: CONFIG, fetchImpl: async () => ({ ok: true, json: async () => rows }) });
  assert.equal(ok.source, "supabase");
  assert.equal(ok.events.length, 1);
  assert.equal(ok.events[0].event_type, "transcript");
  assert.equal(ok.events[0].weight, "loud");

  const out = await fetchCohortFeed({ config: CONFIG, fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.deepEqual(out, { events: [], source: "none" });
});
