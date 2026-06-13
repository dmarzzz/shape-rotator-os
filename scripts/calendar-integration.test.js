const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  loadRoutingPolicy,
  validateRoutingPolicy,
  policyDecisionForSession,
  buildGoogleCalendarEvent,
  googleEventToSessionRow,
  googleEventsToSupabaseRows,
  meetArtifactToSourceArtifact,
  captureArtifactToSourceArtifact,
  meetArtifactRowsFromManifest,
  otterArtifactRowsFromManifest,
  manualSourceArtifactRowsFromManifest,
  processingJobShapeForSourceArtifact,
  buildProcessingJobsFromSourceArtifacts,
  buildDerivedArtifactsFromTranscript,
  stableSessionIdForGoogleEvent,
  calendarJsonFromSessions,
} = require("./lib/calendar-integration.cjs");
const { buildSupabaseUpsertRequests } = require("./lib/supabase-rest.cjs");
const { collectEvents } = require("./build-ics.js");

test("routing policy validates and preserves Tina ceilings", () => {
  const policy = loadRoutingPolicy();
  assert.deepEqual(validateRoutingPolicy(policy), []);

  assert.equal(policyDecisionForSession(policy, "weekly_standup").max_tier, "T2");
  assert.equal(policyDecisionForSession(policy, "weekly_standup").cohort_mode, "aggregate_only");
  assert.equal(policyDecisionForSession(policy, "private_1on1").max_tier, "T1");
  assert.equal(policyDecisionForSession(policy, "private_1on1").cohort_mode, "never");
  assert.equal(policyDecisionForSession(policy, "private_1on1").public_allowed, false);
  assert.equal(policyDecisionForSession(policy, "planning_strategy").max_tier, "T1");
  assert.equal(policyDecisionForSession(policy, "salon").public_allowed, true);
  assert.deepEqual(policyDecisionForSession(policy, "demo_presentation").required_public_approvals, [
    "editorial_pass",
    "presenter_ok",
    "named_people_ok",
  ]);
  assert.equal(policy.transcript_naming.preferred_pattern, "type_project_name_date");
  assert.deepEqual(
    policy.drive_vault.admins.map((admin) => admin.email).sort(),
    [
      "albi@flashbots.net",
      "dan@flashbots.net",
      "fredrik@flashbots.net",
      "michael@flashbots.net",
      "socrates1024@gmail.com",
      "tina@flashbots.net",
    ],
  );
  assert.equal(policy.drive_vault.folder_routes.planning_strategy.path, "90_do_not_publish/planning_strategy");
  assert.equal(policy.drive_vault.folder_routes.private_1on1.path, "90_do_not_publish/private_1on1");
});

test("Google event payload gives guests real invites but no edit rights", () => {
  const policy = loadRoutingPolicy();
  const payload = buildGoogleCalendarEvent({
    policy,
    session: {
      id: "9da143d9-4585-43b2-98f7-b3dfb4c34d5d",
      title: "Private strategy details should not leak",
      public_title: "Shape Rotator planning",
      session_type: "planning_strategy",
      starts_at: "2026-06-15T16:00:00-04:00",
      ends_at: "2026-06-15T17:00:00-04:00",
      timezone: "America/New_York",
      bot_requested: true,
    },
    attendees: [
      { email: "Guest@example.com", name: "Guest" },
      { email: "guest@example.com" },
    ],
    botEmail: "bot@shaperotator.example",
  });

  assert.equal(payload.query.sendUpdates, "all");
  assert.equal(payload.query.conferenceDataVersion, 1);
  assert.equal(payload.body.summary, "Shape Rotator planning");
  assert.equal(payload.body.guestsCanModify, false);
  assert.equal(payload.body.guestsCanInviteOthers, false);
  assert.equal(payload.body.guestsCanSeeOtherGuests, true);
  assert.equal(payload.body.attendees.length, 2);
  assert.deepEqual(payload.body.attendees.map((attendee) => attendee.email).sort(), [
    "bot@shaperotator.example",
    "guest@example.com",
  ]);
  assert.equal(payload.body.extendedProperties.private.shape_session_type, "planning_strategy");
  assert.equal(payload.body.extendedProperties.private.shape_max_tier, "T1");
  assert.match(payload.body.description, /Routing ceiling: T1/);
  assert.doesNotMatch(payload.body.description, /Private strategy details/);
});

test("Google event payload includes capture bot by default unless explicitly disabled", () => {
  const policy = loadRoutingPolicy();
  const baseSession = {
    id: "9da143d9-4585-43b2-98f7-b3dfb4c34d5d",
    title: "Office hours",
    session_type: "office_hours",
    starts_at: "2026-06-15T16:00:00-04:00",
    ends_at: "2026-06-15T17:00:00-04:00",
    timezone: "America/New_York",
  };
  const defaultPayload = buildGoogleCalendarEvent({
    policy,
    session: baseSession,
    attendees: [{ email: "guest@example.com" }],
    botEmail: "cube@shaperotator.xyz",
  });
  assert.deepEqual(defaultPayload.body.attendees.map((attendee) => attendee.email).sort(), [
    "cube@shaperotator.xyz",
    "guest@example.com",
  ]);

  const disabledPayload = buildGoogleCalendarEvent({
    policy,
    session: { ...baseSession, bot_requested: false },
    attendees: [{ email: "guest@example.com" }],
    botEmail: "cube@shaperotator.xyz",
  });
  assert.deepEqual(disabledPayload.body.attendees.map((attendee) => attendee.email), ["guest@example.com"]);
});

test("Google event payload can disable Meet creation for non-video sessions", () => {
  const policy = loadRoutingPolicy();
  const payload = buildGoogleCalendarEvent({
    policy,
    requestMeet: false,
    session: {
      id: "9da143d9-4585-43b2-98f7-b3dfb4c34d5d",
      title: "In-person office hours",
      session_type: "office_hours",
      starts_at: "2026-06-15T16:00:00-04:00",
      ends_at: "2026-06-15T17:00:00-04:00",
      timezone: "America/New_York",
    },
  });

  assert.equal(payload.query.conferenceDataVersion, 0);
  assert.equal(payload.body.conferenceData, undefined);
});

test("Google event rows round-trip back to session metadata", () => {
  const policy = loadRoutingPolicy();
  const row = googleEventToSessionRow({
    id: "abc123",
    etag: "\"etag\"",
    summary: "Office hours",
    status: "confirmed",
    htmlLink: "https://calendar.google.com/event?eid=abc",
    iCalUID: "ical@example.com",
    organizer: { email: "calendar@shaperotator.example" },
    start: { dateTime: "2026-06-16T16:00:00-04:00", timeZone: "America/New_York" },
    end: { dateTime: "2026-06-16T17:00:00-04:00", timeZone: "America/New_York" },
    hangoutLink: "https://meet.google.com/abc-defg-hij",
    guestsCanModify: false,
    guestsCanInviteOthers: false,
    guestsCanSeeOtherGuests: true,
    extendedProperties: {
      private: {
        shape_session_id: "sess_123",
        shape_session_type: "office_hours",
        shape_max_tier: "T2",
      },
    },
  }, { orgId: "org_1", calendarConnectionId: "cal_1", policy });

  assert.equal(row.id, "sess_123");
  assert.equal(row.session_type, "office_hours");
  assert.equal(row.google_event_id, "abc123");
  assert.equal(row.google_meet_url, "https://meet.google.com/abc-defg-hij");
  assert.equal(row.google_meeting_code, "abc-defg-hij");
  assert.equal(row.guests_can_modify, false);
  assert.equal(row.transcript_status, "expected");
  assert.equal(row.distill_due_at, "2026-06-18T21:00:00.000Z");
});

test("Google event sync maps sessions and attendee RSVP rows", () => {
  const policy = loadRoutingPolicy();
  const rows = googleEventsToSupabaseRows([{
    id: "abc123",
    summary: "Demo",
    status: "confirmed",
    organizer: { email: "calendar@shaperotator.example" },
    start: { dateTime: "2026-06-16T16:00:00-04:00", timeZone: "America/New_York" },
    end: { dateTime: "2026-06-16T17:00:00-04:00", timeZone: "America/New_York" },
    attendees: [
      { email: "guest@example.com", responseStatus: "accepted" },
      { email: "bot@shaperotator.example", responseStatus: "needsAction" },
    ],
    extendedProperties: {
      private: {
        shape_session_id: "sess_456",
        shape_session_type: "demo_presentation",
        shape_max_tier: "T3",
      },
    },
  }], {
    orgId: "org_1",
    calendarConnectionId: "cal_1",
    policy,
    botEmail: "bot@shaperotator.example",
  });

  assert.equal(rows.sessions.length, 1);
  assert.equal(rows.sessions[0].id, "sess_456");
  assert.equal(rows.sessions[0].calendar_connection_id, "cal_1");
  assert.equal(rows.sessions[0].max_tier, "T3");
  assert.equal(rows.sessions[0].transcript_status, "expected");
  assert.equal(rows.attendees.length, 2);
  assert.deepEqual(rows.attendees.map((row) => [row.email, row.attendee_role, row.invite_status]), [
    ["guest@example.com", "guest", "accepted"],
    ["bot@shaperotator.example", "bot", "needs_action"],
  ]);
});

test("Google calendar imports get stable session IDs even without Shape private props", () => {
  const event = {
    id: "calendar_event_123",
    summary: "Manually added office hours",
    status: "confirmed",
    start: { dateTime: "2026-06-16T16:00:00-04:00", timeZone: "America/New_York" },
    end: { dateTime: "2026-06-16T17:00:00-04:00", timeZone: "America/New_York" },
    attendees: [{ email: "guest@example.com", responseStatus: "accepted" }],
  };
  const id = stableSessionIdForGoogleEvent(event, {
    orgId: "11111111-1111-1111-1111-111111111111",
    calendarConnectionId: "22222222-2222-2222-2222-222222222222",
  });
  const rows = googleEventsToSupabaseRows([event], {
    orgId: "11111111-1111-1111-1111-111111111111",
    calendarConnectionId: "22222222-2222-2222-2222-222222222222",
    policy: loadRoutingPolicy(),
  });

  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(rows.sessions[0].id, id);
  assert.equal(rows.attendees[0].session_id, id);
});

test("Meet transcript artifact becomes a private T0 source artifact", () => {
  const source = meetArtifactToSourceArtifact({
    orgId: "org_1",
    sessionId: "session_1",
    meetArtifact: {
      id: "artifact_1",
      artifact_kind: "transcript",
      meet_resource_name: "conferenceRecords/123/transcripts/456",
    },
  });

  assert.equal(source.source_kind, "meet_transcript");
  assert.equal(source.source_tier, "T0");
  assert.equal(source.storage_mode, "external_ref");
  assert.equal(source.raw_available_to_server, false);
});

test("source artifacts preserve persisted capture artifact IDs for provenance", () => {
  const source = captureArtifactToSourceArtifact({
    orgId: "org_1",
    sessionId: "session_1",
    captureArtifact: {
      id: "capture_123",
      provider: "otter",
      artifact_kind: "slides",
      storage_ref: "otter-export://demo/slide-001.png",
      metadata: {
        source_hash: "abc123",
        mime_type: "image/png",
        size_bytes: 512,
      },
    },
  });

  assert.equal(source.capture_artifact_id, "capture_123");
  assert.equal(source.source_kind, "otter_slide");
  assert.equal(source.source_hash, "abc123");
  assert.equal(source.mime_type, "image/png");
  assert.equal(source.size_bytes, 512);
});

test("Meet manifest normalizes transcripts and Gemini smart notes as private source artifacts", () => {
  const rows = meetArtifactRowsFromManifest({
    orgId: "org_1",
    sessionId: "session_1",
    manifest: {
      conference_record: "conferenceRecords/abc",
      meet_space: "spaces/xyz",
      artifacts: [
        { kind: "transcript", name: "conferenceRecords/abc/transcripts/123" },
        { kind: "smartNotes", name: "conferenceRecords/abc/smartNotes/456" },
        { kind: "recording", name: "conferenceRecords/abc/recordings/789" },
      ],
    },
  });

  assert.equal(rows.captureArtifacts.length, 3);
  assert.equal(rows.ingestionEvents.length, 3);
  assert.equal(rows.captureArtifacts[1].artifact_kind, "smart_notes");
  assert.equal(rows.captureArtifacts[2].artifact_kind, "recording");
  assert.equal(rows.sourceArtifacts.length, 2);
  assert.equal(rows.processingJobs.length, 0);
  assert.equal(rows.sourceArtifacts[0].source_kind, "meet_transcript");
  assert.equal(rows.sourceArtifacts[1].source_kind, "meet_smart_notes");
  assert.ok(rows.sourceArtifacts.every((row) => row.source_tier === "T0"));
});

test("Otter transcript and slide exports normalize to private source artifacts", () => {
  const rows = otterArtifactRowsFromManifest({
    orgId: "org_1",
    sessionId: "session_1",
    manifest: {
      conversation_id: "otter_123",
      artifacts: [
        { kind: "transcript", file: "exports/transcript.txt" },
        { kind: "summary", file: "exports/summary.txt" },
        { kind: "slides", file: "exports/slide-001.jpg", captured_at: "2026-06-12T16:10:00Z" },
      ],
    },
  });

  assert.equal(rows.captureArtifacts.length, 3);
  assert.equal(rows.ingestionEvents.length, 3);
  assert.equal(rows.captureArtifacts[2].provider, "otter");
  assert.equal(rows.captureArtifacts[2].artifact_kind, "slides");
  assert.equal(rows.sourceArtifacts[0].source_kind, "otter_transcript");
  assert.equal(rows.sourceArtifacts[1].source_kind, "otter_summary");
  assert.equal(rows.sourceArtifacts[2].source_kind, "otter_slide");
  assert.equal(rows.sourceArtifacts[2].source_tier, "T0");
});

test("Otter slide groups preserve hashes, MIME metadata, and stable provider IDs", () => {
  const rows = otterArtifactRowsFromManifest({
    orgId: "org_1",
    sessionId: "session_1",
    manifest: {
      conversation_id: "otter_456",
      export_source: "otter_export_folder",
      slides: [
        {
          file: "slides/screen-001.png",
          source_hash: "2f3f8f7f0f2565ad",
          mime_type: "image/png",
          size_bytes: 2048,
          slide_number: 1,
        },
      ],
    },
  });

  assert.equal(rows.captureArtifacts.length, 1);
  assert.equal(rows.ingestionEvents.length, 1);
  assert.equal(rows.captureArtifacts[0].artifact_kind, "slides");
  assert.equal(rows.captureArtifacts[0].provider_resource_name, "otter:otter_456:slides:2f3f8f7f0f2565ad");
  assert.equal(rows.captureArtifacts[0].metadata.slide_number, 1);
  assert.equal(rows.captureArtifacts[0].metadata.export_source, "otter_export_folder");
  assert.equal(rows.sourceArtifacts.length, 1);
  assert.equal(rows.sourceArtifacts[0].source_kind, "otter_slide");
  assert.equal(rows.sourceArtifacts[0].source_hash, "2f3f8f7f0f2565ad");
  assert.equal(rows.sourceArtifacts[0].mime_type, "image/png");
  assert.equal(rows.sourceArtifacts[0].size_bytes, 2048);
  assert.equal(rows.sourceArtifacts[0].raw_available_to_server, false);
});

test("Manual and local artifacts enter as private source refs without raw server access", () => {
  const rows = manualSourceArtifactRowsFromManifest({
    orgId: "org_1",
    sessionId: "session_1",
    manifest: {
      storage_mode: "local_only",
      artifacts: [
        { kind: "manual_upload", file: "local/transcript.txt", mime_type: "text/plain" },
        { kind: "drive_doc", url: "https://docs.google.com/document/d/example" },
      ],
    },
  });

  assert.equal(rows.sourceArtifacts.length, 2);
  assert.equal(rows.ingestionEvents.length, 2);
  assert.equal(rows.processingJobs.length, 0);
  assert.equal(rows.sourceArtifacts[0].source_kind, "manual_upload");
  assert.equal(rows.sourceArtifacts[0].storage_mode, "local_only");
  assert.equal(rows.sourceArtifacts[0].raw_available_to_server, false);
  assert.equal(rows.sourceArtifacts[1].source_kind, "drive_doc");
  assert.equal(rows.sourceArtifacts[1].source_tier, "T0");
});

test("manual artifacts preserve self-declared Meet and Otter source kinds", () => {
  const rows = manualSourceArtifactRowsFromManifest({
    orgId: "org_1",
    sessionId: "session_1",
    manifest: {
      storage_mode: "external_ref",
      artifacts: [
        { kind: "meet_transcript", url: "https://drive.google.com/file/d/meet-transcript" },
        { kind: "otter_transcript", url: "https://otter.ai/u/transcript" },
        { kind: "otter_summary", url: "https://otter.ai/u/summary" },
      ],
    },
  });

  assert.deepEqual(rows.sourceArtifacts.map((row) => row.source_kind), [
    "meet_transcript",
    "otter_transcript",
    "otter_summary",
  ]);
  assert.ok(rows.sourceArtifacts.every((row) => row.storage_mode === "external_ref"));
  assert.ok(rows.sourceArtifacts.every((row) => row.raw_available_to_server === false));
});

test("processing jobs queue only runnable work for persisted source artifacts", () => {
  const jobs = buildProcessingJobsFromSourceArtifacts({
    orgId: "org_1",
    policyVersion: "2026-06-12",
    dueAt: "2026-06-18T21:00:00.000Z",
    sourceArtifacts: [
      {
        id: "source_1",
        org_id: "org_1",
        session_id: "session_1",
        source_kind: "manual_upload",
        storage_mode: "local_only",
      },
      {
        id: "source_2",
        org_id: "org_1",
        session_id: "session_1",
        source_kind: "meet_transcript",
        storage_mode: "external_ref",
      },
      {
        id: "source_3",
        org_id: "org_1",
        session_id: "session_1",
        source_kind: "otter_slide",
        storage_mode: "local_only",
      },
      {
        id: "source_4",
        org_id: "org_1",
        session_id: "session_1",
        source_kind: "video",
        storage_mode: "external_ref",
      },
      {
        org_id: "org_1",
        session_id: "session_1",
        source_kind: "manual_upload",
        storage_mode: "local_only",
      },
    ],
  });

  assert.equal(jobs.length, 4);
  assert.equal(jobs[0].source_artifact_id, "source_1");
  assert.equal(jobs[0].job_kind, "distill");
  assert.equal(jobs[0].processor_mode, "local");
  assert.equal(jobs[0].tee_required, false);
  assert.equal(jobs[0].policy_version, "2026-06-12");
  assert.equal(jobs[0].due_at, "2026-06-18T21:00:00.000Z");
  assert.equal(jobs[0].prompt_version, "local-distill-v1");
  assert.deepEqual(jobs.map((job) => [job.source_artifact_id, job.job_kind, job.prompt_version]), [
    ["source_1", "distill", "local-distill-v1"],
    ["source_2", "artifact_fetch", "artifact-fetch-v1"],
    ["source_3", "review_prepare", "artifact-review-v1"],
    ["source_4", "artifact_fetch", "artifact-fetch-v1"],
  ]);
  assert.equal(processingJobShapeForSourceArtifact({
    id: "source_5",
    session_id: "session_1",
    source_kind: "unknown",
    storage_mode: "local_only",
  }), null);
  assert.equal(processingJobShapeForSourceArtifact({
    id: "source_6",
    session_id: "session_1",
    source_kind: "meet_transcript",
    storage_mode: "encrypted_object",
    raw_available_to_server: true,
  }).job_kind, "artifact_fetch");
  assert.equal(processingJobShapeForSourceArtifact({
    id: "source_6",
    session_id: "session_1",
    source_kind: "meet_transcript",
    storage_mode: "encrypted_object",
    raw_available_to_server: true,
  }, { processorMode: "tee" }).job_kind, "distill");
});

test("local transcript distillation creates gated readouts without raw contact details", () => {
  const policy = loadRoutingPolicy();
  const rows = buildDerivedArtifactsFromTranscript({
    orgId: "org_1",
    session: {
      id: "session_1",
      org_id: "org_1",
      session_type: "demo_presentation",
      title: "Private product critique",
      public_title: "Project demo",
    },
    sourceArtifact: {
      id: "source_1",
      org_id: "org_1",
      session_id: "session_1",
    },
    processingJob: { id: "job_1" },
    policy,
    transcriptText: [
      "Alice decided the team will ship the demo next week and email alice@example.com for follow-up.",
      "The blocker is that the deployment link https://example.com/private is not ready yet.",
      "What should the presenter approve before Tuesday?",
    ].join(" "),
  });

  assert.equal(rows.derivedArtifacts.length, 2);
  assert.equal(rows.derivedArtifacts[0].artifact_kind, "readout");
  assert.equal(rows.derivedArtifacts[0].tier, "T2");
  assert.equal(rows.derivedArtifacts[0].approval_state, "not_required");
  assert.equal(rows.derivedArtifacts[1].artifact_kind, "public_candidate");
  assert.equal(rows.derivedArtifacts[1].tier, "T3");
  assert.equal(rows.derivedArtifacts[1].approval_state, "pending");
  assert.deepEqual(rows.approvalGates.map((gate) => gate.gate_key), [
    "editorial_pass",
    "presenter_ok",
    "named_people_ok",
  ]);
  assert.doesNotMatch(rows.derivedArtifacts[0].content_md, /alice@example\.com/);
  assert.doesNotMatch(rows.derivedArtifacts[0].content_md, /https:\/\/example\.com\/private/);

  const aggregate = buildDerivedArtifactsFromTranscript({
    orgId: "org_1",
    session: { id: "session_2", session_type: "weekly_standup", title: "Standup" },
    sourceArtifact: { id: "source_2", session_id: "session_2" },
    policy,
    transcriptText: "The team decided the next action is to ship aggregate updates and avoid individual status details.",
  });
  assert.equal(aggregate.derivedArtifacts[0].source_transform, "aggregate");
  assert.equal(aggregate.derivedArtifacts[0].tier, "T2");
  assert.equal(aggregate.approvalGates.length, 0);

  const privateOnly = buildDerivedArtifactsFromTranscript({
    orgId: "org_1",
    session: { id: "session_3", session_type: "private_1on1", title: "Private 1:1" },
    sourceArtifact: { id: "source_3", session_id: "session_3" },
    policy,
    transcriptText: "The coordinators decided this governance detail stays internal and never reaches cohort surfaces.",
  });
  assert.deepEqual(privateOnly.derivedArtifacts, []);
  assert.deepEqual(privateOnly.approvalGates, []);
});

test("local distillation CLI emits Supabase-ready rows and omits raw transcript text", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shape-distill-"));
  const transcriptPath = path.join(tmp, "transcript.txt");
  const sessionPath = path.join(tmp, "session.json");
  const sourcePath = path.join(tmp, "source-artifact.json");
  const jobPath = path.join(tmp, "processing-job.json");
  fs.writeFileSync(transcriptPath, [
    "Alice decided the next action is to ship the demo and email alice@example.com.",
    "The private deployment link https://example.com/private should not leave the room.",
  ].join(" "));
  fs.writeFileSync(sessionPath, JSON.stringify({
    id: "session_1",
    org_id: "org_1",
    session_type: "demo_presentation",
    title: "Internal demo review",
    public_title: "Demo review",
  }));
  fs.writeFileSync(sourcePath, JSON.stringify({
    id: "source_1",
    org_id: "org_1",
    session_id: "session_1",
  }));
  fs.writeFileSync(jobPath, JSON.stringify({
    id: "job_1",
    org_id: "org_1",
    source_artifact_id: "source_1",
    job_kind: "distill",
    prompt_version: "local-distill-v1",
  }));

  const output = execFileSync(process.execPath, [
    path.join(__dirname, "prepare-derived-artifacts.js"),
    "--transcript", transcriptPath,
    "--session", sessionPath,
    "--source-artifact", sourcePath,
    "--processing-job", jobPath,
  ], { encoding: "utf8" });
  const payload = JSON.parse(output);

  assert.equal(payload.derivedArtifacts.length, 2);
  assert.ok(payload.derivedArtifacts.every((artifact) => artifact.id));
  assert.equal(payload.approvalGates.length, 3);
  assert.ok(payload.approvalGates.every((gate) => gate.id && gate.derived_artifact_id === payload.derivedArtifacts[1].id));
  assert.equal(payload.processingJobs[0].processor_status, "complete");
  assert.doesNotMatch(output, /alice@example\.com/);
  assert.doesNotMatch(output, /https:\/\/example\.com\/private/);
});

test("Supabase REST upsert requests preserve table order and conflict keys", () => {
  const requests = buildSupabaseUpsertRequests({
    supabaseUrl: "https://project.supabase.co",
    sessions: [{
      id: "sess_1",
      org_id: "org_1",
      calendar_connection_id: "cal_1",
      google_event_id: "evt_1",
    }],
    attendees: [{ session_id: "sess_1", email: "guest@example.com" }],
    captureArtifacts: [{
      session_id: "sess_1",
      provider: "google_meet",
      artifact_kind: "transcript",
      provider_resource_name: "conferenceRecords/abc/transcripts/123",
    }],
    sourceArtifacts: [{ session_id: "sess_1", source_kind: "meet_transcript" }],
  });

  assert.deepEqual(requests.map((request) => request.table), [
    "sessions",
    "session_attendees",
    "capture_artifacts",
    "source_artifacts",
  ]);
  assert.match(requests[0].url, /on_conflict=id/);
  assert.match(requests[1].url, /session_id%2Cemail/);
  assert.equal(requests[3].headers.prefer, "return=representation");
});

test("Supabase REST upsert requests include ingress, queue, and approval tables", () => {
  const requests = buildSupabaseUpsertRequests({
    supabaseUrl: "https://project.supabase.co",
    ingestionEvents: [{ org_id: "org_1", provider: "manual", event_type: "manual_upload.submitted" }],
    processingJobs: [{
      source_artifact_id: "source_1",
      job_kind: "distill",
      prompt_version: "local-distill-v1",
    }],
    derivedArtifacts: [{ id: "derived_1", artifact_kind: "readout" }],
    approvalGates: [{ derived_artifact_id: "derived_1", gate_key: "presenter_ok" }],
  });

  assert.deepEqual(requests.map((request) => request.table), [
    "ingestion_events",
    "processing_jobs",
    "derived_artifacts",
    "approval_gates",
  ]);
  assert.equal(requests[0].headers.prefer, "return=representation");
  assert.match(requests[1].url, /source_artifact_id%2Cjob_kind%2Cprompt_version/);
  assert.match(requests[2].url, /on_conflict=id/);
  assert.match(requests[3].url, /derived_artifact_id%2Cgate_key/);
});

test("Supabase REST source artifact upsert uses capture conflict only when linked", () => {
  const deterministic = buildSupabaseUpsertRequests({
    supabaseUrl: "https://project.supabase.co",
    sourceArtifacts: [{
      id: "source_1",
      session_id: "sess_1",
      source_kind: "drive_doc",
      storage_ref: "drive://file_1",
    }],
  });
  assert.match(deterministic[0].url, /on_conflict=id/);
  assert.match(deterministic[0].headers.prefer, /resolution=merge-duplicates/);

  const linked = buildSupabaseUpsertRequests({
    supabaseUrl: "https://project.supabase.co",
    sourceArtifacts: [{
      capture_artifact_id: "capture_1",
      session_id: "sess_1",
      source_kind: "otter_slide",
    }],
  });
  assert.match(linked[0].url, /capture_artifact_id%2Csource_kind/);
  assert.match(linked[0].headers.prefer, /resolution=merge-duplicates/);

  const manual = buildSupabaseUpsertRequests({
    supabaseUrl: "https://project.supabase.co",
    sourceArtifacts: [{
      session_id: "sess_1",
      source_kind: "manual_upload",
      storage_ref: "local/transcript.txt",
    }],
  });
  assert.doesNotMatch(manual[0].url, /on_conflict/);
  assert.equal(manual[0].headers.prefer, "return=representation");
});

test("Supabase sessions export to the existing calendar.json shape and ICS collector", () => {
  const calendar = calendarJsonFromSessions({
    lastRefresh: "2026-06-12T12:00:00Z",
    sessions: [
      {
        title: "Office hours",
        session_type: "office_hours",
        max_tier: "T2",
        starts_at: "2026-06-16T16:00:00-04:00",
        ends_at: "2026-06-16T17:00:00-04:00",
        timezone: "America/New_York",
        google_meet_url: "https://meet.google.com/abc-defg-hij",
      },
      {
        title: "Cancelled",
        status: "cancelled",
        session_type: "office_hours",
        starts_at: "2026-06-16T18:00:00-04:00",
        ends_at: "2026-06-16T19:00:00-04:00",
      },
    ],
  });

  assert.equal(calendar.tabs["Supabase Sessions"].length, 2);
  assert.match(calendar.tabs["Supabase Sessions"][1][3], /Office hours/);
  assert.match(calendar.tabs["Supabase Sessions"][1][3], /Meet: https:\/\/meet\.google\.com\/abc-defg-hij/);
  assert.doesNotMatch(JSON.stringify(calendar), /Cancelled/);

  const events = collectEvents(calendar);
  assert.equal(events.length, 1);
  assert.equal(events[0].summary, "16:00-17:00 Office hours");
});
