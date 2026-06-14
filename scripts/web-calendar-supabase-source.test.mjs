import test from "node:test";
import assert from "node:assert/strict";
import {
  calendarJsonFromSessions,
  fetchSupabaseSessions,
  loadSupabaseCalendarSnapshot,
} from "../apps/web/scripts/calendar-supabase-source.mjs";

test("web supabase calendar source converts session rows into calendar grid JSON", () => {
  const calendar = calendarJsonFromSessions({
    lastRefresh: "2026-06-12T12:00:00Z",
    sessions: [
      {
        title: "Private title",
        public_title: "Demo",
        session_type: "demo_presentation",
        max_tier: "T3",
        status: "scheduled",
        starts_at: "2026-06-16T16:00:00-04:00",
        ends_at: "2026-06-16T17:00:00-04:00",
        timezone: "America/New_York",
        google_meet_url: "https://meet.google.com/abc-defg-hij",
      },
      {
        title: "Cancelled",
        status: "cancelled",
        starts_at: "2026-06-16T18:00:00-04:00",
        ends_at: "2026-06-16T19:00:00-04:00",
      },
    ],
  });

  assert.equal(calendar.source, "supabase-sessions");
  assert.equal(calendar.tabs["Supabase Sessions"].length, 2);
  assert.match(calendar.tabs["Supabase Sessions"][1][3], /Demo/);
  assert.match(calendar.tabs["Supabase Sessions"][1][3], /Meet: https:\/\/meet\.google\.com\/abc-defg-hij/);
  assert.doesNotMatch(JSON.stringify(calendar), /Cancelled/);
});

test("web supabase calendar source skips fetch when config is incomplete", async () => {
  const calls = [];
  const rows = await fetchSupabaseSessions({
    config: {},
    fetchImpl: async (...args) => {
      calls.push(args);
      return { ok: true, json: async () => [] };
    },
  });

  assert.equal(rows, null);
  assert.equal(calls.length, 0);

  const noUserTokenRows = await fetchSupabaseSessions({
    config: {
      supabaseUrl: "https://project.supabase.co",
      supabaseAnonKey: "anon",
      orgId: "org_1",
    },
    fetchImpl: async (...args) => {
      calls.push(args);
      return { ok: true, json: async () => [] };
    },
  });

  assert.equal(noUserTokenRows, null);
  assert.equal(calls.length, 0);
});

test("web supabase calendar source queries sessions with signed-in auth", async () => {
  let observed = null;
  const rows = await fetchSupabaseSessions({
    config: {
      supabaseUrl: "https://project.supabase.co/",
      supabaseAnonKey: "anon",
      accessToken: "user-token",
      orgId: "org_1",
    },
    fetchImpl: async (url, init) => {
      observed = { url: String(url), init };
      return {
        ok: true,
        json: async () => [{ title: "Office hours" }],
      };
    },
  });

  assert.deepEqual(rows, [{ title: "Office hours" }]);
  assert.match(observed.url, /^https:\/\/project\.supabase\.co\/rest\/v1\/sessions\?/);
  assert.match(observed.url, /org_id=eq\.org_1/);
  assert.equal(observed.init.headers.apikey, "anon");
  assert.equal(observed.init.headers.authorization, "Bearer user-token");
});

test("web supabase calendar snapshot returns calendar JSON from fetched sessions", async () => {
  const snapshot = await loadSupabaseCalendarSnapshot({
    config: {
      supabaseUrl: "https://project.supabase.co",
      supabaseAnonKey: "anon",
      accessToken: "user-token",
      orgId: "org_1",
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => [{
        public_title: "Office hours",
        status: "scheduled",
        starts_at: "2026-06-16T16:00:00-04:00",
        ends_at: "2026-06-16T17:00:00-04:00",
        timezone: "America/New_York",
      }],
    }),
  });

  assert.equal(snapshot.source, "supabase-sessions");
  assert.match(JSON.stringify(snapshot), /Office hours/);
});
