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
  listTranscriptIntakeHistory,
  loadTranscriptPolicy,
  routeForTranscriptType,
  stageTranscriptFile,
  submitTranscriptIntake,
} = require("./transcript-intake.js");

test("transcript type declaration uses the Engine routing categories", () => {
  const policy = loadTranscriptPolicy();
  assert.equal(routeForTranscriptType(policy, "office_hours").path, "raw_transcripts/office_hours");
  assert.equal(routeForTranscriptType(policy, "private_1on1").path, "do_not_publish/private_1on1");
  assert.equal(routeForTranscriptType(policy, "leadership_meeting").path, "do_not_publish/leadership_meeting");
  const options = getTranscriptIntakeOptions();
  assert.equal(options.sessionTypes.some((type) => type.key === "leadership_meeting"), true);
  assert.deepEqual(options.processingPaths.map((path) => path.key), ["metadata", "supabase_raw", "local_agent"]);
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
  fs.rmSync(root, { recursive: true, force: true });
});

test("listTranscriptIntakeHistory is safe on a missing intake root", () => {
  const items = listTranscriptIntakeHistory({ intakeRoot: path.join(os.tmpdir(), "srwk-no-such-dir-xyz") });
  assert.deepEqual(items, []);
});
