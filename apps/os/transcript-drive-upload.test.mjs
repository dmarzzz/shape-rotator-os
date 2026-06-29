import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  driveRouteForTranscriptType,
  loadTranscriptPolicy,
  suggestTranscriptDriveName,
  uploadTranscriptFile,
} = require("./transcript-drive-upload.js");

test("transcript type declaration resolves the canonical Drive route", () => {
  const policy = loadTranscriptPolicy();
  assert.equal(driveRouteForTranscriptType(policy, "office_hours").path, "raw_transcripts/office_hours");
  assert.equal(driveRouteForTranscriptType(policy, "private_1on1").path, "do_not_publish/private_1on1");
  assert.throws(
    () => driveRouteForTranscriptType(policy, ""),
    /Choose a transcript type/,
  );
});

test("suggested Drive names keep the declared type first", () => {
  assert.equal(
    suggestTranscriptDriveName({
      sessionType: "office_hours",
      originalName: "Conclave transcript final.txt",
    }),
    "office_hours_conclave-transcript-final.txt",
  );
  assert.equal(
    suggestTranscriptDriveName({
      sessionType: "salon",
      originalName: "raw.md",
      label: "Info Markets 2026-06-08",
    }),
    "salon_info-markets-2026-06-08.md",
  );
});

test("uploadTranscriptFile creates the typed folder and uploads metadata only", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sros-transcript-upload-"));
  const filePath = path.join(tmp, "Raw Notes.txt");
  fs.writeFileSync(filePath, "Speaker A: private source text\n", "utf8");

  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    calls.push({ parsed, options });
    if (String(url).includes("oauth2.googleapis.com/token")) {
      return response({ access_token: "access_token" });
    }
    if (parsed.pathname.endsWith("/upload/drive/v3/files")) {
      const body = Buffer.isBuffer(options.body) ? options.body.toString("utf8") : String(options.body || "");
      assert.match(body, /"declared_session_type":"office_hours"/);
      assert.match(body, /"transcript_route_path":"raw_transcripts\/office_hours"/);
      assert.match(body, /Speaker A: private source text/);
      return response({
        id: "drive_file_1",
        name: "office_hours_review-notes.txt",
        webViewLink: "https://drive.google.com/file/d/drive_file_1/view",
      });
    }
    if (parsed.pathname.endsWith("/drive/v3/files") && options.method !== "POST") {
      assert.match(parsed.searchParams.get("q"), /office_hours/);
      return response({ files: [] });
    }
    if (parsed.pathname.endsWith("/drive/v3/files") && options.method === "POST") {
      assert.deepEqual(JSON.parse(options.body), {
        name: "office_hours",
        mimeType: "application/vnd.google-apps.folder",
        parents: ["raw_folder"],
      });
      return response({ id: "office_hours_folder", name: "office_hours", parents: ["raw_folder"] });
    }
    throw new Error(`unexpected fetch ${options.method || "GET"} ${url}`);
  };

  const result = await uploadTranscriptFile({
    filePath,
    sessionType: "office_hours",
    label: "Review Notes",
    env: {
      GOOGLE_OAUTH_REFRESH_TOKEN: "refresh",
      GOOGLE_OAUTH_CLIENT_ID: "client",
      GOOGLE_OAUTH_CLIENT_SECRET: "secret",
      GOOGLE_TRANSCRIPT_DRIVE_ID: "shared_drive",
      GOOGLE_TRANSCRIPT_RAW_FOLDER_ID: "raw_folder",
    },
    fetchImpl,
    now: new Date("2026-06-29T12:00:00Z"),
  });

  assert.equal(result.ok, true);
  assert.equal(result.routePath, "raw_transcripts/office_hours");
  assert.equal(result.targetPath, "raw_transcripts/office_hours/office_hours_review-notes.txt");
  assert.equal(result.driveFileId, "drive_file_1");
  assert.equal(calls.some((call) => call.parsed.pathname.endsWith("/upload/drive/v3/files")), true);
});

function response(body, init = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status || 200,
    json: async () => body,
  };
}
