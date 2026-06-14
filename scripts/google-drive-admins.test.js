const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_DRIVE_ADMIN_EMAILS,
  buildDriveAdminPlan,
  runGoogleDriveAdminSetup,
} = require("./setup-google-drive-admins.js");

test("Google Drive admin plan requires explicit admin emails", () => {
  assert.deepEqual(DEFAULT_DRIVE_ADMIN_EMAILS, []);
  assert.throws(
    () => buildDriveAdminPlan({ driveId: "shared-drive" }),
    /at least one Drive admin email is required/,
  );

  const plan = buildDriveAdminPlan({ driveId: "shared-drive", emails: "admin@example.com" });
  assert.deepEqual(plan.admins, ["admin@example.com"]);
  assert.equal(plan.role, "organizer");
  assert.equal(plan.actions.length, 1);
  assert.ok(plan.actions.every((action) => action.action === "dry-run"));
});

test("Google Drive admin dry-run does not require a token", async () => {
  const result = await runGoogleDriveAdminSetup({
    driveId: "shared-drive",
    emails: "admin@example.com",
    fetchImpl: async () => {
      throw new Error("dry-run should not fetch");
    },
  });

  assert.equal(result.apply, false);
  assert.equal(result.planned, 1);
  assert.deepEqual(result.actions, [{
    action: "dry-run",
    email: "admin@example.com",
    role: "organizer",
  }]);
});

test("Google Drive admin setup inserts missing organizers and updates weaker roles", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ method: options.method || "GET", path: parsed.pathname, query: parsed.searchParams, body });
    assert.equal(options.headers.authorization, "Bearer drive-token");
    if ((options.method || "GET") === "GET") {
      return Response.json({
        permissions: [{
          id: "perm-writer",
          type: "user",
          emailAddress: "writer@example.com",
          role: "writer",
        }, {
          id: "perm-organizer",
          type: "user",
          emailAddress: "same@example.com",
          role: "organizer",
        }],
      });
    }
    if ((options.method || "GET") === "POST") {
      assert.equal(parsed.pathname.endsWith("/permissions"), true);
      assert.equal(parsed.searchParams.get("supportsAllDrives"), "true");
      assert.equal(parsed.searchParams.get("sendNotificationEmail"), "true");
      return Response.json({
        id: `perm-${body.emailAddress}`,
        type: body.type,
        emailAddress: body.emailAddress,
        role: body.role,
      });
    }
    assert.equal((options.method || "GET"), "PATCH");
    assert.equal(parsed.pathname.endsWith("/permissions/perm-writer"), true);
    return Response.json({
      id: "perm-writer",
      type: "user",
      emailAddress: "writer@example.com",
      role: body.role,
    });
  };

  const result = await runGoogleDriveAdminSetup({
    driveId: "shared-drive",
    accessToken: "drive-token",
    emails: "new@example.com,writer@example.com,same@example.com",
    apply: true,
    sendNotifications: true,
    fetchImpl,
  });

  assert.equal(result.inserted, 1);
  assert.equal(result.updated, 1);
  assert.equal(result.unchanged, 1);
  assert.deepEqual(result.actions.map((action) => action.action), ["inserted", "updated", "unchanged"]);
  assert.equal(calls.some((call) => call.method === "POST"), true);
  assert.equal(calls.some((call) => call.method === "PATCH"), true);
});

test("Google Drive admin verify reports missing and would-update rows", async () => {
  const result = await runGoogleDriveAdminSetup({
    driveId: "shared-drive",
    accessToken: "drive-token",
    emails: "reader@example.com,missing@example.com,organizer@example.com",
    verify: true,
    fetchImpl: async () => Response.json({
      permissions: [{
        id: "perm-reader",
        type: "user",
        emailAddress: "reader@example.com",
        role: "reader",
      }, {
        id: "perm-organizer",
        type: "user",
        emailAddress: "organizer@example.com",
        role: "organizer",
      }],
    }),
  });

  assert.equal(result.missing, 1);
  assert.equal(result.would_update, 1);
  assert.equal(result.unchanged, 1);
  assert.deepEqual(result.actions.map((action) => action.action), ["would_update", "missing", "unchanged"]);
});
