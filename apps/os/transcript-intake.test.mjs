import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildTranscriptIntakeBody,
  getTranscriptIntakeOptions,
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
  assert.throws(
    () => routeForTranscriptType(policy, ""),
    /Choose a transcript type/,
  );
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
