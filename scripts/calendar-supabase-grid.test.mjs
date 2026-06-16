import test from "node:test";
import assert from "node:assert/strict";

import { buildUpsertRequest, publishGrid, scanGridForLeaks } from "./publish-calendar-grid-to-supabase.mjs";
import {
  publicCalendarGridUrl,
  normalizeGrid,
  fetchPublicCalendarGrid,
} from "../apps/os/src/renderer/calendar-supabase.mjs";

const GRID = {
  last_refresh: "2026-06-15T21:00:00.000Z",
  source: "build-calendar-from-google",
  tabs: { "May 18 Start": [["Week", "Dates"], ["1", "May 18-23"]] },
};

// ── writer: buildUpsertRequest ──────────────────────────────────────────
test("buildUpsertRequest targets the upsert endpoint and carries the grid", () => {
  const { url, body } = buildUpsertRequest({ url: "https://x.supabase.co/", grid: GRID, now: "2026-06-15T21:05:00.000Z" });
  assert.equal(url, "https://x.supabase.co/rest/v1/public_calendar_grid?on_conflict=id");
  assert.equal(body.id, "current");
  assert.deepEqual(body.grid, GRID);
  assert.equal(body.source, "build-calendar-from-google");
  assert.equal(body.last_refresh, GRID.last_refresh);
  assert.equal(body.updated_at, "2026-06-15T21:05:00.000Z");
});

test("buildUpsertRequest defaults source when the grid omits it", () => {
  const { body } = buildUpsertRequest({ url: "https://x.supabase.co", grid: { tabs: {} }, now: "t" });
  assert.equal(body.source, "build-calendar-from-google");
  assert.equal(body.last_refresh, null);
});

test("buildUpsertRequest rejects a missing url or a non-grid", () => {
  assert.throws(() => buildUpsertRequest({ url: "", grid: GRID }), /SUPABASE_URL is required/);
  assert.throws(() => buildUpsertRequest({ url: "https://x", grid: {} }), /tabs/);
  assert.throws(() => buildUpsertRequest({ url: "https://x", grid: null }), /tabs/);
});

// ── writer: leak gate (security review #2) ──────────────────────────────
test("scanGridForLeaks passes a clean schedule grid (incl. times/dates)", () => {
  const clean = { tabs: { "May 18 Start": [["Week", "Dates"], ["1", "May 18-23", "16:00-17:30 Onboarding"]] } };
  assert.deepEqual(scanGridForLeaks(clean), []);
});

test("scanGridForLeaks catches emails, video links, private markers, candid notes", () => {
  assert.deepEqual(scanGridForLeaks({ tabs: { t: [["ping a@b.com"]] } }), ["email address"]);
  assert.deepEqual(scanGridForLeaks({ tabs: { t: [["join meet.google.com/xyz"]] } }), ["video-call link"]);
  assert.deepEqual(scanGridForLeaks({ tabs: { t: [["leadership_meeting prep"]] } }), ["private routing marker"]);
  assert.deepEqual(scanGridForLeaks({ tabs: { t: [["Goals — Tina: pivot"]] } }), ["candid leadership note"]);
});

test("publishGrid refuses to upsert a grid that trips the leak gate (no fetch)", async () => {
  let fetched = false;
  const fetchImpl = async () => { fetched = true; return { ok: true, status: 201 }; };
  await assert.rejects(
    () => publishGrid({ url: "https://x", key: "k", grid: { tabs: { t: [["call zoom.us/j/1"]] } }, fetchImpl, now: "t" }),
    /refusing to publish.*video-call link/,
  );
  assert.equal(fetched, false, "must not reach Supabase when the gate trips");
});

// ── writer: publishGrid ─────────────────────────────────────────────────
test("publishGrid skips cleanly when Supabase env is absent", async () => {
  const res = await publishGrid({ url: "", key: "", grid: GRID });
  assert.equal(res.skipped, true);
});

test("publishGrid POSTs an upsert with service-role auth headers", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 201 };
  };
  const res = await publishGrid({ url: "https://x.supabase.co", key: "svc-key", grid: GRID, fetchImpl, now: "t" });
  assert.equal(res.skipped, false);
  assert.equal(res.status, 201);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.method, "POST");
  assert.equal(calls[0].opts.headers.apikey, "svc-key");
  assert.match(calls[0].opts.headers.prefer, /merge-duplicates/);
  assert.deepEqual(JSON.parse(calls[0].opts.body).grid, GRID);
});

test("publishGrid throws on a non-ok response", async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => "no" });
  await assert.rejects(
    () => publishGrid({ url: "https://x", key: "k", grid: GRID, fetchImpl, now: "t" }),
    /Supabase upsert failed: 401/,
  );
});

// ── reader: url + normalize ─────────────────────────────────────────────
test("publicCalendarGridUrl selects the single current row", () => {
  const url = publicCalendarGridUrl("https://x.supabase.co");
  assert.match(url, /\/rest\/v1\/public_calendar_grid\?/);
  assert.match(url, /id=eq\.current/);
  assert.match(url, /limit=1/);
});

test("normalizeGrid accepts a tabs grid and rejects junk", () => {
  assert.deepEqual(normalizeGrid({ grid: GRID }), GRID);
  assert.equal(normalizeGrid({ grid: { no_tabs: true } }), null);
  assert.equal(normalizeGrid({ grid: null }), null);
  assert.equal(normalizeGrid(null), null);
});

// ── reader: fetchPublicCalendarGrid ─────────────────────────────────────
const CONFIG = { url: "https://x.supabase.co", anonKey: "anon-key" };

test("fetchPublicCalendarGrid returns the live grid on success", async () => {
  const fetchImpl = async (url, opts) => {
    assert.match(url, /public_calendar_grid/);
    assert.equal(opts.headers.apikey, "anon-key");
    return { ok: true, json: async () => [{ grid: GRID }] };
  };
  const res = await fetchPublicCalendarGrid({ config: CONFIG, fetchImpl });
  assert.equal(res.source, "supabase");
  assert.deepEqual(res.grid, GRID);
});

test("fetchPublicCalendarGrid degrades without throwing", async () => {
  assert.equal((await fetchPublicCalendarGrid({ config: { url: "", anonKey: "" }, fetchImpl: async () => ({}) })).source, "unconfigured");
  assert.equal((await fetchPublicCalendarGrid({ config: CONFIG, fetchImpl: async () => ({ ok: false, status: 500 }) })).source, "error");
  assert.equal((await fetchPublicCalendarGrid({ config: CONFIG, fetchImpl: async () => ({ ok: true, json: async () => [] }) })).source, "empty");
  const thrown = await fetchPublicCalendarGrid({ config: CONFIG, fetchImpl: async () => { throw new Error("net"); } });
  assert.equal(thrown.source, "error");
});
