const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildDriveFilesListUrl,
  buildDriveArtifactPlan,
  buildDriveInventoryAudit,
  classifyDriveArtifact,
  classifyDriveSourceSystem,
  fetchDriveFileInventory,
  resolveGoogleAccessToken,
  runDriveArtifactPoll,
} = require("./poll-google-drive-artifacts.js");

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const SESSION_ID = "22222222-2222-2222-2222-222222222222";

function sessionFixture() {
  return {
    id: SESSION_ID,
    org_id: ORG_ID,
    title: "Demo Presentation",
    public_title: "Demo Presentation",
    session_type: "demo_presentation",
    starts_at: "2026-06-16T16:00:00Z",
    ends_at: "2026-06-16T17:00:00Z",
    google_meeting_code: "abc-defg-hij",
    google_event_id: "evt_1",
    transcript_status: "expected",
  };
}

function transcriptFile(id = "drive_file_1") {
  return {
    id,
    name: "Demo Presentation transcript abc-defg-hij",
    mimeType: "application/vnd.google-apps.document",
    webViewLink: `https://docs.google.com/document/d/${id}/edit`,
    createdTime: "2026-06-16T17:08:00Z",
    modifiedTime: "2026-06-16T17:09:00Z",
  };
}

function makeSupabaseResponse(url, options, body) {
  const pathname = new URL(String(url)).pathname;
  if (pathname.endsWith("/sessions") && options.method === "GET") {
    return Response.json([sessionFixture()]);
  }
  if (pathname.endsWith("/ingestion_events") && options.method === "POST") return Response.json(body);
  if (pathname.endsWith("/capture_artifacts") && options.method === "POST") {
    return Response.json(body.map((row, index) => ({ id: `capture_${index + 1}`, ...row })));
  }
  if (pathname.endsWith("/source_artifacts") && options.method === "POST") {
    return Response.json(body.map((row, index) => ({ id: `source_${index + 1}`, ...row })));
  }
  if (pathname.endsWith("/processing_jobs") && options.method === "POST") return Response.json(body);
  if (pathname.endsWith("/sessions") && options.method === "PATCH") return Response.json([{ id: SESSION_ID, ...body }]);
  return Response.json({ error: `unexpected ${options.method} ${pathname}` }, { status: 404 });
}

test("Drive files.list URL scopes to folder metadata and shared-drive params", () => {
  const url = buildDriveFilesListUrl({
    folderId: "folder'one",
    driveId: "shared-drive",
    modifiedAfter: "2026-06-16T00:00:00Z",
    pageSize: 50,
  });

  assert.match(url.searchParams.get("q"), /'folder\\'one' in parents/);
  assert.match(url.searchParams.get("q"), /trashed=false/);
  assert.match(url.searchParams.get("q"), /modifiedTime > '2026-06-16T00:00:00Z'/);
  assert.equal(url.searchParams.get("supportsAllDrives"), "true");
  assert.equal(url.searchParams.get("includeItemsFromAllDrives"), "true");
  assert.equal(url.searchParams.get("driveId"), "shared-drive");
  assert.equal(url.searchParams.get("corpora"), "drive");
  assert.match(url.searchParams.get("fields"), /files\(id,name,mimeType/);
});

test("Drive poller resolves OAuth refresh credentials when no access token is supplied", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET", body: String(options.body || "") });
    return Response.json({ access_token: "fresh-token" });
  };

  const token = await resolveGoogleAccessToken({
    env: {
      GOOGLE_OAUTH_CLIENT_ID: "client",
      GOOGLE_OAUTH_CLIENT_SECRET: "secret",
      GOOGLE_OAUTH_REFRESH_TOKEN: "refresh",
    },
    fetchImpl,
  });

  assert.equal(token, "fresh-token");
  assert.equal(calls.length, 1);
  assert.match(calls[0].body, /grant_type=refresh_token/);
});

test("Drive artifact plan maps Meet transcript and Gemini notes refs without raw text", () => {
  const plan = buildDriveArtifactPlan({
    orgId: ORG_ID,
    sessions: [sessionFixture()],
    files: [
      transcriptFile(),
      {
        id: "drive_file_2",
        name: "Gemini notes for Demo Presentation",
        mimeType: "application/vnd.google-apps.document",
        webViewLink: "https://docs.google.com/document/d/drive_file_2/edit",
        createdTime: "2026-06-16T17:10:00Z",
      },
      {
        id: "drive_file_3",
        name: "Unrelated budget sheet",
        mimeType: "application/vnd.google-apps.spreadsheet",
        createdTime: "2026-06-16T17:10:00Z",
      },
    ],
  });
  const text = JSON.stringify(plan);

  assert.equal(plan.matchedSessions, 1);
  assert.equal(plan.matchedFiles, 2);
  assert.equal(plan.captureArtifacts.length, 2);
  assert.deepEqual(plan.captureArtifacts.map((row) => row.artifact_kind), ["transcript", "smart_notes"]);
  assert.equal(plan.sourceArtifacts[0].source_kind, "meet_transcript");
  assert.equal(plan.sourceArtifacts[0].storage_mode, "external_ref");
  assert.equal(plan.sourceArtifacts[0].storage_ref, "drive://drive_file_1");
  assert.equal(plan.sourceArtifacts[0].metadata.source_confidence_pct, 92);
  assert.equal(plan.processingJobs.length, 0);
  assert.equal(plan.unmatchedFiles.length, 1);
  assert.doesNotMatch(text, /raw transcript text/i);
});

test("Drive artifact poller paginates, applies metadata refs, and queues fetch work", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), method: options.method || "GET", body });
    if (parsed.hostname === "www.googleapis.com") {
      assert.equal(options.headers.authorization, "Bearer google-token");
      assert.equal(parsed.pathname, "/drive/v3/files");
      if (!parsed.searchParams.get("pageToken")) {
        return Response.json({ files: [transcriptFile()], nextPageToken: "page-2" });
      }
      assert.equal(parsed.searchParams.get("pageToken"), "page-2");
      return Response.json({ files: [] });
    }
    return makeSupabaseResponse(url, { method: options.method || "GET" }, body);
  };

  const output = await runDriveArtifactPoll({
    accessToken: "google-token",
    folderId: "folder_1",
    orgId: ORG_ID,
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service",
    apply: true,
    fetchImpl,
  });

  assert.equal(output.fetched.sessions, 1);
  assert.equal(output.fetched.files, 1);
  assert.equal(output.matchedFiles, 1);
  assert.equal(output.persisted.sourceArtifacts.length, 1);
  assert.equal(output.persisted.processingJobRows.length, 1);
  assert.equal(output.persisted.processingJobRows[0].job_kind, "artifact_fetch");
  assert.equal(output.persisted.processingJobRows[0].prompt_version, "artifact-fetch-v1");
  assert.ok(calls.some((call) => call.method === "POST" && call.url.includes("/capture_artifacts") && call.body[0].drive_file_id === "drive_file_1"));
  assert.ok(calls.some((call) => (
    call.method === "POST"
    && call.url.includes("/source_artifacts")
    && call.body[0].storage_ref === "drive://drive_file_1"
    && call.body[0].metadata.source_confidence_pct === 92
  )));
  assert.ok(calls.some((call) => call.method === "PATCH" && call.url.includes("/sessions") && call.body.transcript_status === "source_ready"));
  assert.equal(calls.some((call) => call.url.includes("/export?mimeType=text/plain")), false);
});

test("Drive artifact classifier recognizes the expected post-meeting files", () => {
  assert.equal(classifyDriveArtifact({ name: "Weekly transcript", mimeType: "application/vnd.google-apps.document" }), "transcript");
  assert.equal(classifyDriveArtifact({ name: "Gemini smart notes", mimeType: "application/vnd.google-apps.document" }), "smart_notes");
  assert.equal(classifyDriveArtifact({ name: "Attendance report.csv", mimeType: "text/csv" }), "attendance");
  assert.equal(classifyDriveArtifact({ name: "Meeting recording", mimeType: "video/mp4" }), "recording");
  assert.equal(classifyDriveArtifact({ name: "Random doc", mimeType: "application/vnd.google-apps.document" }), null);
});

test("Drive inventory recurses through nested folders and audits source systems", async () => {
  const childrenByFolder = {
    root_folder: [
      {
        id: "folder_otter",
        name: "Transcript exports",
        mimeType: "application/vnd.google-apps.folder",
      },
      {
        id: "meet_root_doc",
        name: "Google Meet transcript abc-defg-hij",
        mimeType: "application/vnd.google-apps.document",
        webViewLink: "https://docs.google.com/document/d/meet_root_doc/edit",
        createdTime: "2026-06-16T17:08:00Z",
      },
    ],
    folder_otter: [
      {
        id: "otter_doc",
        name: "Otter.ai Demo Presentation Transcript",
        mimeType: "text/plain",
        webViewLink: "https://drive.google.com/file/d/otter_doc/view",
      },
      {
        id: "folder_nested",
        name: "Nested",
        mimeType: "application/vnd.google-apps.folder",
      },
    ],
    folder_nested: [
      {
        id: "meet_notes",
        name: "Gemini smart notes for Demo Presentation",
        mimeType: "application/vnd.google-apps.document",
        webViewLink: "https://docs.google.com/document/d/meet_notes/edit",
      },
    ],
  };
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    assert.equal(options.headers.authorization, "Bearer google-token");
    const parsed = new URL(String(url));
    calls.push(parsed.searchParams.get("q"));
    const parentId = /'([^']+)' in parents/.exec(parsed.searchParams.get("q"))?.[1];
    return Response.json({ files: childrenByFolder[parentId] || [] });
  };

  const inventory = await fetchDriveFileInventory({
    folderId: "root_folder",
    accessToken: "google-token",
    recursive: true,
    maxDepth: 2,
    fetchImpl,
  });
  const audit = buildDriveInventoryAudit(inventory);

  assert.equal(inventory.scanned_folder_count, 3);
  assert.equal(inventory.folder_count, 2);
  assert.equal(inventory.file_count, 3);
  assert.equal(inventory.max_observed_depth, 3);
  assert.deepEqual(calls, [
    "'root_folder' in parents and trashed=false",
    "'folder_otter' in parents and trashed=false",
    "'folder_nested' in parents and trashed=false",
  ]);
  assert.equal(audit.by_source_system.otter, 1);
  assert.equal(audit.by_source_system.google_meet, 2);
  assert.equal(audit.by_source_kind.otter_transcript, 1);
  assert.equal(audit.by_source_kind.meet_transcript, 1);
  assert.equal(audit.by_source_kind.meet_smart_notes, 1);
  assert.equal(audit.deepest_files[0].drive_path, "Transcript exports/Nested/Gemini smart notes for Demo Presentation");
});

test("Drive source classifier reports confidence for Otter, GMeet, and ambiguous metadata", () => {
  assert.deepEqual(
    classifyDriveSourceSystem({
      name: "Otter.ai Salon Summary",
      mimeType: "text/plain",
    }).source_kind,
    "otter_summary",
  );
  const gemini = classifyDriveSourceSystem({
    name: "Gemini smart notes",
    mimeType: "application/vnd.google-apps.document",
  });
  assert.equal(gemini.source_kind, "meet_smart_notes");
  assert.equal(gemini.confidence_pct, 92);
  assert.equal(
    classifyDriveSourceSystem({
      name: "Otter export from Google Meet transcript",
      mimeType: "text/plain",
    }).source_system,
    "ambiguous",
  );
});
