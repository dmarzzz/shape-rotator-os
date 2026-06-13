import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveGoogleAccessToken,
  runTranscriptDriveOperations,
} from "./apply-transcript-drive-operations.mjs";

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const PLAN = {
  source_drive: {
    shared_drive_id: "shared_drive",
    raw_folder_id: "raw_folder",
  },
  folder_operations: [
    {
      operation: "ensure_folder",
      path: "10_raw_transcripts_T0",
      name: "10_raw_transcripts_T0",
      parent_path: null,
      known_folder_id: "raw_folder",
    },
    {
      operation: "ensure_folder",
      path: "10_raw_transcripts_T0/salon",
      name: "salon",
      parent_path: "10_raw_transcripts_T0",
    },
    {
      operation: "ensure_folder",
      path: "90_do_not_publish",
      name: "90_do_not_publish",
      parent_path: null,
    },
    {
      operation: "ensure_folder",
      path: "90_do_not_publish/private_1on1",
      name: "private_1on1",
      parent_path: "90_do_not_publish",
    },
  ],
  safe_file_operations: [
    {
      operation: "move_or_rename_file",
      drive_file_id: "drive_salon",
      current_name: "Copy of Salon.txt",
      target_name: "salon_demo_2026-06-08.txt",
      target_folder_path: "10_raw_transcripts_T0/salon",
      target_path: "10_raw_transcripts_T0/salon/salon_demo_2026-06-08.txt",
      inferred_session_type: "salon",
      safe_to_apply: true,
    },
    {
      operation: "move_or_rename_file",
      drive_file_id: "drive_private",
      current_name: "Copy of 1-1.txt",
      target_name: "private_1on1_demo_2026-06-08.txt",
      target_folder_path: "90_do_not_publish/private_1on1",
      target_path: "90_do_not_publish/private_1on1/private_1on1_demo_2026-06-08.txt",
      inferred_session_type: "private_1on1",
      safe_to_apply: true,
    },
  ],
  review_file_operations: [
    {
      operation: "move_or_rename_file",
      drive_file_id: "drive_review",
      target_name: "review.txt",
      target_folder_path: "10_raw_transcripts_T0/salon",
      safe_to_apply: false,
    },
  ],
};

test("drive apply dry-run plans safe operations without network writes", async () => {
  const result = await runTranscriptDriveOperations({
    plan: PLAN,
    apply: false,
    fetchImpl: async () => {
      throw new Error("dry-run should not call Google Drive");
    },
  });

  assert.equal(result.apply, false);
  assert.equal(result.planned_safe_file_operations, 2);
  assert.equal(result.review_file_operations_skipped, 1);
  assert.equal(result.files.length, 2);
  assert.ok(result.files.every((item) => item.action === "would_update"));
});

test("drive apply refuses private 1:1 safe rows outside quarantine", async () => {
  const badPlan = {
    ...PLAN,
    safe_file_operations: [
      {
        ...PLAN.safe_file_operations[1],
        target_folder_path: "10_raw_transcripts_T0/office_hours",
      },
    ],
  };

  await assert.rejects(
    () => runTranscriptDriveOperations({ plan: badPlan, apply: false }),
    /private_1on1 safe operation must target 90_do_not_publish\/private_1on1/,
  );
});

test("drive apply creates folders and updates only safe files", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const method = options.method || "GET";
    calls.push({
      method,
      pathname: parsed.pathname,
      search: parsed.searchParams,
      body: options.body && String(options.body).trim().startsWith("{") ? JSON.parse(options.body) : null,
    });

    if (parsed.hostname === "oauth2.googleapis.com") return response({ access_token: "fresh_token" });
    if (method === "GET" && parsed.pathname.endsWith("/files")) {
      const q = parsed.searchParams.get("q") || "";
      if (q.includes("name='salon'")) return response({ files: [] });
      if (q.includes("name='90_do_not_publish'")) return response({ files: [{ id: "private_root", name: "90_do_not_publish" }] });
      if (q.includes("name='private_1on1'")) return response({ files: [{ id: "private_child", name: "private_1on1" }] });
      return response({ files: [] });
    }
    if (method === "POST" && parsed.pathname.endsWith("/files")) {
      return response({ id: "created_salon", name: "salon", parents: ["raw_folder"] });
    }
    if (method === "GET" && parsed.pathname.endsWith("/files/drive_salon")) {
      return response({ id: "drive_salon", name: "Copy of Salon.txt", parents: ["raw_folder"] });
    }
    if (method === "GET" && parsed.pathname.endsWith("/files/drive_private")) {
      return response({ id: "drive_private", name: "Copy of 1-1.txt", parents: ["raw_folder"] });
    }
    if (method === "PATCH" && parsed.pathname.endsWith("/files/drive_salon")) {
      assert.equal(parsed.searchParams.get("addParents"), "created_salon");
      assert.equal(parsed.searchParams.get("removeParents"), "raw_folder");
      return response({ id: "drive_salon", name: "salon_demo_2026-06-08.txt", parents: ["created_salon"] });
    }
    if (method === "PATCH" && parsed.pathname.endsWith("/files/drive_private")) {
      assert.equal(parsed.searchParams.get("addParents"), "private_child");
      assert.equal(parsed.searchParams.get("removeParents"), "raw_folder");
      return response({ id: "drive_private", name: "private_1on1_demo_2026-06-08.txt", parents: ["private_child"] });
    }
    throw new Error(`unexpected request: ${method} ${parsed.pathname}`);
  };

  const accessToken = await resolveGoogleAccessToken({
    env: {
      GOOGLE_OAUTH_REFRESH_TOKEN: "refresh",
      GOOGLE_OAUTH_CLIENT_ID: "client",
      GOOGLE_OAUTH_CLIENT_SECRET: "secret",
    },
    fetchImpl,
  });
  const result = await runTranscriptDriveOperations({
    plan: PLAN,
    accessToken,
    apply: true,
    fetchImpl,
  });

  assert.equal(accessToken, "fresh_token");
  assert.equal(result.counts.folders_created, 1);
  assert.equal(result.counts.files_updated, 2);
  assert.equal(calls.filter((call) => call.method === "PATCH" && call.pathname.includes("drive_review")).length, 0);
});
