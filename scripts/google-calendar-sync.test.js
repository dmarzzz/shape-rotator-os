const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  applyCancellationPatches,
  buildGoogleEventsListUrl,
  googleEventsToSyncRows,
  runGoogleCalendarSync,
} = require("./sync-google-calendar-events.js");
const { loadRoutingPolicy } = require("./lib/calendar-integration.cjs");

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const CONNECTION_ID = "22222222-2222-2222-2222-222222222222";

function calendarEvent(id = "evt_1") {
  return {
    id,
    summary: "Office hours",
    status: "confirmed",
    organizer: { email: "calendar@example.com" },
    start: { dateTime: "2026-06-16T16:00:00-04:00", timeZone: "America/New_York" },
    end: { dateTime: "2026-06-16T17:00:00-04:00", timeZone: "America/New_York" },
    attendees: [{ email: "guest@example.com", responseStatus: "accepted" }],
  };
}

function makeSupabaseResponse(url, options, body) {
  const pathname = new URL(String(url)).pathname;
  if (pathname.endsWith("/calendar_connections") && options.method === "GET") {
    return Response.json([{
      id: CONNECTION_ID,
      org_id: ORG_ID,
      calendar_id: "cohort@example.com",
      status: "active",
    }]);
  }
  if (pathname.endsWith("/calendar_sync_state") && options.method === "GET") {
    return Response.json([{
      id: "33333333-3333-3333-3333-333333333333",
      org_id: ORG_ID,
      calendar_connection_id: CONNECTION_ID,
      google_sync_token: "stored-token",
      sync_status: "requested",
    }]);
  }
  if (pathname.endsWith("/routing_policies") && options.method === "GET") {
    return Response.json([{ policy_json: loadRoutingPolicy() }]);
  }
  if (pathname.endsWith("/sessions") && options.method === "GET") {
    return Response.json([]);
  }
  if (pathname.endsWith("/calendar_sync_state") && options.method === "POST") {
    return Response.json(body);
  }
  if (pathname.endsWith("/sessions") && options.method === "POST") {
    return Response.json(body);
  }
  if (pathname.endsWith("/session_attendees") && options.method === "POST") {
    return Response.json(body);
  }
  if (pathname.endsWith("/sessions") && options.method === "PATCH") {
    return Response.json([{ id: body.id || "patched", ...body }]);
  }
  return Response.json({ error: `unexpected ${options.method} ${pathname}` }, { status: 404 });
}

test("Google events.list URL keeps reusable sync-token parameters clean", () => {
  const url = buildGoogleEventsListUrl({
    calendarId: "cohort@example.com",
    syncToken: "token-1",
  });

  assert.equal(url.searchParams.get("syncToken"), "token-1");
  assert.equal(url.searchParams.get("showDeleted"), "true");
  assert.equal(url.searchParams.get("singleEvents"), "true");
  assert.equal(url.searchParams.has("timeMin"), false);
  assert.throws(
    () => buildGoogleEventsListUrl({ calendarId: "cohort@example.com", syncToken: "token-1", timeMin: "2026-06-01T00:00:00Z" }),
    /timeMin\/timeMax cannot be used with syncToken/,
  );
});

test("Google calendar sync CLI loads org and connection from env file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-google-sync-cli-"));
  const envFile = path.join(dir, ".env.calendar.local");
  const eventsFile = path.join(dir, "events.json");
  fs.writeFileSync(envFile, [
    `ORG_ID=${ORG_ID}`,
    `CALENDAR_CONNECTION_ID=${CONNECTION_ID}`,
    "GOOGLE_CALENDAR_ID=cohort@example.com",
  ].join("\n"));
  fs.writeFileSync(eventsFile, JSON.stringify({ items: [calendarEvent("cli_evt")] }, null, 2));

  const output = execFileSync(process.execPath, [
    path.join(__dirname, "sync-google-calendar-events.js"),
    "--env-file",
    envFile,
    "--events",
    eventsFile,
  ], {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
    windowsHide: true,
  });
  const result = JSON.parse(output);

  assert.equal(result.source.live, false);
  assert.equal(result.source.calendar_connection_id, CONNECTION_ID);
  assert.equal(result.sessions[0].org_id, ORG_ID);
  assert.equal(result.sessions[0].calendar_connection_id, CONNECTION_ID);
  assert.equal(result.sessions[0].google_event_id, "cli_evt");
});

test("live calendar sync uses stored token, paginates, applies rows, and stores next token", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), method: options.method || "GET", body });
    if (parsed.hostname === "www.googleapis.com") {
      assert.equal(options.headers.authorization, "Bearer google-token");
      assert.equal(parsed.searchParams.get("syncToken"), "stored-token");
      if (!parsed.searchParams.get("pageToken")) {
        return Response.json({ items: [calendarEvent()], nextPageToken: "page-2" });
      }
      assert.equal(parsed.searchParams.get("pageToken"), "page-2");
      return Response.json({ items: [], nextSyncToken: "next-token" });
    }
    return makeSupabaseResponse(url, { method: options.method || "GET" }, body);
  };

  const output = await runGoogleCalendarSync({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service",
    calendarConnectionId: CONNECTION_ID,
    accessToken: "google-token",
    apply: true,
    fetchImpl,
  });

  assert.equal(output.sync.mode, "incremental");
  assert.equal(output.sync.stored_sync_token_used, true);
  assert.equal(output.nextSyncToken, "next-token");
  assert.equal(output.sessions.length, 1);
  assert.equal(output.attendees.length, 1);
  assert.equal(output.applied.skippedAttendees.length, 0);
  assert.ok(calls.some((call) => call.method === "POST" && call.url.includes("/sessions") && call.body[0].google_event_id === "evt_1"));
  assert.ok(calls.some((call) => call.method === "POST" && call.url.includes("/session_attendees") && call.body[0].session_id));
  const statePosts = calls.filter((call) => call.method === "POST" && call.url.includes("/calendar_sync_state"));
  assert.equal(statePosts[0].body[0].sync_status, "running");
  assert.equal(statePosts.at(-1).body[0].sync_status, "ok");
  assert.equal(statePosts.at(-1).body[0].google_sync_token, "next-token");
  assert.equal(statePosts.at(-1).body[0].sync_requested_at, null);
  assert.ok(statePosts.at(-1).body[0].last_incremental_sync_at);
});

test("live calendar sync can refresh OAuth access token", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const body = options.body ? String(options.body) : "";
    calls.push({ url: String(url), method: options.method || "GET", body });
    if (parsed.hostname === "oauth2.googleapis.com") {
      assert.match(body, /grant_type=refresh_token/);
      assert.match(body, /refresh_token=refresh-token/);
      return Response.json({ access_token: "fresh-google-token", expires_in: 3599 });
    }
    if (parsed.hostname === "www.googleapis.com") {
      assert.equal(options.headers.authorization, "Bearer fresh-google-token");
      return Response.json({ items: [], nextSyncToken: "next-token" });
    }
    const parsedBody = options.body ? JSON.parse(options.body) : null;
    return makeSupabaseResponse(url, { method: options.method || "GET" }, parsedBody);
  };

  const output = await runGoogleCalendarSync({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service",
    calendarConnectionId: CONNECTION_ID,
    oauthClientId: "client-id",
    oauthClientSecret: "client-secret",
    oauthRefreshToken: "refresh-token",
    apply: true,
    fetchImpl,
  });

  assert.equal(output.sync.mode, "incremental");
  assert.equal(output.nextSyncToken, "next-token");
  assert.ok(calls.some((call) => call.url.includes("oauth2.googleapis.com/token")));
});

test("calendar sync preserves existing session ids for already imported Google events", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), method: options.method || "GET", body });
    if (parsed.pathname.endsWith("/sessions") && (options.method || "GET") === "GET") {
      assert.equal(parsed.searchParams.get("calendar_connection_id"), `eq.${CONNECTION_ID}`);
      return Response.json([{
        id: "existing-session-id",
        calendar_connection_id: CONNECTION_ID,
        google_event_id: "evt_1",
      }]);
    }
    if (parsed.pathname.endsWith("/sessions") && options.method === "POST") {
      assert.equal(body[0].id, "existing-session-id");
      assert.equal(body[0].google_event_id, "evt_1");
      return Response.json(body);
    }
    if (parsed.pathname.endsWith("/session_attendees") && options.method === "POST") {
      assert.equal(body[0].session_id, "existing-session-id");
      return Response.json(body);
    }
    return makeSupabaseResponse(url, { method: options.method || "GET" }, body);
  };

  const output = await runGoogleCalendarSync({
    events: { items: [calendarEvent("evt_1")] },
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service",
    orgId: ORG_ID,
    calendarConnectionId: CONNECTION_ID,
    apply: true,
    fetchImpl,
  });

  assert.equal(output.applied.sessionIdAlignment.length, 1);
  assert.equal(output.applied.sessionIdAlignment[0].to_id, "existing-session-id");
  assert.ok(calls.some((call) => call.method === "POST" && call.url.includes("/sessions")));
  assert.ok(calls.some((call) => call.method === "POST" && call.url.includes("/session_attendees")));
});

test("expired Google sync token is cleared and retried as a full sync", async () => {
  const googleCalls = [];
  const statePosts = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const body = options.body ? JSON.parse(options.body) : null;
    if (parsed.hostname === "www.googleapis.com") {
      googleCalls.push(parsed);
      if (parsed.searchParams.get("syncToken")) {
        return Response.json({ error: { code: 410, message: "Sync token is no longer valid" } }, { status: 410 });
      }
      return Response.json({ items: [], nextSyncToken: "fresh-token" });
    }
    if (parsed.pathname.endsWith("/calendar_sync_state") && options.method === "POST") {
      statePosts.push(body[0]);
    }
    return makeSupabaseResponse(url, { method: options.method || "GET" }, body);
  };

  const output = await runGoogleCalendarSync({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service",
    calendarConnectionId: CONNECTION_ID,
    accessToken: "google-token",
    apply: true,
    fetchImpl,
  });

  assert.equal(output.sync.mode, "full_after_expired_token");
  assert.equal(output.sync.recovered_from_expired_sync_token, true);
  assert.equal(googleCalls.length, 2);
  assert.equal(googleCalls[0].searchParams.get("syncToken"), "stored-token");
  assert.equal(googleCalls[1].searchParams.has("syncToken"), false);
  assert.ok(statePosts.some((row) => row.sync_status === "expired" && row.google_sync_token === null));
  assert.equal(statePosts.at(-1).sync_status, "ok");
  assert.equal(statePosts.at(-1).google_sync_token, "fresh-token");
  assert.ok(statePosts.at(-1).last_full_sync_at);
});

test("cancelled Google tombstones become session patches, not invalid inserts", () => {
  const rows = googleEventsToSyncRows([{
    id: "gone-event",
    status: "cancelled",
    etag: "\"gone\"",
  }], {
    orgId: ORG_ID,
    calendarConnectionId: CONNECTION_ID,
    policy: loadRoutingPolicy(),
  });

  assert.equal(rows.sessions.length, 0);
  assert.equal(rows.attendees.length, 0);
  assert.equal(rows.cancellationPatches.length, 1);
  assert.equal(rows.cancellationPatches[0].google_event_id, "gone-event");
  assert.equal(rows.cancellationPatches[0].status, "cancelled");
});

test("cancellation patches target the (calendar_connection_id, google_event_id) natural key, not the deterministic id (C1-01)", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method });
    return { ok: true, status: 200, json: async () => [], text: async () => "[]" };
  };
  await applyCancellationPatches({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service_role_test",
    cancellationPatches: [{
      id: "deterministic-id-that-may-not-match-stored-row",
      calendar_connection_id: CONNECTION_ID,
      google_event_id: "gone-event",
      status: "cancelled",
      google_etag: "\"gone\"",
      updated_at: "2026-01-01T00:00:00.000Z",
    }],
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  const url = calls[0].url;
  // Targets the natural key (the table's unique constraint) so webhook-created
  // rows or rows with an explicit shape_session_id are also tombstoned.
  assert.match(url, /google_event_id=eq\.gone-event/);
  assert.match(url, new RegExp(`calendar_connection_id=eq\\.${CONNECTION_ID}`));
  // Must NOT fall back to the deterministic id while the natural key is present.
  assert.doesNotMatch(url, /[?&]id=eq\./);
});
