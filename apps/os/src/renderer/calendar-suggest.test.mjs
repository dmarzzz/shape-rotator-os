import test from "node:test";
import assert from "node:assert/strict";
import { buildEventSuggestion, submitEventSuggestion } from "./calendar-suggest.mjs";

test("buildEventSuggestion builds a routed context_submissions payload", () => {
  const r = buildEventSuggestion({
    title: "zk-proofs reading circle",
    date: "2026-07-14",
    start: "16:00",
    end: "17:30",
    category: "salon",
    details: "weekly, ~8 people",
    contact: "@mike",
  }, { clientId: "c_test" });
  assert.equal(r.ok, true);
  assert.equal(r.payload.source_kind, "other");           // passes the kind CHECK
  assert.equal(r.payload.org_id, "srfg");
  assert.equal(r.payload.processing_status, "pending");
  assert.equal(r.payload.title, "Event suggestion: zk-proofs reading circle");
  assert.equal(r.payload.contact, "@mike");
  assert.equal(r.payload.client_id, "c_test");
  assert.equal(r.payload.metadata.submitted_via, "os-calendar-suggest");
  assert.equal(r.payload.metadata.kind, "event_suggestion");
  assert.deepEqual(r.payload.metadata.event, {
    title: "zk-proofs reading circle",
    date: "2026-07-14", start: "16:00", end: "17:30", category: "salon",
  });
  // readable body: title line + friendly when-line + type + details
  assert.match(r.payload.body, /^Event suggestion — zk-proofs reading circle/);
  assert.match(r.payload.body, /When: Tue Jul 14 · 16:00–17:30/);
  assert.match(r.payload.body, /Type: salon/);
  assert.match(r.payload.body, /weekly, ~8 people/);
});

test("buildEventSuggestion when-line degrades: all-day and date TBD", () => {
  const allDay = buildEventSuggestion({ title: "hike", date: "2026-07-18" });
  assert.match(allDay.payload.body, /When: Sat Jul 18 · all-day/);
  const tbd = buildEventSuggestion({ title: "hike" });
  assert.match(tbd.payload.body, /When: date TBD/);
  assert.equal(tbd.payload.metadata.event.date, null);
});

test("buildEventSuggestion rejects bad input with friendly errors", () => {
  assert.equal(buildEventSuggestion({}).ok, false);
  assert.equal(buildEventSuggestion({ title: "x", date: "14/07/2026" }).ok, false);
  assert.equal(buildEventSuggestion({ title: "x", start: "4pm" }).ok, false);
  assert.equal(buildEventSuggestion({ title: "x", end: "17:00" }).ok, false); // end without start
  assert.equal(buildEventSuggestion({ title: "x", date: "2026-07-14", start: "17:00", end: "16:00" }).ok, false);
});

test("buildEventSuggestion clamps long fields to the table limits", () => {
  const r = buildEventSuggestion({
    title: "t".repeat(500),
    details: "d".repeat(5000),
    contact: "c".repeat(500),
  });
  assert.equal(r.ok, true);
  assert.ok(r.payload.title.length <= 300);
  assert.ok(r.payload.contact.length <= 200);
  assert.ok(r.payload.metadata.event.title.length <= 200);
});

test("submitEventSuggestion posts via the context inbox wire shape", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 201 };
  };
  const res = await submitEventSuggestion(
    { title: "demo night warmup", date: "2026-07-20" },
    { clientId: "c_test", fetchImpl, config: { url: "https://x.supabase.co", anonKey: "anon" } },
  );
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/rest\/v1\/context_submissions$/);
  assert.equal(calls[0].opts.headers.prefer, "return=minimal"); // anon is write-only
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.source_kind, "other");
  assert.equal(body.metadata.kind, "event_suggestion");
});

test("submitEventSuggestion surfaces validation errors without touching the network", async () => {
  let called = false;
  const res = await submitEventSuggestion({}, { clientId: "c", fetchImpl: async () => { called = true; } });
  assert.equal(res.ok, false);
  assert.equal(called, false);
});
