import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildFetchManifest,
  driveContentUrl,
  fetchTranscriptDriveSources,
  parseDriveFileId,
  plannedFetchItems,
  renderFetchSummary,
} from "./fetch-transcript-drive-sources.mjs";

const GENERATED_AT = "2026-06-13T20:00:00.000Z";

const PLAN = {
  generated_at: "2026-06-13T19:29:46.783Z",
  org_id: "org_1",
  policy_version: "2026-06-12",
  sourceArtifacts: [
    {
      id: "430fba86-ef15-5e0b-89fa-21351611c88b",
      org_id: "org_1",
      session_id: "session_1",
      source_kind: "drive_doc",
      source_tier: "T0",
      storage_mode: "external_ref",
      storage_ref: "drive://drive_file_1",
      mime_type: "text/plain",
      raw_available_to_server: false,
    },
  ],
  ingestionEvents: [
    {
      event_json: {
        source_artifact_id: "430fba86-ef15-5e0b-89fa-21351611c88b",
        original_name: "Copy of Agentic Organizations with Sreeram Transcript Jun 8.txt",
        preferred_drive_name: "salon_agentic-organizations-sreeram_2026-06-08.txt",
        inferred_session_type: "salon",
        inferred_date: "2026-06-08",
        max_tier: "T3",
      },
    },
  ],
  processingJobs: [
    {
      id: "fetch_job_1",
      org_id: "org_1",
      source_artifact_id: "430fba86-ef15-5e0b-89fa-21351611c88b",
      job_kind: "artifact_fetch",
      processor_mode: "local",
      prompt_version: "artifact-fetch-v1",
    },
  ],
};

test("parses Drive refs and plans private local paths", () => {
  const root = path.join(os.tmpdir(), "shape-transcripts");
  assert.equal(parseDriveFileId("drive://abc123"), "abc123");
  assert.equal(parseDriveFileId("https://drive.google.com/file/d/file_id/view"), "file_id");
  assert.equal(parseDriveFileId("https://drive.google.com/open?id=file_id_2"), "file_id_2");

  const items = plannedFetchItems(PLAN, { transcriptRoot: root });
  assert.equal(items.length, 1);
  assert.equal(items[0].drive_file_id, "drive_file_1");
  assert.equal(
    items[0].local_relative_path,
    "drive/430fba86-ef15-5e0b-89fa-21351611c88b/salon_agentic-organizations-sreeram_2026-06-08.txt",
  );
  assert.ok(path.resolve(items[0].local_path).startsWith(path.resolve(root)));
});

test("builds dry-run manifest without raw local text", () => {
  const manifest = buildFetchManifest(PLAN, {
    transcriptRoot: "private-transcripts",
    generatedAt: GENERATED_AT,
  });
  const summary = renderFetchSummary(manifest);
  const text = JSON.stringify(manifest);

  assert.equal(manifest.operation_mode, "dry_run");
  assert.equal(manifest.counts.planned_fetches, 1);
  assert.equal(manifest.counts.worker_jobs, 0);
  assert.match(summary, /Transcript Drive Fetch Manifest/);
  assert.doesNotMatch(text, /raw transcript sentence/i);
});

test("uses Drive export for Google Docs and media download for plain files", () => {
  const docUrl = driveContentUrl({ id: "doc_1", mimeType: "application/vnd.google-apps.document" });
  assert.match(String(docUrl), /\/export\?/);
  assert.equal(docUrl.searchParams.get("mimeType"), "text/plain");

  const mediaUrl = driveContentUrl({ id: "file_1", mimeType: "text/plain" });
  assert.equal(mediaUrl.searchParams.get("alt"), "media");
  assert.equal(mediaUrl.searchParams.get("supportsAllDrives"), "true");
});

test("fetches Drive text into private storage and emits local worker batch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shape-drive-fetch-"));
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const parsed = new URL(String(url));
    if (parsed.hostname === "oauth2.googleapis.com") {
      return Response.json({ access_token: "fresh_access_token" });
    }
    if (parsed.pathname.endsWith("/drive/v3/files/drive_file_1") && parsed.searchParams.get("alt") !== "media") {
      return Response.json({
        id: "drive_file_1",
        name: "Agentic Organizations with Sreeram Transcript Jun 8.txt",
        mimeType: "text/plain",
      });
    }
    if (parsed.pathname.endsWith("/drive/v3/files/drive_file_1") && parsed.searchParams.get("alt") === "media") {
      return new Response("Speaker A: raw transcript sentence that stays private.", {
        headers: { "content-type": "text/plain" },
      });
    }
    return Response.json({ error: "unexpected" }, { status: 404 });
  };

  const manifest = await fetchTranscriptDriveSources(PLAN, {
    transcriptRoot: root,
    clientId: "client",
    clientSecret: "secret",
    refreshToken: "refresh",
    generatedAt: GENERATED_AT,
    fetchImpl,
  });

  assert.equal(manifest.operation_mode, "fetch");
  assert.equal(manifest.counts.fetched, 1);
  assert.equal(manifest.counts.failed, 0);
  assert.equal(manifest.worker_batch.jobs.length, 1);
  assert.equal(manifest.worker_batch.jobs[0].processingJob.job_kind, "distill");
  assert.equal(manifest.worker_batch.jobs[0].sourceArtifact.storage_mode, "local_only");
  assert.equal(manifest.worker_batch.jobs[0].sourceArtifact.storage_ref, manifest.items[0].local_relative_path);
  assert.equal(manifest.worker_batch.jobs[0].session.session_type, "salon");
  assert.ok(manifest.items[0].source_hash.startsWith("sha256:"));
  assert.ok(fs.existsSync(path.join(root, manifest.items[0].local_relative_path)));
  assert.doesNotMatch(JSON.stringify(manifest), /Speaker A: raw transcript sentence/);
  assert.ok(calls.some((call) => call.options.headers?.authorization === "Bearer fresh_access_token"));
});
