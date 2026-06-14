const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildMembershipRows,
  matchOrganizerUsers,
  parseEmails,
  runSupabaseAdminOrganizersSetup,
} = require("./setup-supabase-admin-organizers.js");

test("Supabase admin organizer setup parses emails without duplicates", () => {
  assert.deepEqual(
    parseEmails("Admin@Example.com, admin@example.com; second@example.com invalid"),
    ["admin@example.com", "second@example.com"],
  );
});

test("Supabase admin organizer setup matches auth users by email", () => {
  const match = matchOrganizerUsers({
    emails: ["admin@example.com", "missing@example.com"],
    users: [
      { id: "user_1", email: "ADMIN@example.com" },
      { id: "user_2", email: "other@example.com" },
    ],
  });

  assert.deepEqual(match.matched, [{ id: "user_1", email: "admin@example.com" }]);
  assert.deepEqual(match.missing, ["missing@example.com"]);
});

test("Supabase admin organizer setup builds admin membership rows", () => {
  assert.deepEqual(
    buildMembershipRows({
      orgId: "org_1",
      users: [{ id: "user_1" }, { id: "user_2" }],
    }),
    [
      { org_id: "org_1", user_id: "user_1", role: "admin" },
      { org_id: "org_1", user_id: "user_2", role: "admin" },
    ],
  );
});

test("Supabase admin organizer setup dry-run does not write memberships", async () => {
  const calls = [];
  const result = await runSupabaseAdminOrganizersSetup({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service",
    orgId: "org_1",
    emails: "admin@example.com missing@example.com",
    apply: false,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || "GET" });
      assert.match(String(url), /\/auth\/v1\/admin\/users/);
      return {
        ok: true,
        json: async () => ({
          users: [{ id: "user_1", email: "admin@example.com" }],
        }),
      };
    },
  });

  assert.equal(result.apply, false);
  assert.equal(result.matched, 1);
  assert.equal(result.missing, 1);
  assert.equal(result.upserted, 0);
  assert.deepEqual(result.missing_emails, ["missing@example.com"]);
  assert.deepEqual(calls.map((call) => call.method), ["GET"]);
});

test("Supabase admin organizer setup applies matched memberships", async () => {
  const calls = [];
  const result = await runSupabaseAdminOrganizersSetup({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service",
    orgId: "org_1",
    emails: "admin@example.com",
    apply: true,
    fetchImpl: async (url, options = {}) => {
      calls.push({
        url: String(url),
        method: options.method || "GET",
        body: options.body ? JSON.parse(options.body) : null,
      });
      if (String(url).includes("/auth/v1/admin/users")) {
        return {
          ok: true,
          json: async () => ({
            users: [{ id: "user_1", email: "admin@example.com" }],
          }),
        };
      }
      assert.match(String(url), /\/rest\/v1\/org_memberships\?on_conflict=org_id%2Cuser_id/);
      assert.equal(options.method, "POST");
      assert.match(options.headers.prefer, /resolution=merge-duplicates/);
      assert.deepEqual(JSON.parse(options.body), [
        { org_id: "org_1", user_id: "user_1", role: "admin" },
      ]);
      return { ok: true, json: async () => null };
    },
  });

  assert.equal(result.apply, true);
  assert.equal(result.upserted, 1);
  assert.deepEqual(calls.map((call) => call.method), ["GET", "POST"]);
});
