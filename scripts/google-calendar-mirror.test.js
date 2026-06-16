const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildGuestMirrorEventBody,
  fetchSourceSessions,
  needsMirrorUpdate,
  runGuestCalendarMirror,
  stableMirrorEventId,
} = require("./mirror-google-calendar-events.js");

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const SOURCE_CONNECTION_ID = "22222222-2222-2222-2222-222222222222";
const MIRROR_CONNECTION_ID = "33333333-3333-3333-3333-333333333333";
const MIRROR_CALENDAR_ID = "guest-calendar@example.com";

function session(overrides = {}) {
  return {
    id: "44444444-4444-4444-4444-444444444444",
    org_id: ORG_ID,
    calendar_connection_id: SOURCE_CONNECTION_ID,
    title: "Admin-only internal title",
    public_title: "Demo night",
    session_type: "demo_presentation",
    max_tier: "T3",
    status: "scheduled",
    starts_at: "2026-06-16T16:00:00-04:00",
    ends_at: "2026-06-16T17:00:00-04:00",
    timezone: "America/New_York",
    google_calendar_id: "admin-calendar@example.com",
    google_event_id: "admin_evt_1",
    google_etag: "\"source-etag-1\"",
    google_meet_url: "https://meet.google.com/abc-defg-hij",
    ...overrides,
  };
}

test("guest mirror body keeps join link but strips transcript-owning surfaces", () => {
  const body = buildGuestMirrorEventBody({
    session: session(),
    mirrorCalendarId: MIRROR_CALENDAR_ID,
  });

  assert.equal(body.id, stableMirrorEventId(session()));
  assert.equal(body.summary, "Demo night");
  assert.match(body.description, /Join: https:\/\/meet\.google\.com\/abc-defg-hij/);
  assert.equal(body.location, "https://meet.google.com/abc-defg-hij");
  assert.deepEqual(body.start, {
    dateTime: "2026-06-16T16:00:00-04:00",
    timeZone: "America/New_York",
  });
  assert.equal(body.guestsCanModify, false);
  assert.equal(body.guestsCanInviteOthers, false);
  assert.equal(body.guestsCanSeeOtherGuests, false);
  assert.equal(body.attendees, undefined);
  assert.equal(body.conferenceData, undefined);
  assert.equal(body.attachments, undefined);
  assert.equal(body.extendedProperties.private.shape_mirror_kind, "guest_calendar");
  assert.equal(body.extendedProperties.private.shape_source_google_event_id, "admin_evt_1");
});

test("mirror update uses source etag to avoid redundant patches", () => {
  const mapping = {
    mirror_google_event_id: "mirror_evt_1",
    mirror_status: "active",
    source_google_etag: "\"source-etag-1\"",
  };

  assert.equal(needsMirrorUpdate({ session: session(), mapping }), false);
  assert.equal(needsMirrorUpdate({ session: session({ google_etag: "\"source-etag-2\"" }), mapping }), true);
  assert.equal(needsMirrorUpdate({ session: session(), mapping, force: true }), true);
});

test("dry-run plans insert, update, delete, and unchanged mirror actions", async () => {
  const rows = [
    session({ google_event_id: "new_evt", google_etag: "\"new\"" }),
    session({ google_event_id: "changed_evt", google_etag: "\"changed-2\"" }),
    session({ google_event_id: "same_evt", google_etag: "\"same\"" }),
    session({ google_event_id: "cancelled_evt", status: "cancelled", google_etag: "\"gone\"" }),
  ];
  const result = await runGuestCalendarMirror({
    sessions: rows,
    mappings: [
      {
        id: "map_changed",
        org_id: ORG_ID,
        source_calendar_connection_id: SOURCE_CONNECTION_ID,
        source_google_event_id: "changed_evt",
        source_google_etag: "\"changed-1\"",
        mirror_calendar_connection_id: MIRROR_CONNECTION_ID,
        mirror_google_calendar_id: MIRROR_CALENDAR_ID,
        mirror_google_event_id: "mirror_changed",
        mirror_status: "active",
      },
      {
        id: "map_same",
        org_id: ORG_ID,
        source_calendar_connection_id: SOURCE_CONNECTION_ID,
        source_google_event_id: "same_evt",
        source_google_etag: "\"same\"",
        mirror_calendar_connection_id: MIRROR_CONNECTION_ID,
        mirror_google_calendar_id: MIRROR_CALENDAR_ID,
        mirror_google_event_id: "mirror_same",
        mirror_status: "active",
      },
      {
        id: "map_cancelled",
        org_id: ORG_ID,
        source_calendar_connection_id: SOURCE_CONNECTION_ID,
        source_google_event_id: "cancelled_evt",
        source_google_etag: "\"old\"",
        mirror_calendar_connection_id: MIRROR_CONNECTION_ID,
        mirror_google_calendar_id: MIRROR_CALENDAR_ID,
        mirror_google_event_id: "mirror_cancelled",
        mirror_status: "active",
      },
    ],
    sourceCalendarConnectionId: SOURCE_CONNECTION_ID,
    mirrorCalendarConnectionId: MIRROR_CONNECTION_ID,
    mirrorCalendarId: MIRROR_CALENDAR_ID,
  });

  assert.equal(result.apply, false);
  assert.deepEqual(result.actions.map((action) => action.action), [
    "insert",
    "update",
    "unchanged",
    "delete",
  ]);
});

test("guest mirror skips do_not_publish session types so private titles never reach the public calendar", async () => {
  const rows = [
    session({ google_event_id: "demo_evt", session_type: "demo_presentation" }),
    session({ google_event_id: "private_evt", session_type: "private_1on1", public_title: "Career coaching", title: "1:1 coaching" }),
    session({ google_event_id: "strategy_evt", session_type: "planning_strategy", public_title: "Fundraising strategy" }),
  ];
  const result = await runGuestCalendarMirror({
    sessions: rows,
    mappings: [],
    sourceCalendarConnectionId: SOURCE_CONNECTION_ID,
    mirrorCalendarConnectionId: MIRROR_CONNECTION_ID,
    mirrorCalendarId: MIRROR_CALENDAR_ID,
  });
  const byEvent = new Map(result.actions.map((action) => [action.source_google_event_id, action.action]));
  assert.equal(byEvent.get("demo_evt"), "insert");
  assert.equal(byEvent.get("private_evt"), "skip-do-not-publish-session-type");
  assert.equal(byEvent.get("strategy_evt"), "skip-do-not-publish-session-type");
});

test("guest mirror deletes stale mirrors when sessions become do_not_publish", async () => {
  const result = await runGuestCalendarMirror({
    sessions: [
      session({
        google_event_id: "private_evt",
        session_type: "private_1on1",
        public_title: "Career coaching",
        title: "1:1 coaching",
      }),
    ],
    mappings: [{
      id: "map_private",
      org_id: ORG_ID,
      source_calendar_connection_id: SOURCE_CONNECTION_ID,
      source_google_event_id: "private_evt",
      source_google_etag: "\"old\"",
      mirror_calendar_connection_id: MIRROR_CONNECTION_ID,
      mirror_google_calendar_id: MIRROR_CALENDAR_ID,
      mirror_google_event_id: "mirror_private",
      mirror_status: "active",
    }],
    sourceCalendarConnectionId: SOURCE_CONNECTION_ID,
    mirrorCalendarConnectionId: MIRROR_CONNECTION_ID,
    mirrorCalendarId: MIRROR_CALENDAR_ID,
  });

  assert.equal(result.deleted, 1);
  assert.equal(result.actions[0].action, "delete");
  assert.equal(result.actions[0].reason, "do-not-publish-session-type");
  assert.equal(result.actions[0].mirror_google_event_id, "mirror_private");
});

test("apply deletes stale do_not_publish mirror events", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ method: options.method || "GET", path: parsed.pathname, body });
    if (parsed.hostname === "www.googleapis.com" && options.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (parsed.pathname.endsWith("/calendar_event_mirrors") && options.method === "POST") {
      assert.equal(body[0].mirror_status, "cancelled");
      return Response.json(body);
    }
    return Response.json({ error: `unexpected ${options.method || "GET"} ${url}` }, { status: 404 });
  };

  const result = await runGuestCalendarMirror({
    sessions: [session({ session_type: "planning_strategy" })],
    mappings: [{
      id: "map_private",
      org_id: ORG_ID,
      source_calendar_connection_id: SOURCE_CONNECTION_ID,
      source_google_event_id: "admin_evt_1",
      source_google_etag: "\"old\"",
      mirror_calendar_connection_id: MIRROR_CONNECTION_ID,
      mirror_google_calendar_id: MIRROR_CALENDAR_ID,
      mirror_google_event_id: "mirror_private",
      mirror_status: "active",
    }],
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service",
    sourceCalendarConnectionId: SOURCE_CONNECTION_ID,
    mirrorCalendarConnectionId: MIRROR_CONNECTION_ID,
    mirrorCalendarId: MIRROR_CALENDAR_ID,
    accessToken: "google-token",
    apply: true,
    fetchImpl,
  });

  assert.equal(result.deleted, 1);
  assert.ok(calls.some((call) => call.method === "DELETE" && call.path.includes("/events/mirror_private")));
});

test("apply inserts safe guest event and persists mirror mapping", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ method: options.method || "GET", path: parsed.pathname, query: parsed.searchParams, body });
    if (parsed.hostname === "www.googleapis.com" && parsed.pathname.endsWith("/events")) {
      assert.equal(options.headers.authorization, "Bearer google-token");
      assert.equal(options.method, "POST");
      assert.equal(body.attendees, undefined);
      assert.equal(body.conferenceData, undefined);
      assert.equal(body.attachments, undefined);
      assert.match(body.description, /Join: https:\/\/meet\.google\.com\/abc-defg-hij/);
      return Response.json({ id: body.id, etag: "\"mirror-etag\"", htmlLink: "https://calendar.google.com/event?eid=mirror" });
    }
    if (parsed.pathname.endsWith("/calendar_event_mirrors") && options.method === "POST") {
      assert.equal(parsed.searchParams.get("on_conflict"), "source_calendar_connection_id,source_google_event_id,mirror_calendar_connection_id");
      assert.equal(body[0].source_google_event_id, "admin_evt_1");
      assert.equal(body[0].mirror_status, "active");
      assert.equal(body[0].mirror_google_event_id, stableMirrorEventId(session()));
      return Response.json(body);
    }
    return Response.json({ error: `unexpected ${options.method || "GET"} ${url}` }, { status: 404 });
  };

  const result = await runGuestCalendarMirror({
    sessions: [session()],
    mappings: [],
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service",
    sourceCalendarConnectionId: SOURCE_CONNECTION_ID,
    mirrorCalendarConnectionId: MIRROR_CONNECTION_ID,
    mirrorCalendarId: MIRROR_CALENDAR_ID,
    accessToken: "google-token",
    apply: true,
    fetchImpl,
  });

  assert.equal(result.inserted, 1);
  assert.equal(result.persisted.length, 1);
  assert.ok(calls.some((call) => call.method === "POST" && call.path.endsWith("/events")));
  assert.ok(calls.some((call) => call.method === "POST" && call.path.endsWith("/calendar_event_mirrors")));
});

test("apply deletes cancelled mirror events", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ method: options.method || "GET", path: parsed.pathname, body });
    if (parsed.hostname === "www.googleapis.com" && options.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (parsed.pathname.endsWith("/calendar_event_mirrors") && options.method === "POST") {
      assert.equal(body[0].mirror_status, "cancelled");
      return Response.json(body);
    }
    return Response.json({ error: `unexpected ${options.method || "GET"} ${url}` }, { status: 404 });
  };

  const result = await runGuestCalendarMirror({
    sessions: [session({ status: "cancelled" })],
    mappings: [{
      id: "map_cancelled",
      org_id: ORG_ID,
      source_calendar_connection_id: SOURCE_CONNECTION_ID,
      source_google_event_id: "admin_evt_1",
      source_google_etag: "\"old\"",
      mirror_calendar_connection_id: MIRROR_CONNECTION_ID,
      mirror_google_calendar_id: MIRROR_CALENDAR_ID,
      mirror_google_event_id: "mirror_evt_1",
      mirror_status: "active",
    }],
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service",
    sourceCalendarConnectionId: SOURCE_CONNECTION_ID,
    mirrorCalendarConnectionId: MIRROR_CONNECTION_ID,
    mirrorCalendarId: MIRROR_CALENDAR_ID,
    accessToken: "google-token",
    apply: true,
    fetchImpl,
  });

  assert.equal(result.deleted, 1);
  assert.ok(calls.some((call) => call.method === "DELETE" && call.path.includes("/events/mirror_evt_1")));
});

test("skip-if-unconfigured lets deployment workflows run before guest calendar secrets exist", async () => {
  const result = await runGuestCalendarMirror({
    skipIfUnconfigured: true,
  });

  assert.equal(result.configured, false);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /sourceCalendarConnectionId/);
});

test("stateless mode deletes deterministic cancelled mirrors without mapping rows", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    calls.push({ method: options.method || "GET", path: parsed.pathname });
    if (parsed.hostname === "www.googleapis.com" && options.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return Response.json({ error: `unexpected ${options.method || "GET"} ${url}` }, { status: 404 });
  };

  const result = await runGuestCalendarMirror({
    sessions: [session({ status: "cancelled" })],
    mappings: [],
    sourceCalendarConnectionId: SOURCE_CONNECTION_ID,
    mirrorCalendarConnectionId: MIRROR_CONNECTION_ID,
    mirrorCalendarId: MIRROR_CALENDAR_ID,
    accessToken: "google-token",
    apply: true,
    stateless: true,
    fetchImpl,
  });

  assert.equal(result.stateless, true);
  assert.equal(result.deleted, 1);
  assert.ok(calls.some((call) => call.method === "DELETE" && call.path.includes(`/events/${stableMirrorEventId(session())}`)));
});

test("stateless-if-missing falls back when the mirror mapping table is absent", async () => {
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith("/sessions")) return Response.json([session()]);
    if (parsed.pathname.endsWith("/calendar_event_mirrors")) {
      return Response.json({ code: "PGRST205", message: "missing table" }, { status: 404 });
    }
    return Response.json({ error: `unexpected ${options.method || "GET"} ${url}` }, { status: 404 });
  };

  const result = await runGuestCalendarMirror({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service",
    sourceCalendarConnectionId: SOURCE_CONNECTION_ID,
    mirrorCalendarConnectionId: MIRROR_CONNECTION_ID,
    mirrorCalendarId: MIRROR_CALENDAR_ID,
    apply: false,
    statelessIfMissing: true,
    fetchImpl,
  });

  assert.equal(result.stateless, true);
  assert.equal(result.inserted, 1);
});

test("source session fetch preserves both time bounds", async () => {
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.pathname.endsWith("/sessions"), true);
    assert.equal(options.method || "GET", "GET");
    assert.equal(
      parsed.searchParams.get("and"),
      "(starts_at.gte.2026-06-08T00:00:00Z,starts_at.lt.2026-06-21T00:00:00Z)",
    );
    assert.equal(parsed.searchParams.has("starts_at"), false);
    return Response.json([]);
  };

  await fetchSourceSessions({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service",
    sourceCalendarConnectionId: SOURCE_CONNECTION_ID,
    timeMin: "2026-06-08T00:00:00Z",
    timeMax: "2026-06-21T00:00:00Z",
    fetchImpl,
  });
});
