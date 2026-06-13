import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_GOOGLE_CALENDAR_ID,
  DEFAULT_SUPABASE_URL,
  buildCalendarIngressPayload,
  buildCreateCalendarEventBody,
  buildEventRequestRow,
  buildGoogleEventPreview,
  buildManualSourceManifest,
  callIngestArtifacts,
  calendarIngressConfigWithDefaults,
  approveEventRequest,
  createCalendarEvent,
  defaultCalendarDateTimeValue,
  fetchCalendarOpsQueue,
  loadCalendarIngressConfig,
  parseAttendees,
  persistableCalendarIngressConfig,
  renderCalendarIngressPanel,
  saveCalendarIngressConfig,
  submitEventRequest,
} from "../apps/os/src/renderer/calendar-ingress.mjs";

test("os calendar ingress dedupes attendee emails", () => {
  assert.deepEqual(parseAttendees("Guest <Guest@example.com>\nguest@example.com; other@example.com"), [
    { email: "guest@example.com" },
    { email: "other@example.com" },
  ]);
});

test("os calendar ingress builds request rows without raw transcript content", () => {
  const payload = buildCalendarIngressPayload({
    public_title: "Office hours",
    title: "Internal support details",
    session_type: "office_hours",
    starts_at: "2026-06-16T16:00",
    ends_at: "2026-06-16T17:00",
    timezone: "America/New_York",
    attendee_emails: "guest@example.com",
  }, {
    idFactory: () => "sess_os_request",
  });
  const row = buildEventRequestRow({ orgId: "org_1", payload });

  assert.equal(row.org_id, "org_1");
  assert.equal(row.status, "pending");
  assert.equal(row.request_json.session.status, "requested");
  assert.equal(row.request_json.session.public_title, "Office hours");
  assert.deepEqual(row.request_json.decision.required_public_approvals, []);
  assert.equal(row.request_json.raw_transcript, undefined);
  assert.equal(row.request_json.surface, "electron");
});

test("os calendar ingress preview keeps guests non-editable and private title out", () => {
  const payload = buildCalendarIngressPayload({
    public_title: "Planning",
    title: "Private strategy details",
    session_type: "planning_strategy",
    starts_at: "2026-06-16T16:00",
    ends_at: "2026-06-16T17:00",
    timezone: "America/New_York",
    attendee_emails: "guest@example.com",
    bot_requested: true,
  }, {
    idFactory: () => "sess_os_create",
  });
  const preview = buildGoogleEventPreview(payload, { botEmail: "bot@example.com" });
  const body = buildCreateCalendarEventBody({
    orgId: "org_1",
    calendarConnectionId: "cal_1",
    payload,
    dryRun: true,
  });

  assert.equal(preview.summary, "Planning");
  assert.equal(preview.guestsCanModify, false);
  assert.equal(preview.guestsCanInviteOthers, false);
  assert.equal(preview.attendees.length, 2);
  assert.doesNotMatch(preview.description, /Private strategy details/);
  assert.equal(body.calendar_connection_id, "cal_1");
  assert.equal(body.calendar_id, undefined);
  assert.equal(body.session.status, "scheduled");
  assert.equal(body.dry_run, true);
});

test("os calendar ingress does not put browser calendar IDs into create-event bodies", () => {
  const payload = buildCalendarIngressPayload({
    public_title: "Office hours",
    session_type: "office_hours",
    starts_at: "2026-06-16T16:00",
    ends_at: "2026-06-16T17:00",
  }, {
    idFactory: () => "sess_default_calendar",
  });

  const body = buildCreateCalendarEventBody({
    orgId: "org_1",
    calendarConnectionId: "cal_1",
    payload,
  });

  assert.equal(DEFAULT_GOOGLE_CALENDAR_ID, "c_d3c51f9ef28351bd0e92449a9d0fa7f4bf27c8a2866309f96c6e2176a50b03ed@group.calendar.google.com");
  assert.equal(body.calendar_connection_id, "cal_1");
  assert.equal(body.calendar_id, undefined);
});

test("os calendar ingress panel includes local controls and no service-role field", () => {
  const html = renderCalendarIngressPanel({
    config: {
      supabaseUrl: "https://project.supabase.co",
      orgId: "org_1",
    },
  });

  assert.match(html, /create or request a session/);
  assert.match(html, /submit request/);
  assert.match(html, /create invite/);
  assert.match(html, /dry run/);
  assert.match(html, /submit transcript\/source/);
  assert.match(html, /submit source/);
  assert.match(html, /operator queue/);
  assert.match(html, /refresh queue/);
  assert.match(html, new RegExp(DEFAULT_GOOGLE_CALENDAR_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(html, /name="calendarId"/);
  assert.doesNotMatch(html, /serviceRole/i);
  assert.doesNotMatch(html, /SUPABASE_SERVICE_ROLE_KEY/);
});

test("os calendar ingress uses managed calendar and Supabase project defaults", () => {
  const storage = new Map();
  const localStorage = {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
  };
  const customCalendarId = "custom-calendar@example.com";
  saveCalendarIngressConfig({ calendarId: customCalendarId }, localStorage);

  assert.equal(calendarIngressConfigWithDefaults({}).calendarId, DEFAULT_GOOGLE_CALENDAR_ID);
  assert.equal(calendarIngressConfigWithDefaults({}).supabaseUrl, DEFAULT_SUPABASE_URL);
  assert.equal(DEFAULT_SUPABASE_URL, "https://txjntzwksiluvqcpccpc.supabase.co");
  assert.equal(loadCalendarIngressConfig(localStorage).calendarId, DEFAULT_GOOGLE_CALENDAR_ID);
  assert.equal(loadCalendarIngressConfig(localStorage).supabaseUrl, DEFAULT_SUPABASE_URL);
  assert.equal(JSON.parse(storage.get("srwk:calendar_ingress_config")).calendarId, undefined);

  const html = renderCalendarIngressPanel({
    config: loadCalendarIngressConfig(localStorage),
  });
  assert.doesNotMatch(html, /custom-calendar@example\.com/);
  assert.match(html, new RegExp(DEFAULT_GOOGLE_CALENDAR_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("os calendar ingress approval uses the trusted calendar connection", async () => {
  let capturedBody;
  const request = {
    id: "req_1",
    org_id: "org_1",
    request_json: {
      session: {
        id: "sess_approve",
        public_title: "Office hours",
        starts_at: "2026-06-16T16:00:00",
        ends_at: "2026-06-16T17:00:00",
        timezone: "America/New_York",
      },
      attendees: [],
      request_meet: true,
    },
  };

  await approveEventRequest({
    config: {
      orgId: "org_1",
      calendarConnectionId: "cal_1",
      calendarId: "custom-calendar@example.com",
      createEventUrl: "https://project.supabase.co/functions/v1/create-calendar-event",
      accessToken: "signed-in-token",
    },
    request,
    fetchImpl: async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          session: { id: "sess_approve" },
          persisted: { eventRequests: [{ id: "req_1", status: "approved" }] },
        }),
      };
    },
  });

  assert.equal(capturedBody.calendar_connection_id, "cal_1");
  assert.equal(capturedBody.calendar_id, undefined);
});

test("os calendar ingress default datetime values are New York wall time", () => {
  const now = new Date("2026-06-13T16:37:00Z");
  assert.equal(defaultCalendarDateTimeValue(24, { now }), "2026-06-14T12:00");
  assert.equal(defaultCalendarDateTimeValue(25, { now }), "2026-06-14T13:00");
});

test("os calendar ingress does not persist bearer access tokens", () => {
  const storage = new Map();
  const localStorage = {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
  };
  const config = {
    supabaseUrl: "https://project.supabase.co",
    supabaseAnonKey: "anon",
    accessToken: "user-token",
    access_token: "snake-user-token",
    googleAccessToken: "google-user-token",
    google_access_token: "google-user-token",
    googleRefreshToken: "google-refresh-token",
    google_refresh_token: "snake-refresh-token",
    refreshToken: "refresh-token",
    refresh_token: "snake-refresh-token",
    idToken: "id-token",
    id_token: "snake-id-token",
    orgId: "org_1",
    calendarConnectionId: "cal_1",
  };

  assert.equal(persistableCalendarIngressConfig(config).accessToken, undefined);
  assert.equal(persistableCalendarIngressConfig(config).access_token, undefined);
  assert.equal(persistableCalendarIngressConfig(config).googleAccessToken, undefined);
  assert.equal(persistableCalendarIngressConfig(config).google_access_token, undefined);
  assert.equal(persistableCalendarIngressConfig(config).googleRefreshToken, undefined);
  assert.equal(persistableCalendarIngressConfig(config).google_refresh_token, undefined);
  assert.equal(persistableCalendarIngressConfig(config).refreshToken, undefined);
  assert.equal(persistableCalendarIngressConfig(config).refresh_token, undefined);
  assert.equal(persistableCalendarIngressConfig(config).idToken, undefined);
  assert.equal(persistableCalendarIngressConfig(config).id_token, undefined);
  saveCalendarIngressConfig(config, localStorage);

  const saved = JSON.parse(storage.get("srwk:calendar_ingress_config"));
  assert.equal(saved.accessToken, undefined);
  assert.equal(saved.access_token, undefined);
  assert.equal(saved.googleAccessToken, undefined);
  assert.equal(saved.google_access_token, undefined);
  assert.equal(saved.googleRefreshToken, undefined);
  assert.equal(saved.google_refresh_token, undefined);
  assert.equal(saved.refreshToken, undefined);
  assert.equal(saved.refresh_token, undefined);
  assert.equal(saved.idToken, undefined);
  assert.equal(saved.id_token, undefined);
  assert.equal(saved.supabaseUrl, "https://project.supabase.co");
  assert.equal(loadCalendarIngressConfig(localStorage).accessToken, undefined);
});

test("os source ingress builds a manual manifest without raw browser content", () => {
  const body = buildManualSourceManifest({
    session_id: "sess_source",
    source_kind: "otter_transcript",
    storage_mode: "external_ref",
    storage_ref: "https://otter.ai/u/demo",
    mime_type: "text/plain",
    source_hash: "sha256-demo",
    size_bytes: "42",
  });

  assert.equal(body.provider, "manual");
  assert.equal(body.session_id, "sess_source");
  assert.equal(body.processor_mode, "local");
  assert.equal(body.manifest.raw_available_to_server, false);
  assert.equal(body.manifest.source_tier, "T0");
  assert.deepEqual(body.manifest.artifacts, [{
    source_kind: "otter_transcript",
    source_tier: "T0",
    storage_mode: "external_ref",
    storage_ref: "https://otter.ai/u/demo",
    raw_available_to_server: false,
    mime_type: "text/plain",
    source_hash: "sha256-demo",
    size_bytes: 42,
  }]);
});

test("os source ingress calls the ingest-artifacts function with signed-in auth", async () => {
  const calls = [];
  const config = {
    supabaseUrl: "https://project.supabase.co",
    supabaseAnonKey: "anon",
    accessToken: "user-token",
  };
  const body = buildManualSourceManifest({
    session_id: "sess_source",
    source_kind: "manual_upload",
    storage_mode: "local_only",
    storage_ref: "private-transcripts/sess_source.txt",
  });
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options, body: JSON.parse(options.body) });
    return Response.json({ provider: "manual", sourceArtifacts: [] });
  };

  const result = await callIngestArtifacts({ config, body: { ...body, org_id: "org_1" }, fetchImpl });

  assert.equal(result.provider, "manual");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://project.supabase.co/functions/v1/ingest-artifacts");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.authorization, "Bearer user-token");
  assert.equal(calls[0].options.headers.apikey, "anon");
  assert.equal(calls[0].body.provider, "manual");
  assert.equal(calls[0].body.org_id, "org_1");
  assert.equal(calls[0].body.manifest.raw_available_to_server, false);
});

test("os calendar ingress mutations require a signed-in access token", async () => {
  const config = {
    supabaseUrl: "https://project.supabase.co",
    supabaseAnonKey: "anon",
  };

  await assert.rejects(
    () => submitEventRequest({ config, row: { org_id: "org_1", status: "pending", request_json: {} } }),
    /Signed-in access token/,
  );
  await assert.rejects(
    () => createCalendarEvent({ config, body: { org_id: "org_1" } }),
    /Signed-in access token/,
  );
  await assert.rejects(
    () => fetchCalendarOpsQueue({ config: { ...config, orgId: "org_1" } }),
    /Signed-in access token/,
  );
  await assert.rejects(
    () => callIngestArtifacts({ config, body: { provider: "manual" } }),
    /Signed-in access token/,
  );
});
