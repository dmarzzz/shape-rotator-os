const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_EDITOR_EMAILS,
  buildAclPlan,
  parseEmails,
  runGoogleCalendarAclSetup,
} = require("./setup-google-calendar-acl.js");

test("Google calendar ACL plan requires explicit editor emails", () => {
  assert.deepEqual(DEFAULT_EDITOR_EMAILS, []);
  assert.throws(
    () => buildAclPlan({ calendarId: "calendar@example.com" }),
    /at least one editor email is required/,
  );

  const plan = buildAclPlan({ calendarId: "calendar@example.com", emails: "editor@example.com" });
  assert.deepEqual(plan.editors, ["editor@example.com"]);
  assert.equal(plan.role, "owner");
  assert.equal(plan.scope_type, "user");
  assert.equal(plan.actions.length, 1);
  assert.ok(plan.actions.every((action) => action.action === "dry-run"));
});

test("Google calendar ACL email parsing dedupes and validates addresses", () => {
  assert.deepEqual(
    parseEmails("Admin@Example.com, admin@example.com; second@example.com invalid third@example.com"),
    ["admin@example.com", "second@example.com", "third@example.com"],
  );
});

test("Google calendar ACL dry-run does not require a token or call Google", async () => {
  const output = await runGoogleCalendarAclSetup({
    calendarId: "calendar@example.com",
    emails: "editor@example.com",
    fetchImpl: async () => {
      throw new Error("dry-run should not call fetch");
    },
  });

  assert.equal(output.apply, false);
  assert.equal(output.planned, 1);
  assert.deepEqual(output.actions, [{
    action: "dry-run",
    email: "editor@example.com",
    role: "owner",
    scope_type: "user",
  }]);
});

test("Google calendar ACL setup inserts missing writers and updates readers", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ method: options.method || "GET", path: parsed.pathname, query: parsed.searchParams, body });
    assert.equal(options.headers.authorization, "Bearer google-token");
    if ((options.method || "GET") === "GET") {
      return Response.json({
        items: [{
          id: "user:reader@example.com",
          role: "reader",
          scope: { type: "user", value: "reader@example.com" },
        }, {
          id: "user:same@example.com",
          role: "writer",
          scope: { type: "user", value: "same@example.com" },
        }],
      });
    }
    if ((options.method || "GET") === "POST") {
      assert.equal(parsed.pathname.endsWith("/acl"), true);
      assert.equal(parsed.searchParams.get("sendNotifications"), "false");
      return Response.json({
        id: `user:${body.scope.value}`,
        role: body.role,
        scope: body.scope,
      });
    }
    assert.equal((options.method || "GET"), "PATCH");
    assert.equal(parsed.pathname.endsWith("/acl/user%3Areader%40example.com"), true);
    assert.equal(parsed.searchParams.get("sendNotifications"), "false");
    return Response.json({
      id: "user:reader@example.com",
      role: body.role,
      scope: body.scope,
    });
  };

  const output = await runGoogleCalendarAclSetup({
    calendarId: "calendar@example.com",
    accessToken: "google-token",
    emails: "new@example.com,reader@example.com,same@example.com",
    role: "writer",
    apply: true,
    fetchImpl,
  });

  assert.equal(output.inserted, 1);
  assert.equal(output.updated, 1);
  assert.equal(output.unchanged, 1);
  assert.deepEqual(output.actions.map((action) => action.action), ["inserted", "updated", "unchanged"]);
  assert.equal(calls.filter((call) => call.method === "GET").length, 1);
  assert.equal(calls.some((call) => call.method === "POST"), true);
  assert.equal(calls.some((call) => call.method === "PATCH"), true);
});

test("Google calendar ACL setup does not downgrade stronger existing roles by default", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ method: options.method || "GET", body });
    if ((options.method || "GET") === "GET") {
      return Response.json({
        items: [{
          id: "user:owner@example.com",
          role: "owner",
          scope: { type: "user", value: "owner@example.com" },
        }],
      });
    }
    throw new Error("owner should not be downgraded without allowDowngrade");
  };

  const output = await runGoogleCalendarAclSetup({
    calendarId: "calendar@example.com",
    accessToken: "google-token",
    emails: "owner@example.com",
    role: "writer",
    apply: true,
    fetchImpl,
  });

  assert.equal(output.updated, 0);
  assert.equal(output.unchanged, 1);
  assert.equal(output.actions[0].action, "unchanged");
  assert.equal(output.actions[0].role, "owner");
  assert.equal(output.actions[0].requested_role, "writer");
  assert.equal(calls.length, 1);
});

test("Google calendar ACL setup can explicitly downgrade when requested", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ method: options.method || "GET", path: parsed.pathname, body });
    if ((options.method || "GET") === "GET") {
      return Response.json({
        items: [{
          id: "user:owner@example.com",
          role: "owner",
          scope: { type: "user", value: "owner@example.com" },
        }],
      });
    }
    assert.equal((options.method || "GET"), "PATCH");
    return Response.json({
      id: "user:owner@example.com",
      role: body.role,
      scope: body.scope,
    });
  };

  const output = await runGoogleCalendarAclSetup({
    calendarId: "calendar@example.com",
    accessToken: "google-token",
    emails: "owner@example.com",
    role: "writer",
    allowDowngrade: true,
    apply: true,
    fetchImpl,
  });

  assert.equal(output.updated, 1);
  assert.equal(output.actions[0].from_role, "owner");
  assert.equal(output.actions[0].role, "writer");
  assert.equal(calls.some((call) => call.method === "PATCH"), true);
});

test("Google calendar ACL verify reads existing ACLs without writing", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ method: options.method || "GET" });
    assert.equal((options.method || "GET"), "GET");
    return Response.json({
      items: [{
        id: "user:reader@example.com",
        role: "reader",
        scope: { type: "user", value: "reader@example.com" },
      }, {
        id: "user:owner@example.com",
        role: "owner",
        scope: { type: "user", value: "owner@example.com" },
      }],
    });
  };

  const output = await runGoogleCalendarAclSetup({
    calendarId: "calendar@example.com",
    accessToken: "google-token",
    emails: "reader@example.com,owner@example.com,missing@example.com",
    role: "writer",
    verify: true,
    fetchImpl,
  });

  assert.equal(output.apply, false);
  assert.equal(output.verify, true);
  assert.equal(output.missing, 1);
  assert.equal(output.would_update, 1);
  assert.equal(output.unchanged, 1);
  assert.deepEqual(output.actions.map((action) => action.action), ["would_update", "unchanged", "missing"]);
  assert.equal(calls.length, 1);
});

test("Google calendar ACL setup can target a Google Group", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ method: options.method || "GET", body });
    if ((options.method || "GET") === "GET") return Response.json({ items: [] });
    return Response.json({ id: `group:${body.scope.value}`, role: body.role, scope: body.scope });
  };

  const output = await runGoogleCalendarAclSetup({
    calendarId: "calendar@example.com",
    accessToken: "google-token",
    emails: "shape-calendar-admins@example.com",
    scopeType: "group",
    role: "writer",
    apply: true,
    sendNotifications: true,
    fetchImpl,
  });

  assert.equal(output.inserted, 1);
  assert.equal(calls[1].body.scope.type, "group");
  assert.equal(calls[1].body.role, "writer");
});
