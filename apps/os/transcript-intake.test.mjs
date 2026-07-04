import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildRawContextSubmissionRows,
  buildTranscriptIntakeBody,
  chunkText,
  getTranscriptIntakeOptions,
  inspectTranscriptFiles,
  listTranscriptIntakeHistory,
  loadTranscriptPolicy,
  routeForTranscriptType,
  stageTranscriptFile,
  submitTranscriptIntake,
  submitTranscriptIntakeBatch,
} = require("./transcript-intake.js");

test("transcript type declaration uses the Engine routing categories", () => {
  const policy = loadTranscriptPolicy();
  assert.equal(routeForTranscriptType(policy, "office_hours").path, "raw_transcripts/office_hours");
  assert.equal(routeForTranscriptType(policy, "private_1on1").path, "do_not_publish/private_1on1");
  assert.equal(routeForTranscriptType(policy, "leadership_meeting").path, "do_not_publish/leadership_meeting");
  const options = getTranscriptIntakeOptions();
  assert.equal(options.sessionTypes.some((type) => type.key === "leadership_meeting"), true);
  assert.deepEqual(options.processingPaths.map((path) => path.key), ["drive_inbox", "metadata", "supabase_raw", "local_agent"]);
  assert.throws(
    () => routeForTranscriptType(policy, ""),
    /Choose a transcript type/,
  );
});

test("submitTranscriptIntake sends full text to the private context_submissions inbox", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sros-transcript-raw-"));
  const source = path.join(tmp, "Raw Notes.md");
  const intakeRoot = path.join(tmp, "private-intake");
  fs.writeFileSync(source, "# Transcript\nSynthetic transcript line sent to private Supabase\n", "utf8");

  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options, body: JSON.parse(options.body) });
    return response(null, { status: 201 });
  };

  const result = await submitTranscriptIntake({
    filePath: source,
    sessionType: "office_hours",
    label: "Full Text Notes",
    processingPath: "supabase_raw",
    supabase: {
      supabaseUrl: "https://project.supabase.co",
      supabaseAnonKey: "anon",
      orgId: "srfg",
    },
    intakeRoot,
    storageRefRoot: tmp,
    fetchImpl,
    now: new Date("2026-06-29T12:00:00Z"),
  });

  assert.equal(result.ok, true);
  assert.equal(result.processingPath, "supabase_raw");
  assert.equal(result.rawSubmittedToSupabase, true);
  assert.equal(result.contextSubmissionRows, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://project.supabase.co/rest/v1/context_submissions");
  assert.equal(calls[0].options.headers.prefer, "return=minimal");
  assert.equal(calls[0].options.headers.authorization, "Bearer anon");
  assert.equal(calls[0].body.org_id, "srfg");
  assert.equal(calls[0].body.source_kind, "transcript");
  assert.match(calls[0].body.body, /Synthetic transcript line sent to private Supabase/);
  assert.equal(calls[0].body.metadata.raw_upload, true);
  assert.equal(calls[0].body.metadata.processing_path, "supabase_raw");
  const manifest = JSON.parse(fs.readFileSync(path.join(tmp, `${result.storageRef}.manifest.json`), "utf8"));
  assert.equal(manifest.processing_path, "supabase_raw");
  assert.equal(manifest.raw_submission_rows, 1);
});

test("raw transcript rows chunk long bodies before the table limit", () => {
  const rows = buildRawContextSubmissionRows({
    policy: loadTranscriptPolicy(),
    orgId: "srfg",
    sessionType: "salon",
    label: "Long salon",
    staged: {
      originalName: "long.txt",
      stagedName: "long.txt",
      sourceHash: "abc123",
      mimeType: "text/plain",
      sizeBytes: 180001,
    },
    transcriptText: "x".repeat(180001),
    now: new Date("2026-06-29T12:00:00Z"),
  });
  assert.equal(chunkText("x".repeat(180001)).length, 2);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].body.length, 180000);
  assert.equal(rows[1].body.length, 1);
  assert.equal(rows[0].metadata.chunk_count, 2);
  assert.equal(rows[1].metadata.chunk_index, 1);
});

test("inspectTranscriptFiles accepts valid batch picks and reports skipped files", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sros-transcript-inspect-bulk-"));
  const first = path.join(tmp, "one.txt");
  const second = path.join(tmp, "two.md");
  const skipped = path.join(tmp, "image.png");
  fs.writeFileSync(first, "one", "utf8");
  fs.writeFileSync(second, "two", "utf8");
  fs.writeFileSync(skipped, "png", "utf8");

  const result = inspectTranscriptFiles([first, first, second, skipped]);
  assert.equal(result.ok, true);
  assert.equal(result.files.length, 2);
  assert.deepEqual(result.files.map((item) => item.name), ["one.txt", "two.md"]);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].reason, "unsupported_file_type");
});

test("submitTranscriptIntakeBatch sends multiple raw text transcripts", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sros-transcript-bulk-"));
  const first = path.join(tmp, "one.txt");
  const second = path.join(tmp, "two.vtt");
  const intakeRoot = path.join(tmp, "private-intake");
  fs.writeFileSync(first, "Transcript one\n", "utf8");
  fs.writeFileSync(second, "WEBVTT\n\n00:00.000 --> 00:01.000\nTranscript two\n", "utf8");

  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return response(null, { status: 201 });
  };

  const result = await submitTranscriptIntakeBatch({
    filePaths: [first, second],
    sessionType: "salon",
    label: "Bulk salon",
    processingPath: "supabase_raw",
    supabase: {
      supabaseUrl: "https://project.supabase.co",
      supabaseAnonKey: "anon",
      orgId: "srfg",
    },
    intakeRoot,
    storageRefRoot: tmp,
    fetchImpl,
    now: new Date("2026-06-29T12:00:00Z"),
  });

  assert.equal(result.ok, true);
  assert.equal(result.bulk, true);
  assert.equal(result.totalCount, 2);
  assert.equal(result.okCount, 2);
  assert.equal(result.contextSubmissionRows, 2);
  assert.equal(calls.length, 2);
  assert.match(calls[0].body.body, /Transcript one/);
  assert.match(calls[1].body.body, /Transcript two/);
  assert.equal(result.results.every((item) => item.rawSubmittedToSupabase), true);
});

test("submitTranscriptIntakeBatch reports partial failures without dropping valid files", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sros-transcript-bulk-partial-"));
  const text = path.join(tmp, "ok.txt");
  const pdf = path.join(tmp, "needs-pointer.pdf");
  fs.writeFileSync(text, "Valid transcript\n", "utf8");
  fs.writeFileSync(pdf, "%PDF-1.4 fake", "utf8");
  let calls = 0;

  const result = await submitTranscriptIntakeBatch({
    filePaths: [text, pdf],
    sessionType: "office_hours",
    processingPath: "supabase_raw",
    supabase: {
      supabaseUrl: "https://project.supabase.co",
      supabaseAnonKey: "anon",
      orgId: "srfg",
    },
    intakeRoot: path.join(tmp, "private-intake"),
    storageRefRoot: tmp,
    fetchImpl: async () => { calls += 1; return response(null, { status: 201 }); },
  });

  assert.equal(result.ok, false);
  assert.equal(result.bulk, true);
  assert.equal(result.okCount, 1);
  assert.equal(result.failedCount, 1);
  assert.equal(calls, 1);
  assert.equal(result.results[1].reason, "text_transcript_required");
});

test("submitTranscriptIntake runs a local agent readout without calling Supabase", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sros-transcript-local-"));
  const source = path.join(tmp, "Raw Notes.txt");
  const intakeRoot = path.join(tmp, "private-intake");
  fs.writeFileSync(source, "Synthetic transcript line for local analysis\n", "utf8");
  let seenPrompt = "";
  let fetched = false;

  const result = await submitTranscriptIntake({
    filePath: source,
    sessionType: "office_hours",
    label: "Local Notes",
    processingPath: "local_agent",
    agentCmd: "ollama run qwen2.5",
    agentRunner: async (prompt, opts) => {
      seenPrompt = prompt;
      assert.equal(opts.agentCmd, "ollama run qwen2.5");
      return { ok: true, text: "# Readout\nPrivate distillation only.", cmd: ["ollama", "run", "qwen2.5"] };
    },
    fetchImpl: async () => { fetched = true; throw new Error("should not fetch"); },
    intakeRoot,
    storageRefRoot: tmp,
    now: new Date("2026-06-29T12:00:00Z"),
  });

  assert.equal(result.ok, true);
  assert.equal(result.processingPath, "local_agent");
  assert.equal(result.processedLocally, true);
  assert.equal(fetched, false);
  assert.match(seenPrompt, /Engine Ops transcript distillation rules/);
  assert.match(seenPrompt, /Synthetic transcript line for local analysis/);
  const readoutPath = path.join(tmp, `${result.storageRef}.local-readout.md`);
  const readout = fs.readFileSync(readoutPath, "utf8");
  assert.match(readout, /Private distillation only/);
  assert.doesNotMatch(readout, /Synthetic transcript line for local analysis/);
  const manifest = JSON.parse(fs.readFileSync(path.join(tmp, `${result.storageRef}.manifest.json`), "utf8"));
  assert.equal(manifest.processing_path, "local_agent");
  assert.equal(manifest.local_readout_file_name, result.localReadoutName);
});

test("full-text paths reject document formats that were only staged", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sros-transcript-pdf-"));
  const source = path.join(tmp, "Raw Notes.pdf");
  fs.writeFileSync(source, "%PDF-1.4 fake", "utf8");
  let fetched = false;
  const result = await submitTranscriptIntake({
    filePath: source,
    sessionType: "office_hours",
    processingPath: "supabase_raw",
    supabase: {
      supabaseUrl: "https://project.supabase.co",
      supabaseAnonKey: "anon",
      orgId: "srfg",
    },
    intakeRoot: path.join(tmp, "private-intake"),
    storageRefRoot: tmp,
    fetchImpl: async () => { fetched = true; throw new Error("should not fetch"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "text_transcript_required");
  assert.equal(result.staged, true);
  assert.equal(fetched, false);
});

test("transcript intake stages a private local file and builds a metadata-only manifest", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sros-transcript-intake-"));
  const source = path.join(tmp, "Raw Notes.txt");
  const intakeRoot = path.join(tmp, "private-intake");
  fs.writeFileSync(source, "Synthetic transcript line that stays local\n", "utf8");

  const staged = stageTranscriptFile({
    filePath: source,
    sessionType: "office_hours",
    label: "Review Notes",
    intakeRoot,
    storageRefRoot: tmp,
    now: new Date("2026-06-29T12:00:00Z"),
  });
  assert.equal(fs.existsSync(staged.stagedPath), true);
  assert.match(staged.storageRef, /^private-intake\/2026-06-29\/office_hours_review-notes_/);

  const body = buildTranscriptIntakeBody({
    policy: loadTranscriptPolicy(),
    orgId: "org_1",
    sessionId: "11111111-1111-1111-1111-111111111111",
    sessionType: "office_hours",
    confidence: "best_guess",
    declaredDate: "2026-06-29",
    label: "Review Notes",
    relatedText: "Info Markets",
    staged,
    now: new Date("2026-06-29T12:00:00Z"),
  });

  const serialized = JSON.stringify(body);
  assert.equal(body.provider, "manual");
  assert.equal(body.processor_mode, "local");
  assert.equal(body.manifest.artifacts[0].storage_mode, "local_only");
  assert.equal(body.manifest.artifacts[0].raw_available_to_server, false);
  assert.equal(body.manifest.artifacts[0].metadata.declared_session_type, "office_hours");
  assert.equal(body.manifest.artifacts[0].metadata.type_confidence_pct, 70);
  assert.equal(body.manifest.artifacts[0].metadata.target_drive_route, "raw_transcripts/office_hours");
  assert.doesNotMatch(serialized, /Synthetic transcript line/);
});

test("submitTranscriptIntake calls ingest-artifacts with signed auth", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sros-transcript-submit-"));
  const source = path.join(tmp, "Raw Notes.txt");
  const intakeRoot = path.join(tmp, "private-intake");
  fs.writeFileSync(source, "Synthetic transcript line that stays local\n", "utf8");

  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options, body: JSON.parse(options.body) });
    return response({
      provider: "manual",
      sourceArtifacts: [],
      persisted: {
        sourceArtifacts: [{ id: "source_1" }],
        processingJobs: [{ id: "job_1" }],
      },
    });
  };

  const result = await submitTranscriptIntake({
    filePath: source,
    sessionType: "office_hours",
    label: "Review Notes",
    sessionId: "11111111-1111-1111-1111-111111111111",
    supabase: {
      supabaseUrl: "https://project.supabase.co",
      supabaseAnonKey: "anon",
      accessToken: "user-token",
      orgId: "org_1",
    },
    intakeRoot,
    storageRefRoot: tmp,
    fetchImpl,
    now: new Date("2026-06-29T12:00:00Z"),
  });

  assert.equal(result.ok, true);
  assert.equal(result.processingQueued, true);
  assert.equal(result.driveMirrorStatus, "pending");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://project.supabase.co/functions/v1/ingest-artifacts");
  assert.equal(calls[0].options.headers.authorization, "Bearer user-token");
  assert.equal(calls[0].options.headers.apikey, "anon");
  assert.equal(calls[0].body.org_id, "org_1");
  assert.equal(calls[0].body.manifest.artifacts[0].metadata.drive_mirror_status, "pending");
});

test("submitTranscriptIntake uploads originals to private Drive and indexes only a pointer", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sros-transcript-drive-"));
  const source = path.join(tmp, "Board Deck.pdf");
  const intakeRoot = path.join(tmp, "private-intake");
  fs.writeFileSync(source, "%PDF-1.4 fake private transcript deck", "utf8");

  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const call = { url: String(url), options };
    if (String(url).includes("googleapis.com/upload/drive")) {
      call.bodyText = Buffer.isBuffer(options.body) ? options.body.toString("utf8") : String(options.body || "");
      calls.push(call);
      assert.equal(options.headers.authorization, "Bearer drive-token");
      assert.match(options.headers["content-type"], /^multipart\/related; boundary=sros_/);
      assert.match(call.bodyText, /"parents":\["folder_private"\]/);
      assert.match(call.bodyText, /"source":"shape_os_transcript_intake"/);
      return response({
        id: "drive_file_1",
        name: "salon_board-deck_abc.pdf",
        mimeType: "application/pdf",
        parents: ["folder_private"],
        size: "35",
      });
    }
    call.body = JSON.parse(options.body);
    calls.push(call);
    assert.equal(options.headers.authorization, "Bearer supabase-token");
    assert.equal(options.headers.apikey, "anon");
    return response({
      provider: "google_drive",
      persisted: {
        sourceArtifacts: [{ id: "source_drive_1" }],
        processingJobs: [{ id: "job_drive_1" }],
      },
    });
  };

  const result = await submitTranscriptIntake({
    filePath: source,
    sessionType: "salon",
    label: "Board Deck",
    sessionId: "22222222-2222-4222-8222-222222222222",
    processingPath: "drive_inbox",
    drive: {
      accessToken: "drive-token",
      folderId: "folder_private",
    },
    supabase: {
      supabaseUrl: "https://project.supabase.co",
      supabaseAnonKey: "anon",
      accessToken: "supabase-token",
      orgId: "srfg",
    },
    intakeRoot,
    storageRefRoot: tmp,
    fetchImpl,
    now: new Date("2026-07-04T12:00:00Z"),
  });

  assert.equal(result.ok, true);
  assert.equal(result.processingPath, "drive_inbox");
  assert.equal(result.driveUploaded, true);
  assert.equal(result.driveFileId, "drive_file_1");
  assert.equal(result.submittedToSupabase, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?/);
  assert.equal(calls[0].url.includes("/permissions"), false);
  assert.equal(calls[1].url, "https://project.supabase.co/functions/v1/ingest-artifacts");
  assert.equal(calls[1].body.provider, "manual");
  assert.equal(calls[1].body.processor_mode, "ordinary_cloud");
  assert.equal(calls[1].body.manifest.source_provider, "google_drive");
  const artifact = calls[1].body.manifest.artifacts[0];
  assert.equal(artifact.source_kind, "drive_doc");
  assert.equal(artifact.storage_mode, "external_ref");
  assert.equal(artifact.storage_ref, "drive://drive_file_1");
  assert.equal(artifact.raw_available_to_server, false);
  assert.equal(calls[1].body.manifest.storage_mode, "external_ref");
  assert.equal(artifact.metadata.source_provider, "google_drive");
  assert.equal(artifact.metadata.drive_file_id, "drive_file_1");
  assert.equal(artifact.metadata.local_storage_ref, result.storageRef);
  assert.doesNotMatch(JSON.stringify(calls[1].body), /fake private transcript deck/);
  assert.doesNotMatch(JSON.stringify(calls[1].body), /drive-token|supabase-token/);
  const manifest = JSON.parse(fs.readFileSync(path.join(tmp, `${result.storageRef}.manifest.json`), "utf8"));
  assert.equal(manifest.processing_path, "drive_inbox");
  assert.equal(manifest.drive_file_id, "drive_file_1");
  assert.equal(manifest.drive_folder_id, "folder_private");
  assert.equal(manifest.drive_storage_ref, "drive://drive_file_1");
  assert.equal(manifest.storage_mode, "google_drive_private");
  assert.equal(JSON.stringify(manifest).includes("drive-token"), false);
});

test("submitTranscriptIntake Drive inbox defers Supabase indexing until a session is chosen", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sros-transcript-drive-defer-"));
  const source = path.join(tmp, "Unmatched Notes.txt");
  const intakeRoot = path.join(tmp, "private-intake");
  fs.writeFileSync(source, "Synthetic unmatched transcript", "utf8");

  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return response({
      id: "drive_unmatched_1",
      name: "salon_unmatched-notes_abc.txt",
      mimeType: "text/plain",
      parents: ["folder_private"],
      size: "30",
    });
  };

  const result = await submitTranscriptIntake({
    filePath: source,
    sessionType: "salon",
    label: "Unmatched Notes",
    processingPath: "drive_inbox",
    drive: {
      accessToken: "drive-token",
      folderId: "folder_private",
    },
    supabase: {
      supabaseUrl: "https://project.supabase.co",
      supabaseAnonKey: "anon",
      accessToken: "supabase-token",
      orgId: "srfg",
    },
    intakeRoot,
    storageRefRoot: tmp,
    fetchImpl,
    now: new Date("2026-07-04T12:10:00Z"),
  });

  assert.equal(result.ok, true);
  assert.equal(result.reason, "session_match_required");
  assert.equal(result.driveUploaded, true);
  assert.equal(result.submittedToSupabase, false);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?/);
  const manifest = JSON.parse(fs.readFileSync(path.join(tmp, `${result.storageRef}.manifest.json`), "utf8"));
  assert.equal(manifest.drive_index_pending_reason, "session_match_required");
  assert.equal(manifest.drive_storage_ref, "drive://drive_unmatched_1");
});

test("submitTranscriptIntake Drive inbox stages locally and reports missing Drive config", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sros-transcript-drive-missing-"));
  const source = path.join(tmp, "Raw Notes.docx");
  const intakeRoot = path.join(tmp, "private-intake");
  fs.writeFileSync(source, "fake docx", "utf8");
  let fetched = false;

  const result = await submitTranscriptIntake({
    filePath: source,
    sessionType: "office_hours",
    processingPath: "drive_inbox",
    drive: {},
    supabase: {
      supabaseUrl: "https://project.supabase.co",
      supabaseAnonKey: "anon",
      accessToken: "supabase-token",
      orgId: "srfg",
    },
    intakeRoot,
    storageRefRoot: tmp,
    fetchImpl: async () => { fetched = true; throw new Error("should not fetch"); },
    now: new Date("2026-07-04T12:00:00Z"),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_drive_config");
  assert.equal(result.staged, true);
  assert.equal(fetched, false);
  assert.deepEqual(result.missing, ["Google Drive access token", "Drive folder ID"]);
});

test("submitTranscriptIntake stages locally and reports missing Supabase config", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sros-transcript-missing-"));
  const source = path.join(tmp, "Raw Notes.txt");
  const intakeRoot = path.join(tmp, "private-intake");
  fs.writeFileSync(source, "Synthetic transcript line that stays local\n", "utf8");

  const result = await submitTranscriptIntake({
    filePath: source,
    sessionType: "office_hours",
    intakeRoot,
    storageRefRoot: tmp,
    supabase: {},
    now: new Date("2026-06-29T12:00:00Z"),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_supabase_config");
  assert.equal(result.staged, true);
  assert.match(result.storageRef, /^private-intake\/2026-06-29\/office_hours_raw-notes_/);
});

function response(body, init = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status || 200,
    json: async () => body,
  };
}

test("listTranscriptIntakeHistory reads manifests newest-first with submit state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "srwk-intake-"));
  const sub = path.join(root, "raw_transcripts", "salon");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, "a.txt.manifest.json"), JSON.stringify({
    staged_at: "2026-07-01T10:00:00Z", session_type: "salon", label: "older", processing_queued: true, submitted_at: "2026-07-01T10:00:05Z",
    drive_uploaded_at: "2026-07-01T10:00:02Z", drive_file_id: "drive_older", drive_folder_id: "folder_private",
  }));
  fs.writeFileSync(path.join(sub, "b.txt.manifest.json"), JSON.stringify({
    staged_at: "2026-07-02T10:00:00Z", session_type: "salon", label: "newer, staged only",
  }));
  const items = listTranscriptIntakeHistory({ intakeRoot: root });
  assert.equal(items.length, 2);
  assert.equal(items[0].label, "newer, staged only");
  assert.equal(items[0].submitted_at, null);
  assert.equal(items[1].submitted_at, "2026-07-01T10:00:05Z");
  assert.equal(items[1].processing_queued, true);
  assert.equal(items[1].drive_uploaded_at, "2026-07-01T10:00:02Z");
  assert.equal(items[1].drive_file_id, "drive_older");
  fs.rmSync(root, { recursive: true, force: true });
});

test("listTranscriptIntakeHistory is safe on a missing intake root", () => {
  const items = listTranscriptIntakeHistory({ intakeRoot: path.join(os.tmpdir(), "srwk-no-such-dir-xyz") });
  assert.deepEqual(items, []);
});
