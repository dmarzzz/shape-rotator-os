import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CALENDAR_ID,
  DEFAULT_SUPABASE_URL,
  DEFAULT_CALENDAR_TIMEZONE,
  buildCalendarIngressPayload,
  buildCreateCalendarEventBody,
  buildEventRequestRow,
  buildGoogleEventPreview,
  buildManualSourceManifest,
  cohortInviteDirectoryFromSurface,
  approveEventRequest,
  calendarIngressReadiness,
  callReviewTranscriptArtifact,
  callIngestArtifacts,
  defaultCalendarDateTimeValue,
  decideApprovalGate,
  fetchCalendarOpsQueue,
  fetchPrivateInviteDirectory,
  googleCalendarManagedUrl,
  loadCalendarIngressConfig,
  callCreateCalendarEvent,
  mergeAttendeeEmails,
  parseAttendees,
  persistableCalendarIngressConfig,
  postEventRequest,
  privateInviteDirectoryFromRows,
  saveCalendarIngressConfig,
  reviewDerivedArtifact,
  reviewEvidenceCard,
} from "../apps/web/scripts/calendar-ingress-client.mjs";

test("web calendar ingress parses and deduplicates attendee emails", () => {
  assert.deepEqual(parseAttendees("Guest <Guest@example.com>, guest@example.com\nsecond@example.com"), [
    { email: "guest@example.com" },
    { email: "second@example.com" },
  ]);
});

test("web calendar ingress merges attendee emails without duplicates", () => {
  assert.equal(
    mergeAttendeeEmails("Guest <guest@example.com>", ["guest@example.com", { email: "Second@Example.com" }]),
    "guest@example.com\nsecond@example.com",
  );
});

test("web calendar ingress derives cohort invite groups from the surface", () => {
  const directory = cohortInviteDirectoryFromSurface({
    people: [
      {
        record_id: "alice",
        name: "Alice",
        email: "Alice@example.com",
        role_class: "cohort-member",
        team: "alpha",
      },
      {
        record_id: "bob",
        name: "Bob",
        email: "bob@example.com",
        role_class: "coordinator",
        team: "ops",
        secondary_teams: ["alpha"],
      },
      {
        record_id: "no-email",
        name: "No Email",
        email: null,
        role_class: "cohort-member",
        team: "alpha",
      },
    ],
    teams: [
      { record_id: "alpha", name: "Alpha" },
      { record_id: "ops", name: "Ops" },
    ],
  });

  assert.equal(directory.people.length, 2);
  assert.equal(directory.missingEmailCount, 1);
  assert.deepEqual(directory.groups.find((group) => group.id === "role:cohort-member").emails, ["alice@example.com"]);
  assert.deepEqual(directory.groups.find((group) => group.id === "role:coordinator").emails, ["bob@example.com"]);
  assert.deepEqual(directory.groups.find((group) => group.id === "team:alpha").emails, ["alice@example.com", "bob@example.com"]);
});

test("web calendar ingress derives invite groups from private contacts", () => {
  const directory = privateInviteDirectoryFromRows([
    {
      id: "contact_1",
      person_record_id: "alice",
      display_name: "Alice",
      email: "Alice@example.com",
      team_record_id: "alpha",
      role_class: "cohort-member",
      active: true,
    },
    {
      id: "contact_2",
      display_name: "Inactive",
      email: "inactive@example.com",
      role_class: "cohort-member",
      active: false,
    },
    {
      id: "contact_3",
      display_name: "Bob",
      email: "bob@example.com",
      team_record_id: "alpha",
      role_class: "coordinator",
      active: true,
    },
  ]);

  assert.equal(directory.source, "private_invite_contacts");
  assert.deepEqual(directory.people.map((person) => person.email), ["alice@example.com", "bob@example.com"]);
  assert.deepEqual(directory.groups.find((group) => group.id === "team:alpha").emails, ["alice@example.com", "bob@example.com"]);
  assert.deepEqual(directory.groups.find((group) => group.id === "role:coordinator").emails, ["bob@example.com"]);
});

test("web calendar ingress builds a policy-bound session payload", () => {
  const payload = buildCalendarIngressPayload({
    title: "Private details that should not be the public summary",
    public_title: "Demo night",
    session_type: "demo_presentation",
    starts_at: "2026-06-16T16:00",
    ends_at: "2026-06-16T17:00",
    timezone: "America/New_York",
    attendee_emails: "guest@example.com",
    bot_requested: true,
  }, {
    idFactory: () => "sess_test",
  });

  assert.equal(payload.session.id, "sess_test");
  assert.equal(payload.session.public_title, "Demo night");
  assert.equal(payload.session.title, "Private details that should not be the public summary");
  assert.equal(payload.session.starts_at, "2026-06-16T16:00:00");
  assert.equal(payload.decision.max_tier, "T3");
  assert.deepEqual(payload.decision.required_public_approvals, ["editorial_pass", "presenter_ok", "named_people_ok"]);
  assert.equal(payload.attendees.length, 1);
});

test("web calendar ingress defaults sessions to New York timezone", () => {
  const payload = buildCalendarIngressPayload({
    public_title: "Office hours",
    session_type: "office_hours",
    starts_at: "2026-06-16T16:00",
    ends_at: "2026-06-16T17:00",
  }, {
    idFactory: () => "sess_timezone",
  });

  assert.equal(DEFAULT_CALENDAR_TIMEZONE, "America/New_York");
  assert.equal(payload.session.timezone, "America/New_York");
});

test("web calendar ingress default datetime values are New York wall time", () => {
  const now = new Date("2026-06-13T16:37:00Z");
  assert.equal(defaultCalendarDateTimeValue(24, { now }), "2026-06-14T12:00");
  assert.equal(defaultCalendarDateTimeValue(25, { now }), "2026-06-14T13:00");
});

test("web calendar ingress uses managed calendar and Supabase project defaults", () => {
  const emptyStorage = {
    getItem: () => null,
  };
  const overrideStorage = {
    getItem: () => JSON.stringify({
      calendarId: "operator-override@example.com",
    }),
  };

  assert.equal(DEFAULT_CALENDAR_ID, "c_d3c51f9ef28351bd0e92449a9d0fa7f4bf27c8a2866309f96c6e2176a50b03ed@group.calendar.google.com");
  assert.equal(DEFAULT_SUPABASE_URL, "https://txjntzwksiluvqcpccpc.supabase.co");
  assert.equal(loadCalendarIngressConfig(emptyStorage, "test-key").calendarId, DEFAULT_CALENDAR_ID);
  assert.equal(loadCalendarIngressConfig(overrideStorage, "test-key").calendarId, DEFAULT_CALENDAR_ID);
  assert.equal(loadCalendarIngressConfig(emptyStorage, "test-key").supabaseUrl, DEFAULT_SUPABASE_URL);
  assert.equal(decodeURIComponent(new URL(googleCalendarManagedUrl()).searchParams.get("cid")), DEFAULT_CALENDAR_ID);
});

test("web calendar ingress does not persist bearer or Google access tokens", () => {
  const storage = new Map();
  const localStorage = {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
  };
  const config = {
    supabaseUrl: "https://project.supabase.co",
    supabaseAnonKey: "anon",
    accessToken: "user-token",
    googleAccessToken: "google-user-token",
    googleRefreshToken: "google-refresh-token",
    access_token: "snake-user-token",
    orgId: "org_1",
    calendarConnectionId: "cal_1",
    calendarId: "operator-override@example.com",
  };

  assert.equal(persistableCalendarIngressConfig(config).accessToken, undefined);
  assert.equal(persistableCalendarIngressConfig(config).googleAccessToken, undefined);
  assert.equal(persistableCalendarIngressConfig(config).googleRefreshToken, undefined);
  assert.equal(persistableCalendarIngressConfig(config).access_token, undefined);
  assert.equal(persistableCalendarIngressConfig(config).calendarId, undefined);
  saveCalendarIngressConfig(config, localStorage, "test-key");

  const saved = JSON.parse(storage.get("test-key"));
  assert.equal(saved.accessToken, undefined);
  assert.equal(saved.googleAccessToken, undefined);
  assert.equal(saved.googleRefreshToken, undefined);
  assert.equal(saved.access_token, undefined);
  assert.equal(saved.calendarId, undefined);
  assert.equal(saved.supabaseUrl, "https://project.supabase.co");
  assert.equal(loadCalendarIngressConfig(localStorage, "test-key").accessToken, undefined);
  assert.equal(loadCalendarIngressConfig(localStorage, "test-key").calendarId, DEFAULT_CALENDAR_ID);
});

test("web calendar ingress event request stores only request JSON", () => {
  const payload = buildCalendarIngressPayload({
    public_title: "Office hours",
    session_type: "office_hours",
    starts_at: "2026-06-16T16:00",
    ends_at: "2026-06-16T17:00",
    timezone: "America/New_York",
    attendee_emails: "guest@example.com",
  }, {
    idFactory: () => "sess_request",
  });
  const row = buildEventRequestRow({ orgId: "org_1", payload });

  assert.equal(row.org_id, "org_1");
  assert.equal(row.status, "pending");
  assert.equal(row.request_json.session.status, "requested");
  assert.equal(row.request_json.decision.max_tier, "T2");
  assert.equal(row.request_json.surface, "web");
  assert.equal(row.request_json.raw_transcript, undefined);
});

test("web calendar ingress create body and preview preserve non-editable guests", () => {
  const payload = buildCalendarIngressPayload({
    title: "Private strategy details",
    public_title: "Planning",
    session_type: "planning_strategy",
    starts_at: "2026-06-16T16:00",
    ends_at: "2026-06-16T17:00",
    timezone: "America/New_York",
    attendee_emails: "guest@example.com",
    bot_requested: true,
  }, {
    idFactory: () => "sess_create",
  });
  const body = buildCreateCalendarEventBody({
    orgId: "org_1",
    calendarConnectionId: "cal_1",
    payload,
    dryRun: true,
  });
  const preview = buildGoogleEventPreview(payload, { botEmail: "bot@example.com" });

  assert.equal(body.org_id, "org_1");
  assert.equal(body.calendar_connection_id, "cal_1");
  assert.equal(body.calendar_id, undefined);
  assert.equal(body.session.status, "scheduled");
  assert.equal(body.dry_run, true);
  assert.equal(preview.summary, "Planning");
  assert.equal(preview.guestsCanModify, false);
  assert.equal(preview.guestsCanInviteOthers, false);
  assert.equal(preview.attendees.length, 2);
  assert.doesNotMatch(preview.description, /Private strategy details/);
});

test("web source ingress builds a manual manifest without raw browser content", () => {
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

test("web source ingress calls the ingest-artifacts function with signed-in auth", async () => {
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
  assert.equal(calls[0].body.provider, "manual");
  assert.equal(calls[0].body.org_id, "org_1");
});

test("web calendar ingress readiness keeps browser config separate from operator workers", () => {
  const empty = calendarIngressReadiness({});
  assert.equal(empty.browserReady, false);
  assert.deepEqual(empty.missingBrowserSafe, [
    "Supabase anon key",
    "signed-in access token",
    "org ID",
    "calendar connection ID",
  ]);
  assert.deepEqual(empty.missingOperator, ["Drive artifact folder"]);

  const ready = calendarIngressReadiness({
    supabaseUrl: "https://project.supabase.co",
    supabaseAnonKey: "anon",
    accessToken: "user-token",
    orgId: "org_1",
    calendarConnectionId: "cal_1",
    driveArtifactFolderId: "drive_folder",
  });
  assert.equal(ready.browserReady, true);
  assert.deepEqual(ready.missingBrowserSafe, []);
  assert.deepEqual(ready.missingOperator, []);
});

test("web calendar ingress create body does not trust browser-supplied calendar IDs", () => {
  const payload = buildCalendarIngressPayload({
    public_title: "Office hours",
    session_type: "office_hours",
    starts_at: "2026-06-16T16:00",
    ends_at: "2026-06-16T17:00",
  }, {
    idFactory: () => "sess_default_calendar",
  });

  const defaultBody = buildCreateCalendarEventBody({
    orgId: "org_1",
    calendarConnectionId: "cal_1",
    payload,
  });
  const overrideBody = buildCreateCalendarEventBody({
    orgId: "org_1",
    calendarConnectionId: "cal_1",
    calendarId: "operator-override@example.com",
    payload,
  });

  assert.equal(DEFAULT_CALENDAR_ID, "c_d3c51f9ef28351bd0e92449a9d0fa7f4bf27c8a2866309f96c6e2176a50b03ed@group.calendar.google.com");
  assert.equal(defaultBody.calendar_connection_id, "cal_1");
  assert.equal(overrideBody.calendar_connection_id, "cal_1");
  assert.equal(defaultBody.calendar_id, undefined);
  assert.equal(overrideBody.calendar_id, undefined);
});

test("web calendar ingress fetches the operator queue with signed-in Supabase auth", async () => {
  const calls = [];
  const config = {
    supabaseUrl: "https://project.supabase.co",
    supabaseAnonKey: "anon",
    accessToken: "user-token",
    orgId: "org_1",
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    const path = new URL(url).pathname;
    if (path.endsWith("/event_requests")) return Response.json([{ id: "req_1", request_json: {} }]);
    if (path.endsWith("/processing_jobs")) return Response.json([{ id: "job_1" }]);
    if (path.endsWith("/derived_artifacts")) return Response.json([{ id: "derived_1" }]);
    if (path.endsWith("/evidence_cards")) return Response.json([{ id: "card_1" }]);
    if (path.endsWith("/approval_gates")) return Response.json([{ id: "gate_1" }]);
    return Response.json({ error: "unexpected" }, { status: 404 });
  };

  const queue = await fetchCalendarOpsQueue({ config, fetchImpl, limit: 7 });

  assert.equal(queue.eventRequests.length, 1);
  assert.equal(queue.processingJobs.length, 1);
  assert.equal(queue.derivedArtifacts.length, 1);
  assert.equal(queue.evidenceCards.length, 1);
  assert.equal(queue.approvalGates.length, 1);
  assert.equal(calls.length, 5);
  assert.ok(calls.every((call) => call.options.headers.authorization === "Bearer user-token"));
  assert.match(calls.find((call) => call.url.includes("event_requests")).url, /status=eq\.pending/);
  assert.match(calls.find((call) => call.url.includes("derived_artifacts")).url, /review_status=in.%28generated%2Cneeds_review%2Creviewed%2Cblocked%29/);
  assert.match(calls.find((call) => call.url.includes("evidence_cards")).url, /review_status=in.%28generated%2Cneeds_review%2Creviewed%2Cblocked%29/);
});

test("web calendar ingress fetches private invite contacts with signed-in Supabase auth", async () => {
  const calls = [];
  const config = {
    supabaseUrl: "https://project.supabase.co",
    supabaseAnonKey: "anon",
    accessToken: "user-token",
    orgId: "org_1",
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return Response.json([
      {
        id: "contact_1",
        person_record_id: "alice",
        display_name: "Alice",
        email: "alice@example.com",
        team_record_id: "alpha",
        role_class: "cohort-member",
        active: true,
      },
    ]);
  };

  const directory = await fetchPrivateInviteDirectory({ config, fetchImpl });

  assert.equal(directory.source, "private_invite_contacts");
  assert.equal(directory.people[0].email, "alice@example.com");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.authorization, "Bearer user-token");
  assert.match(calls[0].url, /\/private_invite_contacts/);
  assert.match(calls[0].url, /org_id=eq\.org_1/);
});

test("web calendar ingress approval creates the invite before marking request approved", async () => {
  const calls = [];
  const config = {
    supabaseUrl: "https://project.supabase.co",
    supabaseAnonKey: "anon",
    accessToken: "user-token",
    orgId: "org_1",
    calendarConnectionId: "cal_1",
  };
  const request = {
    id: "req_1",
    org_id: "org_1",
    request_json: {
      session: {
        id: "sess_1",
        public_title: "Demo",
        title: "Private demo prep",
        session_type: "demo_presentation",
        starts_at: "2026-06-16T16:00:00",
        ends_at: "2026-06-16T17:00:00",
        timezone: "America/New_York",
      },
      attendees: [{ email: "guest@example.com" }],
      request_meet: true,
    },
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options, body: options.body ? JSON.parse(options.body) : null });
    if (String(url).includes("/functions/v1/create-calendar-event")) {
      assert.equal(options.method, "POST");
      assert.equal(calls[0].body.session.status, "scheduled");
      assert.equal(calls[0].body.calendar_connection_id, "cal_1");
      assert.equal(calls[0].body.event_request_id, "req_1");
      return Response.json({ session: { id: "sess_1" } });
    }
    if (String(url).includes("/rest/v1/event_requests")) {
      assert.equal(options.method, "PATCH");
      assert.equal(calls[1].body.status, "approved");
      assert.equal(calls[1].body.session_id, "sess_1");
      return Response.json([{ id: "req_1", status: "approved" }]);
    }
    return Response.json({ error: "unexpected" }, { status: 404 });
  };

  const result = await approveEventRequest({ config, request, fetchImpl });

  assert.equal(result.requestRows[0].status, "approved");
  assert.equal(calls.length, 2);
});

test("web calendar ingress gate approval promotes the public candidate only after all gates clear", async () => {
  const calls = [];
  const config = {
    supabaseUrl: "https://project.supabase.co",
    supabaseAnonKey: "anon",
    accessToken: "user-token",
    orgId: "org_1",
  };
  const gate = {
    id: "gate_1",
    org_id: "org_1",
    derived_artifact_id: "derived_1",
    gate_key: "presenter_ok",
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options, body: options.body ? JSON.parse(options.body) : null });
    if (String(url).includes("/functions/v1/review-transcript-artifact")) {
      return Response.json({
        ok: true,
        action: "decide_gate",
        gates: [{ id: "gate_1", gate_status: "approved" }],
        artifact: { id: "derived_1", review_status: "reviewed", approval_state: "approved" },
      });
    }
    return Response.json({ error: "unexpected" }, { status: 404 });
  };

  const rows = await decideApprovalGate({ config, gate, gateStatus: "approved", fetchImpl });

  assert.equal(rows[0].gate_status, "approved");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://project.supabase.co/functions/v1/review-transcript-artifact");
  assert.equal(calls[0].body.action, "decide_gate");
  assert.equal(calls[0].body.gate_id, "gate_1");
  assert.equal(calls[0].body.gate_status, "approved");
});

test("web calendar ingress review actions use the server-side review function", async () => {
  const calls = [];
  const config = {
    supabaseUrl: "https://project.supabase.co",
    supabaseAnonKey: "anon",
    accessToken: "user-token",
    orgId: "org_1",
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options, body: JSON.parse(options.body) });
    return Response.json({
      ok: true,
      action: "review_artifact",
      artifact: { id: "derived_1", review_status: "published", approval_state: "approved" },
    });
  };

  const direct = await callReviewTranscriptArtifact({
    config,
    body: { action: "review_artifact", org_id: "org_1", artifact_id: "derived_1", review_status: "reviewed" },
    fetchImpl,
  });
  const rows = await reviewDerivedArtifact({
    config,
    artifactId: "derived_1",
    reviewStatus: "published",
    approvalState: "approved",
    notes: "publish after gates",
    fetchImpl,
  });

  assert.equal(direct.ok, true);
  assert.equal(rows[0].review_status, "published");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.url === "https://project.supabase.co/functions/v1/review-transcript-artifact"));
  assert.ok(calls.every((call) => call.options.method === "POST"));
  assert.ok(calls.every((call) => call.options.headers.authorization === "Bearer user-token"));
  assert.equal(calls[1].body.publish_public, true);
  assert.equal(calls[1].body.notes, "publish after gates");
});

test("web calendar ingress evidence-card reviews use the server-side review function", async () => {
  const calls = [];
  const config = {
    supabaseUrl: "https://project.supabase.co",
    supabaseAnonKey: "anon",
    accessToken: "user-token",
    orgId: "org_1",
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options, body: JSON.parse(options.body) });
    return Response.json({
      ok: true,
      action: "review_evidence_card",
      evidence_card: { id: "card_1", review_status: "published", approval_state: "approved" },
    });
  };

  const rows = await reviewEvidenceCard({
    config,
    cardId: "card_1",
    reviewStatus: "published",
    approvalState: "approved",
    notes: "publish no-name card",
    fetchImpl,
  });

  assert.equal(rows[0].review_status, "published");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://project.supabase.co/functions/v1/review-transcript-artifact");
  assert.equal(calls[0].body.action, "review_evidence_card");
  assert.equal(calls[0].body.card_id, "card_1");
  assert.equal(calls[0].body.publish_public, true);
});

test("web calendar ingress mutations require a signed-in access token", async () => {
  const config = {
    supabaseUrl: "https://project.supabase.co",
    supabaseAnonKey: "anon",
  };

  await assert.rejects(
    () => postEventRequest({ config, row: { org_id: "org_1", status: "pending", request_json: {} } }),
    /Signed-in access token/,
  );
  await assert.rejects(
    () => callCreateCalendarEvent({ config, body: { org_id: "org_1" } }),
    /Signed-in access token/,
  );
  await assert.rejects(
    () => fetchCalendarOpsQueue({ config: { ...config, orgId: "org_1" } }),
    /Signed-in access token/,
  );
});
