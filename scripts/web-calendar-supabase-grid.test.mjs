import test from "node:test";
import assert from "node:assert/strict";

import {
  publicCalendarGridUrl,
  normalizeGrid,
  fetchPublicCalendarGrid,
  readSupabaseConfig,
} from "../apps/web/scripts/calendar-supabase-grid.mjs";
import { DEFAULT_SUPABASE_URL, DEFAULT_PUBLIC_ANON_KEY } from "../apps/web/scripts/calendar-ingress-client.mjs";

const GRID = { last_refresh: "2026-06-16T00:00:00.000Z", tabs: { "May 18 Start": [["Week", "Dates"]] } };
const CONFIG = { url: "https://x.supabase.co", anonKey: "anon-key" };

test("publicCalendarGridUrl selects the single current row", () => {
  const url = publicCalendarGridUrl("https://x.supabase.co");
  assert.match(url, /\/rest\/v1\/public_calendar_grid\?/);
  assert.match(url, /id=eq\.current/);
  assert.match(url, /limit=1/);
});

test("normalizeGrid accepts a tabs grid and rejects junk", () => {
  assert.deepEqual(normalizeGrid({ grid: GRID }), GRID);
  assert.equal(normalizeGrid({ grid: { no_tabs: true } }), null);
  assert.equal(normalizeGrid(null), null);
});

test("readSupabaseConfig falls back to the baked anon key + project URL", () => {
  const { url, anonKey } = readSupabaseConfig({ getItem: () => null });
  assert.equal(url, DEFAULT_SUPABASE_URL);
  assert.equal(anonKey, DEFAULT_PUBLIC_ANON_KEY);
  assert.match(anonKey, /^eyJ/); // a JWT
});

test("readSupabaseConfig lets a per-deployment config override the defaults", () => {
  const storage = { getItem: () => JSON.stringify({ supabaseUrl: "https://y.co/", supabaseAnonKey: "k2" }) };
  assert.deepEqual(readSupabaseConfig(storage), { url: "https://y.co", anonKey: "k2" });
});

test("the baked web anon key is the anon role (not service)", () => {
  const payload = JSON.parse(Buffer.from(DEFAULT_PUBLIC_ANON_KEY.split(".")[1], "base64").toString());
  assert.equal(payload.role, "anon");
  assert.equal(payload.ref, "txjntzwksiluvqcpccpc");
});

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
  assert.equal((await fetchPublicCalendarGrid({ config: CONFIG, fetchImpl: async () => { throw new Error("net"); } })).source, "error");
});
